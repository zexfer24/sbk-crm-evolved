-- ============================================================================
-- Datos de demostración de los paneles (13/11/2026), plan "Paneles", tarea D1.
-- SOLO PARA LA BASE LOCAL: nunca se corre contra producción.
--
-- Por qué existe: la base local no tiene envíos a SAINT, así que los tres
-- paneles (Dashboard de ventas, Analíticas, Asesores) se verían vacíos. Este
-- script carga 30 días de actividad verosímil de punta a punta y
-- `demo-paneles-borrar.sql` la quita sin dejar rastro.
--
-- Cómo corre (como postgres, mismo patrón que los demás scripts de este
-- directorio; abre y cierra su propia transacción):
--   docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/demo-paneles.sql
--
-- Qué hace:
--   · Los envíos a SAINT NO se inventan: se llama a `public.enviar_borrador_saint`
--     con sesión de `authenticated` (claims de jose/maria/carlos) para que el
--     trigger `ventas_saint_foto` corra tal cual en producción. Después, como
--     postgres, se simula a LiminalReplicant (estado, número, codclie) y se
--     retrofechan borradores y fotos.
--   · Mensajes, carritos y presupuestos se insertan con `created_at` explícito y
--     en orden cronológico por conversación, así los triggers de `messages`
--     calculan bien last_message_at / last_reply_at / awaiting_reply.
--   · Es idempotente: si ya hay datos demo, primero los borra.
--   · Es casi determinista: `setseed` fija el azar; el volumen y la forma no cambian entre
--     corridas, solo se desplaza con la fecha.
--
-- Cómo se marca lo que crea (el borrado es exacto):
--   · contactos: profile_name = 'DEMO-PANELES' (y teléfono +584990xxxxxx);
--     sus conversaciones, mensajes, carritos, etiquetas y traspasos se van por
--     ON DELETE CASCADE.
--   · presupuestos: nota = 'DEMO-PANELES'.
--   · productos: saint_code 'DEMO-001'..'DEMO-013' y description 'DEMO-PANELES'.
--   · borradores y fotos: los que cuelgan de esas conversaciones y presupuestos
--     (numero_saint 'DEMO-xxxxxx', nombre 'Demo').
--   · tasas BCV que faltaban: source = 'demo-paneles'.
--
-- Qué NO toca: supabase/seed.sql, migraciones, metas_venta (las siembra M2) ni
-- ninguna fila que no sea demo. Único efecto lateral que se restaura: el
-- trigger de asignación escribe agents.last_assigned_at; se vuelve a su valor.
--
-- Perilla de volumen: `v_factor` (más abajo) multiplica la cantidad de cada
-- renglón. A 1, los 30 días suman unos pocos miles de dólares y la meta diaria
-- del seed (online 2.600 $ / tienda 1.800 $) se ve lejana; con 5 o 6 el avance
-- queda cerca de la meta.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 0. Borrado previo (idempotencia). Mismas sentencias que demo-paneles-borrar.sql.
-- ---------------------------------------------------------------------------
create temp table _demo_conv on commit drop as
  select c.id
    from public.conversations c
    join public.contacts ct on ct.id = c.contact_id
   where ct.profile_name = 'DEMO-PANELES';
create temp table _demo_pres on commit drop as
  select id from public.presupuestos where nota = 'DEMO-PANELES';

delete from public.ventas_saint
 where borrador_id in (
         select b.id from liminal.saint_borradores b
          where (b.origen = 'carrito' and b.origen_id in (select id from _demo_conv))
             or (b.origen = 'presupuesto' and b.origen_id in (select id from _demo_pres)))
    or conversation_id in (select id from _demo_conv)
    or presupuesto_id in (select id from _demo_pres);
delete from liminal.saint_borradores b
 where (b.origen = 'carrito' and b.origen_id in (select id from _demo_conv))
    or (b.origen = 'presupuesto' and b.origen_id in (select id from _demo_pres));
delete from public.presupuestos where nota = 'DEMO-PANELES';
delete from public.contacts where profile_name = 'DEMO-PANELES';
delete from public.products where description = 'DEMO-PANELES' and saint_code like 'DEMO-%';
delete from public.exchange_rates where source = 'demo-paneles';

-- ---------------------------------------------------------------------------
-- Auxiliares (viven en pg_temp: desaparecen con la sesión).
-- ---------------------------------------------------------------------------

-- Minutos (con decimales) a interval.
create function pg_temp.mins(p_min numeric) returns interval
language sql immutable as $f$
  select make_interval(secs => (p_min * 60)::double precision);
$f$;

-- Demora de primera respuesta en minutos según quién responde:
-- 0 = Seba (IA), 1 = jose, 2 = maria, 3 = carlos. La mezcla da una mediana
-- distinta por persona y respuestas a 2, 8, 30 y 90 minutos.
create function pg_temp.demora(p_ix int) returns numeric
language plpgsql volatile as $f$
declare
  v_arr numeric[];
begin
  v_arr := case p_ix
    when 0 then array[1, 1, 2]
    when 1 then array[2, 8, 8, 30, 30, 90]
    when 2 then array[2, 2, 2, 2, 8, 8, 30]
    else array[8, 8, 30, 30, 90, 90, 2]
  end;
  return v_arr[1 + floor(random() * array_length(v_arr, 1))::int];
end;
$f$;

-- Frases de la conversación (8 por tipo; se elige por índice).
create function pg_temp.frase(p_tipo text, p_i int) returns text
language sql immutable as $f$
  select (case p_tipo
    when 'abre' then array[
      'Buenas tardes, ¿tienen kit de arrastre para Bera SBR?',
      '¿Cuánto cuesta el filtro de aceite?',
      'Hola, necesito pastillas de freno delanteras',
      'Buen día, ¿tienen neumático 90/90-18?',
      '¿Tienen batería 12V para moto?',
      'Me interesa un casco integral, ¿qué tienen?',
      'Necesito aceite 20W50, ¿a cómo lo tienen?',
      'Buenas, quiero cotizar una cadena 428H']
    when 'sigue' then array[
      'Dale, me interesa',
      'Perfecto, ¿cuánto sería en total?',
      'Sí, lo quiero',
      '¿Aceptan pago móvil?',
      'Listo, ¿qué datos necesitas para la factura?',
      'Mándame la cotización por favor',
      '¿Hacen envío por MRW?',
      'Está bien, agrégalo']
    when 'resp' then array[
      'Hola, claro que sí. Te cotizo enseguida.',
      'Tenemos disponible, ¿cuántas unidades necesitas?',
      'Con gusto, te armo el pedido.',
      'Sí, lo tenemos en tienda. ¿Lo retiras o te lo enviamos?',
      'Te paso el precio en un momento.',
      'Perfecto, quedo atento a tu confirmación.',
      'Sí hacemos envíos por MRW a todo el país.',
      'Listo, te lo dejo apartado.']
    when 'cierra' then array[
      'Listo, ya generé tu pedido para facturar.',
      'Perfecto, estoy procesando tu factura.',
      'Gracias por tu compra, enseguida la facturamos.',
      'Pedido enviado a facturar, en un momento te confirmo.',
      'Ya quedó tu pedido, gracias por elegirnos.',
      'Todo listo, tu factura está en proceso.',
      'Perfecto, ya lo mandé a facturar.',
      'Hecho, gracias por tu compra.']
    else array[
      'Gracias, quedo atento',
      '¡Muchas gracias!',
      'Perfecto, gracias',
      'Ok, gracias por la ayuda',
      'Genial, muchas gracias',
      'Gracias, hasta luego',
      'Listo, gracias',
      'Excelente, gracias']
  end)[1 + (abs(p_i) % 8)];
$f$;

-- Un mensaje de texto de la conversación, con su fecha exacta.
create function pg_temp.dm(p_conv uuid, p_sender text, p_agent uuid, p_texto text, p_ts timestamptz) returns void
language sql as $f$
  insert into public.messages (
    conversation_id, direction, sender_type, sender_agent_id, message_type,
    content, whatsapp_status, created_at)
  values (
    p_conv,
    case when p_sender = 'customer' then 'inbound' else 'outbound' end,
    p_sender, p_agent, 'text', p_texto,
    case when p_sender = 'customer' then null else 'read' end,
    p_ts);
$f$;

-- Contacto demo + su conversación (devuelve la conversación).
create function pg_temp.dc(p_i int, p_ts timestamptz, p_status text default 'open', p_asig uuid default null) returns uuid
language plpgsql as $f$
declare
  v_ct uuid;
  v_cv uuid;
begin
  insert into public.contacts (phone_number, display_name, profile_name, created_at, updated_at)
  values ('+584990' || lpad(p_i::text, 6, '0'), 'Demo Cliente ' || lpad(p_i::text, 3, '0'),
          'DEMO-PANELES', p_ts, p_ts)
  returning id into v_ct;
  insert into public.conversations (contact_id, whatsapp_channel_id, status, assigned_agent_id, created_at)
  values (v_ct, 'aaaaaaaa-0000-0000-0000-000000000001', p_status, p_asig, p_ts)
  returning id into v_cv;
  return v_cv;
end;
$f$;

-- Renglones al azar (1 a 3 productos distintos) en un carrito o un presupuesto.
-- p_con013: agrega el producto sin precio (la venta saldrá sin monto).
create function pg_temp.renglones(
  p_carrito boolean, p_id uuid, p_ts_creado timestamptz, p_ts_cambio timestamptz,
  p_agente uuid, p_con013 boolean, p_factor int
) returns void
language plpgsql as $f$
declare
  r record;
  v_np int := 1 + floor(random() * 3)::int;
  v_kind text;
begin
  for r in
    select id, qmax from _prod where code <> 'DEMO-013' order by random() limit v_np
  loop
    v_kind := case when random() < 0.25 then 'estandar' else 'promocion' end;
    if p_carrito then
      insert into public.conversation_cart_items
        (conversation_id, product_id, quantity, origin, added_by, created_at, updated_at, price_kind)
      values (p_id, r.id, (1 + floor(random() * r.qmax))::int * p_factor, 'inventory',
              p_agente, p_ts_creado, p_ts_cambio, v_kind);
    else
      insert into public.presupuesto_items
        (presupuesto_id, product_id, quantity, price_kind, created_at)
      values (p_id, r.id, (1 + floor(random() * r.qmax))::int * p_factor, v_kind, p_ts_creado);
    end if;
  end loop;
  if p_con013 then
    if p_carrito then
      insert into public.conversation_cart_items
        (conversation_id, product_id, quantity, origin, added_by, created_at, updated_at, price_kind)
      select p_id, id, 1, 'inventory', p_agente, p_ts_creado, p_ts_cambio, 'promocion'
        from _prod where code = 'DEMO-013';
    else
      insert into public.presupuesto_items (presupuesto_id, product_id, quantity, price_kind, created_at)
      select p_id, id, 1, 'promocion', p_ts_creado from _prod where code = 'DEMO-013';
    end if;
  end if;
end;
$f$;

-- ---------------------------------------------------------------------------
-- 1. Productos, tasas y plan de las 120 ventas.
-- ---------------------------------------------------------------------------
do $demo$
declare
  v_tz constant text := 'America/Caracas';
  v_ahora constant timestamptz := now();
  v_hoy0 constant timestamptz := date_trunc('day', now() at time zone 'America/Caracas') at time zone 'America/Caracas';
  v_hoy_fecha constant date := (now() at time zone 'America/Caracas')::date;
  v_ag constant uuid[] := array[
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333']::uuid[];
  v_horas constant int[] := array[8,9,9,10,10,10,11,11,11,12,12,13,14,14,15,15,15,16,16,17];
  v_dias int[];
  i int;
  v_ts timestamptz;
  v_a timestamptz;
  v_r double precision;
  v_sx int;
  v_k int;
begin
  perform setseed(0.42);

  -- El trigger de asignación toca agents.last_assigned_at; se guarda para restaurarlo.
  create temp table _agentes_antes on commit drop as
    select id, last_assigned_at from public.agents;

  -- Días disponibles hacia atrás (1 a 29): sin domingos; los sábados pesan la mitad.
  select array_agg(d) into v_dias from (
    select d from generate_series(1, 29) d
     where extract(dow from (v_hoy0 - d * interval '1 day') at time zone v_tz) <> 0
    union all
    select d from generate_series(1, 29) d
     where extract(dow from (v_hoy0 - d * interval '1 day') at time zone v_tz) not in (0, 6)
  ) x;

  -- Productos demo: casi todos en bolívares (como Saint), dos en USD, uno sin precio.
  insert into public.products
    (name, brand, price, currency, stock_quantity, description, is_active, weight_kg, saint_code)
  values
    ('DEMO Kit de arrastre 428H', 'DEMO', 36000, 'VES', 60, 'DEMO-PANELES', true, 1.8, 'DEMO-001'),
    ('DEMO Bujía NGK CR7HSA', 'DEMO', 2800, 'VES', 60, 'DEMO-PANELES', true, 0.05, 'DEMO-002'),
    ('DEMO Pastillas de freno delanteras', 'DEMO', 6500, 'VES', 60, 'DEMO-PANELES', true, 0.3, 'DEMO-003'),
    ('DEMO Filtro de aceite', 'DEMO', 3200, 'VES', 60, 'DEMO-PANELES', true, 0.2, 'DEMO-004'),
    ('DEMO Aceite 20W50 1L', 'DEMO', 7800, 'VES', 60, 'DEMO-PANELES', true, 1.0, 'DEMO-005'),
    ('DEMO Cadena 428H 120 eslabones', 'DEMO', 14500, 'VES', 60, 'DEMO-PANELES', true, 1.3, 'DEMO-006'),
    ('DEMO Neumático 90/90-18', 'DEMO', 52000, 'VES', 60, 'DEMO-PANELES', true, 3.5, 'DEMO-007'),
    ('DEMO Batería 12V 5Ah', 'DEMO', 38000, 'VES', 60, 'DEMO-PANELES', true, 1.9, 'DEMO-008'),
    ('DEMO Casco integral', 'DEMO', 95000, 'VES', 60, 'DEMO-PANELES', true, 1.4, 'DEMO-009'),
    ('DEMO Guaya de acelerador', 'DEMO', 1800, 'VES', 60, 'DEMO-PANELES', true, 0.2, 'DEMO-010'),
    ('DEMO Espejo retrovisor', 'DEMO', 6.50, 'USD', 60, 'DEMO-PANELES', true, 0.4, 'DEMO-011'),
    ('DEMO Kit de empacaduras', 'DEMO', 22.00, 'USD', 60, 'DEMO-PANELES', true, 0.8, 'DEMO-012'),
    ('DEMO Accesorio por definir', 'DEMO', 0, 'VES', 60, 'DEMO-PANELES', true, 0.5, 'DEMO-013');

  create temp table _prod on commit drop as
    select p.id, p.saint_code as code,
           case p.saint_code
             when 'DEMO-001' then 2 when 'DEMO-002' then 6 when 'DEMO-003' then 3
             when 'DEMO-004' then 6 when 'DEMO-005' then 6 when 'DEMO-006' then 2
             when 'DEMO-007' then 2 when 'DEMO-008' then 2 when 'DEMO-009' then 1
             when 'DEMO-010' then 6 when 'DEMO-011' then 3 when 'DEMO-012' then 2
             else 1 end as qmax
      from public.products p
     where p.saint_code like 'DEMO-%';

  -- Tasas BCV de los últimos 30 días que falten (una subida suave de ~870 a ~912).
  insert into public.exchange_rates (rate_date, usd_to_ves, source, fetched_at, fetched_on)
  select v_hoy_fecha - k,
         round((870 + 42 * (30 - k) / 30.0 + (random() - 0.5) * 3)::numeric, 4),
         'demo-paneles',
         ((v_hoy_fecha - k)::timestamp + interval '9 hours') at time zone v_tz,
         v_hoy_fecha - k
    from generate_series(0, 30) k
   where not exists (select 1 from public.exchange_rates e where e.rate_date = v_hoy_fecha - k);

  -- El plan: 120 ventas (72 online, 25 del cliente genérico de mostrador, 23 de
  -- tienda con cédulas que se repiten). `hoy` = una de cada ocho cae hoy (15 de 120).
  create temp table _plan (
    ord int primary key,
    canal text not null,
    generico boolean not null,
    hoy boolean not null,
    ts timestamptz not null,
    sx int not null,
    sender uuid not null,
    first_ai boolean not null,
    d1 numeric, d2 numeric, d3 numeric, g1 numeric, g2 numeric,
    estado text not null default 'creado',
    cedula_tipo text not null,
    cedula_numero text not null,
    nombre text not null,
    apellido text not null,
    codclie text not null,
    cliente_creado boolean,
    conv_id uuid,
    pres_id uuid,
    borrador_id uuid,
    es_dup boolean not null default false
  ) on commit drop;

  for i in 1..120 loop
    -- Fecha de la venta.
    if i in (72, 104, 120) then
      -- Los tres envíos todavía "pendiente": recién enviados.
      v_ts := v_ahora - (case i when 72 then 9 when 104 then 3 else 25 end) * interval '1 minute';
    elsif i in (48, 64) then
      -- Los dos que SAINT rechazó (error).
      v_ts := v_ahora - (case i when 48 then 65 else 160 end) * interval '1 minute';
    elsif i % 8 = 0 then
      -- Ventas de hoy repartidas a lo largo de la jornada hasta "ahora".
      v_a := case when v_ahora - v_hoy0 > interval '9 hours' then v_hoy0 + interval '8 hours' else v_hoy0 end;
      v_k := i / 8;
      v_ts := v_a + greatest((v_ahora - interval '35 minutes') - v_a, interval '0')
                    * (((v_k - 0.5) / 15.0 + (random() - 0.5) * 0.03)::double precision);
    else
      v_ts := v_hoy0
              - v_dias[1 + floor(random() * array_length(v_dias, 1))::int] * interval '1 day'
              + v_horas[1 + floor(random() * array_length(v_horas, 1))::int] * interval '1 hour'
              + floor(random() * 60) * interval '1 minute'
              + floor(random() * 60) * interval '1 second';
    end if;

    -- Quién la gestiona: jose 30 %, maria 35 %, carlos 35 %.
    v_r := random();
    v_sx := case when v_r < 0.30 then 1 when v_r < 0.65 then 2 else 3 end;

    insert into _plan (
      ord, canal, generico, hoy, ts, sx, sender, first_ai,
      d1, d2, d3, g1, g2, estado,
      cedula_tipo, cedula_numero, nombre, apellido, codclie)
    values (
      i,
      case when i <= 72 then 'online' else 'tienda' end,
      i between 73 and 97,
      i % 8 = 0,
      v_ts,
      v_sx,
      v_ag[v_sx],
      i <= 72 and random() < 0.30,
      0, 0, 0,
      3 + floor(random() * 12), 3 + floor(random() * 12),
      case when i in (72, 104, 120) then 'pendiente' when i in (48, 64) then 'error' else 'creado' end,
      case when i % 17 = 0 then 'E' else 'V' end,
      case
        when i between 73 and 97 then '90000000'
        when i >= 98 or i in (5, 15, 25, 35, 45, 55, 65, 70) then '9100' || lpad((1 + i % 12)::text, 4, '0')
        else '92' || lpad(i::text, 6, '0')
      end,
      'Demo',
      case
        when i between 73 and 97 then 'Mostrador'
        when i >= 98 or i in (5, 15, 25, 35, 45, 55, 65, 70) then 'Cliente P' || lpad((1 + i % 12)::text, 2, '0')
        else 'Cliente ' || lpad(i::text, 3, '0')
      end,
      case when i between 73 and 97 then 'DEMO-MOSTRADOR' else 'DEMO-' || i::text end);
  end loop;

  -- Los códigos de cliente siguen a la cédula (la pool y los reincidentes comparten).
  update _plan set codclie = 'DEMO-' || cedula_tipo || cedula_numero where not generico;

  -- Demoras de cada episodio (Seba responde primero en una de cada tres ventas online).
  update _plan set
    d1 = pg_temp.demora(case when first_ai then 0 else sx end) + round((random() * 0.8)::numeric, 2),
    d2 = pg_temp.demora(sx) + round((random() * 0.8)::numeric, 2),
    d3 = pg_temp.demora(sx) + round((random() * 0.8)::numeric, 2);
end
$demo$;

-- ---------------------------------------------------------------------------
-- 2. Conversaciones, mensajes, carritos y presupuestos.
-- ---------------------------------------------------------------------------
do $demo$
declare
  v_tz constant text := 'America/Caracas';
  v_ahora constant timestamptz := now();
  v_hoy0 constant timestamptz := date_trunc('day', now() at time zone 'America/Caracas') at time zone 'America/Caracas';
  v_factor constant int := 1;
  v_ag constant uuid[] := array[
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333']::uuid[];
  v_horas constant int[] := array[8,9,9,10,10,10,11,11,11,12,12,13,14,14,15,15,15,16,16,17];
  v_dias int[];
  v_ci int := 0;                       -- contador de contactos (teléfono y nombre)
  p record;
  i int;
  v_conv uuid;
  v_pres uuid;
  v_h uuid;                            -- el asesor humano de la conversación
  v_sx int;
  v_ai boolean;
  v_c1 timestamptz; v_r1 timestamptz; v_c2 timestamptz; v_r2 timestamptz;
  v_c3 timestamptz; v_r3 timestamptz; v_c4 timestamptz; v_r4 timestamptz;
  v_d1 numeric; v_d2 numeric; v_d4 numeric; v_g1 numeric;
  v_ts timestamptz;
  v_cambio timestamptz;
  v_edades constant int[] := array[40, 44, 48, 52, 58, 236, 240, 244, 250, 80, 130, 330, 420, 600];
  v_tag uuid;
  v_conv_pq uuid;                      -- chat sin carrito que recibe el segundo presupuesto del chat
begin
  perform setseed(0.43);

  select array_agg(d) into v_dias from (
    select d from generate_series(1, 29) d
     where extract(dow from (v_hoy0 - d * interval '1 day') at time zone v_tz) <> 0
    union all
    select d from generate_series(1, 29) d
     where extract(dow from (v_hoy0 - d * interval '1 day') at time zone v_tz) not in (0, 6)
  ) x;

  -- 2.1 Las 72 ventas online: conversación + carrito del chat.
  for p in select * from _plan where canal = 'online' order by ord loop
    v_ci := v_ci + 1;
    v_h := p.sender;
    -- Línea de tiempo hacia atrás desde el envío: cada respuesta sigue a un
    -- mensaje del cliente con la demora que le tocó a ese episodio.
    v_r3 := p.ts - interval '1 minute';
    v_c3 := v_r3 - pg_temp.mins(p.d3);
    v_r2 := v_c3 - pg_temp.mins(p.g2);
    v_c2 := v_r2 - pg_temp.mins(p.d2);
    v_r1 := v_c2 - pg_temp.mins(p.g1);
    v_c1 := v_r1 - pg_temp.mins(p.d1);

    v_conv := pg_temp.dc(v_ci, v_c1 - interval '1 minute');
    perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('abre', p.ord), v_c1);
    if p.first_ai then
      perform pg_temp.dm(v_conv, 'ai', null, pg_temp.frase('resp', p.ord), v_r1);
    else
      perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('resp', p.ord), v_r1);
    end if;
    perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('sigue', p.ord), v_c2);
    perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('resp', p.ord + 3), v_r2);
    perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('sigue', p.ord + 5), v_c3);
    perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('cierra', p.ord), v_r3);

    -- Despedida del cliente después de enviar (solo si cabe antes de "ahora").
    v_c4 := p.ts + pg_temp.mins((4 + random() * 4)::numeric);
    v_d4 := pg_temp.demora(p.sx);
    v_r4 := v_c4 + pg_temp.mins(v_d4);
    if v_r4 < v_ahora - interval '1 minute' then
      perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('gracias', p.ord), v_c4);
      perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('gracias', p.ord + 2), v_r4);
    end if;

    -- El carrito que arma el asesor mientras conversa (sigue ahí después del envío).
    perform pg_temp.renglones(true, v_conv, v_r1 + interval '1 minute', v_r3 - interval '20 seconds',
                              v_h, p.ord in (20, 41), v_factor);
    update _plan set conv_id = v_conv where ord = p.ord;
  end loop;

  -- 2.2 Las 48 ventas de tienda: presupuesto de Inventario (sin chat).
  for p in select * from _plan where canal = 'tienda' order by ord loop
    v_h := case when random() < 0.8 then p.sender else v_ag[1 + floor(random() * 3)::int] end;
    v_ts := p.ts - pg_temp.mins((5 + random() * 35)::numeric);
    insert into public.presupuestos
      (cliente_nombre, cliente_apellido, origen, nota, created_by, created_at, updated_at)
    values (p.nombre, p.apellido, 'inventario', 'DEMO-PANELES', v_h, v_ts, v_ts)
    returning id into v_pres;
    perform pg_temp.renglones(false, v_pres, v_ts, v_ts, v_h, p.ord = 90, v_factor);
    update _plan set pres_id = v_pres where ord = p.ord;
  end loop;

  -- 2.3 Conversaciones que solo preguntaron (84): una o dos vueltas y siempre
  -- terminan con una respuesta (si no, llenarían la cola de espera).
  for i in 1..84 loop
    v_ci := v_ci + 1;
    if random() < 0.25 then
      v_sx := 0;                       -- Seba
    else
      v_sx := 1 + floor(random() * 3)::int;
    end if;
    v_h := v_ag[case when v_sx = 0 then 1 + floor(random() * 3)::int else v_sx end];
    v_ai := v_sx = 0;
    v_d1 := pg_temp.demora(v_sx);
    v_d2 := pg_temp.demora(case when v_sx = 0 then 1 + floor(random() * 3)::int else v_sx end);
    v_g1 := 3 + floor(random() * 17);

    if i % 14 = 0 and v_ahora - v_hoy0 > interval '10 hours' then
      -- Algunas de hoy: una sola vuelta, con margen para la demora más larga.
      v_c1 := (v_hoy0 + interval '8 hours')
              + ((v_ahora - interval '100 minutes') - (v_hoy0 + interval '8 hours')) * random()::double precision;
      v_d2 := null;
    else
      v_c1 := v_hoy0
              - v_dias[1 + floor(random() * array_length(v_dias, 1))::int] * interval '1 day'
              + v_horas[1 + floor(random() * array_length(v_horas, 1))::int] * interval '1 hour'
              + floor(random() * 60) * interval '1 minute';
      if random() >= 0.40 then v_d2 := null; end if;
    end if;

    v_conv := pg_temp.dc(v_ci, v_c1 - interval '1 minute');
    perform pg_temp.dm(v_conv, 'customer', null,
      case when i in (7, 8) then
             (array['El producto que compré llegó con falla y quiero hacer válida la garantía',
                    'Mi pedido no ha llegado y ya pasaron varios días, quiero reclamar'])[i - 6]
           else pg_temp.frase('abre', i) end, v_c1);
    v_r1 := v_c1 + pg_temp.mins(v_d1);
    if v_ai then
      perform pg_temp.dm(v_conv, 'ai', null, pg_temp.frase('resp', i), v_r1);
    else
      perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('resp', i), v_r1);
    end if;
    if v_d2 is not null then
      v_c2 := v_r1 + pg_temp.mins(v_g1);
      perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('sigue', i + 1), v_c2);
      perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('resp', i + 4), v_c2 + pg_temp.mins(v_d2));
    end if;

    if i = 10 then v_conv_pq := v_conv; end if;

    -- Dos con etiqueta de reclamo (las etiquetas ya existen en el seed).
    if i in (7, 8) then
      select id into v_tag from public.tags
       where label ilike case i when 7 then 'reclamo%garant%' else 'reclamo%env%' end
       order by label limit 1;
      if v_tag is not null then
        insert into public.contact_tags (contact_id, tag_id)
        select c.contact_id, v_tag from public.conversations c where c.id = v_conv;
      end if;
    end if;
  end loop;

  -- 2.4 Carritos sin compra (14): 5 cambiados hace ~2 días, 4 hace ~10, 5 sueltos.
  for i in 1..14 loop
    v_ci := v_ci + 1;
    v_sx := 1 + floor(random() * 3)::int;
    v_h := v_ag[v_sx];
    v_ai := random() < 0.30;
    v_cambio := v_ahora - v_edades[i] * interval '1 hour';
    v_d1 := pg_temp.demora(case when v_ai then 0 else v_sx end);
    v_d2 := pg_temp.demora(v_sx);
    v_r2 := v_cambio - interval '1 minute';
    v_c2 := v_r2 - pg_temp.mins(v_d2);
    v_r1 := v_c2 - pg_temp.mins((5 + random() * 10)::numeric);
    v_c1 := v_r1 - pg_temp.mins(v_d1);

    v_conv := pg_temp.dc(v_ci, v_c1 - interval '1 minute');
    perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('abre', i + 2), v_c1);
    if v_ai then
      perform pg_temp.dm(v_conv, 'ai', null, pg_temp.frase('resp', i), v_r1);
    else
      perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('resp', i), v_r1);
    end if;
    perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('sigue', i), v_c2);
    perform pg_temp.dm(v_conv, 'agent', v_h, pg_temp.frase('resp', i + 5), v_r2);
    perform pg_temp.renglones(true, v_conv, v_r1 + interval '1 minute', v_cambio, v_h, false, v_factor);

    -- Un presupuesto del chat sobre el MISMO chat del primer carrito activo: el
    -- panel debe contar solo el presupuesto.
    if i = 1 then
      insert into public.presupuestos
        (cliente_nombre, cliente_apellido, contact_id, conversation_id, origen, nota, created_by, created_at, updated_at)
      select 'Demo', 'Cliente ' || lpad(v_ci::text, 3, '0'), c.contact_id, c.id, 'chat', 'DEMO-PANELES', v_h,
             v_ahora - interval '20 hours', v_ahora - interval '20 hours'
        from public.conversations c where c.id = v_conv
      returning id into v_pres;
      perform pg_temp.renglones(false, v_pres, v_ahora - interval '20 hours', v_ahora - interval '20 hours', v_h, false, v_factor);
    end if;
  end loop;

  -- 2.5 Esperas sin respuesta. 5 siguen abiertas (40 min, 3 h, 7 h, 3 días, 20
  -- días; las dos de horas con asesor asignado) y 5 quedaron cerradas.
  v_ci := v_ci + 1;
  v_conv := pg_temp.dc(v_ci, v_ahora - interval '41 minutes');
  perform pg_temp.dm(v_conv, 'customer', null, 'Hola, ¿siguen ahí? Quiero saber el precio de las pastillas de freno', v_ahora - interval '40 minutes');

  v_ci := v_ci + 1;
  v_conv := pg_temp.dc(v_ci, v_ahora - interval '4 hours 1 minute', 'open', v_ag[2]);
  perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('abre', 11), v_ahora - interval '4 hours');
  perform pg_temp.dm(v_conv, 'agent', v_ag[2], pg_temp.frase('resp', 11), v_ahora - interval '3 hours 54 minutes');
  perform pg_temp.dm(v_conv, 'customer', null, 'Perfecto, ¿y para cuándo me lo tienen?', v_ahora - interval '3 hours');

  v_ci := v_ci + 1;
  v_conv := pg_temp.dc(v_ci, v_ahora - interval '9 hours 1 minute', 'open', v_ag[3]);
  perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('abre', 12), v_ahora - interval '9 hours');
  perform pg_temp.dm(v_conv, 'agent', v_ag[3], pg_temp.frase('resp', 12), v_ahora - interval '8 hours 55 minutes');
  perform pg_temp.dm(v_conv, 'customer', null, '¿Me confirmas si tienen en existencia?', v_ahora - interval '7 hours');

  v_ci := v_ci + 1;
  v_conv := pg_temp.dc(v_ci, v_ahora - interval '72 hours 1 minute');
  perform pg_temp.dm(v_conv, 'customer', null, 'Buenas, necesito un neumático 90/90-18, ¿lo tienen?', v_ahora - interval '72 hours');

  v_ci := v_ci + 1;
  v_conv := pg_temp.dc(v_ci, v_ahora - interval '20 days 1 minute');
  perform pg_temp.dm(v_conv, 'customer', null, 'Hola, ¿tienen bujías NGK?', v_ahora - interval '20 days');

  for i in 1..5 loop
    v_ci := v_ci + 1;
    v_ts := v_hoy0
            - v_dias[1 + floor(random() * array_length(v_dias, 1))::int] * interval '1 day'
            + v_horas[1 + floor(random() * array_length(v_horas, 1))::int] * interval '1 hour';
    v_conv := pg_temp.dc(v_ci, v_ts - interval '1 minute', 'closed');
    perform pg_temp.dm(v_conv, 'customer', null, pg_temp.frase('abre', i + 5), v_ts);
  end loop;

  -- 2.6 Presupuestos sin enviar (tienda): 8 de edades distintas para el panel de ventas activas.
  for i in 1..8 loop
    v_h := v_ag[1 + floor(random() * 3)::int];
    v_ts := v_ahora - (array[5, 20, 40, 96, 216, 360, 528, 672])[i] * interval '1 hour';
    insert into public.presupuestos
      (cliente_nombre, cliente_apellido, origen, nota, created_by, created_at, updated_at)
    values ('Demo', 'Presupuesto ' || lpad(i::text, 2, '0'), 'inventario', 'DEMO-PANELES', v_h, v_ts, v_ts)
    returning id into v_pres;
    perform pg_temp.renglones(false, v_pres, v_ts, v_ts, v_h, false, v_factor);
  end loop;

  -- Un segundo presupuesto del chat, sobre una conversación sin carrito (una de
  -- las que solo preguntaron).
  v_h := v_ag[2];
  insert into public.presupuestos
    (cliente_nombre, cliente_apellido, contact_id, conversation_id, origen, nota, created_by, created_at, updated_at)
  select 'Demo', 'Cliente ' || lpad(right(ct.phone_number, 3), 3, '0'), c.contact_id, c.id, 'chat', 'DEMO-PANELES', v_h,
         v_ahora - interval '3 days', v_ahora - interval '3 days'
    from public.conversations c join public.contacts ct on ct.id = c.contact_id where c.id = v_conv_pq
  returning id into v_pres;
  perform pg_temp.renglones(false, v_pres, v_ahora - interval '3 days', v_ahora - interval '3 days', v_h, false, v_factor);
end
$demo$;

-- ---------------------------------------------------------------------------
-- 3. Los envíos a SAINT: por la RPC, con sesión de authenticated.
-- ---------------------------------------------------------------------------
do $demo$
declare
  p record;
  v_bid uuid;
  v_dup uuid;
begin
  for p in select * from _plan order by ord loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', p.sender, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_bid := public.enviar_borrador_saint(
      case when p.canal = 'online' then 'carrito' else 'presupuesto' end,
      case when p.canal = 'online' then p.conv_id else p.pres_id end,
      p.cedula_tipo, p.cedula_numero, p.nombre, p.apellido, '');
    reset role;
    update _plan set borrador_id = v_bid where ord = p.ord;

    -- Un reenvío idéntico del mismo carrito (la vista ventas_saint_estado lo
    -- cuenta como duplicado al leer, porque el primero queda 'creado'; el primero
    -- tiene que estar 'creado' antes, por el índice de "un envío en curso por
    -- origen").
    if p.ord = 30 then
      update liminal.saint_borradores set estado = 'creado' where id = v_bid;
      perform set_config('request.jwt.claims',
        json_build_object('sub', p.sender, 'role', 'authenticated')::text, true);
      set local role authenticated;
      v_dup := public.enviar_borrador_saint('carrito', p.conv_id,
        p.cedula_tipo, p.cedula_numero, p.nombre, p.apellido, '');
      reset role;
      insert into _plan (
        ord, canal, generico, hoy, ts, sx, sender, first_ai, estado,
        cedula_tipo, cedula_numero, nombre, apellido, codclie, conv_id, borrador_id, es_dup)
      values (
        121, p.canal, p.generico, p.hoy, p.ts + interval '40 minutes', p.sx, p.sender, p.first_ai, 'creado',
        p.cedula_tipo, p.cedula_numero, p.nombre, p.apellido, p.codclie, p.conv_id, v_dup, true);
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end
$demo$;

-- ---------------------------------------------------------------------------
-- 4. Simular a LiminalReplicant y retrofechar.
-- ---------------------------------------------------------------------------

-- Cliente nuevo en SAINT: la primera vez que aparece una cédula, la mitad de las
-- veces SAINT lo creó (cliente_creado = true) y la otra mitad ya existía. El
-- genérico de mostrador ya existía siempre.
with r as (
  select ord, row_number() over (partition by cedula_tipo, cedula_numero order by ts) as rn
    from _plan
)
update _plan p
   set cliente_creado = (not p.generico and r.rn = 1 and p.ord % 2 = 0)
  from r
 where r.ord = p.ord;

update liminal.saint_borradores b set
  created_at = p.ts,
  estado = p.estado,
  intentos = case p.estado when 'error' then 3 when 'pendiente' then 0 else 1 end,
  numero_saint = case when p.estado = 'creado' then 'DEMO-' || lpad(p.ord::text, 6, '0') end,
  codclie = case when p.estado = 'creado' then p.codclie end,
  cliente_creado = case when p.estado = 'creado' then p.cliente_creado end,
  error = case when p.estado = 'error' then 'Demo: cliente bloqueado en SAINT (error simulado)' end,
  reclamado_at = case when p.estado = 'pendiente' then null else p.ts + interval '8 seconds' end,
  procesado_at = case when p.estado = 'pendiente' then null else p.ts + interval '25 seconds' end
 from _plan p
where b.id = p.borrador_id;

-- La foto (ventas_saint) copia la fecha del borrador: se retrofecha igual, y su
-- tasa sale de la del día del envío.
update public.ventas_saint v set
  created_at = p.ts,
  tasa_bcv = t.tasa,
  monto_bs = case when v.monto_usd is null or t.tasa is null then null else round(v.monto_usd * t.tasa, 2) end
 from _plan p
 left join lateral (
   select e.usd_to_ves as tasa
     from public.exchange_rates e
    where e.rate_date <= (p.ts at time zone 'America/Caracas')::date
    order by e.rate_date desc
    limit 1
 ) t on true
where v.borrador_id = p.borrador_id;

-- Las cuatro ventas más antiguas quedan como "estimadas" (como las del backfill
-- de antes del trigger), para que el panel muestre ese aviso.
update public.ventas_saint set estimado = true
 where borrador_id in (select borrador_id from _plan where not es_dup order by ts limit 4);

-- ---------------------------------------------------------------------------
-- 5. Limpieza de efectos laterales.
-- ---------------------------------------------------------------------------
-- La bandeja no debe llenarse de "no leídos" demo: solo quedan las que esperan.
update public.conversations c set unread_count = 0
 where c.contact_id in (select id from public.contacts where profile_name = 'DEMO-PANELES')
   and not coalesce(c.awaiting_reply, false);

-- agents.last_assigned_at vuelve a su valor (lo movió el trigger de asignación).
update public.agents a set last_assigned_at = ant.last_assigned_at
  from _agentes_antes ant
 where ant.id = a.id and a.last_assigned_at is distinct from ant.last_assigned_at;

drop function pg_temp.mins(numeric);
drop function pg_temp.demora(int);
drop function pg_temp.frase(text, int);
drop function pg_temp.dm(uuid, text, uuid, text, timestamptz);
drop function pg_temp.dc(int, timestamptz, text, uuid);
drop function pg_temp.renglones(boolean, uuid, timestamptz, timestamptz, uuid, boolean, int);

-- ---------------------------------------------------------------------------
-- 6. Resumen.
-- ---------------------------------------------------------------------------
select 'contactos demo' as concepto, count(*) as filas from public.contacts where profile_name = 'DEMO-PANELES'
union all select 'conversaciones demo', count(*) from public.conversations c join public.contacts ct on ct.id = c.contact_id where ct.profile_name = 'DEMO-PANELES'
union all select 'mensajes demo', count(*) from public.messages m join public.conversations c on c.id = m.conversation_id join public.contacts ct on ct.id = c.contact_id where ct.profile_name = 'DEMO-PANELES'
union all select 'renglones de carrito', count(*) from public.conversation_cart_items ci join public.conversations c on c.id = ci.conversation_id join public.contacts ct on ct.id = c.contact_id where ct.profile_name = 'DEMO-PANELES'
union all select 'presupuestos demo', count(*) from public.presupuestos where nota = 'DEMO-PANELES'
union all select 'productos demo', count(*) from public.products where description = 'DEMO-PANELES'
union all select 'envios a SAINT (borradores)', count(*) from liminal.saint_borradores b where b.nombre = 'Demo'
union all select '  creado', count(*) from liminal.saint_borradores b where b.nombre = 'Demo' and b.estado = 'creado'
union all select '  pendiente', count(*) from liminal.saint_borradores b where b.nombre = 'Demo' and b.estado = 'pendiente'
union all select '  error', count(*) from liminal.saint_borradores b where b.nombre = 'Demo' and b.estado = 'error'
union all select 'fotos (ventas_saint)', count(*) from public.ventas_saint v join liminal.saint_borradores b on b.id = v.borrador_id where b.nombre = 'Demo'
union all select '  duplicado (lo decide la vista al leer)', count(*) from public.ventas_saint_estado v join liminal.saint_borradores b on b.id = v.borrador_id where b.nombre = 'Demo' and v.duplicado
union all select '  sin monto', count(*) from public.ventas_saint v join liminal.saint_borradores b on b.id = v.borrador_id where b.nombre = 'Demo' and v.monto_usd is null
union all select 'tasas BCV demo agregadas', count(*) from public.exchange_rates where source = 'demo-paneles';

select v.estado, v.canal, count(*) as envios, round(sum(v.monto_usd), 2) as usd
  from public.ventas_saint_estado v join liminal.saint_borradores b on b.id = v.borrador_id
 where b.nombre = 'Demo' and not v.duplicado
 group by v.estado, v.canal
 order by v.estado, v.canal;

commit;
