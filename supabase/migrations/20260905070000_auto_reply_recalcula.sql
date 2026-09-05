-- ============================================================================
-- B1 del anexo "Bandeja que no pierde" (5/9/2026): la base recalcula
-- last_reply_at/awaiting_reply también cuando un mensaje deja de contar
-- como respuesta por marcarse is_auto_reply, no solo cuando Meta lo rechaza.
--
-- El problema que deja abierto A1 (mismo anexo): un escenario del supervisor
-- con `afterSend = "escalate"` manda su texto por sendPlaybookReply ANTES de
-- escalar (T0.3 exige ese orden: nada puede acompañar a un mensaje que Meta
-- ya rechazó), así que ese mensaje se inserta con is_auto_reply = false —
-- todavía no se sabe si va a hacer falta un asesor — y handle_new_message
-- (20260905010000) lo toma como respuesta real: mueve last_reply_at, apaga
-- awaiting_reply. Recién después escalateConversation descubre que no hay
-- ningún asesor conectado. No se puede invertir el orden ni adivinar antes
-- de enviar si habrá asesor (sería una carrera). La salida limpia es que
-- B2 marque ese mensaje como is_auto_reply DESPUÉS, cuando ya se sabe, y que
-- el trigger de status recalcule — pero hasta esta migración
-- handle_message_status_change() solo recalculaba cuando whatsapp_status
-- pasaba a 'failed', nunca cuando cambiaba is_auto_reply.
--
-- Además producción tiene escalaciones sin asesor ANTERIORES al anexo A1
-- cuya despedida de la IA quedó guardada sin la marca is_auto_reply: hoy esas
-- conversaciones tienen last_reply_sender = 'ai' y awaiting_reply en false,
-- como si alguien las hubiera atendido, cuando el cliente sigue esperando a
-- una persona. El operador pidió cero excepciones el 5/9/2026, así que el
-- backfill de abajo las corrige de una vez, dejando que sea el trigger quien
-- recalcule (no un UPDATE a mano sobre last_reply_at).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. handle_message_status_change(): dos cambios sobre la versión de
--    20260905010000.
--
--    a) El primer bloque (propagar last_message_status) hasta hoy solo
--       disparaba por cambio de whatsapp_status, así que el `if` que lo
--       protege era implícito en la condición del trigger. Ahora el mismo
--       trigger también dispara por is_auto_reply, así que el bloque se
--       envuelve en su propio `if old.whatsapp_status is distinct from
--       new.whatsapp_status` explícito — sin esto, marcar is_auto_reply
--       reescribiría last_message_status con el mismo valor de siempre
--       (inofensivo, pero confunde updated_at) o, peor, lo haría depender
--       de que new.whatsapp_status siga poblado en ese UPDATE puntual.
--
--    b) El segundo bloque (recalcular last_reply_at/last_reply_sender con la
--       última respuesta real que siga en pie) pasaba solo por
--       `whatsapp_status = 'failed'`. Ahora también entra cuando
--       `is_auto_reply` pasa de false a true — el caso de B2 y del backfill
--       de abajo: un mensaje que SÍ contaba como respuesta deja de contar.
--       El cuerpo de la subconsulta no cambia (ya excluía is_auto_reply,
--       porque tenía que decidir bien incluso antes de que existiera esta
--       migración: una respuesta vieja que ya era automática no debía
--       colarse). La condición `c.last_reply_at = new.created_at` tampoco
--       cambia: solo recalcula si ESTE mensaje era la respuesta vigente de
--       la conversación — si no lo era, marcarlo is_auto_reply no mueve nada
--       (paso 11 de awaiting_reply.sql).
--
--    Es security definer reemplazada con `create or replace`: conserva el
--    ACL que ya tenía. Medido contra la base local antes de escribir esta
--    migración — anon y authenticated ya la tenían cerrada desde
--    20260830010000_security_definer_revoke_roles.sql (que revocó los DOS,
--    `from public` y `from anon, authenticated`) y siguen así después del
--    `create or replace`; no hace falta ningún revoke ni grant nuevo.
-- ---------------------------------------------------------------------------
create or replace function public.handle_message_status_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.whatsapp_status is distinct from new.whatsapp_status then
    update public.conversations
    set
      last_message_status = new.whatsapp_status,
      updated_at = now()
    where id = new.conversation_id
      and last_message_at = new.created_at;
  end if;

  if new.whatsapp_status = 'failed' or (new.is_auto_reply and not old.is_auto_reply) then
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
-- 2. El trigger pasa a disparar también por is_auto_reply, no solo por
--    whatsapp_status. Se dropea y se recrea entero (no hay `create or
--    replace trigger` con distinta lista de columnas en Postgres < 14 para
--    `of`, y esta base corre en una versión que tampoco lo soporta para este
--    caso) — mismo patrón que 20260905010000 usó para la columna generada.
-- ---------------------------------------------------------------------------
drop trigger if exists on_message_status_changed on public.messages;

create trigger on_message_status_changed
  after update of whatsapp_status, is_auto_reply on public.messages
  for each row
  when (
    old.whatsapp_status is distinct from new.whatsapp_status
    or old.is_auto_reply is distinct from new.is_auto_reply
  )
  execute function public.handle_message_status_change();

-- ---------------------------------------------------------------------------
-- 3. Backfill — cero excepciones, después de recrear el trigger para que sea
--    él quien recalcule last_reply_at/last_reply_sender/awaiting_reply, no
--    un UPDATE a mano que podría desalinearse de la lógica de arriba.
--
--    Marca is_auto_reply = true SOLO el mensaje que hoy es "la respuesta
--    vigente" (m.created_at = c.last_reply_at) de una conversación que:
--      - journey_stage = 'assigned' y not ai_enabled: fue escalada y la IA
--        ya se apagó (si siguiera encendida, no sería el caso que corrige
--        A1/B — el reconciliador exige ai_enabled = true, así que una
--        escalada con la IA todavía prendida no es este escenario).
--      - assigned_agent_id is null: sin asesor. Con asesor asignado, la
--        respuesta de la IA cuenta de verdad — el chat tiene dueño y se ve
--        en "Mías" y en "Escaladas → Con asesor" (decisión explícita de A1,
--        no un olvido).
--      - status <> 'closed': una conversación cerrada no vuelve a "esperando
--        respuesta" por este backfill; si el cliente la reabre, ya hay
--        traspaso propio (T2.1/A2) para eso.
--      - not awaiting_reply y last_reply_sender = 'ai': es exactamente el
--        síntoma — la IA parece haber respondido de verdad y por eso la
--        conversación no figura como pendiente ni como sin dueño, cuando en
--        realidad esa "respuesta" fue la despedida sin asesor detrás.
--      - m.direction = 'outbound' and m.sender_type = 'ai' and not
--        m.is_internal_note and not m.is_auto_reply: el propio mensaje que
--        la subconsulta del trigger habría encontrado como última respuesta
--        real — sin este último filtro se arriesgaría a volver a marcar un
--        mensaje que ya lo era.
--
--    El trigger que se acaba de recrear hace el resto: recalcula
--    last_reply_at con lo que quede antes de este mensaje (o null si no hay
--    nada), y awaiting_reply (columna generada sobre last_reply_at) vuelve a
--    true. Tras aplicar esta migración van a REAPARECER en "Pendientes" y
--    "Sin dueño" escalaciones viejas sin asesor que hoy parecían atendidas —
--    es lo correcto: el cliente seguía esperando a una persona. Ver el
--    aviso en docs/PRODUCCION.md, sección de esta migración.
-- ---------------------------------------------------------------------------
update public.messages m
set is_auto_reply = true
from public.conversations c
where m.conversation_id = c.id
  and c.journey_stage = 'assigned'
  and not c.ai_enabled
  and c.assigned_agent_id is null
  and c.status <> 'closed'
  and not c.awaiting_reply
  and c.last_reply_sender = 'ai'
  and m.direction = 'outbound' and m.sender_type = 'ai'
  and not m.is_internal_note and not m.is_auto_reply
  and m.created_at = c.last_reply_at;

-- ---------------------------------------------------------------------------
-- Sin función security definer NUEVA (handle_message_status_change ya
-- existía, se reemplaza con create or replace): no hacen falta revokes ni
-- grants nuevos. supabase/tests/permisos_funciones.sql suma un grupo
-- "funciones de trigger" que mide handle_new_message() y
-- handle_message_status_change() contra anon/authenticated — ninguna de las
-- dos aparecía todavía en ese archivo por nombre, aunque ya estaban cerradas
-- desde 20260830010000.
-- ---------------------------------------------------------------------------
