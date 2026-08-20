-- ============================================================================
-- Sugerencias de los asesores hacia el supervisor sobre mejoras del bot
-- ============================================================================

create table public.agent_suggestions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  content text not null,
  status text not null default 'pending' check (status in ('pending', 'reviewed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.agents (id) on delete set null
);

comment on table public.agent_suggestions is 'Sugerencias de mejora del bot que los asesores dejan para el supervisor. status pasa a reviewed cuando un supervisor/admin la marca.';

create index agent_suggestions_created_at_idx on public.agent_suggestions (created_at desc);

alter table public.agent_suggestions enable row level security;

create policy "agent_suggestions_all" on public.agent_suggestions for all
  using (public.is_agent()) with check (public.is_agent());

grant select, insert, update, delete on public.agent_suggestions to authenticated, service_role;

alter publication supabase_realtime add table public.agent_suggestions;
