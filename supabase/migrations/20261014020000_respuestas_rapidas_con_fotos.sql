-- ============================================================================
-- Respuestas rápidas con fotos (14/10/2026).
--
-- Contexto: una respuesta rápida (`public.quick_replies`) era solo texto. El
-- cliente pidió que pueda llevar fotos (hasta 10) y que al usarla en el chat
-- salgan junto con el texto. Esta migración solo agrega dónde guardarlas.
--
-- `media_paths` son RUTAS dentro del bucket privado `whatsapp-media`, nunca
-- URLs: las fotos se suben a `quick-replies/<uuid>.<ext>` (la política de insert
-- de storage ya exige `is_agent()`, no se toca) y se sirven por la misma vía
-- firmada que el resto del multimedia. Nunca se borran del bucket: un mensaje ya
-- enviado apunta a la misma ruta, y borrar el archivo rompería su burbuja.
--
-- El CHECK exige: a lo sumo 10 rutas, ningún elemento null y todas bajo el
-- prefijo `quick-replies/` sin `..` (que no se pueda apuntar a la media de otra
-- conversación ni escapar de la carpeta). Un CHECK no admite subconsultas, de
-- ahí la función `immutable` que recorre el arreglo. No es `security definer`:
-- el CHECK la evalúa con los privilegios de quien escribe, y el `EXECUTE` de
-- fábrica a `PUBLIC` es justo lo que hace falta (revocarlo rompería los INSERT
-- de `authenticated`; probado en supabase/tests/respuestas_rapidas_con_fotos.sql).
-- La RLS de `quick_replies` no cambia.
-- ============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

create or replace function public.quick_reply_media_paths_ok(p_paths text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(p like 'quick-replies/%' and p !~ '\.\.'), true)
    from unnest(p_paths) as p
$$;

alter table public.quick_replies
  add column media_paths text[] not null default '{}';

alter table public.quick_replies
  add constraint quick_replies_media_paths_check check (
    cardinality(media_paths) <= 10
    and array_position(media_paths, null) is null
    and public.quick_reply_media_paths_ok(media_paths)
  );

comment on column public.quick_replies.media_paths is
  'Rutas (no URLs) de hasta 10 fotos dentro del bucket privado whatsapp-media, todas bajo quick-replies/. Salen junto con el texto al usar la respuesta rápida. No se borran del bucket: los mensajes ya enviados apuntan a la misma ruta (14/10/2026).';

-- Autoverificación contra el catálogo real.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'quick_replies'
      and column_name = 'media_paths' and data_type = 'ARRAY' and is_nullable = 'NO'
  ) then
    raise exception '20261014020000: quick_replies.media_paths no quedó creada como text[] not null';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quick_replies'::regclass
      and conname = 'quick_replies_media_paths_check' and contype = 'c'
  ) then
    raise exception '20261014020000: falta el CHECK quick_replies_media_paths_check';
  end if;

  if not exists (
    select 1 from pg_proc
    where oid = to_regprocedure('public.quick_reply_media_paths_ok(text[])')
      and provolatile = 'i'
  ) then
    raise exception '20261014020000: falta la función inmutable quick_reply_media_paths_ok(text[])';
  end if;

  raise notice '20261014020000: autoverificación de quick_replies.media_paths correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado (hallazgo M1 del
-- 19/9/2026, misma práctica que las demás migraciones recientes).
notify pgrst, 'reload schema';
