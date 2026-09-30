-- ============================================================================
-- La búsqueda del catálogo: la moto calza por PALABRA, los números con su
-- sufijo, las variantes como conjunto aparte, "otra moto" y "universal", y el
-- desempate por existencia (T2, Entrega A2 "Seba no cotiza lo que no es",
-- 30/9/2026, migración M1 del plan).
--
-- Contexto: la Entrega A (6c8ce24, en producción desde el 29/9/2026) dejó a
-- Seba cotizando cosas que no eran. El mismo 29/9 a las 13:14 VE, un cliente
-- con una SBR 2025 pidió una lista (caucho n° 18, caucho trasero, rodamiento,
-- asiento, aceite) y solo el asiento salió bien. Las causas que viven en SQL:
--
--   1. La moto calzaba por PEDAZO de palabra. `\m` + "gr" calza "GRIS":
--      "maletas" para una GR 250 cotizaba solo MALETA REDONDA 34 LTS TOMCAT
--      GRIS, cuando había 15 maletas con stock. Ahora la moto lleva `\m` al
--      principio y `([0-9]|\M)` al final: "gr" calza GR250 y "GR 250", nunca
--      GRIS.
--   2. Un número no calzaba con su sufijo de letras. "corona de 45" no
--      encontraba CORONA 45T ni la maleta 45LTS, porque el límite de palabra
--      de 20260928010000 (`\M` al final de todo lo que acaba en dígito)
--      cortaba también "45T". Ahora el sufijo es `([^0-9]|$)`: 45 calza 45T y
--      45LTS y sigue sin calzar 5000; dt200 sigue sin calzar DT2000.
--   3. Una palabra corta calzaba por prefijo con cualquier cosa: "tipo de
--      cros" -> "cro" calzaba LUZ CRUCE CROMADO. Un término alfabético de 3
--      letras o menos calza ahora como palabra ENTERA con plural
--      (`(s|es)?\M`): "cro" no calza CROMADO, "rin" calza RINES.
--   4. Cuando la moto del cliente no calzaba con ningún nombre, `tools.ts`
--      cotizaba las tres primeras por ORDEN ALFABÉTICO: BRZ, KAVAK, KLR. La
--      función no traía con qué saber si un producto nombra OTRA moto.
--      Ahora devuelve `nombra_moto`, `nombra_otra_moto` y `es_universal` por
--      fila, y las ventanas para decidir sin mirar solo lo que cupo en el
--      límite. Y el último desempate del orden deja de ser el nombre: manda
--      la existencia (decisión del operador: nunca se elige por orden
--      alfabético antes que por existencia).
--   5. Los colores, el mate/brillante, "edge", "paleta", las tallas... (las
--      VARIANTES) solo ordenaban mezcladas con los opcionales y las tapaban
--      el tope, el stock o la pregunta de filtro: "tanque azul" para una SBR
--      cotizaba EK XPRESS azul (otra moto) y SBR rojos, sin decir que los
--      azules SBR estaban agotados. Ahora `p_variantes` es un conjunto aparte
--      con su puntaje, su lugar en el orden y sus ventanas (TODAS las
--      variantes a la vez).
--
-- HELPER `public.patron_busqueda(alt, tipo)`: ÚNICA fuente de los patrones
-- regex de la búsqueda (M3, `diagnosticar_terminos`, la va a usar también:
-- dos copias del patrón divergen, y un diagnóstico que calza distinto que la
-- búsqueda mentiría). Recibe la alternativa YA normalizada (minúsculas, sin
-- acentos: eso lo hace `catalog-search.ts`) y hace el escapado regex ella
-- misma (el mismo de 20260926010000, vía 1). Es IMMUTABLE. Reglas por tipo:
--
--   prod | opc | var   prefijo `\m`; si la alternativa es solo letras y
--                      tiene 3 o menos -> sufijo `(s|es)?\M`; si termina en
--                      dígito -> sufijo `([^0-9]|$)`; si EMPIEZA en dígito y
--                      trae punto ("11.7") -> prefijo `(\m|[a-z])` (H11.7).
--   moto | moto_marca  `\m` alt `([0-9]|\M)`.
--   cil | anio         `(\m|[a-z])` alt `([^0-9]|$)` (GR250 calza "250",
--                      un año calza "2014").
--   inicio             (interno) lo mismo que `prod` pero anclado al
--                      principio del nombre (`^`): `empieza_con_producto`.
--
-- Un tipo desconocido LANZA: uno mal escrito volvería la búsqueda ciega sin
-- avisar. Permisos: es un helper puro sin datos, pero `buscar_productos` es
-- SECURITY INVOKER y corre con el rol de quien la llama (`service_role`), así
-- que ese rol necesita EXECUTE sobre el helper: los dos revokes de siempre
-- (PUBLIC y anon/authenticated) y el grant a service_role. Nada más lo
-- necesita hoy; si M6 (Control IA, `authenticated`) llegara a llamarlo,
-- tendría que pedir el grant en su propia migración.
--
-- Firma nueva de `buscar_productos` (la de cinco parámetros se retira con
-- `drop function` en esta misma migración: con las dos, PostgREST vería dos
-- sobrecargas y una llamada con nombres de parámetros sería ambigua; la
-- llamada vieja de tres a cinco argumentos sigue resolviendo a esta por los
-- defaults, así que el código que todavía no conoce las columnas nuevas sigue
-- funcionando, y por eso esta migración es compatible hacia atrás):
--
--   buscar_productos(p_terminos jsonb, p_moto jsonb default '[]',
--                    p_limite int default 10, p_opcionales jsonb default '[]',
--                    p_cilindrada jsonb default '[]',
--                    p_variantes jsonb default '[]',
--                    p_moto_marca jsonb default '[]',
--                    p_motos_conocidas jsonb default '[]',
--                    p_marcas_de_moto jsonb default '[]')
--
-- Los primeros dos, p_opcionales, p_cilindrada, p_variantes y p_moto_marca son
-- arreglos de arreglos (grupos de alternativas), con los topes y el escapado
-- de siempre (12 grupos, 4 alternativas). `p_cilindrada` lleva también el AÑO
-- ("2014"): solo ordena. `p_motos_conocidas` es distinto: un arreglo PLANO de
-- strings (las palabras de MOTOS_CONOCIDAS, hasta ~100) que solo sirve para
-- saber si un nombre nombra alguna moto; tope de 200, lo que no es un string
-- no vacío se ignora y algo que no es un arreglo cuenta como sin motos. Sin
-- p_motos_conocidas, nada "nombra moto" y todo es universal: el llamador
-- SIEMPRE tiene que pasarla si quiere D1. `p_marcas_de_moto` (el último
-- parámetro) es otro arreglo PLANO de strings, tope
-- 50: las palabras de moto que son MARCA (bera, ek, empire, md, hj, jaguar,
-- yamaha, honda...; el llamador las pasa y jaguar se trata como marca). Sirve
-- solo para distinguir, dentro de p_motos_conocidas, marca de MODELO.
--
-- Se conservan todas las columnas de 20260928010000 con el mismo significado.
-- La moto con nombre (`p_moto`) sigue siendo lo único que vuelve verdadera la
-- coincidencia de moto: `puntaje_moto_maximo` y `filas_con_maximo_y_moto` se
-- calculan SOLO con `puntaje_moto_nombre`. La marca de moto (`p_moto_marca`:
-- bera, ek, empire... cuando el cliente dio también el modelo) y la
-- cilindrada/año solo ORDENAN. Columnas nuevas al final:
--
--   puntaje_variante, puntaje_moto_marca   grupos que calzan de cada conjunto.
--   nombra_moto        el nombre calza alguna palabra de p_motos_conocidas.
--   nombra_otra_moto   nombra_moto Y no calza ningún grupo de p_moto Y NO (calza
--                      algún grupo de p_moto_marca Y el nombre no nombra ningún
--                      MODELO, o sea ninguna palabra de p_motos_conocidas que no
--                      esté en p_marcas_de_moto). Sin moto
--                      del cliente, es igual a nombra_moto. «ASIENTO SBR /SOC
--                      ORIGINAL» nombra dos motos y con moto sbr da false.
--   es_universal       no nombra ninguna moto, o dice "universal".
--   filas_que_nombran_moto, filas_universales, filas_universales_con_stock,
--   filas_con_variante, filas_con_variante_y_stock
--                      ventanas sobre las filas del máximo (y, si la moto con
--                      nombre calza, solo sobre las de esa moto: el mismo
--                      conjunto que ya usaba `filas_con_maximo_y_stock`),
--                      calculadas ANTES del límite. Las de variante exigen
--                      TODAS las variantes (puntaje_variante = cantidad de
--                      grupos de p_variantes); sin variantes valen 0.
--
-- LA MARCA SOLA NO RESCATA, PERO LA MARCA SIN MODELO SÍ (decisión del
-- coordinador, 30/9/2026, sobre el desvío que reportó T2): `nombra_otra_moto`
-- no puede mirar solo `p_moto`, ni tampoco dejar que cualquier calce de marca
-- lo apague. Dos casos reales del plan (§2.1) piden cosas opuestas:
--   * «tapas laterales blanca» para una Bera Milan cotizaba TAPA LATERAL BERA
--     SBR porque "bera" calzaba: el producto nombra el MODELO sbr, que no es
--     milan -> tiene que seguir siendo "otra moto".
--   * lista «batería» para una Bera Socialista tiene que poder cotizar
--     BATERIA SECA JAGUAR/BERA 12N6.5 (116 u.): el nombre solo nombra MARCAS
--     (jaguar, bera), ningún modelo -> con un cliente de marca bera no es
--     "otra moto".
-- Regla: nombra_otra_moto = nombra alguna moto conocida Y no calza ningún
-- grupo de p_moto Y NO (calza algún grupo de p_moto_marca Y no nombra ningún
-- modelo). "Modelo" = palabra de p_motos_conocidas que NO está en
-- p_marcas_de_moto. Sin p_marcas_de_moto todas las palabras cuentan como
-- modelo y el comportamiento es el anterior (la marca sola no rescata).
--
-- LA MOTO SOLO "CALZA" ENTRE LA FAMILIA DEL PEDIDO (T5b, 30/9/2026, hallazgo
-- del reporte de T5): la moto "calzaba" con UNA sola fila del máximo, aunque
-- fuera de OTRO producto. Con «aceite» para una SBR, BOMBA DE ACEITE BERA SBR
-- puntúa «aceite» igual que un aceite y nombra la SBR: `puntaje_moto_maximo`
-- daba 1, la moto "calzaba", y Seba cotizaba una bomba en vez de un aceite.
-- Ahora la FAMILIA del pedido son las filas del máximo que EMPIEZAN con la
-- cabeza del pedido (`empieza_con_producto`) si alguna lo hace; si ninguna
-- empieza con el producto, la familia es todo el máximo, como antes. Las que
-- solo mencionan la palabra en medio del nombre (la bomba de aceite, el eje
-- del rin, el tensor de la cadena) son de otro producto y no deciden si la
-- moto calza. Decisión (30/9/2026), qué lee la familia y qué no:
--   * `puntaje_moto_maximo` (¿la moto calza?): SOLO la familia. Es el arreglo.
--   * `filas_que_nombran_moto` (¿la familia depende de la moto?, dispara D1):
--     SOLO la familia. Si contara la bomba, «aceite» para una SBR creería que
--     "el aceite depende de la moto" y saldría por D1 en vez de por la regla
--     sin moto.
--   * NO cambian las ventanas de existencia, de universales, de variante ni
--     `filas_con_puntaje_maximo`/`filas_con_maximo_y_moto`: cuentan el
--     conjunto de candidatos tal cual (todo el máximo y, si la moto calza,
--     las de esa moto), porque `tools.ts` elige entre esas mismas filas y la
--     regla del operador del hotfix del 29/9/2026 es "nunca un agotado si hay
--     con existencia": restringirlas a la familia dejaría fuera un
--     `ZAPATO BOTA IMPERMEABLE` con existencia cuando las `BOTA …` están en 0.
--     (Una primera versión de T5b las restringía todas; se descartó por eso.)
--   * Con la moto que NO calza (`puntaje_moto_maximo = 0`) las ventanas ya no
--     exigen `puntaje_moto_nombre = 0`: una fila de otro producto que nombra
--     la moto sigue siendo del conjunto (la moto no filtra), pero no sube en
--     el orden por nombrarla (ver "Orden").
--
-- Orden: puntaje, moto con nombre (solo si la moto calza), variante, empieza
-- con el producto, marca de moto, cilindrada/año, opcional, con existencia,
-- existencia (mayor primero), nombre e id. El límite va DESPUÉS, como siempre.
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
-- 20260928010000): sin transacción falla cerrado.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helper: única fuente de los patrones de la búsqueda.
-- ---------------------------------------------------------------------------
create function public.patron_busqueda(alt text, tipo text)
returns text
language plpgsql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
declare
  v_core text;
  v_prefijo text;
  v_sufijo text;
begin
  -- Escapado regex (ver 20260926010000, vía 1): cada metacarácter de ARE
  -- queda literal.
  v_core := regexp_replace(alt, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g');

  if tipo in ('prod', 'opc', 'var', 'inicio') then
    v_prefijo := case
      when tipo = 'inicio' then '^'
      when alt ~ '^[0-9].*\.' then '(\m|[a-z])'
      else '\m'
    end;
    v_sufijo := case
      when alt ~ '^[a-z]{1,3}$' then '(s|es)?\M'
      when alt ~ '[0-9]$' then '([^0-9]|$)'
      else ''
    end;
    return v_prefijo || v_core || v_sufijo;
  elsif tipo in ('moto', 'moto_marca') then
    return '\m' || v_core || '([0-9]|\M)';
  elsif tipo in ('cil', 'anio') then
    return '(\m|[a-z])' || v_core || '([^0-9]|$)';
  end if;

  raise exception 'patron_busqueda: tipo desconocido %', tipo;
end
$$;

comment on function public.patron_busqueda(text, text) is
  'Única fuente de los patrones regex de la búsqueda del catálogo (buscar_productos y, en M3, diagnosticar_terminos). Recibe la alternativa ya normalizada (minúsculas sin acentos), escapa los metacaracteres y arma el patrón según el tipo: prod/opc/var (palabra; ≤3 letras -> palabra entera con plural; termina en dígito -> ([^0-9]|$); empieza en dígito con punto -> acepta una letra antes), moto/moto_marca (palabra seguida de dígito o fin de palabra), cil/anio, e inicio (interno, anclado al principio). Tipo desconocido lanza. IMMUTABLE. Entrega A2, T2, 30/9/2026.';

revoke execute on function public.patron_busqueda(text, text) from public;
revoke execute on function public.patron_busqueda(text, text) from anon, authenticated;

grant execute on function public.patron_busqueda(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- buscar_productos: firma de ocho parámetros.
-- ---------------------------------------------------------------------------
drop function if exists public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb);

create function public.buscar_productos(
  p_terminos jsonb,
  p_moto jsonb default '[]'::jsonb,
  p_limite int default 10,
  p_opcionales jsonb default '[]'::jsonb,
  p_cilindrada jsonb default '[]'::jsonb,
  p_variantes jsonb default '[]'::jsonb,
  p_moto_marca jsonb default '[]'::jsonb,
  p_motos_conocidas jsonb default '[]'::jsonb,
  p_marcas_de_moto jsonb default '[]'::jsonb
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
  filas_con_maximo_y_stock bigint,
  puntaje_variante int,
  puntaje_moto_marca int,
  nombra_moto boolean,
  nombra_otra_moto boolean,
  es_universal boolean,
  filas_que_nombran_moto bigint,
  filas_universales bigint,
  filas_universales_con_stock bigint,
  filas_con_variante bigint,
  filas_con_variante_y_stock bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with
  -- Los seis conjuntos de grupos (producto, opcionales, moto con nombre,
  -- cilindrada/año, variantes, marca de moto) en una sola lista con su
  -- `tipo`: como mucho 12 grupos por conjunto, y si el llamador manda algo
  -- que no es un arreglo el `case` de abajo lo trata como sin alternativas
  -- en vez de lanzar.
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
    union all
    select 'var', (ord - 1), elem
    from jsonb_array_elements(
      case when jsonb_typeof(p_variantes) = 'array' then p_variantes else '[]'::jsonb end
    ) with ordinality as t(elem, ord)
    where ord <= 12
    union all
    select 'moto_marca', (ord - 1), elem
    from jsonb_array_elements(
      case when jsonb_typeof(p_moto_marca) = 'array' then p_moto_marca else '[]'::jsonb end
    ) with ordinality as t(elem, ord)
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
  -- Patrón final de cada alternativa: SIEMPRE vía `patron_busqueda` (única
  -- fuente). `alt_start` es el mismo patrón anclado al principio del nombre
  -- (empieza_con_producto). `alt_like` es el escapado del prefiltro `ilike`:
  -- backslash primero, después % y _ (vía 2 de 20260926010000).
  alts as (
    select
      tipo,
      grupo_idx,
      replace(replace(replace(alt, '\', '\\'), '%', '\%'), '_', '\_') as alt_like,
      public.patron_busqueda(alt, tipo) as alt_pat,
      case when tipo = 'prod' then public.patron_busqueda(alt, 'inicio') end as alt_start
    from alts_crudas
    where alt <> ''
  ),

  -- Cuántos grupos de variante hay (con al menos una alternativa): las
  -- ventanas de variante exigen TODOS.
  n_variantes as (
    select count(distinct grupo_idx)::int as n from alts where tipo = 'var'
  ),

  -- Palabras de p_marcas_de_moto (arreglo PLANO de strings, tope 50): las
  -- palabras de moto que son MARCA.
  marcas_pat as (
    select lower(trim(both from (e.elem #>> '{}'))) as palabra
    from jsonb_array_elements(
      case when jsonb_typeof(p_marcas_de_moto) = 'array' then p_marcas_de_moto else '[]'::jsonb end
    ) with ordinality as e(elem, ord)
    where e.ord <= 50
      and jsonb_typeof(e.elem) = 'string'
      and trim(both from (e.elem #>> '{}')) <> ''
  ),

  -- Palabras de MOTOS_CONOCIDAS como patrones 'moto', marcadas con `es_marca`
  -- si además están en p_marcas_de_moto. Arreglo PLANO de strings, tope 200;
  -- lo que no es un string no vacío se ignora.
  motos_pat as (
    select
      public.patron_busqueda(w.palabra, 'moto') as pat,
      exists (select 1 from marcas_pat mk where mk.palabra = w.palabra) as es_marca
    from (
      select lower(trim(both from (e.elem #>> '{}'))) as palabra
      from jsonb_array_elements(
        case when jsonb_typeof(p_motos_conocidas) = 'array' then p_motos_conocidas else '[]'::jsonb end
      ) with ordinality as e(elem, ord)
      where e.ord <= 200
        and jsonb_typeof(e.elem) = 'string'
        and trim(both from (e.elem #>> '{}')) <> ''
    ) w
  ),

  -- Prefiltro: OR de las alternativas de PRODUCTO (nunca de opcionales,
  -- moto, cilindrada, variantes ni marca), para que el índice trigram siga
  -- sirviendo. Sin ninguna alternativa (`p_terminos` vacío o nulo)
  -- `patrones` queda en '{}' y `ilike any('{}')` no calza nunca -> cero
  -- filas, sin error.
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

  -- Los siete puntajes en UNA pasada por las alternativas de cada candidato.
  -- `count(distinct grupo_idx)`: un grupo con dos alternativas que calzan las
  -- dos ("dt200" y "dt 200" juntas) cuenta una sola vez. Solo `puntaje`
  -- decide qué filas son relevantes; los otros son de orden o de ventana.
  candidatos_con_puntaje as (
    select
      c.*,
      s.puntaje,
      s.puntaje_opcional,
      s.puntaje_moto_nombre,
      s.puntaje_moto_cilindrada,
      s.puntaje_variante,
      s.puntaje_moto_marca,
      s.empieza_con_producto,
      nv.n as n_var
    from candidatos c
    cross join n_variantes nv
    cross join lateral (
      select
        (count(distinct a.grupo_idx) filter (where a.tipo = 'prod' and c.search_text ~ a.alt_pat))::int as puntaje,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'opc' and c.search_text ~ a.alt_pat))::int as puntaje_opcional,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'moto' and c.search_text ~ a.alt_pat))::int as puntaje_moto_nombre,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'cil' and c.search_text ~ a.alt_pat))::int as puntaje_moto_cilindrada,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'var' and c.search_text ~ a.alt_pat))::int as puntaje_variante,
        (count(distinct a.grupo_idx) filter (where a.tipo = 'moto_marca' and c.search_text ~ a.alt_pat))::int as puntaje_moto_marca,
        coalesce(bool_or(a.tipo = 'prod' and a.grupo_idx = 0 and c.search_text ~ a.alt_start), false) as empieza_con_producto
      from alts a
    ) s
  ),

  -- Puntaje 0 = ningún grupo calzó por palabra -- solo entró por el
  -- prefiltro de subcadena ("rin" contra "ORINGS", "cro" contra "CROMADO").
  -- Se descarta ANTES de los máximos. `nombra_moto` se calcula solo para las
  -- filas relevantes (100 patrones de moto por fila es barato, pero no hace
  -- falta pagarlo por las descartadas).
  candidatos_relevantes as (
    select r.*, m.nombra_moto, m.nombra_modelo
    from candidatos_con_puntaje r
    cross join lateral (
      select
        exists (select 1 from motos_pat mp where r.search_text ~ mp.pat) as nombra_moto,
        exists (select 1 from motos_pat mp where not mp.es_marca and r.search_text ~ mp.pat) as nombra_modelo
    ) m
    where r.puntaje > 0
  ),

  con_maximo as (
    select
      *,
      max(puntaje) over () as puntaje_maximo,
      -- "Otra moto": nombra una moto conocida y NO calza la moto con nombre
      -- del cliente, salvo que calce su MARCA y el nombre no nombre ningún
      -- MODELO (BATERIA SECA JAGUAR/BERA para un cliente de marca bera). La
      -- marca sola, con un modelo distinto en el nombre (TAPA LATERAL BERA SBR
      -- para una Bera Milan), no rescata. Sin moto del cliente
      -- (puntaje_moto_nombre = 0 para todos y sin marca) es nombra_moto.
      (nombra_moto and puntaje_moto_nombre = 0
        and not (puntaje_moto_marca > 0 and not nombra_modelo)) as nombra_otra_moto,
      (not nombra_moto or search_text ~ '\muniversal') as es_universal
    from candidatos_relevantes
  ),
  -- La FAMILIA del pedido (ver la cabecera): las filas del máximo que empiezan
  -- con la cabeza del pedido si alguna lo hace; todo el máximo si ninguna.
  con_familia as (
    select
      *,
      (puntaje = puntaje_maximo
        and (empieza_con_producto
             or not coalesce(bool_or(empieza_con_producto) filter (where puntaje = puntaje_maximo) over (), false))
      ) as en_familia
    from con_maximo
  ),
  con_conteo_maximo as (
    select
      *,
      count(*) filter (where puntaje = puntaje_maximo) over () as filas_con_puntaje_maximo,
      -- SOLO la moto con nombre (ver la cabecera): la cilindrada, el año y la
      -- marca nunca vuelven verdadera la coincidencia de moto. Y SOLO entre
      -- las filas de la familia: una fila de otro producto que nombra la moto
      -- no la hace calzar.
      max(puntaje_moto_nombre) filter (where en_familia) over () as puntaje_moto_maximo
    from con_familia
  ),
  -- Las ventanas de decisión. El conjunto es el mismo para todas: las filas
  -- del máximo y, si la moto con nombre calza (puntaje_moto_maximo > 0), solo
  -- las de esa moto. Con moto que no calza (o sin moto) puntaje_moto_maximo =
  -- 0 y el conjunto es todo el máximo (una fila de otro producto que nombra la
  -- moto sigue dentro: la moto no filtra).
  con_conteo_moto as (
    select
      *,
      count(*) filter (
        where puntaje = puntaje_maximo
          and (puntaje_moto_maximo = 0 or puntaje_moto_nombre = puntaje_moto_maximo)
      ) over () as filas_con_maximo_y_moto,
      count(*) filter (
        where puntaje = puntaje_maximo
          and (puntaje_moto_maximo = 0 or puntaje_moto_nombre = puntaje_moto_maximo)
          and coalesce(stock_quantity, 0) > 0
      ) over () as filas_con_maximo_y_stock,
      -- Solo la familia: ver la cabecera (dispara D1).
      count(*) filter (
        where en_familia
          and (puntaje_moto_maximo = 0 or puntaje_moto_nombre = puntaje_moto_maximo)
          and nombra_moto
      ) over () as filas_que_nombran_moto,
      count(*) filter (
        where puntaje = puntaje_maximo
          and (puntaje_moto_maximo = 0 or puntaje_moto_nombre = puntaje_moto_maximo)
          and es_universal
      ) over () as filas_universales,
      count(*) filter (
        where puntaje = puntaje_maximo
          and (puntaje_moto_maximo = 0 or puntaje_moto_nombre = puntaje_moto_maximo)
          and es_universal
          and coalesce(stock_quantity, 0) > 0
      ) over () as filas_universales_con_stock,
      count(*) filter (
        where puntaje = puntaje_maximo
          and (puntaje_moto_maximo = 0 or puntaje_moto_nombre = puntaje_moto_maximo)
          and n_var > 0
          and puntaje_variante = n_var
      ) over () as filas_con_variante,
      count(*) filter (
        where puntaje = puntaje_maximo
          and (puntaje_moto_maximo = 0 or puntaje_moto_nombre = puntaje_moto_maximo)
          and n_var > 0
          and puntaje_variante = n_var
          and coalesce(stock_quantity, 0) > 0
      ) over () as filas_con_variante_y_stock
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
    f.filas_con_maximo_y_stock,
    f.puntaje_variante, f.puntaje_moto_marca,
    f.nombra_moto, f.nombra_otra_moto, f.es_universal,
    f.filas_que_nombran_moto, f.filas_universales, f.filas_universales_con_stock,
    f.filas_con_variante, f.filas_con_variante_y_stock
  from con_conteo_moto f
  left join lateral (
    select jsonb_agg(jsonb_build_object('moto_brand', pc.moto_brand, 'moto_model', pc.moto_model)) as compatibilidad
    from public.product_compatibility pc
    where pc.product_id = f.id
  ) compat on true
  order by
    f.puntaje desc,
    -- Solo si la moto calza: con moto que no calza, una fila de otro producto
    -- que nombra la moto (BOMBA DE ACEITE BERA SBR) no sube por nombrarla.
    case when f.puntaje_moto_maximo > 0 then f.puntaje_moto_nombre else 0 end desc,
    f.puntaje_variante desc,
    f.empieza_con_producto desc,
    f.puntaje_moto_marca desc,
    f.puntaje_moto_cilindrada desc,
    f.puntaje_opcional desc,
    (coalesce(f.stock_quantity, 0) > 0) desc,
    coalesce(f.stock_quantity, 0) desc,
    f.name,
    f.id
  limit least(greatest(coalesce(p_limite, 10), 1), 50)
$$;

comment on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) is
  'Busca en el catálogo por grupos de alternativas (jsonb, arreglo de arreglos; patrones siempre vía patron_busqueda). p_terminos = obligatorios (definen el puntaje); p_opcionales = solo desempatan; p_moto = marca/modelo CON NOMBRE (ordena y es lo único que puede volver verdadera la coincidencia de moto; calza por palabra: gr no calza GRIS); p_cilindrada = "250"/"200cc"/año, solo ordena; p_variantes = colores, mate, edge, tallas (ordenan y tienen ventanas que exigen TODAS); p_moto_marca = bera/ek/empire cuando el cliente dio también el modelo (solo ordena); p_motos_conocidas = arreglo PLANO de palabras (tope 200) para saber si un nombre nombra alguna moto (nombra_moto, nombra_otra_moto, es_universal); p_marcas_de_moto = arreglo PLANO (tope 50) de las palabras de moto que son marca (bera, ek, jaguar...): un producto que nombra solo marcas y calza la marca del cliente no es de otra moto. La moto solo calza (puntaje_moto_maximo) y la familia solo depende de la moto (filas_que_nombran_moto) entre las filas que empiezan con el producto, si alguna lo hace (la bomba de aceite no es un aceite). Ordena y cuenta (puntaje_maximo, filas_con_*) ANTES del límite; desempata por existencia y nunca por nombre antes que por stock. Plan "Seba no cotiza lo que no es" (Entrega A2), T2, 30/9/2026. Solo la llama service_role (security invoker).';

-- Los dos revokes de siempre, por firma (ver CLAUDE.md): el EXECUTE de
-- fábrica de Postgres a PUBLIC y el `alter default privileges` de Supabase a
-- anon/authenticated. Ninguno alcanza solo.
revoke execute on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public;
revoke execute on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from anon, authenticated;

grant execute on function public.buscar_productos(jsonb, jsonb, int, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';
