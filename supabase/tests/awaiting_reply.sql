-- ===========================================================================
-- awaiting_reply distingue una respuesta real de una nota, un evento o una
-- bienvenida (T0.1, plan "La bandeja que no pierde", 5/9/2026)
--
-- Antes de esta migración (20260905010000_conversations_last_reply.sql)
-- `awaiting_reply` comparaba `last_message_at` —que avanza con CUALQUIER
-- insert en `messages`— contra `last_customer_message_at`. Una nota interna,
-- un evento de sistema, la plantilla de bienvenida automática o un envío de
-- la IA rechazado por Meta apagaban "esperando respuesta" sin que el cliente
-- hubiera recibido nada. Ahora `awaiting_reply` compara contra `last_reply_at`
-- —que solo avanza con una respuesta real, visible, ni automática ni
-- rechazada— y este archivo recorre paso a paso los ocho casos que la
-- reforma existe para arreglar, en el orden en que ocurrirían en una
-- conversación real. Mismo estilo que invariante_leads.sql: transacción con
-- rollback, `raise exception` en cada aserción que falla, no ensucia la base.
--
-- Los `created_at` de los mensajes van EXPLÍCITOS y crecientes (t0, t0 + 5
-- min, t0 + 10 min...) y no por default now(): dentro de una misma
-- transacción `now()` devuelve siempre la hora de ARRANQUE de la
-- transacción, así que dos inserts sucesivos con `default now()` habrían
-- quedado con el mismo instante y las comparaciones `<=` entre
-- last_reply_at/last_customer_message_at habrían empatado sin poder
-- distinguir "antes" de "después" (se detectó así: los pasos 6 y 8a fallaban
-- en la primera versión de este archivo, que sí usaba default now()).
--
-- Corre en el job `migraciones` de CI, contra la base reconstruida desde
-- cero, en el mismo paso que invariante_leads.sql y permisos_funciones.sql.
-- ===========================================================================

begin;

-- Un canal, un contacto, una conversación: los ocho pasos son sobre el MISMO
-- hilo, en orden cronológico, así que alcanza con una sola conversación.
insert into public.whatsapp_channels (id, label, phone_number) values
  ('33333333-3333-3333-3333-333333333333', 'Canal de prueba awaiting_reply', '+580000000010');

insert into public.contacts (id, phone_number) values
  ('44444444-4444-4444-4444-444444444444', '+580000000011');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('55555555-5555-5555-5555-555555555555',
   '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333');

do $$
declare
  conv_id uuid := '55555555-5555-5555-5555-555555555555';
  t0 timestamptz := now() - interval '2 hours';
  msg_id uuid;
  errores text := '';
  v_awaiting boolean;
  v_preview text;
  v_last_message_at timestamptz;
  v_reply_sender text;
begin
  -- -------------------------------------------------------------------------
  -- Paso 1 · el cliente escribe → awaiting_reply = true
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Hola, ¿tienen la Bera 200 disponible?', t0);

  select awaiting_reply into v_awaiting from public.conversations where id = conv_id;
  if v_awaiting is distinct from true then
    errores := errores || format(E'\n  - paso 1 (cliente escribe): awaiting_reply = %s, se esperaba true.', v_awaiting);
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 2 · nota interna de asesor → sigue true, y la preview sigue siendo
  -- la del cliente (la nota no es "visible")
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, is_internal_note, created_at)
  values (conv_id, 'outbound', 'agent', 'text', 'Ojo, este cliente ya compró antes', true, t0 + interval '5 minutes');

  select awaiting_reply, last_message_preview into v_awaiting, v_preview
  from public.conversations where id = conv_id;
  if v_awaiting is distinct from true then
    errores := errores || format(E'\n  - paso 2 (nota interna): awaiting_reply = %s, se esperaba true.', v_awaiting);
  end if;
  if v_preview <> 'Hola, ¿tienen la Bera 200 disponible?' then
    errores := errores || format(E'\n  - paso 2 (nota interna): last_message_preview cambió a "%s", una nota no es visible y no debía tocarla.', v_preview);
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 3 · evento de sistema → sigue true
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'outbound', 'system', 'system_event', 'JOSE RIERA se asignó esta conversación', t0 + interval '10 minutes');

  select awaiting_reply into v_awaiting from public.conversations where id = conv_id;
  if v_awaiting is distinct from true then
    errores := errores || format(E'\n  - paso 3 (evento de sistema): awaiting_reply = %s, se esperaba true.', v_awaiting);
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 4 · bienvenida automática → sigue true, pero last_message_at avanzó
  -- (sí es visible: el cliente la recibe, solo que no cuenta como respuesta)
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, is_auto_reply, whatsapp_status, created_at)
  values (conv_id, 'outbound', 'ai', 'template', 'Bienvenido a SBK Motorcycles', true, 'sent', t0 + interval '15 minutes');

  select awaiting_reply, last_message_at into v_awaiting, v_last_message_at
  from public.conversations where id = conv_id;
  if v_awaiting is distinct from true then
    errores := errores || format(E'\n  - paso 4 (bienvenida): awaiting_reply = %s, se esperaba true.', v_awaiting);
  end if;
  if v_last_message_at is distinct from t0 + interval '15 minutes' then
    errores := errores || E'\n  - paso 4 (bienvenida): last_message_at no avanzó con la plantilla, y sí debía (es visible).';
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 5 · salida de la IA rechazada por Meta → sigue true
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, created_at)
  values (conv_id, 'outbound', 'ai', 'text', 'La Bera 200 sí está disponible, cuesta...', 'failed', t0 + interval '20 minutes');

  select awaiting_reply into v_awaiting from public.conversations where id = conv_id;
  if v_awaiting is distinct from true then
    errores := errores || format(E'\n  - paso 5 (salida de IA rechazada por Meta): awaiting_reply = %s, se esperaba true.', v_awaiting);
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 6 · salida de la IA aceptada → false, last_reply_sender = 'ai'
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, created_at)
  values (conv_id, 'outbound', 'ai', 'text', 'La Bera 200 sí está disponible, cuesta 1.850$', 'sent', t0 + interval '25 minutes');

  select awaiting_reply, last_reply_sender into v_awaiting, v_reply_sender
  from public.conversations where id = conv_id;
  if v_awaiting is distinct from false then
    errores := errores || format(E'\n  - paso 6 (salida de IA aceptada): awaiting_reply = %s, se esperaba false.', v_awaiting);
  end if;
  if v_reply_sender is distinct from 'ai' then
    errores := errores || format(E'\n  - paso 6 (salida de IA aceptada): last_reply_sender = %s, se esperaba ''ai''.', v_reply_sender);
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 7 · el cliente vuelve a escribir → true otra vez
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Perfecto, ¿aceptan pago móvil?', t0 + interval '30 minutes');

  select awaiting_reply into v_awaiting from public.conversations where id = conv_id;
  if v_awaiting is distinct from true then
    errores := errores || format(E'\n  - paso 7 (cliente vuelve a escribir): awaiting_reply = %s, se esperaba true.', v_awaiting);
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 8 · el asesor responde (sent → false) y Meta la rechaza después
  -- (update a failed) → vuelve a true
  -- -------------------------------------------------------------------------
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, created_at)
  values (conv_id, 'outbound', 'agent', 'text', 'Sí, aceptamos pago móvil', 'sent', t0 + interval '35 minutes')
  returning id into msg_id;

  select awaiting_reply into v_awaiting from public.conversations where id = conv_id;
  if v_awaiting is distinct from false then
    errores := errores || format(E'\n  - paso 8a (respuesta de asesor sent): awaiting_reply = %s, se esperaba false.', v_awaiting);
  end if;

  update public.messages set whatsapp_status = 'failed' where id = msg_id;

  select awaiting_reply into v_awaiting from public.conversations where id = conv_id;
  if v_awaiting is distinct from true then
    errores := errores || format(E'\n  - paso 8b (Meta rechaza la respuesta del asesor): awaiting_reply = %s, se esperaba true — sin ninguna respuesta real vigente, la conversación tiene que volver a esperar.', v_awaiting);
  end if;

  -- -------------------------------------------------------------------------
  -- Paso 9 · insertar un traspaso con reason='escalada' no falla (el CHECK
  -- de conversation_handoffs.reason se amplió en esta misma migración)
  -- -------------------------------------------------------------------------
  begin
    insert into public.conversation_handoffs (conversation_id, to_kind, reason)
    values (conv_id, 'human', 'escalada');
  exception when check_violation then
    errores := errores || E'\n  - paso 9: insertar un traspaso con reason=''escalada'' violó el CHECK de conversation_handoffs.reason.';
  end;

  if errores <> '' then
    raise exception E'awaiting_reply / última respuesta real rotos:%', errores;
  end if;
end $$;

rollback;

\echo 'awaiting_reply.sql: todas las aserciones pasaron.'
