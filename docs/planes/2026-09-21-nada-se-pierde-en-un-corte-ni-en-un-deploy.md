# Plan "Nada se pierde en un corte ni en un deploy", 21/9/2026

## Contexto

Origen: informe de producción del Claude del VPS (21/9/2026, cierre 23:27 UTC)
tras desplegar `83bc558` (= `origin/main`, 78 migraciones, base en
`20260921030000`). Los tres problemas medidos ese día ya están cerrados
(búsqueda, reescaladas, espirales). Queda lo que el informe deja abierto:
cortes app↔PostgREST sin diagnóstico, un 500 opaco al bajar una imagen,
instrumentación pendiente (maxOutputTokens/toolChoice sin prueba directa,
tokens por fase inferidos, `agent_token_usage` sin razonamiento), el caché
que "cachea cero" en 93 de 184 turnos, y que cada deploy destruye los logs.

El contraste con el código cambió el diagnóstico en tres puntos (sección
"Hallazgos"). El operador tomó las cuatro decisiones D1–D4.

## Decisiones del operador (21/9/2026)

- **D1 — Cortes:** reintento corto en el cliente admin (`global.fetch`) para
  fallos de red / 503 de Envoy, y si aun así un mensaje del cliente no se
  pudo guardar, el webhook responde **5xx a Meta** para que reentregue (el
  dedupe por `whatsapp_message_id` ya existe). Los `continue` mudos pasan a
  eventos `log.error` contables.
- **D2 — Telemetría:** `[migración]` tabla `agent_turn_calls` (una fila por
  llamada al proveedor) + columnas de pasos/herramientas/tiempos en
  `agent_turns` + la RPC `agent_token_usage` suma caché y razonamiento.
- **D3 — Media:** NO reenvío automático. Instrumentar `api/media` y
  `media-link.ts` con `lib/log.ts`, y decirle al VPS dónde mirar de verdad.
- **D4 — Logs:** `logging: driver: journald` en el servicio `app` de
  `docker-compose.dokploy.yml`, con instrucciones de fusión para el VPS.

Incluidos sin pregunta (bajo riesgo, se aprueban con este plan): valor
`none` para `AI_AGENT_REASONING`, techo de salida en la reescritura de
identidad, y mover el reloj del prompt de escenarios al final para que su
prefijo pueda cachear.

**Revisión del Claude del VPS (21/9/2026, contra producción) — seis cambios
incorporados:** (1) `agent_turn_calls` NO se lee con RLS por fila: el panel
lee por RPC `security definer` y la tabla nace con retención; (2) el compose
de Dokploy no está editado a mano (Dokploy lo regenera en cada deploy):
T8 pierde la instrucción de fusión, journald ya está persistente en el VPS
(422 MB, 162 GB libres); (3) el 500 de la imagen NO fue Storage ni Envoy —
Storage registró subida y firma en 200 y Envoy no vio ninguna petición de
`facebookexternalua` a esa hora: la petición murió ANTES, en Traefik/borde
TLS, y **Traefik no tiene access log** → T9 suma su activación, y T7 no se
presenta como el arreglo del incidente; (4) T1 reintenta SOLO idempotentes
(`GET`/`HEAD`) o la familia Envoy "before headers" (prueba que la petición
nunca llegó): un `POST` con `ECONNRESET` NO se reintenta, porque una fila
duplicada en `agent_turns` infla `agent_spend_today()` y puede apagar a Seba
por tope de gasto; (A) T6 no promete arreglar el caché (el bloque estático
ronda ~830 tokens, bajo el mínimo de 1.024; T4 mide); (B) T2 suma el test
"la reentrega no encola dos veces".

## Hallazgos del contraste con el código (lo que el informe no traía)

1. **Meta NUNCA descarga desde `/api/media/…` del CRM.** El enlace que se le
   manda es una URL firmada de Supabase Storage (`src/lib/media-link.ts:22`,
   `createSignedUrl(path, 600)`) cuyo path es `outbound/<conv>/<uuid>.<ext>`
   (el prefijo que el VPS vio). `/api/media` exige sesión: a Meta le daría
   401, nunca 500. Por eso la app "no registró nada": la petición nunca
   pasó por Next. **Y tampoco fue Storage/Envoy** (verificado por el VPS
   tras el primer borrador de este plan): Storage registró la subida
   (18:39:46.484, 200) y la firma (18:39:46.819, 200), y Envoy no vio NINGUNA
   petición de `facebookexternalua` a esa hora, aunque sí las registra en
   otros momentos del día. La petición de Meta murió antes de Envoy — en
   Traefik o en el borde TLS — y **Traefik no tiene access log activado**:
   ese es el hueco real. Instrumentar `/api/media` sigue valiendo por su
   propio motivo (hoy un 401/403/404/500 ahí no deja línea alguna:
   `src/app/api/media/[...path]/route.ts`, cero `log.*`, sin `try/catch`),
   pero no es el arreglo de este incidente.
2. **Un corte pierde el mensaje del cliente para siempre, sin rastro.** El
   webhook (`src/app/api/webhooks/whatsapp/route.ts`) hace `console.error`
   + `continue` y responde **200** si falla el upsert de contacto (1048), la
   creación de la conversación (1220) o el insert del mensaje (1419, todo lo
   que no sea `23505`). Meta no reintenta un 200. Ninguno de los 17
   `console.*` de ese archivo es filtrable por `event`, así que estas
   pérdidas no aparecen en ningún conteo del VPS. Y **no existe ningún
   reintento alrededor de PostgREST** en `src/` (`createAdminClient`,
   `src/lib/supabase/admin.ts`, no pasa `global.fetch`).
3. **Lo que el VPS usó para diagnosticar las espirales no está en la base.**
   `pasos`, `herramientas`, `redaccionMs`… salen solo por
   `log.info("turno_tiempos")` (`agent.ts:2802`); `agent_turns` guarda un
   único total de tokens sumado entre 3–7 llamadas (`addTokens`,
   `agent.ts:259`). `cached_input_tokens` se escribe y nadie lo lee
   (`AGENT_TURN_COLUMNS` lo omite, la RPC tampoco lo suma).
4. **El prompt de escenarios no puede cachear nunca:** `buildPrompt`
   (`src/lib/ai/playbooks.ts:172-191`) pone fecha/hora/franja/estado en su
   SEGUNDA línea, antes del catálogo de escenarios. Un turno resuelto por
   escenario hace solo esa llamada + `classifyIntent` (`CLASSIFY_PROMPT`,
   ~2.000 chars, seguramente bajo el mínimo de 1.024 tokens): explica en
   buena parte los 93 turnos con caché cero. Hipótesis a confirmar con D2.
5. **La reescritura de la guarda de identidad corre sin techo de salida**
   (`agent.ts:1032-1042`, `generateText` sin `maxOutputTokens`).
6. **`gpt-5.6-luna` SÍ es modelo de razonamiento para `@ai-sdk/openai@4.0.43`**
   (regex `^gpt-(\d+)…`, major 5 → `isReasoningModel = true`, vía Responses
   API). Con `AI_AGENT_REASONING=off` (producción) no viaja nada y el
   proveedor razona por default (58,5 % de la salida medida). Apagarlo es
   `reasoningEffort: "none"` → `reasoning: { effort: "none" }` en el body
   (`node_modules/@ai-sdk/openai/dist/index.js:6408-6423`). El comentario de
   cabecera de `model.ts` ("Luna NO razona") y la tabla de variables de
   `docs/PRODUCCION.md` están desactualizados.
7. **Los 59 s de recuperación del turno caído** no son un misterio: tras un
   error la cola difiere 30 s SIN despertarse sola (a propósito,
   `queue.ts:336-339`) y la recoge el cron de 60 s. Con D1 el corte a mitad
   de turno debería dejar de ocurrir; no se toca la cola.
8. **El punto de menor superficie para ver los parámetros REALES** que salen
   al proveedor es el middleware que ya envuelve todo modelo
   (`rateLimitMiddleware`, `src/lib/ai/rate-limit.ts:252`): `wrapGenerate`
   recibe `params` (`maxOutputTokens`, `toolChoice`, `providerOptions`) y
   devuelve `usage`/`finishReason`. El mapeo a `max_output_tokens` /
   `tool_choice: "none"` es determinista en el SDK instalado.

## Tareas

Regla para todas (memoria "Primero el test, después el código"): test ROJO
primero, después el código; no commitear; reporte obligatorio al
orquestador; comentarios en español con el porqué y la fecha; GLOSARIO en el
mismo cambio. Subagente `implementador` por tarea.

### T1 — El cliente admin reintenta un corte corto de la base
Archivos: NUEVO `src/lib/supabase/fetch-reintentos.ts` (+ `.test.ts`),
NUEVO `src/lib/supabase/errores-base.ts` (+ `.test.ts`),
`src/lib/supabase/admin.ts`.
- `esFalloTransitorioDeBase(err | response)` (función PURA): `TypeError`
  "fetch failed" / `ECONNRESET` / `ECONNREFUSED` / `EAI_AGAIN` / `ETIMEDOUT`;
  respuesta 502/503/504 cuyo cuerpo calce `upstream connect error` /
  `disconnect/reset before headers` / `connection termination` (Envoy: la
  petición nunca llegó a PostgREST); `PostgrestError` con `code` de clase
  `08*` (connection exception), `53*` (recursos), `57P*` (shutdown) o
  `PGRST00*` (PostgREST sin base). Nada más cuenta como transitorio — un
  `23505`, un `42501` o un 400 nunca se reintentan.
- `esReintentoSeguro(method, fallo)` (PURA, misma familia): reintentar SOLO
  si (a) el método es idempotente (`GET`/`HEAD`), o (b) el fallo PRUEBA que
  la petición nunca llegó al upstream — la familia Envoy `upstream connect
  error` / `disconnect/reset before headers` / `connection termination`
  (502/503/504 con ese cuerpo) y `ECONNREFUSED`/`EAI_AGAIN` (no hubo
  conexión). Un `POST`/`PATCH`/`DELETE` con `ECONNRESET`/`ETIMEDOUT`/"fetch
  failed" ambiguo **NO se reintenta**: PostgREST pudo haber ejecutado el
  INSERT y perderse solo la respuesta, y una fila duplicada en
  `agent_turns` infla `agent_spend_today()` — la suma con la que
  `agent_can_run()` apaga a Seba por tope de gasto (objeción 4 del VPS).
  Ese caso queda como hoy: `log.error("base_agotada")` y el llamador ve el
  error.
- `fetchConReintentos(fetch, { intentos: 2, esperasMs: [300, 1000] })`:
  reintenta SOLO cuando `esReintentoSeguro`; nunca si `signal.aborted`; lee
  el cuerpo con `response.clone()` para no consumirlo; `log.warn(
  "base_reintento", { intento, metodo, detail })` en cada reintento y
  `log.error("base_agotada", { metodo, reintentado: boolean, detail })` al
  rendirse (devuelve la última respuesta o relanza el último error — el
  llamador sigue viendo `{ error }` como siempre).
- `createAdminClient()` pasa `global: { fetch: fetchConReintentos(fetch) }`.
  Cubre PostgREST, RPC y Storage (`storage-js` usa el mismo `fetch`) sin
  tocar ningún llamador. El cliente de sesión (`server.ts`) NO cambia.
- `messages` queda protegida además por el UNIQUE de `whatsapp_message_id`
  (`messages_whatsapp_message_id_uidx`, verificado en producción).
Tests: clasificación (cada familia positiva + los negativos); la matriz
método × fallo de `esReintentoSeguro` (POST + ECONNRESET → NO; POST + Envoy
"before headers" → SÍ; GET + ECONNRESET → SÍ; 23505/42501/400 → nunca);
respeto de `signal`; cuerpo no consumido; conteo de llamadas; y que
`createAdminClient` inyecta el fetch (mock de `@supabase/supabase-js`).

### T2 — El webhook no pierde un mensaje del cliente (después de T1)
Archivos: `src/app/api/webhooks/whatsapp/route.ts` + `route.test.ts`.
- Los tres `continue` de pérdida (contacto 1048, conversación 1220,
  mensaje 1419) pasan a `log.error` con nombre —
  `webhook_contacto_no_guardado`, `webhook_conversacion_no_creada`,
  `webhook_mensaje_no_guardado` (`whatsappMessageId`, `detail:
  errorText(...)`) — y, si `esFalloTransitorioDeBase(error)`, levantan
  `persistenciaFallida = true`. Al final del POST, si la bandera está
  arriba, se responde **503** `{ ok: false, retry: true }` DESPUÉS de
  encolar los turnos de lo que sí se guardó — Meta reentrega el lote; lo ya
  guardado cae en `23505` y se ignora; lo perdido se guarda entonces.
- Un fallo NO transitorio (payload raro, constraint) sigue respondiendo
  200: un 5xx permanente haría que Meta repita el mismo lote durante días.
- Los otros 14 `console.*` del archivo pasan a `log.*` con evento (uno por
  sitio, en español, sin contenido de cliente), para que todos sean
  contables. `webhook_error_actualizar_estado` NO se toca (con T1 debería
  bajar solo; medirlo).
- Comentario junto al 200 del freno de avalancha (`route.ts:815`): explicar
  por qué ese caso sigue en 200 y este otro en 503 (uno descarta a
  propósito, el otro no pudo guardar).
Tests: insert de mensaje con error transitorio → 503 + evento + el turno de
la otra conversación del lote SÍ se encola; error no transitorio → 200 +
evento; el `23505` sigue en 200 sin evento de error; los tres sitios; el
test que falta hoy para `webhook_error_actualizar_estado` (describe de
`route.test.ts:1587` que lo nombra y no lo prueba); y **la reentrega no
contesta dos veces** (objeción B del VPS): lote reentregado donde un mensaje
cae en `23505` y otro se guarda por primera vez → `enqueueAgentTurns` recibe
UNA sola conversación, la del mensaje nuevo. Hoy ya es así por construcción
(el `continue` de 1422 corta antes del `touchedByCustomer.set` de 1474), el
test lo fija porque D1 convierte la reentrega en un camino provocado a
propósito.

### T3 — `[migración]` La telemetría del turno vive en la base
Archivo: NUEVO `supabase/migrations/20260921040000_telemetria_del_turno.sql`
+ `supabase/tests/telemetria_del_turno.sql` (cableado al job `migraciones`
del CI como los anteriores) + `src/lib/supabase/database.types.ts`.
- `agent_turns` gana `steps smallint`, `tools_used text`, `wait_ms integer`,
  `classification_ms integer`, `generation_ms integer`, `delivery_ms
  integer` — nullables, sin backfill (lo viejo no se puede reconstruir).
- Tabla `public.agent_turn_calls`: `id`, `turn_id` (fk `agent_turns` on
  delete cascade), `conversation_id` (fk), `sequence smallint` (orden dentro
  del turno), `phase text check in ('escenario','clasificar','redactar',
  'identidad')`, `input_tokens`, `output_tokens`, `cached_input_tokens`,
  `reasoning_tokens` (integer null), `max_output_tokens integer null`,
  `tool_choice text null` (`auto`/`none`/`required`/`tool:<nombre>`),
  `finish_reason text null` (`error` cuando la llamada lanzó),
  `duration_ms integer`, `created_at`. Índices `(turn_id)` y `(created_at
  desc)`. **RLS habilitada SIN ninguna política** (objeción 1 del VPS: una
  política `select using (is_agent())` es exactamente la que se evaluaba
  por fila en `messages` y tumbó la búsqueda 48 h; esta tabla crece 3–7
  filas por turno, 1.100–2.500/día, 400–900 mil al año — más que `messages`
  hoy). Nadie lee la tabla directo: escribe `service_role` (el turno) y se
  lee SOLO por RPC.
- RPC `agent_turn_calls_by_phase(days integer default 30)` → `(phase,
  calls, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
  max_output_tokens_max, tool_choice_none_calls)`: `plpgsql security
  definer`, `is_agent()` chequeado UNA vez al entrar (si no, devuelve
  vacío), `set search_path = public`, los DOS revokes por firma + `grant` a
  `authenticated, service_role` — el patrón de `20260921030000`.
- RPC `agent_turn_calls_purge(retain_days integer default 90)` → `integer`
  (filas borradas): `security definer`, solo `service_role` (revokes a
  `public` y a `anon, authenticated`, grant a `service_role`), `delete …
  where created_at < now() - make_interval(days => retain_days)` sobre el
  índice `created_at`. La llama `api/cron/process-queue` una vez al día con
  guarda en Redis (`SET NX EX 86400` sobre `telemetria:purga:<fecha>`),
  `log.info("telemetria_purgada", { filas })`; si Redis o la RPC fallan, el
  cron sigue con la cola (nunca la frena). Retención desde el día uno.
- `agent_token_usage(days)`: `drop function` + recrear con dos columnas más
  (`cached_input_tokens bigint`, `reasoning_tokens bigint`) y **pasa a
  `plpgsql security definer` con `is_agent()` una vez** — mismo motivo:
  hoy es `invoker` sobre `agent_turns` (10.044 filas, 359/día) y paga la
  política por fila; se recrea igual, así que se corrige de una vez. Los
  dos revokes + grant a `authenticated, service_role`.
- `permisos-funciones.test.ts`: el conteo de `security definer` pasa de 22
  a 25 (tres funciones nuevas o convertidas), cada una listada con sus dos
  revokes — el guardián se pone rojo a propósito hasta que se actualice.
- Cabecera con `set local lock_timeout = '5s'` + la guarda `do $$ … raise
  exception …` que aborta sin transacción, autoverificación al final y
  `notify pgrst, 'reload schema'` — mismo patrón que `20260921020000`.
Test SQL: columnas existen; insert/cascade de `agent_turn_calls`;
`authenticated` NO puede hacer `select` directo sobre la tabla (0 filas, la
RLS sin política); la RPC por fase suma bien como `authenticated` que es
agente y devuelve vacío para uno que no lo es; `agent_token_usage` devuelve
las 7 columnas; el purgado borra solo lo anterior al plazo;
`has_function_privilege('anon', …)` = false en las tres; y un caso de
rendimiento como el de la búsqueda: con 200.000 filas sembradas, la RPC por
fase como `authenticated` tarda menos de 500 ms medido con
`clock_timestamp()`.

### T4 — Cada llamada al proveedor queda medida (después de T3)
Archivos: NUEVO `src/lib/ai/turn-telemetry.ts` (+ `.test.ts`),
`src/lib/ai/model.ts` + `model.test.ts`, `src/lib/ai/agent.ts` +
`agent.test.ts`, `src/lib/data.ts` (+ test de columnas), `src/lib/types.ts`,
`src/components/agent-control/agent-control-view.tsx`.
- `turn-telemetry.ts`: `AsyncLocalStorage<RegistroDeLlamadas>`
  (`node:async_hooks`); `conTelemetriaDeTurno(fn)` abre el registro;
  `telemetryMiddleware(fase)` (un `LanguageModelMiddleware` más, compuesto
  en `build()` de `model.ts` junto a `rateLimitMiddleware`) anota por
  llamada: `phase`, `sequence`, `params.maxOutputTokens`, `params.toolChoice`
  normalizado a texto, `usage` (forma V4 anidada del proveedor —
  `inputTokens.cacheRead`/`outputTokens.reasoning`; verificar contra
  `node_modules/@ai-sdk/provider` y fijarlo con test), `finishReason`,
  `duration_ms`; si `doGenerate` lanza, anota la fila con `finish_reason =
  "error"` y relanza. Sin registro activo (tests viejos, `simulate-message`)
  no hace nada. Nunca lanza por su cuenta.
- `runAgentTurn` corre dentro de `conTelemetriaDeTurno`. `logTurn` inserta
  `agent_turns` con `.select("id").single()`, recibe el snapshot de
  `tiempos` (`steps`, `tools_used`, `wait_ms` ← `esperaMs`, y los tres
  tramos; los que aún no se midieron en ese instante quedan `null`,
  documentar cuáles), y luego inserta las filas de `agent_turn_calls`
  (`turno_llamadas_no_escritas` si falla; nunca lanza). `turno_tiempos` en
  el log se conserva tal cual.
- Panel: `fetchTokenUsageSummary`/`TokenUsageSummary` traen caché y
  razonamiento; "Consumo de tokens" muestra los dos totales; NUEVA lectura
  `fetchTurnCallsByPhase(days)` (`data.ts`, por la RPC
  `agent_turn_calls_by_phase`, envuelta en `readListIfTableExists` de
  `agent-control/degradable-reads.ts` para degradar a `[]` si la migración
  falta) pintada como una tabla chica "Por fase" bajo el consumo (fase,
  llamadas, entrada, caché, razonamiento, techo, `none`); nunca se lee
  `agent_turn_calls` directo. `AGENT_TURN_COLUMNS`/`AgentTurn` suman
  `cached_input_tokens`, `steps`, `tools_used`, y el feed en vivo pinta
  "Caché: N" junto a "Razonamiento: N" y "N pasos · herramientas" cuando
  existen.
- `api/cron/process-queue`: el purgado diario de T3 (guarda Redis, nunca
  frena la cola), con test.
Tests: el middleware registra maxOutputTokens/toolChoice/usage/finish;
sin registro activo no rompe; dos turnos concurrentes no se mezclan (dos
`run` en paralelo); `logTurn` inserta calls con el `turn_id` devuelto y no
lanza si falla; el fake de `agent.test.ts` gana `agent_turn_calls`; un test
de `agent.test.ts` con `ToolLoopAgent` mockeado que verifique que la fila de
la fase `redactar` lleva `max_output_tokens: 1500` (literal) y, tras
escalar, `tool_choice: "none"` — es la prueba directa que pedía el informe
(7.4), medida en el punto donde el SDK ya resolvió los parámetros.

### T5 — El razonamiento se puede apagar de verdad, y todo texto tiene techo
Archivos: `src/lib/ai/model.ts` + `model.test.ts`, `src/lib/ai/agent.ts` +
`agent.test.ts`, `.env.production.example`, `docs/PRODUCCION.md` (tabla de
variables, fila de `AI_AGENT_REASONING`).
- `AI_AGENT_REASONING`: `none` (nuevo) → `providerOptions: { openai: {
  reasoningEffort: "none" } }` en agente y clasificador; `off` sigue
  omitiendo `providerOptions` (default del proveedor); `on`/ausente/basura
  siguen mandando `medium`/`low`. Sin cambio de default. El operador decide
  en Dokploy tras leer `agent_turn_calls.reasoning_tokens` por fase.
- Corregir el comentario de cabecera de `model.ts` (Luna SÍ razona por
  default: 58,5 % de la salida medida el 21/9/2026; el warning del 8/9 era
  de otra versión del SDK) y la fila de PRODUCCION.md.
- `generateText` de la reescritura de identidad (`agent.ts:1032`) gana
  `maxOutputTokens: MAX_OUTPUT_TOKENS`.
Tests: `none` manda `"none"` a los dos modelos; `off` y default intactos;
la reescritura viaja con `maxOutputTokens: 1500` (literal).

### T6 — El prompt de escenarios tiene un prefijo que puede cachear
Archivos: `src/lib/ai/playbooks.ts` + `playbooks.test.ts`.
- `buildPrompt`: el párrafo del reloj (fecha/hora/franja/horario/estado +
  la regla de "compruébalos contra ESA hora") baja al FINAL, después del
  catálogo y de las reglas de duda, justo antes de "Responde solo con el
  nombre exacto…". Todo lo estático (instrucción + catálogo + reglas) queda
  primero. Comentario con el hallazgo 4 y la fecha.
Tests: con dos `now` distintos, el prompt es idéntico hasta el último
carácter del bloque estático; el reloj aparece DESPUÉS de "Escenarios
disponibles"; los tests de reconocimiento existentes siguen en verde (el
enum no cambia). NO se agrega `promptCacheKey`: no se sabe si OpenRouter lo
reenvía — primero medir con T4 qué fase cachea y cuánto. **Sin promesa de
efecto** (nota A del VPS): con 14 escenarios activos el bloque estático
ronda 2.900 caracteres (~830 tokens), por debajo del mínimo de ~1.024 del
caché de OpenAI, y `CLASSIFY_PROMPT` (~570 tokens) también — hoy solo la
redacción puede cachear, coherente con 93 de 184 en cero. T6 es correcto y
barato; T4 dice después si alcanza.

### T7 — `api/media` y el enlace a Meta dejan rastro
Archivos: `src/app/api/media/[...path]/route.ts` + `route.test.ts`,
`src/lib/media-link.ts` (+ test), `src/app/api/messages/send/route.ts`,
`src/lib/ai/send.ts`.
- Route: `log.warn("media.sin_sesion")`, `log.warn("media.sin_acceso", {
  userId })`, `log.error("media.no_firmado", { path, detail:
  errorText(error) })` (hoy el error de Storage se descarta), y `try/catch`
  → 500 JSON + `log.error("media.fallo", { path, detail })`. Cabecera con el
  hallazgo 1: Meta no pasa por acá; esto es para los asesores y el sticker,
  NO el arreglo del 500 de Meta (ese lo hace el access log de Traefik, T9).
- `signedUrlForSending(mediaUrl, contexto?: { messageId, conversationId })`:
  el `console.error` pasa a `log.error("send.enlace_no_firmado", …)`; los
  dos llamadores pasan sus ids. Verificar antes que `media-link.ts` no
  llega al bundle del navegador (importa `createAdminClient`, así que no
  debería); si llegara, `console.error` con ids y nota.
Tests: cada rama escribe su evento (mock de `@/lib/log`); una excepción en
`getSession` → 500 + `media.fallo` (hoy no existe ese test).

### T8 — Los logs sobreviven al deploy
Archivos: `docker-compose.dokploy.yml`, `docs/PRODUCCION.md` (§7 "En
Dokploy" + §9), `docs/entregas/…` (T9).
- Servicio `app`: `logging: { driver: journald, options: { tag: "sbk-crm-app" } }`.
  `docker logs` sigue funcionando con este driver; además `journalctl
  CONTAINER_TAG=sbk-crm-app --since "2h"` sobrevive al recreate.
- PRODUCCION: cómo leer (`journalctl -o cat CONTAINER_TAG=… | jq`). **No
  hay nada que fusionar** (objeción 2 del VPS): Dokploy REGENERA el compose
  en cada deploy a partir del archivo del repo, inyectando los labels de
  Traefik desde su pestaña Domains — lo que en el VPS parece "editado a
  mano" es una reserialización de YAML hecha por máquina. El bloque
  `logging:` viaja solo. Lo que sí se documenta: (a) verificar tras el
  primer deploy que el dominio responde y que el contenedor conserva los
  labels de Traefik (`docker inspect … --format '{{json .Config.Labels}}'`);
  (b) un `git reset --hard` A MANO fuera de un deploy sí tira los labels y
  el dominio cae a 502 hasta el próximo despliegue. Prerrequisitos de
  journald ya verificados por el VPS el 21/9: `/var/log/journal` existe
  (persistente), 422 MB usados, 162 GB libres, sin tocar `journald.conf`.
Sin test automatizable; el criterio es en producción (ver Verificación).

### T9 — Documentación, trampas y entrega
Archivos: `docs/planes/2026-09-21-nada-se-pierde-en-un-corte-ni-en-un-deploy.md`
(este plan), `docs/entregas/2026-09-21-nada-se-pierde-….md`, `docs/GLOSARIO.md`,
`CLAUDE.md` (trampas), `docs/PRODUCCION.md` §12, memoria.
- Trampas nuevas: "Meta descarga desde Storage, no desde `/api/media`";
  "el webhook responde 503 SOLO ante fallo transitorio de persistencia";
  "la telemetría por llamada viaja por `AsyncLocalStorage`, un test que
  llame a `runAgentTurn` con fake necesita `agent_turn_calls`"; "el reloj
  del prompt de escenarios va al final a propósito".
- Entrega para el VPS: migración ANTES del código (`PGOPTIONS="-c
  lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1`); la verificación del dominio
  tras el deploy (T8); **activar el access log de Traefik** (objeción 3:
  la petición de Meta murió antes de Envoy y Traefik no registra accesos
  — en la configuración de Dokploy del servicio `dokploy-traefik`,
  `accessLog: { filePath: /var/log/traefik/access.log, format: json,
  fields: { headers: { names: { User-Agent: keep } } } }` y reinicio de
  Traefik; después, el próximo 131053 se busca por `facebookexternalua` y
  el código de respuesta); pedirle el SQL de confirmación de T3/T4 a las
  24 h (tokens por fase, caché por fase, `max_output_tokens`/`tool_choice`
  de las filas `redactar`); y las nuevas consultas de conteo
  (`webhook_mensaje_no_guardado`, `base_reintento`, `base_agotada`).

## Orden y dependencias
T1 → T2. T3 → T4. T5, T6, T7 independientes (pueden ir en paralelo con
T1/T3). T8 sin dependencias. T9 al cierre. Commits: T3 solo, con
`[migración]` en el título; el resto agrupado por frente, narrativo.

## Verificación

Local: suite completa (`rtk npm run test`), `rtk npx tsc --noEmit`, `rtk npm
run lint`, `rtk proxy npm run build` (timestamp de `.next/BUILD_ID`); tests
SQL sobre `npx supabase db reset` (o `docker exec` con `-1 -v
ON_ERROR_STOP=1`); mutación manual sobre T1 (quitar un patrón transitorio →
su test rojo) y T2 (quitar el 503 → rojo), con respaldo `cp` antes de mutar,
nunca `git checkout --`. Escenario a mano con la base local levantada: un
mensaje simulado por `api/dev/simulate-message` deja fila en `agent_turns`
con `steps`/`tools_used` y N filas en `agent_turn_calls` con `phase` y
`max_output_tokens = 1500` en `redactar`; apagar PostgREST (`docker stop`)
durante un POST al webhook local → 503 y evento `webhook_mensaje_no_guardado`;
volver a levantarlo y repetir el POST → 200 y el mensaje guardado.

Producción (criterios para el VPS, 24–48 h después):
- `select phase, count(*), sum(reasoning_tokens), sum(cached_input_tokens),
  max(max_output_tokens) from agent_turn_calls group by 1` — la fase
  `escenario` deja de cachear cero (T6); `redactar` trae `1500` en todas.
- `tool_choice = 'none'` en toda fila `redactar` posterior a una escalada
  del mismo turno (T4 = 7.4 del informe, probado en dato).
- `webhook_mensaje_no_guardado` con `retry` → cada uno seguido de un `23505`
  o de un guardado exitoso en la reentrega; `webhook_error_actualizar_estado`
  baja frente a `base_reintento` (los cortes cortos ya no llegan al llamador).
- Tras el siguiente deploy, `journalctl CONTAINER_TAG=sbk-crm-app --since
  "1 day"` sigue mostrando los turnos del contenedor anterior.
- El 500 de la imagen: el VPS lo busca en Storage/Envoy, no en la app.

## Ejecución (22/9/2026)

Las nueve tareas se implementaron sin commit sobre el árbol de trabajo de
`main` (subagentes en paralelo, T1→T2 y T3→T4 en su orden de dependencia,
T5-T8 en paralelo). Verificación a mano del orquestador, 06:00-06:40 UTC,
base local: escenario con PostgREST apagado a mitad de un POST al webhook
(503 + `webhook_mensaje_no_guardado`, reintento al volver a levantarlo →
200 y mensaje guardado) y un turno real dejando fila en `agent_turns` con
`steps`/`tools_used` y cuatro filas en `agent_turn_calls`
(`escenario`/`clasificar`/`redactar`×2, la segunda con `tool_choice=none`
tras escalar) — la prueba directa del punto 7.4 del informe del VPS.

Tres desvíos sobre el plan original, los tres correcciones halladas en esa
misma verificación, no cambios de diseño:

- **T2b — la primera lectura del lote (el canal) no tenía ningún inyector
  de T1/T2.** `whatsapp_channels` por `phone_number_id` leía `!channel` sin
  mirar `error`: un corte de la base justo en ESE paso descartaba el lote
  entero con 200 antes de que el resto del código de T2 llegara a correr —
  el mismo agujero que T2 cerró tres pasos más adelante, pero en el primer
  paso. Se agregó `webhook_canal_no_consultable` + `persistenciaFallida`
  igual que los otros tres sitios, y se renombró `phoneNumberId` a
  `canalMeta` en el evento vecino `webhook_canal_no_encontrado` porque
  `lib/log.ts` oculta toda clave que contenga "phone" (pensado para el
  teléfono de un cliente; acá es el id del número de Meta, infraestructura).
- **La clasificación de "transitorio" mira también `err.message`, no solo
  `err.code`.** Hallazgo de Kong vs Envoy (ver la entrega para el VPS): en
  esta máquina el proxy delante de PostgREST es Kong, y con PostgREST
  apagado Kong responde `503 {"message":"name resolution failed"}` — un
  cuerpo sin `code`, que `postgrest-js` convierte en `PostgrestError {
  code: "", message: <cuerpo> }`. Sin mirar `message`, ese 503 no se
  reconocía como transitorio. `errores-base.ts` suma los patrones de Kong
  (`name resolution failed`, `failure to get a peer from the ring-balancer`,
  `invalid response was received from the upstream`) a los de Envoy
  (`upstream connect error`, `disconnect/reset before headers`, `connection
  termination`); producción usa Envoy, así que la clasificación cubre los
  dos proxys en vez de asumir cuál hay delante.
- **El panel "Por fase" de T4 quedó client-side, no en el `Promise.all` de
  `page.tsx`.** La tarea no incluía ese archivo en su alcance ("Archivos:"
  de T4) y `agent-control-view.tsx` ya hace su propio refresco client-side
  para el resto del panel; se cargó en un `useEffect` de montaje aparte
  (con `.then()` en vez de llamar al `useCallback` por nombre, porque
  `react-hooks/set-state-in-effect` sigue la referencia hasta el `setState`
  interno y lo marca como síncrono aunque viva después de un `await`).

Documentación (T9): `CLAUDE.md` suma ocho trampas nuevas y corrige las dos
que quedaron falsas (`AI_AGENT_REASONING=off`/`no razona`, en dos lugares
distintos del archivo); `docs/PRODUCCION.md` corrige la fila de la variable
en §1, suma la sección de journald en §7 y el §12 con el orden y la
verificación de esta entrega; `docs/GLOSARIO.md` verificado archivo por
archivo (faltaban `admin.test.ts`/`media-link.test.ts`/`turn-telemetry.test.ts`
y la actualización del panel "Consumo de tokens", que hasta esta corrida
decía que no sumaba caché/razonamiento — quedó falso desde T4/T3 y se
corrigió). Sin commitear ni pushear: eso lo hace el orquestador después de
revisar los reportes de los nueve subagentes.
