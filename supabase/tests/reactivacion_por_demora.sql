-- ===========================================================================
-- Lo que la base hace cuando Seba REACTIVA la IA tras responder por demora
-- (29/9/2026, cambio de diseño pedido por el operador sobre la Entrega B:
-- "Si Seba va a responder a los 10 minutos porque ningún asesor respondió,
-- activa nuevamente la IA y que mande la respuesta, esto no debe colisionar").
--
-- Este test NO prueba una migración nueva: fija, contra la base, el
-- comportamiento de los triggers YA vigentes del que depende `runDelayTurn`
-- (`delay-turn.ts`) y `demora-cron.ts`:
--   - `handle_conversation_ai_resume` (20260916010000, BEFORE): sella
--     `ai_resume_cutoff_at` = `last_customer_message_at` SOLO al entrar al
--     estado "IA encendida y SIN asesor". Con asesor asignado NO sella.
--   - `handle_conversation_ownership_change` (20260917010000, AFTER): un
--     `ai_enabled` false -> true deja una fila `devuelto_a_ia` con
--     `created_by = 'system'` cuando no hay sesión (`service_role`, que es como
--     corre el turno por demora), y `to_kind` 'unassigned' sin asesor / 'human'
--     con asesor. `demora-cron.ts` reconoce ESA fila (system + posterior al
--     `responded_at` del episodio) para no darla por cierre de la escalada.
--   - `handle_agent_message_silences_ai` (20260917010000): el primer mensaje
--     REAL de un asesor apaga la IA otra vez y deja `silenciada_por_asesor`;
--     una nota interna de sistema (la que deja el turno por demora) no.
-- Si alguna de las tres cambia de comportamiento, este archivo se pone en rojo
-- ANTES de que la reactivación por demora deje a un cliente sin respuesta o a
-- Seba pisando a un asesor.
--
-- Mismo patrón que devolucion_a_la_ia.sql: transacción con rollback, `created_at`
-- explícitos y crecientes (dentro de una transacción `now()` es constante),
-- tabla temporal `_errores` y un solo `raise exception` al final. Una
-- conversación por caso (dos filas de la misma razón en la misma conversación
-- no se pueden desempatar por `created_at`).
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c9c9c9c9-0000-0000-0000-000000000001', 'agente-demora-ia@sbk.test', jsonb_build_object('display_name', 'Agente demora IA'));

insert into public.whatsapp_channels (id, label, phone_number) values
  ('c8c8c8c8-0000-0000-0000-000000000000', 'Canal de prueba reactivación por demora', '+580000007000');

insert into public.contacts (id, phone_number) values
  ('c7c7c7c7-0000-0000-0000-000000000001', '+580000007001'), -- caso 1 (sin asesor)
  ('c7c7c7c7-0000-0000-0000-000000000002', '+580000007002'), -- caso 2 (con asesor)
  ('c7c7c7c7-0000-0000-0000-000000000003', '+580000007003'); -- caso 3 (IA ya encendida)

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('c6c6c6c6-0000-0000-0000-000000000001', 'c7c7c7c7-0000-0000-0000-000000000001', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000002', 'c7c7c7c7-0000-0000-0000-000000000002', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000003', 'c7c7c7c7-0000-0000-0000-000000000003', 'c8c8c8c8-0000-0000-0000-000000000000');

-- ---------------------------------------------------------------------------
-- Caso 1 · SIN asesor: IA pausada, el cliente escribió hace 20 min y nadie
-- contestó; Seba responde (mensaje `ai` con is_auto_reply) y reactiva. El
-- sello queda en el mensaje que Seba acaba de contestar (un turno normal que
-- lo vuelva a ver se calla con `mensaje_previo_a_devolucion`), la fila es
-- `devuelto_a_ia` de sistema hacia 'unassigned', y un mensaje NUEVO del
-- cliente queda por delante del sello (Seba lo atiende normal).
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '20 minutes';
  t1 timestamptz := now() - interval '10 minutes';
  t2 timestamptz := now() - interval '1 minute';
  v_cutoff timestamptz;
  v_new_since boolean;
  v_ai boolean;
  v_row record;
  v_count integer;
begin
  update public.conversations set ai_enabled = false where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', '¿Tienen pastillas de freno?', t0);
  -- Lo que hace el turno por demora: la respuesta de Seba y su nota de sistema.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, is_auto_reply, created_at)
  values (conv_id, 'outbound', 'ai', 'text', 'Un asesor te atiende en breve.', true, t1);
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, is_internal_note, created_at)
  values (conv_id, 'outbound', 'system', 'system_event', 'Seba respondió por demora de 10 min', true, t1);

  -- La reactivación, sin sesión (service_role).
  update public.conversations set ai_enabled = true where id = conv_id and ai_enabled = false;

  select ai_resume_cutoff_at, new_since_ai_resume, ai_enabled into v_cutoff, v_new_since, v_ai
    from public.conversations where id = conv_id;
  if v_ai is distinct from true then
    insert into _errores(msg) values ('Caso 1 (sin asesor): ai_enabled no quedó en true.');
  end if;
  if v_cutoff is distinct from t0 then
    insert into _errores(msg) values (format('Caso 1 (sin asesor): ai_resume_cutoff_at = %s, se esperaba t0 (%s): el sello copia el mensaje ya contestado.', v_cutoff, t0));
  end if;
  if v_new_since is distinct from false then
    insert into _errores(msg) values (format('Caso 1 (sin asesor): new_since_ai_resume = %s, se esperaba false (el reconciliador no debe reencolar lo que Seba ya contestó).', v_new_since));
  end if;

  select * into v_row from public.conversation_handoffs where conversation_id = conv_id and reason = 'devuelto_a_ia';
  if v_row is null then
    insert into _errores(msg) values ('Caso 1 (sin asesor): no quedó la fila devuelto_a_ia.');
  else
    if v_row.created_by is distinct from 'system' then
      insert into _errores(msg) values (format('Caso 1 (sin asesor): created_by = %s, se esperaba ''system'' (sin sesión) -- así lo reconoce demora-cron.', v_row.created_by));
    end if;
    if v_row.to_kind is distinct from 'unassigned' then
      insert into _errores(msg) values (format('Caso 1 (sin asesor): to_kind = %s, se esperaba ''unassigned''.', v_row.to_kind));
    end if;
  end if;

  -- La bitácora tiene además la silenciada_por_asesor del montaje (apagar la
  -- IA con un UPDATE); la reactivación agrega EXACTAMENTE una fila más.
  select count(*) into v_count from public.conversation_handoffs
    where conversation_id = conv_id and reason <> 'silenciada_por_asesor';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (sin asesor): %s fila(s) de la reactivación en la bitácora, se esperaba 1 (solo devuelto_a_ia).', v_count));
  end if;

  -- Un mensaje NUEVO del cliente queda por delante del sello.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'y también cadenas', t2);
  select new_since_ai_resume into v_new_since from public.conversations where id = conv_id;
  if v_new_since is distinct from true then
    insert into _errores(msg) values (format('Caso 1 (sin asesor): new_since_ai_resume = %s tras un mensaje nuevo, se esperaba true (Seba tiene que atenderlo).', v_new_since));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · CON asesor asignado que nunca escribió: la reactivación NO sella
-- (el trigger BEFORE solo sella al entrar a "IA encendida y sin asesor"), la
-- fila es `devuelto_a_ia` de sistema hacia 'human' (mismo asesor), y el
-- PRIMER mensaje real del asesor apaga la IA de nuevo con
-- `silenciada_por_asesor` -- la regla "el asesor manda" sigue intacta. Una
-- nota interna de sistema NO la apaga.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000002';
  agent_id uuid := 'c9c9c9c9-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '20 minutes';
  t1 timestamptz := now() - interval '10 minutes';
  t2 timestamptz := now() - interval '5 minutes';
  t3 timestamptz := now() - interval '1 minute';
  v_cutoff timestamptz;
  v_ai boolean;
  v_row record;
  v_count integer;
begin
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', '¿Tienen pastillas de freno?', t0);
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, is_auto_reply, created_at)
  values (conv_id, 'outbound', 'ai', 'text', 'Un asesor te atiende en breve.', true, t1);

  update public.conversations set ai_enabled = true where id = conv_id and ai_enabled = false;

  select ai_resume_cutoff_at, ai_enabled into v_cutoff, v_ai from public.conversations where id = conv_id;
  if v_ai is distinct from true then
    insert into _errores(msg) values ('Caso 2 (con asesor): ai_enabled no quedó en true.');
  end if;
  if v_cutoff is not null then
    insert into _errores(msg) values (format('Caso 2 (con asesor): ai_resume_cutoff_at = %s, se esperaba null (con asesor asignado no sella).', v_cutoff));
  end if;

  select * into v_row from public.conversation_handoffs where conversation_id = conv_id and reason = 'devuelto_a_ia';
  if v_row is null then
    insert into _errores(msg) values ('Caso 2 (con asesor): no quedó la fila devuelto_a_ia.');
  else
    if v_row.created_by is distinct from 'system' then
      insert into _errores(msg) values (format('Caso 2 (con asesor): created_by = %s, se esperaba ''system''.', v_row.created_by));
    end if;
    if v_row.to_kind is distinct from 'human' or v_row.to_id is distinct from agent_id then
      insert into _errores(msg) values (format('Caso 2 (con asesor): to_kind/to_id = %s/%s, se esperaba human/%s.', v_row.to_kind, v_row.to_id, agent_id));
    end if;
  end if;

  -- La nota interna de sistema del turno por demora no apaga la IA.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, is_internal_note, created_at)
  values (conv_id, 'outbound', 'system', 'system_event', 'Seba reactivó la IA en este chat', true, t2);
  select ai_enabled into v_ai from public.conversations where id = conv_id;
  if v_ai is distinct from true then
    insert into _errores(msg) values ('Caso 2 (con asesor): la nota interna de sistema apagó la IA.');
  end if;

  -- El primer mensaje REAL del asesor sí la apaga y deja silenciada_por_asesor.
  insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, created_at)
  values (conv_id, 'outbound', 'agent', agent_id, 'text', 'Hola, ya te ayudo.', t3);
  select ai_enabled into v_ai from public.conversations where id = conv_id;
  if v_ai is distinct from false then
    insert into _errores(msg) values ('Caso 2 (con asesor): el mensaje real del asesor NO apagó la IA.');
  end if;
  select count(*) into v_count from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2 (con asesor): %s fila(s) silenciada_por_asesor, se esperaba 1.', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · la IA YA estaba encendida: el UPDATE condicionado
-- (`where ai_enabled = false`) no toca ninguna fila y no escribe nada extra.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000003';
  v_rows integer;
  v_count integer;
begin
  update public.conversations set ai_enabled = true where id = conv_id and ai_enabled = false;
  get diagnostics v_rows = row_count;
  if v_rows is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3 (IA ya encendida): el UPDATE tocó %s fila(s), se esperaban 0.', v_rows));
  end if;
  select count(*) into v_count from public.conversation_handoffs where conversation_id = conv_id;
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3 (IA ya encendida): %s fila(s) en la bitácora, se esperaban 0.', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Veredicto
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'reactivacion_por_demora.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'reactivacion_por_demora.sql: todas las aserciones pasaron.'
