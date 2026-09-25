-- ============================================================================
-- La búsqueda del catálogo ordena y cuenta en la base antes de recortar
-- (T1, plan "La búsqueda encuentra lo que el cliente pide", 25-26/9/2026).
--
-- `buscar_repuesto` está apagada desde el 25/8. Al simularla en el VPS
-- contra el catálogo real (6.035 productos que llegan de Saint, §2.1 del
-- plan), la búsqueda falló en casi la mitad de los casos, y las causas
-- estaban del lado de TypeScript, no de la base:
--   - `tools.ts` cortaba con `.limit(31)` SIN `order`, y recién después
--     `rankByTerms` ordenaba esas 31 en memoria -- si el producto correcto
--     no entraba entre los primeros 31 que trajo Postgres (sin ningún
--     criterio), nunca aparecía, sin importar cuán bien calzara.
--   - Usaba subcadenas: "rin" traía ORINGS (contiene "rin" en el medio).
--   - No entendía plurales ("pastillas" no calzaba con "pastilla") ni
--     números cortos ("45", "DT 200" quedaban descartados por tener menos
--     de tres letras).
--   - Filtraba por `product_compatibility`, que hoy tiene CERO filas: la
--     moto nunca podía ordenar ni pesar nada.
--
-- Esta función mueve el orden, el puntaje y los conteos que arman esas
-- decisiones a SQL, para que se calculen sobre TODO el conjunto de
-- candidatos ANTES de recortar -- nunca al revés. Los términos llegan como
-- GRUPOS de alternativas (jsonb, arreglo de arreglos): un grupo calza si
-- calza CUALQUIERA de sus alternativas (ver `catalog-search.ts`,
-- `catalogTermGroups` -- necesario para sinónimos y para que "dt200"/
-- "dt 200" cuenten como el mismo término, no como dos).
--
-- SECURITY INVOKER, no DEFINER (desvío 3 del plan): la única que llama a
-- esta función es `service_role` (`runAgentTurn` crea `createAdminClient()`
-- y se lo pasa a `buildCatalogTool`; ningún camino con sesión de asesor
-- llega acá) -- ese rol ya se salta RLS por su cuenta, así que un `security
-- definer` no cortaría ningún costo real y sí agregaría una función más a
-- la lista de `permisos-funciones.test.ts` sin necesidad (la trampa de
-- `search_conversations_by_message`, que SÍ necesitaba `definer` porque la
-- llama `authenticated` a través de RLS por fila).
--
-- Escapado (NUNCA SQL dinámico): cada alternativa se escapa dos veces, para
-- dos usos distintos --
--   1. Como REGEX, para el puntaje por inicio de palabra:
--      `regexp_replace(alt, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')`.
--      Verificado a mano contra esta base (25/9/2026): con
--      `standard_conforming_strings` en `on` (el default), un backslash
--      dentro de un literal `'...'` NO se interpreta como escape de la
--      cadena SQL -- así que UN backslash en el texto fuente ya es UN
--      backslash en el valor, y `'\\\1'` como REEMPLAZO es literalmente
--      backslash + backslash + "1", que el motor de regex sí interpreta
--      como "backreference 1 con un backslash literal delante" -- exacto lo
--      que hace falta para anteponer `\` a cada metacarácter capturado.
--      Probado con `'a.b*c(d)[e]{f}|g\h-i'` -> `'a\.b\*c\(d\)\[e\]\{f\}\|g
--      \\h\-i'`, y con `\m` de por medio: "rin" calza "rin delantero" y
--      "rin.", pero NO "orings" (sin límite de palabra en el medio) ni
--      cualquier cosa cuando la alternativa es literalmente "." o "%".
--   2. Como patrón LIKE (para el prefiltro): `\` primero, después `%` y
--      `_` -- si se escapara `%`/`_` antes que `\`, el backslash agregado
--      para escapar el `%` quedaría él mismo escapado de más al llegar el
--      turno del `\`. El escape por defecto de LIKE/ILIKE en Postgres ES
--      el backslash, así que no hace falta `escape` explícito.
--
-- Prefiltro (`is_active and price > 0 and search_text ilike any(...)` con
-- TODAS las alternativas de TODOS los grupos de PRODUCTO, nunca de moto):
-- existe para que el índice trigram `products_search_text_trgm`
-- (`20260822100000`) siga sirviendo -- un `~` con `\m` directo contra toda
-- la tabla no lo usa. Trae de más a propósito (por diseño, un ILIKE de
-- subcadena) y el puntaje de abajo es quien de verdad decide qué calza.
--
-- Puntaje: cuántos GRUPOS de producto tienen alguna alternativa con
-- `search_text ~ ('\m' || alternativa_escapada)` (inicio de palabra -- así
-- "pastilla" calza el plural "pastillas" del catálogo, y "rin" no calza en
-- medio de "orings"). Una fila con puntaje 0 -- entró al candidato solo por
-- el prefiltro de subcadena, no por ningún calce real de palabra -- se
-- descarta ANTES de calcular los máximos: si no, "rin" traería ORINGS con
-- puntaje 0 al final de la lista, y el ruido del prefiltro ensuciaría
-- puntaje_maximo/filas_con_puntaje_maximo. `puntaje_moto` es el mismo
-- cálculo sobre los grupos de moto -- SIEMPRE un bono de orden, nunca un
-- requisito (moto vacía o sin calce -> puntaje_moto = 0 para todos, nunca
-- excluye a nadie).
--
-- Conteos ANTES del límite -- el bug de origen (`tools.ts:333-335`, medido
-- en el VPS el 25/9/2026 contra 6.035 productos): `puntaje_maximo`,
-- `filas_con_puntaje_maximo`, `puntaje_moto_maximo` (el máximo de
-- puntaje_moto SOLO entre las filas con puntaje = puntaje_maximo) y
-- `filas_con_maximo_y_moto` se calculan con funciones ventana sobre TODO el
-- conjunto de candidatos relevantes (puntaje > 0), antes de que la
-- sentencia final aplique el `limit` -- por eso `p_limite = 1` no cambia
-- ninguno de estos cuatro números (caso 12 del test SQL).
--
-- Orden: `puntaje desc, puntaje_moto desc, (stock_quantity > 0) desc,
-- name`. El límite (`least(greatest(coalesce(p_limite,10),1),50)`) va
-- DESPUÉS del `order by` en la sentencia final -- nunca antes.
--
-- Topes defensivos: como mucho 12 grupos y 4 alternativas por grupo (se
-- recorta con `where ord <= 12`/`where ord <= 4`, nunca se lanza error);
-- alternativas vacías se ignoran (`where alt <> ''`); `p_terminos` vacío o
-- nulo da cero filas sin error (el prefiltro con un arreglo vacío de
-- patrones no calza nada).
--
-- Sin `lock_timeout`: esta migración solo CREA una función nueva, no toca
-- ninguna fila ni bloquea `products` (a diferencia de las migraciones que
-- alteran esa tabla, ver 20260925010000).
-- ============================================================================

create function public.buscar_productos(
  p_terminos jsonb,
  p_moto jsonb default '[]'::jsonb,
  p_limite int default 10
)
returns table (
  id uuid,
  name text,
  brand text,
  price numeric(12, 2),
  currency text,
  stock_quantity integer,
  updated_at timestamptz,
  compatibilidad jsonb,
  puntaje int,
  puntaje_moto int,
  puntaje_maximo int,
  filas_con_puntaje_maximo bigint,
  puntaje_moto_maximo int,
  filas_con_maximo_y_moto bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with
  -- Grupos de PRODUCTO: como mucho 12, ya en minúsculas y sin espacios de
  -- sobra. `elem` queda como jsonb (un arreglo de alternativas, o
  -- cualquier otra cosa si el llamador manda algo raro -- el `case` de
  -- abajo lo trata como sin alternativas en vez de lanzar).
  grupos_prod as (
    select (ord - 1) as grupo_idx, elem as grupo
    from jsonb_array_elements(coalesce(p_terminos, '[]'::jsonb)) with ordinality as t(elem, ord)
    where ord <= 12
  ),
  alts_prod_crudas as (
    select g.grupo_idx, lower(trim(both from (a.elem #>> '{}'))) as alt
    from grupos_prod g
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(g.grupo) = 'array' then g.grupo else '[]'::jsonb end
    ) with ordinality as a(elem, ord)
    where a.ord <= 4
  ),
  alts_prod as (
    select
      grupo_idx,
      -- Escapado regex: ver el comentario de cabecera (vía 1).
      regexp_replace(alt, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') as alt_regex,
      -- Escapado LIKE: backslash primero, después % y _ (vía 2).
      replace(replace(replace(alt, '\', '\\'), '%', '\%'), '_', '\_') as alt_like
    from alts_prod_crudas
    where alt <> ''
  ),

  -- Grupos de MOTO: mismo tratamiento que los de producto. NUNCA entran al
  -- prefiltro (ver más abajo) ni pueden excluir una fila -- son un bono de
  -- orden, no un requisito.
  grupos_moto as (
    select (ord - 1) as grupo_idx, elem as grupo
    from jsonb_array_elements(coalesce(p_moto, '[]'::jsonb)) with ordinality as t(elem, ord)
    where ord <= 12
  ),
  alts_moto_crudas as (
    select g.grupo_idx, lower(trim(both from (a.elem #>> '{}'))) as alt
    from grupos_moto g
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(g.grupo) = 'array' then g.grupo else '[]'::jsonb end
    ) with ordinality as a(elem, ord)
    where a.ord <= 4
  ),
  alts_moto as (
    select grupo_idx, regexp_replace(alt, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') as alt_regex
    from alts_moto_crudas
    where alt <> ''
  ),

  -- Prefiltro: OR de TODAS las alternativas de PRODUCTO (nunca de moto),
  -- para que el índice trigram siga sirviendo. Si no queda ninguna
  -- alternativa (p_terminos vacío/nulo, o solo alternativas vacías),
  -- `patrones` queda en '{}' y `ilike any('{}')` no calza nunca -> cero
  -- filas, sin error.
  patrones_prefiltro as (
    select coalesce(array_agg('%' || alt_like || '%'), '{}'::text[]) as patrones
    from alts_prod
  ),

  candidatos as (
    select
      p.id, p.name, p.brand, p.price, p.currency, p.stock_quantity, p.updated_at, p.search_text
    from public.products p, patrones_prefiltro pf
    where p.is_active
      and p.price > 0
      and p.search_text ilike any (pf.patrones)
  ),

  -- Puntaje: cuántos grupos de producto/moto tienen alguna alternativa que
  -- calce por inicio de palabra ('\m'). `count(distinct grupo_idx)` para
  -- que un grupo con dos alternativas que calzan las dos (p. ej. "dt200" Y
  -- "dt 200" aparecen juntas en el nombre) cuente una sola vez. Subconsulta
  -- correlacionada: corre solo sobre el conjunto YA prefiltrado por
  -- trigram, nunca sobre `products` entera.
  candidatos_con_puntaje as (
    select
      c.*,
      (
        select count(distinct a.grupo_idx)
        from alts_prod a
        where c.search_text ~ ('\m' || a.alt_regex)
      ) as puntaje,
      (
        select count(distinct a.grupo_idx)
        from alts_moto a
        where c.search_text ~ ('\m' || a.alt_regex)
      ) as puntaje_moto
    from candidatos c
  ),

  -- Puntaje 0 = ningún grupo calzó por inicio de palabra -- el producto
  -- solo entró al candidato por el prefiltro de subcadena (p. ej. "rin"
  -- contra "ORINGS"). Se descarta ACÁ, antes de calcular los máximos, para
  -- que el ruido del prefiltro no ensucie puntaje_maximo/
  -- filas_con_puntaje_maximo ni se le devuelva nunca al que llama una fila
  -- que no calzó ni un término.
  candidatos_relevantes as (
    select * from candidatos_con_puntaje where puntaje > 0
  ),

  -- Conteos ANTES del límite -- el bug de origen (ver cabecera): se
  -- calculan con funciones ventana sobre TODO candidatos_relevantes, antes
  -- de que la sentencia final aplique ningún `limit`.
  con_maximo as (
    select *, max(puntaje) over () as puntaje_maximo
    from candidatos_relevantes
  ),
  con_conteo_maximo as (
    select
      *,
      count(*) filter (where puntaje = puntaje_maximo) over () as filas_con_puntaje_maximo,
      -- Restringido a las filas con puntaje = puntaje_maximo: la moto es un
      -- bono SOLO entre los candidatos que ya calzaron mejor el repuesto.
      max(puntaje_moto) filter (where puntaje = puntaje_maximo) over () as puntaje_moto_maximo
    from con_maximo
  ),
  con_conteo_moto as (
    select
      *,
      count(*) filter (
        where puntaje = puntaje_maximo and puntaje_moto = puntaje_moto_maximo
      ) over () as filas_con_maximo_y_moto
    from con_conteo_maximo
  )

  select
    f.id, f.name, f.brand, f.price, f.currency, f.stock_quantity, f.updated_at,
    -- product_compatibility tiene 0 filas hoy (ver CLAUDE.md); coalesce a
    -- '[]' para no devolver null cuando algún día tenga datos y un producto
    -- puntual no tenga ninguna fila igual.
    coalesce(compat.compatibilidad, '[]'::jsonb) as compatibilidad,
    f.puntaje, f.puntaje_moto,
    f.puntaje_maximo, f.filas_con_puntaje_maximo,
    f.puntaje_moto_maximo, f.filas_con_maximo_y_moto
  from con_conteo_moto f
  left join lateral (
    select jsonb_agg(jsonb_build_object('moto_brand', pc.moto_brand, 'moto_model', pc.moto_model)) as compatibilidad
    from public.product_compatibility pc
    where pc.product_id = f.id
  ) compat on true
  order by f.puntaje desc, f.puntaje_moto desc, (f.stock_quantity > 0) desc, f.name
  limit least(greatest(coalesce(p_limite, 10), 1), 50)
$$;

comment on function public.buscar_productos(jsonb, jsonb, int) is
  'Busca en el catálogo por grupos de alternativas (jsonb, arreglo de arreglos): un grupo calza si calza cualquiera de sus alternativas. Ordena y cuenta (puntaje_maximo, filas_con_puntaje_maximo, puntaje_moto_maximo, filas_con_maximo_y_moto) ANTES de aplicar el límite -- T1, plan "La búsqueda encuentra lo que el cliente pide", 25-26/9/2026. Solo la llama service_role (agent.ts, buildCatalogTool), que ya se salta RLS -- por eso es security invoker, no definer.';

-- Los dos revokes de siempre (ver CLAUDE.md, "los dos revokes"): el EXECUTE
-- de fábrica que Postgres le da a PUBLIC en toda función nueva, y el
-- `alter default privileges` de Supabase que además se lo da a
-- anon/authenticated explícito. Ninguno de los dos alcanza solo.
revoke execute on function public.buscar_productos(jsonb, jsonb, int) from public;
revoke execute on function public.buscar_productos(jsonb, jsonb, int) from anon, authenticated;

-- Solo service_role: es quien de verdad la llama (ver cabecera).
grant execute on function public.buscar_productos(jsonb, jsonb, int) to service_role;

notify pgrst, 'reload schema';
