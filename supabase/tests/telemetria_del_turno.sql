-- ============================================================================
-- La telemetría por llamada del turno vive en la base (Tarea T3, plan "Nada
-- se pierde en un corte ni en un deploy", 21/9/2026 — decisión D2).
--
-- Migración bajo prueba: 20260921040000_telemetria_del_turno.sql.
--
-- Hasta esta migración, lo único que separaba "pasos"/"herramientas"/tiempo
-- de redacción/qué tool_choice viajó de verdad era `log.info("turno_tiempos")`
-- (agent.ts) — un log que un deploy destruye (ver T8 del mismo plan) y que
-- `agent_turns` nunca guardaba por fase, solo un total sumado entre las 3-7
-- llamadas al proveedor de cada turno. Este archivo prueba las tres piezas
-- que la migración deja listas para que T4 (siguiente tarea del mismo plan)
-- las llene desde `agent.ts`: la tabla `agent_turn_calls` (una fila por
-- llamada), la RPC agregada `agent_turn_calls_by_phase` y la nueva firma de
-- `agent_token_usage` (suma caché/razonamiento y deja de pagar is_agent()
-- por fila).
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final — mismo estilo que search_conversations_by_message.sql/
-- catalog_links.sql. Los datos chicos se insertan como `postgres` (bypassa
-- RLS) ANTES de simular sesión; las funciones bajo prueba son SECURITY
-- DEFINER (dueñas de `postgres`, que tiene rolbypassrls), así que lo que hay
-- que simular es el SUJETO que llama (auth.uid()), no permisos de tabla.
--
-- Caso 9 (rendimiento) sigue el mismo criterio que el caso 8 de
-- search_conversations_by_message.sql: mide con `clock_timestamp()` en vez de
-- `statement_timeout` (un `SET LOCAL` dentro de un bloque `do $$` no gobierna
-- retroactivamente el statement que ya está corriendo cuando el cambio
-- ocurre DENTRO de ese mismo bloque). Umbral 500 ms, mismo que esa suite —
-- 200.000 filas de agent_turn_calls es mayor volumen de fila que los 100.000
-- mensajes de aquel test, pero el agregado por fase es una sola pasada de
-- `group by` sobre una tabla angosta (trece columnas casi todas numéricas),
-- sin el `LIKE`/índice GIN trigram que hacía cara la búsqueda de mensajes.
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- La tabla temporal la crea el rol de conexión (postgres); los casos que
-- corren bajo `set local role authenticated` más abajo necesitan poder
-- anotar un error sin que la propia tabla de errores tire "permission
-- denied for table _errores" -- mismo hallazgo que ai_lessons.sql/
-- search_conversations_by_message.sql.
grant insert on _errores to authenticated;

-- ---------------------------------------------------------------------------
-- Datos base: un canal, un contacto, una conversación persistente, y un
-- "turno principal" (P) con cinco llamadas (una por fase, más una segunda
-- "redactar" simulando el paso posterior a una escalada con tool_choice
-- "none") que sirven de fixture para los casos 3-6. Un "turno X" descartable
-- para el caso de cascada (caso 2).
-- ---------------------------------------------------------------------------
insert into public.whatsapp_channels (id, label, phone_number) values
  ('a6a6a6a6-0000-0000-0000-000000000000', 'Canal de prueba telemetría', '+580000008000');

insert into public.contacts (id, phone_number) values
  ('a7a7a7a7-0000-0000-0000-000000000001', '+580000008001');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('a8a8a8a8-0000-0000-0000-000000000001', 'a7a7a7a7-0000-0000-0000-000000000001', 'a6a6a6a6-0000-0000-0000-000000000000');

insert into public.agent_turns (id, conversation_id, action, model, input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens) values
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 'escalated', 'gpt-5.6-luna', 660, 205, 865, 60, 50);

-- Turno descartable, para el caso 2 (cascada).
insert into public.agent_turns (id, conversation_id, action) values
  ('a9a9a9a9-0000-0000-0000-000000000002', 'a8a8a8a8-0000-0000-0000-000000000001', 'answered');

-- Cinco llamadas del turno P: escenario, clasificar, dos de redactar (la
-- segunda con tool_choice='none', como tras una escalada) e identidad.
insert into public.agent_turn_calls
  (turn_id, conversation_id, sequence, phase, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, max_output_tokens, tool_choice, finish_reason, duration_ms) values
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 1, 'escenario',  100, 20,  10, null, null, null,   'stop',       50),
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 2, 'clasificar', 200, 15,   0, null, null, null,   'stop',       80),
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 3, 'redactar',   300, 120, 50,   40, 1500, 'auto', 'tool-calls', 900),
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 4, 'redactar',   310, 60,   0,   10, 1500, 'none', 'stop',       400),
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 5, 'identidad',   50, 10,   0, null, 1500, null,   'stop',       120);

-- Dos agentes de prueba: A es un asesor real y activo; NA tiene sesión
-- válida de Supabase Auth pero SIN fila en public.agents (mismo patrón que
-- search_conversations_by_message.sql: is_active=false NO sirve para simular
-- "no agente" desde que is_agent() dejó de mirar esa columna,
-- 20260825040000_agent_switch_only_gates_ai.sql). handle_new_agent() crea la
-- fila espejo automáticamente al insertar en auth.users; se borra a mano
-- para NA.
insert into auth.users (id, email, raw_user_meta_data) values
  ('a5a5a5a5-0000-0000-0000-000000000001', 'agente-a-telemetria@sbk.test', jsonb_build_object('display_name', 'Agente A (telemetría)')),
  ('a5a5a5a5-0000-0000-0000-000000000002', 'agente-na-telemetria@sbk.test', jsonb_build_object('display_name', 'Agente NA (telemetría, sin fila en agents)'));

delete from public.agents where id = 'a5a5a5a5-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- Caso 1 · las seis columnas nuevas de agent_turns existen (nullable, sin
-- default -- "no se sabe" para lo viejo).
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'agent_turns'
    and column_name in ('steps', 'tools_used', 'wait_ms', 'classification_ms', 'generation_ms', 'delivery_ms')
    and is_nullable = 'YES';
  if n is distinct from 6 then
    insert into _errores(msg) values (format('Caso 1 (columnas de agent_turns): encontró %s de las 6 columnas nuevas (nullable), se esperaban 6.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · agent_turn_calls existe con sus 14 columnas, y el FK a
-- agent_turns borra en cascada.
-- ---------------------------------------------------------------------------
do $$
declare
  n_cols integer;
  n_antes integer;
  n_despues integer;
begin
  select count(*) into n_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'agent_turn_calls'
    and column_name in ('id', 'turn_id', 'conversation_id', 'sequence', 'phase', 'input_tokens',
                         'output_tokens', 'cached_input_tokens', 'reasoning_tokens', 'max_output_tokens',
                         'tool_choice', 'finish_reason', 'duration_ms', 'created_at');
  if n_cols is distinct from 14 then
    insert into _errores(msg) values (format('Caso 2 (columnas de agent_turn_calls): encontró %s de las 14 columnas esperadas.', n_cols));
  end if;

  insert into public.agent_turn_calls (turn_id, conversation_id, sequence, phase, duration_ms) values
    ('a9a9a9a9-0000-0000-0000-000000000002', 'a8a8a8a8-0000-0000-0000-000000000001', 1, 'escenario', 10),
    ('a9a9a9a9-0000-0000-0000-000000000002', 'a8a8a8a8-0000-0000-0000-000000000001', 2, 'redactar', 20);

  select count(*) into n_antes from public.agent_turn_calls where turn_id = 'a9a9a9a9-0000-0000-0000-000000000002';
  if n_antes is distinct from 2 then
    insert into _errores(msg) values (format('Caso 2 (cascada, antes de borrar): %s fila(s) para el turno descartable, se esperaban 2.', n_antes));
  end if;

  delete from public.agent_turns where id = 'a9a9a9a9-0000-0000-0000-000000000002';

  select count(*) into n_despues from public.agent_turn_calls where turn_id = 'a9a9a9a9-0000-0000-0000-000000000002';
  if n_despues is distinct from 0 then
    insert into _errores(msg) values (format('Caso 2 (cascada, después de borrar el turno): %s fila(s) quedaron huérfanas, se esperaban 0 (on delete cascade).', n_despues));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · authenticated NO puede leer agent_turn_calls directo: la tabla
-- tiene RLS habilitada sin ninguna política, así que un select da 0 filas
-- (no un error de permisos -- el grant de tabla de authenticated sigue ahí
-- por default privileges, lo que falta es una policy que RLS evalúe), aunque
-- el turno P tiene 5 filas reales sembradas más arriba.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'a5a5a5a5-0000-0000-0000-000000000001';

do $$
declare
  n integer;
begin
  select count(*) into n from public.agent_turn_calls;
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3 (select directo de authenticated): %s fila(s), se esperaban 0 -- RLS sin política debe filtrar TODO, aunque existan 5 filas reales del turno P.', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 4 · agent_turn_calls_by_phase suma bien, por fase, como authenticated
-- que SÍ es agente.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'a5a5a5a5-0000-0000-0000-000000000001';

do $$
declare
  errores text := '';
  r record;
begin
  select * into r from public.agent_turn_calls_by_phase(30) where phase = 'escenario';
  if r.calls is distinct from 1 or r.input_tokens is distinct from 100 or r.output_tokens is distinct from 20
     or r.cached_input_tokens is distinct from 10 or r.reasoning_tokens is distinct from 0
     or r.max_output_tokens_max is not null or r.tool_choice_none_calls is distinct from 0 then
    errores := errores || format(E'\n  - fase escenario: calls=%s input=%s output=%s cached=%s reasoning=%s max=%s none=%s (esperado calls=1 input=100 output=20 cached=10 reasoning=0 max=null none=0)',
      r.calls, r.input_tokens, r.output_tokens, r.cached_input_tokens, r.reasoning_tokens, r.max_output_tokens_max, r.tool_choice_none_calls);
  end if;

  select * into r from public.agent_turn_calls_by_phase(30) where phase = 'clasificar';
  if r.calls is distinct from 1 or r.input_tokens is distinct from 200 or r.output_tokens is distinct from 15
     or r.cached_input_tokens is distinct from 0 or r.reasoning_tokens is distinct from 0
     or r.max_output_tokens_max is not null or r.tool_choice_none_calls is distinct from 0 then
    errores := errores || format(E'\n  - fase clasificar: calls=%s input=%s output=%s cached=%s reasoning=%s max=%s none=%s (esperado calls=1 input=200 output=15 cached=0 reasoning=0 max=null none=0)',
      r.calls, r.input_tokens, r.output_tokens, r.cached_input_tokens, r.reasoning_tokens, r.max_output_tokens_max, r.tool_choice_none_calls);
  end if;

  -- redactar suma las DOS llamadas (300+310, 120+60, 50+0, 40+10) y cuenta
  -- UNA sola con tool_choice='none' -- la que sigue a la escalada.
  select * into r from public.agent_turn_calls_by_phase(30) where phase = 'redactar';
  if r.calls is distinct from 2 or r.input_tokens is distinct from 610 or r.output_tokens is distinct from 180
     or r.cached_input_tokens is distinct from 50 or r.reasoning_tokens is distinct from 50
     or r.max_output_tokens_max is distinct from 1500 or r.tool_choice_none_calls is distinct from 1 then
    errores := errores || format(E'\n  - fase redactar: calls=%s input=%s output=%s cached=%s reasoning=%s max=%s none=%s (esperado calls=2 input=610 output=180 cached=50 reasoning=50 max=1500 none=1)',
      r.calls, r.input_tokens, r.output_tokens, r.cached_input_tokens, r.reasoning_tokens, r.max_output_tokens_max, r.tool_choice_none_calls);
  end if;

  select * into r from public.agent_turn_calls_by_phase(30) where phase = 'identidad';
  if r.calls is distinct from 1 or r.input_tokens is distinct from 50 or r.output_tokens is distinct from 10
     or r.cached_input_tokens is distinct from 0 or r.reasoning_tokens is distinct from 0
     or r.max_output_tokens_max is distinct from 1500 or r.tool_choice_none_calls is distinct from 0 then
    errores := errores || format(E'\n  - fase identidad: calls=%s input=%s output=%s cached=%s reasoning=%s max=%s none=%s (esperado calls=1 input=50 output=10 cached=0 reasoning=0 max=1500 none=0)',
      r.calls, r.input_tokens, r.output_tokens, r.cached_input_tokens, r.reasoning_tokens, r.max_output_tokens_max, r.tool_choice_none_calls);
  end if;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 4 (agent_turn_calls_by_phase, agente real):%s', errores));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 5 · agent_turn_calls_by_phase devuelve VACÍO para un authenticated
-- que no es agente (sin fila en public.agents) -- mismas 5 filas reales que
-- el caso 4 sí ve.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'a5a5a5a5-0000-0000-0000-000000000002';

do $$
declare
  n integer;
begin
  select count(*) into n from public.agent_turn_calls_by_phase(30);
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 5 (agent_turn_calls_by_phase, no agente): %s fila(s), se esperaban 0.', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 6 · agent_token_usage devuelve las 7 columnas (day, model,
-- input_tokens, output_tokens, total_tokens, cached_input_tokens,
-- reasoning_tokens) con los valores del turno P, como agente real; vacío
-- para quien no es agente.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'a5a5a5a5-0000-0000-0000-000000000001';

do $$
declare
  r record;
begin
  -- Las 7 columnas de un RETURNS TABLE se validan leyéndolas del propio
  -- SELECT de abajo (r.day/r.model/.../r.reasoning_tokens): si a la RPC le
  -- faltara alguna, este bloque fallaría en tiempo de parseo/ejecución antes
  -- de llegar a comparar valores.
  select * into r from public.agent_token_usage(30) where model = 'gpt-5.6-luna';
  if r.model is null then
    insert into _errores(msg) values ('Caso 6 (agent_token_usage): no devolvió ninguna fila para gpt-5.6-luna, se esperaba una (el turno P sembrado más arriba).');
  else
    if r.input_tokens is distinct from 660 or r.output_tokens is distinct from 205 or r.total_tokens is distinct from 865
       or r.cached_input_tokens is distinct from 60 or r.reasoning_tokens is distinct from 50 then
      insert into _errores(msg) values (format('Caso 6 (agent_token_usage, valores): day=%s model=%s input=%s output=%s total=%s cached=%s reasoning=%s (esperado input=660 output=205 total=865 cached=60 reasoning=50)',
        r.day, r.model, r.input_tokens, r.output_tokens, r.total_tokens, r.cached_input_tokens, r.reasoning_tokens));
    end if;
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

set local role authenticated;
set local "request.jwt.claim.sub" = 'a5a5a5a5-0000-0000-0000-000000000002';

do $$
declare
  n integer;
begin
  select count(*) into n from public.agent_token_usage(30);
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 6b (agent_token_usage, no agente): %s fila(s), se esperaban 0.', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 7 · agent_turn_calls_purge borra SOLO lo anterior al plazo. Se
-- insertan tres filas "viejas" (150 días) más allá del retain_days=90 de
-- prueba, junto a las 5 del turno P (recientes, deben sobrevivir).
-- ---------------------------------------------------------------------------
insert into public.agent_turn_calls
  (turn_id, conversation_id, sequence, phase, duration_ms, created_at) values
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 90, 'redactar', 10, now() - interval '150 days'),
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 91, 'redactar', 10, now() - interval '160 days'),
  ('a9a9a9a9-0000-0000-0000-000000000001', 'a8a8a8a8-0000-0000-0000-000000000001', 92, 'redactar', 10, now() - interval '200 days');

do $$
declare
  n_antes integer;
  n_borradas integer;
  n_viejas_restantes integer;
begin
  select count(*) into n_antes from public.agent_turn_calls where turn_id = 'a9a9a9a9-0000-0000-0000-000000000001';
  if n_antes is distinct from 8 then
    insert into _errores(msg) values (format('Caso 7 (purgado, antes): %s fila(s) para el turno P, se esperaban 8 (5 recientes + 3 viejas).', n_antes));
  end if;

  select public.agent_turn_calls_purge(90) into n_borradas;
  if n_borradas is distinct from 3 then
    insert into _errores(msg) values (format('Caso 7 (purgado, filas borradas): devolvió %s, se esperaban 3 (solo las de 150/160/200 días).', n_borradas));
  end if;

  select count(*) into n_viejas_restantes from public.agent_turn_calls
    where turn_id = 'a9a9a9a9-0000-0000-0000-000000000001' and created_at < now() - interval '90 days';
  if n_viejas_restantes is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7 (purgado, verificación): quedaron %s fila(s) más viejas que 90 días, se esperaban 0.', n_viejas_restantes));
  end if;

  select count(*) into n_antes from public.agent_turn_calls where turn_id = 'a9a9a9a9-0000-0000-0000-000000000001';
  if n_antes is distinct from 5 then
    insert into _errores(msg) values (format('Caso 7 (purgado, sobrevivientes): quedaron %s fila(s) para el turno P, se esperaban 5 (las recientes del caso 4, intactas).', n_antes));
  end if;
end $$;

-- El purgado es SOLO de service_role -- authenticated no puede ejecutarlo.
set local role authenticated;
set local "request.jwt.claim.sub" = 'a5a5a5a5-0000-0000-0000-000000000001';

do $$
begin
  perform public.agent_turn_calls_purge(90);
  insert into _errores(msg) values ('Caso 7b (purgado, permisos): authenticated pudo ejecutar agent_turn_calls_purge() y NO debería (solo service_role).');
exception when insufficient_privilege then
  null; -- esperado
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 8 · has_function_privilege('anon', …) = false en las tres funciones,
-- y los grants positivos quedan donde corresponde.
-- ---------------------------------------------------------------------------
do $$
declare
  errores text := '';
begin
  if has_function_privilege('anon', 'public.agent_turn_calls_by_phase(integer)', 'execute') then
    errores := errores || E'\n  - anon puede ejecutar agent_turn_calls_by_phase() y no debería.';
  end if;
  if not has_function_privilege('authenticated', 'public.agent_turn_calls_by_phase(integer)', 'execute') then
    errores := errores || E'\n  - authenticated NO puede ejecutar agent_turn_calls_by_phase() y sí debería.';
  end if;
  if not has_function_privilege('service_role', 'public.agent_turn_calls_by_phase(integer)', 'execute') then
    errores := errores || E'\n  - service_role NO puede ejecutar agent_turn_calls_by_phase() y sí debería.';
  end if;

  if has_function_privilege('anon', 'public.agent_turn_calls_purge(integer)', 'execute') then
    errores := errores || E'\n  - anon puede ejecutar agent_turn_calls_purge() y no debería.';
  end if;
  if has_function_privilege('authenticated', 'public.agent_turn_calls_purge(integer)', 'execute') then
    errores := errores || E'\n  - authenticated puede ejecutar agent_turn_calls_purge() y NO debería (solo service_role).';
  end if;
  if not has_function_privilege('service_role', 'public.agent_turn_calls_purge(integer)', 'execute') then
    errores := errores || E'\n  - service_role NO puede ejecutar agent_turn_calls_purge() y sí debería.';
  end if;

  if has_function_privilege('anon', 'public.agent_token_usage(integer)', 'execute') then
    errores := errores || E'\n  - anon puede ejecutar agent_token_usage() y no debería.';
  end if;
  if not has_function_privilege('authenticated', 'public.agent_token_usage(integer)', 'execute') then
    errores := errores || E'\n  - authenticated NO puede ejecutar agent_token_usage() y sí debería.';
  end if;
  if not has_function_privilege('service_role', 'public.agent_token_usage(integer)', 'execute') then
    errores := errores || E'\n  - service_role NO puede ejecutar agent_token_usage() y sí debería.';
  end if;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 8 (permisos):%s', errores));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 9 · RESGUARDO DE RENDIMIENTO. Siembra 200.000 filas de
-- agent_turn_calls (un turno y una conversación propios, para no interferir
-- con los conteos de los casos 4-7) y mide agent_turn_calls_by_phase(30)
-- como authenticated con clock_timestamp() -- ver el comentario de cabecera
-- sobre por qué no se usa statement_timeout acá.
-- ---------------------------------------------------------------------------
-- Prefijo d6/d7/d8/d9 (no dddddddd -- seed.sql YA usa 'dddddddd-0000-0000-0000-00000000000N'
-- para cinco conversaciones de demo; colisionaba con la 2).
insert into public.whatsapp_channels (id, label, phone_number) values
  ('d6d6d6d6-0000-0000-0000-000000000000', 'Canal de prueba rendimiento (telemetría)', '+580000009900');

insert into public.contacts (id, phone_number) values
  ('d7d7d7d7-0000-0000-0000-000000000001', '+580000009901');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('d8d8d8d8-0000-0000-0000-000000000002', 'd7d7d7d7-0000-0000-0000-000000000001', 'd6d6d6d6-0000-0000-0000-000000000000');

insert into public.agent_turns (id, conversation_id, action) values
  ('d9d9d9d9-0000-0000-0000-000000000003', 'd8d8d8d8-0000-0000-0000-000000000002', 'answered');

insert into public.agent_turn_calls
  (turn_id, conversation_id, sequence, phase, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, max_output_tokens, tool_choice, finish_reason, duration_ms, created_at)
select
  'd9d9d9d9-0000-0000-0000-000000000003',
  'd8d8d8d8-0000-0000-0000-000000000002',
  ((g % 30) + 1)::smallint,
  (array['escenario', 'clasificar', 'redactar', 'identidad'])[(g % 4) + 1],
  100 + (g % 500),
  40 + (g % 200),
  10 + (g % 50),
  case when g % 3 = 0 then 20 + (g % 40) else null end,
  case when (g % 4) = 2 then 1500 else null end, -- (g % 4)+1 = 3 -> "redactar"
  case when g % 10 = 0 then 'none' else 'auto' end,
  'stop',
  100 + (g % 900),
  now() - ((200000 - g) || ' seconds')::interval
from generate_series(1, 200000) g;

analyze public.agent_turn_calls;

set local role authenticated;
set local "request.jwt.claim.sub" = 'a5a5a5a5-0000-0000-0000-000000000001';

do $$
declare
  t0 timestamptz;
  elapsed_ms numeric;
  n integer;
  umbral_ms constant numeric := 500;
begin
  t0 := clock_timestamp();
  select count(*) into n from public.agent_turn_calls_by_phase(30);
  elapsed_ms := extract(epoch from (clock_timestamp() - t0)) * 1000;

  if elapsed_ms > umbral_ms then
    insert into _errores(msg) values (format(
      'Caso 9 (rendimiento): agent_turn_calls_by_phase tardó %s ms (umbral %s ms) contra ~200.000 filas sembradas, como authenticated.',
      round(elapsed_ms), umbral_ms
    ));
  end if;

  raise notice 'Caso 9 (rendimiento): % ms (umbral % ms), % fila(s) de fase.', round(elapsed_ms, 1), umbral_ms, n;
end $$;

reset role;
reset "request.jwt.claim.sub";

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
    raise exception E'telemetria_del_turno.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'telemetria_del_turno.sql: todas las aserciones pasaron.'
