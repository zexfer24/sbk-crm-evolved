-- Liminal CRM - Segunda tanda de features
-- Datos de cliente (Venezuela), citas de mensajes, multimedia, mensajes rápidos.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Datos del cliente
-- ============================================================================
alter table public.contacts
  add column cedula_type text check (cedula_type in ('V', 'E')),
  add column cedula_number text,
  add column state text check (state in (
    'Amazonas', 'Anzoátegui', 'Apure', 'Aragua', 'Barinas', 'Bolívar', 'Carabobo',
    'Cojedes', 'Delta Amacuro', 'Distrito Capital', 'Falcón', 'Guárico', 'La Guaira',
    'Lara', 'Mérida', 'Miranda', 'Monagas', 'Nueva Esparta', 'Portuguesa', 'Sucre',
    'Táchira', 'Trujillo', 'Yaracuy', 'Zulia'
  )),
  add column city text,
  add column address text;

-- ============================================================================
-- Citar mensajes (respuesta a un mensaje del cliente o nuestro)
-- ============================================================================
alter table public.messages
  add column reply_to_message_id uuid references public.messages (id) on delete set null;

-- ============================================================================
-- Mensajes rápidos (texto predefinido que se carga en el composer, editable
-- antes de enviar — distinto de las plantillas, que se envían directo).
-- ============================================================================
create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_quick_replies_updated_at before update on public.quick_replies
  for each row execute function public.set_updated_at();

alter table public.quick_replies enable row level security;

create policy "quick_replies_all" on public.quick_replies for all
  using (public.is_agent()) with check (public.is_agent());

grant select, insert, update, delete on public.quick_replies to authenticated, service_role;

-- ============================================================================
-- Storage: multimedia entrante/saliente de WhatsApp
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', true)
on conflict (id) do nothing;

create policy "whatsapp_media_select" on storage.objects for select
  using (bucket_id = 'whatsapp-media');

create policy "whatsapp_media_insert_authenticated" on storage.objects for insert to authenticated
  with check (bucket_id = 'whatsapp-media');
