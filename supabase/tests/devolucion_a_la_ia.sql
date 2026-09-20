-- ===========================================================================
-- El sello de devolución (Tarea 1, "La IA no vuelve a pedir lo que ya
-- pidió" -- revisión del 16/9/2026)
--
-- Migración bajo prueba: 20260916010000_devolucion_a_la_ia.sql.
--
-- Mismo patrón que awaiting_reply.sql/pins.sql: transacción con rollback,
-- `created_at` explícitos y crecientes (dentro de una misma transacción
-- `now()` es constante, así que dos inserts sucesivos con `default now()`
-- empatarían y el `>` del predicado de new_since_ai_resume no podría
-- distinguir "antes" de "después"), tabla temporal `_errores` y un solo
-- `raise exception` al final con todo lo acumulado.
--
-- Una conversación POR CASO que deja fila en conversation_handoffs: los dos
-- triggers de la migración escriben con `created_at default now()`
-- (constante dentro de la transacción) y `id` es un `gen_random_uuid()` sin
-- orden cronológico, así que dos filas de la MISMA razón en la MISMA
-- conversación no se pueden desempatar por ninguna columna de forma
-- fiable -- mismo defecto que detectó la primera versión de
-- awaiting_reply.sql/pins.sql con inserts por `default now()`, aplicado acá
-- a la bitácora en vez de a los mensajes. Compartir conversación solo entre
-- casos que NO dejan fila (el 1 y el 9, que se verifican por ausencia).
--
-- Los estados iniciales "ya escalada" (ai_enabled=false, con o sin
-- assigned_agent_id) se siembran con el INSERT de conversations, no con un
-- UPDATE previo: un INSERT no dispara los triggers de esta migración (son
-- BEFORE/AFTER UPDATE), así que no hay que descartar filas de bitácora del
-- montaje antes de medir el caso de verdad.
--
-- Agentes de prueba (auth.users, dispara handle_new_agent()) hacen falta
-- para los casos que asignan/desasignan un asesor y para el caso de
-- created_by='user' (mismo patrón mínimo que pins.sql). Un tercero (C) se
-- sumó en la corrección post-revisión del 16/9/2026 para los casos de
-- `reclamado` que necesitan distinguir "quién ya tenía el caso" de "quién
-- se lo saca".
--
-- Corre en el job `migraciones` de CI, en el mismo paso que
-- permisos_funciones.sql/invariante_leads.sql/awaiting_reply.sql.
--
-- Corrección del 18/9/2026 (T0 del plan "Seba atiende el mostrador",
-- docs/planes/2026-09-17-seba-atiende-el-mostrador.md): la migración
-- 20260917010000 le agrega a la rama `reclamado` de
-- `handle_conversation_ownership_change()` la condición `auth.uid() is not
-- null` (su hallazgo 1: sin esa guarda, la escalada de una tarea futura de
-- ese plan -- que va a cambiar SOLO `assigned_agent_id`, con
-- `service_role`, sin sesión -- dejaría una fila `reclamado` espuria antes
-- de su propia fila `escalada`). Los casos 13, 14 y 15 de acá abajo (los
-- de `reclamado`, sumados en la corrección post-revisión del 16/9/2026)
-- simulaban al asesor que reclama SIN ninguna sesión, porque ese día
-- `auth.uid()` todavía no importaba para esa rama -- se les agregó `set
-- local role authenticated` + `set local "request.jwt.claim.sub"` (mismo
-- patrón que el caso 11a) para seguir representando lo que pasa de verdad:
-- `assignToMe`/`intervene` siempre corren con la sesión del asesor que
-- reclama. Sin este ajuste los tres casos se ponen en rojo apenas se aplica
-- 20260917010000 -- verificado corriendo este archivo contra la base local
-- con esa migración ya aplicada.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- Tres agentes de prueba: A para los casos que solo necesitan "un asesor
-- cualquiera" (1 a 10), B exclusivo del caso 11 (created_by) para que su
-- sub-caso 'user' no se mezcle con ningún handoff de los demás casos. C es
-- nuevo (corrección post-revisión, 16/9/2026) para los casos de `reclamado`
-- que necesitan un SEGUNDO asesor distinto del que ya tiene el caso -- si
-- reusara A o B, el "de quién se lo saca" no se distinguiría del "quién ya
-- lo tenía" al leer el test.
insert into auth.users (id, email, raw_user_meta_data) values
  ('b9b9b9b9-0000-0000-0000-000000000001', 'agente-a-devolucion@sbk.test', jsonb_build_object('display_name', 'Agente A (devolución)')),
  ('b9b9b9b9-0000-0000-0000-000000000002', 'agente-b-devolucion@sbk.test', jsonb_build_object('display_name', 'Agente B (devolución)')),
  ('b9b9b9b9-0000-0000-0000-000000000003', 'agente-c-devolucion@sbk.test', jsonb_build_object('display_name', 'Agente C (devolución)'));

insert into public.whatsapp_channels (id, label, phone_number) values
  ('b8b8b8b8-0000-0000-0000-000000000000', 'Canal de prueba devolución a la IA', '+580000006000');

-- Dieciocho conversaciones propias, una por caso (el 12 -- permisos -- no
-- necesita ninguna). Los casos 13-16 son la corrección post-revisión del
-- 16/9/2026 (`/code-review high`): `reclamado` (13, 14, 15) y la rama
-- `closed` de `v_to_kind` (16). El caso 17 se sumó el 20/9/2026 ("El
-- resguardo antes del push", tarea M3).
insert into public.contacts (id, phone_number) values
  ('b7b7b7b7-0000-0000-0000-000000000001', '+580000006001'), -- caso 1
  ('b7b7b7b7-0000-0000-0000-000000000002', '+580000006002'), -- caso 2
  ('b7b7b7b7-0000-0000-0000-000000000003', '+580000006003'), -- caso 3
  ('b7b7b7b7-0000-0000-0000-000000000004', '+580000006004'), -- caso 4
  ('b7b7b7b7-0000-0000-0000-000000000005', '+580000006005'), -- caso 5
  ('b7b7b7b7-0000-0000-0000-000000000006', '+580000006006'), -- caso 6a
  ('b7b7b7b7-0000-0000-0000-000000000007', '+580000006007'), -- caso 6b (latencia)
  ('b7b7b7b7-0000-0000-0000-000000000008', '+580000006008'), -- caso 7 (unsupported)
  ('b7b7b7b7-0000-0000-0000-000000000009', '+580000006009'), -- caso 8 (sin nada pendiente)
  ('b7b7b7b7-0000-0000-0000-000000000010', '+580000006010'), -- caso 9 (update ajeno)
  ('b7b7b7b7-0000-0000-0000-000000000011', '+580000006011'), -- caso 10 (segunda devolución)
  ('b7b7b7b7-0000-0000-0000-000000000012', '+580000006012'), -- caso 11a (created_by user)
  ('b7b7b7b7-0000-0000-0000-000000000013', '+580000006013'), -- caso 11b (created_by system)
  ('b7b7b7b7-0000-0000-0000-000000000014', '+580000006014'), -- caso 13 (reclamado desde unassigned)
  ('b7b7b7b7-0000-0000-0000-000000000015', '+580000006015'), -- caso 14 (reclamado con IA encendida)
  ('b7b7b7b7-0000-0000-0000-000000000016', '+580000006016'), -- caso 15 (reclamado: reasignar X -> Y)
  ('b7b7b7b7-0000-0000-0000-000000000017', '+580000006017'), -- caso 16 (cerrada, desasignar -> closed)
  ('b7b7b7b7-0000-0000-0000-000000000018', '+580000006018'); -- caso 17 (reclamado con ai_enabled cambiando a la vez)

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('b6b6b6b6-0000-0000-0000-000000000001', 'b7b7b7b7-0000-0000-0000-000000000001', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000002', 'b7b7b7b7-0000-0000-0000-000000000002', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000003', 'b7b7b7b7-0000-0000-0000-000000000003', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000004', 'b7b7b7b7-0000-0000-0000-000000000004', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000005', 'b7b7b7b7-0000-0000-0000-000000000005', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000006', 'b7b7b7b7-0000-0000-0000-000000000006', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000007', 'b7b7b7b7-0000-0000-0000-000000000007', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000008', 'b7b7b7b7-0000-0000-0000-000000000008', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000009', 'b7b7b7b7-0000-0000-0000-000000000009', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000010', 'b7b7b7b7-0000-0000-0000-000000000010', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000011', 'b7b7b7b7-0000-0000-0000-000000000011', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000012', 'b7b7b7b7-0000-0000-0000-000000000012', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000013', 'b7b7b7b7-0000-0000-0000-000000000013', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000014', 'b7b7b7b7-0000-0000-0000-000000000014', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000015', 'b7b7b7b7-0000-0000-0000-000000000015', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000016', 'b7b7b7b7-0000-0000-0000-000000000016', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000018', 'b7b7b7b7-0000-0000-0000-000000000018', 'b8b8b8b8-0000-0000-0000-000000000000'),
  ('b6b6b6b6-0000-0000-0000-000000000017', 'b7b7b7b7-0000-0000-0000-000000000017', 'b8b8b8b8-0000-0000-0000-000000000000');

-- ---------------------------------------------------------------------------
-- Caso 1 · escalada simulada (ai_enabled=false + asignar asesor en un solo
-- UPDATE, como hace escalate.ts): SALE del estado "la IA gobierna sin
-- asesor", no ENTRA -- no sella, no escribe filas en la bitácora.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000001';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  v_cutoff timestamptz;
  v_count integer;
begin
  update public.conversations
  set ai_enabled = false, assigned_agent_id = agent_id
  where id = conv_id;

  select ai_resume_cutoff_at into v_cutoff from public.conversations where id = conv_id;
  if v_cutoff is not null then
    insert into _errores(msg) values (format('Caso 1 (escalada simulada): ai_resume_cutoff_at = %s, se esperaba null (una escalada sale del estado, no entra).', v_cutoff));
  end if;

  select count(*) into v_count from public.conversation_handoffs where conversation_id = conv_id;
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('Caso 1 (escalada simulada): %s fila(s) en conversation_handoffs, se esperaban 0.', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · desasignar y luego reactivar, con el mensaje de la escalada
-- todavía sin responder: el sello queda igual al último mensaje del cliente
-- y new_since_ai_resume en false (nada nuevo llegó); dos filas a
-- 'unassigned' (el cliente sigue esperando a una PERSONA, no a la IA que
-- acaba de recuperar el chat).
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000002';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '2 hours';
  v_cutoff timestamptz;
  v_new_since boolean;
  v_count integer;
  v_to_kind text;
begin
  -- Estado inicial ya escalado: ai_enabled=false, asignada a A.
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;
  -- El mensaje que motivó la escalada, todavía sin ninguna respuesta real.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  -- Paso A: desasignar.
  update public.conversations set assigned_agent_id = null where id = conv_id;
  -- Paso B: reactivar.
  update public.conversations set ai_enabled = true where id = conv_id;

  select ai_resume_cutoff_at, new_since_ai_resume into v_cutoff, v_new_since
    from public.conversations where id = conv_id;

  if v_cutoff is distinct from t0 then
    insert into _errores(msg) values (format('Caso 2 (desasignar→reactivar): ai_resume_cutoff_at = %s, se esperaba t0 (%s).', v_cutoff, t0));
  end if;
  if v_new_since is distinct from false then
    insert into _errores(msg) values (format('Caso 2 (desasignar→reactivar): new_since_ai_resume = %s, se esperaba false (el mensaje pendiente es el mismo que motivó la escalada).', v_new_since));
  end if;

  select count(*) into v_count
    from public.conversation_handoffs
    where conversation_id = conv_id and to_kind = 'unassigned';
  if v_count is distinct from 2 then
    insert into _errores(msg) values (format('Caso 2 (desasignar→reactivar): %s fila(s) con to_kind unassigned, se esperaban 2 (desasignada_por_asesor + devuelto_a_ia).', v_count));
  end if;

  select count(*) into v_count from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'desasignada_por_asesor';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2 (desasignar→reactivar): %s fila(s) desasignada_por_asesor, se esperaba 1.', v_count));
  end if;

  select count(*) into v_count from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'devuelto_a_ia';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2 (desasignar→reactivar): %s fila(s) devuelto_a_ia, se esperaba 1.', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · reactivar y luego desasignar (orden inverso al caso 2): el sello
-- NO se mueve al reactivar (sigue asignada, no entra al estado "sin
-- asesor") -- se mueve recién al desasignar, el paso que de verdad entrega
-- el gobierno a la IA sola. La primera fila va a 'human' con to_id; la
-- segunda, a 'unassigned' (mismo mensaje sin responder que el caso 2).
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000003';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '2 hours';
  v_cutoff timestamptz;
  v_to_kind text;
  v_to_id uuid;
begin
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  -- Paso A: reactivar SIN desasignar (la conversación sigue con A).
  update public.conversations set ai_enabled = true where id = conv_id;

  select ai_resume_cutoff_at into v_cutoff from public.conversations where id = conv_id;
  if v_cutoff is not null then
    insert into _errores(msg) values (format('Caso 3 (reactivar→desasignar), paso A: ai_resume_cutoff_at = %s, se esperaba null (sigue asignada, no entró al estado "sin asesor").', v_cutoff));
  end if;

  select to_kind, to_id into v_to_kind, v_to_id
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'devuelto_a_ia';
  if v_to_kind is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 3 (reactivar→desasignar), paso A: to_kind de devuelto_a_ia = %s, se esperaba ''human''.', v_to_kind));
  end if;
  if v_to_id is distinct from agent_id then
    insert into _errores(msg) values (format('Caso 3 (reactivar→desasignar), paso A: to_id de devuelto_a_ia = %s, se esperaba %s.', v_to_id, agent_id));
  end if;

  -- Paso B: desasignar. Recién acá entra al estado "sin asesor" y sella.
  update public.conversations set assigned_agent_id = null where id = conv_id;

  select ai_resume_cutoff_at into v_cutoff from public.conversations where id = conv_id;
  if v_cutoff is distinct from t0 then
    insert into _errores(msg) values (format('Caso 3 (reactivar→desasignar), paso B: ai_resume_cutoff_at = %s, se esperaba t0 (%s) -- sella recién en el segundo paso.', v_cutoff, t0));
  end if;

  select to_kind into v_to_kind
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'desasignada_por_asesor';
  if v_to_kind is distinct from 'unassigned' then
    insert into _errores(msg) values (format('Caso 3 (reactivar→desasignar), paso B: to_kind de desasignada_por_asesor = %s, se esperaba ''unassigned''.', v_to_kind));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · las dos condiciones en UN SOLO UPDATE (un panel que desasigne y
-- reactive de una sola llamada): dos filas, mismo to_kind -- comparten
-- created_at, así que el trigger tiene que calcular to_kind UNA vez y no
-- dos veces con estados intermedios distintos.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000004';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '2 hours';
  v_count integer;
  v_distinct_to_kinds integer;
begin
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  update public.conversations set assigned_agent_id = null, ai_enabled = true where id = conv_id;

  select count(*) into v_count from public.conversation_handoffs where conversation_id = conv_id;
  if v_count is distinct from 2 then
    insert into _errores(msg) values (format('Caso 4 (un solo UPDATE): %s fila(s) en la bitácora, se esperaban 2.', v_count));
  end if;

  select count(distinct to_kind) into v_distinct_to_kinds
    from public.conversation_handoffs where conversation_id = conv_id;
  if v_distinct_to_kinds is distinct from 1 then
    insert into _errores(msg) values (format('Caso 4 (un solo UPDATE): las %s filas no comparten el mismo to_kind.', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · un mensaje del cliente ENTRE la escalada y la devolución no deja
-- new_since_ai_resume en true tras devolver: el sello copia el ÚLTIMO
-- mensaje conocido en el instante de la devolución, así que ese mismo
-- mensaje nunca puede quedar "por delante" de su propio sello.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000005';
  t0 timestamptz := now() - interval '2 hours';
  t1 timestamptz := now() - interval '1 hour';
  v_cutoff timestamptz;
  v_new_since boolean;
begin
  -- Escalada sin asesor disponible: ai_enabled=false, sin asesor.
  update public.conversations set ai_enabled = false where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  -- El cliente escribe MIENTRAS espera, antes de que nadie lo devuelva.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', '¿Ya me atienden?', t1);

  update public.conversations set ai_enabled = true where id = conv_id;

  select ai_resume_cutoff_at, new_since_ai_resume into v_cutoff, v_new_since
    from public.conversations where id = conv_id;

  if v_cutoff is distinct from t1 then
    insert into _errores(msg) values (format('Caso 5 (mensaje entre escalada y devolución): ai_resume_cutoff_at = %s, se esperaba t1 (%s), el último mensaje conocido al devolver.', v_cutoff, t1));
  end if;
  if v_new_since is distinct from false then
    insert into _errores(msg) values (format('Caso 5 (mensaje entre escalada y devolución): new_since_ai_resume = %s, se esperaba false -- ese mensaje no puede quedar por delante de su propio sello.', v_new_since));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6a · un mensaje nuevo del cliente DESPUÉS de la devolución pasa a
-- new_since_ai_resume = true.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000006';
  t0 timestamptz := now() - interval '2 hours';
  t1 timestamptz := now() - interval '1 hour';
  v_new_since boolean;
begin
  update public.conversations set ai_enabled = false where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  update public.conversations set ai_enabled = true where id = conv_id; -- sella con t0

  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Sigo aquí, ¿alguien me ayuda?', t1);

  select new_since_ai_resume into v_new_since from public.conversations where id = conv_id;
  if v_new_since is distinct from true then
    insert into _errores(msg) values (format('Caso 6a (mensaje nuevo tras devolver): new_since_ai_resume = %s, se esperaba true.', v_new_since));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6b · latencia de Meta: un mensaje cuyo created_at es POSTERIOR al
-- sello pero anterior a "ahora" (y anterior al propio momento en que se
-- inserta la fila) también cuenta como nuevo -- el sello compara contra el
-- último mensaje YA CONOCIDO al momento de la devolución, no contra now(),
-- así que un mensaje que Meta entrega con retraso (enviado casi al mismo
-- tiempo que la devolución, pero insertado en la base recién después) no
-- queda "detrás" de un cutoff que se hubiera fijado con el reloj de pared.
-- t2 está a solo un segundo de t0 (el sello), muy por detrás de la hora
-- real de esta transacción -- justo lo que pasaría si Meta lo entrega
-- tarde.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000007';
  t0 timestamptz := now() - interval '2 hours';
  t2 timestamptz := (now() - interval '2 hours') + interval '1 second';
  v_new_since boolean;
begin
  update public.conversations set ai_enabled = false where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  update public.conversations set ai_enabled = true where id = conv_id; -- sella con t0

  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Perdón la demora, aquí Meta lo entregó tarde', t2);

  select new_since_ai_resume into v_new_since from public.conversations where id = conv_id;
  if v_new_since is distinct from true then
    insert into _errores(msg) values (format('Caso 6b (latencia de Meta): new_since_ai_resume = %s, se esperaba true -- el mensaje es posterior al sello aunque su created_at esté muy por detrás de la hora real de esta transacción.', v_new_since));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7 · un `unsupported` entrante DESPUÉS de la devolución no mueve
-- last_customer_message_at (candado A de 20260907010000: Meta no lo cuenta
-- para su ventana de 24h y el CRM tampoco), así que sigue en false.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000008';
  t0 timestamptz := now() - interval '2 hours';
  t1 timestamptz := now() - interval '1 hour';
  v_new_since boolean;
begin
  update public.conversations set ai_enabled = false where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  update public.conversations set ai_enabled = true where id = conv_id; -- sella con t0

  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'unsupported', null, t1);

  select new_since_ai_resume into v_new_since from public.conversations where id = conv_id;
  if v_new_since is distinct from false then
    insert into _errores(msg) values (format('Caso 7 (unsupported tras devolver): new_since_ai_resume = %s, se esperaba false -- un unsupported no mueve last_customer_message_at.', v_new_since));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 8 · reactivar sin nada pendiente (awaiting_reply en false: la última
-- salida fue una respuesta real) deja to_kind = 'ai'.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000009';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '2 hours';
  t1 timestamptz := now() - interval '1 hour';
  v_to_kind text;
begin
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Gracias por la ayuda', t0);
  -- El asesor SÍ respondió antes de soltar el caso: awaiting_reply queda en
  -- false (last_reply_at >= last_customer_message_at).
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, whatsapp_status, created_at)
  values (conv_id, 'outbound', 'agent', 'text', 'Con gusto, que tengas buen día', 'sent', t1);

  update public.conversations set assigned_agent_id = null where id = conv_id;
  update public.conversations set ai_enabled = true where id = conv_id;

  select to_kind into v_to_kind
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'devuelto_a_ia';
  if v_to_kind is distinct from 'ai' then
    insert into _errores(msg) values (format('Caso 8 (reactivar sin nada pendiente): to_kind = %s, se esperaba ''ai''.', v_to_kind));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 9 · un UPDATE que no toca ai_enabled ni assigned_agent_id no sella
-- ni deja fila -- ninguno de los dos WHEN dispara.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000010';
  v_cutoff_before timestamptz;
  v_cutoff_after timestamptz;
  v_count_before integer;
  v_count_after integer;
begin
  select ai_resume_cutoff_at into v_cutoff_before from public.conversations where id = conv_id;
  select count(*) into v_count_before from public.conversation_handoffs where conversation_id = conv_id;

  update public.conversations set journey_stage = 'assigned' where id = conv_id;

  select ai_resume_cutoff_at into v_cutoff_after from public.conversations where id = conv_id;
  select count(*) into v_count_after from public.conversation_handoffs where conversation_id = conv_id;

  if v_cutoff_after is distinct from v_cutoff_before then
    insert into _errores(msg) values ('Caso 9 (update ajeno): ai_resume_cutoff_at cambió sin tocar ai_enabled/assigned_agent_id.');
  end if;
  if v_count_after is distinct from v_count_before then
    insert into _errores(msg) values (format('Caso 9 (update ajeno): la bitácora pasó de %s a %s filas.', v_count_before, v_count_after));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 10 · una segunda devolución mueve el sello -- no queda pegado a la
-- primera vez que la conversación entró al estado "sin asesor".
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000011';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '3 hours';
  t1 timestamptz := now() - interval '2 hours';
  t2 timestamptz := now() - interval '1 hour';
  v_cutoff_1 timestamptz;
  v_cutoff_2 timestamptz;
begin
  update public.conversations set ai_enabled = false where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Primera vez que pido un asesor', t0);

  update public.conversations set ai_enabled = true where id = conv_id; -- primera devolución: sella con t0

  select ai_resume_cutoff_at into v_cutoff_1 from public.conversations where id = conv_id;
  if v_cutoff_1 is distinct from t0 then
    insert into _errores(msg) values (format('Caso 10 (segunda devolución), primera devolución: ai_resume_cutoff_at = %s, se esperaba t0 (%s).', v_cutoff_1, t0));
  end if;

  -- La IA atiende, escala de nuevo (esta vez con asesor) y ese asesor
  -- también suelta el caso.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Necesito hablar con alguien otra vez', t1);
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;
  update public.conversations set assigned_agent_id = null where id = conv_id;

  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Sigo esperando', t2);

  update public.conversations set ai_enabled = true where id = conv_id; -- segunda devolución: sella con t2

  select ai_resume_cutoff_at into v_cutoff_2 from public.conversations where id = conv_id;
  if v_cutoff_2 is distinct from t2 then
    insert into _errores(msg) values (format('Caso 10 (segunda devolución): ai_resume_cutoff_at = %s, se esperaba t2 (%s) -- el sello se movió con la segunda devolución.', v_cutoff_2, t2));
  end if;
  if v_cutoff_2 is not distinct from v_cutoff_1 then
    insert into _errores(msg) values ('Caso 10 (segunda devolución): el sello quedó igual al de la primera devolución; debía moverse.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 11 · created_by: 'user' cuando la sesión trae un sub (un asesor
-- actuando desde el panel), 'system' cuando no hay sesión (script SQL,
-- borrado de un asesor, o la carrera del UPDATE ciego de escalate.ts
-- corriendo con service_role -- ver CLAUDE.md, "código de servidor no es
-- sinónimo de service_role").
--
-- El sub-caso 'user' corre como el agente B correría desde el navegador:
-- `set local role authenticated` + `set local "request.jwt.claim.sub"`
-- (mismo patrón verificado contra esta base en pins.sql, 5/9/2026:
-- auth.uid() lee primero request.jwt.claim.sub). `conversations_all`
-- (20260819000001) exige is_agent(), así que el sub tiene que ser un agente
-- activo de verdad -- el agente B, que ningún otro caso usa.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000012';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000002';
  v_created_by text;
begin
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;

  set local role authenticated;
  set local "request.jwt.claim.sub" = 'b9b9b9b9-0000-0000-0000-000000000002';

  update public.conversations set assigned_agent_id = null where id = conv_id;

  -- `set local` vive hasta el FIN DE LA TRANSACCIÓN, no solo de este bloque
  -- -- sin este reset explícito el caso 11b (más abajo, sin sesión)
  -- heredaría el sub de este agente y saldría 'user' en vez de 'system'
  -- (se detectó así: la primera versión de este archivo no reseteaba
  -- request.jwt.claim.sub y el caso 11b fallaba).
  reset role;
  reset "request.jwt.claim.sub";

  select created_by into v_created_by
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'desasignada_por_asesor';
  if v_created_by is distinct from 'user' then
    insert into _errores(msg) values (format('Caso 11a (created_by con sesión): created_by = %s, se esperaba ''user''.', v_created_by));
  end if;
end $$;

do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000013';
  agent_id uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  v_created_by text;
begin
  -- Sin sesión (rol postgres de esta conexión, sin request.jwt.claim.sub):
  -- auth.uid() da null, igual que un script SQL directo o un UPDATE de
  -- service_role.
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_id where id = conv_id;
  update public.conversations set assigned_agent_id = null where id = conv_id;

  select created_by into v_created_by
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'desasignada_por_asesor';
  if v_created_by is distinct from 'system' then
    insert into _errores(msg) values (format('Caso 11b (created_by sin sesión): created_by = %s, se esperaba ''system''.', v_created_by));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 12 · permisos -- ni anon NI authenticated pueden ejecutar ninguna de
-- las dos funciones de esta migración (los dos revokes: PUBLIC y
-- anon/authenticated). El guardián general de permisos_funciones.sql ya
-- recorre pg_proc entero, pero SOLO mira anon (aserción 1 de ese archivo);
-- esta aserción es la específica de esta migración, igual que
-- awaiting_reply.sql prueba su propio CHECK aparte del guardián general.
--
-- Ampliado el 20/9/2026 ("El resguardo antes del push", tarea M3): una
-- prueba de mutación encontró que `grant execute ... to authenticated` sobre
-- estas dos funciones de TRIGGER sobrevivía a toda la suite -- ni este caso
-- (que hasta entonces solo miraba anon) ni permisos_funciones.sql lo
-- detectaban. Son funciones `returns trigger`: ningún rol necesita EXECUTE
-- sobre ellas para que el trigger dispare (Postgres no comprueba EXECUTE del
-- rol que dispara la operación al ejecutar un trigger, ver el comentario de
-- la sección 5 de la migración) -- un grant a `authenticated` sería
-- privilegio de más sin ningún uso legítimo, y solo esta aserción lo
-- atrapa.
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.handle_conversation_ai_resume()', 'execute') then
    insert into _errores(msg) values ('Caso 12 (permisos): anon puede ejecutar handle_conversation_ai_resume().');
  end if;
  if has_function_privilege('anon', 'public.handle_conversation_ownership_change()', 'execute') then
    insert into _errores(msg) values ('Caso 12 (permisos): anon puede ejecutar handle_conversation_ownership_change().');
  end if;
  if has_function_privilege('authenticated', 'public.handle_conversation_ai_resume()', 'execute') then
    insert into _errores(msg) values ('Caso 12 (permisos): authenticated puede ejecutar handle_conversation_ai_resume() -- es una función de trigger, ningún rol necesita EXECUTE sobre ella.');
  end if;
  if has_function_privilege('authenticated', 'public.handle_conversation_ownership_change()', 'execute') then
    insert into _errores(msg) values ('Caso 12 (permisos): authenticated puede ejecutar handle_conversation_ownership_change() -- es una función de trigger, ningún rol necesita EXECUTE sobre ella.');
  end if;
end $$;

-- ===========================================================================
-- Corrección post-revisión de `/code-review high` (16/9/2026): tres hallazgos
-- sobre la primera versión de esta migración -- ver el comentario de la
-- sección 5 de la migración y CLAUDE.md ("El trigger AFTER dejó con rastro
-- dos movimientos de dueño..."). Casos 13-15 cubren `reclamado`; el caso 16
-- cubre la rama `closed` de `v_to_kind`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Caso 13 · `reclamado` desde "sin dueño": escalada simulada (asesor A + IA
-- apagada en un UPDATE, no deja fila -- ver caso 1), desasignar (deja
-- 'desasignada_por_asesor' con to_kind 'unassigned', porque la IA sigue
-- apagada) y recién entonces asignar a C con la IA TODAVÍA apagada: el
-- `from` de la fila `reclamado` es el dueño anterior a ESE update --
-- 'unassigned', no 'human' A -- porque entre desasignar y reclamar el chat
-- no tuvo dueño.
--
-- NO se verifica acá con la MISMA consulta que unassigned_waiting_count()
-- (`order by created_at desc, id desc limit 1`): dentro de esta transacción
-- `now()` es constante (ver el comentario de cabecera de este archivo), así
-- que la fila 'desasignada_por_asesor' y la fila 'reclamado' comparten el
-- MISMO created_at -- exactamente el defecto de desempate que ese
-- comentario ya advierte, aplicado esta vez a dos razones distintas de la
-- MISMA conversación en vez de a dos filas de la misma razón. El desempate
-- por id quedaría librado al azar del UUID, y una corrida SÍ falló así en
-- el desarrollo de este caso. La prueba equivalente y determinista es
-- verificar que el to_kind de la fila 'reclamado' -- la que de verdad
-- importa una vez que C tiene el caso -- es 'human' y no 'unassigned' (ya
-- verificado abajo): eso es exactamente lo que
-- unassigned_waiting_count() necesita ver en la ÚLTIMA fila real (con
-- timestamps de pared distintos, que es como corre en producción) para NO
-- contar esta conversación en "Sin dueño".
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000014';
  agent_a uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  agent_c uuid := 'b9b9b9b9-0000-0000-0000-000000000003';
  t0 timestamptz := now() - interval '2 hours';
  v_count integer;
  v_from_kind text;
  v_from_id uuid;
  v_to_kind text;
  v_to_id uuid;
begin
  -- Escalada simulada (no deja fila, ver caso 1).
  update public.conversations set ai_enabled = false, assigned_agent_id = agent_a where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Quiero hablar con un asesor', t0);

  -- Desasignar: queda 'unassigned' porque la IA sigue apagada.
  update public.conversations set assigned_agent_id = null where id = conv_id;

  -- Reclamar: C toma el caso, IA sigue apagada (ai_enabled sin cambio). Con
  -- sesión real de C -- corrección del 18/9/2026 (T0, "Seba atiende el
  -- mostrador"): desde 20260917010000 la rama `reclamado` exige
  -- `auth.uid() is not null` (hallazgo 1 de ese plan: sin la guarda, la
  -- escalada de T4 -- que solo cambia assigned_agent_id, sin sesión --
  -- dejaría una fila `reclamado` espuria), así que este UPDATE necesita
  -- simular la sesión del asesor que reclama de verdad, igual que el
  -- caso 11a de este mismo archivo.
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'b9b9b9b9-0000-0000-0000-000000000003';

  update public.conversations set assigned_agent_id = agent_c where id = conv_id;

  reset role;
  reset "request.jwt.claim.sub";

  select count(*) into v_count from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_count is distinct from 1 then
    insert into _errores(msg) values (format('Caso 13 (reclamado desde unassigned): %s fila(s) reclamado, se esperaba 1.', v_count));
  end if;

  select from_kind, from_id, to_kind, to_id into v_from_kind, v_from_id, v_to_kind, v_to_id
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_from_kind is distinct from 'unassigned' then
    insert into _errores(msg) values (format('Caso 13 (reclamado desde unassigned): from_kind = %s, se esperaba ''unassigned'' (el dueño anterior a ESE update).', v_from_kind));
  end if;
  if v_from_id is not null then
    insert into _errores(msg) values (format('Caso 13 (reclamado desde unassigned): from_id = %s, se esperaba null.', v_from_id));
  end if;
  if v_to_kind is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 13 (reclamado desde unassigned): to_kind = %s, se esperaba ''human'' (para que unassigned_waiting_count() no la cuente).', v_to_kind));
  end if;
  if v_to_id is distinct from agent_c then
    insert into _errores(msg) values (format('Caso 13 (reclamado desde unassigned): to_id = %s, se esperaba %s.', v_to_id, agent_c));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 14 · `reclamado` con la IA encendida: un asesor interviene
-- (`intervene`, mutations.ts) un chat que la IA todavía gobierna --
-- assigned_agent_id pasa de null a B sin que ai_enabled cambie. El `from`
-- es 'ai' (old.ai_enabled = true), no 'unassigned'.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000015';
  agent_b uuid := 'b9b9b9b9-0000-0000-0000-000000000002';
  v_from_kind text;
  v_to_kind text;
  v_to_id uuid;
begin
  -- La conversación nace con ai_enabled = true y sin asesor (default). Con
  -- sesión de B, que se autoasigna -- ver nota del 18/9/2026 en el caso 13.
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'b9b9b9b9-0000-0000-0000-000000000002';

  update public.conversations set assigned_agent_id = agent_b where id = conv_id;

  reset role;
  reset "request.jwt.claim.sub";

  select from_kind, to_kind, to_id into v_from_kind, v_to_kind, v_to_id
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_from_kind is distinct from 'ai' then
    insert into _errores(msg) values (format('Caso 14 (reclamado con IA encendida): from_kind = %s, se esperaba ''ai''.', v_from_kind));
  end if;
  if v_to_kind is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 14 (reclamado con IA encendida): to_kind = %s, se esperaba ''human''.', v_to_kind));
  end if;
  if v_to_id is distinct from agent_b then
    insert into _errores(msg) values (format('Caso 14 (reclamado con IA encendida): to_id = %s, se esperaba %s.', v_to_id, agent_b));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 15 · `reclamado` reasignando de un asesor a otro directamente (sin
-- pasar por "sin dueño" en el medio): A tiene el caso, C se lo saca de un
-- solo UPDATE. `from` es 'human' + A (el dueño ANTERIOR a ESE update, no
-- 'unassigned').
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000016';
  agent_a uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  agent_c uuid := 'b9b9b9b9-0000-0000-0000-000000000003';
  v_from_kind text;
  v_from_id uuid;
  v_to_kind text;
  v_to_id uuid;
begin
  -- A toma el caso primero (esto también deja su propia fila 'reclamado',
  -- de 'ai' a A -- no es lo que este caso mide, se ignora a propósito). Con
  -- sesión de A -- ver nota del 18/9/2026 en el caso 13.
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'b9b9b9b9-0000-0000-0000-000000000001';
  update public.conversations set assigned_agent_id = agent_a where id = conv_id;
  reset role;
  reset "request.jwt.claim.sub";

  -- C se lo saca a A de un solo UPDATE, sin tocar ai_enabled. Con sesión de
  -- C, que reclama el caso él mismo.
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'b9b9b9b9-0000-0000-0000-000000000003';
  update public.conversations set assigned_agent_id = agent_c where id = conv_id;
  reset role;
  reset "request.jwt.claim.sub";

  select from_kind, from_id, to_kind, to_id into v_from_kind, v_from_id, v_to_kind, v_to_id
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado' and to_id = agent_c;
  if v_from_kind is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 15 (reasignar X -> Y): from_kind = %s, se esperaba ''human''.', v_from_kind));
  end if;
  if v_from_id is distinct from agent_a then
    insert into _errores(msg) values (format('Caso 15 (reasignar X -> Y): from_id = %s, se esperaba %s (A, el dueño anterior a ESE update).', v_from_id, agent_a));
  end if;
  if v_to_kind is distinct from 'human' then
    insert into _errores(msg) values (format('Caso 15 (reasignar X -> Y): to_kind = %s, se esperaba ''human''.', v_to_kind));
  end if;
  if v_to_id is distinct from agent_c then
    insert into _errores(msg) values (format('Caso 15 (reasignar X -> Y): to_id = %s, se esperaba %s.', v_to_id, agent_c));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 16 · rama `closed` de `v_to_kind`: una conversación CERRADA con
-- asesor y `awaiting_reply` true (un mensaje del cliente sin responder) se
-- desasigna desde el encabezado -- no hay candado por estado. Sin la rama
-- `closed`, `v_to_kind` habría dado 'unassigned' (la IA está apagada) y
-- `unassigned_waiting_count()` habría contado un chat CERRADO en "Sin
-- dueño".
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000017';
  agent_a uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  t0 timestamptz := now() - interval '2 hours';
  v_to_kind text;
  v_contada_en_sin_dueno boolean;
begin
  update public.conversations
    set ai_enabled = false, assigned_agent_id = agent_a, status = 'closed'
    where id = conv_id;
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'text', 'Gracias, eso era todo', t0);

  -- Desasignar un chat CERRADO (sin candado de estado en mutations.ts).
  update public.conversations set assigned_agent_id = null where id = conv_id;

  select to_kind into v_to_kind
    from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'desasignada_por_asesor';
  if v_to_kind is distinct from 'closed' then
    insert into _errores(msg) values (format('Caso 16 (cerrada, desasignar): to_kind = %s, se esperaba ''closed''.', v_to_kind));
  end if;

  select exists (
    select 1 from public.conversations c
    where c.id = conv_id
      and c.awaiting_reply
      and (
        select h.to_kind from public.conversation_handoffs h
        where h.conversation_id = c.id
        order by h.created_at desc, h.id desc
        limit 1
      ) = 'unassigned'
  ) into v_contada_en_sin_dueno;
  if v_contada_en_sin_dueno then
    insert into _errores(msg) values ('Caso 16 (cerrada, desasignar): unassigned_waiting_count() contaría este chat CERRADO en "Sin dueño".');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 17 · `reclamado` NO dispara cuando `ai_enabled` cambia EN EL MISMO
-- UPDATE que `assigned_agent_id`, aunque el UPDATE traiga sesión real de un
-- asesor (`auth.uid() is not null`) -- "El resguardo antes del push"
-- (20/9/2026, tarea M3): una prueba de mutación quitando SOLO la condición
-- `old.ai_enabled = new.ai_enabled` de la rama `reclamado` sobrevivía a los
-- 16 casos de arriba, porque ninguno combina sesión real CON ai_enabled
-- cambiando a la vez -- los casos 13/14/15 (reclamado) nunca tocan
-- ai_enabled en su UPDATE, y el caso 1 (escalada simulada, que sí cambia las
-- dos columnas) corre sin sesión. Sin esta guarda, una escalada hecha con
-- sesión de un asesor (en vez de con `service_role`, como hace hoy
-- `escalate.ts`) dejaría una fila `reclamado` espuria ADEMÁS de su propia
-- fila `escalada`.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := 'b6b6b6b6-0000-0000-0000-000000000018';
  agent_a uuid := 'b9b9b9b9-0000-0000-0000-000000000001';
  v_count integer;
begin
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'b9b9b9b9-0000-0000-0000-000000000001';

  -- Mismo UPDATE que una escalada (assigned_agent_id Y ai_enabled juntos),
  -- pero CON sesión real -- a diferencia del caso 1, que corre sin sesión.
  update public.conversations
  set ai_enabled = false, assigned_agent_id = agent_a
  where id = conv_id;

  reset role;
  reset "request.jwt.claim.sub";

  select count(*) into v_count from public.conversation_handoffs
    where conversation_id = conv_id and reason = 'reclamado';
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('Caso 17 (reclamado con sesión y ai_enabled cambiando a la vez): %s fila(s) reclamado, se esperaban 0 -- ai_enabled cambió en el mismo UPDATE.', v_count));
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
    raise exception E'devolucion_a_la_ia.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'devolucion_a_la_ia.sql: todas las aserciones pasaron.'
