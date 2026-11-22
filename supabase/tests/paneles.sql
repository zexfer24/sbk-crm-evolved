-- ===========================================================================
-- Las cinco RPC de lectura de los paneles (13/11/2026), plan "Paneles", M4
-- (migración 20261113040000_paneles_lectura.sql; contrato en
-- docs/paneles-contrato.md).
--
-- Qué fija:
--   1. panel_ventas: ingresos/envíos/unidades por canal = cuenta a mano;
--      `pendiente` va a tránsito y no a ingresos; `error` aparte; un
--      `duplicado` (vista `ventas_saint_estado`) no cuenta; la granularidad (hora/día/mes) sale del
--      rango; la serie trae tramos vacíos; perfil_horario (solo en `dia`);
--      personas, top de repuestos, tipo de precio, estado, recurrentes.
--   2. Un genérico (>= 20 ventas del mismo `codclie` en los 30 días que
--      terminan en p_hasta) se excluye de los recurrentes y cuenta en
--      `genericos_excluidos`.
--   3. panel_conversaciones: embudo y resultados a mano (con un reclamo cuya
--      etiqueta lleva tilde y mayúscula), `resultados` suma `escribieron`,
--      conversión por persona con ventana de 7 días, calor 7 x 24 en hora de
--      Caracas.
--   4. panel_asesores: episodios y mediana de primera respuesta a mano
--      (respuestas a 2, 8 y 90 min; un episodio cuyo antecedente es anterior
--      al rango; un mensaje que continúa una ráfaga NO es episodio).
--   5. panel_cola: una espera de 3 días cuenta; una de 20 días va a
--      `abandonadas`; el reloj corre desde el primer mensaje del cliente
--      posterior a la última respuesta; un chat cerrado no cuenta.
--   6. panel_ventas_activas (ventana de 48 h desde 20261122010000): presupuesto
--      sin enviar cuenta; uno con `creado` o en tránsito no; carrito cambiado
--      hace 40 h cuenta, hace 10 días no; carrito sin cambios desde su envío no;
--      presupuesto `chat` + carrito de la misma conversación cuentan 1; un
--      renglón sin precio nunca deja un parcial. La fecha de un presupuesto es
--      `updated_at`. El desglose por origen, equipo y ventana de WhatsApp tiene
--      su propio test: `paneles_ventas_activas.sql`.
--   7. Permisos: un asesor y una cuenta caja reciben 42501; anon no tiene
--      EXECUTE; un rango de más de 92 días en las dos que leen `messages`
--      y un rango invertido dan 22023.
--
-- panel_cola y panel_ventas_activas leen el estado ACTUAL de toda la base, no un
-- rango: se prueban por DIFERENCIA (foto antes y después de sembrar), así no
-- dependen de lo que ya hubiera en la base local. Los demás usan rangos del
-- año 2031, sin ningún dato real.
--
-- Corre como `authenticated` con la `sub` de usuarios reales (como `postgres` se
-- salta la RLS y no mediría nada). Aplicar la migración antes y correr con
-- `docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < ...`
-- Termina en rollback: no deja datos.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- Resultados de las RPC, guardados por clave para verificarlos como postgres.
create temporary table _r (clave text primary key, j jsonb);
grant select, insert on _r to authenticated, service_role;

-- S: supervisor; A y A2: asesores; C: caja.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('d0a4e100-0000-0000-0000-0000000000b1', 'super-paneles@sbk.test',  jsonb_build_object('display_name', 'Super Paneles'), '{"role":"supervisor"}'::jsonb),
  ('d0a4e100-0000-0000-0000-0000000000a1', 'asesor1-paneles@sbk.test', jsonb_build_object('display_name', 'Asesor Uno Paneles'), '{}'::jsonb),
  ('d0a4e100-0000-0000-0000-0000000000a2', 'asesor2-paneles@sbk.test', jsonb_build_object('display_name', 'Asesor Dos Paneles'), '{}'::jsonb),
  ('d0a4e100-0000-0000-0000-0000000000c1', 'caja-paneles@sbk.test',   jsonb_build_object('display_name', 'Caja Paneles'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('d0a4e100-1000-0000-0000-000000000000', 'Canal de prueba paneles', '+580000009700');

-- Tasa de la prueba: 40, con una fecha que la hace la vigente.
insert into public.exchange_rates (rate_date, usd_to_ves) values ('2999-12-31', 40);

-- Productos (precio CRUDO; el recargo y el techo los pone precio_venta_usd).
--   PN-A  Bs 1000  -> 29,00 promoción / 31,10 estándar (peso 2,5 kg: tarifa 2,10)
--   PN-B  Bs 100,50 -> 3,00
--   PN-D  USD 5     -> 5,80
--   PN-X  precio 0  -> sin precio (null)
insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active, weight_kg) values
  ('d0a4e100-4000-0000-0000-00000000000a', 'Prod PN A', 1000.00, 'VES', 5, 'PN-A', true, 2.5),
  ('d0a4e100-4000-0000-0000-00000000000b', 'Prod PN B',  100.50, 'VES', 5, 'PN-B', true, null),
  ('d0a4e100-4000-0000-0000-00000000000d', 'Prod PN D',    5.00, 'USD', 5, 'PN-D', true, null),
  ('d0a4e100-4000-0000-0000-00000000000f', 'Prod PN X',    0.00, 'USD', 5, 'PN-X', true, null);

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

-- Compara un valor de la RPC guardada en _r (ruta tipo '{canales,online,ingresos}')
-- con lo esperado, numérico-consciente: 29.00 = 29.
create or replace function pg_temp.eq(etiqueta text, p_clave text, ruta text, esperado jsonb) returns void
language plpgsql as $$
declare
  v_j jsonb;
  v_obt jsonb;
begin
  select j into v_j from _r where _r.clave = p_clave;
  if v_j is null then
    insert into _errores(msg) values (format('%s: no hay resultado guardado "%s".', etiqueta, p_clave));
    return;
  end if;
  v_obt := coalesce(v_j #> ruta::text[], '"<ausente>"'::jsonb);
  if v_obt is distinct from esperado then
    insert into _errores(msg) values (format('%s: en %s se esperaba %s y salió %s.', etiqueta, ruta, esperado, v_obt));
  end if;
end $$;

create or replace function pg_temp.largo(etiqueta text, p_clave text, ruta text, esperado int) returns void
language plpgsql as $$
declare
  v_j jsonb;
  v_obt int;
begin
  select j into v_j from _r where _r.clave = p_clave;
  v_obt := jsonb_array_length(v_j #> ruta::text[]);
  if v_obt is distinct from esperado then
    insert into _errores(msg) values (format('%s: el arreglo %s debía tener %s elementos y tiene %s.', etiqueta, ruta, esperado, coalesce(v_obt::text, 'null')));
  end if;
end $$;

-- Diferencia numérica entre dos fotos (post - base) de una RPC de estado actual.
create or replace function pg_temp.delta(etiqueta text, p_base text, p_post text, ruta text, esperado numeric) returns void
language plpgsql as $$
declare
  v_b numeric;
  v_p numeric;
begin
  select coalesce((j #>> ruta::text[])::numeric, 0) into v_b from _r where _r.clave = p_base;
  select coalesce((j #>> ruta::text[])::numeric, 0) into v_p from _r where _r.clave = p_post;
  if (v_p - v_b) is distinct from esperado then
    insert into _errores(msg) values (format('%s: en %s la diferencia debía ser %s y fue %s (antes %s, después %s).', etiqueta, ruta, esperado, v_p - v_b, v_b, v_p));
  end if;
end $$;

-- Ids por número: contacto n, conversación n, presupuesto n.
create or replace function pg_temp.cid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e100-3000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.ctid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e100-2000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.prid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e100-5000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.pid(l text) returns uuid language sql immutable as
  $$ select ('d0a4e100-4000-0000-0000-00000000000' || l)::uuid $$;

-- Una conversación (con su contacto) de prueba.
create or replace function pg_temp.conv(n int, p_asignado uuid default null) returns uuid
language plpgsql as $$
begin
  insert into public.contacts (id, phone_number, display_name)
  values (pg_temp.ctid(n), '+58000000' || lpad(n::text, 4, '0'), 'Cliente paneles ' || n);
  insert into public.conversations (id, contact_id, whatsapp_channel_id, assigned_agent_id)
  values (pg_temp.cid(n), pg_temp.ctid(n), 'd0a4e100-1000-0000-0000-000000000000', p_asignado);
  return pg_temp.cid(n);
end $$;

-- Un mensaje: 'c' cliente, 'a' asesor (quien), 'i' IA, 'n' nota interna de asesor.
create or replace function pg_temp.msg(n int, tipo text, quien uuid, cuando timestamptz) returns void
language plpgsql as $$
begin
  insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at)
  values (
    pg_temp.cid(n),
    case when tipo = 'c' then 'inbound' else 'outbound' end,
    case tipo when 'c' then 'customer' when 'i' then 'ai' else 'agent' end,
    case when tipo in ('a', 'n') then quien end,
    'text', 'mensaje de prueba', tipo = 'n', cuando);
end $$;

-- Un presupuesto con ítems: p_items = [{"p":"a","q":1,"k":"promocion"}, ...]
-- La fecha que cuenta para las activas es `updated_at` (`guardar_presupuesto` la
-- pone en now() al reemplazar los renglones): se fija igual que `created_at`.
create or replace function pg_temp.pres(n int, p_origen text, p_conv uuid, p_creado timestamptz, p_items jsonb) returns uuid
language plpgsql as $$
begin
  insert into public.presupuestos (id, cliente_nombre, cliente_apellido, conversation_id, origen, created_by, created_at, updated_at)
  values (pg_temp.prid(n), 'Cli', 'Paneles ' || n, p_conv, p_origen, 'd0a4e100-0000-0000-0000-0000000000a1', p_creado, p_creado);
  insert into public.presupuesto_items (presupuesto_id, product_id, quantity, price_kind)
  select pg_temp.prid(n), pg_temp.pid(i ->> 'p'), (i ->> 'q')::int, coalesce(i ->> 'k', 'promocion')
    from jsonb_array_elements(p_items) i;
  return pg_temp.prid(n);
end $$;

-- Un carrito de la conversación n: p_items = [{"p":"a","q":1}, ...]
create or replace function pg_temp.carrito(n int, p_actualizado timestamptz, p_items jsonb) returns void
language plpgsql as $$
begin
  insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, added_by, created_at, updated_at, price_kind)
  select pg_temp.cid(n), pg_temp.pid(i ->> 'p'), (i ->> 'q')::int, 'inventory',
         'd0a4e100-0000-0000-0000-0000000000a1', p_actualizado, p_actualizado, coalesce(i ->> 'k', 'promocion')
    from jsonb_array_elements(p_items) i;
end $$;

-- Un borrador de SAINT (el trigger de M1 escribe la foto) y, si no es
-- `pendiente`, su paso al estado final como lo haría LiminalReplicant.
create or replace function pg_temp.borrador(
  p_origen text, p_origen_id uuid, p_por uuid, p_cedula text, p_estado text, p_creado timestamptz,
  p_codclie text, p_cliente_creado boolean, p_items jsonb
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, estado, created_at)
  values (p_origen, p_origen_id, p_por, 'V', p_cedula, 'Nom', 'Ape', '+584140000000', p_items, 'pendiente', p_creado)
  returning id into v_id;
  if p_estado <> 'pendiente' then
    update liminal.saint_borradores
       set estado = p_estado,
           codclie = p_codclie,
           cliente_creado = p_cliente_creado,
           numero_saint = case when p_estado = 'creado' then 'F-' || left(v_id::text, 8) end,
           error = case when p_estado = 'error' then 'falló en la prueba' end,
           procesado_at = p_creado + interval '1 minute'
     where id = v_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 0 · FOTO BASE del estado actual (antes de sembrar nada), como supervisor.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
insert into _r select 'cola_base', public.panel_cola();
insert into _r select 'act_base', public.panel_ventas_activas();
reset role;

-- ---------------------------------------------------------------------------
-- 1 · Siembra de la cola y de las ventas activas (relativas a now()).
-- ---------------------------------------------------------------------------
-- Cola: W1 3 días sin dueño; W2 20 días con dueño (abandonada); W3 30 min con
-- dueño; W4 respondida hace 9 días y vuelve a escribir hace 2 h (el reloj corre
-- desde ese mensaje, no desde el de hace 10 días); W5 cerrada; W6 10 h.
select pg_temp.conv(101);
select pg_temp.conv(102, 'd0a4e100-0000-0000-0000-0000000000a1');
select pg_temp.conv(103, 'd0a4e100-0000-0000-0000-0000000000a1');
select pg_temp.conv(104);
select pg_temp.conv(105);
select pg_temp.conv(106);
select pg_temp.msg(101, 'c', null, now() - interval '3 days');
select pg_temp.msg(102, 'c', null, now() - interval '20 days');
select pg_temp.msg(103, 'c', null, now() - interval '30 minutes');
select pg_temp.msg(104, 'c', null, now() - interval '10 days');
select pg_temp.msg(104, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', now() - interval '9 days');
select pg_temp.msg(104, 'c', null, now() - interval '2 hours');
select pg_temp.msg(105, 'c', null, now() - interval '1 day');
select pg_temp.msg(106, 'c', null, now() - interval '10 hours');
update public.conversations set status = 'closed' where id = pg_temp.cid(105);

-- Ventas activas.
select pg_temp.conv(111);
select pg_temp.conv(112);
select pg_temp.conv(113);
select pg_temp.conv(114);
select pg_temp.conv(115);
-- PR1 inventario hace 30 h: A + D = 29,00 + 5,80 = 34,80 (tienda, tramo 3d).
select pg_temp.pres(1, 'inventario', null, now() - interval '30 hours', '[{"p":"a","q":1},{"p":"d","q":1}]');
-- PR2 con un borrador `creado`: ya se vendió, no cuenta.
select pg_temp.pres(2, 'inventario', null, now() - interval '1 day', '[{"p":"d","q":1}]');
-- PR3 del chat (conv 111) hace 10 h: D x2 = 11,60 (online, 24h). El carrito de
-- la conv 111 NO suma: cuenta solo el presupuesto.
select pg_temp.pres(3, 'chat', pg_temp.cid(111), now() - interval '10 hours', '[{"p":"d","q":2}]');
-- PR4 hace 40 días: fuera de la ventana de 48 h.
select pg_temp.pres(4, 'inventario', null, now() - interval '40 days', '[{"p":"d","q":1}]');
-- PR5 con un renglón sin precio (PN-X): suma a sin_precio y su monto queda null.
select pg_temp.pres(5, 'inventario', null, now() - interval '36 hours', '[{"p":"f","q":1}]');
-- PR6 con un borrador en tránsito: no cuenta.
select pg_temp.pres(6, 'inventario', null, now() - interval '1 day', '[{"p":"d","q":1}]');
select pg_temp.carrito(111, now() - interval '1 day', '[{"p":"a","q":1}]');
-- G2: carrito cambiado hace 40 h: A + B = 32,00 (online, 3d).
select pg_temp.carrito(112, now() - interval '40 hours', '[{"p":"a","q":1},{"p":"b","q":1}]');
-- G3: carrito cambiado hace 10 días: fuera de la ventana de 48 h.
select pg_temp.carrito(113, now() - interval '10 days', '[{"p":"d","q":1}]');
-- G4: cambiado hace 40 h y enviado (creado) hace 1 día, DESPUÉS del cambio: no cuenta.
select pg_temp.carrito(114, now() - interval '40 hours', '[{"p":"d","q":1}]');
-- G5: cambiado hace 36 h; su envío fue hace 5 días, ANTES del cambio: cuenta (5,80, 3d).
select pg_temp.carrito(115, now() - interval '36 hours', '[{"p":"d","q":1}]');

select pg_temp.borrador('presupuesto', pg_temp.prid(2), 'd0a4e100-0000-0000-0000-0000000000a1', '1', 'creado', now() - interval '12 hours', 'X1', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('presupuesto', pg_temp.prid(6), 'd0a4e100-0000-0000-0000-0000000000a1', '1', 'pendiente', now() - interval '1 hour', null, null, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(114), 'd0a4e100-0000-0000-0000-0000000000a1', '1', 'creado', now() - interval '1 day', 'X2', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(115), 'd0a4e100-0000-0000-0000-0000000000a1', '1', 'creado', now() - interval '5 days', 'X3', true, '[{"codprod":"PN-D","cantidad":1}]');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
insert into _r select 'cola_post', public.panel_cola();
insert into _r select 'act_post', public.panel_ventas_activas();
reset role;

-- ---- panel_cola (caso 5) ----
select pg_temp.delta('Cola: pendientes', 'cola_base', 'cola_post', '{pendientes}', 4);
select pg_temp.delta('Cola: abandonadas (la de 20 días)', 'cola_base', 'cola_post', '{abandonadas}', 1);
select pg_temp.delta('Cola: sin dueño', 'cola_base', 'cola_post', '{sin_dueno}', 3);
select pg_temp.delta('Cola: con dueño', 'cola_base', 'cola_post', '{con_dueno}', 1);
select pg_temp.delta('Cola: menos de 1 h (W3)', 'cola_base', 'cola_post', '{por_antiguedad,menos_1h}', 1);
select pg_temp.delta('Cola: de 1 a 4 h (W4, desde el mensaje posterior a la última respuesta)', 'cola_base', 'cola_post', '{por_antiguedad,de_1_a_4h}', 1);
select pg_temp.delta('Cola: de 4 a 24 h (W6)', 'cola_base', 'cola_post', '{por_antiguedad,de_4_a_24h}', 1);
select pg_temp.delta('Cola: de 1 a 7 días (W1)', 'cola_base', 'cola_post', '{por_antiguedad,de_1_a_7d}', 1);
select pg_temp.eq('Cola: corte de días', 'cola_post', '{corte_dias}', '7');
-- Si la base estaba sin pendientes (CI), la más vieja es W1 y la lista trae las cuatro.
do $$
declare
  v_base jsonb := (select j from _r where clave = 'cola_base');
  v_post jsonb := (select j from _r where clave = 'cola_post');
begin
  if (v_base ->> 'pendientes')::int = 0 then
    if v_post #>> '{mas_viejo,conversation_id}' is distinct from pg_temp.cid(101)::text then
      insert into _errores(msg) values (format('Cola: la espera más vieja debía ser W1 y salió %s.', v_post #> '{mas_viejo}'));
    end if;
    if jsonb_array_length(v_post -> 'lista') <> 4 then
      insert into _errores(msg) values (format('Cola: la lista debía traer las 4 pendientes y trae %s.', jsonb_array_length(v_post -> 'lista')));
    end if;
    if v_post #>> '{lista,0,contacto}' is distinct from 'Cliente paneles 101' then
      insert into _errores(msg) values (format('Cola: el contacto de la más vieja debía ser "Cliente paneles 101" y salió %s.', v_post #> '{lista,0,contacto}'));
    end if;
  end if;
end $$;

-- ---- panel_ventas_activas (caso 6) ----
select pg_temp.delta('Activas: total', 'act_base', 'act_post', '{total}', 84.20);
select pg_temp.delta('Activas: presupuestos monto', 'act_base', 'act_post', '{presupuestos,monto}', 46.40);
select pg_temp.delta('Activas: presupuestos cantidad (PR1, PR3, PR5)', 'act_base', 'act_post', '{presupuestos,cantidad}', 3);
select pg_temp.delta('Activas: presupuestos sin precio (PR5)', 'act_base', 'act_post', '{presupuestos,sin_precio}', 1);
select pg_temp.delta('Activas: carritos monto', 'act_base', 'act_post', '{carritos,monto}', 37.80);
select pg_temp.delta('Activas: carritos cantidad (G2, G5)', 'act_base', 'act_post', '{carritos,cantidad}', 2);
select pg_temp.delta('Activas: carritos sin precio', 'act_base', 'act_post', '{carritos,sin_precio}', 0);
select pg_temp.delta('Activas: online monto', 'act_base', 'act_post', '{por_canal,online,monto}', 49.40);
select pg_temp.delta('Activas: online cantidad', 'act_base', 'act_post', '{por_canal,online,cantidad}', 3);
select pg_temp.delta('Activas: tienda monto (PR5 sin precio no suma)', 'act_base', 'act_post', '{por_canal,tienda,monto}', 34.80);
select pg_temp.delta('Activas: tienda cantidad', 'act_base', 'act_post', '{por_canal,tienda,cantidad}', 2);
select pg_temp.delta('Activas: tramo 24h cantidad', 'act_base', 'act_post', '{antiguedad,0,cantidad}', 1);
select pg_temp.delta('Activas: tramo 24h monto', 'act_base', 'act_post', '{antiguedad,0,monto}', 11.60);
select pg_temp.delta('Activas: tramo 3d cantidad (PR1, PR5, G2, G5)', 'act_base', 'act_post', '{antiguedad,1,cantidad}', 4);
select pg_temp.delta('Activas: tramo 3d monto', 'act_base', 'act_post', '{antiguedad,1,monto}', 72.60);
select pg_temp.delta('Activas: tramo 7d cantidad (con 48 h ya no se llena)', 'act_base', 'act_post', '{antiguedad,2,cantidad}', 0);
select pg_temp.delta('Activas: tramo 7d monto', 'act_base', 'act_post', '{antiguedad,2,monto}', 0);
select pg_temp.delta('Activas: tramo 30d cantidad', 'act_base', 'act_post', '{antiguedad,3,cantidad}', 0);
do $$
declare
  v_post jsonb := (select j from _r where clave = 'act_post');
  v_base jsonb := (select j from _r where clave = 'act_base');
  v_tramos text;
begin
  select string_agg(t ->> 'tramo', ',' order by ord) into v_tramos
    from jsonb_array_elements(v_post -> 'antiguedad') with ordinality as x(t, ord);
  if v_tramos is distinct from '24h,3d,7d,30d' then
    insert into _errores(msg) values (format('Activas: los tramos debían ser 24h,3d,7d,30d y salieron %s.', v_tramos));
  end if;
  -- Con la base sin presupuestos ni carritos (CI), `items` trae exactamente las 5 cosas.
  if (v_base #>> '{presupuestos,cantidad}')::int = 0 and (v_base #>> '{carritos,cantidad}')::int = 0 then
    if jsonb_array_length(v_post -> 'items') <> 5 then
      insert into _errores(msg) values (format('Activas: items debía traer 5 y trae %s.', jsonb_array_length(v_post -> 'items')));
    end if;
    -- El más viejo primero: G2 (40 h, carrito de la conversación 112).
    if v_post #>> '{items,0,id}' is distinct from pg_temp.cid(112)::text
       or v_post #>> '{items,0,tipo}' is distinct from 'carrito' then
      insert into _errores(msg) values (format('Activas: el primer ítem debía ser el carrito G2 y salió %s.', v_post #> '{items,0}'));
    end if;
  end if;
  -- PR5 trae un renglón sin precio: su ítem queda sin monto (nunca un parcial).
  if not exists (
       select 1 from jsonb_array_elements(v_post -> 'items') e
        where e ->> 'id' = pg_temp.prid(5)::text
          and e -> 'monto' = 'null'::jsonb and e ->> 'tipo' = 'presupuesto') then
    insert into _errores(msg) values ('Activas: el ítem de PR5 debía estar y quedar sin monto.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · Siembra de panel_ventas (marzo de 2031, hora de Caracas -04).
-- ---------------------------------------------------------------------------
select pg_temp.conv(n) from generate_series(1, 5) n;
-- Carritos de las conversaciones online (con fecha vieja: ya no importan a las activas).
select pg_temp.carrito(1, '2020-01-01', '[{"p":"a","q":1},{"p":"d","q":2}]');
select pg_temp.carrito(2, '2020-01-01', '[{"p":"a","q":2}]');
select pg_temp.carrito(3, '2020-01-01', '[{"p":"b","q":1}]');
select pg_temp.carrito(4, '2020-01-01', '[{"p":"d","q":1}]');
select pg_temp.carrito(5, '2020-01-01', '[{"p":"f","q":1}]');
-- Presupuestos de la tienda.
select pg_temp.pres(11, 'inventario', null, '2020-01-01', '[{"p":"a","q":1},{"p":"b","q":1}]');
select pg_temp.pres(12, 'inventario', null, '2020-01-01', '[{"p":"d","q":1}]');
select pg_temp.pres(13, 'inventario', null, '2020-01-01', '[{"p":"a","q":1,"k":"estandar"}]');
select pg_temp.pres(14, 'inventario', null, '2020-01-01', '[{"p":"d","q":1}]');

-- Una venta anterior al rango del mismo cliente 200 (lo vuelve "recurrente") y 19
-- ventas del mismo `codclie` 'CG' (con la del caso V6 son 20: genérico).
select pg_temp.borrador('presupuesto', gen_random_uuid(), 'd0a4e100-0000-0000-0000-0000000000a1', '200', 'creado', '2031-02-20 12:00-04', 'C200', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('presupuesto', gen_random_uuid(), 'd0a4e100-0000-0000-0000-0000000000a1', '600', 'creado', timestamptz '2031-02-15 08:00-04' + (n || ' hours')::interval, 'CG', true, '[{"codprod":"PN-D","cantidad":1}]')
  from generate_series(1, 19) n;

-- V1..V11 (clave: V<n>). Cédula = clave del comprador.
select pg_temp.borrador('carrito', pg_temp.cid(1), 'd0a4e100-0000-0000-0000-0000000000a1', '100', 'creado', '2031-03-10 09:30-04', 'C100', true, '[{"codprod":"PN-A","cantidad":1},{"codprod":"PN-D","cantidad":2}]'); -- V1 online A 40,60
select pg_temp.borrador('carrito', pg_temp.cid(2), 'd0a4e100-0000-0000-0000-0000000000a2', '200', 'creado', '2031-03-10 15:10-04', 'C200', true, '[{"codprod":"PN-A","cantidad":2}]');                                       -- V2 online A2 58,00
select pg_temp.borrador('carrito', pg_temp.cid(3), 'd0a4e100-0000-0000-0000-0000000000a1', '100', 'creado', '2031-03-11 09:45-04', 'C100', true, '[{"codprod":"PN-B","cantidad":1}]');                                       -- V3 online A 3,00
select pg_temp.borrador('presupuesto', pg_temp.prid(11), 'd0a4e100-0000-0000-0000-0000000000a1', '400', 'creado', '2031-03-10 10:05-04', 'C400', true, '[{"codprod":"PN-A","cantidad":1},{"codprod":"PN-B","cantidad":1}]'); -- V4 tienda A 32,00
select pg_temp.borrador('presupuesto', pg_temp.prid(12), 'd0a4e100-0000-0000-0000-0000000000a2', '500', 'creado', '2031-03-11 15:00-04', 'C500', false, '[{"codprod":"PN-D","cantidad":1}]');                          -- V5 tienda A2 5,80
select pg_temp.borrador('presupuesto', pg_temp.prid(13), 'd0a4e100-0000-0000-0000-0000000000c1', '600', 'creado', '2031-03-11 11:00-04', 'CG', true, '[{"codprod":"PN-A","cantidad":1}]');                                  -- V6 tienda C estándar 31,10 (genérico)
select pg_temp.borrador('carrito', pg_temp.cid(4), 'd0a4e100-0000-0000-0000-0000000000a1', '700', 'pendiente', '2031-03-11 12:00-04', null, null, '[{"codprod":"PN-D","cantidad":1}]');                                   -- V7 en tránsito 5,80
select pg_temp.borrador('presupuesto', pg_temp.prid(14), 'd0a4e100-0000-0000-0000-0000000000a1', '800', 'error', '2031-03-11 13:00-04', null, null, '[{"codprod":"PN-D","cantidad":1}]');                                   -- V8 error
select pg_temp.borrador('carrito', pg_temp.cid(2), 'd0a4e100-0000-0000-0000-0000000000a2', '200', 'creado', '2031-03-10 16:00-04', 'C200', true, '[{"codprod":"PN-A","cantidad":2}]');                                       -- V9 reenvío de V2: duplicado
select pg_temp.borrador('carrito', pg_temp.cid(5), 'd0a4e100-0000-0000-0000-0000000000a2', '300', 'creado', '2031-03-11 17:00-04', 'C300', false, '[{"codprod":"PN-X","cantidad":1}]');                                      -- V10 online A2 sin precio
select pg_temp.borrador('presupuesto', gen_random_uuid(), 'd0a4e100-0000-0000-0000-0000000000a1', '900', 'creado', '2031-03-11 18:00-04', 'C900', true, '[{"codprod":"PN-D","cantidad":1}]');                                -- V11 se queda sin foto
delete from public.ventas_saint
 where borrador_id = (select id from liminal.saint_borradores where cedula_numero = '900' and created_at = '2031-03-11 18:00-04');

-- ---------------------------------------------------------------------------
-- 3 · Llamadas de panel_ventas como supervisor (hora, día y mes).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
insert into _r select 'v_hora', public.panel_ventas('2031-03-10 00:00-04', '2031-03-11 00:00-04');
insert into _r select 'v_dia',  public.panel_ventas('2031-03-10 00:00-04', '2031-03-13 00:00-04');
insert into _r select 'v_mes',  public.panel_ventas('2031-01-01 00:00-04', '2031-05-01 00:00-04');
reset role;

-- Granularidad según el rango, y la serie trae todos los tramos (con 0).
select pg_temp.eq('Ventas hora: granularidad', 'v_hora', '{granularidad}', '"hora"');
select pg_temp.eq('Ventas día: granularidad', 'v_dia', '{granularidad}', '"dia"');
select pg_temp.eq('Ventas mes: granularidad', 'v_mes', '{granularidad}', '"mes"');
select pg_temp.largo('Ventas hora: 24 tramos', 'v_hora', '{serie}', 24);
select pg_temp.largo('Ventas día: 3 tramos (el último vacío)', 'v_dia', '{serie}', 3);
select pg_temp.largo('Ventas mes: 4 tramos (enero a abril)', 'v_mes', '{serie}', 4);
select pg_temp.eq('Ventas hora: la venta de las 9:30 cae en la hora 9 (online)', 'v_hora', '{serie,9,online}', '40.60');
select pg_temp.eq('Ventas hora: la de las 15:10 en la hora 15 (online)', 'v_hora', '{serie,15,online}', '58.00');
select pg_temp.eq('Ventas hora: la de las 10:05 en la hora 10 (tienda)', 'v_hora', '{serie,10,tienda}', '32.00');
select pg_temp.eq('Ventas hora: una hora vacía trae 0', 'v_hora', '{serie,3,online}', '0');
select pg_temp.eq('Ventas hora: el primer tramo arranca a medianoche de Caracas', 'v_hora', '{serie,0,t}', '"2031-03-10T00:00:00-04:00"');
select pg_temp.eq('Ventas hora: el duplicado (V9) no suma al ingreso online', 'v_hora', '{canales,online,ingresos}', '98.60');
select pg_temp.eq('Ventas hora: perfil_horario vacío si no es por día', 'v_hora', '{perfil_horario}', '[]');
select pg_temp.eq('Ventas mes: perfil_horario vacío si no es por día', 'v_mes', '{perfil_horario}', '[]');

-- Resumen por canal (rango de 3 días) = cuenta a mano.
select pg_temp.eq('Online: ingresos', 'v_dia', '{canales,online,ingresos}', '101.60');
select pg_temp.eq('Online: envíos (V1, V2, V3, V10; no V7 en tránsito ni V9 duplicado)', 'v_dia', '{canales,online,envios}', '4');
select pg_temp.eq('Online: unidades', 'v_dia', '{canales,online,unidades}', '7');
select pg_temp.eq('Online: ticket = ingresos / envíos con monto', 'v_dia', '{canales,online,ticket}', '33.87');
select pg_temp.eq('Online: sin monto (V10)', 'v_dia', '{canales,online,sin_monto}', '1');
select pg_temp.eq('Online: estimados', 'v_dia', '{canales,online,estimados}', '0');
select pg_temp.eq('Tienda: ingresos (con el estándar de la caja completo)', 'v_dia', '{canales,tienda,ingresos}', '68.90');
select pg_temp.eq('Tienda: envíos', 'v_dia', '{canales,tienda,envios}', '3');
select pg_temp.eq('Tienda: unidades', 'v_dia', '{canales,tienda,unidades}', '4');
select pg_temp.eq('Tienda: ticket', 'v_dia', '{canales,tienda,ticket}', '22.97');
select pg_temp.eq('Tienda: sin monto', 'v_dia', '{canales,tienda,sin_monto}', '0');

-- Serie por día.
select pg_temp.eq('Serie día 1: online', 'v_dia', '{serie,0,online}', '98.60');
select pg_temp.eq('Serie día 1: tienda', 'v_dia', '{serie,0,tienda}', '32.00');
select pg_temp.eq('Serie día 1: envíos online', 'v_dia', '{serie,0,envios_online}', '2');
select pg_temp.eq('Serie día 1: envíos tienda', 'v_dia', '{serie,0,envios_tienda}', '1');
select pg_temp.eq('Serie día 2: online (V10 sin monto no suma)', 'v_dia', '{serie,1,online}', '3.00');
select pg_temp.eq('Serie día 2: tienda', 'v_dia', '{serie,1,tienda}', '36.90');
select pg_temp.eq('Serie día 2: envíos online (V3 y V10)', 'v_dia', '{serie,1,envios_online}', '2');
select pg_temp.eq('Serie día 2: envíos tienda', 'v_dia', '{serie,1,envios_tienda}', '2');
select pg_temp.eq('Serie día 3: vacío', 'v_dia', '{serie,2,online}', '0');
select pg_temp.eq('Serie día 3: envíos vacíos', 'v_dia', '{serie,2,envios_tienda}', '0');

-- Perfil horario (solo con granularidad día): un elemento por día, 24 montos por canal.
select pg_temp.largo('Perfil: un elemento por día del rango', 'v_dia', '{perfil_horario}', 3);
select pg_temp.eq('Perfil día 1: la fecha', 'v_dia', '{perfil_horario,0,dia}', '"2031-03-10"');
select pg_temp.largo('Perfil día 1: 24 horas online', 'v_dia', '{perfil_horario,0,online}', 24);
select pg_temp.largo('Perfil día 1: 24 horas tienda', 'v_dia', '{perfil_horario,0,tienda}', 24);
select pg_temp.eq('Perfil día 1: online hora 9', 'v_dia', '{perfil_horario,0,online,9}', '40.60');
select pg_temp.eq('Perfil día 1: online hora 15', 'v_dia', '{perfil_horario,0,online,15}', '58.00');
select pg_temp.eq('Perfil día 1: online hora 10 vacía', 'v_dia', '{perfil_horario,0,online,10}', '0');
select pg_temp.eq('Perfil día 1: tienda hora 10', 'v_dia', '{perfil_horario,0,tienda,10}', '32.00');
select pg_temp.eq('Perfil día 2: la fecha', 'v_dia', '{perfil_horario,1,dia}', '"2031-03-11"');
select pg_temp.eq('Perfil día 2: online hora 9 (otra hora que el día 1 para el otro canal)', 'v_dia', '{perfil_horario,1,online,9}', '3.00');
select pg_temp.eq('Perfil día 2: online hora 17 (V10 sin monto)', 'v_dia', '{perfil_horario,1,online,17}', '0');
select pg_temp.eq('Perfil día 2: tienda hora 11 (estándar de la caja)', 'v_dia', '{perfil_horario,1,tienda,11}', '31.10');
select pg_temp.eq('Perfil día 2: tienda hora 15', 'v_dia', '{perfil_horario,1,tienda,15}', '5.80');
select pg_temp.eq('Perfil día 3: la fecha', 'v_dia', '{perfil_horario,2,dia}', '"2031-03-12"');
select pg_temp.eq('Perfil día 3: vacío', 'v_dia', '{perfil_horario,2,tienda,11}', '0');

-- Personas: por (quien envió, canal), ingresos desc.
select pg_temp.largo('Personas: 5 filas', 'v_dia', '{personas}', 5);
select pg_temp.eq('Personas 1: A2 online', 'v_dia', '{personas,0,agent_id}', to_jsonb('d0a4e100-0000-0000-0000-0000000000a2'::text));
select pg_temp.eq('Personas 1: canal', 'v_dia', '{personas,0,canal}', '"online"');
select pg_temp.eq('Personas 1: nombre', 'v_dia', '{personas,0,nombre}', '"Asesor Dos Paneles"');
select pg_temp.eq('Personas 1: rol', 'v_dia', '{personas,0,rol}', '"agent"');
select pg_temp.eq('Personas 1: ingresos (V2; V10 no tiene monto)', 'v_dia', '{personas,0,ingresos}', '58.00');
select pg_temp.eq('Personas 1: envíos', 'v_dia', '{personas,0,envios}', '2');
select pg_temp.eq('Personas 1: unidades', 'v_dia', '{personas,0,unidades}', '3');
select pg_temp.eq('Personas 2: A online', 'v_dia', '{personas,1,agent_id}', to_jsonb('d0a4e100-0000-0000-0000-0000000000a1'::text));
select pg_temp.eq('Personas 2: ingresos', 'v_dia', '{personas,1,ingresos}', '43.60');
select pg_temp.eq('Personas 2: envíos', 'v_dia', '{personas,1,envios}', '2');
select pg_temp.eq('Personas 3: A tienda', 'v_dia', '{personas,2,canal}', '"tienda"');
select pg_temp.eq('Personas 3: ingresos', 'v_dia', '{personas,2,ingresos}', '32.00');
select pg_temp.eq('Personas 4: la caja con el estándar completo', 'v_dia', '{personas,3,rol}', '"caja"');
select pg_temp.eq('Personas 4: ingresos', 'v_dia', '{personas,3,ingresos}', '31.10');
select pg_temp.eq('Personas 5: A2 tienda', 'v_dia', '{personas,4,ingresos}', '5.80');

-- Top de repuestos.
select pg_temp.largo('Top: 4 repuestos', 'v_dia', '{top_repuestos}', 4);
select pg_temp.eq('Top 1: PN-A', 'v_dia', '{top_repuestos,0,codprod}', '"PN-A"');
select pg_temp.eq('Top 1: nombre', 'v_dia', '{top_repuestos,0,nombre}', '"Prod PN A"');
select pg_temp.eq('Top 1: unidades', 'v_dia', '{top_repuestos,0,unidades}', '5');
select pg_temp.eq('Top 1: ingresos', 'v_dia', '{top_repuestos,0,ingresos}', '147.10');
select pg_temp.eq('Top 1: unidades online', 'v_dia', '{top_repuestos,0,unidades_online}', '3');
select pg_temp.eq('Top 1: unidades tienda', 'v_dia', '{top_repuestos,0,unidades_tienda}', '2');
select pg_temp.eq('Top 2: PN-D', 'v_dia', '{top_repuestos,1,codprod}', '"PN-D"');
select pg_temp.eq('Top 2: ingresos', 'v_dia', '{top_repuestos,1,ingresos}', '17.40');
select pg_temp.eq('Top 3: PN-B', 'v_dia', '{top_repuestos,2,codprod}', '"PN-B"');
select pg_temp.eq('Top 3: ingresos', 'v_dia', '{top_repuestos,2,ingresos}', '6.00');
select pg_temp.eq('Top 4: PN-X sin precio al final, ingresos null', 'v_dia', '{top_repuestos,3,codprod}', '"PN-X"');
select pg_temp.eq('Top 4: ingresos null', 'v_dia', '{top_repuestos,3,ingresos}', 'null');

-- Tipo de precio (unidades vendidas por tipo).
select pg_temp.eq('Tipo de precio: online promoción', 'v_dia', '{tipo_precio,online,promocion}', '7');
select pg_temp.eq('Tipo de precio: online estándar', 'v_dia', '{tipo_precio,online,estandar}', '0');
select pg_temp.eq('Tipo de precio: tienda promoción', 'v_dia', '{tipo_precio,tienda,promocion}', '3');
select pg_temp.eq('Tipo de precio: tienda estándar', 'v_dia', '{tipo_precio,tienda,estandar}', '1');

-- Estado: tránsito, error, sin foto, duplicados.
select pg_temp.eq('Estado: tránsito envíos (V7)', 'v_dia', '{estado,transito,envios}', '1');
select pg_temp.eq('Estado: tránsito monto (no entra a ingresos)', 'v_dia', '{estado,transito,monto}', '5.80');
select pg_temp.eq('Estado: error', 'v_dia', '{estado,error,envios}', '1');
select pg_temp.eq('Estado: sin foto (V11)', 'v_dia', '{estado,sin_foto}', '1');
select pg_temp.eq('Estado: duplicados (V9)', 'v_dia', '{estado,duplicados}', '1');

-- Recurrentes (caso 2): el genérico 'CG' se excluye.
select pg_temp.eq('Recurrentes online: compradores (100, 200, 300)', 'v_dia', '{recurrentes,online,compradores}', '3');
select pg_temp.eq('Recurrentes online: regresan (200 con venta previa, 300 ya existía en SAINT)', 'v_dia', '{recurrentes,online,regresan}', '2');
select pg_temp.eq('Recurrentes tienda: compradores (400 y 500; el genérico no)', 'v_dia', '{recurrentes,tienda,compradores}', '2');
select pg_temp.eq('Recurrentes tienda: regresan (500 ya existía)', 'v_dia', '{recurrentes,tienda,regresan}', '1');
select pg_temp.eq('Recurrentes: genéricos excluidos', 'v_dia', '{recurrentes,genericos_excluidos}', '1');

-- ---------------------------------------------------------------------------
-- 3b · El duplicado se decide AL LEER, contra el estado ACTUAL (15/11/2026,
--      corrección del code-review del plan "Paneles"). Junio de 2031, un día por
--      caso. Un envío `creado` es duplicado solo si existe OTRO envío `creado`
--      anterior (o del mismo instante con `borrador_id` menor) del mismo origen
--      o de la misma conversación, con las mismas líneas y a menos de 24 h.
--      Un `error` o un envío en tránsito nunca vuelve duplicado a otro.
--   (a) error -> reenvío idéntico `creado`: cuenta como venta (el bug real:
--       el cliente corrige la cédula y reenvía, y la venta desaparecía).
--   (b) dos `creado` idénticos en 24 h: cuenta uno.
--   (c) tres `creado` idénticos: cuenta uno.
--   (d) anterior en tránsito + posterior `creado`: cuenta el posterior; si el
--       anterior pasa a `creado`, cuenta el anterior: siempre uno.
--   (e) a más de 24 h, los dos cuentan.
--   (f) el anterior cae FUERA del rango consultado: el posterior sigue siendo
--       duplicado (la regla no depende de la ventana de la pantalla).
-- ---------------------------------------------------------------------------
select pg_temp.conv(n) from generate_series(61, 66) n;
select pg_temp.carrito(n, '2020-01-01', '[{"p":"d","q":1}]') from generate_series(61, 66) n;
select pg_temp.pres(61, 'chat', pg_temp.cid(64), '2020-01-01', '[{"p":"d","q":1}]');

-- (a)
select pg_temp.borrador('carrito', pg_temp.cid(61), 'd0a4e100-0000-0000-0000-0000000000a1', '610', 'error',  '2031-06-01 10:00-04', null,  null, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(61), 'd0a4e100-0000-0000-0000-0000000000a1', '610', 'creado', '2031-06-01 10:30-04', 'C610', true, '[{"codprod":"PN-D","cantidad":1}]');
-- (b)
select pg_temp.borrador('carrito', pg_temp.cid(62), 'd0a4e100-0000-0000-0000-0000000000a1', '620', 'creado', '2031-06-02 10:00-04', 'C620', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(62), 'd0a4e100-0000-0000-0000-0000000000a1', '620', 'creado', '2031-06-02 11:00-04', 'C620', true, '[{"codprod":"PN-D","cantidad":1}]');
-- (c)
select pg_temp.borrador('carrito', pg_temp.cid(63), 'd0a4e100-0000-0000-0000-0000000000a1', '630', 'creado', '2031-06-03 10:00-04', 'C630', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(63), 'd0a4e100-0000-0000-0000-0000000000a1', '630', 'creado', '2031-06-03 11:00-04', 'C630', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(63), 'd0a4e100-0000-0000-0000-0000000000a1', '630', 'creado', '2031-06-03 12:00-04', 'C630', true, '[{"codprod":"PN-D","cantidad":1}]');
-- (d) el presupuesto de chat (anterior, en tránsito) y el carrito de la MISMA conversación.
select pg_temp.borrador('presupuesto', pg_temp.prid(61), 'd0a4e100-0000-0000-0000-0000000000a1', '640', 'pendiente', '2031-06-04 09:00-04', null, null, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(64), 'd0a4e100-0000-0000-0000-0000000000a1', '640', 'creado', '2031-06-04 10:00-04', 'C640', true, '[{"codprod":"PN-D","cantidad":1}]');
-- (e) 25 horas entre uno y otro.
select pg_temp.borrador('carrito', pg_temp.cid(65), 'd0a4e100-0000-0000-0000-0000000000a1', '650', 'creado', '2031-06-05 10:00-04', 'C650', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(65), 'd0a4e100-0000-0000-0000-0000000000a1', '650', 'creado', '2031-06-06 11:00-04', 'C650', true, '[{"codprod":"PN-D","cantidad":1}]');
-- (f) el primero a las 23:50 del 8, el reenvío a las 00:20 del 9.
select pg_temp.borrador('carrito', pg_temp.cid(66), 'd0a4e100-0000-0000-0000-0000000000a1', '660', 'creado', '2031-06-08 23:50-04', 'C660', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(66), 'd0a4e100-0000-0000-0000-0000000000a1', '660', 'creado', '2031-06-09 00:20-04', 'C660', true, '[{"codprod":"PN-D","cantidad":1}]');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
insert into _r select 'dup_a', public.panel_ventas('2031-06-01 00:00-04', '2031-06-02 00:00-04');
insert into _r select 'dup_b', public.panel_ventas('2031-06-02 00:00-04', '2031-06-03 00:00-04');
insert into _r select 'dup_c', public.panel_ventas('2031-06-03 00:00-04', '2031-06-04 00:00-04');
insert into _r select 'dup_d1', public.panel_ventas('2031-06-04 00:00-04', '2031-06-05 00:00-04');
insert into _r select 'dup_e', public.panel_ventas('2031-06-05 00:00-04', '2031-06-07 00:00-04');
insert into _r select 'dup_f', public.panel_ventas('2031-06-09 00:00-04', '2031-06-10 00:00-04');
reset role;

-- (d) el anterior (el presupuesto) pasa a `creado`: ahora cuenta el anterior.
update liminal.saint_borradores
   set estado = 'creado', codclie = 'C640', cliente_creado = true, numero_saint = 'F-dup-d', procesado_at = '2031-06-04 09:05-04'
 where origen = 'presupuesto' and origen_id = pg_temp.prid(61);

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
insert into _r select 'dup_d2', public.panel_ventas('2031-06-04 00:00-04', '2031-06-05 00:00-04');
reset role;

select pg_temp.eq('Duplicado (a): error + reenvío creado = una venta', 'dup_a', '{canales,online,envios}', '1');
select pg_temp.eq('Duplicado (a): su ingreso es el del reenvío', 'dup_a', '{canales,online,ingresos}', '5.80');
select pg_temp.eq('Duplicado (a): el error sigue contado como error', 'dup_a', '{estado,error,envios}', '1');
select pg_temp.eq('Duplicado (a): no hay duplicados', 'dup_a', '{estado,duplicados}', '0');
select pg_temp.eq('Duplicado (b): dos creado idénticos = una venta', 'dup_b', '{canales,online,envios}', '1');
select pg_temp.eq('Duplicado (b): ingreso de uno solo', 'dup_b', '{canales,online,ingresos}', '5.80');
select pg_temp.eq('Duplicado (b): un duplicado', 'dup_b', '{estado,duplicados}', '1');
select pg_temp.eq('Duplicado (c): tres creado idénticos = una venta', 'dup_c', '{canales,online,envios}', '1');
select pg_temp.eq('Duplicado (c): dos duplicados', 'dup_c', '{estado,duplicados}', '2');
select pg_temp.eq('Duplicado (d1): anterior en tránsito + posterior creado = una venta', 'dup_d1', '{canales,online,envios}', '1');
select pg_temp.eq('Duplicado (d1): el anterior sigue en tránsito', 'dup_d1', '{estado,transito,envios}', '1');
select pg_temp.eq('Duplicado (d1): sin duplicados mientras uno está en tránsito', 'dup_d1', '{estado,duplicados}', '0');
select pg_temp.eq('Duplicado (d2): al pasar el anterior a creado sigue siendo una venta', 'dup_d2', '{canales,online,envios}', '1');
select pg_temp.eq('Duplicado (d2): ahora el posterior es el duplicado', 'dup_d2', '{estado,duplicados}', '1');
select pg_temp.eq('Duplicado (d2): ya nada en tránsito', 'dup_d2', '{estado,transito,envios}', '0');
select pg_temp.eq('Duplicado (e): a más de 24 h cuentan los dos', 'dup_e', '{canales,online,envios}', '2');
select pg_temp.eq('Duplicado (e): ingreso de los dos', 'dup_e', '{canales,online,ingresos}', '11.60');
select pg_temp.eq('Duplicado (e): sin duplicados', 'dup_e', '{estado,duplicados}', '0');
select pg_temp.eq('Duplicado (f): el anterior fuera del rango igual lo vuelve duplicado', 'dup_f', '{canales,online,envios}', '0');
select pg_temp.eq('Duplicado (f): cuenta como duplicado en su rango', 'dup_f', '{estado,duplicados}', '1');

-- ---------------------------------------------------------------------------
-- 4 · Siembra de panel_conversaciones (abril de 2031).
-- ---------------------------------------------------------------------------
select pg_temp.conv(n) from generate_series(21, 30) n;

insert into public.tags (id, label) values
  ('d0a4e100-6000-0000-0000-000000000001', 'Reclamo – garantía'),
  ('d0a4e100-6000-0000-0000-000000000002', 'Sin reclamo');
insert into public.contact_tags (contact_id, tag_id) values
  (pg_temp.ctid(22), 'd0a4e100-6000-0000-0000-000000000001'),
  (pg_temp.ctid(28), 'd0a4e100-6000-0000-0000-000000000001'),
  (pg_temp.ctid(27), 'd0a4e100-6000-0000-0000-000000000002');

-- K1 (21): compra después de la respuesta de A.
select pg_temp.msg(21, 'c', null, '2031-04-01 10:00-04');
select pg_temp.msg(21, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-01 10:05-04');
select pg_temp.msg(21, 'c', null, '2031-04-01 10:30-04');
-- K2 (22): reclamo atendido por la IA.
select pg_temp.msg(22, 'c', null, '2031-04-01 11:00-04');
select pg_temp.msg(22, 'i', null, '2031-04-01 11:01-04');
-- K3 (23): carrito sin compra, atendida por A2.
select pg_temp.msg(23, 'c', null, '2031-04-02 09:00-04');
select pg_temp.msg(23, 'a', 'd0a4e100-0000-0000-0000-0000000000a2', '2031-04-02 09:10-04');
select pg_temp.carrito(23, '2031-04-02 09:20-04', '[{"p":"d","q":1}]');
-- K4 (24): solo preguntó; la nota interna de A2 no cuenta como respuesta.
select pg_temp.msg(24, 'c', null, '2031-04-02 15:00-04');
select pg_temp.msg(24, 'n', 'd0a4e100-0000-0000-0000-0000000000a2', '2031-04-02 15:10-04');
select pg_temp.msg(24, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-02 15:30-04');
-- K5 (25): solo una nota interna: sin respuesta.
select pg_temp.msg(25, 'c', null, '2031-04-03 08:00-04');
select pg_temp.msg(25, 'n', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-03 08:05-04');
-- K6 (26): la respuesta de A fue ANTES del mensaje del cliente: sin respuesta (pero A atendió en el rango).
select pg_temp.msg(26, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-03 09:00-04');
select pg_temp.msg(26, 'c', null, '2031-04-03 10:00-04');
-- K7 (27): sin respuesta, con la etiqueta "Sin reclamo" (no calza), a las 22:30 de Caracas.
select pg_temp.msg(27, 'c', null, '2031-04-04 22:30-04');
-- K8 (28): atendida por la IA y por A; etiqueta de reclamo, pero compró.
select pg_temp.msg(28, 'c', null, '2031-04-04 12:00-04');
select pg_temp.msg(28, 'i', null, '2031-04-04 12:00:30-04');
select pg_temp.msg(28, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-04 12:10-04');
-- K9 (29): el cliente escribió ANTES del rango; A respondió dentro (cuenta como atendida, no como "escribió").
select pg_temp.msg(29, 'c', null, '2031-03-30 10:00-04');
select pg_temp.msg(29, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-01 08:00-04');
-- K10 (30): compra a los 9 días de la primera respuesta (fuera de la ventana de 7).
select pg_temp.msg(30, 'c', null, '2031-04-01 12:00-04');
select pg_temp.msg(30, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-01 12:30-04');

-- Ventas de chat (carrito vacío: ya vendido); la foto queda sin monto, el panel cuenta la venta.
select pg_temp.borrador('carrito', pg_temp.cid(21), 'd0a4e100-0000-0000-0000-0000000000a1', '1021', 'creado', '2031-04-02 09:00-04', 'K21', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(28), 'd0a4e100-0000-0000-0000-0000000000a1', '1028', 'creado', '2031-04-05 10:00-04', 'K28', true, '[{"codprod":"PN-D","cantidad":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(30), 'd0a4e100-0000-0000-0000-0000000000a1', '1030', 'creado', '2031-04-10 10:00-04', 'K30', true, '[{"codprod":"PN-D","cantidad":1}]');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
insert into _r select 'c_abril', public.panel_conversaciones('2031-04-01 00:00-04', '2031-04-15 00:00-04');
reset role;

-- Embudo.
select pg_temp.eq('Embudo: escribieron (K9 escribió antes del rango)', 'c_abril', '{embudo,escribieron}', '9');
select pg_temp.eq('Embudo: respondidas (sin la nota interna ni la respuesta anterior al mensaje)', 'c_abril', '{embudo,respondidas}', '6');
select pg_temp.eq('Embudo: con carrito (el de K3 más las tres que ya compraron)', 'c_abril', '{embudo,con_carrito}', '4');
select pg_temp.eq('Embudo: compraron (K1, K8, K10)', 'c_abril', '{embudo,compraron}', '3');
-- Resultados excluyentes que suman lo que escribieron.
select pg_temp.eq('Resultados: compraron (gana al reclamo de K8)', 'c_abril', '{resultados,compraron}', '3');
select pg_temp.eq('Resultados: reclamo (K2, etiqueta con tilde y mayúscula)', 'c_abril', '{resultados,reclamo}', '1');
select pg_temp.eq('Resultados: carrito sin compra (K3)', 'c_abril', '{resultados,carrito_sin_compra}', '1');
select pg_temp.eq('Resultados: solo preguntaron (K4)', 'c_abril', '{resultados,solo_preguntaron}', '1');
select pg_temp.eq('Resultados: sin respuesta (K5, K6, K7)', 'c_abril', '{resultados,sin_respuesta}', '3');
do $$
declare
  v jsonb := (select j from _r where clave = 'c_abril');
  v_suma int;
begin
  select sum(value::int) into v_suma from jsonb_each_text(v -> 'resultados');
  if v_suma is distinct from (v #>> '{embudo,escribieron}')::int then
    insert into _errores(msg) values (format('Resultados: debían sumar lo que escribieron (%s) y suman %s.', v #>> '{embudo,escribieron}', v_suma));
  end if;
end $$;

-- Conversión por persona (ventana de 7 días tras su primera respuesta).
select pg_temp.eq('Conversión equipo: atendidas (todas las que alguien respondió en el rango)', 'c_abril', '{conversion,equipo,atendidas}', '8');
select pg_temp.eq('Conversión equipo: compraron (K1, K8; K10 se pasó de 7 días)', 'c_abril', '{conversion,equipo,compraron}', '2');
select pg_temp.largo('Conversión: tres personas (A, la IA y A2)', 'c_abril', '{conversion,personas}', 3);
select pg_temp.eq('Conversión 1: A', 'c_abril', '{conversion,personas,0,agent_id}', to_jsonb('d0a4e100-0000-0000-0000-0000000000a1'::text));
select pg_temp.eq('Conversión 1: atendidas (K1, K4, K6, K8, K9, K10)', 'c_abril', '{conversion,personas,0,atendidas}', '6');
select pg_temp.eq('Conversión 1: compraron (K1, K8)', 'c_abril', '{conversion,personas,0,compraron}', '2');
select pg_temp.eq('Conversión 2: la IA', 'c_abril', '{conversion,personas,1,rol}', '"ia"');
select pg_temp.eq('Conversión 2: la IA no tiene agent_id', 'c_abril', '{conversion,personas,1,agent_id}', 'null');
select pg_temp.eq('Conversión 2: atendidas (K2, K8)', 'c_abril', '{conversion,personas,1,atendidas}', '2');
select pg_temp.eq('Conversión 2: compraron (K8: una venta cuenta para cada persona que respondió)', 'c_abril', '{conversion,personas,1,compraron}', '1');
select pg_temp.eq('Conversión 3: A2', 'c_abril', '{conversion,personas,2,agent_id}', to_jsonb('d0a4e100-0000-0000-0000-0000000000a2'::text));
select pg_temp.eq('Conversión 3: atendidas', 'c_abril', '{conversion,personas,2,atendidas}', '1');
select pg_temp.eq('Conversión 3: compraron', 'c_abril', '{conversion,personas,2,compraron}', '0');

-- Calor 7 x 24 en hora de Caracas (0 = domingo; 2031-04-01 es martes).
select pg_temp.largo('Calor: 7 filas', 'c_abril', '{calor,valores}', 7);
select pg_temp.largo('Calor: 24 horas', 'c_abril', '{calor,valores,0}', 24);
select pg_temp.eq('Calor: martes 10 h (dos mensajes de K1)', 'c_abril', '{calor,valores,2,10}', '2');
select pg_temp.eq('Calor: martes 12 h (K10)', 'c_abril', '{calor,valores,2,12}', '1');
select pg_temp.eq('Calor: viernes 22 h de Caracas (a las 02:30 UTC del sábado)', 'c_abril', '{calor,valores,5,22}', '1');
select pg_temp.eq('Calor: sábado 2 h queda en 0 (no se cuenta en UTC)', 'c_abril', '{calor,valores,6,2}', '0');
select pg_temp.eq('Calor: viernes 12 h (K8)', 'c_abril', '{calor,valores,5,12}', '1');
select pg_temp.eq('Calor: domingo 0 h vacío', 'c_abril', '{calor,valores,0,0}', '0');
do $$
declare
  v jsonb := (select j from _r where clave = 'c_abril');
  v_total int;
begin
  select sum((c)::int) into v_total
    from jsonb_array_elements(v #> '{calor,valores}') f, jsonb_array_elements_text(f) c;
  if v_total is distinct from 10 then
    insert into _errores(msg) values (format('Calor: la matriz debía sumar los 10 mensajes del cliente del rango y suma %s.', v_total));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5 · Siembra de panel_asesores (1 y 2 de mayo de 2031).
-- ---------------------------------------------------------------------------
select pg_temp.conv(n) from generate_series(41, 48) n;
-- Q1: respuesta a 2 min; seguimiento a los 30 min; nota interna que no cuenta.
select pg_temp.msg(41, 'c', null, '2031-05-01 09:00-04');
select pg_temp.msg(41, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-05-01 09:02-04');
select pg_temp.msg(41, 'n', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-05-01 09:05-04');
select pg_temp.msg(41, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-05-01 09:30-04');
-- Q2: 8 min. Q3: 90 min.
select pg_temp.msg(42, 'c', null, '2031-05-01 10:00-04');
select pg_temp.msg(42, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-05-01 10:08-04');
select pg_temp.msg(43, 'c', null, '2031-05-01 11:00-04');
select pg_temp.msg(43, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-05-01 12:30-04');
-- Q4: ráfaga de dos mensajes (un solo episodio) que A2 responde a los 4 min; luego otro episodio sin respuesta.
select pg_temp.msg(44, 'c', null, '2031-05-01 13:00-04');
select pg_temp.msg(44, 'c', null, '2031-05-01 13:01-04');
select pg_temp.msg(44, 'a', 'd0a4e100-0000-0000-0000-0000000000a2', '2031-05-01 13:04-04');
select pg_temp.msg(44, 'c', null, '2031-05-01 13:30-04');
-- Q5: la IA responde a los 30 s.
select pg_temp.msg(45, 'c', null, '2031-05-02 08:00-04');
select pg_temp.msg(45, 'i', null, '2031-05-02 08:00:30-04');
-- Q6: el antecedente (una salida) es de ANTES del rango: el mensaje del cliente sí abre episodio; A responde a los 10 min.
select pg_temp.msg(46, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-04-30 10:00-04');
select pg_temp.msg(46, 'c', null, '2031-05-01 15:00-04');
select pg_temp.msg(46, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-05-01 15:10-04');
-- Q7: el antecedente es otro mensaje del CLIENTE (anterior al rango): continúa una ráfaga, no es episodio.
select pg_temp.msg(47, 'c', null, '2031-04-30 11:00-04');
select pg_temp.msg(47, 'c', null, '2031-05-01 16:00-04');
select pg_temp.msg(47, 'a', 'd0a4e100-0000-0000-0000-0000000000a1', '2031-05-01 16:20-04');

-- Envíos del rango: A arma una venta de tienda y una online; la caja, una de tienda.
select pg_temp.pres(21, 'inventario', null, '2020-01-01', '[{"p":"a","q":1}]');
select pg_temp.pres(22, 'inventario', null, '2020-01-01', '[{"p":"d","q":1}]');
select pg_temp.carrito(48, '2020-01-01', '[{"p":"d","q":2}]');
select pg_temp.borrador('presupuesto', pg_temp.prid(21), 'd0a4e100-0000-0000-0000-0000000000a1', '2001', 'creado', '2031-05-01 14:00-04', 'E1', true, '[{"codprod":"PN-A","cantidad":1}]');  -- A tienda 29,00
select pg_temp.borrador('carrito', pg_temp.cid(48), 'd0a4e100-0000-0000-0000-0000000000a1', '2002', 'creado', '2031-05-02 10:00-04', 'E2', true, '[{"codprod":"PN-D","cantidad":2}]');       -- A online 11,60
select pg_temp.borrador('presupuesto', pg_temp.prid(22), 'd0a4e100-0000-0000-0000-0000000000c1', '2003', 'creado', '2031-05-01 11:00-04', 'E3', true, '[{"codprod":"PN-D","cantidad":1}]');  -- caja tienda 5,80

-- Reasignaciones por demora (dos en el rango y una después).
insert into public.conversation_handoffs (conversation_id, from_kind, from_id, to_kind, to_id, reason, created_by, created_at) values
  (pg_temp.cid(41), 'human', 'd0a4e100-0000-0000-0000-0000000000a1', 'human', 'd0a4e100-0000-0000-0000-0000000000a2', 'reasignada_por_demora', 'system', '2031-05-01 12:00-04'),
  (pg_temp.cid(42), 'human', 'd0a4e100-0000-0000-0000-0000000000a1', 'human', 'd0a4e100-0000-0000-0000-0000000000a2', 'reasignada_por_demora', 'system', '2031-05-02 09:00-04'),
  (pg_temp.cid(43), 'human', 'd0a4e100-0000-0000-0000-0000000000a1', 'human', 'd0a4e100-0000-0000-0000-0000000000a2', 'reasignada_por_demora', 'system', '2031-06-01 09:00-04');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
insert into _r select 'a_mayo', public.panel_asesores('2031-05-01 00:00-04', '2031-05-03 00:00-04');
reset role;

select pg_temp.largo('Asesores: A, A2 y la caja (el supervisor sin actividad no aparece)', 'a_mayo', '{personas}', 3);
select pg_temp.eq('Asesor A: id', 'a_mayo', '{personas,0,agent_id}', to_jsonb('d0a4e100-0000-0000-0000-0000000000a1'::text));
select pg_temp.eq('Asesor A: nombre', 'a_mayo', '{personas,0,nombre}', '"Asesor Uno Paneles"');
select pg_temp.eq('Asesor A: rol', 'a_mayo', '{personas,0,rol}', '"agent"');
select pg_temp.eq('Asesor A: en reparto', 'a_mayo', '{personas,0,en_reparto}', 'true');
select pg_temp.eq('Asesor A: mensajes (6; sin la nota interna ni la salida anterior al rango)', 'a_mayo', '{personas,0,mensajes}', '6');
select pg_temp.eq('Asesor A: conversaciones', 'a_mayo', '{personas,0,conversaciones}', '5');
select pg_temp.eq('Asesor A: contactos', 'a_mayo', '{personas,0,contactos}', '5');
select pg_temp.eq('Asesor A: episodios (Q1, Q2, Q3, Q6; Q7 continúa una ráfaga)', 'a_mayo', '{personas,0,episodios}', '4');
select pg_temp.eq('Asesor A: mediana de la primera respuesta (2, 8, 10 y 90 min)', 'a_mayo', '{personas,0,primera_resp_mediana_min}', '9.0');
select pg_temp.eq('Asesor A: p90 (66 min)', 'a_mayo', '{personas,0,primera_resp_p90_min}', '66.0');
select pg_temp.eq('Asesor A: respondidos en 5 min (1 de 4)', 'a_mayo', '{personas,0,en_5min}', '0.25');
select pg_temp.eq('Asesor A: envíos', 'a_mayo', '{personas,0,envios}', '2');
select pg_temp.eq('Asesor A: monto', 'a_mayo', '{personas,0,monto}', '40.60');
select pg_temp.eq('Asesor A: unidades', 'a_mayo', '{personas,0,unidades}', '3');
select pg_temp.eq('Asesor A: envíos online', 'a_mayo', '{personas,0,envios_online}', '1');
select pg_temp.eq('Asesor A: envíos tienda', 'a_mayo', '{personas,0,envios_tienda}', '1');
select pg_temp.eq('Asesor A: reasignadas desde él (2 en el rango)', 'a_mayo', '{personas,0,reasignadas_desde}', '2');
select pg_temp.eq('Asesor A: último mensaje', 'a_mayo', '{personas,0,ultimo_mensaje}', '"2031-05-01T16:20:00-04:00"');
select pg_temp.largo('Asesor A: actividad por hora (24)', 'a_mayo', '{personas,0,actividad_hora}', 24);
select pg_temp.eq('Asesor A: actividad hora 9 (dos mensajes)', 'a_mayo', '{personas,0,actividad_hora,9}', '2');
select pg_temp.eq('Asesor A: actividad hora 12', 'a_mayo', '{personas,0,actividad_hora,12}', '1');
select pg_temp.eq('Asesor A: actividad hora 16', 'a_mayo', '{personas,0,actividad_hora,16}', '1');
select pg_temp.eq('Asesor A: actividad hora 3 vacía', 'a_mayo', '{personas,0,actividad_hora,3}', '0');
select pg_temp.eq('Asesor A2: id', 'a_mayo', '{personas,1,agent_id}', to_jsonb('d0a4e100-0000-0000-0000-0000000000a2'::text));
select pg_temp.eq('Asesor A2: mensajes', 'a_mayo', '{personas,1,mensajes}', '1');
select pg_temp.eq('Asesor A2: episodios (el segundo quedó sin responder: no es suyo)', 'a_mayo', '{personas,1,episodios}', '1');
select pg_temp.eq('Asesor A2: mediana (4 min)', 'a_mayo', '{personas,1,primera_resp_mediana_min}', '4.0');
select pg_temp.eq('Asesor A2: en 5 min', 'a_mayo', '{personas,1,en_5min}', '1.0');
select pg_temp.eq('Asesor A2: sin envíos, monto null', 'a_mayo', '{personas,1,monto}', 'null');
select pg_temp.eq('Asesor A2: sin envíos', 'a_mayo', '{personas,1,envios}', '0');
select pg_temp.eq('La caja entra por sus envíos: rol', 'a_mayo', '{personas,2,rol}', '"caja"');
select pg_temp.eq('La caja: envíos', 'a_mayo', '{personas,2,envios}', '1');
select pg_temp.eq('La caja: monto', 'a_mayo', '{personas,2,monto}', '5.80');
select pg_temp.eq('La caja: sin mensajes', 'a_mayo', '{personas,2,mensajes}', '0');
select pg_temp.eq('La caja: sin episodios, mediana null', 'a_mayo', '{personas,2,primera_resp_mediana_min}', 'null');
select pg_temp.eq('Seba: mensajes', 'a_mayo', '{seba,mensajes}', '1');
select pg_temp.eq('Seba: conversaciones', 'a_mayo', '{seba,conversaciones}', '1');
select pg_temp.eq('Seba: último', 'a_mayo', '{seba,ultimo}', '"2031-05-02T08:00:30-04:00"');
select pg_temp.eq('Equipo: episodios (7: 4 de A, 2 de Q4, 1 de Q5)', 'a_mayo', '{equipo,episodios}', '7');
select pg_temp.eq('Equipo: mediana de lo respondido (0,5, 2, 4, 8, 10 y 90 min)', 'a_mayo', '{equipo,primera_resp_mediana_min}', '6.0');
select pg_temp.eq('Equipo: en 5 min (3 de 6)', 'a_mayo', '{equipo,en_5min}', '0.5');

-- ---------------------------------------------------------------------------
-- 7 · Permisos y validación de rangos.
-- ---------------------------------------------------------------------------
-- anon no puede ejecutar ninguna de las cinco; authenticated y service_role sí.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.panel_ventas(timestamptz,timestamptz)',
    'public.panel_conversaciones(timestamptz,timestamptz)',
    'public.panel_asesores(timestamptz,timestamptz)',
    'public.panel_cola()',
    'public.panel_ventas_activas()'
  ] loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('public', f, 'EXECUTE') then
      insert into _errores(msg) values (format('Permisos: anon o PUBLIC pueden ejecutar %s.', f));
    end if;
    if not has_function_privilege('authenticated', f, 'EXECUTE') or not has_function_privilege('service_role', f, 'EXECUTE') then
      insert into _errores(msg) values (format('Permisos: authenticated y service_role deben poder ejecutar %s.', f));
    end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
      insert into _errores(msg) values (format('Permisos: %s debía ser security definer.', f));
    end if;
  end loop;
end $$;

-- Un asesor (A) y la caja (C): 42501 en las cinco.
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000a1';
select pg_temp.esperar('Asesor: panel_ventas', pg_temp.probar($q$select public.panel_ventas('2031-03-10 00:00-04', '2031-03-11 00:00-04')$q$), '^error 42501');
select pg_temp.esperar('Asesor: panel_conversaciones', pg_temp.probar($q$select public.panel_conversaciones('2031-04-01 00:00-04', '2031-04-02 00:00-04')$q$), '^error 42501');
select pg_temp.esperar('Asesor: panel_asesores', pg_temp.probar($q$select public.panel_asesores('2031-05-01 00:00-04', '2031-05-02 00:00-04')$q$), '^error 42501');
select pg_temp.esperar('Asesor: panel_cola', pg_temp.probar($q$select public.panel_cola()$q$), '^error 42501');
select pg_temp.esperar('Asesor: panel_ventas_activas', pg_temp.probar($q$select public.panel_ventas_activas()$q$), '^error 42501');
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000c1';
select pg_temp.esperar('Caja: panel_ventas', pg_temp.probar($q$select public.panel_ventas('2031-03-10 00:00-04', '2031-03-11 00:00-04')$q$), '^error 42501');
select pg_temp.esperar('Caja: panel_conversaciones', pg_temp.probar($q$select public.panel_conversaciones('2031-04-01 00:00-04', '2031-04-02 00:00-04')$q$), '^error 42501');
select pg_temp.esperar('Caja: panel_asesores', pg_temp.probar($q$select public.panel_asesores('2031-05-01 00:00-04', '2031-05-02 00:00-04')$q$), '^error 42501');
select pg_temp.esperar('Caja: panel_cola', pg_temp.probar($q$select public.panel_cola()$q$), '^error 42501');
select pg_temp.esperar('Caja: panel_ventas_activas', pg_temp.probar($q$select public.panel_ventas_activas()$q$), '^error 42501');

-- Rangos inválidos como supervisor: 22023.
set local "request.jwt.claim.sub" = 'd0a4e100-0000-0000-0000-0000000000b1';
select pg_temp.esperar('Rango de 93 días en panel_conversaciones', pg_temp.probar($q$select public.panel_conversaciones('2031-01-01 00:00-04', '2031-04-04 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Rango de 93 días en panel_asesores', pg_temp.probar($q$select public.panel_asesores('2031-01-01 00:00-04', '2031-04-04 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Rango de 92 días exactos en panel_conversaciones pasa', pg_temp.probar($q$select public.panel_conversaciones('2031-01-01 00:00-04', '2031-04-03 00:00-04')$q$), '^filas=1');
select pg_temp.esperar('Rango de 92 días exactos en panel_asesores pasa', pg_temp.probar($q$select public.panel_asesores('2031-01-01 00:00-04', '2031-04-03 00:00-04')$q$), '^filas=1');
select pg_temp.esperar('panel_ventas no tiene tope de rango', pg_temp.probar($q$select public.panel_ventas('2029-01-01 00:00-04', '2031-04-04 00:00-04')$q$), '^filas=1');
select pg_temp.esperar('Rango invertido en panel_ventas', pg_temp.probar($q$select public.panel_ventas('2031-03-11 00:00-04', '2031-03-10 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Rango vacío en panel_conversaciones', pg_temp.probar($q$select public.panel_conversaciones('2031-03-10 00:00-04', '2031-03-10 00:00-04')$q$), '^error 22023');
select pg_temp.esperar('Rango invertido en panel_asesores', pg_temp.probar($q$select public.panel_asesores('2031-03-11 00:00-04', '2031-03-10 00:00-04')$q$), '^error 22023');
reset role;

-- ---------------------------------------------------------------------------
-- Veredicto: un solo raise exception con todas las fallas.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int;
begin
  select count(*) into v_n from _errores;
  if v_n > 0 then
    raise exception E'paneles.sql: % verificación(es) fallaron:\n%', v_n, (select string_agg('  - ' || msg, E'\n') from _errores);
  end if;
  raise notice 'paneles.sql: todas las aserciones pasaron.';
end $$;

rollback;
