-- ============================================================================
-- Tarea M2 · "La factura Saint y los nueve campos" -- plan "Nada sin leer, un
-- solo catálogo y la factura Saint" (aprobado 18/9/2026).
--
-- Historia (exploración del 18/9, D9 del plan): el cliente pidió que "Cerrar
-- venta" exija, entre otros, el "Número de factura Saint" -- el número que
-- Saint (el sistema administrativo del negocio) le asigna a la factura real
-- que se emite en el mostrador. Hasta esta migración `orders` no tenía
-- ninguna columna de referencia externa: el dinero de la venta vivía en
-- `orders`, el método de pago y el comprobante en `conversations.deal_*`, el
-- cliente en `contacts`, y el correlativo interno de la factura del CRM
-- (`invoices.number`, "SBK-000123") es un número DISTINTO que no debe
-- confundirse con el de Saint -- son dos sistemas, dos numeraciones.
--
-- `saint_invoice_number` nace NULLABLE en base porque las ventas cerradas
-- ANTES del 18/9/2026 no tienen ese dato y no hay forma de reconstruirlo
-- (D9); el modal de Cerrar venta (T5 de este mismo plan, código aparte) lo
-- exige como obligatorio para toda venta nueva. Sin restricción de unicidad
-- a propósito (D9): una misma factura Saint puede cubrir más de un chat (el
-- mostrador a veces cobra junto lo que el CRM registró como dos
-- conversaciones separadas), y un rechazo por duplicado en el momento de
-- cerrar confundiría al asesor más de lo que protegería.
-- ============================================================================

alter table public.orders
  add column saint_invoice_number text;

alter table public.orders
  add constraint orders_saint_invoice_number_check
  check (
    saint_invoice_number is null
    or (
      saint_invoice_number = btrim(saint_invoice_number)
      and char_length(saint_invoice_number) between 1 and 40
    )
  );

comment on column public.orders.saint_invoice_number is
  'Número de la factura emitida en Saint, el sistema administrativo del negocio -- NO es `invoices.number` (el correlativo interno del CRM, "SBK-000123"): son dos numeraciones distintas de dos sistemas distintos (D9, plan "Nada sin leer, un solo catálogo y la factura Saint", 18/9/2026). Nullable porque las ventas cerradas antes del 18/9/2026 no lo tienen; el modal "Cerrar venta" lo exige como obligatorio para toda venta nueva. Sin unicidad a propósito: una factura Saint puede cubrir más de un chat, y un rechazo por duplicado en el mostrador confundiría más de lo que protege. El CHECK exige el texto recortado (sin espacios sueltos alrededor) y de 1 a 40 caracteres cuando no es null.';

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (information_schema/pg_constraint),
-- no el texto de este archivo -- mismo criterio que 20260918010000
-- (catalog_links) y el resto de las migraciones recientes (ver CLAUDE.md,
-- "Cerrar una función security definer...": el mismo principio de no confiar
-- en el .sql aplica a cualquier verificación de esquema).
-- ---------------------------------------------------------------------------
do $$
declare
  col_exists boolean;
  col_nullable text;
  check_count integer;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'saint_invoice_number'
  ) into col_exists;

  if not col_exists then
    raise exception '20260918020000: public.orders.saint_invoice_number no quedó creada';
  end if;

  select is_nullable into col_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'saint_invoice_number';

  if col_nullable is distinct from 'YES' then
    raise exception '20260918020000: orders.saint_invoice_number debía quedar nullable (ventas anteriores al 18/9/2026 no la tienen), encontró is_nullable = %', col_nullable;
  end if;

  select count(*) into check_count
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_saint_invoice_number_check';

  if check_count is distinct from 1 then
    raise exception '20260918020000: orders_saint_invoice_number_check no quedó creado (encontrados: %)', check_count;
  end if;

  raise notice '20260918020000: autoverificación de orders.saint_invoice_number (columna nullable + CHECK) correcta.';
end
$$;
