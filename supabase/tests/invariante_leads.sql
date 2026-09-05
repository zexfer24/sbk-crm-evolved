-- ===========================================================================
-- La invariante "ningún lead invisible", verificada contra la base
--
-- La regla que gobierna la reforma (ver CLAUDE.md) dice:
--
--   Toda conversación con `awaiting_reply` tiene exactamente un dueño y una
--   hora límite de respuesta. Ninguna salida del sistema deja una
--   conversación esperando sin dueño ni fecha.
--
-- Su forma final —`owner_kind` y `response_due_at` como columnas de
-- `conversations`— nace en la Etapa 2 del plan, así que HOY esa consulta no
-- se puede escribir: las columnas no existen. Lo que se verifica acá es su
-- proxy de la Etapa 1, que es la bitácora `conversation_handoffs`, y en
-- concreto la única pregunta que la reforma necesita contestar bien:
-- **cuántas conversaciones siguen esperando y quedaron sin dueño**.
--
-- POR QUÉ ESTE ARCHIVO EXISTE, Y NO ALCANZA CON LOS TESTS DE VITEST
--
-- Ese número tiene DOS implementaciones, en dos lenguajes, y las dos están
-- en producción: `unassigned_waiting_count()` en SQL (la que informa
-- /api/health, el KPI que decide si la Etapa 2 arranca) e `isUnassignedLead`
-- en TypeScript (la que arma la píldora "Sin dueño" de la bandeja). Si se
-- separan, el tablero y la bandeja dicen cosas distintas sobre el mismo
-- hecho — y el precedente de este repo es que eso pasa: la ventana de 24 h
-- tiene su propio archivo de contrato (`src/lib/ventana-24h-contrato.test.ts`)
-- justamente porque se había separado.
--
-- Los casos de acá abajo son los MISMOS que afirma
-- `src/lib/invariante-leads-contrato.test.ts` sobre la implementación en
-- TypeScript, con los mismos nombres. Si alguien cambia una de las dos
-- definiciones, uno de los dos archivos se pone rojo.
--
-- EL CASO QUE JUSTIFICA TODO ESTO (caso 2 más abajo)
--
-- La forma natural de escribir este conteo desde el cliente —"la
-- conversación tiene AL MENOS una fila unassigned"— está mal, y está mal de
-- una manera que no se nota hasta que es tarde: el reconciliador escribe un
-- `reabierto` encima de todo lo que rescata, así que con esa definición
-- TODA conversación recuperada seguiría contando como perdida para siempre.
-- El KPI solo sabría subir. Se descubrió midiendo contra una base real el
-- 30/8/2026, no leyendo el código.
--
-- Corre en el job `migraciones` de CI, contra la base reconstruida desde
-- cero. Todo pasa dentro de una transacción con `rollback` al final: no
-- depende de los seeds ni deja nada atrás.
-- ===========================================================================

begin;

-- Datos propios, con ids fijos para poder afirmar sobre ellos. `awaiting_reply`
-- es una columna GENERADA (20260825050000, redefinida por 20260905010000):
-- vale true cuando hay mensaje del cliente y nadie dio una respuesta real
-- después. Hasta el 4/9/2026 se inducía con `last_message_at <=
-- last_customer_message_at` (cualquier mensaje apagaba "esperando"); desde
-- 20260905010000 (T0.1, 5/9/2026) SOLO la apaga `last_reply_at`, así que acá
-- se induce dejando `last_reply_at`/`last_reply_sender` en null (nadie
-- respondió) salvo en el caso 5, donde se simula la respuesta real del
-- asesor fijando esas dos columnas.
-- Un contacto por caso: `conversations` tiene único (contact_id,
-- whatsapp_channel_id), así que ocho conversaciones sobre el mismo canal
-- necesitan ocho contactos distintos. El caso 6 (T2.1, 5/9/2026) suma
-- `cerrada_por_asesor`/`reabierta_por_cliente` a la lista de razones que
-- puede escribir esta bitácora: nace de 20260905030000. El caso 7 (anexo A1,
-- 5/9/2026) es la despedida de la IA al escalar sin asesores: sale con
-- `is_auto_reply = true` (misma marca que la bienvenida automática, T0.1) y
-- por eso NO apaga `awaiting_reply` aunque el cliente la haya recibido. El
-- caso 8 (anexo A2, 5/9/2026) es el mismo cierre/reapertura del caso 6 pero
-- con un asesor YA asignado al chat: el webhook la reabre con destino
-- `human` en vez de `unassigned`, así que NO cuenta -- tiene dueño.
insert into public.contacts (id, phone_number) values
  ('11111111-1111-1111-1111-111111111101', '+580000000001'),
  ('11111111-1111-1111-1111-111111111102', '+580000000002'),
  ('11111111-1111-1111-1111-111111111103', '+580000000003'),
  ('11111111-1111-1111-1111-111111111104', '+580000000004'),
  ('11111111-1111-1111-1111-111111111105', '+580000000005'),
  ('11111111-1111-1111-1111-111111111106', '+580000000006'),
  ('11111111-1111-1111-1111-111111111107', '+580000000007'),
  ('11111111-1111-1111-1111-111111111108', '+580000000008');

insert into public.whatsapp_channels (id, label, phone_number) values
  ('22222222-2222-2222-2222-222222222222', 'Canal de prueba', '+580000000000');

insert into public.conversations
  (id, contact_id, whatsapp_channel_id, last_customer_message_at, last_message_at,
   last_reply_at, last_reply_sender)
values
  -- caso 1 · soltada y nunca recuperada → CUENTA
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours',
   null, null),
  -- caso 2 · soltada y DESPUÉS rescatada por el reconciliador → NO cuenta
  ('aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111102', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours',
   null, null),
  -- caso 3 · soltada y después tomada por una persona → NO cuenta
  ('aaaaaaaa-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111103', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours',
   null, null),
  -- caso 4 · sin ninguna fila de bitácora → NO cuenta (nunca se soltó)
  ('aaaaaaaa-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111104', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours',
   null, null),
  -- caso 5 · soltada, pero el asesor YA contestó → NO cuenta: no espera a nadie.
  -- last_reply_at/last_reply_sender simulan la respuesta real (T0.1,
  -- 20260905010000): sin ellos, `last_message_at` más nuevo que
  -- `last_customer_message_at` ya no alcanza para apagar awaiting_reply.
  ('aaaaaaaa-0000-0000-0000-000000000005',
   '11111111-1111-1111-1111-111111111105', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '1 minute',
   now() - interval '1 minute', 'agent'),
  -- caso 6 · un asesor la había cerrado y el cliente volvió a escribir con
  -- la IA apagada (T2.1, 5/9/2026): el webhook la reabre sola y deja
  -- `reabierta_por_cliente` con destino `unassigned` (ver
  -- webhooks/whatsapp/route.ts) — sigue esperando y quedó sin dueño →
  -- CUENTA, aunque haya pasado por `closed` en el medio.
  ('aaaaaaaa-0000-0000-0000-000000000006',
   '11111111-1111-1111-1111-111111111106', '22222222-2222-2222-2222-222222222222',
   now() - interval '10 minutes', now() - interval '10 minutes',
   null, null);

-- Caso 7 · escalada sin asesores y la IA se despidió con `is_auto_reply`
-- (anexo A1, 5/9/2026): CUENTA. Insert aparte porque necesita dos columnas
-- que los otros seis casos no tocan —`ai_enabled = false` y
-- `journey_stage = 'assigned'`, tal como los deja `escalate.ts` cuando
-- escala sin candidato— y a propósito SIN `last_customer_message_at`/
-- `last_message_at`/`last_reply_at` escritos a mano: los deja el trigger
-- `handle_new_message` a partir de los dos mensajes que se insertan más
-- abajo, para que sea la regla real la que decida, no un valor fabricado.
insert into public.conversations
  (id, contact_id, whatsapp_channel_id, ai_enabled, journey_stage)
values
  ('aaaaaaaa-0000-0000-0000-000000000007',
   '11111111-1111-1111-1111-111111111107', '22222222-2222-2222-2222-222222222222',
   false, 'assigned');

-- Los dos mensajes del caso 7, en orden: el entrante del cliente (fija
-- `last_customer_message_at` vía el trigger) y después el saliente de la IA
-- con `is_auto_reply = true` (visible, pero el trigger lo excluye de
-- "respuesta real": no toca `last_reply_at`/`last_reply_sender`, que se
-- quedan en null). Si `is_auto_reply` no existiera o valiera `false` acá,
-- este insert apagaría `awaiting_reply` solo y el caso dejaría de contar —
-- que es exactamente el bug que corrige el anexo A1.
insert into public.messages
  (conversation_id, direction, sender_type, message_type, content, is_auto_reply, whatsapp_status, created_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000007', 'inbound', 'customer', 'text',
   'Hola, ¿tienen el kit de arrastre para una Bera SBR 200?', false, null,
   now() - interval '10 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000007', 'outbound', 'ai', 'text',
   'Ya dejé tu caso registrado para que lo revise un asesor. En cuanto haya alguien disponible te escriben por acá.',
   true, 'sent', now() - interval '9 minutes');

-- Caso 8 · cerrada, el cliente volvió y la conversación tenía asesor (anexo
-- A2, 5/9/2026): NO CUENTA. Hace falta un asesor de verdad para la FK de
-- `assigned_agent_id` (references public.agents, que a su vez referencia
-- auth.users) -- mismo patrón mínimo que usa `pins.sql`: insertar en
-- auth.users dispara handle_new_agent() (security definer) y crea la fila
-- espejo en public.agents. `awaiting_reply` queda en `true` (esperando) con
-- `last_reply_at` en null, igual que los casos 1-6, porque acá no importa
-- decidir por el trigger: lo que se prueba es que un último traspaso
-- `human` con dueño no cuenta como sin dueño, sin importar el `closed` de
-- en medio.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c9c9c9c9-0000-0000-0000-000000000001', 'asesor-caso8@sbk.test', jsonb_build_object('display_name', 'Asesor (caso 8)'));

insert into public.conversations
  (id, contact_id, whatsapp_channel_id, assigned_agent_id, ai_enabled,
   last_customer_message_at, last_message_at, last_reply_at, last_reply_sender)
values
  ('aaaaaaaa-0000-0000-0000-000000000008',
   '11111111-1111-1111-1111-111111111108', '22222222-2222-2222-2222-222222222222',
   'c9c9c9c9-0000-0000-0000-000000000001', false,
   now() - interval '10 minutes', now() - interval '10 minutes',
   null, null);

-- Los traspasos. El `created_at` explícito y separado en el tiempo es
-- deliberado: lo que decide es la fila MÁS RECIENTE, no el orden de inserción.
insert into public.conversation_handoffs (conversation_id, to_kind, to_id, reason, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'unassigned', null, 'agente_no_puede_correr', now() - interval '90 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000002', 'unassigned', null, 'abandonado',  now() - interval '90 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'ai',         null, 'reabierto',   now() - interval '30 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000003', 'unassigned', null, 'fuera_de_ventana', now() - interval '90 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'human',      null, 'reclamado',        now() - interval '30 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000005', 'unassigned', null, 'entrega_fallida', now() - interval '90 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000006', 'closed',     null, 'cerrada_por_asesor',  now() - interval '3 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'unassigned', null, 'reabierta_por_cliente', now() - interval '10 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000007', 'unassigned', null, 'escalada_sin_asesor', now() - interval '9 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000008', 'closed', null, 'cerrada_por_asesor', now() - interval '3 hours'),
  ('aaaaaaaa-0000-0000-0000-000000000008', 'human', 'c9c9c9c9-0000-0000-0000-000000000001', 'reabierta_por_cliente', now() - interval '10 minutes');

do $$
declare
  esperado integer := 3;  -- el caso 1, el caso 6 y el caso 7
  obtenido integer;
  errores text := '';
  fila record;
begin
  select public.unassigned_waiting_count() into obtenido;

  if obtenido <> esperado then
    errores := errores || format(
      E'\n  - unassigned_waiting_count() devolvió %s y debía devolver %s.', obtenido, esperado);
  end if;

  -- Caso 6, explícito y con nombre propio (T2.1, 5/9/2026): pasar por
  -- `closed` en el medio no debe blindar a una conversación de contar como
  -- sin dueño. Si alguien filtrara unassigned_waiting_count() por
  -- `status <> 'closed'` en vez de mirar solo el último traspaso, esta
  -- fila seguiría contando bien -- pero si alguien mirara el status ACTUAL
  -- en vez del último traspaso para decidir "sin dueño", este es el caso
  -- que lo delata.
  select count(*)::integer into obtenido
  from public.conversations c
  where c.id = 'aaaaaaaa-0000-0000-0000-000000000006'
    and c.awaiting_reply
    and (
      select h.to_kind from public.conversation_handoffs h
      where h.conversation_id = c.id
      order by h.created_at desc, h.id desc limit 1
    ) = 'unassigned';

  if obtenido <> 1 then
    errores := errores ||
      E'\n  - la conversación cerrada y luego reabierta por el cliente (reabierta_por_cliente) no cuenta como sin dueño.';
  end if;

  -- Caso 7, explícito y con nombre propio (anexo A1, 5/9/2026): la despedida
  -- de la IA al escalar sin asesores lleva `is_auto_reply = true`, así que el
  -- trigger no la cuenta como respuesta real y `awaiting_reply` se queda en
  -- `true`. Si alguien volviera a guardar ese mensaje sin la marca —o el
  -- trigger dejara de respetarla— esta conversación se apagaría sola y este
  -- bloque es el que lo delata.
  select count(*)::integer into obtenido
  from public.conversations c
  where c.id = 'aaaaaaaa-0000-0000-0000-000000000007'
    and c.awaiting_reply
    and (
      select h.to_kind from public.conversation_handoffs h
      where h.conversation_id = c.id
      order by h.created_at desc, h.id desc limit 1
    ) = 'unassigned';

  if obtenido <> 1 then
    errores := errores ||
      E'\n  - la escalación sin asesores (is_auto_reply en la despedida de la IA) no cuenta como sin dueño.';
  end if;

  -- Caso 2 explícito y con nombre propio: es el que se le escapa a la
  -- definición ingenua ("tiene alguna fila unassigned"), y el que haría que
  -- el KPI solo supiera subir. Si este bloque falla, alguien reescribió el
  -- conteo con esa definición.
  select count(*)::integer into obtenido
  from public.conversations c
  where c.id = 'aaaaaaaa-0000-0000-0000-000000000002'
    and c.awaiting_reply
    and (
      select h.to_kind from public.conversation_handoffs h
      where h.conversation_id = c.id
      order by h.created_at desc, h.id desc limit 1
    ) = 'unassigned';

  if obtenido <> 0 then
    errores := errores ||
      E'\n  - la conversación rescatada por el reconciliador (un `reabierto` encima de un `unassigned`) sigue contando como sin dueño: el KPI solo sabría subir.';
  end if;

  -- Caso 8, explícito y con nombre propio (anexo A2, 5/9/2026): la misma
  -- historia del caso 6 (cerrada por un asesor y reabierta por el cliente),
  -- pero acá el chat SÍ tenía asesor asignado -- el webhook deja
  -- `reabierta_por_cliente` con destino `human`, no `unassigned`. Sin la
  -- corrección de A2 este caso contaría igual que el 6, porque el destino
  -- se decidía solo por `ai_enabled` y nunca miraba `assigned_agent_id`.
  select count(*)::integer into obtenido
  from public.conversations c
  where c.id = 'aaaaaaaa-0000-0000-0000-000000000008'
    and c.awaiting_reply
    and (
      select h.to_kind from public.conversation_handoffs h
      where h.conversation_id = c.id
      order by h.created_at desc, h.id desc limit 1
    ) = 'unassigned';

  if obtenido <> 0 then
    errores := errores ||
      E'\n  - la conversación cerrada, reabierta por el cliente y CON asesor asignado cuenta como sin dueño (debía quedar `human`).';
  end if;

  -- La invariante propiamente dicha, en su forma de Etapa 1: toda
  -- conversación que el sistema soltó y que sigue esperando tiene que ser
  -- VISIBLE — es decir, contable. Una que quedara `unassigned` sin aparecer
  -- en el conteo sería exactamente el lead invisible que la reforma existe
  -- para que no haya.
  for fila in
    select c.id
    from public.conversations c
    where c.awaiting_reply
      and (
        select h.to_kind from public.conversation_handoffs h
        where h.conversation_id = c.id
        order by h.created_at desc, h.id desc limit 1
      ) = 'unassigned'
  loop
    if fila.id not in (
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000006',
      'aaaaaaaa-0000-0000-0000-000000000007'
    ) then
      errores := errores || format(
        E'\n  - la conversación %s quedó sin dueño y el conteo no la ve.', fila.id);
    end if;
  end loop;

  if errores <> '' then
    raise exception E'Invariante "ningún lead invisible" rota:%', errores;
  end if;
end $$;

rollback;

\echo 'invariante_leads.sql: todas las aserciones pasaron.'
