-- ===========================================================================
-- Un turno sin contenido legible deja rastro y las etapas congeladas se
-- limpian (T1, corrida "La IA ve lo que llega", 8/9/2026)
--
-- Migración bajo prueba: 20260908010000_traspaso_sin_contenido_legible.sql.
--
-- El caso real: la conversación cea69118-5d17-4f08-84c6-925755672b87 recibió
-- un audio sin texto previo, `loadHistory` descartaba toda fila sin
-- `content`, el turno salía por historial vacío SIN escribir traspaso -- el
-- reconciliador la reencoló 30 veces hasta que un asesor contestó a mano. El
-- código que cierra ese hueco (T4, misma corrida) va a llamar
-- `record_handoff(..., to_kind => 'unassigned', reason =>
-- 'sin_contenido_legible')`; esta migración amplía el CHECK de
-- `conversation_handoffs.reason` para admitirlo. Además, ese `return` salía
-- DESPUÉS de dejar `journey_stage = 'classifying'` sin limpiar: 17
-- conversaciones quedaron congeladas en `classifying`/`tool_running` sin
-- lock vigente (la más vieja del 27/8/2026), y la migración trae un backfill
-- que las limpia.
--
-- Casos 1 y 2 corren sobre una sola conversación, con `record_handoff()`
-- llamado directo (la base local conecta como `postgres`, superusuario: no
-- hace falta simular el rol `service_role` al que está concedida la
-- función). Casos 3 y 4 prueban el BACKFILL de la migración, no algo que
-- corra solo -- necesitan `\i` (metacomando de psql, no SQL) para reaplicar
-- la migración sobre datos sembrados después de que la base ya la corrió una
-- vez al construirse, igual que hace `ventana_24h.sql` con su caso 6. Por
-- eso este archivo tiene VARIOS bloques `do $$` en vez de uno solo: `\i` no
-- puede ir dentro de un bloque plpgsql. Los errores de todos los bloques se
-- acumulan en una tabla temporal y se revisan al final, una sola vez.
--
-- Corre en el job `migraciones` de CI. Transacción con rollback, no ensucia
-- la base.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- Un solo canal para las cuatro conversaciones de este archivo.
insert into public.whatsapp_channels (id, label, phone_number) values
  ('77777777-7777-7777-7777-777777777700', 'Canal de prueba traspaso_sin_contenido_legible', '+580000003000');

insert into public.contacts (id, phone_number) values
  ('77777777-7777-7777-7777-777777777701', '+580000003001'),
  ('77777777-7777-7777-7777-777777777703', '+580000003003'),
  ('77777777-7777-7777-7777-777777777705', '+580000003005'),
  ('77777777-7777-7777-7777-777777777707', '+580000003007');

-- Conversación para los casos 1 y 2 (record_handoff): sin journey_stage, no
-- le concierne al backfill.
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('77777777-7777-7777-7777-777777777702',
   '77777777-7777-7777-7777-777777777701',
   '77777777-7777-7777-7777-777777777700');

-- ---------------------------------------------------------------------------
-- Casos 1 y 2 · record_handoff() y el CHECK de conversation_handoffs.reason
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '77777777-7777-7777-7777-777777777702';
  v_id uuid;
  v_count integer;
begin
  -- Caso 1 · record_handoff acepta sin_contenido_legible
  begin
    select public.record_handoff(conv_id, 'unassigned', 'sin_contenido_legible') into v_id;
  exception when check_violation then
    insert into _errores(msg) values ('record_handoff acepta sin_contenido_legible: la llamada lanzó check_violation y no debía.');
  end;

  select count(*) into v_count
    from public.conversation_handoffs
    where id = v_id and to_kind = 'unassigned' and reason = 'sin_contenido_legible';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('record_handoff acepta sin_contenido_legible: no quedó la fila esperada en conversation_handoffs (id=%s, encontradas=%s).', v_id, v_count));
  end if;

  -- Caso 2 · record_handoff rechaza una razón inventada
  begin
    perform public.record_handoff(conv_id, 'unassigned', 'razon_inventada');
    insert into _errores(msg) values ('record_handoff rechaza una razón inventada: la llamada NO lanzó excepción y debía (check_violation).');
  exception
    when check_violation then
      null; -- esperado: el CHECK de conversation_handoffs.reason la frenó.
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Casos 3 y 4 · el backfill, sembrado ANTES de reaplicar la migración
--
-- Tres conversaciones con distinto estado de "congelada":
--   - ...704 (contact ...703): classifying, sin lock (ai_turn_lock_until
--     null) -- el caso más simple del bug real.
--   - ...706 (contact ...705): tool_running con active_tool puesto, lock ya
--     vencido (5 min atrás) -- lo que dejó un turno que murió a mitad de una
--     herramienta.
--   - ...708 (contact ...707): classifying con lock VIGENTE (1 min por
--     delante) -- simula un turno corriendo AHORA MISMO; el backfill no
--     debe tocarla, o le arrancaría journey_stage a un turno de verdad en
--     curso.
-- ---------------------------------------------------------------------------
insert into public.conversations
  (id, contact_id, whatsapp_channel_id, journey_stage, active_tool, ai_turn_lock_until)
values
  ('77777777-7777-7777-7777-777777777704',
   '77777777-7777-7777-7777-777777777703',
   '77777777-7777-7777-7777-777777777700',
   'classifying', null, null),
  ('77777777-7777-7777-7777-777777777706',
   '77777777-7777-7777-7777-777777777705',
   '77777777-7777-7777-7777-777777777700',
   'tool_running', 'buscarRepuesto', now() - interval '5 minutes'),
  ('77777777-7777-7777-7777-777777777708',
   '77777777-7777-7777-7777-777777777707',
   '77777777-7777-7777-7777-777777777700',
   'classifying', null, now() + interval '1 minute');

-- Reaplica la migración sobre los datos recién sembrados: demuestra el
-- backfill Y, de paso, la idempotencia del CHECK (drop/add del mismo
-- constraint, ya aplicado una vez al construir la base).
\i supabase/migrations/20260908010000_traspaso_sin_contenido_legible.sql

do $$
declare
  v_stage text;
  v_tool text;
begin
  -- Caso 3 · el backfill limpia un classifying sin lock
  select journey_stage, active_tool into v_stage, v_tool
    from public.conversations where id = '77777777-7777-7777-7777-777777777704';
  if v_stage is not null or v_tool is not null then
    insert into _errores(msg) values (format('el backfill limpia un classifying sin lock: journey_stage=%s, active_tool=%s, se esperaba null/null.', v_stage, v_tool));
  end if;

  -- Caso 3 (mismo criterio) · tool_running con lock vencido
  select journey_stage, active_tool into v_stage, v_tool
    from public.conversations where id = '77777777-7777-7777-7777-777777777706';
  if v_stage is not null or v_tool is not null then
    insert into _errores(msg) values (format('el backfill limpia un classifying sin lock: journey_stage=%s, active_tool=%s, se esperaba null/null (tool_running con ai_turn_lock_until vencido).', v_stage, v_tool));
  end if;

  -- Caso 4 · el backfill no toca un classifying con lock vigente
  select journey_stage, active_tool into v_stage, v_tool
    from public.conversations where id = '77777777-7777-7777-7777-777777777708';
  if v_stage is distinct from 'classifying' then
    insert into _errores(msg) values (format('el backfill no toca un classifying con lock vigente: journey_stage=%s, se esperaba que siguiera en classifying.', v_stage));
  end if;
  if v_tool is not null then
    insert into _errores(msg) values (format('el backfill no toca un classifying con lock vigente: active_tool=%s, se esperaba que siguiera null (no lo tocó nunca).', v_tool));
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
    raise exception E'traspaso_sin_contenido_legible.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'traspaso_sin_contenido_legible.sql: todas las aserciones pasaron.'
