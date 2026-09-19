-- ===========================================================================
-- Un solo catálogo (Tarea M1, plan "Nada sin leer, un solo catálogo y la
-- factura Saint", 18/9/2026)
--
-- Migración bajo prueba: 20260918010000_catalog_links.sql.
--
-- Mismo patrón que ai_lessons.sql/devolucion_a_la_ia.sql: transacción con
-- rollback, tabla temporal `_errores`, un solo `raise exception` al final
-- con todo lo acumulado. La parte de RLS corre con `set local role
-- authenticated` + `set local "request.jwt.claim.sub"` para que las
-- políticas se evalúen como en producción, no como el rol `postgres` (que
-- no tiene RLS activa y escondería cualquier agujero de la política).
--
-- Dos agentes de prueba: A (asesor corriente -- prueba que RLS le deja leer
-- pero no escribir) y S (supervisor -- prueba que sí puede crear, editar y
-- borrar). `handle_new_agent()` crea la fila espejo en public.agents con
-- role='agent' por default; S se sube a 'supervisor' con un UPDATE directo
-- (como postgres, antes de que ningún `set local role` esté activo).
--
-- Corre en el job `migraciones` de CI, junto a
-- ai_lessons.sql/devolucion_a_la_ia.sql/seba_y_escalada_viva.sql.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- La tabla temporal la crea el rol de conexión (postgres); los casos que
-- corren bajo `set local role authenticated` más abajo necesitan poder
-- anotar un error sin que la propia tabla de errores tire "permission
-- denied for table _errores" -- mismo hallazgo que ai_lessons.sql.
grant insert on _errores to authenticated;

-- Dos agentes de prueba.
insert into auth.users (id, email, raw_user_meta_data) values
  ('d1d1d1d1-0000-0000-0000-000000000001', 'agente-a-catalogos@sbk.test', jsonb_build_object('display_name', 'Agente A (catálogos)')),
  ('d1d1d1d1-0000-0000-0000-000000000002', 'agente-s-catalogos@sbk.test', jsonb_build_object('display_name', 'Agente S (catálogos, supervisor)'));

update public.agents set role = 'supervisor' where id = 'd1d1d1d1-0000-0000-0000-000000000002';

-- A partir de acá se corre como el supervisor S correría desde el panel.
set local role authenticated;
set local "request.jwt.claim.sub" = 'd1d1d1d1-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- Caso 1 · el supervisor S crea un catálogo válido -- OK.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  insert into public.catalog_links (id, key, label, url, sort_order, updated_by) values (
    'd2d2d2d2-0000-0000-0000-000000000001',
    'cascos',
    'Cascos',
    'https://drive.google.com/file/d/1iz77Lc00000000000000000000000000/view',
    1,
    'd1d1d1d1-0000-0000-0000-000000000002'
  );

  select count(*) into n from public.catalog_links
    where id = 'd2d2d2d2-0000-0000-0000-000000000001';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (insert de supervisor): %s fila(s) encontradas, se esperaba 1.', n));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 1 (insert de supervisor): el insert del supervisor S falló y no debía -- %s', sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · clave con MAYÚSCULA rechazada por el CHECK de `key`.
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.catalog_links (id, key, label, url, updated_by) values (
      'd2d2d2d2-0000-0000-0000-000000000002',
      'Cascos-Mayuscula',
      'Cascos con mayúscula -- no debería pasar',
      'https://drive.google.com/file/d/2/view',
      'd1d1d1d1-0000-0000-0000-000000000002'
    );
    se_insertó := true;
  exception
    when check_violation then
      -- Esperado: 23514, el CHECK inline de key (`^[a-z0-9-]{1,30}$`).
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 2 (clave con mayúscula): el insert se aceptó -- el CHECK de key no está frenando mayúsculas.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · clave con ESPACIO rechazada por el mismo CHECK.
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.catalog_links (id, key, label, url, updated_by) values (
      'd2d2d2d2-0000-0000-0000-000000000003',
      'cascos con espacio',
      'Cascos con espacio -- no debería pasar',
      'https://drive.google.com/file/d/3/view',
      'd1d1d1d1-0000-0000-0000-000000000002'
    );
    se_insertó := true;
  exception
    when check_violation then
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 3 (clave con espacio): el insert se aceptó -- el CHECK de key no está frenando espacios.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · URL sin esquema (`http(s)://`) rechazada por el CHECK de `url`.
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.catalog_links (id, key, label, url, updated_by) values (
      'd2d2d2d2-0000-0000-0000-000000000004',
      'resonadores',
      'Resonadores',
      'drive.google.com/file/d/4/view',
      'd1d1d1d1-0000-0000-0000-000000000002'
    );
    se_insertó := true;
  exception
    when check_violation then
      -- Esperado: 23514, el CHECK inline de url (`^https?://`).
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 4 (URL sin esquema): el insert se aceptó -- el CHECK de url no está exigiendo http(s)://.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · clave REPETIDA rechazada por la restricción unique de `key`.
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.catalog_links (id, key, label, url, updated_by) values (
      'd2d2d2d2-0000-0000-0000-000000000005',
      'cascos',
      'Cascos (duplicado)',
      'https://drive.google.com/file/d/5/view',
      'd1d1d1d1-0000-0000-0000-000000000002'
    );
    se_insertó := true;
  exception
    when unique_violation then
      -- Esperado: 23505, catalog_links_key_key.
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 5 (clave repetida): el insert se aceptó -- la clave "cascos" no es única.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · el supervisor S SÍ puede actualizar (cambia la URL, que es
-- justo el problema que esta tabla resuelve: la rotación de Drive se
-- corrige en un solo sitio) y borrar.
-- ---------------------------------------------------------------------------
do $$
declare
  filas integer;
  url_actual text;
begin
  update public.catalog_links set url = 'https://drive.google.com/file/d/1nuevo000000000000000000000000000/view'
    where id = 'd2d2d2d2-0000-0000-0000-000000000001';
  get diagnostics filas = row_count;
  if filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 6 (UPDATE de supervisor): afectó %s fila(s), se esperaba 1.', filas));
  end if;

  select url into url_actual from public.catalog_links where id = 'd2d2d2d2-0000-0000-0000-000000000001';
  if url_actual is distinct from 'https://drive.google.com/file/d/1nuevo000000000000000000000000000/view' then
    insert into _errores(msg) values (format('Caso 6 (UPDATE de supervisor): url = %s, se esperaba la URL nueva.', url_actual));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7 · un asesor corriente (A, ni supervisor) SÍ puede LEER (is_agent())
-- pero NO puede escribir -- ni crear, ni editar, ni borrar.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'd1d1d1d1-0000-0000-0000-000000000001';

do $$
declare
  n integer;
  se_insertó boolean := false;
  filas integer;
begin
  -- Lectura: A ve el catálogo que dejó el supervisor.
  select count(*) into n from public.catalog_links where id = 'd2d2d2d2-0000-0000-0000-000000000001';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 7 (lectura de A): %s fila(s) encontradas, se esperaba 1 -- un asesor corriente debería poder leer catalog_links.', n));
  end if;

  -- Escritura (insert): rechazada por la política catalog_links_write.
  begin
    insert into public.catalog_links (id, key, label, url, updated_by) values (
      'd2d2d2d2-0000-0000-0000-000000000007',
      'defensas',
      'Defensas',
      'https://drive.google.com/file/d/7/view',
      'd1d1d1d1-0000-0000-0000-000000000001'
    );
    se_insertó := true;
  exception
    when insufficient_privilege then
      -- Esperado: 42501, "new row violates row-level security policy".
      null;
  end;
  if se_insertó then
    insert into _errores(msg) values ('Caso 7 (insert de A): un asesor corriente pudo crear un catálogo -- catalog_links_write no está restringiendo a supervisor/admin.');
  end if;

  -- Escritura (update): 0 filas afectadas, la de S sigue igual.
  update public.catalog_links set label = 'Editado por A -- no debería pasar'
    where id = 'd2d2d2d2-0000-0000-0000-000000000001';
  get diagnostics filas = row_count;
  if filas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7 (update de A): afectó %s fila(s), se esperaban 0.', filas));
  end if;

  -- Escritura (delete): 0 filas afectadas.
  delete from public.catalog_links where id = 'd2d2d2d2-0000-0000-0000-000000000001';
  get diagnostics filas = row_count;
  if filas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7 (delete de A): afectó %s fila(s), se esperaban 0.', filas));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 8 · `anon` (sin sesión) no lee nada: aunque el grant de tabla exista
-- (`has_table_privilege`, heredado de las default privileges que Supabase
-- deja para el rol de conexión -- ver CLAUDE.md sobre las dos vías de
-- privilegio), la RLS de catalog_links_select exige is_agent(), y anon no
-- tiene fila en public.agents -- 0 filas visibles de verdad.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  set local role anon;
  select count(*) into n from public.catalog_links;
  reset role;

  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 8 (anon lee): anon vio %s fila(s) de catalog_links, se esperaban 0 -- la RLS no lo está bloqueando.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 9 · catalog_links quedó publicada en supabase_realtime (mismo
-- criterio que 20260909050000/20260917020000: suscribirse a un canal muerto
-- no falla, calla para siempre -- esto es lo único que distingue las dos
-- situaciones).
-- ---------------------------------------------------------------------------
do $$
declare
  publicada boolean;
begin
  select exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'catalog_links'
  ) into publicada;

  if not publicada then
    insert into _errores(msg) values ('Caso 9 (Realtime): catalog_links no aparece en pg_publication_tables para supabase_realtime.');
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
    raise exception E'catalog_links.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'catalog_links.sql: todas las aserciones pasaron.'
