-- ============================================================================
-- Tarea T3 · plan "La escalada se hace una vez y la búsqueda responde"
-- (aprobado 21/9/2026, Frente 1, D3).
--
-- El bug, medido en producción por el Claude del VPS: TODA búsqueda de
-- /inbox daba 500 por `statement timeout` -- 156 de 156 en 48 h, media
-- 3,3 s, máxima cerca del tope de 8 s que Supabase le da al rol
-- `authenticated`. Causa, reproducida contra la base local con ~100.000
-- mensajes sembrados (`supabase/tests/search_conversations_by_message.sql`,
-- caso 8 -- confirmado en ROJO contra la función vieja antes de escribir
-- esta migración, ~1,0-1,2 s en tres corridas): la función era `language
-- sql stable security invoker`, así que corría desde la app con los
-- privilegios de `authenticated`, y su filtro de verdad era un `not exists`
-- CORRELACIONADO por fila contra la CTE `terms`
-- (`m.search_text not like '%' || t.term || '%'` dentro de una subconsulta
-- referenciada fila por fila) -- eso el planner no lo puede empujar al
-- índice GIN trigram de `messages.search_text` (20260822110000) bajo
-- NINGUNA circunstancia, con o sin RLS de por medio: cada fila se evalúa
-- con un subplan propio. El resultado, medido con `explain (analyze,
-- buffers)` como `authenticated` contra ese mismo sembrado: `Function Scan`
-- con ~204.000 buffers leídos y ~1,0-1,2 s de ejecución (el hallazgo 1 del
-- plan, contra 115.000 mensajes en producción, midió 75 ms como superusuario
-- contra 1.468 ms como `authenticated`, 234.613 buffers contra 4.706 --
-- mismo orden de magnitud).
--
-- La función nueva (candidata del orquestador, medida contra 115.000
-- mensajes en 27 ms / 137 ms / 20 ms según el término; contra el sembrado
-- de 100.000 de este repo, 34-111 ms en cuatro términos distintos) resuelve
-- el patrón UNA sola vez en un arreglo plpgsql (`pats := array_agg('%' ||
-- t || '%')`) y filtra con `search_text LIKE ALL (pats)` -- una expresión
-- CONSTANTE que el planner SÍ puede empujar al índice GIN trigram (Bitmap
-- Index/Heap Scan en vez de Function Scan con Filter por fila; medido:
-- 8.142 buffers contra 204.147, ~25 veces menos). El chequeo de RLS
-- (`is_agent()`) pasa a hacerse UNA vez al principio del cuerpo, en vez de
-- una vez por fila vía la política `messages_all using (is_agent())`:
-- `security definer`, dueña de `postgres` (rolbypassrls=true en este
-- stack), así que adentro de la función el acceso a `messages` bypassa RLS
-- por completo -- el `if not public.is_agent() then return; end if;` del
-- principio es el ÚNICO portón que queda, y por eso lleva los DOS revokes
-- de cualquier `security definer` nueva (ver CLAUDE.md: el `EXECUTE` de
-- fábrica de Postgres a `PUBLIC` y el `alter default privileges` de
-- Supabase a `anon`/`authenticated` son dos vías independientes, ninguna de
-- las dos alcanza sola).
--
-- Misma firma, mismas columnas de retorno, mismo tipo de retorno
-- (`returns table (...)`): `create or replace function` con la firma
-- intacta SÍ permite cambiar de `language sql` a `language plpgsql` --
-- verificado contra esta base antes de escribir esta migración (el lenguaje
-- es un atributo de implementación, no parte de la firma; lo único que
-- `create or replace` prohíbe tocar sin dropear es el tipo de retorno y los
-- tipos de los argumentos). No hace falta un `drop` + `create` aparte.
--
-- Semántica intacta, a propósito, con lo que ya hacía la función vieja:
-- AND entre términos, sin acentos/mayúsculas (`immutable_unaccent(lower(...))`,
-- mismo wrapper que ya usan products.search_text/contacts.search_text),
-- excluye `message_type = 'system_event'` y `content is null`, una fila por
-- conversación con el mensaje que calza más reciente, `p_limit <= 0` -> cero
-- filas (`greatest(p_limit, 0)`, igual que antes). Comodines de LIKE
-- (`%`, `_`, `\`) SIN escapar en el término del asesor: comportamiento SIN
-- CAMBIOS respecto a la función vieja, que ya armaba el patrón como
-- `'%' || término || '%'` sin escapar nada -- esta tarea no lo arregla
-- porque no era el bug reportado y cambiaría semántica que nadie pidió
-- tocar; queda documentado acá y en la cabecera del test.
--
-- `set local lock_timeout = '5s'` + guarda contra el no-op silencioso +
-- `notify pgrst` -- mismo patrón que las migraciones desde 20260916010000
-- (ver CLAUDE.md, "El trigger AFTER dejó con rastro..." y "Las cinco
-- migraciones de Seba/catálogo/factura..."): sin `psql -1 -v
-- ON_ERROR_STOP=1`, `set local` es un no-op y PostgREST seguiría sirviendo
-- el esquema cacheado con la función vieja hasta que alguien lo recargue a
-- mano.
-- ============================================================================
set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

create or replace function public.search_conversations_by_message(
  p_query text,
  p_limit integer default 40
)
returns table (
  conversation_id uuid,
  message_id uuid,
  content text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $fn$
declare
  pats text[];
begin
  -- El chequeo de RLS, UNA sola vez -- reemplaza a la política
  -- `messages_all using (is_agent())`, que con la función vieja (security
  -- invoker) se evaluaba una vez POR FILA dentro del Seq/Function Scan.
  if not public.is_agent() then
    return;
  end if;

  select array_agg('%' || t || '%') into pats
  from unnest(
    string_to_array(
      regexp_replace(trim(public.immutable_unaccent(lower(p_query))), '\s+', ' ', 'g'),
      ' '
    )
  ) t
  where t <> '';

  -- Sin términos de verdad (p_query vacío o solo espacios): cero filas,
  -- igual que la función vieja (su `exists (select 1 from terms where term
  -- <> '')` daba false y el `not exists` que envolvía todo quedaba
  -- vacuamente cierto sobre CERO filas calzadas -- mismo resultado neto,
  -- expresado acá como un corte explícito en vez de un artefacto lógico).
  if pats is null then
    return;
  end if;

  return query
  select h.conversation_id, h.message_id, h.content, h.created_at from (
    select distinct on (m.conversation_id)
      m.conversation_id,
      m.id as message_id,
      m.content,
      m.created_at
    from public.messages m
    where m.message_type <> 'system_event'
      and m.content is not null
      and m.search_text like all (pats)
    order by m.conversation_id, m.created_at desc
  ) h
  order by h.created_at desc
  limit greatest(p_limit, 0);
end;
$fn$;

comment on function public.search_conversations_by_message(text, integer) is
  'Conversaciones cuyo historial contiene todas las palabras buscadas, con el mensaje coincidente más reciente de cada una. security definer desde 20260921030000: is_agent() se comprueba UNA vez al entrar (no por fila vía RLS) y el filtro LIKE ALL sobre un arreglo constante sí lo puede usar el índice GIN trigram de messages.search_text -- la versión vieja (security invoker, filtro correlacionado por subconsulta) tardaba ~1-1,5 s como authenticated contra ~100.000-115.000 mensajes; esta, 20-140 ms.';

-- Los DOS revokes por firma (ver CLAUDE.md): el EXECUTE de fábrica de
-- Postgres a PUBLIC, y el alter default privileges de Supabase a
-- anon/authenticated. Sin las dos sentencias, anon sigue pudiendo ejecutar
-- una función security definer que ahora bypassa RLS por completo si
-- alguna de las dos vías queda abierta.
revoke execute on function public.search_conversations_by_message(text, integer) from public;
revoke execute on function public.search_conversations_by_message(text, integer) from anon, authenticated;

-- Grant explícito a quien debe conservar el acceso: authenticated (la llama
-- el navegador con sesión, inbox-sidebar.tsx) y service_role (mismo grant
-- que ya traía la función desde 20260822110000, por si algún día se llama
-- desde el servidor).
grant execute on function public.search_conversations_by_message(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (pg_proc/has_function_privilege),
-- no el texto de este archivo.
-- ---------------------------------------------------------------------------
do $$
declare
  v_prosecdef boolean;
  v_prolang text;
begin
  select p.prosecdef, l.lanname into v_prosecdef, v_prolang
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  where p.oid = 'public.search_conversations_by_message(text, integer)'::regprocedure;

  if v_prosecdef is distinct from true then
    raise exception '20260921030000: search_conversations_by_message no quedó security definer.';
  end if;

  if v_prolang is distinct from 'plpgsql' then
    raise exception '20260921030000: search_conversations_by_message no quedó en plpgsql, encontró %.', v_prolang;
  end if;

  if has_function_privilege('anon', 'public.search_conversations_by_message(text, integer)', 'execute') then
    raise exception '20260921030000: anon todavía puede ejecutar search_conversations_by_message() -- faltó uno de los dos revokes.';
  end if;

  if not has_function_privilege('authenticated', 'public.search_conversations_by_message(text, integer)', 'execute') then
    raise exception '20260921030000: authenticated NO puede ejecutar search_conversations_by_message() -- la bandeja se queda sin buscador.';
  end if;

  if not has_function_privilege('service_role', 'public.search_conversations_by_message(text, integer)', 'execute') then
    raise exception '20260921030000: service_role NO puede ejecutar search_conversations_by_message().';
  end if;

  raise notice '20260921030000: autoverificación de search_conversations_by_message (security definer, plpgsql, permisos) correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado -- una función
-- reemplazada con create or replace no cambia de OID, pero el cache de
-- PostgREST también guarda la firma de permisos/security definer que
-- acabamos de tocar.
notify pgrst, 'reload schema';
