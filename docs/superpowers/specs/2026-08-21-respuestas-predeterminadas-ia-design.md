# Respuestas predeterminadas de la IA (playbooks)

Fecha: 2026-08-21
Rama: `feat/dashboard-recorrido-cliente`
Área: `src/lib/ai/`, `/agent-control`

## Contexto

El cliente (Jose Mujica, SBK Motorcycles) pidió que la IA "lea, analice y
contextualice para dar una respuesta rápida basada en las respuestas
predeterminadas que ya tengo". Los ejemplos que dio:

| Mensaje del cliente | Respuesta esperada |
|---|---|
| "Hola realicé una compra por Cashea" | Agradecimiento + texto de postventa |
| "Hice una compra hace días pero no me han enviado la guía" | Pedir cédula del titular de Cashea |
| Lo mismo, pero la compra no fue por Cashea | Pedir nombre y apellido |
| "Hola quiero accesorios" | Enviar catálogo general |
| "Buenas tardes, información de los niveles de Cashea" | Enviar plantilla de niveles |

"Y así sucesivamente con todo" — la lista va a crecer, así que el cliente
tiene que poder agregar escenarios sin que nadie toque código.

Hoy el agente (`src/lib/ai/agent.ts`) clasifica en 4 categorías genéricas
(`consulta_disponibilidad`, `devolucion`, `queja`, `otro`) y después
**redacta libre** con un tool loop. Los cinco casos de arriba caen todos en
`consulta_disponibilidad` u `otro`, y el texto que llega al cliente lo
inventa el modelo en vez de ser el texto oficial de la empresa.

## Alcance

1. Biblioteca de respuestas predeterminadas de la IA, administrable desde
   el CRM: cuándo aplica cada una, qué texto se envía, qué adjunto lleva y
   qué pasa después.
2. Fase de reconocimiento previa al flujo actual: si el mensaje coincide
   con un escenario cargado, se envía el texto oficial **verbatim** desde
   código; si no, cae al flujo de siempre.
3. Adjuntos: la IA gana la capacidad de enviar imagen / documento / video
   (hoy solo envía texto).
4. Panel de administración en `/agent-control`, con detección de
   escenarios faltantes a partir de los mensajes reales que no
   coincidieron con nada.

### Fuera de alcance (decidido explícitamente)

- **Biblioteca compartida con `quick_replies`.** Se evaluó extender la
  tabla existente y se descartó: los mensajes rápidos son un atajo de
  tipeo personal de cada asesor, mientras que las respuestas de la IA son
  discurso oficial de la empresa. Ciclos de vida y permisos distintos →
  tablas distintas. El panel ofrece un botón para **copiar** el texto de
  un mensaje rápido al crear un escenario, pero no quedan vinculados.
- **Búsqueda semántica / embeddings.** El enum dinámico aguanta cómodo
  hasta ~40 escenarios. Si SBK llega ahí, se migra el matcher sin tocar
  nada más.
- **Variables tipo `{{nombre}}`** en el texto de la respuesta.
- **Flujos de varios pasos con memoria de estado.** `after_send =
  'escalate'` cubre los casos reales de hoy: cuando hace falta un dato
  sensible, lo toma un humano.
- **Un tercer valor `continue` en `after_send`.** Se diseñó y se descartó
  por redundante: el mensaje siguiente del cliente ya abre un turno nuevo
  que hace su propia fase de reconocimiento y, si no coincide con nada,
  cae al flujo normal. `continue` y `wait` producían el mismo
  comportamiento observable.

## Esquema de base de datos

### Migración `20260821010000_ai_playbooks.sql`

```sql
create table public.ai_playbooks (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  trigger_description text not null,
  response_text text not null,
  attachment_url text,
  attachment_type text check (attachment_type in ('link', 'image', 'document', 'video')),
  after_send text not null default 'wait' check (after_send in ('wait', 'escalate')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_playbooks_attachment_pair check (
    (attachment_url is null and attachment_type is null)
    or (attachment_url is not null and attachment_type is not null)
  )
);
```

`name` es `unique` porque **es el valor del enum que ve el modelo** en la
fase de reconocimiento. Usar el nombre legible en vez del UUID hace que el
prompt de matching sea entendible y que los fallos sean depurables a
simple vista.

`ai_playbooks_attachment_pair` evita el estado a medias (una URL sin tipo
no se sabe cómo enviar).

### `link` vs. archivo adjunto

Los catálogos de SBK son **links que configura el cliente**, no archivos
subidos, y son varios: el escenario que coincida decide cuál link sale.
Esto obliga a distinguir dos formas de enviar una URL, porque la Cloud API
las trata distinto:

| `attachment_type` | Cómo se envía | Cuándo usarlo |
|---|---|---|
| `link` | La URL se anexa al final de `response_text`, como texto | Cualquier URL: catálogo web, Drive, Instagram, una carpeta compartida |
| `image` · `document` · `video` | `sendWhatsappMedia`, y **Meta descarga el archivo** desde la URL | Solo si la URL apunta directo al archivo (`.pdf`, `.jpg`) y es pública sin login |

La distinción no es cosmética: si Jose pega un link de Google Drive o de
una página web y el sistema intenta mandarlo como `document`, **Meta
rechaza el envío** porque no puede descargar un archivo de ahí. `link` es
el valor por defecto del formulario justamente porque es el que siempre
funciona.

Un catálogo por escenario: "Catálogo de accesorios", "Catálogo de cascos",
etc., cada uno con su `trigger_description`. El reconocimiento elige cuál,
igual que con cualquier otro escenario — no hace falta ninguna lógica
especial para catálogos.

`after_send` en inglés, igual que `agent_turns.action`.

```sql
create trigger set_ai_playbooks_updated_at before update on public.ai_playbooks
  for each row execute function public.set_updated_at();
```

### Cambios en `agent_turns`

```sql
alter table public.agent_turns
  add column playbook_id uuid references public.ai_playbooks (id) on delete set null,
  add column customer_message text;
```

`playbook_id` nullable: la mayoría de los turnos no van a coincidir con
ningún escenario. **No se agrega un valor nuevo a `agent_turns.action`** —
un playbook que responde es `answered` y uno que escala es `escalated`,
igual que hoy; `playbook_id` es lo que distingue el camino.

`customer_message` guarda el último mensaje del cliente de ese turno. Es
lo que alimenta la lista de escenarios faltantes: sin esto, el panel
podría decir "este turno no coincidió con nada" pero no *con qué* no
coincidió, y el cliente tendría que abrir cada conversación para saber
qué escenario le falta crear.

### RLS

```sql
alter table public.ai_playbooks enable row level security;

create policy "ai_playbooks_select" on public.ai_playbooks
  for select using (public.is_agent());

create policy "ai_playbooks_write" on public.ai_playbooks
  for all using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

grant select, insert, update, delete on public.ai_playbooks
  to authenticated, service_role;
```

El `grant` completo a `authenticated` es intencional y **no** debilita la
restricción: los `grant` de Postgres operan por rol de conexión, y todo
agente del CRM se conecta como `authenticated`. Limitar el `grant` a
`select` habría bloqueado también a los supervisores. Quien filtra por rol
de agente es RLS (`ai_playbooks_write`), no el `grant` — mismo criterio que
el resto del backend del agente.

Escritura restringida a supervisor/admin usando
`public.is_supervisor_or_admin()`, que ya existe
(`20260819090000_agents_supervisor_update_policy.sql`). Cualquier asesor
puede *ver* qué dice la IA; solo supervisión puede cambiarlo. Este es el
motivo principal por el que la biblioteca vive aparte de `quick_replies`,
que sigue abierta a todos.

```sql
alter publication supabase_realtime add table public.ai_playbooks;
```

### Semilla

`supabase/seeds/ai_playbooks.sql` con los cinco escenarios que dio el
cliente, como punto de partida editable desde el panel:

| `name` | `after_send` | Adjunto |
|---|---|---|
| Postventa Cashea | `wait` | — |
| Guía de envío · Cashea | `escalate` | — |
| Guía de envío · compra directa | `escalate` | — |
| Catálogo general | `wait` | `link` |
| Niveles de Cashea | `wait` | `link` |

Los textos de la semilla son un borrador razonable; el cliente los ajusta
desde el panel sin redeploy. Las dos filas con adjunto quedan con
`attachment_url` nulo hasta que Jose configure sus links — un escenario
sin adjunto envía solo su texto, así que la semilla es válida desde el
minuto cero.

## El turno del agente

### Fase 0 — reconocimiento de escenario

Nueva, antes de la clasificación actual. Va **dentro** del lock de
conversación y después de cargar el historial:

```
withConversationTurnLock:
  journey_stage = 'classifying'
  history = loadHistory()
  if history vacío → return

  playbooks = fetchActivePlaybooks()
  if playbooks.length > 0:
    match = matchPlaybook(history, playbooks)      ← Fase 0
    if match:
      runPlaybook(match)                            ← envío verbatim
      logTurn(playbook_id, tokens de fase 0)
      return

  ... flujo actual: classifyIntent → ToolLoopAgent
```

Si no hay escenarios activos, la fase 0 **no llama al modelo** y el costo
del turno es idéntico al de hoy.

### `src/lib/ai/playbooks.ts` (nuevo)

```ts
export interface Playbook {
  id: string;
  name: string;
  triggerDescription: string;
  responseText: string;
  attachmentUrl: string | null;
  attachmentType: "image" | "document" | "video" | null;
  afterSend: "wait" | "escalate";
}

export async function fetchActivePlaybooks(
  supabase: SupabaseClient<Database>
): Promise<Playbook[]>;

export async function matchPlaybook(
  history: ModelMessage[],
  playbooks: Playbook[]
): Promise<{ playbook: Playbook | null; usage: LanguageModelUsage }>;
```

`matchPlaybook` usa `generateObject` con `output: "enum"`, mismo patrón que
`classifyIntent` (`src/lib/ai/classify.ts:18`) y con
`getAgentModel("low")` — reconocer un escenario es una tarea de
clasificación, no de razonamiento.

El enum se arma con los `name` de los playbooks activos **más un valor
`"ninguno"` obligatorio**. El system prompt lista cada escenario como
`name: trigger_description` e instruye explícitamente a responder
`ninguno` ante la duda. Un falso positivo manda el texto equivocado a un
cliente real; un falso negativo solo cae al flujo actual, que ya funciona.
La asimetría de costo justifica sesgar el prompt hacia `ninguno`.

### Ejecución del escenario

`runPlaybook` no llama al modelo en ningún punto:

1. Envía `response_text` **tal cual**, sin pasarlo por el modelo. Si el
   adjunto es de tipo `link`, la URL va anexada al final de ese mismo
   mensaje.
2. Si el adjunto es `image` / `document` / `video`, lo envía como mensaje
   aparte vía `sendWhatsappMedia`.
3. Según `after_send`:
   - `wait` → `journey_stage = null`, `active_tool = null`. Fin del turno.
   - `escalate` → `escalateConversation(...)` con `motivo: "seguimiento"`
     y un resumen que nombra el escenario.
4. Registra en `agent_turns`: `action` (`answered` / `escalated`),
   `playbook_id`, `customer_message`, y los tokens de la fase 0.

Este es el punto central del diseño: **el modelo elige cuál respuesta, nunca
cómo se redacta.** Es la misma línea que ya sigue el proyecto — *"las reglas
de negocio que no pueden fallar no dependen de este prompt: están en
código"* (`src/lib/ai/prompt.ts:3`).

### Motivo de escalamiento nuevo

`EscalationMotivo` (`src/lib/ai/escalate.ts:16`) pasa de
`"devolucion" | "queja" | "intencion_compra"` a incluir `"seguimiento"`:
postventa y logística, que es lo que necesitan los escenarios de guía de
envío. No toca `deal_status` (eso sigue siendo exclusivo de
`intencion_compra`) ni etiqueta reclamos (exclusivo de `queja`).

### Envío con adjuntos — `src/lib/ai/send.ts` (nuevo)

`sendAgentReply` sale de `agent.ts` (donde hoy está en la línea 91) a un
módulo propio, y se le suma el envío de media:

```ts
export async function sendAgentText(supabase, conversation, text): Promise<void>;
export async function sendAgentMedia(
  supabase, conversation, type, url, caption?
): Promise<void>;
```

Ambas conservan el comportamiento actual frente a un canal simulado
(`status !== "connected"` o sin `WHATSAPP_ACCESS_TOKEN`): el mensaje se
inserta igual en `messages` aunque no salga por WhatsApp, para que el
simulador del panel siga funcionando.

`messages.message_type` ya acepta `image` / `document` / `video`
(`20260819050000_allow_sticker_message_type.sql`) y el bucket público
`whatsapp-media` ya existe, así que no hace falta infraestructura nueva
para los adjuntos.

## Los casos del cliente, resueltos

| Mensaje | Escenario | Qué hace |
|---|---|---|
| "Realicé una compra por Cashea" | Postventa Cashea | Texto · `wait` |
| "No me han enviado la guía" *(mencionó Cashea antes)* | Guía · Cashea | Pide cédula del titular · `escalate` |
| "No me han enviado la guía" *(sin mencionar Cashea)* | Guía · compra directa | Pide nombre y apellido · `escalate` |
| "Quiero accesorios" | Catálogo general | Texto + link del catálogo · `wait` |
| "Información de los niveles de Cashea" | Niveles de Cashea | Texto + link · `wait` |

La bifurcación Cashea / compra directa **no necesita un motor de reglas**:
son dos escenarios independientes, y como `matchPlaybook` recibe el
historial completo (no solo el último mensaje), distingue solo si el
cliente mencionó Cashea antes. La condicionalidad vive en el
reconocimiento, no en un árbol de decisión que haya que mantener.

## Panel de administración

Pestaña nueva **"Respuestas"** en `agent-control-view.tsx`
(`AgentControlTab` pasa a `"ia" | "agentes" | "respuestas"`), en un
componente propio `src/components/agent-control/playbooks-panel.tsx`.

**Lista de escenarios**: nombre, cuándo aplica, interruptor `is_active`,
indicador de adjunto y de `after_send`, con editar y borrar. Solo
supervisor/admin ve los controles de escritura (RLS lo bloquea igual del
lado del servidor).

**Formulario**: nombre · cuándo aplica · texto de la respuesta · adjunto ·
qué hacer después.

El campo de adjunto ofrece las dos vías: **pegar un link** (opción por
defecto, la que va a usar Jose para los catálogos) o **subir un archivo**
a `whatsapp-media`, con el mismo patrón que `composer.tsx:130`. Subir un
archivo fija `attachment_type` según el MIME; pegar un link lo deja en
`link` salvo que el usuario elija explícitamente otro tipo, con un aviso
de que Meta debe poder descargar el archivo directo desde esa URL.

**Importar desde mensajes rápidos**: selector de `quick_replies` que copia
`label` → `name` y `content` → `response_text`. Copia, no vínculo: a
partir de ahí son independientes.

**Escenarios faltantes**: turnos recientes con `playbook_id is null`,
mostrando `customer_message`, con un botón "Crear escenario con este
mensaje" que precarga el formulario. Esto es lo que hace operativo el "y
así sucesivamente con todo": en vez de que el cliente adivine de entrada
todos los escenarios, el sistema le va diciendo cuáles le faltan a partir
de conversaciones reales.

El simulador que ya existe en el panel sirve para probar un escenario
recién creado sin esperar a un cliente real.

## Contabilidad de tokens

La fase 0 consume tokens y hay que sumarlos en los dos caminos:

- **Con coincidencia**: el turno registra solo los tokens de la fase 0. Es
  **más barato que hoy**, porque se evitan la clasificación y el tool loop
  completos.
- **Sin coincidencia**: fase 0 + clasificación + tool loop. Es más caro que
  el flujo actual.

Se reusa `addTokens` (`agent.ts:54`), así que el gráfico de consumo y el
cálculo de costo en `/agent-control` siguen cuadrando sin cambios.

Con pocos escenarios activos, la mayoría de los turnos paga el sobrecosto
de una clasificación extra. El punto de equilibrio llega cuando la
biblioteca cubre buena parte del tráfico real — que es justamente para lo
que sirve la lista de escenarios faltantes.

## Guardrails

Sin cambios: la fase 0 vive **dentro** de `withConversationTurnLock` y
después de los cortes de `ai_globally_enabled`, `ai_enabled` y
`assigned_agent_id` (`agent.ts:167`). Un escenario no puede dispararse en
una conversación que ya tiene asesor humano, ni con la IA apagada.

La red de seguridad que fuerza el escalamiento en `devolucion` y `queja`
(`agent.ts:238`) no se toca: vive en el flujo genérico, y un turno
resuelto por playbook no pasa por ahí.

## Pruebas

Vitest, archivos junto al código (patrón de `tools.test.ts`,
`claim-agent.test.ts`).

`src/lib/ai/playbooks.test.ts`
- No llama al modelo cuando no hay escenarios activos.
- Arma el enum con los nombres de los escenarios más `"ninguno"`.
- Devuelve `null` cuando el modelo responde `"ninguno"`.
- Devuelve el playbook correcto cuando el modelo responde con su nombre.
- Un nombre desconocido en la respuesta del modelo se trata como `null`,
  no como error del turno.

`src/lib/ai/agent.test.ts` (nuevo)
- Con coincidencia: el mensaje insertado es **exactamente**
  `response_text`, y no se llama a `classifyIntent` ni al tool loop.
- `after_send: 'escalate'` llama a `escalateConversation`; `'wait'` deja
  `journey_stage` en `null`.
- Sin coincidencia: el flujo actual corre igual que hoy.
- El turno registra `playbook_id` y `customer_message` en ambos caminos.

`src/lib/ai/send.test.ts` (nuevo)
- Un escenario con adjunto `link` inserta **un** mensaje, con la URL
  anexada al texto.
- Un escenario con adjunto `document` inserta **dos** mensajes (texto +
  media) con el `message_type` correcto.
- Canal simulado: inserta en `messages` sin llamar a la Cloud API.

## Archivos

| Archivo | Cambio |
|---|---|
| `supabase/migrations/20260821010000_ai_playbooks.sql` | nuevo |
| `supabase/seeds/ai_playbooks.sql` | nuevo |
| `src/lib/ai/playbooks.ts` + test | nuevo |
| `src/lib/ai/send.ts` + test | nuevo (extrae `sendAgentReply` de `agent.ts`) |
| `src/lib/ai/agent.ts` + test | fase 0, `runPlaybook`, usa `send.ts` |
| `src/lib/ai/escalate.ts` | motivo `"seguimiento"` |
| `src/lib/types.ts` | `Playbook`, `PlaybookAfterSend`, campos nuevos de `AgentTurn` |
| `src/lib/data.ts` | `fetchPlaybooks`, `fetchUnmatchedTurns` |
| `src/lib/mutations.ts` | crear / editar / borrar / activar escenario |
| `src/components/agent-control/playbooks-panel.tsx` | nuevo |
| `src/components/agent-control/agent-control-view.tsx` | pestaña "Respuestas" |
| `src/app/agent-control/page.tsx` | carga inicial de escenarios |
