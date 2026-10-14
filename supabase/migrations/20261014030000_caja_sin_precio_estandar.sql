-- ============================================================================
-- La caja ve SOLO el precio promoción: deja de recibir la tarifa de envío MRW
-- (14/10/2026).
--
-- Contexto: 20261013010000 (sección 6) pasó el chequeo de `tarifa_mrw_usd()` a
-- `can_read_inventory()` para que la caja viera el precio estándar (precio +
-- tarifa de envío) en el Inventario. El operador ahora pide lo contrario: la
-- caja ve únicamente el precio promoción. `tarifa_mrw_usd` es `security
-- definer` y lee `shipping_rates` saltándose su RLS, así que ESA función era
-- la fuga: el campo calculado `tarifa_envio_usd(products)` (invoker, sin `set
-- search_path`, inlineable; 20261012010000 sección 4) la llama y hereda el
-- cambio sin tocarlo.
--
-- Decisión de diseño: la caja NO recibe un error, recibe `null`. `PRODUCT_SELECT`
-- pide `tarifa_envio_usd` SIEMPRE: si la función fallara, el Inventario entero
-- dejaría de cargar para la caja. Con `null`, la tarjeta cae a "sin tarifa" y
-- la caja sigue leyendo precio, existencia y peso. Vuelve el chequeo
-- `is_agent()` (que excluye a la caja) con EXACTAMENTE el mismo cuerpo de
-- 20261013010000 sección 6; cambia una sola línea.
--
-- `can_read_inventory()` queda solo para las nueve políticas
-- `<tabla>_select_inventario`; su `comment on function` se corrige.
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

-- ---------------------------------------------------------------------------
-- 1. tarifa_mrw_usd(): vuelve a is_agent(), la caja recibe null
-- ---------------------------------------------------------------------------
create or replace function public.tarifa_mrw_usd(p_peso numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_peso is null or p_peso <= 0 or p_peso >= 80 then null
    when current_setting('role', true) = 'authenticated' and not public.is_agent() then null
    else (
      select r.tarifa_usd
      from public.shipping_rates r
      where r.carrier = 'mrw'
        and r.desde_kg <= p_peso
        and p_peso < r.hasta_kg
    )
  end;
$$;

revoke execute on function public.tarifa_mrw_usd(numeric) from public;
revoke execute on function public.tarifa_mrw_usd(numeric) from anon;
grant execute on function public.tarifa_mrw_usd(numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. can_read_inventory(): ya no la usa tarifa_mrw_usd
-- ---------------------------------------------------------------------------
comment on function public.can_read_inventory() is
  'true si auth.uid() tiene fila en public.agents, con CUALQUIER rol (agent, supervisor, admin o caja). is_agent() excluye a la caja; esta no. Solo la usan las 9 políticas <tabla>_select_inventario; tarifa_mrw_usd ya no la usa (desde 20261014030000, 14/10/2026: la caja no recibe la tarifa de envío).';

-- ---------------------------------------------------------------------------
-- 3. Autoverificación
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc
     where oid = 'public.tarifa_mrw_usd(numeric)'::regprocedure
       and prosecdef
       and prosrc like '%is_agent()%'
       and prosrc not like '%can_read_inventory%'
  ) then
    raise exception '20261014030000: tarifa_mrw_usd debía quedar security definer, con is_agent() y sin can_read_inventory()';
  end if;
  if has_function_privilege('anon', 'public.tarifa_mrw_usd(numeric)', 'EXECUTE') then
    raise exception '20261014030000: anon puede ejecutar tarifa_mrw_usd()';
  end if;
  if not has_function_privilege('authenticated', 'public.tarifa_mrw_usd(numeric)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.tarifa_mrw_usd(numeric)', 'EXECUTE') then
    raise exception '20261014030000: authenticated y service_role deben poder ejecutar tarifa_mrw_usd()';
  end if;

  raise notice '20261014030000: autoverificación correcta (la caja ya no recibe la tarifa de envío).';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
