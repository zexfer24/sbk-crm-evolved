-- ===========================================================================
-- El piso de datos de los paneles (21/11/2026), plan "Los paneles cuentan desde
-- el lunes 16/11/2026 y se refrescan solos", T1 (migración
-- 20261121020000_paneles_inicio.sql; contrato en docs/paneles-contrato.md).
--
-- Qué fija:
--   1. `public.paneles_inicio()` = el lunes 16/11/2026 00:00 de Caracas
--      (2026-11-16 04:00:00+00), `immutable`, NO security definer, anon sin
--      EXECUTE.
--   2. A1: las firmas de panel_ventas, panel_conversaciones y panel_asesores NO
--      cambiaron (el código viejo sigue llamándolas): argumentos y retorno
--      iguales a literales escritos aquí; siguen security definer.
--   3. Paridad: pedir desde antes del piso es exactamente pedir desde el piso
--      (jsonb completo), también cuando el recorte cambia la granularidad de
--      panel_ventas (7 días -> 1 día: los dos salen por hora) y cuando el rango
--      original excedía los 92 días que el tope de las otras dos permite.
--   4. Un rango ENTERO anterior al piso no lanza: devuelve la forma vacía del
--      contrato (mismas claves que un rango válido sin datos, todo en cero).
--   5. Un rango invertido sigue siendo 22023, también si es anterior al piso.
--   6. D3: una compra anterior al piso cuenta como historia del cliente
--      (`recurrentes.online.regresan`): `hist` no se recorta.
--   7. Un reenvío del 16/11 de un envío del 15/11 sigue siendo duplicado: el
--      duplicado también se decide contra la historia anterior al piso.
--
-- La base del dev tiene datos reales, así que los conteos se miden como
-- DIFERENCIA contra una lectura base tomada antes de sembrar; las igualdades de
-- jsonb completo se comparan tal cual (las dos llamadas ven los mismos datos).
--
-- Corre como `authenticated` con la `sub` de un supervisor real (como `postgres`
-- se salta la RLS y no mediría nada). Aplicar la migración antes y correr con
-- `docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < ...`
-- Termina en rollback: no deja datos.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- Resultados de las RPC, guardados por clave para compararlos como postgres.
create temporary table _r (clave text primary key, j jsonb);
grant select, insert on _r to authenticated, service_role;

-- S: supervisor; A: asesor.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('d0a4e101-0000-0000-0000-0000000000b1', 'super-pinicio@sbk.test', jsonb_build_object('display_name', 'Super Piso'), '{"role":"supervisor"}'::jsonb),
  ('d0a4e101-0000-0000-0000-0000000000a1', 'asesor-pinicio@sbk.test', jsonb_build_object('display_name', 'Asesor Piso'), '{}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('d0a4e101-1000-0000-0000-000000000000', 'Canal de prueba piso', '+580000009801');

-- Un producto en USD (sin tasa de por medio): 5,00 -> 5,80 con el recargo.
insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active) values
  ('d0a4e101-4000-0000-0000-00000000000d', 'Prod PI D', 5.00, 'USD', 5, 'PI-D', true);

-- Utilidades ---------------------------------------------------------------
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

create or replace function pg_temp.esperar(etiqueta text, r text, patron text) returns void
language plpgsql as $$
begin
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

-- Dos resultados guardados deben ser idénticos (jsonb completo).
create or replace function pg_temp.igual(etiqueta text, a text, b text) returns void
language plpgsql as $$
declare
  v_a jsonb;
  v_b jsonb;
begin
  select j into v_a from _r where clave = a;
  select j into v_b from _r where clave = b;
  if v_a is null or v_b is null then
    insert into _errores(msg) values (format('%s: falta un resultado guardado (%s, %s).', etiqueta, a, b));
  elsif v_a is distinct from v_b then
    insert into _errores(msg) values (format('%s: los jsonb difieren.%s  %s: %s%s  %s: %s', etiqueta, E'\n', a, left(v_a::text, 600), E'\n', b, left(v_b::text, 600)));
  end if;
end $$;

-- Valor numérico de una ruta del resultado guardado (0 si no existe).
create or replace function pg_temp.num(p_clave text, ruta text) returns numeric
language sql as $$
  select coalesce((j #>> ruta::text[])::numeric, 0) from _r where clave = p_clave
$$;

create or replace function pg_temp.delta(etiqueta text, p_base text, p_post text, ruta text, esperado numeric) returns void
language plpgsql as $$
declare
  v_b numeric := pg_temp.num(p_base, ruta);
  v_p numeric := pg_temp.num(p_post, ruta);
begin
  if (v_p - v_b) is distinct from esperado then
    insert into _errores(msg) values (format('%s: en %s la diferencia debía ser %s y fue %s (antes %s, después %s).', etiqueta, ruta, esperado, v_p - v_b, v_b, v_p));
  end if;
end $$;

create or replace function pg_temp.eq(etiqueta text, p_clave text, ruta text, esperado jsonb) returns void
language plpgsql as $$
declare
  v_obt jsonb;
begin
  select coalesce(j #> ruta::text[], '"<ausente>"'::jsonb) into v_obt from _r where clave = p_clave;
  if v_obt is distinct from esperado then
    insert into _errores(msg) values (format('%s: en %s se esperaba %s y salió %s.', etiqueta, ruta, esperado, v_obt));
  end if;
end $$;

-- Todas las rutas de CLAVES de un jsonb, recorriendo solo objetos (un arreglo es
-- una hoja: su contenido depende de los datos, la forma del contrato no).
create or replace function pg_temp.claves(j jsonb, prefijo text default '') returns setof text
language plpgsql as $$
declare
  k text;
begin
  if jsonb_typeof(j) <> 'object' then
    return;
  end if;
  for k in select jsonb_object_keys(j) loop
    return next prefijo || '/' || k;
    return query select * from pg_temp.claves(j -> k, prefijo || '/' || k);
  end loop;
end $$;

create or replace function pg_temp.misma_forma(etiqueta text, a text, b text) returns void
language plpgsql as $$
declare
  v_a text[];
  v_b text[];
begin
  select array_agg(c order by c) into v_a from pg_temp.claves((select j from _r where clave = a)) c;
  select array_agg(c order by c) into v_b from pg_temp.claves((select j from _r where clave = b)) c;
  if v_a is null or v_b is null or v_a is distinct from v_b then
    insert into _errores(msg) values (format('%s: las claves difieren.%s  %s: %s%s  %s: %s', etiqueta, E'\n', a, v_a, E'\n', b, v_b));
  end if;
end $$;

create or replace function pg_temp.cid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e101-3000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.ctid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e101-2000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

-- Una conversación (con su contacto) de prueba.
create or replace function pg_temp.conv(n int) returns uuid
language plpgsql as $$
begin
  insert into public.contacts (id, phone_number, display_name)
  values (pg_temp.ctid(n), '+58000098' || lpad(n::text, 4, '0'), 'Cliente piso ' || n);
  insert into public.conversations (id, contact_id, whatsapp_channel_id)
  values (pg_temp.cid(n), pg_temp.ctid(n), 'd0a4e101-1000-0000-0000-000000000000');
  return pg_temp.cid(n);
end $$;

-- Un mensaje: 'c' cliente, 'a' asesor.
create or replace function pg_temp.msg(n int, tipo text, cuando timestamptz) returns void
language plpgsql as $$
begin
  insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at)
  values (
    pg_temp.cid(n),
    case when tipo = 'c' then 'inbound' else 'outbound' end,
    case tipo when 'c' then 'customer' else 'agent' end,
    case when tipo = 'a' then 'd0a4e101-0000-0000-0000-0000000000a1'::uuid end,
    'text', 'mensaje de prueba', false, cuando);
end $$;

-- Un envío `creado` del carrito de la conversación n (canal online): el trigger
-- de M1 escribe la foto. Un solo producto (PI-D x1), así que dos envíos de la
-- misma conversación tienen la misma firma de ítems.
create or replace function pg_temp.envio(n int, p_cedula text, p_codclie text, p_creado timestamptz) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, estado, created_at)
  values ('carrito', pg_temp.cid(n), 'd0a4e101-0000-0000-0000-0000000000a1', 'V', p_cedula, 'Nom', 'Ape', '+584140000000',
          '[{"codprod":"PI-D","cantidad":1}]', 'pendiente', p_creado)
  returning id into v_id;
  update liminal.saint_borradores
     set estado = 'creado', codclie = p_codclie, cliente_creado = true,
         numero_saint = 'F-' || left(v_id::text, 8), procesado_at = p_creado + interval '1 minute'
   where id = v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 1 · La función del piso.
-- ---------------------------------------------------------------------------
do $$
begin
  if public.paneles_inicio() is distinct from timestamptz '2026-11-16 04:00:00+00' then
    insert into _errores(msg) values (format('paneles_inicio() debía ser 2026-11-16 04:00:00+00 y es %s.', public.paneles_inicio()));
  end if;
  if public.paneles_inicio() is distinct from timestamptz '2026-11-16 00:00:00-04' then
    insert into _errores(msg) values ('paneles_inicio() no es el lunes 16/11/2026 00:00 de Caracas.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · A1: las firmas no cambiaron + permisos.
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
  r record;
begin
  foreach f in array array['panel_ventas', 'panel_conversaciones', 'panel_asesores'] loop
    select p.oid, p.prosecdef,
           pg_get_function_identity_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as res,
           (select count(*) from pg_proc q where q.proname = f and q.pronamespace = 'public'::regnamespace) as n
      into r
      from pg_proc p
     where p.proname = f and p.pronamespace = 'public'::regnamespace;
    if r.n <> 1 then
      insert into _errores(msg) values (format('A1: %s debe tener UNA sola firma y tiene %s.', f, r.n));
    end if;
    if r.args is distinct from 'p_desde timestamp with time zone, p_hasta timestamp with time zone' then
      insert into _errores(msg) values (format('A1: los argumentos de %s cambiaron: "%s".', f, r.args));
    end if;
    if r.res is distinct from 'jsonb' then
      insert into _errores(msg) values (format('A1: el retorno de %s cambió: "%s".', f, r.res));
    end if;
    if not r.prosecdef then
      insert into _errores(msg) values (format('Permisos: %s debía seguir security definer.', f));
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('public', r.oid, 'EXECUTE') then
      insert into _errores(msg) values (format('Permisos: anon o PUBLIC pueden ejecutar %s.', f));
    end if;
    if not has_function_privilege('authenticated', r.oid, 'EXECUTE') or not has_function_privilege('service_role', r.oid, 'EXECUTE') then
      insert into _errores(msg) values (format('Permisos: authenticated y service_role deben poder ejecutar %s.', f));
    end if;
  end loop;

  select p.oid, p.prosecdef, p.provolatile,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_function_result(p.oid) as res
    into r
    from pg_proc p
   where p.proname = 'paneles_inicio' and p.pronamespace = 'public'::regnamespace;
  if r.args is distinct from '' or r.res is distinct from 'timestamp with time zone' then
    insert into _errores(msg) values (format('paneles_inicio(): firma inesperada (args "%s", retorno "%s").', r.args, r.res));
  end if;
  if r.prosecdef then
    insert into _errores(msg) values ('paneles_inicio() NO debe ser security definer (no lee tablas).');
  end if;
  if r.provolatile <> 'i' then
    insert into _errores(msg) values (format('paneles_inicio() debe ser immutable y es "%s".', r.provolatile));
  end if;
  if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('public', r.oid, 'EXECUTE') then
    insert into _errores(msg) values ('Permisos: anon o PUBLIC pueden ejecutar paneles_inicio().');
  end if;
  if not has_function_privilege('authenticated', r.oid, 'EXECUTE') or not has_function_privilege('service_role', r.oid, 'EXECUTE') then
    insert into _errores(msg) values ('Permisos: authenticated y service_role deben poder ejecutar paneles_inicio().');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3 · Siembra. Las conversaciones 1 a 3 (cédulas 9810001 a 9810003).
-- ---------------------------------------------------------------------------
select pg_temp.conv(n) from generate_series(1, 4) n;

-- Lecturas BASE como supervisor, ANTES de sembrar las ventas.
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e101-0000-0000-0000-0000000000b1';
insert into _r select 'base_16_19', public.panel_ventas('2026-11-16 00:00-04', '2026-11-19 00:00-04');
insert into _r select 'base_16_17', public.panel_ventas('2026-11-16 00:00-04', '2026-11-17 00:00-04');
reset role;

-- Paridad: una venta el 12/11 (anterior al piso) y otra el 17/11, con mensajes
-- del cliente y del asesor esos mismos días.
select pg_temp.envio(2, '9810002', 'PI-C2', '2026-11-12 11:00-04');
select pg_temp.envio(3, '9810003', 'PI-C3', '2026-11-17 11:00-04');
select pg_temp.msg(2, 'c', '2026-11-12 10:00-04');
select pg_temp.msg(2, 'a', '2026-11-12 10:05-04');
select pg_temp.msg(3, 'c', '2026-11-17 10:00-04');
select pg_temp.msg(3, 'a', '2026-11-17 10:06-04');

-- D3: el cliente 9810001 compró el 10/11 (antes del piso) y vuelve el 18/11.
select pg_temp.envio(1, '9810001', 'PI-C1', '2026-11-10 12:00-04');
select pg_temp.envio(1, '9810001', 'PI-C1', '2026-11-18 12:00-04');

-- Duplicado a caballo del piso: envío el 15/11 23:50 (hora de Caracas) y su
-- reenvío idéntico (misma conversación, mismos ítems) el 16/11 00:20.
select pg_temp.envio(4, '9810004', 'PI-C4', '2026-11-15 23:50-04');
select pg_temp.envio(4, '9810004', 'PI-C4', '2026-11-16 00:20-04');

-- ---------------------------------------------------------------------------
-- 4 · Paridad, forma vacía, rangos inválidos: llamadas como supervisor.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e101-0000-0000-0000-0000000000b1';

insert into _r select 'v_larga',  public.panel_ventas('2026-11-10 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'v_piso',   public.panel_ventas('2026-11-16 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'v_7d',     public.panel_ventas('2026-11-10 00:00-04', '2026-11-17 00:00-04');
insert into _r select 'v_1d',     public.panel_ventas('2026-11-16 00:00-04', '2026-11-17 00:00-04');
insert into _r select 'c_larga',  public.panel_conversaciones('2026-11-10 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'c_piso',   public.panel_conversaciones('2026-11-16 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'a_larga',  public.panel_asesores('2026-11-10 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'a_piso',   public.panel_asesores('2026-11-16 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'c_140d',   public.panel_conversaciones('2026-07-01 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'a_140d',   public.panel_asesores('2026-07-01 00:00-04', '2026-11-18 00:00-04');
insert into _r select 'v_post_6', public.panel_ventas('2026-11-16 00:00-04', '2026-11-19 00:00-04');
insert into _r select 'v_post_7', public.panel_ventas('2026-11-16 00:00-04', '2026-11-17 00:00-04');

-- Forma vacía: un rango entero anterior al piso, y la referencia (rango válido
-- sin datos, en 2031).
insert into _r select 'v_vacio', public.panel_ventas('2026-11-01 00:00-04', '2026-11-10 00:00-04');
insert into _r select 'c_vacio', public.panel_conversaciones('2026-11-01 00:00-04', '2026-11-10 00:00-04');
insert into _r select 'a_vacio', public.panel_asesores('2026-11-01 00:00-04', '2026-11-10 00:00-04');
insert into _r select 'v_ref',   public.panel_ventas('2031-09-01 00:00-04', '2031-09-02 00:00-04');
insert into _r select 'c_ref',   public.panel_conversaciones('2031-09-01 00:00-04', '2031-09-02 00:00-04');
insert into _r select 'a_ref',   public.panel_asesores('2031-09-01 00:00-04', '2031-09-02 00:00-04');

-- Rango anterior al piso que además excede los 92 días: forma vacía, no 22023.
select pg_temp.esperar('panel_conversaciones: rango viejo de más de 92 días no lanza', pg_temp.probar($q$select public.panel_conversaciones('2026-01-01 00:00-04', '2026-11-10 00:00-04')$q$), '^filas=1');
select pg_temp.esperar('panel_asesores: rango viejo de más de 92 días no lanza', pg_temp.probar($q$select public.panel_asesores('2026-01-01 00:00-04', '2026-11-10 00:00-04')$q$), '^filas=1');
-- Un rango que termina EXACTO en el piso también es anterior a él (semiabierto).
select pg_temp.esperar('panel_ventas: un rango que termina en el piso no lanza', pg_temp.probar($q$select public.panel_ventas('2026-11-09 00:00-04', '2026-11-16 00:00-04')$q$), '^filas=1');

-- Rangos inválidos: invertido o vacío sigue siendo 22023 (aunque sea anterior al piso).
select pg_temp.esperar('Invertido en panel_ventas', pg_temp.probar($q$select public.panel_ventas('2031-03-11 00:00-04', '2031-03-10 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Invertido en panel_conversaciones', pg_temp.probar($q$select public.panel_conversaciones('2031-03-11 00:00-04', '2031-03-10 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Invertido en panel_asesores', pg_temp.probar($q$select public.panel_asesores('2031-03-11 00:00-04', '2031-03-10 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Invertido anterior al piso en panel_ventas', pg_temp.probar($q$select public.panel_ventas('2026-11-10 00:00-04', '2026-11-01 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Invertido anterior al piso en panel_conversaciones', pg_temp.probar($q$select public.panel_conversaciones('2026-11-10 00:00-04', '2026-11-01 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Invertido anterior al piso en panel_asesores', pg_temp.probar($q$select public.panel_asesores('2026-11-10 00:00-04', '2026-11-01 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Vacío en panel_ventas', pg_temp.probar($q$select public.panel_ventas('2026-11-10 00:00-04', '2026-11-10 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Nulo en panel_asesores', pg_temp.probar($q$select public.panel_asesores(null, '2026-11-10 00:00-04')$q$), '^error 22023');

-- El tope de 92 días se mide sobre el rango YA recortado: del piso al 2027 son más.
select pg_temp.esperar('Tope de 92 días tras el recorte (panel_conversaciones)', pg_temp.probar($q$select public.panel_conversaciones('2026-07-01 00:00-04', '2027-03-01 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Tope de 92 días tras el recorte (panel_asesores)', pg_temp.probar($q$select public.panel_asesores('2026-07-01 00:00-04', '2027-03-01 00:00-04')$q$), '^error 22023');
reset role;

-- Paridad (jsonb completo).
select pg_temp.igual('Ventas: 10/11-18/11 = 16/11-18/11', 'v_larga', 'v_piso');
select pg_temp.igual('Ventas: 10/11-17/11 (7 días) = 16/11-17/11 (1 día): los dos por hora', 'v_7d', 'v_1d');
select pg_temp.eq('Ventas: el rango recortado a 1 día sale por hora', 'v_7d', '{granularidad}', '"hora"');
select pg_temp.igual('Conversaciones: 10/11-18/11 = 16/11-18/11', 'c_larga', 'c_piso');
select pg_temp.igual('Asesores: 10/11-18/11 = 16/11-18/11', 'a_larga', 'a_piso');
select pg_temp.igual('Conversaciones: 140 días que terminan tras el piso = 16/11-18/11', 'c_140d', 'c_piso');
select pg_temp.igual('Asesores: 140 días que terminan tras el piso = 16/11-18/11', 'a_140d', 'a_piso');

-- Forma vacía: mismas claves que el rango válido sin datos y todo en cero.
select pg_temp.misma_forma('Ventas: forma vacía', 'v_vacio', 'v_ref');
select pg_temp.misma_forma('Conversaciones: forma vacía', 'c_vacio', 'c_ref');
select pg_temp.misma_forma('Asesores: forma vacía', 'a_vacio', 'a_ref');
select pg_temp.eq('Ventas vacío: envíos online', 'v_vacio', '{canales,online,envios}', '0');
select pg_temp.eq('Ventas vacío: envíos tienda', 'v_vacio', '{canales,tienda,envios}', '0');
select pg_temp.eq('Ventas vacío: ingresos online', 'v_vacio', '{canales,online,ingresos}', '0');
select pg_temp.eq('Ventas vacío: serie vacía', 'v_vacio', '{serie}', '[]');
select pg_temp.eq('Ventas vacío: perfil_horario vacío', 'v_vacio', '{perfil_horario}', '[]');
select pg_temp.eq('Ventas vacío: personas vacías', 'v_vacio', '{personas}', '[]');
select pg_temp.eq('Ventas vacío: top vacío', 'v_vacio', '{top_repuestos}', '[]');
select pg_temp.eq('Ventas vacío: duplicados', 'v_vacio', '{estado,duplicados}', '0');
select pg_temp.eq('Ventas vacío: sin foto', 'v_vacio', '{estado,sin_foto}', '0');
select pg_temp.eq('Ventas vacío: compradores online', 'v_vacio', '{recurrentes,online,compradores}', '0');
select pg_temp.eq('Conversaciones vacío: escribieron', 'c_vacio', '{embudo,escribieron}', '0');
select pg_temp.eq('Conversaciones vacío: compraron', 'c_vacio', '{embudo,compraron}', '0');
select pg_temp.eq('Conversaciones vacío: personas vacías', 'c_vacio', '{conversion,personas}', '[]');
select pg_temp.eq('Asesores vacío: personas vacías', 'a_vacio', '{personas}', '[]');
select pg_temp.eq('Asesores vacío: episodios del equipo', 'a_vacio', '{equipo,episodios}', '0');
select pg_temp.eq('Asesores vacío: mensajes de Seba', 'a_vacio', '{seba,mensajes}', '0');

-- D3: el cliente 9810001 compró el 10/11 (antes del piso) y el 18/11 (en el rango):
-- cuenta como comprador y REGRESA. Con la compra de la conv. 3 (17/11, sin
-- historia) los compradores online del 16/11-19/11 suben 2 y los que regresan 1.
select pg_temp.delta('D3: compradores online (9810001 y 9810003)', 'base_16_19', 'v_post_6', '{recurrentes,online,compradores}', 2);
select pg_temp.delta('D3: regresan online (solo 9810001, por su compra del 10/11)', 'base_16_19', 'v_post_6', '{recurrentes,online,regresan}', 1);

-- Duplicado a caballo del piso: el reenvío del 16/11 00:20 es duplicado de un
-- envío del 15/11 (fuera del rango pero dentro de la historia): +1 duplicado y
-- ninguna venta nueva el 16/11.
select pg_temp.delta('Duplicado: el reenvío del 16/11 cuenta como duplicado', 'base_16_17', 'v_post_7', '{estado,duplicados}', 1);
select pg_temp.delta('Duplicado: no suma envíos online el 16/11', 'base_16_17', 'v_post_7', '{canales,online,envios}', 0);

-- ---------------------------------------------------------------------------
-- Veredicto: un solo raise exception con todas las fallas.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int;
begin
  select count(*) into v_n from _errores;
  if v_n > 0 then
    raise exception E'paneles_inicio.sql: % verificación(es) fallaron:\n%', v_n, (select string_agg('  - ' || msg, E'\n') from _errores);
  end if;
  raise notice 'paneles_inicio.sql: todas las aserciones pasaron.';
end $$;

rollback;
