-- ============================================================================
-- T1 de la corrida "La bandeja habla español y el número nuevo queda a un
-- clic" (8/9/2026)
--
-- El problema: la lista de la bandeja pinta "Image", "Audio", "Sticker",
-- "Unsupported" como vista previa cuando el último mensaje visible no trae
-- `content` (una foto/audio/video/documento/sticker sin pie, o un
-- `unsupported` de Meta). Causa: `handle_new_message()` escribía
-- `left(coalesce(new.content, initcap(replace(new.message_type, '_', ' '))),
-- 280)` en `last_message_preview` -- el `initcap` del `message_type` en
-- inglés crudo, sin traducir -- y `conversation-list-item.tsx:153` lo pinta
-- tal cual. Deuda dejada explícitamente por la corrida "El cliente que
-- cambió de número" (6/9/2026, ver
-- docs/planes/2026-09-06-el-cliente-que-cambio-de-numero.md).
--
-- La solución va en la base, no en el frontend: `last_message_preview` es la
-- única fuente de verdad que lee la bandeja (no hay una segunda columna con
-- el tipo crudo que el cliente pudiera necesitar reconstruir), así que
-- traducir en TypeScript exigiría duplicar la tabla de etiquetas ahí Y en
-- cualquier otro consumidor futuro de esa columna. Una sola función SQL,
-- reusable donde haga falta.
--
--   1. `message_preview_label(message_type)` -- función nueva, SQL pura
--      (ni siquiera necesita plpgsql), NO `security definer`: no lee ni
--      escribe ninguna tabla, así que no hay nada que salte RLS ni haga
--      falta revocar (el guardián de `supabase/tests/permisos_funciones.sql`
--      solo recorre funciones con `prosecdef = true`; esta no calza ahí a
--      propósito). Vocabulario alineado con `src/lib/ai/history-line.ts`
--      ("foto", "documento", "nota de voz" para audio en el marcador del
--      modelo -- acá se usa "Audio" tal como pide el criterio de esta tarea)
--      y con la burbuja de `unsupported` en
--      `src/components/chat/message-bubble.tsx` ("WhatsApp no entrega este
--      mensaje...").
--
--   2. `handle_new_message()`: copia EXACTA de la versión vigente en
--      20260907010000_ventana_24h_dice_la_verdad.sql, cambiando SOLO la
--      expresión de `last_message_preview` para llamar a la función nueva en
--      vez de `initcap(replace(...))` directo. Los candados A/B sobre
--      `last_customer_message_at`/`unread_count`/`has_reply`/`last_reply_*`
--      quedan carácter por carácter iguales -- esta migración no les
--      concierne. Sin `security definer` NUEVA (ya lo era desde
--      20260830010000) -> `create or replace function` conserva el ACL, sin
--      revokes ni grants nuevos.
--
--   3. Backfill idempotente: solo toca conversaciones cuyo
--      `last_message_preview` actual es EXACTAMENTE el `initcap` en inglés
--      del `message_type` de su último mensaje VISIBLE -- el mismo
--      `distinct on (conversation_id)` con el mismo predicado de visibilidad
--      que el paso 5 de 20260905010000_conversations_last_reply.sql. Un
--      cliente que escribió literalmente "Image" como texto queda intacto
--      (su `message_type` es `text`, `initcap(replace('text','_',' '))` da
--      "Text", no "Image" -- no calza el predicado). Aplicado dos veces no
--      cambia nada: la segunda vez ya no quedan previews en inglés que
--      calcen con el `initcap` de su tipo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabla de etiquetas en español para message_type. `immutable strict`:
--    determinística, sin entrada nula relevante (un `message_type` nulo
--    devolvería null igual con `strict`, que es el mismo comportamiento que
--    tenía `initcap(replace(null, ...))` antes -- `messages.message_type` es
--    NOT NULL de todas formas, así que este caso no ocurre en la práctica).
-- ---------------------------------------------------------------------------
create or replace function public.message_preview_label(message_type text)
returns text
language sql
immutable strict
as $$
  select case message_type
    when 'image' then '📷 Foto'
    when 'video' then '🎥 Video'
    when 'audio' then '🎤 Audio'
    when 'document' then '📄 Documento'
    when 'sticker' then 'Sticker'
    when 'template' then 'Plantilla'
    when 'unsupported' then 'Mensaje que WhatsApp no entrega'
    else initcap(replace(message_type, '_', ' '))
  end;
$$;

comment on function public.message_preview_label(text) is
  'Traduce message_type a la etiqueta en español que pinta la preview de la bandeja cuando el mensaje no trae content (conversation-list-item.tsx). Antes de esta función handle_new_message() usaba initcap(replace(message_type, ''_'', '' '')) directo, dejando "Image"/"Audio"/"Sticker"/"Unsupported" en inglés crudo -- deuda de la corrida "El cliente que cambió de número" (6/9/2026), cerrada por la corrida "La bandeja habla español y el número nuevo queda a un clic" (8/9/2026). NO es security definer: no toca ninguna tabla, no hace falta revocarle nada a nadie.';

-- ---------------------------------------------------------------------------
-- 2. handle_new_message(): parte de la versión vigente en
--    20260907010000_ventana_24h_dice_la_verdad.sql. Cambia SOLO la
--    expresión de `last_message_preview` (línea marcada abajo); todo lo
--    demás -- candados A/B, has_reply, unread_count, last_reply_* -- queda
--    exactamente igual.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  visible boolean;
begin
  -- "Visible" es lo que la bandeja pinta como el último mensaje del hilo: un
  -- entrante del cliente, o un saliente del asesor/IA que no sea una nota
  -- interna. Un evento de sistema (sender_type='system') o una nota
  -- (is_internal_note) no son visibles: no mueven la preview de la lista.
  visible := new.direction = 'inbound'
    or (new.sender_type in ('agent', 'ai') and not new.is_internal_note);

  update public.conversations
  set
    last_message_at = case when visible then new.created_at else last_message_at end,
    -- Única línea que cambia respecto a 20260907010000: la etiqueta de
    -- respaldo cuando no hay content ya no sale del initcap crudo del tipo
    -- en inglés, sale de message_preview_label() (ver punto 1 de esta
    -- migración).
    last_message_preview = case when visible
      then left(coalesce(new.content, public.message_preview_label(new.message_type)), 280)
      else last_message_preview
    end,
    last_message_direction = case when visible then new.direction else last_message_direction end,
    last_message_status = case when visible then new.whatsapp_status else last_message_status end,
    -- Candado A: un `unsupported` sigue siendo visible arriba (se ve en el
    -- chat) pero no cuenta como "el cliente escribió" para el reloj de la
    -- ventana de 24 h -- Meta tampoco lo cuenta para la suya.
    --
    -- Candado B: un saliente que la IA insertó YA fallido con 131047 (Meta
    -- avisando que la ventana ya estaba cerrada al momento del envío) empuja
    -- el reloj hacia atrás. `last_customer_message_at is not null` evita que
    -- `least(null, x)` invente una fecha sobre un lead sin mensajes; `new.
    -- created_at > last_customer_message_at` evita que un fallo insertado
    -- fuera de orden retroceda un reloj que un mensaje posterior ya adelantó.
    last_customer_message_at = case
      when new.direction = 'inbound' and new.message_type <> 'unsupported' then new.created_at
      when new.direction = 'outbound'
        and new.whatsapp_status = 'failed'
        and new.whatsapp_error_code = 131047
        and last_customer_message_at is not null
        and new.created_at > last_customer_message_at
      then least(last_customer_message_at, new.created_at - interval '24 hours')
      else last_customer_message_at
    end,
    has_reply = has_reply or (
      new.direction = 'outbound'
      and new.sender_type <> 'system'
      and not new.is_internal_note
    ),
    -- Mismo candado A que arriba: un `unsupported` no suma a "no leídos" --
    -- no es un mensaje que el cliente esté esperando que alguien lea, es
    -- Meta avisando de algo que no supo entregar tal cual.
    unread_count = case
      when new.direction = 'inbound' and new.message_type <> 'unsupported' then unread_count + 1
      else unread_count
    end,
    -- Respuesta real: saliente, visible, ni bienvenida automática ni
    -- rechazada por Meta. Una nota, un evento de sistema, la plantilla de
    -- bienvenida o un envío que Meta ya rechazó al insertarse (whatsapp_status
    -- llega 'failed' desde el arranque, no solo por un update posterior) NO
    -- apagan "esperando respuesta".
    last_reply_at = case
      when new.direction = 'outbound'
        and visible
        and not new.is_auto_reply
        and new.whatsapp_status is distinct from 'failed'
      then new.created_at
      else last_reply_at
    end,
    last_reply_sender = case
      when new.direction = 'outbound'
        and visible
        and not new.is_auto_reply
        and new.whatsapp_status is distinct from 'failed'
      then new.sender_type
      else last_reply_sender
    end,
    updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill: recalcula `last_message_preview` en las conversaciones cuyo
--    valor actual es EXACTAMENTE el initcap en inglés del message_type de su
--    último mensaje visible (el mismo distinct on (conversation_id) con el
--    mismo predicado de visibilidad que el paso 5 de
--    20260905010000_conversations_last_reply.sql). `raise notice` con el
--    conteo de filas corregidas.
-- ---------------------------------------------------------------------------
do $$
declare
  n_corregidas integer;
begin
  update public.conversations c
  set
    last_message_preview = left(coalesce(m.content, public.message_preview_label(m.message_type)), 280),
    updated_at = now()
  from (
    select distinct on (conversation_id)
      conversation_id, content, message_type
    from public.messages
    where direction = 'inbound'
       or (sender_type in ('agent', 'ai') and not is_internal_note)
    order by conversation_id, created_at desc
  ) m
  where m.conversation_id = c.id
    and c.last_message_preview = initcap(replace(m.message_type, '_', ' '));
  get diagnostics n_corregidas = row_count;
  raise notice 'preview_en_espanol: % conversación(es) con last_message_preview corregido de inglés crudo a español', n_corregidas;
end $$;

-- ---------------------------------------------------------------------------
-- Sin revokes ni grants nuevos: message_preview_label() no es security
-- definer, y handle_new_message() ya estaba cerrada a anon/authenticated
-- desde 20260830010000_security_definer_revoke_roles.sql -- `create or
-- replace function` conserva el ACL existente.
-- ---------------------------------------------------------------------------
