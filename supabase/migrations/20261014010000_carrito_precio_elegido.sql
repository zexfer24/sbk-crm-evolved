-- ============================================================================
-- El carrito del chat recuerda qué precio se cobra por renglón (14/10/2026).
--
-- Contexto: el carrito persistente (20260929010000) guarda solo producto y
-- cantidad, y el precio se calcula al mirar y al facturar (D6: el vigente,
-- nunca una copia). El operador pidió (14/10/2026) que el asesor elija, POR
-- RENGLÓN, si ese repuesto se cobra al precio de promoción o al precio
-- estándar (promoción + envío MRW, la tarifa por peso de 20261012010000).
-- Un repuesto sigue siendo un solo renglón: `unique (conversation_id,
-- product_id)` NO cambia; lo que cambia es qué precio se le aplica.
--
-- `price_kind`:
--   · 'promocion' (default): el precio de siempre, `productPriceUsd` +
--     `usdFromBs`. Todo renglón existente queda así, sin backfill.
--   · 'estandar': el precio de promoción MÁS la tarifa de envío MRW por peso,
--     calculada AL LEER con `tarifa_envio_usd` (mismo criterio que el
--     Inventario). Sigue sin guardarse ningún precio: si Saint cambia el
--     precio o la tarifa cambia, el renglón cobra el vigente.
--
-- Un `add column ... not null default` con default constante no reescribe la
-- tabla en Postgres 11+ (solo toca el catálogo), así que el lock es breve. La
-- tabla ya está en `supabase_realtime` con `replica identity full`; agregar una
-- columna no cambia eso, pero la autoverificación lo reconfirma (un canal sobre
-- una tabla no publicada calla para siempre).
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

alter table public.conversation_cart_items
  add column price_kind text not null default 'promocion'
  constraint conversation_cart_items_price_kind_check
  check (price_kind in ('promocion', 'estandar'));

comment on column public.conversation_cart_items.price_kind is
  'Qué precio se cobra por este renglón: ''promocion'' (el de siempre) o ''estandar'' (precio de promoción + tarifa de envío MRW por peso, calculada al leer con tarifa_envio_usd). No se guarda ningún precio: se calcula el vigente (14/10/2026).';

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'conversation_cart_items'
      and column_name = 'price_kind' and is_nullable = 'NO'
  ) then
    raise exception '20261014010000: falta la columna conversation_cart_items.price_kind (not null)';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.conversation_cart_items'::regclass
      and conname = 'conversation_cart_items_price_kind_check'
  ) then
    raise exception '20261014010000: falta el CHECK conversation_cart_items_price_kind_check';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'conversation_cart_items'
  ) then
    raise exception '20261014010000: conversation_cart_items dejó de estar en supabase_realtime';
  end if;

  raise notice '20261014010000: autoverificación de price_kind correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la columna nueva da
-- 400 hasta que alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
