-- ===========================================================================
-- La demora del asesor (T10a, plan "Seba encuentra, no insiste, y el mostrador
-- no deja a nadie esperando", 28/9/2026, Entrega B)
--
-- Migración bajo prueba: 20260929020000_demora_del_asesor.sql.
--
-- Mismo patrón que carrito_por_conversacion.sql: una transacción con rollback,
-- tabla temporal `_errores`, un solo `raise exception` al final con todo lo
-- acumulado. La parte de permisos baja de rol de verdad (`set local role`):
-- como `postgres` se salta RLS y grants y no mediría nada.
--
-- Qué fija:
--   1. `conversation_handoffs_reason_check` acepta las DOS razones nuevas
--      (`reasignada_por_demora`, `demora_sin_asesor`), sigue aceptando las 30
--      que ya tenía (lista literal copiada de 20260917010000, la última que
--      tocó ese CHECK) y rechaza una inventada.
--   2. `agent_settings.demora_activa` nace `false` y `demora_activa_desde`
--      nace `null` (el interruptor arranca apagado: encenderlo es una decisión
--      del operador tras desplegar).
--   3. `conversation_delay_episodes`: la PK (conversation_id, episode_at) es el
--      candado de idempotencia. `insert … on conflict do nothing` no duplica
--      el episodio, y `update … where responded_at is null returning`
--      RECLAMA una sola vez (dos pasadas del cron en el mismo minuto dan una
--      sola acción).
--   4. `origen` solo admite 'escalada' o 'cliente'; los defaults son los del
--      plan (reassignments 0, agentes_previos '{}').
--   5. Borrar la conversación borra sus episodios (cascade).
--   6. La tabla tiene RLS habilitada SIN ninguna política y solo `service_role`
--      la toca: un agente autenticado no obtiene ninguna fila (ni escribe) --
--      mismo criterio que `agent_turn_calls` (20260921040000), pero además con
--      los grants de fábrica de Supabase quitados a anon/authenticated.
--
-- Corre en el job `migraciones` de CI.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- Un agente corriente (para medir lo que ve un `authenticated` real).
insert into auth.users (id, email, raw_user_meta_data) values
  ('de1a0000-0000-0000-0000-000000000001', 'agente-demora@sbk.test', jsonb_build_object('display_name', 'Agente (demora)'));

-- Fixtures (como postgres, sin RLS).
insert into public.whatsapp_channels (id, label, phone_number) values
  ('de1a0000-1000-0000-0000-000000000000', 'Canal de prueba demora', '+580000009500');
insert into public.contacts (id, phone_number) values
  ('de1a0000-2000-0000-0000-000000000001', '+580000009501'),
  ('de1a0000-2000-0000-0000-000000000002', '+580000009502');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('de1a0000-3000-0000-0000-000000000001', 'de1a0000-2000-0000-0000-000000000001', 'de1a0000-1000-0000-0000-000000000000'),
  ('de1a0000-3000-0000-0000-000000000002', 'de1a0000-2000-0000-0000-000000000002', 'de1a0000-1000-0000-0000-000000000000');

-- ---------------------------------------------------------------------------
-- Caso 1 · el CHECK de conversation_handoffs.reason.
--   a) acepta las dos razones nuevas;
--   b) sigue aceptando las 30 de antes (lista literal de 20260917010000);
--   c) rechaza una inventada.
-- Cada insert va en su propio sub-bloque: un check_violation aborta solo ese
-- intento, no la transacción entera.
-- ---------------------------------------------------------------------------
do $$
declare
  v_nuevas text[] := array['reasignada_por_demora', 'demora_sin_asesor'];
  v_viejas text[] := array[
    'agente_no_puede_correr','conversacion_inexistente','pausada','asignada','humano_intervino',
    'humano_se_adelanto','fuera_de_ventana','identidad_no_verificable','lock_perdido','abandonado',
    'entrega_fallida','reabierto','escalado_por_ia','reclamado','devuelto_a_ia','cerrado',
    'ventana_vencida','sla_vencido','escalada','escalada_sin_asesor','rechazado_por_meta',
    'cerrada_por_asesor','reabierta_por_asesor','reabierta_por_cliente','sin_contenido_legible',
    'cortesia_tras_escalada','desasignada_por_asesor','mensaje_previo_a_devolucion',
    'silenciada_por_asesor','fuera_de_tema_repetido'
  ];
  v_razon text;
  v_entro boolean;
begin
  foreach v_razon in array v_nuevas || v_viejas loop
    begin
      insert into public.conversation_handoffs (conversation_id, to_kind, reason)
        values ('de1a0000-3000-0000-0000-000000000001', 'unassigned', v_razon);
    exception when check_violation then
      insert into _errores(msg) values (format('Caso 1: el CHECK de conversation_handoffs.reason rechazó la razón "%s" (debía aceptarla).', v_razon));
    end;
  end loop;

  v_entro := false;
  begin
    insert into public.conversation_handoffs (conversation_id, to_kind, reason)
      values ('de1a0000-3000-0000-0000-000000000001', 'unassigned', 'razon_inventada_por_el_test');
    v_entro := true;
  exception when check_violation then
    null;
  end;
  if v_entro then
    insert into _errores(msg) values ('Caso 1: el CHECK aceptó una razón inventada (perdió su lista cerrada).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · agent_settings: el interruptor nace apagado y sin fecha.
-- ---------------------------------------------------------------------------
do $$
declare
  v_activa boolean;
  v_desde timestamptz;
  v_nullable_activa text;
  v_nullable_desde text;
  v_default_activa text;
  v_tipo_activa text;
  v_tipo_desde text;
begin
  select demora_activa, demora_activa_desde into v_activa, v_desde
    from public.agent_settings where id;

  if v_activa is distinct from false then
    insert into _errores(msg) values (format('Caso 2: agent_settings.demora_activa debía ser false en la fila singleton, es %s.', v_activa));
  end if;
  if v_desde is not null then
    insert into _errores(msg) values (format('Caso 2: agent_settings.demora_activa_desde debía ser null, es %s.', v_desde));
  end if;

  select data_type, is_nullable, column_default into v_tipo_activa, v_nullable_activa, v_default_activa
    from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_settings' and column_name = 'demora_activa';
  if v_tipo_activa is distinct from 'boolean' or v_nullable_activa is distinct from 'NO' or v_default_activa is distinct from 'false' then
    insert into _errores(msg) values (format('Caso 2: demora_activa debía ser boolean NOT NULL default false; es %s / nullable=%s / default=%s.', v_tipo_activa, v_nullable_activa, v_default_activa));
  end if;

  select data_type, is_nullable into v_tipo_desde, v_nullable_desde
    from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_settings' and column_name = 'demora_activa_desde';
  if v_tipo_desde is distinct from 'timestamp with time zone' or v_nullable_desde is distinct from 'YES' then
    insert into _errores(msg) values (format('Caso 2: demora_activa_desde debía ser timestamptz nullable; es %s / nullable=%s.', v_tipo_desde, v_nullable_desde));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · defaults de conversation_delay_episodes y CHECK de `origen`.
-- ---------------------------------------------------------------------------
do $$
declare
  r public.conversation_delay_episodes;
  v_entro boolean;
begin
  insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
    values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 10:00:00+00', 'escalada')
    returning * into r;

  if r.reassignments is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3: reassignments debía nacer en 0, nace en %s.', r.reassignments));
  end if;
  if r.agentes_previos is distinct from '{}'::uuid[] then
    insert into _errores(msg) values (format('Caso 3: agentes_previos debía nacer vacío, nace %s.', r.agentes_previos));
  end if;
  if r.created_at is null then
    insert into _errores(msg) values ('Caso 3: created_at debía nacer con now().');
  end if;
  if r.responded_at is not null or r.ultima_reasignacion_at is not null or r.supervisor_notified_at is not null then
    insert into _errores(msg) values ('Caso 3: responded_at, ultima_reasignacion_at y supervisor_notified_at debían nacer en null.');
  end if;

  -- 'cliente' también es un origen válido.
  insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
    values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 11:00:00+00', 'cliente');

  -- Cualquier otro valor lo rechaza el CHECK.
  v_entro := false;
  begin
    insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
      values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 12:00:00+00', 'otro');
    v_entro := true;
  exception when check_violation then
    null;
  end;
  if v_entro then
    insert into _errores(msg) values ('Caso 3: origen = ''otro'' se aceptó (el CHECK in (''escalada'',''cliente'') no está).');
  end if;

  -- origen es obligatorio.
  v_entro := false;
  begin
    insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
      values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 13:00:00+00', null);
    v_entro := true;
  exception when not_null_violation or check_violation then
    null;
  end;
  if v_entro then
    insert into _errores(msg) values ('Caso 3: origen = null se aceptó (debía ser obligatorio).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · la PK es el candado de idempotencia.
--   a) el mismo (conversation_id, episode_at) por segunda vez: unique_violation;
--   b) `insert … on conflict do nothing` no duplica (0 filas la segunda vez);
--   c) el mismo episode_at en OTRA conversación sí entra (la clave es el par).
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  v_entro boolean;
begin
  v_entro := false;
  begin
    insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
      values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 10:00:00+00', 'escalada');
    v_entro := true;
  exception when unique_violation then
    null;
  end;
  if v_entro then
    insert into _errores(msg) values ('Caso 4: el mismo (conversation_id, episode_at) se insertó dos veces (falta la PK).');
  end if;

  insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
    values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 14:00:00+00', 'cliente')
    on conflict do nothing;
  get diagnostics n = row_count;
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 4: el primer insert on conflict do nothing debía insertar 1 fila, insertó %s.', n));
  end if;

  insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
    values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 14:00:00+00', 'cliente')
    on conflict do nothing;
  get diagnostics n = row_count;
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 4: el segundo insert on conflict do nothing debía insertar 0 filas, insertó %s.', n));
  end if;

  select count(*) into n from public.conversation_delay_episodes
    where conversation_id = 'de1a0000-3000-0000-0000-000000000001' and episode_at = '2026-09-29 14:00:00+00';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 4: el episodio debía existir UNA vez, existe %s.', n));
  end if;

  begin
    insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
      values ('de1a0000-3000-0000-0000-000000000002', '2026-09-29 10:00:00+00', 'escalada');
  exception when unique_violation then
    insert into _errores(msg) values ('Caso 4: el mismo episode_at en otra conversación debía entrar (la PK es el par).');
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · `update … where responded_at is null returning` reclama UNA vez.
-- Es el mismo patrón que T10b usará para que dos pasadas del cron en el mismo
-- minuto den una sola acción: la primera se lleva la fila, la segunda ve 0.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  v_id uuid;
begin
  update public.conversation_delay_episodes
     set responded_at = '2026-09-29 10:10:00+00'
   where conversation_id = 'de1a0000-3000-0000-0000-000000000001'
     and episode_at = '2026-09-29 10:00:00+00'
     and responded_at is null
   returning conversation_id into v_id;
  get diagnostics n = row_count;
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 5: el primer claim debía afectar 1 fila, afectó %s.', n));
  end if;

  update public.conversation_delay_episodes
     set responded_at = '2026-09-29 10:10:01+00'
   where conversation_id = 'de1a0000-3000-0000-0000-000000000001'
     and episode_at = '2026-09-29 10:00:00+00'
     and responded_at is null
   returning conversation_id into v_id;
  get diagnostics n = row_count;
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 5: el segundo claim debía afectar 0 filas (ya reclamado), afectó %s.', n));
  end if;

  -- El primero no fue pisado por el segundo.
  if (select responded_at from public.conversation_delay_episodes
       where conversation_id = 'de1a0000-3000-0000-0000-000000000001'
         and episode_at = '2026-09-29 10:00:00+00') is distinct from '2026-09-29 10:10:00+00'::timestamptz then
    insert into _errores(msg) values ('Caso 5: el segundo claim pisó el responded_at del primero.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · estructura de permisos, medida en el catálogo (como postgres):
-- RLS habilitada, CERO políticas, y solo service_role con privilegios.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  v_rol text;
  v_priv text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.conversation_delay_episodes'::regclass) then
    insert into _errores(msg) values ('Caso 6: conversation_delay_episodes no tiene RLS habilitada.');
  end if;

  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'conversation_delay_episodes';
  if n <> 0 then
    insert into _errores(msg) values (format('Caso 6: conversation_delay_episodes debía tener CERO políticas (se lee solo con service_role); tiene %s.', n));
  end if;

  foreach v_rol in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['select', 'insert', 'update', 'delete'] loop
      if has_table_privilege(v_rol, 'public.conversation_delay_episodes', v_priv) then
        insert into _errores(msg) values (format('Caso 6: %s conserva %s sobre conversation_delay_episodes (el revoke all explícito no se aplicó).', v_rol, upper(v_priv)));
      end if;
    end loop;
  end loop;

  foreach v_priv in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.conversation_delay_episodes', v_priv) then
      insert into _errores(msg) values (format('Caso 6: service_role no tiene %s sobre conversation_delay_episodes (T10b lo necesita).', upper(v_priv)));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7 · service_role SÍ lee y escribe (sin política: bypassa RLS).
-- ---------------------------------------------------------------------------
set local role service_role;

do $$
declare
  n integer;
begin
  insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
    values ('de1a0000-3000-0000-0000-000000000002', '2026-09-29 15:00:00+00', 'cliente');

  select count(*) into n from public.conversation_delay_episodes
    where conversation_id = 'de1a0000-3000-0000-0000-000000000002';
  if n is distinct from 2 then
    insert into _errores(msg) values (format('Caso 7: service_role debía ver los 2 episodios de la conversación 2, ve %s.', n));
  end if;

  update public.conversation_delay_episodes
     set reassignments = 1, agentes_previos = array['de1a0000-0000-0000-0000-000000000001']::uuid[],
         ultima_reasignacion_at = '2026-09-29 15:15:00+00'
   where conversation_id = 'de1a0000-3000-0000-0000-000000000002'
     and episode_at = '2026-09-29 15:00:00+00';
  get diagnostics n = row_count;
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 7: service_role debía poder actualizar el episodio (afectó %s filas).', n));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso 7: service_role no pudo operar sobre conversation_delay_episodes -- %s', sqlerrm));
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Caso 8 · un agente autenticado NO obtiene filas ni puede escribir. Con los
-- grants de fábrica quitados, el SELECT ni siquiera llega a RLS
-- (insufficient_privilege); si algún día se le devolvieran, la ausencia de
-- políticas lo dejaría en 0 filas. Cualquiera de las dos salidas es "no ve
-- nada"; lo que jamás debe pasar es ver una fila o escribir una.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'de1a0000-0000-0000-0000-000000000001';

do $$
declare
  n integer := 0;
  v_entro boolean := false;
begin
  begin
    select count(*) into n from public.conversation_delay_episodes;
  exception when insufficient_privilege then
    n := 0;
  end;
  if n <> 0 then
    insert into _errores(msg) values (format('Caso 8: un agente autenticado ve %s fila(s) de conversation_delay_episodes (debía ver 0).', n));
  end if;

  begin
    insert into public.conversation_delay_episodes (conversation_id, episode_at, origen)
      values ('de1a0000-3000-0000-0000-000000000001', '2026-09-29 16:00:00+00', 'cliente');
    v_entro := true;
  exception when insufficient_privilege then
    null;
  end;
  if v_entro then
    insert into _errores(msg) values ('Caso 8: un agente autenticado pudo INSERTAR en conversation_delay_episodes.');
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Caso 9 · borrar la conversación borra sus episodios (cascade).
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from public.conversation_delay_episodes
    where conversation_id = 'de1a0000-3000-0000-0000-000000000002';
  if n = 0 then
    insert into _errores(msg) values ('Caso 9: la conversación 2 debía tener episodios antes de borrarla (el fixture no cargó).');
  end if;

  delete from public.conversations where id = 'de1a0000-3000-0000-0000-000000000002';

  select count(*) into n from public.conversation_delay_episodes
    where conversation_id = 'de1a0000-3000-0000-0000-000000000002';
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 9: borrar la conversación dejó %s episodio(s) huérfano(s).', n));
  end if;
end $$;

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
    raise exception E'demora_del_asesor.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'demora_del_asesor.sql: todas las aserciones pasaron.'
