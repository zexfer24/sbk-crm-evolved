-- ============================================================================
-- Aserciones de permisos sobre funciones security definer de public
--
-- Se corre con `psql -v ON_ERROR_STOP=1 -f supabase/tests/permisos_funciones.sql`
-- contra la base reconstruida desde cero en CI (job `migraciones`). Un `raise
-- exception` dentro de cualquiera de los `do $$ ... $$;` de abajo hace que
-- psql corte con exit ≠ 0 y ponga el job en rojo — no hay "reportar y
-- seguir": la primera falla tumba el script.
--
-- Origen: auditoría del 30/8/2026 contra el VPS de producción. Con la anon
-- key pública (la que viaja al navegador) y sin sesión:
--   POST /rest/v1/rpc/agent_metrics {"p_days":1} → HTTP 200 con métricas por
--   asesor, ventas y montos.
-- Causa: el EXECUTE le llega a anon por DOS vías independientes, y `security
-- definer` salta RLS — no hay política que frene lo que ya puede ejecutar.
--   1) Postgres le da EXECUTE de fábrica al pseudo-rol PUBLIC en toda función
--      nueva (se ve en pg_proc.proacl como una entrada `=X/postgres`, sin
--      nombre de rol antes del `=`); anon hereda de PUBLIC, así que
--      has_function_privilege('anon', ...) da true aunque nunca se le haya
--      hecho un grant a anon por su nombre. Se corta con
--      `revoke ... from public`.
--   2) Supabase deja de fábrica un `alter default privileges ... grant
--      execute on functions to anon, authenticated, service_role` en el
--      esquema public, que además le pone grants EXPLÍCITOS a esos tres
--      roles. Se corta con `revoke ... from anon, authenticated`.
-- Ninguna de las dos alcanza sola: la migración
-- 20260830010000_security_definer_revoke_roles.sql se escribió primero solo
-- con el revoke de roles (vía 2), y aplicada contra una base real 14 de 17
-- funciones siguieron ejecutables por anon — les faltaba cortar la vía 1.
-- Las tres que sí quedaron cerradas (las del lock, ai_turn_lock_*) lo
-- estaban de casualidad: su migración vieja (20260829020000) ya traía el
-- `revoke ... from public` que a la nueva le faltaba. Y después de revocar
-- de PUBLIC hay que devolver con un `grant` explícito el acceso a quien deba
-- conservarlo (authenticated si la llama el navegador, service_role si la
-- llama la IA): si a ese rol el acceso le venía solo por PUBLIC, el revoke
-- se lo saca también, sin avisar.
--
-- La aserción 1 de abajo es la más importante de este archivo: es la red que
-- atrapa a la función security definer que alguien agregue el año que viene
-- sin acordarse de revocarle EXECUTE a anon. Las aserciones 2 y 3 fijan el
-- estado conocido función por función (útil para el mensaje de error
-- específico); la 1 es la que no depende de que nadie actualice una lista.
--
-- ----------------------------------------------------------------------------
-- LA TRAMPA — por qué is_agent() e is_supervisor_or_admin() están en la
-- lista blanca A PROPÓSITO, no por descuido:
--
-- 49 políticas de RLS vivas invocan alguna de las dos (39 con is_agent(), 14
-- con is_supervisor_or_admin(), descontando las ya dropeadas y reemplazadas),
-- y 48 de esas 49 no llevan cláusula `TO` — o sea que son `TO public` y
-- corren para todos los roles, anon incluido. Una expresión de política se
-- evalúa CON LOS PRIVILEGIOS DEL ROL QUE CONSULTA: si a anon se le revoca
-- EXECUTE sobre is_agent(), una consulta anónima a `contacts` deja de
-- devolver 0 filas (que es lo correcto: RLS filtrando todo) y pasa a
-- reventar con `42501 permission denied for function is_agent`. Si se le
-- revoca a authenticated, se cae el CRM para todo el equipo, porque cada
-- política que hoy dice "solo si is_agent()" deja de poder evaluarse para
-- cualquier asesor con sesión real.
--
-- Ninguna de las dos funciones filtra nada por sí sola: son un booleano
-- sobre quién pregunta, el filtro lo pone la política que las usa. La
-- aserción 5 de abajo es la prueba en vivo de esto — no es decorativa, es la
-- que demuestra por qué la lista blanca tiene que seguir teniendo estas dos
-- funciones y ninguna más. Que nadie las saque "por consistencia" con las
-- demás.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. El guardián general: ninguna función security definer del esquema
--    public puede ser ejecutable por anon, salvo la lista blanca explícita.
--
--    Esto es lo que atrapa a la función nueva que alguien escriba el año que
--    viene y se olvide de cerrar: no depende de mantener actualizada una
--    lista de nombres, recorre pg_proc de verdad.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  infractoras text := '';
begin
  for r in
    select
      p.oid,
      p.proname,
      pg_get_function_identity_arguments(p.oid) as argumentos
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef = true
      and p.proname not in ('is_agent', 'is_supervisor_or_admin') -- lista blanca, ver LA TRAMPA arriba
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    infractoras := infractoras || format(E'\n  - public.%I(%s) — ejecutable por anon', r.proname, r.argumentos);
  end loop;

  if infractoras <> '' then
    raise exception E'Funciones security definer ejecutables por anon fuera de la lista blanca (is_agent, is_supervisor_or_admin):%\nEl EXECUTE llega por dos vías independientes, hay que cortar las dos en la migración: `revoke execute on function ... from public;` (Postgres se lo da de fábrica al pseudo-rol PUBLIC, y anon hereda de ahí) Y `revoke execute on function ... from anon, authenticated;` (el `alter default privileges` de Supabase le da EXECUTE explícito a esos roles aparte). Con una sola de las dos la función sigue abierta — pasó con 14 de 17 el 30/8/2026. Después, devolvé con `grant execute ... to authenticated` o `to service_role` el acceso a quien deba conservarlo: si le venía solo por PUBLIC, el revoke se lo saca también.', infractoras;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Grupo service_role — cerradas del todo a anon y authenticated. Solo las
--    llama el servidor con createAdminClient() (service_role), nunca el
--    navegador con sesión.
-- ---------------------------------------------------------------------------
do $$
declare
  funciones text[] := array[
    'public.ai_turn_lock_acquire(uuid, text, integer)',
    'public.ai_turn_lock_renew(uuid, text, integer)',
    'public.ai_turn_lock_release(uuid, text)',
    'public.claim_agent_turn(integer, integer)',
    'public.enqueue_agent_turn(uuid, integer)',
    'public.finish_agent_turn(uuid, text, integer)',
    'public.rate_limit_allow(text, integer, integer)'
  ];
  f text;
  errores text := '';
begin
  foreach f in array funciones loop
    if has_function_privilege('anon', f::regprocedure, 'EXECUTE') then
      errores := errores || format(E'\n  - %s: anon puede ejecutarla y NO debería (grupo service_role)', f);
    end if;
    if has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      errores := errores || format(E'\n  - %s: authenticated puede ejecutarla y NO debería (grupo service_role)', f);
    end if;
    if not has_function_privilege('service_role', f::regprocedure, 'EXECUTE') then
      errores := errores || format(E'\n  - %s: service_role NO puede ejecutarla y SÍ debería (la usa el servidor con createAdminClient)', f);
    end if;
  end loop;

  if errores <> '' then
    raise exception E'Permisos incorrectos en el grupo service_role:%', errores;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 3. Grupo authenticated — cerradas a anon, pero SIGUEN abiertas para
--    authenticated. El navegador con sesión de asesor las llama de verdad
--    (fetchAgentSettings, fetchAgentMetrics, el panel de Control de IA): si
--    alguien las cierra también ahí "por prolijidad", apaga la bandeja y ese
--    panel para todo el equipo — tan grave como dejarlas abiertas a anon.
-- ---------------------------------------------------------------------------
do $$
declare
  funciones text[] := array[
    'public.agent_metrics(integer)',
    'public.agent_can_run()',
    'public.agent_spend_today()'
  ];
  f text;
  errores text := '';
begin
  foreach f in array funciones loop
    if has_function_privilege('anon', f::regprocedure, 'EXECUTE') then
      errores := errores || format(E'\n  - %s: anon puede ejecutarla y NO debería', f);
    end if;
    if not has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') then
      errores := errores || format(E'\n  - %s: authenticated NO puede ejecutarla y SÍ debería (la llama el navegador con sesión — cerrarla apaga la bandeja o el panel de Control de IA)', f);
    end if;
    if not has_function_privilege('service_role', f::regprocedure, 'EXECUTE') then
      errores := errores || format(E'\n  - %s: service_role NO puede ejecutarla y SÍ debería', f);
    end if;
  end loop;

  if errores <> '' then
    raise exception E'Permisos incorrectos en el grupo authenticated:%', errores;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 4. No-regresión de las intocables: is_agent() e is_supervisor_or_admin()
--    siguen ejecutables por los tres roles. Ver LA TRAMPA al inicio del
--    archivo — esto NO es un descuido si algún día alguien intenta "cerrar"
--    estas dos por consistencia con las de arriba.
-- ---------------------------------------------------------------------------
do $$
declare
  funciones text[] := array[
    'public.is_agent()',
    'public.is_supervisor_or_admin()'
  ];
  roles text[] := array['anon', 'authenticated', 'service_role'];
  f text;
  rol text;
  errores text := '';
begin
  foreach f in array funciones loop
    foreach rol in array roles loop
      if not has_function_privilege(rol, f::regprocedure, 'EXECUTE') then
        errores := errores || format(E'\n  - %s: %s NO puede ejecutarla y SÍ debería (49 políticas RLS "to public" la invocan — ver LA TRAMPA al inicio del archivo)', f, rol);
      end if;
    end loop;
  end loop;

  if errores <> '' then
    raise exception E'Regresión en las funciones intocables de RLS:%', errores;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 5. La prueba de que la no-regresión de arriba importa de verdad: una
--    consulta anónima a una tabla con RLS "to public using (is_agent())"
--    tiene que devolver 0 filas y NO reventar con 42501. Si is_agent()
--    perdiera EXECUTE para anon, esta misma consulta pasaría de "0 filas" a
--    "permission denied for function is_agent" — el síntoma exacto que
--    describe LA TRAMPA al inicio del archivo. Esta aserción es la que
--    demuestra en vivo por qué is_agent() no se puede revocar.
-- ---------------------------------------------------------------------------
set role anon;

do $$
declare
  n bigint;
begin
  begin
    select count(*) into n from public.contacts;
  exception when insufficient_privilege then
    raise exception 'select count(*) from public.contacts como anon reventó con permiso denegado (42501). Esto pasa si is_agent() (o is_supervisor_or_admin()) perdió EXECUTE para anon/authenticated: NO SE LES REVOCA, 49 políticas RLS "to public" dependen de poder evaluarlas con el rol que consulta. Ver LA TRAMPA al inicio de este archivo.';
  end;

  if n is distinct from 0 then
    raise exception 'select count(*) from public.contacts como anon devolvió % filas; se esperaban 0 (RLS debe filtrar todo para un rol sin sesión).', n;
  end if;
end $$;

reset role;

\echo 'permisos_funciones.sql: todas las aserciones pasaron.'
