-- Búsqueda de contactos sin acentos ni mayúsculas (F13).
--
-- El buscador de la bandeja (`searchConversationSummaries`, src/lib/data.ts)
-- filtraba `display_name`/`profile_name`/`phone_number` con un `ilike` directo
-- contra lo que la persona escribió. Por WhatsApp nadie escribe con tildes:
-- "jose" no encontraba al contacto "José", igual que "bujia" no encontraba
-- "Bujía" en el catálogo antes de 20260822100000.
--
-- Mismo patrón que esa migración (imitado a propósito, ver su comentario):
-- una columna generada `search_text`, sin acentos y en minúsculas, con índice
-- trigram para que el `ilike '%termino%'` (comodín al principio, un btree no
-- sirve) no degrade con el volumen de contactos.
--
-- La diferencia con products/messages es que acá NO hace falta crear nada
-- nuevo de extensiones ni de función: `unaccent`, `pg_trgm` y el wrapper
-- `public.immutable_unaccent(text)` ya existen desde 20260822100000
-- (products.search_text) y los reutiliza también 20260822110000
-- (messages.search_text). Los tres viven en el esquema `public` — no
-- "extensions" — porque esa migración los creó con `create extension if not
-- exists unaccent;`/`... pg_trgm;` sin calificar esquema; seguir esa misma
-- convención acá (sin volver a declarar las extensiones, sin volver a crear
-- la función, sin calificar `gin_trgm_ops`) es lo que mantiene coherente el
-- patrón de los tres search_text del proyecto en vez de tener dos esquemas
-- distintos conviviendo por accidente.
alter table public.contacts
  add column if not exists search_text text
  generated always as (
    public.immutable_unaccent(
      lower(
        coalesce(display_name, '') || ' ' ||
        coalesce(profile_name, '') || ' ' ||
        coalesce(phone_number, '')
      )
    )
  ) stored;

create index if not exists contacts_search_text_trgm
  on public.contacts using gin (search_text gin_trgm_ops);

comment on column public.contacts.search_text is
  'Nombre para mostrar, nombre de perfil de WhatsApp y número, juntos, sin acentos y en minúsculas. Lo consulta searchConversationSummaries (src/lib/data.ts).';
