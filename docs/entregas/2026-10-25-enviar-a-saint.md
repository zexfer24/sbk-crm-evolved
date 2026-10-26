# Entrega «Enviar a SAINT» (25/10/2026)

Rama `entrega/enviar-a-saint`, partida de `main` = `32c5ac5`. **UNA migración**, que se aplica ANTES del fast-forward de `main`. Sin variables de entorno nuevas. Toca base, servidor (RPC) y UI.

Qué hace: el asesor (o la caja) pulsa «Enviar a SAINT» en un presupuesto guardado o en el carrito del chat. El CRM deja una fila `pendiente` en `liminal.saint_borradores` y el agente LiminalReplicant, que corre en la PC junto a SAINT, crea la factura en espera con los precios vigentes de SAINT (`Precio3`). El resultado (`creado` + número, o `error` + motivo) llega al CRM por Realtime. Contrato: documento de traspaso de LiminalReplicant (`main` `35fbccc`, 25/10/2026).

Decisiones del operador:
- D1: el CRM escribe y lee por RPC en `public`. `liminal` NO se expone en PostgREST (no se toca `PGRST_DB_SCHEMAS`).
- D2: la caja también envía (presupuestos). El carrito del chat exige `is_agent()`.
- D3: la cédula tipeada se guarda en el contacto solo si le faltaba (desde el carrito). El teléfono del contacto nunca se pisa.
- D4: los productos sin `saint_code` o dados de baja (`is_active = false`) se bloquean antes de enviar.

## ⚠ Antes de aplicar: tres comprobaciones en la base de producción (solo lectura)
```sql
-- 1. ¿Quién es dueño de liminal y puede postgres crear ahí?
select nspowner::regrole as dueno, has_schema_privilege('postgres', 'liminal', 'CREATE') as postgres_crea
  from pg_namespace where nspname = 'liminal';
-- 2. ¿Existe el rol del agente con ese nombre?
select rolname, rolbypassrls from pg_roles where rolname = 'liminal_replicator';
-- 3. ¿Ya existe la tabla (la creó alguien a mano)?
select to_regclass('liminal.saint_borradores');
```
- Si `postgres_crea = false`, la migración aborta en `create table` (dentro de la transacción, sin dejar nada a medias). Salidas: aplicarla como el dueño del esquema o como `supabase_admin`, o que el dueño corra antes `grant create on schema liminal to postgres;`. **Avisar antes de elegir.**
- Si el rol del agente NO se llama `liminal_replicator` (ver `Destination:ConnectionString` en el `appsettings.json` publicado del agente), **no aplicar**: avisar. La migración solo da permisos a ese nombre. Si no existe, sigue con un `NOTICE` y el agente quedaría sin acceso a la tabla.
- Si la tabla ya existe, la migración la respeta (`create table if not exists`), pero conviene comparar sus columnas con el contrato antes de seguir.

## Pasos en el VPS
1. Las tres comprobaciones de arriba.
2. Aplicar con `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261025010000_saint_borradores.sql`.
   - Esperado: `NOTICE: 20261025010000: autoverificación de saint_borradores correcta.` En producción NO debe salir el aviso «el rol liminal_replicator no existe…».
   - Sin `-1`, aborta a propósito.
   - Verificación posterior:
     ```sql
     select has_table_privilege('liminal_replicator', 'liminal.saint_borradores', 'UPDATE'),   -- true
            has_table_privilege('authenticated', 'liminal.saint_borradores', 'UPDATE'),        -- false
            exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'liminal' and tablename = 'saint_borradores'); -- true
     ```
3. Fast-forward de `main` a `entrega/enviar-a-saint`. **Esto despliega.**
4. Mirar el CI del push a `main`.

## ⚠ El agente de producción sigue con `Borradores:Enabled=false`
Mientras siga apagado, cada envío queda en `pendiente` y a los 2 minutos el CRM muestra «SAINT no responde: el agente podría estar apagado». **Cuando se encienda, el agente procesa TODO lo pendiente**, incluidos envíos viejos de prueba. Antes de encenderlo, revisar y cancelar lo que ya no sirva:
```sql
select id, origen, nombre, apellido, created_at from liminal.saint_borradores where estado = 'pendiente' order by created_at;
-- Para cancelar uno (como postgres): el CRM lo muestra como error y deja reenviar.
update liminal.saint_borradores set estado = 'error', error = 'Cancelado: se envió antes de encender el agente.', procesado_at = now()
 where id = '<id>' and estado = 'pendiente';
```

## Commits (`32c5ac5..` HEAD de la rama)
| # | Commit | Migración | Variables de entorno | UI / servidor |
|---|---|---|---|---|
| 1 | [migración] La cola de borradores hacia SAINT existe en la base | **Sí**, `20261025010000_saint_borradores.sql` (+ `supabase/tests/saint_borradores.sql`) | No | Solo base |
| 2 | El asesor envía un presupuesto o el carrito a SAINT y ve el resultado en vivo | No (usa la 1) | No | UI + cliente |
| 3 | (este reporte, glosario y CLAUDE.md) | No | No | Docs |

Rebuild completo: cambia el bundle del cliente.

## Qué cambia
- **Base:**
  - `liminal.saint_borradores`: copia exacta del contrato del agente (columnas, CHECK, índice anti doble clic `ux_saint_borradores_en_curso`, trigger `pg_notify('saint_borradores', id)`).
  - Permisos de `authenticated`: SELECT y el INSERT de las 9 columnas de la solicitud; nunca UPDATE ni DELETE.
  - RLS: lee e inserta `can_read_inventory()`, y el INSERT solo a nombre propio (`creado_por = auth.uid()`).
  - `liminal_replicator`: USAGE, SELECT, UPDATE y política propia.
  - La tabla entra a `supabase_realtime`.
- **`enviar_borrador_saint(...)`** (`security invoker`):
  - Arma los ítems DESDE LA BASE (`presupuesto_items` o `conversation_cart_items` + `products.saint_code`) y suma los códigos repetidos.
  - Valida con los mismos textos que el agente.
  - Rechaza renglones sin código o dados de baja, nombrando los productos.
  - Desde el carrito, completa la cédula del contacto si faltaba.
  - El doble clic devuelve `23505` («Ya hay un envío en curso.»).
- **`borradores_saint(uuid[])`**: el último envío de cada origen (máx. 500).
- **UI:**
  - Dónde: botón «Enviar a SAINT» con la línea de estado en vivo, en tres lugares: el carrito del chat, «Presupuestos guardados» de /inventario y los presupuestos del cliente en el panel del chat.
  - Modal: pide cédula V/E, nombre, apellido y teléfono, precargados del contacto o del último envío.
  - Reenvío de uno ya `creado`: pide confirmación («Este presupuesto ya se envió a SAINT como 004036 el 24/10 10:52. ¿Enviar de nuevo?»).
  - Estados: Enviando…, Creando…, En SAINT como N y el error del agente tal cual.

## Verificado en local
- **Tests:**
  - `supabase/tests/saint_borradores.sql`: todas las aserciones. Cubre RLS, columnas prohibidas, sin UPDATE/DELETE, suma por código, bloqueo sin código o inactivo, textos de validación, `23505`, caja y carrito, la cédula al contacto y `anon` sin acceso.
  - Siguen pasando `presupuestos.sql` y `permisos_funciones.sql`. La rama de `liminal_replicator` se probó creando el rol dentro de una transacción con rollback.
- **Migración:** aplicada dos veces seguidas con `psql -1` (es re-ejecutable).
- **Suite, tipos y build:** suite completa en verde, `tsc` limpio, lint sin errores (los warnings ya estaban en `main`) y `npm run build` correcto.
- **Punta a punta en el navegador** (Playwright contra `next dev`, sesión de un asesor del seed, al agente lo simulé con `UPDATE` como superusuario):
  - presupuesto → fila `pendiente` con los ítems correctos;
  - procesando → creado «004036 · cliente nuevo registrado» y luego `error`, todo por Realtime sin recargar;
  - confirmación de reenvío con cédula y teléfono precargados, y botón bloqueado mientras está pendiente;
  - en el carrito del chat: bloqueo por un producto sin código, validación del teléfono, la cédula guardada en el contacto y layout correcto a 268 px.
- **Pruebas de mutación** (cada una puso rojo su test):
  - quitar `creado_por = auth.uid()` de la política;
  - quitar el chequeo de `saint_code`;
  - cambiar la suma por `max`;
  - quitar «no todo ceros»;
  - cambiar 2 min por 3;
  - tratar `procesando` como libre;
  - quitar el bloqueo `en_curso`;
  - aceptar eventos Realtime más viejos.

## Lo que NO se probó
- **El agente real.** La prueba de punta a punta con LiminalReplicant se coordina con ese repo: hay un SAINT de pruebas y la lista `docs/saint/aceptacion-saint-pruebas.md`.
- **Realtime sobre un esquema que no es `public` en producción.** En local funcionó con el rol `authenticated` y RLS. En el VPS conviene confirmar, tras el deploy, que la línea de estado cambia sola al simular un `UPDATE` de prueba.
