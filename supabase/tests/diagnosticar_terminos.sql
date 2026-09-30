-- ============================================================================
-- diagnosticar_terminos: qué palabra tumba la búsqueda (T3, Entrega A2 "Seba
-- no cotiza lo que no es", 30/9/2026, decisión D3 del operador)
--
-- Migración bajo prueba: 20260930030000_terminos_relajables.sql.
--
-- El caso que la motivó (sección 2.6 de casos-del-vps, 29/9/2026):
-- "manguera de bomba de freno delantero" para una Bera Socialista. Antes de
-- A1 cotizaba; con la marca/palabra obligatoria quedó en 0 porque "bomba"
-- NO co-ocurre con "manguera" en ningún nombre (MANGUERA FRENO DELANTERO no
-- dice "bomba"), aunque "bomba" SÍ existe en el catálogo (BOMBA FRENO…) y
-- "freno" sí co-ocurre con "manguera". Una palabra que no existe en ningún
-- nombre ("pwk" en "carburador pwk 30mm cortina plana") también tumba la
-- búsqueda. La función responde, por cada grupo de alternativas, las dos
-- preguntas de D3: ¿existe en algún producto activo con precio? y ¿existe
-- junto a la CABEZA (el primer grupo que existe y no es un número suelto)?
-- Con eso el código decide qué grupos relajar.
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que corregir_terminos.sql). Todo
-- corre como `postgres` salvo el caso de `service_role`. Como el catálogo
-- local puede traer cientos de productos reales, el test desactiva TODO
-- producto preexistente al entrar (dentro de la transacción con rollback).
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

update public.products set is_active = false;

-- ---------------------------------------------------------------------------
-- Fixture. EL RUIDO VA PRIMERO. Los nombres son los de Saint citados en 2.6.
-- ---------------------------------------------------------------------------
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  -- Ruido: cosas que comparten palabras sueltas con los casos.
  ('d1000000-0000-0000-0000-000000000001', 'MANGUERA COMBUSTIBLE UNIVERSAL', null, 3.00, 'USD', 5, true),
  ('d1000000-0000-0000-0000-000000000002', 'BOMBA DE AGUA', null, 20.00, 'USD', 5, true),
  ('d1000000-0000-0000-0000-000000000003', 'BOMBA DE ACEITE', null, 20.00, 'USD', 5, true),
  ('d1000000-0000-0000-0000-000000000004', 'CAUCHO 90/5000 RARO', null, 30.00, 'USD', 5, true),
  -- Los correctos.
  ('d1000000-0000-0000-0000-000000000005', 'MANGUERA FRENO DELANTERO BERA L&J', null, 6.00, 'USD', 4, true),
  ('d1000000-0000-0000-0000-000000000006', 'BOMBA FRENO DELANTERO KAVAK', null, 25.00, 'USD', 4, true),
  ('d1000000-0000-0000-0000-000000000007', 'CARBURADOR CORTINA PLANA 30MM', null, 40.00, 'USD', 4, true),
  ('d1000000-0000-0000-0000-000000000008', 'PIÑON 14T/11T HJ COOL ALDRICH', null, 12.00, 'USD', 3, true),
  ('d1000000-0000-0000-0000-000000000009', 'FILTRO ACEITE MOTOR', null, 5.00, 'USD', 4, true),
  ('d1000000-0000-0000-0000-000000000010', 'CAUCHO 19 90/90 TS712 TIMSUN', null, 45.00, 'USD', 4, true);

-- Productos que NO cuentan: inactivo y con precio 0. "abrazadera" y
-- "carter" solo existen en ellos.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('d2000000-0000-0000-0000-000000000001', 'ABRAZADERA INACTIVA', null, 2.00, 'USD', 5, false),
  ('d2000000-0000-0000-0000-000000000002', 'CARTER SIN PRECIO', null, 0.00, 'USD', 5, true);

-- Helper de lectura: una fila por grupo, en un texto "idx:en:con" para
-- comparar de un golpe (t = true, f = false, n = null).
create function pg_temp.diag(p_terminos jsonb, p_cabeza int) returns text
language sql stable as $$
  select coalesce(string_agg(
    d.grupo_idx || ':' ||
    case d.en_catalogo when true then 't' when false then 'f' else 'n' end || ':' ||
    case d.con_cabeza when true then 't' when false then 'f' else 'n' end,
    ' ' order by d.grupo_idx), '')
  from public.diagnosticar_terminos(p_terminos, p_cabeza) d
$$;

-- ---------------------------------------------------------------------------
-- Caso 1: "carburador pwk 30mm cortina plana" -> pwk no existe en ningún
-- nombre. Cabeza = carburador (grupo 0).
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  v := pg_temp.diag('[["carburador"],["pwk"],["30mm"],["cortina"],["plana"]]'::jsonb, 0);
  if v is distinct from '0:t:t 1:f:f 2:t:t 3:t:t 4:t:t' then
    insert into _errores(msg) values (format('Caso 1: carburador/pwk devolvió "%s"; se esperaba "0:t:t 1:f:f 2:t:t 3:t:t 4:t:t" (pwk no está en ningún nombre).', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 (D3): "manguera de bomba de freno delantero". bomba existe pero no
-- junto a manguera; freno y delantero sí. Cabeza = manguera (grupo 0).
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  v := pg_temp.diag('[["manguera"],["bomba"],["freno"],["delantero"]]'::jsonb, 0);
  if v is distinct from '0:t:t 1:t:f 2:t:t 3:t:t' then
    insert into _errores(msg) values (format('Caso 2: manguera/bomba/freno devolvió "%s"; se esperaba "0:t:t 1:t:f 2:t:t 3:t:t" (bomba existe pero no con manguera).', v));
  end if;
  -- Con otra cabeza el veredicto cambia: con cabeza = bomba (grupo 1),
  -- manguera es el que no co-ocurre.
  v := pg_temp.diag('[["manguera"],["bomba"],["freno"],["delantero"]]'::jsonb, 1);
  if v is distinct from '0:t:f 1:t:t 2:t:t 3:t:t' then
    insert into _errores(msg) values (format('Caso 2b: con cabeza = bomba devolvió "%s"; se esperaba "0:t:f 1:t:t 2:t:t 3:t:t".', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3: cabeza nula o fuera de rango -> con_cabeza null; en_catalogo igual.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  v := pg_temp.diag('[["manguera"],["pwk"]]'::jsonb, null);
  if v is distinct from '0:t:n 1:f:n' then
    insert into _errores(msg) values (format('Caso 3: cabeza nula devolvió "%s"; se esperaba "0:t:n 1:f:n".', v));
  end if;
  v := pg_temp.diag('[["manguera"],["pwk"]]'::jsonb, 2);
  if v is distinct from '0:t:n 1:f:n' then
    insert into _errores(msg) values (format('Caso 3: cabeza 2 (fuera de rango, hay 2 grupos) devolvió "%s"; se esperaba "0:t:n 1:f:n".', v));
  end if;
  v := pg_temp.diag('[["manguera"],["pwk"]]'::jsonb, -1);
  if v is distinct from '0:t:n 1:f:n' then
    insert into _errores(msg) values (format('Caso 3: cabeza -1 devolvió "%s"; se esperaba "0:t:n 1:f:n".', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4: grupos con varias alternativas. Un grupo existe si CUALQUIERA de
-- sus alternativas calza; con la cabeza, si algún producto calza alguna
-- alternativa de cada uno de los dos grupos.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  -- Grupo 0 = ["engine","filtro"] (calza por "filtro": FILTRO ACEITE MOTOR).
  -- Grupo 1 = ["zzz","bomba"] (calza por "bomba", pero ningún producto de
  -- filtro/engine trae bomba).
  -- Grupo 2 = ["motor","zzz"] (FILTRO ACEITE MOTOR: sí con la cabeza).
  -- Grupo 3 = ["zzz","yyy"] (ninguna).
  v := pg_temp.diag('[["engine","filtro"],["zzz","bomba"],["motor","zzz"],["zzz","yyy"]]'::jsonb, 0);
  if v is distinct from '0:t:t 1:t:f 2:t:t 3:f:f' then
    insert into _errores(msg) values (format('Caso 4: alternativas múltiples devolvió "%s"; se esperaba "0:t:t 1:t:f 2:t:t 3:f:f".', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5: números. "11" calza 11T (PIÑON 14T/11T) pero "1" NO calza 11T, y
-- "50" no calza 5000 (patron_busqueda: un número que termina la alternativa
-- lleva ([^0-9]|$)). "14" calza 14T.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  v := pg_temp.diag('[["pinon"],["11"],["14"],["1"],["50"],["5000"]]'::jsonb, 0);
  if v is distinct from '0:t:t 1:t:t 2:t:t 3:f:f 4:f:f 5:t:f' then
    insert into _errores(msg) values (format('Caso 5: números devolvió "%s"; se esperaba "0:t:t 1:t:t 2:t:t 3:f:f 4:f:f 5:t:f" (11 y 14 calzan el piñón; 1 no calza 11T; 50 no calza 5000; 5000 existe pero no junto al piñón).', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6: inactivos y precio 0 no cuentan.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  v := pg_temp.diag('[["manguera"],["abrazadera"],["carter"]]'::jsonb, 0);
  if v is distinct from '0:t:t 1:f:f 2:f:f' then
    insert into _errores(msg) values (format('Caso 6: producto inactivo / con precio 0 devolvió "%s"; se esperaba "0:t:t 1:f:f 2:f:f".', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7: topes (12 grupos, 4 alternativas) y entradas raras.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
  n integer;
begin
  -- 13 grupos: solo se devuelven 12 (índices 0..11); el grupo 12 se ignora.
  select count(*) into n from public.diagnosticar_terminos(
    '[["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"],["manguera"]]'::jsonb, 0);
  if n <> 12 then
    insert into _errores(msg) values (format('Caso 7: 13 grupos devolvieron %s filas; se esperaban 12.', n));
  end if;

  -- 5 alternativas: la quinta se ignora (solo ella calzaría).
  v := pg_temp.diag('[["zzz","yyy","xxx","www","manguera"]]'::jsonb, 0);
  if v is distinct from '0:f:f' then
    insert into _errores(msg) values (format('Caso 7: la quinta alternativa se tuvo en cuenta ("%s"); el tope es 4.', v));
  end if;
  v := pg_temp.diag('[["zzz","yyy","xxx","manguera"]]'::jsonb, 0);
  if v is distinct from '0:t:t' then
    insert into _errores(msg) values (format('Caso 7: la cuarta alternativa no se tuvo en cuenta ("%s").', v));
  end if;

  -- Arreglo vacío, nulo y no-arreglo: cero filas, sin error.
  select count(*) into n from public.diagnosticar_terminos('[]'::jsonb, 0);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 7: el arreglo vacío devolvió filas.');
  end if;
  select count(*) into n from public.diagnosticar_terminos(null, null);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 7: el jsonb nulo devolvió filas.');
  end if;
  select count(*) into n from public.diagnosticar_terminos('{"a": 1}'::jsonb, 0);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 7: un jsonb que no es arreglo devolvió filas.');
  end if;

  -- Un grupo que no es arreglo, o vacío: una fila con false (no lanza).
  v := pg_temp.diag('["manguera", [], ["manguera"]]'::jsonb, 2);
  if v is distinct from '0:f:f 1:f:f 2:t:t' then
    insert into _errores(msg) values (format('Caso 7: grupos que no son arreglo / vacíos devolvieron "%s"; se esperaba "0:f:f 1:f:f 2:t:t".', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 8: los comodines de LIKE y los metacaracteres de regex se toman
-- LITERALES (mismo escapado que buscar_productos): "%", "_", ".", "(" no
-- calzan "todo".
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  v := pg_temp.diag('[["%"],["_"],["."],["("],["[a-z]+"]]'::jsonb, null);
  if v is distinct from '0:f:n 1:f:n 2:f:n 3:f:n 4:f:n' then
    insert into _errores(msg) values (format('Caso 8: metacaracteres devolvieron "%s"; se esperaba que ninguno calzara.', v));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 9: permisos y forma: solo service_role; security invoker; stable.
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig regprocedure := 'public.diagnosticar_terminos(jsonb, integer)'::regprocedure;
  v_seg_definer boolean;
  v_volatilidad "char";
  v_filas integer;
begin
  if has_function_privilege('anon', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: anon puede ejecutar diagnosticar_terminos.');
  end if;
  if has_function_privilege('authenticated', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: authenticated puede ejecutar diagnosticar_terminos.');
  end if;
  if not has_function_privilege('service_role', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: service_role NO puede ejecutar diagnosticar_terminos.');
  end if;

  select prosecdef, provolatile into v_seg_definer, v_volatilidad from pg_proc where oid = v_sig;
  if v_seg_definer then
    insert into _errores(msg) values ('Caso 9: diagnosticar_terminos es security definer; debe ser security invoker (la llama service_role, que ya salta RLS).');
  end if;
  if v_volatilidad <> 's' then
    insert into _errores(msg) values (format('Caso 9: diagnosticar_terminos tiene volatilidad %s; debe ser stable.', v_volatilidad));
  end if;

  -- Como service_role (la llamada real): lee products y resuelve
  -- patron_busqueda con el search_path fijo.
  set local role service_role;
  select count(*) into v_filas from public.diagnosticar_terminos('[["manguera"],["bomba"]]'::jsonb, 0);
  reset role;
  if v_filas <> 2 then
    insert into _errores(msg) values (format('Caso 9: como service_role devolvió %s fila(s); se esperaban 2.', v_filas));
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
    raise exception E'diagnosticar_terminos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'diagnosticar_terminos.sql: todas las aserciones pasaron.'
