-- ============================================================================
-- T0.1 del plan "La bandeja que no pierde" (Etapa 0 · F1 F2 F3 F4)
--
-- El problema de origen: `awaiting_reply` compara `last_message_at` contra
-- `last_customer_message_at`, y `last_message_at` avanza con TODO insert en
-- `messages` (20260827020000_conversations_has_reply.sql, handle_new_message).
-- Una nota interna del asesor, un evento de sistema (insertSystemEvent en
-- src/lib/mutations.ts), la plantilla de bienvenida automática y un envío de
-- la IA que Meta rechaza (whatsapp_status='failed') mueven `last_message_at`
-- sin que el cliente haya recibido nada de nadie — y eso apaga
-- `awaiting_reply` en falso: la conversación deja de figurar como pendiente
-- aunque siga sin respuesta real.
--
-- La reforma separa dos cosas que hoy comparte una sola columna:
--   - "último mensaje visible" (lo que la bandeja pinta en la lista: entra
--     cualquier mensaje que el cliente pueda leer o que muestre la burbuja
--     del chat salvo notas y eventos de sistema) — sigue viviendo en
--     `last_message_at`/`last_message_preview`/`last_message_direction`/
--     `last_message_status`.
--   - "última respuesta real" (lo único que puede apagar "esperando
--     respuesta") — columna nueva `last_reply_at`/`last_reply_sender`, que
--     solo avanza con una salida de un asesor o la IA que de verdad llegó (no
--     es la bienvenida automática, no fue rechazada por Meta).
--
-- `awaiting_reply` pasa a compararse contra `last_reply_at` en vez de contra
-- `last_message_at`. El resto de columnas de "último mensaje" (usadas por la
-- lista de la bandeja para pintar la preview y el doble-check) no cambian de
-- semántica salvo que ahora solo las mueve un mensaje VISIBLE — antes las
-- movía cualquier insert, incluida una nota o un evento de sistema.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Marca de "esto es un automatismo, no una respuesta que cuenta como
--    atención": hoy la única emisora es la plantilla de bienvenida
--    (sender_type='ai', message_type='template'), pero el nombre es genérico
--    a propósito para cualquier automatismo futuro que tampoco deba apagar
--    "esperando respuesta" (un recordatorio, un aviso programado…).
-- ---------------------------------------------------------------------------
alter table public.messages
  add column is_auto_reply boolean not null default false;

comment on column public.messages.is_auto_reply is
  'Un envío automático (hoy: la plantilla de bienvenida) que NO cuenta como respuesta real: no apaga last_reply_at/awaiting_reply aunque el cliente lo reciba. Nace por T0.1 del plan "La bandeja que no pierde" (5/9/2026).';

-- ---------------------------------------------------------------------------
-- 2. La "última respuesta real", separada del "último mensaje visible".
--    `last_reply_sender` no incluye 'system' ni 'customer' a propósito: un
--    evento de sistema o un mensaje entrante nunca son una respuesta.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column last_reply_at timestamptz,
  add column last_reply_sender text check (last_reply_sender in ('agent', 'ai'));

comment on column public.conversations.last_reply_at is
  'Cuándo salió la última respuesta real hacia el cliente: un asesor o la IA, visible (ni nota interna ni evento de sistema), que no era la bienvenida automática (is_auto_reply) ni fue rechazada por Meta (whatsapp_status=failed). Es lo único que puede apagar awaiting_reply. T0.1, 5/9/2026.';
comment on column public.conversations.last_reply_sender is
  'Quién dio la última respuesta real: agent o ai. Null si nadie ha respondido todavía (o si la única respuesta que hubo se invalidó — rechazo de Meta, o el asesor la borró).';

-- ---------------------------------------------------------------------------
-- 3. handle_new_message(): separa "visible" (mueve last_message_*) de
--    "respuesta real" (mueve last_reply_*). `last_customer_message_at`,
--    `unread_count` y `has_reply` NO cambian de regla — siguen exactamente
--    como en 20260827020000.
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
    last_message_preview = case when visible
      then left(coalesce(new.content, initcap(replace(new.message_type, '_', ' '))), 280)
      else last_message_preview
    end,
    last_message_direction = case when visible then new.direction else last_message_direction end,
    last_message_status = case when visible then new.whatsapp_status else last_message_status end,
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
-- 4. handle_message_status_change(): además de lo que ya hacía (propagar el
--    estado de entrega si el mensaje sigue siendo el último visible), si un
--    envío que SÍ había apagado "esperando respuesta" resulta rechazado por
--    Meta después de insertarse, hay que recalcular con la última respuesta
--    real que siga en pie — o volver a null si no queda ninguna — para que
--    la conversación vuelva a esperar. Sin esto, un envío aceptado por el
--    trigger de inserción (whatsapp_status todavía 'sent') y rechazado un
--    instante después por el callback de Meta dejaría awaiting_reply en
--    false para siempre, con el cliente sin haber recibido nada.
-- ---------------------------------------------------------------------------
create or replace function public.handle_message_status_change()
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

  if new.whatsapp_status = 'failed' then
    update public.conversations c
    set
      last_reply_at = (
        select m.created_at
        from public.messages m
        where m.conversation_id = c.id
          and m.direction = 'outbound'
          and m.sender_type in ('agent', 'ai')
          and not m.is_internal_note
          and not m.is_auto_reply
          and m.whatsapp_status is distinct from 'failed'
        order by m.created_at desc
        limit 1
      ),
      last_reply_sender = (
        select m.sender_type
        from public.messages m
        where m.conversation_id = c.id
          and m.direction = 'outbound'
          and m.sender_type in ('agent', 'ai')
          and not m.is_internal_note
          and not m.is_auto_reply
          and m.whatsapp_status is distinct from 'failed'
        order by m.created_at desc
        limit 1
      ),
      updated_at = now()
    where c.id = new.conversation_id
      and c.last_reply_at = new.created_at;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Backfill, en el orden que importa: primero is_auto_reply (identifica la
--    bienvenida histórica), después last_reply_at/last_reply_sender (que la
--    usa en su condición), y por separado last_message_* recalculado solo
--    contra mensajes VISIBLES — antes de este backfill esas columnas podían
--    apuntar a una nota o un evento de sistema, que ya no cuentan como
--    "último mensaje" bajo la regla nueva.
-- ---------------------------------------------------------------------------
update public.messages
set is_auto_reply = true
where message_type = 'template' and sender_type = 'ai';

update public.conversations c
set
  last_reply_at = m.created_at,
  last_reply_sender = m.sender_type
from (
  select distinct on (conversation_id)
    conversation_id, created_at, sender_type
  from public.messages
  where direction = 'outbound'
    and sender_type in ('agent', 'ai')
    and not is_internal_note
    and not is_auto_reply
    and whatsapp_status is distinct from 'failed'
  order by conversation_id, created_at desc
) m
where m.conversation_id = c.id;

update public.conversations c
set
  last_message_at = m.created_at,
  last_message_preview = left(coalesce(m.content, initcap(replace(m.message_type, '_', ' '))), 280),
  last_message_direction = m.direction,
  last_message_status = m.whatsapp_status
from (
  select distinct on (conversation_id)
    conversation_id, created_at, content, message_type, direction, whatsapp_status
  from public.messages
  where direction = 'inbound'
     or (sender_type in ('agent', 'ai') and not is_internal_note)
  order by conversation_id, created_at desc
) m
where m.conversation_id = c.id;

-- ---------------------------------------------------------------------------
-- 6. awaiting_reply pasa a compararse contra last_reply_at (backfileado
--    arriba) en vez de last_message_at. Al ser columna GENERADA, hay que
--    dropearla y volver a crearla — Postgres recomputa el valor de cada fila
--    en ese mismo instante contra el last_reply_at que ya quedó correcto por
--    el backfill de más arriba, así que el orden de esta migración importa.
--
--    Dropear la columna arrastra los índices parciales que la usan en su
--    predicado (conversations_free_unanswered_idx, conversations_pending_idx)
--    sin necesidad de CASCADE: se recrean acá mismo, con el predicado exacto
--    que tenían (20260828010000 y 20260828020000 respectivamente).
-- ---------------------------------------------------------------------------
alter table public.conversations drop column awaiting_reply;

alter table public.conversations
  add column awaiting_reply boolean
  generated always as (
    last_customer_message_at is not null
    and (last_reply_at is null or last_reply_at <= last_customer_message_at)
  ) stored;

comment on column public.conversations.awaiting_reply is
  'Nadie ha dado una respuesta real desde el último mensaje del cliente: last_reply_at es null o quedó antes que last_customer_message_at. Hasta el 5/9/2026 (T0.1) comparaba contra last_message_at, que avanzaba con notas, eventos de sistema, la bienvenida automática y envíos rechazados por Meta — apagando "esperando" sin que el cliente recibiera nada. Ahora solo lo apaga una respuesta real de un asesor o la IA (ver last_reply_at).';

create index conversations_free_unanswered_idx
  on public.conversations (last_message_at desc nulls last)
  where awaiting_reply
    and assigned_agent_id is null
    and status <> 'closed';

comment on index public.conversations_free_unanswered_idx is
  'Trabajo libre sin contestar, en el mismo orden que pide la bandeja (last_message_at desc nulls last). awaiting_reply ahora se apaga solo con una respuesta real (last_reply_at), no con cualquier mensaje (T0.1, 5/9/2026).';

create index conversations_pending_idx
  on public.conversations (last_message_at desc nulls last)
  where awaiting_reply
    and status <> 'closed';

comment on index public.conversations_pending_idx is
  'Píldora "Pendientes" de la bandeja: awaiting_reply and status <> closed, sin exigir asesor libre. awaiting_reply ahora se apaga solo con una respuesta real (last_reply_at), no con cualquier mensaje (T0.1, 5/9/2026).';

-- ---------------------------------------------------------------------------
-- 7. Índice nuevo para T1.5 del plan: conversaciones escaladas a un asesor
--    (IA apagada tras el escalado) que siguen abiertas, ordenadas para que
--    ese panel no tenga que recorrer toda la tabla. No se usa todavía en
--    esta tarea — lo consume la Etapa 1.
-- ---------------------------------------------------------------------------
create index conversations_escalated_idx
  on public.conversations (last_message_at desc)
  where journey_stage = 'assigned' and not ai_enabled and status <> 'closed';

comment on index public.conversations_escalated_idx is
  'Conversaciones escaladas a un asesor humano (ai_enabled apagada tras el escalado) que siguen abiertas. Preparado en T0.1 (5/9/2026) para que lo use T1.5.';

-- ---------------------------------------------------------------------------
-- 8. conversation_handoffs.reason: la Etapa 0 necesita registrar el
--    escalado a un asesor y su falla (nadie disponible), y el rechazo de un
--    envío de la IA por Meta. Se amplía el CHECK, no se toca el tipo (sigue
--    siendo `text`, ver 20260830040000 sobre por qué no es un enum).
-- ---------------------------------------------------------------------------
alter table public.conversation_handoffs
  drop constraint conversation_handoffs_reason_check;

alter table public.conversation_handoffs
  add constraint conversation_handoffs_reason_check
  check (reason in (
    'agente_no_puede_correr',
    'conversacion_inexistente',
    'pausada',
    'asignada',
    'humano_intervino',
    'humano_se_adelanto',
    'fuera_de_ventana',
    'identidad_no_verificable',
    'lock_perdido',
    'abandonado',
    'entrega_fallida',
    'reabierto',
    'escalado_por_ia',
    'reclamado',
    'devuelto_a_ia',
    'cerrado',
    'ventana_vencida',
    'sla_vencido',
    'escalada',
    'escalada_sin_asesor',
    'rechazado_por_meta'
  ));

-- ---------------------------------------------------------------------------
-- No hace falta ningún revoke nuevo: handle_new_message() y
-- handle_message_status_change() ya estaban cerradas a anon/authenticated
-- desde 20260830010000_security_definer_revoke_roles.sql, y `create or
-- replace function` conserva el ACL existente de la función (no lo
-- resetea) — se verificó con has_function_privilege contra la base
-- reconstruida, ver reporte de esta tarea. unassigned_waiting_count() no
-- cambia: sigue leyendo conversation_handoffs por nombre de columna, ajeno
-- a la lista de razones.
-- ---------------------------------------------------------------------------
