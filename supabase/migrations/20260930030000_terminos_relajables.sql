-- ============================================================================
-- Qué palabra tumba la búsqueda (T3, Entrega A2 "Seba no cotiza lo que no
-- es", 30/9/2026, decisión D3 del operador).
--
-- Desde 20260928010000 la búsqueda del catálogo exige TODOS los grupos de
-- palabras (la marca es obligatoria: el caso Inca no puede volver). El
-- estudio del VPS del 29/9/2026 (sección 2.6 de
-- docs/planes/2026-09-30-seba-a2-casos-del-vps.md) midió el costo: 25 casos
-- iguales y 6 peores por una palabra obligatoria que no es ni producto ni
-- marca y que tumba la búsqueda entera:
--
--   * "manguera de bomba de freno delantero" (Bera Socialista): existe
--     MANGUERA FRENO DELANTERO BERA L&J, pero "bomba" NO co-ocurre con
--     "manguera" en ningún nombre — "bomba" existe en el catálogo (BOMBA
--     FRENO…), solo que en otros productos. Antes cotizaba; hoy queda en 0
--     y debía salir la manguera.
--   * "carburador pwk 30mm cortina plana": "pwk" no aparece en NINGÚN nombre
--     activo (el nombre dice CARBURADOR CORTINA PLANA 30MM). Antes cotizaba;
--     hoy, 0.
--   * "kit de cilindro pasador fino", "ibk 30 litros", "caliper de freno
--     scooter", "tubo de escape con silenciador", "parrilla con porta
--     alforjas", "piñón de 14 con reborde de 11", "caucho 90 90 19
--     semitaco", "botas talla 39"…
--
-- La decisión D3 (tercer intento, DESPUÉS del corrector): se relaja un
-- grupo que no es la cabeza, ni una marca, ni una moto, y que cumple una de
-- dos: no aparece en ningún nombre activo, o ningún producto lo trae junto
-- con la cabeza. "La cabeza" es el primer grupo que existe en el catálogo y
-- no es un número suelto. Decidir eso exige mirar el catálogo, y solo la
-- base puede hacerlo sin traerse miles de nombres a TypeScript.
--
-- `diagnosticar_terminos(p_terminos, p_cabeza)` recibe los grupos de
-- alternativas (el MISMO formato jsonb que `buscar_productos.p_terminos`:
-- arreglo de arreglos de strings ya normalizados —minúsculas sin acentos—,
-- como mucho 12 grupos y 4 alternativas por grupo) y el índice de la cabeza
-- (0-based), y devuelve UNA fila por grupo:
--
--   grupo_idx    el índice del grupo (0-based), en el mismo orden de entrada.
--   en_catalogo  existe algún producto ACTIVO con precio > 0 cuyo
--                `search_text` calza ALGUNA alternativa del grupo.
--   con_cabeza   existe algún producto que calza el grupo Y el grupo cabeza
--                (alguna alternativa de cada uno). Para el propio grupo
--                cabeza es igual a `en_catalogo`. NULL si `p_cabeza` es nulo
--                o está fuera de rango (no hay cabeza contra la que medir).
--
-- Los patrones salen SIEMPRE de `public.patron_busqueda(alt, 'prod')`
-- (20260930010000), la única fuente: lo que aquí "existe" es exactamente lo
-- que `buscar_productos` calzaría — un número que termina la alternativa
-- lleva `([^0-9]|$)` (11 calza 11T, 1 no; 50 no calza 5000), una palabra de
-- 3 letras o menos acepta plural, etc. Si el diagnóstico usara otro patrón,
-- diría "existe" de algo que la búsqueda no encuentra, o al revés.
--
-- Prefiltro `ilike` por alternativa (mismo escapado LIKE que
-- `buscar_productos`: backslash primero, después % y _) para que Postgres use
-- el índice trigram de `search_text` en vez de recorrer 6.000 filas con una
-- regex por cada alternativa; el regex real se aplica solo a lo que pasó el
-- prefiltro.
--
-- Solo corre cuando fallaron el primer intento y el corrector: es el camino
-- menos frecuente de la herramienta (con `catalog-correction.ts`,
-- `diagnosticarTerminos`, que nunca lanza).
--
-- SECURITY INVOKER, igual que `buscar_productos` y `corregir_terminos`, y a
-- propósito NO definer: la ÚNICA llamada llega con el cliente admin
-- (`service_role`), que salta RLS por su cuenta, así que no hay política por
-- fila que ahorrar (el único motivo por el que otras funciones de esta base
-- son definer, 20260921030000). Lleva los dos revokes por firma y `grant … to
-- service_role`.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA TRANSACCIÓN (`psql -1 -v
-- ON_ERROR_STOP=1`, o la CLI de Supabase): `set local lock_timeout` fuera de
-- una transacción es un no-op silencioso (CLAUDE.md, trampa de las cinco
-- migraciones de Seba). Requiere 20260930010000 (`patron_busqueda`); la
-- función es nueva: no reemplaza nada.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (mismo bloque que
-- 20260916010000/20260928010000/20260930020000): sin transacción falla
-- cerrado.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- Requiere el helper de patrones de 20260930010000: falla cerrado y claro si
-- se aplicó fuera de orden.
do $$
begin
  if to_regprocedure('public.patron_busqueda(text, text)') is null then
    raise exception 'public.patron_busqueda(text, text) no existe: la crea 20260930010000_busqueda_por_palabra_moto_y_variantes.sql, que debe aplicarse antes que esta migración.';
  end if;
end $$;

create function public.diagnosticar_terminos(
  p_terminos jsonb,
  p_cabeza integer
)
returns table (grupo_idx integer, en_catalogo boolean, con_cabeza boolean)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with
  -- Como mucho 12 grupos; si el llamador manda algo que no es un arreglo, no
  -- hay grupos (cero filas, sin lanzar).
  grupos as (
    select (t.ord - 1)::integer as grupo_idx, t.elem as grupo
    from jsonb_array_elements(
      case when jsonb_typeof(p_terminos) = 'array' then p_terminos else '[]'::jsonb end
    ) with ordinality as t(elem, ord)
    where t.ord <= 12
  ),
  -- Como mucho 4 alternativas por grupo; un grupo que no es arreglo se trata
  -- como sin alternativas (no calza nada).
  alts_crudas as (
    select g.grupo_idx, lower(trim(both from (a.elem #>> '{}'))) as alt
    from grupos g
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(g.grupo) = 'array' then g.grupo else '[]'::jsonb end
    ) with ordinality as a(elem, ord)
    where a.ord <= 4
  ),
  -- Patrón final SIEMPRE vía `patron_busqueda` (única fuente). `alt_like` es
  -- el escapado del prefiltro `ilike`: backslash primero, después % y _.
  alts as (
    select
      grupo_idx,
      replace(replace(replace(alt, '\', '\\'), '%', '\%'), '_', '\_') as alt_like,
      public.patron_busqueda(alt, 'prod') as alt_pat
    from alts_crudas
    where alt is not null and alt <> ''
  ),
  patrones_prefiltro as (
    select coalesce(array_agg('%' || alt_like || '%'), '{}'::text[]) as patrones
    from alts
  ),
  -- Solo productos que pasan el prefiltro de ALGUNA alternativa (sin
  -- alternativas, `ilike any('{}')` no calza nunca: cero candidatos).
  candidatos as (
    select p.id, p.search_text
    from public.products p, patrones_prefiltro pf
    where p.is_active
      and p.price > 0
      and p.search_text ilike any (pf.patrones)
  ),
  -- Qué grupos calza cada candidato (con el regex real, no con el prefiltro).
  calces as (
    select distinct c.id, a.grupo_idx
    from candidatos c
    join alts a on c.search_text ~ a.alt_pat
  ),
  -- ¿La cabeza está dentro de los grupos que llegaron?
  cabeza_valida as (
    select exists (select 1 from grupos gr where gr.grupo_idx = p_cabeza) as ok
  )
  select
    g.grupo_idx,
    exists (select 1 from calces c where c.grupo_idx = g.grupo_idx) as en_catalogo,
    case
      when p_cabeza is null or not (select ok from cabeza_valida) then null
      when g.grupo_idx = p_cabeza then
        exists (select 1 from calces c where c.grupo_idx = g.grupo_idx)
      else
        exists (
          select 1
          from calces c1
          join calces c2 on c2.id = c1.id
          where c1.grupo_idx = g.grupo_idx
            and c2.grupo_idx = p_cabeza
        )
    end as con_cabeza
  from grupos g
  order by g.grupo_idx
$$;

comment on function public.diagnosticar_terminos(jsonb, integer) is
  'Por cada grupo de alternativas (mismo formato jsonb que buscar_productos.p_terminos: hasta 12 grupos y 4 alternativas, texto normalizado) dice si existe en algún producto activo con precio > 0 (en_catalogo) y si existe junto al grupo cabeza p_cabeza, índice 0-based (con_cabeza; para la propia cabeza = en_catalogo; NULL si p_cabeza es nulo o está fuera de rango). Patrones siempre vía patron_busqueda(alt, ''prod''), la misma fuente que buscar_productos. Sirve al tercer intento de la búsqueda (D3): relajar el grupo que no existe o que no co-ocurre con la cabeza. security invoker: la llama solo service_role, que salta RLS. Entrega A2, T3, 30/9/2026.';

-- Los dos revokes de siempre, por firma (ver CLAUDE.md): el EXECUTE de
-- fábrica de Postgres a PUBLIC y el `alter default privileges` de Supabase a
-- anon/authenticated. Ninguno alcanza solo.
revoke execute on function public.diagnosticar_terminos(jsonb, integer) from public;
revoke execute on function public.diagnosticar_terminos(jsonb, integer) from anon, authenticated;

grant execute on function public.diagnosticar_terminos(jsonb, integer) to service_role;

notify pgrst, 'reload schema';
