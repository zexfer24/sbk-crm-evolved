# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# SBK Motorcycles CRM

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
