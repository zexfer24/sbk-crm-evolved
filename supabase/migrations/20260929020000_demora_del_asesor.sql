-- ============================================================================
-- Tarea T10a · plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
-- esperando" (28/9/2026), Entrega B: nadie se queda sin atender (3.4).
--
-- Contexto: medido en producción, 283 escaladas en 3 días y 201 quedaron sin un
-- solo mensaje del asesor en 15 minutos (en 62 de ellas el cliente ni volvió a
-- escribir). Nada en el sistema le pone reloj al asesor: la despedida de Seba
-- al escalar mueve `last_reply_at` y deja `awaiting_reply` en false, así que
-- ningún reloj atado solo a "último mensaje sin respuesta" arranca. T10b (la
-- lógica: `demora.ts`, `delay-turn.ts`, la ruta de cron) usa este esquema;
-- esta migración NO cambia ningún comportamiento por sí sola: el interruptor
-- nace APAGADO y nadie escribe todavía en la tabla nueva.
--
-- Qué agrega:
--   1. `conversation_handoffs.reason` suma `reasignada_por_demora` (a los 15
--      min sin respuesta del asesor la conversación se reasigna a otro) y
--      `demora_sin_asesor` (con el tope de 2 reasignaciones ya gastado, o sin
--      nadie a quien rotar, se deja constancia y se avisa a los supervisores).
--      El CHECK es una copia COMPLETA de los 30 valores vigentes, tomados de
--      20260917010000 (la última migración que lo tocó; verificado el
--      29/9/2026 contra `pg_get_constraintdef` en la base local y con
--      `grep conversation_handoffs_reason_check supabase/migrations`): sin la
--      lista entera, `drop constraint`+`add constraint` borraría en silencio
--      cualquier razón que se omitiera y el INSERT de `recordHandoff` fallaría
--      contra la base real (la trampa de `fuera_de_tema` del 14/9/2026).
--   2. `agent_settings.demora_activa` (boolean, default false) y
--      `demora_activa_desde` (timestamptz, null): el interruptor de la demora
--      y el instante en que se encendió. `demora_activa_desde` es el corte del
--      backlog: un mensaje del cliente o un traspaso ANTERIOR a esa fecha no
--      cuenta para ningún episodio, así que encender el interruptor no dispara
--      de golpe respuestas y reasignaciones sobre cientos de chats viejos.
--      `agent_settings` es de columnas (singleton, `id boolean`), no
--      clave/valor: van como columnas. Escribe un supervisor/admin (la
--      política `agent_settings_update` ya lo exige, sin cambios).
--   3. `conversation_delay_episodes`: un episodio de espera por fila. La clave
--      (conversation_id, episode_at) ES el candado de idempotencia -- dos
--      pasadas del cron en el mismo minuto reclaman la fila con `insert … on
--      conflict do nothing` y `update … where responded_at is null returning`,
--      y solo una se lleva la acción. `episode_at` es la fecha de su origen:
--      el `created_at` del traspaso ORIGINAL (`escalada`/`escalada_sin_asesor`,
--      origen 'escalada') o `last_customer_message_at` (origen 'cliente').
--      `reasignada_por_demora` NO abre un episodio nuevo: continúa el de la
--      escalada original y acumula `reassignments`/`agentes_previos`; los 15
--      min siguientes se cuentan desde `ultima_reasignacion_at`. Sin eso cada
--      reasignación reiniciaría el contador y el tope de 2 no llegaría nunca.
--
-- Permisos de la tabla nueva (mismo criterio que `agent_turn_calls`,
-- 20260921040000, y `product_weight_audit`/`saint.sync_log`, 20260925010000):
-- RLS habilitada SIN ninguna política, y `revoke all` explícito a
-- public/anon/authenticated -- el `alter default privileges` de Supabase le da
-- ALL a `anon` y `authenticated` a toda tabla nueva de `public`, y aunque RLS
-- sin política ya filtra todo (0 filas), un privilegio de tabla que nadie
-- necesita es superficie de más. Solo `service_role` (BYPASSRLS, pero igual
-- necesita el GRANT de tabla) lee y escribe: el cron y el turno por demora
-- corren con el cliente admin. Ningún panel lee esta tabla.
--
-- Orden de los DDL y locks: `create table … references conversations` toma
-- SHARE ROW EXCLUSIVE sobre `conversations`, y los triggers de esa tabla
-- escriben `conversation_handoffs` dentro de la misma transacción del UPDATE
-- (conversations primero, handoffs después). Esta migración toma los locks en
-- ESE mismo orden -- primero la tabla nueva (conversations), al final el CHECK
-- de `conversation_handoffs` (ACCESS EXCLUSIVE, más el escaneo de las filas
-- existentes) -- para no reproducir el interbloqueo con el webhook que ya
-- tumbó un ensayo de 20260916010000 (ver CLAUDE.md, "Las cinco migraciones de
-- Seba/catálogo/factura…").
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso, y el
-- `add constraint` pide ACCESS EXCLUSIVE sobre una tabla donde el webhook y el
-- turno insertan a cada mensaje.
--
-- No hay función `security definer` nueva (nada que revocar). Sin función
-- nueva, `permisos_funciones.sql` y el guardián `permisos-funciones.test.ts`
-- no cambian.
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
-- 1. conversation_delay_episodes (primero: toma el lock de `conversations`
--    antes que el de `conversation_handoffs`, ver la cabecera).
-- ---------------------------------------------------------------------------
create table public.conversation_delay_episodes (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  episode_at timestamptz not null,
  origen text not null check (origen in ('escalada', 'cliente')),
  responded_at timestamptz,
  reassignments integer not null default 0,
  agentes_previos uuid[] not null default '{}',
  ultima_reasignacion_at timestamptz,
  supervisor_notified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (conversation_id, episode_at)
);

comment on table public.conversation_delay_episodes is
  'Un episodio de espera sin atender por fila (T10a, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", 28/9/2026). La clave (conversation_id, episode_at) es el candado de idempotencia del cron de demora: la fila se reclama con insert … on conflict do nothing y update … where responded_at is null returning. RLS habilitada SIN ninguna política y revoke all a anon/authenticated: solo service_role la lee y escribe (mismo criterio que agent_turn_calls).';
comment on column public.conversation_delay_episodes.episode_at is
  'Fecha del ORIGEN del episodio: el created_at del traspaso original (escalada / escalada_sin_asesor) si origen = escalada, o last_customer_message_at si origen = cliente. reasignada_por_demora NO abre un episodio nuevo: continúa este mismo.';
comment on column public.conversation_delay_episodes.origen is
  'De dónde nace el reloj: escalada (un traspaso escalada/escalada_sin_asesor sin mensaje de asesor desde entonces) o cliente (un mensaje del cliente sin respuesta real).';
comment on column public.conversation_delay_episodes.responded_at is
  'Cuándo se reclamó la respuesta por demora de Seba (a los 10 min). null = todavía no. El claim es update … where responded_at is null returning: una sola pasada se lleva la acción.';
comment on column public.conversation_delay_episodes.reassignments is
  'Cuántas veces se rotó el asesor dentro de este episodio (tope 2, decisión D3). Se acumula en esta fila; reasignada_por_demora no crea otra.';
comment on column public.conversation_delay_episodes.agentes_previos is
  'Asesores que ya tuvieron el chat en este episodio (el actual al reasignar y los anteriores): la reasignación nunca los repite (decisión D4).';
comment on column public.conversation_delay_episodes.ultima_reasignacion_at is
  'Cuándo fue la última reasignación del episodio. Los 15 min siguientes se cuentan desde acá, no desde episode_at; sin esta columna cada reasignación reiniciaría el contador y el tope de 2 no llegaría nunca.';
comment on column public.conversation_delay_episodes.supervisor_notified_at is
  'Cuándo se avisó a los supervisores por haber llegado al tope de reasignaciones (traspaso demora_sin_asesor). null = todavía no.';

alter table public.conversation_delay_episodes enable row level security;

-- SIN ninguna política a propósito (ver la cabecera). Los grants de fábrica
-- (alter default privileges de Supabase) se quitan EXPLÍCITOS: `revoke all
-- from public` corta el EXECUTE/privilegio heredado del pseudo-rol y `from
-- anon, authenticated` los grants directos -- mismo par de vías que la trampa
-- de las funciones `security definer` (CLAUDE.md). service_role tiene
-- BYPASSRLS pero necesita el GRANT de tabla: bypassrls salta las políticas, no
-- los privilegios de SQL.
revoke all on public.conversation_delay_episodes from public;
revoke all on public.conversation_delay_episodes from anon, authenticated;
grant select, insert, update, delete on public.conversation_delay_episodes to service_role;

-- ---------------------------------------------------------------------------
-- 2. agent_settings: el interruptor de la demora (nace APAGADO).
-- ---------------------------------------------------------------------------
alter table public.agent_settings
  add column if not exists demora_activa boolean not null default false,
  add column if not exists demora_activa_desde timestamptz;

comment on column public.agent_settings.demora_activa is
  'Interruptor de la demora del asesor (T10, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", 28/9/2026). false = ni Seba responde por demora ni se reasigna nada. Lo enciende un supervisor/admin desde Control IA, DESPUÉS de desplegar y de avisar a los asesores.';
comment on column public.agent_settings.demora_activa_desde is
  'Instante en que se encendió demora_activa. Es el corte del backlog: un mensaje del cliente o un traspaso anterior a esta fecha no abre episodio, para que encender el interruptor no dispare de golpe sobre cientos de chats viejos. null mientras nunca se haya encendido.';

-- ---------------------------------------------------------------------------
-- 3. conversation_handoffs.reason -- copia COMPLETA de los 30 valores
--    vigentes en 20260917010000 (líneas 275-315 de esa migración) más las dos
--    razones de la demora. Va al final: es el DDL que más tiempo retiene su
--    lock (ACCESS EXCLUSIVE + escaneo de las filas existentes).
-- ---------------------------------------------------------------------------
alter table public.conversation_handoffs
  drop constraint conversation_handoffs_reason_check;

alter table public.conversation_handoffs
  add constraint conversation_handoffs_reason_check
  check (reason in (
    'agente_no_puede_correr',
    'conversacion_inexistente',
    'pausada',
    'asignada',
    'humano_intervino',
    'humano_se_adelanto',
    'fuera_de_ventana',
    'identidad_no_verificable',
    'lock_perdido',
    'abandonado',
    'entrega_fallida',
    'reabierto',
    'escalado_por_ia',
    'reclamado',
    'devuelto_a_ia',
    'cerrado',
    'ventana_vencida',
    'sla_vencido',
    'escalada',
    'escalada_sin_asesor',
    'rechazado_por_meta',
    'cerrada_por_asesor',
    'reabierta_por_asesor',
    'reabierta_por_cliente',
    'sin_contenido_legible',
    'cortesia_tras_escalada',
    'desasignada_por_asesor',
    'mensaje_previo_a_devolucion',
    'silenciada_por_asesor',
    'fuera_de_tema_repetido',
    -- T10a, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
    -- esperando" (29/9/2026): a los 15 min sin mensaje del asesor la
    -- conversación pasa a otro asesor (la escribe el cron de demora, T10b).
    'reasignada_por_demora',
    -- Idem: tope de 2 reasignaciones alcanzado (o nadie a quien rotar); queda
    -- constancia en la bitácora y se avisa a los supervisores.
    'demora_sin_asesor'
  ));

comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: ver 20260830040000). T2.1 (5/9/2026) sumó cerrada_por_asesor/reabierta_por_asesor/reabierta_por_cliente; "La IA ve lo que llega" (8/9/2026) sumó sin_contenido_legible; "La voz cercana y la espera visible" (14/9/2026) sumó cortesia_tras_escalada; "La IA no vuelve a pedir lo que ya pidió" (16/9/2026) sumó desasignada_por_asesor/mensaje_previo_a_devolucion; "Seba atiende el mostrador" (18/9/2026, T0) sumó silenciada_por_asesor; "El resguardo antes del push" (20/9/2026, C6) sumó fuera_de_tema_repetido; T10a de "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando" (29/9/2026) suma reasignada_por_demora (a los 15 min sin mensaje del asesor el chat pasa a otro; SÍ cambia de manos y cierra/continúa la escalada abierta) y demora_sin_asesor (tope de 2 reasignaciones alcanzado: no cambia de dueño, entra en RAZONES_QUE_NO_CIERRAN_LA_ESCALADA).';

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real (no leyendo este archivo).
-- ---------------------------------------------------------------------------
do $$
declare
  def_reason text;
  n_valores integer;
  v_faltan text;
  v_esperadas text[] := array[
    'agente_no_puede_correr','conversacion_inexistente','pausada','asignada','humano_intervino',
    'humano_se_adelanto','fuera_de_ventana','identidad_no_verificable','lock_perdido','abandonado',
    'entrega_fallida','reabierto','escalado_por_ia','reclamado','devuelto_a_ia','cerrado',
    'ventana_vencida','sla_vencido','escalada','escalada_sin_asesor','rechazado_por_meta',
    'cerrada_por_asesor','reabierta_por_asesor','reabierta_por_cliente','sin_contenido_legible',
    'cortesia_tras_escalada','desasignada_por_asesor','mensaje_previo_a_devolucion',
    'silenciada_por_asesor','fuera_de_tema_repetido',
    'reasignada_por_demora','demora_sin_asesor'
  ];
  v_col record;
begin
  -- 3. El CHECK trae las 32 razones (ninguna de las 30 viejas se perdió).
  select pg_get_constraintdef(oid) into def_reason
    from pg_constraint
    where conrelid = 'public.conversation_handoffs'::regclass
      and conname = 'conversation_handoffs_reason_check';
  if def_reason is null then
    raise exception '20260929020000: conversation_handoffs_reason_check no existe';
  end if;

  select string_agg(e, ', ') into v_faltan
    from unnest(v_esperadas) as e
    where position('''' || e || '''::text' in def_reason) = 0;
  if v_faltan is not null then
    raise exception '20260929020000: conversation_handoffs_reason_check perdió razones: % (definición: %)', v_faltan, def_reason;
  end if;

  select count(*) into n_valores from regexp_matches(def_reason, '''([a-z_]+)''::text', 'g');
  if n_valores <> 32 then
    raise exception '20260929020000: conversation_handoffs_reason_check debía tener 32 razones, tiene % (definición: %)', n_valores, def_reason;
  end if;

  -- 2. Las dos columnas de agent_settings, con el tipo, la nulabilidad y el
  --    default que T10b espera.
  select data_type, is_nullable, column_default into v_col
    from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_settings' and column_name = 'demora_activa';
  if v_col.data_type is distinct from 'boolean' or v_col.is_nullable is distinct from 'NO' or v_col.column_default is distinct from 'false' then
    raise exception '20260929020000: agent_settings.demora_activa debía ser boolean NOT NULL default false (encontró % / % / %)', v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  select data_type, is_nullable into v_col
    from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_settings' and column_name = 'demora_activa_desde';
  if v_col.data_type is distinct from 'timestamp with time zone' or v_col.is_nullable is distinct from 'YES' then
    raise exception '20260929020000: agent_settings.demora_activa_desde debía ser timestamptz nullable (encontró % / %)', v_col.data_type, v_col.is_nullable;
  end if;

  if exists (select 1 from public.agent_settings where demora_activa) then
    raise exception '20260929020000: agent_settings.demora_activa debía nacer apagado';
  end if;

  -- 1. La tabla existe, con RLS, sin políticas, cerrada a anon/authenticated y
  --    abierta a service_role.
  if to_regclass('public.conversation_delay_episodes') is null then
    raise exception '20260929020000: conversation_delay_episodes no quedó creada';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.conversation_delay_episodes'::regclass) then
    raise exception '20260929020000: conversation_delay_episodes no tiene RLS habilitada';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversation_delay_episodes') then
    raise exception '20260929020000: conversation_delay_episodes debía quedar SIN políticas (se lee solo con service_role)';
  end if;
  -- Con una lista separada por comas, has_table_privilege da true si tiene
  -- CUALQUIERA de los privilegios.
  if has_table_privilege('anon', 'public.conversation_delay_episodes', 'select,insert,update,delete')
     or has_table_privilege('authenticated', 'public.conversation_delay_episodes', 'select,insert,update,delete') then
    raise exception '20260929020000: anon/authenticated conservan privilegios sobre conversation_delay_episodes (el revoke all no se aplicó)';
  end if;
  if not has_table_privilege('service_role', 'public.conversation_delay_episodes', 'select')
     or not has_table_privilege('service_role', 'public.conversation_delay_episodes', 'insert')
     or not has_table_privilege('service_role', 'public.conversation_delay_episodes', 'update')
     or not has_table_privilege('service_role', 'public.conversation_delay_episodes', 'delete') then
    raise exception '20260929020000: service_role no tiene select/insert/update/delete sobre conversation_delay_episodes';
  end if;

  raise notice '20260929020000: autoverificación de la demora del asesor (CHECK de 32 razones, agent_settings, conversation_delay_episodes cerrada) correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y las columnas /
-- tablas nuevas dan 400 hasta que alguien lo recargue a mano (hallazgo M1,
-- 19/9/2026).
notify pgrst, 'reload schema';
