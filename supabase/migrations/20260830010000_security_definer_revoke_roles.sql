-- ============================================================================
-- Las funciones security definer dejan de ser ejecutables por anon
--
-- Supabase deja un `alter default privileges ... grant execute on functions
-- to anon, authenticated, service_role` en el esquema public (confirmado en
-- pg_default_acl, junto con el mismo default para postgres y
-- supabase_admin). Toda función nueva nace ejecutable por anon, y
-- `security definer` salta RLS: no hay política que la frene.
--
-- Evidencia real contra producción el 30/8/2026, con la anon key pública (la
-- que viaja al navegador) y sin sesión:
--   - POST /rest/v1/rpc/agent_metrics {"p_days":1} → HTTP 200 con métricas
--     por asesor, ventas y montos.
--   - POST /rest/v1/rpc/ai_turn_lock_acquire con un conversation_id real →
--     HTTP 200, toma el lock y deja esa conversación muda para la IA.
--   - claim_agent_turn(integer, integer) no tiene argumentos obligatorios:
--     cualquiera puede robarle turnos a la cola.
--
-- EL PRIVILEGIO LLEGA POR DOS VÍAS DISTINTAS, Y HAY QUE CORTAR LAS DOS:
--   1. El `EXECUTE` de fábrica que Postgres — no Supabase — concede a toda
--      función nueva al pseudo-rol PUBLIC. Se corta con
--      `revoke execute ... from public`.
--   2. Los grants explícitos que el `alter default privileges` de Supabase
--      deja puestos en `anon`/`authenticated` (visibles en pg_default_acl).
--      Se cortan con `revoke execute ... from anon, authenticated`.
-- Mientras quede el de PUBLIC, `has_function_privilege('anon', ...)` sigue
-- devolviendo `true` aunque el grant explícito a `anon` ya se haya
-- revocado — `anon` hereda de PUBLIC. Un revoke que solo toque una de las
-- dos vías no cierra nada, y el `.sql` de cualquiera de las dos versiones
-- se lee igual de bien: no hay forma de distinguirlas leyendo el código,
-- solo midiendo contra la base.
--
-- Primer intento, primera versión de esta misma migración, aplicada contra
-- una base local real el 30/8/2026: solo tenía el revoke de
-- `anon, authenticated` (vía 2). Al medir después con
-- `has_function_privilege` contra `pg_proc.proacl`, de las 17 funciones solo
-- las tres del lock (`ai_turn_lock_acquire/renew/release`) habían quedado
-- realmente cerradas a `anon` — porque su migración original
-- (20260829020000_conversations_turn_lock_lease.sql:113-115) ya traía el
-- `revoke ... from public` que a esta migración le faltaba. Las otras
-- catorce seguían con el `=X/postgres` de PUBLIC en su ACL, así que
-- `anon` seguía pudiendo ejecutarlas. Sin esa medición se habría desplegado
-- esta migración creyendo el problema resuelto: por eso el test de permisos
-- (que corre `has_function_privilege` contra la base, no contra el `.sql`)
-- es parte del arreglo y no un extra.
--
-- Un intento anterior a ese, más viejo, había ido por la otra mitad:
--   - 20260822040000_agent_turn_queue.sql:115-119 ni siquiera lo intentó:
--     solo tiene `grant ... to service_role`, ninguna línea `revoke`.
--
-- Después de revocar de PUBLIC hace falta devolver explícitamente el acceso
-- a quien lo necesita: si un rol lo tenía solo por herencia de PUBLIC, este
-- revoke se lo saca igual que al resto. Cada función que el navegador o el
-- servidor siguen llamando lleva su `grant` explícito al lado del revoke,
-- aunque ya lo tuviera por su migración original — así esta migración queda
-- autosuficiente e idempotente, y un `revoke from public` futuro en otro
-- archivo no la vuelve a cerrar por accidente.
--
-- Auditoría cerrada, llamador y rol de Postgres verificados uno por uno
-- (createAdminClient = service_role, createClient de lib/supabase/server =
-- authenticated con cookie de sesión — que un archivo corra en el servidor
-- NO dice con qué rol llama; lo dice el cliente Supabase que usa). Firmas
-- confirmadas contra las migraciones que las definen; no queda ninguna
-- sobrecarga huérfana de las viejas enqueue_agent_turn(uuid) /
-- finish_agent_turn(uuid, text) — 20260822050000_agent_turn_debounce.sql:42-43
-- las dropea antes de crear las de 2 y 3 argumentos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Grupo 1 — solo service_role las llama (todas vía createAdminClient, nunca
-- con cookie de sesión). Se cierran del todo a anon y authenticated, y el
-- grant a service_role queda explícito para no depender de PUBLIC ni de la
-- migración original.
-- ---------------------------------------------------------------------------
revoke execute on function public.ai_turn_lock_acquire(uuid, text, integer) from public;
revoke execute on function public.ai_turn_lock_acquire(uuid, text, integer) from anon, authenticated;
grant execute on function public.ai_turn_lock_acquire(uuid, text, integer) to service_role;

revoke execute on function public.ai_turn_lock_renew(uuid, text, integer) from public;
revoke execute on function public.ai_turn_lock_renew(uuid, text, integer) from anon, authenticated;
grant execute on function public.ai_turn_lock_renew(uuid, text, integer) to service_role;

revoke execute on function public.ai_turn_lock_release(uuid, text) from public;
revoke execute on function public.ai_turn_lock_release(uuid, text) from anon, authenticated;
grant execute on function public.ai_turn_lock_release(uuid, text) to service_role;

revoke execute on function public.claim_agent_turn(integer, integer) from public;
revoke execute on function public.claim_agent_turn(integer, integer) from anon, authenticated;
grant execute on function public.claim_agent_turn(integer, integer) to service_role;

revoke execute on function public.enqueue_agent_turn(uuid, integer) from public;
revoke execute on function public.enqueue_agent_turn(uuid, integer) from anon, authenticated;
grant execute on function public.enqueue_agent_turn(uuid, integer) to service_role;

revoke execute on function public.finish_agent_turn(uuid, text, integer) from public;
revoke execute on function public.finish_agent_turn(uuid, text, integer) from anon, authenticated;
grant execute on function public.finish_agent_turn(uuid, text, integer) to service_role;

revoke execute on function public.rate_limit_allow(text, integer, integer) from public;
revoke execute on function public.rate_limit_allow(text, integer, integer) from anon, authenticated;
grant execute on function public.rate_limit_allow(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Grupo 2 — el navegador SÍ las llama, pero siempre con sesión de asesor. Se
-- quedan ejecutables por authenticated: cerrarlas también ahí apaga el CRM.
-- El revoke de PUBLIC les saca el EXECUTE de fábrica, así que el grant a
-- authenticated queda explícito para no perder el acceso.
--
--   - agent_spend_today: src/components/crm-shell.tsx:228 y
--     src/components/agent-control/agent-control-view.tsx:257 (los dos
--     "use client") → fetchAgentSettings (src/lib/data.ts:1803) →
--     rpc("agent_spend_today") en la línea 1806.
--   - agent_metrics: agent-control-view.tsx:263 → fetchAgentMetrics
--     (src/lib/data.ts:1330).
--   - agent_can_run: src/app/api/agent/backlog/route.ts:68. La ruta corre en
--     el servidor, pero el cliente que arma en la línea 50 es createClient()
--     de @/lib/supabase/server — anon key + cookie de sesión, no
--     service_role. Por eso viaja como authenticated y no se puede tocar
--     acá: lo que decide el rol de la llamada es el cliente Supabase usado
--     (server.ts = authenticated, admin.ts = service_role), no si el
--     archivo que la invoca es de servidor.
-- ---------------------------------------------------------------------------
revoke execute on function public.agent_metrics(integer) from public;
revoke execute on function public.agent_metrics(integer) from anon;
grant execute on function public.agent_metrics(integer) to authenticated;

revoke execute on function public.agent_can_run() from public;
revoke execute on function public.agent_can_run() from anon;
grant execute on function public.agent_can_run() to authenticated;

revoke execute on function public.agent_spend_today() from public;
revoke execute on function public.agent_spend_today() from anon;
grant execute on function public.agent_spend_today() to authenticated;

-- ---------------------------------------------------------------------------
-- Grupo 3 — higiene: `returns trigger`, PostgREST nunca las expone como RPC,
-- pero nacieron con el mismo default privilege abierto que todo lo demás. Se
-- cierran del todo porque no las llama ni el navegador ni el servidor por
-- RPC — solo triggers de Postgres, que no necesitan privilegio de rol. No
-- llevan grant: Postgres ejecuta funciones de trigger sin comprobar EXECUTE
-- del rol que dispara la operación.
-- ---------------------------------------------------------------------------
revoke execute on function public.enforce_sale_role_guard() from public;
revoke execute on function public.enforce_sale_role_guard() from anon, authenticated;

revoke execute on function public.handle_conversation_assigned() from public;
revoke execute on function public.handle_conversation_assigned() from anon, authenticated;

revoke execute on function public.handle_message_status_change() from public;
revoke execute on function public.handle_message_status_change() from anon, authenticated;

revoke execute on function public.handle_new_agent() from public;
revoke execute on function public.handle_new_agent() from anon, authenticated;

revoke execute on function public.handle_new_message() from public;
revoke execute on function public.handle_new_message() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grupo 4 — `security invoker` (no definer): hoy no filtran nada distinto
-- porque las tablas que tocan (agent_turns, messages, conversations) tienen
-- RLS con `using (public.is_agent())`, así que una llamada anónima ya
-- recibía conjuntos vacíos. Se cierran igual: depender en silencio de que la
-- política compense el privilegio de ejecución es justo la fragilidad que
-- ya mordió una vez con `ai_turn_running` (ver 20260829020000). Solo anon:
-- el navegador con sesión sí las usa, así que el grant a authenticated
-- queda explícito.
-- ---------------------------------------------------------------------------
revoke execute on function public.agent_token_usage(integer) from public;
revoke execute on function public.agent_token_usage(integer) from anon;
grant execute on function public.agent_token_usage(integer) to authenticated;

revoke execute on function public.message_activity_by_hour(timestamptz, timestamptz, text) from public;
revoke execute on function public.message_activity_by_hour(timestamptz, timestamptz, text) from anon;
grant execute on function public.message_activity_by_hour(timestamptz, timestamptz, text) to authenticated;

revoke execute on function public.search_conversations_by_message(text, integer) from public;
revoke execute on function public.search_conversations_by_message(text, integer) from anon;
grant execute on function public.search_conversations_by_message(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- LO QUE ESTA MIGRACIÓN A PROPÓSITO NO TOCA
--
-- is_agent() e is_supervisor_or_admin() NO se revocan a ningún rol, ni
-- siquiera a PUBLIC. 49 políticas de RLS vivas las invocan (39 con
-- is_agent(), 14 con is_supervisor_or_admin(), descontando 4 ya dropeadas y
-- reemplazadas), y 48 de esas 49 no llevan cláusula TO — o sea que son TO
-- public y corren para todos los roles, anon incluido. Una política se
-- evalúa CON LOS PRIVILEGIOS DEL ROL QUE CONSULTA: si a anon se le quita
-- EXECUTE sobre is_agent() (por la vía que sea, PUBLIC o el grant
-- explícito), una consulta anónima a `contacts` deja de devolver 0 filas y
-- pasa a reventar con 42501 (permission denied for function is_agent). Si
-- se le quita a authenticated, se cae el CRM para todo el equipo. Ninguna
-- de las dos funciones filtra nada por sí sola: son un booleano sobre quién
-- pregunta, el filtro lo pone la política que las usa. No agregarlas acá
-- "por consistencia" con las de arriba.
-- ---------------------------------------------------------------------------

notify pgrst, 'reload schema';
