-- ============================================================================
-- Consumo de tokens por turno + tarifas por modelo (Control del agente de IA)
-- ============================================================================

alter table public.agent_turns
  add column input_tokens integer,
  add column output_tokens integer,
  add column total_tokens integer;

comment on column public.agent_turns.total_tokens is 'input_tokens + output_tokens del turno completo (clasificación + respuesta). Null si el turno falló antes de llamar al modelo.';

-- ---------------------------------------------------------------------------
-- MODEL_PRICING
-- Tarifa en USD por millón de tokens, por modelo. `model` usa el mismo
-- formato "proveedor/modelo" que ya escribe currentAgentModelLabel() en
-- agent_turns.model, así que el cruce es por igualdad directa de texto.
-- Editable desde el panel de Control de IA sin necesidad de redeploy.
-- ---------------------------------------------------------------------------
create table public.model_pricing (
  model text primary key,
  input_price_per_million numeric(10, 4) not null,
  output_price_per_million numeric(10, 4) not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null
);

alter table public.model_pricing enable row level security;

create policy "model_pricing_all" on public.model_pricing for all
  using (public.is_agent()) with check (public.is_agent());

grant select, insert, update, delete on public.model_pricing to authenticated, service_role;
