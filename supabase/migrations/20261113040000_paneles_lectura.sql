-- ============================================================================
-- Las cinco RPC de lectura de los paneles (13/11/2026), plan "Paneles", M4.
--
-- Contexto: Dashboard de ventas, Analíticas y Asesores (solo supervisor/admin)
-- leen todo por RPC, nunca con un `select` directo. La forma exacta del jsonb
-- vive en `docs/paneles-contrato.md`; cambiar una clave exige tocar las dos
-- puntas (esta migración y `src/lib/paneles/*`) y ese archivo en el mismo commit.
--
--   · panel_ventas(p_desde, p_hasta)          ventas por canal, serie, perfil
--                                             horario, personas, top de repuestos,
--                                             tipo de precio, estado, recurrentes.
--   · panel_conversaciones(p_desde, p_hasta)  embudo, resultados, conversión por
--                                             persona y calor (solo chat/online).
--   · panel_asesores(p_desde, p_hasta)        actividad, primera respuesta,
--                                             envíos y reasignaciones por persona.
--   · panel_cola()                            pendientes de respuesta AHORA.
--   · panel_ventas_activas()                  presupuestos y carritos sin enviar.
--
-- TODAS son `security definer` con `is_supervisor_or_admin()` comprobado UNA
-- vez (si no, 42501) y los dos revokes + grant (CLAUDE.md, "Convenciones"). Por
-- qué definer y no invoker: `messages` y `ventas_saint` se leen por miles de
-- filas, y una política por fila (`is_agent()` / ninguna política en
-- `ventas_saint`) es la trampa que tumbó la búsqueda de /inbox 48 h
-- (`20260921030000`: 75 ms como superusuario, 1.468 ms como `authenticated`).
-- Medido como `authenticated` en `supabase/tests/paneles_rendimiento.sql`.
--
-- Decisiones donde el contrato no decía todo (13/11/2026):
--   * Un rango es SEMIABIERTO: [p_desde, p_hasta). Un envío o mensaje a las
--     00:00:00 exactas de p_hasta cae en el rango siguiente.
--   * Una "venta" se fecha por `ventas_saint.created_at` (el momento del envío a
--     SAINT, copia de `saint_borradores.created_at`), no por `procesado_at`.
--   * Una venta es un envío `creado` que NO es duplicado, y el duplicado lo
--     decide la vista `public.ventas_saint_estado` (M1) AL LEER, contra el estado
--     ACTUAL de cada envío (corrección del 15/11/2026): `creado` con otro
--     `creado` anterior del mismo origen o conversación, mismos ítems y menos
--     de 24 h. Marcarlo al insertar hacía desaparecer la venta de quien corregía
--     una cédula y reenviaba tras un `error`. Ninguna RPC repite la regla.
--   * `canales.*.ingresos` vale 0 si no hubo ventas y null si las hubo pero
--     ninguna tiene monto. En el resto (`personas`, `monto` de asesores, de
--     tránsito y de las activas) null = "no hay nada que sumar" y la pantalla
--     pinta "—".
--   * `tipo_precio` cuenta UNIDADES (no renglones ni envíos) por tipo de precio.
--   * `con_carrito` del embudo incluye a quien compró aunque su carrito ya se
--     vaciara al vender: sin eso el embudo no sería monótono (un carrito se
--     borra al cerrar la venta). El reclamo mira la etiqueta sin acentos NI
--     mayúsculas con acento (`translate` antes de `lower`: en una base con
--     collation C `lower('Ó')` no baja la Ó).
--   * Las respuestas se buscan hasta p_hasta: una respuesta posterior al rango
--     no cuenta como "respondida" dentro de él.
--   * `equipo` de `panel_asesores`: `episodios` cuenta todos los iniciados en el
--     rango; la mediana y `en_5min` usan solo los que alguien respondió.
--
-- `set plan_cache_mode = force_custom_plan` en las cinco: plpgsql guarda el plan
-- de cada consulta y, tras 5 ejecuciones con plan personalizado, puede pasarse a
-- un plan GENÉRICO que no conoce el rango de fechas. Medido el 13/11/2026 con
-- 300 mil mensajes: la sexta llamada de `panel_asesores` pasó de 1,4 s a 163 s
-- (un bucle anidado sobre estimaciones de 6 filas). Con la sesión del panel
-- (una conexión reutilizada por PostgREST) no es hipotético.
--
-- `set enable_nestloop = off` en `panel_conversaciones` y `panel_asesores`: los
-- CTE intermedios (episodios, respuestas) los estima el planificador en 1 fila, y
-- con esa estimación elige un bucle anidado: con un rango de 3 días y 300 mil
-- mensajes en la tabla, `panel_asesores` tardó 6,5 s (27 millones de
-- comparaciones) contra 0,15 s con un hash join. Son consultas de agregación
-- sobre miles de filas: ninguna se beneficia de un bucle anidado. El único
-- `join lateral` (el antecedente de cada conversación, con `limit 1` contra el
-- índice) no tiene otro plan posible y sigue funcionando.
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

-- ---------------------------------------------------------------------------
-- 1. panel_ventas
-- ---------------------------------------------------------------------------
create or replace function public.panel_ventas(p_desde timestamptz, p_hasta timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set timezone = 'America/Caracas'
set plan_cache_mode = force_custom_plan
as $$
declare
  v_tz constant text := 'America/Caracas';
  v_gran text;
  v_unit text;
  v_step interval;
  v_resultado jsonb;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde then
    raise exception 'rango inválido: p_hasta debe ser posterior a p_desde' using errcode = '22023';
  end if;

  v_gran := case
    when p_hasta - p_desde <= interval '1 day' then 'hora'
    when p_hasta - p_desde > interval '92 days' then 'mes'
    else 'dia'
  end;
  v_unit := case v_gran when 'hora' then 'hour' when 'dia' then 'day' else 'month' end;
  v_step := ('1 ' || v_unit)::interval;

  with
  -- La vista `ventas_saint_estado` se lee UNA sola vez por llamada (15/11/2026):
  -- calcular `duplicado` es una pasada sobre todo el historial (ver M1), y leerla
  -- tres veces (el rango, los clientes genéricos, las compras previas) triplicaba
  -- el costo. De aquí salen las tres: columnas angostas, todo el historial hasta
  -- p_hasta.
  hist as materialized (
    select e.borrador_id, e.created_at, e.estado, e.duplicado, e.codclie,
           e.cedula_tipo, e.cedula_numero, e.cliente_creado
      from public.ventas_saint_estado e
     where e.created_at < p_hasta
  ),
  -- Toda foto del rango con el estado de su borrador (y los datos del cliente).
  -- Las columnas anchas (renglones, montos) salen de la tabla por su clave: la
  -- regla de venta/duplicado sigue viniendo solo de la vista.
  v as materialized (
    select vs.borrador_id, vs.created_at, vs.canal, vs.enviado_por, vs.unidades, vs.monto_usd,
           vs.estimado, vs.lineas, hi.duplicado,
           hi.estado, hi.cedula_tipo, hi.cedula_numero, hi.codclie, hi.cliente_creado
      from hist hi
      join public.ventas_saint vs on vs.borrador_id = hi.borrador_id
     where hi.created_at >= p_desde
  ),
  -- Venta = `creado` (factura en espera en SAINT) y no duplicado. El duplicado
  -- lo decide la vista `ventas_saint_estado` contra el estado ACTUAL de cada
  -- envío (15/11/2026): un `error` o un envío en tránsito nunca lo causa.
  ventas as materialized (
    select * from v where estado = 'creado' and not duplicado
  ),
  canal_agg as (
    select c.canal,
           count(vv.borrador_id)::int as envios,
           coalesce(sum(vv.unidades), 0)::int as unidades,
           count(vv.monto_usd)::int as n_monto,
           sum(vv.monto_usd) as ingresos,
           (count(*) filter (where vv.borrador_id is not null and vv.estimado))::int as estimados,
           (count(*) filter (where vv.borrador_id is not null and vv.monto_usd is null))::int as sin_monto
      from (values ('online'), ('tienda')) c(canal)
      left join ventas vv on vv.canal = c.canal
     group by c.canal
  ),
  -- Tramos del rango en hora de Caracas (con los vacíos).
  tramos as (
    select g as t_local
      from generate_series(
             date_trunc(v_unit, p_desde at time zone v_tz),
             date_trunc(v_unit, (p_hasta - interval '1 microsecond') at time zone v_tz),
             v_step) g
  ),
  por_tramo as (
    select date_trunc(v_unit, vv.created_at at time zone v_tz) as t_local,
           vv.canal,
           sum(vv.monto_usd) as monto,
           count(*)::int as envios
      from ventas vv
     group by 1, 2
  ),
  serie_filas as (
    select t.t_local,
           coalesce(sum(p.monto) filter (where p.canal = 'online'), 0) as online,
           coalesce(sum(p.monto) filter (where p.canal = 'tienda'), 0) as tienda,
           coalesce(sum(p.envios) filter (where p.canal = 'online'), 0)::int as envios_online,
           coalesce(sum(p.envios) filter (where p.canal = 'tienda'), 0)::int as envios_tienda
      from tramos t
      left join por_tramo p on p.t_local = t.t_local
     group by t.t_local
  ),
  -- Montos por hora de Caracas y por día (solo se usa con granularidad `dia`).
  horario as (
    select (vv.created_at at time zone v_tz)::date as dia,
           extract(hour from vv.created_at at time zone v_tz)::int as hora,
           vv.canal,
           sum(vv.monto_usd) as monto
      from ventas vv
     where v_gran = 'dia'
     group by 1, 2, 3
  ),
  -- Una sola pasada: rejilla día x hora (24) con los montos de cada canal, y de
  -- ahí un arreglo de 24 por día. (Una versión con subconsultas correlacionadas
  -- por día y hora tardaba 770 ms con 91 días: 2.184 recorridos de `horario`.)
  perfil_dia as (
    select g.dia,
           jsonb_agg(g.online order by g.hh) as online,
           jsonb_agg(g.tienda order by g.hh) as tienda
      from (
        select t.t_local::date as dia, hh.hh,
               coalesce(sum(h.monto) filter (where h.canal = 'online'), 0) as online,
               coalesce(sum(h.monto) filter (where h.canal = 'tienda'), 0) as tienda
          from tramos t
          cross join generate_series(0, 23) hh(hh)
          left join horario h on h.dia = t.t_local::date and h.hora = hh.hh
         where v_gran = 'dia'
         group by t.t_local::date, hh.hh
      ) g
     group by g.dia
  ),
  personas_agg as (
    select vv.enviado_por, vv.canal,
           count(*)::int as envios,
           coalesce(sum(vv.unidades), 0)::int as unidades,
           sum(vv.monto_usd) as ingresos
      from ventas vv
     group by 1, 2
  ),
  -- Una fila por renglón de cada foto: de ahí salen el top y el tipo de precio.
  lin as materialized (
    select l.codprod, l.nombre, l.cantidad, l.precio_usd, l.price_kind, vv.canal
      from ventas vv,
           jsonb_to_recordset(vv.lineas) as l(codprod text, nombre text, cantidad int, precio_usd numeric, price_kind text)
  ),
  top_filas as (
    select l.codprod,
           max(l.nombre) as nombre,
           coalesce(sum(l.cantidad), 0)::int as unidades,
           sum(l.cantidad * l.precio_usd) as ingresos,
           coalesce(sum(l.cantidad) filter (where l.canal = 'online'), 0)::int as unidades_online,
           coalesce(sum(l.cantidad) filter (where l.canal = 'tienda'), 0)::int as unidades_tienda
      from lin l
     group by l.codprod
     order by sum(l.cantidad * l.precio_usd) desc nulls last, sum(l.cantidad) desc, l.codprod
     limit 15
  ),
  tipo_agg as (
    select c.canal,
           coalesce(sum(l.cantidad) filter (where l.price_kind = 'promocion'), 0)::int as promocion,
           coalesce(sum(l.cantidad) filter (where l.price_kind = 'estandar'), 0)::int as estandar
      from (values ('online'), ('tienda')) c(canal)
      left join lin l on l.canal = c.canal
     group by c.canal
  ),
  -- Recurrentes. Genérico = un `codclie` con 20 o más ventas en los 30 días que
  -- terminan en p_hasta (el cliente "varios" de la caja): no es un comprador.
  gen as materialized (
    select hi.codclie
      from hist hi
     where hi.estado = 'creado' and not hi.duplicado and hi.codclie is not null
       and hi.created_at >= p_hasta - interval '30 days'
     group by hi.codclie
    having count(*) >= 20
  ),
  compradores as materialized (
    select vv.canal, upper(btrim(vv.cedula_tipo || vv.cedula_numero)) as k
      from ventas vv
     where vv.codclie is null or vv.codclie not in (select g.codclie from gen g)
     group by 1, 2
  ),
  -- Ya estaba en SAINT: algún borrador suyo del rango salió con `cliente_creado = false`.
  ya_existian as materialized (
    select distinct upper(btrim(b.cedula_tipo || b.cedula_numero)) as k
      from liminal.saint_borradores b
     where b.created_at >= p_desde and b.created_at < p_hasta and b.cliente_creado = false
  ),
  -- O tuvo una venta antes del rango.
  previas as materialized (
    select distinct upper(btrim(hi.cedula_tipo || hi.cedula_numero)) as k
      from hist hi
     where hi.estado = 'creado' and not hi.duplicado and hi.created_at < p_desde
       and upper(btrim(hi.cedula_tipo || hi.cedula_numero)) in (select c.k from compradores c)
  ),
  recurrentes_agg as (
    select c.canal, c.k,
           (c.k in (select p.k from previas p) or c.k in (select y.k from ya_existian y)) as regresa
      from compradores c
  )
  select jsonb_build_object(
    'granularidad', v_gran,
    'canales', (
      select jsonb_object_agg(a.canal, jsonb_build_object(
               'ingresos', case when a.envios = 0 then 0 when a.n_monto = 0 then null else a.ingresos end,
               'envios', a.envios,
               'unidades', a.unidades,
               'ticket', case when a.n_monto = 0 then null else round(a.ingresos / a.n_monto, 2) end,
               'estimados', a.estimados,
               'sin_monto', a.sin_monto))
        from canal_agg a
    ),
    'serie', coalesce((
      select jsonb_agg(jsonb_build_object(
               't', s.t_local at time zone v_tz,
               'online', s.online,
               'tienda', s.tienda,
               'envios_online', s.envios_online,
               'envios_tienda', s.envios_tienda) order by s.t_local)
        from serie_filas s
    ), '[]'::jsonb),
    'perfil_horario', case
      when v_gran = 'dia' then coalesce((
        select jsonb_agg(jsonb_build_object(
                 'dia', to_char(pd.dia, 'YYYY-MM-DD'),
                 'online', pd.online,
                 'tienda', pd.tienda) order by pd.dia)
          from perfil_dia pd
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'personas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'agent_id', p.enviado_por,
               'nombre', coalesce(a.display_name, 'Sin nombre'),
               'rol', a.role,
               'canal', p.canal,
               'ingresos', p.ingresos,
               'envios', p.envios,
               'unidades', p.unidades)
             order by p.ingresos desc nulls last, p.envios desc, a.display_name, p.canal)
        from personas_agg p
        left join public.agents a on a.id = p.enviado_por
    ), '[]'::jsonb),
    'top_repuestos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'codprod', f.codprod,
               'nombre', f.nombre,
               'unidades', f.unidades,
               'ingresos', f.ingresos,
               'unidades_online', f.unidades_online,
               'unidades_tienda', f.unidades_tienda)
             order by f.ingresos desc nulls last, f.unidades desc, f.codprod)
        from top_filas f
    ), '[]'::jsonb),
    'tipo_precio', (
      select jsonb_object_agg(t.canal, jsonb_build_object('promocion', t.promocion, 'estandar', t.estandar))
        from tipo_agg t
    ),
    'estado', jsonb_build_object(
      'transito', (
        select jsonb_build_object(
                 'envios', count(*)::int,
                 'monto', case when count(x.monto_usd) = 0 then null else sum(x.monto_usd) end)
          from v x
         where x.estado in ('pendiente', 'procesando')
      ),
      'error', jsonb_build_object(
        'envios', (select count(*)::int from v x where x.estado = 'error')
      ),
      -- Envíos del rango que no dejaron foto (los de antes de la M1 o los que el
      -- trigger no alcanzó a escribir): el backfill los recupera.
      'sin_foto', (
        select count(*)::int
          from liminal.saint_borradores b
         where b.created_at >= p_desde and b.created_at < p_hasta
           and not exists (select 1 from public.ventas_saint vs where vs.borrador_id = b.id)
      ),
      'duplicados', (select count(*)::int from v x where x.duplicado)
    ),
    'recurrentes', jsonb_build_object(
      'online', jsonb_build_object(
        'compradores', (select count(*)::int from recurrentes_agg r where r.canal = 'online'),
        'regresan', (select count(*)::int from recurrentes_agg r where r.canal = 'online' and r.regresa)),
      'tienda', jsonb_build_object(
        'compradores', (select count(*)::int from recurrentes_agg r where r.canal = 'tienda'),
        'regresan', (select count(*)::int from recurrentes_agg r where r.canal = 'tienda' and r.regresa)),
      'genericos_excluidos', (
        select count(distinct vv.codclie)::int from ventas vv where vv.codclie in (select g.codclie from gen g))
    )
  ) into v_resultado;

  return v_resultado;
end;
$$;

comment on function public.panel_ventas(timestamptz, timestamptz) is
  'Dashboard de ventas (plan "Paneles", M4, 13/11/2026): ventas por canal, serie por hora/día/mes, perfil horario, personas, top de repuestos, tipo de precio, estado y recurrentes. Contrato en docs/paneles-contrato.md. Rango [p_desde, p_hasta). Solo supervisor/admin (42501).';

-- ---------------------------------------------------------------------------
-- 2. panel_conversaciones
-- ---------------------------------------------------------------------------
create or replace function public.panel_conversaciones(p_desde timestamptz, p_hasta timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set timezone = 'America/Caracas'
set enable_nestloop = off
set plan_cache_mode = force_custom_plan
as $$
declare
  v_tz constant text := 'America/Caracas';
  v_resultado jsonb;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde then
    raise exception 'rango inválido: p_hasta debe ser posterior a p_desde' using errcode = '22023';
  end if;
  if p_hasta - p_desde > interval '92 days' then
    raise exception 'rango demasiado largo: el máximo son 92 días' using errcode = '22023';
  end if;

  with
  -- Los dos predicados de abajo repiten, tal cual, los de los índices parciales
  -- `messages_entrantes_fecha_idx` / `messages_salientes_fecha_idx` (M3): sin
  -- eso el planificador no los puede usar.
  ent as materialized (
    select m.conversation_id, m.created_at
      from public.messages m
     where m.sender_type = 'customer'
       and m.created_at >= p_desde and m.created_at < p_hasta
  ),
  sal as materialized (
    select m.conversation_id, m.sender_type, m.sender_agent_id, m.created_at
      from public.messages m
     where m.sender_type in ('agent', 'ai') and not m.is_internal_note
       and m.created_at >= p_desde and m.created_at < p_hasta
  ),
  -- Conversaciones con al menos un mensaje del cliente en el rango.
  clientes as materialized (
    select e.conversation_id, min(e.created_at) as primer
      from ent e
     group by e.conversation_id
  ),
  -- Ventas del chat con 7 días de cola para medir la conversión tras la respuesta.
  ventas_ventana as materialized (
    select vs.conversation_id, vs.created_at
      from public.ventas_saint_estado vs
     where vs.conversation_id is not null
       and vs.estado = 'creado' and not vs.duplicado
       and vs.created_at >= p_desde and vs.created_at < p_hasta + interval '7 days'
  ),
  resp as (
    select s.conversation_id
      from sal s
      join clientes cl on cl.conversation_id = s.conversation_id
     where s.created_at > cl.primer
     group by s.conversation_id
  ),
  comp as (
    select distinct vt.conversation_id
      from ventas_ventana vt
     where vt.created_at >= p_desde and vt.created_at < p_hasta
  ),
  carr as (
    select distinct ci.conversation_id
      from public.conversation_cart_items ci
     where (ci.created_at >= p_desde and ci.created_at < p_hasta)
        or (ci.updated_at >= p_desde and ci.updated_at < p_hasta)
  ),
  -- La etiqueta es del CONTACTO. `translate` antes de `lower`: con collation C,
  -- `lower('Ó')` no baja la Ó y "RECLAMÓ" no calzaría.
  recl as (
    select distinct co.id as conversation_id
      from public.conversations co
      join clientes cl on cl.conversation_id = co.id
      join public.contact_tags ct on ct.contact_id = co.contact_id
      join public.tags t on t.id = ct.tag_id
     where translate(lower(translate(btrim(t.label), 'ÁÉÍÓÚÜ', 'AEIOUU')), 'áéíóúü', 'aeiouu') like 'reclamo%'
  ),
  clasif as materialized (
    select cl.conversation_id,
           (r.conversation_id is not null) as respondida,
           (cm.conversation_id is not null) as compro,
           (ca.conversation_id is not null) as carrito,
           (rc.conversation_id is not null) as reclamo
      from clientes cl
      left join resp r on r.conversation_id = cl.conversation_id
      left join comp cm on cm.conversation_id = cl.conversation_id
      left join carr ca on ca.conversation_id = cl.conversation_id
      left join recl rc on rc.conversation_id = cl.conversation_id
  ),
  -- Primera respuesta de cada persona en cada conversación (la IA es una sola persona).
  primeras as materialized (
    select s.conversation_id,
           case when s.sender_type = 'ai' then null else s.sender_agent_id end as persona,
           (s.sender_type = 'ai') as es_ia,
           min(s.created_at) as primera
      from sal s
     group by 1, 2, 3
  ),
  primeras_compra as (
    select p.conversation_id, p.persona, p.es_ia,
           bool_or(vt.conversation_id is not null) as compro
      from primeras p
      left join ventas_ventana vt
        on vt.conversation_id = p.conversation_id
       and vt.created_at >= p.primera
       and vt.created_at <= p.primera + interval '7 days'
     group by 1, 2, 3
  ),
  persona_agg as (
    select pc.persona, pc.es_ia,
           count(*)::int as atendidas,
           (count(*) filter (where pc.compro))::int as compraron
      from primeras_compra pc
     group by 1, 2
  ),
  primera_equipo as (
    select s.conversation_id, min(s.created_at) as primera
      from sal s
     group by s.conversation_id
  ),
  equipo_compra as (
    select pe.conversation_id,
           bool_or(vt.conversation_id is not null) as compro
      from primera_equipo pe
      left join ventas_ventana vt
        on vt.conversation_id = pe.conversation_id
       and vt.created_at >= pe.primera
       and vt.created_at <= pe.primera + interval '7 days'
     group by 1
  ),
  calor_agg as (
    select extract(dow from e.created_at at time zone v_tz)::int as d,
           extract(hour from e.created_at at time zone v_tz)::int as h,
           count(*)::int as n
      from ent e
     group by 1, 2
  )
  select jsonb_build_object(
    'embudo', (
      select jsonb_build_object(
               'escribieron', count(*)::int,
               'respondidas', (count(*) filter (where c.respondida))::int,
               -- Un carrito que se vendió se vacía: quien compró cuenta como con carrito.
               'con_carrito', (count(*) filter (where c.carrito or c.compro))::int,
               'compraron', (count(*) filter (where c.compro))::int)
        from clasif c
    ),
    -- Excluyentes, con la precedencia del contrato.
    'resultados', (
      select jsonb_build_object(
               'compraron', (count(*) filter (where c.compro))::int,
               'reclamo', (count(*) filter (where not c.compro and c.reclamo))::int,
               'carrito_sin_compra', (count(*) filter (where not c.compro and not c.reclamo and c.carrito))::int,
               'solo_preguntaron', (count(*) filter (where not c.compro and not c.reclamo and not c.carrito and c.respondida))::int,
               'sin_respuesta', (count(*) filter (where not c.compro and not c.reclamo and not c.carrito and not c.respondida))::int)
        from clasif c
    ),
    'conversion', jsonb_build_object(
      'equipo', (
        select jsonb_build_object(
                 'atendidas', count(*)::int,
                 'compraron', (count(*) filter (where ec.compro))::int)
          from equipo_compra ec
      ),
      'personas', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'agent_id', pa.persona,
                 'nombre', case when pa.es_ia then 'Seba' else coalesce(a.display_name, 'Sin nombre') end,
                 'rol', case when pa.es_ia then 'ia' else a.role end,
                 'atendidas', pa.atendidas,
                 'compraron', pa.compraron)
               order by pa.atendidas desc, pa.compraron desc, a.display_name)
          from persona_agg pa
          left join public.agents a on a.id = pa.persona
      ), '[]'::jsonb)
    ),
    'calor', jsonb_build_object(
      'valores', (
        select jsonb_agg(fila order by d)
          from (
            select dd as d,
                   jsonb_agg(coalesce(ca.n, 0) order by hh) as fila
              from generate_series(0, 6) dd
              cross join generate_series(0, 23) hh
              left join calor_agg ca on ca.d = dd and ca.h = hh
             group by dd
          ) x
      )
    )
  ) into v_resultado;

  return v_resultado;
end;
$$;

comment on function public.panel_conversaciones(timestamptz, timestamptz) is
  'Analíticas del chat (plan "Paneles", M4, 13/11/2026): embudo, resultados excluyentes, conversión por persona en 7 días y calor 7x24 en hora de Caracas. Contrato en docs/paneles-contrato.md. Rango [p_desde, p_hasta) de a lo sumo 92 días (22023). Solo supervisor/admin (42501).';

-- ---------------------------------------------------------------------------
-- 3. panel_asesores
-- ---------------------------------------------------------------------------
create or replace function public.panel_asesores(p_desde timestamptz, p_hasta timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set timezone = 'America/Caracas'
set enable_nestloop = off
set plan_cache_mode = force_custom_plan
as $$
declare
  v_tz constant text := 'America/Caracas';
  v_resultado jsonb;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde then
    raise exception 'rango inválido: p_hasta debe ser posterior a p_desde' using errcode = '22023';
  end if;
  if p_hasta - p_desde > interval '92 days' then
    raise exception 'rango demasiado largo: el máximo son 92 días' using errcode = '22023';
  end if;

  with
  -- Mismos predicados que los índices parciales de M3.
  ent as materialized (
    select m.conversation_id, m.created_at
      from public.messages m
     where m.sender_type = 'customer'
       and m.created_at >= p_desde and m.created_at < p_hasta
  ),
  sal as materialized (
    select m.conversation_id, m.sender_type, m.sender_agent_id, m.created_at
      from public.messages m
     where m.sender_type in ('agent', 'ai') and not m.is_internal_note
       and m.created_at >= p_desde and m.created_at < p_hasta
  ),
  ventas_r as materialized (
    select vs.enviado_por, vs.canal, vs.monto_usd, vs.unidades
      from public.ventas_saint_estado vs
     where vs.created_at >= p_desde and vs.created_at < p_hasta
       and vs.estado = 'creado' and not vs.duplicado
  ),
  -- Línea de tiempo por conversación: mensajes del cliente (k = 0) y salidas
  -- reales (k = 1). `k` es smallint y `ia` boolean a propósito: ordenar 300 mil
  -- eventos por (conversación, fecha, k) con un `text` costaba ~500 ms más.
  eventos as (
    select e.conversation_id, e.created_at, 0::smallint as k, null::uuid as ag, null::boolean as ia
      from ent e
    union all
    select s.conversation_id, s.created_at, 1::smallint, s.sender_agent_id, (s.sender_type = 'ai')
      from sal s
  ),
  -- `outs_incl` sirve a las dos puntas con una sola pasada de ventana: en un
  -- mensaje del cliente es cuántas salidas lo precedían; en una salida, su número
  -- de orden. La respuesta al episodio que tiene `outs_incl = n` es la salida
  -- número n + 1.
  ordenados as materialized (
    select ev.conversation_id, ev.created_at, ev.k, ev.ag, ev.ia,
           lag(ev.k) over w as k_prev,
           sum(ev.k) over (w rows between unbounded preceding and current row) as outs_incl
      from eventos ev
    window w as (partition by ev.conversation_id order by ev.created_at, ev.k)
  ),
  -- Para el primer mensaje del cliente del rango: ¿qué lo precedía antes del rango?
  ant as materialized (
    select p.conversation_id, x.k
      from (select e.conversation_id, min(e.created_at) as pr from ent e group by e.conversation_id) p
      left join lateral (
        select case when m.sender_type = 'customer' then 0 else 1 end::smallint as k
          from public.messages m
         where m.conversation_id = p.conversation_id
           and m.created_at < p.pr
           and not m.is_internal_note
           and m.sender_type in ('customer', 'agent', 'ai')
         order by m.created_at desc
         limit 1
      ) x on true
  ),
  -- Episodio = mensaje del cliente que sigue a una salida (o abre la conversación).
  episodios as materialized (
    select o.conversation_id, o.created_at, o.outs_incl
      from ordenados o
      left join ant a on a.conversation_id = o.conversation_id
     where o.k = 0
       and (o.k_prev = 1 or (o.k_prev is null and (a.k is null or a.k = 1)))
  ),
  -- A cada episodio le responde la primera salida real posterior.
  respuestas as materialized (
    select e.conversation_id, so.ia, so.ag,
           extract(epoch from (so.created_at - e.created_at)) / 60.0 as min_resp
      from episodios e
      left join ordenados so
        on so.conversation_id = e.conversation_id and so.k = 1 and so.outs_incl = e.outs_incl + 1
  ),
  ep_persona as materialized (
    select r.ag as agent_id,
           count(*)::int as episodios,
           round((percentile_cont(0.5) within group (order by r.min_resp))::numeric, 1) as mediana,
           round((percentile_cont(0.9) within group (order by r.min_resp))::numeric, 1) as p90,
           round((count(*) filter (where r.min_resp <= 5))::numeric / count(*), 4) as en_5
      from respuestas r
     where r.ag is not null
     group by r.ag
  ),
  msj as materialized (
    select s.sender_agent_id as agent_id,
           count(*)::int as mensajes,
           count(distinct s.conversation_id)::int as conversaciones,
           max(s.created_at) as ultimo
      from sal s
     where s.sender_type = 'agent' and s.sender_agent_id is not null
     group by s.sender_agent_id
  ),
  contactos as materialized (
    select d.agent_id, count(distinct c.contact_id)::int as contactos
      from (select distinct s.sender_agent_id as agent_id, s.conversation_id
              from sal s
             where s.sender_type = 'agent' and s.sender_agent_id is not null) d
      join public.conversations c on c.id = d.conversation_id
     group by d.agent_id
  ),
  act as materialized (
    select s.sender_agent_id as agent_id,
           extract(hour from s.created_at at time zone v_tz)::int as hora,
           count(*)::int as n
      from sal s
     where s.sender_type = 'agent' and s.sender_agent_id is not null
     group by 1, 2
  ),
  env as materialized (
    select vr.enviado_por as agent_id,
           count(*)::int as envios,
           coalesce(sum(vr.unidades), 0)::int as unidades,
           count(vr.monto_usd)::int as n_monto,
           sum(vr.monto_usd) as monto,
           (count(*) filter (where vr.canal = 'online'))::int as envios_online,
           (count(*) filter (where vr.canal = 'tienda'))::int as envios_tienda
      from ventas_r vr
     where vr.enviado_por is not null
     group by vr.enviado_por
  ),
  reas as materialized (
    select h.from_id as agent_id, count(*)::int as n
      from public.conversation_handoffs h
     where h.reason = 'reasignada_por_demora'
       and h.from_id is not null
       and h.created_at >= p_desde and h.created_at < p_hasta
     group by h.from_id
  ),
  personas as materialized (
    select a.id as agent_id, a.display_name, a.role, a.is_active,
           coalesce(m.mensajes, 0) as mensajes,
           coalesce(m.conversaciones, 0) as conversaciones,
           coalesce(ct.contactos, 0) as contactos,
           m.ultimo,
           coalesce(ep.episodios, 0) as episodios,
           ep.mediana, ep.p90, ep.en_5,
           coalesce(e.envios, 0) as envios,
           case when coalesce(e.n_monto, 0) > 0 then e.monto end as monto,
           coalesce(e.unidades, 0) as unidades,
           coalesce(e.envios_online, 0) as envios_online,
           coalesce(e.envios_tienda, 0) as envios_tienda,
           coalesce(r.n, 0) as reasignadas
      from public.agents a
      left join msj m on m.agent_id = a.id
      left join contactos ct on ct.agent_id = a.id
      left join ep_persona ep on ep.agent_id = a.id
      left join env e on e.agent_id = a.id
      left join reas r on r.agent_id = a.id
     where (coalesce(m.mensajes, 0) > 0 or coalesce(e.envios, 0) > 0)
       and (a.role <> 'caja' or coalesce(e.envios, 0) > 0)
  )
  select jsonb_build_object(
    'personas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'agent_id', p.agent_id,
               'nombre', p.display_name,
               'rol', p.role,
               'en_reparto', p.is_active,
               'conversaciones', p.conversaciones,
               'mensajes', p.mensajes,
               'contactos', p.contactos,
               'episodios', p.episodios,
               'primera_resp_mediana_min', p.mediana,
               'primera_resp_p90_min', p.p90,
               'en_5min', p.en_5,
               'envios', p.envios,
               'monto', p.monto,
               'unidades', p.unidades,
               'envios_online', p.envios_online,
               'envios_tienda', p.envios_tienda,
               'reasignadas_desde', p.reasignadas,
               'ultimo_mensaje', p.ultimo,
               'actividad_hora', (
                 select jsonb_agg(coalesce(ac.n, 0) order by hh)
                   from generate_series(0, 23) hh
                   left join act ac on ac.agent_id = p.agent_id and ac.hora = hh))
             order by p.mensajes desc, p.envios desc, p.display_name)
        from personas p
    ), '[]'::jsonb),
    'seba', (
      select jsonb_build_object(
               'mensajes', count(*)::int,
               'conversaciones', count(distinct s.conversation_id)::int,
               'ultimo', max(s.created_at))
        from sal s
       where s.sender_type = 'ai'
    ),
    'equipo', (
      select jsonb_build_object(
               'episodios', count(*)::int,
               'primera_resp_mediana_min', round((percentile_cont(0.5) within group (order by r.min_resp))::numeric, 1),
               'en_5min', case when count(r.min_resp) = 0 then null
                               else round((count(*) filter (where r.min_resp <= 5))::numeric / count(r.min_resp), 4) end)
        from respuestas r
    )
  ) into v_resultado;

  return v_resultado;
end;
$$;

comment on function public.panel_asesores(timestamptz, timestamptz) is
  'Panel de asesores (plan "Paneles", M4, 13/11/2026): actividad, episodios y primera respuesta, envíos y reasignaciones por persona, más Seba y el equipo. Contrato en docs/paneles-contrato.md. Rango [p_desde, p_hasta) de a lo sumo 92 días (22023). Solo supervisor/admin (42501).';

-- ---------------------------------------------------------------------------
-- 4. panel_cola
-- ---------------------------------------------------------------------------
create or replace function public.panel_cola()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set timezone = 'America/Caracas'
set plan_cache_mode = force_custom_plan
as $$
declare
  v_resultado jsonb;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  with
  -- Esperando respuesta, no cerradas. El reloj corre desde el primer mensaje del
  -- cliente POSTERIOR a la última respuesta real (`last_reply_at`); sin ninguno
  -- legible (un `unsupported` no mueve `last_customer_message_at`) cae a ese
  -- campo.
  esperando as materialized (
    select c.id, c.assigned_agent_id, c.contact_id,
           coalesce(
             (select min(m.created_at)
                from public.messages m
               where m.conversation_id = c.id
                 and m.sender_type = 'customer'
                 and m.message_type <> 'unsupported'
                 and (c.last_reply_at is null or m.created_at > c.last_reply_at)),
             c.last_customer_message_at) as desde
      from public.conversations c
     where c.status <> 'closed' and c.awaiting_reply
  ),
  pend as materialized (
    select e.*
      from esperando e
     where e.desde is not null and e.desde >= now() - interval '7 days'
  ),
  detalle as (
    select p.id as conversation_id, p.desde,
           coalesce(nullif(btrim(ct.display_name), ''), nullif(btrim(ct.profile_name), ''), ct.phone_number) as contacto,
           p.assigned_agent_id as asesor_id,
           a.display_name as asesor
      from pend p
      left join public.contacts ct on ct.id = p.contact_id
      left join public.agents a on a.id = p.assigned_agent_id
  ),
  veinte as (
    select * from detalle order by desde, conversation_id limit 20
  )
  select jsonb_build_object(
    'corte_dias', 7,
    'pendientes', (select count(*)::int from pend),
    'sin_dueno', (select count(*)::int from pend where assigned_agent_id is null),
    'con_dueno', (select count(*)::int from pend where assigned_agent_id is not null),
    'abandonadas', (select count(*)::int from esperando e where e.desde is not null and e.desde < now() - interval '7 days'),
    'por_antiguedad', jsonb_build_object(
      'menos_1h', (select count(*)::int from pend where desde >= now() - interval '1 hour'),
      'de_1_a_4h', (select count(*)::int from pend where desde < now() - interval '1 hour' and desde >= now() - interval '4 hours'),
      'de_4_a_24h', (select count(*)::int from pend where desde < now() - interval '4 hours' and desde >= now() - interval '24 hours'),
      'de_1_a_7d', (select count(*)::int from pend where desde < now() - interval '24 hours')
    ),
    'mas_viejo', (
      select jsonb_build_object(
               'conversation_id', d.conversation_id,
               'desde', d.desde,
               'contacto', d.contacto,
               'asesor', d.asesor)
        from (select * from veinte order by desde, conversation_id limit 1) d
    ),
    'lista', coalesce((
      select jsonb_agg(jsonb_build_object(
               'conversation_id', v.conversation_id,
               'desde', v.desde,
               'contacto', v.contacto,
               'asesor_id', v.asesor_id,
               'asesor', v.asesor) order by v.desde, v.conversation_id)
        from veinte v
    ), '[]'::jsonb)
  ) into v_resultado;

  return v_resultado;
end;
$$;

comment on function public.panel_cola() is
  'Cola de espera AHORA (plan "Paneles", M4, 13/11/2026): conversaciones abiertas esperando respuesta, por antigüedad, con la más vieja y las 20 más viejas. Más de 7 días = abandonadas. Contrato en docs/paneles-contrato.md. Solo supervisor/admin (42501).';

-- ---------------------------------------------------------------------------
-- 5. panel_ventas_activas
-- ---------------------------------------------------------------------------
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
  -- Presupuestos de los últimos 30 días sin un borrador `creado` o en tránsito.
  pres as materialized (
    select p.id, p.origen, p.created_at as desde, p.created_by, p.conversation_id,
           btrim(p.cliente_nombre || ' ' || p.cliente_apellido) as cliente
      from public.presupuestos p
     where p.created_at >= now() - interval '30 days'
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
           a.display_name as responsable,
           pr.cliente,
           case when count(*) filter (where l.precio is null) > 0 then null
                else round(sum(l.quantity * l.precio), 2) end as monto,
           (count(*) filter (where l.precio is null))::int as sin_precio,
           coalesce(sum(l.quantity), 0)::int as unidades,
           pr.desde
      from pres pr
      join pres_lin l on l.id = pr.id
      left join public.agents a on a.id = pr.created_by
     group by pr.id, pr.origen, a.display_name, pr.cliente, pr.desde
  ),
  -- Carritos del chat cambiados en los últimos 7 días, sin un envío posterior al
  -- cambio y sin un presupuesto `chat` activo en la misma conversación.
  carr as materialized (
    select ci.conversation_id, max(ci.updated_at) as desde
      from public.conversation_cart_items ci
     group by ci.conversation_id
    having max(ci.updated_at) >= now() - interval '7 days'
  ),
  carr_act as materialized (
    select c.conversation_id, c.desde
      from carr c
     where not exists (
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
           (select ag.display_name
              from public.conversation_cart_items u
              left join public.agents ag on ag.id = u.added_by
             where u.conversation_id = ca.conversation_id
             order by u.updated_at desc
             limit 1) as responsable,
           coalesce(nullif(btrim(ct.display_name), ''), nullif(btrim(ct.profile_name), ''), ct.phone_number) as cliente,
           case when count(*) filter (where l.precio is null) > 0 then null
                else round(sum(l.quantity * l.precio), 2) end as monto,
           (count(*) filter (where l.precio is null))::int as sin_precio,
           coalesce(sum(l.quantity), 0)::int as unidades,
           ca.desde
      from carr_act ca
      join carr_lin l on l.conversation_id = ca.conversation_id
      left join public.conversations co on co.id = ca.conversation_id
      left join public.contacts ct on ct.id = co.contact_id
     group by ca.conversation_id, ca.desde, ct.display_name, ct.profile_name, ct.phone_number
  ),
  items as materialized (
    select tipo, id, canal, responsable, cliente, monto, sin_precio, unidades, desde from pres_item
    union all
    select tipo, id, canal, responsable, cliente, monto, sin_precio, unidades, desde from carr_item
  ),
  con_tramo as (
    select i.*,
           case
             when i.desde >= now() - interval '1 day' then '24h'
             when i.desde >= now() - interval '3 days' then '3d'
             when i.desde >= now() - interval '7 days' then '7d'
             else '30d'
           end as tramo
      from items i
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
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tipo', o.tipo,
               'id', o.id,
               'canal', o.canal,
               'responsable', o.responsable,
               'cliente', o.cliente,
               'monto', o.monto,
               'unidades', o.unidades,
               'desde', o.desde) order by o.desde, o.id)
        from (select * from items order by desde, id limit 30) o
    ), '[]'::jsonb)
  ) into v_resultado;

  return v_resultado;
end;
$$;

comment on function public.panel_ventas_activas() is
  'Ventas por cerrar AHORA (plan "Paneles", M4, 13/11/2026): presupuestos (30 días) y carritos del chat (7 días) sin enviar a SAINT, valuados al precio de hoy con precio_venta_usd_base. Un renglón sin precio deja el monto del ítem en null (nunca un parcial). Contrato en docs/paneles-contrato.md. Solo supervisor/admin (42501).';

-- ---------------------------------------------------------------------------
-- 6. Permisos: los DOS revokes y el grant (CLAUDE.md, "Convenciones").
-- ---------------------------------------------------------------------------
revoke execute on function public.panel_ventas(timestamptz, timestamptz) from public;
revoke execute on function public.panel_ventas(timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.panel_ventas(timestamptz, timestamptz) to authenticated, service_role;

revoke execute on function public.panel_conversaciones(timestamptz, timestamptz) from public;
revoke execute on function public.panel_conversaciones(timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.panel_conversaciones(timestamptz, timestamptz) to authenticated, service_role;

revoke execute on function public.panel_asesores(timestamptz, timestamptz) from public;
revoke execute on function public.panel_asesores(timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.panel_asesores(timestamptz, timestamptz) to authenticated, service_role;

revoke execute on function public.panel_cola() from public;
revoke execute on function public.panel_cola() from anon, authenticated;
grant execute on function public.panel_cola() to authenticated, service_role;

revoke execute on function public.panel_ventas_activas() from public;
revoke execute on function public.panel_ventas_activas() from anon, authenticated;
grant execute on function public.panel_ventas_activas() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
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
  ]
  loop
    if to_regprocedure(f) is null then
      raise exception '20261113040000: no existe %', f;
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('public', f, 'EXECUTE') then
      raise exception '20261113040000: anon o PUBLIC pueden ejecutar %', f;
    end if;
    if not has_function_privilege('authenticated', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '20261113040000: authenticated y service_role deben poder ejecutar %', f;
    end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
      raise exception '20261113040000: % debía quedar security definer', f;
    end if;
  end loop;

  raise notice '20261113040000: autoverificación de las RPC de los paneles correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
