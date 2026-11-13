-- ============================================================================
-- La foto de cada envío a SAINT (13/11/2026), plan "Paneles", M1.
--
-- Contexto: los tres paneles nuevos (Dashboard de ventas, Analíticas, Asesores)
-- cuentan ventas, y toda venta del negocio pasa por "Enviar a SAINT"
-- (`liminal.saint_borradores`, 20261025010000): un `creado` es una factura EN
-- ESPERA en SAINT. Pero esa tabla es un CONTRATO con el agente LiminalReplicant
-- y solo guarda `items [{codprod, cantidad}]`: ni precios, ni canal, ni quién
-- armó el pedido. Reconstruir el monto después, con el precio de ese día, sería
-- adivinar (el precio y la tasa cambian), así que cada envío deja una FOTO en el
-- mismo instante en que nace.
--
-- Qué crea:
--   1. `public.precio_venta_usd(products, tipo, tasa)`: el precio unitario en USD
--      EXACTAMENTE como lo muestra el CRM (recargo del 16 % -> bolívares a
--      dólares con techo a $0,10 -> estándar = promoción + tarifa MRW). Replica
--      en SQL a `recargo-precio.ts`, `usd-price.ts` y `standardPriceAmounts`
--      (`inventory.ts`); `src/lib/precio-venta-paridad.test.ts` y
--      `supabase/tests/ventas_saint.sql` los atan con casos dorados escritos a
--      mano. Devuelve null donde TypeScript da null (sin tasa para un producto en
--      Bs, sin precio, estándar sin tarifa).
--   2. `public.ventas_saint`: una fila por borrador con monto, canal, quién armó
--      y quién envió. Sin FK hacia `liminal` (el esquema es del replicador). RLS
--      habilitada SIN políticas y `revoke all` a todos: se lee solo por RPC
--      `security definer` (mismo criterio que `product_weight_audit`,
--      20260925010000).
--   3. Un trigger AFTER INSERT sobre `liminal.saint_borradores` que escribe la
--      foto en la MISMA transacción del envío. La foto NUNCA puede abortarlo:
--      todo el cuerpo va dentro de un bloque con `exception when others` y, si
--      falla, deja una fila mínima con `foto_error` (también protegida) y sigue.
--
-- Canal (decisión del operador, "por flujo"): el carrito del chat es `online`; un
-- presupuesto es `online` si nació en el chat y `tienda` si nació en Inventario.
--
-- NO toca `enviar_borrador_saint` ni ninguna columna del contrato con el agente.
-- Nada de backfill: las filas existentes son otra tarea.
--
-- Por qué la función del trigger lee la tarifa MRW directo de `shipping_rates` y
-- no con `tarifa_mrw_usd()`: esa función da null a la CAJA (14/10/2026: la caja
-- ve solo el precio promoción) mirando el rol de la SESIÓN, que dentro de un
-- `security definer` sigue siendo `authenticated`. La caja puede enviar un
-- presupuesto con renglones estándar que armó un asesor, y la foto de ese envío
-- tiene que llevar el monto completo, no uno vacío. `precio_venta_usd` (la que
-- usa la gente) sí pasa por `tarifa_mrw_usd`: la caja no puede sonsacar la
-- tarifa con ella.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. Es
-- re-ejecutable (`create or replace` / `if not exists` / `drop ... if exists`).
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
-- 1. Precio de venta unitario en USD
-- ---------------------------------------------------------------------------
-- La base: aritmética pura, sin leer ninguna tabla (la tarifa llega como
-- parámetro). `immutable`.
--
--   · Producto en USD:  `usdConRecargo(price)` = techo a $0,10 de price x 1,16.
--   · Producto en Bs:   `bsConRecargo(price)` (al céntimo) y luego `usdFromBs`
--                       (bs / tasa con techo a $0,10). Sin tasa -> null.
--   · Estándar:         lo anterior + tarifa MRW; sin tarifa -> null.
--   · Precio nulo o <= 0 -> null. Desvío consciente de TypeScript, que dejaría
--     pasar un 0: para el panel un renglón sin precio es "sin precio" y marca
--     `lineas_sin_precio`, no una venta de $0.
--
-- El `+ 1e-9` / `- 1e-9` es el mismo epsilon de TypeScript (absorbe el ruido de
-- coma flotante); con `numeric` casi no hace falta, pero es el que hace que un
-- exacto como 29,00 no suba y se mantiene idéntico para que la paridad no
-- dependa de un detalle.
create or replace function public.precio_venta_usd_base(
  p_product public.products,
  p_price_kind text,
  p_tasa numeric,
  p_tarifa numeric
) returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  -- El único lugar de la base donde vive el recargo; el guardián de
  -- `precio-venta-paridad.test.ts` exige que sea igual a `RECARGO_PRECIO`.
  v_recargo constant numeric := 0.16;
  v_epsilon constant numeric := 0.000000001;
  v_usd numeric;
  v_bs numeric;
begin
  if p_product.price is null or p_product.price <= 0 then
    return null;
  end if;

  if p_product.currency = 'USD' then
    v_usd := round(ceil(p_product.price * (1 + v_recargo) * 10 - v_epsilon) / 10, 2);
  else
    if p_tasa is null or p_tasa <= 0 then
      return null;
    end if;
    v_bs := floor(p_product.price * (1 + v_recargo) * 100 + v_epsilon + 0.5) / 100;
    v_usd := round(ceil(v_bs / p_tasa * 10 - v_epsilon) / 10, 2);
  end if;

  if p_price_kind = 'estandar' then
    if p_tarifa is null then
      return null;
    end if;
    return round(v_usd + p_tarifa, 2);
  end if;

  return v_usd;
end;
$$;

comment on function public.precio_venta_usd_base(public.products, text, numeric, numeric) is
  'Aritmética del precio de venta unitario en USD (plan "Paneles", M1, 13/11/2026): recargo de 16 % y techo a 10 centavos, igual que recargo-precio.ts + usd-price.ts + standardPriceAmounts. La tarifa MRW llega como parámetro. Null donde TypeScript da null.';

-- La que usa la gente: resuelve la tarifa con `tarifa_mrw_usd` (la caja recibe
-- null, igual que en el Inventario).
create or replace function public.precio_venta_usd(
  p_product public.products,
  p_price_kind text,
  p_tasa numeric
) returns numeric
language sql
stable
set search_path = public
as $$
  select public.precio_venta_usd_base(
    p_product,
    p_price_kind,
    p_tasa,
    case when p_price_kind = 'estandar' then public.tarifa_mrw_usd(p_product.weight_kg) end
  );
$$;

comment on function public.precio_venta_usd(public.products, text, numeric) is
  'Precio de venta unitario en USD de un producto tal como lo muestra el CRM (plan "Paneles", M1, 13/11/2026). p_price_kind: promocion o estandar; p_tasa: bolívares por dólar (null si no hay). security invoker: la tarifa MRW sale de tarifa_mrw_usd, que le da null a la caja.';

revoke execute on function public.precio_venta_usd_base(public.products, text, numeric, numeric) from public;
revoke execute on function public.precio_venta_usd_base(public.products, text, numeric, numeric) from anon, authenticated;
grant execute on function public.precio_venta_usd_base(public.products, text, numeric, numeric) to authenticated, service_role;

revoke execute on function public.precio_venta_usd(public.products, text, numeric) from public;
revoke execute on function public.precio_venta_usd(public.products, text, numeric) from anon, authenticated;
grant execute on function public.precio_venta_usd(public.products, text, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. La tabla de fotos
-- ---------------------------------------------------------------------------
create table if not exists public.ventas_saint (
  -- Id del borrador de `liminal.saint_borradores`. Sin FK: el esquema `liminal`
  -- es del replicador y un borrador borrado allá no debe arrastrar la foto.
  borrador_id uuid primary key,
  created_at timestamptz not null default now(),
  origen text not null,
  canal text not null check (canal in ('online', 'tienda')),
  canal_fuente text not null check (canal_fuente in ('registro', 'inferido')),
  conversation_id uuid null,
  presupuesto_id uuid null,
  armado_por uuid null,
  enviado_por uuid null,
  rol_envia text null,
  unidades int null,
  monto_usd numeric(12, 2) null,
  monto_bs numeric(14, 2) null,
  tasa_bcv numeric null,
  -- [{product_id, codprod, nombre, cantidad, precio_usd|null, price_kind}]
  lineas jsonb not null default '[]'::jsonb,
  lineas_sin_precio int not null default 0,
  estimado boolean not null default false,
  posible_duplicado boolean not null default false,
  foto_error text null
);

comment on table public.ventas_saint is
  'Foto de cada envío a SAINT (plan "Paneles", M1, 13/11/2026): monto en USD y Bs con el precio y la tasa del momento del envío, canal (online/tienda) y quién armó y envió. La escribe el trigger ventas_saint_foto_after_insert sobre liminal.saint_borradores; se lee solo por RPC security definer. monto_usd es null si algún renglón no tiene precio (nunca un total parcial). estimado y posible_duplicado marcan filas poco fiables; foto_error, una foto que no pudo calcularse.';
comment on column public.ventas_saint.canal_fuente is
  '''registro'': el canal salió del origen del pedido (carrito = online; presupuesto según presupuestos.origen). ''inferido'': se dedujo a mano o por la fila mínima de una foto rota.';
comment on column public.ventas_saint.rol_envia is
  'agents.role de quien envió, COPIADO al enviar (el rol puede cambiar después).';
comment on column public.ventas_saint.posible_duplicado is
  'true si ya existía otra foto del mismo origen (o de la misma conversación) con las mismas líneas (codprod + cantidad) y menos de 24 h antes.';

create index if not exists ventas_saint_created_at_idx on public.ventas_saint (created_at);
create index if not exists ventas_saint_conversation_idx on public.ventas_saint (conversation_id);
create index if not exists ventas_saint_enviado_por_idx on public.ventas_saint (enviado_por, created_at);

-- El `alter default privileges` de Supabase le da ALL a anon/authenticated/
-- service_role a toda tabla nueva de `public`: se corta todo (mismo criterio que
-- `product_weight_audit`, 20260925010000). RLS sin políticas: solo las funciones
-- `security definer` (dueño `postgres`) la tocan.
revoke all on public.ventas_saint from public, anon, authenticated, service_role;
alter table public.ventas_saint enable row level security;

-- ---------------------------------------------------------------------------
-- 3. El trigger que toma la foto
-- ---------------------------------------------------------------------------
create or replace function public.ventas_saint_foto() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tasa numeric;
  v_canal text;
  v_fuente text := 'registro';
  v_conv uuid;
  v_pres uuid;
  v_armado uuid;
  v_rol text;
  v_lineas jsonb;
  v_unidades int;
  v_sin_precio int;
  v_monto numeric;
  v_monto_bs numeric;
  v_firma text;
  v_dup boolean;
  v_error text;
begin
  -- TODO el cuerpo va protegido: una foto que falla nunca aborta el envío.
  begin
    -- Tasa vigente: la de `rate_date` más alto (igual que fetchLatestBcvRate).
    select er.usd_to_ves into v_tasa
      from public.exchange_rates er
     order by er.rate_date desc
     limit 1;
    if v_tasa is not null and v_tasa <= 0 then
      v_tasa := null;
    end if;

    -- Canal, conversación y quién armó el pedido.
    if new.origen = 'carrito' then
      v_canal := 'online';
      v_conv := new.origen_id;
      select ci.added_by into v_armado
        from public.conversation_cart_items ci
       where ci.conversation_id = new.origen_id
       order by ci.updated_at desc, ci.created_at desc
       limit 1;
    else
      v_pres := new.origen_id;
      select pr.conversation_id,
             pr.created_by,
             case pr.origen when 'chat' then 'online' else 'tienda' end
        into v_conv, v_armado, v_canal
        from public.presupuestos pr
       where pr.id = new.origen_id;
      if not found then
        -- Un presupuesto que ya no existe: no se inventa su origen.
        v_canal := 'tienda';
        v_fuente := 'inferido';
      end if;
    end if;

    select a.role into v_rol from public.agents a where a.id = new.creado_por;

    -- Una línea por renglón del origen, con el precio de HOY (el del envío): la
    -- foto congela lo que el CRM mostraba al enviar. La tarifa MRW se lee directo
    -- de `shipping_rates` (ver la cabecera: la caja no la recibe por
    -- `tarifa_mrw_usd`). Mismos límites que esa función: sin peso, peso <= 0 o
    -- >= 80 kg no hay tarifa.
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'product_id', s.product_id,
               'codprod', s.codprod,
               'nombre', s.nombre,
               'cantidad', s.cantidad,
               'precio_usd', s.precio,
               'price_kind', s.kind)
             order by s.creado, s.codprod), '[]'::jsonb),
           coalesce(sum(s.cantidad), 0)::int,
           (count(*) filter (where s.precio is null))::int,
           case
             when count(*) = 0 or count(*) filter (where s.precio is null) > 0 then null
             else round(sum(s.cantidad * s.precio), 2)
           end
      into v_lineas, v_unidades, v_sin_precio, v_monto
      from (
        select p.id as product_id,
               btrim(coalesce(p.saint_code, '')) as codprod,
               p.name as nombre,
               x.cantidad,
               x.kind,
               x.creado,
               public.precio_venta_usd_base(p, x.kind, v_tasa, t.tarifa) as precio
          from (
            select pi.product_id, pi.quantity as cantidad, pi.price_kind as kind, pi.created_at as creado
              from public.presupuesto_items pi
             where new.origen = 'presupuesto' and pi.presupuesto_id = new.origen_id
            union all
            select ci.product_id, ci.quantity, ci.price_kind, ci.created_at
              from public.conversation_cart_items ci
             where new.origen = 'carrito' and ci.conversation_id = new.origen_id
          ) x
          join public.products p on p.id = x.product_id
          left join lateral (
            select r.tarifa_usd as tarifa
              from public.shipping_rates r
             where r.carrier = 'mrw'
               and p.weight_kg is not null and p.weight_kg > 0 and p.weight_kg < 80
               and r.desde_kg <= p.weight_kg
               and p.weight_kg < r.hasta_kg
             limit 1
          ) t on true
      ) s;

    v_monto_bs := case when v_monto is null or v_tasa is null then null else round(v_monto * v_tasa, 2) end;

    -- Posible duplicado: otra foto del mismo origen (o de la misma conversación)
    -- con las mismas líneas (codprod + cantidad) de menos de 24 h antes.
    select string_agg(i.codprod || ':' || i.cantidad, ',' order by i.codprod)
      into v_firma
      from jsonb_to_recordset(new.items) as i(codprod text, cantidad int);

    select exists (
      select 1
        from public.ventas_saint v
        join liminal.saint_borradores b on b.id = v.borrador_id
       where v.borrador_id <> new.id
         and v.created_at <= new.created_at
         and v.created_at > new.created_at - interval '24 hours'
         and (b.origen_id = new.origen_id or (v_conv is not null and v.conversation_id = v_conv))
         and (select string_agg(i.codprod || ':' || i.cantidad, ',' order by i.codprod)
                from jsonb_to_recordset(b.items) as i(codprod text, cantidad int)) = v_firma
    ) into v_dup;

    insert into public.ventas_saint (
      borrador_id, created_at, origen, canal, canal_fuente, conversation_id, presupuesto_id,
      armado_por, enviado_por, rol_envia, unidades, monto_usd, monto_bs, tasa_bcv,
      lineas, lineas_sin_precio, posible_duplicado
    ) values (
      new.id, new.created_at, new.origen, v_canal, v_fuente, v_conv, v_pres,
      v_armado, new.creado_por, v_rol, v_unidades, v_monto, v_monto_bs, v_tasa,
      v_lineas, v_sin_precio, coalesce(v_dup, false)
    )
    on conflict (borrador_id) do nothing;
  exception when others then
    v_error := left(sqlerrm, 200);
    -- Fila mínima: que el panel sepa que existió un envío y por qué no tiene
    -- monto. También protegida: si ni esto entra, el envío sigue igual.
    begin
      insert into public.ventas_saint (
        borrador_id, created_at, origen, canal, canal_fuente, enviado_por, foto_error
      ) values (
        new.id, new.created_at, new.origen,
        case new.origen
          when 'carrito' then 'online'
          else coalesce(
            (select case pr.origen when 'chat' then 'online' else 'tienda' end
               from public.presupuestos pr where pr.id = new.origen_id),
            'tienda')
        end,
        'inferido', new.creado_por, v_error
      )
      on conflict (borrador_id) do nothing;
    exception when others then
      raise warning 'ventas_saint_foto: no se pudo dejar ni la fila mínima del borrador %: %', new.id, sqlerrm;
    end;
  end;

  return null;
end;
$$;

comment on function public.ventas_saint_foto() is
  'Trigger AFTER INSERT sobre liminal.saint_borradores (plan "Paneles", M1, 13/11/2026): deja en ventas_saint la foto del envío (monto con el precio y la tasa de ese momento, canal, quién armó y envió). security definer: escribe en una tabla sin ningún grant a la API. Nunca aborta el envío: todo error se atrapa y deja una fila mínima con foto_error.';

-- Dos revokes, ningún grant: nadie la invoca por RPC (Postgres no comprueba
-- EXECUTE al disparar un trigger).
revoke execute on function public.ventas_saint_foto() from public;
revoke execute on function public.ventas_saint_foto() from anon, authenticated;

drop trigger if exists ventas_saint_foto_after_insert on liminal.saint_borradores;
create trigger ventas_saint_foto_after_insert
  after insert on liminal.saint_borradores
  for each row execute function public.ventas_saint_foto();

-- ---------------------------------------------------------------------------
-- 4. Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  if not exists (
    select 1 from pg_class where oid = 'public.ventas_saint'::regclass and relrowsecurity
  ) then
    raise exception '20261113010000: public.ventas_saint quedó sin RLS habilitada';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.ventas_saint'::regclass) then
    raise exception '20261113010000: public.ventas_saint no debía tener ninguna política';
  end if;
  if has_table_privilege('anon', 'public.ventas_saint', 'SELECT')
     or has_table_privilege('authenticated', 'public.ventas_saint', 'SELECT')
     or has_table_privilege('authenticated', 'public.ventas_saint', 'INSERT')
     or has_table_privilege('service_role', 'public.ventas_saint', 'SELECT') then
    raise exception '20261113010000: algún rol de la API puede tocar public.ventas_saint';
  end if;

  foreach f in array array[
    'public.precio_venta_usd_base(public.products,text,numeric,numeric)',
    'public.precio_venta_usd(public.products,text,numeric)',
    'public.ventas_saint_foto()'
  ]
  loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('public', f, 'EXECUTE') then
      raise exception '20261113010000: anon o PUBLIC pueden ejecutar %', f;
    end if;
  end loop;

  foreach f in array array[
    'public.precio_venta_usd_base(public.products,text,numeric,numeric)',
    'public.precio_venta_usd(public.products,text,numeric)'
  ]
  loop
    if not has_function_privilege('authenticated', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '20261113010000: authenticated y service_role deben poder ejecutar %', f;
    end if;
    if exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
      raise exception '20261113010000: % debía quedar security invoker', f;
    end if;
  end loop;

  if has_function_privilege('authenticated', 'public.ventas_saint_foto()', 'EXECUTE') then
    raise exception '20261113010000: authenticated puede ejecutar ventas_saint_foto()';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.ventas_saint_foto()'::regprocedure and prosecdef) then
    raise exception '20261113010000: ventas_saint_foto() debía quedar security definer';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'liminal.saint_borradores'::regclass
       and tgname = 'ventas_saint_foto_after_insert'
       and not tgisinternal
       and (tgtype & 1) = 1      -- por fila
       and (tgtype & 4) = 4      -- INSERT
       and (tgtype & 2) = 0      -- no BEFORE (AFTER)
  ) then
    raise exception '20261113010000: falta el trigger AFTER INSERT ventas_saint_foto_after_insert';
  end if;

  raise notice '20261113010000: autoverificación de ventas_saint correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
