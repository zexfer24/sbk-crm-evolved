# Plan · La IA ve lo que llega

Aprobado por el operador el 8/9/2026. Rama `la-ia-ve-lo-que-llega` desde
`origin/main` (= `a9560d6` = producción, desplegado el 7/9 09:36 UTC; base
con 60/60 migraciones, verificado el mismo día por SSH). Orquestador: Fable.
Implementan subagentes `general-purpose` con `model: "sonnet"`, uno por
tarea, contexto limpio, reporte obligatorio. Copia final del plan en
`docs/planes/2026-09-08-la-ia-ve-lo-que-llega.md` (T8, este documento).

## Contexto

Cinco bugs medidos en producción el 7/9/2026 (ver brief del operador):
(1) `loadHistory` descarta toda fila sin `content`, así que fotos, audios y
stickers son invisibles para el modelo y un chat que arranca con un audio
sale del turno sin rastro y entra en bucle con el reconciliador (caso
`cea69118…`, 30 reencolados); (2) `journey_stage` queda en `classifying`
(17 hoy); (3) `reasoningEffort` se manda a un modelo vía OpenRouter que no
lo soporta; (4) `errorText` aplasta los `PostgrestError` a
`[object Object]`; (5) "ya escribió un humano" es vitalicio y deja muda a
la IA en el 100 % del backlog (caso `3b654d2c…`, un "a" del 28/8).

## Medido hoy en producción (solo lectura, SSH `mi-servidor-cloud`)

| Qué | Valor |
|---|---|
| Commit desplegado / migraciones | `a9560d6` / 60 |
| `classifying` sin lock vigente | 17 (0 `tool_running`) |
| Entrantes sin `content` en 7 días | image 830, audio 344, sticker 132, video 33, unsupported 3, document 1 |
| `awaiting_reply` abiertas cuyo historial seguiría vacío DESPUÉS de S1 | **0 de 269** → S4 es red de seguridad |
| Candidatas mudas (awaiting, IA on, sin asesor, abiertas, en ventana) | 48; con humano alguna vez: 47 |
| …con humano DESPUÉS del último mensaje del cliente | **0** (ver hallazgo 1) |
| …con humano hace < 30 min | 4 |
| Liberadas con G=30 / G=60 | **44 / 39** |
| `3b654d2c…` | lcma 7/9 12:54 UTC, último humano 6/9 18:40 UTC → se libera con cualquier G |
| `payload` de documentos entrantes | vacío: el webhook NO guarda el nombre del archivo |

## Hallazgos de la lectura que cambian el diseño respecto al brief

1. **`awaiting_reply = true` ya implica que ningún humano RESPONDIÓ después
   del último mensaje del cliente** (columna generada: `last_reply_at <=
   lcma`, y una respuesta de asesor mueve `last_reply_at`). Para el
   reconciliador y el backlog —que filtran por `awaiting_reply`— la parte
   (1) de S8 solo aporta con notas internas (no mueven `last_reply_at`);
   la cláusula que de verdad decide ahí es la gracia G. La parte (1) sí
   importa en `deliver()` (`humanWroteMeanwhile`) y al abrir el turno.
2. **Bug 2 tiene TRES puertas en `agent.ts`, no una**: el `return` por
   historial vacío (l. 846), el `return` por fallo de clasificación (l. 954,
   deja `classifying`) y el `catch` del tool loop (l. 1060-1069, limpia solo
   `active_tool` y deja `classifying`/`tool_running`). El corte de red del
   7/9 11:57 pasó por la segunda. T4 cierra las tres.
3. **El nombre del documento no existe en la base** (`payload` vacío para
   `document`; el webhook solo guarda `caption` en `content`). El marcador
   de documento va sin nombre; guardar `filename` en `payload` queda fuera
   de alcance (declarado).
4. **`DeliveryOutcome` se esparce entero en el `insert` de `messages`**
   (`...entrega`, `send.ts:126,157`): distinguir red de Meta no puede ser
   una columna nueva esparcida. Se distingue por `err instanceof
   MetaApiError` en `entregar()` (un 5xx de Meta sin código numérico sigue
   siendo Meta), viaja en un campo `origenDelFallo: "meta" | "red" | null`
   y los dos inserts pasan a elegir las cuatro columnas explícitamente.
   "Reintentable por la cola" se cumple por el reconciliador: un saliente
   `failed` no apaga `awaiting_reply` (T0.1), así que la conversación se
   reencola sola en ≤ 5 min; dentro del turno NO se reintenta (regla de
   `turn-delivery.ts`: una vez `intentado`, nunca se repite).
5. **`SYSTEM_PROMPT` completo ya calza con la guarda** ("asistente virtual",
   "bot" en la sección 1): el test de T3 pasa por `revealsIdentity` SOLO el
   bloque nuevo, exportado como constante, y verifica que `SYSTEM_PROMPT` lo
   contiene.
6. **Los marcadores de media saliente son líneas `assistant`**:
   `alreadySentPlaybook` y `alreadyRedirected` miran "la última respuesta
   nuestra"; si esa es `[El asesor envió una foto]` la comparación daría
   falso y se apoyaría solo en la red de 6 h. Decisión: las dos saltan
   marcadores (`isHistoryMarker`) y comparan contra el último texto real.
7. **`errorMessage` en `agent.ts:54` es un duplicado de `errorText`** con el
   mismo defecto. T6 lo elimina: un solo traductor.
8. **Docker Desktop está apagado en esta máquina** (`npipe` inexistente) y la
   base local del 54322 no responde: la validación SQL de T1 exige
   arrancarlo (decisión del operador) o apoyarse en el job `migraciones` de
   CI.
9. `human-handled.ts` no lleva `server-only` (lo importa `data.ts`): G se lee
   de `process.env.AI_HUMAN_GRACE_MINUTES` con default 30; en el navegador
   la variable no existe y cae al default, que es correcto.

## Decisiones de diseño (textos y mecanismos fijados por el plan)

**S1 — `src/lib/ai/history-line.ts` (nuevo, puro, sin `server-only`)**
`historyLine(row): { role: "user" | "assistant"; content: string; marcador: boolean } | null`
con `row = { sender_type, content, is_internal_note, message_type }` (las
mismas columnas que hoy pide `loadHistory`; `direction` no hace falta).
`null` = se salta. Reglas:

| Fila | Resultado |
|---|---|
| `is_internal_note`, `sender_type = 'system'`, `message_type = 'unsupported'` | `null` (como hoy) |
| `text`, `location`, `contacts`, `interactive`, `order`, `template`, `system_event` | `content` tal cual; `null` si vacío (como hoy) |
| cliente `image` con pie | `[El cliente envió una foto. Pie: <content>]` |
| cliente `image` sin pie | `[El cliente envió una foto sin texto; no puedes verla]` |
| cliente `video` con / sin pie | `[El cliente envió un video. Pie: …]` / `[El cliente envió un video sin texto; no puedes verlo]` |
| cliente `audio` | `[El cliente envió una nota de voz; no puedes escucharla]` |
| cliente `document` con / sin pie | `[El cliente envió un documento. Pie: …]` / `[El cliente envió un documento; no puedes abrirlo]` |
| cliente `sticker` | `[El cliente envió un sticker]` |
| saliente (`agent` o `ai`) `image`/`video`/`audio`/`document`/`sticker` | `[El asesor envió una foto]` / `un video` / `una nota de voz` / `un documento` / `un sticker`, con `. Pie: …` si hay `content` |

`isHistoryMarker(text) = /^\[(El cliente|El asesor) envió /.test(text)`.
`loadHistory` (`agent.ts`) pasa a `for … { const linea = historyLine(row);
if (linea) messages.push({ role, content }) }`. `messages.content` NO se
toca (restricción del brief).

**S3 — fase 0 ignora marcadores.** `lastCustomerMessage(history)` devuelve
`null` si la última línea `user` es marcador (nada con qué crear un
escenario). En `runTurnPhases`, si la última línea `user` es marcador, NO
se llama a `matchPlaybook` (match = `{ playbook: null, usage: ZERO_USAGE }`,
exportar `ZERO_USAGE` de `playbooks.ts`) y se deja `log.info(
"turno_ultimo_mensaje_sin_texto", { conversationId })`. La clasificación
de intención sí corre (define herramientas). Un texto posterior a la foto
("cualquiera de estos en talla L") es el caso normal: fase 0 corre con el
marcador en contexto.

**S2 — bloque nuevo en `SYSTEM_PROMPT`**, sección `7. LO QUE TE LLEGA SIN
TEXTO`, exportado como `MEDIA_RULES` (T3 fija la redacción; guía):
lo que va entre corchetes lo escribió el CRM y describe algo que llegó y
que no puedes ver ni escuchar — nunca lo cites; foto/video sin texto: no
adivines, pregunta en una sola pregunta qué repuesto es o qué busca (si
trae pie, atiende el pie); nota de voz: pide con naturalidad que te lo
escriba por acá; sticker solo: no lo comentes, sigue con lo último o
saluda si es lo primero; documento: dile que un asesor lo revisa y
pregunta qué necesita; **nunca expliques por qué no puedes verlo ni
digas qué eres** — solo pide lo que necesitas. Prohibido en el bloque
cualquier fragmento que calce con `identity-guard.ts`.

**S4 — historial vacío deja rastro** (`agent.ts` l. 846):
`log.warn("turno_sin_contenido_legible", { conversationId })` +
`recordHandoff({ toKind: "unassigned", reason: "sin_contenido_legible" })` +
`update conversations set journey_stage = null, active_tool = null`. Más las
otras dos puertas del hallazgo 2: el `return` de clasificación fallida y
el `catch` del tool loop también resetean `journey_stage: null, active_tool:
null` (ahí NO se escribe traspaso nuevo: ya escriben `agent_turns` con
`action: "error"` y el reconciliador las recoge). `HandoffReason` gana
`"sin_contenido_legible"`.

**S5 — backfill** en la migración de T1 (idempotente, `raise notice`).

**S6 — `AI_AGENT_REASONING=off|on`** (default `on`): `build()` adjunta
`providerOptions.openai.reasoningEffort` solo si está `on` y el proveedor
es OpenAI. Gobierna TODO lo que sale de `model.ts` (agente y clasificador).
Cabecera de `model.ts` corregida (proveedor OpenAI-compatible por
`OPENAI_BASE_URL`; hoy OpenRouter con `gpt-5.6-luna`, sin razonamiento).
Fallo de red ≠ rechazo de Meta según hallazgo 4: `rejectedByMeta` con
`origenDelFallo === "red"` → `log.error("turno_envio_fallo_de_red")` +
traspaso `entrega_fallida` (ya existe en CHECK y en `HandoffReason`) +
reset de etapa; con `"meta"` → `rechazado_por_meta` como hoy. `send.ts`:
`ia_envio_fallido` gana `origen: "meta" | "red"`.

**S7 — `errorText`**: `Error` → `message`; objeto con `message` string;
`code` presente ? `"${code}: ${message}"` : `message`; string → tal cual;
`undefined`/`null` → `"undefined"`/`"null"`; otro objeto →
`JSON.stringify` acotado a 300 caracteres; `String()` solo si el stringify
lanza.

**S8 — regla nueva de `human-handled.ts`**: un humano reclama el chat si
existe un mensaje `sender_type = 'agent'` (notas incluidas) con
`created_at > lcma` **o** `created_at > now − G min`. `lcma` null → `false`
(caso 5 del brief; nada que contestar). Firmas:
- `humanHasWritten(supabase, conversationId, { lastCustomerMessageAt, now?, graceMinutes? })`:
  consulta `select created_at … eq sender_type agent … order created_at desc limit 1`
  y compara en memoria.
- `conversationsWrittenByHumans(supabase, rows: { id, lastCustomerMessageAt }[], { now?, graceMinutes? })`:
  UNA consulta `select conversation_id, created_at … in(ids) … eq sender_type agent … gt created_at <umbral>`
  con `umbral = min(now − G, min(lcma_i))` (acota filas sin perder ninguna
  relevante) y decisión exacta en memoria por conversación.
- `humanGraceMinutes()` lee `AI_HUMAN_GRACE_MINUTES` (default **G = 30**,
  fijado por el operador el 8/9/2026; valor inválido o ausente → 30).
- Consumidores: `agent.ts:1255` pasa `convo.last_customer_message_at`;
  `deliver()` gana el parámetro `lastCustomerMessageAt` (lo tienen
  `runPlaybook` y `runTurnPhases`) y se lo pasa a `humanWroteMeanwhile`;
  `reconciler.ts` suma `last_customer_message_at` al `select`; `data.ts`
  cambia `unansweredFreeWork(supabase, "id")` por
  `"id, last_customer_message_at"` en `fetchBacklogConversationIds` y
  `fetchBacklogCounts`.
- "Reactivar IA" (`setAiEnabled`, `mutations.ts`) y "Desasignar"
  (`unassign`) ya escriben solo `ai_enabled`/`assigned_agent_id`; no
  dependen de nada más. T7 lo prueba con un test que recorre: humano viejo
  + `ai_enabled=true` + `assigned_agent_id=null` + cliente nuevo → turno
  pasa la guarda.

## Orden de ejecución (secuencial, un subagente por tarea, cada uno commitea)

T1 → T6 → T3 → T2 → T4 → T5 → T7 → T8. Secuencial porque T2, T4, T5, T6 y
T7 tocan `agent.ts`; T4 depende de T1 (la razón tiene que existir en el
CHECK) y de T2 (comparte el bloque del historial vacío).

## T1 · Migración + test SQL (commit `[migración] …`)

**Archivos:** `supabase/migrations/20260908010000_traspaso_sin_contenido_legible.sql`
(nuevo), `supabase/tests/traspaso_sin_contenido_legible.sql` (nuevo),
`.github/workflows/ci.yml` (paso nuevo en `migraciones`, mismo formato que
el de `ventana_24h.sql`), `docs/GLOSARIO.md` (fila en la tabla de
`supabase/`; el conteo "Migraciones (N)" sube en 1).

- Cabecera en español con el caso `cea69118-5d17-4f08-84c6-925755672b87`
  (audio 6/9 21:39 UTC, 30 reencolados, asesor a mano 7/9 13:15) y las 17
  `classifying` (la más vieja del 27/8).
- `drop constraint conversation_handoffs_reason_check` + `add constraint`
  con la lista COMPLETA vigente de `20260905030000` (24 valores) +
  `'sin_contenido_legible'`. Nada más. `comment on column` actualizado.
- Backfill S5 en `do $$`: `update conversations set journey_stage = null,
  active_tool = null where journey_stage in ('classifying','tool_running')
  and (ai_turn_lock_until is null or ai_turn_lock_until < now())`, `raise
  notice` con el conteo. Idempotente (reaplicable con `\i`).
- Sin funciones nuevas → sin revokes.

**Test** (formato `ventana_24h.sql`: `begin`, tabla temporal `_errores`,
bloques `do $$`, `\i` de la migración para el backfill, `rollback`,
`\echo`; ids `77777777-…`): (1) `record_handoff` acepta
`sin_contenido_legible`; (2) rechaza `razon_inventada` (captura
`check_violation`); (3) el backfill limpia un `classifying` sin lock
(`ai_turn_lock_until` null) y otro con lock vencido; (4) NO toca un
`classifying` con `ai_turn_lock_until = now() + interval '1 minute'`.

**Terminado:** `psql -f` del test en verde contra base local con la
migración aplicada (o CI si Docker sigue apagado); `permisos_funciones.sql`,
`invariante_leads.sql` y `awaiting_reply.sql` siguen en verde; reporte con
el CHECK final, salida cruda y conteo del backfill.

## T6 · `errorText` entiende los errores de Supabase (S7)

**Archivos:** `src/lib/log.ts`, `src/lib/log.test.ts` (existe: agregar
`describe("errorText")`), `src/lib/ai/agent.ts` (borrar `errorMessage`,
usar `errorText` en sus dos sitios), `docs/GLOSARIO.md` (fila `log.ts`).

Tests: `Error`; `PostgrestError` real (`new PostgrestError({ message,
details, hint, code: "PGRST301" })` de `@supabase/supabase-js`) →
`"PGRST301: …"`; objeto `{ message }` sin código; string; `undefined`;
`null`; objeto sin `message` → JSON acotado; objeto circular → no lanza.
Grep en el reporte: ningún `String(err` en `src/lib/ai`, `src/lib/log.ts`,
`src/lib/whatsapp` ni `src/app/api/webhooks`.

## T3 · Prompt + guarda de identidad (S2)

**Archivos:** `src/lib/ai/prompt.ts`, `src/lib/ai/prompt.test.ts`,
`docs/GLOSARIO.md` (fila `prompt.ts`).

- `export const MEDIA_RULES = \`7. LO QUE TE LLEGA SIN TEXTO …\``, incluido en
  `SYSTEM_PROMPT` (parte estática: el prefijo cambia una vez y vuelve a
  cachear). Numeración: la sección 6 "CÓMO ESCRIBES" queda antes; la 7 va
  al final del bloque estático.
- Tests: `SYSTEM_PROMPT` contiene `MEDIA_RULES`; `buildInstructions(...)`
  contiene `MEDIA_RULES`; `revealsIdentity(MEDIA_RULES)` es `null`; y un
  test "si el bloque dijera 'soy un asistente automatizado' la guarda lo
  atraparía" (`revealsIdentity(MEDIA_RULES + " soy un asistente
  automatizado")` no es null) para probar que el test mira lo que dice
  mirar. Las cuatro conductas (foto, audio, sticker, documento) aparecen
  en el texto (asserts por palabra clave: "foto", "nota de voz", "sticker",
  "documento").

## T2 · `loadHistory` describe media + fase 0 no reconoce marcadores (S1, S3)

**Archivos:** `src/lib/ai/history-line.ts` (nuevo),
`src/lib/ai/history-line.test.ts` (nuevo), `src/lib/ai/agent.ts`
(`loadHistory`, `lastCustomerMessage`, `alreadySentPlaybook`,
`alreadyRedirected`, salto de fase 0), `src/lib/ai/playbooks.ts` (exportar
`ZERO_USAGE`), `src/lib/ai/agent.test.ts`, `docs/GLOSARIO.md` (filas
`history-line.ts`, `agent.ts`, `playbooks.ts`).

Tests `history-line.test.ts`: una `it` por fila de la tabla de S1 (texto
EXACTO), más `isHistoryMarker` (marcadores → true; texto del cliente que
empieza con "[" → false; los marcadores no calzan con
`revealsIdentity`). Tests en `agent.test.ts` (extender `FakeState.history`
con `message_type` opcional, default `text`): "solo un audio ya no deja
historial vacío" (antes: `matchPlaybookMock` no se llamaba; ahora se
clasifica y se redacta, con la línea del audio como único `user`);
"`unsupported` sigue saltándose" (no romper el test existente);
"un marcador como último mensaje no llama a `matchPlaybook` ni deja
`escenario_no_se_repite`" (spy sobre `log.info`); "una foto seguida de
texto sí corre fase 0 con la foto en contexto";
"`agent_turns.customer_message` queda null cuando lo último es un
marcador"; "la última respuesta nuestra para `alreadySentPlaybook` salta
un marcador de foto del asesor".

## T4 · Salida por historial vacío con rastro + limpieza de etapa (S4, Bug 2)

**Archivos:** `src/lib/ai/agent.ts` (tres puertas del hallazgo 2),
`src/lib/ai/handoffs.ts` (`HandoffReason` + `"sin_contenido_legible"`),
`src/lib/ai/reconciler.ts` (solo el comentario de l. 152-168: la puerta
del historial vacío ya deja rastro y la de "humanos" cambia en T7),
`src/lib/ai/agent.test.ts`, `src/lib/ai/handoffs.test.ts` (si enumera
razones), `docs/GLOSARIO.md`.

Tests en `agent.test.ts`: historial vacío (solo `unsupported`) →
`handoffCalls` contiene `p_reason: "sin_contenido_legible"`,
`conversationUpdates` contiene `{ journey_stage: null, active_tool: null }`,
`turno_tiempos` sale con `entregado: false` (spy `log.info`); clasificación
fallida → reset de etapa; tool loop que lanza → reset de etapa (hoy solo
`active_tool`). Depende de T1 y T2.

## T5 · `reasoningEffort` condicional + fallo de red ≠ rechazo de Meta (S6)

**Archivos:** `src/lib/ai/model.ts`, `src/lib/ai/model.test.ts`,
`src/lib/ai/send.ts`, `src/lib/ai/send.test.ts`, `src/lib/ai/agent.ts`
(`rejectedByMeta` + firma de `deliver`/callers si hace falta),
`src/lib/ai/agent.test.ts`, `.env.local.example`, `.env.production.example`
(`AI_AGENT_REASONING`, comentario con el porqué: OpenRouter + Luna),
`docs/GLOSARIO.md` (filas `model.ts`, `send.ts`).

Tests `model.test.ts` (sumar `AI_AGENT_REASONING` a `VARIABLES`): sin la
variable → `providerOptions` presente con `reasoningEffort`; `off` →
`providerOptions` undefined (agente Y clasificador); `on` explícito →
presente; Google nunca lo lleva (ya). `send.test.ts`: `MetaApiError` con
código → `origenDelFallo: "meta"`, `whatsapp_error_code` numérico;
`new TypeError("fetch failed")` → `origenDelFallo: "red"`, código null, el
insert en `messages` sigue llevando SOLO las cuatro columnas de siempre
(assert sobre las claves del row insertado). `agent.test.ts`: envío con
`origenDelFallo: "red"` → traspaso `entrega_fallida`, no
`rechazado_por_meta`, etapa reseteada; con `"meta"` → `rechazado_por_meta`
(el test existente).

## T7 · "Escribió un humano" deja de ser vitalicio (S8)

**Archivos:** `src/lib/ai/human-handled.ts`, `src/lib/ai/human-handled.test.ts`,
`src/lib/ai/agent.ts` (l. 404 vía `deliver`, l. 1255), `src/lib/ai/agent.test.ts`
(fake de `messages`: mensajes humanos con `created_at`, cadena
`.eq().eq().order().limit()` y `.in().eq().gt()`), `src/lib/ai/reconciler.ts`
+ `reconciler.test.ts`, `src/lib/data.ts` + `src/lib/data-backlog.test.ts`,
`src/lib/mutations.test.ts` (o el archivo donde vivan `setAiEnabled`/`unassign`),
`.env.local.example`, `.env.production.example` (`AI_HUMAN_GRACE_MINUTES`),
`docs/GLOSARIO.md` (filas `human-handled.ts`, `reconciler.ts`, `data.ts`).
Cabecera de `human-handled.ts` reescrita: conserva la historia del 26/8 y
suma la del 7/9 (`3b654d2c…`, 47/48 mudas) y el porqué de G.

Tests `human-handled.test.ts` (los cinco casos del brief, espejo para la
unitaria y la de lote, con `now` fijo e inyectado y G inyectado):
(1) humano después de lcma → bloquea; (2) humano antes de lcma y hace más
de G → NO bloquea (el "a" del 28/8 vs cliente del 7/9); (3) humano antes
de lcma pero hace menos de G → bloquea (carrera asesor→cliente→IA);
(4) sin humano → NO bloquea; (5) lcma null → NO bloquea; más: nota interna
reciente bloquea igual; el lote solo consulta `messages` una vez; el
umbral `gt` de la consulta del lote es `min(now − G, min lcma)`. Los tests
del incidente del 26/8 que ya existen en ese archivo se mantienen verdes
(sus mensajes humanos deben tener `created_at` posteriores al del cliente
o dentro de G). `reconciler.test.ts` y `data-backlog.test.ts`: conversación
con humano viejo + cliente nuevo ahora SÍ se reencola / SÍ cuenta en el
backlog; con humano reciente sigue fuera. Test de "reactivar/desasignar
devuelven el chat": `setAiEnabled(true)` escribe solo `ai_enabled`,
`unassign` solo `assigned_agent_id`, y con ese estado más un cliente nuevo
`runAgentTurn` llega a clasificar.

Reporte: G final, consumidores tocados y la consulta de producción (la
misma de arriba) con el número de liberadas al valor de G aprobado.

## T8 · Documentación y glosario

- `docs/GLOSARIO.md`: revisar que T1–T7 dejaron sus filas; completar.
- `CLAUDE.md`: Arquitectura, reemplazar "si un humano ya escribió en el
  chat, la IA no entra" por la regla nueva con fecha 8/9/2026 y el caso
  `3b654d2c…`; Trampas: "`messages.content` es SOLO lo que el cliente
  escribió; el texto para el modelo de un multimedia lo arma `historyLine`,
  nunca la base. `errorText` es el único traductor de errores a texto de
  log. `AI_AGENT_REASONING=off` cuando el modelo no razona (OpenRouter +
  Luna): el SDK avisa `reasoningEffort is not supported` 3-4 veces por
  turno y el esfuerzo no se aplica".
- `docs/PRODUCCION.md`: §1 filas `AI_AGENT_REASONING` y
  `AI_HUMAN_GRACE_MINUTES`; §2 párrafo de `20260908010000` (qué corrige,
  consulta para contar `classifying` antes, verificación = 0 después); §7
  "En Dokploy": este deploy lleva migración + variable nueva, el orden
  (respaldo → variable en Environment → migración a mano → registrar →
  push); conteo de la comprobación final 60 → 61.
- `docs/planes/2026-09-08-la-ia-ve-lo-que-llega.md`: este plan + sección
  "Brief del operador" (el brief completo, como `2026-09-06-prompt-orquestador.md`)
  + "Resultado de la corrida".
- Nota para el operador en el reporte de entrega: el reconciliador va a
  reencolar de golpe las ~44 conversaciones mudas que sigan en ventana
  (tope 50 por pasada; cupos 3 simultáneos / 4 por minuto).

## Validación del orquestador (antes de cerrar cada tarea)

- Leer el reporte entero; sin reporte no hay tarea.
- Correr yo: `rtk npm run test`, `rtk npm run lint`, `rtk npx tsc --noEmit`;
  `psql -f` de los tests SQL contra la base local con la migración aplicada
  (exige Docker Desktop arriba) o, si no, la salida del job `migraciones`
  de CI en un PR de la rama.
- **Mutaciones** (cada una revertida después):
  - T1: quitar `'sin_contenido_legible'` del CHECK → caso (1) rojo.
  - T2: `audio` → `null` en `historyLine` → "solo un audio ya no deja
    historial vacío" rojo.
  - T3: pegar "soy un asistente automatizado" en `MEDIA_RULES` → test de
    la guarda rojo.
  - T5: forzar `providerOptions` siempre → "con off no manda
    providerOptions" rojo.
  - T6: volver `errorText` a `String(err)` → caso `PostgrestError` rojo.
  - T7: quitar la cláusula de gracia → caso (3) rojo; volver a "alguna
    vez" → caso (2) rojo.
- `git log`: la migración sola en su commit con `[migración]`, ANTES del
  commit de T4; ocho commits sobre `origin/main`.

## Salida a producción (solo con confirmación del operador, paso a paso; fuera del alcance de los subagentes)

1. Respaldo `pg_dump` a `/root/respaldos/sbk-<fecha>-pre-ia-ve-lo-que-llega.sql.gz`.
2. `AI_AGENT_REASONING=off` (y `AI_HUMAN_GRACE_MINUTES=<G>` si difiere del
   default) en Environment del compose en Dokploy, sin desplegar.
3. Migración a mano en `supabase-db` + registro en
   `supabase_migrations.schema_migrations`; comprobar `classifying` sin
   lock = 0 y 61 migraciones.
4. Merge fast-forward a `main` + push → webhook de Dokploy; seguir
   `deployment.allByCompose` (`5z7CrotCBgO9rTAOsZYH`) hasta `done`; si no
   arranca, `compose.deploy`. Verificar 12 labels de Traefik, `/api/health`
   y AUSENCIA del warning `reasoningEffort` en los logs nuevos.
5. Primeros 10 min: `reconciliador_encolo_huerfanas` con `encoladas` alto una
   vez, `turno_tiempos` con `entregado:true` al ritmo de los cupos, cero
   `turno_chat_de_una_persona` para humanos viejos; un
   `turno_persona_se_adelanto` sobre un chat que un asesor atiende AHORA =
   G corto → subir la variable sin redeploy.
6. Prueba en vivo con +584225157846 (`3b654d2c…`): "Hola" → la IA contesta;
   audio solo → pide que se lo escriban; foto sin texto → pregunta qué es.
7. Al día siguiente: `entregado:false` fuera de cortes de red ≈ 0; ningún
   `turno_sin_contenido_legible` repetido para la misma conversación; el
   conteo 47/48 baja a los chats con asesor activo de verdad.

## Fuera de alcance (declarado)

- Guardar el nombre del documento (`filename`) en `payload` desde el webhook.
- Reintentar dentro del mismo turno un envío que falló por red (regla de
  `turn-delivery.ts`); lo cubre el reconciliador.
- Recalcular `unread_count` o cualquier otra columna en el backfill.
- La píldora "Escaladas" de la bandeja (`journeyStage === "assigned"`) y
  `stageOf` del tablero: no cambian.
- Un candado tomado por el asesor al escribir desde el CRM (la ventana de
  ~1 s de la llamada a Meta sigue igual).

## Decisiones del operador (8/9/2026)

1. **G = 30 minutos** como default de `AI_HUMAN_GRACE_MINUTES` (libera 44 de
   las 48 mudas medidas hoy).
2. **Docker Desktop lo arranca el operador**: la validación SQL de T1 corre
   en local contra `supabase_db_Liminal_CRM` (54322), como en la corrida
   anterior.

---

## Brief del operador

El texto completo que el operador (vía el Claude del VPS, con acceso SSH a
producción) le dio al Claude orquestador para arrancar esta corrida, tal
cual, sin resumir:

> # Orquestador · "La IA ve lo que llega" · SBK CRM
>
> Eres el **orquestador** de esta entrega. Trabajas con la metodología `/liminalwork`:
> tú planificas, delegas y validas; **no implementas**. Cada tarea la ejecuta un subagente
> `general-purpose` con `model: "sonnet"` y razonamiento alto, uno por tarea, con contexto
> limpio, y te entrega un reporte que tú validas antes de cerrarla.
>
> Repositorio: el checkout de producción está en
> `/etc/dokploy/compose/sbk-crm-y-bot-frontend-zonhta/code` (producción = `origin/main` =
> `a9560d6`, desplegado el 7/9/2026 09:36 UTC; la migración `20260907010000` YA está
> aplicada en la base, verificado). Trabaja en una rama nueva `la-ia-ve-lo-que-llega`
> desde `origin/main`. Lee `CLAUDE.md`, `AGENTS.md` y `docs/GLOSARIO.md` antes de
> planificar. Respeta sus reglas: todo en español, comentarios que cuentan el porqué con
> fecha, commits narrativos, `[migración]` en el título del commit que agrega una migración
> y esa migración en commit separado del código que la usa, entrada de glosario por cada
> archivo tocado, tests junto al código, `rtk` delante de los comandos (`rtk npm run test`,
> `rtk npx vitest run <ruta>`, `rtk npm run lint`, `rtk npx tsc --noEmit`,
> `rtk proxy npm run build` — nunca `rtk next build`).
>
> Guarda el plan aprobado en `docs/planes/2026-09-08-la-ia-ve-lo-que-llega.md` con el
> mismo formato que `docs/planes/2026-09-07-ventana-24h-dice-la-verdad.md`.
>
> ---
>
> ## 1. Diagnóstico ya hecho (no lo vuelvas a derivar)
>
> Medido en producción el 7/9/2026 entre 09:42 y 14:10 UTC (logs del contenedor + base).
>
> ### Bug 1 · La IA es ciega a fotos, audios y stickers (grave)
>
> `loadHistory` (`src/lib/ai/agent.ts:158-180`) descarta toda fila con `!row.content`. El
> webhook (`src/app/api/webhooks/whatsapp/route.ts:1258-1262`) guarda imagen, audio, video,
> documento y sticker con `content = caption ?? null`: sin pie de foto, `content` es null.
> En 7 días: **108 de 1000 entrantes (10,8 %)** sin contenido — 64 imágenes, 36 audios,
> 8 stickers. Dos consecuencias:
>
> - **Sin texto previo → historial vacío** → `runTurnPhases` sale en `agent.ts:846`
>   (`if (history.length === 0) return;`) sin clasificar, sin redactar, sin escalar y **sin
>   escribir traspaso** — viola la invariante "ningún lead invisible" de `CLAUDE.md`. Caso
>   real: conversación `cea69118-5d17-4f08-84c6-925755672b87`, audio a las 21:39 UTC del
>   6/9, silencio 15,5 h; el reconciliador (`src/lib/ai/reconciler.ts`) la reencoló **30
>   veces** (turnos de ~50 ms, `entregado:false`) hasta que un asesor contestó a mano a las
>   13:15. Es el bucle perpetuo que el comentario de `reconciler.ts:157` cree cerrado: el
>   filtro de `conversationsWrittenByHumans` no cubre esta puerta.
> - **Con texto previo → la IA responde como si la foto no existiera.** Conversación
>   `7631718e-52bc-4448-99f2-586789c073ff`: dos fotos a las 13:09 y "Cualquier de estos en
>   talla L" a las 13:10; "estos" es invisible para el modelo.
>
> De 56 entrantes sin contenido en la semana, 30 quedaron sin respuesta o tardaron > 30 min,
> y siempre contestó un humano, nunca la IA.
>
> **Restricción de diseño que cambia el brief:** NO sintetizar texto en `messages.content`.
> La burbuja del chat (`src/components/chat/message-bubble.tsx:140-160`) pinta por
> `message_type` y usa `content` como pie de foto; `media-group.tsx`, `quoted-content.tsx` y
> `close-sale-modal.tsx:77` (comprobante de pago = imagen entrante) también dependen de que
> `content` sea SOLO lo que el cliente escribió. El texto para el modelo se construye en
> `loadHistory` a partir de `message_type`, sin tocar la base.
>
> ### Bug 2 · `journey_stage` se queda en "Clasificando"
>
> `runTurnPhases` escribe `journey_stage='classifying'` (`agent.ts:840-843`) ANTES de cargar
> el historial, y el `return` de historial vacío ocurre antes de los tres consumidores donde
> vive la limpieza (`agent.ts:553`, `:809`, `:978`, `:1145`). Hay **17 conversaciones** en
> `classifying` ahora mismo, la más vieja del 27/8/2026, sin lock y sin turno corriendo.
> `stageOf` en `dashboard.ts` ya no las honra en el tablero (ver Trampas en `CLAUDE.md`),
> pero la píldora de la bandeja y el campo crudo sí las muestran.
>
> ### Bug 3 · `reasoningEffort` es letra muerta
>
> `build()` en `src/lib/ai/model.ts:66-78` adjunta `providerOptions.openai.reasoningEffort`
> a TODO modelo del proveedor OpenAI. Producción corre `AI_AGENT_MODEL=openai/gpt-5.6-luna`
> a través de **OpenRouter** (`OPENAI_BASE_URL`), un modelo sin razonamiento: cada llamada
> emite `AI SDK Warning (openai.responses / openai/gpt-5.6-luna): The feature
> "reasoningEffort" is not supported`, 3-4 veces por turno. El esfuerzo configurado no se
> aplica. Además el comentario de `model.ts:9-12` ("OpenAI, directo, sin gateway") miente:
> el corte de las 11:57 UTC fue `getaddrinfo EAI_AGAIN openrouter.ai`
> (`escenario_reconocimiento_fallido`), y dejó 2 `ia_envio_fallido` con `detalle:"fetch
> failed"` que `rejectedByMeta` (`agent.ts:528-560`) trató como rechazo de Meta con
> `codigo:null` — un fallo de red no es un rechazo de Meta.
>
> ### Bug 4 · `[object Object]` en dos errores — la causa NO está en los sitios
>
> `turno_lock_no_liberado` (`src/lib/ai/conversation-lock.ts:127,132`) y
> `webhook_error_actualizar_estado` (`route.ts:903-906`) **ya llaman `errorText()`**. El
> problema es `errorText` mismo (`src/lib/log.ts:65-67`): `err instanceof Error ?
> err.message : String(err)`. Un `PostgrestError` de supabase-js (`{message, details, hint,
> code}`) no pasa el `instanceof` y `String()` lo aplasta a `[object Object]`. Un solo fix,
> en un solo archivo, arregla todos los sitios presentes y futuros.
>
> ### Bug 5 · "Ya escribió un humano" es vitalicio (grave — entra en esta entrega)
>
> `humanHasWritten` / `conversationsWrittenByHumans` (`src/lib/ai/human-handled.ts:60-95`)
> preguntan si existe **algún** mensaje `sender_type='agent'` en la conversación, alguna vez.
> Consumidores: `agent.ts:404` (guarda de apertura, dentro de `humanWroteMeanwhile`),
> `agent.ts:1255` (guarda al abrir el turno), `reconciler.ts:173`, `data.ts:2264,2300`
> (backlog de la bandeja). Efecto medido: de **37** conversaciones esperando respuesta ahora
> mismo con IA encendida y sin asesor asignado, **37** tienen un humano que escribió alguna
> vez → la IA está muda en el 100 % del backlog. "Reactivar respuestas automáticas" pone
> `ai_enabled=true`, que la guarda no lee; el chat `3b654d2c` (+584225157846) quedó mudo
> por un "a" que un supervisor escribió el 28/8/2026 (y dos imágenes el 6/9), y siguió mudo
> después de que el supervisor reactivara la IA el 7/9 09:55:47 UTC (dos
> `turno_chat_de_una_persona`, 10:33 y 12:54). No es un bug de implementación sino de
> alcance temporal de la regla: pregunta "¿alguna vez?" cuando debe preguntar "¿ahora?".
> Toca la guarda que protege a los asesores, así que se hace con cabeza (ver S8).
>
> ---
>
> ## 2. Solución a implementar
>
> **S1 — El historial describe lo que no puede leer, en vez de esconderlo.**
> `loadHistory` deja de descartar por `!row.content` y pasa a decidir por `message_type`:
>
> | `message_type` entrante | Texto para el modelo |
> |---|---|
> | `text`, `location`, `contacts`, `interactive`, `order` | `content` tal cual (si está vacío, se salta como hoy) |
> | `image` / `video` con pie | `[Foto/Video del cliente. Pie: <content>]` |
> | `image` / `video` sin pie | `[El cliente envió una foto/un video sin texto; no puedes verlo]` |
> | `audio` | `[El cliente envió una nota de voz; no puedes escucharla]` |
> | `document` | `[El cliente envió un documento<: nombre si viene en payload>; no puedes abrirlo]` |
> | `sticker` | `[El cliente envió un sticker]` |
> | `unsupported`, `system`, notas internas | se saltan (como hoy) |
>
> Los salientes `image` del asesor (comprobantes, fotos de producto) también reciben su
> marcador `[Foto enviada por el asesor]` para que el modelo entienda el hilo. Los textos
> exactos los fija el plan; la forma va en una función pura `historyLine(row)` exportada y
> probada aparte.
>
> **S2 — El prompt le dice al modelo qué hacer con lo que no ve.** Un bloque corto en
> `src/lib/ai/prompt.ts` (junto a las reglas de TURNO ACTUAL): ante una foto sin texto, pide
> que le digan qué es o qué busca; ante una nota de voz, pide con naturalidad que se lo
> escriba; ante un sticker solo, no lo comenta, sigue con lo último que se estaba hablando o
> saluda si es lo primero. **Nunca dice que "no puede ver imágenes por ser un sistema"** —
> la guarda de identidad (`identity-guard.ts`) lo bloquearía; el plan tiene que verificar
> con un test que la frase del prompt no calza con la guarda.
>
> **S3 — Fase 0 no reconoce escenarios sobre un marcador.** `lastCustomerMessage` y el
> reconocimiento de escenario (`classify.ts` / `playbooks.ts`) no deben comparar un playbook
> contra `[El cliente envió una foto…]`. El plan decide si `lastCustomerMessage` devuelve
> null para marcadores o si la fase 0 los ignora; en cualquier caso, un marcador como último
> mensaje NO puede disparar un escenario ni contar como "fue_la_ultima_respuesta".
>
> **S4 — La salida por historial vacío deja rastro y limpia la etapa.** Con S1, el
> historial vacío queda para casos residuales (solo `unsupported`, solo notas). Ese `return`
> pasa a: `log.warn("turno_sin_contenido_legible", …)` + `recordHandoff(… toKind:
> "unassigned", reason: "sin_contenido_legible")` + `journey_stage: null, active_tool:
> null`. Nueva razón en el CHECK de `conversation_handoffs.reason` → **migración**.
>
> **S5 — Backfill de las etapas congeladas.** En la misma migración de S4: `update
> conversations set journey_stage = null, active_tool = null where journey_stage in
> ('classifying','tool_running') and (ai_turn_lock_until is null or ai_turn_lock_until <
> now())`, con `raise notice` del conteo (esperado: 17). Idempotente.
>
> **S6 — El esfuerzo de razonamiento se manda solo a quien lo entiende.** `build()` adjunta
> `reasoningEffort` únicamente si el modelo lo soporta. Mecanismo a decidir en el plan, con
> esta restricción: la decisión tiene que ser de configuración, no de heurística sobre el
> nombre (`gpt-5.6-luna` no razona; un `gpt-5.6` sí podría). Propuesta: variable
> `AI_AGENT_REASONING=off|on` (default `on` para no cambiar el comportamiento de nadie que
> no la ponga; producción la pondrá en `off` hasta cambiar de modelo). Corregir el comentario
> de cabecera de `model.ts` (proveedor OpenAI-compatible vía `OPENAI_BASE_URL`; hoy
> OpenRouter) y que `ia_envio_fallido` / `rejectedByMeta` distingan **fallo de red** (sin
> `whatsapp_error_code`, mensaje `fetch failed`) de **rechazo de Meta** (con código): el
> fallo de red sigue reintentable por la cola, no escribe `rechazado_por_meta`.
>
> **S7 — `errorText` entiende los errores de Supabase.** Si `err` no es `Error` pero es un
> objeto con `message` string, devolver `message` (y `code` si existe: `"PGRST301: …"`);
> si no, `JSON.stringify` acotado; `String()` solo como último recurso. Test con un
> `PostgrestError` real importado de `@supabase/supabase-js`.
>
> **S8 (Bug 5) — "Escribió un humano" deja de ser vitalicio.** Arreglo en dos partes,
> aprobado por el operador:
>
> 1. `humanHasWritten` y `conversationsWrittenByHumans` filtran por
>    **`messages.created_at > conversations.last_customer_message_at`**: el asesor "se
>    adelantó" solo si escribió DESPUÉS de lo que la IA va a contestar. Un mensaje humano
>    anterior al último mensaje del cliente ya no reclama el chat.
> 2. "Reactivar la IA" y "desasignar" devuelven el chat a la IA **sin código nuevo**: con
>    (1), en cuanto el cliente vuelve a escribir no hay ningún mensaje humano posterior y la
>    guarda deja pasar. El plan verifica que esos dos botones no dependan de nada más (p. ej.
>    que `ai_enabled` vuelva a `true` y que `assigned_agent_id` quede null) y lo prueba.
>
> **Cláusula de gracia obligatoria.** (1) sola reabre la carrera que la guarda existe para
> evitar: el asesor contesta, el cliente responde a los dos minutos, ya no hay mensaje
> humano posterior al del cliente y la IA se mete a mitad de una venta. Por eso la regla
> final es: *un humano reclama el chat si escribió después de `last_customer_message_at`*
> **o** *si escribió hace menos de G minutos* (reloj de pared; G lo fija el operador en el
> plan — propuesta 30 min). Con G, el asesor que está conversando conserva el chat entre
> mensaje y mensaje; el "a" del 28/8 no lo conserva nunca. G se inyecta en las dos
> funciones (`now` opcional, como en `escalateConversation`) para poder probarlo, y en
> producción se lee de una variable de entorno (`AI_HUMAN_GRACE_MINUTES`, default 30) para
> poder ajustarla sin tocar código — va en `.env.example` y en la nota de despliegue de T8
> junto con `AI_AGENT_REASONING`.
>
> **Detalle de implementación que el plan resuelve.** Las dos funciones hoy solo consultan
> `messages`; para (1) necesitan `last_customer_message_at`. `agent.ts:1255` ya tiene
> `convo` cargado (pasarlo, no volver a leerlo); `reconciler.ts` ya trae las candidatas de
> `conversations` (agregar la columna al `select`); `data.ts` decide el plan. La versión en
> lote (`conversationsWrittenByHumans`) NO puede hacer la comparación correlacionada en
> PostgREST: traer `conversation_id, max(created_at)` de los mensajes humanos y comparar en
> memoria contra el mapa `id → lcma`. Los cuatro consumidores cambian en el mismo commit.
>
> **Efecto esperado al desplegar:** el reconciliador va a encontrar de golpe las ~37
> conversaciones mudas que sigan dentro de la ventana de 24 h y las va a reencolar en su
> primera pasada (tope 50 por pasada; los cupos de `AGENT_MAX_CONCURRENT_TURNS=3` y
> `AGENT_MAX_TURNS_PER_MINUTE=4` las gotean). Es la IA contestando lo que debía haber
> contestado, no un bug — pero el operador tiene que saberlo antes del push.
>
> ---
>
> ## 3. Fase de planificación (hazla tú, antes de desplegar a nadie)
>
> 1. Entra en Plan Mode. Lee `agent.ts` completo (es el archivo más tocado), `human-handled.ts`,
>    `reconciler.ts`, `model.ts`, `log.ts`, `prompt.ts`, `classify.ts`, `playbooks.ts`, la
>    rama media del webhook (`route.ts:1236-1420`) y las tres migraciones que definen
>    `conversation_handoffs.reason` (`20260830040000`, `20260905010000`, `20260905030000`) —
>    la nueva redefine el CHECK completo copiando la última lista vigente.
> 2. Confirma cómo corren los tests SQL (`supabase/tests/*.sql`, job `migraciones` de CI) y
>    los de TypeScript (`rtk npm run test`, vitest). Modelos: `agent.test.ts:514-540` (ya
>    prueba que `loadHistory` salta `unsupported`), `model.test.ts`, `prompt.test.ts`,
>    `identity-guard.test.ts`, `handoffs.test.ts`.
> 3. Mide en producción, antes de diseñar S4, cuántas conversaciones con `awaiting_reply`
>    seguirían dando historial vacío DESPUÉS de S1 (solo `unsupported`/notas). Si son cero,
>    S4 es red de seguridad; si no, hay que ver qué son.
> 4. Presenta el plan al operador con archivos, orden, tests y criterios de terminado.
>    Señala qué módulos sin cobertura se tocan y **pide explícitamente el valor de G** (la
>    gracia de S8). Espera aprobación.
>
> ## 4. Tareas para los subagentes (una por subagente, Sonnet, razonamiento alto)
>
> ### T1 · Migración + test SQL (commit propio, título con `[migración]`)
> - `supabase/migrations/20260908010000_traspaso_sin_contenido_legible.sql`: cabecera en
>   español con el caso `cea69118` del 6-7/9/2026; redefinir el CHECK de
>   `conversation_handoffs.reason` con la lista vigente + `sin_contenido_legible` (+ nada
>   más, salvo que S8 se apruebe y necesite algo); backfill S5 con `raise notice`.
> - Test `supabase/tests/traspaso_sin_contenido_legible.sql`, mismo formato que los vecinos:
>   (1) `record_handoff` acepta la razón nueva; (2) rechaza una razón inventada; (3) el
>   backfill limpia un `classifying` sin lock y (4) NO toca un `classifying` con lock
>   vigente.
> - Reporte: CHECK final, salida del job SQL en verde, conteo del backfill.
>
> ### T2 · `loadHistory` describe media + fase 0 no reconoce marcadores (S1, S3)
> - `historyLine(row)` pura y exportada en `agent.ts` (o módulo nuevo
>   `src/lib/ai/history-line.ts` si el plan lo prefiere, con su test al lado).
> - Tests: un caso por fila de la tabla de S1, más: historial que ANTES quedaba vacío (solo un
>   audio) ahora tiene una línea; `unsupported` sigue saltándose (no romper
>   `agent.test.ts:520`); un marcador como último mensaje NO dispara escenario ni
>   `escenario_no_se_repite`.
> - Reporte: textos finales de los marcadores, decisión tomada en S3 y por qué.
>
> ### T3 · Prompt + guarda de identidad (S2)
> - Bloque nuevo en `prompt.ts`; `prompt.test.ts` verifica que el bloque está y que sus
>   frases NO calzan con `identity-guard.ts` (test que pasa el texto del bloque por la guarda).
> - Reporte: texto final del bloque, salida de tests.
>
> ### T4 · Salida por historial vacío con rastro + limpieza de etapa (S4, Bug 2 en código)
> - El `return` de `agent.ts:846` pasa a registrar evento, traspaso y reset de etapa. Test en
>   `agent.test.ts`: con historial vacío se escribe `record_handoff` con
>   `sin_contenido_legible`, `journey_stage` queda null, y `turno_tiempos` sale con
>   `entregado:false`.
> - Depende de T1 (la razón tiene que existir en el CHECK) — se despliega después.
> - Reporte: diff del bloque, salida de tests.
>
> ### T5 · `reasoningEffort` condicional + fallo de red ≠ rechazo de Meta (S6)
> - `model.ts`: mecanismo aprobado en el plan, comentario de cabecera corregido,
>   `model.test.ts` con los dos caminos (con/sin `providerOptions`) y sin warning del SDK.
> - `agent.ts` (`ia_envio_fallido` / `rejectedByMeta`) y `send.ts`: fallo de red no escribe
>   `rechazado_por_meta`; test con `fetch failed` sin código.
> - `.env.example` (o donde el repo documente variables) con la variable nueva.
> - Reporte: qué variable, qué default, salida de tests.
>
> ### T6 · `errorText` (S7)
> - `log.ts` + `log.test.ts` (crear si no existe): `Error`, `PostgrestError`, objeto con
>   `message`, string, `undefined`, objeto sin `message`.
> - Reporte: salida de tests, y confirmación de que ningún sitio llama `String(err)` directo
>   en `src/lib/ai` ni en el webhook (grep).
>
> ### T7 · "Escribió un humano" deja de ser vitalicio (S8)
> - `human-handled.ts`: las dos funciones con la regla `created_at > lcma OR created_at >
>   now − G`, `now` y G inyectables; los cuatro consumidores (`agent.ts:404`, `agent.ts:1255`,
>   `reconciler.ts:173`, `data.ts:2264,2300`) en el mismo commit, cada uno pasando el `lcma`
>   que ya tiene o agregándolo a su `select`.
> - `human-handled.test.ts` (casos espejo para la versión unitaria y la de lote):
>   (1) humano escribió DESPUÉS del último mensaje del cliente → bloquea;
>   (2) humano escribió ANTES del último mensaje del cliente y hace más de G → NO bloquea
>       (el caso `3b654d2c`: "a" del 28/8, cliente escribe el 7/9);
>   (3) humano escribió antes del último mensaje del cliente pero hace menos de G → bloquea
>       (la carrera asesor→cliente→IA);
>   (4) sin ningún mensaje humano → NO bloquea (no romper lo que hoy funciona);
>   (5) `lcma` null (lead sin mensajes) → NO bloquea.
> - `reconciler.test.ts` y el test del backlog en `data.ts`: una conversación con humano
>   viejo y cliente nuevo ahora SÍ se reencola / SÍ aparece en el backlog.
> - Verificar (y probar) que "reactivar la IA" y "desasignar" (`mutations.ts` o donde vivan)
>   dejan `ai_enabled=true` / `assigned_agent_id=null` y no dependen de nada más para que
>   (1) las devuelva a la IA.
> - Reporte: G final, lista de consumidores tocados, salida de tests, y la consulta en
>   producción de cuántas de las 37 quedarían liberadas con la regla nueva (solo lectura).
>
> ### T8 · Documentación y glosario
> - `docs/GLOSARIO.md`: entradas de archivos nuevos/tocados.
> - `CLAUDE.md`, sección Trampas: "`messages.content` es SOLO lo que el cliente escribió;
>   el texto para el modelo de un mensaje multimedia lo arma `historyLine`, nunca la base.
>   `errorText` es el único traductor de errores a texto de log." Y reescribir la frase de
>   Arquitectura "si un humano ya escribió en el chat, la IA no entra" con la regla nueva:
>   "si un humano escribió después del último mensaje del cliente, o hace menos de G min,
>   la IA no entra" (con fecha y el caso `3b654d2c`).
> - Nota de despliegue en `docs/PRODUCCION.md` (o el runbook vigente): **este deploy lleva
>   migración y una variable de entorno nueva** (`AI_AGENT_REASONING=off` en Dokploy).
>
> ## 5. Validación del orquestador (obligatoria antes de cerrar cada tarea)
>
> - Leer el reporte completo. Sin reporte, la tarea no existe.
> - Correr tú mismo `rtk npm run test`, `rtk npm run lint`, `rtk npx tsc --noEmit` y el
>   test SQL sobre una base reconstruida (o un subagente de verificación que pegue la salida
>   cruda).
> - **Pruebas de mutación** (verificación reforzada):
>   - T2: cambiar el marcador de `audio` para que devuelva null → el test "solo un audio ya no
>     deja historial vacío" debe ponerse rojo.
>   - T3: meter "soy un asistente automatizado" en el bloque nuevo → el test de la guarda debe
>     ponerse rojo.
>   - T5: forzar `providerOptions` siempre → el test "sin razonamiento no manda
>     providerOptions" debe ponerse rojo.
>   - T6: volver `errorText` a `String(err)` → el caso `PostgrestError` debe ponerse rojo.
>   - T1: quitar `sin_contenido_legible` del CHECK → el caso (1) del `.sql` debe ponerse rojo.
>   - T7: quitar la cláusula de gracia (dejar solo `created_at > lcma`) → el caso (3) debe
>     ponerse rojo; volver la regla a "alguna vez" → el caso (2) debe ponerse rojo.
>   Si un test no se rompe, no cubre lo que dice cubrir: devolver la tarea.
> - Confirmar que `git log` tiene la migración en su propio commit con `[migración]`, ANTES
>   del commit de T4 que la usa.
>
> ## 6. Salida a producción (solo con confirmación del operador, paso a paso)
>
> **Orden obligatorio — el push a `main` dispara el deploy solo (webhook de Dokploy); el
> código llegaría antes que la base y que la variable:**
>
> 1. Respaldo: `docker exec supabase-db pg_dump …` a
>    `/root/respaldos/sbk-<fecha>-pre-ia-ve-lo-que-llega.sql.gz`.
> 2. Poner `AI_AGENT_REASONING=off` en el entorno del compose en Dokploy (sin desplegar aún).
> 3. Aplicar la migración a mano en `supabase-db` y registrarla en la tabla de migraciones
>    como se hizo con `20260907010000`. Comprobar: `select count(*) from conversations where
>    journey_stage = 'classifying'` debe dar 0 (sin locks vigentes).
> 4. Merge a `main` y push → el webhook despliega. Seguir el estado en
>    `GET /api/deployment.allByCompose?composeId=5z7CkrotCBgO9rTAOsZYH` hasta `done`; si no
>    arranca solo, `compose.deploy` (nunca `compose.redeploy`). Verificar los 12 labels de
>    Traefik, `/api/health` y que en los logs del contenedor nuevo **no aparece** el warning
>    `reasoningEffort`.
> 5. Los primeros 10 minutos después del deploy: mirar los logs. Debe aparecer
>    `reconciliador_encolo_huerfanas` con `encoladas` alto una sola vez (las ~37 liberadas
>    por S8), seguido de `turno_tiempos` con `entregado:true` al ritmo de los cupos, y **cero**
>    `turno_chat_de_una_persona` para conversaciones cuyo último mensaje humano sea viejo.
>    Si aparece un `turno_persona_se_adelanto` en un chat que un asesor está atendiendo
>    ahora mismo, G es corto: subirlo por variable de entorno sin redeploy de código.
> 6. Prueba en vivo con el número de pruebas (+584225157846, chat `3b654d2c`): con S8 ese
>    chat ya no está mudo (el último mensaje humano es del 6/9 18:40, anterior al del
>    cliente). Mandar "Hola" → la IA contesta; mandar un audio solo → pide que se lo
>    escriban; mandar una foto sin texto → pregunta qué es.
> 7. Al día siguiente, medir: `turno_tiempos` con `entregado:false` fuera del corte de red
>    debe ser ~0; no debe haber `turno_sin_contenido_legible` repetido para la misma
>    conversación (eso sería el bucle otra vez, por otra puerta); y el conteo "esperando
>    respuesta, IA encendida, sin asesor, con humano que escribió alguna vez" que dio 37/37
>    el 7/9 debe bajar a los chats con un asesor activo de verdad.
>
> Entrega al operador un cierre con: qué cambió, evidencia de tests (salida real), estado del
> deploy, la métrica del punto 6 y qué quedó fuera, si algo quedó fuera.

## Resultado de la corrida

Ejecutada el 8/9/2026, siete commits sobre `a9560d6` (rama
`la-ia-ve-lo-que-llega`), en este orden:

- `0fbed32` — **`[migración]` Un turno sin contenido legible deja rastro y
  las etapas congeladas se limpian** (T1). Amplía el CHECK de
  `conversation_handoffs.reason` con `sin_contenido_legible`; backfill que
  limpia `journey_stage`/`active_tool` a null en `classifying`/`tool_running`
  sin lock vigente. Test `traspaso_sin_contenido_legible.sql` (cuatro
  casos), cableado en CI. Archivos: `.github/workflows/ci.yml` (+14),
  `docs/GLOSARIO.md` (+3/-1),
  `supabase/migrations/20260908010000_traspaso_sin_contenido_legible.sql`
  (+94), `supabase/tests/traspaso_sin_contenido_legible.sql` (+171).
- `f2eaea2` — **Los errores de Supabase llegan al registro con su código y
  su mensaje** (T6). `errorText` deja de aplastar un `PostgrestError`/
  `AuthError`/`StorageError` a `[object Object]`: revisa `message`+`code`
  antes de `instanceof Error`; `agent.ts` pierde el `errorMessage`
  duplicado. Archivos: `docs/GLOSARIO.md` (+2/-1), `src/lib/ai/agent.ts`
  (+2/-6), `src/lib/log.test.ts` (+57), `src/lib/log.ts` (+47/-2).
- `1805084` — **El guion le dice a la IA qué hacer con una foto, un audio
  o un sticker que no puede leer** (T3). `MEDIA_RULES` (sección
  `7. LO QUE TE LLEGA SIN TEXTO` de `SYSTEM_PROMPT`), verificada contra
  `identity-guard.ts`. Archivos: `docs/GLOSARIO.md` (+1/-1),
  `src/lib/ai/prompt.test.ts` (+55), `src/lib/ai/prompt.ts` (+39/-1).
- `333ba6f` — **La IA ve que le llegó una foto, un audio o un sticker
  aunque no pueda abrirlos** (T2). `history-line.ts` nuevo (`historyLine`,
  `isHistoryMarker`); `loadHistory` deja de descartar filas sin `content`;
  fase 0 no reconoce escenario sobre un marcador (`ZERO_USAGE` exportada de
  `playbooks.ts`); `alreadySentPlaybook`/`alreadyRedirected` saltan
  marcadores salientes. Archivos: `docs/GLOSARIO.md` (+4/-1),
  `src/lib/ai/agent.test.ts` (+141/-4), `src/lib/ai/agent.ts` (+88/-8),
  `src/lib/ai/history-line.test.ts` (+306), `src/lib/ai/history-line.ts`
  (+117), `src/lib/ai/playbooks.ts` (+6/-1).
- `2f236d6` — **Un turno sin nada legible deja rastro y ninguna salida del
  turno congela la etapa** (T4). El `return` por historial vacío escribe
  `record_handoff(sin_contenido_legible)` y limpia la etapa;
  `resetStage()` compartida por las tres puertas del hallazgo 2 (historial
  vacío, clasificación fallida, `catch` del tool loop). `HandoffReason`
  suma `sin_contenido_legible`. Archivos: `docs/GLOSARIO.md` (+3/-1),
  `src/lib/ai/agent.test.ts` (+104), `src/lib/ai/agent.ts` (+88/-8),
  `src/lib/ai/handoffs.ts` (+12/-1), `src/lib/ai/reconciler.ts` (+16).
- `05cf784` — **El esfuerzo de razonamiento solo viaja a un modelo que lo
  entiende, y un corte de red ya no se confunde con un rechazo de Meta**
  (T5). `AI_AGENT_REASONING=off|on` (default `on`) gobierna
  `providerOptions.openai.reasoningEffort` en `model.ts`; `send.ts` suma
  `origenDelFallo: "meta" | "red" | null` (por tipo de excepción, no por
  código) y `columnasDeEntrega()` reemplaza el `...entrega` esparcido;
  `agent.ts` (`rejectedByMeta` → `deliveryFailed`) bifurca por
  `origenDelFallo`: `"red"` deja `entrega_fallida` sin marcar
  `rechazado_por_meta`. Archivos: `.env.local.example` (+10),
  `.env.production.example` (+10), `docs/GLOSARIO.md` (+6/-3),
  `src/lib/ai/agent.test.ts` (+109), `src/lib/ai/agent.ts` (+79/-14),
  `src/lib/ai/handoffs.ts` (+11/-1), `src/lib/ai/model.test.ts` (+64),
  `src/lib/ai/model.ts` (+46/-4), `src/lib/ai/send.test.ts` (+75),
  `src/lib/ai/send.ts` (+47/-2).
- `b51143e` — **Un asesor conserva el chat mientras conversa, no para
  siempre** (T7). `humanClaimsChat(lastHumanAt, lastCustomerMessageAt, now,
  graceMinutes)`, función pura compartida por `humanHasWritten` (consulta
  individual) y `conversationsWrittenByHumans` (lote, una sola consulta);
  bloquea solo si el humano escribió DESPUÉS del último mensaje del
  cliente o hace menos de `AI_HUMAN_GRACE_MINUTES` (default 30, fijado por
  el operador). Cuatro consumidores actualizados: `agent.ts` (guarda de
  apertura y `deliver()`), `reconciler.ts`, `data.ts`
  (`fetchBacklogConversationIds`/`fetchBacklogCounts`). Archivos:
  `.env.local.example` (+9), `.env.production.example` (+10),
  `docs/GLOSARIO.md` (+8/-6), `src/lib/ai/agent.test.ts` (+96/-17),
  `src/lib/ai/agent.ts` (+34/-16), `src/lib/ai/handoffs.test.ts` (+15/-2),
  `src/lib/ai/human-handled.test.ts` (+466/-17),
  `src/lib/ai/human-handled.ts` (+206/-18),
  `src/lib/ai/reconciler.test.ts` (+79/-7), `src/lib/ai/reconciler.ts`
  (+29/-5), `src/lib/ai/turn-correlation.test.ts` (+3/-2),
  `src/lib/data-backlog.test.ts` (+90/-7), `src/lib/data.ts` (+27/-5),
  `src/lib/mutations.test.ts` (+32).

**Validación del orquestador:** suite `rtk npm run test` verde con 1718
tests en 120 archivos tras T7 (subiendo desde los 1621/119 de la corrida
anterior); `rtk npx tsc --noEmit` y `rtk npm run lint` limpios. Mutaciones
de T2, T3, T4, T5, T6 y T7 verificadas por su propio subagente: cada una
puso rojo el test que decía cubrir (revertidas después). **La validación
SQL de T1 (`psql -f supabase/tests/traspaso_sin_contenido_legible.sql`) y
su mutación quedaron PENDIENTES**: Docker Desktop estuvo apagado toda la
corrida (decisión del operador: lo arranca él antes del push) y la base
local del puerto 54322 no respondió; el resto de la migración (CHECK,
backfill idempotente, formato del test) se revisó leyendo el `.sql`, no
ejecutándolo.

Medido en producción el 8/9/2026 (solo lectura, antes del deploy): 0 de
269 historiales de conversaciones `awaiting_reply` quedarían vacíos tras
S1 (confirma que S4/T4 es red de seguridad, no el camino común); con
G = 30, 48 de 49 candidatas mudas (`awaiting_reply`, IA encendida, sin
asesor, abiertas, en ventana) quedan liberadas — la única que sigue
bloqueada tiene un asesor conversando ahora mismo (gracia funcionando
como se diseñó).

**Pendiente antes del push a `main`:**

1. Correr `psql -f supabase/tests/traspaso_sin_contenido_legible.sql`
   (más `permisos_funciones.sql`, `invariante_leads.sql`,
   `awaiting_reply.sql`, `ventana_24h.sql`) contra la base local con
   Docker Desktop arriba, y su mutación (quitar `sin_contenido_legible`
   del CHECK → caso (1) debe ponerse rojo).
2. La salida a producción completa (respaldo → `AI_AGENT_REASONING=off`
   en Dokploy → migración a mano + registro → push a `main` → verificar
   ausencia del warning `reasoningEffort` y `reconciliador_encolo_huerfanas`
   con `encoladas` alto una vez), tal como la describe la sección "Salida
   a producción" arriba — fuera del alcance de los subagentes y de este
   documento, queda para cuando el operador confirme paso a paso.

**Deuda declarada** (sección "Fuera de alcance" de este plan, más lo que
anotaron los subagentes durante la corrida):

- El nombre del documento (`filename`) no se guarda en `payload` desde el
  webhook: el marcador de documento entrante va sin nombre.
- Reintentar dentro del mismo turno un envío que falló por red no está
  cubierto (regla de `turn-delivery.ts`: una vez intentado, no se repite);
  lo cubre el reconciliador reencolando la conversación.
- El backfill de T1 no recalcula `unread_count` ni ninguna otra columna
  además de `journey_stage`/`active_tool`.
- La píldora "Escaladas" de la bandeja (`journeyStage === "assigned"`) y
  `stageOf` del tablero no cambiaron en esta corrida.
- Un candado tomado por el asesor al escribir desde el CRM sigue con la
  ventana de ~1 s de la llamada a Meta, sin tocar.
- El trigger de status (`handle_message_status_change`) no dispara si
  SOLO cambia `whatsapp_error_code` sin cambiar `whatsapp_status` junto
  con él (hoy ambos escritores —el asesor y el callback de Meta— siempre
  cambian los dos juntos, así que no se observó en la práctica, pero
  queda anotado como supuesto no verificado por un test).

Esta sección de "Resultado de la corrida" (T8) se escribió con contexto
limpio a partir de los siete commits, este plan y el resto de la
documentación del repositorio — no participó en T1-T7, así que lo anterior
es una lectura del resultado, no un reporte de primera mano de esas
tareas.
