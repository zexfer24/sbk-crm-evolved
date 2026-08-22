-- ============================================================================
-- Respuestas predeterminadas de la IA (playbooks)
--
-- Escenarios que la IA reconoce y responde con el texto oficial de la
-- empresa, verbatim, sin pasarlo por el modelo. El modelo elige CUÁL
-- responder; nunca CÓMO se redacta.
--
-- Vive aparte de public.quick_replies a propósito: un mensaje rápido es un
-- atajo de tipeo de cada asesor, esto es discurso de la empresa frente al
-- cliente. Ciclos de vida y permisos distintos (ver RLS más abajo).
-- ============================================================================

create table public.ai_playbooks (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  trigger_description text not null,
  response_text text not null,
  attachment_url text,
  attachment_type text check (attachment_type in ('link', 'image', 'document', 'video')),
  after_send text not null default 'wait' check (after_send in ('wait', 'escalate')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_playbooks_attachment_pair check (
    (attachment_url is null and attachment_type is null)
    or (attachment_url is not null and attachment_type is not null)
  )
);

comment on table public.ai_playbooks is 'Respuestas predeterminadas que la IA envía tal cual cuando reconoce el escenario.';
comment on column public.ai_playbooks.name is 'Único porque ES el valor del enum que ve el modelo al elegir escenario. Legible a propósito: hace depurable el reconocimiento.';
comment on column public.ai_playbooks.trigger_description is 'Cuándo aplica, en lenguaje natural. Es lo único que lee el clasificador para decidir.';
comment on column public.ai_playbooks.response_text is 'Se envía VERBATIM. El modelo no lo reescribe ni lo parafrasea.';
comment on column public.ai_playbooks.attachment_type is 'link: la URL se anexa al texto (sirve para cualquier URL). image/document/video: Meta descarga el archivo desde la URL, que debe apuntar al archivo directo y ser pública.';
comment on column public.ai_playbooks.after_send is 'wait: queda a la espera de la respuesta del cliente. escalate: pasa a un asesor humano.';

create index ai_playbooks_active_idx on public.ai_playbooks (is_active) where is_active;

create trigger set_ai_playbooks_updated_at before update on public.ai_playbooks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Bitácora: qué escenario resolvió el turno, y con qué mensaje del cliente.
-- ---------------------------------------------------------------------------
alter table public.agent_turns
  add column playbook_id uuid references public.ai_playbooks (id) on delete set null,
  add column customer_message text;

comment on column public.agent_turns.playbook_id is 'Escenario que resolvió el turno. Null = no coincidió con ninguno y resolvió el flujo genérico.';
comment on column public.agent_turns.customer_message is 'Último mensaje del cliente en el turno. Alimenta la lista de escenarios faltantes del panel.';

-- ---------------------------------------------------------------------------
-- RLS — asimétrica a propósito: cualquier asesor puede VER qué dice la IA,
-- pero solo supervisión puede cambiarlo. Sin esto, un asesor podría alterar
-- el discurso oficial que la IA usa sola frente a los clientes.
--
-- El `grant` completo a `authenticated` es intencional y no debilita nada:
-- los grants de Postgres van por rol de conexión, y todo agente del CRM se
-- conecta como `authenticated`. Quien filtra por rol de agente es RLS.
-- ---------------------------------------------------------------------------
alter table public.ai_playbooks enable row level security;

create policy "ai_playbooks_select" on public.ai_playbooks
  for select using (public.is_agent());

create policy "ai_playbooks_write" on public.ai_playbooks
  for all using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

grant select, insert, update, delete on public.ai_playbooks to authenticated, service_role;

-- El panel administra los escenarios en vivo, igual que quick_replies.
alter publication supabase_realtime add table public.ai_playbooks;
