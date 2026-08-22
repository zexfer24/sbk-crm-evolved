-- ---------------------------------------------------------------------------
-- Estado de entrega en la bandeja
--
-- La lista de conversaciones necesita pintar el doble check de WhatsApp
-- (enviado / recibido / leído) junto a la preview, sin cargar los mensajes de
-- cada hilo. Para eso la conversación guarda de quién es el último mensaje y
-- en qué estado quedó.
--
-- La preview también crecía corta: 140 caracteres cortan la mayoría de los
-- mensajes a media frase. Sube a 280 para que la lista muestre dos renglones
-- completos.
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column last_message_direction text
    check (last_message_direction in ('inbound', 'outbound')),
  add column last_message_status text
    check (last_message_status in ('sent', 'delivered', 'read', 'failed'));

comment on column public.conversations.last_message_direction is
  'Dirección del último mensaje. El doble check solo aplica a los salientes.';
comment on column public.conversations.last_message_status is
  'Estado de entrega del último mensaje saliente. Null en los entrantes y en las notas internas.';

-- ---------------------------------------------------------------------------
-- El trigger de inserción ahora arrastra también dirección y estado.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations
  set
    last_message_at = new.created_at,
    last_message_preview = left(coalesce(new.content, initcap(replace(new.message_type, '_', ' '))), 280),
    last_message_direction = new.direction,
    last_message_status = new.whatsapp_status,
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

-- ---------------------------------------------------------------------------
-- El estado de entrega no llega con el mensaje: lo confirma WhatsApp después,
-- por webhook, con un UPDATE sobre messages. Sin este segundo trigger la
-- bandeja se quedaría para siempre en "enviado".
--
-- Solo se propaga si el mensaje sigue siendo el último de la conversación: un
-- "leído" tardío de un mensaje viejo no debe pisar el estado del actual.
-- ---------------------------------------------------------------------------
create function public.handle_message_status_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations
  set
    last_message_status = new.whatsapp_status,
    updated_at = now()
  where id = new.conversation_id
    and last_message_at = new.created_at;
  return new;
end;
$$;

create trigger on_message_status_changed
  after update of whatsapp_status on public.messages
  for each row
  when (old.whatsapp_status is distinct from new.whatsapp_status)
  execute function public.handle_message_status_change();

-- ---------------------------------------------------------------------------
-- Backfill: las conversaciones que ya existen no tienen estos datos. Se toman
-- del último mensaje real de cada hilo.
-- ---------------------------------------------------------------------------
update public.conversations c
set
  last_message_direction = m.direction,
  last_message_status = m.whatsapp_status
from (
  select distinct on (conversation_id)
    conversation_id, direction, whatsapp_status
  from public.messages
  order by conversation_id, created_at desc
) m
where m.conversation_id = c.id;

-- Filtrar "no leídos" y "sin asignar" recorre la bandeja entera en cada carga.
create index conversations_unread_idx
  on public.conversations (unread_count)
  where unread_count > 0;

create index conversations_unassigned_idx
  on public.conversations (last_message_at desc)
  where assigned_agent_id is null;
