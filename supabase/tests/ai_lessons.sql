-- ===========================================================================
-- Lecciones de Seba (Tarea 1, plan "Seba atiende el mostrador", 18/9/2026)
--
-- Migración bajo prueba: 20260917020000_ai_lessons.sql.
--
-- Mismo patrón que devolucion_a_la_ia.sql/pins.sql: transacción con
-- rollback, tabla temporal `_errores`, un solo `raise exception` al final
-- con todo lo acumulado. La parte de RLS corre con `set local role
-- authenticated` + `set local "request.jwt.claim.sub"` (verificado contra
-- esta base en pins.sql, 5/9/2026: auth.uid() lee primero
-- request.jwt.claim.sub) para que las políticas se evalúen como en
-- producción, no como el rol `postgres` (que no tiene RLS activa y
-- escondería cualquier agujero de la política).
--
-- Tres agentes de prueba: A (autor de las lecciones), B (otro agente
-- corriente, ni supervisor ni autor -- prueba que RLS lo bloquea) y S
-- (supervisor -- prueba que sí puede editar/borrar lecciones ajenas).
-- `handle_new_agent()` crea la fila espejo en public.agents con
-- role='agent' por default; S se sube a 'supervisor' con un UPDATE directo
-- (como postgres, antes de que ningún `set local role` esté activo).
--
-- Corre en el job `migraciones` de CI, junto a
-- permisos_funciones.sql/invariante_leads.sql/devolucion_a_la_ia.sql.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- La tabla temporal la crea el rol de conexión (postgres); los casos 3, 4 y
-- la sesión de A corren bajo `set local role authenticated` más abajo, y sin
-- este grant un `insert into _errores` DENTRO de esa sesión revienta con
-- "permission denied for table _errores" en vez de anotar el error de
-- verdad -- se detectó corriendo la mutación del insert (caso 2 sin
-- created_by = auth.uid()): la aserción fallida no podía ni dejar su
-- mensaje.
grant insert on _errores to authenticated;

-- Tres agentes de prueba.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'agente-a-lecciones@sbk.test', jsonb_build_object('display_name', 'Agente A (lecciones)')),
  ('c1c1c1c1-0000-0000-0000-000000000002', 'agente-b-lecciones@sbk.test', jsonb_build_object('display_name', 'Agente B (lecciones)')),
  ('c1c1c1c1-0000-0000-0000-000000000003', 'agente-s-lecciones@sbk.test', jsonb_build_object('display_name', 'Agente S (lecciones, supervisor)'));

update public.agents set role = 'supervisor' where id = 'c1c1c1c1-0000-0000-0000-000000000003';

-- Un canal, un contacto y una conversación propios -- solo hacen falta para
-- el caso 5 (scope='conversacion' exige conversation_id).
insert into public.whatsapp_channels (id, label, phone_number) values
  ('c2c2c2c2-0000-0000-0000-000000000000', 'Canal de prueba (lecciones)', '+580000007000');

insert into public.contacts (id, phone_number) values
  ('c3c3c3c3-0000-0000-0000-000000000001', '+580000007001');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('c4c4c4c4-0000-0000-0000-000000000001', 'c3c3c3c3-0000-0000-0000-000000000001', 'c2c2c2c2-0000-0000-0000-000000000000');

-- A partir de acá se corre como el agente A correría desde el navegador.
set local role authenticated;
set local "request.jwt.claim.sub" = 'c1c1c1c1-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- Caso 1 · A inserta una lección global con created_by = auth.uid() → OK.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  insert into public.ai_lessons (id, scope, kind, content, created_by) values (
    'c5c5c5c5-0000-0000-0000-000000000001',
    'global',
    'nota',
    'Los repuestos de la Bera R1 también sirven para la Empire Keeway 150.',
    'c1c1c1c1-0000-0000-0000-000000000001'
  );

  select count(*) into n from public.ai_lessons
    where id = 'c5c5c5c5-0000-0000-0000-000000000001'
      and created_by = 'c1c1c1c1-0000-0000-0000-000000000001';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (insert propio): %s fila(s) encontradas, se esperaba 1.', n));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 1 (insert propio): el insert del propio agente A falló y no debía -- %s', sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · A intenta insertar una lección con created_by de OTRO agente (B)
-- → rechazado por RLS (el `with check` de ai_lessons_insert exige
-- created_by = auth.uid()).
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.ai_lessons (id, scope, kind, content, created_by) values (
      'c5c5c5c5-0000-0000-0000-000000000099',
      'global',
      'nota',
      'Lección insertada a nombre de otro agente -- no debería pasar.',
      'c1c1c1c1-0000-0000-0000-000000000002'
    );
    se_insertó := true;
  exception
    when insufficient_privilege then
      -- Esperado: 42501, "new row violates row-level security policy".
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 2 (created_by ajeno): el insert con created_by de otro agente se aceptó -- la política ai_lessons_insert no está exigiendo created_by = auth.uid().');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · scope='conversacion' sin conversation_id → viola el CHECK
-- ai_lessons_conversacion_requires_conversation. (Numerado según la lista
-- de la tarea; se corre acá, todavía bajo la sesión de A, porque A puede
-- insertar de por sí -- lo que se mide es el CHECK, no la RLS.)
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.ai_lessons (id, scope, kind, content, conversation_id, created_by) values (
      'c5c5c5c5-0000-0000-0000-000000000005',
      'conversacion',
      'nota',
      'Lección de un solo chat sin decir cuál -- no debería pasar.',
      null,
      'c1c1c1c1-0000-0000-0000-000000000001'
    );
    se_insertó := true;
  exception
    when check_violation then
      -- Esperado: 23514, ai_lessons_conversacion_requires_conversation.
      if sqlerrm not like '%ai_lessons_conversacion_requires_conversation%' then
        insert into _errores(msg) values (format('Caso 5 (scope conversacion sin conversation_id): falló, pero no por el CHECK esperado -- %s', sqlerrm));
      end if;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 5 (scope conversacion sin conversation_id): el insert se aceptó -- el CHECK ai_lessons_conversacion_requires_conversation no está frenando.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · content de 201 caracteres → viola el CHECK de longitud
-- (char_length(btrim(content)) between 1 and 200).
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.ai_lessons (id, scope, kind, content, created_by) values (
      'c5c5c5c5-0000-0000-0000-000000000006',
      'global',
      'nota',
      repeat('a', 201),
      'c1c1c1c1-0000-0000-0000-000000000001'
    );
    se_insertó := true;
  exception
    when check_violation then
      -- Esperado: 23514, el CHECK inline de content.
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 6 (content de 201 caracteres): el insert se aceptó -- el CHECK de longitud de content no está frenando.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7 · kind='sinonimo' sin synonym_to → viola el CHECK
-- ai_lessons_synonym_requires_terms.
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.ai_lessons (id, scope, kind, content, synonym_from, created_by) values (
      'c5c5c5c5-0000-0000-0000-000000000007',
      'global',
      'sinonimo',
      'Sinónimo sin término real de destino -- no debería pasar.',
      'pastilla',
      'c1c1c1c1-0000-0000-0000-000000000001'
    );
    se_insertó := true;
  exception
    when check_violation then
      -- Esperado: 23514, ai_lessons_synonym_requires_terms.
      if sqlerrm not like '%ai_lessons_synonym_requires_terms%' then
        insert into _errores(msg) values (format('Caso 7 (sinonimo sin synonym_to): falló, pero no por el CHECK esperado -- %s', sqlerrm));
      end if;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 7 (sinonimo sin synonym_to): el insert se aceptó -- el CHECK ai_lessons_synonym_requires_terms no está frenando.');
  end if;
end $$;

-- Segunda lección de A, propia para los casos 3 y 4 (edición/borrado ajeno).
do $$
begin
  insert into public.ai_lessons (id, scope, kind, content, created_by) values (
    'c5c5c5c5-0000-0000-0000-000000000002',
    'global',
    'nota',
    'No ofrecer el kit de arrastre genérico para la Bera SBR: el cliente siempre pregunta por el original.',
    'c1c1c1c1-0000-0000-0000-000000000001'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2b · el propio AUTOR (A) edita y borra SU PROPIA lección -- "El
-- resguardo antes del push" (20/9/2026, tarea M3). Hasta esta corrida el
-- archivo solo probaba que un agente AJENO (B) no puede tocarla (caso 3) y
-- que un SUPERVISOR sí puede (caso 4); una prueba de mutación que le quitaba
-- a `ai_lessons_update` la rama `or created_by = auth.uid()` (dejando SOLO
-- `is_supervisor_or_admin()`) sobrevivía a los dos porque ninguno ejercitaba
-- el camino del propio autor -- exactamente la mitad de la política que la
-- migración documenta ("solo el autor o un supervisor/admin puede editar o
-- borrar"). Usa una TERCERA lección, propia de este caso, para no interferir
-- con la que los casos 3 y 4 necesitan intacta.
-- ---------------------------------------------------------------------------
do $$
declare
  filas integer;
  activa boolean;
begin
  insert into public.ai_lessons (id, scope, kind, content, created_by) values (
    'c5c5c5c5-0000-0000-0000-000000000003',
    'global',
    'nota',
    'El repuesto de encendido de la Empire Keeway también calza en la TVS Star.',
    'c1c1c1c1-0000-0000-0000-000000000001'
  );

  update public.ai_lessons set is_active = false where id = 'c5c5c5c5-0000-0000-0000-000000000003';
  get diagnostics filas = row_count;
  if filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2b (el autor edita lo suyo): UPDATE afectó %s fila(s), se esperaba 1.', filas));
  end if;

  select is_active into activa from public.ai_lessons where id = 'c5c5c5c5-0000-0000-0000-000000000003';
  if activa is distinct from false then
    insert into _errores(msg) values (format('Caso 2b (el autor edita lo suyo): is_active = %s, se esperaba false.', activa));
  end if;

  delete from public.ai_lessons where id = 'c5c5c5c5-0000-0000-0000-000000000003';
  get diagnostics filas = row_count;
  if filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2b (el autor borra lo suyo): DELETE afectó %s fila(s), se esperaba 1.', filas));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 2b (el autor edita/borra lo suyo): falló y no debía -- %s', sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · otro agente (B, ni supervisor ni autor) intenta UPDATE/DELETE de
-- la lección de A → 0 filas afectadas (la política solo lo deja pasar por
-- is_supervisor_or_admin() o created_by = auth.uid(); ninguna de las dos se
-- cumple para B), y la fila sigue intacta.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c1c1c1c1-0000-0000-0000-000000000002';

do $$
declare
  filas integer;
  contenido_actual text;
begin
  update public.ai_lessons set content = 'Editado por B -- no debería pasar.'
    where id = 'c5c5c5c5-0000-0000-0000-000000000002';
  get diagnostics filas = row_count;
  if filas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3 (UPDATE ajeno de B): afectó %s fila(s), se esperaban 0.', filas));
  end if;

  delete from public.ai_lessons where id = 'c5c5c5c5-0000-0000-0000-000000000002';
  get diagnostics filas = row_count;
  if filas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3 (DELETE ajeno de B): afectó %s fila(s), se esperaban 0.', filas));
  end if;

  select content into contenido_actual from public.ai_lessons where id = 'c5c5c5c5-0000-0000-0000-000000000002';
  if contenido_actual is null then
    insert into _errores(msg) values ('Caso 3 (UPDATE/DELETE ajeno de B): la fila de A desapareció -- no debía tocarse.');
  elsif contenido_actual like '%Editado por B%' then
    insert into _errores(msg) values ('Caso 3 (UPDATE ajeno de B): el contenido cambió -- no debía tocarse.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · un supervisor (S) SÍ puede actualizar (is_active = false) y
-- borrar la lección de A.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c1c1c1c1-0000-0000-0000-000000000003';

do $$
declare
  filas integer;
  activa boolean;
begin
  update public.ai_lessons set is_active = false where id = 'c5c5c5c5-0000-0000-0000-000000000002';
  get diagnostics filas = row_count;
  if filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 4 (UPDATE de supervisor): afectó %s fila(s), se esperaba 1.', filas));
  end if;

  select is_active into activa from public.ai_lessons where id = 'c5c5c5c5-0000-0000-0000-000000000002';
  if activa is distinct from false then
    insert into _errores(msg) values (format('Caso 4 (UPDATE de supervisor): is_active = %s, se esperaba false.', activa));
  end if;

  delete from public.ai_lessons where id = 'c5c5c5c5-0000-0000-0000-000000000002';
  get diagnostics filas = row_count;
  if filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 4 (DELETE de supervisor): afectó %s fila(s), se esperaba 1.', filas));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 7b · la política `ai_lessons_select` es `using (is_agent())`, no
-- `using (true)` -- "El resguardo antes del push" (20/9/2026, tarea M3): con
-- `handle_new_agent()` creando una fila espejo para TODO usuario de
-- `auth.users`, cualquier sesión autenticada de las pruebas de arriba ya es
-- agente y no distingue las dos políticas. Este caso usa un uuid que NUNCA
-- se insertó en `auth.users` (por lo tanto tampoco en `agents`): con
-- `is_agent()` de verdad, `auth.uid()` no calza ninguna fila y el SELECT
-- debe devolver 0 filas; con `using (true)` devolvería todas.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  set local role authenticated;
  set local "request.jwt.claim.sub" = 'c1c1c1c1-0000-0000-0000-00000000ffff';

  select count(*) into n from public.ai_lessons;

  reset role;
  reset "request.jwt.claim.sub";

  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7b (select sin fila en agents): %s fila(s) visibles, se esperaban 0 -- ai_lessons_select no está exigiendo is_agent().', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 8 · ai_lessons quedó publicada en supabase_realtime (mismo criterio
-- que 20260909050000: suscribirse a un canal muerto no falla, calla para
-- siempre -- esto es lo único que distingue las dos situaciones).
-- ---------------------------------------------------------------------------
do $$
declare
  publicada boolean;
begin
  select exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_lessons'
  ) into publicada;

  if not publicada then
    insert into _errores(msg) values ('Caso 8 (Realtime): ai_lessons no aparece en pg_publication_tables para supabase_realtime.');
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
    raise exception E'ai_lessons.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'ai_lessons.sql: todas las aserciones pasaron.'
