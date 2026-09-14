-- ===========================================================================
-- Los cinco valores de intención y la cortesía tras una escalada quedan
-- admitidos en la base (Tarea 1, plan "La voz cercana y la espera visible",
-- 14/9/2026)
--
-- Migración bajo prueba: 20260914010000_intenciones_y_traspasos_completos.sql.
--
-- `agent_turns.intent`/`conversations.intent` nacieron con cuatro valores
-- (20260819040000_agent_backend.sql) y `classify.ts` (INTENT_VALUES) devuelve
-- cinco desde que existe `fuera_de_tema` ("El reloj dice la verdad",
-- 5/9/2026): cada turno fuera de tema fallaba el insert de `logTurn` y el
-- update de la intención en silencio. La Tarea 4 de esta misma corrida va a
-- llamar `record_handoff(..., reason => 'cortesia_tras_escalada')` cuando el
-- cliente cierra con una cortesía tras una escalada sin asesor todavía --
-- esta migración amplía el CHECK de `conversation_handoffs.reason` para
-- admitirlo.
--
-- Cuatro casos, mismo patrón que `traspaso_sin_contenido_legible.sql`: (1)
-- un `agent_turns` con intent='fuera_de_tema' se inserta, (2) un update de
-- `conversations.intent='fuera_de_tema'` pasa, (3) `record_handoff(...,
-- 'cortesia_tras_escalada')` deja fila, (4) un valor inventado sigue
-- rechazado en los tres CHECK. Todo en una transacción con rollback: no
-- ensucia la base. Corre en el job `migraciones` de CI.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

insert into public.whatsapp_channels (id, label, phone_number) values
  ('88888888-8888-8888-8888-888888888800', 'Canal de prueba intenciones_y_traspasos_completos', '+580000004000');

insert into public.contacts (id, phone_number) values
  ('88888888-8888-8888-8888-888888888801', '+580000004001');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('88888888-8888-8888-8888-888888888802',
   '88888888-8888-8888-8888-888888888801',
   '88888888-8888-8888-8888-888888888800');

-- ---------------------------------------------------------------------------
-- Caso 1 · agent_turns.intent admite 'fuera_de_tema'
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '88888888-8888-8888-8888-888888888802';
  v_id uuid;
  v_count integer;
begin
  begin
    insert into public.agent_turns (conversation_id, intent, action)
    values (conv_id, 'fuera_de_tema', 'answered')
    returning id into v_id;
  exception when check_violation then
    insert into _errores(msg) values ('agent_turns.intent acepta fuera_de_tema: el insert lanzó check_violation y no debía.');
  end;

  select count(*) into v_count
    from public.agent_turns
    where id = v_id and intent = 'fuera_de_tema';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('agent_turns.intent acepta fuera_de_tema: no quedó la fila esperada (id=%s, encontradas=%s).', v_id, v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · conversations.intent admite 'fuera_de_tema'
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '88888888-8888-8888-8888-888888888802';
  v_intent text;
begin
  begin
    update public.conversations set intent = 'fuera_de_tema' where id = conv_id;
  exception when check_violation then
    insert into _errores(msg) values ('conversations.intent acepta fuera_de_tema: el update lanzó check_violation y no debía.');
  end;

  select intent into v_intent from public.conversations where id = conv_id;
  if v_intent is distinct from 'fuera_de_tema' then
    insert into _errores(msg) values (format('conversations.intent acepta fuera_de_tema: quedó en %s, se esperaba fuera_de_tema.', v_intent));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · record_handoff() acepta 'cortesia_tras_escalada'
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '88888888-8888-8888-8888-888888888802';
  v_id uuid;
  v_count integer;
begin
  begin
    select public.record_handoff(conv_id, 'unassigned', 'cortesia_tras_escalada') into v_id;
  exception when check_violation then
    insert into _errores(msg) values ('record_handoff acepta cortesia_tras_escalada: la llamada lanzó check_violation y no debía.');
  end;

  select count(*) into v_count
    from public.conversation_handoffs
    where id = v_id and to_kind = 'unassigned' and reason = 'cortesia_tras_escalada';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('record_handoff acepta cortesia_tras_escalada: no quedó la fila esperada en conversation_handoffs (id=%s, encontradas=%s).', v_id, v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · un valor inventado sigue rechazado en los tres CHECK
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '88888888-8888-8888-8888-888888888802';
begin
  begin
    insert into public.agent_turns (conversation_id, intent, action)
    values (conv_id, 'razon_inventada', 'answered');
    insert into _errores(msg) values ('agent_turns.intent rechaza una intención inventada: el insert NO lanzó excepción y debía (check_violation).');
  exception
    when check_violation then
      null; -- esperado
  end;

  begin
    update public.conversations set intent = 'razon_inventada' where id = conv_id;
    insert into _errores(msg) values ('conversations.intent rechaza una intención inventada: el update NO lanzó excepción y debía (check_violation).');
  exception
    when check_violation then
      null; -- esperado
  end;

  begin
    perform public.record_handoff(conv_id, 'unassigned', 'razon_inventada');
    insert into _errores(msg) values ('conversation_handoffs.reason rechaza una razón inventada: la llamada NO lanzó excepción y debía (check_violation).');
  exception
    when check_violation then
      null; -- esperado
  end;
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
    raise exception E'intenciones_y_traspasos_completos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'intenciones_y_traspasos_completos.sql: todas las aserciones pasaron.'
