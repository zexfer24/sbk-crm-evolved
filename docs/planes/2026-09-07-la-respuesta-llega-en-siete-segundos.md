# Plan · La respuesta llega en siete segundos

Rama `respuesta-en-siete-segundos` desde `origin/main` (= `e2f9e24` =
producción, verificado el 7/9/2026 por SSH `mi-servidor-cloud`: el checkout
de Dokploy está en `e2f9e24`). Sin migración. Orquestador: Fable. Implementan
subagentes `general-purpose` con `model: "sonnet"`, uno por tarea, contexto
limpio, reporte obligatorio. Los subagentes NO hacen commit ni editan
`docs/GLOSARIO.md`/`CLAUDE.md`: entregan la línea de glosario por archivo y
el orquestador la aplica al commitear (misma convención que las corridas
anteriores). Copia final del plan en
`docs/planes/2026-09-07-la-respuesta-llega-en-siete-segundos.md` (T6, este
documento).

## Contexto

El dueño reporta esperas de hasta hora y media por una respuesta de la IA. El
diagnóstico ya está hecho (brief del operador, 7/9/2026, 88 turnos medidos):
el turno completo tarda 7,2 s de mediana; lo que se come el tiempo es la
**cola** (11,2 min de mediana, p90 32 min). Tres frenos calibrados a 4
turnos/min —`AGENT_MAX_TURNS_PER_MINUTE=4`, `AI_MAX_REQUESTS_PER_MINUTE=15`
(≈4,4 turnos/min, default de una cuenta gratuita que ya no existe) y el cron
cada 300 s con tope 10— y un turno frenado que **nadie despierta** a los 20 s
(`RETRY_WHEN_PACED_SECONDS` sin despertador: solo el próximo webhook o el
cron). Meta: **p50 ≤ 7 s y p90 ≤ 10 s** en el camino "pregunta terminada + 1
paso de redacción"; ráfaga ~11 s (debounce de 6 s intocable); 2 pasos ~9 s.

## Hallazgos de la lectura que cambian el diseño respecto al brief

1. **No hay Redis local en esta máquina** (puerto 6379 cerrado; Docker sí
   está arriba). `queue.test.ts` y `redis-queue.test.ts` se saltan ENTEROS
   sin Redis (`if (!disponible) return`): un test nuevo ahí pasa "verde" sin
   ejecutarse, y la prueba de mutación del orquestador daría verde de
   mentira. → Los tests de reparto de T0/T1/T3 van en archivos con
   `FakeRedis` (`queue-limit.test.ts` y un `queue-continuation.test.ts`
   nuevo); los de atomicidad Lua de T0 van en `redis-queue.test.ts` Y el
   orquestador levanta un Redis real para validarlos (`docker run -d --name
   sbk_redis -p 6379:6379 redis:7-alpine redis-server --appendonly yes`,
   receta ya escrita en la cabecera de `redis-queue.test.ts`).
   `fake-redis.ts` reconoce los scripts POR CONTENIDO y reimplementa su
   semántica: todo cambio al `CLAIM_SCRIPT` se espeja ahí en la misma tarea.
2. **`.env.example` no existe.** Las plantillas son `.env.local.example` y
   `.env.production.example` (las dos llevan hoy `AGENT_MAX_TURNS_PER_MINUTE=4`
   y el comentario "Con un techo de 20/min, 15 es el número"). T1 toca las dos.
3. **La base no sabe qué herramienta usó un turno**: `agent_turns` guarda
   `intent/action/summary/tokens`, y `turno_tiempos` trae `pasos` pero no el
   nombre. La medición de T4 ("qué herramienta dispara el segundo paso") no
   sale de ningún dato existente. → T0 añade `herramientas` a
   `turno_tiempos` (nombres de `result.steps[].toolCalls[].toolName` unidos
   por coma; `LogContext` solo admite primitivos) y T4 pasa a ser una
   medición POSTERIOR al despliegue, sobre esa línea, sin código.
4. **`runAgentTurn(conversationId)` no sabe cuándo venció el turno.** Para
   separar debounce de cola hay que pasarle el vencimiento desde la cola:
   `runAgentTurn(conversationId, { vencioEn?: number })`. Llamadores:
   `queue.ts` (pasa el score) y `api/dev/simulate-message` (sin cola →
   omite; los dos tramos quedan `null`). Los mocks `runAgentTurn: (id) =>
   mock(id)` de `queue-limit`/`queue.test` siguen valiendo (el segundo
   argumento se ignora).
5. **Un turno diferido pierde su vencimiento original**: `cola.enqueue(id,
   20)` en el camino "ritmo al tope" sobrescribe el score, así que
   `debounceMs = score − lcma` incluiría la espera en cola previa y `colaMs`
   mediría de menos —justo el número del criterio de cierre (`colaMs` < 1 s
   de mediana), sesgado hacia el verde—. → `AgentQueue` gana
   `defer(conversationId, seconds)`: mismo ZADD, pero guarda el primer
   vencimiento en `liminal:agent:vencimiento:{id}` (`SET NX EX 3600`);
   `enqueue` (camino del webhook, ventana nueva) lo BORRA; `claimDue` lo lee
   y lo borra dentro del mismo script y devuelve `{ conversationId, vencioEn
   }` con el original si existía, si no el score. Los cuatro re-encolados de
   `processQueuedTurns` (ritmo, cupo, lock, error) pasan a `defer`.
6. **La continuación de T3 no puede usar `after()` de Next**: `after()`
   solo vale dentro de una petición (o de otro `after`), y la continuación
   se dispara desde un `setTimeout` fuera de todo request. En el standalone
   de Node los timers viven sin problema (así corre ya `processAfterDebounce`
   dentro del `after` del webhook). → `setTimeout(...).unref()` a nivel de
   módulo, UNA pendiente como máximo por proceso, con el menor plazo de los
   diferidos de la pasada (3 s cupo / 20 s ritmo / 30 s lock) + margen; la
   cancela `stopAgentQueue()`. El cron sigue siendo red de seguridad.
7. **Los defaults en código también cambian** (no solo el `.env`): el 15 de
   `rate-limit.ts` y el 4 de `queue.ts` están calibrados contra un techo que
   OpenRouter ya no impone (verificado el 7/9 con la llave de producción),
   y `AI_MAX_*` no están en el Environment de Dokploy. La rampa de T5 se
   hace con valores EXPLÍCITOS en Dokploy, así que el default nuevo no salta
   a producción sin pasar por el escalón 1.
8. **Comentarios que quedan mintiendo tras S1** y se corrigen en T1 con la
   historia: cabecera de `rate-limit.ts` ("15 contra 20"),
   `maxTurnsPerMinute()` en `queue.ts` ("cuatro por minuto es
   deliberadamente lento"), `api/agent/backlog/route.ts` ("diez turnos cada
   cinco minutos", `SWEEP_LOCK_SECONDS` "media hora al ritmo del cron"),
   cabecera de `api/cron/process-queue/route.ts` ("cinco minutos"),
   `docs/PRODUCCION.md` §7 ("cada 5 minutos", el crontab `*/5`, "Cron de la
   cola") y `queue-limit.test.ts` ("MAX_PER_RUN es diez").
9. **SSH `mi-servidor-cloud` funciona hoy** (solo lectura verificada). T2
   exporta los historiales reales desde ahí a un JSON local ignorado por
   git; T5 se vigila desde acá.
10. **El comparador de T2 corre con vitest, no con `tsx`**: `classify.ts`,
    `playbooks.ts` y `model.ts` importan `server-only`, y el único runner
    del repo que lo stubea (alias en `vitest.config.ts`) es vitest.
    `scripts/verificar-respaldo.test.ts` ya sienta el precedente de tests
    en `scripts/`. Se guarda por variable de entorno para que la suite
    normal no lo ejecute jamás.

## Decisiones del operador (sección 9 del brief)

Tomadas el 7/9/2026 (no re-litigar):

1. **Objetivo:** p50 ≤ 7 s en el camino normal y ~11 s en ráfaga. El
   debounce de 6 s / 2 s NO se toca.
2. **T4 = segunda ola.** En esta corrida solo se mide (línea `herramientas`
   de T0 + tráfico real tras T5). El prompt del redactor no se toca.
3. **Las variables de Dokploy las carga el operador** a mano en cada
   escalón; el orquestador le dicta los valores, espera confirmación y
   verifica dentro del contenedor con `docker exec … env | grep AGENT_`.

## Reglas para todos los subagentes

- Leer `CLAUDE.md`, `AGENTS.md`, `docs/GLOSARIO.md` y los archivos que nombra
  la tarea ANTES de escribir. Todo en español; comentarios con el porqué y
  la fecha (7/9/2026, medición del brief); `rtk` delante de todo comando
  (`rtk npx vitest run <ruta>`, `rtk npm run lint`, `rtk npx tsc --noEmit`).
- Sin commit, sin tocar `GLOSARIO.md`/`CLAUDE.md`: entregar la línea de
  glosario propuesta por archivo tocado.
- Si el subagente cree necesitar una migración o un cambio de esquema, se
  detiene y lo reporta.
- Reporte final: qué se implementó y decisiones tomadas; archivos tocados;
  resultado de `rtk npx vitest run` de los archivos de la tarea + `lint` +
  `tsc`; desvíos y deuda.

## Orden de ejecución

- **Tanda 1 (paralelo, archivos disjuntos):** T1 (`queue.ts`,
  `rate-limit.ts`, compose, plantillas `.env`, PRODUCCION, backlog/cron
  comentarios, `queue-limit.test.ts`, `rate-limit.test.ts`) ‖ T2
  (`model.test.ts`, `scripts/`, `.gitignore`).
- **Tanda 2:** T0 (`agent.ts`, `redis-queue.ts`, `fake-redis.ts`,
  `queue.ts` —solo el `claimDue`/`defer`—, `agent.test.ts`,
  `redis-queue.test.ts`, `queue-limit.test.ts`), cuando T1 esté commiteada
  (los dos editan `queue.ts`).
- **Tanda 3:** T3 (`queue.ts`, `queue-continuation.test.ts` nuevo), cuando T0
  esté commiteada.
- **Tanda 4:** T6 documentación. Después T5 (orquestador + operador).
- Cada tanda cierra con `rtk npm run test`, `rtk npm run lint`, `rtk npx tsc
  --noEmit` en verde y su commit.

---

## T1 · Destopar los tres frenos (S1) — tanda 1

**Archivos:** `src/lib/ai/queue.ts`, `src/lib/ai/rate-limit.ts`,
`src/lib/ai/queue-limit.test.ts`, `src/lib/ai/rate-limit.test.ts`,
`docker-compose.dokploy.yml`, `docker-compose.yml`, `.env.local.example`,
`.env.production.example`, `docs/PRODUCCION.md`, comentarios en
`src/app/api/agent/backlog/route.ts` y `src/app/api/cron/process-queue/route.ts`.

- `queue.ts`: `const MAX_PER_RUN = 10` → `function maxPerRun(): number` que
  lee `AGENT_QUEUE_MAX_PER_RUN` con el patrón exacto de `maxTurnsPerMinute()`
  (`Number(...)`, `Number.isFinite && > 0`, si no default **30**).
  `processAfterDebounce(limit = maxPerRun(), ...)` y `processQueuedTurns(limit
  = maxPerRun())`. Defaults nuevos: `maxConcurrentTurns()` 3 → **8**,
  `maxTurnsPerMinute()` 4 → **30**. Reescribir los dos doc-comments: el
  "deliberadamente lento" del 26/8/2026 queda como historia; la razón nueva
  es la medición del 7/9/2026 (demanda 2,54 conv/min media, picos de 6; 27
  `cola_ritmo_al_tope` en 18 min; hora y media de espera con 360 en cola a
  4/min) y que el freno de emergencia real es `agent_can_run` por turno + el
  tope de gasto diario, no la lentitud.
- `rate-limit.ts`: `topeConcurrente()` 3 → **12**, `topePorMinuto()` 15 →
  **120**. Cabecera: sustituir "15 contra 20" por la verdad del 7/9/2026
  (`/api/v1/key` de OpenRouter: `is_free_tier: false`, `limit: null`,
  `rate_limit` deprecado; el 20/min era de la cuenta gratuita) y la
  aritmética que obliga a subir los dos frenos juntos (un turno ≈ 3,4
  peticiones → 15/min = 4,4 turnos/min; subir solo el de turnos produce
  `ia_ritmo_al_tope` durmiendo hasta 60 s dentro del turno). Sin cambio de
  lógica.
- Compose ×2: `sleep 300` → `sleep 60`; comentario "cada 5 minutos" → "cada
  minuto" con el porqué (red de seguridad de 2 turnos/min era parte del
  atraso).
- Plantillas `.env` ×2: bloque Redis/ritmo con las CINCO variables
  (`AGENT_MAX_CONCURRENT_TURNS=8`, `AGENT_MAX_TURNS_PER_MINUTE=30`,
  `AGENT_QUEUE_MAX_PER_RUN=30`, `AI_MAX_CONCURRENT_REQUESTS=12`,
  `AI_MAX_REQUESTS_PER_MINUTE=120`) y comentarios nuevos: por qué van
  juntas, qué medía cada una, y que la vuelta atrás es bajar
  `AGENT_MAX_TURNS_PER_MINUTE` en Dokploy.
- `docs/PRODUCCION.md`: §1 tabla → fila por cada una de las cinco (valor,
  por qué, cómo se revierte); §7 "cron" → "cada minuto"; crontab `*/5` →
  `* * * * *`; "Cron de la cola de turnos" → red de seguridad cada minuto +
  la continuación propia de T3 (cuando exista); apartado nuevo "Rampa de
  los topes" con los dos escalones y las señales a vigilar
  (`cola_ritmo_al_tope` baja, `ia_ritmo_al_tope` nunca, cero 429,
  `zcard liminal:agent:turns` tiende a 0).
- Comentarios de `backlog/route.ts` (cabecera y `SWEEP_LOCK_SECONDS`) y
  `cron/process-queue/route.ts`: dejar de decir "diez cada cinco minutos".

**Tests:**
- `queue-limit.test.ts` (FakeRedis): "el tope por pasada sale del entorno"
  (`AGENT_QUEUE_MAX_PER_RUN=3`, 5 encoladas → 3 atendidas, 2 pendientes);
  "con basura cae al default" (`"muchos"` → default 30: 32 encoladas → 30
  atendidas); "con cero cae al default"; el caso existente "el cron sigue
  drenando hasta su tope por pasada" pasa a fijar la variable en 10 (o a
  esperar 30 de 32) y su comentario deja de decir "MAX_PER_RUN es diez".
  `afterEach` borra `AGENT_QUEUE_MAX_PER_RUN`.
- `rate-limit.test.ts`: "los dos topes salen del entorno" (con
  `AI_MAX_CONCURRENT_REQUESTS=1` el pico es 1; con
  `AI_MAX_REQUESTS_PER_MINUTE=2` la tercera petición se frena y aparece
  `ia_ritmo_al_tope`), y "sin variables, los defaults son 12 y 120"
  (afirmar el default explícitamente: es lo que documenta el cambio).
- `queue-limit.test.ts`: "con ritmo destopado una pasada no deja
  `deferred`" (sin `AGENT_MAX_TURNS_PER_MINUTE`, 8 encoladas → `deferred ===
  0`).

**Mutaciones del orquestador:** `MAX_PER_RUN` de vuelta a la constante 10 →
"sale del entorno" rojo; `"muchos"` en la variable → cae a 30, nunca `NaN`.

**Commit:** "Los tres frenos de la IA se sueltan a la vez y el cron mira
cada minuto".

## T2 · La clasificación en un modelo pequeño (S2) — tanda 1

**Archivos:** `src/lib/ai/model.test.ts`,
`scripts/comparar-clasificador.test.ts` (nuevo),
`scripts/exportar-historiales-clasificador.sql` (nuevo), `.gitignore`.

- **Test de la trampa** en `model.test.ts`, describe "costura…": con
  `AI_AGENT_PROVIDER=openai` y `AI_CLASSIFIER_MODEL=google/gemini-3.1-flash-lite`
  (nombre de OpenRouter) el clasificador se construye con `openaiMock` y NO
  con `googleMock` (sale por `OPENAI_BASE_URL`, que es lo que queremos), y
  el agente sigue en `gpt-5.6-luna`. Mutación: prefijo `google/` en
  `resolveProvider` → rojo.
- **Export** (`scripts/exportar-historiales-clasificador.sql`, se corre por
  SSH con `docker exec -i supabase-db psql -At`): ~200 conversaciones con
  turno de IA en los últimos 7 días, cada una con sus últimas 20 filas de
  `messages` (`sender_type, content, is_internal_note, message_type,
  created_at`) en orden ascendente, más `ai_playbooks` activos con sus tags
  y `agent_settings.business_hours`. Salida JSON a
  `scripts/historiales-clasificador.json` (entrada de `.gitignore`: trae
  texto de clientes, NUNCA al repo).
- **Comparador** (`scripts/comparar-clasificador.test.ts`): `it.skipIf(!
  process.env.COMPARAR_CLASIFICADOR)`, timeout propio de 30 min. Reconstruye
  cada historial con `historyLine` (el mismo camino que `loadHistory`), y
  para cada uno llama `classifyIntent(history)` y `matchPlaybook(history,
  playbooks, createdAt-del-último-mensaje, businessHours)` DOS veces: con
  `AI_CLASSIFIER_MODEL` vacío (grande = `AI_AGENT_MODEL`) y con
  `AI_CLASSIFIER_MODEL=google/gemini-3.1-flash-lite`. Los dos leen el env
  en cada llamada, así que basta con cambiar `process.env` entre pasadas.
  Fija `AI_MAX_REQUESTS_PER_MINUTE`/`AI_MAX_CONCURRENT_REQUESTS` altos en el
  propio archivo. Reporta: tabla de acuerdo por enum (intención) con
  matriz de confusión, escenarios que el grande reconoció y el chico no
  (lista con id), `clasificacionMs` mediana/p90 por modelo, y errores del
  proveedor (si OpenRouter no acepta `output: "enum"` para Gemini, el
  comparador lo va a delatar: eso es un resultado, no un fallo del
  script). Se corre localmente con `OPENAI_API_KEY`/`OPENAI_BASE_URL` de
  producción exportadas en la shell de esa corrida (no en archivo).
- **Criterio de aplicación:** ≥ 95 % de acuerdo en intención y cero
  escenarios perdidos. Si no llega, se reporta y `.env` no se toca; el plan
  sigue sin T2 con la meta en ~9 s.

**Commit:** "Un comparador decide si la clasificación puede mudarse a un
modelo chico".

## T0 · El log dice cuánto se esperó en la cola — tanda 2

**Archivos:** `src/lib/ai/redis-queue.ts`, `src/lib/ai/fake-redis.ts`,
`src/lib/ai/queue.ts`, `src/lib/ai/agent.ts`, `src/lib/ai/redis-queue.test.ts`,
`src/lib/ai/queue-limit.test.ts`, `src/lib/ai/agent.test.ts`.

- `redis-queue.ts`: `CLAIM_SCRIPT` devuelve `{miembro, score}`
  (`ZRANGEBYSCORE ... WITHSCORES LIMIT 0 1`, `ZREM`, luego `GET`+`DEL` de
  `ARGV[2]..miembro` —la clave de vencimiento original— y devuelve
  `{member, original or score}`); `claimDue(): Promise<{ conversationId:
  string; vencioEn: number } | null>`; nueva `defer(conversationId,
  seconds)` (ZADD + `SET liminal:agent:vencimiento:{id} <scoreAnterior> NX
  EX 3600` — el score anterior se lee con `ZSCORE` antes del ZADD; si no
  había, no se guarda nada); `enqueue` suma `DEL` de esa clave. `purge`
  borra también las claves `liminal:agent:vencimiento:*` (SCAN; son pocas).
- `fake-redis.ts`: espejar `zscore`, `get`, `set` con `EX`/`NX` (ya existe
  `NX`), y el `CLAIM_SCRIPT` nuevo devolviendo `[member, score]` como tabla
  Lua → array.
- `queue.ts`: `atender()` usa `const reclamo = await cola.claimDue()`; pasa
  `runAgentTurn(reclamo.conversationId, { vencioEn: reclamo.vencioEn })`;
  los cuatro re-encolados usan `cola.defer(...)`.
- `agent.ts`: `TurnTiming` gana `debounceMs` (= `vencioEn − lcma`, `null`
  sin `vencioEn`), `colaMs` (= `arranque − vencioEn`) y `herramientas`
  (`string | null`, nombres de `result.steps` unidos por coma; `""` si no
  usó ninguna). `esperaMs` sigue siendo `arranque − lcma` (y con `vencioEn`
  válido cumple `debounceMs + colaMs === esperaMs` por construcción, sobre
  el mismo `Date.now()` capturado UNA vez). `runAgentTurn(conversationId,
  options?: { vencioEn?: number })`; `newTurnTiming(lcma, vencioEn)`.
  Comentario con el porqué: separar el tramo que es diseño (debounce) del
  que es atraso (cola) es lo único que permite afirmar por turno que se
  cumplió la meta del 7/9/2026.
- **Tests:** `redis-queue.test.ts` (Redis real): "el reclamo devuelve la
  conversación y su vencimiento" (score encolado = `vencioEn` ± 5 ms), "un
  turno diferido conserva el vencimiento original" (`enqueue(id,0)` →
  `defer(id,20)` → adelantar reloj/encolar con `-30` → `claimDue().vencioEn`
  es el original), "un mensaje nuevo reinicia el vencimiento" (`defer` →
  `enqueue` → el original desaparece), y el caso de atomicidad existente
  adaptado a la forma nueva. `queue-limit.test.ts`: "el turno recibe el
  vencimiento con que se reclamó" (mock captura el 2.º argumento).
  `agent.test.ts`, describe "tiempos del turno": "separa la ventana de
  silencio de la espera en cola y suman la espera total" (`lcma = ahora −
  8000`, `vencioEn = ahora − 5000` → `debounceMs ≈ 3000`, `colaMs ≈ 5000`,
  `debounceMs + colaMs === esperaMs`), "sin vencimiento los dos tramos
  quedan null y esperaMs sigue" y "la línea trae las herramientas usadas"
  (el mock de `generate` ya devuelve 2 pasos: afirmar el nombre).
- **Mutación del orquestador:** `claimDue` devolviendo `vencioEn: 0` →
  el test de suma en `agent.test.ts` NO se rompe solo (el turno recibe lo
  que le pasan): la mutación se aplica en `queue.ts` (pasar `vencioEn: 0`)
  y debe poner rojo "el turno recibe el vencimiento con que se reclamó"; y
  en `agent.ts` (calcular `colaMs` desde otro `Date.now()`) debe poner rojo
  la suma. Se ejecutan las dos.
- **Reporte:** una línea `turno_tiempos` real (del test o de local) con
  `debounceMs`, `colaMs`, `esperaMs`, `herramientas`.

**Commit:** "El registro de tiempos separa la ventana de silencio de la
espera en cola y nombra las herramientas".

## T3 · Un turno frenado no depende del cron (S3) — tanda 3

**Archivos:** `src/lib/ai/queue.ts`, `src/lib/ai/queue-continuation.test.ts`
(nuevo, FakeRedis + `vi.useFakeTimers`), `docs/PRODUCCION.md` (párrafo de
"Cron de la cola").

- En `processQueuedTurns`, cada rama que difiere anota el plazo usado
  (`RETRY_WHEN_BUSY_SECONDS` 3 / `RETRY_WHEN_PACED_SECONDS` 20 /
  `RETRY_WHEN_LOCKED_SECONDS` 30; el de error, 30, NO programa continuación:
  ya lo cubre el cron y no conviene reintentar errores en caliente). Al
  terminar la pasada, si `deferred > 0` y no hay continuación pendiente:
  `continuacion = setTimeout(() => { continuacion = null; void
  processQueuedTurns(); }, menorPlazo*1000 + WAKE_MARGIN_MS).unref()` y
  `log.info("cola_continuacion_programada", { enSegundos, diferidos })`.
  Una sola pendiente por proceso (variable de módulo); si ya hay una, no se
  programa otra (`log.info("cola_continuacion_ya_pendiente")` no: silencio,
  para no llenar el log). `stopAgentQueue()` la cancela. Errores de la
  continuación: `processQueuedTurns` ya no lanza; igual `.catch` con
  `log.error("cola_continuacion_fallida")`.
- Comentario con la historia: el 7/9/2026 el único despertador era el
  cron cada 5 min con tope 10 (2 turnos/min), y un turno frenado por ritmo
  se quedaba 20 s… hasta que el próximo webhook ajeno o el cron lo
  reclamaran. El límite deliberado del webhook (`limit =
  conversaciones.length`, 26/8/2026) se mantiene: la continuación usa
  `maxPerRun()`, y el freno real es el ritmo por minuto, no la lentitud.
- **Tests** (`queue-continuation.test.ts`): "una pasada con diferidos
  programa exactamente una continuación" (`AGENT_MAX_TURNS_PER_MINUTE=1`, 3
  encoladas → 1 procesada, 2 diferidas, un solo timer pendiente;
  `vi.advanceTimersByTime(20_500)` → `runAgentTurn` llamado otra vez);
  "sin diferidos no programa ninguna"; "dos pasadas con diferidos comparten
  una sola continuación"; "la continuación no se solapa con otra en curso"
  (mientras la continuación corre, una pasada nueva con diferidos no
  programa otra hasta que la primera termine); "stopAgentQueue cancela la
  continuación pendiente"; "elige el menor plazo" (cupo lleno → 3,5 s, no
  20,5).
- **Mutación del orquestador:** quitar el `setTimeout` → "programa
  exactamente una continuación" rojo.
- **Reporte:** simulación con FakeRedis y timers falsos: 100 conversaciones
  sembradas, `AGENT_MAX_TURNS_PER_MINUTE=30`, sin cron → tiempo virtual
  hasta drenar (esperado ≈ 3 min 20 s: 30 + 30 + 30 + 10 con esperas de
  20 s entre pasadas).

**Commit:** "La cola se despierta sola cuando un turno quedó frenado".

## T4 · Los dos pasos de redacción — medición posterior (sin subagente)

Con la línea nueva de T0 (`herramientas`, `pasos`) y 2 h de tráfico real
tras T5: proporción de turnos con 2 pasos, herramienta que lo dispara
(`consultarBiblioteca` / `buscarHistorialCompras` / `escalarAAsesor`) y
`redaccionMs` por paso. Entregable: tabla en el reporte de cierre. Nada de
tocar el prompt sin segunda aprobación del operador (decisión 2).

## T6 · Documentación — tanda 4

**Archivos:** `docs/planes/<fecha>-la-respuesta-llega-en-siete-segundos.md`
(este plan + hallazgos + decisiones + brief completo del operador + resultado
de la corrida, mismo formato que `2026-09-07-ventana-24h-dice-la-verdad.md`
y `2026-09-08-la-ia-ve-lo-que-llega.md`), `CLAUDE.md` (Arquitectura: la cola
ya no drena a 4/min ni depende del cron: cinco variables, continuación
propia; Trampas: "los tests de la cola con Redis real se saltan sin Redis",
"`debounceMs`/`colaMs` separan diseño de atraso"; el 20/min "de la cuenta
gratuita" como trampa histórica), `docs/GLOSARIO.md` (revisar que T0–T3
dejaron sus filas; `scripts/comparar-clasificador.test.ts`,
`queue-continuation.test.ts`, el SQL de export).

**Commit:** "La documentación cuenta cómo la cola drena en minutos y cómo se
mide cada tramo del turno".

## Validación del orquestador (antes de cerrar cada tarea)

- Leer el reporte entero; sin reporte no hay tarea.
- Correr `rtk npm run test`, `rtk npm run lint`, `rtk npx tsc --noEmit`;
  para T0 y T3 además con `sbk_redis` levantado (`REDIS_URL` por defecto ya
  apunta a `127.0.0.1:6379`) para que `queue.test.ts`/`redis-queue.test.ts`
  corran de verdad; anotar en el reporte cuántos tests corrieron con Redis.
- Mutaciones de la sección de cada tarea; si una no se pone roja, la tarea
  vuelve.
- Fábricas espejo (`route.test.ts`, `new-contact-race.test.ts`,
  `welcome-race.test.ts`): ninguna tarea agrega a `queue.ts` un export que el
  webhook use (`defer` es interno a la cola; `maxPerRun` no se exporta), así
  que no cambian; se verifica corriendo esos tres archivos.
- Build final: `rtk proxy npm run build` + timestamp de `.next/BUILD_ID`.
- `git log`: un commit por tarea, narrativo, sin `[migración]`.

## T5 · Rampa y verificación en producción (orquestador + operador, paso a paso)

Solo con confirmación del operador en cada paso; según la decisión 3, las
variables las carga el operador en el Environment de Dokploy o se cargan
por la API. Orden (sección 8 del brief): respaldo `pg_dump` →
`/root/respaldos/sbk-<fecha>-pre-siete-segundos.sql.gz`; escalón 1 en
Dokploy (`AGENT_MAX_TURNS_PER_MINUTE=10`, `AI_MAX_REQUESTS_PER_MINUTE=40`,
`AI_MAX_CONCURRENT_REQUESTS=6`, `AGENT_MAX_CONCURRENT_TURNS=4`,
`AGENT_QUEUE_MAX_PER_RUN=30`) SIN desplegar; merge a `main` + push (webhook
despliega; seguir `deployment.allByCompose?composeId=5z7CkrotCBgO9rTAOsZYH`;
`compose.deploy` si no arranca, NUNCA `redeploy`); 12 labels de Traefik y
`/api/health`; `docker exec … env | grep AGENT_` dentro del contenedor; 30
min de vigilancia (`cola_ritmo_al_tope` baja, `ia_ritmo_al_tope` nunca, cero
429, `redis-cli zcard liminal:agent:turns` → 0 entre ráfagas); escalón 2
(30/120/12/8) + 30 min; criterio de cierre con 2 h de tráfico y los tramos
de T0: p50 ≤ 7 s, p90 ≤ 10 s en "pregunta terminada + 1 paso", `colaMs` < 1 s
de mediana, cero 429, gasto < $3/día (línea base $0,47 por 432 turnos).
Vuelta atrás: bajar `AGENT_MAX_TURNS_PER_MINUTE` en Dokploy y redesplegar.
Cierre: reporte de entrega por commit (cinco puntos) y actualización de la
memoria de producción.

## Fuera de alcance (declarado)

- El debounce de 6 s/2 s (decisión 1; bajarlo devuelve la respuesta por
  frase).
- Tocar el prompt del redactor para bajar a un paso (T4 = solo medición).
- Repartir el ritmo de `rate-limit.ts` entre varias instancias (sigue siendo
  por proceso; producción corre una).
- Índice de "Pendientes" y demás deuda de corridas anteriores.

---

## Brief del operador

El texto completo que el operador le dio al Claude orquestador para arrancar
esta corrida, tal cual, sin resumir:

> # Orquestador · "La respuesta llega en siete segundos" · SBK CRM
>
> Eres el **orquestador** de esta entrega. Trabajas con la metodología `/liminalwork`:
> tú planificas, delegas y validas; **no implementas**. Cada tarea la ejecuta un subagente
> `general-purpose` con `model: "sonnet"` y razonamiento alto, uno por tarea, con contexto
> limpio, y te entrega un reporte que tú validas antes de cerrarla.
>
> Repositorio: el checkout de producción está en
> `/etc/dokploy/compose/sbk-crm-y-bot-frontend-zonhta/code` (producción = `origin/main` =
> `e2f9e24`, desplegado el 7/9/2026 17:34 UTC; **61 de 61 migraciones aplicadas**,
> verificado el mismo día contra `supabase_migrations.schema_migrations`). Trabaja en una
> rama nueva `respuesta-en-siete-segundos` desde `origin/main`. Lee `CLAUDE.md`,
> `AGENTS.md` y `docs/GLOSARIO.md` antes de planificar. Respeta sus reglas: todo en
> español, comentarios que cuentan el porqué con fecha, commits narrativos, entrada de
> glosario por cada archivo tocado, tests junto al código, `rtk` delante de los comandos
> (`rtk npm run test`, `rtk npx vitest run <ruta>`, `rtk npm run lint`,
> `rtk npx tsc --noEmit`, `rtk proxy npm run build` — nunca `rtk next build`).
>
> **Esta entrega NO lleva migración**: no toca el esquema. Si tu plan termina necesitando
> una, va en commit propio con `[migración]` en el título, separada del código que la usa.
>
> Guarda el plan aprobado en
> `docs/planes/<fecha de aprobación>-la-respuesta-llega-en-siete-segundos.md` con el mismo
> formato que `docs/planes/2026-09-07-ventana-24h-dice-la-verdad.md`.
>
> ---
>
> ## 1. El encargo, en una línea
>
> El dueño reporta que **los clientes esperan hasta hora y media** por una respuesta de la
> IA. Lo que pide: que se mande un mensaje, pasen seis o siete segundos y la respuesta ya
> esté ahí.
>
> ---
>
> ## 2. Diagnóstico ya hecho (no lo vuelvas a derivar)
>
> Medido en producción el 7/9/2026 entre las 17:34 y las 18:24 UTC: 88 turnos del log
> `turno_tiempos` del contenedor nuevo, la base y la cola de Redis. La medición del atraso
> cubre además el día entero desde las 09:00 UTC.
>
> ### 2.1 El presupuesto de tiempo, tramo por tramo
>
> | Tramo | Hoy | Fuente |
> |---|---|---|
> | Debounce (pregunta terminada) | 2,0 s | `DEBOUNCE_SHORT_SECONDS`, `queue.ts:52` |
> | Debounce (ráfaga a medias) | 6,0 s | `DEBOUNCE_SECONDS`, `queue.ts:33` |
> | **Espera en cola** | **11,2 min de mediana, p90 32 min, hasta 90 min** | 48 respuestas a mensajes llegados después del deploy |
> | **Clasificación** (escenario + intención, YA en paralelo) | **2,9 s** (máx 5,8; n=88) | `agent.ts:1040` |
> | Redacción, 1 paso (35 de 65) | 3,1 s (máx 7,4) | `agent.ts:1223` |
> | Redacción, 2 pasos (29 de 65) | 5,1 s (máx 10,2) | idem |
> | Envío a Meta | 0,7 s (máx 1,1; n=87) | `agent.ts:547` |
> | Overhead fuera de las tres fases (base, red) | 0,2 s (máx 0,4) | `turnoMs` menos las fases |
> | **Turno completo** | **7,2 s de mediana** | |
>
> Latencia real de punta a punta medida hoy, por hora UTC (respuesta de la IA menos último
> mensaje del cliente):
>
> | Hora | Mediana | p90 | Máx |
> |---|---|---|---|
> | 09:00–11:00 (drenando lo acumulado mientras estuvo apagada) | 6–10 h | | 15 h |
> | 12:00–16:00 (régimen normal, sin atraso) | 18–48 s | 1,6–2,7 min | 3,7 min |
> | 17:34–18:24 (con atraso) | 11,2 min | 32,3 min | 39,2 min |
>
> O sea: **el turno no es el problema — la cola sí.** Y ni siquiera en el mejor momento del
> día (mediana 18–48 s) se llega a la meta, porque la clasificación se lleva 2,9 s.
>
> ### 2.2 Los tres frenos, y por qué subir uno solo no sirve
>
> 1. **`AGENT_MAX_TURNS_PER_MINUTE=4`** — tope global en Redis (`queue.ts:139-142`,
>    `createTurnPace` en `redis-queue.ts:154`). Cuatro respuestas por minuto para toda la
>    tienda. La demanda real medida entre las 12:00 y las 17:00 UTC fue de **2,54
>    conversaciones por minuto de media, con picos de 6**, y 17 de 259 minutos pasaron del
>    tope. En los primeros 18 minutos tras el deploy se registraron **27
>    `cola_ritmo_al_tope`** (`queue.ts:355`).
>
> 2. **`AI_MAX_REQUESTS_PER_MINUTE=15` y `AI_MAX_CONCURRENT_REQUESTS=3`**
>    (`rate-limit.ts:56-64`) — **ninguna de las dos está definida en el `.env` de
>    producción: corren con el default**. Cuentan PETICIONES, no turnos, y un turno gasta
>    ~3,4 peticiones (escenario + intención + 1 o 2 pasos de redacción). 15 peticiones por
>    minuto **son 4,4 turnos por minuto**: el segundo freno está calibrado exactamente tan
>    bajo como el primero. Si se sube solo el de turnos, aparece `ia_ritmo_al_tope`
>    (`rate-limit.ts:119`), que **duerme dentro del turno hasta 60 s**.
>
> 3. **El cron cada 300 s con tope de 10 por pasada** (`docker-compose.dokploy.yml:94`,
>    `docker-compose.yml:144`, `MAX_PER_RUN` en `queue.ts:22`) = 2 turnos/min de red de
>    seguridad. Y es el **único despertador**: cuando el ritmo frena un turno, vuelve a la
>    cola con `RETRY_WHEN_PACED_SECONDS=20` (`queue.ts:155`) **pero nadie lo despierta a
>    los 20 s** — el worker se retira. Los únicos que drenan son el próximo webhook, que
>    procesa solo lo que él mismo encoló (`route.ts:1499-1500`, `limit =
>    conversaciones.length`, límite deliberado), y el cron.
>
> **La aritmética del atraso**: `claimDue` es FIFO por vencimiento (`CLAIM_SCRIPT`,
> `redis-queue.ts:34-39`, `ZRANGEBYSCORE … LIMIT 0 1`), así que cada mensaje nuevo entra
> detrás de todo lo viejo. Espera = cola ÷ 4 por minuto. Con 360 acumuladas —lo que deja
> una noche o una reapertura masiva— son 90 minutos. Ahí está la hora y media que reporta
> el dueño. A las 18:23 UTC la cola tenía 27 conversaciones.
>
> ### 2.3 El techo del proveedor que justificaba el 15 no existe
>
> El encabezado de `rate-limit.ts` fija el objetivo en 15 "por debajo del techo real de
> 20". Consultado el 7/9/2026 contra `https://openrouter.ai/api/v1/key` con la propia
> llave de producción: **`is_free_tier: false`, sin límite de crédito
> (`limit: null`), y el `rate_limit` de la respuesta viene marcado como deprecado**. El
> techo de 20/min era de la época de la cuenta gratuita. Igual **no lo subas de un salto**:
> puede haber topes por modelo aguas arriba que la llave no declara. Ver T5 (rampa).
>
> ### 2.4 Lo que NO es el problema — no gastes subagentes acá
>
> - **El overhead de la aplicación**: 0,2 s de mediana fuera de las tres fases. La base y
>   la red no son el cuello.
> - **La entrega a Meta**: 0 mensajes `failed` en la ventana medida; 0,7 s de mediana.
> - **El aviso de "escribiendo"**: ya existe y ya sale temprano (`fireTypingIndicator`,
>   `agent.ts:259` y `agent.ts:1222`).
> - **El caché de prompt**: ya funciona (36.908 tokens cacheados en los primeros turnos).
> - **`reasoningEffort`**: ya está apagado (`AI_AGENT_REASONING=off`), y `gpt-5.6-luna` no
>   razona. No hay nada que ganar ahí.
> - **La paralelización de las dos clasificaciones**: ya se hizo (`agent.ts:1040`, las dos
>   salen juntas). Lo que queda por ganar es el MODELO, no el orden.
>
> ---
>
> ## 3. Objetivo y criterio de cierre
>
> > **p50 ≤ 7 s y p90 ≤ 10 s** desde que Meta entrega el mensaje hasta que sale la
> > respuesta, para el camino "pregunta terminada + redacción de un paso".
>
> Lo que hay que decirle al operador antes de aprobar, porque cambia la promesa:
>
> - **En ráfaga no se puede bajar de 6 s** — el debounce largo es lo que evita contestar
>   frase por frase. Ese camino queda en ~11 s.
> - **Con herramienta (2 pasos de redacción) el piso es ~9 s** hasta que corra T4.
>
> Presupuesto de la meta: 2,0 s debounce + 0,2 s cola + 1,0 s clasificación + 3,1 s
> redacción + 0,7 s envío + 0,2 s overhead = **7,2 s**. Es justo, y por eso T4 existe.
>
> ---
>
> ## 4. Solución a implementar
>
> - **S1 · Destopar los tres frenos a la vez.** Turnos 4 → 30/min, peticiones 15 → 120/min,
>   peticiones en vuelo 3 → 12, turnos simultáneos 3 → 8, tope por pasada 10 → 30
>   (hoy constante, pasa a variable), cron 300 s → 60 s.
> - **S2 · La clasificación en un modelo pequeño.** La costura ya existe y está vacía:
>   `AI_CLASSIFIER_MODEL` (`model.ts`, `resolveClassifierModelId` / `getClassifierModel`).
>   Es cambio de `.env`, no de código — pero **no se aplica sin el comparador de calidad**.
> - **S3 · Que un turno frenado no dependa del cron** (red de seguridad, no camino normal).
> - **S4 · El log separa debounce de cola**, o no hay forma de probar que se cumplió.
> - **S5 · Rampa en producción con vuelta atrás por variable de entorno.**
>
> ---
>
> ## 5. Fase de planificación (hazla tú, antes de desplegar a nadie)
>
> 1. Entra en Plan Mode. Lee completos `src/lib/ai/queue.ts`, `src/lib/ai/redis-queue.ts`,
>    `src/lib/ai/rate-limit.ts` y `src/lib/ai/model.ts`; de `src/lib/ai/agent.ts` al menos
>    `TurnTiming` (l. 67-97), `runTurnPhases` (l. 949+), la clasificación paralela
>    (l. 1040) y la redacción (l. 1223); la cola del webhook
>    (`src/app/api/webhooks/whatsapp/route.ts:1478-1500`) y
>    `src/app/api/cron/process-queue/route.ts`.
> 2. Confirma la cobertura que ya existe y que vas a extender: `queue.test.ts` (481
>    líneas), `queue-limit.test.ts`, `queue-spacing.test.ts`, `debounce.test.ts`,
>    `redis-queue.test.ts`, `rate-limit.test.ts` (226), `model.test.ts` (196),
>    `agent.test.ts` (2.860). **Ningún módulo de esta entrega está sin resguardo**: no
>    hacen falta tests previos de protección, sí los casos nuevos de cada tarea.
> 3. Mira la trampa de `vi.mock` con `importOriginal()` que documenta `CLAUDE.md`: si le
>    agregas a `queue.ts` un export que el webhook use, hay que actualizar las fábricas
>    espejo de `route.test.ts`, `new-contact-race.test.ts` y `welcome-race.test.ts`.
> 4. Presenta el plan al operador con archivos, orden, tests y criterios de terminado, y
>    **pídele explícitamente las tres decisiones de la sección 9**. Espera aprobación.
>
> ---
>
> ## 6. Tareas para los subagentes (una por subagente, Sonnet, razonamiento alto)
>
> ### T0 · El log dice cuánto se esperó en la cola
> `esperaMs` (`agent.ts:69,86`) mezcla debounce y cola en un solo número: hoy no se puede
> afirmar por turno que se cumplió el objetivo.
> - `claimDue` devuelve también el vencimiento del miembro (el `CLAIM_SCRIPT` de
>   `redis-queue.ts:34-39` ya tiene el score a mano; devolver miembro y score).
> - `TurnTiming` gana `debounceMs` y `colaMs`; `turno_tiempos` los publica y siguen sumando
>   `esperaMs`.
> - Tests: `redis-queue.test.ts` (el claim devuelve miembro y vencimiento, y sigue siendo
>   atómico), `agent.test.ts` (`turno_tiempos` trae los dos tramos y su suma es `esperaMs`).
> - Reporte: una línea de log real con los dos tramos separados.
>
> ### T1 · Destopar los tres frenos (S1)
> - `MAX_PER_RUN` (`queue.ts:22`) pasa a leerse de `AGENT_QUEUE_MAX_PER_RUN` con default
>   **30**, mismo patrón que `maxTurnsPerMinute()` (`queue.ts:139-142`): número finito y
>   positivo o default, nunca un valor a medias.
> - `docker-compose.dokploy.yml:94` y `docker-compose.yml:144`: `sleep 300` → `sleep 60`.
> - `.env.example` y `docs/PRODUCCION.md`: documentar las cinco variables con el valor
>   nuevo y **por qué** (que el próximo que las lea no repita el 15 de la cuenta gratuita).
> - Valores objetivo, todos por entorno y reversibles sin recompilar:
>   `AGENT_MAX_TURNS_PER_MINUTE=30`, `AI_MAX_REQUESTS_PER_MINUTE=120`,
>   `AI_MAX_CONCURRENT_REQUESTS=12`, `AGENT_MAX_CONCURRENT_TURNS=8`,
>   `AGENT_QUEUE_MAX_PER_RUN=30`.
> - Tests: `queue-limit.test.ts` (el tope por pasada sale del entorno, cae al default con
>   basura y con cero), `rate-limit.test.ts` (los dos topes salen del entorno),
>   `queue.test.ts` (con ritmo destopado una pasada no deja `deferred`).
> - Reporte: el diff de los dos compose y la tabla de defaults antes/después.
>
> ### T2 · La clasificación en un modelo pequeño (S2)
> **No cambies el `.env` sin el comparador en verde.** Orden obligatorio:
> 1. Un script en `scripts/` (no va a producción) que reproduce ~200 historiales reales
>    contra el clasificador grande y el chico y reporta acuerdo por enum, por separado para
>    intención (`classifyIntent`) y escenario (`matchPlaybook`).
> 2. Se aplica solo si el acuerdo es **≥ 95 % en intención y no pierde ningún escenario**
>    que el grande sí reconocía. Si no llega, se reporta y NO se cambia: el plan sigue
>    valiendo sin T2, con la meta en ~9 s.
> - **Trampa a fijar con un test**: `resolveProvider` (`model.ts`) manda a Google solo si el
>   id empieza con `gemini`. Un `google/gemini-3.1-flash-lite` —que es como lo nombra
>   OpenRouter— resuelve a proveedor `openai` y sale por `OPENAI_BASE_URL`, que es lo que
>   queremos; hoy ningún test lo afirma. Añadir el caso a `model.test.ts`.
> - Reporte: tabla de acuerdo, y `clasificacionMs` antes/después.
>
> ### T3 · Que un turno frenado no dependa del cron (S3)
> `processQueuedTurns` que termina con `deferred > 0` se reprograma solo a los
> `RETRY_WHEN_PACED_SECONDS`, en vez de esperar al cron.
> - Tests (`queue.test.ts`): una pasada con diferidos programa **exactamente una**
>   continuación; sin diferidos no programa ninguna; la continuación no se solapa con otra
>   en curso.
> - Reporte: cuánto tarda en drenar una cola sembrada de 100 conversaciones sin cron.
>
> ### T4 · Los dos pasos de redacción — MEDIR primero, decidir después
> 29 de 65 turnos gastan un viaje extra al modelo (+2,0 s de mediana). Con `buscar_repuesto`
> apagada quedan biblioteca, historial y escalar.
> - **Entregable de esta tarea: solo la medición.** Qué herramienta dispara el segundo paso
>   y en qué proporción, sobre los turnos reales del día. Nada de tocar el prompt del
>   redactor sin ese dato y sin una segunda aprobación del operador: es el único cambio de
>   la entrega que puede degradar la calidad de lo que lee el cliente.
>
> ### T5 · Rampa y verificación en producción (la corres tú, no un subagente)
> Ver sección 8.
>
> ---
>
> ## 7. Validación del orquestador (obligatoria antes de cerrar cada tarea)
>
> - Leer el reporte completo. Sin reporte, la tarea no existe.
> - Correr tú mismo `rtk npm run test`, `rtk npm run lint` y `rtk npx tsc --noEmit`.
> - **Pruebas de mutación** (verificación reforzada):
>   - T0: hacer que `claimDue` devuelva el score como `0` → el test de `turno_tiempos` que
>     afirma `debounceMs + colaMs === esperaMs` debe ponerse rojo.
>   - T1: devolver `MAX_PER_RUN` a la constante 10 ignorando el entorno → el caso "el tope
>     por pasada sale del entorno" debe ponerse rojo. Poner basura en la variable
>     (`"muchos"`) → debe caer al default, no a `NaN`.
>   - T2: cambiar el prefijo de `resolveProvider` a `google/` → el caso nuevo debe ponerse
>     rojo.
>   - T3: quitar la reprogramación → el caso "una pasada con diferidos programa una
>     continuación" debe ponerse rojo.
>   Si un test no se rompe, no cubre lo que dice cubrir: devolver la tarea.
> - Confirmar que cada archivo tocado tiene su línea de `docs/GLOSARIO.md` actualizada en el
>   mismo commit.
>
> ---
>
> ## 8. Salida a producción (solo con confirmación del operador, paso por paso)
>
> **El push a `main` dispara el deploy solo** (Dokploy clona al pushear; el reflog dice
> `clone`). Las variables de entorno viven en la pestaña **Environment de Dokploy**, que
> está **cifrada**: el `.env` del checkout se regenera en cada deploy, así que editarlo por
> SSH solo dura hasta el próximo. Los valores hay que cargarlos en Dokploy ANTES del push, o
> el código nuevo arranca con los topes viejos.
>
> 1. Respaldo: `docker exec supabase-db pg_dump …` a
>    `/root/respaldos/sbk-<fecha>-pre-siete-segundos.sql.gz`.
> 2. Cargar en el Environment de Dokploy las cinco variables de T1, **pero con el primer
>    escalón de la rampa**: `AGENT_MAX_TURNS_PER_MINUTE=10`,
>    `AI_MAX_REQUESTS_PER_MINUTE=40`, `AI_MAX_CONCURRENT_REQUESTS=6`,
>    `AGENT_MAX_CONCURRENT_TURNS=4`, `AGENT_QUEUE_MAX_PER_RUN=30`. Sin desplegar aún.
> 3. Merge a `main` y push → el webhook despliega. Seguir el estado en
>    `GET /api/deployment.allByCompose?composeId=5z7CkrotCBgO9rTAOsZYH` hasta `done`; si no
>    arranca solo, `compose.deploy` (**nunca** `compose.redeploy`, que es Rebuild y no trae
>    el commit nuevo). Verificar los 12 labels de Traefik y `/api/health`.
> 4. Verificar dentro del contenedor que las variables llegaron
>    (`docker exec … env | grep AGENT_`): el Environment cifrado no se puede leer desde el
>    VPS, solo se comprueba del lado de adentro.
> 5. **Primer escalón, 30 minutos mirando**: `cola_ritmo_al_tope` debe bajar mucho pero
>    puede seguir apareciendo; `ia_ritmo_al_tope` **no debe aparecer nunca** (si aparece, el
>    tope de peticiones quedó corto para el de turnos); cero 429 del proveedor; la cola de
>    Redis (`redis-cli zcard liminal:agent:turns`) tiene que tender a 0 entre ráfagas.
> 6. **Segundo escalón** si el primero está limpio: subir a los valores plenos de T1
>    (30/120/12/8). Otros 30 minutos de la misma vigilancia.
> 7. **Criterio de cierre**, con dos horas de tráfico real y los tramos nuevos de T0:
>    p50 ≤ 7 s y p90 ≤ 10 s en el camino "pregunta terminada + 1 paso"; `colaMs` por debajo
>    de 1 s de mediana; cero 429; gasto diario por debajo de $3 (línea base: **$0,47 por
>    432 turnos** el 7/9/2026, con el tope duro de $10/día intacto en `agent_settings`).
> 8. Vuelta atrás: bajar `AGENT_MAX_TURNS_PER_MINUTE` en Dokploy y redesplegar. No hace
>    falta tocar código ni base.
>
> ---
>
> ## 9. Decisiones que tiene que dar el operador (pídelas antes de aprobar el plan)
>
> 1. **El objetivo**: ¿se acepta p50 ≤ 7 s en el camino normal y ~11 s en ráfaga, o hay que
>    atacar también el debounce de 6 s? (Bajarlo devuelve el problema que vino a resolver:
>    una respuesta por frase.)
> 2. **T4**: ¿entra ahora o queda como segunda ola? Recomendación: segunda ola — con T1+T2
>    ya se llega a ~7 s en el camino de un paso, y tocar el prompt del redactor es el único
>    cambio que arriesga la calidad de lo que lee el cliente.
> 3. **Las variables de entorno**: ¿las carga el operador en Dokploy o se cargan por la API
>    de Dokploy?
>
> ---
>
> ## 10. Contexto que conviene tener a mano
>
> - `buscar_repuesto` está **apagada** desde el 25/8/2026 (`agent_tools.is_enabled = false`).
>   Por eso 8 de cada 29 respuestas son "no puedo confirmar existencia ni precio". No es
>   parte de esta entrega, pero explica por qué la redacción es corta y por qué el tool loop
>   usa biblioteca/historial/escalar y no catálogo.
> - La entrega anterior ("La IA ve lo que llega", `e2f9e24`) está desplegada y sana: 0
>   turnos en error, 0 entregas fallidas, 0 conversaciones atascadas en `classifying`, el
>   reconciliador sin bucle.
> - **El horario de atención NO apaga el turno.** `agent_can_run()` mira solo dos cosas:
>   `agent_settings.ai_globally_enabled` y el tope de gasto diario (`agent_spend_today()`,
>   que cuenta por día de `America/Caracas`). `business_hours` alimenta el prompt y el reloj
>   de "Atascado", nada más. El atraso de la mañana del 7/9 no fue el horario: **la IA
>   estaba apagada por el interruptor global y se encendió esa mañana** (no hay ni un
>   `agent_turns` anterior al 7/9; `agent_settings.updated_at` = 7/9 09:54 UTC). Lo que
>   importa para esta entrega es la consecuencia, no la causa: **cada vez que la IA vuelve
>   de estar apagada hereda una cola grande**, y con el tope en 4/min esa cola tarda horas
>   en drenar mientras los clientes nuevos esperan detrás. Con S1 drena en minutos.
> - Gasto del 7/9/2026: **$0,55 por 492 turnos**, contra un tope de $10/día. El destope no
>   crea demanda; el tope duro sigue siendo la red.

---

## Resultado de la corrida

Ejecutada el 7/9/2026, cuatro commits sobre `e2f9e24` (rama
`respuesta-en-siete-segundos`), en este orden:

- `eaa0bca` — **Los tres frenos de la IA se sueltan a la vez y el cron mira
  cada minuto** (T1). `queue.ts`: `MAX_PER_RUN` pasa a `maxPerRun()` leyendo
  `AGENT_QUEUE_MAX_PER_RUN` (default 30; basura o cero caen al default,
  nunca `NaN`); defaults de turnos simultáneos 3→8 y de turnos por minuto
  4→30. `rate-limit.ts`: defaults 3→12 peticiones en vuelo y 15→120 por
  minuto, con la cabecera explicando por qué los dos frenos se suben
  siempre juntos. Los dos `docker-compose*.yml`: el cron pasa de `sleep
  300` a `sleep 60`. Plantillas `.env` y `docs/PRODUCCION.md`: las cinco
  variables documentadas con su porqué y la sección "Rampa de los topes"
  con los dos escalones. Comentarios de `backlog/route.ts` y
  `cron/process-queue/route.ts` dejan de decir "diez cada cinco minutos".
  Tests: el tope por pasada sale del entorno (explícito, basura y cero),
  los dos topes de `rate-limit` salen del entorno con defaults 12/120, y
  con el ritmo destopado una pasada no deja `deferred`. Archivos:
  `.env.local.example` (+56/-…), `.env.production.example` (+61/-…),
  `docker-compose.dokploy.yml` (+13), `docker-compose.yml` (+13),
  `docs/GLOSARIO.md` (+15/-…), `docs/PRODUCCION.md` (+66/-…),
  `src/app/api/agent/backlog/route.ts` (+23/-…),
  `src/app/api/cron/process-queue/route.ts` (+6/-…),
  `src/lib/ai/queue-limit.test.ts` (+68/-…), `src/lib/ai/queue.ts`
  (+70/-…), `src/lib/ai/rate-limit.test.ts` (+109), `src/lib/ai/rate-limit.ts`
  (+31/-…) — 12 archivos, 446 inserciones, 85 borrados.
- `7108eff` — **Un comparador decide si la clasificación puede mudarse a un
  modelo chico** (T2). `model.test.ts` fija la trampa: un id con prefijo de
  fabricante (`google/gemini-...`) NO empieza con `gemini`, sale por el
  proveedor `openai` y `OPENAI_BASE_URL`. `scripts/exportar-historiales-clasificador.sql`
  exporta hasta 200 conversaciones reales por SSH a un JSON gitignoreado.
  `scripts/comparar-clasificador.test.ts`: archivo de vitest guardado por
  `COMPARAR_CLASIFICADOR`, dos pasadas (grande, luego chico) con pool de 5,
  matriz de confusión, escenarios perdidos, tiempos, tokens y errores del
  proveedor. Fixture sintético de 5 conversaciones para probar la plomería.
  Archivos: `.gitignore` (+7), `docs/GLOSARIO.md` (+5/-…),
  `scripts/comparar-clasificador.fixture-sintetico.json` (+141),
  `scripts/comparar-clasificador.test.ts` (+625),
  `scripts/exportar-historiales-clasificador.sql` (+110),
  `src/lib/ai/model.test.ts` (+33) — 6 archivos, 920 inserciones, 1 borrado.
- `51d50f1` — **El registro de tiempos separa la ventana de silencio de la
  espera en cola y nombra las herramientas** (T0). `redis-queue.ts`:
  `CLAIM_SCRIPT` devuelve `[conversationId, vencimiento]`; el primer
  reclamo siembra `liminal:agent:vencimiento:{id}` (TTL 1 h) con el score;
  un reclamo posterior la lee y la borra; nueva `defer(id, seconds)` para
  los reintentos del sistema, que conservan el vencimiento más viejo;
  `enqueue` la borra (mensaje nuevo = ventana nueva); `purge` la barre con
  SCAN. `queue.ts`: `atender()` pasa `vencioEn` a `runAgentTurn` y difiere
  con `defer`. `agent.ts`: `TurnTiming` gana `debounceMs` (vencimiento −
  último mensaje del cliente), `colaMs` (arranque − vencimiento) y
  `herramientas` (los `toolName` de `result.steps` unidos por coma); un
  solo `Date.now()` en `newTurnTiming` garantiza `debounceMs + colaMs ===
  esperaMs`; sin `vencioEn` (`simulate-message`) los dos tramos quedan
  `null` y `esperaMs` sigue midiendo. `fake-redis.ts` espeja el script
  nuevo, `zscore`, `get` y `scan`. Archivos: `docs/GLOSARIO.md` (+8/-…),
  `src/lib/ai/agent.test.ts` (+94), `src/lib/ai/agent.ts` (+94/-…),
  `src/lib/ai/fake-redis.ts` (+54/-…), `src/lib/ai/queue-limit.test.ts`
  (+73/-…), `src/lib/ai/queue.ts` (+27/-…), `src/lib/ai/reconciler.test.ts`
  (+14/-…), `src/lib/ai/redis-queue.test.ts` (+127/-…),
  `src/lib/ai/redis-queue.ts` (+108/-…) — 9 archivos, 565 inserciones, 34
  borrados.
- `662f9a8` — **La cola se despierta sola cuando un turno quedó frenado**
  (T3). `processQueuedTurns` pasa a ser la puerta pública de
  `ejecutarPasada`, que además devuelve los plazos de los turnos diferidos
  con plazo (el de error queda afuera). `registrarDiferidos` programa un
  solo `setTimeout` por proceso con el MENOR plazo más el margen,
  `.unref()`, y la continuación reintenta con `maxPerRun()`, nunca con el
  `limit` de quien la disparó. Estado de módulo con tres valores
  (inactiva/programada/corriendo). `stopAgentQueue` cancela la
  continuación pendiente. Hallazgo documentado: una pasada que agota su
  tope (30) sin que nada se rechace no deja ningún turno frenado y no
  programa continuación; ese resto lo drena el cron cada minuto, al mismo
  ritmo (30/min) que `AGENT_MAX_TURNS_PER_MINUTE` — decisión: no se cambió
  el diseño, queda anotado como deuda. Archivos: `docs/GLOSARIO.md`
  (+3/-…), `docs/PRODUCCION.md` (+15/-…),
  `src/lib/ai/queue-continuation.test.ts` (+363, nuevo), `src/lib/ai/queue.ts`
  (+150/-…) — 4 archivos, 525 inserciones, 6 borrados.

### El comparador de T2, resultado completo

Export real: 200 conversaciones con turno de IA en 7 días (últimos 20
mensajes c/u), 14 escenarios activos, horario real. Grande = `gpt-5.6-luna`
vía OpenRouter (`AI_AGENT_REASONING=off`), el de producción. Criterio del
plan: ≥ 95 % de acuerdo en intención y cero escenarios perdidos.

| Candidato (`AI_CLASSIFIER_MODEL`) | Acuerdo intención | Escenarios perdidos / ganados / distintos | Clasif. p50 (intención / escenario) | Errores del proveedor | Veredicto |
|---|---|---|---|---|---|
| `gpt-5.6-luna` contra sí mismo (línea base de ruido) | **92,5 %** (185/200) | 8 / 10 / 14 | 2,40 s / 2,75 s | 0 | — (la referencia no es determinista) |
| `google/gemini-3.1-flash-lite` (el del brief) | 81,5 % (163/200) | 10 / 18 / 26 | **1,11 s / 1,10 s** | 0 | NO APLICAR |
| `openai/gpt-5.4-nano` | 68,0 % (136/200) | 10 / 49 / 27 | 1,03 s / 1,05 s | 0 | NO APLICAR |
| `google/gemini-3.7-flash` | 78,4 % (40/51 comparables) | 70 / 1 / 1 | 0,76 s / 0,78 s | 298 ("Provider returned error", 149 de 200 conversaciones) | NO APLICAR (inestable en OpenRouter) |
| `google/gemini-3.5-flash-lite` | 70,6 % (36/51 comparables) | 67 / 3 / 7 | 0,70 s / 0,71 s | 298 (ídem) | NO APLICAR (inestable en OpenRouter) |
| `google/gemini-3.1-flash` | — | — | — | 400 ("is not a valid model ID") | no existe en OpenRouter |

Lecturas: el criterio de ≥ 95 % es inalcanzable incluso para el mismo
modelo: la referencia (el grande) solo coincide consigo mismo en el 92,5 %
y "pierde" 8 escenarios contra sí misma. El desacuerdo dominante en TODOS
los casos es `consulta_disponibilidad` ↔ `otro` (34 de 37 desacuerdos con
flash-lite; 14 de 15 del grande consigo mismo), dos intenciones que hoy
reciben las mismas herramientas en el tool loop; en escenarios, el ruido es
`Gracias` ↔ `REDES`. Flash-lite es el único candidato serio: baja la
clasificación de ~2,5 s a ~1,1 s (−1,4 s por turno) sin errores del
proveedor, pero queda 11 puntos por debajo del ruido de la referencia y
pierde 10 escenarios (la referencia pierde 8 contra sí misma). Luna ya es
de la banda más barata de OpenRouter (0,20 $/M entrada, 1,20 $/M salida);
flash-lite cuesta más (0,25 / 1,50): mudar la clasificación es una decisión
de latencia, no de costo. **Decisión según el plan: NO se cambia el
`.env`; la meta del camino normal queda en ~9 s hasta una segunda ola.**
Segunda ola posible: fusionar `consulta_disponibilidad`/`otro` en el
clasificador (reciben las mismas herramientas) y volver a medir flash-lite
contra un criterio relativo a la línea base (p. ej. ≥ 90 % cuando el grande
consigo mismo da 92,5 %).

### Mutaciones del orquestador

- T1: `MAX_PER_RUN` de vuelta a la constante 10 → el caso "el tope por
  pasada sale del entorno" se puso rojo (3 casos afectados); `"muchos"` en
  la variable → sin la guarda cae a `NaN` en vez de 30, el caso quedó rojo.
- T0: `claimDue` devolviendo `vencioEn: 0` desde `queue.ts` → "el turno
  recibe el vencimiento con que se reclamó" rojo; calcular `colaMs` desde
  otro `Date.now()` en `agent.ts` → la suma `debounceMs + colaMs ===
  esperaMs` rojo. Las dos mutaciones se comportaron como predecía el plan.
- T3: quitar el `setTimeout` de `registrarDiferidos` → "una pasada con
  diferidos programa exactamente una continuación" rojo.
- T2: cambiar el prefijo de `resolveProvider` a `google/` → el caso nuevo
  de `model.test.ts` rojo.

Las cuatro mutaciones se revirtieron después de confirmar el rojo. Un
incidente durante la verificación: revertir una mutación con `git checkout
--` pisó cambios sin commitear de T1 en `queue.ts` (dos tareas editaban el
mismo archivo en tandas distintas); se recuperaron de una copia hecha antes
de mutar (`cp`) — de ahí la convención nueva en `CLAUDE.md`.

### Suite final y validación

`rtk npm run test`: **121 archivos, 1748 tests en verde** (+1 `skip` —el
comparador de T2 sin `COMPARAR_CLASIFICADOR`— y +1 `todo` preexistente, sin
cambios respecto a la corrida anterior salvo el crecimiento de la suite).
`rtk npm run lint` y `rtk npx tsc --noEmit`: limpios. Un Redis local se
levantó (`docker run … sbk_redis`) para T0 y T3, porque
`queue.test.ts`/`redis-queue.test.ts` se saltan enteros sin Redis (ver
trampa nueva en `CLAUDE.md`). El "catálogo fuera de servicio" observado en
validaciones locales previas es el interruptor `buscar_repuesto`, que nace
apagado en el seed — no una regresión de esta corrida.

### Línea base de producción (última hora antes de la corrida, 18:00-19:00 UTC, 95 turnos)

`esperaMs`: p50 13,2 min / p90 92,8 min / máx 2,9 h. Clasificación p50
2,8 s; redacción 4,0 s; envío 0,7 s; turno completo (sin la espera en
cola) 6,8 s de mediana. 123 `cola_ritmo_al_tope` en la hora; 0
`ia_ritmo_al_tope`; 17 conversaciones en cola a las 18:42 UTC.

### Deuda declarada

- T3: una pasada que agota su tope por completo (30) sin dejar ningún
  turno diferido no programa continuación propia; ese resto lo drena el
  cron cada minuto, al mismo ritmo (30/min) que
  `AGENT_MAX_TURNS_PER_MINUTE`. Se dejó así a propósito (declarado en el
  commit, no un olvido).
- T2: la clasificación sigue en el modelo grande (~2,5-2,9 s); ningún
  candidato midió por encima del criterio relativo a la línea base de
  ruido (92,5 %). La meta del camino normal queda en ~9 s hasta que una
  segunda ola fusione `consulta_disponibilidad`/`otro` o aparezca un
  candidato mejor en OpenRouter.
- T4 no se implementó (decisión del operador: segunda ola). El prompt del
  redactor no se tocó.
- Repartir el ritmo de `rate-limit.ts` entre varias instancias sigue fuera
  de alcance (producción corre una sola).
- El índice de "Pendientes" y demás deuda de corridas anteriores no
  cambia.

### Pendiente al cierre de este documento

- **T5 · Rampa en producción** (orquestador + operador, paso a paso): no
  ejecutada. Falta el respaldo `pg_dump`, cargar el escalón 1 en Dokploy
  (`AGENT_MAX_TURNS_PER_MINUTE=10`, `AI_MAX_REQUESTS_PER_MINUTE=40`,
  `AI_MAX_CONCURRENT_REQUESTS=6`, `AGENT_MAX_CONCURRENT_TURNS=4`,
  `AGENT_QUEUE_MAX_PER_RUN=30`), el push a `main`, la verificación dentro
  del contenedor, 30 minutos de vigilancia por escalón, el escalón 2
  (30/120/12/8) y el criterio de cierre (p50 ≤ 7 s, p90 ≤ 10 s, `colaMs` <
  1 s de mediana, cero 429, gasto < $3/día). No se inventa ningún resultado
  de esa rampa aquí: queda para cuando el operador confirme paso a paso.
- **T4 · Los dos pasos de redacción**: medición posterior, sobre 2 h de
  tráfico real DESPUÉS de que T5 esté en producción, usando la línea
  `herramientas` que T0 ya deja en `turno_tiempos`. Sin datos todavía.

Esta documentación (T6) se escribió con contexto limpio a partir de los
cuatro commits de arriba y este plan — no participó en T0, T1, T2 ni T3,
así que lo anterior es una lectura del resultado, no un reporte de primera
mano de esas tareas.
