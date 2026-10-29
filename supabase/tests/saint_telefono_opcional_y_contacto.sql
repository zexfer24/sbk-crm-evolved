-- ===========================================================================
-- Facturar en SAINT (28/10/2026), plan "Facturar en SAINT sale del fondo del
-- panel", T0 (migración 20261028010000_saint_telefono_opcional_y_contacto.sql).
--
-- Contexto: el formulario de "Enviar a SAINT" dejó de exigir el teléfono (el
-- agente LiminalReplicant lo recibe pero no lo necesita para facturar) y pasó a
-- ser la fuente de verdad del contacto: lo que el asesor tipea en el último
-- envío (nombre, apellido, cédula) queda guardado en el contacto, aunque el
-- contacto ya tuviera otros datos. El teléfono del contacto NUNCA se toca: es la
-- llave de WhatsApp.
--
-- Qué fija:
--   a. Teléfono vacío (o en blanco) => se acepta y la fila guarda '' (la columna
--      `liminal.saint_borradores.telefono` sigue `not null`: contrato con el
--      agente, no se toca).
--   b. Teléfono con contenido inválido ('abc', '+12345') => 22023 con el detail
--      EXACTO 'Teléfono inválido.'; uno válido sigue entrando.
--   c. Carrito: el contacto de la conversación queda con
--      display_name = nombre || ' ' || apellido y la cédula tipeada, AUNQUE ya
--      tuviera otra cédula y otro nombre (gana el último envío). Su teléfono no
--      cambia.
--   d. Presupuesto con contacto: lo mismo, por `presupuestos.contact_id`.
--   e. Presupuesto sin contacto (contact_id nulo): el envío no falla y no se
--      toca ningún contacto.
--   f. Un reenvío con otros datos vuelve a pisar el contacto (siempre, no solo
--      "si faltaba" como en 20261025010000).
--   g. La caja (no pasa is_agent()) envía un presupuesto con contacto: el envío
--      entra, pero la RLS de `contacts` le da 0 filas y el contacto queda igual.
--      Es lo aceptado en el plan; el test lo fija para que no cambie en silencio.
--
-- Corre como `authenticated` con la `sub` de un usuario real (como `postgres` se
-- salta la RLS y no mediría nada). Aplicar la migración antes y correr con
-- `docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f - < ...`
-- Termina en rollback: no deja datos.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

create temporary table _ids (clave text primary key, id uuid);
grant select, insert on _ids to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('b0d9e801-0000-0000-0000-0000000000a1', 'asesor-tel-saint@sbk.test', jsonb_build_object('display_name', 'Asesor tel saint'), '{}'::jsonb),
  ('b0d9e801-0000-0000-0000-0000000000c1', 'caja-tel-saint@sbk.test',   jsonb_build_object('display_name', 'Caja tel saint'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('b0d9e801-1000-0000-0000-000000000000', 'Canal de prueba tel saint', '+580000009400');

-- c1: con cédula y nombre viejos (el envío los PISA); c2: sin cédula (presupuesto);
-- c3: presupuesto de la caja; c4: carrito del teléfono vacío; c5: carrito de las
-- validaciones (no debe quedar ninguna fila).
insert into public.contacts (id, phone_number, display_name, cedula_type, cedula_number) values
  ('b0d9e801-2000-0000-0000-000000000001', '+580000009401', 'Nombre Viejo', 'E', '99999999'),
  ('b0d9e801-2000-0000-0000-000000000002', '+580000009402', 'Contacto presupuesto', null, null),
  ('b0d9e801-2000-0000-0000-000000000003', '+580000009403', 'Contacto de la caja', 'E', '88888888'),
  ('b0d9e801-2000-0000-0000-000000000004', '+580000009404', 'Contacto teléfono vacío', null, null),
  ('b0d9e801-2000-0000-0000-000000000005', '+580000009405', 'Contacto validaciones', null, null);
insert into public.conversations (id, contact_id, whatsapp_channel_id)
select ('b0d9e801-3000-0000-0000-00000000000' || n)::uuid,
       ('b0d9e801-2000-0000-0000-00000000000' || n)::uuid,
       'b0d9e801-1000-0000-0000-000000000000'
  from generate_series(1, 5) n;

insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active) values
  ('b0d9e801-4000-0000-0000-000000000001', 'Prod tel SAINT', 10, 'USD', 5, 'TEL-A', true);

insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin) values
  ('b0d9e801-3000-0000-0000-000000000001', 'b0d9e801-4000-0000-0000-000000000001', 1, 'inventory'),
  ('b0d9e801-3000-0000-0000-000000000004', 'b0d9e801-4000-0000-0000-000000000001', 1, 'inventory'),
  ('b0d9e801-3000-0000-0000-000000000005', 'b0d9e801-4000-0000-0000-000000000001', 1, 'inventory');

-- PR1: con contacto c2; PR2: SIN contacto; PR3: con contacto c3 (lo envía la caja).
insert into public.presupuestos (id, cliente_nombre, cliente_apellido, contact_id, origen, created_by) values
  ('b0d9e801-5000-0000-0000-000000000001', 'Ana', 'Pérez', 'b0d9e801-2000-0000-0000-000000000002', 'inventario', 'b0d9e801-0000-0000-0000-0000000000a1'),
  ('b0d9e801-5000-0000-0000-000000000002', 'Sin', 'Contacto', null, 'inventario', 'b0d9e801-0000-0000-0000-0000000000a1'),
  ('b0d9e801-5000-0000-0000-000000000003', 'Caja', 'Cliente', 'b0d9e801-2000-0000-0000-000000000003', 'inventario', 'b0d9e801-0000-0000-0000-0000000000a1');
insert into public.presupuesto_items (presupuesto_id, product_id, quantity) values
  ('b0d9e801-5000-0000-0000-000000000001', 'b0d9e801-4000-0000-0000-000000000001', 1),
  ('b0d9e801-5000-0000-0000-000000000002', 'b0d9e801-4000-0000-0000-000000000001', 1),
  ('b0d9e801-5000-0000-0000-000000000003', 'b0d9e801-4000-0000-0000-000000000001', 1);

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

-- Comprueba display_name / cédula / teléfono de un contacto (como postgres).
create or replace function pg_temp.contacto(etiqueta text, p_id uuid, p_nombre text, p_tipo text, p_numero text, p_telefono text) returns void
language plpgsql as $$
declare
  c record;
begin
  select * into c from public.contacts where id = p_id;
  if c.display_name is distinct from p_nombre
     or c.cedula_type is distinct from p_tipo
     or c.cedula_number is distinct from p_numero
     or c.phone_number is distinct from p_telefono then
    insert into _errores(msg) values (format(
      '%s: el contacto debía quedar con %L / %L %L / tel %L y quedó %L / %L %L / tel %L.',
      etiqueta, p_nombre, p_tipo, p_numero, p_telefono,
      c.display_name, c.cedula_type, c.cedula_number, c.phone_number));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Casos a, b, c, f · el asesor envía carritos
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e801-0000-0000-0000-0000000000a1';

-- a · teléfono vacío y teléfono en blanco entran; la fila guarda ''.
select pg_temp.esperar('Caso a: teléfono vacío',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e801-3000-0000-0000-000000000004', 'V', '12345678', 'Luis', 'Mora', '')$q$),
  '^filas=1$');

do $$
declare
  r record;
begin
  select * into r from liminal.saint_borradores where origen_id = 'b0d9e801-3000-0000-0000-000000000004';
  if r.id is null then
    insert into _errores(msg) values ('Caso a: no quedó la fila del envío sin teléfono.');
  elsif r.telefono is distinct from '' then
    insert into _errores(msg) values (format('Caso a: el teléfono debía guardarse como cadena vacía y salió %L.', r.telefono));
  end if;
end $$;

-- a · teléfono en blanco (solo espacios) también; origen presupuesto SIN contacto
-- (caso e: contact_id nulo no puede hacer fallar el envío).
select pg_temp.esperar('Caso a: teléfono en blanco',
  pg_temp.probar($q$select public.enviar_borrador_saint('presupuesto', 'b0d9e801-5000-0000-0000-000000000002', 'V', '12345678', 'Sin', 'Contacto', '   ')$q$),
  '^filas=1$');

-- b · con contenido inválido sigue rechazando, con el texto exacto.
select pg_temp.esperar('Caso b: teléfono con letras',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e801-3000-0000-0000-000000000005', 'V', '12345678', 'Ana', 'Pérez', 'abc')$q$),
  '^error 22023: saint_dato_invalido \| Teléfono inválido\.$');
select pg_temp.esperar('Caso b: teléfono demasiado corto',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e801-3000-0000-0000-000000000005', 'V', '12345678', 'Ana', 'Pérez', '+12345')$q$),
  '^error 22023: saint_dato_invalido \| Teléfono inválido\.$');
select pg_temp.esperar('Caso b: no quedó fila del origen rechazado',
  pg_temp.contar($q$select 1 from liminal.saint_borradores where origen_id = 'b0d9e801-3000-0000-0000-000000000005'$q$),
  '^filas=0$');

-- c · carrito: el contacto (con nombre y cédula viejos) queda con los nuevos.
select pg_temp.esperar('Caso c: envío del carrito',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e801-3000-0000-0000-000000000001', 'v', '11111111', '  Ana ', ' Pérez ', '+584141234567')$q$),
  '^filas=1$');

reset role;
reset "request.jwt.claim.sub";

select pg_temp.contacto('Caso c: carrito pisa nombre y cédula, no el teléfono',
  'b0d9e801-2000-0000-0000-000000000001', 'Ana Pérez', 'V', '11111111', '+580000009401');
-- a · el contacto del carrito sin teléfono tipeado: sus datos nuevos también entran.
select pg_temp.contacto('Caso a: el envío sin teléfono también guarda el contacto',
  'b0d9e801-2000-0000-0000-000000000004', 'Luis Mora', 'V', '12345678', '+580000009404');

-- f · reenvío con otros datos: el primer envío tiene que cerrarse (simula al
-- agente, como postgres) para que el índice de "un envío en curso" deje pasar.
update liminal.saint_borradores set estado = 'creado', numero_saint = 'F-1'
 where origen_id = 'b0d9e801-3000-0000-0000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e801-0000-0000-0000-0000000000a1';

select pg_temp.esperar('Caso f: reenvío del carrito con otros datos',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'b0d9e801-3000-0000-0000-000000000001', 'E', '22222222', 'Beto', 'Rojas', '')$q$),
  '^filas=1$');

reset role;
reset "request.jwt.claim.sub";

select pg_temp.contacto('Caso f: gana el último envío',
  'b0d9e801-2000-0000-0000-000000000001', 'Beto Rojas', 'E', '22222222', '+580000009401');

-- ---------------------------------------------------------------------------
-- Casos d, e · el asesor envía presupuestos
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e801-0000-0000-0000-0000000000a1';

-- d · presupuesto CON contacto.
select pg_temp.esperar('Caso d: envío del presupuesto con contacto',
  pg_temp.probar($q$select public.enviar_borrador_saint('presupuesto', 'b0d9e801-5000-0000-0000-000000000001', 'V', '33333333', 'Carla', 'Díaz', '')$q$),
  '^filas=1$');

reset role;
reset "request.jwt.claim.sub";

select pg_temp.contacto('Caso d: el presupuesto guarda nombre y cédula en su contacto',
  'b0d9e801-2000-0000-0000-000000000002', 'Carla Díaz', 'V', '33333333', '+580000009402');

-- e · presupuesto SIN contacto: el envío del caso a (PR2, teléfono en blanco) ya
-- entró sin fallar; aquí se verifica que ningún contacto ajeno se tocó.
select pg_temp.contacto('Caso e: el presupuesto sin contacto no toca el contacto de las validaciones',
  'b0d9e801-2000-0000-0000-000000000005', 'Contacto validaciones', null, null, '+580000009405');
select pg_temp.esperar('Caso e: el presupuesto sin contacto sí dejó su envío',
  pg_temp.contar($q$select 1 from liminal.saint_borradores where origen_id = 'b0d9e801-5000-0000-0000-000000000002' and nombre = 'Sin'$q$),
  '^filas=1$');

-- ---------------------------------------------------------------------------
-- Caso g · la caja envía un presupuesto con contacto: entra, el contacto no cambia
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e801-0000-0000-0000-0000000000c1';

select pg_temp.esperar('Caso g: la caja envía el presupuesto',
  pg_temp.probar($q$select public.enviar_borrador_saint('presupuesto', 'b0d9e801-5000-0000-0000-000000000003', 'V', '44444444', 'Caja', 'Nueva', '')$q$),
  '^filas=1$');

reset role;
reset "request.jwt.claim.sub";

select pg_temp.contacto('Caso g: la RLS de contacts deja el contacto de la caja intacto',
  'b0d9e801-2000-0000-0000-000000000003', 'Contacto de la caja', 'E', '88888888', '+580000009403');

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
    raise exception E'saint_telefono_opcional_y_contacto.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'saint_telefono_opcional_y_contacto.sql: todas las aserciones pasaron.'
