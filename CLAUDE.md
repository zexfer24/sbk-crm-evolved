# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# SBK Motors CRM

CRM multiagente de ventas por WhatsApp para una tienda de motos y repuestos en
Venezuela (equipo en Barinas, zona horaria `America/Caracas`, tasa BCV como
referencia cambiaria). Bandeja compartida en tiempo real + un agente de IA
vendedor que responde solo, cotiza contra el inventario real y escala a los
asesores humanos. Conectado de verdad a la WhatsApp Cloud API de Meta.

**Mapa del código:** `docs/GLOSARIO.md` — módulo por módulo, qué hace cada
archivo. Consultarlo antes de buscar a ciegas; actualizar su línea en el mismo
commit que toque un archivo.

**Puesta en producción:** `docs/PRODUCCION.md` — la guía completa, con la
verificación de cada paso. El despliegue real corre en un VPS administrado por
otro Claude; los commits se le entregan con un reporte (ver Convenciones).

## Comandos

```bash
npm run dev                        # Next dev (Supabase local: npx supabase start / db reset)
rtk npm run test                   # Suite completa (vitest run)
rtk npx vitest run <ruta>          # Un solo archivo de test
rtk npm run lint                   # ESLint
rtk npx tsc --noEmit               # Tipos
rtk proxy npm run build            # Build — ¡NUNCA `rtk next build`! (ver Trampas)
curl -s "https://api.github.com/repos/zexfer24/sbk-crm-evolved/actions/runs?per_page=3"  # CI de los últimos push (sin gh)
```

CI (`.github/workflows/ci.yml`): tipos + lint + tests + build, y en paralelo
reconstruye la base desde cero con las migraciones y seeds del repo.

## Arquitectura

**Camino de un mensaje entrante** (el flujo que explica la mitad del código):

1. `api/webhooks/whatsapp` verifica la firma HMAC de Meta, escribe
   mensaje/contacto/conversación con el cliente admin (service role, sin
   sesión) y **encola** el turno de IA. Nunca procesa en línea.
2. La cola (`lib/ai/queue.ts` + `redis-queue.ts`, Redis con scripts Lua)
   espera silencio antes de atender: 6 s si el mensaje parece ráfaga a medias,
   2 s si cierra la idea. Cinco variables de ritmo que se suben siempre
   juntas gobiernan cuánto drena (7/9/2026, "La respuesta llega en siete
   segundos": `AGENT_MAX_CONCURRENT_TURNS=8`, `AGENT_MAX_TURNS_PER_MINUTE=30`,
   `AGENT_QUEUE_MAX_PER_RUN=30`, `AI_MAX_CONCURRENT_REQUESTS=12` y
   `AI_MAX_REQUESTS_PER_MINUTE=120` en `rate-limit.ts` — un turno gasta
   ≈3,4 peticiones, así que subir solo el freno de turnos deja al de
   peticiones durmiendo el turno hasta 60 s). `api/cron/process-queue`
   (cada minuto desde el 7/9/2026, antes cada 5 min, `CRON_SECRET`) sigue
   siendo la red de seguridad para turnos huérfanos, pero un turno frenado
   por ritmo/cupo/lock ya no espera al cron: se reprograma solo con su
   propia continuación (`registrarDiferidos`, un `setTimeout` con el menor
   plazo y `.unref()`). `claimDue` devuelve también el vencimiento
   original del turno, con el que `turno_tiempos` separa `debounceMs` (la
   ventana de silencio, diseño) de `colaMs` (lo que esperó frenado,
   atraso).
3. El turno (`lib/ai/agent.ts`) corre en paralelo la fase 0 (¿calza un
   escenario/playbook del supervisor? → se envía tal cual) y la fase 1
   (clasificar intención → define qué herramientas recibe el modelo), y solo
   entonces el tool loop (máx. 5 pasos: catálogo, biblioteca, historial,
   escalar). `loadHistory` describe cada foto/audio/video/documento/sticker
   sin texto legible con un marcador entre corchetes que arma `historyLine`
   (`history-line.ts`, 8/9/2026: `[El cliente envió una foto sin texto; no
   puedes verla]`, etc.) en vez de descartar la fila; si el último mensaje
   del cliente es uno de esos marcadores, la fase 0 no corre (nada con qué
   reconocer un escenario). Desde B3 ("El reloj dice la verdad", 5/9/2026) el turno lee
   `agent_settings.business_hours` al arrancar (default L–V 08:00–18:00 si
   falla; nunca se cae por el horario) y el bloque `TURNO ACTUAL` del prompt
   trae la franja del día, el saludo, el horario de atención y si la tienda
   está abierta YA CALCULADOS por `business-hours.ts` (`turnClockLine`): el
   modelo los copia, no los deduce. La regla vieja "Saber la hora no es saber
   el horario" quedó sin efecto: el horario ahora sí existe en el sistema.
   Fuera de horario la IA sigue vendiendo; cobros y cierre los hace un
   asesor, y al escalar por compra con la tienda cerrada nombra cuándo se
   procesa la venta. Antes de mandar la redacción final, el texto pasa por
   la guarda de identidad (`identity-guard.ts`): detecta si se describe como
   automatizada o como una persona, intenta reescribirlo una vez y, si sigue
   calzando, escala y manda en su lugar la despedida fija.
4. El envío sale por `lib/whatsapp/meta-client.ts` (server-only). Canal no
   `connected` = envío simulado (demo sin gastar).

**Frenos del agente**, todos independientes: lock por conversación con lease
que se renueva solo, cupos globales en Redis, rate limit de peticiones hacia
el proveedor (`rate-limit.ts`), tope de gasto diario, interruptor global,
interruptor por herramienta, la guarda de identidad (`identity-guard.ts` +
`applyIdentityGuard` en `agent.ts`): ningún texto que describa a la IA como
automatizada o como una persona le llega al cliente, y la regla "si un
humano escribió DESPUÉS del último mensaje del cliente, o hace menos de
`AI_HUMAN_GRACE_MINUTES` (default 30), la IA no entra" (`human-handled.ts`,
`humanClaimsChat`; 8/9/2026 — antes era vitalicia, "¿alguna vez escribió un
asesor?", y dejaba muda a la IA en el 100 % del backlog: el caso
`3b654d2c…` quedó mudo por un "a" que un supervisor escribió el 28/8/2026 y
siguió mudo incluso después de reactivar la IA; con la regla nueva 47 de 48
conversaciones mudas del backlog medido el 8/9/2026 se liberan).
`turn-target.ts` congela a quién se le habla; `turn-delivery.ts` impide el
doble envío en reintentos.

**Frontend:** App Router con una página por sección; `components/crm-shell.tsx`
es el cliente raíz de la bandeja (estado, suscripciones realtime de Supabase,
outbox de envíos). Lecturas en `lib/data.ts` y `lib/*-data.ts`; escrituras en
`lib/mutations.ts`. La lógica con reglas de negocio vive separada de React en
módulos puros (`inbox-filters`, `outbox`, `sale-cart`, `customers`,
`inventory`…) precisamente para poder probarla sin levantar nada.

**Base:** Supabase self-hosted (Postgres + Auth + Realtime + Storage). RLS
activo pero compartido —cualquier agente autenticado lee/escribe todo; no es
multi-tenant— salvo las acciones sensibles, que exigen rol
supervisor/admin **en RLS**, no solo en la interfaz. El bucket
`whatsapp-media` es privado: el multimedia se sirve por `api/media/[...path]`
con sesión. Inventario y catálogo de la IA son la MISMA tabla `products`, sin
copia intermedia.

## Convenciones

- **Todo en español**: commits, comentarios, logs (`lib/log.ts`, eventos como
  `cola_turno_fallido`), UI. Los comentarios explican el porqué y la historia
  (fallas reales con fecha), no el qué.
- **Commits narrativos**: una frase que dice el efecto observable ("El panel
  marca los escenarios que llevan un precio escrito a mano"), no `feat: ...`.
- **`[migración]` en el título** de todo commit que agregue una migración, y
  la migración va en commit separado del código que la usa. Omitirlo ya tiró
  producción 6 minutos en hora pico.
- **Toda función `security definer` nueva en `public` nace con los DOS
  revokes explícitos por firma —`revoke execute ... from public` y
  `revoke execute ... from anon, authenticated`— más el `grant` a quien sí
  la necesita, en la misma migración que la crea.** El privilegio llega por
  dos vías independientes (el `EXECUTE` de fábrica de Postgres a `PUBLIC`, y
  el `alter default privileges` de Supabase que se lo da además a
  `anon`/`authenticated`), y ninguno de los dos revokes alcanza solo (ver
  Trampas). Excepción permanente: `is_agent()` e `is_supervisor_or_admin()`
  no se revocan nunca, ni de `PUBLIC` — 49 políticas de RLS `TO public` las
  invocan.
- **Tests al lado del módulo** (`foo.ts` + `foo.test.ts`). Un cambio de lógica
  trae su test en el mismo commit.
- **Entrega a producción**: preguntar en qué commit está producción antes de
  calcular qué migraciones aplicar (`produccion..HEAD`, nunca el HEAD local), y
  redactar el reporte de entrega por commit para el Claude del VPS.
- **Metodología de trabajo**: todo cambio entra por la skill `liminalwork`
  (plan aprobado → subagentes → reportes → tests). Sin plan no se implementa.
- **Al revertir una mutación de verificación sobre código que un subagente
  aún no commiteó, respaldar con `cp` antes y restaurar desde esa copia —
  nunca con `git checkout -- <archivo>`.** El 7/9/2026, revertir una
  mutación así en `queue.ts` con `git checkout --` pisó cambios sin
  commitear de otra tarea que tocaba el mismo archivo; se recuperaron de
  una copia hecha antes de mutar.

## La invariante "ningún lead invisible"

La reforma que arrancó el 30/8/2026 se gobierna por una sola regla, y todo
código que decida no atender una conversación tiene que respetarla:

> Toda conversación con `awaiting_reply = true` tiene exactamente un dueño y
> una hora límite de respuesta. Ninguna salida del sistema deja una
> conversación esperando sin dueño ni fecha.

Su forma final —`owner_kind` + `response_due_at` en `conversations`— nace en
la Etapa 2. En la Etapa 1 esas columnas NO existen todavía, así que la
invariante no se puede consultar tal cual: lo que corre hoy es su proxy, que
es la tabla de bitácora `conversation_handoffs` (migración
20260830040000). Cada salida silenciosa del turno, de la cola y del webhook
deja ahí una fila con su razón, y el lead sin dueño es el que tiene como
última fila un `to_kind = 'unassigned'` y sigue con `awaiting_reply`.

La consecuencia práctica para cualquiera que toque `lib/ai/`: **un `return`
que abandona una conversación sin escribir su traspaso es un bug**, aunque
la decisión de callarse sea la correcta. Callarse está bien; callarse sin
dejar rastro es lo que hacía desaparecer leads.

## Trampas conocidas

- `rtk next build` **reporta éxito sin construir**. Compilar siempre con
  `rtk proxy npm run build` y verificar el timestamp de `.next/BUILD_ID`.
- `rtk git commit -m` se rompe con comillas simples en el mensaje: los
  mensajes largos van con `git commit -F <archivo>` (sin rtk).
- **La suite en Windows corre con `pool: forks` + `isolate: true`**: un
  proceso nuevo por archivo, hasta 7 en paralelo sobre 8 núcleos. La
  contención que eso producía se atacó el 28/8/2026 (`testTimeout` 15s como
  red de seguridad, `slowTestThreshold: 1000` delata la degradación, entorno
  `node` por defecto —solo los tests que usan DOM declaran
  `/** @vitest-environment jsdom */`—, `userEvent.setup({delay: null,
  pointerEventsCheck: 0})` en los tests de teclado, tests de rutas
  importando en `beforeAll`) y se cerró el 29/8/2026: los archivos que aún
  caían bajo carga dependían de plazos de reloj de pared que no escalan —
  el `testTimeout` de 15s NUNCA gobernó los `waitFor` de Testing Library
  (traían 1000 ms de fábrica), ese era el hueco real. Ahora
  `asyncUtilTimeout: 5000` en `vitest.setup.ts` (solo jsdom) cubre esos
  `waitFor`, los tests de rutas esperan el hecho con `vi.waitFor({timeout:
  5000})` en vez de un `setTimeout(0)`, las cargas en frío pesadas
  (`new-contact-race.test.ts`, `bcv-fetch.test.ts`) calientan su grafo en un
  `beforeAll` con 30s propios, y Babel solo transforma `.tsx`/`.jsx`. Sigue
  vigente el diagnóstico: si un archivo falla en la suite y pasa aislado
  (`rtk npx vitest run <ruta>`) es contención, no regresión; palancas
  locales de diagnóstico: `VITEST_MAX_WORKERS=4` y `--no-file-parallelism`.
  Reproducido y verificado con quemadores de CPU a prioridad AboveNormal:
  12 quemadores tumban cualquier presupuesto e impiden arrancar workers —
  esa dosis es reproductor del mecanismo, no criterio de verde.
- **Un `vi.mock` con `importOriginal()` arrastra el grafo ENTERO del módulo
  real** (mockear `@/lib/ai/queue` cargaba los dos SDK de IA e ioredis para
  leer dos constantes). En tests de rutas: mockear también `@/lib/ai/agent` y
  `@/lib/redis`, e importar el route una sola vez en `beforeAll`.
  `route.test.ts`, `new-contact-race.test.ts` y `welcome-race.test.ts` ya
  mantienen sus fábricas en espejo completo (incluido el mock de
  `@/lib/redis` en las tres); si se añade a `queue.ts` un export que el
  webhook use, actualizar las tres.
- El stack Supabase self-hosted es `supabase-squad` (se clona de
  `zexfer24/supabase-squad`, no vive en este repo). Studio/meta corren en su
  perfil `admin`: un 503 en el panel significa levantar esos contenedores, no
  tocar Envoy.
- **`has_reply` es vitalicio** (lo enciende la IA, el asesor y la bienvenida
  automática; nunca se apaga): NO sirve como corte de "sin atender" — usarlo
  así vació la píldora de la bandeja en producción el 28/8/2026. La píldora
  "No leídas" de la bandeja usa `unread_count`/`manually_unread`
  (`isUnread` en `inbox-filters.ts`), no `has_reply`. La ventana de 24h sin
  respuesta sigue existiendo, pero ya no en la bandeja: vive en
  `dashboard.ts` (`isStalePending`) y el `AgentHomePanel`. (30/8/2026: la
  bandeja recuperó una píldora "Pendientes" —y es la que abre por
  default—, pero corta por `awaiting_reply` + conversación abierta
  [`inbox-filters.ts`], no por `has_reply` ni por la ventana de 24h; esta
  trampa sigue vigente tal cual está escrita arriba.) Desde la migración
  20260905010000 (T0.1, 5/9/2026) `awaiting_reply` deja de compararse contra
  "el último mensaje" y pasa a compararse contra `last_reply_at`:
  **`awaiting_reply` se apaga SOLO con una respuesta real —no con notas,
  eventos de sistema, bienvenida ni envíos `failed`— desde 20260905010000.**
  En memoria eso es `awaitingReply()` (`dashboard.ts`) comparando
  `lastReplyAt` contra `lastCustomerMessageAt`, ya no `lastMessageAt` contra
  `lastCustomerMessageAt`. TODA despedida de la IA sin asesor —la del tool
  loop (anexo A1, 5/9/2026) o la de un escenario con `afterSend = "escalate"`
  (anexo B2, 5/9/2026, marcada DESPUÉS de saber que no hay asesor)— es
  `is_auto_reply` y por eso NO apaga `awaiting_reply`: el cliente sigue
  esperando a una persona, aunque haya recibido la cortesía. Desde la
  migración 20260905070000 (B1, 5/9/2026) marcar un mensaje como
  `is_auto_reply` DESPUÉS de insertado también recalcula `last_reply_at` y
  devuelve `awaiting_reply` a `true`.
- **"Atascado" en el tablero tiene UNA definición desde A1 ("El reloj dice la
  verdad", 5/9/2026)**: conversación abierta + `awaitingReply` + minutos desde
  `lastCustomerMessageAt` ≥ umbral de su etapa (`isStalled`/`waitingMinutes`
  en `dashboard.ts`). Si la pelota está del lado del cliente NO está
  atascada, esté donde esté (cliente callado tras la IA = "Consulta" en
  gris). El reloj NO es `lastMessageAt` (una nota interna o un evento lo
  adelantan sin que el cliente haga nada) ni `minutesInStage` (queda solo
  para la cola de reclamos). En "Con asesor" se mide en minutos de HORARIO
  LABORAL (`businessMinutesBetween`, `business-hours.ts`; umbral 60): de
  noche o domingo un asesor no está atascado. `stageOf` ya no confía en
  `journey_stage` a ciegas: `assigned` sin asesor cae a "Consulta" y un
  `classifying`/`tool_running` sin `awaitingReply` es un resto congelado
  que no se honra. La píldora "Escaladas" de la bandeja (`inbox-filters.ts`)
  sigue mirando el campo crudo `journeyStage === "assigned"`: no comparten
  predicado, a propósito, hasta la Etapa 2.
- `supabase/seed.sql` **no va a producción** (trae usuarios con contraseña
  escrita); los seeds de catálogo y playbooks sí.
- Sin `WHATSAPP_APP_SECRET` el webhook acepta cualquier POST (a propósito,
  solo para local). En producción es obligatoria — igual que `CRON_SECRET`.
- **Cerrar una función `security definer` a `anon` exige LOS DOS revokes, no
  uno.** El privilegio llega por dos vías independientes: el `EXECUTE` de
  fábrica que Postgres —no Supabase— concede a toda función nueva al
  pseudo-rol `PUBLIC`, y el `alter default privileges ... grant execute on
  functions to anon, authenticated, service_role` que Supabase deja puesto
  en `public` (visible en `pg_default_acl`), que además le da un grant
  explícito a `anon`/`authenticated`. `revoke execute ... from public` corta
  la primera vía pero no la segunda; `revoke execute ... from anon,
  authenticated` corta la segunda pero no la primera —mientras quede
  cualquiera de las dos, `has_function_privilege('anon', ...)` sigue dando
  `true`, porque `anon` hereda de `PUBLIC`—. Hacen falta las dos sentencias,
  y después un `grant` explícito a quien deba conservar el acceso (el
  revoke de `PUBLIC` también se lo saca a quien lo tenía solo por ahí). Este
  error, con solo una de las dos vías cortada, ya expuso métricas de negocio
  (`agent_metrics`), el lock de turno de la IA y la cola de turnos a
  internet, sin sesión, el 30/8/2026 — dos migraciones distintas probaron
  una vía cada una y ninguna cerró nada; se detectó recién midiendo con
  `has_function_privilege` contra la base, no leyendo el `.sql`.
- **"Código de servidor" no es sinónimo de `service_role`.** El rol de
  Postgres con el que viaja una llamada lo decide el cliente Supabase que se
  usó, no dónde corre el archivo: `@/lib/supabase/server` (`createClient()`)
  es anon key + cookie de sesión → rol `authenticated`; solo
  `@/lib/supabase/admin` (`createAdminClient()`) es `service_role`. Un route
  handler puede ser perfectamente `authenticated`:
  `src/app/api/agent/backlog/route.ts:50` lo es, y por eso `agent_can_run` no
  se pudo cerrar a `service_role`.
- **La guarda de identidad NO puede prohibir `automátic*`/`digital`/`sistema`
  sueltos** (decisión del 6/9/2026). En `products` hay 25 filas como
  `AUTOMATICO HORSE`, `AUTOMATICO BERA R1 AUTOASIA` o `TACOMETRO DIGITAL
  BERA SBR`, y los asesores escriben "el sistema lo hace automáticamente"
  (Cashea): una guarda que bloqueara esos adjetivos sueltos dejaría a la IA
  sin poder cotizar el automático de una Horse. `identity-guard.ts` ancla sus
  patrones en la AUTORREFERENCIA ("soy un…", "asistente automatizado",
  "respuesta automática", "no soy una persona") y en términos sin otro uso en
  el negocio (`bot`, `chatbot`, `inteligencia artificial`, `IA` en mayúsculas
  evaluada sobre el texto original —así `guía`/`GUIA`/`AUTOASIA` no
  calzan—, `ChatGPT`, `OpenAI`, `GPT`, `Gemini`, `modelo de lenguaje`), nunca
  en el adjetivo suelto.
- **`last_customer_message_at` (lcma) solo se mueve con un entrante que no
  sea `unsupported`; un saliente `failed` con el código 131047 de Meta la
  cierra a `created_at − 24 h`** (los dos triggers, `handle_new_message()` y
  `handle_message_status_change()`, migración 20260907010000, 7/9/2026). Caso
  real: la conversación `aa75ef33…` (+593987317372) mostraba la caja de texto
  habilitada y "quedan 11 h" mientras Meta rechazaba todo con 131047 —un
  `unsupported` de Meta guardado como entrante había reiniciado el reloj de
  la ventana, y el CRM ignoraba el aviso explícito de ventana cerrada que
  Meta ya había mandado. Un `unsupported` sigue siendo VISIBLE en el chat y
  en la lista (mueve `last_message_at`/preview) pero no abre ventana ni
  cuenta como no leído — Meta tampoco lo cuenta para su propia ventana de
  24 h; esto reemplaza lo que D3 (6/9/2026) pretendía ("cuenta como entrante
  para que caiga en Pendientes"). El candado del 131047 lleva doble guarda:
  `lcma is not null` (`least(null, x)` devuelve `x`, no `null` — sin esta
  guarda un 131047 sobre un lead sin mensajes le inventaría una fecha y
  encendería `awaiting_reply`) y `created_at > lcma` (un callback de Meta que
  llega tarde no puede retroceder un reloj que un mensaje real posterior ya
  adelantó). **No escribas `last_customer_message_at` a mano desde
  TypeScript** — los dos candados viven solo en la base. `isComposerWindowOpen`
  (`whatsapp-window.ts`) es la red de seguridad del composer para el hueco
  entre el rechazo de Meta y el refresh por realtime: espeja los mismos dos
  candados en memoria contra `messages`, no reemplaza a la base.
- **`messages.content` es SOLO lo que el cliente escribió** (8/9/2026): el
  texto que ve el modelo de una foto/audio/documento/sticker lo arma
  `historyLine` en memoria (`[El cliente envió …]`/`[El asesor envió …]`),
  nunca la base — la burbuja, `media-group`, `quoted-content` y
  `close-sale-modal` dependen de que `content` sea el pie de foto real.
  `MEDIA_RULES` (sección 7 del prompt) le dice al modelo qué hacer y su
  test la pasa por la guarda de identidad. Caso `7631718e…` ("cualquiera
  de estos en talla L" con dos fotos invisibles) y `cea69118…` (audio solo,
  30 reencolados).
- **`conversations.last_message_preview` lo escribe la base, en español,
  desde la migración 20260908020000** ("La bandeja habla español",
  8/9/2026): cuando el mensaje no trae `content`, `handle_new_message()`
  llama a `message_preview_label(message_type)` ("📷 Foto", "🎤 Audio",
  "Mensaje que WhatsApp no entrega"…). NO traducir el preview en la
  interfaz ni comparar contra "Image"/"Unsupported" en TypeScript: antes
  de esa migración el trigger escribía el `initcap` del tipo en inglés y
  la lista lo pintaba tal cual; el backfill de la migración corrigió solo
  las filas cuyo preview era EXACTAMENTE ese `initcap`. Una etiqueta
  nueva se agrega en la función SQL (migración nueva), no en la UI.
- **`errorText` (`lib/log.ts`) es el único traductor de errores a texto de
  log** (8/9/2026): no escribir `err instanceof Error ? err.message :
  String(err)` en ningún sitio — un `PostgrestError` sale `[object Object]`
  por esa vía (`turno_lock_no_liberado`, `webhook_error_actualizar_estado`,
  7/9/2026). **`AI_AGENT_REASONING=off` cuando el modelo no razona**:
  producción corre `gpt-5.6-luna` vía OpenRouter (`OPENAI_BASE_URL`), el
  SDK avisaba `reasoningEffort is not supported` 3-4 veces por turno y el
  esfuerzo no se aplicaba. Un `fetch failed` hacia Meta es `origenDelFallo:
  "red"` → traspaso `entrega_fallida`, no `rechazado_por_meta`; lo
  reencola el reconciliador.
- **`queue.test.ts` y `redis-queue.test.ts` se saltan ENTEROS sin Redis**
  (`if (!disponible) return` al inicio del archivo; puerto 6379 cerrado en
  la máquina de esta corrida, 7/9/2026). Un test nuevo ahí "pasa" sin
  ejecutar una sola aserción, y una prueba de mutación corrida sin Redis
  da verde de mentira. Levantar `docker run -d --name sbk_redis -p
  6379:6379 redis:7-alpine redis-server --appendonly yes` antes de validar
  cualquier tarea que toque `redis-queue.ts` (receta en la cabecera del
  archivo); lo que sí puede probarse sin Redis va con `FakeRedis` en
  archivos aparte (`queue-limit.test.ts`, `queue-continuation.test.ts`).
- **El "techo de 20/min" de OpenRouter que justificaba
  `AI_MAX_REQUESTS_PER_MINUTE=15` era de la cuenta gratuita** (verificado
  el 7/9/2026 contra `/api/v1/key` con la llave de producción:
  `is_free_tier: false`, `limit: null`, `rate_limit` deprecado). Los
  frenos de turnos (`AGENT_MAX_TURNS_PER_MINUTE`) y de peticiones
  (`AI_MAX_REQUESTS_PER_MINUTE`) se suben siempre juntos porque un turno
  gasta ≈3,4 peticiones (escenario + intención + 1-2 pasos de redacción):
  subir solo el de turnos hace aparecer `ia_ritmo_al_tope`, que duerme
  dentro del turno hasta 60 s. El Environment de Dokploy está cifrado y
  solo llega al contenedor con un redeploy — cargarlo no basta si no se
  redespliega.
- **El comparador de clasificación no tiene una referencia fija**
  (`scripts/comparar-clasificador.test.ts`, 7/9/2026): corrido dos veces
  con el mismo modelo grande (`gpt-5.6-luna`) sobre 200 conversaciones
  reales, solo coincide consigo mismo en el 92,5 % y "pierde" 8 escenarios
  contra su propia respuesta anterior — un criterio absoluto de ≥95 % de
  acuerdo es inalcanzable incluso para el modelo de referencia. Comparar
  siempre contra esa línea base grande-contra-grande, nunca contra 100 %;
  el desacuerdo dominante en todos los candidatos medidos
  (`google/gemini-3.1-flash-lite` incluido) es
  `consulta_disponibilidad`↔`otro`, dos intenciones que hoy reciben las
  mismas herramientas en el tool loop.
- **El corte "habló hoy" de la bandeja tiene UNA sola fuente** (T1 de "Seis
  frentes del buzón", 8/9/2026): `useInboxDay(scope)` (`use-inbox-day.ts`,
  vive en `crm-shell.tsx`) calcula la medianoche de Caracas con
  `currentDayRange` y ese MISMO string viaja a `FetchConversationsOptions.since`,
  a `fetchInboxCounts`, a `fetchUnassignedConversations` y a `matchesDay`
  (`inbox-filters.ts`). La fórmula es `last_message_at >= hoy` O
  (`last_message_at is null` Y `created_at >= hoy`) — la segunda pata existe
  para que un contacto recién agregado desde la bandeja (T6, sin mensajes)
  no desaparezca. No recalcular la medianoche en ningún otro sitio: dos
  relojes desalineados hacen que un chat entre en la lista pero no en el
  conteo. La búsqueda ignora el corte a propósito; el interruptor "Ver todo"
  se guarda por visor en `localStorage` (`sbk.inbox.scope.<agentId>`).
- **`intencion_compra` escala con el primer aviso, igual que devolución y
  queja** (revertido el 9/9/2026, corrida "El pase a ventas al primer sí").
  T2 del plan "Seis frentes del buzón" (8/9/2026) le había puesto una
  segunda confirmación: la herramienta de escalar sellaba
  `conversations.handoff_confirmation_pending_at` y solo escalaba de verdad
  cuando el cliente decía que sí por segunda vez. En producción hizo bucle —
  el cliente contestaba "ok", "está bien" o "dale" al primer paso hacia el
  cierre, el prompt exigía un segundo "sí" LITERAL y el modelo no contaba
  esos sinónimos como la confirmación, así que la conversación quedaba dando
  vueltas sin escalar nunca. El operador aprobó eliminar la doble
  confirmación por completo: se borró `handoff-confirmation.ts` (la máquina
  de estados que decidía "none"/"awaiting"/"confirmed"/"expired") y la rama
  de `buildEscalateTool` (`tools.ts`) que la consultaba. **La única regla
  que queda es la prosa del prompt** (`SALES_ACCEPTANCE_RULES`, sección 3,
  que reemplazó a `SALES_HANDOFF_RULES`): le nombra al modelo las formas de
  aceptar que no son un "sí" literal ("ok", "está bien", "dale", "listo",
  "claro", "por favor", un pulgar arriba) y le dice que pase el caso de una
  vez. **Ya no hay ninguna red de seguridad en código** — si algún día hace
  falta volver a frenar el escalamiento, hay que reconstruir la máquina de
  estados, no alcanza con tocar el prompt. La columna
  `conversations.handoff_confirmation_pending_at` (migración
  `20260909010000`) sigue en la base **sin uso**, con valores viejos que ya
  nadie lee ni escribe — no hay migración de reversa a propósito (`drop
  column` es irreversible) — y `database.types.ts` la conserva porque el
  esquema real todavía tiene la columna.
- **Un sticker saliente solo viaja por `link` a un WebP del bucket** (T3a,
  8/9/2026): payload `{ type: "sticker", sticker: { link } }` SIN `caption`
  (`meta-client.ts`); la biblioteca (`stickers`) guarda `storage_path` dentro
  de `whatsapp-media` bajo `stickers/<uuid>.webp`, nunca una URL.
  `deleteSticker` borra la FILA antes que el objeto para que un rechazo de
  RLS no deje archivos huérfanos. **Actualización (8/9/2026): el primer
  sticker saliente en producción SÍ se verificó, y Meta lo rechazó** — no por
  el `caption` (la forma del payload estaba bien), sino por PESO: error
  131053, "Sticker file has size 973668 bytes but must be atmost 512000
  bytes and non-empty" (mensaje `642661b5-7c07-4676-9c4a-9d0af949a712`,
  conversación `3b654d2c…`, 18:38 UTC). Era el mismo sticker, byte por byte,
  que ese cliente había mandado el día anterior — un WebP **animado**
  guardado en la biblioteca con `animated` en su default `false`. Ver la
  trampa siguiente ("los límites de Meta son de salida") y
  `whatsapp/sticker-guard.ts`.
- **Los límites de peso de stickers de Meta son de SALIDA, y son DOS, no
  uno** (8/9/2026, caso `642661b5…` de arriba): WhatsApp entrega al cliente
  stickers entrantes más pesados de lo que la Cloud API deja reenviar, así
  que **nada de lo que se recibe es reenviable por definición** — hay que
  medirlo, nunca asumirlo. El límite es 100 KB para un sticker estático y
  **500 KB para uno animado** (cinco veces más), y **detectar animación es
  leer bytes** (`isAnimatedWebp` en `sticker-image.ts`: `RIFF`+`WEBP`+`VP8X`
  y el bit `0x02` del byte de flags en el offset 20), nunca la extensión ni
  el MIME que mandó el cliente. La escalera de calidad de `sticker-canvas.ts`
  (T3b) **NO rescata un animado que no entra**: reencodear en `<canvas>` lo
  aplana a un solo fotograma, deja de ser el sticker que el asesor quería
  guardar — un animado que no entra se RECHAZA, nunca se recomprime. Por eso
  `saveStickerFromMessage` (`mutations.ts`) ya no usa el camino rápido
  `storage.copy`: para pesar el archivo y detectar animación hay que bajar
  los bytes igual, así que un "camino rápido" que nunca ve lo que acaba de
  medir no se justificaba — ahora baja, mide y RECIÉN ENTONCES escribe; si no
  entra, tira antes de tocar storage o la tabla, sin dejar nada a medias. Y
  `api/messages/send/route.ts` corta con 422 ANTES de insertar la fila en
  `messages` (`checkStickerBeforeSend`, `whatsapp/sticker-guard.ts`) porque
  Meta acepta el POST con 200/wamid igual — el 131053 llega recién ~3 s
  después por el webhook de status, un `failed` silencioso que solo se
  entiende mirando la burbuja.
- **`products.weight_kg` es nullable y la IA NO lo lee** (T4, 8/9/2026):
  `null` significa "sin cargar" (la mayoría del catálogo hasta que alguien lo
  complete para Cashea), el filtro "Sin peso" cuenta solo activos, y
  `buildCatalogTool` no lo selecciona a propósito. `parseWeightInput` acepta
  coma o punto y devuelve `value: null` para el campo vacío (guardado
  legítimo, no error).
- **La factura es un SNAPSHOT** (T5, 8/9/2026): `invoices.customer` e
  `invoices.items` se copian de `contacts`/`order_items` al generarla y no se
  actualizan si después editan el contacto o el producto; los totales se
  redondean a centavos renglón por renglón (`computeInvoiceTotals`,
  `invoices.ts`), nunca al final. Emitir y anular exigen supervisor/admin EN
  RLS (`invoices_update`). Los datos fiscales del emisor (`INVOICE_ISSUER`)
  y el IVA (`DEFAULT_TAX_RATE = 0`) están "Por definir" hasta que el operador
  los entregue: la hoja lo muestra así, no inventa valores.
- **Un componente que devuelve un FRAGMENTO le entrega N hijos a su padre, no
  uno — y si ese padre es un grid de columnas fijas, le desarma la pantalla
  entera.** Tumbó producción el 9/9/2026, en las seis secciones a la vez.
  `AppRail` pasó a devolver `<>` con el `<nav>` del rail MÁS el contenedor
  `aria-live` de `AssignmentNotifier` (143531c); un fragmento no crea nodo DOM,
  así que los dos subieron como hijos DIRECTOS de `.crm` (crm.css) y
  `.dash-frame` (dashboard.css), que son `grid-template-columns: 72px
  minmax(0, 1fr)` — DOS columnas. El contenedor del aviso se quedó la columna
  del contenido y TODO el CRM cayó a una fila implícita de 72px de ancho,
  recortada por el `overflow: hidden`. **`pointer-events: none` NO saca del
  flujo** (solo deja pasar los clics): lo que hacía falta era `position: fixed`
  en `.an-live`. Antes de montar algo nuevo dentro de un componente
  compartido, mirar si el padre reparte columnas: el hijo de más no se ve en
  ningún test. **Los tests de este repo NO pueden atrapar esto** — jsdom no
  calcula layout, así que ninguna aserción sobre el DOM renderizado detecta
  un grid desarmado. (10/9/2026, "El aviso de asignación sale arriba a la
  derecha": `AssignmentNotifier` dejó de montar `.an-live`/`.an-toast` —pasó
  a usar el `toast()` global de HeroUI, con el `Toast.Provider` ya montado
  en `layout.tsx`— así que `assignment-notifier.css` se borró entero y el
  componente devuelve `null`; el fragmento de `AppRail` ya no tiene un
  segundo hijo que robarle la columna al grid. El resguardo de la HOJA de
  estilos se fue con el CSS: quedó reemplazado por
  `app-rail.test.tsx` ("entrega un solo hijo directo"), que verifica
  `container.childElementCount === 1` — más general que mirar una regla CSS
  puntual, porque atrapa CUALQUIER hijo de más que algo montado dentro de
  `AppRail` deje en el DOM, no solo este caso.)
- **Estar en una migración con RLS no significa que una tabla publique nada
  por Realtime — y suscribirse a un canal muerto no falla, calla para
  siempre.** `conversation_handoffs` existe desde el 30/8/2026
  (migración 20260830040000) con su política `conversation_handoffs_select
  using (is_agent())`, y desde esa misma fecha `crm-shell.tsx` tiene un canal
  `unassigned-handoffs` suscrito a sus `postgres_changes` para mantener viva
  la píldora "Sin dueño". Verificado contra producción el 8/9/2026
  (`select tablename from pg_publication_tables where
  pubname='supabase_realtime'`): de 15 tablas publicadas, esa NO estaba —
  nadie la agregó a `supabase_realtime` en la migración que la creó ni en
  ninguna posterior. El canal se arma bien, `channel.subscribe()` reporta
  `SUBSCRIBED`, y no llega jamás un evento: la píldora solo se actualizaba al
  recargar la página, desde el 30/8 hasta el 8/9. Antes de confiar en un
  canal nuevo (o viejo, que nadie había medido), verificar la publicación
  contra la base, no leer la migración ni el código del canal — ninguno de
  los dos avisa. Arreglado en `migrations/20260909050000_realtime_conversation_handoffs.sql`
  (`alter publication supabase_realtime add table`, con
  autoverificación: `raise exception` si al final no quedó publicada).
- **El `reason` de `conversation_handoffs` es imprescindible para distinguir
  "te asignaron algo nuevo" de "seguís teniendo lo mismo de siempre" — no es
  higiene, es la diferencia entre un aviso útil y un aviso que salta en cada
  mensaje.** El aviso de asignación (8/9/2026, `assignment-notice.ts`) solo
  dispara con `to_kind === "human" && to_id === miAgentId && reason ===
  "escalada"`. `escalada` (`escalate.ts`) es el ÚNICO traspaso que significa
  "la IA te acaba de entregar este caso"; `asignada` (`agent.ts`) se escribe
  CADA VEZ que llega un mensaje del cliente a una conversación que YA tiene
  dueño —no es una asignación nueva, es la misma reafirmándose—, así que
  filtrar solo por `to_kind`/`to_id` habría hecho saltar el aviso en cada
  mensaje del cliente durante el resto de la conversación. `created_by`
  tampoco sirve como filtro: vale `'system'` en casi todas las razones,
  incluida `escalada`.
- **El dedupe de un aviso que vive dentro de un componente montado en varios
  sitios a la vez tiene que ser un `Set` de MÓDULO, nunca de instancia.**
  `AppRail` se monta en las seis secciones del CRM y TAMBIÉN dentro de
  `section-skeleton.tsx`, así que durante cualquier navegación coexisten dos
  instancias unos milisegundos — las dos suscritas al mismo canal
  `assignment-notice`, las dos recibiendo el mismo INSERT de
  `conversation_handoffs`. Un `Set` por instancia (p. ej. un `useRef` dentro
  de `AssignmentNotifier`) no protege de nada porque cada instancia tiene el
  suyo; `markAssignmentNoticeSeen` (`assignment-notice.ts`) usa un `Set` a
  nivel de módulo (tope 200, FIFO) que las dos instancias comparten. Mismo
  motivo por el que `notifiedHandoffIds` nunca se resetea al montar el
  componente.
- **El Recorrido muestra SOLO el día en curso; "Total de leads" es su único
  número acumulado** (corrida "Los números del día", 10/9/2026).
  `buildJourney`/`countStalled` (`dashboard.ts`) reciben `dayStart` —el
  MISMO string de `useInboxDay("today")` que usa la bandeja, aplicado en
  memoria porque la lista de Reclamos de la misma página necesita
  conversaciones de cualquier fecha—; sin `dayStart` no filtran nada
  (llamador viejo). El orden dentro de cada etapa es "más nuevo arriba"
  (revierte "lo urgente arriba" del 5/9); la urgencia la conservan el punto
  rojo y el contador "N atascados". `matchesDay` está replicada en privado
  en `dashboard.ts` porque `inbox-filters.ts` ya importa de `dashboard.ts`
  (ciclo).
  **"Primer contacto" es una COLUMNA DE COHORTE, no un peldaño de la
  escalera** (corrida "El Recorrido cuenta los números nuevos del día",
  10/9/2026, misma tarde, segunda vuelta): la misma conversación puede
  aparecer ahí Y en su columna de estado real (p. ej. "Con asesor") a la
  vez, a propósito — cualquier número del tablero que sume las columnas en
  vez de contar conversaciones únicas cuenta esa tarjeta dos veces, que es
  justo por lo que existe `countStalled` (cuenta sobre el conjunto
  `isActive` + `matchesDay`, no sobre `stage.stalled` de cada columna). Su
  definición (`isFirstContact`) es "creada hoy + tiene un mensaje del
  cliente"; `welcomeSentAt` YA NO participa. Sí participaba hasta esta
  corrida —"CREADO HOY con un solo mensaje del cliente, `lastCustomerMessageAt
  <= welcomeSentAt`, espere o no"— y esa dependencia fue el bug real: se
  midió en producción el 10/9/2026 y la columna daba CERO sobre 119 números
  nuevos del día (90 ya con asesor, 28 ya con respuesta), porque
  `WHATSAPP_WELCOME_TEMPLATE` está vacía desde siempre y `welcome_sent_at`
  nunca se sella. Sacarle solo esa condición al peldaño no arreglaba nada de
  fondo —habría mostrado 1 de 119, porque casi ningún lead nuevo se queda
  quieto en un peldaño de escalera—, así que el operador decidió la cohorte
  completa en vez de un parche puntual. La cohorte NO tiene reloj propio:
  `stageOf` nunca devuelve `"first_contact"` (perdió ese peldaño y su
  parámetro `dayStart`, igual que `waitingMinutes`/`isStalled`), así que el
  punto rojo de cada tarjeta de "Primer contacto" se pinta con el umbral de
  su etapa REAL (60 min laborales con asesor, 15 sin él) — "atascado" sigue
  teniendo una sola definición, la de siempre. Y ojo con la asimetría frente
  al llamador viejo: sin `dayStart`, `buildJourney` y `countStalled` dejan
  pasar cualquier fecha, pero `isFirstContact` devuelve `false` (sin día no
  hay cohorte), así que esa columna se VACÍA en vez de llenarse — lo
  contrario de lo que sugiere el resto de la viñeta.
- **`dayKey` (`format.ts`) agrupa en la zona del NAVEGADOR; el día de
  negocio se corta con `crmDayKey`/`todayKey` (`sales-day.ts`)**
  (10/9/2026). Un asesor con el reloj de Windows en otra zona vería una
  venta de las 23:30 cambiar de día. Ventas corta en memoria sobre lo que
  ya trae `fetchSales`; cuenta y suma SOLO `won` en USD (`closeSale`
  siempre crea la orden en USD; `null` se trata como USD), las devueltas
  se cuentan aparte y nunca se mezclan monedas.
- **Una fila de campos en flex con `align-items: center` se desalinea apenas
  un vecino tenga una línea más.** Inventario (10/9/2026): el campo Precio
  llevaba debajo, SOLO en productos en USD, la línea "Bs. …" (`.inv-bs`);
  ese campo quedaba más alto y Stock y Peso se centraban contra él, unos
  píxeles más abajo — en productos en bolívares no pasaba, por eso
  "algunas" filas se veían torcidas. `.inv-row` es ahora una grilla de
  columnas FIJAS (la de estado también: con `auto`, cada `<li>` repartía
  distinto y las cajas se corrían 38 px entre filas) y el pie de bolívares
  se reserva siempre. El resguardo (`inventario-css.test.ts`) mira la HOJA,
  no el DOM; la alineación se midió con `getBoundingClientRect` en Brave.
- **`conversations.assigned_at` existe desde la migración 20260822080000**
  (la sella `handle_conversation_assigned`, BEFORE, y la limpia al
  desasignar) **y `database.types.ts` NO la tenía**: el plan del 10/9/2026
  la creyó nueva y la primera versión de la migración la volvía a crear
  (habría fallado con "column already exists"). Los tipos generados son
  copia a mano y pueden mentir por omisión: antes de "agregar" una columna,
  `grep` en `supabase/migrations/`. "Asignadas hoy" del panel de inicio es
  `null` solo para lo asignado antes del 22/8/2026.
- **Las ventas se atribuyen a quien CERRÓ (`deal_closed_by`), no al asesor
  asignado, en TODO el CRM desde 20260910010000**: la lista de Ventas ya lo
  hacía, `agent_day_summary` (panel de inicio) nace así y `agent_metrics`
  (Control IA) se realineó en esa migración (decisión 8, 10/9/2026). Un
  supervisor que cierra la venta de un chat asignado a otro se la lleva él.
- **El panel de inicio de la bandeja habla del ASESOR y de HOY** (10/9/2026):
  `agent_day_summary(p_from, p_to)` recibe el rango desde el cliente
  (`dayRangeFrom(useInboxDay("today"))`, aparte del `dayScope` de la
  bandeja: "Ver todo" no cambia el día) y decide el asesor por `auth.uid()`.
  `null` del RPC pinta "—", nunca un cero que parezca verdad. La lista "La
  IA te pasó hoy" y su refresco en vivo dependen de que
  `conversation_handoffs` esté publicada en Realtime (migración
  20260909050000): sin ella el canal calla y solo se ve al recargar.
- **Control IA ya no lista los chats sin asesor** (10/9/2026): la tarjeta
  "Sin asignar" mostraba TODOS y con cientos de leads desbordaba la página.
  Queda el número en la nota del roster, enlazado a `/inbox`; la cola vive
  paginada en la píldora "Sin dueño". La bandeja todavía no acepta un
  parámetro de URL para abrir en una píldora.
- **`next dev` puede servir un chunk con una versión VIEJA de un módulo, sin
  avisar de nada** (10/9/2026, verificando el aviso de asignación en local).
  `data.ts` viaja en DOS chunks del cliente —el de `src/lib` y el de
  `app-rail`, porque `AssignmentNotifier` importa `fetchCurrentAgent`— y uno
  de los dos traía `fetchInboxCounts` SIN `mineUnread` mientras el otro sí:
  el panel de inicio pintaba "Tuyas sin leer" vacío después de cualquier
  refresco en vivo, porque el objeto de contadores llegaba con seis claves
  en vez de siete. El fuente estaba bien y la suite en verde. Borrar
  `.next/dev` no alcanza: hay que borrar **también `.next/cache` y
  `.next/turbopack`**, reiniciar el server (confirmar pid nuevo con
  `netstat -ano | grep :3000`) y recargar con **Ctrl+Shift+R** — sin la
  recarga dura, el navegador reusa el chunk viejo y Turbopack tira
  `module factory is not available`. Diagnóstico: bajar cada chunk desde la
  consola (`fetch(url, {cache:'reload'})`) y contar el símbolo que falta,
  antes de tocar una línea de código. Producción no lo sufre: CI y Dokploy
  compilan desde cero.
- **Tras arrancar Docker Desktop, el primer minuto la base rechaza los
  tokens** (10/9/2026): el reloj de la VM arranca atrasado y PostgREST
  responde `PGRST303 "JWT issued at future"`. Se ve como
  `fetchBusinessHours` cayendo al horario por defecto y como TODOS los
  canales de Realtime cerrándose ~40 s después de entrar. No es un bug del
  CRM: esperar un minuto tras `docker ps` y recargar. (Los siete
  `realtime_canal_caido` que aparecen al cargar una página son el doble
  montaje de StrictMode en desarrollo, tampoco son una caída.)
- **La suite local y el CI no corren el mismo Node, y el CI no frena el
  deploy** (10/9/2026). Esta máquina corre Node 26; el CI y el Dockerfile,
  Node 22. Node 25+ trae Web Storage nativo que, sin `--localstorage-file`,
  deja `localStorage` en `undefined` dentro de jsdom; en Node 22 jsdom trae
  uno real. Con esa diferencia, 15 tests de `inbox-sidebar.test.tsx`
  heredaban la píldora que guardaba el test anterior y el paso "Pruebas" del
  CI estuvo ROJO desde el 6/9 (`1379b2c`) hasta el 10/9 mientras la suite
  local daba verde. Nadie lo vio porque Dokploy despliega con el push sin
  esperar al CI: `2f80f1e`, la versión en producción, salió con el CI en
  rojo. Desde entonces `vitest.config.ts` pasa `--no-experimental-webstorage`
  a los workers (`execArgv`), `vitest.setup.ts` vacía `localStorage` antes de
  cada test y `vitest.setup.test.ts` fija las dos cosas. **Después de cada
  push, mirar el CI**: sin `gh` alcanza la API pública (ver Comandos; campos
  `head_sha`, `status`, `conclusion`). GitHub muestra solo 10 anotaciones por
  paso: si hay más fallas, reproducirlas en local.

- **Toda salida de un turno que escaló es `is_auto_reply`, con asesor o sin
  él** (T5, "La voz cercana y la espera visible", 14/9/2026). Antes
  `isAutoReply: outcome.escalated && outcome.unassigned === true`: con
  asesor asignado la promesa "un asesor te va a atender" salía como
  respuesta real, el trigger apagaba `awaiting_reply` y la conversación
  desaparecía de Pendientes —170 promesas de ≥ 30 min invisibles en 72 h, 23
  sin cumplir— y "Con asesor" del Recorrido nunca contaba atascados
  (`waitingMinutes` devuelve `null` sin `awaitingReply`). Ahora la
  conversación sigue esperando hasta que una persona escriba: aparece en
  "Pendientes" y en "Tuyas" del asesor, y "Con asesor" cuenta atascados a
  60 min laborales. El camino de escenario `afterSend = "escalate"` marca
  igual (`turno_escenario_escalado_marcado`). El reconciliador no la
  reencola porque `ai_enabled = false`. Si alguna vez una escalada apaga
  `awaiting_reply`, el bug está en quien mandó el texto sin la marca, no
  en la base.
- **La IA saluda por franja UNA sola vez, y el saludo lo calcula el código,
  no el modelo ni el panel** (T3 y T4, "La voz de mostrador con nombre
  propio", 15/9/2026). El sufijo `needsGreeting` de `buildInstructions`
  (`prompt.ts`) trae el saludo ya resuelto —"¡Buenas noches!"— con
  `greetingFor(dayBand(now))` de `business-hours.ts`, solo en el primer
  mensaje de la conversación; en los demás el sufijo prohíbe saludar.
  `turnClockLine` sigue SIN franja a propósito: hasta el 14/9 la traía en
  cada turno y la IA saludaba a mitad de conversación (a veces con la
  franja mal), y el 14/9 el saludo fue neutro un día ("¡Hola!") hasta que el
  operador pidió la franja de vuelta. No volver a meter el saludo en `TURNO
  ACTUAL`: el modelo copia lo que llega en cada turno, no solo en el
  primero. Ningún escenario del panel saluda (ver la trampa siguiente), así
  que el saludo no depende de nada configurable.
- **Los CHECK de `intent` viven en `20260914010000`; un valor nuevo en
  `INTENT_VALUES` (`classify.ts`) exige migración** (T1, 14/9/2026).
  `fuera_de_tema` existió en el código desde el 5/9 y en la base hasta el
  14/9 no: cada turno fuera de tema fallaba en silencio el insert de
  `logTurn` y el update de `conversations.intent` (3 turnos visibles, 0 en
  bitácora). Desde T5 esos dos errores se registran
  (`turno_bitacora_no_escrita`, `turno_intencion_no_guardada`) sin lanzar:
  si aparecen en el log, falta una migración, no un try/catch.
- **Un error de la RPC `agent_can_run` LANZA y la cola reintenta; solo un
  `false` es "IA apagada"** (T5, 14/9/2026). Antes `stillEnabled` devolvía
  `false` ante cualquier error y la apertura de `runAgentTurn` leía
  `{ data }` sin mirar `error`: 13 turnos en 72 h quedaron como
  `agente_no_puede_correr`/`turno_saltado_ia_apagada` con el interruptor
  encendido, y eran cortes de conexión con la base (0,87 $ gastados en
  turnos que nunca respondieron). Ahora `turno_interruptor_no_consultable`
  + `throw`: el turno falla antes de `entrega.intentado = true`, así que
  no hay doble envío, y `MAX_ATTEMPTS` de la cola hace los reintentos.
  Sigue fallando cerrado (no se envía), pero un corte de base ya no se
  disfraza de interruptor. `human-handled.test.ts` espera el rechazo. El WEBHOOK tiene su propio chequeo antes de encolar (route.ts, `webhook_interruptor_no_consultable`): ante error sigue de largo y encola; solo un `false` real deja `agente_no_puede_correr` sin encolar (corrección hallada en la verificación final del 14/9: con la RPC rota antes del mensaje, el hueco del webhook tapaba el arreglo del turno).
- **Fase 0 ignora SIEMPRE los escenarios cuyo texto empieza saludando** (T4,
  15/9/2026). `matchPlaybook` saca de los candidatos todo escenario cuyo
  `response_text` calce `isGreetingPlaybook` (`saludo.ts`:
  hola/buenas/buenos/buen día/bienvenid…) antes de llamar al modelo, y deja
  `escenarios_saludo_ignorados` con sus nombres. El 14/9 el descarte era
  condicional (solo si el mensaje traía más que un saludo) y un "hola"
  pelado seguía eligiendo el escenario del panel, con el texto y la franja
  escritos a mano: eso fue lo que el cliente reportó como "configuré los
  escenarios y la IA no funcionaba". `greeting-window.ts` (el reloj que
  filtraba escenarios por la franja de su texto) se retiró el 15/9: sus
  tres patrones eran subconjunto de `isGreetingPlaybook`, así que ya no
  podía filtrar nada. Consecuencia para el panel: un escenario que deba
  salir NO puede empezar con hola/buenas/bienvenid ("¡Hola! Acá va el
  catálogo 👇" se ignora aunque no sea un saludo); O3 lo documenta. Y ojo
  con los tests: un escenario de prueba "¡Buenas tardes!…" sin `now` fijo
  hizo fallar tres tests de `playbooks.test.ts` después de las 19:00 del
  14/9 sin que nadie lo viera hasta el 15/9 — nunca dejar un test que
  dependa del reloj real.
- **La guarda de cortesía tras escalada (`cortesia_tras_escalada`) solo
  puede correr SIN asesor asignado, y `escalationOpen` mira la última fila
  QUE CAMBIA DE MANOS** (T4 del 14/9 y T5 del 15/9/2026). `openTurn` corta
  antes con `asignada` cuando `assigned_agent_id` no es `null`, así que
  dentro de `runTurnPhases` la rama `toKind: "human"` de esa guarda es
  defensiva e inalcanzable hoy. El caso real es el de la devolución masiva
  a la IA del 13/9 (asesor quitado, `ai_enabled = true`, último traspaso
  `escalada`): el "gracias" reencolado calzaba el escenario de despedida.
  `escalationOpen` (`handoffs.ts`) lo detecta y el turno se calla dejando
  la fila con `to_kind = 'unassigned'`: cae en "Sin dueño", que es la
  verdad. `awaiting_reply` no se toca a propósito. Desde el 15/9 la
  consulta excluye `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` (`asignada`,
  `pausada`, `agente_no_puede_correr`, `cortesia_tras_escalada`,
  `humano_intervino`, `humano_se_adelanto`): esas filas se escriben sin que
  la escalada cambie y el 14/9 tapaban la `escalada` (una `asignada`
  posterior, o la propia segunda cortesía). **Toda razón nueva que se
  escriba por mensaje sin cambiar de dueño exige sumarse a esa constante**;
  una razón desconocida cuenta como cierre y la IA atiende.
- **Al segundo adjunto sin texto la IA escala en código, sin modelo** (T6,
  14/9/2026). `mediaStreakWithoutText` (`history-line.ts`) cuenta la racha
  de marcadores SIN pie desde el final; con dos y una respuesta de la IA en
  medio, `runTurnPhases` escala con `seguimiento`, manda `DESPEDIDA_MEDIA`
  con `is_auto_reply` y no llama ni a fase 0 ni a `classifyIntent` (la
  fila de `agent_turns` queda sin tokens). El sticker no cuenta ni corta la
  racha. La línea de `MEDIA_RULES` es informativa: la regla vive en código.
- **Las notas de voz de Meta llegan como `audio/ogg; codecs=opus`, el CRM
  las sirve tal cual, y en Chrome el fallo NO es el formato: es la URL
  firmada de 60 s** (T6b del 14/9 y T7 del 15/9/2026;
  `docs/diagnosticos/2026-09-14-notas-de-voz.md` y
  `2026-09-15-notas-de-voz-chrome.md`). `api/media` solo redirige (307) a
  una URL firmada de Supabase Storage que vive 60 s; la burbuja
  (`AudioContent`, `message-bubble.tsx`) usa `<audio preload="metadata">`,
  que resuelve ese redirect al montarse. Si el asesor pulsa play más de un
  minuto después, Chrome pide los rangos a la URL vencida, Storage responde
  400 con JSON y `<audio>` reporta el código 4, el MISMO que un códec no
  soportado (medido en local con `curl`; `Accept-Ranges`/206 y el
  `Content-Type` sí están bien). Los asesores usan Android o PC con
  Chrome/Brave/Edge, así que la hipótesis Safari/Ogg del 14/9 queda
  descartada. Desde el 15/9 la rama del código 4 ofrece Reintentar además
  de Descargar; el TTL de `api/media` NO se tocó (decisión del operador):
  el arreglo de fondo (TTL más largo o streaming con `Range` sin URL
  firmada) es de v1.2. La extensión `.bin` de esas notas se cerró el 15/9
  (`extensionForMime`, `whatsapp/media-extension.ts`, corta el parámetro
  tras `;`).
- **El negocio se llama SBK Motors y el nombre vive en `src/lib/brand.ts`**
  (T2, 15/9/2026). Hasta esa fecha "SBK Motorcycles" estaba escrito a mano
  en ~20 archivos (prompt, clasificador, herramientas, factura, título,
  login, seis cabeceras) y uno llegaba al cliente en cada saludo;
  `BUSINESS_NAME`/`APP_TITLE` son ahora la única fuente y ningún archivo de
  `src/` escribe el literal salvo `brand.ts` y sus tests. La migración
  `20260915010000` corrigió el nombre en los DATOS (categorías y entradas
  de la biblioteca, escenarios del panel). Se conservan a propósito con el
  nombre viejo: los identificadores de infraestructura (tag de imagen
  `sbk-motorcycles-crm`, `REMOTE_DIR` de `deploy.sh`, `.claude/launch.json`
  — son rutas en el VPS), las migraciones ya aplicadas, el User-Agent
  `SbkMotorcyclesCRM/1.0` de `bcv-fetch.ts` y las citas históricas de frases
  reales en comentarios y tests ("Soy el asistente automatizado de SBK
  Motorcycles" fue lo que salió el 26/8: es evidencia, no marca).
- **La IA solo atiende mensajes del cliente posteriores al sello de
  devolución, y "Sin dueño" ahora también lo llenan las devoluciones**
  (T1/T2/T3, "La IA no vuelve a pedir lo que ya pidió" — revisión,
  16/9/2026, migración `20260916010000`). Caso reportado: un cliente pide
  un asesor, la IA escala y se despide ("te paso con un asesor"); un
  asesor desasigna la conversación y reactiva la IA a mano; en menos de un
  minuto el reconciliador la reencolaba y la IA repetía la misma promesa
  sobre el MISMO mensaje viejo del cliente — el mecanismo que el 13/9
  volvió a escalar 63 casos. `conversations.ai_resume_cutoff_at` es el
  sello: lo escribe el trigger BEFORE `handle_conversation_ai_resume()` al
  ENTRAR al estado "IA encendida y sin asesor" (viniendo de cualquier otro
  estado — cubre los dos órdenes de desasignar/reactivar y un UPDATE
  masivo por SQL); una escalada SALE de ese estado, así que nunca sella.
  `new_since_ai_resume` es la columna GENERADA que compara
  `last_customer_message_at` contra ese sello — `reconciler.ts` y
  `unansweredFreeWork` (`data.ts`, el botón de atraso "encender la IA")
  filtran por ella EN EL WHERE, no en memoria. La guarda
  nueva de `runAgentTurn` (`agent.ts`, después de `pausada`, antes de
  `humanHasWritten`) compara lo mismo en código: si
  `last_customer_message_at` es anterior O IGUAL al sello, el turno no
  llama al modelo y deja el traspaso `mensaje_previo_a_devolucion` a
  `unassigned` — ese chat cae y se queda en "Sin dueño" hasta que alguien
  (un humano, o la IA con un mensaje nuevo del cliente) lo atienda. Es la
  decisión del operador del 16/9, no un bug: "Sin dueño" crece con cada
  devolución que deja un mensaje pendiente.
- **El sello copia `last_customer_message_at`, nunca `now()`** — misma
  razón que la trampa del 131047 de más arriba: `created_at` de un
  entrante es la marca de tiempo de META (`route.ts:1343`), así que un
  mensaje mandado un segundo antes de la devolución pero ENTREGADO después
  quedaría detrás de un `now()` fijado con el reloj de pared de esta
  máquina. Contra el último mensaje ya conocido en el instante de la
  devolución no hace falta ninguna tolerancia: cualquier mensaje que
  llegue después queda por delante del sello sin importar cuándo salió la
  respuesta de la IA — por eso la guarda de `agent.ts` no sufre la carrera
  de ráfaga (el cliente escribe mientras la IA redacta): el sello nunca se
  mueve con una salida, solo con una devolución.
- **TODA reactivación sella, no solo la que sigue a una escalada** —
  también la de una pausa manual. Si un asesor pausa la IA, el cliente
  escribe, nadie le contesta y el asesor la reactiva, la IA NO contesta
  ese mensaje: el chat queda en "Sin dueño" hasta que alguien le escriba o
  el cliente vuelva a escribir. El trigger dispara con CUALQUIER cambio de
  `ai_enabled`/`assigned_agent_id`, y sella al ENTRAR al estado "sin
  asesor" sin mirar por qué se llegó ahí — es una consecuencia que el
  operador aprobó a propósito con este plan, no un efecto colateral que
  falte corregir.
- **`devuelto_a_ia`/`desasignada_por_asesor` SÍ cierran la escalada para
  `escalationOpen`; `mensaje_previo_a_devolucion` NO** (`handoffs.ts`,
  `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`). Las dos primeras las escribe el
  trigger AFTER `handle_conversation_ownership_change()` cuando un humano
  de verdad mueve al dueño (desasigna, o reactiva la IA) — eso SÍ cambia
  de manos, y si no cerraran la escalada un "gracias" escrito DESPUÉS de
  la devolución quedaría callado por la guarda de cortesía
  (`cortesia_tras_escalada`), contra la decisión de que la IA vuelva a
  responder lo que el cliente escriba después de que se la devuelven.
  `mensaje_previo_a_devolucion` es justo lo opuesto — la propia guarda de
  T3 callándose sola, sin que nadie mueva al dueño — y por eso SÍ está en
  la constante: tratarla como cierre dejaría a `escalationOpen` mirando su
  propia salida silenciosa como si fuera un traspaso real. Consecuencia:
  `reabierto` (el que escribía el reconciliador al reencolar) ya NO se
  escribe para un mensaje anterior a la devolución, porque
  `new_since_ai_resume` lo saca del WHERE antes de que el reconciliador
  llegue a considerarlo.
- **Diseño descartado el 16/9/2026, no repetirlo.** La primera versión de
  este plan (15/9/2026, commit `56fa2df`, migración `20260915020000`,
  deshecho con `git reset --soft` antes de salir de esta máquina) medía
  una columna `awaiting_any_reply` contra `last_message_at` —"¿salió algo
  después del último mensaje del cliente?"— y la revisión adversarial le
  encontró cinco fallas: (1) un envío `failed` también adelanta
  `last_message_at`, tapando `entrega_fallida`; (2) la carrera de ráfaga
  —el cliente escribe mientras la IA redacta y la respuesta queda fechada
  después de ese mensaje— callaba un mensaje sin contestar; (3) la
  plantilla de bienvenida se inserta justo después del primer mensaje del
  cliente, y la guarda habría callado el primer turno de cada lead nuevo;
  (4) la fila `devuelto_a_ia` iba siempre a `'ai'`, así que un cliente con
  una promesa pendiente salía de "Sin dueño"; (5) con la IA apagada por la
  escalada, el cliente puede escribir mientras espera al asesor —el
  webhook lo encola igual y el turno sale por `pausada`— dejando un
  mensaje ANTERIOR a la devolución que un reloj de salidas vería como
  pendiente al reactivar. El sello de devolución no sufre ninguna de las
  cinco: no mira salidas, solo el instante en que un humano le entrega el
  chat a la IA.
- **El trigger AFTER dejó con rastro tres movimientos de dueño que antes no
  tenían ninguno.** `handle_conversation_ownership_change()`
  (`20260916010000`) inserta `desasignada_por_asesor` cuando un asesor
  suelta el caso, `devuelto_a_ia` cuando la IA se reactiva y `reclamado`
  cuando un asesor TOMA un caso (`assignToMe`/`intervene` en
  `mutations.ts`, sin `ai_enabled` cambiando en el mismo UPDATE —eso
  excluye a la escalada, que cambia las dos columnas juntas y deja su
  propia fila `escalada`)—los tres movimientos que `mutations.ts` hacía sin
  escribir bitácora, justo lo que prohíbe la invariante "ningún lead
  invisible"—, con `to_kind` calculado UNA sola vez para todas las filas
  que caigan en el mismo UPDATE (para no contradecirse entre sí; como
  mucho dos de las tres disparan juntas) y `created_by` resuelto por
  `auth.uid()` (`'user'` con sesión, `'system'` sin ella: un script SQL
  directo, el `on delete set null` al borrar un asesor, o la carrera del
  UPDATE ciego de `escalate.ts:84` corriendo con `service_role`).
  `reclamado` ya vivía en el CHECK desde `20260830040000` sin que nadie lo
  escribiera de verdad hasta esta migración. **Corrección post-revisión del
  mismo 16/9/2026 (`/code-review high`):** `v_to_kind` mira PRIMERO
  `new.status = 'closed'` —antes de mirar quién quedó asignado—, porque
  desasignar (o el `on delete set null` de un asesor borrado) un chat YA
  CERRADO daba `'unassigned'` y `unassigned_waiting_count()` lo contaba en
  "Sin dueño" aunque estuviera cerrado; y aplicar esta migración a mano
  exige `psql -1 -v ON_ERROR_STOP=1` (ver docs/PRODUCCION.md) porque `set
  local lock_timeout` fuera de una transacción es un NO-OP silencioso y una
  falla a mitad de archivo sin `ON_ERROR_STOP` deja el trigger AFTER
  leyendo una columna que la sentencia siguiente nunca llegó a crear.
---

# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test            # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
rtk uv run <cmd>        # Compact uv project command output
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

## Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history       # View command history with savings
rtk discover             # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>          # Run command without filtering (for debugging)
rtk init                 # Add RTK instructions to CLAUDE.md
rtk init --global        # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.

@AGENTS.md
