-- ===========================================================================
-- Enviar a SAINT (25/10/2026, migración 20261025010000_saint_borradores.sql).
--
-- Contexto: un asesor (o la caja) pulsa "Enviar a SAINT" en un presupuesto o en
-- el carrito del chat. El CRM inserta una fila `pendiente` en
-- `liminal.saint_borradores` (contrato fijo con el agente LiminalReplicant,
-- que corre en la PC del cliente con el rol `liminal_replicator`); el agente la
-- reclama, crea la factura en espera en SAINT y escribe `creado` + número, o
-- `error`. PostgREST NO expone el esquema `liminal`: el CRM escribe y lee por
-- las RPC `enviar_borrador_saint` y `borradores_saint` (security invoker, la
-- RLS manda).
--
-- Qué fija:
--   a. Un asesor envía el carrito: fila `pendiente`, creado_por = él,
--      intentos = 0 y `items` exacto, con los dos productos del mismo código
--      (uno con un espacio de más) SUMADOS en un renglón y el orden por primera
--      aparición.
--   b. Un segundo envío del mismo origen con la fila pendiente => 23505 (sin
--      capturar). Cuando el agente la cierra (simulado como postgres), el
--      reenvío funciona.
--   c. El asesor, directo sobre la tabla: UPDATE y DELETE => privilegio; INSERT
--      con `estado`/`numero_saint` => privilegio de columna; INSERT con
--      creado_por de otro => violación de RLS; INSERT propio sí entra.
--   d. Producto sin saint_code (null o en blanco) => 22023 con el detail que
--      los nombra; producto inactivo => 22023 con su detail.
--   e. Cédula inválida, todo ceros, tipo 'X', teléfono 'abc', nombre o apellido
--      en blanco, origen inválido => 22023 con el detail EXACTO (son los textos
--      del agente). Más de 9999 unidades de un código y más de 100 códigos.
--   f. La caja envía un presupuesto => ok; la caja envía un carrito => 42501.
--   g. Desde el carrito el nombre, el apellido y la cédula tipeados se guardan
--      en el contacto SIEMPRE (gana el último envío, aunque ya tuviera otros);
--      el teléfono del contacto nunca se toca. (28/10/2026: antes la cédula se
--      guardaba SOLO si faltaba y nunca se tocaba el nombre; el cambio y sus
--      casos de presupuesto viven en saint_telefono_opcional_y_contacto.sql.)
--      El presupuesto enviado por la CAJA no toca su contacto (la RLS de
--      `contacts` le da 0 filas).
--   h. `borradores_saint` devuelve solo el ÚLTIMO envío de cada origen y no
--      lista un origen sin envíos; un arreglo enorme no lanza (se recorta a 500).
--   i. anon no ejecuta ninguna de las dos RPC ni lee la tabla.
--   j. Un origen sin renglones visibles (carrito vacío) => 22023 "no tiene
--      artículos".
--
-- Nota de fixtures: `products` tiene un índice único sobre `saint_code`, así
-- que "dos productos distintos con el MISMO código" son 'SBT-A' y 'SBT-A '
-- (con un espacio al final): el índice los ve distintos y la RPC agrupa por
-- btrim(saint_code), como hace el agente al buscar en SAINT.
--
-- Corre como `authenticated` con la `sub` de un usuario real: como `postgres`
-- se salta la RLS y no mediría nada. Aplicar la migración antes y correr con
-- `docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f - < ...`
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

create temporary table _ids (clave text primary key, id uuid);
grant select, insert on _ids to authenticated, service_role;

-- A y B asesores, CJ caja.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('b0d9e800-0000-0000-0000-0000000000a1', 'asesor-a-saint@sbk.test', jsonb_build_object('display_name', 'Asesor A saint'), '{}'::jsonb),
  ('b0d9e800-0000-0000-0000-0000000000a2', 'asesor-b-saint@sbk.test', jsonb_build_object('display_name', 'Asesor B saint'), '{}'::jsonb),
  ('b0d9e800-0000-0000-0000-0000000000c1', 'caja-saint@sbk.test',     jsonb_build_object('display_name', 'Caja saint'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('b0d9e800-1000-0000-0000-000000000000', 'Canal de prueba saint', '+580000009300');

-- ct1 CON cédula (E 99999999); el resto SIN cédula.
insert into public.contacts (id, phone_number, display_name, cedula_type, cedula_number) values
  ('b0d9e800-2000-0000-0000-000000000001', '+580000009301', 'Contacto con cédula', 'E', '99999999'),
  ('b0d9e800-2000-0000-0000-000000000002', '+580000009302', 'Contacto sin cédula', null, null),
  ('b0d9e800-2000-0000-0000-000000000003', '+580000009303', 'Contacto carrito vacío', null, null),
  ('b0d9e800-2000-0000-0000-000000000004', '+580000009304', 'Contacto sin código', null, null),
  ('b0d9e800-2000-0000-0000-000000000005', '+580000009305', 'Contacto producto inactivo', null, null),
  ('b0d9e800-2000-0000-0000-000000000006', '+580000009306', 'Contacto cantidad excesiva', null, null),
  ('b0d9e800-2000-0000-0000-000000000007', '+580000009307', 'Contacto de un presupuesto', null, null),
  ('b0d9e800-2000-0000-0000-000000000008', '+580000009308', 'Contacto 101 códigos', null, null);
insert into public.conversations (id, contact_id, whatsapp_channel_id)
select ('b0d9e800-3000-0000-0000-00000000000' || n)::uuid,
       ('b0d9e800-2000-0000-0000-00000000000' || n)::uuid,
       'b0d9e800-1000-0000-0000-000000000000'
  from generate_series(1, 8) n;

insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active) values
  ('b0d9e800-4000-0000-0000-000000000001', 'Prod SAINT A1',         10, 'USD', 5, 'SBT-A',  true),
  ('b0d9e800-4000-0000-0000-000000000002', 'Prod SAINT A2',         11, 'USD', 5, 'SBT-A ', true),
  ('b0d9e800-4000-0000-0000-000000000003', 'Prod SAINT B',          12, 'USD', 5, 'SBT-B',  true),
  ('b0d9e800-4000-0000-0000-000000000004', 'Zeta sin codigo',       13, 'USD', 5, null,     true),
  ('b0d9e800-4000-0000-0000-000000000005', 'Alfa blanco',           14, 'USD', 5, '   ',    true),
  ('b0d9e800-4000-0000-0000-000000000006', 'Producto dado de baja', 15, 'USD', 5, 'SBT-I',  false);
insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active)
select ('b0d9e800-4100-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'Prod SAINT masivo ' || n, 1, 'USD', 1, 'SBT-M-' || n, true
  from generate_series(1, 101) n;

-- Carritos (como postgres, con created_at escalonado para fijar el orden).
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, created_at) values
  -- cv1: A1 x2 (hace 2 min), A2 x3 (hace 1 min), B x1 (hace 10 min, el más viejo)
  ('b0d9e800-3000-0000-0000-000000000001', 'b0d9e800-4000-0000-0000-000000000001', 2, 'inventory', now() - interval '2 minutes'),
  ('b0d9e800-3000-0000-0000-000000000001', 'b0d9e800-4000-0000-0000-000000000002', 3, 'inventory', now() - interval '1 minute'),
  ('b0d9e800-3000-0000-0000-000000000001', 'b0d9e800-4000-0000-0000-000000000003', 1, 'inventory', now() - interval '10 minutes'),
  -- cv2: B x1
  ('b0d9e800-3000-0000-0000-000000000002', 'b0d9e800-4000-0000-0000-000000000003', 1, 'inventory', now()),
  -- cv4: un código bueno, uno null y uno en blanco
  ('b0d9e800-3000-0000-0000-000000000004', 'b0d9e800-4000-0000-0000-000000000001', 1, 'inventory', now()),
  ('b0d9e800-3000-0000-0000-000000000004', 'b0d9e800-4000-0000-0000-000000000004', 1, 'inventory', now()),
  ('b0d9e800-3000-0000-0000-000000000004', 'b0d9e800-4000-0000-0000-000000000005', 1, 'inventory', now()),
  -- cv5: uno bueno y uno inactivo
  ('b0d9e800-3000-0000-0000-000000000005', 'b0d9e800-4000-0000-0000-000000000001', 1, 'inventory', now()),
  ('b0d9e800-3000-0000-0000-000000000005', 'b0d9e800-4000-0000-0000-000000000006', 1, 'inventory', now()),
  -- cv6: 9000 + 1000 del mismo código = 10000
  ('b0d9e800-3000-0000-0000-000000000006', 'b0d9e800-4000-0000-0000-000000000001', 9000, 'inventory', now()),
  ('b0d9e800-3000-0000-0000-000000000006', 'b0d9e800-4000-0000-0000-000000000002', 1000, 'inventory', now());
-- cv7 -> contact 7 se usa en el presupuesto; el carrito de 101 códigos va en cv8.
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin)
select 'b0d9e800-3000-0000-0000-000000000008', ('b0d9e800-4100-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 1, 'inventory'
  from generate_series(1, 101) n;

-- Presupuesto PR1 de A (contacto sin cédula): A1 x2 y B x1.
insert into public.presupuestos (id, cliente_nombre, cliente_apellido, contact_id, origen, created_by) values
  ('b0d9e800-5000-0000-0000-000000000001', 'Ana', 'Pérez', 'b0d9e800-2000-0000-0000-000000000007', 'inventario', 'b0d9e800-0000-0000-0000-0000000000a1');
insert into public.presupuesto_items (presupuesto_id, product_id, quantity) values
  ('b0d9e800-5000-0000-0000-000000000001', 'b0d9e800-4000-0000-0000-000000000001', 2),
  ('b0d9e800-5000-0000-0000-000000000001', 'b0d9e800-4000-0000-0000-000000000003', 1);

-- Ejecuta una sentencia con los privilegios del rol que la llame y devuelve
-- "filas=N" o "error <sqlstate>: <mensaje> | <detail>".
create or replace function pg_temp.probar(q text) returns text
language plpgsql as $$
declare
  n integer;
  d text;
begin
  execute q;
  get diagnostics n = row_count;
  return 'filas=' || n;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return 'error ' || sqlstate || ': ' || sqlerrm || ' | ' || coalesce(d, '');
end $$;

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

-- Igualdad exacta (los details son textos del agente: ni una coma de más).
create or replace function pg_temp.esperar_detail(etiqueta text, r text, detail text) returns void
language plpgsql as $$
declare
  esperado text := 'error 22023: saint_dato_invalido | ' || detail;
begin
  if r is distinct from esperado then
    insert into _errores(msg) values (format('%s: se esperaba "%s" y salió "%s".', etiqueta, esperado, r));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso a · el asesor A envía el carrito de cv1
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a1';

do $$
declare
  v uuid;
  r record;
begin
  -- Tipo en minúscula y con espacios: se normaliza a 'V'.
  v := public.enviar_borrador_saint(
    'carrito', 'b0d9e800-3000-0000-0000-000000000001', ' v ', ' 11111111 ', '  Ana ', ' Pérez ', ' +584141234567 ');
  insert into _ids(clave, id) values ('B1', v);

  select * into r from liminal.saint_borradores where id = v;
  if r.id is null then
    insert into _errores(msg) values ('Caso a: la fila no quedó legible para su autor.');
    return;
  end if;
  if r.estado is distinct from 'pendiente' or r.intentos is distinct from 0 then
    insert into _errores(msg) values (format('Caso a: estado/intentos salieron %L/%s, se esperaba pendiente/0.', r.estado, r.intentos));
  end if;
  if r.creado_por is distinct from 'b0d9e800-0000-0000-0000-0000000000a1'::uuid then
    insert into _errores(msg) values (format('Caso a: creado_por salió %s, se esperaba el asesor A.', r.creado_por));
  end if;
  if r.origen is distinct from 'carrito' or r.origen_id is distinct from 'b0d9e800-3000-0000-0000-000000000001'::uuid then
    insert into _errores(msg) values (format('Caso a: origen/origen_id salieron %L/%s.', r.origen, r.origen_id));
  end if;
  if r.cedula_tipo is distinct from 'V' or r.cedula_numero is distinct from '11111111'
     or r.nombre is distinct from 'Ana' or r.apellido is distinct from 'Pérez' or r.telefono is distinct from '+584141234567' then
    insert into _errores(msg) values (format('Caso a: los datos no se normalizaron (%L %L %L %L %L).', r.cedula_tipo, r.cedula_numero, r.nombre, r.apellido, r.telefono));
  end if;
  -- B (el más viejo) primero; A1 + A2 sumados en un solo renglón (2 + 3 = 5).
  if r.items is distinct from '[{"codprod":"SBT-B","cantidad":1},{"codprod":"SBT-A","cantidad":5}]'::jsonb then
    insert into _errores(msg) values (format('Caso a: items salió %s.', r.items));
  end if;
  if r.numero_saint is not null or r.codclie is not null or r.error is not null or r.procesado_at is not null or r.reclamado_at is not null then
    insert into _errores(msg) values ('Caso a: los campos del agente debían nacer vacíos.');
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso a: la RPC del asesor falló -- %s %s', sqlstate, sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso b · el segundo envío con la fila pendiente => 23505
-- ---------------------------------------------------------------------------
select pg_temp.esperar('Caso b: reenvío con la fila pendiente',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000001', 'V', '11111111', 'Ana', 'Pérez', '+584141234567')$q$),
  '^error 23505');

reset role;
reset "request.jwt.claim.sub";

-- El agente (postgres) lo cierra; el envío anterior se manda una hora atrás
-- para que "el último" sea medible (now() no avanza dentro de la transacción).
update liminal.saint_borradores
   set estado = 'creado', numero_saint = '004036', procesado_at = now(), created_at = now() - interval '1 hour'
 where id = (select id from _ids where clave = 'B1');

set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a1';

do $$
declare
  v uuid;
begin
  v := public.enviar_borrador_saint(
    'carrito', 'b0d9e800-3000-0000-0000-000000000001', 'V', '11111111', 'Ana', 'Pérez', '+584141234567');
  insert into _ids(clave, id) values ('B1b', v);
exception when others then
  insert into _errores(msg) values (format('Caso b: el reenvío tras cerrarse el anterior falló -- %s %s', sqlstate, sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso c · el asesor, directo sobre la tabla
-- ---------------------------------------------------------------------------
select pg_temp.esperar('Caso c: UPDATE directo',
  pg_temp.probar($q$update liminal.saint_borradores set estado = 'creado'$q$), '^error 42501');
select pg_temp.esperar('Caso c: DELETE directo',
  pg_temp.probar($q$delete from liminal.saint_borradores$q$), '^error 42501');
select pg_temp.esperar('Caso c: INSERT con estado',
  pg_temp.probar($q$insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, estado)
    values ('carrito', 'b0d9e800-9000-0000-0000-000000000001', 'b0d9e800-0000-0000-0000-0000000000a1', 'V', '11111111', 'Ana', 'Pérez', '+584141234567', '[{"codprod":"X","cantidad":1}]', 'creado')$q$),
  '^error 42501');
select pg_temp.esperar('Caso c: INSERT con numero_saint',
  pg_temp.probar($q$insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, numero_saint)
    values ('carrito', 'b0d9e800-9000-0000-0000-000000000001', 'b0d9e800-0000-0000-0000-0000000000a1', 'V', '11111111', 'Ana', 'Pérez', '+584141234567', '[{"codprod":"X","cantidad":1}]', '000001')$q$),
  '^error 42501');
select pg_temp.esperar('Caso c: INSERT firmado por otro asesor',
  pg_temp.probar($q$insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items)
    values ('carrito', 'b0d9e800-9000-0000-0000-000000000001', 'b0d9e800-0000-0000-0000-0000000000a2', 'V', '11111111', 'Ana', 'Pérez', '+584141234567', '[{"codprod":"X","cantidad":1}]')$q$),
  '^error 42501: new row violates row-level security');
select pg_temp.esperar('Caso c: INSERT propio sí entra',
  pg_temp.probar($q$insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items)
    values ('carrito', 'b0d9e800-9000-0000-0000-000000000001', 'b0d9e800-0000-0000-0000-0000000000a1', 'V', '11111111', 'Ana', 'Pérez', '+584141234567', '[{"codprod":"X","cantidad":1}]')$q$),
  '^filas=1$');
-- Los CHECK del contrato también valen en el insert directo.
select pg_temp.esperar('Caso c: INSERT con items vacío',
  pg_temp.probar($q$insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items)
    values ('carrito', 'b0d9e800-9000-0000-0000-000000000002', 'b0d9e800-0000-0000-0000-0000000000a1', 'V', '11111111', 'Ana', 'Pérez', '+584141234567', '[]')$q$),
  '^error 23514');
-- El asesor B ve lo de A (bandeja compartida).
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a2';
select pg_temp.esperar('Caso c: B ve los envíos de A',
  pg_temp.contar($q$select 1 from liminal.saint_borradores where creado_por = 'b0d9e800-0000-0000-0000-0000000000a1'$q$), '^filas=3$');

-- ---------------------------------------------------------------------------
-- Casos d, e, j · validaciones (A)
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a1';

-- d · sin código / inactivo
select pg_temp.esperar_detail('Caso d: sin código SAINT',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000004', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'Sin código SAINT: Alfa blanco, Zeta sin codigo.');
select pg_temp.esperar_detail('Caso d: producto dado de baja',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000005', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'Dados de baja en el inventario: Producto dado de baja.');

-- e · datos del cliente (contra el carrito bueno de cv2, para que el único
-- motivo de rechazo sea el dato)
select pg_temp.esperar_detail('Caso e: tipo X',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'X', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'Tipo de cédula inválido: solo V o E.');
select pg_temp.esperar_detail('Caso e: cédula con letras',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', 'abc', 'Ana', 'Pérez', '+584141234567')$q$),
  'Cédula inválida: use solo dígitos (5 a 10).');
select pg_temp.esperar_detail('Caso e: cédula corta',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '1234', 'Ana', 'Pérez', '+584141234567')$q$),
  'Cédula inválida: use solo dígitos (5 a 10).');
select pg_temp.esperar_detail('Caso e: cédula de 11 dígitos',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '12345678901', 'Ana', 'Pérez', '+584141234567')$q$),
  'Cédula inválida: use solo dígitos (5 a 10).');
select pg_temp.esperar_detail('Caso e: cédula todo ceros',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '0000000', 'Ana', 'Pérez', '+584141234567')$q$),
  'Cédula inválida: use solo dígitos (5 a 10).');
select pg_temp.esperar_detail('Caso e: nombre en blanco',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '12345678', '   ', 'Pérez', '+584141234567')$q$),
  'Falta el nombre del cliente.');
select pg_temp.esperar_detail('Caso e: apellido en blanco',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '12345678', 'Ana', '', '+584141234567')$q$),
  'Falta el apellido del cliente.');
select pg_temp.esperar_detail('Caso e: teléfono con letras',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '12345678', 'Ana', 'Pérez', 'abc')$q$),
  'Teléfono inválido.');
select pg_temp.esperar_detail('Caso e: teléfono demasiado corto',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '12345678', 'Ana', 'Pérez', '+12345')$q$),
  'Teléfono inválido.');
select pg_temp.esperar_detail('Caso e: origen inválido',
  pg_temp.probar($q$select public.enviar_borrador_saint('otro', 'b0d9e800-3000-0000-0000-000000000002', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'Origen inválido.');
select pg_temp.esperar_detail('Caso e: más de 9999 unidades del mismo código',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000006', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'Cantidad inválida en SBT-A: debe ser un entero entre 1 y 9999.');
select pg_temp.esperar_detail('Caso e: más de 100 líneas',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000008', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'El borrador supera 100 líneas.');

-- j · sin renglones visibles
select pg_temp.esperar_detail('Caso j: carrito vacío',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000003', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'El borrador no tiene artículos.');
select pg_temp.esperar_detail('Caso j: presupuesto inexistente',
  pg_temp.probar($q$select public.enviar_borrador_saint('presupuesto', 'b0d9e800-5000-0000-0000-0000000000ff', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  'El borrador no tiene artículos.');

-- Ninguna validación fallida dejó fila.
select pg_temp.esperar('Casos d/e/j: no quedó ninguna fila de los orígenes rechazados',
  pg_temp.contar($q$select 1 from liminal.saint_borradores where origen_id in (
     'b0d9e800-3000-0000-0000-000000000002','b0d9e800-3000-0000-0000-000000000003','b0d9e800-3000-0000-0000-000000000004',
     'b0d9e800-3000-0000-0000-000000000005','b0d9e800-3000-0000-0000-000000000006','b0d9e800-3000-0000-0000-000000000008')$q$),
  '^filas=0$');

-- ---------------------------------------------------------------------------
-- Caso g · desde el carrito lo tipeado se guarda en el contacto SIEMPRE (28/10/2026)
-- ---------------------------------------------------------------------------
-- cv2 (contacto SIN cédula): queda con la tipeada y con el nombre del formulario.
select pg_temp.esperar('Caso g: envío de cv2',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'e', '12345678', 'Beto', 'Rojas', '+584149999999')$q$),
  '^filas=1$');

reset role;
reset "request.jwt.claim.sub";

do $$
declare
  c record;
begin
  select * into c from public.contacts where id = 'b0d9e800-2000-0000-0000-000000000002';
  if c.cedula_type is distinct from 'E' or c.cedula_number is distinct from '12345678' then
    insert into _errores(msg) values (format('Caso g: el contacto sin cédula debía quedar con E/12345678 y quedó %L/%L.', c.cedula_type, c.cedula_number));
  end if;
  if c.phone_number is distinct from '+580000009302' or c.display_name is distinct from 'Beto Rojas' then
    insert into _errores(msg) values (format('Caso g: el teléfono no debía tocarse y el nombre debía quedar "Beto Rojas" (%L / %L).', c.phone_number, c.display_name));
  end if;
  -- cv1 (contacto CON cédula E 99999999): el envío del caso a usó V 11111111 y
  -- SÍ la pisó (28/10/2026: gana el último envío; antes no la pisaba).
  select * into c from public.contacts where id = 'b0d9e800-2000-0000-0000-000000000001';
  if c.cedula_type is distinct from 'V' or c.cedula_number is distinct from '11111111' or c.display_name is distinct from 'Ana Pérez' then
    insert into _errores(msg) values (format('Caso g: el contacto con cédula debía quedar con V/11111111 y "Ana Pérez" (gana el último envío) y quedó %L/%L/%L.', c.cedula_type, c.cedula_number, c.display_name));
  end if;
  if c.phone_number is distinct from '+580000009301' then
    insert into _errores(msg) values (format('Caso g: se pisó el teléfono del contacto con cédula (%L).', c.phone_number));
  end if;
end $$;

-- Un número en blanco ('   ') en el contacto también se reemplaza por lo tipeado.
update public.contacts set cedula_type = 'V', cedula_number = '   ' where id = 'b0d9e800-2000-0000-0000-000000000003';
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin)
  values ('b0d9e800-3000-0000-0000-000000000003', 'b0d9e800-4000-0000-0000-000000000003', 1, 'inventory');
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a1';
select pg_temp.esperar('Caso g: envío con cédula en blanco en el contacto',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000003', 'V', '55555555', 'Carla', 'Díaz', '+584148888888')$q$),
  '^filas=1$');
reset role;
reset "request.jwt.claim.sub";
do $$
declare
  c record;
begin
  select * into c from public.contacts where id = 'b0d9e800-2000-0000-0000-000000000003';
  if c.cedula_number is distinct from '55555555' then
    insert into _errores(msg) values (format('Caso g: la cédula en blanco debía completarse y quedó %L.', c.cedula_number));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso f · la caja
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000c1';

select pg_temp.esperar('Caso f: la caja es can_read_inventory pero no is_agent',
  (select 'valor=' || (public.can_read_inventory() and not public.is_agent())), '^valor=true$');

do $$
declare
  v uuid;
  r record;
begin
  v := public.enviar_borrador_saint(
    'presupuesto', 'b0d9e800-5000-0000-0000-000000000001', 'V', '22222222', 'Ana', 'Pérez', '584141112222');
  insert into _ids(clave, id) values ('P1', v);
  select * into r from liminal.saint_borradores where id = v;
  if r.creado_por is distinct from 'b0d9e800-0000-0000-0000-0000000000c1'::uuid or r.estado is distinct from 'pendiente' then
    insert into _errores(msg) values (format('Caso f: la fila de la caja salió %L/%s.', r.estado, r.creado_por));
  end if;
  -- Presupuesto: mismos created_at => desempata el código.
  if r.items is distinct from '[{"codprod":"SBT-A","cantidad":2},{"codprod":"SBT-B","cantidad":1}]'::jsonb then
    insert into _errores(msg) values (format('Caso f: items del presupuesto salió %s.', r.items));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso f: la caja no pudo enviar un presupuesto -- %s %s', sqlstate, sqlerrm));
end $$;

select pg_temp.esperar('Caso f: la caja no envía un carrito',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000001', 'V', '11111111', 'Ana', 'Pérez', '+584141234567')$q$),
  '^error 42501: saint_sin_permiso');
select pg_temp.esperar('Caso f: la caja ve los envíos',
  pg_temp.contar($q$select 1 from liminal.saint_borradores$q$), '^filas=[1-9][0-9]*$');
-- La caja tampoco escribe a mano sobre la tabla.
select pg_temp.esperar('Caso f: la caja no hace UPDATE',
  pg_temp.probar($q$update liminal.saint_borradores set estado = 'creado'$q$), '^error 42501');

reset role;
reset "request.jwt.claim.sub";

-- Caso g (presupuesto de la CAJA): el contacto del presupuesto queda intacto (la caja no
-- pasa is_agent(): su UPDATE sobre `contacts` afecta 0 filas por RLS y el envío sigue;
-- lo que hace un asesor con un presupuesto está en saint_telefono_opcional_y_contacto.sql).
do $$
declare
  c record;
begin
  select * into c from public.contacts where id = 'b0d9e800-2000-0000-0000-000000000007';
  if c.cedula_type is not null or c.cedula_number is not null then
    insert into _errores(msg) values (format('Caso g: la caja no debía tocar el contacto del presupuesto y el 7 quedó con %L/%L.', c.cedula_type, c.cedula_number));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso h · borradores_saint: solo el último envío de cada origen
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a2';

do $$
declare
  n integer;
  r record;
begin
  -- cv1 tiene dos envíos (el viejo 'creado' y el nuevo 'pendiente'); PR1 uno;
  -- cv4 ninguno.
  select count(*) into n from public.borradores_saint(array[
    'b0d9e800-3000-0000-0000-000000000001'::uuid,
    'b0d9e800-5000-0000-0000-000000000001'::uuid,
    'b0d9e800-3000-0000-0000-000000000004'::uuid]);
  if n <> 2 then
    insert into _errores(msg) values (format('Caso h: se esperaban 2 orígenes con envío y salieron %s.', n));
  end if;
  select * into r from public.borradores_saint(array['b0d9e800-3000-0000-0000-000000000001'::uuid]);
  if r.id is distinct from (select id from _ids where clave = 'B1b') or r.estado is distinct from 'pendiente' then
    insert into _errores(msg) values (format('Caso h: el último envío de cv1 debía ser el reenvío pendiente y salió %s (%s).', r.id, r.estado));
  end if;
  if r.numero_saint is not null or r.nombre is distinct from 'Ana' or r.cedula_numero is distinct from '11111111' then
    insert into _errores(msg) values ('Caso h: las columnas devueltas no son las del último envío.');
  end if;
  -- El viejo, ya creado, sigue existiendo pero no es "el último".
  select * into r from public.borradores_saint(array['b0d9e800-3000-0000-0000-000000000001'::uuid]) where numero_saint = '004036';
  if r.id is not null then
    insert into _errores(msg) values ('Caso h: devolvió también el envío viejo del mismo origen.');
  end if;
  -- Arreglo vacío y arreglo enorme: no lanzan.
  select count(*) into n from public.borradores_saint(array[]::uuid[]);
  if n <> 0 then
    insert into _errores(msg) values (format('Caso h: arreglo vacío devolvió %s filas.', n));
  end if;
  select count(*) into n from public.borradores_saint((select array_agg(gen_random_uuid()) from generate_series(1, 600)));
  if n <> 0 then
    insert into _errores(msg) values (format('Caso h: 600 orígenes al azar devolvieron %s filas.', n));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso h: borradores_saint falló -- %s %s', sqlstate, sqlerrm));
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso i · anon no tiene nada
-- ---------------------------------------------------------------------------
set local role anon;
select pg_temp.esperar('Caso i: anon no ejecuta enviar_borrador_saint',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e800-3000-0000-0000-000000000002', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  '^error 42501');
select pg_temp.esperar('Caso i: anon no ejecuta borradores_saint',
  pg_temp.probar($q$select * from public.borradores_saint(array['b0d9e800-3000-0000-0000-000000000001'::uuid])$q$),
  '^error 42501');
select pg_temp.esperar('Caso i: anon no lee la tabla',
  pg_temp.probar($q$select * from liminal.saint_borradores$q$), '^error 42501');
select pg_temp.esperar('Caso i: anon no inserta',
  pg_temp.probar($q$insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items)
    values ('carrito', 'b0d9e800-9000-0000-0000-000000000003', 'b0d9e800-0000-0000-0000-0000000000a1', 'V', '11111111', 'Ana', 'Pérez', '+584141234567', '[{"codprod":"X","cantidad":1}]')$q$),
  '^error 42501');
reset role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.enviar_borrador_saint(text,uuid,text,text,text,text,text)',
    'public.borradores_saint(uuid[])']
  loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('public', f, 'EXECUTE') then
      insert into _errores(msg) values (format('Caso i: anon o PUBLIC pueden ejecutar %s.', f));
    end if;
    if not has_function_privilege('authenticated', f, 'EXECUTE') or not has_function_privilege('service_role', f, 'EXECUTE') then
      insert into _errores(msg) values (format('Caso i: authenticated y service_role deben poder ejecutar %s.', f));
    end if;
    if exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
      insert into _errores(msg) values (format('Caso i: %s debía ser security invoker.', f));
    end if;
  end loop;
  if has_table_privilege('authenticated', 'liminal.saint_borradores', 'UPDATE')
     or has_table_privilege('authenticated', 'liminal.saint_borradores', 'DELETE') then
    insert into _errores(msg) values ('Caso i: authenticated no debía poder UPDATE ni DELETE sobre la tabla.');
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'liminal' and tablename = 'saint_borradores') then
    insert into _errores(msg) values ('Caso i: la tabla no está publicada en supabase_realtime.');
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
    raise exception E'saint_borradores.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'saint_borradores.sql: todas las aserciones pasaron.'
