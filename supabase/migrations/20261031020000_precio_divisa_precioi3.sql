-- ============================================================================
-- Corrección del precio divisa: es `SAPROD.PrecioI3`, no `Precio1`
-- (31/10/2026).
--
-- Historia: la migración 20261030010000 (30/10/2026) expuso el «precio divisa»
-- como campo calculado `products.precio_divisa_usd` leyendo `saprod.precio1`.
-- Era la columna equivocada: en SAINT el precio divisa (USD) vive en
-- `SAPROD.PrecioI3` (= Precio3 / tasa, 3 decimales) y `Precio1` vale 0 en
-- todos los productos. Ejemplo medido contra la réplica: `D8TC-CHAMPION` tiene
-- precio3 = 1650 y precioi3 = 1.500; la función tiene que dar 1.50, y con la
-- versión anterior daba 0.00 («Sin precio en SAINT» en toda la lista).
--
-- ESTA MIGRACIÓN NO EDITA la anterior (puede estar ya aplicada en producción):
-- la REEMPLAZA con `create or replace`. Misma firma y mismo contrato que
-- 20261030010000:
--   - `public.precio_divisa_usd(public.products)`, `security definer`,
--     devuelve `round(precioi3::numeric, 2)` TAL CUAL (0 y negativos
--     incluidos: la interfaz pinta «Sin precio en SAINT» con <= 0).
--   - null si no hay `saint_code`, tabla (`saint.saprod`, si no
--     `public.saprod`), columnas, fila, o si quien llama con rol `authenticated`
--     no pasa `can_read_inventory()` (la caja SÍ lo ve).
--   - Si la tabla trae `precio1` pero NO `precioi3`, devuelve null: NUNCA cae
--     a `precio1`. Caer a la columna vieja volvería a mostrar ceros que
--     parecen verdad.
--   - No se calcula `precio3 / tasa` en ningún lado: el USD lo fija SAINT.
--
-- El código de la app no cambia por esto (PostgREST ya pide
-- `precio_divisa_usd`): esta migración se puede aplicar antes o después del
-- deploy. Hasta que se aplique, el Inventario sigue mostrando lo que daba la
-- versión anterior.
--
-- La sección 2 repite, idempotente, el cierre de `saprod` a `anon` y
-- `authenticated`: si el agente replicador recreó la tabla en `public` desde
-- la 20261030010000, los default privileges de Supabase le devolvieron ALL a
-- esos roles (la misma vía que el `alter default privileges` de CLAUDE.md,
-- «Cerrar una función security definer a anon exige LOS DOS revokes»).
--
-- SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN -- `psql -1 -v ON_ERROR_STOP=1` --
-- mismo motivo que las anteriores: `set local lock_timeout` fuera de una
-- transacción es un NO-OP silencioso. No reescribe ninguna tabla propia.
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
-- 1. Campo calculado products.precio_divisa_usd, ahora desde precioi3
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
  -- La columna es la divisa de SAINT (la otra, la de siempre en 0, no se mira).
  if not exists (
       select 1 from pg_attribute
        where attrelid = v_fuente and attname = 'precioi3' and attnum > 0 and not attisdropped)
     or not exists (
       select 1 from pg_attribute
        where attrelid = v_fuente and attname = 'codprod' and attnum > 0 and not attisdropped) then
    return null;
  end if;

  execute format('select round(precioi3::numeric, 2) from %s where codprod = $1', v_fuente)
    into v_precio using p.saint_code;

  return v_precio;
end;
$$;

comment on function public.precio_divisa_usd(public.products) is
  'Campo calculado de PostgREST sobre products (corregido el 31/10/2026): precio divisa en USD = round(SAPROD.PrecioI3, 2) de la réplica de SAINT (saint.saprod, si no public.saprod), leído en vivo por products.saint_code = saprod.codprod. PrecioI3 es Precio3 / tasa calculado por SAINT; Precio1 vale 0 en SAINT y no se lee nunca. Devuelve el valor tal cual, incluidos 0 y negativos (la interfaz decide que <= 0 es sin precio); null si no hay saint_code, tabla, columnas (precioi3, codprod) o fila, o si quien llama con sesión authenticated no tiene fila en agents (la caja SÍ lo ve). Solo informativo: no lo usan Seba, el carrito, la factura ni Enviar a SAINT.';

-- `create or replace` conserva los privilegios, pero se reafirman los dos
-- revokes (PUBLIC y anon) y el grant: la regla de CLAUDE.md es que cada
-- migración que toca una función definer los deje explícitos.
revoke execute on function public.precio_divisa_usd(public.products) from public;
revoke execute on function public.precio_divisa_usd(public.products) from anon;
grant execute on function public.precio_divisa_usd(public.products) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Cierre de saprod a anon / authenticated (repetido, idempotente)
-- ---------------------------------------------------------------------------
do $$
declare
  v_tabla regclass;
  v_cerro boolean := false;
begin
  foreach v_tabla in array array[to_regclass('saint.saprod'), to_regclass('public.saprod')] loop
    if v_tabla is not null then
      execute format('revoke all on %s from anon, authenticated', v_tabla);
      raise notice '20261031020000: cerrada % a anon y authenticated.', v_tabla;
      v_cerro := true;
    end if;
  end loop;

  if not v_cerro then
    raise notice '20261031020000: no existe saint.saprod ni public.saprod en esta base; nada que cerrar.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Autoverificación
-- ---------------------------------------------------------------------------
do $$
declare
  v_tabla regclass;
  v_priv text;
  v_def text;
begin
  if not exists (
    select 1 from pg_proc
     where oid = 'public.precio_divisa_usd(public.products)'::regprocedure
       and prosecdef
  ) then
    raise exception '20261031020000: precio_divisa_usd debía quedar security definer';
  end if;
  if has_function_privilege('anon', 'public.precio_divisa_usd(public.products)', 'EXECUTE') then
    raise exception '20261031020000: anon puede ejecutar precio_divisa_usd()';
  end if;
  if not has_function_privilege('authenticated', 'public.precio_divisa_usd(public.products)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.precio_divisa_usd(public.products)', 'EXECUTE') then
    raise exception '20261031020000: authenticated y service_role deben poder ejecutar precio_divisa_usd()';
  end if;

  -- El cuerpo lee precioi3 y no menciona precio1 en ninguna parte (ni en el
  -- código: los comentarios del cuerpo tampoco la nombran a propósito).
  v_def := pg_get_functiondef('public.precio_divisa_usd(public.products)'::regprocedure);
  if v_def not like '%precioi3%' then
    raise exception '20261031020000: el cuerpo de precio_divisa_usd no menciona precioi3';
  end if;
  if v_def like '%precio1%' then
    raise exception '20261031020000: el cuerpo de precio_divisa_usd todavía menciona precio1';
  end if;

  foreach v_tabla in array array[to_regclass('saint.saprod'), to_regclass('public.saprod')] loop
    if v_tabla is not null then
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege('anon', v_tabla, v_priv)
           or has_table_privilege('authenticated', v_tabla, v_priv) then
          raise exception '20261031020000: anon o authenticated conservan % sobre %', v_priv, v_tabla;
        end if;
      end loop;
    end if;
  end loop;

  raise notice '20261031020000: autoverificación correcta (precio divisa desde precioi3; saprod cerrada a anon/authenticated si existe).';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
