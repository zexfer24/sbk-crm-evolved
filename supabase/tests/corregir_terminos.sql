-- ============================================================================
-- corregir_terminos: el segundo intento tolerante a tipeos (T2, plan "Seba
-- encuentra, no insiste, y el mostrador no deja a nadie esperando",
-- 28/9/2026)
--
-- Migración bajo prueba: 20260928020000_corrector_de_terminos.sql.
--
-- Los casos buenos salen de los tipeos reales del estudio del VPS (1.027
-- turnos, 25/9 → 28/9/2026): "horsen" por HORSE, "tisum"/"stinsun" por
-- TIMSUN, "express" por XPRESS, "iphone" por IPONE, "motopower" por
-- MOTORPOWER, "swhera" por SWITCHERA, "ciguañal" por CIGUEÑAL. Los malos son
-- los que NO pueden corregirse: "beta" (una moto conocida, protegida) no
-- pasa a "bera" aunque bera exista; números; una palabra que ya está en el
-- vocabulario; términos de tres letras.
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que buscar_productos.sql). Todo
-- corre como `postgres` salvo el caso de `service_role`, que baja de rol con
-- `set local role` para probar el grant de verdad.
--
-- Como el vocabulario sale de TODOS los productos activos con precio > 0, la
-- base local (cientos de productos de un ensayo previo) contaminaría los
-- casos: el test desactiva todo producto preexistente al entrar, dentro de la
-- transacción que hace `rollback`, igual que buscar_productos.sql.
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

update public.products set is_active = false;

-- ---------------------------------------------------------------------------
-- Fixture: nombres reales del catálogo. "beta" NO aparece en ningún nombre
-- (si estuviera, dejaría de necesitar corrección y el caso no probaría nada).
-- ---------------------------------------------------------------------------
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c1000000-0000-0000-0000-000000000001', 'ASIENTO HORSE TX', null, 40.00, 'USD', 2, true),
  ('c1000000-0000-0000-0000-000000000002', 'CAUCHO TIMSUN 90/90-18', 'TIMSUN', 30.00, 'USD', 2, true),
  ('c1000000-0000-0000-0000-000000000003', 'PALANCA XPRESS', null, 8.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000004', 'ACEITE IPONE 20W50', null, 9.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000005', 'GUAYA MOTORPOWER', null, 3.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000006', 'SWITCHERA CLAXON', null, 6.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000007', 'CIGUEÑAL BERA SBR', null, 90.00, 'USD', 1, true),
  ('c1000000-0000-0000-0000-000000000008', 'RIN BERA KAVAK', null, 25.00, 'USD', 3, true);

-- Desempate por frecuencia: "cesco" está a distancia 1 de casco y de cosco
-- con la MISMA similitud de trigramas; casco aparece en 3 productos y cosco
-- en 1, así que gana casco.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c2000000-0000-0000-0000-000000000001', 'CASCO ABATIBLE', null, 90.00, 'USD', 1, true),
  ('c2000000-0000-0000-0000-000000000002', 'CASCO INTEGRAL', null, 80.00, 'USD', 1, true),
  ('c2000000-0000-0000-0000-000000000003', 'CASCO ABIERTO', null, 70.00, 'USD', 1, true),
  ('c2000000-0000-0000-0000-000000000004', 'COSCO ESPECIAL', null, 10.00, 'USD', 1, true);

-- Desempate por similitud ANTES que por frecuencia: "bujis" está a distancia
-- 1 de bujia y de bujes; bujia se parece más (4 de 8 trigramas contra 3 de
-- 9) aunque bujes aparezca en 3 productos y bujia en 1.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c3000000-0000-0000-0000-000000000001', 'BUJIA NGK', null, 4.00, 'USD', 1, true),
  ('c3000000-0000-0000-0000-000000000002', 'BUJES SWING ARM', null, 4.00, 'USD', 1, true),
  ('c3000000-0000-0000-0000-000000000003', 'BUJES SUSPENSION', null, 4.00, 'USD', 1, true),
  ('c3000000-0000-0000-0000-000000000004', 'BUJES PIÑON', null, 4.00, 'USD', 1, true);

-- Fuera del vocabulario: un producto INACTIVO y uno con precio 0. "filtra"
-- y "pistones" solo existen en ellos, así que NO son palabras válidas y se
-- corrigen hacia FILTRO / PISTON (activos, con precio).
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c4000000-0000-0000-0000-000000000001', 'FILTRO ACEITE', null, 5.00, 'USD', 1, true),
  ('c4000000-0000-0000-0000-000000000002', 'FILTRA VIEJO', null, 5.00, 'USD', 1, false),
  ('c4000000-0000-0000-0000-000000000003', 'PISTON STD', null, 20.00, 'USD', 1, true),
  ('c4000000-0000-0000-0000-000000000004', 'PISTONES SIN PRECIO', null, 0.00, 'USD', 1, true);

-- ---------------------------------------------------------------------------
-- Casos que DEBEN corregirse
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
  v_corregido text;
begin
  for caso in
    select * from (values
      ('horsen', 'horse'),
      ('HORSEN', 'horse'),
      ('tisum', 'timsun'),
      ('stinsun', 'timsun'),
      ('express', 'xpress'),
      ('iphone', 'ipone'),
      ('motopower', 'motorpower'),
      ('swhera', 'switchera'),
      ('ciguañal', 'ciguenal'),
      ('ciguanal', 'ciguenal'),
      ('Ciguañal', 'ciguenal'),
      ('cesco', 'casco'),
      ('bujis', 'bujia'),
      ('filtra', 'filtro'),
      ('pistones', 'piston')
    ) as t(entrada, esperado)
  loop
    select c.corregido into v_corregido
    from public.corregir_terminos(array[caso.entrada], '{}'::text[]) c;
    if v_corregido is distinct from caso.esperado then
      insert into _errores(msg) values (format('Caso 1: "%s" se corrigió a %s; se esperaba "%s".', caso.entrada, coalesce('"' || v_corregido || '"', 'nada'), caso.esperado));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Casos que NO pueden corregirse
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
  n integer;
begin
  -- "beta" está a distancia 1 de "bera" (que sí existe); protegida NO cambia.
  select count(*) into n from public.corregir_terminos(array['beta'], array['beta', 'bera']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 2: "beta" protegida se corrigió (una moto conocida jamás pasa a otra).');
  end if;

  -- Sin la protección, en cambio, beta SÍ es un tipeo de bera: prueba que el
  -- caso anterior falla por la exclusión y no porque beta no se pueda corregir.
  select count(*) into n from public.corregir_terminos(array['beta'], '{}'::text[]);
  if n <> 1 then
    insert into _errores(msg) values ('Caso 2b: "beta" sin proteger debía corregirse a "bera" (el caso 2 no probaría nada si esto no pasa).');
  end if;

  -- La protección se compara normalizada (acentos, mayúsculas).
  select count(*) into n from public.corregir_terminos(array['BÉTA'], array['beta']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 2c: la lista de protegidos debe compararse sin acentos ni mayúsculas.');
  end if;

  -- Números y términos con dígitos: nunca.
  for caso in select unnest(array['250', 'dt2000', '20w50', '90/90-18', 'xpres2']) as t loop
    select count(*) into n from public.corregir_terminos(array[caso.t], '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 3: el término con dígitos "%s" se corrigió.', caso.t));
    end if;
  end loop;

  -- Una palabra que YA está en el vocabulario no se toca, aunque otra
  -- parecida exista ("bera" está a distancia 1 de "beta"/"rin"...).
  for caso in select unnest(array['horse', 'bera', 'casco', 'bujes', 'BERA']) as t loop
    select count(*) into n from public.corregir_terminos(array[caso.t], '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 4: la palabra "%s", que ya está en el vocabulario, se corrigió.', caso.t));
    end if;
  end loop;

  -- Tres letras o menos: nunca ("ber" está a distancia 1 de "bera").
  for caso in select unnest(array['ber', 'rim', 'xy']) as t loop
    select count(*) into n from public.corregir_terminos(array[caso.t], '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 5: el término corto "%s" se corrigió.', caso.t));
    end if;
  end loop;

  -- Una palabra sin parecido con nada del vocabulario queda como está.
  select count(*) into n from public.corregir_terminos(array['zzzzzzzz', 'quimera'], '{}'::text[]);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 6: una palabra sin parecido con el vocabulario se corrigió a algo.');
  end if;

  -- Arreglo vacío y nulo: cero filas, sin error.
  select count(*) into n from public.corregir_terminos('{}'::text[], '{}'::text[]);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 7: el arreglo vacío devolvió filas.');
  end if;
  select count(*) into n from public.corregir_terminos(null, null);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 7: el arreglo nulo devolvió filas.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Varios términos a la vez: solo vuelven los corregidos, con `original` tal
-- como se pasó (el llamador lo usa para nombrar "busqué X en lugar de Y").
-- ---------------------------------------------------------------------------
do $$
declare
  v_filas integer;
  v_original text;
  v_corregido text;
begin
  select count(*), min(original), min(corregido) into v_filas, v_original, v_corregido
  from public.corregir_terminos(array['aceite', 'iphone', '20w50', 'bera', 'beta'], array['beta']);
  if v_filas <> 1 or v_original is distinct from 'iphone' or v_corregido is distinct from 'ipone' then
    insert into _errores(msg) values (format('Caso 8: mezcla de términos devolvió %s fila(s) (%s → %s); se esperaba solo iphone → ipone.', v_filas, v_original, v_corregido));
  end if;

  -- El mismo término repetido no duplica filas.
  select count(*) into v_filas from public.corregir_terminos(array['iphone', 'iphone'], '{}'::text[]);
  if v_filas <> 1 then
    insert into _errores(msg) values (format('Caso 8: un término repetido devolvió %s filas; se esperaba 1.', v_filas));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Permisos y forma: la llama solo service_role; security invoker; stable.
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig regprocedure := 'public.corregir_terminos(text[], text[])'::regprocedure;
  v_seg_definer boolean;
  v_volatilidad "char";
  v_ns_trgm regnamespace;
  v_ns_fuzzy regnamespace;
  v_filas integer;
begin
  if has_function_privilege('anon', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: anon puede ejecutar corregir_terminos.');
  end if;
  if has_function_privilege('authenticated', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: authenticated puede ejecutar corregir_terminos.');
  end if;
  if not has_function_privilege('service_role', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: service_role NO puede ejecutar corregir_terminos.');
  end if;

  select prosecdef, provolatile into v_seg_definer, v_volatilidad from pg_proc where oid = v_sig;
  if v_seg_definer then
    insert into _errores(msg) values ('Caso 10: corregir_terminos es security definer; debe ser security invoker (la llama service_role, que ya salta RLS).');
  end if;
  if v_volatilidad <> 's' then
    insert into _errores(msg) values (format('Caso 10: corregir_terminos tiene volatilidad %s; debe ser stable.', v_volatilidad));
  end if;

  -- fuzzystrmatch en el MISMO schema que pg_trgm (el search_path fijo de la
  -- función enumera schemas conocidos; si divergen, una de las dos
  -- funciones no se resuelve en producción).
  select extnamespace::regnamespace into v_ns_trgm from pg_extension where extname = 'pg_trgm';
  select extnamespace::regnamespace into v_ns_fuzzy from pg_extension where extname = 'fuzzystrmatch';
  if v_ns_fuzzy is null then
    insert into _errores(msg) values ('Caso 11: fuzzystrmatch no está instalada.');
  elsif v_ns_fuzzy is distinct from v_ns_trgm then
    insert into _errores(msg) values (format('Caso 11: fuzzystrmatch vive en %s y pg_trgm en %s; deben ser el mismo schema.', v_ns_fuzzy, v_ns_trgm));
  end if;

  -- Ejecutada COMO service_role (la llamada real): necesita leer products y
  -- resolver levenshtein/similarity con el search_path fijo.
  set local role service_role;
  select count(*) into v_filas from public.corregir_terminos(array['horsen'], '{}'::text[]);
  reset role;
  if v_filas <> 1 then
    insert into _errores(msg) values (format('Caso 12: como service_role, "horsen" devolvió %s fila(s); se esperaba 1.', v_filas));
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
    raise exception E'corregir_terminos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'corregir_terminos.sql: todas las aserciones pasaron.'
