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
-- firma es la de CINCO parámetros y la de tres YA NO EXISTE (un `drop
-- function` en la migración) -- si sobreviviera, PostgREST vería dos
-- sobrecargas y una llamada con nombres de parámetros sería ambigua.
-- ---------------------------------------------------------------------------
do $$
declare
  errores text := '';
begin
  if to_regprocedure('public.buscar_productos(jsonb, jsonb, int)') is not null then
    errores := errores || E'\n  - la firma vieja buscar_productos(jsonb, jsonb, int) sigue existiendo: la migración tenía que retirarla.';
  end if;
  if to_regprocedure('public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb)') is null then
    errores := errores || E'\n  - no existe la firma nueva buscar_productos(jsonb, jsonb, int, jsonb, jsonb).';
  else
    if has_function_privilege('anon', 'public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb)', 'execute') then
      errores := errores || E'\n  - anon puede ejecutar buscar_productos() y no debería.';
    end if;
    if has_function_privilege('authenticated', 'public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb)', 'execute') then
      errores := errores || E'\n  - authenticated puede ejecutar buscar_productos() y no debería -- ningún camino con sesión de asesor llama al catálogo, solo service_role.';
    end if;
    if not has_function_privilege('service_role', 'public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb)', 'execute') then
      errores := errores || E'\n  - service_role NO puede ejecutar buscar_productos() y sí debería -- es quien la llama desde agent.ts.';
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
