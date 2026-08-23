-- SBK Motorcycles CRM - Esquema inicial
-- Multiagente + WhatsApp (Meta Cloud API) + IA
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- AGENTS
-- Perfil de cada usuario humano del CRM. 1:1 con auth.users (Supabase Auth).
-- ---------------------------------------------------------------------------
create table public.agents (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  full_name text,
  avatar_url text,
  role text not null default 'agent' check (role in ('agent', 'supervisor', 'admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agents is 'Perfil de cada agente/supervisor humano. La fila se crea automáticamente al registrarse via Supabase Auth.';
comment on column public.agents.display_name is 'Nombre corto mostrado en burbujas de chat, ej. "JOSE RIERA".';

-- Crea automáticamente el perfil de agente cuando se registra un usuario en Supabase Auth.
create function public.handle_new_agent()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.agents (id, display_name, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_agent();

-- ---------------------------------------------------------------------------
-- WHATSAPP_CHANNELS
-- Buzones / números de WhatsApp Business (Meta Cloud API) conectados al CRM.
-- ---------------------------------------------------------------------------
create table public.whatsapp_channels (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  phone_number text not null unique,
  phone_number_id text unique,
  waba_id text,
  status text not null default 'pending' check (status in ('connected', 'disconnected', 'pending')),
  access_token_secret_ref text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.whatsapp_channels is 'Un buzón por número de WhatsApp Business conectado vía Meta Cloud API. Soporta multi-buzón.';
comment on column public.whatsapp_channels.phone_number_id is 'phone_number_id de la Meta Cloud API, usado para enviar mensajes.';
comment on column public.whatsapp_channels.access_token_secret_ref is 'Referencia/nombre del secreto (no el token en claro) donde vive el access token de Meta para este canal.';

-- ---------------------------------------------------------------------------
-- CONTACTS
-- Clientes que escriben por WhatsApp.
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  display_name text,
  profile_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.contacts.profile_name is 'Nombre de perfil de WhatsApp reportado por Meta.';
comment on column public.contacts.display_name is 'Nombre editable por el agente para el CRM (puede diferir del profile_name).';

-- ---------------------------------------------------------------------------
-- TAGS / CONTACT_TAGS
-- Etiquetas de categorización de contactos (ej. "BBK").
-- ---------------------------------------------------------------------------
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  color text not null default 'default' check (color in ('default', 'accent', 'success', 'warning', 'danger')),
  created_at timestamptz not null default now()
);

create table public.contact_tags (
  contact_id uuid not null references public.contacts (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- CONVERSATIONS
-- Un hilo = un contacto hablando por un buzón de WhatsApp específico.
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  whatsapp_channel_id uuid not null references public.whatsapp_channels (id),
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  unread_count integer not null default 0,
  assigned_agent_id uuid references public.agents (id) on delete set null,
  ai_enabled boolean not null default true,
  deal_status text not null default 'none' check (deal_status in ('none', 'in_progress', 'won', 'lost')),
  deal_closed_at timestamptz,
  last_customer_message_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, whatsapp_channel_id)
);

comment on column public.conversations.ai_enabled is 'Si la IA sigue respondiendo automáticamente en esta conversación. Se apaga cuando un supervisor "Interviene" pausando la IA.';
comment on column public.conversations.last_customer_message_at is 'Timestamp del último mensaje entrante del cliente. Base de la ventana de 24h de WhatsApp.';
comment on column public.conversations.unread_count is 'Mensajes entrantes del cliente sin leer. Base del filtro "No leídos"/"Leídos".';

create index conversations_assigned_agent_id_idx on public.conversations (assigned_agent_id);
create index conversations_whatsapp_channel_id_idx on public.conversations (whatsapp_channel_id);
create index conversations_last_message_at_idx on public.conversations (last_message_at desc);

-- ---------------------------------------------------------------------------
-- MESSAGES
-- Mensajes individuales + eventos de sistema (auditoría) dentro de una conversación.
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender_type text not null check (sender_type in ('customer', 'agent', 'ai', 'system')),
  sender_agent_id uuid references public.agents (id) on delete set null,
  message_type text not null default 'text'
    check (message_type in ('text', 'image', 'audio', 'video', 'document', 'template', 'system_event')),
  content text,
  template_name text,
  media_url text,
  is_internal_note boolean not null default false,
  whatsapp_message_id text,
  whatsapp_status text check (whatsapp_status in ('sent', 'delivered', 'read', 'failed')),
  created_at timestamptz not null default now()
);

comment on table public.messages is 'Incluye mensajes reales de WhatsApp y eventos de sistema (sender_type=system) para el rastro de auditoría en la burbuja de chat.';
comment on column public.messages.is_internal_note is 'Nota interna del supervisor/agente, NO se envía al cliente por WhatsApp.';
comment on column public.messages.sender_agent_id is 'Agente autor, aplica cuando sender_type=agent (o system, para saber quién disparó el evento).';

create index messages_conversation_id_created_at_idx on public.messages (conversation_id, created_at);

-- Mantiene los metadatos de "último mensaje" y el contador de no leídos en conversations.
create function public.handle_new_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations
  set
    last_message_at = new.created_at,
    last_message_preview = left(coalesce(new.content, initcap(replace(new.message_type, '_', ' '))), 140),
    last_customer_message_at = case
      when new.direction = 'inbound' then new.created_at
      else last_customer_message_at
    end,
    unread_count = case
      when new.direction = 'inbound' then unread_count + 1
      else unread_count
    end,
    updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

create trigger on_message_inserted
  after insert on public.messages
  for each row execute function public.handle_new_message();

-- ---------------------------------------------------------------------------
-- NOTES
-- Notas internas del perfil del contacto (independientes del hilo de mensajes).
-- ---------------------------------------------------------------------------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);

create index notes_contact_id_idx on public.notes (contact_id, created_at desc);

-- ---------------------------------------------------------------------------
-- TEMPLATES
-- Plantillas de WhatsApp preaprobadas por Meta, usadas para reabrir chats tras 24h.
-- ---------------------------------------------------------------------------
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  whatsapp_channel_id uuid references public.whatsapp_channels (id) on delete cascade,
  name text not null,
  language text not null default 'es',
  category text not null default 'utility' check (category in ('utility', 'marketing', 'authentication')),
  body_preview text not null,
  status text not null default 'pending' check (status in ('approved', 'pending', 'rejected')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_agents_updated_at before update on public.agents
  for each row execute function public.set_updated_at();
create trigger set_whatsapp_channels_updated_at before update on public.whatsapp_channels
  for each row execute function public.set_updated_at();
create trigger set_contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Realtime: publica los cambios de chat en vivo al frontend.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;

-- ---------------------------------------------------------------------------
-- RLS
-- CRM interno: cualquier agente autenticado (con fila en public.agents) puede
-- leer/escribir todo. No es multi-tenant; el aislamiento importante es
-- autenticado vs. anónimo.
-- ---------------------------------------------------------------------------
alter table public.agents enable row level security;
alter table public.whatsapp_channels enable row level security;
alter table public.contacts enable row level security;
alter table public.tags enable row level security;
alter table public.contact_tags enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.notes enable row level security;
alter table public.templates enable row level security;

create function public.is_agent()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (select 1 from public.agents where id = auth.uid() and is_active);
$$;

create policy "agents_select_all" on public.agents for select using (public.is_agent());
create policy "agents_update_self" on public.agents for update using (id = auth.uid());

create policy "whatsapp_channels_all" on public.whatsapp_channels for all
  using (public.is_agent()) with check (public.is_agent());

create policy "contacts_all" on public.contacts for all
  using (public.is_agent()) with check (public.is_agent());

create policy "tags_all" on public.tags for all
  using (public.is_agent()) with check (public.is_agent());

create policy "contact_tags_all" on public.contact_tags for all
  using (public.is_agent()) with check (public.is_agent());

create policy "conversations_all" on public.conversations for all
  using (public.is_agent()) with check (public.is_agent());

create policy "messages_all" on public.messages for all
  using (public.is_agent()) with check (public.is_agent());

create policy "notes_all" on public.notes for all
  using (public.is_agent()) with check (public.is_agent());

create policy "templates_all" on public.templates for all
  using (public.is_agent()) with check (public.is_agent());

-- ---------------------------------------------------------------------------
-- GRANTS
-- RLS por sí sola no expone las tablas: el rol `authenticated` también
-- necesita privilegios SQL estándar (esta versión de Supabase ya no
-- auto-expone tablas nuevas a los roles de la Data API).
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on
  public.agents,
  public.whatsapp_channels,
  public.contacts,
  public.tags,
  public.contact_tags,
  public.conversations,
  public.messages,
  public.notes,
  public.templates
to authenticated, service_role;
