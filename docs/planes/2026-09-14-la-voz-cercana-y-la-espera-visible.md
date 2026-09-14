# Plan · La voz cercana y la espera visible (14/9/2026)

> **Para quien ejecute:** metodología `liminalwork` (plan aprobado → un
> subagente por tarea → reporte → validación del orquestador). Los subagentes
> corren como `subagent_type: "implementador"` (Sonnet, esfuerzo alto,
> `.claude/agents/implementador.md`). Los pasos usan casillas `- [ ]`. El
> prompt orquestador listo para pegar está al final.

**Objetivo:** cerrar la última grieta antes de declarar la versión **v1.1
estable**: que la IA suene cercana (no tajante), salude bien y una sola vez,
no se trague la pregunta del cliente, no deje a nadie esperando sin que se
vea, tenga salida ante fotos y audios, y que lo que la base cuenta del turno
sea verdad.

**Fuentes:** la auditoría "72 horas en el buzón" (727 conversaciones, 11/9
15:00 → 14/9 15:00 VET, artefacto `8DmjraAEufTqy83s5YpEyU`) y el reporte
directo del cliente: *la IA da los buenos días, buenas tardes y buenas
noches*, y *es muy tajante y para nada amigable con los leads*.

**Enfoque:** ocho tareas de código (una migración chica, el resto en
`lib/ai/` y el prompt), seis tareas operativas del panel que ningún código
reemplaza, y una verificación en producción a 48 h con las mismas métricas
de la auditoría. Al cerrar en verde se etiqueta `v1.1`.

**Stack:** Next 16 (App Router), Vitest 4 (`pool: forks`), Supabase
self-hosted, Redis, Vercel AI SDK (`ToolLoopAgent`), modelo `gpt-5.6-luna`
vía OpenRouter.

**Base:** `main` local = `5721ad3` (tres commits del CI en verde sin push;
`origin/main` = `38a540e`; producción = `38a540e` según el VPS el 13/9).
**Confirmar con el operador en qué commit está producción antes de calcular
migraciones.** Una migración nueva (`20260914010000`), sin variables de
entorno nuevas.

---

## Contexto: qué dijo la auditoría y dónde vive en el código

Cada hallazgo se verificó contra el código el 14/9/2026. Lo que está
confirmado se marca ✔; lo que sigue siendo hipótesis, ✘.

| # | Hallazgo (auditoría / cliente) | Dónde vive | Estado |
|---|---|---|---|
| 1 | La IA saluda por franja ("¡Buenas noches!") y a veces con la franja equivocada (3 casos); el cliente no quiere ese saludo. | `business-hours.ts:turnClockLine` mete `franja: tarde (saluda "buenas tardes")` en TURNO ACTUAL de **cada** turno; `prompt.ts` sección 6 manda copiarlo; los tres escenarios de saludo de producción empiezan con el saludo de franja y `greeting-window.ts` los filtra por hora. | ✔ |
| 2 | Tono tajante: "No podemos confirmar existencia ni precio; te paso con un asesor." | `prompt.ts`: el sufijo `missingCatalog` ("no afirmes existencia ni precio… ofrece pasar el caso") y la búsqueda de catálogo **apagada desde el 25/8** (`20260825010000` la siembra en `false`). Los textos fijos (`OFF_TOPIC_REPLY`, `DESPEDIDA_*`, la instrucción de `buildEscalateTool`) son secos. El turno no recibe el nombre del cliente (`runAgentTurn` solo selecciona `contact:contacts(phone_number)`). | ✔ |
| 3 | La promesa "un asesor te va a atender" cuenta como respuesta: la escalada desaparece de Pendientes (170 promesas ≥30 min, 23 sin cumplir). | `agent.ts:1387-1400`: `isAutoReply: outcome.escalated && outcome.unassigned === true` — con asesor asignado el mensaje sale con `is_auto_reply = false`, el trigger `handle_new_message` lo cuenta como respuesta real y apaga `awaiting_reply`. Mismo hueco en el camino de escenario con `afterSend = "escalate"` (`agent.ts:935-985`, solo marca si `unassigned`). Consecuencia extra: `waitingMinutes` (`dashboard.ts`) devuelve `null` sin `awaitingReply`, así que **"Con asesor" nunca cuenta atascados**. | ✔ |
| 4 | El escenario de saludo se traga la pregunta (53 casos: "Buenas tardes, tienen tanque de EK Xpress"). | `playbooks.ts:matchPlaybook` filtra por hora (`playbooksAtTime`) pero no por la FORMA del mensaje; el prompt del clasificador solo advierte "ante la duda, ninguno". | ✔ |
| 5 | Despedida o REDES con una escalada abierta ("Ok, muchas gracias" → "¡Gracias por preferirnos!"). | Tras la devolución masiva a la IA del 13/9 (`ai_enabled = true`, asesor quitado), el "gracias" reencolado corre fase 0 y calza el escenario de despedida. Nada mira si la última fila de `conversation_handoffs` es una escalada sin respuesta humana. | ✔ |
| 6 | Escaladas fuera de horario con asesor: 50 de 108 sin respuesta; la IA promete "te va a atender" a las 11 pm. | `claim-agent.ts` reparte por `is_active` (bandera permanente del roster, no presencia). `buildEscalateTool` con asesor devuelve "Dile al cliente que un asesor lo va a atender" sin mirar el horario; solo el camino SIN asesor nombra la próxima apertura (`unassignedEscalationInstruction`). | ✔ |
| 7 | Fotos y audios sin texto: la IA repite la misma pregunta hasta 10 veces sin escalar. | `MEDIA_RULES` (prompt) manda preguntar; nada cuenta cuántas veces ya preguntó. `history-line.ts` ya marca cada adjunto. | ✔ |
| 8 | Los asesores no pueden reproducir las notas de voz ("no se nos reproducen"). | `message-bubble.tsx` usa `<audio>` nativo con el `audio/ogg; codecs=opus` de Meta. Safari/iOS no reproduce Opus en OGG. Sin confirmar qué navegador usan los asesores. | ✘ |
| 9 | Los turnos "fuera de tema" no quedan registrados (3 visibles, 0 en bitácora). | `20260819040000_agent_backend.sql:114,157`: los CHECK de `agent_turns.intent` y `conversations.intent` admiten cuatro valores y **no** `fuera_de_tema`; `logTurn` (`agent.ts:433`) y `update({ intent })` (`agent.ts:1203`) ignoran el `error`. | ✔ |
| 10 | 13 turnos en que la IA "figuró apagada" con el interruptor encendido y gasto de 0,87 $; coinciden con cortes de base. | `stillEnabled` (`agent.ts:503-512`) devuelve `false` ante un error de la RPC y `deliver` escribe traspaso `agente_no_puede_correr`; en la apertura, `runAgentTurn` lee `{ data: canRun }` sin mirar `error`, así que un fallo de red también cae en `turno_saltado_ia_apagada`. **Hipótesis confirmada en el código.** El corte de base en sí (41 estados de WhatsApp perdidos) es infraestructura del VPS. | ✔ código / ✘ causa del corte |
| 11 | 151 preguntas sin respuesta propia: 99 de catálogo, el resto de biblioteca (6 entradas hoy). Horario del domingo distinto entre el panel y lo que dice el asesor. | Datos del panel (`/agent-control`): interruptor de catálogo, biblioteca, escenarios, `business_hours`. | ✔ operativo |
| 12 | Ritmo: 138 veces al tope de 30 turnos/min. | `AGENT_MAX_TURNS_PER_MINUTE=30` (escalón actual). Se sube siempre junto con las otras cuatro (ver CLAUDE.md). | ✔ operativo |
| 13 | Rotación: en 155 de 375 escaladas respondió otro asesor. | No hay presencia ni turnos de guardia en el modelo; es la Etapa 2 (`owner_kind` + `response_due_at`). | ✔ fuera de alcance |

**Sobre el reporte del cliente, dos lecturas posibles y una sola solución.**
"La IA da los buenos días, buenas tardes y buenas noches" puede querer decir
que saluda por franja cuando la tienda prefiere un "hola" neutro, o que
saluda con la franja equivocada, o que saluda en cada mensaje. Las tres se
cierran con la misma regla: **la IA saluda una sola vez por conversación,
con un saludo neutro que no depende de la hora, y en el resto de la
conversación no saluda**. Un "¡Hola!" nunca sale mal a ninguna hora. Si el
operador prefiere conservar el saludo por franja, la Decisión 1 tiene su
alternativa escrita.

## Decisiones (se aprueban con este plan)

1. **Saludo neutro y único.** El turno deja de recibir `franja … (saluda
   "…")` en TURNO ACTUAL; queda la hora, el horario y si la tienda está
   abierta (eso sí lo necesita para vender fuera de horario). El sufijo
   `needsGreeting` pide "¡Hola!" o "¡Buenas!" y presentarse como SBK
   Motorcycles; si ya hubo saludo, prohíbe saludar de nuevo. Los tres
   escenarios de saludo de producción los reemplaza el operador por UNO
   neutro (tarea O3); `greeting-window.ts` se queda tal cual, fallando
   abierto, por si algún escenario sigue empezando con "buenas tardes".
   *Alternativa si el operador la prefiere:* conservar la franja solo en el
   sufijo de primer saludo (`needsGreeting`) y quitarla del resto; el resto
   del plan no cambia.
2. **La IA tutea y suena de mostrador.** Nueva sección "CÓMO SUENAS" en el
   prompt: agradece, reconoce lo que pidió el cliente antes de responder,
   explica en una frase qué va a pasar cuando pasa el caso, nunca contesta
   una pregunta con una sola línea seca, usa el nombre del cliente cuando lo
   sabe (no en cada mensaje), como mucho un emoji. Los textos fijos que hoy
   son secos se reescriben. Los escenarios del panel con "usted" ("¿En qué
   podemos ayudarle?") los unifica el operador a "tú" (O3).
3. **La promesa de un asesor no es una respuesta.** Todo texto que la IA
   manda en el turno en que escaló —haya o no asesor asignado— sale con
   `is_auto_reply = true`. La conversación sigue `awaiting_reply` hasta que
   una persona escriba; aparece en "Pendientes" y en "Tuyas" del asesor
   asignado, y "Con asesor" del Recorrido empieza a contar atascados de
   verdad (60 min laborales, umbral que ya existe). No se toca la base: el
   trigger de `20260905010000` ya hace el resto. El reconciliador no la
   reencola porque `ai_enabled = false`.
4. **Fase 0 no elige un saludo si el mensaje trae más que un saludo.** Una
   regla determinista en código, antes del modelo: si el último mensaje del
   cliente no es SOLO un saludo, los escenarios de saludo (los que empiezan
   saludando: hola/buenas/buenos/bienvenid…) salen de los candidatos. Y **no
   se despide con una escalada abierta**: si el último mensaje es solo
   cortesía ("gracias", "ok", "perfecto", "listo", 👍) y el último traspaso
   de la conversación es `escalada`/`escalada_sin_asesor` sin que un asesor
   haya escrito después, el turno se calla y deja traspaso
   `cortesia_tras_escalada` (razón nueva, migración T1).
5. **Al segundo adjunto sin texto se escala.** Si el cliente manda dos
   fotos/audios/videos/documentos seguidos sin pie y la IA ya pidió una vez
   que le escribiera, el turno escala con motivo `seguimiento`, resumen que
   cuenta qué llegó, y manda una línea cálida fija ("te paso con un asesor
   para que revise lo que mandaste"). Sin tool loop: es código, no el
   modelo.
6. **La promesa dice cuándo.** Con asesor asignado y la tienda cerrada, la
   instrucción de `buildEscalateTool` y la despedida fija nombran la próxima
   apertura ("un asesor te escribe el lunes a partir de las 8:30 am"), igual
   que ya hace el camino sin asesor. `escalateConversation` devuelve
   `businessStatus` siempre.
7. **La bitácora no miente.** Migración `20260914010000`: `fuera_de_tema`
   entra a los dos CHECK de `intent` y `cortesia_tras_escalada` al de
   `reason`. `logTurn` y el `update({ intent })` registran el error con
   `errorText`. Un error de la RPC `agent_can_run` (no un `false`) **lanza**
   en vez de tratarse como "IA apagada": la cola reintenta (tres intentos,
   `MAX_ATTEMPTS`) y `entrega.intentado` sigue en `false`, así que no hay
   riesgo de doble envío. Falla cerrado igual: no se envía.
8. **Casos nuevos en el guion, no en código:** patrocinios, listas de
   precios ajenas y número equivocado son `fuera_de_tema` (respuesta fija);
   horario se responde desde TURNO ACTUAL sin escalar; agotado con "avísame"
   y listas largas/mayoreo escalan con `seguimiento` y un resumen ordenado
   (la herramienta gana ese motivo en su enum). No se construye un registro
   de avisos de reposición: es Etapa 2.
9. **Fuera de alcance de esta corrida:** presencia/turnos de guardia y
   reasignación automática (Etapa 2, `response_due_at`); transcodificar
   audios; estabilizar la conexión con la base (recomendación al VPS, abajo);
   el registro de avisos de reposición. Cada uno queda anotado en "Deuda".

## Reglas para todos

- Leer `CLAUDE.md` y `docs/GLOSARIO.md` antes de tocar nada. Todo en español;
  los comentarios cuentan el porqué y la historia, con fecha, no el qué.
- Los subagentes NO commitean, NO hacen push y NO editan `docs/GLOSARIO.md`
  ni `CLAUDE.md`: entregan la línea de glosario propuesta por archivo tocado
  y el orquestador la aplica al commitear.
- Reporte obligatorio: qué implementaron y decidieron, archivos tocados,
  salida de sus tests, de `rtk npx tsc --noEmit` y de `rtk npm run lint`,
  desvíos y dudas. El orquestador corre él mismo esos tres comandos y la
  suite (`rtk npm run test`) antes de cerrar cada tanda.
- Pruebas de mutación: `cp <archivo> <scratchpad>/<archivo>.bak` antes de
  mutar y restaurar con `cp`. **Nunca `git checkout -- <archivo>`.**
- Todo texto nuevo que pueda llegarle al cliente pasa por `revealsIdentity`
  en un test estático (patrón de `prompt.test.ts` "identidad: ni IA ni
  persona" y de `agent.test.ts` con las despedidas).
- `queue.test.ts`/`redis-queue.test.ts` se saltan sin Redis: ninguna tarea
  de esta corrida toca la cola, así que no hace falta levantarlo.
- Si un paso que debe dar rojo da verde (o al revés), parar y reportarlo.
- Si dos tests de `crm-shell.test.tsx` fallan al cruzar la medianoche de
  Caracas, es la trampa conocida: repetir.

## Archivos

| Archivo | Tarea | Cambio |
|---|---|---|
| `docs/planes/2026-09-14-la-voz-cercana-y-la-espera-visible.md` | 0 | Este plan |
| `docs/planes/2026-09-14-prompt-orquestador.md` | 0 | El prompt del final |
| `supabase/migrations/20260914010000_intenciones_y_traspasos_completos.sql` | 1 | Crear: `fuera_de_tema` en los dos CHECK de `intent`; `cortesia_tras_escalada` en `reason` |
| `supabase/tests/intenciones_y_traspasos_completos.sql` | 1 | Crear: los tres valores se aceptan |
| `src/lib/business-hours.ts` + `.test.ts` | 2 | `turnClockLine` sin franja ni saludo |
| `src/lib/ai/greeting-window.ts` | 2 | Solo comentario: sigue vivo como red para escenarios viejos |
| `src/lib/ai/prompt.ts` + `.test.ts` | 2 | Sección 6: saludo neutro y único; sufijo `needsGreeting` |
| `src/lib/ai/prompt.ts` + `.test.ts` | 3 | Sección nueva "CÓMO SUENAS"; `customerName` en el sufijo; textos fijos cálidos |
| `src/lib/ai/customer-name.ts` + `.test.ts` | 3 | Crear: primer nombre presentable a partir de `display_name`/`profile_name` |
| `src/lib/ai/turn-target.ts` | 3 | `AgentConversation.contact` gana `display_name`/`profile_name` |
| `src/lib/ai/agent.ts` + `.test.ts` | 3 | Select del contacto; `customerName` a `buildInstructions`; despedidas cálidas |
| `src/lib/ai/tools.ts` + `.test.ts` | 3 | Instrucciones de escalada cálidas |
| `src/lib/ai/saludo.ts` + `.test.ts` | 4 | Crear: `isPureGreeting`, `isCourtesyOnly`, `isGreetingPlaybook` |
| `src/lib/ai/playbooks.ts` + `.test.ts` | 4 | `matchPlaybook` recibe el último texto del cliente y descarta saludos |
| `src/lib/ai/handoffs.ts` + `.test.ts` | 4 | `cortesia_tras_escalada` en `HandoffReason`; `escalationOpen()` |
| `src/lib/ai/agent.ts` + `.test.ts` | 4 | Guarda de cortesía tras escalada antes de fase 0 |
| `src/lib/ai/agent.ts` + `.test.ts` | 5 | `is_auto_reply` en toda salida de un turno que escaló; `logTurn`/`intent` registran error; `stillEnabled`/apertura lanzan ante error de RPC |
| `src/lib/ai/escalate.ts` + `.test.ts` | 5 | `businessStatus` siempre en el resultado |
| `src/lib/ai/tools.ts` + `.test.ts` | 5 | Instrucción con asesor según horario |
| `src/lib/ai/history-line.ts` + `.test.ts` | 6 | `mediaStreakWithoutText(history)` |
| `src/lib/ai/agent.ts` + `.test.ts` | 6 | Escalada al segundo adjunto sin texto |
| `docs/diagnosticos/2026-09-14-notas-de-voz.md` | 6b | Crear: diagnóstico del audio que no se reproduce (sin código salvo que sea trivial) |
| `src/lib/ai/prompt.ts` + `.test.ts` | 7 | 5.4/5.5 y sección 3: no-clientes, horario, agotado, listas largas |
| `src/lib/ai/classify.ts` + `.test.ts` | 7 | `fuera_de_tema` incluye a quien no es cliente |
| `src/lib/ai/tools.ts` + `.test.ts` | 7 | `seguimiento` en el enum de `escalarAAsesor` |
| `CLAUDE.md`, `docs/GLOSARIO.md`, `docs/PRODUCCION.md` | 8 | Trampas nuevas, glosario, lista operativa de v1.1 |

---

## Tarea 0 · El plan a mano (orquestador, sin subagente)

- [ ] Guardar este plan en `docs/planes/2026-09-14-la-voz-cercana-y-la-espera-visible.md`
      y el prompt orquestador en `docs/planes/2026-09-14-prompt-orquestador.md`.
- [ ] Confirmar con el operador: (a) en qué commit está producción, (b) la
      Decisión 1 (saludo neutro) o su alternativa, (c) si los tres commits
      del CI (`059fe34…5721ad3`) se pushean antes o junto con esta corrida.
- [ ] Commit: `El plan de la voz cercana y la espera visible queda escrito`.

## Tarea 1 · [migración] La base acepta lo que el código ya escribe

**Contexto.** `agent_turns.intent` y `conversations.intent` nacieron con
cuatro valores (`20260819040000_agent_backend.sql:114,157`) y `classify.ts`
devuelve cinco desde que existe `fuera_de_tema`: cada turno fuera de tema
falla el `insert` de `logTurn` y el `update` de la intención en silencio.
T4 va a escribir la razón de traspaso `cortesia_tras_escalada`, que el CHECK
de `conversation_handoffs.reason` (última versión en
`20260905030000_handoff_reasons_cierre.sql` y `20260908010000`) no admite.

- [ ] Crear `supabase/migrations/20260914010000_intenciones_y_traspasos_completos.sql`:
  - `alter table public.agent_turns drop constraint agent_turns_intent_check`
    (verificar el nombre real con `\d agent_turns` en la base local; si el
    CHECK es inline sin nombre, usar el nombre generado que muestre
    `pg_constraint`) y recrearlo con los cinco valores de `INTENT_VALUES`.
  - Lo mismo con `conversations_intent_check` (nombrado en `:156`).
  - `conversation_handoffs_reason_check`: copiar la lista vigente completa
    (la de `20260908010000`, que es la última que la tocó) más
    `cortesia_tras_escalada`, con su comentario de una línea.
  - Bloque `do $$` final de autoverificación: intenta un `insert` de prueba
    en una transacción que se revierte (o consulta `pg_get_constraintdef`)
    y hace `raise exception` si alguno de los tres valores no está.
  - Sin backfill: no hay filas que corregir (los inserts rechazados nunca
    existieron).
- [ ] Crear `supabase/tests/intenciones_y_traspasos_completos.sql` con el
      patrón de `traspaso_sin_contenido_legible.sql`: (1) un `agent_turns`
      con `intent = 'fuera_de_tema'` se inserta; (2) un `update` de
      `conversations.intent = 'fuera_de_tema'` pasa; (3) `record_handoff(...,
      'cortesia_tras_escalada')` deja fila; (4) un valor inventado sigue
      rechazado.
- [ ] Verificar contra la base local (`docker exec` al contenedor de
      Postgres, ver memoria "CLI de supabase rota"): aplicar la migración y
      correr el test SQL.
- [ ] Reporte: nombres reales de los tres constraints y la salida del test.

**Commit (aparte, primero de la corrida):** `[migración] La base acepta los
turnos fuera de tema y la cortesía tras una escalada`.

## Tarea 2 · La IA saluda una vez, con un hola que no depende de la hora

**Contexto.** `turnClockLine` (`business-hours.ts`) pone en TURNO ACTUAL
`franja: tarde (saluda "buenas tardes")` en cada turno; la sección 6 del
prompt manda copiarlo. Resultado: la IA saluda por franja, a veces con la
franja mal (3 casos en 72 h) y a veces en mitad de una conversación. El
cliente reportó exactamente eso. Decisión 1.

- [ ] `business-hours.ts`: `turnClockLine` devuelve
      `Hora local: <fecha>, <hora>. Horario de atención: <horario>. Ahora
      mismo: <estado>.` — sin `franja` ni `saluda`. `dayBand`/`greetingFor`
      se conservan (los usa `playbooks.ts:buildPrompt` para los disparadores
      horarios de los escenarios y `greeting-window.ts`). Comentario con la
      fecha y el porqué (reporte del cliente, 14/9/2026).
- [ ] `business-hours.test.ts`: ajustar los tests de `turnClockLine`; agregar
      "nunca trae la palabra saluda ni un saludo de franja" con regex
      `/saluda|buenos días|buenas tardes|buenas noches/i`.
- [ ] `prompt.ts` sección 6: reemplazar "Cuando saludes, usa la franja…" por:
      *Saludas UNA sola vez por conversación, y solo cuando TURNO ACTUAL te
      diga que es el primer mensaje: un "¡Hola!" o un "¡Buenas!" y de dónde
      escribes. Nunca saludes por la hora —ni buenos días, ni buenas tardes,
      ni buenas noches— y nunca vuelvas a saludar en un mensaje posterior,
      aunque el cliente salude otra vez: respóndele lo que preguntó.*
- [ ] `prompt.ts` `buildInstructions`: sufijo `needsGreeting` → *Es el
      primer mensaje que recibe de nosotros: saluda con un hola breve, dile
      que le escribes de SBK Motorcycles y responde en el mismo mensaje.*;
      si no → *Ya hubo saludo en esta conversación: no saludes de nuevo, ve
      directo a lo que preguntó.*
- [ ] `prompt.test.ts`: (a) `buildInstructions(...)` a las 8:30 pm y a las
      8:10 am no contiene `buenas noches`/`buenos días`/`franja`; (b) el
      bloque estático sigue sin hora; (c) los tests "a las 8:30 pm… dice
      noche y buenas noches" y "la regla es copiar la franja…" se
      reescriben a la regla nueva; (d) el sufijo con `needsGreeting` nombra
      "SBK Motorcycles" y sigue pasando `revealsIdentity`.
- [ ] `greeting-window.ts`: solo el comentario de cabecera: desde el
      14/9/2026 el saludo del flujo genérico es neutro; este filtro queda
      como red para escenarios del panel que sigan empezando con un saludo
      de franja (falla abierto, no se toca).
- [ ] Mutación: volver a poner `(saluda "${saludo}")` en `turnClockLine` →
      el test (a) debe ponerse rojo. Restaurar con `cp`.

**Commit:** `La IA saluda una sola vez y con un hola que no depende de la hora`.

## Tarea 3 · La IA suena de mostrador: cercana, con nombre y sin cortar en seco

**Contexto.** Los textos que el cliente recibe hoy son secos por tres vías:
el guion no tiene reglas de calidez (solo "cercano, directo, sencillo" en
la sección 1), los textos fijos son fríos (`OFF_TOPIC_REPLY`,
`DESPEDIDA_SIN_ASESOR`, `DESPEDIDA_CON_ASESOR`, el sufijo `missingCatalog`,
las instrucciones de `buildEscalateTool`), y el modelo no sabe cómo se llama
el cliente aunque `contacts.profile_name` lo trae Meta en cada webhook.
Decisión 2.

- [ ] Crear `src/lib/ai/customer-name.ts` (puro, sin `server-only`):
      `customerFirstName(displayName: string | null, profileName: string |
      null): string | null`. Prefiere `display_name` (editado por el asesor)
      sobre `profile_name`. Devuelve el primer token si parece un nombre:
      solo letras (con acentos) y de 2 a 20 caracteres; capitaliza ("JOSE
      RIERA" → "Jose", "maría" → "María"). Devuelve `null` si es un
      teléfono, solo emojis/símbolos, una sola letra, o contiene dígitos.
      Test con esos casos y con "SBK Motos" (devuelve "Sbk": aceptable, el
      prompt dice "si el nombre no parece de persona, no lo uses").
- [ ] `turn-target.ts`: `AgentConversation.contact` gana `display_name` y
      `profile_name` (opcionales, `string | null`). `agent.ts:runAgentTurn`
      selecciona `contact:contacts(phone_number, display_name,
      profile_name)`.
- [ ] `prompt.ts`: `TurnContext.customerName?: string | null`. Sufijo:
      `El cliente se llama <Nombre>: úsalo con naturalidad, en el saludo o
      cuando le respondas algo importante, no en cada mensaje. Si no parece
      un nombre de persona, no lo uses.` Solo si viene nombre.
- [ ] `prompt.ts`: nueva sección **"CÓMO SUENAS"** entre la 1 y la 2 (o como
      6-bis; elegir lo que menos rompa la numeración citada en los tests) con
      estas reglas, en prosa breve: (1) tuteas siempre; (2) antes de dar un
      dato, reconoce en media frase lo que pidió ("¡Claro! El tanque de la
      EK Xpress…"); (3) cuando pasas el caso, dices en una frase por qué y
      qué va a pasar ("para confirmarte precio y existencia te paso con un
      asesor, que te escribe por acá"), nunca solo "te paso con un asesor";
      (4) una pregunta nunca se contesta con una sola línea seca ni con un
      "no"; (5) agradeces cuando el cliente da un dato o espera; (6) como
      mucho un emoji por mensaje y solo 🏍️, 👍 o 🙌; (7) si el cliente está
      molesto, primero la disculpa, después la solución; (8) no uses
      "estimado", "le informamos", "procedemos", "en breve estaremos": son
      de correo.
- [ ] Textos fijos, reescritos y pasados por `revealsIdentity` en test:
  - `OFF_TOPIC_REPLY`: *Por acá te ayudamos con repuestos y accesorios para
    tu moto 🏍️. Si buscas algo de eso, dime qué necesitas y con gusto te lo
    reviso.*
  - `DESPEDIDA_SIN_ASESOR`: *Listo, dejé tu caso registrado para que un
    asesor lo revise. En cuanto haya alguien disponible te escribe por acá;
    gracias por la paciencia.*
  - `DESPEDIDA_CON_ASESOR`: pasa a ser la función `despedidaConAsesor(status)`
    (T5 le da el horario); texto base: *Dame un momentico: ya le paso tu
    caso a un asesor para que te ayude con esto y te escriba por acá.*
  - Sufijo `missingCatalog`: *La búsqueda de catálogo está apagada: no
    afirmes existencia ni precio. Dile con calidez que un asesor se lo
    confirma por acá y pasa el caso.*
  - `buildEscalateTool` con asesor: *Ya está asignado a X. Dile al cliente,
    con calidez, que un asesor toma su caso y le escribe por acá; agradécele
    la espera.* (T5 le suma el horario).
- [ ] `prompt.test.ts`: la sección nueva existe en el bloque estático (sigue
      cacheable: idéntico se salude o no); el sufijo con nombre lo incluye y
      sin nombre no; los cinco textos pasan `revealsIdentity`; el bloque no
      contiene "estimado".
- [ ] `agent.test.ts`: el select del turno pide `display_name` y
      `profile_name`; `buildInstructions` recibe `customerName` cuando el
      contacto tiene nombre y `null` cuando es un teléfono.
- [ ] Opcional (verificación reforzada, si el operador la pide): un script
      `scripts/tono-muestra.test.ts` fuera de la suite (mismo patrón de
      `comparar-clasificador.test.ts`, salta sin `OPENAI_API_KEY`) que arma
      cinco historiales sintéticos (pregunta de precio con catálogo apagado,
      queja, foto sin texto, "¿a qué hora cierran?", "gracias") y escribe
      las cinco respuestas a `scripts/tono-muestra.reporte.md` para leerlas
      a mano. Cuesta centavos; no corre en CI.
- [ ] Mutación: quitar la regla (3) de "CÓMO SUENAS" → un test estático que
      busque "por qué y qué va a pasar" se pone rojo. Restaurar.

**Commit:** `La IA suena de mostrador: reconoce lo que pediste, te llama por tu nombre y explica a quién te pasa`.

## Tarea 4 · Fase 0 no se traga la pregunta ni se despide con una escalada abierta

**Contexto.** 53 veces en 72 h el cliente saludó y preguntó en el mismo
mensaje y recibió solo "¿En qué podemos ayudarle?"; y tras la devolución
masiva del 13/9 un "Ok, muchas gracias" reencolado recibió la despedida
"¡Gracias por preferirnos!" mientras esperaba a un asesor. Decisión 4.

- [ ] Crear `src/lib/ai/saludo.ts` (puro) con tests:
  - `isPureGreeting(text)`: `true` si, normalizado (sin acentos, minúsculas,
    sin signos ni emojis), el texto es solo saludo: `hola`, `buenas`,
    `buenos dias`, `buenas tardes`, `buenas noches`, `buen dia`, `hey`,
    `saludos`, `que tal`, `hola buenas`, combinaciones con "como estan",
    "buenas tardes amigo". Falla hacia `false` con cualquier palabra fuera
    de esa lista (así "buenas, tienen tanque…" es `false`). Tope de 6
    palabras.
  - `isCourtesyOnly(text)`: `gracias`, `muchas gracias`, `ok`, `okey`,
    `vale`, `listo`, `perfecto`, `dale`, `de acuerdo`, `esta bien`, `gracias
    amigo`, solo emojis 👍🙏🙌❤️, combinaciones. Mismo tope y misma
    política.
  - `isGreetingPlaybook(responseText)`: el texto normalizado empieza con
    `hola`, `buenas`, `buenos`, `buen dia`, `bienvenid`. Falla abierto
    (`false` ante duda: un escenario que no se reconoce como saludo se deja
    en la lista).
- [ ] `playbooks.ts`: `matchPlaybook(history, playbooks, now, businessHours,
      lastCustomerText?: string | null)`. Si `lastCustomerText` viene y
      `!isPureGreeting(lastCustomerText)`, se descartan los candidatos con
      `isGreetingPlaybook`. Y en `buildPrompt` una línea: *Si el cliente
      saluda Y pregunta algo en el mismo mensaje, el saludo no cuenta:
      clasifica por la pregunta.* Log `escenarios_saludo_descartados` con el
      conteo (info).
- [ ] `agent.ts:runTurnPhases`: pasar el último texto del cliente (ya existe
      `lastUserText`/equivalente en `~:268-277`; reutilizarlo).
- [ ] `handoffs.ts`: `HandoffReason` gana `cortesia_tras_escalada`.
      `escalationOpen(supabase, conversationId): Promise<boolean>` — `true`
      si la última fila de `conversation_handoffs` de la conversación tiene
      `reason in ('escalada','escalada_sin_asesor')` y no hay ningún
      `messages` con `sender_type = 'agent'` posterior a esa fila. Falla
      cerrado hacia `false` (ante error, la IA atiende normal) con log
      `escalada_abierta_no_consultable`.
- [ ] `agent.ts:runTurnPhases`, ANTES de fase 0 y de clasificar: si
      `isCourtesyOnly(lastCustomerText)` y `await escalationOpen(...)` →
      `recordHandoff({ toKind: convo.assigned_agent_id ? "human" :
      "unassigned", toId: convo.assigned_agent_id ?? null, reason:
      "cortesia_tras_escalada" })`, `resetStage`, log
      `turno_cortesia_tras_escalada`, `logTurn` con `action: "answered"`,
      `summary: "Cortesía con escalada abierta: no se respondió."` y
      `return`. Sin envío.
- [ ] `playbooks.test.ts`: con "Buenas tardes, tienen tanque de EK Xpress"
      el enum que recibe el modelo no incluye el escenario cuya respuesta
      empieza "¡Buenas tardes!"; con "hola" sí lo incluye.
- [ ] `agent.test.ts`: (a) "Ok, muchas gracias" con último traspaso
      `escalada` y sin mensaje de asesor posterior → no se llama al modelo,
      no se envía nada, queda traspaso `cortesia_tras_escalada` con el
      `to_id` del asesor; (b) mismo mensaje con un `agent` posterior → turno
      normal; (c) "gracias, y ¿tienen rines 17?" (no es solo cortesía) →
      turno normal.
- [ ] `handoffs.test.ts`: `escalationOpen` en los tres casos y ante error.
- [ ] Mutación: en `matchPlaybook` quitar el filtro de saludos → el test de
      `playbooks.test.ts` se pone rojo. Restaurar.

**Commit:** `La IA responde la pregunta aunque venga con saludo, y no se despide de quien espera a un asesor`.

## Tarea 5 · La espera se ve y la bitácora dice la verdad

**Contexto.** Hallazgos 3, 6, 9 y 10. La promesa "un asesor te va a atender"
sale con `is_auto_reply = false` cuando hay asesor (`agent.ts:~1395`) y en
el camino de escenario `escalate` (`~:958`), apaga `awaiting_reply` y la
conversación desaparece de Pendientes; "Con asesor" nunca cuenta atascados.
Con la tienda cerrada la promesa no dice cuándo. `logTurn` y el `update` de
`intent` ignoran el error (por eso ningún fuera de tema quedó en bitácora).
Un error de red en `agent_can_run` se registra como "IA apagada". Decisiones
3, 6 y 7.

- [ ] `escalate.ts`: `EscalateResult.businessStatus` deja de ser "solo si
      unassigned": se devuelve siempre (ya se calcula siempre). Ajustar el
      docblock. `escalate.test.ts`: con asesor también viene.
- [ ] `tools.ts`: `escalationInstruction(status, assignedName | null)`
      reemplaza a `unassignedEscalationInstruction`: cuatro ramas (con/sin
      asesor × abierta/cerrada). Con asesor y cerrada: *Ya está asignado a X,
      pero la tienda está cerrada: dile con calidez que un asesor le escribe
      <dayLabel> a partir de las <time>, y agradécele la paciencia. NO
      prometas que lo atienden ahora.* `tools.test.ts`: las cuatro ramas.
- [ ] `agent.ts`: `despedidaConAsesor(status)` (T3 creó la función) nombra
      la próxima apertura si está cerrada.
- [ ] `agent.ts` envío final (`~:1387-1400`): `isAutoReply: outcome.escalated`
      (sin la condición `unassigned`). Actualizar el comentario: desde el
      14/9/2026 la promesa de un asesor tampoco es respuesta, con el dato de
      la auditoría (170 promesas ≥ 30 min, 23 sin cumplir).
- [ ] `agent.ts` camino de escenario `escalate` (`~:935-985`): el `update({
      is_auto_reply: true })` corre siempre que `result.escalated`, no solo
      `unassigned`; el `log.info` pasa a `turno_escenario_escalado_marcado`.
- [ ] `agent.ts:logTurn`: capturar `{ error }` y `log.error("turno_bitacora_no_escrita",
      { conversationId, action, detail: errorText(error) })`. Ídem para
      `update({ intent })` → `turno_intencion_no_guardada`. No lanzan.
- [ ] `agent.ts:stillEnabled`: ante `error` de la RPC (o excepción de red)
      **lanzar** `new Error(\`agent_can_run no consultable: …\`)` después del
      `log.error` existente; `deliver` no lo atrapa, el turno falla antes de
      `entrega.intentado = true` y la cola reintenta. Solo un `data ===
      false` genuino sigue escribiendo `agente_no_puede_correr`. Reescribir
      el docblock "Falla cerrado": sigue sin enviar, pero un corte de base
      ya no se disfraza de interruptor (hallazgo 10 de la auditoría, 13
      turnos en 72 h).
- [ ] `agent.ts:runAgentTurn` apertura: destructurar `{ data: canRun, error:
      canRunError }`; si `canRunError`, `log.error("turno_interruptor_no_consultable", …)`
      y lanzar. Solo `canRun === false` es `turno_saltado_ia_apagada`.
- [ ] `agent.test.ts`: (a) escalada con asesor → el mensaje al cliente lleva
      `is_auto_reply: true`; (b) escenario `escalate` con asesor → el
      `update` de `is_auto_reply` corre; (c) RPC con error en `stillEnabled`
      → el turno lanza y NO hay traspaso `agente_no_puede_correr`; (d) RPC
      con error en la apertura → lanza; (e) `logTurn` con error → log
      `turno_bitacora_no_escrita`, no lanza.
- [ ] Verificar sin tocar: `reconciler.ts` (`ai_enabled = true` en el
      predicado) no reencola escaladas; `human-handled.ts` no cambia;
      `invariante-leads-contrato.test.ts` sigue verde.
- [ ] Mutación: restaurar `&& outcome.unassigned === true` → el test (a) se
      pone rojo. Restaurar con `cp`.

**Commit:** `La promesa de un asesor deja la conversación esperando, dice cuándo, y la bitácora registra lo que pasó de verdad`.

## Tarea 6 · Al segundo adjunto sin texto, la IA pasa el caso

**Contexto.** 494 fotos y 117 audios en 72 h; la IA repitió "¿qué repuesto
buscas?" hasta 10 veces. `history-line.ts` ya marca cada adjunto; nadie
cuenta la racha. Decisión 5.

- [ ] `history-line.ts`: `mediaStreakWithoutText(history: HistoryLine[] |
      ModelMessage[]): { adjuntos: number; yaPreguntamos: boolean; tipos:
      string[] }` — recorre desde el final: cuenta líneas de cliente que son
      marcadores SIN pie (los que terminan en "; no puedes verla/verlo/
      escucharla/abrirlo" o son "[El cliente envió un sticker]" NO cuentan:
      un sticker no es un pedido) hasta la primera línea de cliente con
      texto; `yaPreguntamos` es `true` si entre esos marcadores hay al menos
      una línea `assistant` que no sea marcador. Tests: foto+pregunta de la
      IA+foto → `{2, true}`; foto+foto sin respuesta en medio → `{2, false}`
      (la IA todavía no preguntó: turno normal); foto con pie → `{0}`;
      texto al final → `{0}`.
- [ ] `agent.ts:runTurnPhases`, después de la guarda de cortesía (T4) y
      antes de fase 0: si `adjuntos >= 2 && yaPreguntamos` →
      `escalateConversation({ motivo: "seguimiento", resumen: "El cliente
      mandó N adjuntos sin texto (fotos/notas de voz) y ya se le pidió que
      escribiera. Revisar en el chat qué mandó." })`, enviar
      `DESPEDIDA_MEDIA` (texto fijo cálido: *Ya vi que me mandaste varias
      cosas 🙌. Para no hacerte esperar, te paso con un asesor que lo revisa
      y te escribe por acá.*, con `isAutoReply: true` por Decisión 3 y con
      `despedidaConAsesor`/horario si aplica), `logTurn` `escalated`,
      `return`. Sin fase 0 ni tool loop (ahorra 3 llamadas al modelo).
- [ ] `prompt.ts` `MEDIA_RULES`: una línea al final: *Si ya pediste una vez
      que te escriba y vuelve a mandar otra foto o audio sin texto, el caso
      pasa solo a un asesor: no vuelvas a pedirle lo mismo.* (informativa;
      la regla vive en código).
- [ ] `agent.test.ts`: (a) foto → IA pregunta → foto: escala con
      `seguimiento`, manda `DESPEDIDA_MEDIA` con `is_auto_reply: true`, no
      llama a `classifyIntent`; (b) foto → foto sin que la IA haya
      respondido: turno normal; (c) sticker+sticker: turno normal;
      (d) `DESPEDIDA_MEDIA` pasa `revealsIdentity`.
- [ ] Mutación: cambiar `>= 2` por `>= 3` → (a) se pone rojo.

**Commit:** `Al segundo adjunto sin texto la IA deja de preguntar y pasa el caso`.

## Tarea 6b · Diagnóstico: por qué los asesores no oyen las notas de voz (sin código)

**Contexto.** Un asesor pidió 7 veces "escríbelo, no se nos reproducen las
notas de voz". `message-bubble.tsx` usa `<audio>` nativo con el archivo tal
como lo entrega Meta (`audio/ogg; codecs=opus`). Safari (macOS/iOS) no
reproduce Opus en contenedor OGG; Chrome y Brave sí.

- [ ] Reproducir en local: bajar un audio real por `api/media/[...path]`
      (con sesión), comprobar `Content-Type` y los bytes iniciales
      (`OggS`). Probar en Brave/Chrome y, si hay, en Safari/iPhone.
- [ ] Preguntar al operador desde qué navegador y equipo trabajan los cuatro
      asesores (celular/PC, Chrome/Safari/WhatsApp Web).
- [ ] Escribir `docs/diagnosticos/2026-09-14-notas-de-voz.md`: causa
      probable, evidencia, y las tres salidas con costo: (1) botón
      "Descargar" ya existe → instruir; (2) transcodificar a `audio/mp4`
      (AAC) al recibir, con `ffmpeg` en el contenedor (deuda: imagen más
      pesada, CPU); (3) pedir a Meta el formato alternativo (no existe).
      Recomendación para v1.2. **Solo se toca código si la causa es trivial
      (p. ej., un `Content-Type` mal servido por `api/media`)**; cualquier
      otra cosa se reporta y se deja para otra corrida.

**Sin commit propio** (el diagnóstico va con el commit de documentación, T8).

## Tarea 7 · El guion atiende a quien no es cliente, el horario, el agotado y las listas largas

**Contexto.** Sección 3 de la auditoría: patrocinios y números equivocados
atendidos como clientes; "¿a qué hora cierran?" escalado o improvisado
aunque el horario ya llega en TURNO ACTUAL; "avísame cuando llegue" escalado
como compra; listas largas con dos interrogatorios y sin resumen. Decisión 8.

- [ ] `classify.ts` `CLASSIFY_PROMPT`, en `fuera_de_tema`: *…o mensajes que
      no son de un cliente: propuestas de patrocinio o publicidad, listas de
      precios de otros negocios, cadenas, o alguien que claramente se
      equivocó de número.* Mantener la regla "ante la duda, otro".
      `classify.test.ts`: el prompt nombra patrocinio y número equivocado.
- [ ] `prompt.ts` 5.5: *Si pregunta por el horario o si están abiertos,
      respóndelo tú con lo que dice TURNO ACTUAL, sin escalar ni consultar
      nada.* 5.1: *Si el repuesto está agotado y el cliente pide que le
      avisen cuando llegue, no lo escales como compra: escala con motivo
      seguimiento y un resumen que diga qué repuesto y para qué moto, y dile
      que un asesor le avisa por acá.* Sección 3: *Si el cliente manda una
      lista de varios repuestos o pregunta por compra al mayor, tómala
      completa: pregunta a lo sumo UNA vez marca y modelo, no un repuesto a
      la vez, y al escalar pasa la lista ordenada, un renglón por repuesto.*
- [ ] `tools.ts` `buildEscalateTool`: `motivo: z.enum(["devolucion", "queja",
      "intencion_compra", "seguimiento"])` con `.describe` que explique
      `seguimiento` (aviso de reposición, listas largas, postventa). El resto
      de la herramienta no cambia (`escalate.ts` ya lo admite).
      `tools.test.ts`: el esquema acepta `seguimiento`.
- [ ] `prompt.test.ts`: los tres textos existen y pasan `revealsIdentity`;
      la sección 5.5 nombra TURNO ACTUAL para el horario.
- [ ] Mutación: quitar `seguimiento` del enum → el test de tools se pone rojo.

**Commit:** `El guion responde el horario, registra el aviso de reposición y no atiende patrocinios como clientes`.

## Tarea 8 · Documentación y v1.1 (orquestador)

- [ ] `CLAUDE.md`, trampas nuevas (breves, con fecha 14/9/2026):
  (1) *toda salida de un turno que escaló es `is_auto_reply`*, con asesor o
  sin él; "Pendientes" y "Con asesor" cuentan con eso; (2) *la IA no saluda
  por franja*: `turnClockLine` no trae saludo, `greeting-window.ts` es solo
  red; (3) los CHECK de `intent` viven en `20260914010000`; un valor nuevo
  en `INTENT_VALUES` exige migración; (4) un error de `agent_can_run` lanza
  y la cola reintenta — solo `false` es "apagada"; (5) fase 0 descarta
  escenarios de saludo cuando el mensaje trae más que un saludo.
- [ ] `docs/GLOSARIO.md`: líneas de `customer-name.ts`, `saludo.ts`, la
      migración, el test SQL, el diagnóstico, y actualizar `prompt.ts`,
      `business-hours.ts`, `agent.ts`, `playbooks.ts`, `handoffs.ts`,
      `escalate.ts`, `tools.ts`, `history-line.ts`, `classify.ts`.
- [ ] `docs/PRODUCCION.md`: sección "Lista operativa de v1.1" con las tareas
      O1–O8 de abajo y su verificación.
- [ ] `docs/diagnosticos/2026-09-14-notas-de-voz.md` (de T6b).

**Commit:** `La documentación cuenta cómo la IA dejó de ser tajante y por qué la espera ahora se ve`.

---

## Tareas operativas (operador, desde el panel — ningún código las reemplaza)

| # | Qué | Por qué | Cómo se verifica |
|---|---|---|---|
| O1 | Contactar hoy a los 80 leads sin respuesta (CSV de la auditoría), empezando por los 11 del viernes y los 29 del domingo. | 3 ventas perdidas y 47 en riesgo ya contadas. | Píldora "Pendientes" baja; los 80 tienen respuesta de asesor. |
| O2 | **Encender "Consulta de productos"** en Control IA tras confirmar que el inventario del 11/9 está al día. | 99 de 151 preguntas sin respuesta propia son precio/existencia; es la causa principal del tono "te paso con un asesor". Desde el 25/8 nunca estuvo encendida. | Un turno de consulta muestra `buscarRepuesto` en `agent_turns`; la tasa de escaladas por `intencion_compra` baja de 438/480. |
| O3 | Reemplazar los tres escenarios de saludo por UNO neutro (*¡Hola! Bienvenido a SBK Motorcycles 🏍️ ¿Qué repuesto o accesorio buscas para tu moto?*), disparador *solo cuando el mensaje es únicamente un saludo*; unificar a "tú" los escenarios con "usted"; estrechar el disparador de la despedida ("Gracias por preferirnos") a *cuando el cliente se despide y no queda nada pendiente*. | Decisiones 1, 2 y 4. | `agent_turns` con `playbook_id` de saludo solo en mensajes que son solo saludo. |
| O4 | Confirmar el horario del domingo (¿9:30–16:00 o 9:00–16:30?) y corregir `business_hours` en el panel. | La IA dice el horario tal cual está cargado. | `turnClockLine` en un turno de domingo. |
| O5 | Cargar la biblioteca con las respuestas validadas de la sección 2 de la auditoría: horario, taller y precios de referencia, métodos de pago aceptados/rechazados (Binance sí, Zelle no), compatibilidades frecuentes, guía MRW y tiempos, Cashea (error de envío gratis), garantía y cambios, RCV. Revisar los enlaces de Drive del catálogo (fallaron 12/9 y 13/9). | 52 preguntas de política sin respuesta propia; hoy la biblioteca tiene 6 entradas. | `consultarBiblioteca` devuelve resultados en esos turnos. |
| O6 | Roster: marcar "Fuera del reparto" a quien no está de turno (fin del día, domingo). No devolver conversaciones a la IA en masa mientras tengan escalada abierta: reasignar. | `claim-agent.ts` reparte por esa bandera; la devolución masiva del 13/9 re-escaló 63 casos y quitó el asesor a 11 leads del viernes. | Escaladas fuera de horario caen en "Sin dueño" (visibles) en vez de en un asesor ausente. |
| O7 | Rampa de ritmo: pasar `AGENT_MAX_TURNS_PER_MINUTE` 30→40 y `AI_MAX_REQUESTS_PER_MINUTE` 120→160 juntas (las cinco variables suben juntas; redeploy de Dokploy). | 138 topes de 30/min en 72 h. | `ia_ritmo_al_tope` desaparece en hora pico. |
| O8 | Pedir al Claude del VPS revisar los cortes de conexión con la base: `docker logs` del contenedor de la app y de PostgREST/pooler alrededor de los 13 `turno_interruptor_no_consultable` y los 41 `webhook_error_actualizar_estado`; límites de conexiones del pooler; reinicios de contenedores. | Hallazgo 10. Con T5 el síntoma deja de disfrazarse, pero la causa es del VPS. | Cero `turno_interruptor_no_consultable` en 48 h. |

---

## Orden de ejecución

- **Tanda 1 (paralelo, archivos disjuntos):** T1 (migración), T2
  (`business-hours.ts`, `greeting-window.ts`, `prompt.ts` sección 6 y
  sufijo), T5 (`agent.ts`, `escalate.ts`, `tools.ts`), T6b (diagnóstico,
  sin código). Commit de T1 primero.
- **Tanda 2:** T3 (`prompt.ts`, `agent.ts`, `tools.ts`, `customer-name.ts`,
  `turn-target.ts`) — sola, porque comparte `prompt.ts` con T2 y `agent.ts`
  con T5.
- **Tanda 3 (paralelo):** T4 (`saludo.ts`, `playbooks.ts`, `handoffs.ts`,
  `agent.ts`) y T7 (`prompt.ts`, `classify.ts`, `tools.ts`). Disjuntos.
- **Tanda 4:** T6 (`agent.ts`, `history-line.ts`).
- **Cierre:** T8 y la verificación final.

Cada tanda cierra con `rtk npx tsc --noEmit`, `rtk npm run lint` y `rtk npm
run test` en verde antes de abrir la siguiente.

## Commits (en este orden)

1. `[migración] La base acepta los turnos fuera de tema y la cortesía tras una escalada` (T1)
2. `El plan de la voz cercana y la espera visible queda escrito` (T0; puede ir junto al 3)
3. `La IA saluda una sola vez y con un hola que no depende de la hora` (T2)
4. `La promesa de un asesor deja la conversación esperando, dice cuándo, y la bitácora registra lo que pasó de verdad` (T5)
5. `La IA suena de mostrador: reconoce lo que pediste, te llama por tu nombre y explica a quién te pasa` (T3)
6. `La IA responde la pregunta aunque venga con saludo, y no se despide de quien espera a un asesor` (T4)
7. `El guion responde el horario, registra el aviso de reposición y no atiende patrocinios como clientes` (T7)
8. `Al segundo adjunto sin texto la IA deja de preguntar y pasa el caso` (T6)
9. `La documentación cuenta cómo la IA dejó de ser tajante y por qué la espera ahora se ve` (T8)

## Verificación final (orquestador)

- [ ] Suite completa, tipos, lint; build con `rtk proxy npm run build` y
      timestamp de `.next/BUILD_ID` posterior al último commit.
- [ ] Mutaciones de T2, T3, T4, T5, T6 y T7 repetidas por el orquestador
      (una cada una), con respaldo `cp`.
- [ ] Escenario a mano contra el dev local (Supabase local + webhook, receta
      en memoria "Entorno local para ver la app en Brave"), con la IA
      encendida y catálogo encendido:
  1. `"Buenas tardes, tienen tanque de EK Xpress en negro"` en un chat nuevo
     → NO sale un escenario de saludo; la respuesta empieza con "¡Hola!" (o
     "¡Buenas!"), nombra el tanque, no dice "buenas tardes".
  2. Segundo mensaje `"hola"` → no vuelve a saludar.
  3. `"sí, lo quiero"` → escala; en `messages` el texto de la IA tiene
     `is_auto_reply = true`; `conversations.awaiting_reply = true`; la
     conversación aparece en "Pendientes" y en "Tuyas" del asesor.
  4. Con `business_hours` cerrado ahora (editar el panel): repetir 3 → la
     promesa nombra el día y la hora de apertura.
  5. Foto sin texto → la IA pregunta; segunda foto sin texto → escala con
     `seguimiento`, manda `DESPEDIDA_MEDIA`, `agent_turns` sin
     `classifyIntent` (un solo turno con tokens de clasificación en 0).
  6. Reactivar la IA desde el chat y mandar `"gracias"` → silencio; fila
     `cortesia_tras_escalada` en `conversation_handoffs`.
  7. `"escríbeme un poema"` → `OFF_TOPIC_REPLY` nuevo y una fila en
     `agent_turns` con `intent = 'fuera_de_tema'`.
  8. Apagar Postgres un instante durante un turno (o simular error de la
     RPC) → log `turno_interruptor_no_consultable`, sin traspaso
     `agente_no_puede_correr`, la cola reintenta.
- [ ] Verificación visual (memoria "Verificación visual antes de fusionar
      UI"): Bandeja "Pendientes" y "Tuyas", Recorrido "Con asesor" con un
      atascado real; nada de esta corrida toca CSS, pero la píldora cambia
      de contenido.
- [ ] Preguntar en qué commit está producción; reporte de entrega por commit
      en el formato de `docs/PRODUCCION.md` (una migración: `20260914010000`,
      sin variables nuevas; O7 cambia dos variables existentes).

## Verificación en producción y etiqueta v1.1

A las 48 h del despliegue, repetir sobre la base de producción (solo
lectura) las cuatro cifras de la auditoría y compararlas:

| Métrica | Antes (72 h al 14/9) | Meta |
|---|---|---|
| Mensajes de la IA que empiezan con "buenos días/tardes/noches" | 3 con franja mal; ~50 % de los escenarios eran saludos | 0 |
| Promesas "un asesor te atiende" que apagaron `awaiting_reply` | 170 ≥ 30 min invisibles | 0 (todas `is_auto_reply`) |
| Repeticiones de "¿qué repuesto buscas?" ante adjuntos sin texto | hasta 10 por chat | ≤ 1 por racha |
| `agent_turns` con `intent = 'fuera_de_tema'` | 0 (rechazados) | = a los turnos fuera de tema del log |
| Escaladas por `intencion_compra` (con catálogo encendido, O2) | 438 / 480 | < 250 |
| Lectura de tono: 20 respuestas de la IA elegidas al azar | "tajante" | ≥ 16 con reconocimiento + explicación (rúbrica de "CÓMO SUENAS") |

Con eso en verde y O1–O6 hechas: `git tag -a v1.1 -m "SBK CRM v1.1 estable:
la voz cercana y la espera visible"` sobre el commit desplegado, y push del
tag. La memoria y `docs/PRODUCCION.md` registran el hash.

## Deuda que este plan deja anotada a propósito

- Presencia real de asesores y reasignación por `response_due_at` (Etapa 2):
  hoy la rotación es por `is_active` y 155 de 375 escaladas las respondió
  otro asesor.
- Registro de avisos de reposición ("avísame cuando llegue"): hoy es un
  `seguimiento` a mano.
- Transcodificar notas de voz para Safari/iOS (según T6b).
- Cortes de conexión con la base: síntoma visible desde T5, causa en el VPS
  (O8).
- `greeting-window.ts` puede retirarse cuando ningún escenario del panel
  empiece con saludo de franja (medir con `select response_text from
  ai_playbooks where is_active`).
- La columna `conversations.handoff_confirmation_pending_at` sigue sin uso
  (desde el 9/9).
- Dokploy despliega sin esperar al CI (recomendación desde el 10/9).

---

## Prompt orquestador (para pegar)

Actúa como ORQUESTADOR bajo la metodología `liminalwork` (léela con la skill
antes de nada, junto con `CLAUDE.md` y `docs/GLOSARIO.md`). El plan ya está
aprobado por el operador y vive en
`docs/planes/2026-09-14-la-voz-cercana-y-la-espera-visible.md`: léelo entero
antes de repartir nada. Tu trabajo es ejecutarlo completo —ocho tareas de
código (T1–T7 más T6b), la documentación T8 y la verificación final— y dejar
el repo con todo hecho, testeado y commiteado, sin hacer `push` ni tocar
producción. Hay UNA migración (T1), que va en su propio commit, primero, con
`[migración]` en el título.

Reglas del orquestador:

1. No implementas. Cada tarea del plan se la asignas a UN subagente propio
   con `subagent_type: "implementador"` (Sonnet, esfuerzo alto), contexto
   limpio. En el prompt del subagente pega literalmente: la sección
   "Decisiones", la sección "Reglas para todos", la sección completa de SU
   tarea (contexto, pasos, tests y mutación), y la instrucción de leer
   `CLAUDE.md`, `docs/GLOSARIO.md` y los archivos que la tarea nombra antes
   de escribir. Nada de resumirle la tarea.

2. Respeta "Orden de ejecución": tanda 1 en paralelo {T1, T2, T5, T6b};
   tanda 2 {T3} sola; tanda 3 {T4, T7} en paralelo; tanda 4 {T6}. Cada
   tanda cierra con `rtk npx tsc --noEmit`, `rtk npm run lint` y `rtk npm
   run test` en verde antes de abrir la siguiente. Al prompt de T5 pégale
   el reporte de T1 (nombres reales de los constraints); al de T4, el de T1
   (la razón nueva ya existe en la base) y el de T3 (dónde quedó
   `despedidaConAsesor`); al de T6, los de T4 y T5 (dónde están la guarda de
   cortesía y la marca `isAutoReply`).

3. Los subagentes NO commitean ni editan `docs/GLOSARIO.md` ni `CLAUDE.md`:
   te entregan la línea de glosario propuesta por archivo y la aplicas tú al
   commitear.

4. Cada subagente termina con el reporte obligatorio. No cierras una tarea
   sin ese reporte Y sin correr tú mismo los tres comandos. Si algo no cuadra
   con el plan, abres otro subagente con la corrección concreta; no parcheas
   a mano.

5. Commits: los haces tú, uno por tarea, con los títulos y el orden de la
   sección "Commits". Mensajes largos con `git commit -F <archivo>` (sin
   rtk). Cada commit lleva sus líneas de `docs/GLOSARIO.md`. `CLAUDE.md` se
   toca en T8, salvo que un reporte cambie doctrina antes.

6. Supuestos que puedes ajustar sin volver al operador: el texto exacto de
   los mensajes fijos mientras digan lo mismo y pasen `revealsIdentity`; los
   nombres de los eventos de log; la lista de palabras de `saludo.ts`; el
   sitio exacto de la sección "CÓMO SUENAS" en la numeración del prompt. Si
   la decisión cambia el plan —otra columna, tocar un trigger, tocar la
   cola, cambiar el comportamiento de `is_auto_reply` en la base—, párate y
   pregúntame.

7. Al cerrar la tanda 4 corre la "Verificación final" completa, incluido el
   escenario a mano de ocho pasos contra el dev local y las seis mutaciones.
   Antes del reporte de entrega pregúntame en qué commit está producción.

8. Entrégame al final: (a) la lista de commits en orden con hash y título;
   (b) el reporte de entrega por commit para el Claude del VPS en el formato
   de `docs/PRODUCCION.md`, con la migración `20260914010000`, el cambio de
   O7 en las variables, y las verificaciones post-deploy de la sección
   "Verificación en producción"; (c) la lista operativa O1–O8 tal cual, para
   el operador; (d) las dudas y la deuda que dejaron los subagentes más la
   que el plan anota a propósito.

Empieza leyendo la skill `liminalwork`, `CLAUDE.md`, `docs/GLOSARIO.md` y
el plan. Luego confirma en una línea que vas a arrancar la tanda 1 con {T1,
T2, T5, T6b} en paralelo y arranca.
