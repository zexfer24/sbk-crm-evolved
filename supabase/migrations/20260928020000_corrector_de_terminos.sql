-- ============================================================================
-- El segundo intento de la búsqueda tolera tipeos (T2, plan "Seba encuentra,
-- no insiste, y el mostrador no deja a nadie esperando", 28/9/2026).
--
-- El estudio del VPS sobre 1.027 turnos (25/9 → 28/9/2026) encontró clientes
-- que escriben el repuesto con un tipeo y reciben "no lo encuentro" (o una
-- escalada) aunque el producto exista: "horsen" por HORSE, "tisum" y
-- "stinsun" por TIMSUN, "express" por XPRESS, "iphone" por IPONE (la marca
-- del aceite se llama así en el catálogo), "motopower" por MOTORPOWER,
-- "swhera" por SWITCHERA, "ciguañal" por CIGUEÑAL. Los cuatro son un
-- tropiezo de tecla a distancia de edición 1-3 de una palabra que SÍ está en
-- el catálogo.
--
-- `corregir_terminos(p_terminos, p_protegidos)` recibe las palabras del
-- cliente que no calzaron y devuelve, SOLO para las que se puedan corregir,
-- la palabra del catálogo más parecida. La herramienta `buscarRepuesto`
-- (T3b) la llama UNA vez, cuando el primer intento no calzó, reintenta con
-- lo corregido y, si hubo corrección, la nombra al cliente ("busqué IPONE en
-- lugar de iphone") para que confirme.
--
-- Cuándo corrige un término (todas a la vez):
--   * tiene 4 letras o más (con menos, cualquier palabra queda a distancia 1
--     de otra: "rin", "ber", "kit");
--   * solo trae letras (nada de dígitos: "dt200", "20w50", "90/90-18" son
--     medidas, no palabras mal escritas);
--   * NO está ya en el vocabulario (una palabra que existe se busca tal cual);
--   * NO está en `p_protegidos`. `tools.ts` pasa ahí `MOTOS_CONOCIDAS`: "beta"
--     es una moto y NO es un tipeo de "bera" aunque esté a distancia 1 y
--     "bera" exista — corregirla habría cotizado repuestos de otra moto.
--
-- Vocabulario: las palabras distintas (sin acentos, minúsculas, de 3 letras
-- o más, sin dígitos) de `search_text` de los productos ACTIVOS con precio
-- mayor que cero, con su frecuencia (en cuántos productos aparece), calculado
-- AL VUELO en cada llamada. Son unas 6.000 filas y la función solo corre en
-- el camino sin coincidencia; una tabla materializada habría que mantenerla
-- al día con cada corrida de `saint.sync_products()` (cada minuto) para
-- ahorrar unos milisegundos que aquí no se necesitan.
--
-- Candidato: el de menor distancia de Levenshtein, dentro de un umbral que
-- crece con el largo de la palabra; a igual distancia gana el de mayor
-- similitud de trigramas (`similarity`, pg_trgm), y a igual similitud el más
-- frecuente en el catálogo. El umbral y su porqué:
--
--   largo 4   → distancia ≤ 1  ("beta"→"bera": una tecla; con 2, la mitad de
--                               la palabra y casi cualquier cosa calzaría)
--   largo 5   → distancia ≤ 2  ("tisum"→"timsun": omite una letra Y cambia
--                               otra)
--   largo 6+  → distancia ≤ 3  ("swhera"→"switchera": la palabra escrita
--                               al vuelo pierde tres letras seguidas)
--
-- La distancia 3 es la más floja, así que se le exige además un parecido de
-- trigramas de al menos 0,3 (`similarity` por defecto de pg_trgm): "swhera"
-- contra "switchera" da 0,42; una palabra cualquiera de seis letras contra un
-- nombre que solo comparte la mitad de las letras da menos. Bajo distancia 1
-- o 2 no se exige nada (el propio umbral ya es estricto: "tisum" contra
-- "timsun" da 0,18 de similitud y es una corrección legítima).
--
-- SECURITY INVOKER, igual que `buscar_productos` (20260926010000/
-- 20260928010000) y a propósito NO definer. Se revisó el motivo por el que
-- otras funciones de esta base son definer (20260921030000: una función que
-- recorre una tabla con RLS paga `is_agent()` POR FILA) y aquí no aplica: la
-- ÚNICA llamada llega desde `agent.ts` con el cliente admin (`service_role`),
-- que salta la RLS por su cuenta, así que no hay política por fila que
-- ahorrar. Un definer solo agregaría superficie: ejecutaría con los
-- privilegios del dueño (postgres) una función que lee `products` con texto
-- que viene de un cliente de WhatsApp. Lleva igual los dos revokes por firma
-- y `grant … to service_role` (nadie más necesita llamarla), y un
-- `search_path` fijo.
--
-- `fuzzystrmatch` (levenshtein) se instala en el MISMO schema que `pg_trgm`
-- (`similarity`): en Supabase self-hosted las extensiones pueden vivir en
-- `public` o en `extensions`, y la migración que creó `pg_trgm`
-- (20260822100000) la instaló sin calificar schema, así que el destino real
-- solo se sabe leyendo el catálogo. El `search_path` fijo de la función
-- enumera `public, extensions, pg_catalog`; un guard falla cerrado si la
-- extensión quedó en cualquier otro schema (la función no resolvería
-- `levenshtein`/`similarity` y fallaría en tiempo de ejecución, en
-- producción, en el camino menos probado).
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA TRANSACCIÓN (`psql -1 -v
-- ON_ERROR_STOP=1`, o la CLI de Supabase, que ya envuelve cada archivo):
-- `set local lock_timeout` fuera de una transacción es un no-op silencioso
-- (ver CLAUDE.md, trampa de las cinco migraciones de Seba). `create
-- extension` toma un lock breve sobre el catálogo de extensiones; el tope de
-- 5 s evita encolar detrás de una llamada en vuelo mientras el webhook
-- espera. La función es nueva (no hay `drop`): no reemplaza nada.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (mismo bloque que
-- 20260916010000/20260918010000/20260928010000): sin transacción falla
-- cerrado.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- fuzzystrmatch junto a pg_trgm. `format('%I', …)` cita el nombre del schema.
do $$
declare
  v_schema text;
begin
  select extnamespace::regnamespace::text into v_schema
  from pg_extension
  where extname = 'pg_trgm';

  if v_schema is null then
    raise exception 'pg_trgm no está instalada: la crea 20260822100000_products_search_text.sql, que debe aplicarse antes que esta migración.';
  end if;

  execute format('create extension if not exists fuzzystrmatch with schema %I', v_schema);
end $$;

-- Autoverificación: las dos extensiones en el mismo schema, y uno de los dos
-- que el search_path fijo de la función sabe resolver.
do $$
declare
  v_trgm text;
  v_fuzzy text;
begin
  select extnamespace::regnamespace::text into v_trgm from pg_extension where extname = 'pg_trgm';
  select extnamespace::regnamespace::text into v_fuzzy from pg_extension where extname = 'fuzzystrmatch';

  if v_fuzzy is distinct from v_trgm then
    raise exception 'fuzzystrmatch quedó en % y pg_trgm en %: tienen que compartir schema (la extensión ya existía en otro lugar; muévela con alter extension … set schema).', v_fuzzy, v_trgm;
  end if;

  if v_trgm not in ('public', 'extensions') then
    raise exception 'pg_trgm y fuzzystrmatch viven en el schema %, que el search_path de corregir_terminos (public, extensions, pg_catalog) no incluye: agrégalo antes de crear la función.', v_trgm;
  end if;
end $$;

create function public.corregir_terminos(
  p_terminos text[],
  p_protegidos text[] default '{}'::text[]
)
returns table (original text, corregido text)
language sql
stable
security invoker
set search_path = public, extensions, pg_catalog
as $$
  with
  -- Palabras que jamás se corrigen (las motos conocidas), normalizadas igual
  -- que `search_text`: minúsculas y sin acentos.
  protegidos as (
    select distinct public.immutable_unaccent(lower(btrim(x))) as palabra
    from unnest(coalesce(p_protegidos, '{}'::text[])) as x
    where x is not null
  ),
  -- Los términos del cliente, normalizados; un término repetido cuenta una
  -- sola vez (la primera aparición conserva su texto original y su orden).
  entrada as (
    select distinct on (n.norma) n.original, n.norma, n.orden
    from (
      select
        t.original,
        public.immutable_unaccent(lower(btrim(t.original))) as norma,
        t.orden
      from unnest(coalesce(p_terminos, '{}'::text[])) with ordinality as t(original, orden)
      where t.original is not null
    ) n
    order by n.norma, n.orden
  ),
  -- Elegibles: solo letras, 4 o más, y no protegidos. El umbral de distancia
  -- depende del largo (ver la cabecera).
  elegibles as (
    select
      e.original,
      e.norma,
      e.orden,
      case
        when length(e.norma) <= 4 then 1
        when length(e.norma) = 5 then 2
        else 3
      end as umbral
    from entrada e
    where e.norma ~ '^[a-z]+$'
      and length(e.norma) >= 4
      and not exists (select 1 from protegidos p where p.palabra = e.norma)
  ),
  -- Vocabulario al vuelo: palabras de 3+ letras sin dígitos de los productos
  -- activos con precio, con en cuántos productos aparece cada una.
  vocabulario as (
    select w.palabra, count(distinct p.id) as frecuencia
    from public.products p
    cross join lateral regexp_split_to_table(p.search_text, '[^a-z0-9]+') as w(palabra)
    where p.is_active
      and p.price > 0
      and w.palabra ~ '^[a-z]{3,}$'
    group by w.palabra
  ),
  -- Los que NO están en el vocabulario (una palabra que existe no se corrige).
  sin_calce as (
    select el.*
    from elegibles el
    where not exists (select 1 from vocabulario v where v.palabra = el.norma)
  ),
  candidatos as (
    select
      s.original,
      s.norma,
      s.orden,
      v.palabra,
      v.frecuencia,
      levenshtein(s.norma, v.palabra) as distancia,
      similarity(s.norma, v.palabra) as parecido
    from sin_calce s
    join vocabulario v
      on abs(length(v.palabra) - length(s.norma)) <= s.umbral
     and levenshtein_less_equal(s.norma, v.palabra, s.umbral) <= s.umbral
  )
  select distinct on (c.norma) c.original as original, c.palabra as corregido
  from candidatos c
  where c.distancia < 3 or c.parecido >= 0.3
  order by c.norma, c.distancia, c.parecido desc, c.frecuencia desc, c.palabra
$$;

comment on function public.corregir_terminos(text[], text[]) is
  'Corrige tipeos contra el vocabulario del catálogo (palabras de products activos con precio > 0). Devuelve SOLO los términos corregidos (original tal como llegó, corregido en minúsculas sin acentos). Solo corrige palabras de 4+ letras sin dígitos que no existan en el vocabulario ni estén en p_protegidos (las motos conocidas: beta no pasa a bera). Candidato: menor levenshtein dentro del umbral por largo (4→1, 5→2, 6+→3), desempate por similarity y frecuencia; a distancia 3 exige similarity >= 0.3. security invoker: la llama solo service_role, que salta RLS.';

-- Los dos revokes de siempre, por firma (ver CLAUDE.md): el EXECUTE de
-- fábrica de Postgres a PUBLIC y el `alter default privileges` de Supabase a
-- anon/authenticated. Ninguno alcanza solo.
revoke execute on function public.corregir_terminos(text[], text[]) from public;
revoke execute on function public.corregir_terminos(text[], text[]) from anon, authenticated;

grant execute on function public.corregir_terminos(text[], text[]) to service_role;

notify pgrst, 'reload schema';
