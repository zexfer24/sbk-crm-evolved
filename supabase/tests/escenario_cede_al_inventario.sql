-- ===========================================================================
-- "El repuesto manda, con permiso del supervisor" (Tarea T1, plan "El
-- catálogo configurado sale siempre", 21/9/2026)
--
-- Migración bajo prueba: 20260921010000_escenario_cede_al_inventario.sql.
--
-- Mismo patrón que catalog_links.sql/ai_lessons.sql: transacción con
-- rollback, tabla temporal `_errores`, un solo `raise exception` al final
-- con todo lo acumulado. La parte de RLS corre con `set local role
-- authenticated` + `set local "request.jwt.claim.sub"` para que las
-- políticas se evalúen como en producción, no como el rol `postgres` (que no
-- tiene RLS activa y escondería cualquier agujero de la política). No hace
-- falta crear la política de escritura: `ai_playbooks_write` ya existe desde
-- 20260821010000 y ya exige `is_supervisor_or_admin()` para TODA la tabla,
-- columna nueva incluida -- este test verifica justamente que eso siga
-- siendo cierto para `cede_al_inventario`, no que exista una política nueva.
--
-- Corre en el job `migraciones` de CI, junto a
-- catalog_links.sql/ai_lessons.sql/factura_saint.sql/seba_y_escalada_viva.sql.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- La tabla temporal la crea el rol de conexión (postgres); los casos que
-- corren bajo `set local role authenticated` más abajo necesitan poder
-- anotar un error sin que la propia tabla de errores tire "permission
-- denied for table _errores" -- mismo hallazgo que ai_lessons.sql/
-- catalog_links.sql.
grant insert on _errores to authenticated;

-- Dos agentes de prueba: A (asesor corriente) y S (supervisor).
insert into auth.users (id, email, raw_user_meta_data) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'agente-a-cede-inventario@sbk.test', jsonb_build_object('display_name', 'Agente A (cede al inventario)')),
  ('c1c1c1c1-0000-0000-0000-000000000002', 'agente-s-cede-inventario@sbk.test', jsonb_build_object('display_name', 'Agente S (cede al inventario, supervisor)'));

update public.agents set role = 'supervisor' where id = 'c1c1c1c1-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- Caso 1 · la columna existe, es NOT NULL y su DEFAULT es `false` -- lee el
-- catálogo real (information_schema), no confía en que la migración haya
-- corrido "a ojo".
-- ---------------------------------------------------------------------------
do $$
declare
  col_exists boolean;
  col_nullable text;
  col_default text;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_playbooks'
      and column_name = 'cede_al_inventario'
  ) into col_exists;

  if not col_exists then
    insert into _errores(msg) values ('Caso 1 (columna existe): public.ai_playbooks.cede_al_inventario no existe.');
  else
    select is_nullable, column_default into col_nullable, col_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'ai_playbooks'
        and column_name = 'cede_al_inventario';

    if col_nullable is distinct from 'NO' then
      insert into _errores(msg) values (format('Caso 1 (columna NOT NULL): is_nullable = %L, se esperaba ''NO''.', col_nullable));
    end if;

    if col_default is distinct from 'false' then
      insert into _errores(msg) values (format('Caso 1 (DEFAULT false): column_default = %L, se esperaba ''false''.', col_default));
    end if;
  end if;
end $$;

-- A partir de acá se corre como el supervisor S correría desde el panel.
set local role authenticated;
set local "request.jwt.claim.sub" = 'c1c1c1c1-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- Caso 2 · un insert sin nombrar la columna queda en `false` -- el default
-- cubre tanto las filas viejas (backfill implícito) como cualquier escenario
-- nuevo que el panel cree sin tocar la casilla.
-- ---------------------------------------------------------------------------
do $$
declare
  guardado boolean;
begin
  insert into public.ai_playbooks (id, name, trigger_description, response_text) values (
    'c2c2c2c2-0000-0000-0000-000000000001',
    'Escenario de prueba (sin marcar)',
    'cuando el cliente pregunta algo que no calza con nada más',
    'Un asesor te va a atender enseguida.'
  );

  select cede_al_inventario into guardado from public.ai_playbooks
    where id = 'c2c2c2c2-0000-0000-0000-000000000001';

  if guardado is distinct from false then
    insert into _errores(msg) values (format('Caso 2 (insert sin nombrar la columna): quedó guardado como %L, se esperaba false.', guardado));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 2 (insert sin nombrar la columna): el insert del supervisor S falló y no debía -- %s', sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · el supervisor S SÍ puede marcar un escenario en `true` -- es
-- justo la acción que T4 (el panel) le da: "Catálogo general" se marca a
-- mano para que ceda al inventario.
-- ---------------------------------------------------------------------------
do $$
declare
  filas integer;
  guardado boolean;
begin
  update public.ai_playbooks set cede_al_inventario = true
    where id = 'c2c2c2c2-0000-0000-0000-000000000001';
  get diagnostics filas = row_count;
  if filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 3 (UPDATE de supervisor): afectó %s fila(s), se esperaba 1.', filas));
  end if;

  select cede_al_inventario into guardado from public.ai_playbooks
    where id = 'c2c2c2c2-0000-0000-0000-000000000001';
  if guardado is distinct from true then
    insert into _errores(msg) values (format('Caso 3 (UPDATE de supervisor): cede_al_inventario = %L, se esperaba true.', guardado));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · un asesor corriente (A, ni supervisor) puede LEER la columna
-- (`ai_playbooks_select` exige solo `is_agent()`) pero NO puede marcarla --
-- ni en un insert nuevo, ni en un UPDATE sobre el escenario que dejó S.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c1c1c1c1-0000-0000-0000-000000000001';

do $$
declare
  leido boolean;
  se_insertó boolean := false;
  filas integer;
  sigue_true boolean;
begin
  -- Lectura: A ve el valor que dejó el supervisor.
  select cede_al_inventario into leido from public.ai_playbooks
    where id = 'c2c2c2c2-0000-0000-0000-000000000001';
  if leido is distinct from true then
    insert into _errores(msg) values (format('Caso 4 (lectura de A): cede_al_inventario = %L, se esperaba true -- un asesor corriente debería poder leer ai_playbooks.', leido));
  end if;

  -- Escritura (insert): rechazada por la política ai_playbooks_write, que
  -- exige is_supervisor_or_admin() para TODA la tabla, no solo para esta
  -- columna -- confirma que la columna nueva no abrió un agujero.
  begin
    insert into public.ai_playbooks (id, name, trigger_description, response_text, cede_al_inventario) values (
      'c2c2c2c2-0000-0000-0000-000000000004',
      'Escenario de A (no debería crearse)',
      'cuando A intenta colarse',
      'Texto que no debería llegar a nadie.',
      true
    );
    se_insertó := true;
  exception
    when insufficient_privilege then
      -- Esperado: 42501, "new row violates row-level security policy".
      null;
  end;
  if se_insertó then
    insert into _errores(msg) values ('Caso 4 (insert de A): un asesor corriente pudo crear un escenario -- ai_playbooks_write no está restringiendo a supervisor/admin.');
  end if;

  -- Escritura (update): 0 filas afectadas, el valor de S sigue en true.
  update public.ai_playbooks set cede_al_inventario = false
    where id = 'c2c2c2c2-0000-0000-0000-000000000001';
  get diagnostics filas = row_count;
  if filas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 4 (update de A): afectó %s fila(s), se esperaban 0.', filas));
  end if;

  select cede_al_inventario into sigue_true from public.ai_playbooks
    where id = 'c2c2c2c2-0000-0000-0000-000000000001';
  if sigue_true is distinct from true then
    insert into _errores(msg) values (format('Caso 4 (update de A): cede_al_inventario quedó en %L -- el intento de A no debía cambiar nada.', sigue_true));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

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
    raise exception E'escenario_cede_al_inventario.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'escenario_cede_al_inventario.sql: todas las aserciones pasaron.'
