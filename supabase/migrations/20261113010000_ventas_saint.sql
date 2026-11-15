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
--   4. La vista `public.ventas_saint_estado`: la ÚNICA definición de "venta" y de
--      "duplicado" para los paneles (corrección del 15/11/2026, ver abajo).
--
-- DUPLICADO: SE DECIDE AL LEER, NO AL INSERTAR (corrección del 15/11/2026, hallazgo
-- del `code-review` del plan "Paneles"). La primera versión marcaba
-- `posible_duplicado` AL INSERTAR si ya existía otra foto del mismo origen (o de
-- la misma conversación) con las mismas líneas en las 24 h previas, SIN mirar el
-- estado de ese envío anterior: un asesor enviaba el carrito, SAINT lo rechazaba
-- (`error`, p. ej. una cédula mal), corregía y reenviaba los mismos ítems -> el
-- segundo quedaba `creado` pero nacía "duplicado" y la venta desaparecía de
-- Ingresos, de la conversión y de los envíos por persona. Marcarlo al insertar
-- no tiene arreglo completo: en ese instante el envío anterior puede estar
-- `pendiente` y terminar en `error` después. Ahora la foto solo guarda la FIRMA
-- de sus ítems (`firma_items`) y la vista decide, contra el estado ACTUAL:
--
--   Un envío `creado` es duplicado si existe OTRO envío `creado` ANTERIOR (por
--   `created_at`; a igual instante, el de `borrador_id` menor, para que de dos
--   simultáneos cuente uno) del mismo origen o de la misma conversación (no
--   nula), con la misma firma de ítems y a menos de 24 h. Un envío en `error` o
--   en tránsito NUNCA vuelve duplicado a otro. Con tres `creado` iguales cuenta
--   uno (el primero: no hace falta recursión, el primero de un grupo nunca tiene
--   un anterior). Si el anterior estaba en tránsito y el posterior quedó
--   `creado`, cuenta el posterior; si luego el anterior también pasa a `creado`,
--   cuenta el anterior y el posterior pasa a duplicado: siempre uno.
--
-- `posible_duplicado` se QUITÓ de la tabla (M1 y M4 aún no estaban en producción):
-- dejarla sin usar habría invitado a leerla.
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
-- La vista depende de las columnas de la tabla (`vs.*`): se suelta primero para
-- poder quitar `posible_duplicado` en una base donde la primera versión de esta
-- migración ya corrió (la local); se vuelve a crear en la sección 4.
drop view if exists public.ventas_saint_estado;

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
  -- Firma canónica de los ítems del borrador: `codprod:cantidad` ordenados por
  -- código y separados por coma. null en la fila mínima de una foto rota.
  firma_items text null,
  foto_error text null
);

-- Una base donde la primera versión de esta migración ya corrió (la local):
-- agrega la firma, la rellena desde los ítems de cada borrador y quita la marca
-- de duplicado, que ahora decide la vista al leer.
alter table public.ventas_saint add column if not exists firma_items text null;
alter table public.ventas_saint drop column if exists posible_duplicado;
update public.ventas_saint vs
   set firma_items = (
     select string_agg(i.codprod || ':' || i.cantidad, ',' order by i.codprod)
       from jsonb_to_recordset(b.items) as i(codprod text, cantidad int))
  from liminal.saint_borradores b
 where b.id = vs.borrador_id and vs.firma_items is null and vs.foto_error is null;

comment on table public.ventas_saint is
  'Foto de cada envío a SAINT (plan "Paneles", M1, 13/11/2026): monto en USD y Bs con el precio y la tasa del momento del envío, canal (online/tienda) y quién armó y envió. La escribe el trigger ventas_saint_foto_after_insert sobre liminal.saint_borradores; se lee solo por RPC security definer (y por la vista ventas_saint_estado, que decide qué envío es una venta y cuál un duplicado). monto_usd es null si algún renglón no tiene precio (nunca un total parcial). estimado marca filas poco fiables; foto_error, una foto que no pudo calcularse.';
comment on column public.ventas_saint.canal_fuente is
  '''registro'': el canal salió del origen del pedido (carrito = online; presupuesto según presupuestos.origen). ''inferido'': se dedujo a mano o por la fila mínima de una foto rota.';
comment on column public.ventas_saint.rol_envia is
  'agents.role de quien envió, COPIADO al enviar (el rol puede cambiar después).';
comment on column public.ventas_saint.firma_items is
  'Firma de los ítems del borrador (codprod:cantidad ordenados por código, separados por coma). La vista ventas_saint_estado la compara para decidir los duplicados al leer, contra el estado ACTUAL de cada envío (15/11/2026).';

create index if not exists ventas_saint_created_at_idx on public.ventas_saint (created_at);
create index if not exists ventas_saint_conversation_idx on public.ventas_saint (conversation_id);
-- (15/11/2026) El índice parcial por `presupuesto_id` que existía para el
-- `exists` de la vista de duplicados se retiró: la vista ahora hace una pasada de
-- conjunto con `lag` y no consulta por presupuesto. Se suelta por si la base
-- local ya lo tenía.
drop index if exists public.ventas_saint_presupuesto_idx;
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

    -- La firma de los ítems (codprod:cantidad, ordenados por código). El
    -- duplicado ya NO se decide aquí: lo decide la vista `ventas_saint_estado` al
    -- leer, contra el estado actual de cada envío (ver la cabecera).
    select string_agg(i.codprod || ':' || i.cantidad, ',' order by i.codprod)
      into v_firma
      from jsonb_to_recordset(new.items) as i(codprod text, cantidad int);

    insert into public.ventas_saint (
      borrador_id, created_at, origen, canal, canal_fuente, conversation_id, presupuesto_id,
      armado_por, enviado_por, rol_envia, unidades, monto_usd, monto_bs, tasa_bcv,
      lineas, lineas_sin_precio, firma_items
    ) values (
      new.id, new.created_at, new.origen, v_canal, v_fuente, v_conv, v_pres,
      v_armado, new.creado_por, v_rol, v_unidades, v_monto, v_monto_bs, v_tasa,
      v_lineas, v_sin_precio, v_firma
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
-- 4. La vista que decide qué es una venta y qué un duplicado
-- ---------------------------------------------------------------------------
-- Una fila por foto, con el estado ACTUAL de su borrador, los datos del cliente
-- que las RPC de los paneles necesitan y `duplicado` (solo puede ser true si el
-- envío está `creado`; ver la regla en la cabecera). Una venta es
-- `estado = 'creado' and not duplicado`: TODAS las RPC de M4 usan esta vista y
-- ninguna repite la regla.
--
-- CÓMO se calcula `duplicado` (15/11/2026, segunda corrección, medida): la
-- primera versión de la corrección lo calculaba con un `exists` correlacionado
-- por fila, con un `or` entre conversación y presupuesto, y esa forma costaba el
-- doble de lo que cuestan los paneles SIN calcularlo (con 30 mil envíos:
-- `panel_asesores` a 30 días, 1,2 s contra 0,6 s; a 92 días, 2,3 s contra 1,1 s).
-- Dos razones: el `or` impide usar un solo índice, y `panel_conversaciones` y
-- `panel_asesores` corren con `enable_nestloop = off` (ver M4), que castiga el
-- `join` con `saint_borradores` DENTRO de cada subconsulta, una vez por fila.
-- Ahora es una sola pasada, de conjunto, sin bucles por fila: el "anterior
-- inmediato" con `lag` por partición (conversación + firma, y aparte presupuesto
-- + firma), sobre los envíos `creado` con firma ordenados por (`created_at`,
-- `borrador_id`). Es EQUIVALENTE a la regla de arriba: si el `creado` anterior
-- más cercano de un grupo está a 24 h o más, ninguno de los anteriores (todos
-- más lejanos) está a menos; y a igual `created_at` el predecesor inmediato es
-- el de `borrador_id` menor, con diferencia 0 (< 24 h). Un `creado` solo entra
-- como "anterior" si su estado ACTUAL es `creado`, porque la ventana solo recorre
-- esos. La ventana mira TODA la tabla, no el rango que consulta la pantalla: un
-- reenvío a las 00:20 sigue siendo duplicado de un envío de las 23:50 del día
-- anterior aunque el rango arranque a medianoche. Por eso no hay filtro de fecha
-- que empujar adentro, y por eso cuesta una pasada completa (~45 ms con 30 mil
-- envíos): cada RPC de M4 lee la vista UNA vez por consulta (`panel_ventas`
-- la lee una sola vez y de ahí saca el rango, los clientes genéricos y las
-- compras previas).
--
-- Vista del dueño (`postgres`, no `security_invoker`): la leen solo funciones
-- `security definer`; sin ningún grant a la API (mismo criterio que la tabla).
create view public.ventas_saint_estado as
select vs.*,
       b.estado,
       b.cedula_tipo,
       b.cedula_numero,
       b.codclie,
       b.cliente_creado,
       (d.borrador_id is not null) as duplicado
  from public.ventas_saint vs
  join liminal.saint_borradores b on b.id = vs.borrador_id
  left join (
    -- Duplicados por conversación (no nula) y firma.
    select x.borrador_id
      from (
        select a.borrador_id,
               a.created_at - lag(a.created_at) over (
                 partition by a.conversation_id, a.firma_items
                 order by a.created_at, a.borrador_id) as desde_el_anterior
          from public.ventas_saint a
          join liminal.saint_borradores ab on ab.id = a.borrador_id
         where ab.estado = 'creado' and a.firma_items is not null and a.conversation_id is not null
      ) x
     where x.desde_el_anterior < interval '24 hours'
    union
    -- Duplicados por presupuesto (no nulo) y firma. `union` (no `all`): un envío
    -- que lo es por las dos vías entra una sola vez y el `left join` no lo
    -- multiplica.
    select y.borrador_id
      from (
        select a.borrador_id,
               a.created_at - lag(a.created_at) over (
                 partition by a.presupuesto_id, a.firma_items
                 order by a.created_at, a.borrador_id) as desde_el_anterior
          from public.ventas_saint a
          join liminal.saint_borradores ab on ab.id = a.borrador_id
         where ab.estado = 'creado' and a.firma_items is not null and a.presupuesto_id is not null
      ) y
     where y.desde_el_anterior < interval '24 hours'
  ) d on d.borrador_id = vs.borrador_id;

comment on view public.ventas_saint_estado is
  'Cada foto de ventas_saint con el estado ACTUAL de su borrador de SAINT y `duplicado` (plan "Paneles", M1, corrección del 15/11/2026): un envío creado es duplicado si existe OTRO envío creado anterior (a igual instante, el de borrador_id menor) del mismo origen o de la misma conversación, con la misma firma de ítems y a menos de 24 h. Un envío en error o en tránsito nunca vuelve duplicado a otro. Una venta es estado = creado y not duplicado. Se calcula en una pasada de conjunto (lag por conversacion+firma y por presupuesto+firma, 15/11/2026), no con una subconsulta por fila. Solo la leen las RPC security definer de los paneles.';

revoke all on public.ventas_saint_estado from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Autoverificación contra el catálogo real
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
  if has_table_privilege('anon', 'public.ventas_saint_estado', 'SELECT')
     or has_table_privilege('authenticated', 'public.ventas_saint_estado', 'SELECT')
     or has_table_privilege('service_role', 'public.ventas_saint_estado', 'SELECT') then
    raise exception '20261113010000: algún rol de la API puede leer public.ventas_saint_estado';
  end if;
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.ventas_saint'::regclass and attname = 'posible_duplicado' and not attisdropped
  ) then
    raise exception '20261113010000: public.ventas_saint no debía conservar posible_duplicado (el duplicado se decide al leer)';
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
