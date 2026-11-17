-- ============================================================================
-- Seba v2: sombra, copiloto, revisiones y telemetría de versión (S1, entrega 3
-- del rework de Seba, 17/11/2026)
--
-- Qué es: la base para que Seba v2 redacte borradores SIN enviarlos ("sombra":
-- solo lo ve el supervisor, para medir; "copiloto": el asesor ve la sugerencia
-- en su chat y decide) y para que un supervisor los revise y diga qué estuvo
-- mal. Nada de esto toca al turno de Seba v1 en vivo.
--
-- DECISIÓN DE DISEÑO (difiere del brief original del VPS, a propósito): un turno
-- en sombra NO escribe en `agent_turns`. Esa tabla se lee directo desde el panel
-- (feed de turnos, "escenarios faltantes", búsquedas, consumo de tokens,
-- `playbookSentRecently`) y por tres RPC; filas de sombra los contaminarían.
-- Todo lo de un turno en sombra (tokens, modelo, llamadas al proveedor) vive en
-- `agent_shadow_drafts`, y `shadow_spend_today()` se calcula desde ahí. Por eso
-- `agent_spend_today()` y `agent_can_run()` NO se tocan: el gasto en vivo y el de
-- la sombra son dos números separados, con dos topes separados.
--
-- Lo que hace:
--   1. `agent_turns`: `agent_version` ('v1'/'v2'), `escalation_motivo` y
--      `escalation_area`, para distinguir los turnos EN VIVO de v2 y saber a
--      dónde escalaron.
--   2. `agent_turn_calls.model`: qué modelo atendió cada llamada.
--   3. `agent_shadow_drafts`: un borrador por turno en sombra/copiloto (la ráfaga
--      que respondía, los mensajes que habría enviado, herramientas, si habría
--      escalado, contexto, tokens y llamadas). RLS: el supervisor/admin lee todo;
--      un asesor lee SOLO los de `copiloto` y, por permiso de COLUMNA, solo puede
--      resolver la sugerencia (estado, quién, cuándo). No hay política de insert
--      ni de delete para usuarios: escribe el cliente admin (`service_role`).
--      Publicada en `supabase_realtime`: el chat muestra la sugerencia de
--      copiloto en vivo.
--   4. `shadow_reviews`: la revisión de un supervisor sobre un borrador (veredicto,
--      tipo de error, corrección, destino). Solo supervisor/admin, en RLS.
--   5. `shadow_spend_today()` (el panel la muestra contra el tope) y
--      `shadow_can_run()` (solo `service_role`: el webhook/turno decide si corre
--      la sombra). Mismo cálculo que `agent_spend_today()` sobre los borradores
--      de HOY en Caracas. Comportamiento conocido, igual que en
--      `agent_spend_today()`: un borrador con un modelo sin fila en
--      `model_pricing` no suma.
--   6. `conversation_cart_items.origin` acepta 'seba': el renglón que Seba v2
--      puso al armar el pedido.
--
-- El nombre real del CHECK de `origin` es `conversation_cart_items_origin_check`
-- (confirmado en la base el 17/11/2026 contra `pg_constraint`).
--
-- Las dos funciones nuevas son `security definer` y llevan sus DOS revokes (a
-- `public` y a `anon, authenticated`) más el `grant` a quien sí las necesita,
-- en esta misma migración (CLAUDE.md, "Convenciones"). Cuerpo entre `$$`: el
-- guardián `permisos-funciones.test.ts` parsea la cabecera hasta el primer `$$`.
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

-- ---------------------------------------------------------------------------
-- 1. agent_turns: versión del agente y destino de la escalada
-- ---------------------------------------------------------------------------
alter table public.agent_turns
  add column if not exists agent_version text not null default 'v1',
  add column if not exists escalation_motivo text,
  add column if not exists escalation_area text;

alter table public.agent_turns drop constraint if exists agent_turns_agent_version_check;
alter table public.agent_turns
  add constraint agent_turns_agent_version_check check (agent_version in ('v1', 'v2'));

alter table public.agent_turns drop constraint if exists agent_turns_escalation_area_check;
alter table public.agent_turns
  add constraint agent_turns_escalation_area_check
  check (escalation_area is null or escalation_area in ('pagos', 'ventas', 'envios', 'reclamos'));

alter table public.agent_turns drop constraint if exists agent_turns_escalation_motivo_length;
alter table public.agent_turns
  add constraint agent_turns_escalation_motivo_length
  check (escalation_motivo is null or char_length(escalation_motivo) <= 60);

comment on column public.agent_turns.agent_version is
  'Qué agente atendió el turno EN VIVO: v1 (el de siempre, también todo lo anterior a esta migración) o v2. Los turnos en sombra NO escriben aquí: viven en agent_shadow_drafts.';
comment on column public.agent_turns.escalation_motivo is
  'Motivo con el que el turno escaló (turnos de v2), texto corto (<= 60). null si no escaló o es de v1.';
comment on column public.agent_turns.escalation_area is
  'Área a la que escaló el turno (pagos/ventas/envios/reclamos). null si no escaló o es de v1.';

-- ---------------------------------------------------------------------------
-- 2. agent_turn_calls: qué modelo atendió cada llamada
-- ---------------------------------------------------------------------------
alter table public.agent_turn_calls add column if not exists model text;

comment on column public.agent_turn_calls.model is
  'Modelo que atendió ESTA llamada (null en las anteriores a 20261117010000). Permite medir por modelo cuando v1 y v2 conviven.';

-- ---------------------------------------------------------------------------
-- 3. agent_shadow_drafts: lo que Seba v2 redactó sin enviar
-- ---------------------------------------------------------------------------
create table if not exists public.agent_shadow_drafts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  modo text not null
    constraint agent_shadow_drafts_modo_check check (modo in ('sombra', 'copiloto')),
  trigger_message_id uuid references public.messages (id) on delete set null,
  rafaga jsonb not null
    constraint agent_shadow_drafts_rafaga_array check (jsonb_typeof(rafaga) = 'array'),
  mensajes jsonb not null
    constraint agent_shadow_drafts_mensajes_array check (jsonb_typeof(mensajes) = 'array'),
  herramientas jsonb not null default '[]',
  productos uuid[] not null default '{}',
  escalaria boolean not null default false,
  motivo text,
  area text
    constraint agent_shadow_drafts_area_check check (area is null or area in ('pagos', 'ventas', 'envios', 'reclamos')),
  nota text,
  estado_antes jsonb,
  estado_despues jsonb,
  guardas jsonb not null default '[]',
  contexto jsonb not null
    constraint agent_shadow_drafts_contexto_object check (jsonb_typeof(contexto) = 'object'),
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  llamadas jsonb not null default '[]',
  duration_ms integer,
  sugerencia_estado text
    constraint agent_shadow_drafts_sugerencia_estado_check
    check (sugerencia_estado in ('pendiente', 'enviada', 'editada', 'descartada', 'vencida')),
  sugerencia_resuelta_por uuid references public.agents (id) on delete set null,
  sugerencia_resuelta_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.agent_shadow_drafts is
  'Borrador que Seba v2 redactó SIN enviar (S1, entrega 3 del rework de Seba, 17/11/2026): modo sombra (solo supervisor, para medir) o copiloto (el asesor ve la sugerencia en su chat). Un turno en sombra no escribe en agent_turns: sus tokens, modelo y llamadas viven aquí y shadow_spend_today() los suma. Escribe solo service_role.';
comment on column public.agent_shadow_drafts.rafaga is
  'Arreglo con los textos del cliente que el borrador respondía.';
comment on column public.agent_shadow_drafts.mensajes is
  'Arreglo [{orden, tipo, texto, origen}] con lo que Seba habría enviado, en orden.';
comment on column public.agent_shadow_drafts.contexto is
  'Objeto {ia_global, asesor_asignado, asesor_escribio_hace_min}: el estado del chat cuando se redactó.';
comment on column public.agent_shadow_drafts.llamadas is
  'Una entrada por llamada al proveedor del turno (fase, tokens, ms).';
comment on column public.agent_shadow_drafts.sugerencia_estado is
  'Solo modo copiloto: pendiente/enviada/editada/descartada/vencida. null en sombra. El asesor puede resolverla (este campo y los dos siguientes) por permiso de columna.';

create index if not exists agent_shadow_drafts_conversation_idx
  on public.agent_shadow_drafts (conversation_id, created_at desc);
create index if not exists agent_shadow_drafts_created_idx
  on public.agent_shadow_drafts (created_at desc);

alter table public.agent_shadow_drafts enable row level security;

drop policy if exists "agent_shadow_drafts_select" on public.agent_shadow_drafts;
create policy "agent_shadow_drafts_select" on public.agent_shadow_drafts
  for select to authenticated
  using (public.is_supervisor_or_admin() or (modo = 'copiloto' and public.is_agent()));

drop policy if exists "agent_shadow_drafts_update" on public.agent_shadow_drafts;
create policy "agent_shadow_drafts_update" on public.agent_shadow_drafts
  for update to authenticated
  using (modo = 'copiloto' and public.is_agent())
  with check (modo = 'copiloto' and public.is_agent());

-- Los DOS caminos de privilegio de fábrica (CLAUDE.md, "Trampas"): se quita todo
-- (también lo que esté por columna: un REVOKE de tabla se lo lleva) y se da de
-- vuelta solo lo que hace falta. El UPDATE del asesor es POR COLUMNA: con un grant
-- de tabla entera podría reescribir los mensajes de un borrador de copiloto.
revoke all on public.agent_shadow_drafts from public;
revoke all on public.agent_shadow_drafts from anon, authenticated;
grant select on public.agent_shadow_drafts to authenticated;
grant update (sugerencia_estado, sugerencia_resuelta_por, sugerencia_resuelta_at)
  on public.agent_shadow_drafts to authenticated;
grant select, insert, update, delete on public.agent_shadow_drafts to service_role;

-- Realtime: el chat muestra la sugerencia de copiloto en vivo.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'agent_shadow_drafts'
  ) then
    alter publication supabase_realtime add table public.agent_shadow_drafts;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. shadow_reviews: la revisión de un supervisor sobre un borrador
-- ---------------------------------------------------------------------------
create table if not exists public.shadow_reviews (
  draft_id uuid primary key references public.agent_shadow_drafts (id) on delete cascade,
  veredicto text not null
    constraint shadow_reviews_veredicto_check check (veredicto in ('igual', 'cambio_menor', 'no')),
  error_tipo text
    constraint shadow_reviews_error_tipo_check check (error_tipo in (
      'producto_equivocado', 'precio', 'tono', 'debio_pasar',
      'no_debio_pasar', 'dato_inventado', 'forma_de_pago', 'otro')),
  correccion text
    constraint shadow_reviews_correccion_length check (char_length(correccion) <= 2000),
  destino text
    constraint shadow_reviews_destino_check check (destino in ('leccion', 'caso_de_arnes', 'prompt', 'ninguno')),
  reviewed_by uuid not null references public.agents (id),
  reviewed_at timestamptz not null default now()
);

comment on table public.shadow_reviews is
  'Revisión de un supervisor/admin sobre un borrador de sombra o copiloto (S1, 17/11/2026): si el borrador estuvo igual, con un cambio menor o mal; qué tipo de error; la corrección y a dónde va (lección, caso del arnés, prompt). Una por borrador; se borra con él.';

alter table public.shadow_reviews enable row level security;

drop policy if exists "shadow_reviews_select" on public.shadow_reviews;
create policy "shadow_reviews_select" on public.shadow_reviews
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "shadow_reviews_insert" on public.shadow_reviews;
create policy "shadow_reviews_insert" on public.shadow_reviews
  for insert to authenticated
  with check (public.is_supervisor_or_admin());

drop policy if exists "shadow_reviews_update" on public.shadow_reviews;
create policy "shadow_reviews_update" on public.shadow_reviews
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "shadow_reviews_delete" on public.shadow_reviews;
create policy "shadow_reviews_delete" on public.shadow_reviews
  for delete to authenticated
  using (public.is_supervisor_or_admin());

revoke all on public.shadow_reviews from public;
revoke all on public.shadow_reviews from anon, authenticated;
grant select, insert, update, delete on public.shadow_reviews to authenticated;
grant select, insert, update, delete on public.shadow_reviews to service_role;

-- ---------------------------------------------------------------------------
-- 5. Gasto de la sombra, aparte del gasto en vivo
-- ---------------------------------------------------------------------------
create or replace function public.shadow_spend_today()
returns numeric
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(
      (coalesce(d.input_tokens, 0) / 1000000.0) * p.input_price_per_million
    + (coalesce(d.output_tokens, 0) / 1000000.0) * p.output_price_per_million), 0)::numeric
    from public.agent_shadow_drafts d
    join public.model_pricing p on p.model = d.model
   where d.created_at >= ((now() at time zone 'America/Caracas')::date)::timestamp at time zone 'America/Caracas'
     and d.created_at <  (((now() at time zone 'America/Caracas')::date + 1))::timestamp at time zone 'America/Caracas';
$$;

comment on function public.shadow_spend_today is
  'Gasto en USD de la sombra y el copiloto de Seba v2 en el día en curso (hora de Caracas), con la tarifa del modelo de cada borrador (sin tarifa no suma, igual que agent_spend_today). Separado del gasto en vivo: no suma agent_turns ni lecturas.';

revoke execute on function public.shadow_spend_today() from public;
revoke execute on function public.shadow_spend_today() from anon, authenticated;
grant execute on function public.shadow_spend_today() to authenticated, service_role;

create or replace function public.shadow_can_run()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce((
    select s.seba_v2_modo in ('sombra', 'copiloto')
       and public.shadow_spend_today() < s.shadow_daily_cap_usd
      from public.agent_settings s
     where s.id
  ), false);
$$;

comment on function public.shadow_can_run is
  'true solo si Seba v2 está en modo sombra o copiloto y el gasto de la sombra de hoy (shadow_spend_today) no llegó a shadow_daily_cap_usd. Sin fila de configuración: false. Solo service_role la llama.';

revoke execute on function public.shadow_can_run() from public;
revoke execute on function public.shadow_can_run() from anon, authenticated;
grant execute on function public.shadow_can_run() to service_role;

-- ---------------------------------------------------------------------------
-- 6. El carrito acepta renglones puestos por Seba v2
-- ---------------------------------------------------------------------------
alter table public.conversation_cart_items drop constraint if exists conversation_cart_items_origin_check;
alter table public.conversation_cart_items
  add constraint conversation_cart_items_origin_check check (origin in ('quote', 'inventory', 'seba'));

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.agent_shadow_drafts'::regclass) then
    raise exception '20261117010000: agent_shadow_drafts no tiene RLS activa';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.shadow_reviews'::regclass) then
    raise exception '20261117010000: shadow_reviews no tiene RLS activa';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'agent_shadow_drafts') <> 2 then
    raise exception '20261117010000: agent_shadow_drafts debía tener exactamente dos políticas (select, update)';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'shadow_reviews') <> 4 then
    raise exception '20261117010000: shadow_reviews debía tener exactamente cuatro políticas';
  end if;
  if has_table_privilege('anon', 'public.agent_shadow_drafts', 'select')
     or has_table_privilege('anon', 'public.shadow_reviews', 'select') then
    raise exception '20261117010000: anon todavía puede leer una de las tablas nuevas';
  end if;
  if has_column_privilege('authenticated', 'public.agent_shadow_drafts', 'nota', 'update') then
    raise exception '20261117010000: authenticated puede actualizar agent_shadow_drafts.nota; el UPDATE debía ser solo por columnas de la sugerencia';
  end if;
  if not has_column_privilege('authenticated', 'public.agent_shadow_drafts', 'sugerencia_estado', 'update') then
    raise exception '20261117010000: authenticated no puede resolver la sugerencia (sugerencia_estado)';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_shadow_drafts'
  ) then
    raise exception '20261117010000: agent_shadow_drafts no quedó publicada en supabase_realtime';
  end if;
  if has_function_privilege('anon', 'public.shadow_can_run()', 'execute')
     or has_function_privilege('authenticated', 'public.shadow_can_run()', 'execute') then
    raise exception '20261117010000: shadow_can_run() debía ser solo de service_role';
  end if;
  if has_function_privilege('anon', 'public.shadow_spend_today()', 'execute') then
    raise exception '20261117010000: anon todavía puede ejecutar shadow_spend_today()';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'agent_turns'
         and column_name in ('agent_version', 'escalation_motivo', 'escalation_area')) <> 3 then
    raise exception '20261117010000: faltan columnas nuevas de agent_turns';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_turn_calls' and column_name = 'model'
  ) then
    raise exception '20261117010000: falta agent_turn_calls.model';
  end if;
end $$;

notify pgrst, 'reload schema';
