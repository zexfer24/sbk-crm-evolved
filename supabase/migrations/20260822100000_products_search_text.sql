-- Columna de búsqueda normalizada del catálogo.
--
-- El agente respondía "no tenemos" a "tienen bujía NGK?" con la Bujía CR7HSA
-- marca NGK en el estante: la búsqueda hacía un solo ILIKE con la frase
-- completa contra name y brand por separado, y ningún producto se llama
-- "bujía NGK". El otro caso es que por WhatsApp nadie escribe acentos, así
-- que "bujia" tampoco calzaba con "Bujía".
--
-- Los dos se arreglan buscando palabra por palabra sobre un solo texto ya
-- normalizado: nombre y marca juntos, sin acentos y en minúsculas.
--
-- unaccent() es STABLE, no IMMUTABLE, así que no se puede usar directo en una
-- columna generada. El envoltorio fija el diccionario ('unaccent'), que es lo
-- que la hace determinista — es el patrón documentado para este caso.

create extension if not exists unaccent;

create or replace function public.immutable_unaccent(text)
returns text
language sql
immutable
parallel safe
strict
-- search_path fijo: sin esto, la función resuelve `unaccent` según el
-- search_path de quien la llame, y una columna generada no puede depender de
-- eso.
set search_path = public, pg_catalog
as $$
  select public.unaccent('public.unaccent'::regdictionary, $1)
$$;

alter table public.products
  add column if not exists search_text text
  generated always as (
    public.immutable_unaccent(lower(coalesce(name, '') || ' ' || coalesce(brand, '')))
  ) stored;

-- El filtro es `ilike '%termino%'`, con comodín al principio: un btree normal
-- no sirve. trigram sí, y es lo que hace que la búsqueda no degrade cuando el
-- catálogo pase de cinco productos a varios miles.
create extension if not exists pg_trgm;

create index if not exists products_search_text_trgm
  on public.products using gin (search_text gin_trgm_ops);

comment on column public.products.search_text is
  'Nombre y marca juntos, sin acentos y en minúsculas. Es lo que consulta la herramienta de catálogo del agente.';
