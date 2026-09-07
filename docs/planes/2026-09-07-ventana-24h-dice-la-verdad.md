# Plan · La ventana de 24 h dice la verdad

Aprobado por el operador el 6/9/2026. Rama `ventana-24h-verdad` desde
`origin/main` (= `341fd1e`; producción está en `8ee97d7`, sin migraciones
entre ambos, así que la ÚNICA migración del rango `produccion..HEAD` es la
nueva de esta corrida). Orquestador: Fable. Implementan subagentes
`general-purpose` con `model: "sonnet"`, uno por tarea, contexto limpio,
reporte obligatorio.

## Contexto

La conversación `aa75ef33…` (+593987317372) muestra la caja de texto
habilitada y "quedan 11 h" mientras Meta rechaza todo con 131047. Causa: el
6/9 02:54 UTC entró un `unsupported` de Meta guardado como `inbound`, y
`handle_new_message()` mueve `last_customer_message_at` con CUALQUIER
inbound. Meta no cuenta ese evento; el CRM sí. Y cuando Meta dice
explícitamente "ventana cerrada" (131047), el CRM lo ignora.

Dos candados, ambos en la base, para que `isWithin24hWindow` /
`withinFreeformWindow` / la píldora de la lista / `agent.ts:226` (la IA no
intenta enviar fuera de ventana) den la respuesta correcta sin tocar
TypeScript, más una red de seguridad chica en el composer.

## Hallazgos de la lectura que cambian el diseño respecto al brief

1. **La IA inserta sus mensajes YA con `whatsapp_status='failed'` y
   `whatsapp_error_code`** (`src/lib/ai/send.ts:126` y `:157`,
   `...entrega`). El trigger de status (`on_message_status_changed`, `after
   update of whatsapp_status, is_auto_reply`) NUNCA dispara para esos
   fallos. → **El candado 2 tiene que vivir en LAS DOS funciones**:
   `handle_message_status_change()` (camino del asesor:
   `send/route.ts:260-267` hace un solo UPDATE con status + código → sí
   dispara; y el callback de Meta en `webhooks/whatsapp/route.ts:888-894`,
   también un solo UPDATE) y `handle_new_message()` (camino de la IA: INSERT
   ya fallido).
2. **`least(null, x)` en Postgres devuelve `x`**: un 131047 sobre una
   conversación que nunca tuvo mensaje del cliente (asesor que escribe texto
   libre a un número nuevo) pondría `last_customer_message_at` NO nulo y
   encendería `awaiting_reply` (columna generada: `lcma is not null and
   (last_reply_at is null or last_reply_at <= lcma)`) para un cliente que
   nunca escribió. → Guardar: si `lcma is null`, se queda null.
3. **Callback tardío**: si el mensaje fallido es ANTERIOR al último mensaje
   real del cliente (mensaje sale a las 10:00 en `pending`, el cliente
   escribe a las 10:05, Meta confirma el fallo a las 10:06),
   `least(lcma, created_at − 24h)` cerraría una ventana que el cliente acaba
   de reabrir. → Aplicar el candado 2 solo cuando
   `new.created_at > last_customer_message_at`.
4. **D3 (6/9/2026) quiso lo contrario**: el comentario del webhook
   (`route.ts:~977-983` y `~1395-1401`) dice que el `unsupported` solo
   "cuenta como entrante para que caiga en Pendientes". Con el candado 1 eso
   deja de ser cierto (ni `lcma`, ni `unread_count`, ni `awaiting_reply`).
   Decisión: seguir el brief —Meta no lo cuenta, así que el CRM tampoco
   puede fingir que abre la ventana—; el `unsupported` **sigue siendo
   visible** (mueve `last_message_at`/preview/direction, la conversación
   sube en la lista y la burbuja marcador de D3 se ve en el chat). Los
   comentarios del webhook se corrigen en T2. Deuda que queda declarada: sin
   `unread_count` ni `awaiting_reply`, la única señal es la burbuja y el
   reorden de la lista.
5. **Realtime existe**: `crm-shell.tsx:840-844` se suscribe a `UPDATE` de
   `conversations` filtrado por el chat abierto (`scheduleDetailRefresh`) y
   a `messages` del mismo chat (`:815`); la lista entera escucha
   `conversations` en `use-live-conversations.ts:193`. La red de seguridad
   del composer cubre solo el hueco entre el rechazo y el refresh, y una
   desconexión del canal. `Composer` NO recibe `messages` hoy; `ChatPanel`
   sí los tiene (`chat-panel.tsx:41`).
6. **Cómo probar el backfill en CI** (base vacía, migración ya aplicada): el
   test `ventana_24h.sql` siembra las filas "históricas" y ejecuta `\i
   supabase/migrations/20260907010000_ventana_24h_dice_la_verdad.sql` DENTRO
   de su transacción (ruta relativa a la raíz del repo, que es desde donde
   corre `psql` en CI y en local). Exige que la migración sea idempotente:
   solo `create or replace function` (sin tocar triggers:
   `on_message_inserted` y `on_message_status_changed` ya disparan donde
   hace falta) y `update`s re-ejecutables.
7. **Sin test previo de `whatsapp-window.ts`**: no existe
   `whatsapp-window.test.ts`; solo la pata 4 de
   `ventana-24h-contrato.test.ts`. T2 lo crea. `composer.test.tsx` y
   `window-countdown.test.tsx` sí existen.
8. **Local**: hay `psql` 18 en `C:/Program Files/PostgreSQL/18/bin/psql.exe`
   y la base local `supabase_db_Liminal_CRM` (127.0.0.1:54322,
   `postgres/postgres`) tiene 58/59 migraciones (falta `20260906020000`,
   transaccional: `drop index`/`create index` sin `concurrently`).
   Validación local = aplicar esa + la nueva con `psql -f`, correr el `.sql`
   de test, y las mutaciones.

## T1 · Migración + test SQL (commit propio, título con `[migración]`)

**Archivos:**
`supabase/migrations/20260907010000_ventana_24h_dice_la_verdad.sql` (nuevo),
`supabase/tests/ventana_24h.sql` (nuevo), `.github/workflows/ci.yml` (paso
nuevo en el job `migraciones`, mismo formato que el de
`whatsapp_status_forward.sql`), `docs/GLOSARIO.md` (fila de la migración y
del test en la tabla de migraciones, mismo estilo que la fila de
`20260905070000`).

**Migración** (cabecera en español con el caso del 6/9/2026 y el porqué de
cada candado; sin `security definer` nueva → sin revokes; `create or
replace` conserva el ACL, igual que 20260905070000):

- `handle_new_message()`: copiar la versión de `20260905010000:65-127` y
  cambiar:
  - `last_customer_message_at`: `when new.direction='inbound' and
    new.message_type <> 'unsupported' then new.created_at` … **candado 2 por
    INSERT**: `when new.direction='outbound' and new.whatsapp_status='failed'
    and new.whatsapp_error_code=131047 and last_customer_message_at is not
    null and new.created_at > last_customer_message_at then
    least(last_customer_message_at, new.created_at - interval '24 hours')` …
    `else last_customer_message_at`.
  - `unread_count`: `when new.direction='inbound' and new.message_type <>
    'unsupported'`.
  - `visible`, `last_message_*`, `has_reply`, `last_reply_*`: SIN cambios.
- `handle_message_status_change()`: copiar la versión de
  `20260905070000:63-116` y añadir un tercer bloque: `if
  new.whatsapp_status='failed' and new.whatsapp_error_code=131047 and
  new.direction='outbound' then update conversations set
  last_customer_message_at = least(last_customer_message_at, new.created_at -
  interval '24 hours'), updated_at=now() where id=new.conversation_id and
  last_customer_message_at is not null and new.created_at >
  last_customer_message_at`. Los dos bloques existentes no se tocan.
- **Backfill**, en este orden, cada uno con `raise notice` del conteo
  (dentro de `do $$`):
  - (a) `update messages set message_type='unsupported' where
    direction='inbound' and message_type='text' and content like 'El cliente
    envió un mensaje que el CRM todavía no sabe mostrar%'`.
  - (b) conversaciones cuyo `lcma` coincide con el `created_at` de un
    inbound `unsupported`: `lcma = (select max(created_at) from messages
    where conversation_id=c.id and direction='inbound' and message_type <>
    'unsupported')` (null si no hay). `unread_count` no se recalcula (no hay
    forma fiable; se documenta).
  - (c) regla 131047 sobre lo ya registrado: por conversación con `lcma not
    null`, `lcma = least(lcma, min(m.created_at) - 24h)` sobre los outbound
    `failed`/131047 con `m.created_at > c.lcma`.
  - Verificación esperada en producción: `aa75ef33…` →
    `2026-08-31 16:50:35+00`.

**Test `supabase/tests/ventana_24h.sql`** (formato
`whatsapp_status_forward.sql`/`awaiting_reply.sql`: `begin` … `do $$` con
`errores` acumulados y `raise exception` … `rollback` … `\echo`;
`created_at` explícitos y crecientes —`now()` es constante dentro de la
transacción—; ids `66666666-…`). Casos, en este orden y con estos nombres
(T2 los espeja):

1. `inbound text abre la ventana` — lcma = t, unread_count +1,
   awaiting_reply true.
2. `inbound unsupported no mueve la ventana` — lcma y unread_count intactos;
   `last_message_at` SÍ avanza (visible).
3. `fallo saliente 131047 cierra la ventana a created_at menos 24h` —
   camino UPDATE (insert en `pending`, luego `update set
   whatsapp_status='failed', whatsapp_error_code=131047` en una sola
   sentencia, como `send/route.ts`).
4. `fallo con otro código no toca la ventana` — 131026.
5. `tras el cierre por 131047 un inbound text la reabre`.
6. `el backfill reclasifica el texto histórico y recalcula` — siembra una
   conversación aparte con inbound real viejo + fila `text` con el
   contenido fijo histórico (lcma inflado) + outbound `failed` 131047
   posterior; `\i` de la migración; comprueba `message_type='unsupported'`,
   lcma = el inbound real (b) y que (c) no lo empeora; y un `select` de
   evidencia para el reporte.
7. `fallo 131047 insertado ya fallido cierra la ventana` — camino INSERT de
   la IA (`whatsapp_status='failed'` y código en el propio insert).
8. `fallo 131047 sin mensaje del cliente deja la ventana en null` — lcma
   null antes y después; awaiting_reply sigue false.
9. `fallo 131047 anterior al último mensaje del cliente no toca la ventana`
   — callback tardío.

**Criterio de terminado T1:** `psql -f supabase/tests/ventana_24h.sql` en
verde contra la base local con la migración aplicada; los demás `.sql` de
`supabase/tests` siguen en verde (sobre todo `awaiting_reply.sql` y
`permisos_funciones.sql`); reporte con la definición final de las dos
funciones, salida cruda de psql y el `select` del caso 6. Commit: `[migración]
La ventana de 24 h solo la abre el cliente y la cierra el 131047 de Meta` (o
similar narrativo).

## T2 · Red de seguridad en el cliente + contrato TS (commit propio, sin migración)

**Archivos:** `src/lib/whatsapp-window.ts`, `src/lib/whatsapp-window.test.ts`
(nuevo), `src/components/chat/composer.tsx`,
`src/components/chat/composer.test.tsx`, `src/components/chat/chat-panel.tsx`,
`src/app/api/webhooks/whatsapp/route.ts` (solo comentarios de D3 y el
`log.info` de `webhook_unsupported_guardado`), `docs/GLOSARIO.md` (filas de
cada archivo tocado).

- `whatsapp-window.ts`:
  - `windowClosedByMeta(messages: Pick<Message,'direction'|'messageType'|'whatsappStatus'|'whatsappErrorCode'|'createdAt'>[]): boolean`
    — true si el outbound más reciente con `whatsappStatus==='failed' &&
    whatsappErrorCode===131047` no tiene ningún inbound con `messageType !==
    'unsupported'` posterior (espejo del candado 1: un `unsupported` no
    reabre).
  - `isComposerWindowOpen(lastCustomerMessageAt, messages, now?)` =
    `isWithin24hWindow(...) && !windowClosedByMeta(messages)`.
  - `WINDOW_MS`, `isWithin24hWindow`, `hoursUntilWindowCloses` sin cambios
    (los usan webhook, agent, lista).
- `chat-panel.tsx` pasa `messages` al `Composer`; `Composer` gana la prop
  `messages: Message[]` y `withinWindow` pasa a
  `isComposerWindowOpen(conversation.lastCustomerMessageAt, messages)`
  (useMemo). Con eso `disabled`, placeholder "Ventana de 24h cerrada — usa
  una plantilla", el aviso con candado (`:390-400`) y el `WindowCountdown`
  (`:407-409`, solo se pinta con `withinWindow`) quedan cubiertos sin tocar
  `window-countdown.tsx`.
- Comentarios del webhook: reemplazar "contando como entrante para que caiga
  en Pendientes" por la verdad nueva (visible en el chat y la lista, pero no
  abre ventana ni cuenta como no leído; Meta tampoco lo cuenta —caso del
  6/9/2026—).
- **Tests:** `whatsapp-window.test.ts` con `describe` por caso, mismos
  nombres y orden que los casos 1-5, 7, 8, 9 del `.sql` (el 6 es solo SQL;
  en TS el 7 y el 3 colapsan en "hay un failed 131047 sin inbound
  posterior", el 8 en "sin lcma sigue cerrada", el 9 en "inbound real
  posterior al fallo → abierta"). `composer.test.tsx`: dos casos nuevos —
  lcma reciente + último outbound `failed` 131047 → textarea deshabilitada,
  placeholder de plantilla, sin "quedan"; y el mismo hilo con un inbound
  `text` posterior → habilitada. `ventana-24h-contrato.test.ts`: solo si
  hace falta; no se espera cambio (la pata 4 sigue midiendo
  `isWithin24hWindow`).
- **Criterio de terminado T2:** `rtk npm run test`, `rtk npm run lint`, `rtk
  npx tsc --noEmit` en verde; reporte con archivos, decisiones y el
  hallazgo del realtime (punto 5 de arriba, confirmado leyendo
  `crm-shell.tsx`).

## T3 · Documentación (commit propio)

- `CLAUDE.md`, Trampas conocidas: "`last_customer_message_at` solo se mueve
  con un inbound no-`unsupported`; un saliente `failed` con 131047 la cierra
  a `created_at − 24 h` (los dos triggers, 20260907010000). No escribir esa
  columna a mano desde TypeScript. Un `unsupported` es visible pero no abre
  ventana ni cuenta como no leído."
- `docs/PRODUCCION.md` §2: párrafo de `20260907010000` como el de
  `20260905070000` (qué corrige, consulta para medir cuántas conversaciones
  toca antes de aplicarla, verificación de `aa75ef33…`); §7 "En Dokploy":
  Dokploy NO aplica migraciones — respaldo, aplicar a mano en
  `supabase-db`, registrar en `supabase_migrations.schema_migrations`, y
  solo después `compose.deploy`; el contador de la comprobación final pasa
  de 59 a 60.
- `docs/planes/2026-09-07-ventana-24h-dice-la-verdad.md`: este plan + el
  brief del operador (mismo patrón que `2026-09-06-prompt-orquestador.md`).
- `docs/GLOSARIO.md`: revisar que T1 y T2 dejaron sus filas; completar lo
  que falte.

## Validación del orquestador (antes de cerrar cada tarea)

- Leer el reporte entero; sin reporte no hay tarea.
- Correr yo: `rtk npm run test`, `rtk npm run lint`, `rtk npx tsc --noEmit`,
  y `psql … -f supabase/tests/ventana_24h.sql` + `awaiting_reply.sql` +
  `permisos_funciones.sql` contra la base local con la migración aplicada.
- **Mutaciones** (sobre la migración de T1, reaplicando con `psql -f` cada
  vez porque es idempotente): `'unsupported'`→`'audio'` en el candado 1 →
  caso 2 rojo; `131047`→`131048` en el candado 2 de
  `handle_message_status_change` → caso 3 rojo; `131047`→`131048` en el
  candado 2 de `handle_new_message` → caso 7 rojo. Revertir y reaplicar. Si
  algo no se pone rojo, la tarea vuelve.
- `git log`: migración sola en su commit con `[migración]`; tres commits en
  total sobre `origin/main`.

## Salida a producción (solo con confirmación paso a paso del operador; fuera del alcance de los subagentes)

Respaldo → aplicar `20260907010000` a mano en `supabase-db` y registrarla →
`select last_customer_message_at from conversations where
id='aa75ef33-…'` = `2026-08-31 16:50:35+00` → merge a `main`, push,
`compose.deploy` según `/root/respaldos/RUNBOOK-deploy-20260906.md`, 12
labels de Traefik y `/api/health` → abrir el chat de +593987317372: caja
bloqueada, aviso de plantilla, sin contador.

## Fuera de alcance (declarado)

- Que el trigger de status dispare cuando solo cambia
  `whatsapp_error_code` (hoy ambos escritores lo cambian junto con el
  status).
- La vista previa "Unsupported" de la lista (deuda D3) y `unread_count` de
  conversaciones ya infladas.
- La píldora "18 h" de `conversation-list-item` no conoce `messages`: se
  corrige sola por realtime cuando la base fija `lcma`.
- La bienvenida automática ante un `unsupported` solo (`claimWelcome`):
  comportamiento actual, no lo toca este cambio.

## Brief del operador

El plan menciona un "brief del operador" (ver T3 arriba) pero este
documento —la copia de trabajo del plan que usó el orquestador— no trae esa
sección aparte; a diferencia de `2026-09-06-prompt-orquestador.md`
(compañero del plan "El cliente que cambió de número"), esta corrida no
generó un prompt orquestador propio como archivo separado. El brief real
del operador que dio origen a esta corrida no está disponible para este
subagente de documentación: no se reconstruye aquí para no inventarlo.

## Resultado de la corrida

Ejecutada el 7/9/2026, dos commits sobre `341fd1e` (rama
`ventana-24h-verdad`):

- `bbf9f53` — **`[migración]` La ventana de 24 h solo la abre el cliente y
  la cierra el 131047 de Meta** (T1). `create or replace` de
  `handle_new_message()` y `handle_message_status_change()`, candado A
  (`unsupported` no mueve lcma/`unread_count`) y candado B (`failed`/131047
  cierra lcma a `created_at − 24h`, con las dos guardas de `lcma is not
  null` y `created_at > lcma`) en las dos funciones. Backfill idempotente en
  tres pasos con `raise notice`. Test `supabase/tests/ventana_24h.sql`
  (nueve casos), cableado en CI. Archivos:
  `.github/workflows/ci.yml` (+14), `docs/GLOSARIO.md` (+1),
  `supabase/migrations/20260907010000_ventana_24h_dice_la_verdad.sql`
  (+351), `supabase/tests/ventana_24h.sql` (+314).
- `028b501` — **El composer le cree a Meta cuando rechaza un envío con
  131047** (T2). `whatsapp-window.ts` gana `windowClosedByMeta(messages)` e
  `isComposerWindowOpen`; `chat-panel.tsx` reenvía `messages` al
  `Composer`, que calcula `withinWindow` con `isComposerWindowOpen` en un
  `useMemo`; comentarios de D3 en el webhook corregidos. Tests:
  `whatsapp-window.test.ts` (nuevo, espeja los casos 1-5, 7-9 del `.sql`) y
  dos casos nuevos en `composer.test.tsx`. Archivos: `docs/GLOSARIO.md`
  (+6/-0), `src/app/api/webhooks/whatsapp/route.ts` (+38/-19),
  `src/components/chat/chat-panel.tsx` (+1), `composer.test.tsx` (+86),
  `composer.tsx` (+26), `whatsapp-window.test.ts` (+179),
  `whatsapp-window.ts` (+71).

**Validación del orquestador:**

- Tests SQL (`ventana_24h.sql`, `awaiting_reply.sql`,
  `permisos_funciones.sql`) en verde contra la base local con la migración
  aplicada.
- Mutaciones sobre la migración de T1, cada una reaplicada con `psql -f`
  (idempotente) y revertida después: `'unsupported'`→`'audio'` en el
  candado A puso rojo el caso 2; `131047`→`131048` en el candado B de
  `handle_message_status_change` puso rojo el caso 3; `131047`→`131048` en
  el candado B de `handle_new_message` puso rojo el caso 7. Las tres
  mutaciones se comportaron como predecía el plan.
- `rtk npm run test`: 119 archivos, 1621 tests, verde. `rtk npm run lint` y
  `rtk npx tsc --noEmit`: verde.

**Deuda declarada (sin cambios respecto a "Fuera de alcance" arriba):** el
trigger de status no dispara si solo cambia `whatsapp_error_code`; la vista
previa "Unsupported" de la lista sigue en deuda (D3); `unread_count` de
conversaciones ya infladas por `unsupported` históricos no se recalcula
(backfill paso (b), sin forma fiable de reconstruirlo); la píldora "18 h" de
`conversation-list-item` se corrige sola por realtime, no por este cambio;
la bienvenida automática ante un `unsupported` solo no se tocó.

Esta documentación (T3) se escribió con contexto limpio a partir de estos
dos commits, el plan de arriba y el resto de la documentación del repo — no
participó en T1 ni T2, así que lo anterior es una lectura del resultado, no
un reporte de primera mano de esas tareas.
