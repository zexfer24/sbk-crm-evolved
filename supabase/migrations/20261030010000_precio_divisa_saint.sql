-- ============================================================================
-- Precio divisa = `SAPROD.Precio1` de SAINT, expuesto como campo calculado
-- (30/10/2026).
--
-- Contexto: SAINT lleva por producto un "precio divisa" (`Precio1`, en USD) que
-- el negocio quiere ver en el Inventario junto al precio promoción. La réplica
-- de SAINT (`saprod`, tabla espejo que administra el agente externo
-- LiminalReplicant) ya trae `precio1`; el vínculo es `products.saint_code =
-- saprod.codprod`.
--
-- Decisiones de diseño:
--   - Es SOLO INFORMATIVO: no lo usan Seba, el carrito, la factura ni «Enviar
--     a SAINT». Por eso NO se copia a `products` (que es de solo lectura para
--     la app y de Saint como dueño, 20260925010000): se LEE EN VIVO de la
--     réplica al pedir el producto, como campo calculado de PostgREST
--     (`select=...,precio_divisa_usd`), mismo patrón que `tarifa_envio_usd`
--     (20261012010000). Una copia en `products` se desactualizaría en silencio
--     entre dos corridas de `saint.sync_products()`.
--   - `security definer`: el CRM (rol `authenticated`) NO necesita ningún
--     permiso directo sobre `saprod`; la función la lee como su dueño. El
--     acceso se chequea UNA vez por llamada: quien llama con sesión debe tener
--     fila en `agents` con cualquier rol (`can_read_inventory()`, la caja
--     INCLUIDA -- decisión del operador: la caja SÍ ve el precio divisa, a
--     diferencia de la tarifa de envío, 20261014030000). `service_role` y
--     `postgres` no traen `auth.uid()`: el chequeo solo aplica al rol
--     `authenticated` de la sesión (`current_setting('role')`, no
--     `current_user`, que dentro de un definer es siempre el dueño).
--   - La fuente se resuelve EXACTAMENTE como `saint.sync_products()`
--     (20260925010000): `coalesce(to_regclass('saint.saprod'),
--     to_regclass('public.saprod'))`. Hoy la réplica vive en `public.saprod`;
--     cuando se mude a `saint.saprod`, esta función la sigue sola. EN LOCAL Y
--     EN CI NINGUNA DE LAS DOS EXISTE: la migración se crea y funciona sin
--     ellas (la función devuelve null; las tablas se miran en tiempo de
--     ejecución con SQL dinámico y se comprueba que tengan las dos columnas).
--   - Devuelve `round(precio1, 2)` TAL CUAL, incluidos 0 y negativos: la
--     interfaz decide que <= 0 es "sin precio"; la base no oculta nada. null si
--     no hay fila, tabla, columna, `saint_code`, o si quien llama con sesión
--     no es agente.
--
-- CIERRE DE `saprod` (sección 2): la réplica nunca debió ser alcanzable por la
-- API de la app. Se le revoca todo a `anon` y `authenticated` sobre cualquiera
-- de las dos tablas que exista. NO toca los privilegios de otros roles (el rol
-- con que escribe el agente de réplica sigue intacto). Esa sección SOLO se
-- aplica en producción después de que el reporte del VPS confirme que
-- LiminalReplicant escribe con un rol distinto de anon/authenticated; en
-- local/CI no hay `saprod` y el bloque no hace nada. Idempotente.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. No reescribe
-- ninguna tabla propia.
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
-- 1. Campo calculado products.precio_divisa_usd
-- ---------------------------------------------------------------------------
create or replace function public.precio_divisa_usd(p public.products)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fuente regclass;
  v_precio numeric;
begin
  if p.saint_code is null then
    return null;
  end if;

  -- Una sesión `authenticated` que no es agente (ni caja) recibe null, igual
  -- que si leyera la tabla con su RLS. `service_role` y `postgres` pasan.
  if current_setting('role', true) = 'authenticated' and not public.can_read_inventory() then
    return null;
  end if;

  -- Misma resolución que saint.sync_products(): saint.saprod gana.
  v_fuente := coalesce(to_regclass('saint.saprod'), to_regclass('public.saprod'));
  if v_fuente is null then
    return null;
  end if;

  -- Sin las dos columnas no hay nada que leer (la réplica puede cambiar de
  -- forma sin avisar): null, nunca un error que rompa la lectura de products.
  if not exists (
       select 1 from pg_attribute
        where attrelid = v_fuente and attname = 'precio1' and attnum > 0 and not attisdropped)
     or not exists (
       select 1 from pg_attribute
        where attrelid = v_fuente and attname = 'codprod' and attnum > 0 and not attisdropped) then
    return null;
  end if;

  execute format('select round(precio1::numeric, 2) from %s where codprod = $1', v_fuente)
    into v_precio using p.saint_code;

  return v_precio;
end;
$$;

comment on function public.precio_divisa_usd(public.products) is
  'Campo calculado de PostgREST sobre products (30/10/2026): precio divisa en USD = round(SAPROD.Precio1, 2) de la réplica de SAINT (saint.saprod, si no public.saprod), leído en vivo por products.saint_code = saprod.codprod. Devuelve el valor tal cual, incluidos 0 y negativos (la interfaz decide que <= 0 es sin precio); null si no hay saint_code, tabla, columnas o fila, o si quien llama con sesión authenticated no tiene fila en agents (la caja SÍ lo ve). Solo informativo: no lo usan Seba, el carrito, la factura ni Enviar a SAINT.';

-- Los dos revokes (PUBLIC y anon) y el grant a quien sí la usa (CLAUDE.md,
-- "Cerrar una función security definer a anon exige LOS DOS revokes").
revoke execute on function public.precio_divisa_usd(public.products) from public;
revoke execute on function public.precio_divisa_usd(public.products) from anon;
grant execute on function public.precio_divisa_usd(public.products) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Cierre de saprod a anon / authenticated
-- ---------------------------------------------------------------------------
-- El agente de réplica escribe con otro rol; la app jamás necesita leer ni
-- escribir saprod directo (la función de arriba es definer). Si la tabla no
-- existe (local, CI) no hace nada.
do $$
declare
  v_tabla regclass;
  v_cerro boolean := false;
begin
  foreach v_tabla in array array[to_regclass('saint.saprod'), to_regclass('public.saprod')] loop
    if v_tabla is not null then
      execute format('revoke all on %s from anon, authenticated', v_tabla);
      raise notice '20261030010000: cerrada % a anon y authenticated.', v_tabla;
      v_cerro := true;
    end if;
  end loop;

  if not v_cerro then
    raise notice '20261030010000: no existe saint.saprod ni public.saprod en esta base; nada que cerrar.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Autoverificación
-- ---------------------------------------------------------------------------
do $$
declare
  v_tabla regclass;
  v_priv text;
begin
  if not exists (
    select 1 from pg_proc
     where oid = 'public.precio_divisa_usd(public.products)'::regprocedure
       and prosecdef
  ) then
    raise exception '20261030010000: precio_divisa_usd debía quedar security definer';
  end if;
  if has_function_privilege('anon', 'public.precio_divisa_usd(public.products)', 'EXECUTE') then
    raise exception '20261030010000: anon puede ejecutar precio_divisa_usd()';
  end if;
  if not has_function_privilege('authenticated', 'public.precio_divisa_usd(public.products)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.precio_divisa_usd(public.products)', 'EXECUTE') then
    raise exception '20261030010000: authenticated y service_role deben poder ejecutar precio_divisa_usd()';
  end if;

  foreach v_tabla in array array[to_regclass('saint.saprod'), to_regclass('public.saprod')] loop
    if v_tabla is not null then
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege('anon', v_tabla, v_priv)
           or has_table_privilege('authenticated', v_tabla, v_priv) then
          raise exception '20261030010000: anon o authenticated conservan % sobre %', v_priv, v_tabla;
        end if;
      end loop;
    end if;
  end loop;

  raise notice '20261030010000: autoverificación correcta (precio divisa expuesto; saprod cerrada a anon/authenticated si existe).';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
