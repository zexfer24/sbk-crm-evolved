-- ============================================================================
-- La búsqueda de la bandeja no revienta la base (Tarea T3, plan "La escalada
-- se hace una vez y la búsqueda responde", 21/9/2026 — D3/Frente 1)
--
-- Migración bajo prueba: 20260921030000_busqueda_de_mensajes_sin_rls_por_fila.sql.
--
-- El bug medido en producción: TODA búsqueda de /inbox daba 500 por
-- `statement timeout` (156 de 156 en 48 h; media 3,3 s, máx cerca del tope de
-- 8 s de `authenticated`). Causa reproducida contra la base local con 115.000
-- mensajes sembrados: `search_conversations_by_message` era `security
-- invoker` con un filtro `not exists (select ... where m.search_text not
-- like ...)` correlacionado por fila — ni el índice GIN trigram de
-- `messages.search_text` ni la política `messages_all using (is_agent())`
-- se pueden evaluar de forma barata así: el plan de EXPLAIN mostraba
-- `Function Scan` con ~204.000 buffers leídos y ~1,0-1,2 s de ejecución como
-- `authenticated` contra 100.000 mensajes sembrados por este mismo archivo
-- (caso 8) — remedido el 21/9/2026 al escribir este test, antes de tocar la
-- migración: ver el reporte de la tarea para los números completos.
--
-- La función candidata (medida por el orquestador contra 115.000 mensajes:
-- 27 ms / 137 ms / 20 ms según el término) resuelve el patrón UNA vez en un
-- arreglo (`pats`), lo que el planner SÍ puede empujar al índice GIN vía
-- `LIKE ALL` (Bitmap Index Scan en vez de Function Scan con Filter por
-- fila), y comprueba `is_agent()` UNA sola vez al principio en vez de una
-- vez por fila (RLS de por medio). `security definer`: el chequeo de RLS que
-- antes hacía la política de `messages` por fila queda a cargo del propio
-- cuerpo de la función.
--
-- Comodines de LIKE (%, _, \) sin escapar: comportamiento SIN CAMBIOS. La
-- función vieja ya arma el patrón como `'%' || término || '%'` y pasa el
-- término del asesor tal cual — un término que trajera un `%`/`_`/`\`
-- propio ya se interpretaba como comodín de LIKE antes de esta migración
-- (mismo defecto, no lo introduce esta tarea). `message-search.ts`
-- (`searchTerms`) tampoco escapa esos caracteres del lado del cliente. Se
-- documenta acá porque el plan pedía revisarlo explícitamente; no hay caso
-- de test nuevo para esto (no es parte de los 8+2 casos del reporte del VPS
-- y arreglarlo no estaba en el alcance de esta tarea — cambiaría semántica
-- que hoy nadie reportó como bug).
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que devolucion_a_la_ia.sql/
-- catalog_links.sql). Los datos chicos (casos 1-7, 9) se insertan como
-- `postgres` (bypassa RLS, `rolbypassrls`) ANTES de simular sesión — mismo
-- motivo que el resto de los tests: la función SECURITY DEFINER que se está
-- probando queda dueña de `postgres`, así que adentro de la función el
-- acceso a `messages` bypassa RLS igual (el único portón es el `is_agent()`
-- explícito del cuerpo) — lo que hay que simular con `set local role
-- authenticated` + `request.jwt.claim.sub` es el SUJETO que llama, no el
-- acceso a la tabla en sí.
--
-- Caso 8 (rendimiento) NO usa `statement_timeout` real: se probó primero
-- (`set local statement_timeout` + capturar `query_canceled` con un
-- SAVEPOINT) y funciona, pero `SET LOCAL` cambia el GUC para el PRÓXIMO
-- statement de nivel superior — no afecta retroactivamente al que ya está
-- corriendo cuando el cambio ocurre DENTRO de un bloque `do $$ ... $$`
-- (verificado contra esta base: un `pg_sleep(1)` con `set local
-- statement_timeout='200ms'` ejecutado ANTES en el MISMO bloque `do` no se
-- cancela — corre el segundo completo). Medir con `clock_timestamp()` antes
-- y después de la llamada, y comparar contra un umbral en milisegundos, es
-- más simple, no depende de ese matiz de `SET LOCAL`, y da el número real
-- para el reporte en vez de solo un booleano. Umbral elegido: 500 ms —
-- medido contra 100.000 mensajes sembrados en esta misma máquina, la
-- función VIEJA tardó 1.036-1.225 ms (tres corridas) y la NUEVA 34-111 ms
-- (cuatro términos distintos); 500 ms deja margen de sobra por debajo del
-- piso de la vieja (~2x) y por encima del techo medido de la nueva (~4,5x),
-- para no ponerse en rojo por ruido en un runner de CI más lento.
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- La tabla temporal la crea el rol de conexión (postgres); los casos que
-- corren bajo `set local role authenticated` más abajo necesitan poder
-- anotar un error sin que la propia tabla de errores tire "permission
-- denied for table _errores" -- mismo hallazgo que ai_lessons.sql/
-- catalog_links.sql.
grant insert on _errores to authenticated;

-- ---------------------------------------------------------------------------
-- Datos chicos para los casos 1-7 y 9. Un canal, seis conversaciones (una
-- por caso que necesita datos propios), mensajes con created_at explícito
-- (dentro de esta transacción now() es constante, así que dos inserts
-- sucesivos con default now() empatarían y el "más reciente" del caso 6 no
-- se podría desempatar).
-- ---------------------------------------------------------------------------
insert into public.whatsapp_channels (id, label, phone_number) values
  ('f6f6f6f6-0000-0000-0000-000000000000', 'Canal de prueba búsqueda', '+580000007000');

insert into public.contacts (id, phone_number) values
  ('f7f7f7f7-0000-0000-0000-000000000001', '+580000007001'), -- caso 1 (Uno) y 5 (system_event, mismo término)
  ('f7f7f7f7-0000-0000-0000-000000000002', '+580000007002'), -- caso 2 positivo (Dos)
  ('f7f7f7f7-0000-0000-0000-000000000003', '+580000007003'), -- caso 2 negativo (DosB, solo "caucho")
  ('f7f7f7f7-0000-0000-0000-000000000004', '+580000007004'), -- caso 4 (Cuatro, batería sin tilde)
  ('f7f7f7f7-0000-0000-0000-000000000005', '+580000007005'), -- caso 5 (Cinco, solo system_event)
  ('f7f7f7f7-0000-0000-0000-000000000006', '+580000007006'); -- caso 6 (Seis, varias coincidencias)

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('f8f8f8f8-0000-0000-0000-000000000001', 'f7f7f7f7-0000-0000-0000-000000000001', 'f6f6f6f6-0000-0000-0000-000000000000'),
  ('f8f8f8f8-0000-0000-0000-000000000002', 'f7f7f7f7-0000-0000-0000-000000000002', 'f6f6f6f6-0000-0000-0000-000000000000'),
  ('f8f8f8f8-0000-0000-0000-000000000003', 'f7f7f7f7-0000-0000-0000-000000000003', 'f6f6f6f6-0000-0000-0000-000000000000'),
  ('f8f8f8f8-0000-0000-0000-000000000004', 'f7f7f7f7-0000-0000-0000-000000000004', 'f6f6f6f6-0000-0000-0000-000000000000'),
  ('f8f8f8f8-0000-0000-0000-000000000005', 'f7f7f7f7-0000-0000-0000-000000000005', 'f6f6f6f6-0000-0000-0000-000000000000'),
  ('f8f8f8f8-0000-0000-0000-000000000006', 'f7f7f7f7-0000-0000-0000-000000000006', 'f6f6f6f6-0000-0000-0000-000000000000');

-- Caso 1: término existente -> conversación correcta ("Uno").
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('f8f8f8f8-0000-0000-0000-000000000001', 'inbound', 'customer', 'text', 'Necesito una bujia nueva para mi moto', now() - interval '6 hours');

-- Caso 2: dos términos exigen AMBOS. "Dos" los tiene los dos, "DosB" solo uno.
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('f8f8f8f8-0000-0000-0000-000000000002', 'inbound', 'customer', 'text', 'Tienen caucho trasero para una bera sbr?', now() - interval '5 hours'),
  ('f8f8f8f8-0000-0000-0000-000000000003', 'inbound', 'customer', 'text', 'Necesito un caucho para la delantera', now() - interval '5 hours');

-- Caso 4: "bateria" (sin tilde en la búsqueda) encuentra "batería" (con tilde).
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('f8f8f8f8-0000-0000-0000-000000000004', 'inbound', 'customer', 'text', 'La batería está descargada, necesito otra', now() - interval '4 hours');

-- Caso 5: el ÚNICO mensaje de esta conversación es un system_event que
-- contiene el mismo término del caso 1 ("bujia") -- si la exclusión de
-- system_event fallara, el caso 1 vería DOS conversaciones en vez de una.
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('f8f8f8f8-0000-0000-0000-000000000005', 'outbound', 'system', 'system_event', 'Venta cerrada por Luis, entregó bujia de regalo', now() - interval '3 hours');

-- Caso 6: dos coincidencias reales en la MISMA conversación con un término
-- propio ("candela", para no interferir con el caso 1/5 que usan "bujia") --
-- tiene que volver UNA fila con el mensaje más reciente.
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('f8f8f8f8-0000-0000-0000-000000000006', 'inbound', 'customer', 'text', 'Candela vieja para cambiar', now() - interval '2 hours'),
  ('f8f8f8f8-0000-0000-0000-000000000006', 'inbound', 'customer', 'text', 'Otra candela mas para el pedido', now() - interval '1 hours');

-- Dos agentes de prueba: A es un asesor real y activo (casos 1-8); NA se
-- crea con sesión válida de Supabase Auth pero SIN fila en public.agents
-- (caso 9 -- "authenticated que no es agente"). `is_active=false` NO sirve
-- para simular esto: `is_agent()` (`create or replace` desde
-- 20260825040000_agent_switch_only_gates_ai.sql) dejó de exigir
-- `is_active` -- hoy solo comprueba que EXISTA la fila. Se comprobó armando
-- este caso: con `is_active=false` `is_agent()` seguía dando `true` y el
-- caso salía en rojo por una razón equivocada. `handle_new_agent()` crea la
-- fila espejo automáticamente al insertar en auth.users, así que hay que
-- borrarla después para simular un usuario autenticado que no es del
-- equipo.
insert into auth.users (id, email, raw_user_meta_data) values
  ('f5f5f5f5-0000-0000-0000-000000000001', 'agente-a-busqueda@sbk.test', jsonb_build_object('display_name', 'Agente A (búsqueda)')),
  ('f5f5f5f5-0000-0000-0000-000000000002', 'agente-na-busqueda@sbk.test', jsonb_build_object('display_name', 'Agente NA (búsqueda, sin fila en agents)'));

delete from public.agents where id = 'f5f5f5f5-0000-0000-0000-000000000002';

-- A partir de acá se corre como correría el navegador: sesión real del
-- agente A. La función bajo prueba es SECURITY DEFINER (dueña de
-- `postgres`, que tiene rolbypassrls): el único portón real es el
-- `is_agent()` explícito de su cuerpo, así que lo que hace falta simular es
-- el SUJETO que llama (auth.uid()), no permisos de tabla.
set local role authenticated;
set local "request.jwt.claim.sub" = 'f5f5f5f5-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- Caso 1 · término existente -> conversación correcta.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from public.search_conversations_by_message('bujia', 40) r
    where r.conversation_id = 'f8f8f8f8-0000-0000-0000-000000000001';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (término existente): %s fila(s) para la conversación "Uno", se esperaba 1.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · dos términos exigen AMBOS: "Dos" los tiene los dos, "DosB" solo
-- "caucho" -- no debe aparecer.
-- ---------------------------------------------------------------------------
do $$
declare
  n_dos integer;
  n_dosb integer;
begin
  select count(*) into n_dos from public.search_conversations_by_message('caucho trasero', 40) r
    where r.conversation_id = 'f8f8f8f8-0000-0000-0000-000000000002';
  if n_dos is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2 (dos términos, AMBOS): %s fila(s) para "Dos" (los tiene los dos), se esperaba 1.', n_dos));
  end if;

  select count(*) into n_dosb from public.search_conversations_by_message('caucho trasero', 40) r
    where r.conversation_id = 'f8f8f8f8-0000-0000-0000-000000000003';
  if n_dosb is distinct from 0 then
    insert into _errores(msg) values (format('Caso 2 (dos términos, AMBOS): %s fila(s) para "DosB" (solo tiene "caucho"), se esperaban 0.', n_dosb));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · sin coincidencias -> cero filas.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from public.search_conversations_by_message('carburador9x8z-que-no-existe', 40);
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3 (sin coincidencias): %s fila(s), se esperaban 0.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · "bateria" (sin tilde en la búsqueda) encuentra "batería".
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from public.search_conversations_by_message('bateria', 40) r
    where r.conversation_id = 'f8f8f8f8-0000-0000-0000-000000000004';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 4 (sin tilde encuentra con tilde): %s fila(s), se esperaba 1.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · system_event excluido: buscar "bujia" no debe devolver "Cinco"
-- (su único mensaje es un system_event) -- y de paso confirma que el caso 1
-- sigue viendo UNA sola conversación con ese término, no dos.
-- ---------------------------------------------------------------------------
do $$
declare
  n_total integer;
  n_cinco integer;
begin
  select count(*) into n_total from public.search_conversations_by_message('bujia', 40);
  if n_total is distinct from 1 then
    insert into _errores(msg) values (format('Caso 5 (system_event excluido): "bujia" devolvió %s conversación(es) en total, se esperaba 1 (solo "Uno" -- "Cinco" debe quedar afuera).', n_total));
  end if;

  select count(*) into n_cinco from public.search_conversations_by_message('bujia', 40) r
    where r.conversation_id = 'f8f8f8f8-0000-0000-0000-000000000005';
  if n_cinco is distinct from 0 then
    insert into _errores(msg) values (format('Caso 5 (system_event excluido): %s fila(s) para "Cinco" (solo tiene un system_event), se esperaban 0.', n_cinco));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · varias coincidencias en una conversación -> UNA fila, la más
-- reciente.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  v_content text;
begin
  select count(*) into n from public.search_conversations_by_message('candela', 40) r
    where r.conversation_id = 'f8f8f8f8-0000-0000-0000-000000000006';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 6 (varias coincidencias, una fila): %s fila(s) para "Seis", se esperaba 1.', n));
  end if;

  select r.content into v_content from public.search_conversations_by_message('candela', 40) r
    where r.conversation_id = 'f8f8f8f8-0000-0000-0000-000000000006';
  if v_content is distinct from 'Otra candela mas para el pedido' then
    insert into _errores(msg) values (format('Caso 6 (varias coincidencias, la más reciente): content = %L, se esperaba el mensaje más nuevo ("Otra candela mas para el pedido").', v_content));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7 · p_limit = 0 -> cero filas, aunque haya coincidencias reales.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from public.search_conversations_by_message('bujia', 0);
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7 (p_limit=0): %s fila(s), se esperaban 0 (aunque "bujia" sí tiene coincidencias).', n));
  end if;
end $$;

-- Se vuelve a postgres/rolbypassrls para el sembrado masivo: session_replication_role
-- es un GUC que un rol sin privilegio de superusuario/bypassrls no puede tocar.
reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 8 · RESGUARDO DE RENDIMIENTO. Siembra ~100.000 mensajes (2.000
-- conversaciones x 50 mensajes) saltando triggers con
-- session_replication_role=replica (el trigger handle_new_message hace un
-- UPDATE por fila sobre conversations -- innecesario para este test y
-- carísimo a este volumen) y midiendo con clock_timestamp() -- ver el
-- comentario de cabecera sobre por qué no se usa `statement_timeout` acá.
-- Contenido sin ninguno de los términos de los casos 1-7 (nada de "bujia",
-- "caucho", "bateria", "candela") para no alterar sus conteos.
-- ---------------------------------------------------------------------------
insert into public.whatsapp_channels (id, label, phone_number) values
  ('eeeeeeee-0000-0000-0000-000000000000', 'Canal de prueba rendimiento (búsqueda)', '+580000009000');

set local session_replication_role = replica;

insert into public.contacts (id, phone_number)
select ('e1e1e1e1-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
       '+58900' || lpad(g::text, 7, '0')
from generate_series(1, 2000) g;

insert into public.conversations (id, contact_id, whatsapp_channel_id)
select ('e2e2e2e2-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
       ('e1e1e1e1-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
       'eeeeeeee-0000-0000-0000-000000000000'
from generate_series(1, 2000) g;

insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
select
  ('e2e2e2e2-0000-0000-0000-' || lpad(c::text, 12, '0'))::uuid,
  case when m % 2 = 0 then 'inbound' else 'outbound' end,
  case when m % 2 = 0 then 'customer' else 'agent' end,
  'text',
  'Mensaje de prueba numero ' || m || ' de la conversacion ' || c || ' sobre motos y accesorios varios para el catalogo',
  now() - ((2000 * 50 - (c * 50 + m)) || ' seconds')::interval
from generate_series(1, 2000) c, generate_series(1, 50) m;

set local session_replication_role = origin;

analyze public.messages;
analyze public.conversations;

set local role authenticated;
set local "request.jwt.claim.sub" = 'f5f5f5f5-0000-0000-0000-000000000001';

do $$
declare
  t0 timestamptz;
  elapsed_ms numeric;
  n integer;
  -- Ver el comentario de cabecera: medido contra esta misma base con
  -- ~100.000 mensajes, la función vieja tardó 1.036-1.225 ms y la nueva
  -- 34-111 ms (cuatro términos). 500 ms separa con margen de sobra en las
  -- dos direcciones.
  umbral_ms constant numeric := 500;
begin
  t0 := clock_timestamp();
  select count(*) into n from public.search_conversations_by_message('xyznoexisteenningunmensaje9f8', 40);
  elapsed_ms := extract(epoch from (clock_timestamp() - t0)) * 1000;

  if elapsed_ms > umbral_ms then
    insert into _errores(msg) values (format(
      'Caso 8 (rendimiento): search_conversations_by_message tardó %s ms (umbral %s ms) contra ~100.000 mensajes sembrados, como authenticated -- si esto se puso en rojo con la función NUEVA (no con la vieja, ver la migración 20260921030000), es una regresión real, no ruido: la función vieja ya se midió por encima de 1.000 ms en esta misma máquina.',
      round(elapsed_ms), umbral_ms
    ));
  end if;

  raise notice 'Caso 8 (rendimiento): % ms (umbral % ms), % fila(s).', round(elapsed_ms, 1), umbral_ms, n;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 9 · un usuario `authenticated` que NO es agente (sin fila en
-- public.agents -- ver el comentario de arriba sobre por qué is_active=false
-- no alcanza) recibe cero filas -- la función pasa a `security definer`,
-- así que ese chequeo ahora es responsabilidad SUYA (is_agent() en el
-- cuerpo), no de la política de `messages`. Se busca "bujia", que SÍ tiene
-- una coincidencia real para un agente de verdad (caso 1) -- la diferencia
-- tiene que ser el sujeto, no el término.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'f5f5f5f5-0000-0000-0000-000000000002';

do $$
declare
  n integer;
begin
  select count(*) into n from public.search_conversations_by_message('bujia', 40);
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 9 (authenticated sin ser agente): %s fila(s), se esperaban 0 -- "bujia" sí tiene una coincidencia real para un agente activo (caso 1).', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 10 · permisos de la función misma: `anon` NO tiene EXECUTE, `authenticated`
-- y `service_role` SÍ. Los DOS revokes de la migración (`from public` y
-- `from anon, authenticated`) más el grant explícito a `authenticated,
-- service_role`.
-- ---------------------------------------------------------------------------
do $$
declare
  errores text := '';
begin
  if has_function_privilege('anon', 'public.search_conversations_by_message(text, integer)', 'execute') then
    errores := errores || E'\n  - anon puede ejecutar search_conversations_by_message() y no debería.';
  end if;
  if not has_function_privilege('authenticated', 'public.search_conversations_by_message(text, integer)', 'execute') then
    errores := errores || E'\n  - authenticated NO puede ejecutar search_conversations_by_message() y sí debería (la llama el navegador con sesión).';
  end if;
  if not has_function_privilege('service_role', 'public.search_conversations_by_message(text, integer)', 'execute') then
    errores := errores || E'\n  - service_role NO puede ejecutar search_conversations_by_message() y sí debería (grant explícito, mismo criterio que la migración original).';
  end if;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 10 (permisos):%s', errores));
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
    raise exception E'search_conversations_by_message.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'search_conversations_by_message.sql: todas las aserciones pasaron.'
