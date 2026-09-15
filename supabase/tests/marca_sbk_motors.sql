-- ===========================================================================
-- La base dice SBK Motors donde decía SBK Motorcycles (Tarea 1, plan "La voz
-- de mostrador con nombre propio y el cierre de v1.1", 15/9/2026)
--
-- Migración bajo prueba: 20260915010000_marca_sbk_motors.sql.
--
-- Tres casos:
--   1. Cero filas con "SBK Motorcycles" en knowledge_categories,
--      knowledge_entries y ai_playbooks -- lo que deja la migración al
--      aplicarse sobre los datos reales de la base (seed + lo sembrado por
--      20260825020000_knowledge_base.sql).
--   2. La categoría "La tienda" (sembrada con "SBK Motorcycles" en su
--      description desde 20260825020000) existe y su description ya dice
--      "SBK Motors" -- el caso concreto que motivó la tarea.
--   3. Idempotencia real: se inserta una categoría de prueba con el nombre
--      viejo EN el texto (no solo el título), se reaplica la sentencia de la
--      migración con `\i` sobre esa fila nueva, y se comprueba que quedó en
--      "SBK Motors" -- una segunda pasada de una migración ya aplicada no
--      debe fallar ni dejar el nombre viejo en datos sembrados después.
--
-- Todo en una transacción con rollback: no ensucia la base. `\i` no puede ir
-- dentro de un bloque plpgsql (igual que preview_en_espanol.sql y
-- ventana_24h.sql), así que el caso 3 queda repartido en bloques `do $$`
-- alrededor de la línea `\i` suelta. Los errores de todos los bloques se
-- acumulan en una tabla temporal y se revisan al final, una sola vez.
--
-- Para correrlo LOCAL contra el contenedor (psql no vive en el host, y el
-- repo no está montado dentro del contenedor): `docker cp` la carpeta
-- `supabase/` del repo a `/tmp/repo/supabase` dentro del contenedor y corré
-- `psql -f supabase/tests/marca_sbk_motors.sql` con
-- `docker exec -w /tmp/repo <contenedor> ...` -- el `\i` de abajo, igual que
-- en CI, resuelve su ruta relativa al cwd de psql (repo root), no al
-- directorio del script que lo contiene.
--
-- Corre en el job `migraciones` de CI.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- ---------------------------------------------------------------------------
-- Caso 1 · cero filas con el nombre viejo, sobre los datos reales de la base
-- (la migración ya corrió al construir la base, igual que cualquier otra).
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from public.knowledge_categories
    where name like '%SBK Motorcycles%' or description like '%SBK Motorcycles%';
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('caso 1: knowledge_categories todavía tiene %s fila(s) con "SBK Motorcycles".', v_count));
  end if;

  select count(*) into v_count
    from public.knowledge_entries
    where title like '%SBK Motorcycles%' or content like '%SBK Motorcycles%';
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('caso 1: knowledge_entries todavía tiene %s fila(s) con "SBK Motorcycles".', v_count));
  end if;

  select count(*) into v_count
    from public.ai_playbooks
    where trigger_description like '%SBK Motorcycles%' or response_text like '%SBK Motorcycles%';
  if v_count is distinct from 0 then
    insert into _errores(msg) values (format('caso 1: ai_playbooks todavía tiene %s fila(s) con "SBK Motorcycles".', v_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · la categoría "La tienda" existe y su description dice "SBK Motors"
-- ---------------------------------------------------------------------------
do $$
declare
  v_description text;
begin
  select description into v_description
    from public.knowledge_categories
    where name = 'La tienda';

  if v_description is null then
    insert into _errores(msg) values ('caso 2: no se encontró la categoría "La tienda" (¿se renombró o se borró?).');
  elsif v_description not like '%SBK Motors%' then
    insert into _errores(msg) values (format('caso 2: la description de "La tienda" no contiene "SBK Motors" (quedó: %L).', v_description));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · idempotencia: una categoría sembrada DESPUÉS de que la base ya
-- corrió la migración una vez también queda corregida al reaplicarla.
-- ---------------------------------------------------------------------------
insert into public.knowledge_categories (id, name, description) values
  ('66666666-6666-6666-6666-666666666601', 'Prueba marca_sbk_motors', 'Datos generales de SBK Motorcycles para verificar el replace.');

\i supabase/migrations/20260915010000_marca_sbk_motors.sql

do $$
declare
  v_description text;
begin
  select description into v_description
    from public.knowledge_categories
    where id = '66666666-6666-6666-6666-666666666601';

  if v_description is distinct from 'Datos generales de SBK Motors para verificar el replace.' then
    insert into _errores(msg) values (format('caso 3 (idempotencia, primera reaplicación): description quedó en %L, se esperaba "Datos generales de SBK Motors para verificar el replace.".', v_description));
  end if;
end $$;

-- Reaplicar una segunda vez: ninguna fila ya corregida debe volver a moverse
-- ni la migración debe fallar por no encontrar nada que reemplazar.
\i supabase/migrations/20260915010000_marca_sbk_motors.sql

do $$
declare
  v_description text;
begin
  select description into v_description
    from public.knowledge_categories
    where id = '66666666-6666-6666-6666-666666666601';

  if v_description is distinct from 'Datos generales de SBK Motors para verificar el replace.' then
    insert into _errores(msg) values (format('caso 3 (idempotencia, segunda reaplicación): description quedó en %L, se esperaba que siguiera en "Datos generales de SBK Motors para verificar el replace.".', v_description));
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
    raise exception E'marca_sbk_motors.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'marca_sbk_motors.sql: todas las aserciones pasaron.'
