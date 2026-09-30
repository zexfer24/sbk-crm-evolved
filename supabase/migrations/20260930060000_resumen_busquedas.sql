-- ============================================================================
-- A2 T9 · M6 -- Pestaña «Búsquedas» de Control IA: `resumen_busquedas` y
-- `terminos_de_busquedas` (plan "Seba no cotiza lo que no es", 30/9/2026,
-- sección 4.7).
--
-- Qué resuelven. Cada turno guarda en `agent_turns.catalog_queries` el rastro
-- de las búsquedas al catálogo (`ConsultaCatalogo`, `tools.ts`): v1 desde el
-- 28/9 (`query, productos, moto, grupos, opcionales, corregido, resultado`) y
-- v2 desde A2 (con `v: 2`, más `avisos`, `relajados`, `cotizados`,
-- `correccionDescartada`, `conteos`…). La pestaña «Búsquedas» de Control IA
-- necesita contar esa colección (a 30 días son decenas de miles de objetos
-- jsonb): traerla entera al navegador para sumarla allá pagaría el peso de la
-- red y de la RLS por fila (ver más abajo), así que se agrega en SQL.
--
--   · `resumen_busquedas(p_desde)`      -> bloque A: los conteos del período.
--   · `terminos_de_busquedas(p_desde)`  -> bloque C (los términos obligatorios
--     que no calzaron) y bloque D (las correcciones y en qué terminó cada una).
--     Van en una segunda función y no en la primera porque el período del
--     bloque A lo elige el asesor (hoy / 7 / 30 días) y C y D son siempre de 30
--     días: con una sola función, cada cambio de período recalcularía C y D.
--
-- Por qué `security definer` y no `security invoker` (desvío sobre la nota del
-- operador, explicado en el plan): la política de `agent_turns` es
-- `using (is_agent())`, es decir, UNA llamada a una función `security definer`
-- POR FILA. Recorrer 30 días de turnos así es exactamente la trampa que tumbó
-- la búsqueda de `/inbox` durante 48 h (migración 20260921030000: 75 ms como
-- superusuario contra 1.468 ms como `authenticated` sobre 115.000 mensajes).
-- Con `security definer`, `is_agent()` se chequea UNA vez al entrar y el
-- resto de la función lee `agent_turns` sin la política por fila. Como ese
-- chequeo pasa a ser el único portón, las dos funciones llevan los DOS
-- revokes de siempre (el EXECUTE de fábrica a `PUBLIC` y el de
-- `anon`/`authenticated` del `alter default privileges` de Supabase, ver
-- CLAUDE.md) más el grant a quien sí las llama (`authenticated` con sesión, el
-- navegador; `service_role` por simetría con las demás). Quien no es agente
-- recibe `null`.
--
-- Filas v1 y v2 juntas. Nada de lo que solo trae v2 se inventa para una fila
-- v1: los conteos que salen de campos nuevos (avisos, relajos, cotizados)
-- simplemente no suman nada por ellas, y `v1` dice cuántas búsquedas del
-- período son de esa versión para que el panel avise «N búsquedas anteriores
-- a A2 no registran avisos» en vez de pintar un cero que parezca verdad.
-- Cada campo jsonb que se recorre se comprueba con `jsonb_typeof`: una fila
-- rara (`{}`, un escalar, un campo con otro tipo) no puede romper la agregación
-- de las demás. El período se acota a 90 días hacia atrás (un `p_desde` de 1970
-- no debe leer la tabla entera).
-- ============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- Bloque A: los conteos del período.
create or replace function public.resumen_busquedas(p_desde timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $fn$
declare
  v_desde timestamptz := greatest(p_desde, now() - interval '90 days');
  v_resumen jsonb;
begin
  -- El chequeo de RLS, UNA sola vez (ver la cabecera): sin él, `security
  -- definer` le abriría los turnos a cualquier usuario con sesión.
  if not public.is_agent() then
    return null;
  end if;

  with consultas as (
    select t.id as turno_id, c.q,
           -- `jsonb_array_length` explota con un escalar (un `null` jsonb lo es) y
           -- Postgres no garantiza el orden de un `and`: el `case` sí.
           case when jsonb_typeof(c.q -> 'corregido') = 'array' then jsonb_array_length(c.q -> 'corregido') else 0 end as n_corregido,
           case when jsonb_typeof(c.q -> 'correccionDescartada') = 'array' then jsonb_array_length(c.q -> 'correccionDescartada') else 0 end as n_descartadas,
           case when jsonb_typeof(c.q -> 'relajados') = 'array' then jsonb_array_length(c.q -> 'relajados') else 0 end as n_relajados
    from public.agent_turns t
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(t.catalog_queries) = 'array' then t.catalog_queries else '[]'::jsonb end
    ) as c(q)
    where t.created_at >= v_desde
      and t.catalog_queries is not null
      and jsonb_typeof(c.q) = 'object'
  ),
  avisos as (
    select a ->> 'tipo' as tipo
    from consultas c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.q -> 'avisos') = 'array' then c.q -> 'avisos' else '[]'::jsonb end
    ) as x(a)
    where jsonb_typeof(a) = 'object'
  ),
  cotizados as (
    select p ->> 'productId' as producto
    from consultas c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.q -> 'cotizados') = 'array' then c.q -> 'cotizados' else '[]'::jsonb end
    ) as x(p)
    where jsonb_typeof(p) = 'object'
  )
  select jsonb_build_object(
    'turnos', (select count(distinct turno_id) from consultas),
    'busquedas', (select count(*) from consultas),
    'v1', (select count(*) from consultas where q -> 'v' is null),
    'resultados', jsonb_build_object(
      'con_existencia', (select count(*) from consultas where q ->> 'resultado' = 'con_existencia'),
      'agotados',       (select count(*) from consultas where q ->> 'resultado' = 'agotados'),
      'generico',       (select count(*) from consultas where q ->> 'resultado' = 'generico'),
      'sin_resultados', (select count(*) from consultas where q ->> 'resultado' = 'sin_resultados'),
      'sin_terminos',   (select count(*) from consultas where q ->> 'resultado' = 'sin_terminos'),
      'error',          (select count(*) from consultas where q ->> 'resultado' = 'error')
    ),
    'avisos', jsonb_build_object(
      'universales',      (select count(*) from avisos where tipo = 'universales'),
      'moto_sin_calce',   (select count(*) from avisos where tipo = 'moto_sin_calce'),
      'relajado',         (select count(*) from avisos where tipo = 'relajado'),
      'relajado_agotado', (select count(*) from avisos where tipo = 'relajado_agotado'),
      'variante_agotada', (select count(*) from avisos where tipo = 'variante_agotada'),
      'varias_opciones',  (select count(*) from avisos where tipo = 'varias_opciones')
    ),
    'correcciones', (
      select count(*) from consultas where n_corregido > 0
    ),
    'descartadas', (
      select count(*) from consultas where n_descartadas > 0
    ),
    'relajos', (
      select count(*) from consultas where n_relajados > 0
    ),
    -- «Terminó cotizando»: lo relajado acabó en un producto CON existencia.
    'relajos_cotizaron', (
      select count(*) from consultas
      where n_relajados > 0 and q ->> 'resultado' = 'con_existencia'
    ),
    'cotizaciones', (select count(*) from cotizados),
    'productos_distintos', (select count(distinct producto) from cotizados where producto is not null)
  ) into v_resumen;

  return v_resumen;
end;
$fn$;

-- Bloques C y D: los términos que no calzaron y las correcciones.
create or replace function public.terminos_de_busquedas(p_desde timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $fn$
declare
  v_desde timestamptz := greatest(p_desde, now() - interval '90 days');
  v_terminos jsonb;
begin
  if not public.is_agent() then
    return null;
  end if;

  with consultas as (
    select t.created_at, c.q
    from public.agent_turns t
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(t.catalog_queries) = 'array' then t.catalog_queries else '[]'::jsonb end
    ) as c(q)
    where t.created_at >= v_desde
      and t.catalog_queries is not null
      and jsonb_typeof(c.q) = 'object'
  ),
  -- Bloque C. Un término obligatorio de una búsqueda SIN resultados: se cuenta
  -- la primera alternativa de cada grupo (`grupos` es [[término, singular/
  -- plural…], …]).
  sin_resultados as (
    select lower(g ->> 0) as termino, 'sin_resultados'::text as origen, c.created_at
    from consultas c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.q -> 'grupos') = 'array' then c.q -> 'grupos' else '[]'::jsonb end
    ) as x(g)
    where c.q ->> 'resultado' = 'sin_resultados'
      and case when jsonb_typeof(g) = 'array' then jsonb_array_length(g) else 0 end > 0
  ),
  -- Un término que D3 relajó (no estaba en el nombre de ningún producto), sea
  -- cual sea el resultado final de esa búsqueda.
  relajados as (
    select lower(r #>> '{}') as termino, 'relajado'::text as origen, c.created_at
    from consultas c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.q -> 'relajados') = 'array' then c.q -> 'relajados' else '[]'::jsonb end
    ) as x(r)
    where jsonb_typeof(r) = 'string'
  ),
  sin_calce as (
    select termino,
           count(*) filter (where origen = 'sin_resultados') as sin_resultados,
           count(*) filter (where origen = 'relajado') as relajado,
           max(created_at) as ultima
    from (select * from sin_resultados union all select * from relajados) u
    where termino is not null and btrim(termino) <> ''
    group by termino
  ),
  -- Bloque D. Cada corrección propuesta al cliente y en qué terminó la búsqueda.
  correcciones as (
    select lower(k ->> 'original') as original,
           lower(k ->> 'corregido') as corregido,
           count(*) as veces,
           count(*) filter (where c.q ->> 'resultado' = 'con_existencia') as con_existencia,
           count(*) filter (where c.q ->> 'resultado' = 'agotados') as agotados,
           count(*) filter (where c.q ->> 'resultado' = 'sin_resultados') as sin_resultados,
           count(*) filter (where c.q ->> 'resultado' not in ('con_existencia', 'agotados', 'sin_resultados')
                              or c.q ->> 'resultado' is null) as otros,
           max(c.created_at) as ultima
    from consultas c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.q -> 'corregido') = 'array' then c.q -> 'corregido' else '[]'::jsonb end
    ) as x(k)
    where jsonb_typeof(k) = 'object'
      and k ->> 'original' is not null
      and k ->> 'corregido' is not null
    group by 1, 2
  )
  select jsonb_build_object(
    'sin_calce', (
      select coalesce(jsonb_agg(to_jsonb(s) order by s.sin_resultados + s.relajado desc, s.termino), '[]'::jsonb)
      from (select * from sin_calce order by sin_resultados + relajado desc, termino limit 30) s
    ),
    'correcciones', (
      select coalesce(jsonb_agg(to_jsonb(d) order by d.veces desc, d.original, d.corregido), '[]'::jsonb)
      from (select * from correcciones order by veces desc, original, corregido limit 30) d
    )
  ) into v_terminos;

  return v_terminos;
end;
$fn$;

comment on function public.resumen_busquedas(timestamptz) is
  'Bloque A de la pestaña «Búsquedas» (T9, A2, 30/9/2026): conteos de agent_turns.catalog_queries desde p_desde (tope 90 días) — resultados, avisos, correcciones y descartadas, relajos, cotizaciones. Lee filas v1 y v2. security definer con is_agent() chequeado UNA vez (la política por fila de agent_turns es la trampa de 20260921030000); null si quien llama no es agente.';
comment on function public.terminos_de_busquedas(timestamptz) is
  'Bloques C y D de la pestaña «Búsquedas» (T9, A2, 30/9/2026): los términos obligatorios de las búsquedas sin resultados y los que D3 relajó (sin_calce), y las correcciones propuestas con en qué terminó cada una (correcciones), top 30 de cada lista. security definer con is_agent() UNA vez; null si quien llama no es agente.';

revoke execute on function public.resumen_busquedas(timestamptz) from public;
revoke execute on function public.resumen_busquedas(timestamptz) from anon, authenticated;
grant execute on function public.resumen_busquedas(timestamptz) to authenticated, service_role;

revoke execute on function public.terminos_de_busquedas(timestamptz) from public;
revoke execute on function public.terminos_de_busquedas(timestamptz) from anon, authenticated;
grant execute on function public.terminos_de_busquedas(timestamptz) to authenticated, service_role;

-- Autoverificación contra el catálogo real (no contra este archivo): las dos
-- son `security definer` y `anon` no puede ejecutarlas.
do $$
declare
  f text;
  v_definer boolean;
begin
  foreach f in array array[
    'public.resumen_busquedas(timestamptz)',
    'public.terminos_de_busquedas(timestamptz)'
  ] loop
    select p.prosecdef into v_definer from pg_proc p where p.oid = f::regprocedure;
    if v_definer is distinct from true then
      raise exception '20260930060000: % no quedó security definer.', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then
      raise exception '20260930060000: anon todavía puede ejecutar % -- faltó uno de los dos revokes.', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '20260930060000: authenticated no puede ejecutar % y la llama el navegador.', f;
    end if;
  end loop;

  raise notice '20260930060000: autoverificación de resumen_busquedas / terminos_de_busquedas correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y el RPC nuevo da 404
-- hasta que alguien lo recargue a mano (hallazgo M1 del 19/9/2026).
notify pgrst, 'reload schema';
