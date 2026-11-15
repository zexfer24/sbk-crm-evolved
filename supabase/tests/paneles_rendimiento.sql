-- ===========================================================================
-- Rendimiento de las RPC de los paneles (13/11/2026), plan "Paneles", M4.
--
-- NO corre en CI (pesado: siembra ~300 mil mensajes y 30 mil envíos dentro de la
-- transacción). Se corre a mano, contra la base local, después de aplicar
-- `20261113040000_paneles_lectura.sql`:
--
--   docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/paneles_rendimiento.sql
--
-- Mide como `authenticated` (con la `sub` de un supervisor), NUNCA como
-- superusuario: una función `security invoker` sobre una tabla con RLS paga la
-- política por fila y como postgres no se vería (CLAUDE.md, trampa del
-- 21/9/2026, `search_conversations_by_message`). Las cinco RPC son `security
-- definer`, así que el tiempo que sale aquí es el que ve la pantalla.
--
-- Objetivo del plan: cada RPC < 1,5 s con un rango de 30 días (el
-- `statement_timeout` de `authenticated` es 8 s). El script FALLA si alguna pasa
-- de su límite con la caché caliente (corridas 2 a 8; la primera se informa
-- aparte). Los rangos de 90 días, el peor caso, se vigilan contra 3 s. Termina
-- en rollback.
-- ===========================================================================

begin;

-- Las ~330 mil filas se siembran con los triggers apagados (si no, cada mensaje
-- actualizaría su conversación). Solo vale para la siembra: se reactiva antes de medir.
set local session_replication_role = replica;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('d0a4e200-0000-0000-0000-0000000000b1', 'super-rend@sbk.test', jsonb_build_object('display_name', 'Super Rend'), '{"role":"supervisor"}'::jsonb),
  ('d0a4e200-0000-0000-0000-0000000000a1', 'a1-rend@sbk.test', jsonb_build_object('display_name', 'Asesor Rend 1'), '{}'::jsonb),
  ('d0a4e200-0000-0000-0000-0000000000a2', 'a2-rend@sbk.test', jsonb_build_object('display_name', 'Asesor Rend 2'), '{}'::jsonb),
  ('d0a4e200-0000-0000-0000-0000000000a3', 'a3-rend@sbk.test', jsonb_build_object('display_name', 'Asesor Rend 3'), '{}'::jsonb),
  ('d0a4e200-0000-0000-0000-0000000000a4', 'a4-rend@sbk.test', jsonb_build_object('display_name', 'Asesor Rend 4'), '{}'::jsonb);

-- Con los triggers apagados `handle_new_agent` no corrió: se crean a mano.
insert into public.agents (id, display_name, role) values
  ('d0a4e200-0000-0000-0000-0000000000b1', 'Super Rend', 'supervisor'),
  ('d0a4e200-0000-0000-0000-0000000000a1', 'Asesor Rend 1', 'agent'),
  ('d0a4e200-0000-0000-0000-0000000000a2', 'Asesor Rend 2', 'agent'),
  ('d0a4e200-0000-0000-0000-0000000000a3', 'Asesor Rend 3', 'agent'),
  ('d0a4e200-0000-0000-0000-0000000000a4', 'Asesor Rend 4', 'agent')
on conflict (id) do nothing;

insert into public.whatsapp_channels (id, label, phone_number) values
  ('d0a4e200-1000-0000-0000-000000000000', 'Canal de rendimiento', '+580000009800');

-- 15.000 conversaciones con su contacto.
insert into public.contacts (id, phone_number, display_name)
select ('d0a4e200-2000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, '+5800099' || lpad(n::text, 5, '0'), 'Cliente rend ' || n
  from generate_series(1, 15000) n;
insert into public.conversations (id, contact_id, whatsapp_channel_id, assigned_agent_id, last_customer_message_at, created_at)
select ('d0a4e200-3000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       ('d0a4e200-2000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'd0a4e200-1000-0000-0000-000000000000',
       case when n % 3 = 0 then null else ('d0a4e200-0000-0000-0000-0000000000a' || (1 + n % 4))::uuid end,
       now() - (random() * interval '60 days'),
       now() - interval '61 days'
  from generate_series(1, 15000) n;

-- 300.000 mensajes: 20 por conversación repartidos en 60 días (45 % cliente,
-- 35 % asesor, 15 % IA, 5 % nota interna).
insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at)
select c.id,
       case when t.tipo = 'c' then 'inbound' else 'outbound' end,
       case t.tipo when 'c' then 'customer' when 'i' then 'ai' else 'agent' end,
       case when t.tipo in ('a', 'n') then ('d0a4e200-0000-0000-0000-0000000000a' || (1 + (c.n + t.i) % 4))::uuid end,
       'text', 'mensaje de rendimiento', t.tipo = 'n',
       c.base + (t.i * interval '9 minutes') + (random() * interval '8 minutes')
  from (
    select ('d0a4e200-3000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as id, n,
           now() - (random() * interval '60 days') as base
      from generate_series(1, 15000) n
  ) c
  cross join lateral (
    select i,
           case
             when r < 0.45 then 'c'
             when r < 0.80 then 'a'
             when r < 0.95 then 'i'
             else 'n'
           end as tipo
      from (select i, random() as r from generate_series(1, 20) i) q
  ) t;

-- 30.000 envíos con su foto: dos tercios online, un tercio tienda; el 70 % `creado`.
insert into liminal.saint_borradores (id, origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items, estado, codclie, cliente_creado, created_at)
select gen_random_uuid(),
       case when n % 3 = 0 then 'presupuesto' else 'carrito' end,
       gen_random_uuid(),
       ('d0a4e200-0000-0000-0000-0000000000a' || (1 + n % 4))::uuid,
       'V', (10000000 + n % 12000)::text, 'N', 'A', '+584140000000',
       '[{"codprod":"PN-R","cantidad":2}]'::jsonb,
       case when n % 10 < 7 then 'creado' when n % 10 < 9 then 'pendiente' else 'error' end,
       'C' || (n % 12000), n % 2 = 0,
       now() - (random() * interval '60 days')
  from generate_series(1, 30000) n;
-- `firma_items` igual para todos (el peor caso de la vista de duplicados: cada
-- candidato del mismo origen o conversación pasa el filtro de la firma) y
-- `presupuesto_id` en los de origen presupuesto (15/11/2026: el duplicado ya no
-- se marca al insertar, lo decide la vista `ventas_saint_estado` al leer).
insert into public.ventas_saint (borrador_id, created_at, origen, canal, canal_fuente, conversation_id, presupuesto_id, enviado_por, unidades, monto_usd, monto_bs, tasa_bcv, firma_items, lineas)
select b.id, b.created_at, b.origen,
       case when b.origen = 'carrito' then 'online' else 'tienda' end,
       'registro',
       case when b.origen = 'carrito' then ('d0a4e200-3000-0000-0000-' || lpad((1 + abs(hashtext(b.id::text)) % 15000)::text, 12, '0'))::uuid end,
       case when b.origen = 'presupuesto' then b.origen_id end,
       b.creado_por, 6, 40 + (random() * 100)::numeric(8, 2), null, 40, 'PN-R:2',
       jsonb_build_array(
         jsonb_build_object('product_id', gen_random_uuid(), 'codprod', 'PN-R' || (random() * 200)::int, 'nombre', 'Repuesto', 'cantidad', 2, 'precio_usd', 10, 'price_kind', 'promocion'),
         jsonb_build_object('product_id', gen_random_uuid(), 'codprod', 'PN-R' || (random() * 200)::int, 'nombre', 'Repuesto', 'cantidad', 4, 'precio_usd', 5, 'price_kind', 'estandar'))
  from liminal.saint_borradores b
 -- Solo los borradores sembrados aquí: la base local puede traer otros envíos con su foto (datos demo), y repetirlos choca con la clave de ventas_saint (14/11/2026).
 where b.creado_por in (
   'd0a4e200-0000-0000-0000-0000000000a1'::uuid,
   'd0a4e200-0000-0000-0000-0000000000a2'::uuid,
   'd0a4e200-0000-0000-0000-0000000000a3'::uuid,
   'd0a4e200-0000-0000-0000-0000000000a4'::uuid);

set local session_replication_role = origin;
analyze public.messages;
analyze public.conversations;
analyze public.ventas_saint;
analyze liminal.saint_borradores;

create temporary table _t (rpc text, corrida int, ms numeric, limite_ms numeric);
grant insert on _t to authenticated;

-- Mide una RPC 8 veces como authenticated con la sesión del supervisor. Son 8 a
-- propósito: plpgsql pasa a un plan genérico después de 5 ejecuciones con plan
-- personalizado, y esa sexta llamada fue la que tardó 163 s antes de fijar
-- `plan_cache_mode = force_custom_plan` en las funciones.
create or replace function pg_temp.medir(p_rpc text, p_sql text, p_limite_ms numeric) returns void
language plpgsql as $$
declare
  t0 timestamptz;
  i int;
begin
  for i in 1..8 loop
    t0 := clock_timestamp();
    execute p_sql;
    insert into _t values (p_rpc, i, round((extract(epoch from (clock_timestamp() - t0)) * 1000)::numeric, 1), p_limite_ms);
  end loop;
end $$;

set local role authenticated;
set local "request.jwt.claim.sub" = 'd0a4e200-0000-0000-0000-0000000000b1';

-- Rangos de 30 días: objetivo del plan, 1,5 s. Los de 90 días son el peor caso
-- (el tope de las dos que leen `messages`): se vigilan contra 3 s, a media
-- distancia del `statement_timeout` de 8 s.
select pg_temp.medir('panel_ventas 30 días',         format($q$select public.panel_ventas(%L, %L)$q$, now() - interval '30 days', now()), 1500);
select pg_temp.medir('panel_ventas 90 días',         format($q$select public.panel_ventas(%L, %L)$q$, now() - interval '90 days', now()), 3000);
select pg_temp.medir('panel_conversaciones 30 días', format($q$select public.panel_conversaciones(%L, %L)$q$, now() - interval '30 days', now()), 1500);
select pg_temp.medir('panel_conversaciones 92 días', format($q$select public.panel_conversaciones(%L, %L)$q$, now() - interval '92 days', now()), 3000);
select pg_temp.medir('panel_asesores 30 días',       format($q$select public.panel_asesores(%L, %L)$q$, now() - interval '30 days', now()), 1500);
select pg_temp.medir('panel_asesores 92 días',       format($q$select public.panel_asesores(%L, %L)$q$, now() - interval '92 days', now()), 3000);
select pg_temp.medir('panel_cola',                   'select public.panel_cola()', 1500);
select pg_temp.medir('panel_ventas_activas',         'select public.panel_ventas_activas()', 1500);

reset role;

select rpc, min(ms) as min_ms, max(ms) filter (where corrida > 1) as max_ms_calientes, max(limite_ms) as limite_ms
  from _t group by rpc order by rpc;

do $$
declare
  r record;
begin
  for r in select rpc, max(ms) as ms, max(limite_ms) as lim from _t where corrida > 1 group by rpc having max(ms) > max(limite_ms) loop
    raise exception 'rendimiento: % tardó hasta % ms con la caché caliente (límite % ms)', r.rpc, r.ms, r.lim;
  end loop;
  raise notice 'paneles_rendimiento.sql: todas las RPC dentro de su límite.';
end $$;

rollback;
