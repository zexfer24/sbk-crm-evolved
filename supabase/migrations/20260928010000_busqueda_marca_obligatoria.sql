-- ============================================================================
-- La búsqueda del catálogo: opcionales, marca obligatoria, números completos
-- (T1, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
-- esperando", 28/9/2026).
--
-- El estudio del VPS sobre 1.027 turnos (25/9 → 28/9/2026) dio 457 turnos
-- fallidos en 280 conversaciones; la búsqueda del catálogo era la primera de
-- las cuatro causas. Lo que falló, con casos reales:
--
--   1. La tolerancia N-1 (`requerido = grupos - 1` con 4 o más grupos, en
--      `tools.ts`) descartaba la MARCA: "defensa gxs 250" y "defensa ava
--      mustang 250" traían DEFENSA BRZ 250 porque calzaban "defensa" y
--      "250", y se cotizaba una defensa de otra moto. (El N-1 lo retira T3a;
--      esta migración le da lo que hace falta para no necesitarlo.)
--   2. Una palabra DESCRIPTIVA que no está en el nombre ("semi", "sintético",
--      "integral", "gris", "delantero") tumbaba la búsqueda entera si era
--      obligatoria: "aceite 20w50 semi sintetico inca" no encontraba ACEITE
--      INCA 20W50 4T porque el nombre no dice "semi sintetico". Por eso la
--      función recibe `p_opcionales`: grupos que solo DESEMPATAN, nunca
--      excluyen (un grupo opcional no suma al `puntaje`).
--   3. Los números calzaban por prefijo: `\m50` calzaba "5000" ("aceite
--      iphone 20/50" traía el MOTUL 5000) y "dt200" calzaba "DT2000". Toda
--      alternativa que TERMINA en dígito lleva ahora `\M` al final.
--   4. "11.7" no calzaba el Givi "H11.7": el modelo trae una letra pegada al
--      número. Una alternativa que EMPIEZA en dígito y trae punto acepta un
--      prefijo de letras, `(\m|[a-z])11\.7\M` (un dígito delante NO cuenta:
--      "211.7" no es H11.7).
--   5. "RIN TRASERO BERA" quedaba detrás de "EJE RIN TRASERO BERA" (empatan
--      en puntaje y el nombre los ordenaba al revés): `empieza_con_producto`
--      premia al que EMPIEZA con el producto pedido.
--   6. "Genérico" (más de tres filas en el máximo) no miraba el stock: siete
--      botas sin una sola unidad se preguntaban como si hubiera de dónde
--      elegir. `filas_con_maximo_y_stock` cuenta, sobre TODO el conjunto y
--      antes del límite, cuántas filas del máximo (y de la moto con nombre,
--      si calza) tienen existencia.
--
-- Firma nueva (la vieja se retira con `drop function` en esta misma
-- migración: con las dos, PostgREST vería dos sobrecargas y una llamada con
-- nombres de parámetros sería ambigua; la llamada de `tools.ts` con tres
-- argumentos sigue resolviendo a esta por los defaults):
--
--   buscar_productos(p_terminos jsonb, p_moto jsonb default '[]',
--                    p_limite int default 10, p_opcionales jsonb default '[]',
--                    p_cilindrada jsonb default '[]')
--
-- Los cinco jsonb son arreglos de arreglos (grupos de alternativas), con el
-- mismo tratamiento de escapado, topes (12 grupos, 4 alternativas) y
-- alternativas vacías de siempre (ver 20260926010000, que sigue siendo la
-- referencia del escapado doble regex/LIKE).
--
-- MOTO CON NOMBRE VS CILINDRADA (corrección del operador): `p_moto` lleva
-- marcas y modelos con nombre (bera, sbr, gxs…); `p_cilindrada` lleva los
-- "250"/"200cc" sueltos. Ninguna de las dos excluye una fila, las dos solo
-- ORDENAN, pero solo la moto con NOMBRE puede volver verdadera la
-- coincidencia de moto: `puntaje_moto_maximo` y `filas_con_maximo_y_moto` se
-- calculan SOLO con `puntaje_moto_nombre`. Una cilindrada que calza ("250" en
-- "DEFENSA BRZ 250") nunca hace que `tools.ts` crea que la moto del cliente
-- (gxs) calzó y restrinja/cotice esa fila. `puntaje_moto` (columna que ya
-- existía) queda como la SUMA de las dos, solo informativa para el orden
-- compuesto; ningún llamador debe decidir por ella.
--
-- Orden: puntaje desc, puntaje_moto_nombre desc, empieza_con_producto desc,
-- puntaje_moto_cilindrada desc, puntaje_opcional desc, con stock desc, name.
-- El límite va DESPUÉS, como siempre. Los conteos (`puntaje_maximo`,
-- `filas_con_puntaje_maximo`, `puntaje_moto_maximo`, `filas_con_maximo_y_moto`
-- y `filas_con_maximo_y_stock`) son funciones ventana sobre TODO el conjunto
-- de candidatos relevantes, antes del límite.
--
-- `empieza_con_producto`: el `search_text` (nombre y marca, sin acentos)
-- empieza con alguna alternativa del PRIMER grupo obligatorio (índice 0 de
-- `p_terminos`; con el mismo `\M` final si la alternativa acaba en dígito).
--
-- El prefiltro `ilike` sigue usando SOLO las alternativas obligatorias (el
-- índice trigram `products_search_text_trgm` sirve para ellas; los opcionales
-- y la moto nunca acotan el conjunto).
--
-- SECURITY INVOKER, igual que la versión anterior (la llama `service_role`,
-- que ya salta RLS). Los dos revokes por firma + grant a service_role.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA TRANSACCIÓN (`psql -1 -v
-- ON_ERROR_STOP=1`, o la CLI de Supabase, que ya envuelve cada archivo):
-- `set local lock_timeout` fuera de una transacción es un no-op silencioso
-- (ver CLAUDE.md, trampa de las cinco migraciones de Seba). El `drop
-- function` toma un lock breve sobre la función; el tope de 5 s evita
-- encolar detrás de una llamada en vuelo mientras el webhook espera.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (mismo bloque que
-- 20260916010000/20260918010000): sin transacción falla cerrado.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

drop function if exists public.buscar_productos(jsonb, jsonb, int);

create function public.buscar_productos(
  p_terminos jsonb,
  p_moto jsonb default '[]'::jsonb,
  p_limite int default 10,
  p_opcionales jsonb default '[]'::jsonb,
  p_cilindrada jsonb default '[]'::jsonb
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
  filas_con_maximo_y_moto bigint,
  puntaje_opcional int,
  empieza_con_producto boolean,
  puntaje_moto_nombre int,
  puntaje_moto_cilindrada int,
  filas_con_maximo_y_stock bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with
  -- Los cuatro conjuntos de grupos (producto, opcionales, moto con nombre,
  -- cilindrada) en una sola lista con su `tipo`: como mucho 12 grupos por
  -- conjunto, y si el llamador manda algo que no es un arreglo el `case`
  -- de abajo lo trata como sin alternativas en vez de lanzar.
  grupos as (
    select 'prod'::text as tipo, (ord - 1) as grupo_idx, elem as grupo
    from jsonb_array_elements(coalesce(p_terminos, '[]'::jsonb)) with ordinality as t(elem, ord)
    where ord <= 12
    union all
    select 'opc', (ord - 1), elem
    from jsonb_array_elements(coalesce(p_opcionales, '[]'::jsonb)) with ordinality as t(elem, ord)
    where ord <= 12
    union all
    select 'moto', (ord - 1), elem
    from jsonb_array_elements(coalesce(p_moto, '[]'::jsonb)) with ordinality as t(elem, ord)
    where ord <= 12
    union all
    select 'cil', (ord - 1), elem
    from jsonb_array_elements(coalesce(p_cilindrada, '[]'::jsonb)) with ordinality as t(elem, ord)
    where ord <= 12
  ),
  alts_crudas as (
    select g.tipo, g.grupo_idx, lower(trim(both from (a.elem #>> '{}'))) as alt
    from grupos g
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(g.grupo) = 'array' then g.grupo else '[]'::jsonb end
    ) with ordinality as a(elem, ord)
    where a.ord <= 4
  ),
  alts_escapadas as (
    select
      tipo,
      grupo_idx,
      alt,
      -- Escapado regex: ver 20260926010000 (vía 1).
      regexp_replace(alt, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') as alt_core,
      -- Escapado LIKE: backslash primero, después % y _ (vía 2).
      replace(replace(replace(alt, '\', '\\'), '%', '\%'), '_', '\_') as alt_like
    from alts_crudas
    where alt <> ''
  ),
  -- Patrón final de cada alternativa:
  --   * prefijo: inicio de palabra (\m). Si la alternativa EMPIEZA en dígito
  --     y trae punto ("11.7"), acepta además una letra pegada ("h11.7");
  --   * sufijo: si TERMINA en dígito, fin de palabra (\M): "50" no calza
  --     "5000", "dt200" no calza "dt2000".
  -- `alt_start` es lo mismo pero anclado al principio del nombre
  -- (empieza_con_producto).
  alts as (
    select
      tipo,
      grupo_idx,
      alt_like,
      case when alt ~ '^[0-9].*\.' then '(\m|[a-z])' else '\m' end
        || alt_core
        || case when alt ~ '[0-9]$' then '\M' else '' end as alt_pat,
      '^' || alt_core || case when alt ~ '[0-9]$' then '\M' else '' end as alt_start
    from alts_escapadas
  ),

  -- Prefiltro: OR de las alternativas de PRODUCTO (nunca de opcionales,
  -- moto ni cilindrada), para que el índice trigram siga sirviendo. Sin
  -- ninguna alternativa (`p_terminos` vacío o nulo) `patrones` queda en '{}'
  -- y `ilike any('{}')` no calza nunca -> cero filas, sin error.
  patrones_prefiltro as (
    select coalesce(array_agg('%' || alt_like || '%'), '{}'::text[]) as patrones
    from alts
    where tipo = 'prod'
  ),

  candidatos as (
    select
      p.id, p.name, p.brand, p.price, p.currency, p.stock_quantity, p.updated_at, p.search_text
    from public.products p, patrones_prefiltro pf
    where p.is_active
      and p.price > 0
      and p.search_text ilike any (pf.patrones)
  ),

  -- Los cinco puntajes en UNA pasada por las alternativas de cada candidato.
  -- `count(distinct grupo_idx)`: un grupo con dos alternativas que calzan las
  -- dos ("dt200" y "dt 200" juntas) cuenta una sola vez. Solo `puntaje`
  -- decide qué filas son relevantes; los otros cuatro son de orden.
  candidatos_con_puntaje as (
    select
      c.*,
      s.puntaje,
      s.puntaje_opcional,
      s.puntaje_moto_nombre,
      s.puntaje_moto_cilindrada,
      s.empieza_con_producto
    from candidatos c
    cross join lateral (
      select
        (count(distinct a.grupo_idx) filter (where a.tipo = 'prod' and c.search_text ~ a.alt_pat))::int as puntaje,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'opc' and c.search_text ~ a.alt_pat))::int as puntaje_opcional,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'moto' and c.search_text ~ a.alt_pat))::int as puntaje_moto_nombre,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'cil' and c.search_text ~ a.alt_pat))::int as puntaje_moto_cilindrada,
        coalesce(bool_or(a.tipo = 'prod' and a.grupo_idx = 0 and c.search_text ~ a.alt_start), false) as empieza_con_producto
      from alts a
    ) s
  ),

  -- Puntaje 0 = ningún grupo calzó por palabra -- solo entró por el
  -- prefiltro de subcadena ("rin" contra "ORINGS", "dt200" contra
  -- "DT2000"). Se descarta ANTES de los máximos.
  candidatos_relevantes as (
    select * from candidatos_con_puntaje where puntaje > 0
  ),

  con_maximo as (
    select *, max(puntaje) over () as puntaje_maximo
    from candidatos_relevantes
  ),
  con_conteo_maximo as (
    select
      *,
      count(*) filter (where puntaje = puntaje_maximo) over () as filas_con_puntaje_maximo,
      -- SOLO la moto con nombre (ver la cabecera): la cilindrada nunca vuelve
      -- verdadera la coincidencia de moto.
      max(puntaje_moto_nombre) filter (where puntaje = puntaje_maximo) over () as puntaje_moto_maximo
    from con_maximo
  ),
  con_conteo_moto as (
    select
      *,
      count(*) filter (
        where puntaje = puntaje_maximo and puntaje_moto_nombre = puntaje_moto_maximo
      ) over () as filas_con_maximo_y_moto,
      -- Las del máximo con existencia; si la moto con nombre calza
      -- (puntaje_moto_maximo > 0) solo las de esa moto. Con moto que no calza
      -- (o sin moto) puntaje_moto_maximo = 0 y todas las del máximo tienen
      -- puntaje_moto_nombre = 0, así que la misma condición no restringe.
      count(*) filter (
        where puntaje = puntaje_maximo
          and puntaje_moto_nombre = puntaje_moto_maximo
          and coalesce(stock_quantity, 0) > 0
      ) over () as filas_con_maximo_y_stock
    from con_conteo_maximo
  )

  select
    f.id, f.name, f.brand, f.price, f.currency, f.stock_quantity, f.updated_at,
    -- product_compatibility tiene 0 filas hoy (ver CLAUDE.md); coalesce a
    -- '[]' para no devolver null cuando algún día tenga datos y un producto
    -- puntual no tenga ninguna fila igual.
    coalesce(compat.compatibilidad, '[]'::jsonb) as compatibilidad,
    f.puntaje,
    (f.puntaje_moto_nombre + f.puntaje_moto_cilindrada) as puntaje_moto,
    f.puntaje_maximo, f.filas_con_puntaje_maximo,
    f.puntaje_moto_maximo, f.filas_con_maximo_y_moto,
    f.puntaje_opcional, f.empieza_con_producto,
    f.puntaje_moto_nombre, f.puntaje_moto_cilindrada,
    f.filas_con_maximo_y_stock
  from con_conteo_moto f
  left join lateral (
    select jsonb_agg(jsonb_build_object('moto_brand', pc.moto_brand, 'moto_model', pc.moto_model)) as compatibilidad
    from public.product_compatibility pc
    where pc.product_id = f.id
  ) compat on true
  order by
    f.puntaje desc,
    f.puntaje_moto_nombre desc,
    f.empieza_con_producto desc,
    f.puntaje_moto_cilindrada desc,
    f.puntaje_opcional desc,
    (coalesce(f.stock_quantity, 0) > 0) desc,
    f.name
  limit least(greatest(coalesce(p_limite, 10), 1), 50)
$$;

comment on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb) is
  'Busca en el catálogo por grupos de alternativas (jsonb, arreglo de arreglos). p_terminos = obligatorios (definen el puntaje); p_opcionales = solo desempatan; p_moto = marca/modelo CON NOMBRE (ordena y es lo único que puede volver verdadera la coincidencia de moto); p_cilindrada = "250"/"200cc" sueltos (solo ordena). Alternativas que terminan en dígito llevan \M; las que empiezan en dígito y traen punto aceptan letras pegadas. Ordena y cuenta (puntaje_maximo, filas_con_puntaje_maximo, puntaje_moto_maximo, filas_con_maximo_y_moto, filas_con_maximo_y_stock) ANTES del límite. Plan "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", T1, 28/9/2026. Solo la llama service_role (security invoker).';

-- Los dos revokes de siempre, por firma (ver CLAUDE.md): el EXECUTE de
-- fábrica de Postgres a PUBLIC y el `alter default privileges` de Supabase a
-- anon/authenticated. Ninguno alcanza solo.
revoke execute on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb) from public;
revoke execute on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb) from anon, authenticated;

grant execute on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';
