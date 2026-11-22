-- ===========================================================================
-- panel_ventas_activas: ventana de 48 h y desglose (22/11/2026), migración
-- 20261122010000_ventas_activas_desglose.sql (contrato en docs/paneles-contrato.md).
--
-- Qué fija:
--   1-5. Origen y equipo por ítem: presupuesto de Inventario de la caja ->
--        `presupuesto_inventario` + equipo `tienda` + ventana `no_aplica`; el mismo
--        presupuesto armado por un asesor -> equipo `online` con `canal` `tienda`
--        (los dos ejes son independientes); presupuesto del chat y carrito con su
--        `conversation_id`; carrito con `added_by` null -> `sin_dato`.
--   6.   Ventana de WhatsApp: último mensaje del cliente hace 1 h `abierta`, 21 h
--        `por_cerrar` (quedan 3 h < 4 h), 25 h `cerrada`, sin mensajes `cerrada`
--        con `ventana_hasta` null. La ventana se siembra con mensajes entrantes
--        reales (el trigger mueve `last_customer_message_at`).
--   7.   48 h: 47 h entra (tramo `48h`), 49 h no entra y suma a `fuera_de_ventana`
--        (carritos y presupuestos, con su `por_origen`).
--   8.   Anti doble conteo: un presupuesto de 49 h con borrador `creado` no suma
--        a `fuera_de_ventana`; un carrito de 60 h con un presupuesto `chat` de
--        60 h sin enviar en su conversación tampoco (sí el presupuesto); un
--        carrito de 55 h con un envío posterior tampoco.
--   9.   Un ítem cuyo único renglón no tiene precio deja null su celda (monto de
--        `por_origen_equipo`, `por_equipo`) y suma a `sin_precio`.
--   10.  Sumas: los montos de `por_origen`, `por_equipo`, `por_ventana`, la matriz
--        `por_origen_equipo`, `por_canal_ventana` y `tramos_48h` dan `total`; las
--        cantidades dan presupuestos + carritos; `antiguedad` sigue con
--        `24h,3d,7d,30d` (7d y 30d en 0); `items` tiene un elemento por ítem.
--   11.  Un asesor y la caja reciben 42501.
--
-- Como la función lee el estado ACTUAL de toda la base, el test vacía
-- `conversation_cart_items` y `presupuestos` (como postgres, dentro de la
-- transacción que termina en rollback) para que las cuentas sean exactas y no
-- dependan de lo que hubiera en la base local. `now()` es constante dentro de
-- la transacción, así que las fronteras (21 h + 24 h, 47 h, 49 h) no tienen
-- jitter.
--
-- Corre como `authenticated` con la `sub` de usuarios reales. Aplicar la
-- migración antes y correr con
-- `docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f - < ...`
-- Termina en rollback: no deja datos.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

create temporary table _r (clave text primary key, j jsonb);
grant select, insert on _r to authenticated, service_role;

-- S: supervisor; A: asesor; C: caja.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('d0a4e200-0000-0000-0000-0000000000b1', 'super-va@sbk.test',  jsonb_build_object('display_name', 'Super VA'), '{"role":"supervisor"}'::jsonb),
  ('d0a4e200-0000-0000-0000-0000000000a1', 'asesor-va@sbk.test', jsonb_build_object('display_name', 'Asesor VA'), '{}'::jsonb),
  ('d0a4e200-0000-0000-0000-0000000000c1', 'caja-va@sbk.test',   jsonb_build_object('display_name', 'Caja VA'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('d0a4e200-1000-0000-0000-000000000000', 'Canal de prueba ventas activas', '+580000009800');

insert into public.exchange_rates (rate_date, usd_to_ves) values ('2999-12-31', 40);

-- Productos (precio CRUDO; el recargo y el techo los pone precio_venta_usd).
--   a  Bs 1000   -> 29,00 promoción
--   b  Bs 100,50 -> 3,00
--   d  USD 5     -> 5,80
--   f  precio 0  -> sin precio (null)
insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active, weight_kg) values
  ('d0a4e200-4000-0000-0000-00000000000a', 'Prod VA A', 1000.00, 'VES', 5, 'VA-A', true, 2.5),
  ('d0a4e200-4000-0000-0000-00000000000b', 'Prod VA B',  100.50, 'VES', 5, 'VA-B', true, null),
  ('d0a4e200-4000-0000-0000-00000000000d', 'Prod VA D',    5.00, 'USD', 5, 'VA-D', true, null),
  ('d0a4e200-4000-0000-0000-00000000000f', 'Prod VA X',    0.00, 'USD', 5, 'VA-X', true, null);

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

-- Compara un valor de la RPC guardada en _r con lo esperado (jsonb: 29.00 = 29).
create or replace function pg_temp.eq(etiqueta text, ruta text, esperado jsonb) returns void
language plpgsql as $$
declare
  v_j jsonb;
  v_obt jsonb;
begin
  select j into v_j from _r where _r.clave = 'act';
  v_obt := coalesce(v_j #> ruta::text[], '"<ausente>"'::jsonb);
  if v_obt is distinct from esperado then
    insert into _errores(msg) values (format('%s: en %s se esperaba %s y salió %s.', etiqueta, ruta, esperado, v_obt));
  end if;
end $$;

-- Un ítem de `items` por id: sus campos tienen que contener lo esperado.
create or replace function pg_temp.item(etiqueta text, p_id uuid, esperado jsonb) returns void
language plpgsql as $$
declare
  v_it jsonb;
begin
  select e into v_it
    from _r, jsonb_array_elements(_r.j -> 'items') e
   where _r.clave = 'act' and e ->> 'id' = p_id::text;
  if v_it is null then
    insert into _errores(msg) values (format('%s: el ítem %s no está en items.', etiqueta, p_id));
  elsif not (v_it @> esperado) then
    insert into _errores(msg) values (format('%s: se esperaba %s y salió %s.', etiqueta, esperado, v_it));
  end if;
end $$;

create or replace function pg_temp.sin_item(etiqueta text, p_id uuid) returns void
language plpgsql as $$
begin
  if exists (select 1 from _r, jsonb_array_elements(_r.j -> 'items') e
              where _r.clave = 'act' and e ->> 'id' = p_id::text) then
    insert into _errores(msg) values (format('%s: el ítem %s NO debía estar en items.', etiqueta, p_id));
  end if;
end $$;

-- Ids por número: contacto, conversación y presupuesto n.
create or replace function pg_temp.cid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e200-3000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.ctid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e200-2000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.prid(n int) returns uuid language sql immutable as
  $$ select ('d0a4e200-5000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.pid(l text) returns uuid language sql immutable as
  $$ select ('d0a4e200-4000-0000-0000-00000000000' || l)::uuid $$;

create or replace function pg_temp.conv(n int) returns uuid
language plpgsql as $$
begin
  insert into public.contacts (id, phone_number, display_name)
  values (pg_temp.ctid(n), '+58000001' || lpad(n::text, 4, '0'), 'Cliente VA ' || n);
  insert into public.conversations (id, contact_id, whatsapp_channel_id)
  values (pg_temp.cid(n), pg_temp.ctid(n), 'd0a4e200-1000-0000-0000-000000000000');
  return pg_temp.cid(n);
end $$;

-- Un mensaje ENTRANTE del cliente: el trigger mueve last_customer_message_at.
create or replace function pg_temp.msg_cliente(n int, cuando timestamptz) returns void
language plpgsql as $$
begin
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (pg_temp.cid(n), 'inbound', 'customer', 'text', 'mensaje de prueba', cuando);
end $$;

-- Un presupuesto con ítems; p_por = quién lo armó (null = sin agente).
-- `updated_at` es la fecha que cuenta (guardar_presupuesto la pone en now()).
create or replace function pg_temp.pres(n int, p_origen text, p_conv uuid, p_por uuid, p_fecha timestamptz, p_items jsonb) returns uuid
language plpgsql as $$
begin
  insert into public.presupuestos (id, cliente_nombre, cliente_apellido, conversation_id, origen, created_by, created_at, updated_at)
  values (pg_temp.prid(n), 'Cli', 'VA ' || n, p_conv, p_origen, p_por, p_fecha, p_fecha);
  insert into public.presupuesto_items (presupuesto_id, product_id, quantity, price_kind)
  select pg_temp.prid(n), pg_temp.pid(i ->> 'p'), (i ->> 'q')::int, coalesce(i ->> 'k', 'promocion')
    from jsonb_array_elements(p_items) i;
  return pg_temp.prid(n);
end $$;

-- Un carrito de la conversación n; p_por = quién lo agregó (null = sin agente).
create or replace function pg_temp.carrito(n int, p_por uuid, p_actualizado timestamptz, p_items jsonb) returns void
language plpgsql as $$
begin
  insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, added_by, created_at, updated_at, price_kind)
  select pg_temp.cid(n), pg_temp.pid(i ->> 'p'), (i ->> 'q')::int, 'inventory',
         p_por, p_actualizado, p_actualizado, coalesce(i ->> 'k', 'promocion')
    from jsonb_array_elements(p_items) i;
end $$;

-- Un borrador de SAINT ya en su estado final.
create or replace function pg_temp.borrador(p_origen text, p_origen_id uuid, p_estado text, p_creado timestamptz, p_codprod text) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into liminal.saint_borradores (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, estado, created_at)
  values (p_origen, p_origen_id, 'd0a4e200-0000-0000-0000-0000000000a1', 'V', '1', 'Nom', 'Ape', '+584140000000',
          jsonb_build_array(jsonb_build_object('codprod', p_codprod, 'cantidad', 1)), 'pendiente', p_creado)
  returning id into v_id;
  if p_estado <> 'pendiente' then
    update liminal.saint_borradores
       set estado = p_estado, codclie = 'XVA', cliente_creado = true,
           numero_saint = case when p_estado = 'creado' then 'F-' || left(v_id::text, 8) end,
           procesado_at = p_creado + interval '1 minute'
     where id = v_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0 · Base limpia: la función lee toda la base, así que se vacía lo que cuenta.
-- ---------------------------------------------------------------------------
delete from public.presupuestos;
delete from public.conversation_cart_items;

-- ---------------------------------------------------------------------------
-- 1 · Siembra (relativa a now(), que es constante dentro de la transacción).
-- ---------------------------------------------------------------------------
select pg_temp.conv(n) from generate_series(1, 10) n;

-- Ventana de WhatsApp de cada conversación (caso 6).
select pg_temp.msg_cliente(1, now() - interval '1 hour');   -- abierta (P3)
select pg_temp.msg_cliente(3, now() - interval '1 hour');   -- abierta
select pg_temp.msg_cliente(4, now() - interval '21 hours'); -- por cerrar (quedan 3 h)
select pg_temp.msg_cliente(5, now() - interval '25 hours'); -- cerrada
-- conv 6: sin mensajes del cliente -> cerrada, sin ventana_hasta.
select pg_temp.msg_cliente(7, now() - interval '2 hours');  -- abierta

-- Presupuestos.
-- P1  inventario de la CAJA hace 5 h: D = 5,80 (tienda / equipo tienda / no_aplica / 12h)
select pg_temp.pres(1, 'inventario', null, 'd0a4e200-0000-0000-0000-0000000000c1', now() - interval '5 hours', '[{"p":"d","q":1}]');
-- P2  inventario del ASESOR hace 20 h: D x2 = 11,60 (canal tienda / equipo online / 24h)
select pg_temp.pres(2, 'inventario', null, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '20 hours', '[{"p":"d","q":2}]');
-- P3  del chat (conv 1) hace 30 h: A = 29,00 (online / online / abierta / 48h)
select pg_temp.pres(3, 'chat', pg_temp.cid(1), 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '30 hours', '[{"p":"a","q":1}]');
-- P4  inventario del asesor hace 47 h: B = 3,00 (entra, tramo 48h)
select pg_temp.pres(4, 'inventario', null, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '47 hours', '[{"p":"b","q":1}]');
-- P5  inventario hace 49 h: FUERA (presupuestos + origen presupuesto_inventario)
select pg_temp.pres(5, 'inventario', null, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '49 hours', '[{"p":"d","q":1}]');
-- P6  inventario hace 49 h CON borrador creado: ya se vendió, no suma a nada
select pg_temp.pres(6, 'inventario', null, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '49 hours', '[{"p":"d","q":1}]');
select pg_temp.borrador('presupuesto', pg_temp.prid(6), 'creado', now() - interval '30 hours', 'VA-D');
-- P7  del chat (conv 2) hace 60 h sin enviar: FUERA (presupuesto_chat); representa a la conv 2
select pg_temp.pres(7, 'chat', pg_temp.cid(2), 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '60 hours', '[{"p":"d","q":1}]');

-- Carritos (todos agregados por el asesor salvo C6).
-- C1  conv 1 hace 2 h: la conv 1 ya tiene P3 activo -> el carrito NO cuenta
select pg_temp.carrito(1, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '2 hours', '[{"p":"d","q":1}]');
-- C2  conv 2 hace 60 h: la conv 2 la representa P7 -> NO suma a fuera_de_ventana.carritos
select pg_temp.carrito(2, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '60 hours', '[{"p":"d","q":1}]');
-- C3  conv 3 hace 3 h: A = 29,00 (ventana abierta, tramo 12h)
select pg_temp.carrito(3, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '3 hours', '[{"p":"a","q":1}]');
-- C4  conv 4 hace 13 h: D = 5,80 (por cerrar, tramo 24h)
select pg_temp.carrito(4, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '13 hours', '[{"p":"d","q":1}]');
-- C5  conv 5 hace 26 h: B = 3,00 (cerrada, tramo 48h)
select pg_temp.carrito(5, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '26 hours', '[{"p":"b","q":1}]');
-- C6  conv 6 hace 1 h, added_by null, SOLO un renglón sin precio: sin_dato, monto null
select pg_temp.carrito(6, null, now() - interval '1 hour', '[{"p":"f","q":1}]');
-- C7  conv 7 hace 47 h: D = 5,80 (entra, tramo 48h)
select pg_temp.carrito(7, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '47 hours', '[{"p":"d","q":1}]');
-- C8  conv 8 hace 49 h: FUERA (carritos + carrito_chat)
select pg_temp.carrito(8, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '49 hours', '[{"p":"d","q":1}]');
-- C10 conv 10 hace 55 h con un envío `creado` posterior al cambio: no suma a nada
select pg_temp.carrito(10, 'd0a4e200-0000-0000-0000-0000000000a1', now() - interval '55 hours', '[{"p":"d","q":1}]');
select pg_temp.borrador('carrito', pg_temp.cid(10), 'creado', now() - interval '54 hours', 'VA-D');

-- ---------------------------------------------------------------------------
-- 2 · La RPC como supervisor, y los permisos (caso 11).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e200-0000-0000-0000-0000000000b1';
insert into _r select 'act', public.panel_ventas_activas();
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e200-0000-0000-0000-0000000000a1';
select pg_temp.esperar('Asesor: panel_ventas_activas', pg_temp.probar($q$select public.panel_ventas_activas()$q$), '^error 42501');
set local "request.jwt.claim.sub" = 'd0a4e200-0000-0000-0000-0000000000c1';
select pg_temp.esperar('Caja: panel_ventas_activas', pg_temp.probar($q$select public.panel_ventas_activas()$q$), '^error 42501');
reset role;

-- ---------------------------------------------------------------------------
-- 3 · Casos 1-5: origen, equipo y conversación por ítem.
-- ---------------------------------------------------------------------------
select pg_temp.item('Caso 1: presupuesto de Inventario de la caja', pg_temp.prid(1),
  '{"tipo":"presupuesto","origen":"presupuesto_inventario","equipo":"tienda","canal":"tienda","ventana":"no_aplica","ventana_hasta":null,"conversation_id":null,"monto":5.80,"unidades":1}'::jsonb);
select pg_temp.item('Caso 2: presupuesto de Inventario del asesor (equipo online, canal tienda)', pg_temp.prid(2),
  '{"tipo":"presupuesto","origen":"presupuesto_inventario","equipo":"online","canal":"tienda","ventana":"no_aplica","monto":11.60,"unidades":2,"responsable":"Asesor VA"}'::jsonb);
select pg_temp.item('Caso 3: presupuesto del chat', pg_temp.prid(3),
  ('{"tipo":"presupuesto","origen":"presupuesto_chat","equipo":"online","canal":"online","monto":29.00,"conversation_id":"' || pg_temp.cid(1) || '"}')::jsonb);
select pg_temp.item('Caso 4: carrito del chat', pg_temp.cid(3),
  ('{"tipo":"carrito","origen":"carrito_chat","equipo":"online","canal":"online","monto":29.00,"conversation_id":"' || pg_temp.cid(3) || '","responsable":"Asesor VA","cliente":"Cliente VA 3"}')::jsonb);
select pg_temp.item('Caso 5: carrito con added_by null', pg_temp.cid(6),
  ('{"tipo":"carrito","origen":"carrito_chat","equipo":"sin_dato","canal":"online","responsable":null,"conversation_id":"' || pg_temp.cid(6) || '"}')::jsonb);

-- ---------------------------------------------------------------------------
-- 4 · Caso 6: la ventana de WhatsApp.
-- ---------------------------------------------------------------------------
select pg_temp.item('Caso 6: 1 h -> abierta', pg_temp.cid(3), '{"ventana":"abierta"}'::jsonb);
select pg_temp.item('Caso 6: 21 h -> por_cerrar', pg_temp.cid(4), '{"ventana":"por_cerrar"}'::jsonb);
select pg_temp.item('Caso 6: 25 h -> cerrada', pg_temp.cid(5), '{"ventana":"cerrada"}'::jsonb);
select pg_temp.item('Caso 6: sin mensajes del cliente -> cerrada, sin ventana_hasta', pg_temp.cid(6), '{"ventana":"cerrada","ventana_hasta":null}'::jsonb);
select pg_temp.item('Caso 6: conv 7 (2 h) abierta', pg_temp.cid(7), '{"ventana":"abierta"}'::jsonb);
do $$
declare
  v_hasta timestamptz;
  v_n int;
begin
  -- ventana_hasta = último mensaje + 24 h: 1 h atrás -> dentro de 23 h; 21 h atrás -> dentro de 3 h.
  select (e ->> 'ventana_hasta')::timestamptz into v_hasta
    from _r, jsonb_array_elements(_r.j -> 'items') e
   where _r.clave = 'act' and e ->> 'id' = pg_temp.cid(3)::text;
  if v_hasta is distinct from now() + interval '23 hours' then
    insert into _errores(msg) values (format('Caso 6: ventana_hasta de la conv 3 debía ser now()+23h y salió %s (now %s).', v_hasta, now()));
  end if;
  select (e ->> 'ventana_hasta')::timestamptz into v_hasta
    from _r, jsonb_array_elements(_r.j -> 'items') e
   where _r.clave = 'act' and e ->> 'id' = pg_temp.cid(4)::text;
  if v_hasta is distinct from now() + interval '3 hours' then
    insert into _errores(msg) values (format('Caso 6: ventana_hasta de la conv 4 debía ser now()+3h y salió %s.', v_hasta));
  end if;
  -- El trigger de verdad movió la columna (no se escribió a mano).
  select count(*) into v_n from public.conversations
   where id in (pg_temp.cid(3), pg_temp.cid(4), pg_temp.cid(5), pg_temp.cid(7))
     and last_customer_message_at is not null;
  if v_n <> 4 then
    insert into _errores(msg) values (format('Caso 6: el trigger debía haber movido last_customer_message_at en 4 conversaciones y movió %s.', v_n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5 · Casos 7 y 8: la ventana de 48 h y lo que quedó fuera.
-- ---------------------------------------------------------------------------
select pg_temp.item('Caso 7: carrito de 47 h entra en el tramo 48h', pg_temp.cid(7), '{"monto":5.80}'::jsonb);
select pg_temp.item('Caso 7: presupuesto de Inventario de 47 h entra', pg_temp.prid(4), '{"monto":3.00}'::jsonb);
select pg_temp.sin_item('Caso 7: carrito de 49 h', pg_temp.cid(8));
select pg_temp.sin_item('Caso 7: presupuesto de 49 h', pg_temp.prid(5));
select pg_temp.sin_item('Caso 8: presupuesto de 49 h con borrador creado', pg_temp.prid(6));
select pg_temp.sin_item('Caso 8: presupuesto chat de 60 h', pg_temp.prid(7));
select pg_temp.sin_item('Caso 8: carrito de 60 h', pg_temp.cid(2));
select pg_temp.sin_item('Caso 8: carrito de 55 h con envío posterior', pg_temp.cid(10));
select pg_temp.sin_item('Presupuesto activo en la misma conversación: el carrito no cuenta', pg_temp.cid(1));
-- Fuera de la ventana: C8 (carrito), P5 (inventario) y P7 (chat). NO: P6 (borrador),
-- C2 (lo representa P7), C10 (envío posterior).
select pg_temp.eq('Caso 7 y 8: fuera_de_ventana', '{fuera_de_ventana}',
  '{"carritos":1,"presupuestos":2,"por_origen":{"carrito_chat":1,"presupuesto_chat":1,"presupuesto_inventario":1}}'::jsonb);

-- ---------------------------------------------------------------------------
-- 6 · Caso 9: sin precio, y las celdas del desglose.
-- ---------------------------------------------------------------------------
select pg_temp.item('Caso 9: ítem sin precio', pg_temp.cid(6), '{"monto":null,"unidades":1}'::jsonb);
select pg_temp.eq('Caso 9: celda sin_dato de por_origen_equipo.carrito_chat', '{por_origen_equipo,carrito_chat,sin_dato}', '{"monto":null,"cantidad":1}'::jsonb);
select pg_temp.eq('Caso 9: por_equipo.sin_dato', '{por_equipo,sin_dato}', '{"monto":null,"cantidad":1}'::jsonb);
select pg_temp.eq('Caso 9: por_origen.carrito_chat cuenta el renglón sin precio', '{por_origen,carrito_chat}', '{"monto":43.60,"cantidad":5,"sin_precio":1}'::jsonb);

-- Valores exactos de todo el desglose (a mano, ver la siembra).
select pg_temp.eq('total', '{total}', '93.00'::jsonb);
select pg_temp.eq('presupuestos', '{presupuestos}', '{"monto":49.40,"cantidad":4,"sin_precio":0}'::jsonb);
select pg_temp.eq('carritos', '{carritos}', '{"monto":43.60,"cantidad":5,"sin_precio":1}'::jsonb);
select pg_temp.eq('por_canal', '{por_canal}',
  '{"online":{"monto":72.60,"cantidad":6},"tienda":{"monto":20.40,"cantidad":3}}'::jsonb);
select pg_temp.eq('por_origen', '{por_origen}',
  '{"carrito_chat":{"monto":43.60,"cantidad":5,"sin_precio":1},
    "presupuesto_chat":{"monto":29.00,"cantidad":1,"sin_precio":0},
    "presupuesto_inventario":{"monto":20.40,"cantidad":3,"sin_precio":0}}'::jsonb);
select pg_temp.eq('por_equipo', '{por_equipo}',
  '{"online":{"monto":87.20,"cantidad":7},"tienda":{"monto":5.80,"cantidad":1},"sin_dato":{"monto":null,"cantidad":1}}'::jsonb);
select pg_temp.eq('por_origen_equipo', '{por_origen_equipo}',
  '{"carrito_chat":{"online":{"monto":43.60,"cantidad":4},"tienda":{"monto":null,"cantidad":0},"sin_dato":{"monto":null,"cantidad":1}},
    "presupuesto_chat":{"online":{"monto":29.00,"cantidad":1},"tienda":{"monto":null,"cantidad":0},"sin_dato":{"monto":null,"cantidad":0}},
    "presupuesto_inventario":{"online":{"monto":14.60,"cantidad":2},"tienda":{"monto":5.80,"cantidad":1},"sin_dato":{"monto":null,"cantidad":0}}}'::jsonb);
select pg_temp.eq('por_ventana', '{por_ventana}',
  '{"abierta":{"monto":63.80,"cantidad":3},"por_cerrar":{"monto":5.80,"cantidad":1},
    "cerrada":{"monto":3.00,"cantidad":2},"no_aplica":{"monto":20.40,"cantidad":3}}'::jsonb);
select pg_temp.eq('por_canal_ventana', '{por_canal_ventana}',
  '{"online":{"abierta":{"monto":63.80,"cantidad":3},"por_cerrar":{"monto":5.80,"cantidad":1},"cerrada":{"monto":3.00,"cantidad":2},"no_aplica":{"monto":null,"cantidad":0}},
    "tienda":{"abierta":{"monto":null,"cantidad":0},"por_cerrar":{"monto":null,"cantidad":0},"cerrada":{"monto":null,"cantidad":0},"no_aplica":{"monto":20.40,"cantidad":3}}}'::jsonb);
select pg_temp.eq('tramos_48h', '{tramos_48h}',
  '[{"tramo":"12h","monto":34.80,"cantidad":3},{"tramo":"24h","monto":17.40,"cantidad":2},{"tramo":"48h","monto":40.80,"cantidad":4}]'::jsonb);
-- `antiguedad` conserva sus cuatro tramos (parse.ts desplegado los valida); con 48 h solo se llenan 24h y 3d.
select pg_temp.eq('antiguedad', '{antiguedad}',
  '[{"tramo":"24h","monto":52.20,"cantidad":5},{"tramo":"3d","monto":40.80,"cantidad":4},
    {"tramo":"7d","monto":null,"cantidad":0},{"tramo":"30d","monto":null,"cantidad":0}]'::jsonb);

-- ---------------------------------------------------------------------------
-- 7 · Caso 10: las sumas cuadran entre sí (no solo contra lo escrito a mano).
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb := (select j from _r where clave = 'act');
  v_total numeric := coalesce((v ->> 'total')::numeric, 0);
  v_cant int := (v #>> '{presupuestos,cantidad}')::int + (v #>> '{carritos,cantidad}')::int;
  s numeric;
  c int;
  k text;
  k2 text;
begin
  -- Cada agrupación de un nivel: sus montos dan `total` y sus cantidades dan presupuestos + carritos.
  foreach k in array array['por_origen', 'por_equipo', 'por_ventana', 'por_canal'] loop
    select coalesce(sum((e.value ->> 'monto')::numeric), 0), coalesce(sum((e.value ->> 'cantidad')::int), 0)
      into s, c from jsonb_each(v -> k) e;
    if s <> v_total or c <> v_cant then
      insert into _errores(msg) values (format('Sumas: %s da monto %s y cantidad %s; total %s, cantidad %s.', k, s, c, v_total, v_cant));
    end if;
  end loop;
  -- tramos_48h y antiguedad (arreglos).
  foreach k in array array['tramos_48h', 'antiguedad'] loop
    select coalesce(sum((e ->> 'monto')::numeric), 0), coalesce(sum((e ->> 'cantidad')::int), 0)
      into s, c from jsonb_array_elements(v -> k) e;
    if s <> v_total or c <> v_cant then
      insert into _errores(msg) values (format('Sumas: %s da monto %s y cantidad %s; total %s, cantidad %s.', k, s, c, v_total, v_cant));
    end if;
  end loop;
  -- La matriz origen x equipo: cada fila suma su `por_origen`.
  foreach k in array array['carrito_chat', 'presupuesto_chat', 'presupuesto_inventario'] loop
    select coalesce(sum((e.value ->> 'monto')::numeric), 0), coalesce(sum((e.value ->> 'cantidad')::int), 0)
      into s, c from jsonb_each(v #> array['por_origen_equipo', k]) e;
    if s <> coalesce((v #>> array['por_origen', k, 'monto'])::numeric, 0)
       or c <> (v #>> array['por_origen', k, 'cantidad'])::int then
      insert into _errores(msg) values (format('Sumas: la fila %s de por_origen_equipo da monto %s y cantidad %s, y por_origen dice %s.', k, s, c, v #> array['por_origen', k]));
    end if;
  end loop;
  -- por_canal_ventana.<canal> suma por_canal.<canal>.
  foreach k in array array['online', 'tienda'] loop
    select coalesce(sum((e.value ->> 'monto')::numeric), 0), coalesce(sum((e.value ->> 'cantidad')::int), 0)
      into s, c from jsonb_each(v #> array['por_canal_ventana', k]) e;
    if s <> coalesce((v #>> array['por_canal', k, 'monto'])::numeric, 0)
       or c <> (v #>> array['por_canal', k, 'cantidad'])::int then
      insert into _errores(msg) values (format('Sumas: por_canal_ventana.%s da monto %s y cantidad %s, y por_canal dice %s.', k, s, c, v #> array['por_canal', k]));
    end if;
  end loop;
  -- Todas las celdas vacías están presentes (4 ventanas por canal, 3 equipos por origen).
  foreach k in array array['online', 'tienda'] loop
    if (select count(*) from jsonb_object_keys(v #> array['por_canal_ventana', k])) <> 4 then
      insert into _errores(msg) values (format('Claves: por_canal_ventana.%s debía traer las 4 ventanas.', k));
    end if;
  end loop;
  foreach k2 in array array['carrito_chat', 'presupuesto_chat', 'presupuesto_inventario'] loop
    if (select count(*) from jsonb_object_keys(v #> array['por_origen_equipo', k2])) <> 3 then
      insert into _errores(msg) values (format('Claves: por_origen_equipo.%s debía traer los 3 equipos.', k2));
    end if;
  end loop;
  -- items trae un elemento por ítem (hay menos de 300).
  if jsonb_array_length(v -> 'items') <> v_cant then
    insert into _errores(msg) values (format('items debía traer %s elementos y trae %s.', v_cant, jsonb_array_length(v -> 'items')));
  end if;
  -- antiguedad sigue con sus cuatro tramos, en orden.
  if (select string_agg(t ->> 'tramo', ',' order by ord) from jsonb_array_elements(v -> 'antiguedad') with ordinality x(t, ord))
     is distinct from '24h,3d,7d,30d' then
    insert into _errores(msg) values ('antiguedad debía traer 24h,3d,7d,30d en ese orden.');
  end if;
  if (select string_agg(t ->> 'tramo', ',' order by ord) from jsonb_array_elements(v -> 'tramos_48h') with ordinality x(t, ord))
     is distinct from '12h,24h,48h' then
    insert into _errores(msg) values ('tramos_48h debía traer 12h,24h,48h en ese orden.');
  end if;
  -- Orden de items: el más viejo primero.
  if (v #>> '{items,0,id}') is distinct from pg_temp.cid(7)::text then
    insert into _errores(msg) values (format('El primer ítem debía ser C7 (47 h; empata con P4 y gana por id, 3000 < 5000) y salió %s.', v #>> '{items,0,id}'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Veredicto: un solo raise exception con todas las fallas.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int;
begin
  select count(*) into v_n from _errores;
  if v_n > 0 then
    raise exception E'paneles_ventas_activas.sql: % verificación(es) fallaron:\n%', v_n, (select string_agg('  - ' || msg, E'\n') from _errores);
  end if;
  raise notice 'paneles_ventas_activas.sql: todas las aserciones pasaron.';
end $$;

rollback;
