-- ============================================================================
-- T3.2 del plan "La bandeja que no pierde" (Etapa 3, 5/9/2026): entrantes
-- completos -- botones, listas, pedidos, anuncios, "reproducido"
--
-- La Cloud API manda más formas de mensaje entrante de las que este CRM sabía
-- guardar: la respuesta a un botón o a un ítem de lista de un mensaje
-- interactivo, la respuesta al botón rápido de una plantilla, un pedido
-- armado desde el catálogo de WhatsApp, y el aviso "reproducido" de una nota
-- de voz. Todo lo que no calzaba en ningún `message_type` conocido caía al
-- `else` del webhook con una frase fija en castellano -- perdiendo el dato
-- real (qué botón, qué se pidió, qué tipo era de verdad) detrás de esa
-- frase genérica.
--
-- Esta migración solo abre la puerta en el esquema: los CHECK que faltan y
-- dos columnas jsonb sin esquema fijo (son formas de Meta que cambian por
-- tipo de mensaje). El código que las usa (`webhooks/whatsapp/route.ts`) va
-- en el commit siguiente, sin `[migración]`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. message_type: tres valores nuevos.
--    - 'interactive': la respuesta a un botón o a un ítem de lista de un
--      mensaje interactivo (`interactive.button_reply`/`list_reply`), y
--      también el `type: "button"` de una plantilla -- mismo tratamiento en
--      el código, ver el comentario de webhooks/whatsapp/route.ts.
--    - 'order': un pedido armado desde el catálogo de WhatsApp.
--    - 'unsupported': lo que el CRM todavía no sabe representar. Antes caía
--      con un texto fijo en `content`; desde este commit `content` queda
--      null y el tipo real de Meta se guarda en `payload.type`, sin
--      inventar prosa sobre algo que no se entiende.
-- ---------------------------------------------------------------------------
alter table public.messages
  drop constraint messages_message_type_check;

alter table public.messages
  add constraint messages_message_type_check
  check (message_type in (
    'text', 'image', 'audio', 'video', 'document', 'sticker', 'template',
    'system_event', 'interactive', 'order', 'unsupported'
  ));

-- ---------------------------------------------------------------------------
-- 2. whatsapp_status: 'played' -- WhatsApp lo manda cuando el cliente
--    reproduce una nota de voz que le enviamos. Se agrega al CHECK de
--    `messages` y también al de `conversations.last_message_status`
--    (20260822060000_inbox_delivery_status.sql), porque
--    handle_message_status_change() propaga ahí el estado del último
--    mensaje visible -- sin este segundo CHECK, un audio "reproducido" que
--    resultara ser el último mensaje del hilo rompería ese UPDATE.
-- ---------------------------------------------------------------------------
alter table public.messages
  drop constraint messages_whatsapp_status_check;

alter table public.messages
  add constraint messages_whatsapp_status_check
  check (whatsapp_status in ('sent', 'delivered', 'read', 'played', 'failed'));

alter table public.conversations
  drop constraint conversations_last_message_status_check;

alter table public.conversations
  add constraint conversations_last_message_status_check
  check (last_message_status in ('sent', 'delivered', 'read', 'played', 'failed'));

-- keep_whatsapp_status_moving_forward() (20260822110000) descarta cualquier
-- UPDATE que retroceda el doble check; 'played' tiene que rankear MÁS ALTO
-- que 'read' (una nota de voz se reproduce después de "leerse", nunca
-- antes) para que ese trigger no lo trate como un retroceso -- si quedara
-- empatado o por debajo, un "leído" tardío de Meta pisaría un "reproducido"
-- que el asesor ya había visto, y el check retrocedería en pantalla.
--
-- whatsapp_status_rank() NO es security definer (se verificó leyendo su
-- definición en 20260822110000_message_search_payment_and_closer.sql: la
-- cabecera no lleva esa cláusula, corre con los privilegios de quien la
-- invoca) -- `create or replace` no toca ningún ACL, y no hace falta ningún
-- revoke nuevo.
create or replace function public.whatsapp_status_rank(status text)
returns integer
language sql
immutable
parallel safe
as $$
  select case status
    when 'sent' then 1
    when 'delivered' then 2
    when 'read' then 3
    when 'played' then 4
    else 0
  end
$$;

-- ---------------------------------------------------------------------------
-- 3. Datos crudos que no tienen columna propia todavía.
--
--    messages.payload: qué botón/ítem respondió (id), el payload de la
--    plantilla, los ítems de un pedido, el producto referido de un anuncio
--    (context.referred_product), o solo el tipo real de Meta cuando
--    message_type='unsupported'. jsonb sin esquema fijo a propósito.
--
--    conversations.referral: de qué anuncio "Click to WhatsApp" vino la
--    conversación (message.referral, que Meta manda con el mensaje que
--    origina el hilo), con la fecha en que se recibió -- el banner de la
--    cabecera del chat lo compara contra esa fecha para dejar de mostrarse
--    pasadas 72 h.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column payload jsonb;

comment on column public.messages.payload is
  'Datos crudos del tipo de mensaje sin columna propia: id del botón/ítem respondido, payload de la plantilla, ítems de un pedido, producto referido de un anuncio, o el tipo real de Meta cuando message_type=unsupported. T3.2 del plan "La bandeja que no pierde", 5/9/2026.';

alter table public.conversations
  add column referral jsonb;

comment on column public.conversations.referral is
  'De qué anuncio "Click to WhatsApp" vino esta conversación (message.referral de Meta: headline, sourceUrl, etc.), con receivedAt para que el banner de la cabecera del chat deje de mostrarse pasadas 72 h. Null si no vino de un anuncio. T3.2 del plan "La bandeja que no pierde", 5/9/2026.';
