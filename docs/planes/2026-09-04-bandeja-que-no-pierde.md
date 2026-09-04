# Plan · Bandeja que no pierde

Aprobado por el operador el 4/9/2026. Base: `main` en `26d356d`. Origen: la
auditoría "Auditoría de la Bandeja" (hallazgos F1–F13). Decisiones tomadas al
aprobar: las cuatro etapas entran; no hay coexistencia con la app del teléfono
(el número se usa solo desde el CRM); la píldora nueva se llama **"Escaladas"**.

Este archivo es la fuente de verdad de la implementación. El orquestador
reparte una tarea por subagente y cada subagente recibe SOLO su sección más
las "Reglas para todos". Nada de acá se cambia sin volver al operador.

---

## Reglas para todos (orquestador y subagentes)

- Metodología `liminalwork`: el orquestador no implementa; delega, valida el
  reporte, corre los tests él mismo y hace el commit. Un subagente por tarea,
  contexto limpio, modelo Sonnet con razonamiento alto.
- Todo en español: commits narrativos (el efecto observable, nunca `feat:`),
  comentarios que cuentan el porqué y la fecha, logs vía `lib/log.ts`.
- **Cada migración va en su propio commit con `[migración]` en el título**,
  ANTES del commit del código que la usa. Nombre `supabase/migrations/2026090XNN0000_*.sql`.
- Toda función `security definer` nueva nace con `revoke execute ... from
  public` + `revoke execute ... from anon, authenticated` + el `grant` a quien
  la usa, en la misma migración. Las que se reemplazan (`create or replace`)
  conservan permisos: verificar con `has_function_privilege('anon', ...)`.
- Un cambio de lógica trae su test en el mismo commit, al lado del módulo.
  Tests de base en `supabase/tests/*.sql` (transacción + `rollback`, estilo
  `invariante_leads.sql`) cableados en el job `migraciones` de
  `.github/workflows/ci.yml`.
- Cada archivo tocado actualiza su línea en `docs/GLOSARIO.md` en el mismo
  commit. Cambios de doctrina van a `CLAUDE.md` (sección Trampas / Invariante).
- Verde antes de cerrar una tarea: `npx tsc --noEmit`, `npm run lint`,
  `npm run test -- --no-file-parallelism`; con migración además
  `supabase db reset` y los `.sql` de `supabase/tests` por `psql`
  (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`). Compilar con
  `rtk proxy npm run build` (nunca `rtk next build`) y revisar `.next/BUILD_ID`.
- Trampas vigentes de `CLAUDE.md`: mensajes de commit largos con
  `git commit -F <archivo>`; un `vi.mock` con `importOriginal()` arrastra el
  grafo entero (en tests de rutas mockear también `@/lib/ai/agent` y
  `@/lib/redis`); las tres fábricas del webhook (`route.test.ts`,
  `new-contact-race.test.ts`, `welcome-race.test.ts`) se mantienen en espejo.
- Sin `git push`, sin tocar producción, sin `supabase db push`.
- Reporte obligatorio de cada subagente al terminar: (1) qué implementó y qué
  decidió sobre la marcha, (2) archivos creados/modificados y líneas de
  glosario, (3) resultado de los tests del plan, (4) desvíos, deuda o dudas.
  El orquestador no cierra una tarea sin ese reporte ni sin correr los tests.

## Orden de ejecución

1. **E0** secuencial: T0.1 → T0.2 → T0.3 → T0.4 (la hace el orquestador).
2. **E1** en dos tandas paralelas: (T1.1, T1.2, T1.3, T1.4, T1.7) y luego
   (T1.5, T1.6), que necesitan T0.2 en main local. Cada tanda: subagentes en
   paralelo, luego suite completa antes de la siguiente.
3. **E2**: T2.1 (depende de T0.3) y T2.2 en paralelo.
4. **E3**: T3.1, T3.2, T3.3, T3.4 en paralelo.
5. Verificación final (sección al pie) y reporte de entrega.

Cada etapa termina con `tsc` + lint + suite completa + build en verde antes
de abrir la siguiente.

---

## ETAPA 0 · La base dice la verdad (F1 F2 F3 F4)

Hoy `handle_new_message` mueve `last_message_at` con TODO insert en `messages`
(migración 20260827020000), y `awaiting_reply` = `last_message_at <=
last_customer_message_at`. Por eso una nota interna, un evento de sistema
(`insertSystemEvent` en `src/lib/mutations.ts`), la bienvenida automática y un
envío de la IA rechazado por Meta apagan "esperando" sin que el cliente reciba
nada. Se separa "último mensaje visible" de "última respuesta real".

### T0.1 · [migración] La base distingue una respuesta real de una nota, un evento o una bienvenida

Archivo: `supabase/migrations/20260905010000_conversations_last_reply.sql`.
Un solo commit `[migración]`, sin TypeScript.

Cambios:
1. `alter table messages add column is_auto_reply boolean not null default false`
   (marca la bienvenida y cualquier automatismo futuro que no sea atención).
2. `alter table conversations add column last_reply_at timestamptz,
   add column last_reply_sender text check (last_reply_sender in ('agent','ai'))`.
3. `create or replace function handle_new_message()` (security definer,
   `set search_path = public`, como la vigente):
   - `visible := new.direction = 'inbound' or (new.sender_type in ('agent','ai') and not new.is_internal_note)`.
   - Solo si `visible`: `last_message_at`, `last_message_preview`,
     `last_message_direction`, `last_message_status`. Un evento de sistema o
     una nota solo tocan `updated_at`.
   - `last_customer_message_at`, `unread_count`, `has_reply`: exactamente como hoy.
   - `last_reply_at = new.created_at`, `last_reply_sender = new.sender_type`
     cuando `new.direction = 'outbound' and visible and not new.is_auto_reply
     and new.whatsapp_status is distinct from 'failed'`.
4. `create or replace function handle_message_status_change()`: además de lo
   actual, si `new.whatsapp_status = 'failed'` y la conversación tiene
   `last_reply_at = new.created_at`, recalcular `last_reply_at`/`last_reply_sender`
   con la última fila de `messages` de esa conversación que cumpla la regla de
   (3) (subconsulta `order by created_at desc limit 1`), o `null` si no hay.
5. `awaiting_reply`: `alter table conversations drop column awaiting_reply`
   (arrastra índices) y `add column awaiting_reply boolean generated always as
   (last_customer_message_at is not null and (last_reply_at is null or
   last_reply_at <= last_customer_message_at)) stored`. Recrear
   `conversations_free_unanswered_idx` (predicado de 20260828010000) y
   `conversations_pending_idx` (20260828020000) con sus predicados exactos;
   hacer `grep -n awaiting_reply supabase/migrations/*.sql` y recrear todo lo
   que dependa. `unassigned_waiting_count()` no cambia (lee por nombre).
   Actualizar el `comment on column`.
6. Índice nuevo (lo usa T1.5): `create index conversations_escalated_idx on
   conversations (last_message_at desc) where journey_stage = 'assigned' and
   not ai_enabled and status <> 'closed'`.
7. `conversation_handoffs.reason`: `alter table ... drop constraint <nombre>`
   y volver a crear el `check` con la lista actual más `'escalada'`,
   `'escalada_sin_asesor'`, `'rechazado_por_meta'` (leer 20260830040000 para
   el nombre y la lista).
8. Backfill, en la misma migración, con `update ... from (select distinct on
   (conversation_id) ...)`, sin loops:
   - `messages.is_auto_reply = true where message_type = 'template' and sender_type = 'ai'`.
   - `last_reply_at`/`last_reply_sender` = última fila outbound visible, no
     auto, no `failed`, por conversación.
   - `last_message_at`, `last_message_preview`, `last_message_direction`,
     `last_message_status` = última fila visible por conversación.
9. Verificar con `has_function_privilege` que `anon` sigue sin poder ejecutar
   las dos funciones. Si se crea alguna función auxiliar: dos revokes + grant.

Tests: `supabase/tests/awaiting_reply.sql`, transacción con `rollback`, mismo
estilo que `invariante_leads.sql`. Siembra canal, contacto y conversación y
afirma con `raise exception` en cada paso:
1. entrante → `awaiting_reply = true`;
2. nota interna de asesor (`sender_type='agent'`, `is_internal_note`) → sigue
   `true` y `last_message_preview` sigue siendo el texto del cliente;
3. evento de sistema (`sender_type='system'`, `message_type='system_event'`) → sigue `true`;
4. bienvenida (`sender_type='ai'`, `message_type='template'`, `is_auto_reply`)
   → sigue `true`, pero `last_message_at` avanzó;
5. salida de la IA con `whatsapp_status='failed'` → sigue `true`;
6. salida de la IA `sent` → `false`, `last_reply_sender='ai'`;
7. cliente vuelve a escribir → `true`;
8. respuesta de asesor `sent` (→ `false`) y luego `update messages set
   whatsapp_status='failed'` sobre esa fila → vuelve a `true`;
9. insertar un traspaso con `reason='escalada'` no falla.
Paso nuevo en `.github/workflows/ci.yml` tras "Invariante", con el mismo `psql`.

Terminado: `supabase db reset` limpio · los tres `.sql` de `supabase/tests`
pasan · `invariante_leads.sql` verde sin tocarlo · commit `[migración]` puro.
Mutación (la hace el orquestador en T0.4): quitar `and not new.is_internal_note`
de `visible` → el paso 2 se pone rojo.

### T0.2 · El código lee "última respuesta real" donde antes leía "último mensaje"

Depende de T0.1. Archivos:
- `src/app/api/webhooks/whatsapp/route.ts`: el insert de la bienvenida
  (≈ l. 262) lleva `is_auto_reply: true`.
- `src/lib/types.ts`: `BoardConversation` y `ConversationSummary` ganan
  `lastReplyAt: string | null` y `lastReplySender: "agent" | "ai" | null`.
- `src/lib/data.ts`: `CONVERSATION_BOARD_COLUMNS` selecciona `last_reply_at,
  last_reply_sender`; `mapBoardConversation`/`mapConversationSummary` las
  mapean (crudas, sin `new Date`); `fetchConversationRow` igual.
- `src/lib/use-live-conversations.ts`: el `patch` de `applyConversationRow`
  aplica `last_reply_at`/`last_reply_sender`.
- `src/lib/dashboard.ts`: `awaitingReply()` compara `lastReplyAt` contra
  `lastCustomerMessageAt` con `<=` (mismo operador que la columna); `null` en
  `lastReplyAt` = esperando si hay fecha de cliente.
- `src/lib/supabase/database.types.ts`: columnas nuevas.
- `CLAUDE.md` (Trampas: la entrada de `has_reply` gana: "`awaiting_reply` se
  apaga SOLO con una respuesta real —no con notas, eventos de sistema,
  bienvenida ni envíos `failed`— desde 20260905010000") y `docs/GLOSARIO.md`.

Tests: el archivo que cubra `awaitingReply` (`dashboard*.test.ts`) con cuatro
casos espejo de (2)(4)(5)(6) del SQL; `ventana-24h-contrato.test.ts` gana un
caso que amarra `isWithin24hWindow` (`whatsapp-window.ts`) como cuarta pata;
`data-conversations.test.ts`: el select y el mapeo conservan las columnas;
`use-live-conversations.test.tsx`: un UPDATE con `last_reply_at` se aplica en
memoria; `route.test.ts` del webhook: bienvenida con `is_auto_reply: true`
(las tres fábricas espejo iguales).

Terminado: verde · `grep -rn "lastMessageAt" src/lib/dashboard.ts` no muestra
ninguna comparación de "esperando" contra `lastMessageAt` · glosario y
CLAUDE.md en el mismo commit.

### T0.3 · Ninguna salida sin traspaso

Depende de T0.2. Archivos:
- `src/lib/ai/handoffs.ts`: `HandoffReason` suma `"escalada" |
  "escalada_sin_asesor" | "rechazado_por_meta"` con comentario de porqué.
- `src/lib/ai/escalate.ts`: tras el `update` de la conversación,
  `recordHandoff({ conversationId, toKind: "human", toId: candidate.id,
  reason: "escalada" })` o `{ toKind: "unassigned", reason: "escalada_sin_asesor" }`.
  La nota de sistema se conserva.
- `src/lib/ai/send.ts`: `sendAgentText` y `sendAgentMedia` devuelven el
  `DeliveryOutcome` (hoy `Promise<void>`).
- `src/lib/ai/agent.ts`: en cada consumidor del envío (escenario de fase 0 y
  respuesta del tool loop), si `whatsapp_status === "failed"` →
  `log.warn("turno_rechazado_por_meta", { conversationId, codigo })` y
  `recordHandoff({ toKind: "unassigned", reason: "rechazado_por_meta" })`.
  No se reintenta.
- `src/lib/ai/reconciler.ts`: confirmar que la regla de rescate mira
  `to_kind`, no `reason`; agregar caso.

Tests: `escalate.test.ts` (con candidato → `human` con `toId`; sin candidato →
`unassigned`; orden update → nota → traspaso); `send.test.ts` (el outcome
vuelve); `agent.test.ts` (un `failed` produce `recordHandoff(rechazado_por_meta)`
y ningún segundo envío); `handoffs.test.ts` (los tres reasons);
`reconciler.test.ts`. `invariante_leads.sql` e
`invariante-leads-contrato.test.ts` sin cambios, se corren.

Terminado: verde · con `api/dev/simulate-message` una escalación sin asesores
deja fila en `conversation_handoffs` y aparece en "Sin dueño".

### T0.4 · Verificación de la etapa (orquestador)

1. `supabase db reset`; correr contra el seed las tres consultas de la
   sección F de la auditoría (abajo): la consulta 1 devuelve 0.
2. Mutación manual de T0.1 hecha y revertida; resultado en el reporte.
3. Preguntar al operador en qué commit está producción; calcular
   `produccion..HEAD`; redactar el reporte de entrega por commit para el
   Claude del VPS (formato `docs/PRODUCCION.md`), con: aplicar T0.1 fuera de
   horario (antes de 9:00 Caracas) y con la app detenida por el
   `drop column`; aviso al cliente de que "van a aparecer chats escondidos";
   las tres consultas para medir antes/después.

Consulta 1 (pendientes invisibles):
```sql
select count(*) from public.conversations c
where c.status <> 'closed' and c.last_customer_message_at is not null
  and not c.awaiting_reply
  and not exists (
    select 1 from public.messages m
    where m.conversation_id = c.id and m.direction = 'outbound'
      and m.sender_type <> 'system' and not m.is_internal_note
      and coalesce(m.whatsapp_status,'sent') <> 'failed'
      and m.created_at >= c.last_customer_message_at);
```
Consulta 2 (causa del último outbound en conversaciones "apagadas"):
```sql
select case when m.sender_type='system' then 'evento de sistema'
            when m.is_internal_note then 'nota interna'
            when m.whatsapp_status='failed' then 'envío fallido'
            when m.message_type='template' and m.sender_type='ai' then 'bienvenida'
            else 'respuesta real' end as causa, count(*)
from public.conversations c
join lateral (select * from public.messages where conversation_id=c.id
              and direction='outbound' order by created_at desc limit 1) m on true
where c.status<>'closed' and not c.awaiting_reply and c.last_customer_message_at is not null
group by 1 order by 2 desc;
```
Consulta 3 (escalaciones sin traspaso):
```sql
select count(*) from public.conversations c
where c.journey_stage='assigned' and not c.ai_enabled
  and not exists (select 1 from public.conversation_handoffs h where h.conversation_id=c.id);
```

---

## ETAPA 1 · La bandeja no pierde ni cansa (F5 F7 F8 F9 F13 + Escaladas)

### T1.1 · Un chat abierto en una pestaña oculta no marca leído lo que entra (F5)

- Nuevo módulo puro `src/lib/read-on-arrival.ts`:
  `decideReadOnArrival({ visibilityState, hasFocus })` → `"mark" | "defer"`;
  `shouldFlushDeferred(visibilityState)`.
- `src/components/crm-shell.tsx`, canal `messages-{selectedId}` (≈ l. 682–707):
  el INSERT entrante consulta el módulo; si difiere, anota `pendingReadRef`;
  un listener de `visibilitychange`/`focus` en el mismo efecto marca leído
  UNA vez al volver si el chat sigue abierto. `refreshInboxCounts` en ambos
  caminos. `handleSelect` no cambia.
Tests: `read-on-arrival.test.ts` (node, tabla de casos); `crm-shell.test.tsx`
(jsdom): oculta → no llama `markConversationRead`; `visibilitychange` con el
chat abierto → exactamente una vez; cambió de chat mientras estaba oculta →
no marca el anterior.
Terminado: verde · dos pestañas, chat abierto en la de fondo, mensaje
simulado: "No leídas" lo muestra hasta que la pestaña vuelve al frente.

### T1.2 · El scroll carga solo, antes del fondo, sin saltos (F7)

- `src/components/inbox/inbox-sidebar.tsx`: reemplazar `handleListScroll`
  (l. 692–699) por un sentinel `<div className="crm-list-sentinel" aria-hidden />`
  al final de las filas y antes de avisos/botón, observado con
  `IntersectionObserver` (`root` = `.crm-list`, `rootMargin: "0px 0px 150% 0px"`).
  Intersecta y `pager.hasMore && !pager.loadingMore && !pager.lastPageFailed`
  → `pager.loadMore()`. Tras cada página se re-arma (`unobserve`/`observe`)
  para que una lista corta encadene sin scroll. El botón "Cargar más" se queda
  (red de seguridad, navegadores sin observer).
- `src/lib/data.ts`: `INBOX_PAGE_SIZE = 50`; confirmar que `page.tsx` siembra
  con la misma constante.
- `src/components/crm.css`: `.crm-list { overflow-anchor: auto; }` explícito;
  `.crm-list-sentinel { height: 1px; }`. Verificar `key` estable en filas y
  encabezados de sección.
- Safari sin anclaje: NO compensar `scrollTop` a mano en esta tarea; anotar
  como deuda si se observa.
Tests: `inbox-sidebar.test.tsx` con mock de `IntersectionObserver` que expone
el callback: visible → `onLoadMore` una vez; `loadingMore` → no;
`lastPageFailed` → no; tras `onPage` con sentinel visible → segunda llamada
sin scroll. Test que `INBOX_PAGE_SIZE` gobierna `pillQueryOptions` y la siembra.
Terminado: verde · con ≥ 200 filas locales, bajar con la rueda a velocidad
normal nunca muestra el fondo vacío antes de que aparezcan filas.

### T1.3 · "Más antiguas" pide lo antiguo a la base (F8)

- `src/lib/data.ts`: `FetchConversationsOptions.order?: "recent" | "oldest"`
  (default `recent`). Con `oldest`: `order("last_message_at", { ascending:
  true, nullsFirst: true })` + `order("id", { ascending: true })`; cursor
  invertido, documentado junto al descendente: con fecha →
  `last_message_at.gt.X` OR `and(last_message_at.eq.X,id.gt.ID)`; cursor en
  zona nula (que en ascendente va PRIMERO) → `and(last_message_at.is.null,id.gt.ID)`
  OR `last_message_at.not.is.null`. Un solo `.or()` vía `orGroups`.
- `src/lib/inbox-paging.ts`: `reconcileHead` por posición vale para ambos
  órdenes; documentarlo.
- `src/components/inbox/inbox-sidebar.tsx`: `sort` entra en `pillQueryOptions`
  y en el `sessionKey`; con `sort === "oldest"` también "Todos" resuelve en
  servidor (misma vía que la etiqueta activa).
Tests: `data-conversations.test.ts` (cuatro predicados desc/asc × fecha/nulo
capturando el `.or()` literal); `inbox-sidebar.test.tsx` (cambiar orden abre
sesión nueva; "Todos" pasa a servidor); `inbox-paging.test.ts`.
Verificar el predicado ascendente contra PostgREST local (`supabase start`),
como se hizo el 29/8 con el descendente, y dejarlo anotado en el comentario.
Terminado: verde · "Pendientes" + "Más antiguas" muestra primero la
conversación más vieja de toda la base.

### T1.4 · El tiempo real sabe cuándo se cayó (F9)

- Nuevo módulo puro `src/lib/realtime-status.ts`:
  `nextRealtimeAction(previous, status)` → `"none" | "log_down" | "resync"`
  (transición a `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` → `log_down`;
  `SUBSCRIBED` después de una caída → `resync`).
- `src/lib/use-live-conversations.ts`: `channel.subscribe((status, err) => …)`
  usa el módulo: `log.warn("realtime_canal_caido", { channelName, status })`;
  al resincronizar `requestListRefresh()` (respeta pestaña oculta).
- `src/lib/use-live-refresh.ts`: guarda `lastRefreshAt`; en `visibilitychange`
  a visible refresca si hay pendiente O si pasaron más de
  `STALE_AFTER_MS = 2 * 60 * 1000`.
- `src/components/crm-shell.tsx`: los cinco canales restantes
  (`unassigned-handoffs`, `agent-settings-changes`, `quick-replies-changes`,
  `tags-changes`, `messages-{id}`) reciben el mismo callback; `messages-{id}`
  llama `scheduleMessagesRefresh()` al resincronizar.
Tests: `realtime-status.test.ts`; `use-live-conversations.test.tsx` (el mock
de canal, l. 21–34, invoca el callback de `subscribe`; caída + re-suscripción
→ un `fetcher` extra); nuevo `use-live-refresh.test.tsx` (visible tras 3 min
→ refresca; tras 30 s sin pendiente → no).
Terminado: verde.

### T1.5 · Píldora "Escaladas" (depende de T0.2)

Definición. Servidor: `journey_stage = 'assigned' and ai_enabled = false and
status <> 'closed' and (last_reply_sender is distinct from 'agent' or
awaiting_reply)`. Memoria (`matchesFilter`): la misma fórmula sobre
`journeyStage`, `aiEnabled`, `status`, `lastReplySender`, `awaitingReply(c)`.
Sale cuando un asesor le escribe al cliente y ya no espera, o se cierra.
- `src/lib/types.ts`: `InboxFilter` suma `"escalated"` (el `switch` exhaustivo
  de `pillQueryOptions` deja de compilar hasta atenderlo: a propósito).
- `src/lib/inbox-filters.ts`: orden `pending, unassigned, escalated, unread,
  mine, all`; etiqueta "Escaladas"; `matchesFilter`.
- `src/lib/inbox-sections.ts`: secciones "Sin asesor" (`assignedAgent === null`)
  y "Con asesor".
- `src/lib/data.ts`: opción `escalatedOnly`; `fetchInboxCounts` suma
  `escalated` (índice `conversations_escalated_idx` de T0.1); `InboxCounts`.
- `src/components/inbox/inbox-sidebar.tsx`: `case "escalated"`,
  `resolvedOnServer`, contador en `filterItems`.
  `agent-home-panel.tsx`: tarjeta "Esperando asesor".
- Anchura: seis píldoras en 316 px; las tres primeras deben verse enteras.
Tests: `inbox-filters.test.ts` (seis casos: escalada sin asesor; con asesor
sin responder; con asesor que respondió; que respondió y el cliente volvió;
cerrada; IA encendida); `inbox-sections.test.ts`; `data-inbox-counts.test.ts`;
`inbox-sidebar.test.tsx`; `agent-home-panel.test.tsx`.
Terminado: verde · escalación simulada sin asesores aparece en "Escaladas ›
Sin asesor" y en "Sin dueño"; con asesor, en "Escaladas › Con asesor" y en "Mías".

### T1.6 · La fila muestra la ventana de 24 h y el motivo del fallo (depende de T0.2)

- `src/components/inbox/conversation-list-item.tsx`: cuando
  `awaitingReply(conversation)`, chip compacto con
  `hoursUntilWindowCloses(lastCustomerMessageAt)`: "18 h" (neutro), "3 h"
  (ámbar, < 4 h), "cerrada" (rojo); colores semánticos de `crm.css`, no el
  acento; reloj con `useClock` al minuto. Con `lastMessageStatus === "failed"`,
  `DeliveryCheck` lleva `title` con `failureReason` si la fila tiene el dato;
  si hace falta una columna nueva, anotarlo como deuda (NO migración acá).
- `whatsapp-window.ts` y `dashboard.ts` sin cambios.
Tests: `conversation-list-item.test.tsx` (tres estados con `now` fijo; sin
chip cuando no espera).
Terminado: verde.

### T1.7 · [migración] Búsqueda en servidor sin acentos (F13)

- `supabase/migrations/20260905020000_contacts_search_unaccent.sql`:
  `create extension if not exists unaccent` (en `extensions` si el proyecto
  las pone ahí; revisar cómo está `pg_trgm`); columna generada
  `contacts.search_text` = `lower(unaccent(coalesce(display_name,'') || ' '
  || coalesce(profile_name,'') || ' ' || coalesce(phone_number,'')))`
  — `unaccent` no es `immutable` por defecto: usar un wrapper `immutable`
  (`public.unaccent_immutable(text)`, con los dos revokes + `grant` a
  `authenticated, service_role`) o rellenar por trigger; índice `gin
  (search_text gin_trgm_ops)` si `pg_trgm` está, si no btree.
  Commit `[migración]` aparte.
- `src/lib/data.ts` `searchConversationSummaries`: filtra
  `search_text.ilike.%<normalizado>%` usando `normalizeForSearch` de
  `inbox-filters.ts`.
Tests: `data.test.ts`/`message-search.test.ts` (el término viaja normalizado);
SQL en `supabase/tests/contacts_search.sql`: inserta "José", encuentra "jose".
Terminado: verde · "jose" encuentra a José fuera de la ventana cargada.

---

## ETAPA 2 · Ciclo de vida (F6)

### T2.1 · Cerrar y reabrir, con reapertura automática (depende de T0.3)

`record_handoff()` solo está concedida a `service_role`: cerrar/reabrir
desde el navegador pasa por route handlers con cliente admin tras comprobar
la sesión (patrón de `api/messages/send`).
- Migración `20260905030000_handoff_reasons_cierre.sql`: reasons
  `'cerrada_por_asesor'`, `'reabierta_por_asesor'`, `'reabierta_por_cliente'`.
  Commit `[migración]` aparte.
- `src/lib/ai/handoffs.ts`: los tres reasons.
- `src/app/api/conversations/[id]/close/route.ts`: `status = 'closed'`,
  `insertSystemEvent`, `recordHandoff({ toKind: "closed", reason:
  "cerrada_por_asesor", createdBy: "user", fromId: agente })`.
  `.../reopen/route.ts`: `status = 'open'`, evento, `recordHandoff({ toKind:
  "human", toId: agente, reason: "reabierta_por_asesor", createdBy: "user" })`.
- `src/app/api/webhooks/whatsapp/route.ts`: el `select` de la conversación
  existente trae `status, ai_enabled`; si `closed`, ANTES del insert del
  mensaje: `status = 'open'`, evento "El cliente volvió a escribir",
  `recordHandoff({ toKind: ai_enabled ? "ai" : "unassigned", reason:
  "reabierta_por_cliente" })`.
- `src/lib/mutations.ts`: `closeConversation`/`reopenConversation` (fetch a
  las rutas). `conversation-context-menu.tsx`: "Cerrar conversación" /
  "Reabrir". Cabecera del chat (`src/components/chat/`): misma acción.
- `crm-shell.tsx`: el UPDATE de `status` ya viaja por "applied"; nada más.
Tests: `close/route.test.ts`, `reopen/route.test.ts` (401 sin sesión; efecto
+ traspaso); webhook `route.test.ts` (entrante sobre cerrada reabre y deja
traspaso; fábricas espejo actualizadas en los tres tests);
`conversation-context-menu.test.tsx`; `invariante_leads.sql` caso 6 "cerrada
y el cliente volvió con la IA apagada: CUENTA" y su gemelo en
`invariante-leads-contrato.test.ts`.
Terminado: verde · cerrar desde el menú saca la fila de "Pendientes"; un
mensaje simulado la devuelve con el evento visible.

### T2.2 · [migración] Fijar hasta tres chats por asesor; píldora y orden recordados

- `20260905040000_conversation_pins.sql`: `conversation_pins (agent_id
  references agents, conversation_id references conversations, created_at,
  primary key (agent_id, conversation_id))`; RLS: cada agente lee/escribe solo
  las suyas (`agent_id = auth.uid()`; seguir el patrón de las políticas
  existentes con `is_agent()`); trigger `before insert` que rechaza el cuarto
  pin con mensaje en español (función security definer → dos revokes + grant,
  o `security invoker` si no hace falta definer). Commit `[migración]` aparte.
- `data.ts`: `fetchPinnedIds`; `mutations.ts`: `pinConversation`/`unpin`;
  `inbox-filters.ts`: `applyInboxFilters` recibe `pinnedIds` y los pone
  primero respetando el orden interno; `inbox-sidebar.tsx`: menú "Fijar"/
  "Desfijar", pin visible en la fila; refresco tras mutar (sin canal nuevo).
- Persistencia de `filter` y `sort` en `localStorage` bajo
  `sbk:inbox:{agentId}`, `try/catch`, default `DEFAULT_INBOX_FILTER`.
Tests: `inbox-filters.test.ts` (fijados primero); SQL `supabase/tests/pins.sql`
(el cuarto pin falla; otro agente no ve los pins ajenos);
`inbox-sidebar.test.tsx` (recuerda la píldora; no rompe sin `localStorage`).
Terminado: verde.

---

## ETAPA 3 · Cableado de la Cloud API

Todo habla con Meta desde el servidor (`src/lib/whatsapp/meta-client.ts`,
`GRAPH_API_VERSION` de env); el token nunca toca el navegador; cada llamada
nueva tiene test de payload como las actuales. Referencia de payloads: la
sección G de la auditoría y §13–§15 de "Anatomía de WhatsApp".

### T3.1 · Ticks azules y "escribiendo…" hacia el cliente

- `meta-client.ts`: `markWhatsappRead(phoneNumberId, token, wamid)` →
  `POST /{PHONE_NUMBER_ID}/messages` con `{ messaging_product: "whatsapp",
  status: "read", message_id }`; `sendTypingIndicator(...)` → mismo cuerpo más
  `typing_indicator: { type: "text" }`. Errores → `log.warn`, nunca rompen.
- `POST /api/conversations/[id]/read`: con sesión, último
  `whatsapp_message_id` entrante; llama a Meta si el canal está `connected`.
  `crm-shell.tsx`: junto con `markConversationRead` en `onSelect` y en el
  camino de T1.1 (solo cuando de verdad se marca leído).
- `POST /api/conversations/[id]/typing`: `composer.tsx` lo llama al primer
  carácter y lo renueva cada 20 s mientras haya texto
  (`use-debounced-callback`); se detiene al enviar o vaciar. `agent.ts`: lo
  dispara al arrancar la redacción, solo dentro de la ventana.
- `docs/PRODUCCION.md`: nota (mismo token, no consumen cupo).
Tests: payloads exactos en el test de `meta-client`; rutas (401 sin sesión;
no-op con canal simulado; llamada con canal conectado); `composer.test.tsx`
(un disparo por 20 s); `agent.test.ts` (typing antes del modelo; no fuera de
ventana).

### T3.2 · [migración] Entrantes completos: botones, listas, pedidos, anuncios, `played`

- `20260905050000_messages_interactive_payload.sql`: `message_type` admite
  `'interactive'`, `'order'`, `'unsupported'`; `whatsapp_status` admite
  `'played'` (revisar `keep_whatsapp_status_moving_forward` para que `played`
  sea más avanzado que `read`); `messages.payload jsonb`;
  `conversations.referral jsonb`. Commit `[migración]` aparte.
- `webhook/route.ts`: `interactive.button_reply`/`list_reply` (content
  `"Respondió: {title}"`, `customerText = title`, `payload` con id);
  `button` (plantilla, igual + `payload.template`); `order` (content = resumen
  en español con ítems y total; `customerText` = `order.text` si viene;
  `payload` con `catalog_id`, `product_items`); `message.referral` →
  `conversations.referral` + evento de sistema "Llegó desde el anuncio …";
  `context.referred_product` → `payload`. El `else` deja `content = null`,
  `message_type = 'unsupported'`, `payload.type` (F10). `value.errors` →
  `log.error("webhook_error_meta")`. Registrar el `error` del `update` de statuses.
- `src/lib/ai/agent.ts` (historial ≈ l. 150–158): salta `unsupported`; para
  `order` usa el resumen.
- `src/components/chat/message-bubble.tsx`: tarjeta de pedido; chip
  "respondió a: …"; banner de anuncio en cabecera cuando `referral` tiene
  < 72 h. `delivery-check.tsx`: icono "reproducido".
Tests: `route.test.ts` (botón, lista, botón de plantilla, pedido, referral,
`played`, con payloads de la documentación de Meta); `message-bubble.test.tsx`;
`agent.test.ts` (salta `unsupported`).

### T3.3 · Plantillas con variables y errores de Meta completos

- `meta-client.ts`: `sendWhatsappTemplate` acepta `components` (body
  parameters posicionales; cabecera de texto si aplica).
- `api/messages/send`: `kind: "template"` recibe `variables: string[]`, arma
  los components; guarda en `content` el cuerpo con variables sustituidas.
- `src/components/chat/template-picker-modal.tsx`: detecta `{{n}}` en
  `body_preview`, un campo por variable con sugerencias (nombre del contacto;
  último repuesto cotizado si existe), vista previa renderizada antes de
  enviar; plantillas con `status <> 'approved'` deshabilitadas con tooltip.
- `src/lib/whatsapp/failure-reason.ts`: tabla completa (131050, 131056,
  130429/80007/4, 132000/132001/132012/132015/132016, 131037/131031/368/
  133010, 131064) con frase en español y acción sugerida;
  `message-bubble.tsx` muestra la acción cuando aplica (131047 → abrir
  selector de plantillas).
Tests: payload con components; `send/route.test.ts` (variables → components y
content sustituido); `template-picker-modal.test.tsx`; `failure-reason.test.ts`.

### T3.4 · [migración] Salud del número y estado de plantillas

- `20260905060000_whatsapp_channel_health.sql`: `whatsapp_channels.quality_rating
  text`, `messaging_limit text`, `account_restrictions jsonb`,
  `health_updated_at timestamptz`. Commit `[migración]` aparte.
- `webhook/route.ts`: además de `messages`, atender
  `message_template_status_update` (actualiza `templates.status` por nombre e
  idioma; `log.error` si pasa a `PAUSED`/`DISABLED`/`REJECTED`),
  `phone_number_quality_update` y `account_update` (guardan en el canal;
  `log.error` cuando baja la calidad o llega una restricción).
- `api/health`: expone calidad y límite. Control de IA
  (`src/components/agent-control/`): tarjeta "Salud del número" (calidad,
  límite, fecha; "sin datos" hasta el primer webhook).
- `docs/PRODUCCION.md` §5: los tres campos deben suscribirse en la app de
  Meta (paso manual del operador).
Tests: `route.test.ts` (los tres campos con payloads de la documentación);
test de `health`; componente de Control de IA.

---

## Verificación final y entrega

1. Al cerrar cada etapa: `npx tsc --noEmit`, `npm run lint`, `npm run test --
   --no-file-parallelism`, `rtk proxy npm run build` (+ `.next/BUILD_ID`),
   `supabase db reset` + `.sql` de `supabase/tests`.
2. Al terminar todo: las tres consultas de T0.4 sobre el seed dan 0 / solo
   "respuesta real" / 0. Escenario extremo a extremo con
   `api/dev/simulate-message`: cliente nuevo → bienvenida → IA escala sin
   asesor → aparece en "Pendientes", "Sin dueño" y "Escaladas"; asesor abre
   desde pestaña oculta → sigue en "No leídas"; se auto-asigna → sigue en
   "Pendientes"; contesta → sale de todas menos "Mías" y "Todos"; cierra →
   sale; el cliente vuelve → reabre.
3. Mutaciones manuales, una por etapa, anotadas: T0.1 (quitar la guarda de
   notas), T1.2 (invertir la condición del sentinel), T2.1 (no reabrir en el
   webhook). Cada una pone rojo su test.
4. Reporte de entrega para el Claude del VPS: por commit, migraciones en
   orden (`produccion..HEAD`), pasos manuales de Meta (T3.4), consultas para
   medir antes/después, aviso al cliente por el backfill. Sin `push`.

## Riesgos acotados

- `drop column awaiting_reply` con la app corriendo: aplicar fuera de horario
  y con la app detenida (reporte).
- El backfill devuelve a "Pendientes" conversaciones que hoy parecen atendidas: avisar al cliente.
- Seis píldoras en 316 px: `FilterScroller` desplaza; las tres primeras enteras.
- `IntersectionObserver` no existe en jsdom: el test lo simula; el botón queda.
- Cursor ascendente con zona nula: verificar contra PostgREST local.
- Llamadas extra a Meta: no cuentan como mensajes; se registran; typing ≤ 1/20 s.
- Campos de webhook no suscritos en Meta: la tarjeta muestra "sin datos".

## Fuera de alcance (no tocar en esta corrida)

`owner_kind` + `response_due_at` (plan propio con una semana de números);
catálogo de Meta, mensajes de producto y Flows; coexistencia con la app del
teléfono (el operador confirmó que no existe); "leído por asesor".
