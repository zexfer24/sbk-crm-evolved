-- ============================================================================
-- Agrega el consumo de tokens en Postgres en vez de traer cada fila cruda:
-- fetchTokenUsageSummary escaneaba agent_turns sin límite ni orden, lo que
-- PostgREST trunca en silencio a 1000 filas (max_rows) pasado cierto volumen.
-- Esta función devuelve un puñado de filas (una por día × modelo) sin importar
-- cuántos turnos haya.
-- ============================================================================
create function public.agent_token_usage(days integer default 30)
returns table (day date, model text, input_tokens bigint, output_tokens bigint, total_tokens bigint)
language sql stable security invoker set search_path = public as $$
  select (created_at at time zone 'utc')::date as day,
         coalesce(model, 'desconocido') as model,
         sum(coalesce(input_tokens, 0)) as input_tokens,
         sum(coalesce(output_tokens, 0)) as output_tokens,
         sum(coalesce(total_tokens, 0)) as total_tokens
  from public.agent_turns
  where created_at >= now() - make_interval(days => days)
    and total_tokens is not null
  group by 1, 2;
$$;

comment on function public.agent_token_usage is 'Agregado día×modelo de agent_turns para el panel de consumo de tokens. security invoker: hereda el RLS de agent_turns de quien llama, no necesita policy propia.';

grant execute on function public.agent_token_usage(integer) to authenticated, service_role;
