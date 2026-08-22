-- Los stickers de WhatsApp llegan por el webhook como message.type = "sticker"
-- (WEBP), pero el check original de messages.message_type no lo contemplaba,
-- así que el insert fallaba en silencio y nunca se guardaban.
alter table public.messages
  drop constraint messages_message_type_check;

alter table public.messages
  add constraint messages_message_type_check
  check (message_type in ('text', 'image', 'audio', 'video', 'document', 'sticker', 'template', 'system_event'));
