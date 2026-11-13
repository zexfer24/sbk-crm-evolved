-- ============================================================================
-- Relleno de la foto de venta para los envíos a SAINT que ya existen
-- (13/11/2026, plan "Paneles", B1).
--
-- QUÉ HACE: crea en `public.ventas_saint` la foto de cada borrador de
-- `liminal.saint_borradores` que NO tiene una (los anteriores al trigger de
-- M1, `20261113010000_ventas_saint.sql`: 194 en producción el 13/11/2026), con
-- `estimado = true`. Es un script REVISADO, no una migración: el contenido
-- depende de datos que solo conoce producción (qué cuentas atienden el
-- mostrador, cuándo se desplegó el recargo). Mismo patrón que
-- `2026-09-18-catalogos-iniciales.sql`: llega con huecos `<<...>>` que el
-- Claude del VPS completa, y una guarda aborta si queda alguno.
--
-- POR QUÉ `estimado`: el trigger de M1 toma la foto en el instante del envío,
-- con el precio y la tasa de ESE momento. Estas 194 no tuvieron esa suerte;
-- lo que se hace aquí es reconstruirlas con lo que se sabe hoy, y la
-- reconstrucción tiene tres fuentes de error que los paneles deben poder
-- aislar (por eso la marca): (1) el carrito/presupuesto de origen pudo
-- cambiar o borrarse después, (2) los precios y el peso del catálogo son los de
-- hoy (SAINT los sincroniza cada minuto), y (3) el canal de un presupuesto
-- borrado se DEDUCE (`canal_fuente = 'inferido'`), no se registró.
--
-- LOS DOS HUECOS (los completa el Claude del VPS; nada de esto está en el repo):
--   <<INSTANTE_RECARGO>>   timestamptz del deploy del hotfix del recargo del
--                          16 % (6/11/2026, `recargo-precio.ts`), con zona
--                          horaria explícita. Ej.: '2026-11-06 14:30:00-04'.
--                          Los envíos ANTERIORES a ese instante se valoran SIN
--                          el recargo: es lo que el CRM mostraba entonces.
--   <<CUENTAS_MOSTRADOR>>  `agents.id` (uuid) de las cuentas que atienden el
--                          mostrador, separados por coma, o '' si no hay
--                          ninguna. Un presupuesto BORRADO armado por una de
--                          ellas se infiere de tienda.
-- Se completan editando las dos líneas `\set` de la sección 0, o sin tocar el
-- archivo con `-v instante_recargo='2026-11-06 14:30:00-04'` y `-v
-- cuentas_mostrador='uuid1,uuid2'` en la línea de comandos (una variable ya
-- definida gana sobre el valor del archivo).
--
-- CÓMO CORRERLO (siempre como `postgres`; `ventas_saint` no tiene ningún grant
-- para la API). Primero la PRUEBA, que no escribe nada (es el valor por
-- defecto de `dry_run`); mirar el resumen; recién entonces el modo real:
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < scripts/sql/2026-11-ventas-saint-backfill.sql               # prueba
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -v dry_run=false -f - < scripts/sql/2026-11-ventas-saint-backfill.sql  # real
--
-- SIN `-1`: el archivo abre y cierra su propia transacción (`begin` ... `commit`
-- o `rollback`). Requiere psql >= 13 (`\if :{?variable}`). Aplica DESPUÉS de la
-- migración M1 (si falta la tabla, la función o el trigger, aborta sin tocar
-- nada). Idempotente: una segunda corrida no encuentra borradores sin foto y
-- no cambia nada (`on conflict (borrador_id) do nothing`).
--
-- QUÉ DECIDE, borrador por borrador (todos los estados: el trigger de M1 toma
-- foto de cada INSERT, sea `creado`, `error` o lo que sea; el panel filtra por
-- estado uniendo con el borrador):
--
--   Renglones: los `items` del borrador (codprod, cantidad) unidos a
--     `products.saint_code`. Un código que ya no existe queda como renglón sin
--     precio (`lineas_sin_precio`, monto null: nunca un total parcial). El tipo
--     de precio (`promocion`/`estandar`) se lee del carrito o presupuesto de
--     origen SI todavía existe y todavía trae ese producto; si no, `promocion`
--     (los `items` del borrador no guardan el tipo).
--
--   Tasa: la de `exchange_rates` del día del envío (día de Caracas; si ese día
--     no hay tasa, la más reciente anterior: fines de semana y feriados).
--
--   Precio: desde el INSTANTE_RECARGO, exactamente el del CRM: la función
--     `public.precio_venta_usd` de M1 (no se copia). ANTES, el de entonces, SIN
--     recargo, con una función temporal de este script. Se descartó "dividir
--     por 1,16 y reusar la de M1": para un producto en USD el techo a $0,10 lo
--     metió el recargo (`usdConRecargo`); antes un producto en USD se mostraba
--     tal cual (3,45 era 3,45, no 3,50), y dividir y volver a aplicar el
--     recargo lo habría subido. Lo que el CRM hacía antes del 6/11/2026:
--       · USD  -> el precio tal cual.
--       · Bs   -> bolívares / tasa con techo a $0,10 (`usdFromBs`, desde el
--                 27/9/2026) — sin el 16 %.
--       · estándar -> lo anterior + la tarifa MRW de HOY (`tarifa_mrw_usd`; la
--                 tabla no guarda historia).
--
--   Canal:
--     · carrito                                   -> online / registro
--     · presupuesto VIVO                          -> `origen`: chat = online,
--                                                    inventario = tienda / registro
--     · presupuesto BORRADO (95 de 98 enviados el 13/11/2026: ya no existe su
--       `origen` ni su `conversation_id`)         -> tienda si el `codclie` es
--       el cliente genérico del mostrador O `creado_por` está en
--       CUENTAS_MOSTRADOR; si no, online / inferido.
--     El cliente genérico se detecta aquí mismo: un `codclie` con 20 o más
--     envíos `creado` en los últimos 30 días. El script AVISA cuáles detectó
--     (`notice`) y el resumen del modo de prueba lo repite: revísalo, un
--     cliente corporativo con 20 pedidos al mes lo haría pasar por mostrador.
--
--   `posible_duplicado`: la misma regla de M1 (otro envío del mismo origen, o
--     de la misma conversación, con las mismas líneas codprod+cantidad y menos
--     de 24 h antes). Se compara contra TODOS los borradores, con o sin foto, y
--     un empate exacto de instante lo desempata el id (el trigger de M1 solo
--     ve lo anterior: dos envíos idénticos del mismo segundo se marcarían
--     entre sí). `rol_envia` es el rol ACTUAL del agente: el de entonces no se
--     guardó.
--
-- PARA QUE LA PRUEBA LOCAL REUTILICE ESTE CUERPO sin que `commit` lo cierre,
-- el archivo acepta `\set ya_en_transaccion true`: entonces no abre ni cierra
-- transacción y todo corre dentro de un `savepoint`. En el VPS NO se usa.
-- La prueba es `scripts/sql/2026-11-ventas-saint-backfill.test.sql`.
-- ============================================================================

-- Segunda guarda contra el falso éxito (mismo motivo que
-- `2026-09-18-catalogos-iniciales.sql`): un metacomando de psql, fuera de la
-- transacción y antes de cualquier sentencia.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0) VARIABLES — editar SOLO acá. Los `\if` dejan que una variable ya definida
--    (`-v ...` o la prueba local) gane sobre el valor del archivo.
-- ---------------------------------------------------------------------------

-- Modo. `true` (prueba: no escribe nada) salvo que se diga lo contrario.
\if :{?dry_run}
\else
  \set dry_run true
\endif

\if :{?instante_recargo}
\else
  \set instante_recargo '<<INSTANTE_RECARGO>>'
\endif

\if :{?cuentas_mostrador}
\else
  \set cuentas_mostrador '<<CUENTAS_MOSTRADOR>>'
\endif

\if :{?ya_en_transaccion}
\else
  \set ya_en_transaccion false
\endif

\if :ya_en_transaccion
\else
  begin;
\endif

savepoint backfill_ventas_saint;

-- ---------------------------------------------------------------------------
-- 1) GUARDA — aborta el script ENTERO (sin escribir nada) si queda un hueco
--    sin completar, si el modo no es exactamente `true`/`false` (un valor raro
--    haría que `\if` lo tratara como falso y COMMITEARA de verdad), si los dos
--    valores no se pueden interpretar, o si falta lo que M1 debía crear.
-- ---------------------------------------------------------------------------

drop table if exists _bf_config;
create temporary table _bf_config (modo text, instante text, cuentas text) on commit drop;
insert into _bf_config values (:'dry_run', :'instante_recargo', :'cuentas_mostrador');

do $$
declare
  c record;
  v_ts timestamptz;
  v_cuenta text;
begin
  select * into c from _bf_config;

  if c.modo not in ('true', 'false') then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: dry_run vale "%" y solo se acepta exactamente true o false. No se escribió nada.', c.modo;
  end if;

  if c.instante like '%<<%' or c.cuentas like '%<<%' then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: quedan huecos "<<...>>" sin completar (INSTANTE_RECARGO y/o CUENTAS_MOSTRADOR, sección 0). Complétalos con los valores reales de producción y reintenta -- no se escribió nada.';
  end if;

  -- El instante, con hora Y zona explícitas: sin zona se leería en la zona de
  -- la sesión y el corte quedaría corrido horas.
  if c.instante !~ '[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)? ?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: INSTANTE_RECARGO "%" debe traer hora y zona horaria explícita (ej. 2026-11-06 14:30:00-04). No se escribió nada.', c.instante;
  end if;
  begin
    v_ts := c.instante::timestamptz;
  exception when others then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: INSTANTE_RECARGO "%" no es un timestamptz válido (%). No se escribió nada.', c.instante, sqlerrm;
  end;
  if v_ts > now() then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: INSTANTE_RECARGO % está en el futuro. No se escribió nada.', v_ts;
  end if;

  -- Las cuentas de mostrador: lista de uuid separados por coma ('' = ninguna).
  if btrim(c.cuentas) <> '' then
    foreach v_cuenta in array string_to_array(c.cuentas, ',')
    loop
      begin
        perform btrim(v_cuenta)::uuid;
      exception when others then
        raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: CUENTAS_MOSTRADOR trae "%" que no es un uuid. No se escribió nada.', btrim(v_cuenta);
      end;
      if not exists (select 1 from public.agents a where a.id = btrim(v_cuenta)::uuid) then
        raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: CUENTAS_MOSTRADOR trae % que no es un agents.id de esta base. No se escribió nada.', btrim(v_cuenta);
      end if;
    end loop;
  end if;

  -- Lo que M1 debía haber creado.
  if to_regclass('public.ventas_saint') is null
     or to_regprocedure('public.precio_venta_usd(public.products,text,numeric)') is null then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: falta public.ventas_saint o public.precio_venta_usd -- aplica la migración 20261113010000_ventas_saint.sql ANTES. No se escribió nada.';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'liminal.saint_borradores'::regclass
       and tgname = 'ventas_saint_foto_after_insert' and not tgisinternal
  ) then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: falta el trigger ventas_saint_foto_after_insert (M1). Sin él, los envíos nuevos durante el relleno quedarían sin foto. No se escribió nada.';
  end if;
end
$$;

-- Ajustes ya tipados.
drop table if exists _bf_ajustes;
create temporary table _bf_ajustes on commit drop as
select c.instante::timestamptz as instante,
       case when btrim(c.cuentas) = '' then '{}'::uuid[]
            else (select array_agg(btrim(x)::uuid) from unnest(string_to_array(c.cuentas, ',')) x)
       end as cuentas
  from _bf_config c;

-- ---------------------------------------------------------------------------
-- 2) El precio de ANTES del recargo (6/11/2026) — ver la cabecera. Función
--    temporal: vive en `pg_temp` y desaparece con la sesión. Mismos null que
--    TypeScript: sin tasa para un producto en Bs, sin precio, estándar sin
--    tarifa.
-- ---------------------------------------------------------------------------

create or replace function pg_temp.precio_sin_recargo(
  p_product public.products,
  p_price_kind text,
  p_tasa numeric
) returns numeric
language plpgsql
stable
as $$
declare
  v_epsilon constant numeric := 0.000000001;  -- el mismo de usd-price.ts y de M1
  v_usd numeric;
  v_tarifa numeric;
begin
  if p_product.price is null or p_product.price <= 0 then
    return null;
  end if;

  if p_product.currency = 'USD' then
    v_usd := round(p_product.price, 2);
  else
    if p_tasa is null or p_tasa <= 0 then
      return null;
    end if;
    v_usd := round(ceil(p_product.price / p_tasa * 10 - v_epsilon) / 10, 2);
  end if;

  if p_price_kind = 'estandar' then
    v_tarifa := public.tarifa_mrw_usd(p_product.weight_kg);
    if v_tarifa is null then
      return null;
    end if;
    return round(v_usd + v_tarifa, 2);
  end if;

  return v_usd;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) El cliente genérico del mostrador (un `codclie` con 20 o más envíos
--    `creado` en los últimos 30 días) y la base de TODOS los borradores.
-- ---------------------------------------------------------------------------

drop table if exists _bf_genericos;
create temporary table _bf_genericos on commit drop as
select b.codclie, count(*) as envios
  from liminal.saint_borradores b
 where b.estado = 'creado'
   and b.codclie is not null and btrim(b.codclie) <> ''
   and b.created_at > now() - interval '30 days'
 group by b.codclie
having count(*) >= 20;

do $$
declare
  r record;
  v_n integer := 0;
begin
  for r in select codclie, envios from _bf_genericos order by envios desc loop
    v_n := v_n + 1;
    raise notice 'Cliente genérico de mostrador detectado: codclie % (% envíos "creado" en 30 días).', r.codclie, r.envios;
  end loop;
  if v_n = 0 then
    raise notice 'Ningún codclie llega a 20 envíos "creado" en 30 días: el canal de los presupuestos borrados solo se infiere por CUENTAS_MOSTRADOR.';
  end if;
end
$$;

-- Todos los borradores, con lo que se sabe de su origen HOY.
drop table if exists _bf_base;
create temporary table _bf_base on commit drop as
select b.id,
       b.origen,
       b.origen_id,
       b.created_at,
       b.creado_por,
       b.codclie,
       b.items,
       (select string_agg(i.codprod || ':' || i.cantidad, ',' order by i.codprod)
          from jsonb_to_recordset(b.items) as i(codprod text, cantidad int)) as firma,
       pr.id as pres_vivo,
       pr.origen as pres_origen,
       pr.created_by as pres_creador,
       coalesce(vs.conversation_id,
                case when b.origen = 'carrito' then b.origen_id else pr.conversation_id end) as conversation_id,
       (vs.borrador_id is not null) as tiene_foto
  from liminal.saint_borradores b
  left join public.presupuestos pr on b.origen = 'presupuesto' and pr.id = b.origen_id
  left join public.ventas_saint vs on vs.borrador_id = b.id;

create index on _bf_base (id);

-- Los que se van a rellenar, con la tasa del día de su envío.
drop table if exists _bf_pend;
create temporary table _bf_pend on commit drop as
select b.*,
       (select case when er.usd_to_ves > 0 then er.usd_to_ves end
          from public.exchange_rates er
         where er.rate_date <= (b.created_at at time zone 'America/Caracas')::date
         order by er.rate_date desc
         limit 1) as tasa
  from _bf_base b
 where not b.tiene_foto;

-- ---------------------------------------------------------------------------
-- 4) Una línea por renglón del borrador, con su precio.
-- ---------------------------------------------------------------------------

drop table if exists _bf_lineas;
create temporary table _bf_lineas on commit drop as
select b.id as borrador_id,
       p.id as product_id,
       btrim(i.codprod) as codprod,
       p.name as nombre,
       i.cantidad,
       coalesce(pi.price_kind, ci.price_kind, 'promocion') as kind,
       case
         when p.id is null then null
         when b.created_at >= a.instante
           then public.precio_venta_usd(p, coalesce(pi.price_kind, ci.price_kind, 'promocion'), b.tasa)
         else pg_temp.precio_sin_recargo(p, coalesce(pi.price_kind, ci.price_kind, 'promocion'), b.tasa)
       end as precio
  from _bf_pend b
  cross join _bf_ajustes a
  cross join lateral jsonb_to_recordset(b.items) as i(codprod text, cantidad int)
  left join public.products p on btrim(p.saint_code) = btrim(i.codprod)
  left join public.presupuesto_items pi
         on b.origen = 'presupuesto' and b.pres_vivo is not null
        and pi.presupuesto_id = b.origen_id and pi.product_id = p.id
  left join public.conversation_cart_items ci
         on b.origen = 'carrito'
        and ci.conversation_id = b.origen_id and ci.product_id = p.id;

-- ---------------------------------------------------------------------------
-- 5) La foto de cada uno. `returning` deja en `_bf_creadas` lo que ESTA corrida
--    escribió (lo que ya tenía foto, o un conflicto, no entra).
-- ---------------------------------------------------------------------------

drop table if exists _bf_creadas;
create temporary table _bf_creadas (borrador_id uuid primary key) on commit drop;

with fotos as (
  select b.id,
         b.created_at,
         b.origen,
         b.origen_id,
         b.creado_por,
         b.tasa,
         b.conversation_id,
         x.lineas,
         x.unidades,
         x.sin_precio,
         x.monto,
         -- Canal y de dónde sale.
         case
           when b.origen = 'carrito' then 'online'
           when b.pres_vivo is not null then (case b.pres_origen when 'chat' then 'online' else 'tienda' end)
           when b.codclie in (select g.codclie from _bf_genericos g)
                or b.creado_por = any (a.cuentas) then 'tienda'
           else 'online'
         end as canal,
         case
           when b.origen = 'carrito' or b.pres_vivo is not null then 'registro'
           else 'inferido'
         end as canal_fuente,
         -- Quién armó el pedido: el último que tocó el carrito (igual que el
         -- trigger de M1) o el autor del presupuesto, si todavía existen.
         case b.origen
           when 'carrito' then (
             select ci.added_by
               from public.conversation_cart_items ci
              where ci.conversation_id = b.origen_id
              order by ci.updated_at desc, ci.created_at desc
              limit 1)
           else b.pres_creador
         end as armado_por,
         exists (
           select 1
             from _bf_base o
            where o.id <> b.id
              and (o.created_at, o.id) < (b.created_at, b.id)
              and o.created_at > b.created_at - interval '24 hours'
              and (o.origen_id = b.origen_id
                   or (b.conversation_id is not null and o.conversation_id = b.conversation_id))
              and o.firma = b.firma
         ) as dup
    from _bf_pend b
    cross join _bf_ajustes a
    cross join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
                        'product_id', l.product_id,
                        'codprod', l.codprod,
                        'nombre', l.nombre,
                        'cantidad', l.cantidad,
                        'precio_usd', l.precio,
                        'price_kind', l.kind)
                      order by l.codprod), '[]'::jsonb) as lineas,
             coalesce(sum(l.cantidad), 0)::int as unidades,
             (count(*) filter (where l.precio is null))::int as sin_precio,
             case
               when count(*) = 0 or count(*) filter (where l.precio is null) > 0 then null
               else round(sum(l.cantidad * l.precio), 2)
             end as monto
        from _bf_lineas l
       where l.borrador_id = b.id
    ) x
),
nuevas as (
  insert into public.ventas_saint (
    borrador_id, created_at, origen, canal, canal_fuente, conversation_id, presupuesto_id,
    armado_por, enviado_por, rol_envia, unidades, monto_usd, monto_bs, tasa_bcv,
    lineas, lineas_sin_precio, estimado, posible_duplicado
  )
  select f.id, f.created_at, f.origen, f.canal, f.canal_fuente, f.conversation_id,
         case when f.origen = 'presupuesto' then f.origen_id end,
         f.armado_por, f.creado_por,
         (select ag.role from public.agents ag where ag.id = f.creado_por),
         f.unidades, f.monto,
         case when f.monto is null or f.tasa is null then null else round(f.monto * f.tasa, 2) end,
         f.tasa, f.lineas, f.sin_precio, true, f.dup
    from fotos f
  on conflict (borrador_id) do nothing
  returning borrador_id
)
insert into _bf_creadas select borrador_id from nuevas;

-- Todo borrador que estaba pendiente tiene que tener foto ahora.
do $$
declare
  v_sin integer;
begin
  select count(*) into v_sin
    from _bf_pend p
   where not exists (select 1 from public.ventas_saint v where v.borrador_id = p.id);
  if v_sin > 0 then
    raise exception 'scripts/sql/2026-11-ventas-saint-backfill.sql: % borrador(es) siguen sin foto después del relleno. No se confirma nada.', v_sin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6) RESUMEN — se muestra en los dos modos, ANTES de decidir qué hacer.
-- ---------------------------------------------------------------------------

\echo
\echo '=== RESUMEN DEL RELLENO DE ventas_saint ==='
\echo

\echo '-- Totales de esta corrida'
select (select count(*) from _bf_base) as borradores_en_total,
       (select count(*) from _bf_base where tiene_foto) as ya_tenian_foto,
       (select count(*) from _bf_creadas) as fotos_que_crea_esta_corrida,
       (select count(*) from _bf_creadas c join public.ventas_saint v on v.borrador_id = c.borrador_id
         where v.monto_usd is null) as sin_precio_completo,
       (select count(*) from _bf_creadas c join public.ventas_saint v on v.borrador_id = c.borrador_id
         where v.posible_duplicado) as posibles_duplicados,
       (select count(*) from _bf_creadas c join public.ventas_saint v on v.borrador_id = c.borrador_id
         where v.created_at < (select instante from _bf_ajustes)) as anteriores_al_recargo;

\echo
\echo '-- Fotos por canal y fuente del canal (monto estimado = suma de los envíos con precio completo)'
select v.canal, v.canal_fuente,
       count(*) as fotos,
       count(*) filter (where v.monto_usd is null) as sin_precio,
       round(coalesce(sum(v.monto_usd), 0), 2) as monto_usd_estimado
  from _bf_creadas c
  join public.ventas_saint v on v.borrador_id = c.borrador_id
 group by v.canal, v.canal_fuente
 order by v.canal, v.canal_fuente;

\echo
\echo '-- Monto estimado por canal y semana (lunes, hora de Caracas)'
select v.canal,
       date_trunc('week', v.created_at at time zone 'America/Caracas')::date as semana,
       count(*) as fotos,
       count(*) filter (where v.monto_usd is null) as sin_precio,
       round(coalesce(sum(v.monto_usd), 0), 2) as monto_usd_estimado
  from _bf_creadas c
  join public.ventas_saint v on v.borrador_id = c.borrador_id
 group by v.canal, semana
 order by semana, v.canal;

\echo
\echo '-- Clientes genéricos detectados (codclie con 20 o más envíos "creado" en 30 días)'
select codclie, envios from _bf_genericos order by envios desc;

\echo

-- ---------------------------------------------------------------------------
-- 7) Cierre. `dry_run = true`: se deshace TODO. `false`: se confirma.
-- ---------------------------------------------------------------------------

\if :dry_run
  \echo 'MODO DE PRUEBA (dry_run = true): se deshace todo, no se escribió nada. Para escribir de verdad: -v dry_run=false'
  rollback to savepoint backfill_ventas_saint;
\else
  \echo 'MODO REAL (dry_run = false): se confirman las fotos del resumen.'
  release savepoint backfill_ventas_saint;
\endif

\if :ya_en_transaccion
\else
  \if :dry_run
    rollback;
  \else
    commit;
  \endif
\endif
