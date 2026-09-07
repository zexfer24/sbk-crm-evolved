-- ===========================================================================
-- La ventana de 24 h dice la verdad (T1, corrida "La ventana de 24 h dice
-- la verdad", 7/9/2026)
--
-- Migración bajo prueba: 20260907010000_ventana_24h_dice_la_verdad.sql.
--
-- El caso real: la conversación aa75ef33-38e8-4ff4-8422-7e7f49615795 mostraba
-- la caja de texto habilitada ("quedan 11 h") mientras Meta rechazaba todo
-- con 131047 (ventana cerrada). Dos candados nuevos sobre
-- `last_customer_message_at` (lcma), los dos en `handle_new_message()`
-- (camino INSERT -- la IA inserta sus fallos ya con whatsapp_status='failed')
-- y en `handle_message_status_change()` (camino UPDATE -- el asesor y el
-- callback de Meta):
--
--   Candado A -- un entrante `message_type='unsupported'` no mueve lcma (ni
--   unread_count), aunque sigue siendo visible en el chat.
--   Candado B -- un saliente rechazado con 131047 empuja lcma hacia atrás:
--   `least(lcma, created_at - 24h)`, solo si lcma ya existía (`least(null,
--   x)` devuelve `x`, no `null`) y solo si el fallo es posterior al último
--   mensaje real del cliente (protege contra un callback tardío).
--
-- Casos 1 a 5 y 7 a 9 corren sobre una sola conversación en orden
-- cronológico, con `created_at` explícitos y crecientes (dentro de una
-- transacción `now()` es constante, así que dos inserts con `default now()`
-- empatarían -- mismo motivo que documenta awaiting_reply.sql). El caso 6
-- prueba el BACKFILL de la migración, no el trigger en caliente: necesita
-- `\i` (metacomando de psql, no SQL) para reejecutar la migración sobre
-- datos sembrados después de que la base ya la corrió una vez al
-- construirse -- por eso este archivo tiene VARIOS bloques `do $$` en vez de
-- uno solo: `\i` no puede ir dentro de un bloque plpgsql. Los errores de
-- todos los bloques se acumulan en una tabla temporal y se revisan al final,
-- una sola vez.
--
-- Corre en el job `migraciones` de CI. Transacción con rollback, no ensucia
-- la base.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- Un solo canal para las tres conversaciones de este archivo (A: casos 1-5,
-- 7 y 9; B: caso 8; C: caso 6) -- el UNIQUE de conversations es
-- (contact_id, whatsapp_channel_id), así que compartir canal no choca.
insert into public.whatsapp_channels (id, label, phone_number) values
  ('66666666-6666-6666-6666-666666666600', 'Canal de prueba ventana_24h', '+580000002000');

insert into public.contacts (id, phone_number) values
  ('66666666-6666-6666-6666-666666666601', '+580000002001');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('66666666-6666-6666-6666-666666666602',
   '66666666-6666-6666-6666-666666666601',
   '66666666-6666-6666-6666-666666666600');

-- ---------------------------------------------------------------------------
-- Casos 1 a 5 (conversación A, en orden cronológico)
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '66666666-6666-6666-6666-666666666602';
  t0 timestamptz := now() - interval '3 hours';
  msg3_id uuid;
  msg4_id uuid;
  v_lcma timestamptz;
  v_unread integer;
  v_awaiting boolean;
  v_last_message_at timestamptz;
begin
  -- Caso 1 · inbound text abre la ventana
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Hola, ¿tienen la Bera 200 disponible?', t0);

  select last_customer_message_at, unread_count, awaiting_reply
    into v_lcma, v_unread, v_awaiting
    from public.conversations where id = conv_id;
  if v_lcma is distinct from t0 then
    insert into _errores(msg) values (format('caso 1 (inbound text abre la ventana): last_customer_message_at = %s, se esperaba t0 (%s).', v_lcma, t0));
  end if;
  if v_unread is distinct from 1 then
    insert into _errores(msg) values (format('caso 1 (inbound text abre la ventana): unread_count = %s, se esperaba 1.', v_unread));
  end if;
  if v_awaiting is distinct from true then
    insert into _errores(msg) values (format('caso 1 (inbound text abre la ventana): awaiting_reply = %s, se esperaba true.', v_awaiting));
  end if;

  -- Caso 2 · inbound unsupported no mueve la ventana (sigue visible: last_message_at avanza)
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, payload, created_at)
  values (conv_id, 'inbound', 'customer', 'unsupported', null, jsonb_build_object('type', 'video_note'), t0 + interval '5 minutes');

  select last_customer_message_at, unread_count, last_message_at
    into v_lcma, v_unread, v_last_message_at
    from public.conversations where id = conv_id;
  if v_lcma is distinct from t0 then
    insert into _errores(msg) values (format('caso 2 (inbound unsupported no mueve la ventana): last_customer_message_at = %s, se esperaba que siguiera en t0 (%s).', v_lcma, t0));
  end if;
  if v_unread is distinct from 1 then
    insert into _errores(msg) values (format('caso 2 (inbound unsupported no mueve la ventana): unread_count = %s, se esperaba que siguiera en 1.', v_unread));
  end if;
  if v_last_message_at is distinct from t0 + interval '5 minutes' then
    insert into _errores(msg) values (format('caso 2 (inbound unsupported no mueve la ventana): last_message_at = %s, se esperaba que avanzara a t0+5min (es visible aunque no cuente para la ventana).', v_last_message_at));
  end if;

  -- Caso 3 · fallo saliente 131047 cierra la ventana a created_at menos 24h
  -- (camino UPDATE: insert en "pending" -- whatsapp_status null, igual que
  -- api/messages/send/route.ts -- y luego un solo UPDATE con status + código,
  -- igual que ese mismo route y que el callback de Meta)
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, created_at)
  values (conv_id, 'outbound', 'ai', 'text', 'La Bera 200 sí está disponible, cuesta...', null, t0 + interval '10 minutes')
  returning id into msg3_id;

  update public.messages set whatsapp_status = 'failed', whatsapp_error_code = 131047 where id = msg3_id;

  select last_customer_message_at into v_lcma from public.conversations where id = conv_id;
  if v_lcma is distinct from (t0 + interval '10 minutes' - interval '24 hours') then
    insert into _errores(msg) values (format('caso 3 (fallo 131047 cierra la ventana, camino UPDATE): last_customer_message_at = %s, se esperaba t0+10min-24h (%s).', v_lcma, t0 + interval '10 minutes' - interval '24 hours'));
  end if;

  -- Caso 4 · fallo con otro código no toca la ventana (131026)
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, created_at)
  values (conv_id, 'outbound', 'agent', 'text', 'Dame un momento que verifico stock', null, t0 + interval '15 minutes')
  returning id into msg4_id;

  update public.messages set whatsapp_status = 'failed', whatsapp_error_code = 131026 where id = msg4_id;

  select last_customer_message_at into v_lcma from public.conversations where id = conv_id;
  if v_lcma is distinct from (t0 + interval '10 minutes' - interval '24 hours') then
    insert into _errores(msg) values (format('caso 4 (fallo con otro código no toca la ventana): last_customer_message_at = %s, se esperaba que siguiera igual que el caso 3 (%s).', v_lcma, t0 + interval '10 minutes' - interval '24 hours'));
  end if;

  -- Caso 5 · tras el cierre por 131047 un inbound text la reabre
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Perfecto, ¿aceptan pago móvil?', t0 + interval '20 minutes');

  select last_customer_message_at, unread_count into v_lcma, v_unread from public.conversations where id = conv_id;
  if v_lcma is distinct from (t0 + interval '20 minutes') then
    insert into _errores(msg) values (format('caso 5 (un inbound text reabre la ventana): last_customer_message_at = %s, se esperaba t0+20min (%s).', v_lcma, t0 + interval '20 minutes'));
  end if;
  if v_unread is distinct from 2 then
    insert into _errores(msg) values (format('caso 5 (un inbound text reabre la ventana): unread_count = %s, se esperaba 2.', v_unread));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · el backfill reclasifica el texto histórico y recalcula
--
-- Simula el estado que dejó producción ANTES de esta migración: un inbound
-- real del cliente, seguido de un inbound que en su momento se guardó como
-- message_type='text' con la frase fija histórica -- era, de hecho, un
-- `unsupported` -- que infló last_customer_message_at al timestamp de esa
-- fila (el bug que describe la cabecera de la migración), y más tarde un
-- saliente rechazado por Meta con 131047 que el trigger de ENTONCES (sin
-- candado B) nunca llegó a mirar.
--
-- `on_message_inserted` se desactiva solo para estos tres inserts: la base
-- ya corrió esta migración una vez al construirse, así que el trigger YA
-- ARREGLADO aplicaría los candados A/B en caliente y la conversación nunca
-- llegaría a verse como la dejó la producción real. `last_customer_message_at`
-- se fija a mano al valor inflado (con el trigger desactivado, ningún insert
-- de arriba lo tocó) -- es lo único que el backfill de la migración tiene
-- que corregir, y es lo que este caso pone a prueba con `\i`.
-- ---------------------------------------------------------------------------
insert into public.contacts (id, phone_number) values
  ('66666666-6666-6666-6666-666666666605', '+580000002005');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('66666666-6666-6666-6666-666666666606',
   '66666666-6666-6666-6666-666666666605',
   '66666666-6666-6666-6666-666666666600');

alter table public.messages disable trigger on_message_inserted;

insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('66666666-6666-6666-6666-666666666606', 'inbound', 'customer', 'text',
   'Buenas, ¿tienen cascos talla M?',
   now() - interval '10 days');

insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('66666666-6666-6666-6666-666666666606', 'inbound', 'customer', 'text',
   'El cliente envió un mensaje que el CRM todavía no sabe mostrar. Se puede ver desde WhatsApp en el teléfono.',
   now() - interval '10 days' + interval '1 hour');

insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, whatsapp_error_code, created_at) values
  ('66666666-6666-6666-6666-666666666606', 'outbound', 'ai', 'text',
   'Sí, tenemos cascos talla M disponibles',
   'failed', 131047,
   now() - interval '10 days' + interval '30 hours');

alter table public.messages enable trigger on_message_inserted;

update public.conversations
set last_customer_message_at = now() - interval '10 days' + interval '1 hour',
    unread_count = 2
where id = '66666666-6666-6666-6666-666666666606';

-- Reaplica la migración sobre los datos recién sembrados: demuestra el
-- backfill Y, de paso, la idempotencia de `create or replace function`
-- (ya corrió una vez al construir la base).
\i supabase/migrations/20260907010000_ventana_24h_dice_la_verdad.sql

do $$
declare
  conv_id uuid := '66666666-6666-6666-6666-666666666606';
  t_real timestamptz := now() - interval '10 days';
  v_tipo text;
  v_lcma timestamptz;
begin
  select message_type into v_tipo from public.messages
    where conversation_id = conv_id
      and content like 'El cliente envió un mensaje que el CRM todavía no sabe mostrar%';
  if v_tipo is distinct from 'unsupported' then
    insert into _errores(msg) values (format('caso 6 (backfill): el texto histórico quedó con message_type = %s, se esperaba unsupported.', v_tipo));
  end if;

  select last_customer_message_at into v_lcma from public.conversations where id = conv_id;
  if v_lcma is distinct from t_real then
    insert into _errores(msg) values (format('caso 6 (backfill): last_customer_message_at = %s, se esperaba %s (el inbound real, paso b) -- si quedó antes, el paso (c) lo empeoró de más.', v_lcma, t_real));
  end if;
end $$;

\echo '--- caso 6: evidencia legible para el reporte ---'
select
  c.id as conversation_id,
  c.last_customer_message_at,
  m.message_type,
  left(m.content, 60) as content,
  m.whatsapp_status,
  m.whatsapp_error_code,
  m.created_at
from public.conversations c
join public.messages m on m.conversation_id = c.id
where c.id = '66666666-6666-6666-6666-666666666606'
order by m.created_at;

-- ---------------------------------------------------------------------------
-- Casos 7 a 9 (conversación A -- sigue en t0 -- y conversación B para el 8)
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '66666666-6666-6666-6666-666666666602';
  conv_b_id uuid := '66666666-6666-6666-6666-666666666604';
  t0 timestamptz := now() - interval '3 hours';
  v_lcma timestamptz;
  v_awaiting boolean;
begin
  -- Caso 7 · fallo 131047 insertado ya fallido cierra la ventana (camino
  -- INSERT: como manda sendAgentText/sendAgentMedia en src/lib/ai/send.ts,
  -- el mensaje nace YA con whatsapp_status='failed' y el código puesto, sin
  -- UPDATE posterior)
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, whatsapp_error_code, created_at)
  values (conv_id, 'outbound', 'ai', 'text', 'Ya te confirmo la disponibilidad', 'failed', 131047, t0 + interval '25 minutes');

  select last_customer_message_at into v_lcma from public.conversations where id = conv_id;
  if v_lcma is distinct from (t0 + interval '25 minutes' - interval '24 hours') then
    insert into _errores(msg) values (format('caso 7 (131047 insertado ya fallido, camino INSERT): last_customer_message_at = %s, se esperaba t0+25min-24h (%s).', v_lcma, t0 + interval '25 minutes' - interval '24 hours'));
  end if;

  -- Caso 8 · fallo 131047 sin mensaje del cliente deja la ventana en null
  -- (conversación aparte: nunca recibió un inbound)
  insert into public.contacts (id, phone_number) values
    ('66666666-6666-6666-6666-666666666603', '+580000002003');
  insert into public.conversations (id, contact_id, whatsapp_channel_id) values
    (conv_b_id, '66666666-6666-6666-6666-666666666603', '66666666-6666-6666-6666-666666666600');

  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, whatsapp_error_code, created_at)
  values (conv_b_id, 'outbound', 'ai', 'text', 'Bienvenido, ¿en qué te ayudo?', 'failed', 131047, now());

  select last_customer_message_at, awaiting_reply into v_lcma, v_awaiting from public.conversations where id = conv_b_id;
  if v_lcma is distinct from null then
    insert into _errores(msg) values (format('caso 8 (131047 sin mensaje del cliente): last_customer_message_at = %s, se esperaba null (least(null, x) no debía inventar una fecha).', v_lcma));
  end if;
  if v_awaiting is distinct from false then
    insert into _errores(msg) values (format('caso 8 (131047 sin mensaje del cliente): awaiting_reply = %s, se esperaba false (nadie escribió, no hay nada que esperar).', v_awaiting));
  end if;

  -- Caso 9 · fallo 131047 anterior al último mensaje del cliente no toca la
  -- ventana (callback tardío): primero el cliente escribe de nuevo, y RECIÉN
  -- después llega un fallo sobre un mensaje con created_at ANTERIOR a esa
  -- escritura -- la guarda new.created_at > last_customer_message_at lo frena.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', '¿Y para cuándo la entrega?', t0 + interval '30 minutes');

  select last_customer_message_at into v_lcma from public.conversations where id = conv_id;
  if v_lcma is distinct from (t0 + interval '30 minutes') then
    insert into _errores(msg) values (format('caso 9 (preparación, cliente vuelve a escribir): last_customer_message_at = %s, se esperaba t0+30min (%s) antes del callback tardío.', v_lcma, t0 + interval '30 minutes'));
  end if;

  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, whatsapp_error_code, created_at)
  values (conv_id, 'outbound', 'ai', 'text', 'Confirmando el pedido anterior', 'failed', 131047, t0 + interval '28 minutes');

  select last_customer_message_at into v_lcma from public.conversations where id = conv_id;
  if v_lcma is distinct from (t0 + interval '30 minutes') then
    insert into _errores(msg) values (format('caso 9 (callback tardío no toca la ventana): last_customer_message_at = %s, se esperaba que siguiera en t0+30min (%s) -- el fallo es de un mensaje anterior al último real del cliente.', v_lcma, t0 + interval '30 minutes'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Veredicto: si algún bloque insertó una fila en _errores, se listan todas
-- de una sola vez.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'ventana_24h.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'ventana_24h.sql: todas las aserciones pasaron.'
