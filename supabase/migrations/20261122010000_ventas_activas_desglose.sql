-- ============================================================================
-- `panel_ventas_activas()` cuenta solo lo movido en las últimas 48 h y suma el
-- desglose por origen, equipo y ventana de WhatsApp (22/11/2026).
--
-- Contexto: el panel de "Ventas por cerrar" mezclaba 30 días de presupuestos y 7
-- de carritos, y el supervisor no podía decir qué se podía cerrar HOY. El
-- operador decidió (16/11/2026) que lo de más de 48 h sale del panel (no se
-- borra ni se vacía nada: solo deja de contarse) y pidió ver de dónde viene
-- cada monto y si el cliente todavía puede recibir un mensaje libre.
--
-- Redefine `public.panel_ventas_activas()` (20261113040000, sección 5) con
-- `create or replace`. NINGUNA clave existente cambia de nombre ni de forma
-- (`total`, `presupuestos`, `carritos`, `por_canal`, `antiguedad` y los ocho
-- campos de cada ítem): el código desplegado tiene que seguir funcionando
-- entre esta migración y el deploy. Solo se AGREGAN claves, y el contrato
-- completo vive en `docs/paneles-contrato.md` (hay que tocar las dos puntas,
-- esta función y `src/lib/paneles/*`, en el mismo commit).
--
-- Hechos verificados que fijan las reglas:
--   * La fecha de un presupuesto es `presupuestos.updated_at`, no `created_at`
--     (antes se usaba `created_at` con 30 días). `guardar_presupuesto`
--     (20261021010000) es la ÚNICA que escribe `presupuestos`; al reemplazar los
--     renglones pone `updated_at = now()` (los renglones no se actualizan: se
--     borran y reinsertan dentro de esa RPC), así que cambiar un renglón SÍ
--     mueve la fecha. Un presupuesto armado hace 10 días y retocado ayer cuenta
--     como de ayer, que es lo que el supervisor espera ver.
--   * `equipo` (quién lo armó, por ROL de `agents.role`: `caja` -> `tienda`, el
--     resto -> `online`, sin agente -> `sin_dato`) es un eje APARTE de `canal`
--     (por flujo: `presupuestos.origen`, que no cambia). Un presupuesto de
--     Inventario armado por un asesor es `canal = tienda` y `equipo = online`:
--     son dos preguntas distintas ("¿desde dónde?" y "¿quién?") y mezclarlas en
--     un solo eje esconde justo ese caso. En un carrito, el equipo es el del
--     `added_by` del renglón con `updated_at` más reciente: el MISMO agente que
--     da `responsable`.
--   * La ventana de 24 h de WhatsApp sale de `conversations.last_customer_message_at`,
--     la misma fuente que `isWithin24hWindow` (`src/lib/whatsapp-window.ts`:
--     abierta si `now - last < 24 h`). Un rechazo 131047 de Meta ya empuja esa
--     columna hacia atrás (candados de 20260907010000), así que no hace falta
--     mirarlo aparte. `por_cerrar` = quedan menos de 4 h.
--   * `presupuestos.conversation_id` puede venir lleno con origen `inventario`
--     según el esquema, pero la app nunca lo hace (`carrito-panel.tsx` pasa
--     `null`). Regla: si el presupuesto tiene conversación se mide su ventana;
--     si no, la ventana es `no_aplica`.
--   * `fuera_de_ventana` cuenta (solo cantidades, sin valuar) lo que cumpliría
--     todo lo anterior salvo estar a más de 48 h. Para no contar una
--     conversación dos veces, un carrito viejo NO suma si esa conversación tiene
--     un presupuesto `chat` sin enviar de cualquier fecha: la representa su
--     presupuesto.
--   * `monto` de una celda es null solo si NINGÚN ítem de la celda tiene monto
--     (`case when count(i.monto) = 0 then null else sum(i.monto) end`): así la
--     suma de los montos de `por_origen` da `total`, y la pantalla pinta "—" y
--     no un cero que parezca verdad.
--
-- Valuación sin cambios: `precio_venta_usd_base` con la tasa vigente y la tarifa
-- MRW del peso. `antiguedad` conserva sus cuatro tramos (`24h`, `3d`, `7d`,
-- `30d`) porque `src/lib/paneles/parse.ts` desplegado los valida; con la
-- ventana de 48 h solo se llenan `24h` y `3d`. `items` pasa de 30 a 300.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. Es
-- re-ejecutable (`create or replace`).
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

create or replace function public.panel_ventas_activas()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set timezone = 'America/Caracas'
set plan_cache_mode = force_custom_plan
as $$
declare
  -- Lo movido hace más que esto sale del panel (no se borra nada).
  v_ventana constant interval := interval '48 hours';
  -- Cuánto antes de cerrarse la ventana de WhatsApp se marca `por_cerrar`.
  v_aviso_cierre constant interval := interval '4 hours';
  -- La ventana de mensajes libres de Meta: fija, no es una decisión nuestra.
  v_ventana_wa constant interval := interval '24 hours';
  v_max_items constant integer := 300;
  v_resultado jsonb;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  with
  -- Tasa vigente (la de `rate_date` más alto); sin ella, los renglones en
  -- bolívares quedan sin precio.
  tasa as (
    select case when er.usd_to_ves > 0 then er.usd_to_ves end as t
      from public.exchange_rates er
     order by er.rate_date desc
     limit 1
  ),
  -- Presupuestos movidos dentro de la ventana (`updated_at`) sin un borrador
  -- `creado` o en tránsito.
  pres as materialized (
    select p.id, p.origen, p.updated_at as desde, p.created_by, p.conversation_id,
           btrim(p.cliente_nombre || ' ' || p.cliente_apellido) as cliente
      from public.presupuestos p
     where p.updated_at >= now() - v_ventana
       and not exists (
         select 1 from liminal.saint_borradores b
          where b.origen = 'presupuesto' and b.origen_id = p.id
            and b.estado in ('creado', 'pendiente', 'procesando'))
  ),
  pres_lin as (
    select pr.id, pi.quantity,
           public.precio_venta_usd_base(pd, pi.price_kind, (select t from tasa), tf.tarifa) as precio
      from pres pr
      join public.presupuesto_items pi on pi.presupuesto_id = pr.id
      join public.products pd on pd.id = pi.product_id
      left join lateral (
        select r.tarifa_usd as tarifa
          from public.shipping_rates r
         where r.carrier = 'mrw'
           and pd.weight_kg is not null and pd.weight_kg > 0 and pd.weight_kg < 80
           and r.desde_kg <= pd.weight_kg and pd.weight_kg < r.hasta_kg
         limit 1
      ) tf on true
  ),
  pres_item as (
    select 'presupuesto'::text as tipo, pr.id,
           case pr.origen when 'chat' then 'online' else 'tienda' end as canal,
           case pr.origen when 'chat' then 'presupuesto_chat' else 'presupuesto_inventario' end as origen,
           case when a.id is null then 'sin_dato'
                when a.role = 'caja' then 'tienda'
                else 'online' end as equipo,
           a.display_name as responsable,
           pr.cliente,
           case when count(*) filter (where l.precio is null) > 0 then null
                else round(sum(l.quantity * l.precio), 2) end as monto,
           (count(*) filter (where l.precio is null))::int as sin_precio,
           coalesce(sum(l.quantity), 0)::int as unidades,
           pr.desde,
           pr.conversation_id,
           co.last_customer_message_at
      from pres pr
      join pres_lin l on l.id = pr.id
      left join public.agents a on a.id = pr.created_by
      left join public.conversations co on co.id = pr.conversation_id
     group by pr.id, pr.origen, a.id, a.role, a.display_name, pr.cliente, pr.desde,
              pr.conversation_id, co.last_customer_message_at
  ),
  -- Carritos del chat: último cambio por conversación (sin tope de fecha; la
  -- ventana la aplican las dos ramas de abajo).
  carr as materialized (
    select ci.conversation_id, max(ci.updated_at) as desde
      from public.conversation_cart_items ci
     group by ci.conversation_id
  ),
  -- Activos: cambiados dentro de la ventana, sin un envío posterior al cambio y
  -- sin un presupuesto `chat` activo en la misma conversación.
  carr_act as materialized (
    select c.conversation_id, c.desde
      from carr c
     where c.desde >= now() - v_ventana
       and not exists (
             select 1 from liminal.saint_borradores b
              where b.origen = 'carrito' and b.origen_id = c.conversation_id
                and b.estado in ('creado', 'pendiente', 'procesando')
                and b.created_at > c.desde)
       and not exists (
             select 1 from pres p
              where p.origen = 'chat' and p.conversation_id = c.conversation_id)
  ),
  carr_lin as (
    select ca.conversation_id, ci.quantity,
           public.precio_venta_usd_base(pd, ci.price_kind, (select t from tasa), tf.tarifa) as precio
      from carr_act ca
      join public.conversation_cart_items ci on ci.conversation_id = ca.conversation_id
      join public.products pd on pd.id = ci.product_id
      left join lateral (
        select r.tarifa_usd as tarifa
          from public.shipping_rates r
         where r.carrier = 'mrw'
           and pd.weight_kg is not null and pd.weight_kg > 0 and pd.weight_kg < 80
           and r.desde_kg <= pd.weight_kg and pd.weight_kg < r.hasta_kg
         limit 1
      ) tf on true
  ),
  carr_item as (
    select 'carrito'::text as tipo, ca.conversation_id as id,
           'online'::text as canal,
           'carrito_chat'::text as origen,
           case when ul.agent_id is null then 'sin_dato'
                when ul.role = 'caja' then 'tienda'
                else 'online' end as equipo,
           ul.display_name as responsable,
           coalesce(nullif(btrim(ct.display_name), ''), nullif(btrim(ct.profile_name), ''), ct.phone_number) as cliente,
           case when count(*) filter (where l.precio is null) > 0 then null
                else round(sum(l.quantity * l.precio), 2) end as monto,
           (count(*) filter (where l.precio is null))::int as sin_precio,
           coalesce(sum(l.quantity), 0)::int as unidades,
           ca.desde,
           ca.conversation_id,
           co.last_customer_message_at
      from carr_act ca
      join carr_lin l on l.conversation_id = ca.conversation_id
      left join public.conversations co on co.id = ca.conversation_id
      left join public.contacts ct on ct.id = co.contact_id
      -- Quien tocó por última vez el carrito: da `responsable` y `equipo`.
      left join lateral (
        select ag.id as agent_id, ag.display_name, ag.role
          from public.conversation_cart_items u
          left join public.agents ag on ag.id = u.added_by
         where u.conversation_id = ca.conversation_id
         order by u.updated_at desc, u.id
         limit 1
      ) ul on true
     group by ca.conversation_id, ca.desde, ct.display_name, ct.profile_name, ct.phone_number,
              ul.agent_id, ul.display_name, ul.role, co.last_customer_message_at
  ),
  items as materialized (
    select u.tipo, u.id, u.canal, u.origen, u.equipo, u.responsable, u.cliente, u.monto,
           u.sin_precio, u.unidades, u.desde, u.conversation_id,
           u.last_customer_message_at + v_ventana_wa as ventana_hasta,
           case
             when u.conversation_id is null then 'no_aplica'
             when u.last_customer_message_at is null
               or u.last_customer_message_at + v_ventana_wa <= now() then 'cerrada'
             when u.last_customer_message_at + v_ventana_wa - now() < v_aviso_cierre then 'por_cerrar'
             else 'abierta'
           end as ventana
      from (
        select * from pres_item
        union all
        select * from carr_item
      ) u
  ),
  con_tramo as (
    select i.*,
           case
             when i.desde >= now() - interval '1 day' then '24h'
             when i.desde >= now() - interval '3 days' then '3d'
             when i.desde >= now() - interval '7 days' then '7d'
             else '30d'
           end as tramo,
           case
             when i.desde >= now() - interval '12 hours' then '12h'
             when i.desde >= now() - interval '24 hours' then '24h'
             else '48h'
           end as tramo48
      from items i
  ),
  -- Lo que quedó fuera de la ventana: solo se cuenta, nunca se valúa.
  fuera as (
    select 'presupuesto'::text as tipo,
           case p.origen when 'chat' then 'presupuesto_chat' else 'presupuesto_inventario' end as origen
      from public.presupuestos p
     where p.updated_at < now() - v_ventana
       and exists (select 1 from public.presupuesto_items pi where pi.presupuesto_id = p.id)
       and not exists (
         select 1 from liminal.saint_borradores b
          where b.origen = 'presupuesto' and b.origen_id = p.id
            and b.estado in ('creado', 'pendiente', 'procesando'))
    union all
    select 'carrito'::text, 'carrito_chat'::text
      from carr c
     where c.desde < now() - v_ventana
       and not exists (
             select 1 from liminal.saint_borradores b
              where b.origen = 'carrito' and b.origen_id = c.conversation_id
                and b.estado in ('creado', 'pendiente', 'procesando')
                and b.created_at > c.desde)
       -- La conversación la representa su presupuesto `chat` sin enviar (de
       -- cualquier fecha): no se cuenta dos veces.
       and not exists (
             select 1 from public.presupuestos p
              where p.origen = 'chat' and p.conversation_id = c.conversation_id
                and not exists (
                  select 1 from liminal.saint_borradores b
                   where b.origen = 'presupuesto' and b.origen_id = p.id
                     and b.estado in ('creado', 'pendiente', 'procesando')))
  )
  select jsonb_build_object(
    'total', (select case when count(i.monto) = 0 then null else sum(i.monto) end from items i),
    'presupuestos', (
      select jsonb_build_object(
               'monto', case when count(i.monto) = 0 then null else sum(i.monto) end,
               'cantidad', count(*)::int,
               'sin_precio', coalesce(sum(i.sin_precio), 0)::int)
        from items i where i.tipo = 'presupuesto'
    ),
    'carritos', (
      select jsonb_build_object(
               'monto', case when count(i.monto) = 0 then null else sum(i.monto) end,
               'cantidad', count(*)::int,
               'sin_precio', coalesce(sum(i.sin_precio), 0)::int)
        from items i where i.tipo = 'carrito'
    ),
    'por_canal', (
      select jsonb_object_agg(c.canal, jsonb_build_object(
               'monto', (select case when count(i.monto) = 0 then null else sum(i.monto) end from items i where i.canal = c.canal),
               'cantidad', (select count(*)::int from items i where i.canal = c.canal)))
        from (values ('online'), ('tienda')) c(canal)
    ),
    'antiguedad', (
      select jsonb_agg(jsonb_build_object(
               'tramo', t.tramo,
               'monto', (select case when count(x.monto) = 0 then null else sum(x.monto) end from con_tramo x where x.tramo = t.tramo),
               'cantidad', (select count(*)::int from con_tramo x where x.tramo = t.tramo)) order by t.ord)
        from (values ('24h', 1), ('3d', 2), ('7d', 3), ('30d', 4)) t(tramo, ord)
    ),
    'tramos_48h', (
      select jsonb_agg(jsonb_build_object(
               'tramo', t.tramo,
               'monto', (select case when count(x.monto) = 0 then null else sum(x.monto) end from con_tramo x where x.tramo48 = t.tramo),
               'cantidad', (select count(*)::int from con_tramo x where x.tramo48 = t.tramo)) order by t.ord)
        from (values ('12h', 1), ('24h', 2), ('48h', 3)) t(tramo, ord)
    ),
    'fuera_de_ventana', (
      select jsonb_build_object(
               'carritos', count(*) filter (where f.tipo = 'carrito')::int,
               'presupuestos', count(*) filter (where f.tipo = 'presupuesto')::int,
               'por_origen', jsonb_build_object(
                 'carrito_chat', count(*) filter (where f.origen = 'carrito_chat')::int,
                 'presupuesto_chat', count(*) filter (where f.origen = 'presupuesto_chat')::int,
                 'presupuesto_inventario', count(*) filter (where f.origen = 'presupuesto_inventario')::int))
        from fuera f
    ),
    'por_origen', (
      select jsonb_object_agg(o.k, jsonb_build_object(
               'monto', c.monto, 'cantidad', c.cantidad, 'sin_precio', c.sin_precio))
        from (values ('carrito_chat'), ('presupuesto_chat'), ('presupuesto_inventario')) o(k)
        cross join lateral (
          select case when count(i.monto) = 0 then null else sum(i.monto) end as monto,
                 count(*)::int as cantidad,
                 coalesce(sum(i.sin_precio), 0)::int as sin_precio
            from items i where i.origen = o.k) c
    ),
    'por_equipo', (
      select jsonb_object_agg(e.k, jsonb_build_object('monto', c.monto, 'cantidad', c.cantidad))
        from (values ('online'), ('tienda'), ('sin_dato')) e(k)
        cross join lateral (
          select case when count(i.monto) = 0 then null else sum(i.monto) end as monto,
                 count(*)::int as cantidad
            from items i where i.equipo = e.k) c
    ),
    'por_origen_equipo', (
      select jsonb_object_agg(o.k, (
               select jsonb_object_agg(e.k, jsonb_build_object('monto', c.monto, 'cantidad', c.cantidad))
                 from (values ('online'), ('tienda'), ('sin_dato')) e(k)
                 cross join lateral (
                   select case when count(i.monto) = 0 then null else sum(i.monto) end as monto,
                          count(*)::int as cantidad
                     from items i where i.origen = o.k and i.equipo = e.k) c))
        from (values ('carrito_chat'), ('presupuesto_chat'), ('presupuesto_inventario')) o(k)
    ),
    'por_ventana', (
      select jsonb_object_agg(w.k, jsonb_build_object('monto', c.monto, 'cantidad', c.cantidad))
        from (values ('abierta'), ('por_cerrar'), ('cerrada'), ('no_aplica')) w(k)
        cross join lateral (
          select case when count(i.monto) = 0 then null else sum(i.monto) end as monto,
                 count(*)::int as cantidad
            from items i where i.ventana = w.k) c
    ),
    'por_canal_ventana', (
      select jsonb_object_agg(ch.k, (
               select jsonb_object_agg(w.k, jsonb_build_object('monto', c.monto, 'cantidad', c.cantidad))
                 from (values ('abierta'), ('por_cerrar'), ('cerrada'), ('no_aplica')) w(k)
                 cross join lateral (
                   select case when count(i.monto) = 0 then null else sum(i.monto) end as monto,
                          count(*)::int as cantidad
                     from items i where i.canal = ch.k and i.ventana = w.k) c))
        from (values ('online'), ('tienda')) ch(k)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tipo', o.tipo,
               'id', o.id,
               'canal', o.canal,
               'origen', o.origen,
               'equipo', o.equipo,
               'responsable', o.responsable,
               'cliente', o.cliente,
               'monto', o.monto,
               'unidades', o.unidades,
               'desde', o.desde,
               'conversation_id', o.conversation_id,
               'ventana_hasta', o.ventana_hasta,
               'ventana', o.ventana) order by o.desde, o.id)
        from (select * from items order by desde, id limit v_max_items) o
    ), '[]'::jsonb)
  ) into v_resultado;

  return v_resultado;
end;
$$;

comment on function public.panel_ventas_activas() is
  'Ventas por cerrar AHORA (plan "Paneles", M4, 13/11/2026; ventana de 48 h y desglose, 22/11/2026): presupuestos (fecha = updated_at) y carritos del chat movidos en las últimas 48 h y sin enviar a SAINT, valuados al precio de hoy con precio_venta_usd_base. Un renglón sin precio deja el monto del ítem en null (nunca un parcial). Desglose por origen (carrito_chat, presupuesto_chat, presupuesto_inventario), por equipo (quién lo armó, por rol: caja = tienda; eje aparte de canal, que es por flujo), por ventana de WhatsApp de 24 h (abierta, por_cerrar a menos de 4 h, cerrada, no_aplica sin conversación), tramos de 12/24/48 h y lo que quedó fuera de la ventana (solo cantidades). Hasta 300 ítems. Contrato en docs/paneles-contrato.md. Solo supervisor/admin (42501).';

-- ---------------------------------------------------------------------------
-- Permisos: los DOS revokes y el grant (CLAUDE.md, "Convenciones").
-- ---------------------------------------------------------------------------
revoke execute on function public.panel_ventas_activas() from public;
revoke execute on function public.panel_ventas_activas() from anon, authenticated;
grant execute on function public.panel_ventas_activas() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
declare
  f constant text := 'public.panel_ventas_activas()';
begin
  if to_regprocedure(f) is null then
    raise exception '20261122010000: no existe %', f;
  end if;
  if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('public', f, 'EXECUTE') then
    raise exception '20261122010000: anon o PUBLIC pueden ejecutar %', f;
  end if;
  if not has_function_privilege('authenticated', f, 'EXECUTE')
     or not has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception '20261122010000: authenticated y service_role deben poder ejecutar %', f;
  end if;
  if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
    raise exception '20261122010000: % debía quedar security definer', f;
  end if;

  raise notice '20261122010000: autoverificación de panel_ventas_activas correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
