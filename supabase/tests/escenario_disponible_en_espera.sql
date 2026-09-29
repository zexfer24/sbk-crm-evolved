-- ===========================================================================
-- "Los escenarios que pueden salir mientras el cliente espera al asesor"
-- (Tarea T5, plan "Seba encuentra, no insiste, y el mostrador no deja a
-- nadie esperando", 28/9/2026, decisión D7)
--
-- Migración bajo prueba: 20260928030000_escenario_disponible_en_espera.sql.
--
-- Mismo patrón que escenario_cede_al_inventario.sql: transacción con
-- rollback, tabla temporal `_errores`, un solo `raise exception` al final.
--
-- La migración marca por NOMBRE (sin acentos ni mayúsculas) tres escenarios:
-- Ubicación, Envio gratis Cashea y Postventa Cashea. Como el backfill ya
-- corrió en la base sobre la que se prueba, el test reaplica la migración
-- con `\i` dentro de la transacción, después de sembrar las filas de prueba
-- (variantes de acento y mayúsculas, y tres que NO deben marcarse: REDES,
-- Catálogo general y un nombre que solo EMPIEZA igual que "Ubicación"). Como
-- usa `\i`, hay que correrlo con el repo copiado dentro del contenedor (ver
-- CLAUDE.md, "Un test de supabase/tests/ que hace \i de una migración NO se
-- puede correr con docker exec -i ... -f -").
--
-- Los nombres reales que ya existan en la base (escenarios de producción o
-- del seed) se ignoran: el test cuenta SOLO sus propias filas, por id.
--
-- Nota: la migración trae su propio `set local lock_timeout` y su guarda
-- contra el no-op; este test corre con `psql -1`, así que la guarda pasa.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- ---------------------------------------------------------------------------
-- Caso 1 · la columna existe, es NOT NULL y su DEFAULT es `false`.
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
      and column_name = 'disponible_en_espera'
  ) into col_exists;

  if not col_exists then
    insert into _errores(msg) values ('Caso 1 (columna existe): public.ai_playbooks.disponible_en_espera no existe.');
  else
    select is_nullable, column_default into col_nullable, col_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'ai_playbooks'
        and column_name = 'disponible_en_espera';

    if col_nullable is distinct from 'NO' then
      insert into _errores(msg) values (format('Caso 1 (NOT NULL): is_nullable = %L, se esperaba ''NO''.', col_nullable));
    end if;

    if col_default is distinct from 'false' then
      insert into _errores(msg) values (format('Caso 1 (DEFAULT false): column_default = %L, se esperaba ''false''.', col_default));
    end if;
  end if;
end $$;

-- Si la columna no existe (test en rojo) se corta acá, con un mensaje claro,
-- en vez de fallar más abajo con un error de SQL que no dice qué falta.
do $$
begin
  if exists (select 1 from _errores) then
    raise exception E'escenario_disponible_en_espera.sql roto: %', (select string_agg(msg, E'\n  - ') from _errores);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Siembra: `ai_playbooks.name` es UNIQUE y la base local ya trae escenarios
-- con estos nombres (seed), así que primero se borran los que chocan -- todo
-- dentro de la transacción que termina en rollback.
-- ---------------------------------------------------------------------------
delete from public.ai_playbooks
 where name in ('Ubicación', 'UBICACION', 'Envio gratis Cashea', 'ENVÍO GRATIS CASHEA', 'postventa cashea',
                'REDES', 'Catálogo general', 'Ubicación de repuestos especiales', 'Envio Gratis Cashea');

-- Siembra: cinco escenarios que DEBEN marcarse (variantes de acento y
-- mayúsculas de los tres nombres) y tres que NO.
-- ---------------------------------------------------------------------------
insert into public.ai_playbooks (id, name, trigger_description, response_text) values
  ('d7d7d7d7-0000-0000-0000-000000000001', 'Ubicación',           'pregunta dónde queda la tienda',      'Estamos en Barinas.'),
  ('d7d7d7d7-0000-0000-0000-000000000002', 'UBICACION',           'pregunta dónde queda la tienda (2)',  'Estamos en Barinas.'),
  ('d7d7d7d7-0000-0000-0000-000000000003', 'Envio gratis Cashea', 'pregunta por envío con Cashea',       'El envío con Cashea es gratis.'),
  ('d7d7d7d7-0000-0000-0000-000000000004', 'ENVÍO GRATIS CASHEA', 'pregunta por envío con Cashea (2)',   'El envío con Cashea es gratis.'),
  ('d7d7d7d7-0000-0000-0000-000000000005', 'postventa cashea',    'pregunta por la postventa de Cashea', 'La postventa de Cashea la atiende un asesor.'),
  ('d7d7d7d7-0000-0000-0000-000000000006', 'REDES',               'pide las redes sociales',             'Síguenos en redes.'),
  ('d7d7d7d7-0000-0000-0000-000000000007', 'Catálogo general',    'pide el catálogo',                    'Acá va el catálogo.'),
  ('d7d7d7d7-0000-0000-0000-000000000008', 'Ubicación de repuestos especiales', 'nombre que solo empieza igual', 'Texto de prueba.');

-- Caso 2 · antes del backfill todas las filas sembradas están en el default.
do $$
declare
  marcadas integer;
begin
  select count(*) into marcadas from public.ai_playbooks
    where id::text like 'd7d7d7d7-%' and disponible_en_espera;
  if marcadas <> 0 then
    insert into _errores(msg) values (format('Caso 2 (default): %s fila(s) sembradas nacieron con disponible_en_espera = true, se esperaban 0.', marcadas));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reaplicar la migración (idempotente): el backfill marca por nombre.
-- ---------------------------------------------------------------------------
\i supabase/migrations/20260928030000_escenario_disponible_en_espera.sql

-- Caso 3 · el backfill marcó las cinco variantes de los tres nombres...
do $$
declare
  faltan text;
begin
  select string_agg(name, ', ' order by id) into faltan from public.ai_playbooks
    where id::text in (
      'd7d7d7d7-0000-0000-0000-000000000001', 'd7d7d7d7-0000-0000-0000-000000000002',
      'd7d7d7d7-0000-0000-0000-000000000003', 'd7d7d7d7-0000-0000-0000-000000000004',
      'd7d7d7d7-0000-0000-0000-000000000005'
    ) and not disponible_en_espera;
  if faltan is not null then
    insert into _errores(msg) values (format('Caso 3 (backfill por nombre): no marcó %s.', faltan));
  end if;
end $$;

-- Caso 4 · ...y NO marcó REDES, Catálogo general ni un nombre que solo
-- empieza igual que "Ubicación".
do $$
declare
  sobran text;
begin
  select string_agg(name, ', ' order by id) into sobran from public.ai_playbooks
    where id::text in (
      'd7d7d7d7-0000-0000-0000-000000000006', 'd7d7d7d7-0000-0000-0000-000000000007',
      'd7d7d7d7-0000-0000-0000-000000000008'
    ) and disponible_en_espera;
  if sobran is not null then
    insert into _errores(msg) values (format('Caso 4 (no marcar de más): marcó %s y no debía.', sobran));
  end if;
end $$;

-- Caso 5 · un insert nuevo sin nombrar la columna queda en false, incluso
-- con un nombre de la lista (el backfill es de una sola vez, no un trigger).
do $$
declare
  guardado boolean;
begin
  insert into public.ai_playbooks (id, name, trigger_description, response_text) values
    ('d7d7d7d7-0000-0000-0000-000000000009', 'Envio Gratis Cashea', 'creado después del backfill', 'Texto de prueba.');
  select disponible_en_espera into guardado from public.ai_playbooks
    where id = 'd7d7d7d7-0000-0000-0000-000000000009';
  if guardado is distinct from false then
    insert into _errores(msg) values (format('Caso 5 (insert posterior): disponible_en_espera = %L, se esperaba false.', guardado));
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
    raise exception E'escenario_disponible_en_espera.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'escenario_disponible_en_espera.sql: todas las aserciones pasaron.'
