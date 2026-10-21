-- ===========================================================================
-- Presupuestos guardados (21/10/2026, migración 20261021010000_presupuestos.sql).
--
-- Contexto: el cliente pide guardar varios carritos/presupuestos por cliente,
-- con nombre y apellido, para reabrirlos desde el carrito de /inventario y
-- desde el del chat. Decisiones D1-D4 del plan "Presupuestos y mensajes
-- rápidos": se cobra el precio de hoy (el cotizado es solo referencia), todo el
-- equipo ve y reabre, solo el autor o un supervisor/admin cambia o borra, y la
-- caja guarda pero NUNCA con price_kind = 'estandar' (no ve la tarifa MRW).
--
-- Qué fija:
--   a. Un asesor guarda por RPC con 2 renglones (uno estándar): created_by,
--      total_cotizado_usd y nota recortada.
--   b. Otro asesor lo VE, pero no puede reescribirlo (42501 de la RPC) ni
--      borrarlo (0 filas).
--   c. Un supervisor lo borra y los renglones se van en cascada.
--   d. La caja guarda en promoción; con un renglón estándar falla con 42501 y
--      NO queda cabecera.
--   e. p_items vacío (o no-array, o más de 100) => 22023.
--   f. Reemplazo: guardar de nuevo con p_id deja EXACTAMENTE los renglones
--      nuevos, avanza updated_at y no toca created_by/contact/conversation/origen.
--   g. `delete ... where created_by = auth.uid()` borra solo los propios.
--   h. anon no tiene ni SELECT ni EXECUTE.
--   i. Un nombre de 81 caracteres => check_violation.
--
-- Corre como `authenticated` con la `sub` de un usuario real: como `postgres`
-- se salta la RLS y no mediría nada. Un DELETE que la RLS bloquea afecta 0
-- filas SIN error: por eso cada rechazo se mide con el conteo de filas.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

create temporary table _ids (clave text primary key, id uuid);
grant select, insert on _ids to authenticated, service_role;

-- A y B asesores, SU supervisor, CJ caja.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('b0d9e700-0000-0000-0000-0000000000a1', 'asesor-a-presup@sbk.test', jsonb_build_object('display_name', 'Asesor A presupuestos'), '{}'::jsonb),
  ('b0d9e700-0000-0000-0000-0000000000a2', 'asesor-b-presup@sbk.test', jsonb_build_object('display_name', 'Asesor B presupuestos'), '{}'::jsonb),
  ('b0d9e700-0000-0000-0000-0000000000a3', 'super-presup@sbk.test',    jsonb_build_object('display_name', 'Supervisor presupuestos'), '{"role":"supervisor"}'::jsonb),
  ('b0d9e700-0000-0000-0000-0000000000c1', 'caja-presup@sbk.test',     jsonb_build_object('display_name', 'Caja presupuestos'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('b0d9e700-1000-0000-0000-000000000000', 'Canal de prueba presupuestos', '+580000009200');
insert into public.contacts (id, phone_number) values
  ('b0d9e700-2000-0000-0000-000000000001', '+580000009201');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('b0d9e700-3000-0000-0000-000000000001', 'b0d9e700-2000-0000-0000-000000000001', 'b0d9e700-1000-0000-0000-000000000000');
insert into public.products (id, name, price, currency, stock_quantity) values
  ('b0d9e700-4000-0000-0000-000000000001', 'Producto presupuesto 1', 10, 'USD', 5),
  ('b0d9e700-4000-0000-0000-000000000002', 'Producto presupuesto 2', 20, 'USD', 5),
  ('b0d9e700-4000-0000-0000-000000000003', 'Producto presupuesto 3', 30, 'USD', 5);

-- Ejecuta una sentencia con los privilegios del rol que la llame y devuelve
-- "filas=N" o "error <sqlstate>: <mensaje>".
create or replace function pg_temp.probar(q text) returns text
language plpgsql as $$
declare
  n integer;
begin
  execute q;
  get diagnostics n = row_count;
  return 'filas=' || n;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

-- Cuenta las filas que el rol ve en una consulta: "filas=N" o "error ...".
create or replace function pg_temp.contar(q text) returns text
language plpgsql as $$
declare
  n bigint;
begin
  execute 'select count(*) from (' || q || ') s' into n;
  return 'filas=' || n;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

create or replace function pg_temp.esperar(etiqueta text, r text, patron text) returns void
language plpgsql as $$
begin
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso a · el asesor A guarda por RPC con 2 renglones (uno estándar)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e700-0000-0000-0000-0000000000a1';

do $$
declare
  v uuid;
  r record;
  n integer;
begin
  v := public.guardar_presupuesto(
    null, '  Ana  ', ' Pérez ', 'b0d9e700-2000-0000-0000-000000000001', 'b0d9e700-3000-0000-0000-000000000001',
    'chat', '   ',
    jsonb_build_array(
      jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000001', 'quantity', 2, 'price_kind', 'promocion', 'precio_cotizado_usd', 10.5),
      jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000002', 'quantity', 3, 'price_kind', 'estandar',  'precio_cotizado_usd', 21.33)
    )
  );
  insert into _ids(clave, id) values ('A1', v);

  select * into r from public.presupuestos where id = v;
  if r.id is null then
    insert into _errores(msg) values ('Caso a: el presupuesto no quedó legible para su autor.');
    return;
  end if;
  if r.created_by is distinct from 'b0d9e700-0000-0000-0000-0000000000a1'::uuid then
    insert into _errores(msg) values (format('Caso a: created_by salió %s, se esperaba el asesor A.', r.created_by));
  end if;
  -- 10.50 * 2 + 21.33 * 3 = 21.00 + 63.99 = 84.99
  if r.total_cotizado_usd is distinct from 84.99 then
    insert into _errores(msg) values (format('Caso a: total_cotizado_usd salió %s, se esperaba 84.99.', r.total_cotizado_usd));
  end if;
  if r.cliente_nombre is distinct from 'Ana' or r.cliente_apellido is distinct from 'Pérez' then
    insert into _errores(msg) values (format('Caso a: nombre/apellido sin recortar (%L / %L).', r.cliente_nombre, r.cliente_apellido));
  end if;
  if r.nota is not null then
    insert into _errores(msg) values (format('Caso a: una nota de espacios debía guardarse como null, salió %L.', r.nota));
  end if;
  if r.origen is distinct from 'chat' then
    insert into _errores(msg) values (format('Caso a: origen salió %L, se esperaba chat.', r.origen));
  end if;
  select count(*) into n from public.presupuesto_items where presupuesto_id = v;
  if n <> 2 then
    insert into _errores(msg) values (format('Caso a: se esperaban 2 renglones y hay %s.', n));
  end if;
  if not exists (select 1 from public.presupuesto_items where presupuesto_id = v and price_kind = 'estandar') then
    insert into _errores(msg) values ('Caso a: el renglón estándar del asesor no quedó guardado.');
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso a: la RPC del asesor falló -- %s %s', sqlstate, sqlerrm));
end $$;

-- Un total con un renglón sin precio queda null (no un total a medias).
do $$
declare
  v uuid;
  t numeric;
begin
  v := public.guardar_presupuesto(
    null, 'Luis', 'Gómez', null, null, 'inventario', 'Pidió descuento',
    jsonb_build_array(
      jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000001', 'quantity', 1, 'price_kind', 'promocion', 'precio_cotizado_usd', 10),
      jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000002', 'quantity', 1, 'price_kind', 'promocion', 'precio_cotizado_usd', null)
    )
  );
  insert into _ids(clave, id) values ('A2', v);
  select total_cotizado_usd into t from public.presupuestos where id = v;
  if t is not null then
    insert into _errores(msg) values (format('Caso a: con un renglón sin precio el total debía ser null, salió %s.', t));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso a (total null): la RPC falló -- %s %s', sqlstate, sqlerrm));
end $$;

-- Caso i · nombre de 81 caracteres => check_violation (por RPC y directo).
select pg_temp.esperar('Caso i: RPC con nombre de 81 caracteres',
  pg_temp.probar(format($q$select public.guardar_presupuesto(null, %L, 'X', null, null, 'inventario', null, '[{"product_id":"b0d9e700-4000-0000-0000-000000000001","quantity":1,"price_kind":"promocion","precio_cotizado_usd":1}]'::jsonb)$q$, repeat('n', 81))),
  '^error 23514');
select pg_temp.esperar('Caso i: nombre de 80 caracteres sí entra',
  pg_temp.probar(format($q$select public.guardar_presupuesto(null, %L, 'X', null, null, 'inventario', null, '[{"product_id":"b0d9e700-4000-0000-0000-000000000001","quantity":1,"price_kind":"promocion","precio_cotizado_usd":1}]'::jsonb)$q$, repeat('n', 80))),
  '^filas=1$');
select pg_temp.esperar('Caso i: insert directo con apellido vacío',
  pg_temp.probar($q$insert into public.presupuestos (cliente_nombre, cliente_apellido) values ('Ana', '   ')$q$),
  '^error 23514');

-- Caso e · p_items vacío / no-array / más de 100 => 22023.
select pg_temp.esperar('Caso e: p_items vacío',
  pg_temp.probar($q$select public.guardar_presupuesto(null, 'Ana', 'Pérez', null, null, 'inventario', null, '[]'::jsonb)$q$),
  '^error 22023');
select pg_temp.esperar('Caso e: p_items no es un array',
  pg_temp.probar($q$select public.guardar_presupuesto(null, 'Ana', 'Pérez', null, null, 'inventario', null, '{"a":1}'::jsonb)$q$),
  '^error 22023');
select pg_temp.esperar('Caso e: p_items null',
  pg_temp.probar($q$select public.guardar_presupuesto(null, 'Ana', 'Pérez', null, null, 'inventario', null, null)$q$),
  '^error 22023');
select pg_temp.esperar('Caso e: 101 renglones',
  pg_temp.probar($q$select public.guardar_presupuesto(null, 'Ana', 'Pérez', null, null, 'inventario', null, (select jsonb_agg(jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000001', 'quantity', 1, 'price_kind', 'promocion', 'precio_cotizado_usd', 1)) from generate_series(1, 101)))$q$),
  '^error 22023');

reset role;
reset "request.jwt.claim.sub";

-- Nada de lo rechazado dejó cabecera (solo A1, A2 y el de 80 caracteres).
do $$
declare
  n integer;
begin
  select count(*) into n from public.presupuestos;
  if n <> 3 then
    insert into _errores(msg) values (format('Casos e/i: debían quedar 3 presupuestos (A1, A2 y el de nombre de 80) y hay %s.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso b · el asesor B lo ve, pero no lo reescribe ni lo borra
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e700-0000-0000-0000-0000000000a2';

select pg_temp.esperar('Caso b: B ve los presupuestos de A',
  pg_temp.contar($q$select 1 from public.presupuestos where created_by = 'b0d9e700-0000-0000-0000-0000000000a1'$q$), '^filas=3$');
select pg_temp.esperar('Caso b: B ve los renglones de A',
  pg_temp.contar($q$select 1 from public.presupuesto_items where presupuesto_id = (select id from _ids where clave = 'A1')$q$), '^filas=2$');

select pg_temp.esperar('Caso b: B no reescribe el de A por RPC',
  pg_temp.probar($q$select public.guardar_presupuesto((select id from _ids where clave = 'A1'), 'Hackeado', 'Hackeado', null, null, 'inventario', null, '[{"product_id":"b0d9e700-4000-0000-0000-000000000003","quantity":1,"price_kind":"promocion","precio_cotizado_usd":1}]'::jsonb)$q$),
  '^error 42501');
select pg_temp.esperar('Caso b: B no borra el de A',
  pg_temp.probar($q$delete from public.presupuestos where id = (select id from _ids where clave = 'A1')$q$), '^filas=0$');
select pg_temp.esperar('Caso b: B no actualiza el de A',
  pg_temp.probar($q$update public.presupuestos set cliente_nombre = 'x' where id = (select id from _ids where clave = 'A1')$q$), '^filas=0$');
select pg_temp.esperar('Caso b: B no borra renglones de A',
  pg_temp.probar($q$delete from public.presupuesto_items where presupuesto_id = (select id from _ids where clave = 'A1')$q$), '^filas=0$');
select pg_temp.esperar('Caso b: B no agrega renglones al presupuesto de A',
  pg_temp.probar($q$insert into public.presupuesto_items (presupuesto_id, product_id, quantity) values ((select id from _ids where clave = 'A1'), 'b0d9e700-4000-0000-0000-000000000003', 1)$q$),
  '^error 42501');
select pg_temp.esperar('Caso b: B no firma un presupuesto a nombre de A',
  pg_temp.probar($q$insert into public.presupuestos (cliente_nombre, cliente_apellido, created_by) values ('Ana', 'Pérez', 'b0d9e700-0000-0000-0000-0000000000a1')$q$),
  '^error 42501');

-- B guarda el suyo (para el caso g).
do $$
declare
  v uuid;
begin
  v := public.guardar_presupuesto(
    null, 'Beto', 'Rojas', null, null, 'inventario', null,
    jsonb_build_array(jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000003', 'quantity', 1, 'price_kind', 'promocion', 'precio_cotizado_usd', 30))
  );
  insert into _ids(clave, id) values ('B1', v);
exception when others then
  insert into _errores(msg) values (format('Caso b: B no pudo guardar el suyo -- %s %s', sqlstate, sqlerrm));
end $$;

reset role;
reset "request.jwt.claim.sub";

-- Lo de A quedó intacto (verificado como postgres, sin RLS).
do $$
declare
  r record;
  n integer;
begin
  select cliente_nombre into r from public.presupuestos where id = (select id from _ids where clave = 'A1');
  if r.cliente_nombre is distinct from 'Ana' then
    insert into _errores(msg) values (format('Tras B: el presupuesto de A cambió (cliente_nombre=%L).', r.cliente_nombre));
  end if;
  select count(*) into n from public.presupuesto_items where presupuesto_id = (select id from _ids where clave = 'A1');
  if n <> 2 then
    insert into _errores(msg) values (format('Tras B: los renglones de A cambiaron (%s).', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso f · reemplazo: guardar de nuevo con p_id deja SOLO los renglones nuevos
-- ---------------------------------------------------------------------------
-- El trigger set_updated_at() fuerza now() en cada UPDATE y dentro de una
-- transacción now() no avanza: se retrocede updated_at a mano (sin triggers)
-- para poder medir que el reemplazo lo adelanta.
set local session_replication_role = replica;
update public.presupuestos set updated_at = '2020-01-01 00:00:00+00' where id = (select id from _ids where clave = 'A1');
reset session_replication_role;

set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e700-0000-0000-0000-0000000000a1';

do $$
declare
  v uuid;
  r record;
  n integer;
  q integer;
begin
  v := public.guardar_presupuesto(
    (select id from _ids where clave = 'A1'), 'Ana María', 'Pérez', null, null, 'inventario', 'Cambió de idea',
    jsonb_build_array(
      jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000003', 'quantity', 4, 'price_kind', 'promocion', 'precio_cotizado_usd', 30)
    )
  );
  if v is distinct from (select id from _ids where clave = 'A1') then
    insert into _errores(msg) values ('Caso f: la RPC debía devolver el mismo id.');
  end if;
  select * into r from public.presupuestos where id = v;
  if r.updated_at <= '2020-01-01 00:00:00+00' then
    insert into _errores(msg) values (format('Caso f: updated_at no avanzó (%s).', r.updated_at));
  end if;
  if r.cliente_nombre is distinct from 'Ana María' or r.nota is distinct from 'Cambió de idea' then
    insert into _errores(msg) values (format('Caso f: nombre/nota no se actualizaron (%L / %L).', r.cliente_nombre, r.nota));
  end if;
  if r.total_cotizado_usd is distinct from 120.00 then
    insert into _errores(msg) values (format('Caso f: total salió %s, se esperaba 120.00.', r.total_cotizado_usd));
  end if;
  -- No tocan: created_by, contact_id, conversation_id, origen.
  if r.created_by is distinct from 'b0d9e700-0000-0000-0000-0000000000a1'::uuid
     or r.contact_id is distinct from 'b0d9e700-2000-0000-0000-000000000001'::uuid
     or r.conversation_id is distinct from 'b0d9e700-3000-0000-0000-000000000001'::uuid
     or r.origen is distinct from 'chat' then
    insert into _errores(msg) values (format('Caso f: el reemplazo tocó created_by/contact/conversación/origen (%s / %s / %s / %s).', r.created_by, r.contact_id, r.conversation_id, r.origen));
  end if;
  select count(*), max(quantity) into n, q from public.presupuesto_items where presupuesto_id = v;
  if n <> 1 or q <> 4 or not exists (select 1 from public.presupuesto_items where presupuesto_id = v and product_id = 'b0d9e700-4000-0000-0000-000000000003') then
    insert into _errores(msg) values (format('Caso f: debía quedar exactamente 1 renglón (producto 3 x4) y hay %s (cantidad %s).', n, q));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso f: el reemplazo falló -- %s %s', sqlstate, sqlerrm));
end $$;

-- Reemplazo con un renglón inválido (producto inexistente): revierte TAMBIÉN la
-- cabecera -- A1 conserva su nombre y su renglón.
select pg_temp.esperar('Caso f: renglón inválido en el reemplazo',
  pg_temp.probar($q$select public.guardar_presupuesto((select id from _ids where clave = 'A1'), 'Roto', 'Roto', null, null, 'inventario', null, '[{"product_id":"b0d9e700-4000-0000-0000-0000000000ff","quantity":1,"price_kind":"promocion","precio_cotizado_usd":1}]'::jsonb)$q$),
  '^error 23503');

reset role;
reset "request.jwt.claim.sub";

do $$
declare
  nom text;
  n integer;
begin
  select cliente_nombre into nom from public.presupuestos where id = (select id from _ids where clave = 'A1');
  select count(*) into n from public.presupuesto_items where presupuesto_id = (select id from _ids where clave = 'A1');
  if nom is distinct from 'Ana María' or n <> 1 then
    insert into _errores(msg) values (format('Caso f: el reemplazo fallido no revirtió la cabecera (nombre=%L, renglones=%s).', nom, n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso g · "borrar todos" con `created_by = auth.uid()` borra solo los propios
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e700-0000-0000-0000-0000000000a2';

-- B borra "todos los suyos": solo cae el de B; los de A siguen ahí.
select pg_temp.esperar('Caso g: B borra solo los propios',
  pg_temp.probar($q$delete from public.presupuestos where created_by = auth.uid()$q$), '^filas=1$');
select pg_temp.esperar('Caso g: los de A siguen visibles tras el borrado de B',
  pg_temp.contar($q$select 1 from public.presupuestos where created_by = 'b0d9e700-0000-0000-0000-0000000000a1'$q$), '^filas=3$');
-- Aun sin filtro, la RLS le deja borrar solo los suyos (ya no tiene ninguno).
select pg_temp.esperar('Caso g: B sin filtro tampoco toca lo ajeno',
  pg_temp.probar($q$delete from public.presupuestos$q$), '^filas=0$');

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso d · la caja guarda en promoción, jamás con estándar
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e700-0000-0000-0000-0000000000c1';

select pg_temp.esperar('Caso d: la caja es can_read_inventory pero no is_agent',
  (select 'valor=' || (public.can_read_inventory() and not public.is_agent())), '^valor=true$');
select pg_temp.esperar('Caso d: la caja ve los presupuestos del equipo',
  pg_temp.contar('select 1 from public.presupuestos'), '^filas=3$');

do $$
declare
  v uuid;
begin
  v := public.guardar_presupuesto(
    null, 'Caja', 'Cliente', null, null, 'inventario', null,
    jsonb_build_array(jsonb_build_object('product_id', 'b0d9e700-4000-0000-0000-000000000001', 'quantity', 1, 'price_kind', 'promocion', 'precio_cotizado_usd', 10))
  );
  insert into _ids(clave, id) values ('C1', v);
exception when others then
  insert into _errores(msg) values (format('Caso d: la caja no pudo guardar en promoción -- %s %s', sqlstate, sqlerrm));
end $$;

select pg_temp.esperar('Caso d: la caja con un renglón estándar',
  pg_temp.probar($q$select public.guardar_presupuesto(null, 'Caja', 'Estandar', null, null, 'inventario', null, '[{"product_id":"b0d9e700-4000-0000-0000-000000000001","quantity":1,"price_kind":"promocion","precio_cotizado_usd":10},{"product_id":"b0d9e700-4000-0000-0000-000000000002","quantity":1,"price_kind":"estandar","precio_cotizado_usd":20}]'::jsonb)$q$),
  '^error 42501');
-- Y tampoco por la tabla directa, aun con su propio presupuesto.
select pg_temp.esperar('Caso d: la caja no inserta estándar a mano',
  pg_temp.probar($q$insert into public.presupuesto_items (presupuesto_id, product_id, quantity, price_kind) values ((select id from _ids where clave = 'C1'), 'b0d9e700-4000-0000-0000-000000000002', 1, 'estandar')$q$),
  '^error 42501');
-- Reemplazar el suyo metiendo un estándar también falla y deja intacto el original.
select pg_temp.esperar('Caso d: la caja no reemplaza con estándar',
  pg_temp.probar($q$select public.guardar_presupuesto((select id from _ids where clave = 'C1'), 'Caja', 'Cambiada', null, null, 'inventario', null, '[{"product_id":"b0d9e700-4000-0000-0000-000000000002","quantity":1,"price_kind":"estandar","precio_cotizado_usd":20}]'::jsonb)$q$),
  '^error 42501');

reset role;
reset "request.jwt.claim.sub";

-- Atomicidad: del intento con estándar NO queda cabecera, y el de promoción
-- de la caja sigue intacto.
do $$
declare
  n integer;
  ap text;
begin
  select count(*) into n from public.presupuestos where cliente_apellido = 'Estandar';
  if n <> 0 then
    insert into _errores(msg) values (format('Caso d: el intento con estándar dejó %s cabecera(s) huérfana(s).', n));
  end if;
  select cliente_apellido into ap from public.presupuestos where id = (select id from _ids where clave = 'C1');
  if ap is distinct from 'Cliente' then
    insert into _errores(msg) values (format('Caso d: el reemplazo fallido de la caja alteró su presupuesto (apellido=%L).', ap));
  end if;
  if (select count(*) from public.presupuesto_items where presupuesto_id = (select id from _ids where clave = 'C1')) <> 1 then
    insert into _errores(msg) values ('Caso d: el reemplazo fallido de la caja alteró sus renglones.');
  end if;
  if exists (select 1 from public.presupuesto_items where price_kind = 'estandar' and presupuesto_id = (select id from _ids where clave = 'C1')) then
    insert into _errores(msg) values ('Caso d: quedó un renglón estándar en el presupuesto de la caja.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso c · el supervisor borra lo ajeno y los renglones caen en cascada
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e700-0000-0000-0000-0000000000a3';

select pg_temp.esperar('Caso c: el supervisor reescribe el de A por RPC',
  pg_temp.probar($q$select public.guardar_presupuesto((select id from _ids where clave = 'A2'), 'Luis', 'Gómez (rev.)', null, null, 'inventario', null, '[{"product_id":"b0d9e700-4000-0000-0000-000000000001","quantity":1,"price_kind":"estandar","precio_cotizado_usd":10}]'::jsonb)$q$),
  '^filas=1$');
select pg_temp.esperar('Caso c: el supervisor borra el de A',
  pg_temp.probar($q$delete from public.presupuestos where id = (select id from _ids where clave = 'A1')$q$), '^filas=1$');

reset role;
reset "request.jwt.claim.sub";

do $$
declare
  n integer;
  creador uuid;
begin
  select count(*) into n from public.presupuesto_items where presupuesto_id = (select id from _ids where clave = 'A1');
  if n <> 0 then
    insert into _errores(msg) values (format('Caso c: quedaron %s renglón(es) huérfanos tras borrar el presupuesto.', n));
  end if;
  -- La edición del supervisor no le robó la autoría a A.
  select created_by into creador from public.presupuestos where id = (select id from _ids where clave = 'A2');
  if creador is distinct from 'b0d9e700-0000-0000-0000-0000000000a1'::uuid then
    insert into _errores(msg) values (format('Caso c: el supervisor cambió created_by (%s).', creador));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso h · anon no tiene nada
-- ---------------------------------------------------------------------------
do $$
begin
  if has_table_privilege('anon', 'public.presupuestos', 'select')
     or has_table_privilege('anon', 'public.presupuestos', 'insert')
     or has_table_privilege('anon', 'public.presupuesto_items', 'select')
     or has_table_privilege('anon', 'public.presupuesto_items', 'insert') then
    insert into _errores(msg) values ('Caso h: anon tiene privilegios de tabla sobre presupuestos o presupuesto_items.');
  end if;
  if has_function_privilege('anon', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('public', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE') then
    insert into _errores(msg) values ('Caso h: guardar_presupuesto debía ser ejecutable solo por authenticated y service_role.');
  end if;
  -- Los renglones no se actualizan: se reemplazan.
  if has_table_privilege('authenticated', 'public.presupuesto_items', 'update') then
    insert into _errores(msg) values ('Caso h: authenticated no debía poder UPDATE sobre presupuesto_items.');
  end if;
  -- La RPC es security invoker: la RLS se evalúa como quien llama.
  if exists (select 1 from pg_proc where oid = 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)'::regprocedure and prosecdef) then
    insert into _errores(msg) values ('Caso h: guardar_presupuesto debía ser security invoker.');
  end if;
  -- No se publican por Realtime (fuera de alcance).
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('presupuestos','presupuesto_items')) then
    insert into _errores(msg) values ('Caso h: las tablas de presupuestos no debían publicarse por Realtime.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Veredicto
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'presupuestos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'presupuestos.sql: todas las aserciones pasaron.'
