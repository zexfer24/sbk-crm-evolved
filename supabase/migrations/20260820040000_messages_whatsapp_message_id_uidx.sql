-- ============================================================================
-- Idempotencia del webhook de WhatsApp: la Cloud API de Meta reentrega un
-- webhook si no respondemos rápido o si hay un error (entrega "at-least
-- once"). Sin este índice, un reintento duplicaba el mensaje entrante en el
-- historial y podía disparar una segunda respuesta de la IA. El webhook ya
-- fue actualizado para tratar una violación de esta restricción como "ya
-- procesado" en vez de un error.
--
-- Parcial (where ... is not null) porque los mensajes salientes generados
-- por el CRM (notas internas, algunos eventos de sistema) no siempre tienen
-- whatsapp_message_id.
-- ============================================================================
create unique index if not exists messages_whatsapp_message_id_uidx
  on public.messages (whatsapp_message_id)
  where whatsapp_message_id is not null;
