-- ===========================================================================
-- La foto de cada envío a SAINT (13/11/2026), plan "Paneles", M1
-- (migración 20261113010000_ventas_saint.sql).
--
-- Contexto: los paneles de ventas necesitan saber CUÁNTO vale cada envío a SAINT
-- y quién lo armó y lo envió, y `liminal.saint_borradores` (contrato con el
-- agente LiminalReplicant) no guarda precios ni canal. Un trigger AFTER INSERT
-- deja, en la misma transacción, una "foto" en `public.ventas_saint` con monto,
-- canal y responsables. La foto NUNCA puede abortar un envío.
--
-- Qué fija:
--   1. Carrito del chat -> foto `online`, monto con recargo y techo a $0,10,
--      unidades, líneas, tasa, quién armó (último ítem cambiado) y quién envió.
--   2. Presupuesto `inventario` -> `tienda`; presupuesto `chat` -> `online` y
--      con su conversation_id.
--   3. Renglón `estandar` con tarifa -> precio de estándar; sin tarifa -> el
--      monto queda null y `lineas_sin_precio` cuenta el renglón (nunca un total
--      parcial). La caja (que no recibe la tarifa por `tarifa_mrw_usd`) envía un
--      presupuesto estándar y la foto igual lleva el monto completo.
--   4. Producto en USD -> rama USD.
--   5. Sin ninguna tasa -> el envío PASA, la foto queda con monto null (los
--      productos en USD siguen pudiendo sumarse; los de Bs no).
--   6. Foto rota (un CHECK que rechaza el insert completo, o la tabla renombrada)
--      -> el envío PASA; con el CHECK queda la fila mínima con `foto_error`.
--   7. `authenticated` no lee ni escribe `ventas_saint` (error de permiso).
--   8. Reenvío idéntico -> segunda foto con `posible_duplicado`.
--   9. El 23505 de "un solo envío en curso por origen" sigue igual.
--  10. `precio_venta_usd` contra los casos dorados.
--
-- CASOS DORADOS (escritos a mano, NO calculados con la función que se prueba;
-- los mismos valores viven en src/lib/precio-venta-paridad.test.ts, que los
-- compara contra las funciones de TypeScript). Tasa de la prueba: 40.
--   [dorado:A] VES 1000,00  promoción -> 29.00   (1160,00 / 40 = 29 exacto: NO sube)
--   [dorado:B] VES 100,50   promoción -> 3.00    (116,58 / 40 = 2,9145 -> sube a 3,00)
--   [dorado:C] VES 10,35    promoción -> 0.40    (12,01 / 40 = 0,30025 -> sube a 0,40)
--   [dorado:D] USD 5,00     promoción -> 5.80    (5,80 exacto: NO sube)
--   [dorado:E] USD 12,34    promoción -> 14.40   (14,3144 -> sube a 14,40)
--   [dorado:F] VES 1000,00  estándar, tarifa 2,10 -> 31.10
--   [dorado:G] USD 5,00     estándar, tarifa 2,10 -> 7.90
--
-- Corre como `authenticated` con la `sub` de usuarios reales (como `postgres` se
-- salta la RLS y no mediría nada). Aplicar la migración antes y correr con
-- `docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f - < ...`
-- Termina en rollback: no deja datos.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

create temporary table _ids (clave text primary key, id uuid);
grant select, insert on _ids to authenticated, service_role;

-- A: asesor; S: supervisor; C: caja.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('c0f070a0-0000-0000-0000-0000000000a1', 'asesor-ventas-saint@sbk.test', jsonb_build_object('display_name', 'Asesor ventas saint'), '{}'::jsonb),
  ('c0f070a0-0000-0000-0000-0000000000b1', 'super-ventas-saint@sbk.test',  jsonb_build_object('display_name', 'Supervisor ventas saint'), '{"role":"supervisor"}'::jsonb),
  ('c0f070a0-0000-0000-0000-0000000000c1', 'caja-ventas-saint@sbk.test',   jsonb_build_object('display_name', 'Caja ventas saint'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('c0f070a0-1000-0000-0000-000000000000', 'Canal de prueba ventas saint', '+580000009500');

-- Conversaciones: 1 carrito principal, 2 presupuesto chat, 4 carrito USD,
-- 5 sin tasa (mixto), 6 sin tasa (solo USD), 7 foto rota (CHECK), 8 foto rota (renombre).
insert into public.contacts (id, phone_number, display_name)
select ('c0f070a0-2000-0000-0000-00000000000' || n)::uuid, '+58000000950' || n, 'Contacto ventas saint ' || n
  from generate_series(1, 8) n;
insert into public.conversations (id, contact_id, whatsapp_channel_id)
select ('c0f070a0-3000-0000-0000-00000000000' || n)::uuid,
       ('c0f070a0-2000-0000-0000-00000000000' || n)::uuid,
       'c0f070a0-1000-0000-0000-000000000000'
  from generate_series(1, 8) n;

-- Tasa de la prueba: 40, con una fecha que la hace la vigente.
insert into public.exchange_rates (rate_date, usd_to_ves) values ('2999-12-31', 40);

-- Productos (el precio se guarda CRUDO; el recargo lo pone la función).
-- A y D con peso 2,5 kg -> tarifa MRW 2,10 (tramo [2, 3) de la tabla de tarifas).
insert into public.products (id, name, price, currency, stock_quantity, saint_code, is_active, weight_kg) values
  ('c0f070a0-4000-0000-0000-00000000000a', 'Prod VS A (Bs 1000)',  1000.00, 'VES', 5, 'VS-A', true, 2.5),
  ('c0f070a0-4000-0000-0000-00000000000b', 'Prod VS B (Bs 100,50)', 100.50, 'VES', 5, 'VS-B', true, null),
  ('c0f070a0-4000-0000-0000-00000000000c', 'Prod VS C (Bs 10,35)',   10.35, 'VES', 5, 'VS-C', true, null),
  ('c0f070a0-4000-0000-0000-00000000000d', 'Prod VS D (USD 5)',       5.00, 'USD', 5, 'VS-D', true, 2.5),
  ('c0f070a0-4000-0000-0000-00000000000e', 'Prod VS E (USD 12,34)',  12.34, 'USD', 5, 'VS-E', true, null);

-- Carrito 1 (el principal): A x2 armado por S, B x1 armado DESPUÉS por A -> armó A.
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, added_by, created_at, updated_at) values
  ('c0f070a0-3000-0000-0000-000000000001', 'c0f070a0-4000-0000-0000-00000000000a', 2, 'inventory', 'c0f070a0-0000-0000-0000-0000000000b1', '2026-11-01 10:00+00', '2026-11-01 10:00+00'),
  ('c0f070a0-3000-0000-0000-000000000001', 'c0f070a0-4000-0000-0000-00000000000b', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1', '2026-11-01 10:05+00', '2026-11-02 09:00+00');
-- Carrito 4: solo productos en USD.
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, added_by) values
  ('c0f070a0-3000-0000-0000-000000000004', 'c0f070a0-4000-0000-0000-00000000000d', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-3000-0000-0000-000000000004', 'c0f070a0-4000-0000-0000-00000000000e', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1');
-- Carritos 5 (mixto Bs + USD), 6 (solo USD), 7 y 8 (fotos rotas).
insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, added_by) values
  ('c0f070a0-3000-0000-0000-000000000005', 'c0f070a0-4000-0000-0000-00000000000a', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-3000-0000-0000-000000000005', 'c0f070a0-4000-0000-0000-00000000000d', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-3000-0000-0000-000000000006', 'c0f070a0-4000-0000-0000-00000000000d', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-3000-0000-0000-000000000007', 'c0f070a0-4000-0000-0000-00000000000d', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-3000-0000-0000-000000000008', 'c0f070a0-4000-0000-0000-00000000000d', 1, 'inventory', 'c0f070a0-0000-0000-0000-0000000000a1');

-- Presupuestos (los arma S, los envía A salvo el de la caja):
--   P1 inventario: C x1 + E x2                    -> tienda, 0.40 + 28.80 = 29.20
--   P2 chat (conv 2): D x1                         -> online, 5.80
--   P3 estándar: A est x1 + D est x1               -> 31.10 + 7.90 = 39.00
--   P4 estándar sin tarifa: B est x1 + C x1        -> monto null, 1 renglón sin precio
--   P5 estándar enviado por la CAJA: A est x1      -> 31.10 (la caja no recibe tarifa_mrw_usd)
insert into public.presupuestos (id, cliente_nombre, cliente_apellido, contact_id, conversation_id, origen, created_by) values
  ('c0f070a0-5000-0000-0000-000000000001', 'Ana', 'Uno',    null, null, 'inventario', 'c0f070a0-0000-0000-0000-0000000000b1'),
  ('c0f070a0-5000-0000-0000-000000000002', 'Ana', 'Dos',    null, 'c0f070a0-3000-0000-0000-000000000002', 'chat', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-5000-0000-0000-000000000003', 'Ana', 'Tres',   null, null, 'inventario', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-5000-0000-0000-000000000004', 'Ana', 'Cuatro', null, null, 'inventario', 'c0f070a0-0000-0000-0000-0000000000a1'),
  ('c0f070a0-5000-0000-0000-000000000005', 'Ana', 'Cinco',  null, null, 'inventario', 'c0f070a0-0000-0000-0000-0000000000a1');
insert into public.presupuesto_items (presupuesto_id, product_id, quantity, price_kind) values
  ('c0f070a0-5000-0000-0000-000000000001', 'c0f070a0-4000-0000-0000-00000000000c', 1, 'promocion'),
  ('c0f070a0-5000-0000-0000-000000000001', 'c0f070a0-4000-0000-0000-00000000000e', 2, 'promocion'),
  ('c0f070a0-5000-0000-0000-000000000002', 'c0f070a0-4000-0000-0000-00000000000d', 1, 'promocion'),
  ('c0f070a0-5000-0000-0000-000000000003', 'c0f070a0-4000-0000-0000-00000000000a', 1, 'estandar'),
  ('c0f070a0-5000-0000-0000-000000000003', 'c0f070a0-4000-0000-0000-00000000000d', 1, 'estandar'),
  ('c0f070a0-5000-0000-0000-000000000004', 'c0f070a0-4000-0000-0000-00000000000b', 1, 'estandar'),
  ('c0f070a0-5000-0000-0000-000000000004', 'c0f070a0-4000-0000-0000-00000000000c', 1, 'promocion'),
  ('c0f070a0-5000-0000-0000-000000000005', 'c0f070a0-4000-0000-0000-00000000000a', 1, 'estandar');

-- Utilidades ---------------------------------------------------------------
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
  return 'error ' || sqlstate || ': ' || sqlerrm || ' | ' || coalesce(d, '+584141234567');
end $$;

create or replace function pg_temp.esperar(etiqueta text, r text, patron text) returns void
language plpgsql as $$
begin
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

create or replace function pg_temp.esperar_num(etiqueta text, obtenido numeric, esperado numeric) returns void
language plpgsql as $$
begin
  if obtenido is distinct from esperado then
    insert into _errores(msg) values (format('%s: se esperaba %s y salió %s.', etiqueta, coalesce(esperado::text, 'null'), coalesce(obtenido::text, 'null')));
  end if;
end $$;

-- Precio de venta de un producto del fixture (como postgres).
create or replace function pg_temp.pv(p_id uuid, p_kind text, p_tasa numeric) returns numeric
language sql as $$
  select public.precio_venta_usd(p, p_kind, p_tasa) from public.products p where p.id = p_id
$$;

-- Verifica una foto entera por el id del borrador guardado en _ids.
create or replace function pg_temp.verificar(
  etiqueta text, p_clave text,
  p_canal text, p_conversation uuid, p_presupuesto uuid, p_armado uuid, p_enviado uuid, p_rol text,
  p_unidades int, p_monto_usd numeric, p_monto_bs numeric, p_tasa numeric, p_sin_precio int, p_duplicado boolean
) returns void
language plpgsql as $$
declare
  v record;
  b record;
  id_b uuid := (select id from _ids where clave = p_clave);
begin
  select * into v from public.ventas_saint where borrador_id = id_b;
  select * into b from liminal.saint_borradores where id = id_b;
  if v.borrador_id is null then
    insert into _errores(msg) values (format('%s: no hay foto del borrador %s.', etiqueta, p_clave));
    return;
  end if;
  if v.canal is distinct from p_canal or v.canal_fuente is distinct from 'registro' then
    insert into _errores(msg) values (format('%s: canal %s/%s, se esperaba %s/registro.', etiqueta, v.canal, v.canal_fuente, p_canal));
  end if;
  if v.origen is distinct from b.origen or v.created_at is distinct from b.created_at then
    insert into _errores(msg) values (format('%s: origen/created_at no copian los del borrador.', etiqueta));
  end if;
  if v.conversation_id is distinct from p_conversation then
    insert into _errores(msg) values (format('%s: conversation_id %s, se esperaba %s.', etiqueta, v.conversation_id, p_conversation));
  end if;
  if v.presupuesto_id is distinct from p_presupuesto then
    insert into _errores(msg) values (format('%s: presupuesto_id %s, se esperaba %s.', etiqueta, v.presupuesto_id, p_presupuesto));
  end if;
  if v.armado_por is distinct from p_armado then
    insert into _errores(msg) values (format('%s: armado_por %s, se esperaba %s.', etiqueta, v.armado_por, p_armado));
  end if;
  if v.enviado_por is distinct from p_enviado or v.rol_envia is distinct from p_rol then
    insert into _errores(msg) values (format('%s: enviado_por/rol %s/%s, se esperaba %s/%s.', etiqueta, v.enviado_por, v.rol_envia, p_enviado, p_rol));
  end if;
  if v.unidades is distinct from p_unidades then
    insert into _errores(msg) values (format('%s: unidades %s, se esperaban %s.', etiqueta, v.unidades, p_unidades));
  end if;
  if v.monto_usd is distinct from p_monto_usd then
    insert into _errores(msg) values (format('%s: monto_usd %s, se esperaba %s.', etiqueta, coalesce(v.monto_usd::text, 'null'), coalesce(p_monto_usd::text, 'null')));
  end if;
  if v.monto_bs is distinct from p_monto_bs then
    insert into _errores(msg) values (format('%s: monto_bs %s, se esperaba %s.', etiqueta, coalesce(v.monto_bs::text, 'null'), coalesce(p_monto_bs::text, 'null')));
  end if;
  if v.tasa_bcv is distinct from p_tasa then
    insert into _errores(msg) values (format('%s: tasa_bcv %s, se esperaba %s.', etiqueta, coalesce(v.tasa_bcv::text, 'null'), coalesce(p_tasa::text, 'null')));
  end if;
  if v.lineas_sin_precio is distinct from p_sin_precio then
    insert into _errores(msg) values (format('%s: lineas_sin_precio %s, se esperaba %s.', etiqueta, v.lineas_sin_precio, p_sin_precio));
  end if;
  if v.posible_duplicado is distinct from p_duplicado then
    insert into _errores(msg) values (format('%s: posible_duplicado %s, se esperaba %s.', etiqueta, v.posible_duplicado, p_duplicado));
  end if;
  if v.foto_error is not null or v.estimado then
    insert into _errores(msg) values (format('%s: una foto sana no debía traer foto_error (%L) ni estimado (%s).', etiqueta, v.foto_error, v.estimado));
  end if;
  if jsonb_array_length(v.lineas) is distinct from (select count(*) from liminal.saint_borradores s, jsonb_array_elements(s.items) where s.id = id_b)
     and p_unidades is not null then
    -- Una línea por renglón del origen; con códigos distintos coincide con las líneas del borrador.
    insert into _errores(msg) values (format('%s: el número de líneas de la foto (%s) no coincide con el de ítems del borrador.', etiqueta, jsonb_array_length(v.lineas)));
  end if;
end $$;

-- Precondición: la tarifa MRW del tramo de 2,5 kg es la que suponen los dorados.
select pg_temp.esperar_num('Precondición: tarifa MRW de 2,5 kg', public.tarifa_mrw_usd(2.5), 2.10);

-- ---------------------------------------------------------------------------
-- Caso 10 · precio_venta_usd contra los casos dorados (como postgres).
-- ---------------------------------------------------------------------------
select pg_temp.esperar_num('[dorado:A] VES 1000 promoción', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000a', 'promocion', 40), 29.00);
select pg_temp.esperar_num('[dorado:B] VES 100,50 promoción', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000b', 'promocion', 40), 3.00);
select pg_temp.esperar_num('[dorado:C] VES 10,35 promoción', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000c', 'promocion', 40), 0.40);
select pg_temp.esperar_num('[dorado:D] USD 5 promoción', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000d', 'promocion', 40), 5.80);
select pg_temp.esperar_num('[dorado:E] USD 12,34 promoción', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000e', 'promocion', 40), 14.40);
select pg_temp.esperar_num('[dorado:F] VES 1000 estándar', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000a', 'estandar', 40), 31.10);
select pg_temp.esperar_num('[dorado:G] USD 5 estándar', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000d', 'estandar', 40), 7.90);
-- Los null que TypeScript también da.
select pg_temp.esperar_num('VES sin tasa -> null', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000a', 'promocion', null), null);
select pg_temp.esperar_num('VES con tasa 0 -> null', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000a', 'promocion', 0), null);
select pg_temp.esperar_num('USD sin tasa sigue dando precio', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000d', 'promocion', null), 5.80);
select pg_temp.esperar_num('Estándar sin peso (sin tarifa) -> null', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000b', 'estandar', 40), null);
select pg_temp.esperar_num('USD estándar sin tasa: precio + tarifa', pg_temp.pv('c0f070a0-4000-0000-0000-00000000000d', 'estandar', null), 7.90);

-- ---------------------------------------------------------------------------
-- Envíos (casos 1 a 4 y 8): como authenticated, con la sesión de cada quien.
-- ---------------------------------------------------------------------------
set local role authenticated;

-- S (supervisor) envía los carritos 1 y 4.
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000b1';
insert into _ids select 'c1', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000001', 'V', '12345678', 'Ana', 'Pérez', '+584141234567');
insert into _ids select 'c4', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000004', 'V', '12345678', 'Ana', 'Pérez', '+584141234567');

-- 9 · mientras el envío del carrito 1 sigue pendiente, otro envío del mismo
-- origen sigue dando 23505 (el trigger no lo rompe).
select pg_temp.esperar('Caso 9: segundo envío en curso del mismo origen',
  pg_temp.probar($q$select public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000001', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  '^error 23505');

-- A (asesor) envía los presupuestos 1 a 4.
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000a1';
insert into _ids select 'p1', public.enviar_borrador_saint('presupuesto', 'c0f070a0-5000-0000-0000-000000000001', 'V', '12345678', 'Ana', 'Uno', '+584141234567');
insert into _ids select 'p2', public.enviar_borrador_saint('presupuesto', 'c0f070a0-5000-0000-0000-000000000002', 'V', '12345678', 'Ana', 'Dos', '+584141234567');
insert into _ids select 'p3', public.enviar_borrador_saint('presupuesto', 'c0f070a0-5000-0000-0000-000000000003', 'V', '12345678', 'Ana', 'Tres', '+584141234567');
insert into _ids select 'p4', public.enviar_borrador_saint('presupuesto', 'c0f070a0-5000-0000-0000-000000000004', 'V', '12345678', 'Ana', 'Cuatro', '+584141234567');

-- C (caja) envía el presupuesto estándar 5.
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000c1';
insert into _ids select 'p5', public.enviar_borrador_saint('presupuesto', 'c0f070a0-5000-0000-0000-000000000005', 'V', '12345678', 'Ana', 'Cinco', '+584141234567');

reset role;
reset "request.jwt.claim.sub";

-- 8 · el agente cierra el primer envío del carrito 1 (simulado como postgres) y
-- S lo reenvía idéntico: la segunda foto sale marcada.
update liminal.saint_borradores set estado = 'creado', numero_saint = 'F-1' where id = (select id from _ids where clave = 'c1');

set local role authenticated;
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000b1';
insert into _ids select 'c1b', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000001', 'V', '12345678', 'Ana', 'Pérez', '+584141234567');
reset role;
reset "request.jwt.claim.sub";

-- Un tercer envío con OTRAS cantidades no es duplicado.
update liminal.saint_borradores set estado = 'creado', numero_saint = 'F-2' where id = (select id from _ids where clave = 'c1b');
update public.conversation_cart_items set quantity = 5
 where conversation_id = 'c0f070a0-3000-0000-0000-000000000001' and product_id = 'c0f070a0-4000-0000-0000-00000000000a';

set local role authenticated;
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000b1';
insert into _ids select 'c1c', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000001', 'V', '12345678', 'Ana', 'Pérez', '+584141234567');
reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Verificación de las fotos (como postgres, que sí puede leer la tabla).
-- Orden de los argumentos: canal, conversación, presupuesto, armado_por,
-- enviado_por, rol, unidades, monto_usd, monto_bs, tasa, sin_precio, duplicado.
-- ---------------------------------------------------------------------------
-- 1 · carrito del chat: 2 x 29.00 + 1 x 3.00 = 61.00 USD; x 40 = 2440.00 Bs.
--     Armó A (último ítem cambiado), envió S.
select pg_temp.verificar('Caso 1: carrito del chat', 'c1',
  'online', 'c0f070a0-3000-0000-0000-000000000001', null,
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000b1', 'supervisor',
  3, 61.00, 2440.00, 40, 0, false);

-- 1 · las líneas: una por renglón, con precio unitario, código y tipo de precio.
do $$
declare
  l jsonb;
  la jsonb;
begin
  select lineas into l from public.ventas_saint where borrador_id = (select id from _ids where clave = 'c1');
  select e into la from jsonb_array_elements(l) e where e ->> 'codprod' = 'VS-A';
  if la is null
     or (la ->> 'cantidad')::int <> 2
     or (la ->> 'precio_usd')::numeric <> 29.00
     or la ->> 'price_kind' <> 'promocion'
     or la ->> 'product_id' <> 'c0f070a0-4000-0000-0000-00000000000a'
     or la ->> 'nombre' <> 'Prod VS A (Bs 1000)' then
    insert into _errores(msg) values (format('Caso 1: la línea de VS-A no trae {product_id, codprod, nombre, cantidad, precio_usd, price_kind} correctos: %s', la));
  end if;
end $$;

-- 2 · presupuesto de inventario -> tienda; lo armó S, lo envió A.
select pg_temp.verificar('Caso 2a: presupuesto de inventario', 'p1',
  'tienda', null, 'c0f070a0-5000-0000-0000-000000000001',
  'c0f070a0-0000-0000-0000-0000000000b1', 'c0f070a0-0000-0000-0000-0000000000a1', 'agent',
  3, 29.20, 1168.00, 40, 0, false);
-- 2 · presupuesto de chat enviado igual -> online, con su conversación.
select pg_temp.verificar('Caso 2b: presupuesto de chat', 'p2',
  'online', 'c0f070a0-3000-0000-0000-000000000002', 'c0f070a0-5000-0000-0000-000000000002',
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000a1', 'agent',
  1, 5.80, 232.00, 40, 0, false);

-- 3 · estándar con tarifa: 31.10 + 7.90 = 39.00.
select pg_temp.verificar('Caso 3a: estándar con tarifa', 'p3',
  'tienda', null, 'c0f070a0-5000-0000-0000-000000000003',
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000a1', 'agent',
  2, 39.00, 1560.00, 40, 0, false);
-- 3 · estándar sin tarifa (B no tiene peso): nunca un total parcial.
select pg_temp.verificar('Caso 3b: estándar sin tarifa', 'p4',
  'tienda', null, 'c0f070a0-5000-0000-0000-000000000004',
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000a1', 'agent',
  2, null, null, 40, 1, false);
-- 3 · la caja no recibe tarifa_mrw_usd, pero la foto igual lleva el estándar completo.
select pg_temp.verificar('Caso 3c: estándar enviado por la caja', 'p5',
  'tienda', null, 'c0f070a0-5000-0000-0000-000000000005',
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000c1', 'caja',
  1, 31.10, 1244.00, 40, 0, false);

-- 4 · todo en USD: 5.80 + 14.40 = 20.20.
select pg_temp.verificar('Caso 4: carrito en USD', 'c4',
  'online', 'c0f070a0-3000-0000-0000-000000000004', null,
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000b1', 'supervisor',
  2, 20.20, 808.00, 40, 0, false);

-- 8 · reenvío idéntico: la primera foto limpia, la segunda marcada; con otras
--     cantidades (3.ª) vuelve a salir limpia.
select pg_temp.verificar('Caso 8a: primer envío del carrito', 'c1',
  'online', 'c0f070a0-3000-0000-0000-000000000001', null,
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000b1', 'supervisor',
  3, 61.00, 2440.00, 40, 0, false);
select pg_temp.verificar('Caso 8b: reenvío idéntico', 'c1b',
  'online', 'c0f070a0-3000-0000-0000-000000000001', null,
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000b1', 'supervisor',
  3, 61.00, 2440.00, 40, 0, true);
-- 8 · tercer envío: 5 x 29.00 + 3.00 = 148.00, 6 unidades, NO duplicado. El
--     último ítem cambiado ahora es el de A-x5 (lo agregó S), así que armó S.
select pg_temp.verificar('Caso 8c: reenvío con otras cantidades', 'c1c',
  'online', 'c0f070a0-3000-0000-0000-000000000001', null,
  'c0f070a0-0000-0000-0000-0000000000b1', 'c0f070a0-0000-0000-0000-0000000000b1', 'supervisor',
  6, 148.00, 5920.00, 40, 0, false);

-- 9 · el rechazo por 23505 no dejó una foto huérfana: 3 fotos del carrito 1.
select pg_temp.esperar_num('Caso 9: fotos del carrito 1 (el 23505 no dejó ninguna de más)',
  (select count(*) from public.ventas_saint where conversation_id = 'c0f070a0-3000-0000-0000-000000000001'), 3);

-- ---------------------------------------------------------------------------
-- Caso 7 · authenticated no lee ni escribe la tabla.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000b1';

select pg_temp.esperar('Caso 7: select directo',
  pg_temp.probar($q$select * from public.ventas_saint$q$), '^error 42501');
select pg_temp.esperar('Caso 7: insert directo',
  pg_temp.probar($q$insert into public.ventas_saint (borrador_id, origen, canal, canal_fuente) values (gen_random_uuid(), 'carrito', 'online', 'registro')$q$),
  '^error 42501');
select pg_temp.esperar('Caso 7: update directo',
  pg_temp.probar($q$update public.ventas_saint set monto_usd = 1$q$), '^error 42501');
select pg_temp.esperar('Caso 7: delete directo',
  pg_temp.probar($q$delete from public.ventas_saint$q$), '^error 42501');

reset role;
reset "request.jwt.claim.sub";

do $$
begin
  if has_table_privilege('service_role', 'public.ventas_saint', 'SELECT')
     or has_table_privilege('anon', 'public.ventas_saint', 'SELECT')
     or has_table_privilege('authenticated', 'public.ventas_saint', 'SELECT') then
    insert into _errores(msg) values ('Caso 7: anon, authenticated o service_role pueden leer ventas_saint.');
  end if;
  if not exists (select 1 from pg_class where oid = 'public.ventas_saint'::regclass and relrowsecurity) then
    insert into _errores(msg) values ('Caso 7: ventas_saint no tiene RLS habilitada.');
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.ventas_saint'::regclass) then
    insert into _errores(msg) values ('Caso 7: ventas_saint no debía tener ninguna política.');
  end if;
  if has_function_privilege('anon', 'public.ventas_saint_foto()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ventas_saint_foto()', 'EXECUTE') then
    insert into _errores(msg) values ('Caso 7: la función del trigger es ejecutable por anon o authenticated.');
  end if;
  if has_function_privilege('anon', 'public.precio_venta_usd(public.products, text, numeric)', 'EXECUTE') then
    insert into _errores(msg) values ('Caso 7: anon puede ejecutar precio_venta_usd.');
  end if;
  if not has_function_privilege('authenticated', 'public.precio_venta_usd(public.products, text, numeric)', 'EXECUTE') then
    insert into _errores(msg) values ('Caso 7: authenticated debe poder ejecutar precio_venta_usd.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · una foto rota NUNCA aborta el envío.
-- ---------------------------------------------------------------------------
-- 6a · un CHECK rechaza el insert completo (monto no nulo): queda la fila mínima
--      con foto_error, canal inferido y sin monto.
alter table public.ventas_saint add constraint zz_prueba_foto_rota check (monto_usd is null) not valid;

set local role authenticated;
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000b1';
select pg_temp.esperar('Caso 6a: el envío pasa aunque la foto completa falle',
  pg_temp.probar($q$insert into _ids select 'c7', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000007', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  '^filas=1$');
reset role;
reset "request.jwt.claim.sub";

do $$
declare
  v record;
begin
  select * into v from public.ventas_saint where borrador_id = (select id from _ids where clave = 'c7');
  if v.borrador_id is null then
    insert into _errores(msg) values ('Caso 6a: no quedó ni la fila mínima de la foto rota.');
  elsif v.foto_error is null or v.monto_usd is not null or v.canal_fuente <> 'inferido' or v.canal <> 'online' or v.origen <> 'carrito' then
    insert into _errores(msg) values (format('Caso 6a: la fila mínima debía traer foto_error, sin monto, canal online inferido; trae %L / %L / %L / %L.', v.foto_error, v.monto_usd, v.canal, v.canal_fuente));
  elsif char_length(v.foto_error) > 200 then
    insert into _errores(msg) values ('Caso 6a: foto_error pasa de 200 caracteres.');
  end if;
  if not exists (select 1 from liminal.saint_borradores where id = (select id from _ids where clave = 'c7')) then
    insert into _errores(msg) values ('Caso 6a: el borrador no quedó guardado.');
  end if;
end $$;

alter table public.ventas_saint drop constraint zz_prueba_foto_rota;

-- 6b · la tabla de la foto ni siquiera existe (renombrada): el envío pasa igual.
alter table public.ventas_saint rename to ventas_saint_renombrada;

set local role authenticated;
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000b1';
select pg_temp.esperar('Caso 6b: el envío pasa con la tabla de la foto ausente',
  pg_temp.probar($q$insert into _ids select 'c8', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000008', 'V', '12345678', 'Ana', 'Pérez', '+584141234567')$q$),
  '^filas=1$');
reset role;
reset "request.jwt.claim.sub";

alter table public.ventas_saint_renombrada rename to ventas_saint;
select pg_temp.esperar('Caso 6b: el borrador quedó guardado',
  (select count(*)::text from liminal.saint_borradores where id = (select id from _ids where clave = 'c8')), '^1$');

-- ---------------------------------------------------------------------------
-- Caso 5 · sin ninguna tasa el envío pasa y la foto no inventa monto.
-- ---------------------------------------------------------------------------
delete from public.exchange_rates;

set local role authenticated;
set local "request.jwt.claim.sub" = 'c0f070a0-0000-0000-0000-0000000000b1';
-- Carrito mixto (Bs + USD): un renglón sin precio -> monto null.
insert into _ids select 'c5', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000005', 'V', '12345678', 'Ana', 'Pérez', '+584141234567');
-- Carrito solo en USD: el monto sí existe, el monto en Bs no.
insert into _ids select 'c6', public.enviar_borrador_saint('carrito', 'c0f070a0-3000-0000-0000-000000000006', 'V', '12345678', 'Ana', 'Pérez', '+584141234567');
reset role;
reset "request.jwt.claim.sub";

select pg_temp.verificar('Caso 5a: sin tasa, carrito mixto', 'c5',
  'online', 'c0f070a0-3000-0000-0000-000000000005', null,
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000b1', 'supervisor',
  2, null, null, null, 1, false);
select pg_temp.verificar('Caso 5b: sin tasa, carrito solo en USD', 'c6',
  'online', 'c0f070a0-3000-0000-0000-000000000006', null,
  'c0f070a0-0000-0000-0000-0000000000a1', 'c0f070a0-0000-0000-0000-0000000000b1', 'supervisor',
  1, 5.80, null, null, 0, false);

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
    raise exception E'ventas_saint.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;
