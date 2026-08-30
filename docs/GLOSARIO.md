# Glosario de archivos

Mapa módulo por módulo del proyecto. Su propósito es que orquestador y
subagentes ubiquen el código relevante sin releer el proyecto entero.

**Regla de mantenimiento:** todo cambio que cree, mueva o cambie el propósito
de un archivo actualiza su línea aquí, en el mismo commit.

Convención de tests: cada módulo lleva su `*.test.ts(x)` al lado, con el mismo
nombre. Los tests sin módulo propio (`data-*.test.ts`, `queue-limit`,
`queue-spacing`, `debounce`, `turn-correlation`, `dashboard-tickets`,
`conversation-quotes`) prueban facetas del módulo vecino que nombran.

---

## Raíz

| Archivo | Qué es |
|---|---|
| `next.config.ts` | Cabeceras de seguridad (antes en Caddyfile), `output: standalone`, `staleTimes` de navegación, orígenes de dev para túneles |
| `src/proxy.ts` | Middleware de Next: refresco de sesión + quién puede ver cada página (delega en `lib/supabase/middleware`) |
| `Dockerfile` / `docker-compose.yml` | Imagen standalone sin privilegios con HEALTHCHECK; stack app + caddy + cron |
| `docker-compose.dokploy.yml` | El mismo stack menos Caddy (Dokploy trae Traefik) |
| `Caddyfile` | TLS automático y cabeceras cuando el proxy es Caddy |
| `moto_catalog_schema.sql` / `moto_catalog_data.sql` | Fuente del catálogo de motos/repuestos (5.438 productos); de aquí salen la migración y el seed del catálogo |
| `vitest.config.ts` / `vitest.setup.ts` / `vitest.server-only-stub.ts` | Vitest con entorno `node` por defecto (los tests de UI declaran jsdom por docblock); `testTimeout` 15s contra la contención de workers; stub que anula `server-only` en pruebas; `vitest.setup.ts` sube el `asyncUtilTimeout` de los `waitFor`/`findBy` de Testing Library a 5 s (solo jsdom) para que la espera escale con la carga en vez del 1 s de fábrica; el plugin de React (`@vitejs/plugin-react`) solo transforma `.tsx`/`.jsx` (29/8/2026: su include de fábrica es `/\.[tj]sx?$/` y pasaba Babel sobre todo `.ts` del grafo, incluidos los tests de entorno node y src/lib, que no pueden tener JSX) |
| `liminalwork.md` | Metodología de trabajo (fuente de la skill `liminalwork`) |
| `AGENTS.md` | Aviso de `next dev`: esta versión de Next 16 difiere de los datos de entrenamiento; leer `node_modules/next/dist/docs/` |
| `CREDENCIALES.txt`, `.env.local*` | Solo en disco, ignorados por git; lo versionado son los `.example` |

## `src/app` — páginas (App Router)

| Ruta | Qué es |
|---|---|
| `page.tsx` | Redirección de entrada (a `/login` o `/inbox`) |
| `layout.tsx`, `globals.css`, `theme.css` | Marco global y tokens de tema claro/oscuro |
| `inbox/` (+`[id]/`) | Bandeja compartida: la página arma datos iniciales y monta `crm-shell` |
| `clientes/` | Directorio de clientes (ficha, notas, etiquetas, historial comercial) |
| `inventario/` | Inventario: lo que se ve aquí es lo que la IA cotiza (misma tabla `products`) |
| `ventas/` | Ventas cerradas: verificación y reversión (supervisor) |
| `agent-control/` | Panel de control de la IA |
| `login/` | Acceso |

## `src/app/api` — rutas de servidor

| Ruta | Qué es |
|---|---|
| `webhooks/whatsapp/route.ts` | Entrada de Meta: handshake, verificación de firma HMAC, mensajes entrantes (texto/multimedia/reply), estados de envío; escribe con service role y encola turnos. La bienvenida automática se reclama en la base (`claimWelcome` sella `conversations.welcome_sent_at` con un UPDATE condicional antes de enviar; se devuelve a `null` solo si Meta rechaza la plantilla), no en memoria de la invocación. `new-contact-race.test.ts` cubre la carrera de contacto nuevo y `welcome-race.test.ts` la carrera de la bienvenida — los tres archivos comparten el espejo de mocks (incluido `@/lib/redis`) y la importación del route en `beforeAll` |
| `messages/send/route.ts` | Envío del composer: canal `connected` → Cloud API real (con reintentos solo ante 5xx/red); si no, simulado. El token nunca toca el navegador |
| `cron/process-queue/route.ts` | Red de seguridad de la cola de turnos (cada 5 min); exige `CRON_SECRET`, falla cerrado con 503. Resguardo en `route.test.ts`: los caminos cerrados afirman que la cola NO se llamó |
| `agent/backlog/route.ts` | Repaso del atraso al encender la IA: encola lo que quedó esperando mientras estuvo apagada. Resguardo en `route.test.ts` (incluye el DEFECTO CONOCIDO D1: el lock queda tomado 30 min en los caminos que no encolan) |
| `agent/stop/route.ts` | Freno de emergencia: apaga la IA y también lo que ya estaba en marcha. Resguardo en `route.test.ts`: orden interruptor→purga, degradación con Redis caído, línea de auditoría `ia_apagada` |
| `dev/simulate-message/route.ts` | Simulador del panel: mensaje entrante sin pasar por Meta, turno síncrono. Su test afirma que la guarda de producción corta ANTES de tocar dependencia alguna |
| `media/[...path]/route.ts` | Sirve el bucket privado `whatsapp-media` con la sesión del CRM por delante. Resguardo en `route.test.ts`: 401 sin sesión sin llegar a firmar, y el path viaja sin sanear (DEFECTO CONOCIDO D5) |
| `health/route.ts` | 200 solo si alcanza la base y tiene sus variables; para el monitor externo. Su test afirma los CÓDIGOS HTTP (lo único que leen monitor y HEALTHCHECK), no solo el JSON |
| `workflows/` | (dentro de `dev/`) utilidades de desarrollo |

## `src/lib` — núcleo compartido

| Archivo | Qué es |
|---|---|
| `types.ts` | Tipos de dominio de toda la app (formas mínimas por vista, a propósito) |
| `data.ts` | Capa de LECTURA de la bandeja/chat contra Supabase (55K; mapea filas crudas a tipos de dominio). `fetchConversations` gana `unreadOnly` y `assignedTo` (`FetchConversationsOptions`) para resolver contra la base las píldoras "No leídas" y "Mías" — antes "Mías" filtraba en memoria sobre la ventana cargada y un chat asignado viejo no aparecía. `InboxCounts` gana `unread` (mismo predicado que `unreadOnly`); `pending`/`pendingStale` siguen ahí para el panel de inicio, ya no tienen píldora propia en la bandeja. Paginación por CURSOR (29/8/2026): `offset` salió de `FetchConversationsOptions`, entró `cursor?: ConversationCursor` (`inbox-paging.ts`) — un `offset` de posición se rompía apenas una fila subía al tope en medio de la bajada de la bandeja (confirmado en producción, ~3 reordenamientos/minuto, filas que no volvían nunca). `fetchConversationRows` ordena por `last_message_at desc nulls last, id desc` (el desempate por `id` es necesario: hay empates reales de `last_message_at`) y acumula sus disyunciones (`pendingWindow: "stale"`, `unreadOnly`, el predicado del cursor) en un arreglo para emitir un solo `.or()` con `orExpression` — dos `.or()` en la misma consulta no son fiables. El recorrido MULTIPÁGINA INTERNO (las llamadas sin `limit`: tablero y Control de IA vía `fetchBoardConversations`) también avanza por cursor desde el 29/8/2026: cada página interna pide `range(0, pageSize-1)` con el predicado armado desde la última fila de la página anterior, en vez del `range(rows.length,…)` posicional que perdía en silencio la fila del borde cuando algo salía del conjunto (un chat que se cierra con `activeOnly`) y duplicaba el borde cuando algo subía al tope; el cursor de ENTRADA (`options.cursor`) gobierna solo la primera página interna, después lo reemplaza el de continuación (`cursorFromRow`, gemelo crudo de `cursorAfterPage`), inyectado en el mismo acumulador `orGroups` para que la distribución del OR con `unreadOnly` siga saliendo en un solo `.or()` |
| `mutations.ts` | Capa de ESCRITURA: enviar, asignar, etiquetar, cerrar venta, eventos de sistema en la burbuja |
| `customers.ts` / `customers-data.ts` | Sección Clientes: lógica pura (URL, paginación, gasto) / consultas alrededor de la persona |
| `inventory.ts` / `inventory-data.ts` / `inventory-freshness.ts` | Sección Inventario: lógica pura / consultas a `products` / cuán viejo es el inventario antes de que la IA lo cotice |
| `dashboard.ts` / `dashboard-tickets.test.ts` | Reclamos (contacto etiquetado "Reclamo*"), ventana de 24h (`withinFreeformWindow`), recorrido, e `isStalePending` — ventana de 24h sin respuesta, hoy solo del Dashboard y el `AgentHomePanel` (la reforma del 28/8/2026 tarde le quitó a `inbox-sections.ts` esa píldora y con ella el test de contrato que las mantenía de acuerdo) |
| `inbox-filters.ts` | Las tres píldoras de la bandeja (No leídas/Mías/Todos), iguales para todos los roles; `DEFAULT_INBOX_FILTER = "unread"`. Exporta `isUnread` (LA definición de "sin leer": `unreadCount > 0 || manuallyUnread`, corte GLOBAL de equipo — cerrar un chat no es leerlo). `SERVER_FILTER_LIMIT`/`serverFilterTruncated` (tope mudo de 200 filas y su aviso de recorte) se retiraron el 29/8/2026: "No leídas" y "Mías" pasaron a paginar por cursor (`inbox-paging.ts`) con `INBOX_PAGE_SIZE`, igual que "Todos" — el recorte silencioso que el aviso vigilaba dejó de existir. La guardia anti-crecimiento (máx. 3 píldoras) vive en su test |
| `inbox-sections.ts` | Partición pura de la lista de bandeja en secciones por píldora: `unread` una sola sin encabezado, `mine` partida en Sin leer/Leídas (usa `isUnread` de `inbox-filters.ts`), `all` una sola; no reordena, respeta el sort activo. Ya no corta por ventana de 24h (ese corte se fue con la píldora "Pendientes", que salió de la bandeja) |
| `inbox-paging.ts` | Cursor de paginación de la bandeja (29/8/2026): `ConversationCursor` (`lastMessageAt`/`id`, orden del servidor) y `cursorAfterPage` (última fila de una página, o `null` si vino vacía). Cursor por VALOR, no por posición: reemplaza el `offset` que `crm-shell.tsx` usaba para "cargar más", que perdía filas cuando una conversación subía al tope en medio de la bajada de la lista. Gana `mergeById` (une dos tramos sin repetir, el primero manda), movida de `crm-shell.tsx` tras una revisión de código: vivía duplicada con el dedupe-append que `loadMoreServerRows` reimplementaba a mano en `inbox-sidebar.tsx`. Gana `reconcileHead` (29/8/2026): une una cabecera fresca con lo acumulado y suelta lo que salió del conjunto —en "No leídas"/"Mías" la pertenencia es un predicado y las filas se van, cosa que `mergeById` no puede saber—, por posición e id y nunca por fecha. El módulo se queda PURO a propósito: sus tests corren en entorno node y `data.ts` lo importa desde el servidor |
| `message-search.ts` | Buscar conversaciones por lo que se dijo adentro (no solo nombre/número) |
| `message-grouping.ts` | Galerías de fotos/videos consecutivos y separadores de fecha |
| `outbox.ts` | Cola de envío del composer (pura, sin red): reintento, descarte, limpieza |
| `sale-cart.ts` | Carrito de la venta en curso: lo cotizado por la IA más lo agregado a mano |
| `playbook-price.ts` | Detecta escenarios con precio escrito a mano (que envejece sin que nadie lo toque) |
| `bcv-schedule.ts` | Cuándo volver a preguntar la tasa al BCV (no publica todos los días) |
| `chart-scale.ts` | Líneas de referencia de los gráficos |
| `format.ts` | Formatos de hora/moneda coherentes en toda la app |
| `time-zone.ts` | Una sola zona horaria: la del equipo (`NEXT_PUBLIC_CRM_TIME_ZONE`), no la del navegador |
| `venezuela.ts` | Los 24 estados |
| `storage.ts` | La URL que se guarda en `messages.media_url`: relativa al CRM, no al bucket |
| `media-link.ts` | URL firmada de 10 min para que Meta descargue el adjunto saliente |
| `whatsapp-window.ts` | La regla de las 24h de Meta |
| `redis.ts` | Conexión compartida a Redis (una por proceso) |
| `log.ts` | Registro estructurado JSON (`{"level","event","ts",...}`), eventos en español, oculta valores sensibles |
| `permisos-funciones.test.ts` | Guardián estático: lee las migraciones de `supabase/migrations` y falla si una función `security definer` nueva no trae su `revoke execute ... from anon, authenticated` explícito por firma en la misma migración que la crea |
| `agent-tool-keys.ts` | Claves de `agent_tools` sin `server-only`, para que el panel las use |
| `use-clock.ts`, `use-debounced-callback.ts`, `use-element-width.ts`, `use-long-press.ts`, `use-theme.ts` | Hooks utilitarios (reloj cuantizado, agrupación de refrescos, ancho real, long-press, tema) |
| `use-live-conversations.ts` / `use-live-refresh.ts` / `use-live-sales.ts` | Realtime: mantener bandeja/ventas al día aplicando eventos en memoria y agrupando refetches |
| `use-inbox-pager.ts` | El paginador por cursor de la bandeja, uno solo para las tres píldoras (29/8/2026): cursor + candado en vuelo + sesión + `reachedEnd` + estado de la primera página (loading/ready/error). Todo lo que decide se lee de un ref y no del render: dos eventos de scroll del mismo frame veían el mismo snapshot y disparaban dos consultas con el mismo cursor. Nació de una revisión que encontró la misma máquina escrita dos veces —`cursorRef`+flags en el shell, `serverRows`+`serverSessionRef`+`serverBusyRef` en el sidebar— endurecida a medias en cada copia. El shell lo usa sembrado (`seed`); el sidebar, uno por píldora (`sessionKey`). Un fallo NUNCA enciende `reachedEnd`: por eso existe `status: 'error'` con `retry()` |

## `src/lib/ai` — el agente vendedor

| Archivo | Qué es |
|---|---|
| `agent.ts` | Orquestador del turno: fase 0 (escenario) ‖ fase 1 (intención) en paralelo → tool loop (máx. 5 pasos); mide tiempos por tramo. Antes de hablarle al cliente, `deliver()` confirma que el lock de `conversation-lock.ts` sigue siendo suyo (renovación fenceada por token); si lo perdió, no envía y queda `turno_lock_perdido_sin_enviar` |
| `queue.ts` | Cola de turnos: el webhook encola y sigue; debounce adaptativo (6s ráfaga / 2s pregunta cerrada, `CIERRA_LA_IDEA`); el turno que encuentra la conversación tomada se pospone 30s y vuelve a la cola (`deferred`), sin gastar intentos ni contar como atendido |
| `redis-queue.ts` | La cola en Redis con scripts Lua atómicos: cupos globales, ritmo, sweep lock |
| `conversation-lock.ts` | Un solo turno de IA por conversación, con lease de 90s en `ai_turn_lock_until` + dueño en `ai_turn_lock_token`, renovado cada 30s por el propio turno y soltado solo por quien lo tomó; un proceso que muere deja la conversación libre en ≤90s en vez de para siempre; encontrarlo tomado ya no es silencio, es `ConversationBusyError` |
| `turn-target.ts` | Identidad congelada del turno: a qué chat/cliente se le habla; cierra el riesgo de cruzar respuestas |
| `turn-delivery.ts` | Barrera contra el doble envío: un turno que ya respondió no se reintenta |
| `rate-limit.ts` | El único cuello hacia el proveedor del modelo: cuenta PETICIONES, no turnos |
| `classify.ts` | Fase 1: clasificación barata de intención; decide qué herramientas recibe el modelo |
| `playbooks.ts` | Fase 0: reconocimiento de escenario (respuestas predeterminadas del supervisor, enviadas tal cual; no se repiten en 6h) |
| `prompt.ts` | Identidad y reglas del agente: un solo bloque idéntico en todos los turnos (cacheable) |
| `tools.ts` | Herramientas del tool loop: catálogo, historial de pedidos, escalar; topes de resultados |
| `agent-tools.ts` | Interruptores por herramienta, en la base, cambiables en vivo |
| `catalog-search.ts` / `knowledge-search.ts` | La parte que se equivoca en silencio: cómo se arma la búsqueda en catálogo/biblioteca |
| `knowledge.ts` | Consulta de la biblioteca (políticas, garantías, horarios): información para REDACTAR, no respuestas |
| `escalate.ts` / `claim-agent.ts` | Escalamiento a humano; reclamo atómico del asesor menos recién asignado |
| `human-handled.ts` | La IA no entra donde ya escribió una persona (sin `server-only` a propósito: lo usa `data.ts`) |
| `greeting-window.ts` | El saludo lo decide el reloj de Barinas, no el mensaje (falla real del 27-08: "¡Buenos días!" a las 10 pm) |
| `send.ts` | Envío de las respuestas del turno (texto redactado o escenario con adjunto) |
| `precio.ts` | Formato de precios en código, no en el prompt: la aritmética no se le confía al modelo |
| `model.ts` | Selección de proveedor/modelo por `.env` (prod: OpenAI; dev: Gemini); clasificador puede ir aparte |
| `bcv.ts` / `bcv-fetch.ts` / `bcv-intermediate-ca.ts` | Tasa oficial del BCV leída de su web; con el certificado intermedio que su servidor no manda. Tests: `bcv.test.ts` (parseo contra el fixture real de `__fixtures__/bcv-home-2026-08-28.html`, con `it.todo` del defecto D1: punto decimal → tasa ×100), `bcv-cache.test.ts` (caché/refresco/respaldo `isStale`), `bcv-fetch.test.ts` (TLS/HTTP sin red) |
| `__fixtures__/` | Capturas literales de bcv.org.ve, sin editar; `.gitattributes` en la raíz las protege de la normalización CRLF/LF (las regex del parseo miden distancias en caracteres) |
| `pgrst.ts` | Entrecomillado seguro para filtros `.or()` de PostgREST (anti-inyección) |
| `fake-redis.ts` | Redis en memoria SOLO para pruebas que no dependen de la atomicidad Lua |

## `src/lib/supabase` y `src/lib/whatsapp`

| Archivo | Qué es |
|---|---|
| `supabase/admin.ts` | Cliente service_role (bypassa RLS); solo rutas de servidor sin sesión |
| `supabase/client.ts` / `server.ts` | Clientes anon para navegador / Server Components |
| `supabase/middleware.ts` | Sesión desde la cookie sin preguntarle a GoTrue en cada petición; redirecciones de acceso |
| `supabase/database.types.ts` | Tipos generados del schema |
| `whatsapp/meta-client.ts` | Cliente server-only de la Graph API: texto, plantillas, multimedia, reply, descarga de media |
| `whatsapp/failure-reason.ts` | Del código de error de Meta a una frase accionable para el asesor |
| `whatsapp/phone.ts` | Qué cuenta como número escribible (la falla del `+undefined`) |

## `src/components`

**Shell:** `crm-shell.tsx` (cliente raíz de la bandeja: estado, realtime, outbox, navegación — 26K, el componente más cargado; la paginación de "Todos" es `useInboxPager` sembrado con la primera página que resuelve el servidor — el shell ya no guarda `cursorRef` ni banderas propias, una ráfaga de scroll disparaba varias consultas con el mismo cursor; `livePulse` (A.T6b, 29/8/2026) es un contador que sube dentro de `fetchInboxHead` cada vez que el refresco en vivo trae una cabecera fresca de `conversations`, y viaja como prop a `InboxSidebar` — es el eco que le avisa a "No leídas"/"Mías" que algo cambió en la base sin que esas dos píldoras necesiten su propio canal de realtime), `app-rail` (navegación entre secciones), `url-search-box` (buscador sincronizado con la URL), `sliding-pills` (píldoras de filtro), `context-menu`, `theme-toggle`, `section-skeleton`, `sbk-logo`, `crm.css` (49K, estilos del CRM).

**chat/:** `chat-panel` (historial + composer), `composer` (texto, adjuntos, quick replies, plantillas — 19K), `message-bubble`, `outbox-bubble` (en cola/fallido con reintento), `media-group` + `media-lightbox` (galerías), `formatted-text` (negritas estilo WhatsApp), `quoted-content` (cita), `message-context-menu`, `template-picker-modal` (reabrir fuera de 24h), `quick-replies-modal`, `window-countdown` (cuenta atrás de 24h), `delivery-check` (palomitas), `ai-status-banner`.

**inbox/:** `inbox-sidebar` (tres píldoras No leídas/Mías/Todos, abre en "No leídas"; secciones por píldora vía `inbox-sections` — ya no por ventana de 24h; "No leídas" y "Mías" se resuelven contra la base con `unreadOnly`/`assignedTo` de `data.ts`, `initialUnreadRows` siembra la primera para que abra con datos y no con "Buscando…"; contador de píldora desde la base; el buscador salta a "Todos"; paginación por cursor con `useInboxPager` (`src/lib/use-inbox-pager.ts`), el mismo paginador que usa "Todos" en el shell: `serverRows` guarda solo `{filter, rows}` y el cursor, el candado, la sesión y `reachedEnd` viven en el hook — las tres carreras del 29/8/2026 se cierran allá y se prueban allá; un fallo de la primera página (`pager.status === "error"`, A.T5) pinta "No se pudo traer la bandeja." con botón Reintentar en vez de festejar "Todo leído", sin borrar filas ya pintadas; un fallo de la página SIGUIENTE (`pager.lastPageFailed`, A.T4) cambia el botón "Cargar más conversaciones" del pie por un aviso angosto con Reintentar que llama `pager.loadMore` — no `retry`, que es solo para la primera página —, en las tres píldoras: "Todos" recibe la bandera como prop `lastPageFailed` desde `allPager.lastPageFailed` en `crm-shell.tsx`, mismo pager que ya presta `hasMore`/`onLoadMore`; `serverRows` era invisible para realtime (A.T6b, revisión de código del 29/8/2026): lo que hace ESTE asesor lo cubre `patchServerRows`, pero lo que hace OTRO —leer el chat, que se lo reasignen— llegaba por el canal de "Todos" en `crm-shell.tsx`, que no toca esta consulta aparte, así que una fila vieja sin leer podía quedarse pintada de más o de menos hasta reentrar a la píldora. El eco del pulso vivo del shell (prop `livePulse`) lo cierra: un efecto que, solo con la píldora de servidor activa y ya con filas cargadas, vuelve a pedir la cabecera de ESA píldora sin cursor y la reconcilia con `reconcileHead` (`inbox-paging.ts`) contra `current.rows` — con `freshIsComplete` SIEMPRE en `false`, porque esa cabecera nunca es el conjunto entero, solo el tamaño de una página, y tratarla como completa borraría las páginas profundas que el asesor bajó; descarta la respuesta si la píldora cambió mientras viajaba; no toca `serverPager`, es una consulta aparte de su candado/cursor/`reachedEnd`), `conversation-list-item`, `filter-scroller`, `tag-filter-menu`, `conversation-context-menu`, `agent-home-panel` (panel de inicio: Pendientes / Esperando +24 h / Tuyas — la ventana de 24h que ya no vive en la bandeja sigue viva acá), `bcv-rate-chip`.

**context-panel/:** `context-panel` (ficha del contacto junto al chat), `close-sale-modal` (cierre de venta + datos de cédula/dirección), `sale-items-editor` (carrito), `manage-tags-modal`.

**agent-control/:** `agent-control-view` (42K — la vista más grande del proyecto: interruptores, métricas, simulador, tarifas), `playbooks-panel` (escenarios), `knowledge-panel` (biblioteca), `agent-tools-panel`, `spend-cap-panel` (tope de gasto), `agent-roster-panel` (reparto entre asesores), `agent-metrics-row`, `token-usage-chart`.

**dashboard/:** `dashboard-view`, `journey-board` (recorrido del cliente), `activity-chart`, `ticket-queue`, `ticket-stats`.

**sales/:** `sales-view`, `sale-detail-modal`. **clientes/:** `clientes-view`, `cliente-ficha`, `cliente-datos-panel`, `cliente-notas`, `cliente-etiquetas`. **inventario/:** `inventario-view`, `producto-fila`. **auth/:** `login-form`.

## `supabase/`

| Qué | Dónde |
|---|---|
| Migraciones (49, timestampeadas) | `migrations/` — regla: commit propio con `[migración]` en el título |
| Seed de demo (3 usuarios, 5 conversaciones) | `seed.sql` — **no va a producción** |
| Catálogo y escenarios para producción | `seeds/moto_catalog_seed.sql`, `seeds/ai_playbooks.sql` |
| Config del stack local | `config.toml` |
| Test de permisos de funciones `security definer` | `tests/permisos_funciones.sql` — falla si alguna queda ejecutable por `anon` fuera de la lista blanca (`is_agent`, `is_supervisor_or_admin`) |

## `scripts/` y `docs/`

| Archivo | Qué es |
|---|---|
| `scripts/deploy.sh` | Despliegue por SSH: valida antes de tocar el servidor, copia, levanta, verifica TLS |
| `scripts/preflight.sh` | Frena config rota antes de arrancar (claves cruzadas, URLs locales, secretos de juguete) |
| `scripts/backup.sh` / `restore.sh` | Respaldo/restauración probados de verdad (solo `public`; el bucket no entra) |
| `scripts/verificar-respaldo.sh` | Verifica un `.sql.gz` (gzip íntegro, tamaño, `CREATE TABLE`) sin borrar ni mover nada — aísla el `pipefail` para que un SIGPIPE del productor no se lea como corrupción (bug del 29/8/2026) |
| `scripts/generar-iconos.mjs` | Iconos de la app |
| `docs/PRODUCCION.md` | LA guía de puesta en producción, paso a paso con verificación |
| `docs/superpowers/plans`, `specs/` | Planes y specs de diseño históricos (decisiones documentadas) |
