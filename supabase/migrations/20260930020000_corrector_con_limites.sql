-- ============================================================================
-- El corrector de tipeos deja de cambiar palabras válidas por otras (T3,
-- Entrega A2 "Seba no cotiza lo que no es", 30/9/2026).
--
-- El estudio del VPS del 29/9/2026 (sección 2.4 de
-- docs/planes/2026-09-30-seba-a2-casos-del-vps.md) midió que el segundo
-- intento de la búsqueda EMPEORABA 7 casos y dejaba 3 igual: `corregir_terminos`
-- (20260928020000) cambiaba una palabra que el cliente había escrito bien por
-- OTRA palabra que también existe en el catálogo, y el reintento
-- "encontraba" algo equivocado o, peor, un agotado falso:
--
--   * "intercomunicador para parejas": `pareja` → `para`, y sale AGOTADO con
--     tres "INTERCOMUNICADOR PARA CASCO" en 0 (hay cinco intercomunicadores
--     con stock, EJEAS V7 PRO, 8 u.).
--   * "llanta" → `lata`, y cotiza LIGA FRENO LATA.
--   * "relación", Owen EK → `reparacion`, y cotiza KIT REPARACION CALIPER
--     OWEN; lo mismo "relación 17 por 36" para Horse.
--   * "casco Frankie negro vicera azul": `visera`, y cotiza VISERA CASCO
--     FRANKIE; se pierde CASCO FRANKIE NEGRO MATE V/AZUL (2 u.).
--   * "carplay" → `cara`, "caucho kenda 70/120" → `anda`, "cascos dama negro"
--     → `gama`, frente → freno, compresion → compresor, alante → aislante,
--     numero → nuevo, medida → media.
--   * El corrector vuelve a PLURALIZAR el singular que armó el propio código
--     al buscar: diente → dientes, brazo → brazos, manga → mangas, bidon →
--     bidones, bota → botas, proteccion → protecciones, guarda → guaya.
--
-- Y tienen que seguir funcionando los tipeos que la Entrega A sí arregló:
-- horsen → horse, tisum/stinsun → timsun, iphone → ipone, swhera →
-- switchera, motopower → motorpower, ciguañal → cigueñal, rallo → rayo,
-- siriu → sirius (este último por prefijo, ver abajo). "beta" sigue
-- protegida (es una moto).
--
-- QUÉ CAMBIA
--
-- `corregir_terminos(p_terminos, p_protegidos, p_marcas, p_excluidos)`: la
-- firma de dos parámetros se retira con `drop` (dos sobrecargas harían
-- ambigua la llamada por nombres de `supabase.rpc`), y la nueva trae dos
-- listas más, las dos con default `'{}'`:
--
--   p_marcas     MARCAS_CONOCIDAS de `tools.ts`. `products.brand` está vacía
--                (0 de 6.065 productos), así que la lista cerrada vive en el
--                código, no en la base.
--   p_excluidos  el RELLENO del cliente ("para", "medida", "de", "con"…): una
--                palabra de relleno ni se corrige ni sirve de candidato. Con
--                esto "medida" (que está a distancia 1 de "media") y "pareja"
--                dejan de ser cambiadas por otra palabra suelta.
--
-- Reglas, TODAS a la vez:
--
--   1. Solo se corrige un término `^[a-z]+$` de 4 letras o más, que no esté
--      en `p_protegidos` (motos conocidas: beta no pasa a bera) ni en
--      `p_excluidos`. Todo se compara normalizado (minúsculas, sin acentos).
--   2. PREFIJO: si alguna palabra del vocabulario EMPIEZA con el término,
--      el término ya existe y no se corrige. La búsqueda encuentra por
--      prefijo de palabra (`\mterm`), así que "siriu" ya calza SIRIUS,
--      "diente" ya calza DIENTES y "guarda" ya calza GUARDABARRO: corregirlos
--      solo puede cambiar de producto. Esto cubre de un golpe los siete
--      "singulares" que el corrector pluralizaba.
--   3. El candidato nunca está en `p_excluidos`, y nunca es el plural o el
--      singular del término (candidato = término+"s"/"es", o término =
--      candidato+"s"/"es"): eso lo resuelve la búsqueda, no una "corrección".
--   4. El candidato necesita 5 letras o más, SALVO que suene igual que el
--      término (misma `clave_fonetica`): "rayo" (4 letras) solo se acepta por
--      sonido. Con 4 letras, cualquier palabra queda a una tecla de otra
--      ("dama"→"gama", "kenda"→"anda", "llanta"→"lata").
--   5. El candidato se acepta con UNA de tres razones:
--        a) levenshtein <= 1 (una tecla);
--        b) misma `clave_fonetica` (suena igual: rallo/rayo, vicera/visera);
--        c) está en `p_marcas` y la distancia cabe en el umbral por largo del
--           término (4 letras → 1, 5 → 2, 6 o más → 3). Distancias 2 y 3
--           hacia una palabra cualquiera son cambiar de palabra (frente →
--           freno, alante → aislante, numero → nuevo); hacia una marca de la
--           lista cerrada son un tropiezo de teclado (tisum/stinsun →
--           timsun, swhera → switchera).
--      A distancia 3 se sigue exigiendo similitud de trigramas >= 0,3, como
--      en la versión anterior.
--   6. Desempate entre candidatos: menor distancia, mayor similitud de
--      trigramas, mayor frecuencia en el catálogo y, al final, la palabra
--      (orden alfabético, solo para que el resultado sea determinista).
--
-- `public.clave_fonetica(texto)`: helper IMMUTABLE, sobre texto YA
-- normalizado (minúsculas sin acentos, como `search_text`). Reduce una
-- palabra a cómo suena en español venezolano, de modo que dos palabras que
-- suenan igual dan la misma clave. Las reglas, en este orden (el orden
-- importa):
--     ch → # (protege el dígrafo: no le toca ni la regla de la c ni la de
--             la h muda)
--     qu → k        que, qui  →  ke, ki
--     c antes de e/i → s        cemento → semento
--     c (otro caso) → k         casa → kasa
--     ll → y                    rallo → rayo
--     v → b                     vicera → bicera
--     z → s                     caza → casa
--     h → (nada)                iphone → ipone, hola → ola
--     letra doble → una sola    carro → caro
--   No pretende ser una fonética completa (no toca g/j, x, y/i, w): solo
--   las confusiones que aparecieron en el estudio y las de ortografía más
--   comunes entre clientes de WhatsApp. "dama" y "gama", "frente" y
--   "freno", "pareja" y "para" NO suenan igual (claves distintas).
--
-- VOCABULARIO. Igual que antes: las palabras distintas (sin dígitos, de 3
-- letras o más) de `search_text` de los productos ACTIVOS con precio mayor
-- que cero, con su frecuencia, calculado AL VUELO. Son unas 6.000 filas y la
-- función solo corre en el camino sin coincidencia; una tabla materializada
-- habría que mantenerla al día con cada corrida de `saint.sync_products()`
-- (cada minuto).
--
-- SECURITY INVOKER, igual que `buscar_productos` y que la versión anterior, y
-- a propósito NO definer: la ÚNICA llamada llega desde `catalog-correction.ts`
-- con el cliente admin (`service_role`), que salta RLS por su cuenta, así que
-- no hay política por fila que ahorrar (el único motivo por el que otras
-- funciones de esta base son definer, 20260921030000) y un definer solo
-- sumaría superficie sobre texto que viene de un cliente de WhatsApp. Lleva
-- los dos revokes por firma y `grant … to service_role`. `clave_fonetica` es
-- una función pura sobre texto, sin acceso a tablas: mismo cierre, por
-- coherencia con `patron_busqueda` (20260930010000).
--
-- `fuzzystrmatch` (levenshtein) sigue el mismo trato que en 20260928020000:
-- se crea en el MISMO schema que `pg_trgm` (aquí ya existe, es idempotente) y
-- un guard falla cerrado si quedó en un schema que el `search_path` fijo de
-- la función no enumera.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA TRANSACCIÓN (`psql -1 -v
-- ON_ERROR_STOP=1`, o la CLI de Supabase, que ya envuelve cada archivo):
-- `set local lock_timeout` fuera de una transacción es un no-op silencioso
-- (CLAUDE.md, trampa de las cinco migraciones de Seba). El `drop function`
-- toma un lock breve sobre la función vieja: el tope de 5 s evita encolar
-- detrás de una llamada en vuelo. Entre el `drop` y el `create` no hay
-- ventana observable: es una sola transacción.
--
-- ORDEN DE DESPLIEGUE: esta migración va ANTES del código que pasa
-- `p_marcas`/`p_excluidos`. El código viejo, que llama con dos argumentos,
-- sigue resolviendo a la firma nueva por los defaults.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (mismo bloque que
-- 20260916010000/20260918010000/20260928010000/20260928020000): sin
-- transacción falla cerrado.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- fuzzystrmatch junto a pg_trgm (idempotente: en cualquier base que ya corrió
-- 20260928020000 no hace nada).
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

-- ---------------------------------------------------------------------------
-- Helper: clave fonética. IMMUTABLE, sin acceso a tablas.
-- ---------------------------------------------------------------------------
create function public.clave_fonetica(p_texto text)
returns text
language plpgsql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
declare
  v text := p_texto;
begin
  -- El orden importa: `ch` se protege primero para que ni la regla de la c
  -- ni la de la h muda lo rompan.
  v := regexp_replace(v, 'ch', '#', 'g');
  v := regexp_replace(v, 'qu', 'k', 'g');
  v := regexp_replace(v, 'c(?=[ei])', 's', 'g');
  v := regexp_replace(v, 'c', 'k', 'g');
  v := regexp_replace(v, 'll', 'y', 'g');
  v := regexp_replace(v, 'v', 'b', 'g');
  v := regexp_replace(v, 'z', 's', 'g');
  v := regexp_replace(v, 'h', '', 'g');
  -- Letras dobles colapsadas (carro/caro). Va al final: `ll` ya pasó a `y`.
  v := regexp_replace(v, '(.)\1', '\1', 'g');
  return v;
end
$$;

comment on function public.clave_fonetica(text) is
  'Clave fonética española sobre texto ya normalizado (minúsculas sin acentos): ch→#, qu→k, c antes de e/i→s, c→k, ll→y, v→b, z→s, h muda eliminada, letras dobles colapsadas. Dos palabras que suenan igual dan la misma clave (rallo/rayo, vicera/visera). No es una fonética completa. IMMUTABLE. La usa corregir_terminos. Entrega A2, T3, 30/9/2026.';

revoke execute on function public.clave_fonetica(text) from public;
revoke execute on function public.clave_fonetica(text) from anon, authenticated;

grant execute on function public.clave_fonetica(text) to service_role;

-- ---------------------------------------------------------------------------
-- El corrector, con límites. La firma de dos parámetros se retira.
-- ---------------------------------------------------------------------------
drop function public.corregir_terminos(text[], text[]);

create function public.corregir_terminos(
  p_terminos text[],
  p_protegidos text[] default '{}'::text[],
  p_marcas text[] default '{}'::text[],
  p_excluidos text[] default '{}'::text[]
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
  -- La lista cerrada de marcas: las únicas palabras hacia las que se acepta
  -- una distancia de 2 o 3.
  marcas as (
    select distinct public.immutable_unaccent(lower(btrim(x))) as palabra
    from unnest(coalesce(p_marcas, '{}'::text[])) as x
    where x is not null
  ),
  -- El relleno: ni se corrige ni sirve de candidato.
  excluidos as (
    select distinct public.immutable_unaccent(lower(btrim(x))) as palabra
    from unnest(coalesce(p_excluidos, '{}'::text[])) as x
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
  -- Elegibles: solo letras, 4 o más, ni protegidos ni relleno. El umbral de
  -- distancia (para las marcas) depende del largo (ver la cabecera).
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
      and not exists (select 1 from excluidos x where x.palabra = e.norma)
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
  -- Los que NO son prefijo de ninguna palabra del vocabulario (un término
  -- que ya existe, o que es el comienzo de una palabra que existe, se busca
  -- tal cual: la búsqueda calza por prefijo de palabra). El `like` es
  -- seguro: `norma` solo trae letras a-z.
  sin_calce as (
    select el.*
    from elegibles el
    where not exists (select 1 from vocabulario v where v.palabra like el.norma || '%')
  ),
  candidatos as (
    select
      s.original,
      s.norma,
      s.orden,
      s.umbral,
      v.palabra,
      v.frecuencia,
      levenshtein(s.norma, v.palabra) as distancia,
      similarity(s.norma, v.palabra) as parecido
    from sin_calce s
    join vocabulario v
      on abs(length(v.palabra) - length(s.norma)) <= s.umbral
     and levenshtein_less_equal(s.norma, v.palabra, s.umbral) <= s.umbral
    where not exists (select 1 from excluidos x where x.palabra = v.palabra)
      -- Ni el plural ni el singular del término.
      and v.palabra not in (s.norma || 's', s.norma || 'es')
      and s.norma not in (v.palabra || 's', v.palabra || 'es')
  ),
  evaluados as (
    select
      c.*,
      (public.clave_fonetica(c.norma) = public.clave_fonetica(c.palabra)) as suena_igual,
      exists (select 1 from marcas m where m.palabra = c.palabra) as es_marca
    from candidatos c
  )
  select distinct on (c.norma) c.original as original, c.palabra as corregido
  from evaluados c
  where
    -- 5 letras o más, salvo que suene igual.
    (length(c.palabra) >= 5 or c.suena_igual)
    -- Una tecla, o suena igual, o marca de la lista cerrada (dentro del
    -- umbral por largo, que el join ya garantiza).
    and (c.distancia <= 1 or c.suena_igual or c.es_marca)
    -- A distancia 3, además, parecido de trigramas.
    and (c.distancia < 3 or c.parecido >= 0.3)
  order by c.norma, c.distancia, c.parecido desc, c.frecuencia desc, c.palabra
$$;

comment on function public.corregir_terminos(text[], text[], text[], text[]) is
  'Corrige tipeos contra el vocabulario del catálogo (palabras de products activos con precio > 0). Devuelve SOLO los términos corregidos (original tal como llegó, corregido en minúsculas sin acentos). Solo corrige palabras de 4+ letras sin dígitos que no estén en p_protegidos (motos conocidas), ni en p_excluidos (el relleno), ni sean prefijo de una palabra del vocabulario (ya existen). Candidato: 5+ letras salvo que suene igual (clave_fonetica); nunca el plural/singular del término ni un excluido; se acepta con distancia <= 1, o si suena igual, o si es una marca de p_marcas dentro del umbral por largo (4→1, 5→2, 6+→3; a distancia 3 exige similarity >= 0.3). Desempate: distancia, similarity, frecuencia, palabra. security invoker: la llama solo service_role, que salta RLS. Entrega A2, T3, 30/9/2026.';

-- Los dos revokes de siempre, por firma (ver CLAUDE.md): el EXECUTE de
-- fábrica de Postgres a PUBLIC y el `alter default privileges` de Supabase a
-- anon/authenticated. Ninguno alcanza solo.
revoke execute on function public.corregir_terminos(text[], text[], text[], text[]) from public;
revoke execute on function public.corregir_terminos(text[], text[], text[], text[]) from anon, authenticated;

grant execute on function public.corregir_terminos(text[], text[], text[], text[]) to service_role;

notify pgrst, 'reload schema';
