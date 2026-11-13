-- ============================================================================
-- Prueba LOCAL del script de relleno `2026-11-ventas-saint-backfill.sql`
-- (13/11/2026, plan "Paneles", B1). No va a producción: es la red de seguridad
-- del script, que el Claude del VPS corre una sola vez y a ciegas.
--
-- Qué fija, con cinco borradores de fixture (más tres de apoyo) en una
-- transacción que termina en ROLLBACK:
--   1. Carrito -> online / registro; estimado = true; tasa = la del DÍA del
--      envío (no la más reciente); `armado_por` = quien tocó el carrito.
--   2. Presupuesto vivo de Inventario -> tienda / registro, con su estándar
--      (precio + tarifa MRW).
--   3. Presupuesto BORRADO con el codclie genérico del mostrador (>= 20
--      envíos `creado` en 30 días) -> tienda / inferido.
--   4. Presupuesto borrado normal -> online / inferido; y el borrado que armó
--      una cuenta de `<<CUENTAS_MOSTRADOR>>` -> tienda / inferido.
--   5. Envío anterior a `<<INSTANTE_RECARGO>>`: el precio SIN el 16 % (USD
--      tal cual; bolívares sin recargo y con techo a $0,10), y el estándar
--      sigue sumando la tarifa MRW.
--   6. Un código que ya no existe en `products` -> monto null y una línea sin
--      precio (nunca un total parcial).
--   7. Reenvío idéntico (misma conversación, mismas líneas, 1 h después) ->
--      `posible_duplicado` solo el segundo; y con dos envíos del MISMO instante
--      exacto, el id desempata (solo uno se marca).
--   8. Modo de prueba (`dry_run = true`) NO deja ninguna fila; el real sí.
--   9. Idempotencia: correr el script dos veces no cambia nada.
--
-- Los fixtures usan fechas del año 2001 a propósito: no chocan con ninguna
-- tasa ni envío reales de la base local, y la tasa "del día del envío" se
-- puede probar (40 el 1/3/2001, 50 desde el 12/3/2001).
--
-- COMO SE CORRE (el script de relleno se incluye con `\i`, así que el repo
-- tiene que estar DENTRO del contenedor; ver CLAUDE.md, trampa de `\i`):
--   docker exec supabase_db_Liminal_CRM mkdir -p /tmp/repo
--   tar -cf - supabase scripts | docker exec -i supabase_db_Liminal_CRM sh -c "cd /tmp/repo && tar -xf -"
--   MSYS_NO_PATHCONV=1 docker exec -w /tmp/repo supabase_db_Liminal_CRM \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-ventas-saint-backfill.test.sql
-- (sin `-1`: este archivo abre y cierra su propia transacción). Termina en
-- rollback: no deja datos.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

create temporary table _errores (msg text) on commit drop;

-- Los envíos de fixture NO deben pasar por el trigger de M1: son justo los
-- "anteriores al trigger" que el script rellena. (Se reactiva solo con el
-- rollback.)
alter table liminal.saint_borradores disable trigger ventas_saint_foto_after_insert;

-- A: cuenta de mostrador; B: asesor normal.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('c0f070c0-0000-0000-0000-0000000000a1', 'mostrador-backfill@sbk.test', jsonb_build_object('display_name', 'Mostrador backfill'), '{}'::jsonb),
  ('c0f070c0-0000-0000-0000-0000000000b1', 'asesor-backfill@sbk.test',    jsonb_build_object('display_name', 'Asesor backfill'), '{}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('c0f070c0-1000-0000-0000-000000000000', 'Canal de prueba backfill', '+580000009600');
insert into public.contacts (id, phone_number, display_name)
select ('c0f070c0-2000-0000-0000-00000000000' || n)::uuid, '+58000000960' || n, 'Contacto backfill ' || n
  from generate_series(1, 2) n;
insert into public.conversations (id, contact_id, whatsapp_channel_id)
select ('c0f070c0-3000-0000-0000-00000000000' || n)::uuid,
       ('c0f070c0-2000-0000-0000-00000000000' || n)::uuid,
       'c0f070c0-1000-0000-0000-000000000000'
  from generate_series(1, 2) n;

-- Tasa 40 desde el 1/3/2001 y 50 desde el 12/3/2001.
insert into public.exchange_rates (rate_date, usd_to_ves) values
  ('2001-03-01', 40),
  ('2001-03-12', 50);

-- PA: Bs 1000,00 (2,5 kg -> tarifa MRW 2,10). PD: USD 5,00 (2,5 kg).
insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active, weight_kg) values
  ('c0f070c0-4000-0000-0000-00000000000a', 'Prod BF A (Bs 1000)', 1000.00, 'VES', 5, 'BF-A', true, 2.5),
  ('c0f070c0-4000-0000-0000-00000000000d', 'Prod BF D (USD 5)',      5.00, 'USD', 5, 'BF-D', true, 2.5);

-- Carrito de la conversación 1: PA x2 (lo armó el asesor normal).
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, added_by) values
  ('c0f070c0-3000-0000-0000-000000000001', 'c0f070c0-4000-0000-0000-00000000000a', 2, 'inventory', 'c0f070c0-0000-0000-0000-0000000000b1');
-- Carrito de la conversación 2: PD en ESTÁNDAR (PA no está: su tipo de precio es
-- desconocido y debe tratarse como promoción).
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, added_by, price_kind) values
  ('c0f070c0-3000-0000-0000-000000000002', 'c0f070c0-4000-0000-0000-00000000000d', 1, 'inventory', 'c0f070c0-0000-0000-0000-0000000000b1', 'estandar');

-- Presupuesto VIVO de Inventario: PD estándar x1.
insert into public.presupuestos (id, cliente_nombre, cliente_apellido, origen, created_by) values
  ('c0f070c0-5000-0000-0000-000000000001', 'Ana', 'Backfill', 'inventario', 'c0f070c0-0000-0000-0000-0000000000a1');
insert into public.presupuesto_items (presupuesto_id, product_id, quantity, price_kind) values
  ('c0f070c0-5000-0000-0000-000000000001', 'c0f070c0-4000-0000-0000-00000000000d', 1, 'estandar');

-- Los borradores (todos `creado`; el 23505 de "uno en curso por origen" no
-- aplica a `creado`).
--   B1 carrito conv 1, PA x2, 15/3/2001 (después del recargo, tasa 50)
--   B6 reenvío idéntico de B1, una hora después
--   B2 presupuesto vivo, PD estándar x1, 16/3/2001
--   B3 presupuesto borrado, codclie genérico, PD x2, 20/3/2001
--   B4 presupuesto borrado normal, PD x2, 20/3/2001 (asesor normal)
--   B8 presupuesto borrado normal armado por la cuenta de mostrador, 20/3/2001
--   B5 carrito conv 2, PA x1 + PD x1, 5/3/2001 (ANTES del recargo, tasa 40)
--   B7 presupuesto borrado, un código que no existe, 21/3/2001
--   B9 y B10 presupuesto borrado idéntico, MISMO instante exacto (el desempate
--       por id: solo uno de los dos es "posible duplicado")
insert into liminal.saint_borradores
  (id, origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, estado, created_at, codclie)
values
  ('b0fb1111-0000-0000-0000-000000000001', 'carrito', 'c0f070c0-3000-0000-0000-000000000001',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '1', 'Ana', 'Uno', '', '[{"codprod":"BF-A","cantidad":2}]', 'creado', '2001-03-15 12:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-000000000006', 'carrito', 'c0f070c0-3000-0000-0000-000000000001',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '1', 'Ana', 'Uno', '', '[{"codprod":"BF-A","cantidad":2}]', 'creado', '2001-03-15 13:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-000000000002', 'presupuesto', 'c0f070c0-5000-0000-0000-000000000001',
   'c0f070c0-0000-0000-0000-0000000000a1', 'V', '2', 'Ana', 'Dos', '', '[{"codprod":"BF-D","cantidad":1}]', 'creado', '2001-03-16 10:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-000000000003', 'presupuesto', 'b0fb2222-0000-0000-0000-000000000003',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '3', 'Ana', 'Tres', '', '[{"codprod":"BF-D","cantidad":2}]', 'creado', '2001-03-20 10:00-04', 'BF-GEN'),
  ('b0fb1111-0000-0000-0000-000000000004', 'presupuesto', 'b0fb2222-0000-0000-0000-000000000004',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '4', 'Ana', 'Cuatro', '', '[{"codprod":"BF-D","cantidad":2}]', 'creado', '2001-03-20 11:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-000000000008', 'presupuesto', 'b0fb2222-0000-0000-0000-000000000008',
   'c0f070c0-0000-0000-0000-0000000000a1', 'V', '8', 'Ana', 'Ocho', '', '[{"codprod":"BF-D","cantidad":1}]', 'creado', '2001-03-20 12:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-000000000005', 'carrito', 'c0f070c0-3000-0000-0000-000000000002',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '5', 'Ana', 'Cinco', '', '[{"codprod":"BF-A","cantidad":1},{"codprod":"BF-D","cantidad":1}]', 'creado', '2001-03-05 10:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-000000000007', 'presupuesto', 'b0fb2222-0000-0000-0000-000000000007',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '7', 'Ana', 'Siete', '', '[{"codprod":"BF-NOEXISTE","cantidad":1}]', 'creado', '2001-03-21 10:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-000000000009', 'presupuesto', 'b0fb2222-0000-0000-0000-000000000009',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '9', 'Ana', 'Nueve', '', '[{"codprod":"BF-D","cantidad":1}]', 'creado', '2001-03-22 10:00-04', 'BF-NORMAL'),
  ('b0fb1111-0000-0000-0000-00000000000a', 'presupuesto', 'b0fb2222-0000-0000-0000-000000000009',
   'c0f070c0-0000-0000-0000-0000000000b1', 'V', '9', 'Ana', 'Nueve', '', '[{"codprod":"BF-D","cantidad":1}]', 'creado', '2001-03-22 10:00-04', 'BF-NORMAL');

-- El codclie genérico del mostrador: 20 envíos `creado` en los últimos 30 días.
insert into liminal.saint_borradores
  (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, estado, created_at, codclie)
select 'presupuesto', gen_random_uuid(), 'c0f070c0-0000-0000-0000-0000000000b1', 'V', '9', 'Mostrador', 'Generico', '',
       '[{"codprod":"BF-D","cantidad":1}]', 'creado', now() - interval '1 day', 'BF-GEN'
  from generate_series(1, 20);

-- Los valores de prueba que el VPS pondría en los dos huecos, y el modo real
-- DENTRO de esta transacción (`ya_en_transaccion`: el script no abre ni cierra
-- la suya, trabaja con un savepoint).
\set ya_en_transaccion true
\set instante_recargo '2001-03-10 00:00:00-04'
\set cuentas_mostrador 'c0f070c0-0000-0000-0000-0000000000a1'

-- 8a. Modo de prueba: corre todo y no deja nada.
\set dry_run true
\i scripts/sql/2026-11-ventas-saint-backfill.sql

insert into _errores
select 'dry-run: dejó ' || count(*) || ' foto(s) escritas (debía dejar 0)'
  from public.ventas_saint where borrador_id::text like 'b0fb1111-%'
having count(*) <> 0;

-- 8b. Modo real.
\set dry_run false
\i scripts/sql/2026-11-ventas-saint-backfill.sql

-- Las 10 de fixture + las 20 del codclie genérico.
insert into _errores
select 'real: fotos de fixture = ' || count(*) || ' (esperaba 10)'
  from public.ventas_saint where borrador_id::text like 'b0fb1111-%'
having count(*) <> 10;
insert into _errores
select 'real: fotos de relleno genérico = ' || count(*) || ' (esperaba 20)'
  from public.ventas_saint v join liminal.saint_borradores b on b.id = v.borrador_id
 where b.codclie = 'BF-GEN' and b.created_at > now() - interval '30 days'
having count(*) <> 20;
insert into _errores
select 'real: alguna foto de fixture no quedó estimado'
  from public.ventas_saint where borrador_id::text like 'b0fb1111-%' and not estimado
 limit 1;
insert into _errores
select 'real: alguna foto de fixture trae foto_error'
  from public.ventas_saint where borrador_id::text like 'b0fb1111-%' and foto_error is not null
 limit 1;

-- 1. B1: carrito, online/registro, tasa del día del envío (50: no la 40 del 1/3).
--    1000 x 1,16 = 1160,00 Bs / 50 = 23,20 -> x2 = 46,40; Bs = 46,40 x 50.
insert into _errores
select 'B1: ' || coalesce(to_jsonb(v)::text, 'sin foto')
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000001'
 where v.borrador_id is null
    or not (v.canal = 'online' and v.canal_fuente = 'registro' and v.origen = 'carrito'
            and v.conversation_id = 'c0f070c0-3000-0000-0000-000000000001'
            and v.presupuesto_id is null
            and v.armado_por = 'c0f070c0-0000-0000-0000-0000000000b1'
            and v.enviado_por = 'c0f070c0-0000-0000-0000-0000000000b1'
            and v.rol_envia = 'agent'
            and v.unidades = 2 and v.monto_usd = 46.40 and v.monto_bs = 2320.00 and v.tasa_bcv = 50
            and v.lineas_sin_precio = 0 and v.estimado and not v.posible_duplicado
            and v.created_at = '2001-03-15 12:00-04'
            and (v.lineas -> 0 ->> 'precio_usd')::numeric = 23.20
            and v.lineas -> 0 ->> 'price_kind' = 'promocion');

-- 7. B6: el reenvío idéntico es el único duplicado.
insert into _errores
select 'B6: debía ser posible_duplicado y online'
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000006'
 where v.borrador_id is null or not (v.posible_duplicado and v.canal = 'online' and v.monto_usd = 46.40);
insert into _errores
select 'otro envío marcado posible_duplicado: ' || borrador_id
  from public.ventas_saint
 where borrador_id::text like 'b0fb1111-%' and posible_duplicado
   and borrador_id not in ('b0fb1111-0000-0000-0000-000000000006', 'b0fb1111-0000-0000-0000-00000000000a');

-- 7b. Dos envíos idénticos del MISMO instante: el desempate es el id, así que
--     solo el segundo se marca (con `<=` se marcarían entre sí).
insert into _errores
select 'empate exacto: debía marcarse solo b...0a y quedó ' || coalesce(string_agg(right(borrador_id::text, 2), ','), 'ninguno')
  from public.ventas_saint
 where borrador_id in ('b0fb1111-0000-0000-0000-000000000009', 'b0fb1111-0000-0000-0000-00000000000a')
   and posible_duplicado
having coalesce(string_agg(right(borrador_id::text, 2), ','), '') <> '0a';

-- 2. B2: presupuesto vivo de Inventario -> tienda/registro. PD (USD 5,00) estándar,
--    después del recargo: 5,80 + 2,10 = 7,90.
insert into _errores
select 'B2: ' || coalesce(to_jsonb(v)::text, 'sin foto')
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000002'
 where v.borrador_id is null
    or not (v.canal = 'tienda' and v.canal_fuente = 'registro'
            and v.presupuesto_id = 'c0f070c0-5000-0000-0000-000000000001'
            and v.conversation_id is null
            and v.armado_por = 'c0f070c0-0000-0000-0000-0000000000a1'
            and v.monto_usd = 7.90 and v.tasa_bcv = 50 and v.estimado
            and v.lineas -> 0 ->> 'price_kind' = 'estandar');

-- 3. B3: presupuesto borrado + codclie genérico -> tienda/inferido. 5,80 x 2 = 11,60.
insert into _errores
select 'B3: ' || coalesce(to_jsonb(v)::text, 'sin foto')
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000003'
 where v.borrador_id is null
    or not (v.canal = 'tienda' and v.canal_fuente = 'inferido'
            and v.presupuesto_id = 'b0fb2222-0000-0000-0000-000000000003'
            and v.conversation_id is null and v.armado_por is null
            and v.monto_usd = 11.60 and v.estimado);

-- 4. B4: borrado normal -> online/inferido. B8: borrado armado por el mostrador -> tienda/inferido.
insert into _errores
select 'B4: ' || coalesce(to_jsonb(v)::text, 'sin foto')
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000004'
 where v.borrador_id is null
    or not (v.canal = 'online' and v.canal_fuente = 'inferido' and v.monto_usd = 11.60 and v.estimado);
insert into _errores
select 'B8: ' || coalesce(to_jsonb(v)::text, 'sin foto')
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000008'
 where v.borrador_id is null
    or not (v.canal = 'tienda' and v.canal_fuente = 'inferido' and v.monto_usd = 5.80 and v.estimado);

-- 5. B5: ANTES del recargo (5/3/2001, tasa 40). PA (Bs 1000, sin recargo): 1000 / 40
--    = 25,00 exacto (no sube). PD (USD 5,00) en ESTÁNDAR porque el carrito vivo lo
--    dice: 5,00 + 2,10 = 7,10. Total 32,10; con el recargo habría dado 29,00 + 7,90.
insert into _errores
select 'B5: ' || coalesce(to_jsonb(v)::text, 'sin foto')
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000005'
 where v.borrador_id is null
    or not (v.canal = 'online' and v.canal_fuente = 'registro'
            and v.tasa_bcv = 40 and v.monto_usd = 32.10 and v.monto_bs = 1284.00
            and v.unidades = 2 and v.lineas_sin_precio = 0 and v.estimado
            and (select (l ->> 'precio_usd')::numeric from jsonb_array_elements(v.lineas) l where l ->> 'codprod' = 'BF-A') = 25.00
            and (select l ->> 'price_kind' from jsonb_array_elements(v.lineas) l where l ->> 'codprod' = 'BF-A') = 'promocion'
            and (select (l ->> 'precio_usd')::numeric from jsonb_array_elements(v.lineas) l where l ->> 'codprod' = 'BF-D') = 7.10
            and (select l ->> 'price_kind' from jsonb_array_elements(v.lineas) l where l ->> 'codprod' = 'BF-D') = 'estandar');

-- 6. B7: el código ya no existe -> sin monto y una línea sin precio.
insert into _errores
select 'B7: ' || coalesce(to_jsonb(v)::text, 'sin foto')
  from (select 1) x
  left join public.ventas_saint v on v.borrador_id = 'b0fb1111-0000-0000-0000-000000000007'
 where v.borrador_id is null
    or not (v.monto_usd is null and v.monto_bs is null and v.lineas_sin_precio = 1
            and v.unidades = 1 and v.canal = 'online' and v.canal_fuente = 'inferido' and v.estimado
            and v.lineas -> 0 ->> 'product_id' is null and v.lineas -> 0 ->> 'precio_usd' is null);

-- 9. Idempotencia: una segunda corrida real no cambia ninguna fila.
create temporary table _antes on commit drop as
  select borrador_id, md5(to_jsonb(v)::text) as huella from public.ventas_saint v;

\i scripts/sql/2026-11-ventas-saint-backfill.sql

insert into _errores
select 'idempotencia: cambió la cantidad de fotos (' || (select count(*) from _antes) || ' -> ' || count(*) || ')'
  from public.ventas_saint
having count(*) <> (select count(*) from _antes);
insert into _errores
select 'idempotencia: cambió la foto ' || a.borrador_id
  from _antes a
  left join public.ventas_saint v on v.borrador_id = a.borrador_id
 where v.borrador_id is null or md5(to_jsonb(v)::text) <> a.huella;

-- Resultado: un único raise exception si algo falló (ver `_errores`).
do $$
declare
  v_fallos text;
begin
  select string_agg(msg, E'\n  - ' order by msg) into v_fallos from _errores;
  if v_fallos is not null then
    raise exception E'2026-11-ventas-saint-backfill.test.sql: fallaron comprobaciones:\n  - %', v_fallos;
  end if;
  raise notice '2026-11-ventas-saint-backfill.test.sql: todas las comprobaciones pasaron.';
end
$$;

rollback;
