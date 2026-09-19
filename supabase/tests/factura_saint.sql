-- ===========================================================================
-- La factura Saint y los nueve campos (Tarea M2, plan "Nada sin leer, un
-- solo catálogo y la factura Saint", 18/9/2026)
--
-- Migración bajo prueba: 20260918020000_factura_saint.sql.
--
-- Mismo patrón que catalog_links.sql/ai_lessons.sql: transacción con
-- rollback, tabla temporal `_errores`, un solo `raise exception` al final
-- con todo lo acumulado. No hace falta `set local role`: `orders` no tiene
-- RLS propia en juego para este CHECK (la columna se valida igual sin
-- importar el rol de conexión), así que todos los casos corren como
-- `postgres`.
--
-- Corre en el job `migraciones` de CI, junto a
-- catalog_links.sql/ai_lessons.sql/seba_y_escalada_viva.sql.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- Un contacto de prueba: orders.contact_id es not null. Mismo patrón de
-- número inventado que ai_lessons.sql (`+580000...`), para no chocar con
-- ningún teléfono real de los seeds de demo.
insert into public.contacts (id, phone_number, display_name) values
  ('e1e1e1e1-0000-0000-0000-000000000001', '+580000008001', 'Cliente factura Saint');

-- ---------------------------------------------------------------------------
-- Caso 1 · `'00123'` se acepta tal cual.
-- ---------------------------------------------------------------------------
do $$
declare
  guardado text;
begin
  insert into public.orders (id, contact_id, total_amount, currency, saint_invoice_number) values (
    'e2e2e2e2-0000-0000-0000-000000000001',
    'e1e1e1e1-0000-0000-0000-000000000001',
    100,
    'USD',
    '00123'
  );

  select saint_invoice_number into guardado from public.orders
    where id = 'e2e2e2e2-0000-0000-0000-000000000001';

  if guardado is distinct from '00123' then
    insert into _errores(msg) values (format('Caso 1 (acepta ''00123''): quedó guardado como %L, se esperaba ''00123''.', guardado));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 1 (acepta ''00123''): el insert falló y no debía -- %s', sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · cadena VACÍA rechazada (el CHECK exige 1 a 40 caracteres cuando
-- no es null; una venta sin número Saint debe guardarse como NULL, nunca
-- como '').
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.orders (id, contact_id, total_amount, currency, saint_invoice_number) values (
      'e2e2e2e2-0000-0000-0000-000000000002',
      'e1e1e1e1-0000-0000-0000-000000000001',
      50,
      'USD',
      ''
    );
    se_insertó := true;
  exception
    when check_violation then
      -- Esperado: 23514, orders_saint_invoice_number_check.
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 2 (cadena vacía): el insert se aceptó -- el CHECK no está rechazando ''''.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · texto CON ESPACIOS alrededor rechazado (el CHECK exige el valor
-- ya recortado; el asesor que deja un espacio de más no debe poder guardarlo
-- crudo -- la normalización [`normalizeSaint`] vive en el módulo puro
-- `sale-draft.ts`, no en la base, pero el CHECK es la segunda barrera).
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.orders (id, contact_id, total_amount, currency, saint_invoice_number) values (
      'e2e2e2e2-0000-0000-0000-000000000003',
      'e1e1e1e1-0000-0000-0000-000000000001',
      50,
      'USD',
      ' 00123 '
    );
    se_insertó := true;
  exception
    when check_violation then
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 3 (con espacios alrededor): el insert se aceptó -- el CHECK no está exigiendo el valor recortado.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · 41 caracteres rechazado (el tope es 40, mismo criterio que
-- `ai_playbooks`/`ai_lessons`/`catalog_links.label`).
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.orders (id, contact_id, total_amount, currency, saint_invoice_number) values (
      'e2e2e2e2-0000-0000-0000-000000000004',
      'e1e1e1e1-0000-0000-0000-000000000001',
      50,
      'USD',
      repeat('9', 41)
    );
    se_insertó := true;
  exception
    when check_violation then
      -- Esperado: 23514, orders_saint_invoice_number_check.
      null;
  end;

  if se_insertó then
    insert into _errores(msg) values ('Caso 4 (41 caracteres): el insert se aceptó -- el CHECK no está topando en 40.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · las filas VIEJAS (sin número Saint, ventas anteriores al
-- 18/9/2026) quedan en NULL sin que el CHECK las toque -- D9: la columna
-- nace nullable justo para esto.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  guardado text;
begin
  insert into public.orders (id, contact_id, total_amount, currency) values (
    'e2e2e2e2-0000-0000-0000-000000000005',
    'e1e1e1e1-0000-0000-0000-000000000001',
    75,
    'USD'
  );

  select count(*) into n from public.orders
    where id = 'e2e2e2e2-0000-0000-0000-000000000005';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 5 (venta vieja sin Saint): %s fila(s) encontradas, se esperaba 1.', n));
  end if;

  select saint_invoice_number into guardado from public.orders
    where id = 'e2e2e2e2-0000-0000-0000-000000000005';
  if guardado is not null then
    insert into _errores(msg) values (format('Caso 5 (venta vieja sin Saint): saint_invoice_number = %L, se esperaba NULL.', guardado));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 5 (venta vieja sin Saint): el insert sin la columna falló y no debía -- %s', sqlerrm));
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
    raise exception E'factura_saint.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'factura_saint.sql: todas las aserciones pasaron.'
