-- ---------------------------------------------------------------------------
-- "Sin contestar" quiere decir que nadie contestó, no que el cliente habló
-- último
--
-- El filtro preguntaba tres cosas: sin asesor asignado, no cerrada, y
-- `awaiting_reply` —el último mensaje del hilo es del cliente—. Las tres se
-- cumplen a la vez en un chat que YA se atendió: los asesores de SBK
-- contestan sin asignarse la conversación (nada en el CRM se lo pide), el
-- cliente responde "Ok" a lo que le dijeron, y el hilo vuelve a marcarse como
-- trabajo libre pendiente. Es el mismo agujero que src/lib/ai/human-handled.ts
-- documentó para la IA el 26 de agosto de 2026, y por el mismo motivo: nulo en
-- `assigned_agent_id` no significa "libre", y `awaiting_reply` describe igual
-- de bien una conversación en curso que una sin atender.
--
-- Lo que se notaba: esos chats son viejos, así que ordenados por
-- `last_message_at` caían al FINAL de la lista. Había que bajar hasta el fondo
-- del filtro para encontrarse con conversaciones ya respondidas.
--
-- La señal que falta es "en este hilo salió alguna respuesta". No se puede
-- derivar de `conversations` —vive en `messages`—, así que no puede ser una
-- columna generada como `awaiting_reply`: es una columna real que mantiene el
-- mismo trigger que ya mantiene el resto de los metadatos del último mensaje.
--
-- Qué cuenta como respuesta: un mensaje que el CLIENTE puede leer. Quedan
-- fuera los eventos de sistema (el aviso de escalado es `sender_type` 'system'
-- y no sale por WhatsApp) y las notas internas (el asesor hablándole al
-- equipo). Adentro entran el asesor y la IA por igual: la decisión de producto
-- es que "sin contestar" son los clientes a los que nadie respondió nunca.
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column has_reply boolean not null default false;

comment on column public.conversations.has_reply is
  'Alguna vez salió de acá una respuesta que el cliente puede leer (asesor o IA; no cuentan los eventos de sistema ni las notas internas). Es lo que separa "nadie contestó nunca" de "el último mensaje es del cliente", que es lo único que sabe awaiting_reply. Espeja la condición del filtro "Sin contestar" en src/lib/inbox-filters.ts.';

-- ---------------------------------------------------------------------------
-- El trigger que ya mantiene los metadatos del último mensaje mantiene también
-- este flag. Se enciende y no se apaga: un mensaje no se desenvía.
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
    has_reply = has_reply or (
      new.direction = 'outbound'
      and new.sender_type <> 'system'
      and not new.is_internal_note
    ),
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
-- Backfill: el histórico entero, con el mismo criterio del trigger.
-- ---------------------------------------------------------------------------
update public.conversations c
set has_reply = true
where exists (
  select 1
  from public.messages m
  where m.conversation_id = c.id
    and m.direction = 'outbound'
    and m.sender_type <> 'system'
    and not m.is_internal_note
);

-- ---------------------------------------------------------------------------
-- El índice parcial del filtro incorpora la cuarta condición.
--
-- Va en el predicado y no en las columnas por el mismo motivo que las otras
-- tres: la consulta las pide todas juntas y siempre con el mismo valor, así
-- que dentro del índice queda solo el trabajo libre que nadie contestó nunca
-- —bastante menos filas que antes— y ya ordenado como pregunta la bandeja
-- (ver 20260826010000: `desc nulls last`, que es lo que evita un Sort aparte).
--
-- Aditiva para el despliegue: la columna nace en false con default y el
-- backfill la completa, así que el código viejo —que no la conoce— sigue
-- funcionando igual contra el esquema nuevo.
-- ---------------------------------------------------------------------------
drop index if exists conversations_free_unanswered_idx;

create index conversations_free_unanswered_idx
  on public.conversations (last_message_at desc nulls last)
  where awaiting_reply
    and not has_reply
    and assigned_agent_id is null
    and status <> 'closed';

comment on index public.conversations_free_unanswered_idx is
  'Trabajo libre que nadie contestó nunca, en el mismo orden que pide la bandeja (last_message_at desc nulls last). El orden importa: con nulls first el plan agrega un Sort.';
