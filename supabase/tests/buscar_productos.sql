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
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

update public.products set is_active = false where id::text like 'eeeeeeee-%';

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
-- Caso 11 · [aceite][motul][5100] + moto [[kavak]], sin ningún aceite Kavak
-- -> puntaje_moto_maximo = 0 (la moto es un bono que acá nunca se gana, y
-- no le quita el resultado a nadie).
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_moto_max int;
begin
  select id, puntaje_moto_maximo into v_id, v_moto_max
  from public.buscar_productos('[["aceite"],["motul"],["5100"]]'::jsonb, '[["kavak"]]'::jsonb, 10)
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
-- (la llama service_role desde el servidor); service_role sí.
-- ---------------------------------------------------------------------------
do $$
declare
  errores text := '';
begin
  if has_function_privilege('anon', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') then
    errores := errores || E'\n  - anon puede ejecutar buscar_productos() y no debería.';
  end if;
  if has_function_privilege('authenticated', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') then
    errores := errores || E'\n  - authenticated puede ejecutar buscar_productos() y no debería -- ningún camino con sesión de asesor llama al catálogo, solo service_role.';
  end if;
  if not has_function_privilege('service_role', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') then
    errores := errores || E'\n  - service_role NO puede ejecutar buscar_productos() y sí debería -- es quien la llama desde agent.ts.';
  end if;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 13 (permisos):%s', errores));
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
