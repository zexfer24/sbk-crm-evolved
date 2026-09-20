-- ===========================================================================
-- T0 · "Seba atiende el mostrador" (docs/planes/2026-09-17-seba-atiende-el-
-- mostrador.md, APROBADO 18/9/2026)
--
-- Migración bajo prueba: 20260917010000_seba_y_escalada_viva.sql.
--
-- Mismo patrón que devolucion_a_la_ia.sql: transacción con rollback, tabla
-- temporal `_errores`, un solo `raise exception` al final con todo lo
-- acumulado, una conversación por caso.
--
-- Nueve casos, en el orden del texto de la tarea T0 (más el caso 9, sumado
-- el 19/9/2026 por la tarea T10 del plan "Seba sale sin pisar a nadie" —
-- decisión D-A: `assignToMe`/`intervene` de `mutations.ts` apagan a Seba al
-- tomar un chat a mano):
--   1 y 7 comparten conversación: la MISMA escalada simulada se verifica
--     desde dos ángulos (no deja fila `reclamado`; no sella
--     `ai_resume_cutoff_at`), así que separarlas en dos conversaciones solo
--     habría duplicado el montaje sin probar nada distinto.
--   2: el mismo UPDATE que el caso 1, pero con sesión de un asesor real —
--     sí deja `reclamado`.
--   3: el mensaje real de un asesor apaga la IA (requisito 6 del cliente).
--   4: una nota interna NO apaga.
--   5: un mensaje `ai` o `system` NO apaga (dos sub-casos, misma
--     conversación).
--   6: la pausa manual (sin escalar, sin asesor) también deja rastro.
--   8: el contrato del backfill de `welcome_sent_at` — se prueba re-
--      ejecutando la MISMA sentencia de la migración sobre datos sembrados
--      en esta transacción, no el UPDATE ya corrido en la construcción de
--      la base (misma técnica que el caso 6 de `ventana_24h.sql` y el caso
--      6 de `preview_en_espanol.sql`, sin necesitar `\i` porque acá no hay
--      DDL que reaplicar, solo la sentencia de datos).
--   9 (T10, 19/9/2026): `assignToMe`/`intervene` hacen DOS UPDATE en serie
--      con la MISMA sesión real de un asesor — primero `assigned_agent_id`,
--      después `ai_enabled = false`. Deja las DOS filas: `reclamado` (mismo
--      mecanismo que el caso 2) y `silenciada_por_asesor` (mismo mecanismo
--      que el caso 3, pero disparada por un UPDATE de `mutations.ts`, no
--      por el trigger de mensajes de la sección 4 de la migración). Ninguna
--      espuria, ninguna faltante — el caso SQL de que un UPDATE conjunto de
--      las dos columnas se hubiera comido las dos, contra la invariante
--      "ningún lead invisible".
--
-- Agentes de prueba (auth.users, dispara handle_new_agent()): A es el
-- asesor "de utilería" para los casos que solo necesitan un asesor
-- cualquiera; B es exclusivo del caso 2 (sesión real que reclama el caso),
-- para que su `created_by='user'` no se confunda con ningún otro caso.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c9c9c9c9-0000-0000-0000-000000000001', 'agente-a-seba@sbk.test', jsonb_build_object('display_name', 'Agente A (Seba)')),
  ('c9c9c9c9-0000-0000-0000-000000000002', 'agente-b-seba@sbk.test', jsonb_build_object('display_name', 'Agente B (Seba)'));

insert into public.whatsapp_channels (id, label, phone_number) values
  ('c8c8c8c8-0000-0000-0000-000000000000', 'Canal de prueba Seba y escalada viva', '+580000007000');

-- Nueve contactos/conversaciones: 1 (casos 1+7), 2 (caso 2), 3 (caso 3),
-- 4 (caso 4), 5 (caso 5), 6 (caso 6), 7 y 8 (caso 8a/8b, backfill),
-- 9 (caso 9, T10 — assignToMe/intervene).
insert into public.contacts (id, phone_number) values
  ('c7c7c7c7-0000-0000-0000-000000000001', '+580000007001'),
  ('c7c7c7c7-0000-0000-0000-000000000002', '+580000007002'),
  ('c7c7c7c7-0000-0000-0000-000000000003', '+580000007003'),
  ('c7c7c7c7-0000-0000-0000-000000000004', '+580000007004'),
  ('c7c7c7c7-0000-0000-0000-000000000005', '+580000007005'),
  ('c7c7c7c7-0000-0000-0000-000000000006', '+580000007006'),
  ('c7c7c7c7-0000-0000-0000-000000000007', '+580000007007'),
  ('c7c7c7c7-0000-0000-0000-000000000008', '+580000007008'),
  ('c7c7c7c7-0000-0000-0000-000000000009', '+580000007009');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('c6c6c6c6-0000-0000-0000-000000000001', 'c7c7c7c7-0000-0000-0000-000000000001', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000002', 'c7c7c7c7-0000-0000-0000-000000000002', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000003', 'c7c7c7c7-0000-0000-0000-000000000003', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000004', 'c7c7c7c7-0000-0000-0000-000000000004', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000005', 'c7c7c7c7-0000-0000-0000-000000000005', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000006', 'c7c7c7c7-0000-0000-0000-000000000006', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000007', 'c7c7c7c7-0000-0000-0000-000000000007', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000008', 'c7c7c7c7-0000-0000-0000-000000000008', 'c8c8c8c8-0000-0000-0000-000000000000'),
  ('c6c6c6c6-0000-0000-0000-000000000009', 'c7c7c7c7-0000-0000-0000-000000000009', 'c8c8c8c8-0000-0000-0000-000000000000');

-- ---------------------------------------------------------------------------
-- Casos 1 y 7 · escalada simulada COMO LA HARÁ T4 (sin implementar todavía):
-- UPDATE que toca SOLO assigned_agent_id, ai_enabled sigue true, sin sesión
-- (equivalente a service_role, auth.uid() null). Hallazgo 1: no debe dejar
-- ninguna fila reclamado (mutación de abajo demuestra que sin el
-- `auth.uid() is not null` esto se rompe). Hallazgo del sello: al no ENTRAR
-- al estado "IA encendida y sin asesor" (sigue encendida, pero ahora CON
-- asesor), ai_resume_cutoff_at sigue sin sellar.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000001';
  agent_a uuid := 'c9c9c9c9-0000-0000-0000-000000000001';
  v_count integer;
  v_cutoff timestamptz;
begin
  update public.conversations
  set assigned_agent_id = agent_a
  where id = conv_id;

  select count(*) into v_count
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('Caso 1 (escalada simulada sin sesión): %s fila(s) reclamado, se esperaban 0 (auth.uid() debe ser null sin sesión).', v_count));
  end if;

  select ai_resume_cutoff_at into v_cutoff from public.conversations where id = conv_id;
  if v_cutoff is not null then
    insert into _errores(msg) values (format('Caso 7 (escalada simulada con IA encendida): ai_resume_cutoff_at = %s, se esperaba null (sigue encendida, ahora con asesor -- no entra al estado "sin asesor").', v_cutoff));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · el MISMO UPDATE del caso 1, pero con sesión de un asesor real
-- (B, que reclama el caso él mismo): sí deja una fila reclamado, con
-- created_by='user'.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000002';
  agent_b uuid := 'c9c9c9c9-0000-0000-0000-000000000002';
  v_count integer;
  v_created_by text;
  v_to_kind text;
begin
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'c9c9c9c9-0000-0000-0000-000000000002';

  update public.conversations
  set assigned_agent_id = agent_b
  where id = conv_id;

  -- `set local` vive hasta el fin de la transacción -- resetear acá para
  -- que los casos siguientes no hereden esta sesión (mismo hallazgo que
  -- documenta devolucion_a_la_ia.sql, caso 11a).
  reset role;
  reset "request.jwt.claim.sub";

  select count(*) into v_count
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2 (reclamado con sesión): %s fila(s) reclamado, se esperaba 1.', v_count));
  end if;

  select created_by, to_kind into v_created_by, v_to_kind
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_created_by is distinct from 'user' then
    insert into _errores(msg) values (format('Caso 2 (reclamado con sesión): created_by = %s, se esperaba ''user''.', v_created_by));
  end if;
  if v_to_kind is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 2 (reclamado con sesión): to_kind = %s, se esperaba ''human''.', v_to_kind));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · el primer mensaje REAL de un asesor asignado apaga la IA
-- (requisito 6 del cliente) y deja silenciada_por_asesor con to_kind
-- 'human'.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000003';
  agent_a uuid := 'c9c9c9c9-0000-0000-0000-000000000001';
  v_ai_enabled boolean;
  v_count integer;
  v_to_kind text;
begin
  update public.conversations set assigned_agent_id = agent_a where id = conv_id;

  insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, is_internal_note, message_type, content, whatsapp_status)
  values (conv_id, 'outbound', 'agent', agent_a, false, 'text', 'Ya te ayudo, dame un minuto', 'sent');

  select ai_enabled into v_ai_enabled from public.conversations where id = conv_id;
  if v_ai_enabled is distinct from false then
    insert into _errores(msg) values (format('Caso 3 (mensaje real de asesor): ai_enabled = %s, se esperaba false.', v_ai_enabled));
  end if;

  select count(*) into v_count
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 3 (mensaje real de asesor): %s fila(s) silenciada_por_asesor, se esperaba 1.', v_count));
  end if;

  select to_kind into v_to_kind
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_to_kind is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 3 (mensaje real de asesor): to_kind = %s, se esperaba ''human''.', v_to_kind));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · una NOTA INTERNA de un asesor no apaga la IA -- el WHEN del
-- trigger exige `not is_internal_note`.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000004';
  agent_a uuid := 'c9c9c9c9-0000-0000-0000-000000000001';
  v_ai_enabled boolean;
  v_count integer;
begin
  insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, is_internal_note, message_type, content)
  values (conv_id, 'outbound', 'agent', agent_a, true, 'text', 'Nota interna: el cliente pidió cambio de talla');

  select ai_enabled into v_ai_enabled from public.conversations where id = conv_id;
  if v_ai_enabled is distinct from true then
    insert into _errores(msg) values (format('Caso 4 (nota interna): ai_enabled = %s, se esperaba true (una nota interna no apaga la IA).', v_ai_enabled));
  end if;

  select count(*) into v_count
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('Caso 4 (nota interna): %s fila(s) silenciada_por_asesor, se esperaban 0.', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · un mensaje `ai` (la propia IA respondiendo) o `system` (un
-- evento) no apagan nada -- el WHEN exige `sender_type = 'agent'`.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000005';
  v_ai_enabled boolean;
  v_count integer;
begin
  insert into public.messages (conversation_id, direction, sender_type, is_internal_note, message_type, content)
  values (conv_id, 'outbound', 'ai', false, 'text', 'Con gusto, ¿en qué más te ayudo?');

  select ai_enabled into v_ai_enabled from public.conversations where id = conv_id;
  if v_ai_enabled is distinct from true then
    insert into _errores(msg) values (format('Caso 5a (mensaje ai): ai_enabled = %s, se esperaba true.', v_ai_enabled));
  end if;

  insert into public.messages (conversation_id, direction, sender_type, is_internal_note, message_type, content)
  values (conv_id, 'outbound', 'system', false, 'system_event', 'IA escaló a un asesor. Motivo: confirmar_inventario.');

  select ai_enabled into v_ai_enabled from public.conversations where id = conv_id;
  if v_ai_enabled is distinct from true then
    insert into _errores(msg) values (format('Caso 5b (mensaje system): ai_enabled = %s, se esperaba true.', v_ai_enabled));
  end if;

  select count(*) into v_count
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('Caso 5 (mensajes ai/system): %s fila(s) silenciada_por_asesor, se esperaban 0.', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · pausa manual (setAiEnabled(false) de mutations.ts, sin asesor
-- asignado): deja silenciada_por_asesor con to_kind 'unassigned' -- el
-- cliente sigue esperando a una PERSONA, no a la IA que alguien acaba de
-- silenciar.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000006';
  v_count integer;
  v_to_kind text;
begin
  update public.conversations set ai_enabled = false where id = conv_id;

  select count(*) into v_count
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 6 (pausa manual): %s fila(s) silenciada_por_asesor, se esperaba 1.', v_count));
  end if;

  select to_kind into v_to_kind
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_to_kind is distinct from 'unassigned' then
    insert into _errores(msg) values (format('Caso 6 (pausa manual): to_kind = %s, se esperaba ''unassigned''.', v_to_kind));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 8 · contrato del backfill de welcome_sent_at. No se puede probar el
-- UPDATE que ya corrió al construir la base (no queda estado "antes" que
-- comparar), así que se siembra el estado y se reejecuta la MISMA
-- sentencia de la migración dentro de esta transacción.
--   8a: has_reply=true, welcome_sent_at=null -- queda sellada con
--       last_reply_at (que va ANTES que last_message_at en el COALESCE).
--   8b: has_reply=false -- sigue en null.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_a uuid := 'c6c6c6c6-0000-0000-0000-000000000007';
  conv_b uuid := 'c6c6c6c6-0000-0000-0000-000000000008';
  t_reply timestamptz := now() - interval '3 hours';
  t_message timestamptz := now() - interval '2 hours';
  v_welcome_a timestamptz;
  v_welcome_b timestamptz;
begin
  update public.conversations
  set has_reply = true, last_reply_at = t_reply, last_message_at = t_message, welcome_sent_at = null
  where id = conv_a;

  -- conv_b se deja tal cual nace (has_reply=false, welcome_sent_at=null por
  -- default): es justo el caso que el backfill NO debe tocar.

  -- La MISMA sentencia de la sección 1 de 20260917010000_seba_y_escalada_viva.sql.
  update public.conversations
  set welcome_sent_at = coalesce(last_reply_at, last_message_at, created_at)
  where welcome_sent_at is null and has_reply;

  select welcome_sent_at into v_welcome_a from public.conversations where id = conv_a;
  if v_welcome_a is distinct from t_reply then
    insert into _errores(msg) values (format('Caso 8a (backfill, has_reply=true): welcome_sent_at = %s, se esperaba t_reply (%s).', v_welcome_a, t_reply));
  end if;

  select welcome_sent_at into v_welcome_b from public.conversations where id = conv_b;
  if v_welcome_b is not null then
    insert into _errores(msg) values (format('Caso 8b (backfill, has_reply=false): welcome_sent_at = %s, se esperaba null.', v_welcome_b));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 9 · T10, plan "Seba sale sin pisar a nadie" (19/9/2026, decisión
-- D-A): `assignToMe`/`intervene` (mutations.ts) hacen DOS UPDATE en serie,
-- con la MISMA sesión real de un asesor -- primero `assigned_agent_id`,
-- después `ai_enabled = false`. El primero deja `reclamado` (mismo
-- mecanismo que el caso 2 de arriba: sesión real, ai_enabled no cambió en
-- ESE UPDATE) y el segundo deja `silenciada_por_asesor` (mismo mecanismo
-- que el caso 3: ai_enabled pasó de true a false, assigned_agent_id no
-- cambió en ESE UPDATE) -- las DOS filas, ninguna espuria y ninguna
-- faltante. Es justo el caso que un UPDATE conjunto de las dos columnas
-- habría dejado sin ninguna fila, contra la invariante "ningún lead
-- invisible".
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000009';
  agent_a uuid := 'c9c9c9c9-0000-0000-0000-000000000001';
  v_count_reclamado integer;
  v_count_silenciada integer;
  v_to_kind_reclamado text;
  v_to_kind_silenciada text;
  v_created_by_reclamado text;
  v_created_by_silenciada text;
begin
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'c9c9c9c9-0000-0000-0000-000000000001';

  -- Primer UPDATE: assigned_agent_id, igual que assignToMe/intervene.
  update public.conversations
  set assigned_agent_id = agent_a
  where id = conv_id;

  -- Segundo UPDATE, EN SERIE (nunca en el mismo UPDATE que el de arriba):
  -- ai_enabled = false, igual que silenceAiForManualTakeover en mutations.ts.
  update public.conversations
  set ai_enabled = false
  where id = conv_id;

  -- `set local` vive hasta el fin de la transacción -- resetear acá para
  -- que el veredicto de más abajo no herede esta sesión.
  reset role;
  reset "request.jwt.claim.sub";

  select count(*) into v_count_reclamado
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_count_reclamado is distinct from 1 then
    insert into _errores(msg) values (format('Caso 9 (assignToMe/intervene, dos UPDATE en serie): %s fila(s) reclamado, se esperaba 1.', v_count_reclamado));
  end if;

  select count(*) into v_count_silenciada
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_count_silenciada is distinct from 1 then
    insert into _errores(msg) values (format('Caso 9 (assignToMe/intervene, dos UPDATE en serie): %s fila(s) silenciada_por_asesor, se esperaba 1.', v_count_silenciada));
  end if;

  select to_kind, created_by into v_to_kind_reclamado, v_created_by_reclamado
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_to_kind_reclamado is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 9 (reclamado): to_kind = %s, se esperaba ''human''.', v_to_kind_reclamado));
  end if;
  if v_created_by_reclamado is distinct from 'user' then
    insert into _errores(msg) values (format('Caso 9 (reclamado): created_by = %s, se esperaba ''user''.', v_created_by_reclamado));
  end if;

  select to_kind, created_by into v_to_kind_silenciada, v_created_by_silenciada
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'silenciada_por_asesor';
  if v_to_kind_silenciada is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 9 (silenciada_por_asesor): to_kind = %s, se esperaba ''human'' (queda asignada).', v_to_kind_silenciada));
  end if;
  if v_created_by_silenciada is distinct from 'user' then
    insert into _errores(msg) values (format('Caso 9 (silenciada_por_asesor): created_by = %s, se esperaba ''user''.', v_created_by_silenciada));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 10 · el CHECK admite `fuera_de_tema_repetido` ("El resguardo antes
-- del push", 20/9/2026, tarea C6) y sigue rechazando una razón inventada.
-- Sin el valor en el CHECK, el `recordHandoff` de la segunda insistencia
-- fuera de tema fallaría en silencio contra la base real -- la misma trampa
-- de `fuera_de_tema` del 14/9/2026, invisible para los tests de TypeScript
-- (usan fakes). Reusa la conversación del caso 6.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'c6c6c6c6-0000-0000-0000-000000000006';
  v_rechazada boolean := false;
begin
  begin
    insert into public.conversation_handoffs (conversation_id, from_kind, to_kind, reason, created_by)
    values (conv_id, 'ai', 'unassigned', 'fuera_de_tema_repetido', 'system');
  exception when check_violation then
    insert into _errores(msg) values ('Caso 10: el CHECK rechazó fuera_de_tema_repetido.');
  end;

  begin
    insert into public.conversation_handoffs (conversation_id, from_kind, to_kind, reason, created_by)
    values (conv_id, 'ai', 'unassigned', 'razon_que_no_existe', 'system');
  exception when check_violation then
    v_rechazada := true;
  end;
  if not v_rechazada then
    insert into _errores(msg) values ('Caso 10: el CHECK aceptó una razón inventada.');
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
    raise exception E'seba_y_escalada_viva.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'seba_y_escalada_viva.sql: todas las aserciones pasaron.'
