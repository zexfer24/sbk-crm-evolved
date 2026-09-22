-- ============================================================================
-- Tarea T3 · plan "Nada se pierde en un corte ni en un deploy" (aprobado
-- 21/9/2026, decisión D2 del operador).
--
-- Contexto: el informe del Claude del VPS del 21/9/2026 (tras desplegar
-- 83bc558) diagnosticó las dos espirales de tokens del día anterior mirando
-- SOLO `log.info("turno_tiempos")` -- pasos, herramientas, tiempo de
-- redacción, nada de eso vive en la base (hallazgo 3 del plan). Y
-- `agent_turns` guarda un ÚNICO total de tokens sumado entre 3-7 llamadas al
-- proveedor por turno (escenario, clasificar, 1-2 pasos de redacción, la
-- reescritura de identidad): imposible saber, sin hacer grep en los logs de
-- un contenedor que un deploy destruye (T8 del mismo plan), CUÁNTO costó
-- cada fase, si el modelo cacheó, si razonó, o qué `tool_choice`/
-- `maxOutputTokens` viajó de verdad en la llamada que se disparó tras
-- escalar (7.4 del informe -- la prueba directa que faltaba).
--
-- Esta migración solo abre el hueco en la base: T4 (siguiente tarea del
-- mismo plan) es quien escribe desde `agent.ts`. Acá no se lee ni se escribe
-- nada todavía -- mismo criterio que 20260921020000_agent_turns_reasoning_tokens.sql.
--
-- ----------------------------------------------------------------------------
-- agent_turns: seis columnas nuevas, nullable, SIN backfill -- lo viejo (los
-- turnos ya corridos) no se puede reconstruir, no hay de dónde sacar
-- `steps`/`tools_used`/los cuatro tiempos de un turno que ya pasó. Mismo
-- estilo que `cached_input_tokens` (20260822090000): nullable y sin default,
-- "no es que no midiera nada, es que no se medía todavía".
--
-- ----------------------------------------------------------------------------
-- agent_turn_calls: una fila por cada llamada al proveedor dentro de un
-- turno (3-7 filas/turno, 1.100-2.500 filas/día medidas el 21/9/2026 -- más
-- que `messages` hoy, 400-900 mil filas/año). RLS HABILITADA SIN NINGUNA
-- POLÍTICA, a propósito (objeción 1 de la revisión del VPS, 21/9/2026): una
-- política `select using (is_agent())` es EXACTAMENTE la que 156 búsquedas
-- de /inbox pagaron por fila durante 48 h antes de 20260921030000 -- a este
-- volumen, el mismo patrón sobre una tabla nueva es una bomba de tiempo
-- previsible, no un accidente. Nadie necesita leer esta tabla directo: el
-- turno (service_role, que en este stack tiene BYPASSRLS -- ver
-- conversation_handoffs, 20260830040000, mismo patrón: "escribe service_role"
-- sin ninguna policy de INSERT) la escribe, y el panel de Control IA la lee
-- SOLO por las dos RPC de abajo, que chequean is_agent() UNA vez al entrar en
-- vez de por fila.
--
-- input_tokens/output_tokens/cached_input_tokens de CADA llamada nacen NOT
-- NULL DEFAULT 0 -- decisión de esta tarea, el plan no lo fijaba con la
-- misma explicitud que a reasoning_tokens/max_output_tokens/tool_choice/
-- finish_reason (esos cuatro sí llevan "null" en el texto de la tarea). El
-- SDK siempre devuelve input/output/cached cuando una llamada TERMINA; en el
-- único caso en que no termina (doGenerate lanza, T4 = turno_llamadas_
-- no_escritas), T4 escribe 0 en vez de necesitar que cada `sum()` de las RPC
-- de abajo maneje un `null` que no distingue nada útil ahí. reasoning_tokens/
-- max_output_tokens SÍ quedan nullable: el proveedor no siempre los separa,
-- y null ahí significa de verdad "no se sabe", no "cero medido" (mismo
-- criterio que ya separa a agent_turns.reasoning_tokens -- NOT NULL DEFAULT 0,
-- 20260921020000 -- de sus vecinas nullable de tokens).
--
-- ----------------------------------------------------------------------------
-- agent_turn_calls_by_phase(): el agregado por fase que necesita el panel
-- (T4) para responder, con datos, la promesa 7.4 del informe del VPS
-- ("tool_choice=none en toda fila redactar posterior a una escalada") sin
-- traer cientos de miles de filas crudas al navegador. security definer +
-- is_agent() UNA vez -- mismo patrón que search_conversations_by_message
-- (20260921030000): la tabla no tiene ninguna policy que RLS pudiera evaluar
-- por fila, así que SIN esto la función devolvería siempre cero filas para
-- cualquiera, agente o no.
--
-- agent_turn_calls_purge(): retención desde el día uno -- la llama el cron
-- diario (T4, con guarda en Redis, nunca frena la cola si falla). security
-- definer, service_role SOLAMENTE (ni siquiera authenticated: es un DELETE
-- masivo, no una lectura de panel).
--
-- ----------------------------------------------------------------------------
-- agent_token_usage(): se recrea (DROP + CREATE, cambia el tipo de retorno:
-- suma cached_input_tokens/reasoning_tokens) y de paso se corrige el mismo
-- agujero que 20260921030000 cerró en search_conversations_by_message -- hoy
-- es `language sql security invoker`, corre como `authenticated` y paga la
-- política `agent_turns_all using (is_agent())` UNA VEZ POR FILA sobre
-- 10.044 filas (359/día, 21/9/2026): mucho menos volumen que `messages`,
-- pero la causa es la misma y ya se sabe cómo se arregla -- se corrige de
-- una vez en vez de esperar a que también duela.
--
-- `set local lock_timeout = '5s'` + la guarda contra el no-op silencioso +
-- autoverificación + `notify pgrst` -- mismo patrón que 20260921020000 y
-- 20260921030000 (psql -1 -v ON_ERROR_STOP=1 obligatorio, ver CLAUDE.md).
-- ============================================================================
set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. agent_turns: seis columnas de telemetría del turno completo.
-- ---------------------------------------------------------------------------
alter table public.agent_turns
  add column steps smallint,
  add column tools_used text,
  add column wait_ms integer,
  add column classification_ms integer,
  add column generation_ms integer,
  add column delivery_ms integer;

comment on column public.agent_turns.steps is 'Cuántos pasos dio el tool loop en este turno (fase de redacción). Nullable sin backfill: no se medía antes de esta migración -- T4 (plan "Nada se pierde en un corte ni en un deploy", 21/9/2026) es quien lo escribe.';
comment on column public.agent_turns.tools_used is 'Nombres de las herramientas que el tool loop llegó a invocar en este turno, separados por coma (texto libre, no arreglo: solo se lee para diagnóstico humano en el panel, nunca se filtra por herramienta individual). Nullable sin backfill.';
comment on column public.agent_turns.wait_ms is 'Milisegundos que el turno esperó frenado (ritmo/cupo/lock) antes de arrancar -- lo que CLAUDE.md llama "colaMs", distinto del debounce de silencio (diseño, no atraso). Nullable sin backfill.';
comment on column public.agent_turns.classification_ms is 'Milisegundos de la fase 0+1 (calzar escenario + clasificar intención), que corren en paralelo. Nullable sin backfill.';
comment on column public.agent_turns.generation_ms is 'Milisegundos del tool loop (redacción, hasta 5 pasos). Nullable sin backfill.';
comment on column public.agent_turns.delivery_ms is 'Milisegundos que tardó el envío final al cliente (WhatsApp Cloud API). Nullable sin backfill.';

-- ---------------------------------------------------------------------------
-- 2. agent_turn_calls: una fila por cada llamada al proveedor de IA.
-- ---------------------------------------------------------------------------
create table public.agent_turn_calls (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references public.agent_turns (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sequence smallint not null,
  phase text not null check (phase in ('escenario', 'clasificar', 'redactar', 'identidad')),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  reasoning_tokens integer,
  max_output_tokens integer,
  tool_choice text,
  finish_reason text,
  duration_ms integer not null,
  created_at timestamptz not null default now()
);

comment on table public.agent_turn_calls is 'Una fila por cada llamada al proveedor de IA dentro de un turno (escenario/clasificar/redactar/identidad; 3-7 filas por turno). Nace en la migración 20260921040000 (T3, plan "Nada se pierde en un corte ni en un deploy", 21/9/2026) para responder, con datos, lo que hasta acá solo vivía en `log.info("turno_tiempos")` -- un log que un deploy destruye (ver T8 del mismo plan). RLS habilitada SIN ninguna política a propósito: escribe service_role, se lee SOLO por agent_turn_calls_by_phase()/el purgado -- ver el comentario de cabecera de este archivo, objeción 1 de la revisión del VPS del 21/9/2026.';
comment on column public.agent_turn_calls.sequence is 'Orden de esta llamada dentro del turno (1, 2, 3...). No es UNIQUE a propósito: ninguna consulta depende de que no se repita.';
comment on column public.agent_turn_calls.phase is 'En qué momento del turno se hizo esta llamada: escenario (fase 0, matchPlaybook), clasificar (fase 1, classifyIntent), redactar (tool loop, 1-5 pasos) o identidad (la reescritura de applyIdentityGuard).';
comment on column public.agent_turn_calls.input_tokens is 'Tokens de entrada de ESTA llamada (no confundir con agent_turns.input_tokens, que es la SUMA de todas las llamadas del turno). NOT NULL DEFAULT 0: a diferencia de reasoning_tokens/max_output_tokens (que de verdad pueden faltar -- el proveedor no siempre los reporta separados), input/output/cached los devuelve el SDK siempre que la llamada llega a completarse; en el único caso en que no completa (doGenerate lanza), T4 escribe 0 en vez de un null que obligaría a todo sum() de acá abajo a manejar el caso.';
comment on column public.agent_turn_calls.output_tokens is 'Tokens de salida de ESTA llamada. Ver comentario de input_tokens.';
comment on column public.agent_turn_calls.cached_input_tokens is 'Parte de input_tokens servida desde el caché de prompts del proveedor, en ESTA llamada. Ver comentario de input_tokens.';
comment on column public.agent_turn_calls.reasoning_tokens is 'Tokens de razonamiento interno que el proveedor reportó separados para ESTA llamada. null cuando el proveedor no los separa (no es lo mismo que 0 -- comparar con agent_turns.reasoning_tokens, que sí nace en 0 porque ahí "no se sabe" no es una opción válida al sumar el turno completo).';
comment on column public.agent_turn_calls.max_output_tokens is 'El params.maxOutputTokens que de verdad viajó al proveedor en ESTA llamada, leído del propio parámetro que el SDK ya resolvió (no inferido) -- T4 responde 7.4 del informe del VPS del 21/9/2026: "maxOutputTokens/toolChoice sin prueba directa". null en llamadas sin techo explícito.';
comment on column public.agent_turn_calls.tool_choice is 'El params.toolChoice de ESTA llamada, normalizado a texto: auto/none/required/tool:<nombre>. null cuando la llamada no pasa por el tool loop (escenario/clasificar/identidad no ofrecen herramientas).';
comment on column public.agent_turn_calls.finish_reason is 'Por qué terminó ESTA llamada (stop/tool-calls/length/...). "error" es un valor propio del CRM, no del proveedor: lo escribe T4 cuando doGenerate lanzó -- distingue una llamada medida-y-fallida de una llamada que nunca se registró.';

create index agent_turn_calls_turn_id_idx on public.agent_turn_calls (turn_id);
create index agent_turn_calls_created_at_idx on public.agent_turn_calls (created_at desc);

comment on index public.agent_turn_calls_turn_id_idx is 'La consulta natural del panel sobre un turno puntual: todas sus llamadas, en orden.';
comment on index public.agent_turn_calls_created_at_idx is 'El agregado por fase (agent_turn_calls_by_phase) y el purgado (agent_turn_calls_purge) filtran por ventana de created_at.';

alter table public.agent_turn_calls enable row level security;

-- SIN ninguna política -- ver el comentario de cabecera de este archivo y el
-- de la tabla. authenticated queda con select/insert de fábrica (el `alter
-- default privileges` de Supabase, igual que en cualquier tabla nueva de
-- este esquema) pero RLS sin política filtra TODO al leer: 0 filas, no un
-- error de permisos (los privilegios de tabla siguen ahí, lo que falta es
-- una policy que RLS pueda evaluar); un INSERT directo desde el navegador
-- queda rechazado (RLS sin ninguna WITH CHECK deniega, no permite). El único
-- grant explícito es para service_role, que en este stack tiene BYPASSRLS
-- (ver conversation_handoffs, 20260830040000) y aun así necesita el GRANT de
-- tabla, porque bypassrls salta la evaluación de políticas, no los
-- privilegios de SQL sobre la tabla.
grant select, insert on public.agent_turn_calls to service_role;

-- ---------------------------------------------------------------------------
-- 3. agent_turn_calls_by_phase(): agregado por fase para el panel de Control
--    IA (lo consume T4).
-- ---------------------------------------------------------------------------
create function public.agent_turn_calls_by_phase(days integer default 30)
returns table (
  phase text,
  calls bigint,
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  reasoning_tokens bigint,
  max_output_tokens_max integer,
  tool_choice_none_calls bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.is_agent() then
    return;
  end if;

  return query
  select
    c.phase,
    count(*)::bigint as calls,
    coalesce(sum(c.input_tokens), 0)::bigint as input_tokens,
    coalesce(sum(c.output_tokens), 0)::bigint as output_tokens,
    coalesce(sum(c.cached_input_tokens), 0)::bigint as cached_input_tokens,
    coalesce(sum(c.reasoning_tokens), 0)::bigint as reasoning_tokens,
    max(c.max_output_tokens) as max_output_tokens_max,
    count(*) filter (where c.tool_choice = 'none')::bigint as tool_choice_none_calls
  from public.agent_turn_calls c
  where c.created_at >= now() - make_interval(days => days)
  group by c.phase;
end;
$fn$;

comment on function public.agent_turn_calls_by_phase(integer) is 'Agregado por fase de agent_turn_calls para el panel de Control IA. security definer: is_agent() se comprueba UNA vez al entrar -- la tabla no tiene ninguna policy que RLS pudiera evaluar por fila (nace sin ninguna, ver el comentario de la tabla), así que sin esto ningún authenticated vería una fila jamás.';

revoke execute on function public.agent_turn_calls_by_phase(integer) from public;
revoke execute on function public.agent_turn_calls_by_phase(integer) from anon, authenticated;
grant execute on function public.agent_turn_calls_by_phase(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. agent_turn_calls_purge(): retención desde el día uno. SOLO service_role
--    -- la llama el cron diario (T4, con guarda en Redis).
-- ---------------------------------------------------------------------------
create function public.agent_turn_calls_purge(retain_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_deleted integer;
begin
  delete from public.agent_turn_calls
  where created_at < now() - make_interval(days => retain_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

comment on function public.agent_turn_calls_purge(integer) is 'Borra las filas de agent_turn_calls más viejas que retain_days y devuelve cuántas borró. security definer, SOLO service_role -- la llama el cron diario de purga (T4, guarda en Redis para no correr dos veces el mismo día); ni authenticated ni anon la necesitan, es un DELETE masivo, no una lectura de panel.';

revoke execute on function public.agent_turn_calls_purge(integer) from public;
revoke execute on function public.agent_turn_calls_purge(integer) from anon, authenticated;
grant execute on function public.agent_turn_calls_purge(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. agent_token_usage(): se recrea con caché y razonamiento, y de paso deja
--    de pagar is_agent() por fila -- mismo agujero que search_conversations_
--    by_message (20260921030000), mismo arreglo. DROP porque el tipo de
--    retorno cambia (dos columnas más): create or replace no lo permite.
-- ---------------------------------------------------------------------------
drop function if exists public.agent_token_usage(integer);

create function public.agent_token_usage(days integer default 30)
returns table (
  day date,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint,
  cached_input_tokens bigint,
  reasoning_tokens bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.is_agent() then
    return;
  end if;

  return query
  select
    (t.created_at at time zone 'utc')::date as day,
    coalesce(t.model, 'desconocido') as model,
    sum(coalesce(t.input_tokens, 0))::bigint as input_tokens,
    sum(coalesce(t.output_tokens, 0))::bigint as output_tokens,
    sum(coalesce(t.total_tokens, 0))::bigint as total_tokens,
    sum(coalesce(t.cached_input_tokens, 0))::bigint as cached_input_tokens,
    sum(coalesce(t.reasoning_tokens, 0))::bigint as reasoning_tokens
  from public.agent_turns t
  where t.created_at >= now() - make_interval(days => days)
    and t.total_tokens is not null
  group by 1, 2;
end;
$fn$;

comment on function public.agent_token_usage(integer) is 'Agregado día×modelo de agent_turns para el panel de consumo de tokens -- suma cached_input_tokens/reasoning_tokens desde esta migración (T3, plan "Nada se pierde en un corte ni en un deploy", 21/9/2026). security definer desde acá (antes era security invoker, pagando is_agent() por fila vía agent_turns_all -- 10.044 filas/359 por día medidas el 21/9/2026, el mismo agujero que search_conversations_by_message, 20260921030000, corrigió en messages). is_agent() se comprueba UNA vez al entrar.';

revoke execute on function public.agent_token_usage(integer) from public;
revoke execute on function public.agent_token_usage(integer) from anon, authenticated;
grant execute on function public.agent_token_usage(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real, no el texto de este archivo.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text := '';
  v_count integer;
begin
  -- Las seis columnas de agent_turns.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'agent_turns'
    and column_name in ('steps', 'tools_used', 'wait_ms', 'classification_ms', 'generation_ms', 'delivery_ms');
  if v_count is distinct from 6 then
    v_missing := v_missing || format(E'\n  - agent_turns: encontró %s de las 6 columnas nuevas.', v_count);
  end if;

  -- agent_turn_calls existe, con RLS habilitada y CERO políticas.
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'agent_turn_calls') then
    v_missing := v_missing || E'\n  - agent_turn_calls no quedó creada.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.agent_turn_calls'::regclass) then
    v_missing := v_missing || E'\n  - agent_turn_calls no tiene RLS habilitada.';
  end if;

  select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = 'agent_turn_calls';
  if v_count is distinct from 0 then
    v_missing := v_missing || format(E'\n  - agent_turn_calls tiene %s política(s); debía tener CERO (ver el comentario de cabecera, objeción 1 del VPS).', v_count);
  end if;

  -- Las tres funciones: security definer, cerradas a anon, abiertas a quien
  -- corresponde.
  if has_function_privilege('anon', 'public.agent_turn_calls_by_phase(integer)', 'execute') then
    v_missing := v_missing || E'\n  - agent_turn_calls_by_phase: anon todavía puede ejecutarla.';
  end if;
  if not has_function_privilege('authenticated', 'public.agent_turn_calls_by_phase(integer)', 'execute') then
    v_missing := v_missing || E'\n  - agent_turn_calls_by_phase: authenticated NO puede ejecutarla y sí debería (el panel de Control IA).';
  end if;

  if has_function_privilege('anon', 'public.agent_turn_calls_purge(integer)', 'execute') then
    v_missing := v_missing || E'\n  - agent_turn_calls_purge: anon todavía puede ejecutarla.';
  end if;
  if has_function_privilege('authenticated', 'public.agent_turn_calls_purge(integer)', 'execute') then
    v_missing := v_missing || E'\n  - agent_turn_calls_purge: authenticated puede ejecutarla y NO debería (solo service_role).';
  end if;
  if not has_function_privilege('service_role', 'public.agent_turn_calls_purge(integer)', 'execute') then
    v_missing := v_missing || E'\n  - agent_turn_calls_purge: service_role NO puede ejecutarla.';
  end if;

  if has_function_privilege('anon', 'public.agent_token_usage(integer)', 'execute') then
    v_missing := v_missing || E'\n  - agent_token_usage: anon todavía puede ejecutarla.';
  end if;
  if not has_function_privilege('authenticated', 'public.agent_token_usage(integer)', 'execute') then
    v_missing := v_missing || E'\n  - agent_token_usage: authenticated NO puede ejecutarla y sí debería.';
  end if;

  if v_missing <> '' then
    raise exception E'20260921040000: autoverificación falló:%', v_missing;
  end if;

  raise notice '20260921040000: autoverificación de agent_turn_calls y sus tres RPC correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la tabla/columnas
-- nuevas dan 400 hasta que alguien lo recargue a mano.
notify pgrst, 'reload schema';
