-- ============================================================================
-- Lecturas de audio e imagen (M1, plan "Seba lee fotos y audios", 16/11/2026)
--
-- Qué es: `public.message_readings` guarda, por cada audio o imagen entrante,
-- la lectura que hizo el modelo (transcripción o descripción), su estado
-- (`pendiente`, `ok`, `vacio`, `alucinacion`, `fallo`), el modelo, los tokens y
-- el costo en USD. Una fila por mensaje (`message_id` es la clave primaria).
--
-- Quién escribe: SOLO el webhook, con el cliente admin (`service_role`). No hay
-- políticas de escritura ni grants de escritura para `authenticated`: los
-- agentes solo la LEEN (política `is_agent()`), para ver la lectura en el chat
-- y en Control IA. Está publicada en Realtime para que la burbuja se actualice
-- cuando la lectura pasa de `pendiente` a `ok`.
--
-- Gasto: `agent_spend_today()` ahora SUMA el costo de las lecturas de hoy (hora
-- de Caracas) al de los turnos, y por eso `agent_can_run()` corta también por
-- ese gasto. El corte de lecturas va como RANGO sobre `created_at` para usar
-- `message_readings_created_idx`; la parte de `agent_turns` no se toca.
--
-- `model_pricing`: se carga `openai/gpt-5.4` (2,50 / 15,00 USD por millón de
-- tokens, precio de OpenRouter del 24/10/2026). No pisa una tarifa ya cargada.
--
-- `permisos-funciones.test.ts` no cambia: se redefine una función que ya estaba
-- contada. Se repiten sus dos revokes y el grant (CLAUDE.md, "Convenciones").
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso.
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
-- La tabla
-- ---------------------------------------------------------------------------
create table if not exists public.message_readings (
  message_id      uuid primary key references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  kind            text not null check (kind in ('audio', 'image')),
  status          text not null check (status in ('pendiente', 'ok', 'vacio', 'alucinacion', 'fallo')),
  model           text,
  text            text,   -- transcripción, o descripción de la imagen
  fields          jsonb,  -- solo imagen: campos estructurados de la lectura
  error           text,   -- 'descarga' | 'timeout' | 'proveedor:<código>' | 'formato' | 'tope_de_gasto' | 'tope_no_consultable'
  duration_ms     integer,
  audio_seconds   numeric(8, 2),
  input_tokens    integer,
  output_tokens   integer,
  cost_usd        numeric(10, 6),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists message_readings_conversation_created_idx
  on public.message_readings (conversation_id, created_at);
create index if not exists message_readings_created_idx
  on public.message_readings (created_at);

-- ---------------------------------------------------------------------------
-- RLS: los agentes leen; nadie escribe salvo service_role (que la salta)
-- ---------------------------------------------------------------------------
alter table public.message_readings enable row level security;

drop policy if exists "message_readings_select" on public.message_readings;
create policy "message_readings_select" on public.message_readings
  for select using (public.is_agent());

-- El `alter default privileges` de Supabase le da ALL a anon/authenticated/
-- service_role a toda tabla nueva de `public`: se corta y se deja explícito lo
-- que sí hace falta.
revoke all on public.message_readings from public;
revoke all on public.message_readings from anon;
revoke all on public.message_readings from authenticated;
grant select on public.message_readings to authenticated;
grant select, insert, update, delete on public.message_readings to service_role;

-- ---------------------------------------------------------------------------
-- Realtime (replica identity en default: no hacen falta eventos DELETE)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_readings'
  ) then
    alter publication supabase_realtime add table public.message_readings;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'message_readings'
  ) then
    raise exception '20261116010000: message_readings no quedó publicada en supabase_realtime';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- El tope de gasto diario cuenta también las lecturas
-- ---------------------------------------------------------------------------
create or replace function public.agent_spend_today()
returns numeric
language sql
stable
security definer set search_path = public
as $$
  select (
    coalesce((
      select sum(
        (coalesce(t.input_tokens, 0) / 1000000.0) * p.input_price_per_million
        + (coalesce(t.output_tokens, 0) / 1000000.0) * p.output_price_per_million
      )
      from public.agent_turns t
      join public.model_pricing p on p.model = t.model
      where (t.created_at at time zone 'America/Caracas')::date
            = (now() at time zone 'America/Caracas')::date
    ), 0)
    + coalesce((
      select sum(r.cost_usd)
      from public.message_readings r
      where r.created_at >= ((now() at time zone 'America/Caracas')::date)::timestamp at time zone 'America/Caracas'
        and r.created_at <  (((now() at time zone 'America/Caracas')::date + 1))::timestamp at time zone 'America/Caracas'
    ), 0)
  )::numeric;
$$;

comment on function public.agent_spend_today is
  'Gasto en USD del agente en el día en curso (hora de Caracas): turnos (con la tarifa de su modelo; sin tarifa no suman) más el costo de las lecturas de audio e imagen (message_readings).';

revoke execute on function public.agent_spend_today() from public;
revoke execute on function public.agent_spend_today() from anon, authenticated;
grant execute on function public.agent_spend_today() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tarifa del modelo de lectura (OpenRouter, 24/10/2026)
-- ---------------------------------------------------------------------------
insert into public.model_pricing (model, input_price_per_million, output_price_per_million)
values ('openai/gpt-5.4', 2.5000, 15.0000)
on conflict (model) do nothing;

-- ---------------------------------------------------------------------------
-- Autoverificación final
-- ---------------------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.message_readings'::regclass) then
    raise exception '20261116010000: message_readings debía tener la RLS activa';
  end if;
  if has_table_privilege('authenticated', 'public.message_readings', 'insert') then
    raise exception '20261116010000: authenticated no debía poder insertar en message_readings';
  end if;
end
$$;

notify pgrst, 'reload schema';
