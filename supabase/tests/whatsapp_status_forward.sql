-- ===========================================================================
-- El doble check no retrocede: 'played' es más avanzado que 'read'
--
-- T3.2 del plan "La bandeja que no pierde" (5/9/2026): WhatsApp manda
-- whatsapp_status="played" para las notas de voz que el cliente reprodujo.
-- keep_whatsapp_status_moving_forward() (20260822110000) descarta cualquier
-- UPDATE que retroceda el estado; whatsapp_status_rank() (redefinida en
-- 20260905050000) tiene que rankear 'played' por ENCIMA de 'read' -- si
-- quedara empatado o por debajo, un "leído" tardío de Meta pisaría un
-- "reproducido" que el asesor ya había visto en el chat, y el doble check
-- retrocedería en pantalla.
--
-- Corre en el job `migraciones` de CI, contra la base reconstruida desde
-- cero. Transacción con rollback, no ensucia la base.
-- ===========================================================================

begin;

insert into public.contacts (id, phone_number) values
  ('33333333-3333-3333-3333-333333333301', '+580000001001');

insert into public.whatsapp_channels (id, label, phone_number) values
  ('33333333-3333-3333-3333-333333333300', 'Canal de prueba (played)', '+580000001000');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('33333333-3333-3333-3333-333333333302',
   '33333333-3333-3333-3333-333333333301',
   '33333333-3333-3333-3333-333333333300');

insert into public.messages
  (id, conversation_id, direction, sender_type, message_type, whatsapp_status)
values
  ('33333333-3333-3333-3333-333333333303',
   '33333333-3333-3333-3333-333333333302',
   'outbound', 'agent', 'audio', 'sent');

do $$
declare
  estado text;
  errores text := '';
begin
  -- Avanza normalmente: sent -> delivered -> read -> played.
  update public.messages set whatsapp_status = 'delivered'
    where id = '33333333-3333-3333-3333-333333333303';
  update public.messages set whatsapp_status = 'read'
    where id = '33333333-3333-3333-3333-333333333303';
  update public.messages set whatsapp_status = 'played'
    where id = '33333333-3333-3333-3333-333333333303';

  select whatsapp_status into estado from public.messages
    where id = '33333333-3333-3333-3333-333333333303';
  if estado <> 'played' then
    errores := errores || format(
      E'\n  - tras avanzar sent->delivered->read->played, la fila quedó en %s.', estado);
  end if;

  -- Un 'read' tardío (Meta no garantiza el orden de entrega de los webhooks
  -- de estado) no puede retroceder sobre 'played'.
  update public.messages set whatsapp_status = 'read'
    where id = '33333333-3333-3333-3333-333333333303';

  select whatsapp_status into estado from public.messages
    where id = '33333333-3333-3333-3333-333333333303';
  if estado <> 'played' then
    errores := errores || format(
      E'\n  - un "read" tardío pisó "played": la fila quedó en %s en vez de played.', estado);
  end if;

  -- 'failed' es la excepción explícita del trigger: no es un paso del
  -- recorrido sino su final, y siempre debe poder pisar lo que haya.
  update public.messages set whatsapp_status = 'failed'
    where id = '33333333-3333-3333-3333-333333333303';

  select whatsapp_status into estado from public.messages
    where id = '33333333-3333-3333-3333-333333333303';
  if estado <> 'failed' then
    errores := errores || format(
      E'\n  - "failed" no pudo pisar "played": la fila quedó en %s.', estado);
  end if;

  if errores <> '' then
    raise exception E'whatsapp_status_forward.sql roto:%', errores;
  end if;
end $$;

rollback;

\echo 'whatsapp_status_forward.sql: todas las aserciones pasaron.'
