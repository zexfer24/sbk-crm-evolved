# Entrega — "Nada sin leer, un solo catálogo y la factura Saint" (19/9/2026)

Para el Claude del VPS. Plan aprobado:
`docs/planes/2026-09-18-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`.
Corrida completa en código, HEAD `e7d846e` sobre `main`. Metodología
`liminalwork`: contexto → plan → subagentes `implementador` → reportes →
este documento.

## Antes de nada: confirmar en qué commit está producción

**No asumas `3802fad`.** Esa fue la medición del Claude del VPS el
18/9/2026 (base en migración `20260915010000`, árbol y base coincidían),
pero esta corrida se hizo el 19/9/2026 y puede que otra sesión ya haya
entregado parte de lo pendiente desde entonces (las tres migraciones de "La
IA no vuelve a pedir lo que ya pidió"/Seba, o la corrida "Seba atiende el
mostrador" completa). **Corre `git log --oneline <tu-HEAD-en-produccion>..e7d846e`
antes de calcular qué migraciones/commits faltan por aplicar** — el rango
correcto es `produccion..HEAD`, nunca `3802fad..HEAD` a ciegas ni el HEAD
local de esta sesión.

Si producción sigue en `3802fad`, el rango completo pendiente incluye,
en este orden, TODO lo que sigue: las tres migraciones de
`20260916010000`/`20260917010000`/`20260917020000` (documentadas en
`docs/PRODUCCION.md` §2, con sus propias verificaciones), la corrida
completa de "Seba atiende el mostrador" (13 commits, `6ea6877…c9b5959`, su
propio reporte de entrega si existe aparte) y esta corrida
(`f0a6ce6…e7d846e`, este documento). Si producción ya pasó de `c9b5959`,
usa solo la parte de este documento que aplique.

**Recordatorio permanente:** Dokploy despliega con el push, sin esperar al
CI. Todo lo que la base necesita va ANTES de pushear (ver
`docs/PRODUCCION.md` §11, ya escrito con el orden completo de esta
entrega). Después de cada push, mira igual el CI (API pública de Actions,
sin `gh`, ver Comandos de `CLAUDE.md`) y reproduce en local cualquier falla
que no quepa en las 10 anotaciones que GitHub muestra por paso.

---

## Commit 0 · `f0a6ce6` — el plan (sin código)

Solo `.gitignore` (deja fuera `.liminal/`) y el archivo del plan en
`docs/planes/`. No cambia nada para el usuario ni para producción. No
requiere entrega propia.

---

## Commit 1 · `1e0ca3b` — `[migración]` Los enlaces de catálogo tienen su propia tabla

- **Qué cambia para el usuario:** nada todavía, visible recién con el
  código de los commits siguientes (T2/T3/T4a/T4b). Esta migración solo
  crea la tabla vacía.
- **Migración:** sí, `supabase/migrations/20260918010000_catalog_links.sql`.
  Aplicar con `psql -1 -v ON_ERROR_STOP=1` (mismo patrón que
  `20260916010000`/`20260917010000`, por higiene — esta no tiene columna
  generada ni `lock_timeout` propio, es solo una tabla nueva). Va DESPUÉS
  de las dos migraciones de Seba y ANTES del código de esta corrida. Trae
  tabla `public.catalog_links` (`key`/`label`/`url`/`sort_order`/
  `is_active`/`updated_by`), RLS (cualquier asesor lee, supervisor/admin
  escribe), índice parcial, trigger de `updated_at`, publicada en
  `supabase_realtime` con autoverificación (falla sola si no queda
  publicada). Sin funciones `security definer`, sin revokes que aplicar.
- **Variables de entorno:** ninguna nueva.
- **Riesgo / cómo revertir:** bajo — tabla nueva y vacía, nada la usa
  todavía si se aplica antes que el código. Revertir: `drop table if exists
  public.catalog_links;` (sin dependencias de otras tablas hacia ella) y
  quitar su fila de `supabase_migrations.schema_migrations`.
- **Cómo verificar:**
  ```sql
  select count(*) from pg_policies where tablename = 'catalog_links';  -- 2
  select tablename from pg_publication_tables
  where pubname = 'supabase_realtime' and tablename = 'catalog_links';  -- una fila
  select count(*) from supabase_migrations.schema_migrations;  -- 74 (contando desde 73 tras Seba)
  ```
  Test `supabase/tests/catalog_links.sql` (nueve casos, transacción con
  rollback: clave con mayúscula/espacio rechazada, URL sin esquema
  rechazada, clave repetida rechazada, un asesor corriente no puede
  crear/editar/borrar, `anon` sin sesión ve 0 filas, tabla publicada),
  cableado al job `migraciones` del CI.

---

## Commit 2 · `a8426e8` — La bandeja no esconde lo que nadie leyó ni el chat que está abierto (T1b)

- **Qué cambia para el usuario:** con la bandeja en "solo hoy", un chat con
  mensajes SIN LEER ya no desaparece de la lista aunque su último mensaje
  sea de ayer o de antes; el chat que el asesor tiene abierto no se esfuma
  de la lista al marcarse leído mientras lo sigue mirando (al cambiar de
  chat, sí sale como cualquier chat viejo).
- **Migración:** no.
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo, solo lógica de filtrado en memoria
  (`passesDayCut`, `src/lib/inbox-filters.ts`) más una prop nueva
  (`keepId`) que `inbox-sidebar.tsx` llena con `selectedId`. `git revert
  a8426e8` es seguro por sí solo si producción no pasó todavía de este
  commit — depende de `isUnread`, que ya existía.
- **Cómo verificar:** `rtk npx vitest run src/lib/inbox-filters.test.ts
  src/components/inbox/inbox-sidebar.test.tsx`. Escenario a mano: abrir la
  bandeja en "solo hoy", ubicar (o crear con SQL) un chat con
  `last_message_at` de ayer y `unread_count > 0` — debe aparecer en
  Pendientes; abrirlo, sigue en la lista; abrir otro chat, el primero
  desaparece de la lista si era de ayer.

---

## Commit 3 · `30f6512` — La base devuelve las conversaciones sin leer aunque no hayan hablado hoy (T1a)

- **Qué cambia para el usuario:** el NÚMERO de cada píldora (Pendientes,
  Sin dueño, Escaladas) ahora también cuenta las conversaciones sin leer
  que hablaron antes de hoy — antes de este commit, la lista del commit
  anterior ya las mostraba pero el contador de la píldora no las sumaba
  (mismo bug que "entra en la lista pero no en el conteo" del 8/9/2026).
  "No leídas" y "Tuyas sin leer" no cambian de número (ya las contaban
  todas, sin corte de fecha).
- **Migración:** no. Cambia solo la fórmula de los `.or()` que arma
  `src/lib/data.ts` (`dayCutGroup`), no el esquema.
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo-medio — toca las cuatro consultas
  centrales de la bandeja (`fetchConversationRows`/`fetchInboxCounts`).
  `git revert 30f6512` es seguro si no se aplicó código posterior que
  dependa del cuarto término del grupo OR. Vigilar el `EXPLAIN` en
  producción (ver más abajo): si el planner cae a `Seq Scan` en vez de
  `BitmapOr`, es una señal de rendimiento, no de corrección — no revertir
  por eso solo, medir primero.
- **Cómo verificar:** `rtk npx vitest run src/lib/data-conversations.test.ts
  src/lib/data-inbox-counts.test.ts src/lib/data-unassigned-conversations.test.ts`.
  Después del deploy, correr contra producción (o una réplica de lectura)
  el `EXPLAIN ANALYZE` de la consulta de "Pendientes" con el `.or()` de
  cuatro términos y pegar el plan en el canal del equipo — el `EXPLAIN`
  local del 18/9 (28 filas de la base sembrada) no fue concluyente para
  decidir si el planner usa `BitmapOr` sobre `conversations_unread_pill_idx`
  o cae a `Seq Scan` con volumen real.

---

## Commit 4 · `ce9afee` — `[migración]` Cada orden puede llevar su número de factura Saint (M2)

- **Qué cambia para el usuario:** nada todavía — recién visible con T5/T6
  (commits 6 y 9).
- **Migración:** sí, `supabase/migrations/20260918020000_factura_saint.sql`.
  Aplicar con `psql -1 -v ON_ERROR_STOP=1`, DESPUÉS de `20260918010000` y
  ANTES del código de T5/T6. Agrega `orders.saint_invoice_number text`
  (nullable — las ventas cerradas antes del 18/9/2026 no lo tienen) con
  CHECK de recorte y 1-40 caracteres, sin restricción de unicidad a
  propósito (una factura Saint puede cubrir más de un chat). Ojo con el
  nombre: NO es `invoices.number` (el correlativo interno "SBK-000123"),
  son dos numeraciones de dos sistemas distintos. Sin funciones `security
  definer`, sin RLS nueva.
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo — columna nullable nueva, nada la
  exige todavía si se aplica antes que el código. Revertir: `alter table
  public.orders drop column if exists saint_invoice_number;` (pierde
  cualquier valor ya cargado, pero son datos nuevos, no históricos) y
  quitar la fila de `schema_migrations`.
- **Cómo verificar:**
  ```sql
  select column_name, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'orders'
    and column_name = 'saint_invoice_number';
  -- is_nullable = 'YES'
  select count(*) from supabase_migrations.schema_migrations;  -- 75
  ```
  Test `supabase/tests/factura_saint.sql` (cinco casos: acepta `'00123'`,
  rechaza vacío, rechaza con espacios, rechaza 41 caracteres, una venta sin
  la columna queda en `null`), cableado al job `migraciones` del CI justo
  después de `catalog_links.sql`.

---

## Commit 5 · `e3f6a2c` — Los enlaces de catálogo tienen módulo, tipo, lectura y el script de carga inicial (T2)

- **Qué cambia para el usuario:** todavía nada visible en la interfaz (el
  panel llega en el commit 8, T4a); este commit es la plomería —
  `src/lib/catalog-links.ts` (validación, `slugifyKey`,
  `resolveCatalogMarkers`), `fetchCatalogLinks`/`fetchActiveCatalogLinks`
  en `data.ts`, tipos en `types.ts`, y el script de carga inicial (ver
  sección aparte más abajo, "Script de carga inicial de catálogos").
- **Migración:** no (ya entró en el commit 1).
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo — código puramente aditivo, nada lo
  consume todavía en este commit (lo consumen T3/T4a/T4b, commits
  7/8/6). Seguro de revertir solo si también se revierten esos tres.
- **Cómo verificar:** `rtk npx vitest run src/lib/catalog-links.test.ts`.

---

## Commit 6 · `7dc4d5b` — Cerrar venta exige los nueve datos y guarda el número de factura Saint (T5)

- **Qué cambia para el usuario:** el modal "Cerrar venta" ahora exige los
  NUEVE campos (nombre, WhatsApp, cédula, estado, ciudad, dirección,
  método de pago, número de factura Saint y comprobante de pago) —antes
  solo nombre, carrito y método de pago eran obligatorios—; cada campo
  inválido muestra su propio mensaje de error y el primero inválido recibe
  el foco al intentar guardar. El carrito vacío sigue avisando con el
  toast de siempre (no es uno de los nueve campos del formulario). También
  trae las cuatro mutaciones de `catalog_links` de T2 (mismo archivo
  `mutations.ts`, bloques distintos, sin uso todavía hasta T4a/T4b).
- **Migración:** no (ya entró en el commit 4).
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** medio — cambia el comportamiento del cierre
  de venta, la ruta más sensible a plata del CRM. Antes de revertir, medir
  si ya se cerró alguna venta con `saint_invoice_number` cargado (una
  reversión de este commit no borra la columna de la base, solo deja de
  pedirla). `git revert 7dc4d5b` es seguro en sí mismo; la columna
  `orders.saint_invoice_number` sigue existiendo aunque se revierta el
  código, con los valores ya guardados intactos.
- **Cómo verificar:** `rtk npx vitest run src/lib/sale-draft.test.ts
  src/lib/mutations.test.ts
  src/components/context-panel/close-sale-modal.test.tsx`. Escenario a
  mano: abrir "Cerrar venta", intentar guardar sin factura Saint → error
  bajo el campo, no llama a la mutación; completar los nueve datos →
  guarda, el evento de sistema en el chat nombra la factura ("Venta
  cerrada por… · Factura Saint 00123").

---

## Commit 7 · `68f3757` — Los mensajes rápidos salen con el enlace de catálogo vigente (T4b)

- **Qué cambia para el usuario:** al usar un mensaje rápido que contenga
  `{{catalogo:<clave>}}` o `{{catalogos}}`, el compositor pega la URL real
  del catálogo (leída de `catalog_links`) en vez del marcador crudo; si la
  clave no existe o está inactiva, pega el marcador tal cual y avisa con
  un toast ("El catálogo «x» no está configurado"). El modal de mensajes
  rápidos gana el botón "Insertar catálogo", el aviso de "enlace escrito a
  mano" y la marca "Marcador sin resolver" en la lista.
- **Migración:** no.
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo — aditivo sobre `composer.tsx`/
  `quick-replies-modal.tsx`/`chat-panel.tsx`/`crm-shell.tsx`. Sin
  `catalog_links` cargada (tabla vacía), el comportamiento es idéntico al
  de antes (ningún mensaje rápido trae marcadores todavía hasta que
  alguien los agregue o corra el script de carga). Seguro de revertir por
  sí solo.
- **Cómo verificar:** `rtk npx vitest run src/components/chat/composer.test.tsx
  src/components/chat/quick-replies-modal.test.tsx src/components/crm-shell.test.tsx`.
  Escenario a mano: cargar un catálogo de prueba con clave `cascos` desde
  el panel (una vez desplegado T4a), escribir `{{catalogo:cascos}}` en un
  mensaje rápido nuevo, usarlo en el compositor — debe pegar la URL real.

---

## Commit 8 · `7354021` — La IA resuelve el marcador del catálogo y no manda un escenario con enlace roto (T3)

- **Qué cambia para el usuario:** un escenario del panel que contenga
  `{{catalogo:<clave>}}`/`{{catalogos}}` sale con la URL real resuelta al
  momento del turno; si el marcador no resuelve (clave inactiva o
  inexistente), fase 0 saca ese escenario de los candidatos ANTES de
  llamar al modelo — nunca llega al cliente con un marcador crudo. Si el
  supervisor cambia la URL de un catálogo entre dos turnos, el escenario
  puede repetirse una vez, con el enlace nuevo (aceptado y documentado).
- **Migración:** no.
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** medio — toca el camino caliente del turno
  de IA (`agent.ts`/`send.ts`/`playbooks.ts`). Antes de revertir, confirmar
  que no quedó ningún escenario activo con un marcador de catálogo (si
  quedó, revertir este commit haría que la IA vuelva a mandarlo verbatim,
  con el marcador sin resolver, al cliente). `git revert 7354021` es
  seguro si `catalog_links` sigue vacía o si ningún escenario usa
  marcadores todavía.
- **Cómo verificar:** `rtk npx vitest run src/lib/ai/send.test.ts
  src/lib/ai/playbooks.test.ts src/lib/ai/agent.test.ts`. Escenario a
  mano en el simulador de `/agent-control`: con un catálogo cargado y un
  escenario con `{{catalogo:<clave>}}`, el simulador debe mostrar la URL
  real, no el marcador.

---

## Commit 9 · `a94df35` — El supervisor carga los enlaces de catálogo en Respuestas predeterminadas (T4a)

- **Qué cambia para el usuario:** nueva sección "Enlaces de catálogo"
  arriba de los escenarios, dentro de Control IA → Respuestas
  predeterminadas: crear/editar/desactivar/borrar catálogos (etiqueta,
  clave, URL), botón "Copiar marcador"; borrar avisa cuántos escenarios y
  mensajes rápidos usan esa clave antes de confirmar. El formulario de
  escenario gana "Insertar catálogo", el aviso de enlace escrito a mano y
  la marca "Enlace sin resolver" en la lista.
- **Migración:** no.
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo — nuevo panel (`catalog-links-panel.tsx`)
  más props/handlers en `agent-control-view.tsx`/`playbooks-panel.tsx`,
  aditivo. Requiere sesión de supervisor/admin para escribir (RLS de la
  migración del commit 1 ya lo exige del lado de la base). Seguro de
  revertir por sí solo.
- **Cómo verificar:** `rtk npx vitest run
  src/components/agent-control/catalog-links-panel.test.tsx
  src/components/agent-control/playbooks-panel.test.tsx
  src/components/agent-control/agent-control-view.test.tsx`. Escenario a
  mano: como supervisor, crear un catálogo, copiar su marcador, borrarlo
  con confirmación.

---

## Commit 10 · `e7d846e` — El módulo de Ventas muestra el número de factura Saint (T6)

- **Qué cambia para el usuario:** el detalle de una venta en el módulo de
  Ventas muestra "Factura Saint N.º 00123" después del método de pago (o
  "Sin número de factura Saint" en ventas cerradas antes del 18/9/2026); la
  fila de la lista lleva un chip "Saint 00123" solo cuando existe.
- **Migración:** no (la columna ya está desde el commit 4).
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo — solo lectura/presentación
  (`sale-detail-modal.tsx`, `sales-view.tsx`, `data.ts` — `SALE_SELECT`
  suma la columna al embed de `orders`). Seguro de revertir por sí solo.
- **Cómo verificar:** `rtk npx vitest run
  src/components/sales/sale-detail-modal.test.tsx
  src/components/sales/sales-view.test.tsx`. Escenario a mano: abrir el
  detalle de la venta cerrada en el commit 6 (con factura Saint) y de una
  venta anterior al 18/9/2026 (sin ella).

---

## Script de carga inicial de catálogos (después del deploy, no antes)

`scripts/sql/2026-09-18-catalogos-iniciales.sql` no es código de la
aplicación ni una migración: es un script de UNA SOLA vez que carga los
**siete** catálogos vigentes de producción (los de "Catálogo general" —
Cascos, Resonadores, Maletas, Exploradoras y Bombillos, Defensas,
Lubricantes ×2) y reemplaza la URL de Google Drive pegada a mano por su
marcador en los **dos** escenarios ("CATALOGO CASCOS" y "Catálogo general")
y los cuatro mensajes rápidos que hoy la llevan escrita. **Se corre
DESPUÉS del deploy del código de esta corrida, nunca antes** (D8 del
plan): un marcador sin código que lo resuelva es peor que la URL vieja que
reemplaza; con el código ya arriba, un marcador sin resolver por cualquier
motivo queda contenido por D6 (fase 0 lo descarta, el composer avisa con
toast) en vez de romper algo.

**Corrección de la revisión `code-review high` del 19/9/2026 sobre esta
misma corrida (R1, "correcciones de la revisión de código, parte
catálogo") — dos cambios en el script, ya aplicados en el commit
correspondiente, no algo que el Claude del VPS deba decidir:**

- **"Ubicación" queda FUERA del script** (antes cargaba OCHO catálogos y
  tocaba TRES escenarios, incluido "Ubicación"). Meter el Maps de la
  tienda en `catalog_links` lo colaba dentro de `{{catalogos}}`
  —`formatCatalogList` lista TODO enlace activo, mezclando la ubicación
  con los catálogos de repuestos— y el Maps no rota como un Drive, así que
  no gana nada entrando a la tabla. El escenario "Ubicación" conserva su
  URL escrita a mano tal como está hoy; este script no lo toca.
- **Los `update` ahora comprueban cuántas filas tocaron de verdad**: antes,
  un `id` de otra base (copiado mal, o de un entorno distinto) afectaba
  CERO filas sin avisar nada, y el chequeo final —que unía por ese mismo
  `id`— tampoco lo notaba. Ahora cada `update` corre dentro de su propio
  `do $$ ... $$` con `get diagnostics ... = row_count` y aborta si no
  coincide con el tamaño de su tabla de relleno; la verificación final deja
  de mirar "¿cuántas filas UNIDAS siguen con `drive.google.com`?" y pasa a
  "¿cuántas de las filas de relleno tienen HOY una fila real, sin
  `drive.google.com`?" — detecta tanto la URL no reemplazada como el `id`
  que no corresponde a ninguna fila.

El archivo llega con marcadores de relleno `<<...>>` a propósito — el
implementador de T2 no inventó ningún valor de producción, ni URLs ni
`id`. Pasos:

1. Correr contra la base de producción las dos consultas de ayuda que trae
   el propio archivo en su cabecera (comentario, no se ejecutan solas):
   ```sql
   select id, name, left(response_text, 80) as inicio
     from ai_playbooks
     where response_text ilike '%drive.google.com%' or name ilike '%catalog%'
     order by name;

   select id, label, left(content, 80) as inicio
     from quick_replies
     where content ilike '%drive.google.com%'
     order by label;
   ```
   (La consulta ya NO filtra por `name ilike '%ubicac%'`: "Ubicación" no
   entra a este script — ver la corrección de arriba.)
2. **Pregunta pendiente para el cliente, anotada en el propio script**:
   "Lubricantes" aparece DOS VECES en el escenario "Catálogo general", con
   dos URLs de Drive distintas — ¿son dos catálogos reales, o quedó uno
   viejo sin borrar? Esto frena el SCRIPT, no el deploy del código: hasta
   que el cliente responda, el script carga los dos como
   `lubricantes`/`lubricantes-2` (ya es el default que trae).
3. Completar en el propio archivo las tres tablas de relleno (sección 1):
   las SIETE URLs reales, y para cada uno de los DOS escenarios y CUATRO
   mensajes rápidos, su `id` real y el texto completo YA con el marcador
   puesto en el lugar de la URL.
4. Correr en una sola transacción:
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 \
     -f - < scripts/sql/2026-09-18-catalogos-iniciales.sql
   ```
   El script se protege solo: aborta con un mensaje claro si queda algún
   `<<...>>` sin completar (sección 2), aborta si algún `update` tocó menos
   filas de las esperadas (secciones 4/5, corrección del 19/9/2026), y
   falla al final (sección 6) si, tras el reemplazo, alguna de las filas
   tocadas todavía contiene `drive.google.com` — no hace falta verificar
   nada de eso a mano por separado.

---

## Verificación posterior completa (secciones 4 y 7 del plan)

- Suite, tipos y lint en verde antes de considerar la entrega cerrada:
  `rtk npm run test`, `rtk npx tsc --noEmit`, `rtk npm run lint`.
- `EXPLAIN ANALYZE` de la consulta de "Pendientes" contra producción, con
  volumen real (pendiente de esta entrega: el `EXPLAIN` local del 18/9,
  con 28 filas, no fue concluyente sobre si el planner usa `BitmapOr`
  sobre `conversations_unread_pill_idx` o cae a `Seq Scan`).
- Un chat con mensaje de "ayer" sin leer aparece en Pendientes y en el
  número de la píldora con "solo hoy"; al abrirlo sigue en la lista; al
  cambiar de chat, desaparece.
- Cargar `cascos` con una URL real, escribir `{{catalogo:cascos}}` en un
  escenario y `{{catalogos}}` en otro, y `{{catalogo:cascos}}` en un
  mensaje rápido: el simulador de la IA manda la URL; "Usar" el mensaje
  rápido pega la URL; cambiar la URL en el panel cambia los tres sin tocar
  nada más; desactivar la clave hace que el escenario deje de ser
  candidato y el mensaje rápido avise.
- Tras correr el script de carga inicial, ninguna de las 7 filas tocadas
  (`ai_playbooks`+`quick_replies`) conserva `drive.google.com`.
- Cerrar una venta sin factura Saint muestra el error bajo el campo; con
  los nueve datos guarda, el evento de sistema nombra la factura y el
  detalle en Ventas la muestra.

## Fuera de esta entrega (para no perderlo)

- **Catálogos en casa (v1.3):** subir los PDF al bucket y mandarlos como
  documento de WhatsApp; el diagnóstico del VPS lo recomienda, y la tabla
  de esta corrida ya lo deja preparado (un enlace podrá apuntar a
  `storage_path` en vez de `url` sin romper nada).
- **Ruta pública `/c/<clave>`** con redirección a la URL vigente — opcional,
  P1 del plan, no se pidió para esta corrida.
- Rotar la clave de OpenRouter (quedó expuesta en una sesión de
  diagnóstico del 18/9, avisado por separado) y confirmar si
  `liminal_replicator` sigue en uso — pendiente de otra corrida, no de
  esta.
