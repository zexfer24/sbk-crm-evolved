-- ============================================================================
-- buscar_productos ordena y cuenta ANTES de recortar (T1, plan "La búsqueda
-- encuentra lo que el cliente pide", 25-26/9/2026)
--
-- Migración bajo prueba: 20260926010000_busqueda_ordena_antes_de_recortar.sql.
--
-- El bug de origen (medido en el VPS el 25/9/2026 contra 6.035 productos
-- reales, §2.1 del plan): `tools.ts` cortaba con `.limit(31)` SIN `order`, y
-- recién después ordenaba esas 31 en memoria -- si el repuesto correcto no
-- entraba entre los primeros 31 que traía Postgres sin ningún criterio,
-- nunca aparecía. Además buscaba por subcadena ("rin" traía ORINGS) y
-- filtraba por `product_compatibility`, que hoy tiene CERO filas.
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que
-- search_conversations_by_message.sql / catalog_links.sql). Todo corre como
-- `postgres` -- el trigger de solo lectura de `products` (20260925010000)
-- deja pasar sin más a ese rol, y `buscar_productos` es `security invoker`
-- (la llama `service_role` desde `agent.ts`, que igual bypassa RLS por su
-- cuenta -- no hace falta simular ninguna sesión para probar su lógica de
-- puntaje).
--
-- Neutralizar el seed: `supabase/seed.sql` YA trae 5 productos activos con
-- precio > 0, entre ellos "Pastillas de freno delanteras" (contiene
-- "pastillas" Y "freno") -- si se dejaran activos, el caso de las 5
-- pastillas de este archivo pasaría a ver 6 filas con el puntaje máximo, no
-- 5, y la aserción exacta del plan ("filas_con_puntaje_maximo = 5") daría
-- falso negativo por un producto que ni siquiera es de esta fixture. Se
-- desactivan al entrar (dentro de la transacción que hace `rollback`, así
-- que no se pierde nada real) en vez de evitar las palabras "freno"/
-- "pastilla" en toda la fixture -- lo segundo habría sido frágil: cualquier
-- producto nuevo que el seed agregue mañana con esas palabras volvería a
-- romper este test en silencio.
--
-- T1 del plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
-- esperando" (28/9/2026), migración bajo prueba adicional:
-- 20260928010000_busqueda_marca_obligatoria.sql. Los casos 14-26 fijan la
-- firma nueva (p_opcionales, p_cilindrada), la regla sin N-1 vista desde SQL
-- (el puntaje máximo de "defensa gxs 250" NO llega al número de grupos), el
-- límite de palabra al final de los términos que acaban en dígito (\M) y el
-- orden nuevo. Como siempre, el ruido va insertado ANTES que los productos
-- correctos: con el orden físico de inserción a favor, un `order by` roto
-- pasaría en verde.
--
-- La base local puede traer cientos de productos reales de un ensayo previo
-- (precios en Bs., "PASTILLA FRENO DELANTERO KAVAK 150"...) que contaminan
-- los conteos exactos de estos casos -- el CI arranca con solo los 5 del
-- seed, pero una máquina de desarrollo no. Por eso el test desactiva TODO
-- producto preexistente al entrar (dentro de la transacción con rollback),
-- no solo los `eeeeeeee-%` del seed.
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

update public.products set is_active = false;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------

-- Más de 31 filas que contienen "delantero" o "freno", insertadas ANTES
-- que las 6 correctas (y que el ruido de abajo): con pocas filas el planner
-- recorre la tabla en orden físico, así que un `limit` aplicado antes del
-- orden (el bug real de tools.ts, `.limit(31)` sin `order`, medido en el VPS
-- el 25/9/2026) se queda con estas 40 y nunca ve el producto correcto. Así
-- la mutación "límite antes del orden" pone rojos los casos 1 y 2 (verificada
-- el 26/9/2026: con las correctas insertadas primero, esa mutación pasaba en
-- verde). Ninguna nombra rin/bera/kavak/disco/dt200, así que ninguna puede
-- empatarle el puntaje máximo a los casos 1 y 2.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active)
select
  ('b3000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
  case when g % 2 = 0 then 'AMORTIGUADOR DELANTERO GENERICO ' || g else 'CABLE FRENO GENERICO ' || g end,
  null, 5.00, 'USD', 2, true
from generate_series(1, 40) g;

-- Ruido: calza ALGO de cada consulta (por diseño), pero nunca lo suficiente
-- para empatar el puntaje máximo del caso al que podría colarse.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('b2000000-0000-0000-0000-000000000001', 'ORINGS', null, 1.00, 'USD', 100, true),
  ('b2000000-0000-0000-0000-000000000002', 'MAGNETO DT200 MS', null, 15.00, 'USD', 5, true),
  ('b2000000-0000-0000-0000-000000000003', 'GOMA ASIENTO UNIVERSAL TRACTOR', null, 6.00, 'USD', 8, true),
  ('b2000000-0000-0000-0000-000000000004', 'BASE MALETA COLORES GP', null, 9.00, 'USD', 6, true),
  ('b2000000-0000-0000-0000-000000000005', 'PATIN CADENA TX LECHUZA DSR TIGRITO KAVA', null, 7.00, 'USD', 3, true),
  ('b2000000-0000-0000-0000-000000000006', 'TENSOR CADENA TIEMPO EN125 AUTOASIA', null, 11.00, 'USD', 4, true);

-- T5b (30/9/2026): RUIDO de las filas de OTRO producto que nombran la moto
-- (caso 38). Van acá, en el bloque de ruido, ANTES que las filas correctas del
-- caso: una consulta con `limit` aplicado antes del orden se quedaría con
-- ellas. BOMBA DE ACEITE BERA SBR puntúa "aceite" igual que un aceite de
-- verdad y nombra la SBR: con «aceite» para una SBR, la moto calzaba con ELLA
-- y Seba cotizaba una bomba en vez de un aceite.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('bd000000-0000-0000-0000-000000000001', 'BOMBA DE ACEITE BERA SBR', null, 30.00, 'USD', 5, true),
  ('bd000000-0000-0000-0000-000000000002', 'TENSOR DE CADENA BERA SBR', null, 9.00, 'USD', 4, true);

-- Los 6 nombres reales del §2.1 del plan -- cada uno es la respuesta
-- correcta de uno de los casos de abajo (salvo la cadena de tiempo, que
-- entra como dato realista de más sin un caso dedicado).
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('b1000000-0000-0000-0000-000000000001', 'RIN DELANTERO BERA KAVAK ALDRICH', null, 25.00, 'USD', 3, true),
  ('b1000000-0000-0000-0000-000000000002', 'DISCO FRENO DELANTERO DT200 VIEJO ALDRIC', null, 12.00, 'USD', 2, true),
  ('b1000000-0000-0000-0000-000000000003', 'ASIENTO BERA SBR BASE METAL AUTOASIA', null, 40.00, 'USD', 1, true),
  ('b1000000-0000-0000-0000-000000000004', 'PECHERA AVA DEER LRPRO', null, 55.00, 'USD', 1, true),
  ('b1000000-0000-0000-0000-000000000005', 'MALETA CUADRADA 45 LTS NEGRA FEDERAL', null, 60.00, 'USD', 0, true),
  ('b1000000-0000-0000-0000-000000000006', 'CADENA TIEMPO KLR 4*5-174L DID', 'DID', 30.00, 'USD', 2, true);

-- 13 intercomunicadores activos con precio > 0 -- el candidato del caso 6 --
-- más UNO con precio 0 (caso 8): mismo nombre, mismo calce, para probar que
-- el filtro `price > 0` lo saca aunque puntúe igual que los otros 13.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active)
select
  ('b4000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
  'INTERCOMUNICADOR BLUETOOTH MODELO ' || g,
  null, 20.00, 'USD', 3, true
from generate_series(1, 13) g;

insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('b5000000-0000-0000-0000-000000000001', 'INTERCOMUNICADOR GRATIS DE PROMOCION', null, 0, 'USD', 5, true);

-- 5 pastillas de freno para distintas motos, una de ellas BERA (caso 10).
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('b6000000-0000-0000-0000-000000000001', 'PASTILLA FRENO DELANTERO BERA SBR 200', null, 8.00, 'USD', 4, true),
  ('b6000000-0000-0000-0000-000000000002', 'PASTILLA FRENO DELANTERO YAMAHA YBR 125', null, 8.00, 'USD', 4, true),
  ('b6000000-0000-0000-0000-000000000003', 'PASTILLA FRENO DELANTERO SUZUKI GN125', null, 8.00, 'USD', 4, true),
  ('b6000000-0000-0000-0000-000000000004', 'PASTILLA FRENO DELANTERO HONDA CBF150', null, 8.00, 'USD', 4, true),
  ('b6000000-0000-0000-0000-000000000005', 'PASTILLA FRENO DELANTERO KAVAK MOTOR 150', null, 8.00, 'USD', 4, true);

-- Un aceite MOTUL 5100 sin ninguna moto Kavak (caso 11).
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('b7000000-0000-0000-0000-000000000001', 'ACEITE MOTUL 5100 20W50', 'MOTUL', 18.00, 'USD', 6, true);

-- ---------------------------------------------------------------------------
-- Caso 1 · [rin][delantero][bera][kavak] -> RIN DELANTERO BERA KAVAK ALDRICH
-- primero, con puntaje 4 (los 4 grupos calzan).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
begin
  select id, puntaje into v_id, v_puntaje
  from public.buscar_productos('[["rin"],["delantero"],["bera"],["kavak"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;

  if v_id is distinct from 'b1000000-0000-0000-0000-000000000001'::uuid then
    insert into _errores(msg) values (format('Caso 1: el primer resultado fue %s, se esperaba RIN DELANTERO BERA KAVAK ALDRICH.', v_id));
  end if;
  if v_puntaje is distinct from 4 then
    insert into _errores(msg) values (format('Caso 1: puntaje = %s, se esperaba 4 (los cuatro grupos calzan).', v_puntaje));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · [disco][freno][delantero][dt200,dt 200] -> DISCO FRENO DELANTERO
-- DT200 VIEJO ALDRIC primero -- prueba la alternativa "dt 200" (con espacio)
-- del mismo grupo contra el nombre que trae "DT200" pegado.
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
begin
  select id, puntaje into v_id, v_puntaje
  from public.buscar_productos('[["disco"],["freno"],["delantero"],["dt200", "dt 200"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;

  if v_id is distinct from 'b1000000-0000-0000-0000-000000000002'::uuid then
    insert into _errores(msg) values (format('Caso 2: el primer resultado fue %s, se esperaba DISCO FRENO DELANTERO DT200 VIEJO ALDRIC.', v_id));
  end if;
  if v_puntaje is distinct from 4 then
    insert into _errores(msg) values (format('Caso 2: puntaje = %s, se esperaba 4.', v_puntaje));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · [asiento][sbr] -> ASIENTO BERA SBR BASE METAL AUTOASIA primero.
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.buscar_productos('[["asiento"],["sbr"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;

  if v_id is distinct from 'b1000000-0000-0000-0000-000000000003'::uuid then
    insert into _errores(msg) values (format('Caso 3: el primer resultado fue %s, se esperaba ASIENTO BERA SBR BASE METAL AUTOASIA.', v_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · [pechera][ava][deer] -> PECHERA AVA DEER LRPRO primero.
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.buscar_productos('[["pechera"],["ava"],["deer"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;

  if v_id is distinct from 'b1000000-0000-0000-0000-000000000004'::uuid then
    insert into _errores(msg) values (format('Caso 4: el primer resultado fue %s, se esperaba PECHERA AVA DEER LRPRO.', v_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · [maleta][45][litro,lts] -> MALETA CUADRADA 45 LTS NEGRA FEDERAL
-- primero, con puntaje 3 (el nombre solo trae "LTS", nunca "litro" -- calza
-- por la otra alternativa del mismo grupo).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
begin
  select id, puntaje into v_id, v_puntaje
  from public.buscar_productos('[["maleta"],["45"],["litro", "lts"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;

  if v_id is distinct from 'b1000000-0000-0000-0000-000000000005'::uuid then
    insert into _errores(msg) values (format('Caso 5: el primer resultado fue %s, se esperaba MALETA CUADRADA 45 LTS NEGRA FEDERAL.', v_id));
  end if;
  if v_puntaje is distinct from 3 then
    insert into _errores(msg) values (format('Caso 5: puntaje = %s, se esperaba 3.', v_puntaje));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · [intercomunicador] -> filas_con_puntaje_maximo = 13 (el de precio
-- 0 queda afuera, ver caso 8).
-- ---------------------------------------------------------------------------
do $$
declare
  n_filas int;
  n_max bigint;
begin
  select count(*), max(filas_con_puntaje_maximo) into n_filas, n_max
  from public.buscar_productos('[["intercomunicador"]]'::jsonb, '[]'::jsonb, 50);

  if n_max is distinct from 13 then
    insert into _errores(msg) values (format('Caso 6: filas_con_puntaje_maximo = %s, se esperaba 13.', n_max));
  end if;
  if n_filas <> 13 then
    insert into _errores(msg) values (format('Caso 6: la consulta devolvió %s fila(s) (limit 50), se esperaban 13 -- el de precio 0 no debe estar.', n_filas));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7 · [rin] no trae ORINGS -- calza por subcadena en el prefiltro, pero
-- nunca por inicio de palabra.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n
  from public.buscar_productos('[["rin"]]'::jsonb, '[]'::jsonb, 50) r
  where r.id = 'b2000000-0000-0000-0000-000000000001'::uuid; -- ORINGS

  if n <> 0 then
    insert into _errores(msg) values (format('Caso 7: "rin" trajo %s fila(s) para ORINGS, se esperaban 0.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 8 · el producto con price = 0 no aparece nunca, aunque calce
-- perfecto ("intercomunicador").
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n
  from public.buscar_productos('[["intercomunicador"]]'::jsonb, '[]'::jsonb, 50) r
  where r.id = 'b5000000-0000-0000-0000-000000000001'::uuid;

  if n <> 0 then
    insert into _errores(msg) values (format('Caso 8: el producto con price = 0 apareció %s vez(es), se esperaban 0.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 9 · metacaracteres: ni lanzan error (si algo de acá revienta, todo el
-- script aborta con ON_ERROR_STOP=1, que es la señal misma del fallo) ni
-- calzan de más. "." y "%" sueltos no son comodines universales; "*" y "-"
-- sueltos no calzan contra "4*5-174L" (CADENA TIEMPO); "rin." no calza
-- salvo que el nombre traiga el punto literal (ninguno lo trae).
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  errores text := '';
begin
  select count(*) into n from public.buscar_productos('[["."]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "." trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["%"]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "%%" trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["_"]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "_" trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["*"]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "*" trajo %s fila(s) (no debía calzar contra "4*5-174L"), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["-"]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "-" trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["("]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "(" trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["["]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "[" trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["o''brien"]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "o''brien" trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos(jsonb_build_array(jsonb_build_array(E'\\')), '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "\\" (backslash suelto) trajo %s fila(s), se esperaban 0.', n); end if;

  select count(*) into n from public.buscar_productos('[["rin."]]'::jsonb, '[]'::jsonb, 50);
  if n <> 0 then errores := errores || format(E'\n  - "rin." trajo %s fila(s) sin tener el punto literal en ningún nombre, se esperaban 0.', n); end if;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 9 (metacaracteres):%s', errores));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 10 · [pastilla][freno] + moto [[bera]] -> la BERA sale primera;
-- filas_con_puntaje_maximo sigue en 5 (la moto nunca filtra, solo ordena);
-- puntaje_moto_maximo = 1 (bera calza); filas_con_maximo_y_moto = 1 (solo
-- la BERA calza la moto entre las 5 del máximo).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_filas_max bigint;
  v_moto_max int;
  v_filas_moto bigint;
begin
  select id, filas_con_puntaje_maximo, puntaje_moto_maximo, filas_con_maximo_y_moto
    into v_id, v_filas_max, v_moto_max, v_filas_moto
  from public.buscar_productos('[["pastilla"],["freno"]]'::jsonb, '[["bera"]]'::jsonb, 10)
  limit 1;

  if v_id is distinct from 'b6000000-0000-0000-0000-000000000001'::uuid then
    insert into _errores(msg) values (format('Caso 10: el primer resultado fue %s, se esperaba la pastilla BERA.', v_id));
  end if;
  if v_filas_max is distinct from 5 then
    insert into _errores(msg) values (format('Caso 10: filas_con_puntaje_maximo = %s, se esperaba 5.', v_filas_max));
  end if;
  if v_moto_max is distinct from 1 then
    insert into _errores(msg) values (format('Caso 10: puntaje_moto_maximo = %s, se esperaba 1.', v_moto_max));
  end if;
  if v_filas_moto is distinct from 1 then
    insert into _errores(msg) values (format('Caso 10: filas_con_maximo_y_moto = %s, se esperaba 1.', v_filas_moto));
  end if;

  -- Sin moto, el conteo de filas en el máximo tiene que ser EL MISMO (la
  -- moto nunca resta candidatos) -- ver la nota "moto que nadie nombra" del
  -- plan.
  select filas_con_puntaje_maximo into v_filas_max
  from public.buscar_productos('[["pastilla"],["freno"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;
  if v_filas_max is distinct from 5 then
    insert into _errores(msg) values (format('Caso 10 (sin moto): filas_con_puntaje_maximo = %s, se esperaba 5 -- igual que con moto.', v_filas_max));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 11 · [aceite][motul][5100][20w50] + moto [[kavak]], sin ningún aceite Kavak
-- -> puntaje_moto_maximo = 0 (la moto es un bono que acá nunca se gana, y
-- no le quita el resultado a nadie). 28/9/2026: se suma el grupo [20w50]
-- porque la fixture nueva trae también un MOTUL 5100 15W50 que empataba con
-- el 20W50 en [aceite][motul][5100] y ganaba por nombre.
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_moto_max int;
begin
  select id, puntaje_moto_maximo into v_id, v_moto_max
  from public.buscar_productos('[["aceite"],["motul"],["5100"],["20w50"]]'::jsonb, '[["kavak"]]'::jsonb, 10)
  limit 1;

  if v_id is distinct from 'b7000000-0000-0000-0000-000000000001'::uuid then
    insert into _errores(msg) values (format('Caso 11: el primer resultado fue %s, se esperaba el ACEITE MOTUL 5100.', v_id));
  end if;
  if v_moto_max is distinct from 0 then
    insert into _errores(msg) values (format('Caso 11: puntaje_moto_maximo = %s, se esperaba 0 (ningún aceite es Kavak).', v_moto_max));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 12 · p_limite = 1 sobre la consulta del caso 1 no cambia los
-- conteos -- se calculan ANTES del límite, no sobre las filas que quedan
-- después de recortar.
-- ---------------------------------------------------------------------------
do $$
declare
  v_max_10 int;
  v_filas_10 bigint;
  v_max_1 int;
  v_filas_1 bigint;
  v_n_1 int;
begin
  select puntaje_maximo, filas_con_puntaje_maximo into v_max_10, v_filas_10
  from public.buscar_productos('[["rin"],["delantero"],["bera"],["kavak"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;

  select count(*), max(puntaje_maximo), max(filas_con_puntaje_maximo) into v_n_1, v_max_1, v_filas_1
  from public.buscar_productos('[["rin"],["delantero"],["bera"],["kavak"]]'::jsonb, '[]'::jsonb, 1);

  if v_n_1 <> 1 then
    insert into _errores(msg) values (format('Caso 12: p_limite = 1 devolvió %s fila(s), se esperaba exactamente 1.', v_n_1));
  end if;
  if v_max_1 is distinct from v_max_10 then
    insert into _errores(msg) values (format('Caso 12: puntaje_maximo cambió con p_limite = 1 (%s) contra p_limite = 10 (%s).', v_max_1, v_max_10));
  end if;
  if v_filas_1 is distinct from v_filas_10 then
    insert into _errores(msg) values (format('Caso 12: filas_con_puntaje_maximo cambió con p_limite = 1 (%s) contra p_limite = 10 (%s) -- los conteos tienen que calcularse ANTES del límite.', v_filas_1, v_filas_10));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 13 · permisos: anon y authenticated NO pueden ejecutar la función
-- (la llama service_role desde el servidor); service_role sí. 28/9/2026: la
-- firma era de CINCO parámetros y la de tres se retiró con `drop function`.
-- 30/9/2026 (A2, T2): la firma pasa a NUEVE parámetros (p_variantes,
-- p_moto_marca, p_motos_conocidas, p_marcas_de_moto) y las de cinco y ocho YA NO EXISTEN -- cambio de
-- semántica a propósito: si sobreviviera, PostgREST vería dos sobrecargas y
-- una llamada con nombres de parámetros sería ambigua. `patron_busqueda`
-- (helper immutable, única fuente de los patrones) lleva los mismos dos
-- revokes y el grant a service_role: la llama buscar_productos, que es
-- security invoker y corre con el rol de quien la invoca.
-- ---------------------------------------------------------------------------
do $$
declare
  errores text := '';
  v_sig text := 'public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)';
  v_pat text := 'public.patron_busqueda(text, text)';
begin
  if to_regprocedure('public.buscar_productos(jsonb, jsonb, int)') is not null then
    errores := errores || E'\n  - la firma vieja buscar_productos(jsonb, jsonb, int) sigue existiendo: la migración tenía que retirarla.';
  end if;
  if to_regprocedure('public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb)') is not null then
    errores := errores || E'\n  - la firma de cinco parámetros buscar_productos(jsonb, jsonb, int, jsonb, jsonb) sigue existiendo: la migración 20260930010000 tenía que retirarla.';
  end if;
  if to_regprocedure('public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb, jsonb, jsonb, jsonb)') is not null then
    errores := errores || E'\n  - la firma de ocho parámetros de buscar_productos() sigue existiendo: la migración 20260930010000 (p_marcas_de_moto) tenía que retirarla.';
  end if;
  if to_regprocedure(v_sig) is null then
    errores := errores || E'\n  - no existe la firma nueva de nueve parámetros de buscar_productos().';
  else
    if has_function_privilege('anon', v_sig, 'execute') then
      errores := errores || E'\n  - anon puede ejecutar buscar_productos() y no debería.';
    end if;
    if has_function_privilege('authenticated', v_sig, 'execute') then
      errores := errores || E'\n  - authenticated puede ejecutar buscar_productos() y no debería -- ningún camino con sesión de asesor llama al catálogo, solo service_role.';
    end if;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      errores := errores || E'\n  - service_role NO puede ejecutar buscar_productos() y sí debería -- es quien la llama desde agent.ts.';
    end if;
  end if;

  if to_regprocedure(v_pat) is null then
    errores := errores || E'\n  - no existe patron_busqueda(text, text).';
  else
    if has_function_privilege('anon', v_pat, 'execute') then
      errores := errores || E'\n  - anon puede ejecutar patron_busqueda() y no debería.';
    end if;
    if has_function_privilege('authenticated', v_pat, 'execute') then
      errores := errores || E'\n  - authenticated puede ejecutar patron_busqueda() y no debería.';
    end if;
    if not has_function_privilege('service_role', v_pat, 'execute') then
      errores := errores || E'\n  - service_role NO puede ejecutar patron_busqueda() y la necesita (la llama buscar_productos con su rol).';
    end if;
  end if;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 13 (permisos):%s', errores));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Fixture de T1 (28/9/2026), con nombres reales del catálogo. RUIDO PRIMERO:
-- cada fila de acá calza algo de alguna consulta de los casos 14-26, pero
-- nunca lo suficiente para ganarle al producto correcto.
-- ---------------------------------------------------------------------------
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('b8000000-0000-0000-0000-000000000001', 'ACEITE CASTROL 20W50 SEMI SINTETICO', null, 12.00, 'USD', 5, true),
  ('b8000000-0000-0000-0000-000000000002', 'ACEITE IPONE 20W50 SEMI SINTETICO', null, 11.00, 'USD', 5, true),
  ('b8000000-0000-0000-0000-000000000003', 'ACEITE MOTUL 5000 4T 10W40', 'MOTUL', 14.00, 'USD', 4, true),
  ('b8000000-0000-0000-0000-000000000004', 'MAGNETO DT2000 X', null, 15.00, 'USD', 2, true),
  ('b8000000-0000-0000-0000-000000000005', 'DEFENSA BRZ 250', null, 45.00, 'USD', 2, true),
  ('b8000000-0000-0000-0000-000000000006', 'DEFENSA PROTECTOR MOTOR UNIVERSAL', null, 35.00, 'USD', 2, true),
  ('b8000000-0000-0000-0000-000000000007', 'VISERA EDGE BONNIE', null, 10.00, 'USD', 3, true),
  ('b8000000-0000-0000-0000-000000000008', 'CASCO ELECTRON SIRIUS AZUL TALLA M', null, 80.00, 'USD', 3, true),
  ('b8000000-0000-0000-0000-000000000009', 'CASCO SIRIUS INTEGRAL', null, 75.00, 'USD', 3, true),
  ('b8000000-0000-0000-0000-000000000010', 'ACEITE OILSTONE 2T', null, 6.00, 'USD', 9, true),
  ('b8000000-0000-0000-0000-000000000011', 'EJE RIN TRASERO BERA', null, 9.00, 'USD', 3, true),
  ('b8000000-0000-0000-0000-000000000012', 'RIN DELANTERO BERA', null, 24.00, 'USD', 3, true),
  ('b8000000-0000-0000-0000-000000000013', 'MALETA TOP CASE 450 GIVI', null, 90.00, 'USD', 3, true),
  ('b8000000-0000-0000-0000-000000000014', 'PALANCA DE LEVA EMBRAGUE 200', null, 4.00, 'USD', 3, true),
  ('b8000000-0000-0000-0000-000000000015', 'TORNILLO 211.7', null, 1.00, 'USD', 50, true);

-- 7 botas, TODAS sin stock; 6 botines (3 con stock, 2 sin, 1 BERA sin stock).
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active)
select
  ('ba000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
  'BOTAS IMPERMEABLES MODELO ' || g, null, 60.00, 'USD', 0, true
from generate_series(1, 7) g;

insert into public.products (id, name, brand, price, currency, stock_quantity, is_active)
select
  ('bb000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
  'BOTIN CUERO MODELO ' || g, null, 50.00, 'USD', case when g <= 3 then 2 else 0 end, true
from generate_series(1, 5) g;

insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('bb000000-0000-0000-0000-000000000099', 'BOTIN CUERO BERA', null, 50.00, 'USD', 0, true);

-- Los correctos, DESPUÉS del ruido.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('b9000000-0000-0000-0000-000000000001', 'ACEITE INCA 20W50 4T', null, 8.00, 'USD', 6, true),
  ('b9000000-0000-0000-0000-000000000002', 'ACEITE MOTUL 5100 4T 15W50 SEMI SINTETICO', 'MOTUL', 20.00, 'USD', 6, true),
  ('b9000000-0000-0000-0000-000000000003', 'CASCO BONNIE CERRADO NEGRO', null, 70.00, 'USD', 3, true),
  ('b9000000-0000-0000-0000-000000000004', 'CASCO ELECTRON SIRIUS GRIS TALLA L', null, 80.00, 'USD', 3, true),
  ('b9000000-0000-0000-0000-000000000005', 'ACEITE OILSTONE 4T', null, 7.00, 'USD', 9, true),
  ('b9000000-0000-0000-0000-000000000006', 'RIN TRASERO BERA', null, 26.00, 'USD', 3, true),
  ('b9000000-0000-0000-0000-000000000007', 'ARBOL DE LEVA CG150 RACING BENF', null, 38.00, 'USD', 2, true),
  ('b9000000-0000-0000-0000-000000000008', 'BASE GIVI H11.7 MONOKEY', 'GIVI', 55.00, 'USD', 2, true);

-- Ayudante: posición (1 = primero) de un id en el resultado, o null si no aparece.
create function pg_temp._pos(p_terminos jsonb, p_moto jsonb, p_opc jsonb, p_cil jsonb, p_id uuid)
returns int language sql as $f$
  select t.rn::int from (
    select r.id, row_number() over () as rn
    from public.buscar_productos(p_terminos, p_moto, 50, p_opc, p_cil) r
  ) t where t.id = p_id
$f$;

-- ---------------------------------------------------------------------------
-- Caso 14 · "aceite 20w50 semi sintetico inca" (semi y sintetico opcionales):
-- primero ACEITE INCA 20W50 4T con puntaje 3; Castrol e Ipone calzan
-- "20W50 SEMI SINTETICO" pero NO la marca, así que quedan en puntaje 2 (el
-- puntaje máximo es lo que decide, no los opcionales).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
  v_max int;
  v_filas bigint;
  v_castrol int;
  v_castrol_opc int;
begin
  select id, puntaje, puntaje_maximo, filas_con_puntaje_maximo into v_id, v_puntaje, v_max, v_filas
  from public.buscar_productos('[["aceite"],["20w50"],["inca"]]'::jsonb, '[]'::jsonb, 10,
                               '[["semi"],["sintetico"]]'::jsonb, '[]'::jsonb)
  limit 1;

  if v_id is distinct from 'b9000000-0000-0000-0000-000000000001'::uuid then
    insert into _errores(msg) values (format('Caso 14: el primer resultado fue %s, se esperaba ACEITE INCA 20W50 4T.', v_id));
  end if;
  if v_puntaje is distinct from 3 or v_max is distinct from 3 or v_filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 14: puntaje=%s, puntaje_maximo=%s, filas_con_puntaje_maximo=%s; se esperaba 3/3/1.', v_puntaje, v_max, v_filas));
  end if;

  select puntaje, puntaje_opcional into v_castrol, v_castrol_opc
  from public.buscar_productos('[["aceite"],["20w50"],["inca"]]'::jsonb, '[]'::jsonb, 50,
                               '[["semi"],["sintetico"]]'::jsonb, '[]'::jsonb)
  where id = 'b8000000-0000-0000-0000-000000000001'::uuid;
  if v_castrol is distinct from 2 or v_castrol_opc is distinct from 2 then
    insert into _errores(msg) values (format('Caso 14: CASTROL trae puntaje=%s y puntaje_opcional=%s; se esperaba 2 y 2 (calza aceite + 20w50 y los dos opcionales, pero no la marca).', v_castrol, v_castrol_opc));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 15 · "aceite motul 5100 15w50 semi sintetico" -> MOTUL 5100 15W50
-- (puntaje 4) antes que el MOTUL 5100 20W50 (puntaje 3).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
  v_otro int;
begin
  select id, puntaje into v_id, v_puntaje
  from public.buscar_productos('[["aceite"],["motul"],["5100"],["15w50"]]'::jsonb, '[]'::jsonb, 10,
                               '[["semi"],["sintetico"]]'::jsonb, '[]'::jsonb)
  limit 1;

  if v_id is distinct from 'b9000000-0000-0000-0000-000000000002'::uuid or v_puntaje is distinct from 4 then
    insert into _errores(msg) values (format('Caso 15: el primero fue %s con puntaje %s, se esperaba MOTUL 5100 15W50 con 4.', v_id, v_puntaje));
  end if;

  select puntaje into v_otro
  from public.buscar_productos('[["aceite"],["motul"],["5100"],["15w50"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'b7000000-0000-0000-0000-000000000001'::uuid;
  if v_otro is distinct from 3 then
    insert into _errores(msg) values (format('Caso 15: el MOTUL 5100 20W50 trae puntaje %s, se esperaba 3.', v_otro));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 16 · "aceite iphone 20/50". (a) con la viscosidad como UN grupo
-- [20w50], ningún producto llega a 3 (falta "iphone") y el MOTUL 5000 no
-- calza el grupo [20w50]. (b) El límite de palabra final (\M) de los
-- términos que terminan en dígito: "50" ya NO calza "5000" (con la regex
-- vieja \m50 sí, y por eso "20/50" traía el MOTUL 5000) ni "dt200" calza
-- "DT2000".
-- ---------------------------------------------------------------------------
do $$
declare
  v_max int;
  v_motul5000 int;
  v_dt2000 int;
begin
  select max(puntaje) into v_max
  from public.buscar_productos('[["aceite"],["iphone"],["20w50"]]'::jsonb, '[]'::jsonb, 50);
  if v_max is distinct from 2 then
    insert into _errores(msg) values (format('Caso 16a: puntaje máximo de "aceite iphone 20w50" = %s, se esperaba 2 (nadie tiene "iphone").', v_max));
  end if;

  select puntaje into v_motul5000
  from public.buscar_productos('[["aceite"],["iphone"],["20w50"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'b8000000-0000-0000-0000-000000000003'::uuid;
  if v_motul5000 is distinct from 1 then
    insert into _errores(msg) values (format('Caso 16a: MOTUL 5000 trae puntaje %s, se esperaba 1 (solo "aceite").', v_motul5000));
  end if;

  select puntaje into v_motul5000
  from public.buscar_productos('[["aceite"],["50"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'b8000000-0000-0000-0000-000000000003'::uuid;
  if v_motul5000 is distinct from 1 then
    insert into _errores(msg) values (format('Caso 16b: "50" calzó dentro de "5000" (MOTUL 5000 puntaje %s, se esperaba 1): falta el límite de palabra final (\M) en los términos que terminan en dígito.', v_motul5000));
  end if;

  select count(*) into v_dt2000
  from public.buscar_productos('[["dt200"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'b8000000-0000-0000-0000-000000000004'::uuid;
  if v_dt2000 <> 0 then
    insert into _errores(msg) values ('Caso 16b: "dt200" calzó dentro de "DT2000": falta el límite de palabra final (\M).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 17 · "defensa gxs 250" / "defensa ava mustang 250". Con la marca y el
-- modelo como obligatorios (sin N-1, que vive en tools.ts y T3a retira), la
-- DEFENSA BRZ 250 solo calza "defensa" y "250": puntaje 2, nunca el total de
-- grupos. Y con la moto normalizada (query "defensa", moto gxs / ava mustang,
-- cilindrada 250) la cilindrada SOLA no vuelve verdadera la coincidencia de
-- moto (corrección del operador): puntaje_moto_maximo = 0 y
-- filas_con_maximo_y_moto no restringe (= filas_con_puntaje_maximo).
-- ---------------------------------------------------------------------------
do $$
declare
  v_max int;
  v_moto_max int;
  v_filas bigint;
  v_filas_moto bigint;
  v_nombre int;
  v_cil int;
  v_moto int;
begin
  select max(puntaje) into v_max
  from public.buscar_productos('[["defensa"],["gxs"],["250"]]'::jsonb, '[]'::jsonb, 50);
  if v_max is distinct from 2 then
    insert into _errores(msg) values (format('Caso 17a: "defensa gxs 250" con los tres obligatorios llegó a puntaje %s, se esperaba 2 (< 3 grupos).', v_max));
  end if;

  select max(puntaje) into v_max
  from public.buscar_productos('[["defensa"],["ava"],["mustang"],["250"]]'::jsonb, '[]'::jsonb, 50);
  if v_max is distinct from 2 then
    insert into _errores(msg) values (format('Caso 17b: "defensa ava mustang 250" llegó a puntaje %s, se esperaba 2 (< 4 grupos).', v_max));
  end if;

  -- Moto normalizada: gxs.
  select puntaje_moto_maximo, filas_con_puntaje_maximo, filas_con_maximo_y_moto
    into v_moto_max, v_filas, v_filas_moto
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["gxs"]]'::jsonb, 10, '[]'::jsonb, '[["250"]]'::jsonb)
  limit 1;
  if v_moto_max is distinct from 0 then
    insert into _errores(msg) values (format('Caso 17c: puntaje_moto_maximo = %s con moto gxs + cilindrada 250, se esperaba 0 (la cilindrada sola no calza la moto).', v_moto_max));
  end if;
  if v_filas is distinct from 2 or v_filas_moto is distinct from v_filas then
    insert into _errores(msg) values (format('Caso 17c: filas_con_puntaje_maximo=%s y filas_con_maximo_y_moto=%s, se esperaba 2 y 2 (la cilindrada no restringe).', v_filas, v_filas_moto));
  end if;

  select puntaje_moto_nombre, puntaje_moto_cilindrada, puntaje_moto into v_nombre, v_cil, v_moto
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["gxs"]]'::jsonb, 10, '[]'::jsonb, '[["250"]]'::jsonb)
  where id = 'b8000000-0000-0000-0000-000000000005'::uuid;
  if v_nombre is distinct from 0 or v_cil is distinct from 1 or v_moto is distinct from 1 then
    insert into _errores(msg) values (format('Caso 17c: BRZ 250 trae puntaje_moto_nombre=%s, puntaje_moto_cilindrada=%s, puntaje_moto=%s; se esperaba 0, 1 y 1 (suma).', v_nombre, v_cil, v_moto));
  end if;

  -- Moto normalizada: ava mustang (dos grupos).
  select puntaje_moto_maximo, filas_con_maximo_y_moto into v_moto_max, v_filas_moto
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["ava"],["mustang"]]'::jsonb, 10, '[]'::jsonb, '[["250"]]'::jsonb)
  limit 1;
  if v_moto_max is distinct from 0 or v_filas_moto is distinct from 2 then
    insert into _errores(msg) values (format('Caso 17d: con moto ava mustang + cilindrada 250, puntaje_moto_maximo=%s y filas_con_maximo_y_moto=%s; se esperaba 0 y 2.', v_moto_max, v_filas_moto));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 18 · "maleta de 45" -> [maleta][45]: la MALETA CUADRADA 45 LTS primero
-- con puntaje 2; la de 450 queda en 1 (\M).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
  v_450 int;
begin
  select id, puntaje into v_id, v_puntaje
  from public.buscar_productos('[["maleta"],["45"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;
  if v_id is distinct from 'b1000000-0000-0000-0000-000000000005'::uuid or v_puntaje is distinct from 2 then
    insert into _errores(msg) values (format('Caso 18: el primero fue %s con puntaje %s, se esperaba MALETA CUADRADA 45 LTS con 2.', v_id, v_puntaje));
  end if;

  select puntaje into v_450
  from public.buscar_productos('[["maleta"],["45"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'b8000000-0000-0000-0000-000000000013'::uuid;
  if v_450 is distinct from 1 then
    insert into _errores(msg) values (format('Caso 18: MALETA TOP CASE 450 trae puntaje %s, se esperaba 1 ("45" no calza "450").', v_450));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 19 · "casco bonnie" + opcional [edge]: CASCO BONNIE antes que VISERA
-- EDGE BONNIE (la visera no tiene "casco": puntaje 1 contra 2, y el opcional
-- "edge" no alcanza para pasar por encima de un grupo obligatorio).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_visera_puntaje int;
  v_visera_opc int;
begin
  select id into v_id
  from public.buscar_productos('[["casco"],["bonnie"]]'::jsonb, '[]'::jsonb, 10, '[["edge"]]'::jsonb, '[]'::jsonb)
  limit 1;
  if v_id is distinct from 'b9000000-0000-0000-0000-000000000003'::uuid then
    insert into _errores(msg) values (format('Caso 19: el primero fue %s, se esperaba CASCO BONNIE.', v_id));
  end if;

  select puntaje, puntaje_opcional into v_visera_puntaje, v_visera_opc
  from public.buscar_productos('[["casco"],["bonnie"]]'::jsonb, '[]'::jsonb, 50, '[["edge"]]'::jsonb, '[]'::jsonb)
  where id = 'b8000000-0000-0000-0000-000000000007'::uuid;
  if v_visera_puntaje is distinct from 1 or v_visera_opc is distinct from 1 then
    insert into _errores(msg) values (format('Caso 19: VISERA EDGE BONNIE trae puntaje=%s y puntaje_opcional=%s; se esperaba 1 y 1.', v_visera_puntaje, v_visera_opc));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 20 · "casco sirius electron" + opcionales [integral][gris][mate]: el
-- CASCO ELECTRON SIRIUS GRIS TALLA L primero. Su rival (AZUL, igual puntaje
-- 3) va ANTES por nombre: gana solo por el opcional "gris".
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
  v_opc int;
begin
  select id, puntaje, puntaje_opcional into v_id, v_puntaje, v_opc
  from public.buscar_productos('[["casco"],["sirius"],["electron"]]'::jsonb, '[]'::jsonb, 10,
                               '[["integral"],["gris"],["mate"]]'::jsonb, '[]'::jsonb)
  limit 1;
  if v_id is distinct from 'b9000000-0000-0000-0000-000000000004'::uuid or v_puntaje is distinct from 3 or v_opc is distinct from 1 then
    insert into _errores(msg) values (format('Caso 20: primero=%s puntaje=%s puntaje_opcional=%s; se esperaba CASCO ELECTRON SIRIUS GRIS TALLA L con 3 y 1.', v_id, v_puntaje, v_opc));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 21 · "oilstone" + opcional [4t] -> ACEITE OILSTONE 4T antes que el 2T
-- (el 2T iría antes por nombre: gana por el opcional).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.buscar_productos('[["oilstone"]]'::jsonb, '[]'::jsonb, 10, '[["4t"]]'::jsonb, '[]'::jsonb)
  limit 1;
  if v_id is distinct from 'b9000000-0000-0000-0000-000000000005'::uuid then
    insert into _errores(msg) values (format('Caso 21: el primero fue %s, se esperaba ACEITE OILSTONE 4T.', v_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 22 · un descriptivo ("original") como opcional no cambia el conjunto
-- de resultados ni sus conteos.
-- ---------------------------------------------------------------------------
do $$
declare
  v_sin text;
  v_con text;
  v_filas_sin bigint;
  v_filas_con bigint;
begin
  select string_agg(id::text, ',' order by id), max(filas_con_puntaje_maximo)
    into v_sin, v_filas_sin
  from public.buscar_productos('[["aceite"],["motul"]]'::jsonb, '[]'::jsonb, 50);

  select string_agg(id::text, ',' order by id), max(filas_con_puntaje_maximo)
    into v_con, v_filas_con
  from public.buscar_productos('[["aceite"],["motul"]]'::jsonb, '[]'::jsonb, 50, '[["original"]]'::jsonb, '[]'::jsonb);

  if v_sin is distinct from v_con or v_filas_sin is distinct from v_filas_con then
    insert into _errores(msg) values ('Caso 22: agregar el opcional "original" cambió el conjunto de resultados o sus conteos.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 23 · "leva racing 200cc": el ARBOL DE LEVA CG150 RACING (puntaje 2)
-- aparece primero aunque no diga "200" -- la cilindrada solo ordena.
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_puntaje int;
  v_moto_max int;
  v_cil int;
begin
  select id, puntaje, puntaje_moto_maximo, puntaje_moto_cilindrada into v_id, v_puntaje, v_moto_max, v_cil
  from public.buscar_productos('[["leva"],["racing"]]'::jsonb, '[]'::jsonb, 10, '[]'::jsonb, '[["200"]]'::jsonb)
  limit 1;
  if v_id is distinct from 'b9000000-0000-0000-0000-000000000007'::uuid or v_puntaje is distinct from 2 then
    insert into _errores(msg) values (format('Caso 23: el primero fue %s con puntaje %s, se esperaba ARBOL DE LEVA CG150 RACING con 2.', v_id, v_puntaje));
  end if;
  if v_moto_max is distinct from 0 or v_cil is distinct from 0 then
    insert into _errores(msg) values (format('Caso 23: puntaje_moto_maximo=%s, puntaje_moto_cilindrada=%s; se esperaba 0 y 0.', v_moto_max, v_cil));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 24 · "rin trasero" (trasero opcional) + moto bera: RIN TRASERO BERA
-- primero, y EJE RIN TRASERO BERA DESPUÉS de RIN DELANTERO BERA -- solo
-- `empieza_con_producto` los separa (el EJE va antes por nombre y empata en
-- puntaje, moto y opcional con el RIN TRASERO).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_empieza boolean;
  v_eje_empieza boolean;
  v_pos_rin_trasero int;
  v_pos_rin_delantero int;
  v_pos_eje int;
begin
  select id, empieza_con_producto into v_id, v_empieza
  from public.buscar_productos('[["rin"]]'::jsonb, '[["bera"]]'::jsonb, 10, '[["trasero"]]'::jsonb, '[]'::jsonb)
  limit 1;
  if v_id is distinct from 'b9000000-0000-0000-0000-000000000006'::uuid or v_empieza is distinct from true then
    insert into _errores(msg) values (format('Caso 24: el primero fue %s (empieza_con_producto=%s), se esperaba RIN TRASERO BERA con true.', v_id, v_empieza));
  end if;

  select empieza_con_producto into v_eje_empieza
  from public.buscar_productos('[["rin"]]'::jsonb, '[["bera"]]'::jsonb, 50, '[["trasero"]]'::jsonb, '[]'::jsonb)
  where id = 'b8000000-0000-0000-0000-000000000011'::uuid;
  if v_eje_empieza is distinct from false then
    insert into _errores(msg) values (format('Caso 24: EJE RIN TRASERO BERA trae empieza_con_producto=%s, se esperaba false.', v_eje_empieza));
  end if;

  v_pos_rin_trasero := pg_temp._pos('[["rin"]]'::jsonb, '[["bera"]]'::jsonb, '[["trasero"]]'::jsonb, '[]'::jsonb, 'b9000000-0000-0000-0000-000000000006'::uuid);
  v_pos_rin_delantero := pg_temp._pos('[["rin"]]'::jsonb, '[["bera"]]'::jsonb, '[["trasero"]]'::jsonb, '[]'::jsonb, 'b8000000-0000-0000-0000-000000000012'::uuid);
  v_pos_eje := pg_temp._pos('[["rin"]]'::jsonb, '[["bera"]]'::jsonb, '[["trasero"]]'::jsonb, '[]'::jsonb, 'b8000000-0000-0000-0000-000000000011'::uuid);
  if v_pos_eje <= v_pos_rin_delantero or v_pos_rin_trasero >= v_pos_rin_delantero then
    insert into _errores(msg) values (format('Caso 24: orden RIN TRASERO=%s, RIN DELANTERO=%s, EJE=%s; se esperaba RIN TRASERO < RIN DELANTERO < EJE.', v_pos_rin_trasero, v_pos_rin_delantero, v_pos_eje));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 25 · "11.7": una alternativa que EMPIEZA en dígito y trae punto acepta
-- un prefijo de letras ("H11.7" calza), pero no un dígito delante ("211.7").
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_n integer;
begin
  select id into v_id
  from public.buscar_productos('[["11.7"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;
  if v_id is distinct from 'b9000000-0000-0000-0000-000000000008'::uuid then
    insert into _errores(msg) values (format('Caso 25: "11.7" trajo %s primero, se esperaba BASE GIVI H11.7 MONOKEY.', v_id));
  end if;

  select count(*) into v_n
  from public.buscar_productos('[["11.7"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'b8000000-0000-0000-0000-000000000015'::uuid;
  if v_n <> 0 then
    insert into _errores(msg) values ('Caso 25: "11.7" calzó dentro de "TORNILLO 211.7" (un dígito delante no es un prefijo de letras).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 26 · filas_con_maximo_y_stock, calculada ANTES del límite. 7 botas,
-- todas sin stock: siete en el máximo, cero con stock. 6 botines: 3 con
-- stock; con la moto bera (que calza solo el BOTIN CUERO BERA, sin stock) el
-- conteo de stock se restringe a esa fila: 0.
-- ---------------------------------------------------------------------------
do $$
declare
  v_filas bigint;
  v_stock bigint;
  v_stock_limite1 bigint;
  v_filas_moto bigint;
begin
  select filas_con_puntaje_maximo, filas_con_maximo_y_stock into v_filas, v_stock
  from public.buscar_productos('[["bota"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;
  if v_filas is distinct from 7 or v_stock is distinct from 0 then
    insert into _errores(msg) values (format('Caso 26: botas filas_con_puntaje_maximo=%s, filas_con_maximo_y_stock=%s; se esperaba 7 y 0.', v_filas, v_stock));
  end if;

  select filas_con_puntaje_maximo, filas_con_maximo_y_stock into v_filas, v_stock
  from public.buscar_productos('[["botin"]]'::jsonb, '[]'::jsonb, 10)
  limit 1;
  if v_filas is distinct from 6 or v_stock is distinct from 3 then
    insert into _errores(msg) values (format('Caso 26: botines filas_con_puntaje_maximo=%s, filas_con_maximo_y_stock=%s; se esperaba 6 y 3.', v_filas, v_stock));
  end if;

  select filas_con_maximo_y_stock into v_stock_limite1
  from public.buscar_productos('[["botin"]]'::jsonb, '[]'::jsonb, 1)
  limit 1;
  if v_stock_limite1 is distinct from 3 then
    insert into _errores(msg) values (format('Caso 26: con p_limite = 1 filas_con_maximo_y_stock = %s, se esperaba 3 (se calcula ANTES del límite).', v_stock_limite1));
  end if;

  select filas_con_maximo_y_moto, filas_con_maximo_y_stock into v_filas_moto, v_stock
  from public.buscar_productos('[["botin"]]'::jsonb, '[["bera"]]'::jsonb, 10)
  limit 1;
  if v_filas_moto is distinct from 1 or v_stock is distinct from 0 then
    insert into _errores(msg) values (format('Caso 26: botines con moto bera filas_con_maximo_y_moto=%s, filas_con_maximo_y_stock=%s; se esperaba 1 y 0.', v_filas_moto, v_stock));
  end if;
end $$;

-- ===========================================================================
-- A2, T2 (30/9/2026, plan "Seba no cotiza lo que no es"), migración bajo
-- prueba adicional: 20260930010000_busqueda_por_palabra_moto_y_variantes.sql.
--
-- Casos 27-38: la moto calza por PALABRA ("gr" no calza GRIS), los números
-- calzan con su sufijo de letras ("45" calza 45T y 45LTS, nunca 5000), una
-- palabra corta calza entera con plural ("cro" no calza CROMADO), las
-- variantes son un conjunto aparte con sus ventanas, "otra moto" y
-- "universal" salen de p_motos_conocidas, la marca de moto y el año solo
-- ORDENAN, y el desempate es por existencia y nunca por orden alfabético.
--
-- Fixture con el RUIDO PRIMERO en cada familia (GRIS antes que GR250, 4500
-- antes que 45T, CROMADO antes que CRO...): con el orden físico de inserción
-- a favor de la fila correcta, una mutación que rompa el patrón o el orden
-- pasaría en verde (ver CLAUDE.md, "Un test SQL de orden tiene que insertar
-- el ruido ANTES que la fila correcta"). Se inserta DESPUÉS de los casos
-- 1-26, así que no altera sus conteos exactos.
-- ===========================================================================

insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  -- Familia GR: los dos GRIS (ruido) antes que los GR250 / GR 250.
  ('bc000000-0000-0000-0000-000000000001', 'MALETA REDONDA 34 LTS TOMCAT GRIS', null, 40.00, 'USD', 3, true),
  ('bc000000-0000-0000-0000-000000000002', 'ESPEJO GRIS CROMADO', null, 9.00, 'USD', 4, true),
  ('bc000000-0000-0000-0000-000000000003', 'PASTILLA FRENO GR250', null, 8.00, 'USD', 4, true),
  ('bc000000-0000-0000-0000-000000000004', 'ESPEJO GR 250 IZQUIERDO', null, 9.00, 'USD', 2, true),
  -- Familia 45: 450 y 4500 (ruido) antes que 45T y 45LTS.
  ('bc000000-0000-0000-0000-000000000005', 'KIT ARRASTRE 450 REFORZADO', null, 30.00, 'USD', 2, true),
  ('bc000000-0000-0000-0000-000000000006', 'CORONA 4500 GENERICA', null, 12.00, 'USD', 1, true),
  ('bc000000-0000-0000-0000-000000000007', 'CORONA 45T HORSE', null, 14.00, 'USD', 200, true),
  ('bc000000-0000-0000-0000-000000000008', 'MALETA CUADRADA 45LTS PLATA', null, 60.00, 'USD', 9, true),
  -- Familia palabra corta: CROMADO y RING (ruido) antes que CRO y RINES.
  ('bc000000-0000-0000-0000-000000000009', 'LUZ CRUCE CROMADO', null, 7.00, 'USD', 4, true),
  ('bc000000-0000-0000-0000-000000000010', 'RING PROTECTOR CLUTCH', null, 5.00, 'USD', 1, true),
  ('bc000000-0000-0000-0000-000000000011', 'ESTRIBO TIPO CRO NEGRO', null, 15.00, 'USD', 2, true),
  ('bc000000-0000-0000-0000-000000000012', 'RINES ALUMINIO 17 NEGRO', null, 90.00, 'USD', 2, true),
  -- Familia tanques (variantes, año, marca de moto): T1 y T2 son de OTRA moto.
  ('bc000000-0000-0000-0000-000000000013', 'TANQUE COMBUSTIBLE EK XPRESS II AZUL', null, 50.00, 'USD', 5, true),
  ('bc000000-0000-0000-0000-000000000014', 'TANQUE COMBUSTIBLE OWEN 2014 AZUL', null, 50.00, 'USD', 2, true),
  ('bc000000-0000-0000-0000-000000000015', 'TANQUE COMBUSTIBLE BERA SBR AZUL', null, 55.00, 'USD', 0, true),
  ('bc000000-0000-0000-0000-000000000016', 'TANQUE COMBUSTIBLE BERA SBR AZUL 2024', null, 58.00, 'USD', 0, true),
  ('bc000000-0000-0000-0000-000000000017', 'TANQUE COMBUSTIBLE BERA SBR ROJO', null, 55.00, 'USD', 4, true),
  ('bc000000-0000-0000-0000-000000000018', 'TANQUE COMBUSTIBLE BERA SBR NEGRO', null, 55.00, 'USD', 3, true),
  -- Familia defensas (universales / otra moto). Se suman a DEFENSA BRZ 250 y
  -- DEFENSA PROTECTOR MOTOR UNIVERSAL de la fixture de T1 (28/9/2026).
  ('bc000000-0000-0000-0000-000000000019', 'DEFENSA DELANTERA KAVAK', null, 45.00, 'USD', 3, true),
  ('bc000000-0000-0000-0000-000000000020', 'DEFENSA KLR NEGRA', null, 45.00, 'USD', 1, true),
  ('bc000000-0000-0000-0000-000000000021', 'DEFENSA SLIDER PROTECTOR', null, 20.00, 'USD', 0, true),
  ('bc000000-0000-0000-0000-000000000022', 'DEFENSA UNIVERSAL TIPO KAVAK', null, 25.00, 'USD', 1, true),
  ('bc000000-0000-0000-0000-000000000023', 'DEFENSA DELANTERA SUPER DT LEFOR', null, 48.00, 'USD', 6, true),
  -- «ASIENTO SBR /SOC ORIGINAL» nombra DOS motos y le sirve a una SBR.
  ('bc000000-0000-0000-0000-000000000024', 'ASIENTO SBR /SOC ORIGINAL', null, 40.00, 'USD', 2, true),
  -- Desempate: tres bujías iguales en todo salvo stock y nombre (el de más
  -- stock es el último por orden alfabético) y una sin stock que sería la
  -- primera alfabéticamente.
  ('bc000000-0000-0000-0000-000000000025', 'BUJIA NGK AA0', null, 3.00, 'USD', 0, true),
  ('bc000000-0000-0000-0000-000000000026', 'BUJIA NGK AAA', null, 3.00, 'USD', 1, true),
  ('bc000000-0000-0000-0000-000000000027', 'BUJIA NGK BBB', null, 3.00, 'USD', 5, true),
  ('bc000000-0000-0000-0000-000000000028', 'BUJIA NGK CCC', null, 3.00, 'USD', 9, true);

-- Ayudante: ids en el orden en que la función los devuelve (límite 50).
create function pg_temp._orden(
  p_terminos jsonb,
  p_moto jsonb default '[]'::jsonb,
  p_opc jsonb default '[]'::jsonb,
  p_cil jsonb default '[]'::jsonb,
  p_var jsonb default '[]'::jsonb,
  p_marca jsonb default '[]'::jsonb,
  p_conocidas jsonb default '[]'::jsonb
) returns uuid[] language sql as $f$
  select coalesce(array_agg(t.id order by t.rn), '{}'::uuid[]) from (
    select r.id, row_number() over () as rn
    from public.buscar_productos(
      p_terminos, p_moto, 50, p_opc, p_cil,
      p_variantes => p_var, p_moto_marca => p_marca, p_motos_conocidas => p_conocidas
    ) r
  ) t
$f$;

-- ---------------------------------------------------------------------------
-- Caso 27 · la moto calza por PALABRA (o palabra seguida de dígitos).
--   a) moto "gr" contra maletas: MALETA ... TOMCAT GRIS NO calza la moto (con
--      `\m` a secas, "gr" calzaba dentro de "GRIS"); ninguna maleta nombra gr,
--      así que puntaje_moto_maximo = 0 y la moto no restringe nada.
--   b) pastillas: PASTILLA FRENO GR250 sí calza (gr + dígitos) y queda
--      primera; es la única del máximo con la moto.
--   c) "GR 250" con espacio también calza.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_orden uuid[];
begin
  select puntaje_moto_nombre, puntaje_moto_maximo, filas_con_maximo_y_moto, filas_con_puntaje_maximo into r
  from public.buscar_productos('[["maleta"]]'::jsonb, '[["gr"]]'::jsonb, 50)
  where id = 'bc000000-0000-0000-0000-000000000001'::uuid;
  if r.puntaje_moto_nombre is distinct from 0 or r.puntaje_moto_maximo is distinct from 0
     or r.filas_con_maximo_y_moto is distinct from r.filas_con_puntaje_maximo then
    insert into _errores(msg) values (format('Caso 27a: MALETA ... GRIS con moto "gr": puntaje_moto_nombre=%s, puntaje_moto_maximo=%s, filas_con_maximo_y_moto=%s de %s; se esperaba 0, 0 y todas -- "gr" no calza dentro de "GRIS".', r.puntaje_moto_nombre, r.puntaje_moto_maximo, r.filas_con_maximo_y_moto, r.filas_con_puntaje_maximo));
  end if;

  select puntaje_moto_nombre, puntaje_moto_maximo, filas_con_maximo_y_moto, filas_con_puntaje_maximo into r
  from public.buscar_productos('[["pastilla"],["freno"]]'::jsonb, '[["gr"]]'::jsonb, 50)
  where id = 'bc000000-0000-0000-0000-000000000003'::uuid;
  v_orden := pg_temp._orden('[["pastilla"],["freno"]]'::jsonb, '[["gr"]]'::jsonb);
  if r.puntaje_moto_nombre is distinct from 1 or r.puntaje_moto_maximo is distinct from 1
     or r.filas_con_maximo_y_moto is distinct from 1 or r.filas_con_puntaje_maximo is distinct from 6
     or v_orden[1] is distinct from 'bc000000-0000-0000-0000-000000000003'::uuid then
    insert into _errores(msg) values (format('Caso 27b: PASTILLA FRENO GR250 con moto "gr": puntaje_moto_nombre=%s, puntaje_moto_maximo=%s, filas_con_maximo_y_moto=%s, filas_con_puntaje_maximo=%s, primero=%s; se esperaba 1, 1, 1, 6 y GR250 primera.', r.puntaje_moto_nombre, r.puntaje_moto_maximo, r.filas_con_maximo_y_moto, r.filas_con_puntaje_maximo, v_orden[1]));
  end if;

  select puntaje_moto_nombre into r
  from public.buscar_productos('[["espejo"]]'::jsonb, '[["gr"]]'::jsonb, 50)
  where id = 'bc000000-0000-0000-0000-000000000004'::uuid;
  v_orden := pg_temp._orden('[["espejo"]]'::jsonb, '[["gr"]]'::jsonb);
  if r.puntaje_moto_nombre is distinct from 1 or v_orden[1] is distinct from 'bc000000-0000-0000-0000-000000000004'::uuid then
    insert into _errores(msg) values (format('Caso 27c: ESPEJO GR 250 con moto "gr": puntaje_moto_nombre=%s, primero=%s; se esperaba 1 y ESPEJO GR 250 primero ("GR 250" con espacio calza, GRIS no).', r.puntaje_moto_nombre, v_orden[1]));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 28 · un número calza con su sufijo de LETRAS, nunca de dígitos: "45"
-- calza CORONA 45T y MALETA CUADRADA 45LTS, no CORONA 4500 ni 450; "50" no
-- calza 5000 y "dt200" no calza DT2000 (casos 16 y 18, siguen valiendo).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_orden uuid[];
begin
  select puntaje into r from public.buscar_productos('[["corona"],["45"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'bc000000-0000-0000-0000-000000000007'::uuid;
  v_orden := pg_temp._orden('[["corona"],["45"]]'::jsonb);
  if r.puntaje is distinct from 2 or v_orden[1] is distinct from 'bc000000-0000-0000-0000-000000000007'::uuid then
    insert into _errores(msg) values (format('Caso 28a: CORONA 45T con [corona][45]: puntaje=%s, primero=%s; se esperaba 2 y CORONA 45T primera ("45" calza "45T").', r.puntaje, v_orden[1]));
  end if;

  select puntaje into r from public.buscar_productos('[["corona"],["45"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'bc000000-0000-0000-0000-000000000006'::uuid;
  if r.puntaje is distinct from 1 then
    insert into _errores(msg) values (format('Caso 28a: CORONA 4500 trae puntaje %s, se esperaba 1 ("45" no calza "4500").', r.puntaje));
  end if;

  select puntaje into r from public.buscar_productos('[["maleta"],["45"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'bc000000-0000-0000-0000-000000000008'::uuid;
  if r.puntaje is distinct from 2 then
    insert into _errores(msg) values (format('Caso 28b: MALETA CUADRADA 45LTS trae puntaje %s con [maleta][45], se esperaba 2 ("45" calza "45LTS").', r.puntaje));
  end if;

  select puntaje into r from public.buscar_productos('[["kit"],["45"]]'::jsonb, '[]'::jsonb, 50)
  where id = 'bc000000-0000-0000-0000-000000000005'::uuid;
  if r.puntaje is distinct from 1 then
    insert into _errores(msg) values (format('Caso 28c: KIT ARRASTRE 450 trae puntaje %s con [kit][45], se esperaba 1 ("45" no calza "450").', r.puntaje));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 29 · una palabra alfabética de 3 letras o menos calza como palabra
-- ENTERA, con plural: "cro" no calza LUZ CRUCE CROMADO pero sí ESTRIBO TIPO
-- CRO; "rin" calza RINES ALUMINIO pero no RING PROTECTOR.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cro uuid[];
  v_rin uuid[];
begin
  v_cro := pg_temp._orden('[["cro"]]'::jsonb);
  if not ('bc000000-0000-0000-0000-000000000011'::uuid = any(v_cro)) then
    insert into _errores(msg) values ('Caso 29: "cro" no trajo ESTRIBO TIPO CRO NEGRO.');
  end if;
  if 'bc000000-0000-0000-0000-000000000009'::uuid = any(v_cro) or 'bc000000-0000-0000-0000-000000000002'::uuid = any(v_cro) then
    insert into _errores(msg) values ('Caso 29: "cro" calzó dentro de CROMADO -- una palabra de 3 letras o menos tiene que calzar entera.');
  end if;

  v_rin := pg_temp._orden('[["rin"]]'::jsonb);
  if not ('bc000000-0000-0000-0000-000000000012'::uuid = any(v_rin)) then
    insert into _errores(msg) values ('Caso 29: "rin" no trajo RINES ALUMINIO 17 NEGRO (el plural (s|es)? tiene que calzar).');
  end if;
  if 'bc000000-0000-0000-0000-000000000010'::uuid = any(v_rin) then
    insert into _errores(msg) values ('Caso 29: "rin" calzó dentro de RING PROTECTOR CLUTCH.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 30 · variantes: un conjunto APARTE de grupos (p_variantes) que ordena
-- y se cuenta en ventanas ANTES del límite. Tanque SBR azul: los dos azules
-- SBR están agotados y hay rojo y negro con stock.
--   a) moto sbr + [azul]: la moto calza (1), las del máximo y la moto son 4
--      (los EK/OWEN quedan fuera de la ventana); con variante 2, sin stock 0.
--      Los dos azules SBR van primeros; los EK/OWEN (moto 0) detrás de todos
--      los SBR aunque tengan stock.
--   b) sin moto: 4 tanques azules en total, 2 con stock (EK y OWEN).
--   c) las variantes son ESTRICTAS (TODAS): [azul][rojo] no calza ninguno;
--      [azul][2024] calza solo el SBR azul 2024.
--   d) sin variantes las ventanas de variante valen 0.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_orden uuid[];
begin
  select puntaje_moto_maximo, filas_con_puntaje_maximo, filas_con_maximo_y_moto, filas_con_maximo_y_stock,
         filas_con_variante, filas_con_variante_y_stock into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, 1,
       p_variantes => '[["azul"]]'::jsonb, p_motos_conocidas => '["sbr","xpress","owen"]'::jsonb);
  if r.puntaje_moto_maximo is distinct from 1 or r.filas_con_puntaje_maximo is distinct from 6
     or r.filas_con_maximo_y_moto is distinct from 4 or r.filas_con_maximo_y_stock is distinct from 2
     or r.filas_con_variante is distinct from 2 or r.filas_con_variante_y_stock is distinct from 0 then
    insert into _errores(msg) values (format('Caso 30a: tanque + moto sbr + [azul]: moto_max=%s (1), filas_max=%s (6), max_y_moto=%s (4), max_y_stock=%s (2), con_variante=%s (2), con_variante_y_stock=%s (0).', r.puntaje_moto_maximo, r.filas_con_puntaje_maximo, r.filas_con_maximo_y_moto, r.filas_con_maximo_y_stock, r.filas_con_variante, r.filas_con_variante_y_stock));
  end if;

  v_orden := pg_temp._orden('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[["azul"]]'::jsonb, '[]'::jsonb, '["sbr","xpress","owen"]'::jsonb);
  if not (v_orden[1] in ('bc000000-0000-0000-0000-000000000015'::uuid, 'bc000000-0000-0000-0000-000000000016'::uuid)
          and v_orden[2] in ('bc000000-0000-0000-0000-000000000015'::uuid, 'bc000000-0000-0000-0000-000000000016'::uuid)) then
    insert into _errores(msg) values (format('Caso 30a: los dos primeros con [azul] + moto sbr deberían ser los tanques SBR azules; fueron %s y %s.', v_orden[1], v_orden[2]));
  end if;
  if array_position(v_orden, 'bc000000-0000-0000-0000-000000000013'::uuid) <= array_position(v_orden, 'bc000000-0000-0000-0000-000000000018'::uuid) then
    insert into _errores(msg) values ('Caso 30a: el tanque EK XPRESS azul (otra moto, con stock 5) quedó por delante de un tanque SBR: la moto con nombre ordena antes que la variante.');
  end if;

  -- Banderas por fila, con la moto sbr y estas motos conocidas.
  select nombra_moto, nombra_otra_moto, es_universal into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, 50,
       p_motos_conocidas => '["sbr","xpress","owen"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000015'::uuid;
  if r.nombra_moto is distinct from true or r.nombra_otra_moto is distinct from false or r.es_universal is distinct from false then
    insert into _errores(msg) values (format('Caso 30a: TANQUE BERA SBR AZUL con moto sbr: nombra_moto=%s, nombra_otra_moto=%s, es_universal=%s; se esperaba true, false, false.', r.nombra_moto, r.nombra_otra_moto, r.es_universal));
  end if;
  select nombra_moto, nombra_otra_moto into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, 50,
       p_motos_conocidas => '["sbr","xpress","owen"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000013'::uuid;
  if r.nombra_moto is distinct from true or r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values (format('Caso 30a: TANQUE EK XPRESS con moto sbr: nombra_moto=%s, nombra_otra_moto=%s; se esperaba true y true (es de otra moto).', r.nombra_moto, r.nombra_otra_moto));
  end if;

  -- b) sin moto.
  select puntaje_moto_maximo, filas_con_variante, filas_con_variante_y_stock, puntaje_variante into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[]'::jsonb, 50, p_variantes => '[["azul"]]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000015'::uuid;
  if r.puntaje_moto_maximo is distinct from 0 or r.filas_con_variante is distinct from 4
     or r.filas_con_variante_y_stock is distinct from 2 or r.puntaje_variante is distinct from 1 then
    insert into _errores(msg) values (format('Caso 30b: tanque sin moto + [azul]: moto_max=%s (0), con_variante=%s (4), con_variante_y_stock=%s (2), puntaje_variante del SBR azul=%s (1).', r.puntaje_moto_maximo, r.filas_con_variante, r.filas_con_variante_y_stock, r.puntaje_variante));
  end if;

  -- c) TODAS las variantes.
  select filas_con_variante, filas_con_variante_y_stock into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, 1, p_variantes => '[["azul"],["rojo"]]'::jsonb)
  ;
  if r.filas_con_variante is distinct from 0 or r.filas_con_variante_y_stock is distinct from 0 then
    insert into _errores(msg) values (format('Caso 30c: [azul][rojo] contó %s fila(s) con TODAS las variantes, se esperaban 0 (ningún tanque es azul y rojo).', r.filas_con_variante));
  end if;
  select filas_con_variante, filas_con_variante_y_stock into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, 1, p_variantes => '[["azul"],["2024"]]'::jsonb);
  v_orden := pg_temp._orden('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[["azul"],["2024"]]'::jsonb);
  if r.filas_con_variante is distinct from 1 or r.filas_con_variante_y_stock is distinct from 0
     or v_orden[1] is distinct from 'bc000000-0000-0000-0000-000000000016'::uuid then
    insert into _errores(msg) values (format('Caso 30c: [azul][2024] con moto sbr: con_variante=%s (1), con_variante_y_stock=%s (0), primero=%s (SBR AZUL 2024).', r.filas_con_variante, r.filas_con_variante_y_stock, v_orden[1]));
  end if;

  -- d) sin variantes.
  select filas_con_variante, filas_con_variante_y_stock, puntaje_variante into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, 1);
  if r.filas_con_variante is distinct from 0 or r.filas_con_variante_y_stock is distinct from 0 or r.puntaje_variante is distinct from 0 then
    insert into _errores(msg) values (format('Caso 30d: sin variantes: con_variante=%s, con_variante_y_stock=%s, puntaje_variante=%s; se esperaba 0, 0 y 0.', r.filas_con_variante, r.filas_con_variante_y_stock, r.puntaje_variante));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 31 · el año (2014) viaja en p_cilindrada: solo ORDENA. TANQUE OWEN 2014
-- sube al primer lugar, ningún tanque desaparece y nunca vuelve verdadera la
-- coincidencia de moto.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_orden uuid[];
begin
  v_orden := pg_temp._orden('[["tanque"]]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[["2014"]]'::jsonb);
  select puntaje_moto_cilindrada, puntaje_moto_maximo, filas_con_puntaje_maximo, filas_con_maximo_y_moto into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[]'::jsonb, 50, p_cilindrada => '[["2014"]]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000014'::uuid;
  if r.puntaje_moto_cilindrada is distinct from 1 or r.puntaje_moto_maximo is distinct from 0
     or v_orden[1] is distinct from 'bc000000-0000-0000-0000-000000000014'::uuid
     or cardinality(v_orden) <> 6 or r.filas_con_maximo_y_moto is distinct from r.filas_con_puntaje_maximo then
    insert into _errores(msg) values (format('Caso 31: año 2014 en p_cilindrada: puntaje_moto_cilindrada=%s (1), puntaje_moto_maximo=%s (0), primero=%s (TANQUE OWEN 2014), %s fila(s) (6), max_y_moto=%s de %s.', r.puntaje_moto_cilindrada, r.puntaje_moto_maximo, v_orden[1], cardinality(v_orden), r.filas_con_maximo_y_moto, r.filas_con_puntaje_maximo));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 32 · la marca de moto (p_moto_marca) solo ORDENA: no vuelve verdadero
-- puntaje_moto_maximo ni restringe ventanas. Va DESPUÉS de la moto con nombre
-- y ANTES de la existencia: con marca bera, los tanques BERA (aunque estén
-- agotados) van antes que el EK con stock 5; con moto ek + marca bera manda
-- el EK.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_orden uuid[];
begin
  select puntaje_moto_marca, puntaje_moto_maximo, filas_con_maximo_y_moto, filas_con_puntaje_maximo into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[]'::jsonb, 50, p_moto_marca => '[["bera"]]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000015'::uuid;
  if r.puntaje_moto_marca is distinct from 1 or r.puntaje_moto_maximo is distinct from 0
     or r.filas_con_maximo_y_moto is distinct from r.filas_con_puntaje_maximo then
    insert into _errores(msg) values (format('Caso 32: marca bera: puntaje_moto_marca=%s (1), puntaje_moto_maximo=%s (0), max_y_moto=%s de %s -- la marca no puede volver verdadera la moto ni restringir.', r.puntaje_moto_marca, r.puntaje_moto_maximo, r.filas_con_maximo_y_moto, r.filas_con_puntaje_maximo));
  end if;

  v_orden := pg_temp._orden('[["tanque"]]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[["bera"]]'::jsonb);
  if array_position(v_orden, 'bc000000-0000-0000-0000-000000000013'::uuid) <= array_position(v_orden, 'bc000000-0000-0000-0000-000000000015'::uuid)
     or array_position(v_orden, 'bc000000-0000-0000-0000-000000000014'::uuid) <= array_position(v_orden, 'bc000000-0000-0000-0000-000000000016'::uuid) then
    insert into _errores(msg) values ('Caso 32: con marca bera, un tanque EK/OWEN quedó por delante de un tanque BERA agotado: la marca ordena antes que la existencia.');
  end if;

  select puntaje_moto_maximo, filas_con_maximo_y_moto into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["ek"]]'::jsonb, 1, p_moto_marca => '[["bera"]]'::jsonb);
  v_orden := pg_temp._orden('[["tanque"]]'::jsonb, '[["ek"]]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[["bera"]]'::jsonb);
  if r.puntaje_moto_maximo is distinct from 1 or r.filas_con_maximo_y_moto is distinct from 1
     or v_orden[1] is distinct from 'bc000000-0000-0000-0000-000000000013'::uuid then
    insert into _errores(msg) values (format('Caso 32: moto ek + marca bera: puntaje_moto_maximo=%s (1), max_y_moto=%s (1), primero=%s (TANQUE EK XPRESS): la moto con nombre manda sobre la marca.', r.puntaje_moto_maximo, r.filas_con_maximo_y_moto, v_orden[1]));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 33 · "otra moto" y "universal" (D1) sobre las defensas. Motos conocidas
-- brz, kavak, klr, dt. Siete defensas activas: BRZ 250 (2), PROTECTOR MOTOR
-- UNIVERSAL (2), KAVAK (3), KLR (1), SLIDER PROTECTOR (0, no nombra moto),
-- UNIVERSAL TIPO KAVAK (1: nombra kavak Y dice universal) y SUPER DT (6).
--   a) moto tx (ninguna fila la nombra): las ventanas cubren las siete:
--      nombran moto 5, universales 3 (PROTECTOR, SLIDER, UNIVERSAL KAVAK), con
--      stock 2 (SLIDER está en 0); con stock en total 6.
--   b) moto dt (calza SUPER DT): la ventana se restringe a esa fila.
--   c) sin moto: nombra_otra_moto = nombra_moto.
--   d) sin p_motos_conocidas nada nombra moto y todo es universal (degradación
--      documentada: T5 siempre pasa la lista).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  select puntaje_moto_maximo, filas_con_puntaje_maximo, filas_que_nombran_moto, filas_universales,
         filas_universales_con_stock, filas_con_maximo_y_stock into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["tx"]]'::jsonb, 1,
       p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb);
  if r.puntaje_moto_maximo is distinct from 0 or r.filas_con_puntaje_maximo is distinct from 7
     or r.filas_que_nombran_moto is distinct from 5 or r.filas_universales is distinct from 3
     or r.filas_universales_con_stock is distinct from 2 or r.filas_con_maximo_y_stock is distinct from 6 then
    insert into _errores(msg) values (format('Caso 33a: defensa + moto tx: moto_max=%s (0), filas_max=%s (7), nombran_moto=%s (5), universales=%s (3), universales_con_stock=%s (2), max_y_stock=%s (6).', r.puntaje_moto_maximo, r.filas_con_puntaje_maximo, r.filas_que_nombran_moto, r.filas_universales, r.filas_universales_con_stock, r.filas_con_maximo_y_stock));
  end if;

  -- Banderas por fila (moto tx).
  select nombra_moto, nombra_otra_moto, es_universal into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["tx"]]'::jsonb, 50, p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb)
  where id = 'b8000000-0000-0000-0000-000000000005'::uuid; -- DEFENSA BRZ 250
  if r.nombra_moto is distinct from true or r.nombra_otra_moto is distinct from true or r.es_universal is distinct from false then
    insert into _errores(msg) values (format('Caso 33a: DEFENSA BRZ 250: nombra_moto=%s, nombra_otra_moto=%s, es_universal=%s; se esperaba true, true, false.', r.nombra_moto, r.nombra_otra_moto, r.es_universal));
  end if;
  select nombra_moto, nombra_otra_moto, es_universal into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["tx"]]'::jsonb, 50, p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb)
  where id = 'b8000000-0000-0000-0000-000000000006'::uuid; -- PROTECTOR MOTOR UNIVERSAL
  if r.nombra_moto is distinct from false or r.nombra_otra_moto is distinct from false or r.es_universal is distinct from true then
    insert into _errores(msg) values (format('Caso 33a: DEFENSA PROTECTOR MOTOR UNIVERSAL: nombra_moto=%s, nombra_otra_moto=%s, es_universal=%s; se esperaba false, false, true.', r.nombra_moto, r.nombra_otra_moto, r.es_universal));
  end if;
  select nombra_moto, nombra_otra_moto, es_universal into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["tx"]]'::jsonb, 50, p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000021'::uuid; -- SLIDER PROTECTOR
  if r.nombra_moto is distinct from false or r.nombra_otra_moto is distinct from false or r.es_universal is distinct from true then
    insert into _errores(msg) values (format('Caso 33a: DEFENSA SLIDER PROTECTOR (sin moto en el nombre): nombra_moto=%s, nombra_otra_moto=%s, es_universal=%s; se esperaba false, false, true.', r.nombra_moto, r.nombra_otra_moto, r.es_universal));
  end if;
  select nombra_moto, nombra_otra_moto, es_universal into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["tx"]]'::jsonb, 50, p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000022'::uuid; -- UNIVERSAL TIPO KAVAK
  if r.nombra_moto is distinct from true or r.nombra_otra_moto is distinct from true or r.es_universal is distinct from true then
    insert into _errores(msg) values (format('Caso 33a: DEFENSA UNIVERSAL TIPO KAVAK: nombra_moto=%s, nombra_otra_moto=%s, es_universal=%s; se esperaba true, true, true (nombra una moto pero dice UNIVERSAL).', r.nombra_moto, r.nombra_otra_moto, r.es_universal));
  end if;

  -- b) moto dt: calza SUPER DT.
  select puntaje_moto_maximo, filas_con_maximo_y_moto, filas_que_nombran_moto, filas_universales,
         filas_universales_con_stock, filas_con_maximo_y_stock into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["dt"]]'::jsonb, 1,
       p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb);
  if r.puntaje_moto_maximo is distinct from 1 or r.filas_con_maximo_y_moto is distinct from 1
     or r.filas_que_nombran_moto is distinct from 1 or r.filas_universales is distinct from 0
     or r.filas_universales_con_stock is distinct from 0 or r.filas_con_maximo_y_stock is distinct from 1 then
    insert into _errores(msg) values (format('Caso 33b: defensa + moto dt: moto_max=%s (1), max_y_moto=%s (1), nombran_moto=%s (1), universales=%s (0), universales_con_stock=%s (0), max_y_stock=%s (1) -- las ventanas se restringen a la moto que calza.', r.puntaje_moto_maximo, r.filas_con_maximo_y_moto, r.filas_que_nombran_moto, r.filas_universales, r.filas_universales_con_stock, r.filas_con_maximo_y_stock));
  end if;
  select nombra_otra_moto into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["dt"]]'::jsonb, 50, p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000023'::uuid;
  if r.nombra_otra_moto is distinct from false then
    insert into _errores(msg) values (format('Caso 33b: DEFENSA SUPER DT con moto dt: nombra_otra_moto=%s, se esperaba false (es la moto del cliente).', r.nombra_otra_moto));
  end if;
  select nombra_otra_moto into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["dt"]]'::jsonb, 50, p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000019'::uuid;
  if r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values (format('Caso 33b: DEFENSA KAVAK con moto dt: nombra_otra_moto=%s, se esperaba true.', r.nombra_otra_moto));
  end if;

  -- c) sin moto: nombra_otra_moto = nombra_moto.
  select nombra_moto, nombra_otra_moto into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[]'::jsonb, 50, p_motos_conocidas => '["brz","kavak","klr","dt"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000020'::uuid; -- KLR
  if r.nombra_moto is distinct from true or r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values (format('Caso 33c: DEFENSA KLR sin moto del cliente: nombra_moto=%s, nombra_otra_moto=%s; se esperaba true y true.', r.nombra_moto, r.nombra_otra_moto));
  end if;

  -- d) sin p_motos_conocidas.
  select filas_que_nombran_moto, filas_universales, nombra_moto, es_universal into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[["tx"]]'::jsonb, 1);
  if r.filas_que_nombran_moto is distinct from 0 or r.filas_universales is distinct from 7 or r.nombra_moto is distinct from false or r.es_universal is distinct from true then
    insert into _errores(msg) values (format('Caso 33d: sin p_motos_conocidas: nombran_moto=%s (0), universales=%s (7), nombra_moto=%s, es_universal=%s.', r.filas_que_nombran_moto, r.filas_universales, r.nombra_moto, r.es_universal));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 34 · «ASIENTO SBR /SOC ORIGINAL» nombra DOS motos y sí le sirve a una
-- SBR: con moto sbr, nombra_otra_moto = false. Con moto kavak, en cambio, sí
-- es de otra moto. Y GOMA ASIENTO UNIVERSAL TRACTOR es universal por no
-- nombrar ninguna.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  select nombra_moto, nombra_otra_moto, puntaje_moto_nombre into r
  from public.buscar_productos('[["asiento"]]'::jsonb, '[["sbr"]]'::jsonb, 50, p_motos_conocidas => '["sbr","soc","kavak"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000024'::uuid;
  if r.nombra_moto is distinct from true or r.nombra_otra_moto is distinct from false or r.puntaje_moto_nombre is distinct from 1 then
    insert into _errores(msg) values (format('Caso 34: ASIENTO SBR /SOC con moto sbr: nombra_moto=%s, nombra_otra_moto=%s, puntaje_moto_nombre=%s; se esperaba true, false, 1.', r.nombra_moto, r.nombra_otra_moto, r.puntaje_moto_nombre));
  end if;

  select nombra_otra_moto into r
  from public.buscar_productos('[["asiento"]]'::jsonb, '[["kavak"]]'::jsonb, 50, p_motos_conocidas => '["sbr","soc","kavak"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000024'::uuid;
  if r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values (format('Caso 34: ASIENTO SBR /SOC con moto kavak: nombra_otra_moto=%s, se esperaba true.', r.nombra_otra_moto));
  end if;

  select es_universal, nombra_moto into r
  from public.buscar_productos('[["asiento"]]'::jsonb, '[["sbr"]]'::jsonb, 50, p_motos_conocidas => '["sbr","soc","kavak"]'::jsonb)
  where id = 'b2000000-0000-0000-0000-000000000003'::uuid; -- GOMA ASIENTO UNIVERSAL TRACTOR
  if r.es_universal is distinct from true or r.nombra_moto is distinct from false then
    insert into _errores(msg) values (format('Caso 34: GOMA ASIENTO UNIVERSAL TRACTOR: es_universal=%s, nombra_moto=%s; se esperaba true y false.', r.es_universal, r.nombra_moto));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 34b · la MARCA de moto no cuenta para "otra moto" (desvío documentado
-- en la migración): cliente con moto sbr y marca ek; TANQUE EK XPRESS II calza
-- la marca (ek) pero nombra xpress, no sbr -> sigue siendo de otra moto.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  select nombra_otra_moto, puntaje_moto_marca into r
  from public.buscar_productos('[["tanque"]]'::jsonb, '[["sbr"]]'::jsonb, 50,
       p_moto_marca => '[["ek"]]'::jsonb, p_motos_conocidas => '["sbr","xpress","owen"]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000013'::uuid;
  if r.nombra_otra_moto is distinct from true or r.puntaje_moto_marca is distinct from 1 then
    insert into _errores(msg) values (format('Caso 34b: TANQUE EK XPRESS con moto sbr y marca ek: nombra_otra_moto=%s (true), puntaje_moto_marca=%s (1) -- la marca solo ordena, no vuelve "propio" a un producto de otro modelo.', r.nombra_otra_moto, r.puntaje_moto_marca));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 34c · MARCA SIN MODELO no es "otra moto" (refinamiento del coordinador,
-- 30/9/2026, con p_marcas_de_moto): lista "batería" para una Bera Socialista
-- tiene que poder cotizar BATERIA SECA JAGUAR/BERA 12N6.5 (nombra solo marcas:
-- jaguar y bera), mientras que TAPA LATERAL BERA SBR para una Bera Milan sigue
-- siendo de otra moto (nombra el MODELO sbr, distinto de milan). Ruido primero:
-- baterías de otros modelos y tapas de otros modelos antes de las correctas.
--   a) socialista + marca bera + marcas [bera, jaguar, ek]: JAGUAR/BERA no es
--      otra moto; VSTROM y DR650 (modelos ajenos, sin marca del cliente) sí.
--   b) milan + marca bera: TAPA LATERAL BERA SBR sí es otra moto (modelo sbr),
--      TAPA LATERAL MILAN AZUL calza la moto (puntaje_moto_nombre = 1).
--   c) SIN p_marcas_de_moto, todo cuenta como modelo y el comportamiento es el
--      de antes: JAGUAR/BERA vuelve a ser otra moto.
--   d) una marca solo se reconoce dentro del tope de 50 palabras.
-- ---------------------------------------------------------------------------
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('bc000000-0000-0000-0000-000000000029', 'BATERIA VSTROM 12V 10AH', null, 60.00, 'USD', 4, true),
  ('bc000000-0000-0000-0000-000000000030', 'BATERIA DR650 12V', null, 55.00, 'USD', 3, true),
  ('bc000000-0000-0000-0000-000000000031', 'TAPA LATERAL BERA SBR AZUL', null, 12.00, 'USD', 5, true),
  ('bc000000-0000-0000-0000-000000000032', 'BATERIA SECA JAGUAR/BERA 12N6.5', null, 18.00, 'USD', 116, true),
  ('bc000000-0000-0000-0000-000000000033', 'TAPA LATERAL MILAN AZUL', null, 12.00, 'USD', 2, true);

do $$
declare
  r record;
  v_conocidas jsonb := '["socialista","sbr","milan","bera","jaguar","vstrom","dr650","ek"]'::jsonb;
  v_marcas jsonb := '["bera","jaguar","ek"]'::jsonb;
  v_relleno jsonb;
begin
  -- a) Bera Socialista pide baterías.
  select nombra_moto, nombra_otra_moto, es_universal into r
  from public.buscar_productos('[["bateria"]]'::jsonb, '[["socialista"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas, p_marcas_de_moto => v_marcas)
  where id = 'bc000000-0000-0000-0000-000000000032'::uuid;
  if r.nombra_moto is distinct from true or r.nombra_otra_moto is distinct from false or r.es_universal is distinct from false then
    insert into _errores(msg) values (format('Caso 34c: BATERIA SECA JAGUAR/BERA con moto socialista + marca bera: nombra_moto=%s (true), nombra_otra_moto=%s (false), es_universal=%s (false) -- nombra solo marcas, es de la marca del cliente.', r.nombra_moto, r.nombra_otra_moto, r.es_universal));
  end if;
  select nombra_otra_moto into r
  from public.buscar_productos('[["bateria"]]'::jsonb, '[["socialista"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas, p_marcas_de_moto => v_marcas)
  where id = 'bc000000-0000-0000-0000-000000000029'::uuid;
  if r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values (format('Caso 34c: BATERIA VSTROM con moto socialista + marca bera: nombra_otra_moto=%s, se esperaba true (modelo ajeno, sin la marca del cliente).', r.nombra_otra_moto));
  end if;
  select nombra_otra_moto into r
  from public.buscar_productos('[["bateria"]]'::jsonb, '[["socialista"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas, p_marcas_de_moto => v_marcas)
  where id = 'bc000000-0000-0000-0000-000000000030'::uuid;
  if r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values (format('Caso 34c: BATERIA DR650 con moto socialista + marca bera: nombra_otra_moto=%s, se esperaba true.', r.nombra_otra_moto));
  end if;

  -- b) Bera Milan pide tapas.
  select nombra_otra_moto, puntaje_moto_marca into r
  from public.buscar_productos('[["tapa"],["lateral"]]'::jsonb, '[["milan"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas, p_marcas_de_moto => v_marcas)
  where id = 'bc000000-0000-0000-0000-000000000031'::uuid;
  if r.nombra_otra_moto is distinct from true or r.puntaje_moto_marca is distinct from 1 then
    insert into _errores(msg) values (format('Caso 34c: TAPA LATERAL BERA SBR con moto milan + marca bera: nombra_otra_moto=%s (true), puntaje_moto_marca=%s (1) -- la marca sola no rescata: nombra el modelo sbr.', r.nombra_otra_moto, r.puntaje_moto_marca));
  end if;
  select nombra_otra_moto, puntaje_moto_nombre into r
  from public.buscar_productos('[["tapa"],["lateral"]]'::jsonb, '[["milan"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas, p_marcas_de_moto => v_marcas)
  where id = 'bc000000-0000-0000-0000-000000000033'::uuid;
  if r.nombra_otra_moto is distinct from false or r.puntaje_moto_nombre is distinct from 1 then
    insert into _errores(msg) values (format('Caso 34c: TAPA LATERAL MILAN AZUL con moto milan: nombra_otra_moto=%s (false), puntaje_moto_nombre=%s (1).', r.nombra_otra_moto, r.puntaje_moto_nombre));
  end if;

  -- c) sin p_marcas_de_moto: comportamiento de antes.
  select nombra_otra_moto into r
  from public.buscar_productos('[["bateria"]]'::jsonb, '[["socialista"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas)
  where id = 'bc000000-0000-0000-0000-000000000032'::uuid;
  if r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values (format('Caso 34c: sin p_marcas_de_moto, JAGUAR/BERA: nombra_otra_moto=%s, se esperaba true (todo cuenta como modelo: la marca sola no rescata).', r.nombra_otra_moto));
  end if;

  -- d) tope de 50 marcas: "bera" en la posición 51 no se lee, así que
  -- jaguar/bera vuelve a contar como modelo -> otra moto; en la 50 sí se lee.
  select jsonb_agg('zz' || g) into v_relleno from generate_series(1, 50) g;
  select nombra_otra_moto into r
  from public.buscar_productos('[["bateria"]]'::jsonb, '[["socialista"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas,
       p_marcas_de_moto => (v_relleno || '["bera","jaguar"]'::jsonb))
  where id = 'bc000000-0000-0000-0000-000000000032'::uuid;
  if r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values ('Caso 34c: las marcas después de la palabra 50 de p_marcas_de_moto se leyeron: el tope de 50 no se aplica.');
  end if;
  select jsonb_agg('zz' || g) into v_relleno from generate_series(1, 48) g;
  select nombra_otra_moto into r
  from public.buscar_productos('[["bateria"]]'::jsonb, '[["socialista"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas,
       p_marcas_de_moto => (v_relleno || '["bera","jaguar"]'::jsonb))
  where id = 'bc000000-0000-0000-0000-000000000032'::uuid;
  if r.nombra_otra_moto is distinct from false then
    insert into _errores(msg) values ('Caso 34c: las marcas en las posiciones 49 y 50 de p_marcas_de_moto no se leyeron.');
  end if;

  -- Basura: no lanza y no rescata.
  select nombra_otra_moto into r
  from public.buscar_productos('[["bateria"]]'::jsonb, '[["socialista"]]'::jsonb, 50,
       p_moto_marca => '[["bera"]]'::jsonb, p_motos_conocidas => v_conocidas,
       p_marcas_de_moto => '[null, 7, "", {"a":1}, ["bera"]]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000032'::uuid;
  if r.nombra_otra_moto is distinct from true then
    insert into _errores(msg) values ('Caso 34c: una entrada basura de p_marcas_de_moto rescató a JAGUAR/BERA.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 35 · desempate: con todo igual, manda la EXISTENCIA y nunca el orden
-- alfabético. Tres bujías con stock 1, 5 y 9 (el de más stock es el último
-- por nombre) y una en 0 que sería la primera por nombre: CCC, BBB, AAA, AA0.
-- (Cambio de semántica a propósito frente a 20260928010000, que desempataba
-- por `stock > 0` y después por nombre: A, B, C.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_orden uuid[];
begin
  v_orden := pg_temp._orden('[["bujia"]]'::jsonb);
  if v_orden is distinct from array[
       'bc000000-0000-0000-0000-000000000028'::uuid,
       'bc000000-0000-0000-0000-000000000027'::uuid,
       'bc000000-0000-0000-0000-000000000026'::uuid,
       'bc000000-0000-0000-0000-000000000025'::uuid] then
    insert into _errores(msg) values (format('Caso 35: el orden de las bujías fue %s; se esperaba CCC (9), BBB (5), AAA (1), AA0 (0) -- por existencia, no por nombre.', v_orden));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 36 · patron_busqueda: ÚNICA fuente de los patrones, con su forma exacta
-- por tipo, immutable y sin comodines sin escapar. Los patrones de abajo se
-- comparan literalmente: cualquier cambio tiene que ser deliberado (M3, el
-- diagnóstico de términos relajables, usa la misma función).
-- ---------------------------------------------------------------------------
do $$
declare
  errores text := '';
  v text;
  r record;
begin
  for r in select * from (values
    ('cro',    'prod', '\mcro(s|es)?\M'),
    ('rin',    'opc',  '\mrin(s|es)?\M'),
    ('45',     'prod', '\m45([^0-9]|$)'),
    ('dt200',  'prod', '\mdt200([^0-9]|$)'),
    ('dt 200', 'var',  '\mdt 200([^0-9]|$)'),
    ('11.7',   'prod', '(\m|[a-z])11\.7([^0-9]|$)'),
    ('inca',   'prod', '\minca'),
    ('4t',     'var',  '\m4t'),
    ('gr',     'moto', '\mgr([0-9]|\M)'),
    ('bera',   'moto_marca', '\mbera([0-9]|\M)'),
    ('250',    'cil',  '(\m|[a-z])250([^0-9]|$)'),
    ('2014',   'anio', '(\m|[a-z])2014([^0-9]|$)'),
    ('4*5-174l', 'prod', '\m4\*5\-174l'),
    ('45',     'inicio', '^45([^0-9]|$)'),
    ('inca',   'inicio', '^inca')
  ) as t(alt, tipo, esperado)
  loop
    v := public.patron_busqueda(r.alt, r.tipo);
    if v is distinct from r.esperado then
      errores := errores || format(E'\n  - patron_busqueda(%L, %L) = %L, se esperaba %L.', r.alt, r.tipo, v, r.esperado);
    end if;
  end loop;

  if (select provolatile from pg_proc where oid = 'public.patron_busqueda(text, text)'::regprocedure) <> 'i' then
    errores := errores || E'\n  - patron_busqueda no es IMMUTABLE.';
  end if;

  begin
    perform public.patron_busqueda('x', 'no_existe');
    errores := errores || E'\n  - un tipo desconocido no lanzó error: un tipo mal escrito volvería la búsqueda ciega en silencio.';
  exception when others then
    null;
  end;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 36 (patron_busqueda):%s', errores));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 37 · los topes de la función: p_motos_conocidas admite hasta 200
-- palabras (un arreglo PLANO de strings); una entrada que no es string o
-- viene vacía se ignora sin lanzar; con algo que no es un arreglo la función
-- responde como sin motos.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_conocidas jsonb;
begin
  -- 250 palabras de relleno seguidas de "kavak" en la posición 251: el tope
  -- de 200 la deja fuera, así que DEFENSA DELANTERA KAVAK no nombra moto.
  select jsonb_agg('zz' || g) into v_conocidas from generate_series(1, 250) g;
  v_conocidas := v_conocidas || '["kavak"]'::jsonb;
  select nombra_moto into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[]'::jsonb, 50, p_motos_conocidas => v_conocidas)
  where id = 'bc000000-0000-0000-0000-000000000019'::uuid;
  if r.nombra_moto is distinct from false then
    insert into _errores(msg) values ('Caso 37: la palabra 251 de p_motos_conocidas se leyó: el tope de 200 no se aplica.');
  end if;

  -- La palabra 200 SÍ entra.
  select jsonb_agg('zz' || g) into v_conocidas from generate_series(1, 199) g;
  v_conocidas := v_conocidas || '["kavak"]'::jsonb;
  select nombra_moto into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[]'::jsonb, 50, p_motos_conocidas => v_conocidas)
  where id = 'bc000000-0000-0000-0000-000000000019'::uuid;
  if r.nombra_moto is distinct from true then
    insert into _errores(msg) values ('Caso 37: la palabra 200 de p_motos_conocidas no se leyó.');
  end if;

  -- Entradas basura: no lanzan ni calzan.
  select nombra_moto into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[]'::jsonb, 50, p_motos_conocidas => '[null, 7, "", "  ", {"a":1}, ["kavak"]]'::jsonb)
  where id = 'bc000000-0000-0000-0000-000000000019'::uuid;
  if r.nombra_moto is distinct from false then
    insert into _errores(msg) values ('Caso 37: una entrada basura de p_motos_conocidas calzó.');
  end if;
  select count(*) as n into r
  from public.buscar_productos('[["defensa"]]'::jsonb, '[]'::jsonb, 50, p_motos_conocidas => '"kavak"'::jsonb, p_variantes => '"azul"'::jsonb, p_moto_marca => '7'::jsonb);
  if r.n <> 7 then
    insert into _errores(msg) values (format('Caso 37: con parámetros que no son arreglo la función devolvió %s fila(s), se esperaban 7 (las defensas, sin error).', r.n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 38 · La moto "calza" solo entre la FAMILIA del pedido (T5b, 30/9/2026):
-- las filas del máximo que EMPIEZAN con el producto, si alguna lo hace. Una
-- BOMBA DE ACEITE que nombra la SBR no es un aceite y no vuelve verdadera la
-- coincidencia de moto. Sin ninguna fila que empiece con el producto no se
-- restringe nada. Lo que NO cambia (hotfix del 29/9: nunca un agotado si hay
-- con existencia): las ventanas de existencia siguen contando todo el máximo.
--   a) «aceite» + moto sbr: ningún aceite nombra la SBR, así que
--      puntaje_moto_maximo = 0 aunque BOMBA DE ACEITE BERA SBR la nombre; la
--      familia no depende de la moto (filas_que_nombran_moto = 0) y la bomba no
--      sube en el orden por nombrar la moto.
--   b) «cadena» + moto sbr: CADENA SBR 428H empieza con el producto y nombra la
--      moto: la moto calza (1) y la fila que va primero es la CADENA; el tensor
--      (que también nombra la SBR) sigue siendo del conjunto, pero no cuenta
--      como "nombra moto" de la familia.
--   c) las ventanas de existencia cuentan todo el máximo, la bomba incluida.
--   d) [sbr][cadena]: ninguna fila empieza con «sbr», así que la familia es todo
--      el máximo y nada se restringe.
-- ---------------------------------------------------------------------------
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('bd000000-0000-0000-0000-000000000003', 'CADENA SBR 428H', null, 14.00, 'USD', 3, true),
  ('bd000000-0000-0000-0000-000000000004', 'CADENA UNIVERSAL 428H', null, 12.00, 'USD', 2, true);

do $$
declare
  r record;
  v_max bigint;
  v_max_stock bigint;
  v_orden text;
begin
  -- Todas las filas activas que calzan «aceite» (los aceites y la bomba).
  select count(*), count(*) filter (where stock_quantity > 0) into v_max, v_max_stock
  from public.products
  where is_active and price > 0 and name ~* '\maceite';

  -- a) «aceite» + moto sbr.
  select puntaje_moto_maximo, filas_con_maximo_y_moto, filas_con_puntaje_maximo, filas_que_nombran_moto,
         filas_con_maximo_y_stock into r
  from public.buscar_productos('[["aceite"]]'::jsonb, '[["sbr"]]'::jsonb, 1,
       p_motos_conocidas => '["sbr","bera","kavak","soc"]'::jsonb, p_marcas_de_moto => '["bera"]'::jsonb);
  if r.puntaje_moto_maximo is distinct from 0 then
    insert into _errores(msg) values (format('Caso 38a: «aceite» + moto sbr: puntaje_moto_maximo = %s, se esperaba 0 -- la moto calzó con BOMBA DE ACEITE BERA SBR, una fila que no empieza con el producto.', r.puntaje_moto_maximo));
  end if;
  if r.filas_que_nombran_moto is distinct from 0 then
    insert into _errores(msg) values (format('Caso 38a: filas_que_nombran_moto = %s, se esperaba 0 -- la bomba nombra la SBR pero no es de la familia del pedido (con eso Seba creería que "el aceite depende de la moto").', r.filas_que_nombran_moto));
  end if;
  if r.filas_con_puntaje_maximo is distinct from v_max or r.filas_con_maximo_y_moto is distinct from v_max then
    insert into _errores(msg) values (format('Caso 38a: filas_con_puntaje_maximo=%s y filas_con_maximo_y_moto=%s, se esperaba %s en las dos (con la moto que no calza, el conjunto es todo el máximo).', r.filas_con_puntaje_maximo, r.filas_con_maximo_y_moto, v_max));
  end if;

  select string_agg(name, ' | ' order by rn) into v_orden
  from (select name, row_number() over () as rn
        from public.buscar_productos('[["aceite"]]'::jsonb, '[["sbr"]]'::jsonb, 3,
             p_motos_conocidas => '["sbr","bera","kavak","soc"]'::jsonb, p_marcas_de_moto => '["bera"]'::jsonb)) t;
  if v_orden like '%BOMBA%' then
    insert into _errores(msg) values (format('Caso 38a: la BOMBA DE ACEITE ocupa un lugar entre las tres primeras filas (%s); con la moto que no calza, una fila de otro producto no sube por nombrarla.', v_orden));
  end if;

  -- b) «cadena» + moto sbr.
  select puntaje_moto_maximo, filas_con_maximo_y_moto, filas_que_nombran_moto into r
  from public.buscar_productos('[["cadena"]]'::jsonb, '[["sbr"]]'::jsonb, 1,
       p_motos_conocidas => '["sbr","bera","kavak","klr","en125"]'::jsonb, p_marcas_de_moto => '["bera"]'::jsonb);
  if r.puntaje_moto_maximo is distinct from 1 or r.filas_con_maximo_y_moto is distinct from 2 or r.filas_que_nombran_moto is distinct from 1 then
    insert into _errores(msg) values (format('Caso 38b: «cadena» + moto sbr: puntaje_moto_maximo=%s (1), filas_con_maximo_y_moto=%s (2: CADENA SBR y el tensor), filas_que_nombran_moto=%s (1: solo la familia, sin el tensor).', r.puntaje_moto_maximo, r.filas_con_maximo_y_moto, r.filas_que_nombran_moto));
  end if;
  select name into v_orden
  from public.buscar_productos('[["cadena"]]'::jsonb, '[["sbr"]]'::jsonb, 1,
       p_motos_conocidas => '["sbr","bera","kavak","klr","en125"]'::jsonb, p_marcas_de_moto => '["bera"]'::jsonb);
  if v_orden is distinct from 'CADENA SBR 428H' then
    insert into _errores(msg) values (format('Caso 38b: la primera fila fue %s, se esperaba CADENA SBR 428H.', v_orden));
  end if;

  -- c) las ventanas de existencia cuentan todo el máximo (la bomba, con su
  --    stock, incluida): el hotfix "nunca un agotado si hay con existencia".
  select filas_con_maximo_y_stock into r
  from public.buscar_productos('[["aceite"]]'::jsonb, '[["sbr"]]'::jsonb, 1,
       p_motos_conocidas => '["sbr","bera","kavak","soc"]'::jsonb, p_marcas_de_moto => '["bera"]'::jsonb);
  if r.filas_con_maximo_y_stock is distinct from v_max_stock then
    insert into _errores(msg) values (format('Caso 38c: filas_con_maximo_y_stock = %s, se esperaba %s (todo el máximo con existencia, la bomba incluida): las ventanas de existencia no se restringen a la familia.', r.filas_con_maximo_y_stock, v_max_stock));
  end if;

  -- d) [sbr][cadena]: ninguna fila empieza con «sbr»: nada se restringe y las
  --    dos filas nombran una moto.
  select puntaje_moto_maximo, filas_que_nombran_moto into r
  from public.buscar_productos('[["sbr"],["cadena"]]'::jsonb, '[["sbr"]]'::jsonb, 1,
       p_motos_conocidas => '["sbr","bera","kavak","klr","en125"]'::jsonb, p_marcas_de_moto => '["bera"]'::jsonb);
  if r.puntaje_moto_maximo is distinct from 1 or r.filas_que_nombran_moto is distinct from 2 then
    insert into _errores(msg) values (format('Caso 38d: [sbr][cadena]: puntaje_moto_maximo=%s (1) y filas_que_nombran_moto=%s (2); sin ninguna fila que empiece con el producto la familia es todo el máximo.', r.puntaje_moto_maximo, r.filas_que_nombran_moto));
  end if;
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
    raise exception E'buscar_productos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'buscar_productos.sql: todas las aserciones pasaron.'
