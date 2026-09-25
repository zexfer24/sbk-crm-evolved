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
   atraso). Desde el 22/9/2026 (T4, plan "Nada se pierde en un corte ni en
   un deploy") la misma ruta, DESPUÉS de reconciliar y drenar, purga una vez
   al día lo de `agent_turn_calls` más viejo que 90 días (`agent_turn_calls_
   purge`, lock en Redis `telemetria:purga:<fecha>` para que dos disparos
   del cron no purguen dos veces el mismo día) — nunca lanza ni frena la
   cola, un fallo de Redis o de la RPC solo deja `log.warn`.
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
copia intermedia. Desde el 25/9/2026 (migración `20260925010000`) esa tabla
es de solo lectura para la app salvo `weight_kg`: Saint (vía la réplica
Liminal) es su único dueño real — ver la trampa `products` es de solo
lectura…, más abajo.

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
  7/9/2026). **CORREGIDO el 22/9/2026 (T5, plan "Nada se pierde en un corte
  ni en un deploy"): el título de esta viñeta hasta esa fecha decía
  "`AI_AGENT_REASONING=off` cuando el modelo no razona" y daba por cierto
  que producción corría `gpt-5.6-luna` vía OpenRouter sin razonar (el SDK
  avisaba `reasoningEffort is not supported` 3-4 veces por turno, 8/9/2026,
  y de ahí se asumió que el esfuerzo simplemente no se aplicaba). Es FALSO:
  ese warning era de OTRA versión del SDK; con `@ai-sdk/openai@4.0.43` (el
  instalado), Luna SÍ es modelo de razonamiento (`isReasoningModel` la
  detecta por el id, major ≥ 5) y razona con el default del proveedor
  aunque `AI_AGENT_REASONING=off` esté puesto — medido el 21/9/2026: 58,5 %
  de la salida de Luna es razonamiento con `off`. Ver la trampa de
  `AI_AGENT_REASONING` más abajo (misma fecha) para el estado real, el
  valor `none` que sí lo apaga y dónde se mide.** Un `fetch failed` hacia
  Meta es `origenDelFallo: "red"` → traspaso `entrega_fallida`, no
  `rechazado_por_meta`; lo reencola el reconciliador.
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
- **El corte "habló hoy" de la bandeja tiene UNA sola fuente, y desde el
  18/9/2026 la fórmula es "habló hoy **o** no leída"** (T1 de "Seis frentes
  del buzón", 8/9/2026; reescrita por R1 del plan "Nada sin leer, un solo
  catálogo y la factura Saint", 18/9/2026). `useInboxDay(scope)`
  (`use-inbox-day.ts`, vive en `crm-shell.tsx`) calcula la medianoche de
  Caracas con `currentDayRange` y ese MISMO string sigue viajando a
  `FetchConversationsOptions.since`/`fetchInboxCounts`/
  `fetchUnassignedConversations` — cambió la fórmula que arma cada consulta
  con ese string, no el número de relojes. Hasta el 18/9 la fórmula tenía
  solo dos términos (`last_message_at >= hoy` O sin `last_message_at` con
  `created_at >= hoy`) y un chat con mensajes SIN LEER se esfumaba de la
  bandeja "solo hoy" apenas su último mensaje quedaba fuera del día — "si el
  mensaje no está leído, no importa eso" fue el pedido literal del cliente.
  `dayCutGroup(since)` (`data.ts`) arma ahora el grupo OR de CUATRO
  términos —los dos de siempre más `unread_count > 0` y `manually_unread`,
  sin ninguna condición de fecha— que usan `fetchConversationRows` y
  `fetchInboxCounts`. En memoria, `passesDayCut(conversation, dayStart,
  keepId?)` (`inbox-filters.ts`) es quien de verdad decide qué pinta la
  bandeja: envuelve a `matchesDay` con dos excepciones, sin leer (`isUnread`)
  y la conversación SELECCIONADA (`keepId`, que `inbox-sidebar.tsx` llena
  con `selectedId`, D2) — sin la segunda, `markRead` borraría de la lista al
  chat viejo que el asesor está mirando en el momento en que se marca
  leído. `matchesDay` **no cambió de significado** (sigue siendo, nada más,
  "habló hoy") y la copia privada de `dashboard.ts` (el Recorrido, sin
  noción de "leído") tampoco se tocó — la reforma es de la bandeja, no del
  corte de fecha en sí. En los conteos, `unread`/`mineUnread` DEJARON de
  cruzar el grupo de día: una fila no leída ya lo pasa sola, y cruzarlo ahí
  era justo lo que hacía desaparecer del CONTEO "No leídas" una conversación
  no leída cuyo último mensaje quedaba fuera de "hoy" — el mismo agujero que
  la lista tenía, pero en el número de la píldora. El `EXPLAIN ANALYZE`
  local del 18/9 (28 filas de la base sembrada) NO fue concluyente para
  saber si el planner cae en `BitmapOr` sobre `conversations_unread_pill_idx`
  o en `Seq Scan`: falta medirlo en producción, con volumen real, tras el
  deploy. No recalcular la medianoche en ningún otro sitio: dos relojes
  desalineados hacen que un chat entre en la lista pero no en el conteo. La
  búsqueda ignora el corte a propósito; el interruptor "Ver todo" se guarda
  por visor en `localStorage` (`sbk.inbox.scope.<agentId>`).
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
  en la base. **SUPERADO a medias el 18/9/2026 ("Seba atiende el
  mostrador", D2/T4): la escalada YA NO apaga `ai_enabled`** (ver la
  trampa "La escalada ya no apaga a Seba" más abajo), así que el freno
  contra el reencolado deja de ser `ai_enabled = false` — pasa a ser el
  predicado nuevo del reconciliador (`.or("last_message_direction.eq.
  inbound,last_message_status.eq.failed")`) más la rama `alreadyAssigned`
  de `escalate.ts`, que no vuelve a reclamar a un asesor distinto en cada
  pregunta. El resto de este párrafo (marca `is_auto_reply`, cuenta
  atascados en "Con asesor") sigue vigente tal cual.
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
  que el saludo no depende de nada configurable. **SUPERADO el 18/9/2026
  ("Seba atiende el mostrador", T2b, requisito 1 del cliente): el saludo
  salió del prompt POR COMPLETO.** `needsGreeting` se retira; `prompt.ts`
  pierde los imports `dayBand`/`greetingFor` y el helper `capitalizar`, y
  `TurnContext` pasa a llevar `introducedThisTurn: boolean` (semántica
  invertida: `true` solo cuando Seba se presentó EN ESTE MISMO TURNO). El
  saludo estricto que pidió el cliente ("Hola, buen día, mi nombre es
  Seba…") ya no lo redacta el modelo ni el sufijo: lo manda el TURNO
  (`agent.ts`) como mensaje de texto propio, ANTES de fase 0/1 y del tool
  loop, con `sebaGreeting(dayBand(now))` (`seba.ts`) — ver la trampa "Seba
  se presenta por código" más abajo. La franja SÍ volvió (el 18/9 no
  repite el bug del 14/9: sigue sin vivir en `turnClockLine`, que sigue sin
  franja a propósito), pero ahora nace en `seba.ts`, no en `prompt.ts`.
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
  una razón desconocida cuenta como cierre y la IA atiende. **"`openTurn`
  corta antes con `asignada`" dejó de ser cierto el 18/9/2026** ("Seba
  atiende el mostrador", D2/T4, requisito 6 del cliente): las dos guardas
  de apertura de `runAgentTurn` se fusionan en `if (!convo.ai_enabled)`
  —un chat asignado con la IA ENCENDIDA ya no corta ahí—, así que la rama
  `toKind: "human"` de esta guarda de cortesía deja de ser defensiva: un
  cliente que agradece con la escalada todavía abierta Y un asesor ya
  asignado ahora sí puede toparse con ella de verdad (antes solo la
  alcanzaba el caso "sin asesor" de la devolución masiva). `escalationOpen`
  no cambió: sigue mirando la última fila que cambia de manos, y
  `silenciada_por_asesor` (ver más abajo) se suma a las razones que SÍ
  cierran la escalada.
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
- **Seba se presenta por CÓDIGO, no por el prompt, y `welcome_sent_at` es
  el sello — excluyente con `WHATSAPP_WELCOME_TEMPLATE`** (T2b, plan "Seba
  atiende el mostrador", 18/9/2026, requisito 1 del cliente). El saludo
  estricto ("Hola, buen día, mi nombre es Seba. Soy tu asistente el día de
  hoy en SBK MOTORS, ¿cómo puedo ayudarte?") lo manda `agent.ts` como
  mensaje de texto propio, por `deliver()`, ANTES de fase 0, fase 1 y el
  tool loop — nunca el modelo. `claimPresentation` (`UPDATE conversations
  SET welcome_sent_at = now() WHERE id = ? AND welcome_sent_at IS NULL
  RETURNING id`) reclama el sello ANTES de mandar nada; si el envío falla
  o Meta lo rechaza, se revierte a `null` (mismo patrón que
  `bienvenida_rechazada_por_meta`). Si el cliente solo saludó
  (`isGreetingOnly`/`isCourtesyOnly`), el saludo de Seba ES la respuesta
  completa del turno y se cierra sin llamar a fase 0/1 ni al tool loop —
  tres llamadas al proveedor ahorradas. La migración `20260917010000`
  reescribe la SEMÁNTICA de `welcome_sent_at`: hasta esa migración
  significaba "última vez que salió la PLANTILLA de bienvenida de
  WhatsApp" (`WHATSAPP_WELCOME_TEMPLATE`, vacía desde siempre — esa
  semántica nunca se usó de verdad) y ahora significa "Seba ya se
  presentó en esta conversación". Backfill: `coalesce(last_reply_at,
  last_message_at, created_at)` —nunca `now()`— para todo chat con
  `has_reply` (vitalicio); un chat que JAMÁS recibió nada queda en `null`
  a propósito, porque la próxima vez que hable con ese cliente es, de
  verdad, la primera. **Las dos semánticas son EXCLUYENTES por diseño**:
  si algún día se configura `WHATSAPP_WELCOME_TEMPLATE`, `claimWelcome`
  (`route.ts:316`) sellaría `welcome_sent_at` ANTES de que corra el turno
  y Seba ya no tendría nada que reclamar — no se puede tener la plantilla
  automática de Meta Y el saludo literal de Seba a la vez con la columna
  actual. El webhook pone `welcome_sent_at: null` al reabrir un chat
  cerrado (T2b, ver más abajo): el chat arranca de cero y Seba se
  presenta de nuevo.
- **La escalada ya NO apaga a Seba; lo que la apaga es un mensaje REAL del
  asesor, por trigger** (T4, D2/D3, requisito 6 del cliente, 18/9/2026).
  `escalate.ts` dejó de tocar `ai_enabled` en su `UPDATE` — asignar un
  asesor ya no significa silenciar la IA: Seba sigue contestando en ese
  chat (con o sin existencia, listas, dudas nuevas) hasta que alguien
  humano le escriba de verdad al cliente. Lo que apaga `ai_enabled` es el
  trigger nuevo `handle_agent_message_silences_ai()` (`AFTER INSERT ON
  messages`, migración `20260917010000`), que dispara SOLO con
  `sender_type = 'agent' AND direction = 'outbound' AND NOT
  is_internal_note` — una nota interna NO apaga nada, sigue sin ser una
  respuesta al cliente. También la apaga la pausa manual
  (`setAiEnabled(false)`, `mutations.ts`), que hasta esta migración no
  dejaba ninguna fila en la bitácora. Los dos caminos comparten la rama
  nueva `silenciada_por_asesor` de `handle_conversation_ownership_change`
  — **desvío aceptado sobre el diseño original de T0, hallado corriendo el
  test SQL contra la primera versión de la migración**: la rama exige
  además `old.assigned_agent_id IS NOT DISTINCT FROM new.assigned_agent_id`
  (que `assigned_agent_id` NO cambie en el MISMO `UPDATE`), porque la
  escalada de hoy todavía cambia `ai_enabled` y `assigned_agent_id` juntos
  en un solo `UPDATE` (hasta que una tarea futura la reforme) y sin esa
  guarda cada escalada dejaría una fila `silenciada_por_asesor` espuria
  además de su propia fila `escalada`. `silenciada_por_asesor` SÍ cierra
  una escalada abierta para `escalationOpen()` — un humano tomó el chat de
  verdad —, así que NO está en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`.
  **Actualizado el 19/9/2026 (T10, plan "Seba sale sin pisar a nadie",
  decisión D-A):** hay un TERCER camino que apaga `ai_enabled`, y no pasa
  por el trigger de mensajes de arriba. `assignToMe`/`intervene`
  (`mutations.ts`) hacen su propio `UPDATE` explícito de `ai_enabled =
  false` (`silenceAiForManualTakeover`), en una sentencia APARTE de la que
  mueve `assigned_agent_id` — necesario porque, si fuera el mismo `UPDATE`,
  el trigger no dejaría ninguna fila (ni `reclamado` ni
  `silenciada_por_asesor`) en `conversation_handoffs`. Motivo: con la
  guarda de apertura fusionada en `if (!convo.ai_enabled)` (este mismo
  párrafo, arriba), un chat asignado A MANO con la IA todavía encendida ya
  no cortaba el turno — un asesor que pulsaba "Asignarme"/"Intervenir" y
  tardaba en escribir veía a Seba contestar primero. Ver la trampa de
  `assignToMe`/`intervene` más abajo para el detalle completo y el UPDATE
  operativo que hizo falta para los chats tomados a mano ANTES de este
  código.
- **`reclamado` exige sesión real desde el 18/9/2026 — sin `auth.uid() is
  not null`, cada escalada de Seba dejaría una fila `reclamado` espuria**
  (T0, hallazgo 1 del plan "Seba atiende el mostrador"). La rama
  `reclamado` de `handle_conversation_ownership_change` decía "el asesor
  asignado cambió sin que `ai_enabled` cambiara en el mismo `UPDATE`" —
  exactamente lo que la escalada de Seba iba a hacer con D2 (cambiar SOLO
  `assigned_agent_id`, dejando `ai_enabled` intacto). La escalada corre
  con `service_role`, sin sesión de ningún asesor (ver "código de
  servidor no es sinónimo de `service_role`" más arriba), así que
  `auth.uid()` da `null` ahí; un asesor reclamando de verdad desde el
  panel (`assignToMe`/`intervene`, `mutations.ts`) SÍ trae sesión. Sin
  este candado el caso 1 de `tests/devolucion_a_la_ia.sql` ("escalada
  simulada no deja fila") se habría puesto en rojo apenas saliera T4;
  `tests/seba_y_escalada_viva.sql` (casos 1 y 2) prueba las dos ramas.
- **El reconciliador y "el último mensaje VISIBLE" — el freno nuevo contra
  el bucle nocturno de Seba** (hallazgo 2 del plan, 18/9/2026). Con D2 (la
  escalada ya no apaga la IA) y P1 (de noche o domingo, sin asesores
  conectados, Seba sigue vendiendo), una `escalada_sin_asesor` deja
  `awaiting_reply = true` con la IA encendida y nadie asignado — y el
  sello `ai_resume_cutoff_at` no se mueve, porque no hubo ninguna
  devolución. Sin un freno más, `reconciler.ts` (y el botón "encender la
  IA" de `unansweredFreeWork`, `data.ts`) volvían a encontrar esa misma
  conversación "esperando, sin asesor, con la IA encendida" cada minuto,
  la reencolaban, y el modelo volvía a escalar el MISMO mensaje del
  cliente — para siempre, hasta que alguien escribiera. El freno:
  `.or("last_message_direction.eq.inbound,last_message_status.eq.failed")`
  sumado al `.eq("new_since_ai_resume", true)` que ya existía — solo
  reencola si el ÚLTIMO mensaje VISIBLE de la conversación es del cliente
  (la despedida de Seba con `is_auto_reply` sigue siendo un saliente, no
  cuenta) o si el último saliente FALLÓ (`entrega_fallida`, el caso de
  siempre). Una despedida que salió bien se queda quieta: el
  reconciliador no reintenta una escalada que ya se hizo, solo turnos
  huérfanos de verdad. Mismo predicado, mismo motivo, en `data.ts`
  (`unansweredFreeWork`) — `reconciler.ts` no lo importa de ahí porque esa
  función no está exportada y `data.ts` lo tocaba en paralelo otra tarea;
  si el predicado de un lado cambia, hay que tocar el otro a mano.
- **Escalar un chat YA asignado no reclama a otro asesor ni deja traspaso
  nuevo — solo una nota de reiteración** (T4, hallazgo 3 del plan,
  18/9/2026). Con la IA encendida tras escalar, el modelo puede volver a
  llamar a `escalarAAsesor` en cada consulta de inventario del mismo chat
  (las reglas de "repuesto encontrado"/"stock 0" escalan siempre, con o
  sin existencia): sin esta rama, cada pregunta nueva le habría quitado el
  chat al asesor que ya lo tenía para dárselo a otro por round-robin.
  `escalateConversation` (`escalate.ts`) lee `assigned_agent_id`/
  `ai_enabled` ANTES de reclamar; si ya hay asesor, NO llama a
  `claimNextAvailableAgent`, actualiza `deal_status` solo si el motivo es
  `intencion_compra`, deja una nota interna ("IA reiteró la escalada a
  X…") y devuelve `alreadyAssigned: true` SIN `recordHandoff` — el aviso
  de asignación (`assignment-notice.ts`) solo dispara con la razón
  `escalada`, y repetirla en cada pregunta lo haría saltar sin que nada
  cambiara de dueño de verdad.
- **Toda salida de Seba mientras hay un asesor asignado es `is_auto_reply`,
  y `stageFor` evita que el chat se caiga de "Escaladas" mientras el turno
  trabaja** (T4, 18/9/2026). Con D2, un chat asignado ya no corta el turno
  (ver la trampa de la guarda de cortesía, más arriba): `runTurnPhases`
  calcula `const esperandoAsesor = Boolean(assignedAgentId)` y lo suma con
  OR a cada `isAutoReply` de las salidas que hablan de verdad —la
  redacción final del tool loop, la redirección de fuera de tema, y
  `runPlaybook` (nuevo cuarto parámetro `opciones` de `sendPlaybookReply`,
  `send.ts`)— para que ninguna cortesía de Seba apague `awaiting_reply` en
  un chat que sigue esperando a esa persona. `stageFor(assignedAgentId,
  etapa)` (`assignedAgentId ? "assigned" : etapa`) reemplaza las seis
  escrituras crudas de `journey_stage` (apertura, inicio de cada
  herramienta, los tres reseteos finales, `runPlaybook`) — sin esto la
  píldora "Escaladas" (`inbox-filters.ts`, que mira el campo `journey_stage`
  CRUDO) perdía el chat apenas el turno arrancaba a clasificar o a correr
  una herramienta.
- **Los tres textos fijos de Seba y la red de seguridad del catálogo viven
  en CÓDIGO, no solo en el prompt — y la regla de la única pregunta**
  (T3, requisitos 2/3/4/5 del cliente, 18/9/2026). `TEXTO_CONFIRMAR_
  INVENTARIO`/`TEXTO_SIN_STOCK`/`TEXTO_NO_IDENTIFICADO` (`seba.ts`) son
  literales byte a byte con lo que dictó el cliente. `CatalogOutcome`
  acumula `ran`/`conExistencia`/`agotados`/`sinResultados`/`generico`
  entre TODAS las llamadas al catálogo del mismo turno (un genérico
  bloquea la red entera aunque otro campo haya quedado en `true`, nunca se
  resetean); precedencia `conExistencia` → `generico` (pregunta de filtro,
  NO escala ese turno — requisito 5, la única pregunta:
  `!motoBrand && !motoModel && (quoted.length > 3 || hayMas)`) → todos en
  cero → sin resultados. Si el modelo llega al final del tool loop sin
  haber escalado por su cuenta, la red de seguridad de `agent.ts` (después
  de la red de devolución/queja, ANTES de la guarda de identidad) escala
  en código con el motivo que corresponda y, si el texto del modelo no
  matchea `/asesor/i`, le anexa el texto fijo — así el texto anexado
  también pasa por `applyIdentityGuard` como cualquier otro. Sin
  `consulta_generica` en el enum: ese caso a propósito NO escala.
- **Lecciones de Seba: el caché del prompt, y por qué
  `products.sinonimos_busqueda` sigue durmiente** (T5/T5c, requisito 7 del
  cliente, decisión P3, 18/9/2026). `ai_lessons` (migración
  `20260917020000`) guarda notas (`kind='nota'`, prosa para el modelo) y
  sinónimos (`kind='sinonimo'`, pares `synonym_from`/`synonym_to` para el
  catálogo) con alcance `global` (default de la UI, decisión P2) o
  `conversacion`. Las lecciones GLOBALES van PEGADAS al final de
  `SYSTEM_PROMPT`, DENTRO del prefijo cacheable (`cacheablePrefix`,
  `prompt.ts`): vacío sin lecciones (el prefijo sigue siendo exactamente
  `SYSTEM_PROMPT`, ni un carácter de más, para no invalidar el caché de
  los turnos que no tienen ninguna) y solo cambia cuando alguien enseña
  algo nuevo, así que se cachea entre turnos igual. Las lecciones de LA
  CONVERSACIÓN ACTUAL van en el SUFIJO (`buildChatLessonsLine`), que nunca
  se cachea. Topes: `MAX_GLOBAL_LESSONS = 15`, `MAX_CHAT_LESSONS = 5`,
  `MAX_LESSON_CHARS = 200` (clip defensivo aunque el CHECK de la base ya
  lo garantice). `fetchTurnLessons` NUNCA lanza — error de la base →
  lecciones vacías + `log.warn("turno_lecciones_no_legibles")`, el turno
  sigue igual. Los sinónimos (P3) los lee `buildCatalogTool` (límite 200,
  `is_active = true`) y los expande con `expandTerms` (`catalog-search.ts`)
  ANTES de armar el filtro del catálogo — jerga del cliente ("pastilla")
  que también encuentra el nombre real ("pastillas de freno"). **A
  propósito NO se reutiliza `products.sinonimos_busqueda`** (columna de
  `20260821000000`, hallazgo 9 del plan): esa columna solo se CUENTA para
  el panel de Inventario (`inventory-data.ts`), nadie la consulta para
  buscar, y sigue así — otra RLS, otro panel, y mezclar las dos fuentes de
  sinónimos no estaba en el alcance de esta corrida.
- **`desasignada_por_asesor` puede salir con `created_by = 'system'`
  cuando es el CLIENTE quien reabre un chat cerrado, no solo cuando un
  asesor lo hace a mano** (T2b, 18/9/2026). El webhook reclama la
  reapertura (`UPDATE conversations SET status='open', ai_enabled=true,
  assigned_agent_id=null, welcome_sent_at=null WHERE id=? AND
  status='closed' RETURNING id` — el `.eq("status","closed")` evita que
  dos webhooks concurrentes del mismo lote de Meta dupliquen el evento).
  Si el chat estaba escalado al cerrarse, ese MISMO `UPDATE` cambia
  `assigned_agent_id`/`ai_enabled` y dispara, DENTRO de
  `handle_conversation_ownership_change`, las ramas
  `desasignada_por_asesor`/`devuelto_a_ia` — con `created_by = 'system'`
  porque nadie con sesión tocó nada (el webhook corre con `service_role`,
  `auth.uid()` da `null`). Se acepta como rastro correcto ("el sistema le
  devolvió el chat a la IA") y la fila explícita `reabierta_por_cliente`
  (`recordHandoff`) queda SIEMPRE última, cerrando cualquier escalada
  vieja que `escalationOpen` pudiera seguir viendo abierta. Este `UPDATE`
  corre ANTES de insertar el mensaje entrante: el trigger BEFORE
  `handle_conversation_ai_resume()` sella `ai_resume_cutoff_at` contra el
  `last_customer_message_at` VIEJO, así que el mensaje que reabrió el chat
  (con `created_at` de Meta, necesariamente posterior) no cae en la guarda
  `mensaje_previo_a_devolucion` — es justo el mensaje que hay que
  contestar, no uno que ya estaba ahí antes.
- **"El repuesto manda": un escenario calzado se CEDE al catálogo cuando la
  intención clasificada es `consulta_disponibilidad`, nunca por su cuenta**
  (H1, "Seba atiende el mostrador", 18/9/2026). Escenario a mano contra la
  base local: "¿tienen pastillas de freno?" y "tienen pastillas de freno
  para bera sbr 2020?" calzaron el escenario del panel "Catálogo general"
  2 de 2 veces y el turno mandó "Claro que sí, por acá te dejo nuestro
  catálogo 👇" sin consultar `products`, sin la pregunta de filtro
  (requisito 5) y sin escalar — `agent_turns.summary` quedó `Escenario
  "Catálogo general".`. En `runTurnPhases` (`agent.ts`), dentro del bloque
  `if (match.playbook) { … if (!yaSalioHacePoco) { … } }`, justo antes de
  `runPlaybook`: `cedeAlCatalogo = classified.ok && classified.result.intent
  === "consulta_disponibilidad"`. La clasificación ya corrió EN PARALELO con
  `matchPlaybook` (T4, "La respuesta llega en siete segundos", 7/9/2026),
  así que preguntarle al resultado no cuesta una llamada extra ni cambia el
  orden de nada. Si `cedeAlCatalogo` es `true`, el escenario NO se manda:
  queda `log.info("escenario_cedido_al_catalogo", { conversationId,
  escenario })` y el turno sigue por el flujo genérico (tool loop, T3 de
  esta misma corrida: catálogo real, textos fijos, escalada). Si la
  clasificación falló (`!classified.ok`) o la intención es otra
  (`otro`/`devolucion`/`queja`/`fuera_de_tema`), el escenario sale igual que
  siempre — el costo de la clasificación descartada ya se contaba en
  `classifiedTokens` ANTES de esta rama, sin cambios. Efecto colateral en
  `agent.test.ts`: el default de fábrica de `classifyIntentMock` en el
  `beforeEach` global pasó de `"consulta_disponibilidad"` a `"otro"` — con
  el default viejo, los ~20 tests de escenarios del archivo (que solo
  prueban "calzó/no se repite/etiqueta" y nunca les importó la intención)
  se habrían puesto rojos por esta regla sin tener nada que ver con ella;
  "otro" es el valor neutro del clasificador y no dispara ninguna rama
  especial. Un test nuevo pide `consulta_disponibilidad` explícitamente
  para probar el cede. **(Actualizado el 21/9/2026, plan "El catálogo
  configurado sale siempre"): "cedeAlCatalogo" pasó a exigir CUATRO
  condiciones, no una.** Un reporte de solo lectura de producción (VPS,
  21/9/2026, producción todavía en `3802fad`, sin desplegar H1) midió que
  "CATALOGO CASCOS" (535 usos) y "Catálogo general" (161) en 15 días eran
  el segundo motivo de contacto del negocio, el 30 % de las respuestas
  predeterminadas — y que `buscar_repuesto` está APAGADA en producción
  desde el 25/8. Desplegar H1 tal cual habría cedido esos pedidos a un
  inventario apagado ("precios de los cascos" → escalada, en vez del PDF
  que el escenario ya traía redactado). Las cuatro condiciones, TODAS a la
  vez: (1) intención `consulta_disponibilidad` (esta, la de arriba); (2) la
  herramienta `buscar_repuesto` está encendida (`agent_tools`, código,
  `agent.ts`); (3) el mensaje del cliente —la ráfaga completa,
  `customerBurst`— NO pide el catálogo (`pideCatalogo`,
  `catalog-request.ts`); (4) el escenario tiene
  `ai_playbooks.cede_al_inventario = true` (columna nueva, migración
  `20260921010000`, default `false` — del catálogo real, SOLO "Catálogo
  general" la lleva en `true`; "CATALOGO CASCOS" queda en `false`
  explícito porque su disparador es específico, no compite con una
  consulta de inventario ancha). Se despliega con `buscar_repuesto`
  apagada (igual que hoy en producción): la condición (2) sola ya frena
  cualquier cesión el día del deploy, hasta que el operador la encienda a
  mano desde Control IA (ver `docs/PRODUCCION.md` §11, "Al encender la
  consulta de productos").
- **La reapertura por el cliente "salta la gracia" de `AI_HUMAN_GRACE_MINUTES`,
  y un test que ejercita `runAgentTurn`/`reconcileOrphanTurns` de verdad
  necesita un fake de `conversation_handoffs` con la forma de
  `humanHasWritten`** (H2, "Seba atiende el mostrador", 18/9/2026). Caso
  real, escenario a mano en local: un asesor escribió en un chat escalado,
  el chat se cerró y el cliente volvió a escribir a los pocos segundos; el
  webhook reabrió bien (IA encendida, sin asesor, `welcome_sent_at` en
  null) pero el turno salió por `humano_intervino` —la cláusula de gracia
  vio el mensaje del asesor ANTERIOR al cierre—, así que Seba no saludaba
  hasta 30 min después y quedaba un traspaso `to_kind = 'human'` en un chat
  que ya no tenía asesor. Ahora `humanClaimsChat` (`human-handled.ts`)
  descuenta de la gracia todo mensaje de asesor anterior (o igual) a la
  última fila `reabierta_por_cliente` de esa conversación: el chat
  reabierto arranca de cero, como manda D2. La cláusula "el asesor se
  adelantó al cliente" NO mira la reapertura. `humanHasWritten` y
  `conversationsWrittenByHumans` consultan `conversation_handoffs` SOLO
  cuando la gracia iba a disparar, y ante error de esa consulta fallan
  cerrado (la gracia bloquea como antes) con `console.error`, no con
  `lib/log.ts`: `human-handled.ts` no puede importar nada `server-only`
  porque `data.ts` lo importa y llega al bundle del navegador. La forma de
  la consulta es `.eq(conversation_id).eq(reason).order().limit()`,
  DISTINTA de la de `escalationOpen` (`.eq().not().order().limit()
  .maybeSingle()`): al implementarla rompió a la vez los fakes de
  `agent.test.ts`, `handoffs.test.ts` y `reconciler.test.ts`.
- **Los enlaces de catálogo viven en UNA tabla, `public.catalog_links`, y se
  consumen por MARCADOR — nunca copiando la URL** (D3/D4, plan "Nada sin
  leer, un solo catálogo y la factura Saint", 18/9/2026). Una URL de Google
  Drive pegada a mano dentro de `response_text`/`content` es el BUG que este
  plan corrigió, no un dato legítimo: el catálogo de cascos tuvo CUATRO IDs
  de Drive distintos en 25 días y el 18/9/2026 circulaban DOS versiones a la
  vez (la IA con una URL, el mensaje rápido "Catalogo general" con otra)
  porque la URL vivía copiada en más de un sitio. `{{catalogo:<key>}}`
  resuelve a la URL de un catálogo puntual; `{{catalogos}}` a la lista
  completa de activos, en orden (`resolveCatalogMarkers`,
  `src/lib/catalog-links.ts`). Un marcador SIN RESOLVER —clave inactiva o
  inexistente— nunca llega al cliente por ninguna de las dos vías, pero cada
  una lo maneja distinto: fase 0 (`matchPlaybook`, `playbooks.ts`) SACA el
  escenario de los candidatos ANTES de llamar al modelo (log
  `escenarios_enlace_sin_resolver`, mismo patrón que el descarte de
  escenarios que saludan); el composer, al usar un mensaje rápido, PEGA el
  marcador tal cual y avisa con `toast.warning` — el asesor lo ve antes de
  enviar y decide. `{{catalogos}}` con CERO catálogos activos también cuenta
  como sin resolver (clave sintética `"catalogos"`): no se reemplaza por una
  lista vacía, que habría mandado "Ver también: " sin nada detrás. Detalle
  de implementación con trampa propia: `CATALOG_MARKER`/`CATALOG_LIST_MARKER`
  son regex de MÓDULO con flag `g` — seguras con `.replace()` (la spec
  reinicia `lastIndex` en cada llamada) pero NO con `.test()`/`.exec()`
  repetidos sobre el mismo objeto, que arrastran `lastIndex` entre llamadas
  y pueden devolver falsos negativos a partir de la segunda. `send.ts`
  resuelve los marcadores con los enlaces ACTIVOS leídos al arrancar el
  turno, y `alreadySentPlaybook` compara el texto YA RESUELTO: si un
  supervisor cambia la URL de un catálogo entre dos turnos, un escenario que
  ya se había mandado puede repetirse una vez, con el enlace nuevo —
  aceptado y documentado en el plan, no un bug. **Un marcador MAL ESCRITO
  cuenta como sin resolver, no como texto normal** (corrección de la
  revisión `code-review high`, 19/9/2026): `{{catalogo:cascos_nuevos}}` (guion
  bajo), `{{catalogo: exploradoras y bombillos}}` (espacios), `{{catalogo}}`/
  `{{catalogo:}}` (sin clave) o `{{catalogo:cascos` (sin cerrar) no calzan la
  regex estricta —exige una clave `[a-z0-9-]+`— así que antes de esta
  corrección `missing` quedaba `[]` y ese texto crudo se fugaba tal cual al
  cliente. `resolveCatalogMarkers` suma un paso final, solo para DETECTAR
  (`LOOSE_UNRESOLVED_MARKER`, nunca reemplaza nada): cualquier resto que
  huela a `{{catalogo…}}` después de resolver los marcadores bien formados
  entra a `missing` con su texto crudo recortado a 60 caracteres. **La clave
  de un catálogo NO se puede editar** (mismo commit): al editar, el campo
  quedaba de solo lectura desde `catalog-links-panel.tsx` — cambiarla
  rompería en silencio todos los escenarios y mensajes rápidos que ya la
  referencian; para "renombrar" hay que crear un catálogo nuevo. Desactivar
  (no solo borrar) sigue ahora el mismo patrón "armar y confirmar", contando
  también `{{catalogos}}` cuando el catálogo es el ÚLTIMO activo. La carga
  inicial de los catálogos de producción es un SCRIPT revisado
  (`scripts/sql/2026-09-18-catalogos-iniciales.sql`), no una migración —"el
  contenido es del cliente, no del repo"—: llega con huecos `<<...>>` que
  el Claude del VPS completa contra la base real, y una guarda propia
  aborta el script entero si queda alguno sin completar; se corre DESPUÉS
  del deploy del código, nunca antes (un marcador sin código que lo
  resuelva es peor que la URL vieja que reemplaza). **"Ubicación" queda
  FUERA de ese script a propósito** (corrección del 19/9/2026, antes cargaba
  8 catálogos y tocaba 3 escenarios): meter el Maps de la tienda en
  `catalog_links` lo colaba dentro de `{{catalogos}}` —`formatCatalogList`
  lista TODO enlace activo, mezclando la ubicación con los catálogos de
  repuestos— y el Maps no tiene el problema de rotación de IDs que esta
  tabla resuelve; el escenario "Ubicación" conserva su URL escrita a mano y
  el script no lo toca (7 catálogos, 2 escenarios). Cada `update` del script
  corre dentro de su propio `do $$ ... $$` para poder leer `get diagnostics
  ... = row_count` en el mismo bloque y abortar si no coincide con el
  tamaño de su tabla de relleno —antes un `id` de otra base afectaba CERO
  filas sin que nada lo notara, porque el chequeo final unía por ese mismo
  `id` y un `join` contra una fila inexistente no suma nada al conteo de
  "pendientes". `agent.ts` lee los catálogos con `fetchTurnCatalogLinks`
  (`src/lib/ai/catalog-links.ts`, corrección del 19/9/2026), NO con
  `fetchActiveCatalogLinks` de `data.ts`: la de `data.ts` también la usa el
  navegador y avisa sus errores con `console.error` (no puede importar
  `lib/log.ts` sin arrastrarlo al bundle del cliente); la de `agent.ts`
  nunca lanza y avisa con `log.warn("turno_enlaces_no_legibles")` — antes
  una lectura fallida se perdía en la consola del servidor sin dejar rastro
  en la bitácora, y el único síntoma visible era `escenarios_enlace_sin_resolver`
  culpando a la configuración del escenario. Cualquier test que ejercite
  `runAgentTurn`/`reconcileOrphanTurns` de verdad con un fake de Supabase
  necesita el caso `catalog_links` en su `from()` —sin él, ninguna de las
  dos funciones distingue "tabla no simulada" de "sin catálogos" y el fake
  explota o miente en silencio— (ver `agent.test.ts`). **Actualizado el
  21/9/2026 (T1, plan "Los catálogos se cargan a mano desde el panel; el
  script pasa a ser opcional"): la carga inicial deja de ser un paso
  obligatorio del despliegue.** El operador decidió cargar cada catálogo a
  mano desde el panel una vez que el código estuviera en producción (clave,
  etiqueta y URL primero; recién después reemplazar la URL pegada a mano
  por su marcador en el escenario/mensaje rápido) — el script sigue en el
  repo como alternativa opcional para una carga masiva, sin tocar, y el
  Claude del VPS no lo corre salvo pedido explícito del operador; ver
  `docs/PRODUCCION.md` §11, paso 10.
- **`orders.saint_invoice_number` es nullable en la base y OBLIGATORIO en el
  modal y en la mutación** (D9-D11, plan "Nada sin leer, un solo catálogo y
  la factura Saint", 18/9/2026). Nullable porque las ventas cerradas antes
  del 18/9/2026 no tienen ese dato y no hay forma de reconstruirlo
  retroactivamente; obligatorio desde `close-sale-modal.tsx` (D10,
  validación por campo con `validateSaleDraft`, `src/lib/sale-draft.ts`) y
  otra vez, como SEGUNDA barrera, dentro de `closeSaleWithContactInfo`
  (`mutations.ts`) antes de escribir nada — la validación del modal no
  alcanza sola porque esa función se puede llamar desde cualquier otro
  lado. Ojo con la colisión de nombres: **NO es `invoices.number`**, el
  correlativo INTERNO del CRM ("SBK-000123"); son dos numeraciones de dos
  sistemas distintos, Saint es el sistema administrativo del negocio. Sin
  restricción de UNICIDAD a propósito: una factura Saint puede cubrir más
  de un chat, y un rechazo por duplicado en el mostrador confundiría más de
  lo que protege. El carrito vacío sigue avisando con un toast en vez de un
  mensaje bajo un campo — no es uno de los nueve campos obligatorios porque
  no tiene un único `<input>` al que atarle un error de formulario. El
  asterisco de "obligatorio" en las nueve etiquetas es CSS puro
  (`.lm-required::after`, `theme.css`), nunca texto real dentro del
  `<Label>`, precisamente para no romper `getByLabelText("Nombre")` de los
  tests existentes — un asterisco de verdad en el DOM cambia el nombre
  accesible del campo.
- **El carrito vacío también lanza dentro de la mutación, y los errores por
  campo se limpian por campo, no todos juntos** (corrección R2, revisión
  `code-review high` del 19/9/2026, sobre el plan de arriba). Hasta esa
  revisión `closeSaleWithContactInfo` frenaba el carrito vacío con un `if`
  suelto, sin relación con `validateSaleDraft` — y encima le pasaba
  `itemCount` a esa función sin que `validateSaleDraft` lo mirara nunca, un
  parámetro muerto que sugería una protección que no existía ahí. Ahora
  `validateSaleCart(itemCount): string | null` (`sale-draft.ts`) es la ÚNICA
  fuente de esa regla y la corren los DOS lados: el toast del modal y
  `closeSaleWithContactInfo` como segunda barrera real, antes de escribir
  una sola fila — un llamador nuevo que se salte el modal no puede crear una
  orden de $0,00 con venta `won`. Aparte, hasta esa misma revisión `errors`
  (D10) solo se recalculaba ENTERO al intentar guardar: corregir un campo no
  borraba su propio mensaje hasta el próximo intento, y como el modal no se
  desmonta al cerrarse (sigue vivo con `isOpen=false`), reabrirlo dejaba los
  errores de la vez anterior pegados en pantalla. `clearFieldError(field)`
  borra SOLO el error de un campo cuando cambia (nunca revalida el resto:
  no hay que pintarle un error a un campo que el asesor todavía no tocó), y
  el reseteo al reabrir sigue el patrón "Adjusting state when a prop
  changes" de React —comparar `isOpen` contra una copia en estado y limpiar
  `errors` DURANTE el render— en vez de un `setState` síncrono dentro de un
  `useEffect`, que dispara `react-hooks/set-state-in-effect`.
- **Tomar un chat a mano apaga a Seba con DOS `UPDATE` en serie, nunca uno
  — y el código nuevo no alcanza a los chats ya tomados ANTES del deploy**
  (T10/C1, plan "Seba sale sin pisar a nadie", 19/9/2026). Hasta esta
  corrida, `assignToMe`/`intervene` (`mutations.ts`) solo escribían
  `assigned_agent_id`; con la guarda de apertura del turno fusionada en
  `if (!convo.ai_enabled)` desde "Seba atiende el mostrador" (18/9/2026),
  eso dejó de bastar para frenarlo — un asesor que pulsaba
  "Asignarme"/"Intervenir" y tardaba dos minutos en escribir veía a Seba
  contestar primero, en chats que la persona ya había tomado por su cuenta
  (el requisito 6 del cliente, "Seba sigue hasta que el asesor escriba",
  habla de los chats que SEBA escaló, no de estos). Ahora las dos
  mutaciones hacen un SEGUNDO `UPDATE` propio —
  `silenceAiForManualTakeover(supabase, conversationId,
  previousAssignedAgentId)`, `ai_enabled = false`— DESPUÉS del que mueve
  `assigned_agent_id`, **nunca en el mismo `UPDATE`**: el trigger
  `handle_conversation_ownership_change` (`20260917010000`) solo deja la
  fila `reclamado` si `ai_enabled` no cambia en ESE `UPDATE`, y solo deja
  `silenciada_por_asesor` si `assigned_agent_id` no cambia en el suyo — un
  `UPDATE` conjunto de las dos columnas no habría dejado NINGUNA fila en
  `conversation_handoffs`, contra la invariante "ningún lead invisible".
  **Corrección post-revisión (`code-review high`, 19/9/2026, hallazgo 3):
  la primera versión de este UPDATE, si fallaba, lanzaba directo sin
  ninguna compensación — el chat quedaba ASIGNADO con Seba ENCENDIDA, el
  mismo C1 que T10 existe para cerrar, ahora disparado por un corte de red
  en vez de por el diseño del UPDATE único. "No hay una 'deshacer la
  asignación' que valga la pena ahí" (frase de la primera versión de este
  plan) quedó FALSA.** Ahora `silenceAiForManualTakeover` reintenta el
  apagado UNA vez; si vuelve a fallar, compensa devolviendo
  `assigned_agent_id` al valor que tenía ANTES de la toma manual (leído con
  `readAssignedAgentId` antes de cualquiera de los dos `UPDATE`) y lanza el
  error ORIGINAL igual, para que el asesor vea que la acción no se
  completó — si la propia compensación también falla, se lanza el error
  original de todos modos y queda un `console.error` (este archivo corre en
  el navegador, no puede importar `lib/log.ts`). El orden de los DOS
  `UPDATE` originales no se invierte: apagar la IA primero y fallar el de
  asignar después dejaría el chat SIN asesor Y SIN IA, peor que dejarlo
  asignado con Seba encendida un rato. Este código SOLO protege las
  asignaciones que ocurran DESPUÉS de desplegarlo: para los chats que un
  asesor ya tenía asignados desde antes, hace falta el UPDATE operativo de
  C1 al migrar (`update conversations set ai_enabled = false where
  assigned_agent_id is not null and ai_enabled and status <> 'closed'`, ver
  `docs/PRODUCCION.md` §11) — sin él, Seba seguiría corriendo turnos
  completos en cualquier chat asignado a mano antes del deploy, invisible
  hasta que alguien lo notara en la conversación real.
- **`unassign` reenciende a Seba, pero SOLO si fue el propio tomar-a-mano
  el que la apagó y el asesor nunca le escribió de verdad al cliente**
  (T11, plan "Seba sale sin pisar a nadie", 19/9/2026 — cierra la decisión
  abierta #2 de la revisión `code-review high` del mismo día). El bug sin
  esto: T10 hizo que `assignToMe`/`intervene` apaguen `ai_enabled` con un
  segundo `UPDATE`, pero `unassign` —el mismo interruptor de
  `chat-panel.tsx`, del otro lado— solo tocaba `assigned_agent_id`. Un
  asesor que pulsa "Asignarme" por error y enseguida "Desasignar" dejaba el
  chat SIN dueño Y con Seba APAGADA: el reconciliador exige `ai_enabled =
  true` para reencolar y el turno del webhook sale por `pausada` — mudo
  hasta que alguien note el interruptor apagado. Ahora
  `reenableAiIfAdvisorNeverWrote` (`mutations.ts`) reenciende con un
  SEGUNDO `UPDATE` aparte del que desasigna (mismo motivo que T10: el
  trigger `handle_conversation_ownership_change` deja `desasignada_por_
  asesor` y `devuelto_a_ia` en dos pasos separados, y el BEFORE
  `handle_conversation_ai_resume` sella `ai_resume_cutoff_at`) SOLO si
  las CINCO condiciones se cumplen: la IA estaba apagada, el chat no está
  cerrado, `assigned_at` no es `null`, existe una fila
  `silenciada_por_asesor` con `created_at >= assigned_at` (la apagó el
  PROPIO tomar-a-mano, no una pausa manual de antes de asignarse el chat
  — sin esta condición, un chat pausado a propósito con `setAiEnabled(false)`
  y asignado DESPUÉS, sin que el asesor tocara el interruptor, se
  reencendía al desasignar, pisando una decisión explícita) y el asesor no
  le mandó ningún mensaje real al cliente desde `assignedAt` (mismo
  predicado que apaga la IA por trigger — `sender_type = 'agent'`,
  `direction = 'outbound'`, `is_internal_note = false`; una nota interna
  no cuenta). Consecuencia del sello: al reencenderse, Seba NO contesta el
  mensaje que ya estaba pendiente antes de desasignar —cae en "Sin
  dueño"—, solo los mensajes nuevos, igual que desasignar y reactivar a
  mano por separado ya se comportaba. Cualquier lectura de la cadena que
  falle deja la IA apagada (modo seguro): `console.error`, nunca lanza —
  este archivo corre en el navegador, no puede importar `lib/log.ts`.
  **Límite conocido y aceptado, no corregido:** reencender a mano, volver a
  pausar y desasignar sin escribir, todo con el chat todavía asignado, deja
  una fila `silenciada_por_asesor` indistinguible de la que dejó el propio
  tomar-a-mano — no hay ninguna columna que diga cuál de los tres caminos
  (pausa manual, primer mensaje real del asesor, o `silenceAiForManual
  Takeover`) escribió esa fila, y la IA se reenciende igual; distinguirlo
  exigiría una columna nueva. La OTRA decisión abierta de la misma revisión
  —reencolar el turno tras un `entrega_fallida` post-saludo— la CERRÓ T12
  ("El turno se reintenta solo cuando el proveedor falla después del
  saludo", 19/9/2026): ya no hay ningún `entrega_fallida` post-saludo que
  reencolar a mano — ver esa trampa, más abajo.
- **El turno LANZA si no puede leer la conversación — un 400 de PostgREST
  por una migración faltante ya no se lee como "la conversación no
  existe"** (T1, plan "Seba sale sin pisar a nadie", 19/9/2026, hallazgo
  C2). `runAgentTurn` leía `{ data: conversation }` sin mirar `error`: si
  la fila existía pero el `select` fallaba —por ejemplo, un 400 porque el
  código llegó a producción antes que la migración `20260916010000`, que
  agrega la columna `ai_resume_cutoff_at` que ese mismo `select` pide—,
  `conversation` quedaba `undefined` y el turno caía en la única rama muda
  A PROPÓSITO de la función, pensada para un id borrado por FK, no para un
  corte de infraestructura: sin traspaso, sin log, y la cola contaba el
  turno como resuelto — la IA quedaba muda sin dejar ningún rastro.  Ahora,
  con `error`, `log.error("turno_conversacion_no_consultable", {
  conversationId, detail: errorText(error) })` + `throw` ANTES de
  `entrega.intentado = true`, así que la cola reintenta un fallo
  transitorio en vez de archivarlo como si el lead no existiera. Mismo
  patrón que `turno_interruptor_no_consultable` (14/9/2026), aplicado a la
  otra lectura de arranque del turno; `data === null` SIN error sigue
  yendo por la rama de siempre.
- **Un traspaso `entrega_fallida` cuando el proveedor falla DESPUÉS del
  saludo de Seba — "el reconciliador la recoge sola" dejó de ser cierto el
  18/9/2026** (T2, plan "Seba sale sin pisar a nadie", 19/9/2026, hallazgo
  A2). Las dos salidas mudas del turno —clasificación fallida y el `catch`
  del tool loop— llevaban un comentario que decía, con razón hasta esa
  fecha, "no se escribe un traspaso nuevo… el reconciliador recoge la
  conversación sola porque `awaiting_reply` sigue en `true`". Eso dejó de
  ser cierto cuando Seba empezó a presentarse por código ANTES de fase
  0/1 ("Seba atiende el mostrador", T2b): si el saludo salió EN ESTE
  TURNO, el último mensaje visible de la conversación deja de ser del
  cliente —es un saliente que sí se entregó— y el predicado nuevo del
  reconciliador (`.or("last_message_direction.eq.inbound,last_message_
  status.eq.failed")`, hallazgo 2 de "Seba atiende el mostrador") deja ese
  caso AFUERA para siempre: un lead que recibió el saludo y se quedó sin
  la redacción de verdad, sin traspaso, invisible para "Sin dueño". Ahora,
  SOLO si `introducedThisTurn` es `true`, las dos salidas dejan
  `recordHandoff({ reason: "entrega_fallida", toKind/toId según
  convo.assigned_agent_id })` — decisión D-B del operador: no existe una
  razón "falló el proveedor", y `entrega_fallida` ya significa "falló
  después de haber intentado entregar y no se reintenta para no
  duplicar", que es exactamente este caso, sin necesitar una sexta
  migración con su propio CHECK. Sin saludo previo, el último mensaje
  sigue siendo del cliente y el diagnóstico viejo sigue valiendo tal cual:
  no se escribe nada nuevo. **SUPERADO el 19/9/2026 por T12** ("El turno se
  reintenta solo cuando el proveedor falla después del saludo", cierra la
  decisión abierta #1 del mismo plan): ese `recordHandoff(entrega_fallida)`
  volvía el caso IRRECUPERABLE justo cuando es SEGURO reintentar —lo único
  que salió es la presentación, ya sellada por `claimPresentation`—, así
  que en las dos salidas de arriba, con `introducedThisTurn`, ya NO se
  escribe ese traspaso: se lanza `ProviderFailedAfterGreetingError` en su
  lugar. Ver la trampa nueva de T12, más abajo.
- **`soloSaludo` y la guarda de cortesía tras escalada miran la RÁFAGA
  entera del cliente, no solo la última línea** (T3, plan "Seba sale sin
  pisar a nadie", 19/9/2026, hallazgo A3 más un hallazgo nuevo de la misma
  inspección). La cola agrupa ráfagas de mensajes seguidos antes de correr
  un turno (ver más arriba, "La respuesta llega en siete segundos"): un
  cliente que escribe "Precio del casco LS2" y, dos segundos después,
  "Buenas tardes", le llega al turno como DOS líneas de cliente sin nada
  del CRM entre medio. Las dos guardas leían solo la ÚLTIMA de esas líneas
  (`customerMessage`/`lastCustomerMessage`) y trataban la ráfaga entera
  como si el cliente solo hubiera saludado o agradecido —`soloSaludo`
  mandaba el saludo de Seba y daba el turno por terminado sin contestar la
  pregunta real; la guarda de cortesía ("¿tienen la bomba de aceite?" +
  "gracias" con una escalada abierta) callaba el turno ENTERO—.
  `customerBurst(history)` (`history-line.ts`) junta TODA la ráfaga final
  del cliente —las líneas `user` consecutivas desde el final hasta la
  primera que no lo sea, en orden cronológico—, y las dos guardas pasan a
  exigir que CADA línea de la ráfaga, no solo la última, sea saludo
  (`isGreetingOnly`) o cortesía (`isCourtesyOnly`); un marcador de media en
  la ráfaga no es ni una cosa ni la otra, así que tira la condición a
  `false` sola y el turno sigue de largo, dejando que
  `MEDIA_RULES`/la racha de adjuntos hagan su trabajo. `customerMessage`
  NO cambia de significado: sigue siendo solo la última línea, y sigue
  siendo lo que se guarda en `agent_turns.customer_message`. **Corrección
  post-revisión (`code-review high`, 19/9/2026, hallazgos 4 y 8): la
  primera versión de `customerBurst` no tenía ninguna de las dos guardas
  siguientes.** (1) No acotaba la ráfaga por TIEMPO — retrocedía hasta la
  última línea del ASISTENTE sin mirar el reloj. Caso real: un cliente
  escribe "¿ya me atienden?", nadie contesta (`pausada`), el chat se
  cierra; DÍAS después reabre con "hola". Sin una línea del asistente en el
  medio (el chat estaba cerrado, no silenciado por una respuesta), la
  ráfaga vieja seguía "pegada" a la nueva y Seba habría redactado sobre un
  mensaje de hace días que quedó sin responder A PROPÓSITO.
  `CUSTOMER_BURST_GAP_MINUTES = 10` (`history-line.ts`) corta la ráfaga por
  un hueco de tiempo entre líneas consecutivas del cliente, no solo por una
  respuesta del CRM en el medio; una línea sin fecha parseable (o
  comparada contra una que no la tiene) corta la ráfaga ahí mismo, de forma
  conservadora — mejor perder una línea legítima que arrastrar un mensaje
  viejo dejado sin responder a propósito. (2) Un STICKER del cliente
  (`"[El cliente envió un sticker]"`, `CUSTOMER_STICKER_MARKER`) hacía
  fallar el `every(isCourtesyOnly)` de la guarda de cortesía — "gracias" +
  sticker de pulgar con una escalada abierta ya NO la callaba, y Seba
  mandaba una segunda despedida encima de la primera. Un sticker no es ni
  saludo ni cortesía ni una pregunta (mismo criterio que
  `mediaStreakWithoutText`): `customerBurst` lo salta sin contarlo como
  línea de la ráfaga ni cortarla — ni siquiera mueve la marca de tiempo de
  referencia, como si nunca hubiera estado ahí.
- **`reabierto` también cierra la escalada para `escalationOpen` —
  `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` lo suma** (T8, plan "Seba sale sin
  pisar a nadie", 19/9/2026, hallazgo M6). El reconciliador
  (`reconciler.ts`) escribe `reabierto` CADA VEZ que reencola un turno
  huérfano, sin que nadie cambie de dueño — es "vuelvo a intentar", no una
  decisión nueva sobre a quién pertenece la conversación. Sin sumarla a la
  constante (`handoffs.ts`), un reencolado sobre una escalada abierta
  quedaba como "la última fila que cambia de manos" y tapaba la
  `escalada`/`escalada_sin_asesor` de verdad: `escalationOpen` daba
  `false` y la guarda de cortesía dejaba de disparar, así que la IA podía
  volver a despedirse dos veces sobre un cliente que seguía esperando al
  mismo asesor. Mismo criterio que `asignada`/`pausada`/
  `agente_no_puede_correr`/`cortesia_tras_escalada`/`humano_intervino`/
  `humano_se_adelanto`, ya en la lista.
- **Control IA y Ventas ya tienen `error.tsx`, y en este Next 16.3 la prop
  del boundary es `retry`, no `reset`** (T7, plan "Seba sale sin pisar a
  nadie", 19/9/2026, hallazgo A4). Hasta esta corrida NINGUNA ruta de
  `src/app` tenía un `error.tsx` propio: una lectura que fallara en el
  `Promise.all` de ~19 lecturas de `agent-control/page.tsx`, o en
  `fetchSales` de Ventas, caía en la pantalla 500 genérica de Next, sin
  rail ni forma de volver — el interruptor global de la IA quedaba
  inalcanzable justo cuando algo ya andaba mal. `node_modules/next/dist/
  docs/01-app/03-api-reference/03-file-conventions/error.md` (AGENTS.md:
  este Next no es el de la memoria) confirma `retry` ESTABLE desde la
  16.3.0: reintenta re-pedir y re-renderizar el segmento sin recargar toda
  la pestaña, así que los dos `error.tsx` nuevos (`agent-control/`,
  `ventas/`) usan `retry`, no `reset` (que solo limpia el estado de React
  sin volver a pedir nada — acá el error casi siempre viene de una lectura
  contra Supabase). Los dos replican a mano el marco `.dash` > `.dash-
  frame` > dos hijos directos (`AppRail` + contenido) por la trampa del
  FRAGMENTO del 9/9/2026 — un tercer hijo directo le robaría la columna al
  contenido. En Control IA, además, `readListIfTableExists`
  (`agent-control/degradable-reads.ts`) envuelve las DOS lecturas MÁS
  NUEVAS del panel (`fetchLessons`, `fetchCatalogLinks` — las tablas
  `ai_lessons`/`catalog_links`, que LANZAN si faltan en la base de
  destino) para que degraden solas a `[]` con `console.error` en vez de
  tumbar las otras diecisiete junto con el interruptor global — un
  `error.tsx` solo no alcanza para eso, porque reemplaza la pantalla
  ENTERA, interruptor incluido. En Ventas no hay ninguna lectura que se
  pueda degradar: `saint_invoice_number` viaja DENTRO del `select` de
  `fetchSales`, así que ahí la única salida razonable es el boundary con
  "Reintentar", no fingir una lista de ventas vacía. **Corrección
  post-revisión (`code-review high`, 19/9/2026, hallazgos 5 y 6): dos
  fallas de la primera versión.** (1) La función se llamaba
  `readOptionalList` y tragaba CUALQUIER error, sin mirar cuál — un timeout
  o un 5xx transitorio al leer `catalog_links` pintaba el panel vacío como
  si de verdad no hubiera ningún catálogo, justo lo que CLAUDE.md prohíbe
  ("`null` pinta —, nunca un cero que parezca verdad", trampa de
  `agent_day_summary`). Renombrada `readListIfTableExists`: SOLO degrada a
  `[]` cuando el error dice, de forma verificable por código, que la tabla
  todavía no existe (`42P01`, `undefined_table` de Postgres, o `PGRST205`,
  "no encontré esa relación en el caché de esquema" de PostgREST — lo que
  pasa cuando la migración corrió pero nadie avisó con `notify pgrst`, ver
  la trampa de las cinco migraciones más abajo); cualquier otro error se
  RELANZA y lo atrapa `error.tsx` con su botón Reintentar. (2) Los dos
  `error.tsx` dependían de que `dashboard.css` (`.dash`/`.dash-frame`/
  `.dash-empty*`) ya estuviera insertada por el componente de vista real
  (`AgentControlView`/`SalesView`) — que precisamente NO se monta cuando la
  página lanza ANTES de renderizarlo. La verificación visual en `next dev`
  salió bien porque el dev server sirve el CSS sin trocear por ruta, pero
  el build de producción arma los chunks distinto y no hay garantía de que
  ese `<link>` ya esté insertado. Los dos `error.tsx` importan
  `@/components/dashboard/dashboard.css` de forma explícita ahora, sin
  depender de que otro componente se haya montado antes.
- **Las cinco migraciones de Seba/catálogo/factura se protegen con
  `lock_timeout` y avisan a PostgREST con `notify pgrst`** (T5, plan "Seba
  sale sin pisar a nadie", 19/9/2026, hallazgos A5/M1). Ninguna de las
  cinco (`20260916010000`, `20260917010000`, `20260917020000`,
  `20260918010000`, `20260918020000`) traía `notify pgrst, 'reload
  schema'`: sin él, PostgREST sigue sirviendo el esquema cacheado y una
  columna/tabla/CHECK/trigger recién creado da 400 hasta que alguien lo
  recargue a mano — la MISMA causa raíz de la trampa de C2, de más arriba,
  aplicada a cualquier consulta que dependa del esquema nuevo, no solo a
  `runAgentTurn`. Las tres que todavía no traían `set local lock_timeout =
  '5s'` (`20260917020000`, `20260918010000`, `20260918020000`) lo ganan al
  inicio, mismo motivo que ya vale para `20260916010000`/`20260917010000`
  (ver la trampa de "El trigger AFTER dejó con rastro tres movimientos de
  dueño…" más arriba, sobre `psql -1 -v ON_ERROR_STOP=1`): `set local
  lock_timeout` fuera de una transacción es un NO-OP silencioso, y en la
  inspección previa al despliegue del 19/9/2026 se midió un INSERT del
  webhook encolado 6,9 s detrás del lock de una de estas cinco
  migraciones. Las cinco se aplican con `PGOPTIONS="-c lock_timeout=5s"` +
  `psql -1 -v ON_ERROR_STOP=1` (ver `docs/PRODUCCION.md` §11), en el orden
  de sus fechas, ANTES del código. **Corrección post-revisión (`code-review
  high`, 19/9/2026, hallazgo 10): un NO-OP silencioso significa que
  aplicarla SIN `-1` "funcionaba" igual — sin avisar que el `lock_timeout`
  real nunca se puso.** Las cinco ganaron, justo después de su propio `set
  local lock_timeout = '5s'`, un bloque `do $$ … if
  current_setting('lock_timeout') in ('0', '0ms') then raise exception …
  end if; $$` que ahora falla CERRADO: sin `psql -1 -v ON_ERROR_STOP=1` (o
  el equivalente `PGOPTIONS="-c lock_timeout=5s"` sin `-1`, que también
  pasa la guarda) la migración entera aborta con un mensaje explícito en
  vez de aplicarse "a medias" sin el freno de lock que la justifica.
  Verificado el 19/9/2026: `npx supabase db reset` (CLI 2.117.0) aplica las
  cinco sin abortar — la CLI envuelve cada archivo de migración en su
  propia transacción — y los tests de `supabase/tests/` pasan sobre esa
  base reconstruida desde cero; el CI usa `supabase/setup-cli@v1` con
  `version: latest`, así que la certeza total llega recién con el primer CI
  real sobre este rango. **(Actualizado el 20/9/2026, revisión "El
  resguardo antes del push", tarea C5, hallazgo B): la frase de arriba
  ("aplicarla SIN `-1` aborta") sigue valiendo tal cual solo para TRES de
  las cinco (`20260917020000`, `20260918010000`, `20260918020000`).**
  `20260916010000` y `20260917010000` se editaron IN SITU para arreglar un
  interbloqueo real con el webhook (`lock table … in share row exclusive
  mode` sobre `conversation_handoffs`, y también sobre `messages` en la
  0917, ANTES de tocar una sola fila — reproducido contra la base local con
  30 mil filas y 20 conexiones concurrentes: `deadlock detected` sin el
  candado, tres corridas limpias con él). `lock table` exige un BLOQUE de
  transacción, que la transacción implícita de la CLI de Supabase NO es, así
  que esas dos migraciones ahora traen su propio `begin;`/`commit;` —
  consecuencia: en ESAS DOS, y solo en esas dos, olvidarse el `-1` YA NO
  aborta (el archivo abre y cierra su propia transacción); con `-1` salen
  dos WARNING inofensivos ("already a transaction in progress" / "no
  transaction in progress"). Detalle completo, con los segundos que el
  webhook quedó esperando bajo carga, en `docs/PRODUCCION.md` §11.
- **Un test de `supabase/tests/` que hace `\i` de una migración NO se puede
  correr con `docker exec -i … -f - < archivo`** (19/9/2026, verificando
  T4/T5 de "Seba sale sin pisar a nadie"). `ventana_24h.sql`,
  `traspaso_sin_contenido_legible.sql`, `preview_en_espanol.sql` y
  `marca_sbk_motors.sql` reaplican una migración vieja con `\i
  supabase/migrations/<archivo>.sql` para probar su backfill/idempotencia
  — pero `\i` busca esa ruta DENTRO del contenedor, y `-f -` (stdin) no
  lleva ningún archivo del repo adentro: `\i` falla con "No such file or
  directory" aunque el resto del test compile bien. Hace falta copiar el
  repo primero: `docker cp ./supabase <contenedor>:/tmp/repo/` y correr con
  `-w /tmp/repo` para que la ruta relativa del `\i` resuelva:
  `docker exec -w /tmp/repo <contenedor> psql -U postgres -d postgres -1 -v
  ON_ERROR_STOP=1 -f supabase/tests/<archivo>.sql`. Los tests que NO usan
  `\i` (la mayoría) sí corren con `-f - < archivo`, sin este paso extra.
  **Desde Git Bash, `docker cp ./supabase <contenedor>:/tmp/repo/` puede
  fallar repetido por la conversión de rutas de MSYS** (ensayo del
  despliegue, 19/9/2026): la ruta `/tmp/repo/` la reinterpreta MSYS antes
  de que llegue a Docker. Dos formas, las dos con `MSYS_NO_PATHCONV=1`
  delante de cualquier `docker exec -w /tmp/repo …` que siga:
  - Con `docker cp` (crear el destino primero, `docker cp` no crea
    directorios intermedios): `docker exec <contenedor> mkdir -p /tmp/repo`
    y luego `MSYS_NO_PATHCONV=1 docker cp ./supabase
    <contenedor>:/tmp/repo/supabase`.
  - Sin `docker cp`, sin depender de cómo MSYS reescriba la ruta: `tar -cf -
    supabase | docker exec -i <contenedor> sh -c "mkdir -p /tmp/repo && cd
    /tmp/repo && tar -xf -"`.
  Ojo con `supabase/tests/catalog_links.sql`: su fixture usa `key =
  'cascos'`, y en una base donde YA corrió `scripts/sql/2026-09-18-catalogos-iniciales.sql`
  (que carga esa misma clave en producción) choca con `duplicate key value
  violates unique constraint` — es un artefacto de correr el test contra
  una base de ensayo que ya tiene datos reales del script, no pasa en el
  CI (que arranca de una base limpia con solo migraciones y seeds).
- **Un reintento tras `ProviderFailedAfterGreetingError` tiene que ver
  EXACTAMENTE el mismo historial que vio el primer intento, y recortar el
  saludo SOLO para la ráfaga no alcanza** (T12, "El turno se reintenta
  solo cuando el proveedor falla después del saludo", plan "Seba sale sin
  pisar a nadie", 19/9/2026, cierra la decisión abierta #1). Con D2
  ("Seba atiende el mostrador") la escalada ya no apaga a Seba, y con T2b
  Seba se presenta por código ANTES de fase 0/1: eso dejó dos salidas del
  turno —clasificar y el `catch` del tool loop— que pueden fallar JUSTO
  DESPUÉS de que la presentación ya salió, con `welcome_sent_at` sellado.
  T2 tapaba la invisibilidad con un `recordHandoff(entrega_fallida)`, pero
  ese traspaso volvía el caso IRRECUPERABLE cuando en realidad es SEGURO
  reintentar: lo único que salió fue el saludo, ya sellado por
  `claimPresentation`, y ningún `deliver()` vive fuera de `agent.ts` (las
  herramientas del tool loop no le mandan nada al cliente por su cuenta).
  Ahora esas dos salidas lanzan `ProviderFailedAfterGreetingError`
  (`turn-delivery.ts`) — la ÚNICA excepción a "si `entrega.intentado`, no
  se reintenta"— y `runAgentTurn` la deja pasar TAL CUAL (sin envolver en
  `NonRetryableTurnError`, `log.warn("turno_reintentable_tras_saludo")`)
  para que `queue.ts`, SIN TOCAR, la reintente como cualquier fallo
  transitorio. La revisión adversarial encontró que la primera versión del
  plan recortaba el saludo SOLO para calcular la ráfaga (`customerBurst`)
  y dejaba el historial REAL —el que viaja a `agent.generate` y a
  `classifyIntent`— terminado en un mensaje del ASISTENTE: hay proveedores
  que tratan eso como *prefill* o devuelven vacío, y además fase 0 y
  `mediaStreakWithoutText` verían un historial distinto al del primer
  intento. La versión final recorta el saludo de `history` Y
  `historyCreatedAt` —los dos arreglos que arma `loadHistory` en el mismo
  bucle, mismo índice, `.pop()` en los dos— justo después de `loadHistory`
  y ANTES de calcular nada más: el reintento ve el historial "como si Seba
  no hubiera hablado todavía", terminado en el cliente, igual que el
  primer intento. El reconocimiento (`isSebaGreeting`, `seba.ts`) depende
  de que el texto viaje sin transformar — `send.ts` guarda `content: text`
  tal cual y `historyLine` devuelve `row.content` crudo para un `text` — y
  por eso el test que ejercita el reintento pasa por `loadHistory` de
  verdad con una fila armada como la dejaría `sendAgentText`, no por un
  `introducedThisTurn` inyectado a mano: si el reconocimiento fallara
  alguna vez, el lead quedaría mudo SIN rastro (sin `introducedThisTurn`
  no hay ni `throw` ni traspaso, y el último mensaje visible es saliente).
  **Turno espurio** (un reintento —o cualquier invocación duplicada— sobre
  un saludo que YA fue la respuesta completa, el caso `soloSaludo` del
  primer intento): si la ráfaga recortada sigue siendo solo saludo o
  cortesía, el turno cierra con `resetStage("turno_saludo_ya_respondido",
  …)` sin llamar al modelo ni escribir traspaso —`awaiting_reply` ya había
  quedado apagado por ese saludo (`isAutoReply: false`)—, pero este cierre
  vive A PROPÓSITO DESPUÉS de la guarda de cortesía tras escalada abierta,
  no antes: las dos comparten el caso `["gracias"]`, y con una escalada
  abierta esa guarda tiene que ganar (deja su propio traspaso
  `cortesia_tras_escalada`) en vez de que el cierre silencioso se la coma
  antes de que llegue a evaluarla. Casos revisados que no necesitaron
  código nuevo: el cliente escribe durante la espera del reintento (su
  mensaje queda DESPUÉS del saludo en el historial, así que la última
  línea ya no es del asistente y esto no se reconoce como reintento — el
  saludo se queda en el historial y el turno corre normal); un asesor
  escribe o toma el chat entre intentos (las guardas de apertura de
  siempre, `pausada`/`humano_se_adelanto`, cortan igual); si el intento 1
  llegó a escalar antes de que `generate` lanzara, el reintento puede
  escalar otra vez, pero cae en la rama `alreadyAssigned` de
  `escalate.ts` (solo nota) si ya hay asesor — bitácora repetida, no
  mensaje repetido. Límite aceptado: si los tres intentos de la cola
  fallan, `abandonado` va siempre a `unassigned` (aunque el chat tuviera
  asesor asignado) — con asesor, el chat sigue en "Tuyas"/"Pendientes" por
  `awaiting_reply` de todos modos, porque el saludo es `is_auto_reply`.
- **Un fake de Supabase en un test puede tragarse el operador o el argumento
  de un filtro, y un tope numérico probado contra su propio símbolo
  importado no prueba el número** (revisión "El resguardo antes del push",
  20/9/2026). Cuatro huecos del mismo tipo, en cuatro archivos: `mutations.test.ts`
  no distinguía `.gte(...)` de `.eq(...)` ni miraba el VALOR del
  `.eq("id", …)` de cada UPDATE — la condición más delicada de T11 (¿la
  apagó ESTE tomar-a-mano? ¿el asesor escribió DESDE `assigned_at`?) podía
  invertirse sin que nada se pusiera rojo; `human-handled.test.ts` ignoraba
  el `ascending` de `.order("created_at", …)` sobre `conversation_handoffs`
  y devolvía siempre la fila más reciente por su cuenta, así que invertir
  el orden real no rompía nada; `lessons.test.ts` no aplicaba de verdad los
  `.eq()` que le pasaba el código, y sin `.eq("kind", "nota")` los
  SINÓNIMOS se colaban al prompt como si fueran notas sin que ningún test
  lo notara; y los topes `MAX_GLOBAL_LESSONS`/`MAX_CHAT_LESSONS`/
  `MAX_LESSON_CHARS` (15/5/200) se medían contra el propio símbolo
  importado (`MAX + 10`), así que cambiar el número en el código de
  producción no habría roto nada. Regla: un fake de Supabase nuevo registra
  operador + columna + valor (y el argumento real de `.limit()`/`.order()`),
  y un tope numérico se fija en el test con su literal, nunca con el
  símbolo que ya está probando. Aparte: tras un corte de luz, el REPORTE de
  un subagente de mutación se pierde aunque su trabajo en los archivos de
  test sobreviva en el árbol de trabajo — la tabla de mutaciones
  (`scratchpad/.../tabla.md`) se escribe a disco tras CADA mutación, no
  solo al cierre, para que la sesión que retoma no tenga que re-mutar desde
  cero lo que ya quedó confirmado verde/rojo/verde.
- **Con intención `consulta_disponibilidad`, el primer paso del tool loop
  OBLIGA a llamar a `buscarRepuesto`** (hallazgo K, "El resguardo antes del
  push", 20/9/2026, `tool-choice.ts` + `prepareStep` en `agent.ts`). Caso
  real, escenario a mano: "Precio del casco LS2" → el modelo contestó en un
  paso, sin herramientas, "Tenemos varios modelos de cascos LS2
  disponibles", con CERO cascos en `products`. La red de seguridad del
  catálogo (`catalogOutcome.ran && …`) solo actúa si la herramienta llegó a
  correr: prohibirlo en el prompt no alcanzaba, porque nada en código
  obligaba a consultarla. El `toolChoice` rige SOLO el paso 0 (del 1 en
  adelante el modelo tiene que poder redactar) y solo con el interruptor del
  catálogo encendido; con otra intención nada cambia. El mock de
  `ToolLoopAgent` de `agent.test.ts` captura `prepareStep` pero sigue sin
  invocar `onToolExecutionStart`. En local, la cuota gratuita de Gemini es
  de 15 peticiones por minuto: cuatro chats de prueba a la vez la agotan y
  el turno sale por `turno_reintentable_tras_saludo` — no es un bug; y el
  cron que drena los reintentos no corre en `next dev`, hay que llamar a
  `api/cron/process-queue` a mano con `CRON_SECRET`.
  **K2 (`028fabe`, mismo día):** obligar la búsqueda tenía un efecto
  colateral — el clasificador llama `consulta_disponibilidad` a mensajes
  vagos ("hola, otra consulta") y, sin producto que buscar, el turno
  escalaba por `no_identificado`. `buscarRepuesto` tiene la entrada
  `clienteNoNombroRepuesto`: con ella no toca la base, levanta `generico` y
  Seba pregunta. **La bandera gana SIEMPRE sobre el `query`**: como `query`
  es obligatorio, el modelo lo rellena con algo inventado ("repuesto
  genérico") aunque marque la bandera — medido; con la precedencia contraria
  Seba cotizó productos al azar. **REVERTIDO el 21/9/2026 (plan "El catálogo
  configurado sale siempre"):** el 20/9/2026 esto quedaba como
  "comportamiento conocido, decisión del operador: se deja así" — pedir "el
  catálogo de cascos en PDF" se clasificaba como disponibilidad, el
  escenario del PDF se cedía al inventario (H1) y Seba escalaba sin mandar
  el enlace, dejando el catálogo en manos del asesor. Un reporte de solo
  lectura del 21/9 mostró que ese caso NO era una rareza: "CATALOGO CASCOS"
  y "Catálogo general" eran el 30 % de las respuestas predeterminadas en 15
  días. La "salida propuesta y no implementada" de aquel momento —una
  función pura que detecta si el mensaje nombra catálogo/pdf/lista de
  precios— es, con las otras tres condiciones sumadas, la regla de las
  cuatro condiciones que reemplaza a H1 (ver la viñeta "El repuesto manda",
  más arriba, sección actualizada).
  Los escenarios de pantalla se pueden correr sin la extensión del navegador:
  Playwright con el Chromium de `~/AppData/Local/ms-playwright` contra el
  build de producción (`npm start`) calcula layout de verdad.
- **El estado de producción no se supone, se pregunta** (21/9/2026, plan "El
  catálogo configurado sale siempre"). `buscar_repuesto` estuvo APAGADA en
  producción 27 días seguidos (desde el 25/8) sin que ninguna tarea
  pendiente lo supiera, y tres corridas enteras —"Seba atiende el
  mostrador", el hallazgo K y su corrección K2— se verificaron a mano en
  local con la herramienta ENCENDIDA, exactamente al revés del estado real
  que iban a encontrar el día del deploy. Desplegar H1 sin este plan habría
  cedido "CATALOGO CASCOS"/"Catálogo general" —el 30 % de las respuestas
  predeterminadas medidas en 15 días— a un inventario que en producción
  sigue apagado, dejando sin PDF al segundo motivo de contacto del negocio.
  Antes de cerrar un plan que dependa de un interruptor del panel
  (`agent_tools`, `agent_settings`, un escenario de `ai_playbooks`), pedir
  el reporte de solo lectura al Claude del VPS — el prompt vive en la
  memoria del proyecto — en vez de asumir que "ya se debe haber encendido"
  o que el estado de la última medición sigue vigente.
- **Una función `security invoker` que recorre una tabla con RLS paga la
  política POR FILA, y medirla como superusuario no mide nada** (plan "La
  escalada se hace una vez y la búsqueda responde", 21/9/2026). TODA
  búsqueda por texto de `/inbox` dio 500 por `statement timeout` durante
  semanas (156 de 156 en 48 h; media 3,3 s, máximo 7.991 ms contra los 8 s de
  `authenticated`) mientras `search_conversations_by_message` medía 142–339
  ms llamada a mano en el VPS — como superusuario, que salta RLS.
  Reproducido en local con 115.000 mensajes: 75 ms como superusuario contra
  1.468 ms como `authenticated` (234.613 buffers contra 4.706); el plan
  mostraba `Seq Scan on messages` con `Filter: … AND is_agent()`, una llamada
  a una función `security definer` por fila (`LIKE` no es leakproof, así que
  con RLS tampoco puede ser condición del índice trigram). La migración
  `20260921030000` la pasa a `plpgsql security definer` con `is_agent()`
  chequeado UNA vez y `search_text like all (pats)` en positivo: 27 ms. **Para
  medir una consulta de la app: `set local role authenticated` + `set local
  request.jwt.claims` con el `sub` de un agente, dentro de una transacción.**
  Su test (`supabase/tests/search_conversations_by_message.sql`) mide el
  caso 8 con `clock_timestamp()` contra 500 ms, no con `statement_timeout`:
  un `set local` dentro de un `do $$` no gobierna el statement que ya está
  corriendo. El guardián estático `src/lib/permisos-funciones.test.ts`
  cuenta las funciones `security definer` (22 desde esta migración): una
  nueva lo pone rojo a propósito, y se suma a la lista solo si trae sus dos
  revokes.
- **Una escalada por turno, y con asesor asignado el modelo lo SABE** (T1/T2
  del mismo plan, 21/9/2026). Medido en la primera hora tras desplegar
  `0af0b2c`: 24 turnos escalados donde bastaban 9 (15 notas "IA reiteró la
  escalada"), porque `esperandoAsesor` solo marcaba `isAutoReply` y nunca
  llegaba al prompt; y dos turnos de 145.000 tokens de entrada y ~65.800 de
  salida (0,108 USD y 5 min cada uno) que eran EXACTAMENTE los dos únicos
  con `escalarAAsesor` llamada dos veces en el mismo turno. Ahora: (1)
  `stepToolChoice` (`tool-choice.ts`) devuelve `toolChoice: "none"` en todo
  paso posterior a una escalada —NO se corta con `stopWhen`, decisión D1:
  así Seba redacta su despedida en vez de caer siempre en la fija—; (2)
  `buildEscalateTool` memoriza la primera escalada del turno (`pending`,
  asignado de forma síncrona: cubre dos tool calls en el mismo paso) y se
  resetea si esa primera lanzó o no escaló; (3) `maxOutputTokens: 1500` (si
  el modelo razona, el techo INCLUYE el razonamiento: un corte puede dejar
  `text` vacío, que ya cubren la despedida fija y `turno_sin_texto`) y
  `resumen` ≤ 600; (4) con asesor asignado, `yaEscalada` viaja SOLO en el
  sufijo del prompt (el test compara `cacheablePrefix()` byte a byte), la
  herramienta queda restringida a `motivo: "intencion_compra"` (D2) y se
  omite del todo si `deal_status` ya es `in_progress`; (5) las dos redes de
  seguridad en código no llaman a `escalateConversation` con asesor
  asignado — la del catálogo sigue ANEXANDO su texto fijo, sin tocar la
  base. `escalate.ts` no se tocó.
- **`AI_AGENT_REASONING=off` no apaga el razonamiento: no opina** (T4b,
  21/9/2026). `model.ts` omite `providerOptions` entero y queda el default
  del proveedor; `@ai-sdk/openai@4` decide `isReasoningModel` con una regex
  sobre el id (`gpt-5.6-luna` → `true`) y habla con OpenRouter por la
  Responses API. `agent_turns.reasoning_tokens` (migración `20260921020000`,
  `not null default 0`) mide desde ahora lo que el proveedor reporte en
  `usage.outputTokenDetails.reasoningTokens`; Control IA lo pinta como
  "Razonamiento: N" solo cuando es mayor que cero. Apagarlo de verdad sería
  mandar `reasoning: "none"` explícito, y NO se hizo: hay que medir primero
  con la columna nueva, y después comprobar que OpenRouter lo honra (el 8/9
  Luna respondía `reasoningEffort is not supported`). La RPC
  `agent_token_usage` no trae la columna: sumarla es otra migración.
  **Actualizado el 22/9/2026 (T5, plan "Nada se pierde en un corte ni en un
  deploy"): las dos cosas que esta viñeta dejaba pendientes ya se hicieron.**
  `AI_AGENT_REASONING` tiene un tercer valor, `none`, que SÍ manda el
  apagado explícito (`reasoningEffort: "none"` → el SDK lo traduce a
  `reasoning: { effort: "none" }` en el body de la Responses API); `off`
  sigue sin mandar nada (el proveedor razona con su default) y `on`/ausente/
  basura siguen mandando `medium`/`low`. Y `agent_token_usage` SÍ suma
  `reasoning_tokens`/`cached_input_tokens` desde la migración
  `20260921040000` (T3 del mismo plan, que de paso la pasó de
  `security invoker` a `security definer` — pagaba `is_agent()` por fila,
  mismo agujero que `search_conversations_by_message`). Producción sigue en
  `off`: el operador decide si prueba `none` después de leer
  `agent_turn_calls.reasoning_tokens` por fase (tabla nueva de la misma
  migración, ver la trampa de `agent_turn_calls` más abajo).
- **Meta descarga los adjuntos salientes desde una URL firmada de Supabase
  Storage, NUNCA desde `/api/media/…` del CRM** (hallazgo 1, plan "Nada se
  pierde en un corte ni en un deploy", 21-22/9/2026). El enlace que se le
  manda a Meta lo arma `media-link.ts` (`createSignedUrl(path, 600)`) contra
  el bucket; `/api/media` exige sesión de agente — a Meta le daría 401,
  nunca 500. Caso real, 21/9/2026: un asesor vio un 500 al bajar una imagen
  y la app "no registró nada" (la ruta no tenía un solo `log.*` ni
  `try/catch`, T7 lo cerró), pero tampoco fue Storage ni Envoy — Storage
  registró la subida y la firma en 200, y Envoy no vio NINGUNA petición de
  `facebookexternalua` a esa hora. La petición de Meta murió ANTES de
  Envoy, en Traefik o el borde TLS, y **Traefik no tenía access log
  activado**: ese era el hueco real, no la app. Instrumentar `/api/media`
  (T7) sigue valiendo por su propio motivo — un 401/403/404/500 real de un
  ASESOR mirando una foto o un sticker no dejaba ninguna línea — pero no es
  el arreglo de este incidente; el arreglo es activar el access log de
  Traefik en el VPS (ver `docs/PRODUCCION.md` §12) y buscar el próximo
  131053/500 por `facebookexternalua`.
- **El webhook responde 503 a Meta SOLO ante un fallo TRANSITORIO de
  persistencia, y la clasificación de "transitorio" mira también
  `err.message`, no solo `err.code`** (T1/T2, plan "Nada se pierde en un
  corte ni en un deploy", 21-22/9/2026). Hasta esa corrida, un corte de red
  corto o un Postgres reiniciando entre la app y PostgREST perdía el
  mensaje del cliente PARA SIEMPRE: los tres `continue` de pérdida real
  (contacto, conversación nueva, mensaje entrante) hacían `console.error` y
  el webhook respondía 200 igual — Meta no reintenta un 200. Ahora esos
  `continue` levantan `persistenciaFallida` cuando `esFalloTransitorioDeBase`
  (`errores-base.ts`) reconoce el fallo, y el `POST` responde 503
  `{ok:false,retry:true}` al final (DESPUÉS de encolar los turnos de lo que
  sí se guardó) para que Meta reentregue el lote — lo ya guardado cae en el
  `23505` del dedupe y se ignora, lo perdido se guarda recién ahí. Un fallo
  NO transitorio (payload raro, constraint) se queda en 200: un 5xx
  permanente haría que Meta repita el mismo lote durante días. La
  clasificación no se queda en `err.code`: `postgrest-js` convierte un 503
  con cuerpo NO-JSON o sin `code` en `PostgrestError { code: "", message:
  <cuerpo> }`, así que `esFalloTransitorioDeBase` también mira `err.message`
  contra los patrones de Envoy (`upstream connect error`,
  `disconnect/reset before headers`, `connection termination` — la familia
  "antes de las cabeceras": la petición nunca llegó a PostgREST) y de Kong
  (`name resolution failed`, `failure to get a peer from the ring-balancer`,
  `invalid response was received from the upstream`). Verificado en local
  con PostgREST parado: Kong respondió `503 {"message":"name resolution
  failed"}`, sin esta clasificación por `message` el 503 se leía como un
  fallo cualquiera, sin reintento y sin `persistenciaFallida`, y el webhook
  respondía 200 con el mensaje perdido. En producción el proxy es Envoy, no
  Kong (el stack `supabase-squad`), pero la clasificación cubre los dos: el
  cuerpo real que sirve cada instancia no es el mismo en local que en el
  VPS, y este código no debería depender de cuál proxy hay delante.
  Corrección hallada en la verificación a mano del orquestador (22/9/2026,
  "apagar PostgREST durante un POST al webhook local"): la PRIMERA lectura
  del lote (el canal, `whatsapp_channels` por `phone_number_id`) no pasaba
  por ninguno de estos inyectores — su `error` se descartaba y se leía como
  "no hay canal registrado", así que un corte de la base justo en ESE paso
  descartaba el lote entero con 200 antes de que el resto del código
  llegara a correr; ahora deja `log.error("webhook_canal_no_consultable")`
  y, si es transitorio, `persistenciaFallida = true`.
- **El reintento del cliente admin nunca repite un `POST`/`PATCH`/`DELETE`
  ambiguo: solo `GET`/`HEAD`, o un fallo que PRUEBE que la petición nunca
  llegó al upstream** (T1, mismo plan, 21-22/9/2026). `createAdminClient()`
  pasa `global: { fetch: fetchConReintentos(fetch) }` (cubre PostgREST, RPC
  y Storage de un saque). `esReintentoSeguro(method, fallo)`
  (`errores-base.ts`) reintenta si (a) el método es idempotente, o (b) el
  fallo prueba que la conexión nunca se estableció — la familia Envoy/Kong
  "antes de las cabeceras" y `ECONNREFUSED`/`EAI_AGAIN`. Un `POST` con
  `ECONNRESET`/`ETIMEDOUT`/"fetch failed" ambiguo NO se reintenta:
  PostgREST pudo haber ejecutado el INSERT y perderse solo la respuesta, y
  reintentarlo duplicaría la fila — una fila duplicada en `agent_turns`
  infla `agent_spend_today()`, la suma con la que `agent_can_run()` apaga a
  Seba por tope de gasto. Ese caso se queda como siempre: `log.error(
  "base_agotada")` y el llamador ve el error tal cual.
- **`agent_turn_calls` tiene RLS habilitada SIN ninguna política — se lee
  SOLO por RPC `security definer`, nunca con un `select` directo** (T3,
  plan "Nada se pierde en un corte ni en un deploy", migración
  `20260921040000`, 21-22/9/2026). Una fila por cada llamada al proveedor
  dentro de un turno (escenario/clasificar/redactar/identidad, 3-7 por
  turno, 1.100-2.500/día medidas el 21/9/2026 — más que `messages` hoy). Una
  política `select using (is_agent())` ahí es EXACTAMENTE la que pagó
  `messages` por fila y tumbó la búsqueda de `/inbox` 48 h
  (`20260921030000`); a este volumen es una bomba de tiempo previsible, no
  un accidente. Escribe `service_role` (bypassa RLS, pero igual necesita el
  `grant` de tabla); se lee por `agent_turn_calls_by_phase(days)` (agregado
  por fase) y se purga con `agent_turn_calls_purge(retain_days)` (cron
  diario, guarda en Redis `telemetria:purga:<fecha>`, nunca frena la cola).
  Un `select authenticated` directo sobre la tabla da **0 filas, no un
  error** — RLS sin política filtra todo, no rechaza el permiso de tabla; un
  test que quiera probar esto de verdad necesita comparar contra la RPC, no
  contra un `select` a mano. Cualquier test que ejercite `runAgentTurn` con
  un fake de Supabase necesita el caso `agent_turn_calls` en su `from()` Y
  el `.select("id").single()` del insert de `agent_turns` (`logTurn` ahora
  pide el `id` para poder referenciarlo como `turn_id`) — sin los dos, el
  fake explota o miente en silencio, mismo criterio que `catalog_links`
  (18/9/2026).
- **La telemetría por llamada viaja por `AsyncLocalStorage`, con un orden de
  middlewares que importa** (T4, mismo plan, 21-22/9/2026). `runAgentTurn`
  corre su cuerpo entero dentro de `conTelemetriaDeTurno` (`turn-telemetry.ts`);
  cualquier llamada al proveedor que corra ahí adentro —fase 0/1 en
  paralelo, el tool loop, la reescritura de identidad— se anota sola en el
  mismo registro, sin que ninguna función intermedia tenga que pasarlo a
  mano. `build()` (`model.ts`) compone `[rateLimitMiddleware,
  telemetryMiddleware]`, EN ESE ORDEN: `wrapLanguageModel` invierte el
  arreglo y hace `reduce`, así que el PRIMERO queda envolviendo por FUERA y
  el ÚLTIMO pegado al modelo base — con este orden, `duration_ms` mide la
  llamada real al proveedor, nunca el sueño de `conRitmo` (que puede dormir
  hasta 60 s). Con `ToolLoopAgent` MOCKEADO (como en la mayoría de
  `agent.test.ts`) el middleware no corre nunca — un test que quiera probar
  telemetría de verdad necesita un mock de modelo que sí pase por
  `wrapLanguageModel`, o probar `telemetryMiddleware`/`turnCallsSnapshot`
  aparte (`turn-telemetry.test.ts`), no a través de `agent.test.ts`.
- **El reloj del prompt de escenarios va al FINAL a propósito, no en la
  segunda línea** (T6, mismo plan, 21-22/9/2026). El caché de prompts del
  proveedor cachea por PREFIJO idéntico entre llamadas: con el reloj arriba
  (como hasta esa fecha), cada turno mandaba una hora distinta en los
  primeros caracteres y el prefijo se rompía siempre — la llamada de fase 0
  (`matchPlaybook`) nunca podía cachear, y un turno resuelto por escenario
  hace SOLO esa llamada más la de intención. `buildPrompt` (`playbooks.ts`)
  pone ahora todo lo estático (instrucción + catálogo + reglas) primero y el
  párrafo de fecha/hora/franja/horario/estado al final, justo antes de
  "Responde solo con el nombre exacto…". Sin promesa de efecto: con 14
  escenarios activos el bloque estático ronda ~830 tokens, por debajo del
  mínimo de ~1.024 de OpenAI — T4 mide después si de verdad alcanza.
- **`lib/log.ts` oculta toda clave que contenga `phone`, aunque no sea un
  dato personal** (corrección hallada en la verificación a mano del
  orquestador, 22/9/2026, plan "Nada se pierde en un corte ni en un
  deploy"). El primer intento de `webhook_canal_no_encontrado` usaba
  `phoneNumberId` como clave y el evento salía con el valor tapado
  (`[oculto]`) — inútil para saber QUÉ canal falta, aunque
  `metadata.phone_number_id` es un id de infraestructura del NÚMERO DE
  META, no el teléfono de un cliente. Se renombró a `canalMeta`. Antes de
  nombrar una clave de log, comprobar que no contenga "phone" por
  casualidad — el filtro de `lib/log.ts` no distingue intención.
- **El canal del seed local queda `connected` con un token de Meta
  vencido: para simular hay que ponerlo en `pending`** (hallazgo
  del entorno, 22/9/2026, verificación de "Nada se pierde en un corte ni en
  un deploy"). No mencionado en ningún plan porque no es del código, es del
  seed (`supabase/seed.sql`) — un asesor que reproduzca un escenario a mano
  contra la base local con el canal `connected` va a ver que la IA falla al
  enviar por el token vencido, no por lo que está probando.
- **Un `react-hooks/set-state-in-effect` con un `useCallback` llamado desde
  un `useEffect` de montaje se dispara aunque el `setState` viva DESPUÉS de
  un `await`** (T4, plan "Nada se pierde en un corte ni en un deploy",
  21-22/9/2026). La regla sigue la referencia de la función hasta su
  `setState` interno, no la asincronía real: `AgentControlView` necesita
  cargar `turnCallsByPhase` al montar (sin prop `initial*`, esta tarea no
  tocó `page.tsx`) y llamar a `refreshTurnCallsByPhase` (un `useCallback`)
  por nombre desde el `useEffect` de montaje disparaba la regla igual. La
  forma que el propio mensaje de la regla recomienda es un efecto INLINE
  con `.then()`/`.catch()` (no `async () => {}` directo, que React no
  soporta como cleanup) y una bandera `cancelado` para no escribir el
  estado si el componente se desmontó antes de que la lectura resuelva.
- **Con la escalada abierta, Seba no corre el tool loop: o calza un
  escenario INFORMATIVO o los pendientes van a una nota para el asesor**
  (T5, plan "Seba no habla de más", opción (b) del operador, 23/9/2026).
  Medido el 22/9: 20-27 % de los mensajes de Seba salían con una escalada
  abierta, hasta seis "el asesor ya tiene tu caso" en una misma espera. Con
  `escalationOpen` y pendientes, `runTurnPhases` no clasifica: corre solo
  fase 0 sin escenarios de despedida (`isFarewellPlaybook`, `saludo.ts`) ni
  con `after_send = escalate`; si nada calza, deja una nota interna
  («Mientras espera al asesor, el cliente agregó: …») y NO le escribe al
  cliente. Si la nota falla, el turno lanza ANTES de marcar "visto hasta".
  Los textos que decían "la IA sigue contestando" (`tools.ts`,
  `ai-status-banner.tsx`, `handoffs.ts`) se corrigieron en el mismo commit.
- **"Pendientes" de un turno = mensajes del cliente posteriores a la marca
  "visto hasta" en Redis, no la ráfaga final del historial** (T1/T2/T6,
  mismo plan). `turn-seen.ts` guarda, 6 h, hasta qué mensaje del cliente vio
  el último turno que ATENDIÓ (con los ids del mismo segundo: Meta fecha al
  segundo); sin pendientes el turno sale sin modelo
  (`turno_sin_mensaje_nuevo`). Un turno cuyo cliente escribió mientras
  redactaba cede el borrador (`turno_cedido_a_rafaga`, `turn-cession.ts`,
  tope 2 cesiones seguidas) y lo contesta el turno ya encolado. Un saludo
  suelto de un cliente que ya conocía a Seba espera 8 s la pregunta
  (`greeting-wait.ts`, `cola.defer` sin gastar intentos) y, si no llega, sale
  un saludo fijo sin modelo. **Sin Redis, las tres se comportan como antes
  del plan** — un test de cualquiera de ellas sin Redis ni `FakeRedis` pasa
  sin probar nada. El turno que choca con el lock ya no espera 30 s: el que
  termina lo adelanta (`adelantar`, Lua en `redis-queue.ts`).
- **`agent_turns.wait_ms` guarda desde el 23/9/2026 solo la espera en cola
  (`colaMs`), no ventana de silencio + cola** (T7). Las series de antes del
  deploy mezclan ~7,5 s de debounce: no compararlas con las de después
  (`docs/PRODUCCION.md`). `null` = turno sin vencimiento (simulador).
- **Tras un corte de luz, Windows puede reservar el 54321 y Kong queda sin
  puerto en el host** (23/9/2026). `docker ps` muestra `8000/tcp` sin
  `->`, `curl 127.0.0.1:54321` da 000 y la app registra `base_agotada`
  "fetch failed" en todo; `netsh interface ipv4 show excludedportrange
  protocol=tcp` lo confirma (rango 54241-54340). Sin admin, alcanza un relé:
  `docker run -d --name kong_relay --network supabase_network_Liminal_CRM
  -p 55321:8000 alpine/socat tcp-listen:8000,fork,reuseaddr
  tcp-connect:supabase_kong_Liminal_CRM:8000` y levantar el dev con
  `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321`. En local, Gemini
  responde "high demand" a menudo: el turno falla por el proveedor, no por
  el código.
- **`products` es de solo lectura para la app salvo `weight_kg`; el candado
  está en la base (grants + trigger) y el dueño del dato es
  `saint.sync_products()`** (25/9/2026, T1 del plan "El inventario llega de
  Saint y no se toca a mano", migración `20260925010000`). Hasta esta fecha
  `products` se cargó una sola vez el 24/8/2026 y quedó congelada —precios
  13,4 % por debajo de Saint, 602 códigos que la IA no conocía, 24 nombres
  viejos— mientras cualquier asesor logueado podía cambiar stock/precio o
  borrar productos llamando a la API directo. Ahora `saint.sync_products()`
  (`security definer`, esquema `saint`, nunca lanza —todo error queda en
  `saint.sync_log.error`—) corre por **pg_cron cada minuto**, no por un
  trigger sobre `saprod`: un trigger correría DENTRO de la transacción del
  agente replicador Liminal y, si fallara, bloquearía la réplica en vivo; un
  job de cron es independiente e idempotente (`IS DISTINCT FROM`, no
  reescribe lo que no cambió). Fuente: `coalesce(p_source,
  to_regclass('saint.saprod'), to_regclass('public.saprod'))` —hoy
  `public.saprod`, la réplica todavía no mudó a `saint.saprod`—, copiada con
  SQL dinámico a una tabla temporal porque el nombre de la tabla es un
  `regclass` resuelto en tiempo de ejecución. Mapeo: `codprod`→`saint_code`
  (columna nueva, backfillada el 25/9 desde `description` con la forma
  exacta `"Código ERP: <codprod>"`, el único lugar donde vivía el código
  antes de esta migración), `descrip`→`name`, `precio3`→`price` (`× 1` tal
  cual, sin conversión — el 13,4 % de diferencia era la brecha que ya traía
  Saint, no algo que esta migración inventa), `existen`→`stock_quantity`,
  `coalesce(activo, 1) = 1`→`is_active` (si la fuente no tiene columna
  `activo` —el caso de `public.saprod` hoy—, se trata como si todo
  estuviera `activo = 1`). **Nada se borra**: un producto vinculado que
  desaparece de la fuente se marca `is_active = false` y sella
  `saint_removed_at`, nunca un `DELETE`. **`activo ≠ 1` se aplica SIEMPRE**,
  sin tope y sin contar para la guarda (decisión del operador, 24/9/2026):
  es una baja administrativa de Saint sobre un producto que SIGUE presente,
  distinta de una desaparición — por eso no sella `saint_removed_at`.
  **La guarda es solo para ausencias**: si la fuente cubre menos del 90 % de
  los productos vinculados TODAVÍA NO REMOVIDOS, o la corrida daría de baja
  por ausencia a más de 50, no se da de baja nada por ausencia
  (`guarda_activada = true` en `saint.sync_log`); el cron nunca fuerza — el
  VPS revisa `sync_log` y corre `select saint.sync_products(null, true)` a
  mano para saltarla. Corrección del 25/9/2026 sobre la primera versión: el
  denominador/numerador de la cobertura tienen que excluir lo que YA tiene
  `saint_removed_at` — contándolo también, la cobertura solo podía bajar y
  nunca recuperarse, y pasado el 10 % del catálogo removido la guarda
  saltaba en TODAS las corridas siguientes, para siempre, aunque no hubiera
  ninguna ausencia nueva que proteger. `updated_at` cambia de significado:
  ya no es "última vez que alguien tocó la fila a mano", es **"última vez
  que se confirmó contra Saint"** — el job la toca cuando algo cambió o,
  cada 6 horas, aunque nada haya cambiado, y SOLO si el agente de réplica
  está vivo (`liminal.agent_status` si existe, latido de menos de 15 min; si
  no, `liminal.applied_events` con un evento de menos de 36 h; si ninguna de
  las dos tablas existe, no se considera vivo — fallar cerrado, nunca
  inventar que la réplica sigue corriendo). Dos triggers, no uno:
  `products_read_only_before_trigger` (BEFORE, `security INVOKER` a
  propósito —si fuera `definer`, `current_user` sería siempre `postgres` y
  no frenaría a nadie—, deja pasar a `postgres`/`supabase_admin`, rechaza
  todo lo demás salvo `weight_kg`) y `products_weight_audit_after_trigger`
  (AFTER UPDATE OF `weight_kg`, `security DEFINER`, escribe en
  `product_weight_audit` con `db_role` calculado por
  `coalesce(nullif(current_setting('role'), 'none'), session_user)` —dentro
  de un `definer`, `current_user` es siempre el dueño de la función, así que
  el rol de SESIÓN es lo único que distingue quién escribió de verdad).
  `product_weight_audit` y `saint.sync_log` llevan `revoke all ... from
  anon, authenticated, service_role` EXPLÍCITO aunque nadie se lo pidió por
  fuera: el `alter default privileges` de Supabase en `public` le da ALL a
  esos tres roles a toda tabla nueva de fábrica (la misma trampa de las
  funciones `security definer`, más arriba) — `saint.sync_log` vive en un
  esquema propio que no hereda ese default, pero la migración no confía en
  esa ausencia y lo deja explícito igual. El `grant update (weight_kg,
  updated_at) on products to authenticated` es TEMPORAL a propósito: la
  migración se aplica ANTES de que llegue el código nuevo, y el código VIEJO
  que sigue corriendo en producción en ese hueco manda `updated_at` en el
  payload de "guardar peso" — sin el grant de columna ese UPDATE fallaría
  por permisos antes de llegar al trigger (que igual revierte `updated_at`).
  El código nuevo (`updateProductWeight`, `mutations.ts`) ya manda SOLO
  `{ weight_kg }`, así que tras el deploy el VPS corre `revoke update
  (updated_at) on products from authenticated;` (ver
  `docs/entregas/2026-09-25-inventario-desde-saint.md`). Un navegador con el
  bundle viejo en caché verá a partir de ahí un toast de error al guardar el
  peso hasta que recargue. En el seed
  local, los 5 productos que no traen "Código ERP" en su `description`
  quedan `saint_code = null` — sin vínculo, el job nunca los toca ni los da
  de baja. En local no hay ninguna fuente (`saint.saprod`/`public.saprod`
  no existen) y cada corrida del cron deja una fila con `error` en
  `saint.sync_log` ("no se encontró ninguna tabla fuente…") — es el
  comportamiento esperado, no una falla que arreglar.
- **La tasa BCV se relee por `fetched_at` (un instante) contra los horarios
  00/06/12/18 VE, no por día calendario** (plan "La tasa BCV se lee cuatro
  veces al día", 25/9/2026, `BCV_READ_HOURS` en `bcv-schedule.ts`). Caso real:
  el 24/9 a las 23:53 el chip mostraba la tasa leída a las 07:08 con la del
  25 ya publicada por el BCV — la regla vieja, "una vez por día calendario"
  (`fetched_on`), no tenía forma de saber que había una tasa más nueva
  esperando. `getBcvRate` compara `lastScheduledRead(now)` contra el
  `fetched_at` MÁS RECIENTE guardado (`shouldRefetchBcv`); **el upsert TIENE
  que escribir `fetched_at` explícito** — la columna trae `default now()`
  (solo la fecha de creación de la fila), así que sin escribirlo ahí la regla
  releería en cada request. Sin "Fecha Valor" en la página no se guarda nada
  (se devuelve lo guardado con `isStale: true`): a las 18:00 el BCV ya
  publica la tasa del día hábil siguiente, y guardarla como si rigiera desde
  hoy pisaría la tasa buena del día en curso. La ventana de 5 min tras un
  fallo (`BCV_FAILURE_BACKOFF_MS`) vive EN MEMORIA del proceso, no en Redis —
  el cron (`/api/cron/bcv-refresh`) la ignora con `ignoreFailureBackoff`.
  `fetched_on` sigue escribiéndose en cada upsert pero ya no decide nada;
  borrarla es otra ola, con su propia migración.

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
