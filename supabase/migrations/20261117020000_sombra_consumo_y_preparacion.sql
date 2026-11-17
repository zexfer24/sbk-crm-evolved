-- ============================================================================
-- Pestaña «Sombra»: cuánto consume la sombra y qué tan lista está Seba v2 para
-- desplegar (P1, pedido del operador, 17/11/2026)
--
-- Qué resuelve. El operador tiene que decidir cuándo pasar Seba v2 de sombra a
-- copiloto y a encendido, y quiere hacerlo con números, no a ojo: (a) cuánto
-- cuesta la sombra (borradores, tokens y costo por día, para proyectar qué
-- pasaría con el muestreo al 100 %) y (b) qué tan bien lo hizo según lo que los
-- supervisores revisaron, en tres ejes: la búsqueda de repuestos, la
-- conversación y los montos con pago móvil.
--
-- LA SOMBRA NO APRENDE SOLA: el porcentaje de preparación sale de las
-- revisiones de `shadow_reviews`, no de ninguna medición automática. Esta
-- función solo entrega los conteos crudos (población, revisados, reprobados,
-- cambios menores por eje); el porcentaje, el mínimo de revisiones y el umbral
-- los pone `src/lib/shadow.ts`, para poder ajustarlos sin migrar.
--
-- Una sola RPC, `sombra_resumen(p_desde, p_hasta)`, devuelve todo en un jsonb:
--   * consumo: por día de CARACAS (America/Caracas, no UTC: un borrador de las
--     23:30 de Caracas es del día siguiente en UTC), total del período, gasto de
--     hoy (`shadow_spend_today()`), tope y muestreo de `agent_settings`.
--     El costo de un borrador es la MISMA cuenta de `shadow_spend_today()`:
--     tokens de entrada y de salida por la tarifa por millón de la fila de
--     `model_pricing` cuyo `model` es EXACTAMENTE el del borrador. Sin fila de
--     tarifa suma sus tokens pero NO su costo (y se cuenta en `sin_tarifa`: el
--     tope diario tampoco lo frena); si todos los borradores de un día están sin
--     tarifa, su costo es null, no 0 (un 0 parecería que la sombra es gratis).
--   * preparación: tres ejes sobre los borradores del período.
--       busqueda     -> borradores con la herramienta buscarRepuesto; su error
--                       propio es `producto_equivocado`.
--       pago         -> borradores con la herramienta prepararPago; errores
--                       `precio` y `forma_de_pago`.
--       conversacion -> TODOS los borradores; errores `tono`, `debio_pasar`,
--                       `no_debio_pasar`, `dato_inventado` y `otro`.
--     «Reprobado» = revisión con veredicto `no` y error_tipo de ESE eje (un «no»
--     por `precio` reprueba `pago` y no `busqueda` aunque el borrador también
--     buscara). Una revisión «no» sin tipo de error (el CHECK lo permite; el
--     formulario no) cuenta como `otro`, o sería un revisado que no reprueba a
--     nadie e inflaría el porcentaje.
--     Más las señales automáticas, que no necesitan revisión: borradores con
--     guardas disparadas, que pasarían a un asesor y sin ningún mensaje.
--
-- Por qué `security definer` y no `invoker`: `agent_shadow_drafts` y
-- `shadow_reviews` llevan una política por fila con `is_supervisor_or_admin()`
-- (una llamada a función POR FILA: la trampa de 20260921030000). Con definer el
-- rol se comprueba UNA vez al entrar —como las RPC `panel_*` y
-- `resumen_busquedas`—; quien no es supervisor/admin recibe 42501. Lleva los DOS
-- revokes (el EXECUTE de fábrica a PUBLIC y el del `alter default privileges`
-- de Supabase a anon/authenticated) más el `grant` a quien la llama.
--
-- El período se acota a 90 días hacia atrás desde `p_hasta` (un `p_desde` de 1970
-- no debe leer la tabla entera). Rango [p_desde, p_hasta).
--
-- Cada campo jsonb que se recorre se comprueba con `jsonb_typeof`: una fila
-- rara (`herramientas` que no es un arreglo) no puede romper el agregado.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- `set local lock_timeout` fuera de una
-- transacción es un NO-OP silencioso (falla cerrado abajo).
--
-- Idempotente: se puede aplicar dos veces sin fallar.
-- ============================================================================
set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

create or replace function public.sombra_resumen(p_desde timestamptz, p_hasta timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_desde timestamptz;
  v_resultado jsonb;
begin
  -- El chequeo de rol, UNA sola vez (ver la cabecera): sin él, `security
  -- definer` le abriría los borradores y las revisiones a cualquier sesión.
  if not public.is_supervisor_or_admin() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde then
    raise exception 'rango inválido: p_hasta debe ser posterior a p_desde' using errcode = '22023';
  end if;

  v_desde := greatest(p_desde, p_hasta - interval '90 days');

  with base as (
    select
      d.id,
      (d.created_at at time zone 'America/Caracas')::date as dia,
      coalesce(d.input_tokens, 0)::bigint        as input_tokens,
      coalesce(d.output_tokens, 0)::bigint       as output_tokens,
      coalesce(d.cached_input_tokens, 0)::bigint as cached_input_tokens,
      -- Mismo cálculo que shadow_spend_today(); null si el modelo no tiene tarifa.
      case when p.model is null then null
           else (coalesce(d.input_tokens, 0) / 1000000.0) * p.input_price_per_million
              + (coalesce(d.output_tokens, 0) / 1000000.0) * p.output_price_per_million
      end as costo,
      (p.model is null) as sin_tarifa,
      -- `@>` sobre un arreglo jsonb busca el nombre como elemento; el `case`
      -- evita recorrer un `herramientas` que no sea un arreglo.
      (case when jsonb_typeof(d.herramientas) = 'array'
            then d.herramientas @> '["buscarRepuesto"]'::jsonb else false end) as busca,
      (case when jsonb_typeof(d.herramientas) = 'array'
            then d.herramientas @> '["prepararPago"]'::jsonb else false end) as paga,
      (r.draft_id is not null) as revisado,
      r.veredicto,
      case when r.draft_id is null then null else coalesce(r.error_tipo, 'otro') end as error_tipo,
      (case when jsonb_typeof(d.guardas) = 'array' then jsonb_array_length(d.guardas) > 0 else false end) as con_guardas,
      coalesce(d.escalaria, false) as escalaria,
      (case when jsonb_typeof(d.mensajes) = 'array' then jsonb_array_length(d.mensajes) = 0 else true end) as sin_mensajes
    from public.agent_shadow_drafts d
    left join public.model_pricing p on p.model = d.model
    left join public.shadow_reviews r on r.draft_id = d.id
    where d.created_at >= v_desde
      and d.created_at <  p_hasta
  ),
  por_dia as (
    select
      dia,
      count(*) as borradores,
      sum(input_tokens) as input_tokens,
      sum(output_tokens) as output_tokens,
      sum(cached_input_tokens) as cached_input_tokens,
      -- `sum` de puros null da null: un día todo sin tarifa no es «gratis».
      sum(costo) as costo
    from base
    group by dia
  )
  select jsonb_build_object(
    'consumo', jsonb_build_object(
      'dias', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'dia', to_char(pd.dia, 'YYYY-MM-DD'),
          'borradores', pd.borradores,
          'input_tokens', pd.input_tokens,
          'output_tokens', pd.output_tokens,
          'cached_input_tokens', pd.cached_input_tokens,
          'costo_usd', round(pd.costo, 6)
        ) order by pd.dia desc), '[]'::jsonb)
        from por_dia pd
      ),
      'total', (
        select jsonb_build_object(
          'borradores', count(*),
          'input_tokens', coalesce(sum(b.input_tokens), 0),
          'output_tokens', coalesce(sum(b.output_tokens), 0),
          'cached_input_tokens', coalesce(sum(b.cached_input_tokens), 0),
          -- Sin ningún borrador no hay nada que costar: 0. Con borradores y
          -- todos sin tarifa, null.
          'costo_usd', case when count(*) = 0 then 0 else round(sum(b.costo), 6) end,
          'sin_tarifa', count(*) filter (where b.sin_tarifa)
        )
        from base b
      ),
      'hoy_usd', round(public.shadow_spend_today(), 6),
      'tope_usd', (select s.shadow_daily_cap_usd from public.agent_settings s where s.id),
      'muestreo_pct', (select s.shadow_sample_pct from public.agent_settings s where s.id)
    ),
    'preparacion', jsonb_build_object(
      'ejes', jsonb_build_array(
        (select jsonb_build_object(
          'eje', 'busqueda',
          'poblacion', count(*) filter (where b.busca),
          'revisados', count(*) filter (where b.busca and b.revisado),
          'reprobados', count(*) filter (where b.busca and b.veredicto = 'no'
                                           and b.error_tipo = 'producto_equivocado'),
          'cambios_menores', count(*) filter (where b.busca and b.veredicto = 'cambio_menor'
                                                and b.error_tipo = 'producto_equivocado')
        ) from base b),
        (select jsonb_build_object(
          'eje', 'conversacion',
          'poblacion', count(*),
          'revisados', count(*) filter (where b.revisado),
          'reprobados', count(*) filter (where b.veredicto = 'no'
            and b.error_tipo in ('tono', 'debio_pasar', 'no_debio_pasar', 'dato_inventado', 'otro')),
          'cambios_menores', count(*) filter (where b.veredicto = 'cambio_menor'
            and b.error_tipo in ('tono', 'debio_pasar', 'no_debio_pasar', 'dato_inventado', 'otro'))
        ) from base b),
        (select jsonb_build_object(
          'eje', 'pago',
          'poblacion', count(*) filter (where b.paga),
          'revisados', count(*) filter (where b.paga and b.revisado),
          'reprobados', count(*) filter (where b.paga and b.veredicto = 'no'
                                           and b.error_tipo in ('precio', 'forma_de_pago')),
          'cambios_menores', count(*) filter (where b.paga and b.veredicto = 'cambio_menor'
                                                and b.error_tipo in ('precio', 'forma_de_pago'))
        ) from base b)
      ),
      'senales', (
        select jsonb_build_object(
          'total', count(*),
          'con_guardas', count(*) filter (where b.con_guardas),
          'pasarian_a_asesor', count(*) filter (where b.escalaria),
          'sin_mensajes', count(*) filter (where b.sin_mensajes)
        ) from base b
      )
    )
  ) into v_resultado;

  return v_resultado;
end;
$$;

comment on function public.sombra_resumen(timestamptz, timestamptz) is
  'Pestaña «Sombra» (P1, 17/11/2026): consumo de la sombra por día de Caracas (tokens y costo con la tarifa de model_pricing, igual que shadow_spend_today; sin tarifa suma tokens pero no costo, y todo un día sin tarifa da costo null) y los conteos de preparación para desplegar en tres ejes (búsqueda, conversación, pago) sobre las revisiones de shadow_reviews, más señales automáticas. Rango [p_desde, p_hasta) acotado a 90 días. Solo supervisor/admin (42501).';

revoke execute on function public.sombra_resumen(timestamptz, timestamptz) from public;
revoke execute on function public.sombra_resumen(timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.sombra_resumen(timestamptz, timestamptz) to authenticated, service_role;

-- Autoverificación contra el catálogo real (no contra este archivo).
do $$
declare
  f constant text := 'public.sombra_resumen(timestamptz, timestamptz)';
  v_definer boolean;
begin
  select p.prosecdef into v_definer from pg_proc p where p.oid = f::regprocedure;
  if v_definer is distinct from true then
    raise exception '20261117020000: % no quedó security definer.', f;
  end if;
  if has_function_privilege('anon', f, 'execute') then
    raise exception '20261117020000: anon todavía puede ejecutar % -- faltó uno de los dos revokes.', f;
  end if;
  if not has_function_privilege('authenticated', f, 'execute') then
    raise exception '20261117020000: authenticated no puede ejecutar % y la llama el navegador.', f;
  end if;
  if not has_function_privilege('service_role', f, 'execute') then
    raise exception '20261117020000: service_role no puede ejecutar %.', f;
  end if;
end $$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la RPC nueva da 404
-- hasta que alguien lo recargue a mano.
notify pgrst, 'reload schema';
