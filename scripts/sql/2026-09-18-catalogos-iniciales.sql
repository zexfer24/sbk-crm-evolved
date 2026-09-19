-- ============================================================================
-- Carga inicial de "Un solo catálogo" (D8, tarea T2, plan "Nada sin leer, un
-- solo catálogo y la factura Saint", 18/9/2026).
--
-- QUÉ HACE: en UNA transacción, (1) inserta en `public.catalog_links` los 8
-- enlaces vigentes de producción (7 del escenario "Catálogo general" —
-- Cascos, Resonadores, Maletas, Exploradoras y Bombillos, Defensas,
-- Lubricantes ×2— más Ubicación) y (2) reemplaza la URL de Google Drive
-- pegada a mano por su marcador (`{{catalogo:<key>}}`/`{{catalogos}}`,
-- `src/lib/catalog-links.ts`) en los 3 escenarios y los 4 mensajes rápidos
-- que hoy la llevan escrita.
--
-- QUIÉN LO COMPLETA Y LO CORRE: el Claude del VPS, DESPUÉS de desplegar el
-- código de esta corrida (nunca antes: D4/D6 hacen que un marcador sin
-- resolver quede tal cual en el texto en vez de romper nada, pero un
-- marcador sin código que lo resuelva es peor que la URL vieja que
-- reemplaza — orden obligatorio: código primero, script después, riesgo
-- documentado en la sección 5 del plan). Los IDs y las URLs exactas de
-- producción NO están en este repo a propósito (D8: "el contenido es del
-- cliente, no del repo") — este archivo llega con marcadores `<<...>>` que
-- el Claude del VPS completa contra la base real, revisa y recién entonces
-- ejecuta. NINGÚN valor de este archivo fue inventado por el implementador
-- de T2: donde el plan no traía el dato exacto, quedó el marcador.
--
-- PARA ENCONTRAR LOS VALORES REALES, correr antes en la base de producción
-- (no se ejecutan solas, son de consulta):
--
--   select id, name, left(response_text, 80) as inicio
--     from ai_playbooks
--     where response_text ilike '%drive.google.com%' or name ilike '%catalog%' or name ilike '%ubicac%'
--     order by name;
--
--   select id, label, left(content, 80) as inicio
--     from quick_replies
--     where content ilike '%drive.google.com%'
--     order by label;
--
-- Con esas filas a la vista: copiar cada `id` (uuid) y el TEXTO COMPLETO de
-- `response_text`/`content` con la URL ya cambiada por el marcador que
-- corresponda, y pegarlos en las tablas de relleno de la sección 1 de acá
-- abajo.
--
-- PREGUNTA PENDIENTE PARA EL CLIENTE (D8, frena el script, no el código):
-- "Lubricantes" aparece DOS VECES en el escenario "Catálogo general", con
-- dos archivos de Drive distintos — ¿son dos catálogos reales o quedó uno
-- viejo sin borrar? Hasta que el cliente responda, este script carga los
-- DOS como `lubricantes` y `lubricantes-2` (mismo criterio que hoy, que
-- también manda las dos URLs).
--
-- CÓMO CORRERLO (mismo patrón que `docs/PRODUCCION.md` para migraciones con
-- guardas propias — `-1` es una sola transacción, `-v ON_ERROR_STOP=1` para
-- que una falla a mitad de archivo no deje nada aplicado a medias):
--
--   docker exec -i supabase-db psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 \
--     -f - < scripts/sql/2026-09-18-catalogos-iniciales.sql
--
-- VERIFICACIÓN: el bloque final (sección 6) falla el script entero si, tras
-- el reemplazo, cualquiera de las 3 filas de `ai_playbooks` o las 4 de
-- `quick_replies` tocadas todavía contiene `drive.google.com` — no basta con
-- que el `update` haya corrido, tiene que haber reemplazado la URL de
-- verdad.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) DATOS DE RELLENO — editar SOLO acá, con los valores reales de
--    producción. El resto del script no se toca.
-- ---------------------------------------------------------------------------

create temporary table _catalogo_valores (
  key text primary key,
  label text not null,
  url text not null,
  sort_order integer not null
) on commit drop;

insert into _catalogo_valores (key, label, url, sort_order) values
  ('cascos', 'Cascos', '<<URL_CASCOS>>', 1),
  ('resonadores', 'Resonadores', '<<URL_RESONADORES>>', 2),
  ('maletas', 'Maletas', '<<URL_MALETAS>>', 3),
  ('exploradoras-y-bombillos', 'Exploradoras y Bombillos', '<<URL_EXPLORADORAS_Y_BOMBILLOS>>', 4),
  ('defensas', 'Defensas', '<<URL_DEFENSAS>>', 5),
  -- "Lubricantes" ×2 — ver la pregunta pendiente para el cliente, más arriba.
  ('lubricantes', 'Lubricantes', '<<URL_LUBRICANTES>>', 6),
  ('lubricantes-2', 'Lubricantes (2)', '<<URL_LUBRICANTES_2>>', 7),
  -- Ubicación no es parte de "Catálogo general": es su propio escenario, y
  -- sort_order 99 la deja siempre al final de `{{catalogos}}`.
  ('ubicacion', 'Ubicación', '<<URL_UBICACION>>', 99);

-- `id_texto` es TEXT a propósito (no uuid): si queda un marcador `<<...>>`
-- sin completar, la guarda de la sección 2 lo detecta con un mensaje claro
-- ANTES de que un `::uuid` sin resolver tire un error de casteo genérico.
create temporary table _escenarios_valores (
  escenario text primary key,
  id_texto text not null,
  texto_nuevo text not null
) on commit drop;

insert into _escenarios_valores (escenario, id_texto, texto_nuevo) values
  ('CATALOGO CASCOS', '<<ID_ESCENARIO_CATALOGO_CASCOS>>', '<<TEXTO_ESCENARIO_CATALOGO_CASCOS>>'),
  -- D4: el texto de "Catálogo general" pasa a ser su frase de siempre +
  -- `{{catalogos}}` (la lista completa), en vez de las siete URLs pegadas.
  ('Catálogo general', '<<ID_ESCENARIO_CATALOGO_GENERAL>>', '<<TEXTO_ESCENARIO_CATALOGO_GENERAL>>'),
  ('Ubicación', '<<ID_ESCENARIO_UBICACION>>', '<<TEXTO_ESCENARIO_UBICACION>>');

create temporary table _mensajes_rapidos_valores (
  mensaje_rapido text primary key,
  id_texto text not null,
  texto_nuevo text not null
) on commit drop;

insert into _mensajes_rapidos_valores (mensaje_rapido, id_texto, texto_nuevo) values
  ('mensaje rápido 1', '<<ID_MENSAJE_RAPIDO_1>>', '<<TEXTO_MENSAJE_RAPIDO_1>>'),
  ('mensaje rápido 2', '<<ID_MENSAJE_RAPIDO_2>>', '<<TEXTO_MENSAJE_RAPIDO_2>>'),
  ('mensaje rápido 3', '<<ID_MENSAJE_RAPIDO_3>>', '<<TEXTO_MENSAJE_RAPIDO_3>>'),
  ('mensaje rápido 4', '<<ID_MENSAJE_RAPIDO_4>>', '<<TEXTO_MENSAJE_RAPIDO_4>>');

-- ---------------------------------------------------------------------------
-- 2) GUARDA — aborta el script ENTERO si queda algún marcador `<<...>>` sin
--    completar en cualquiera de las tres tablas de relleno de arriba. Esto
--    es lo que impide correr el script "a medias", con el repo tal como lo
--    entrega este commit.
-- ---------------------------------------------------------------------------

do $$
declare
  v_pendientes text;
begin
  select string_agg(campo, ', ' order by campo) into v_pendientes
  from (
    select 'catalog_links.' || key as campo
      from _catalogo_valores
      where label like '%<<%' or url like '%<<%'
    union all
    select 'ai_playbooks.' || escenario
      from _escenarios_valores
      where id_texto like '%<<%' or texto_nuevo like '%<<%'
    union all
    select 'quick_replies.' || mensaje_rapido
      from _mensajes_rapidos_valores
      where id_texto like '%<<%' or texto_nuevo like '%<<%'
  ) as pendientes;

  if v_pendientes is not null then
    raise exception 'scripts/sql/2026-09-18-catalogos-iniciales.sql: quedan marcadores "<<...>>" sin completar en: %. Complétalo contra la base real de producción antes de reintentar -- no se escribió nada.', v_pendientes;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3) Carga de los 8 catálogos.
-- ---------------------------------------------------------------------------

insert into public.catalog_links (key, label, url, sort_order)
select key, label, url, sort_order from _catalogo_valores;

-- ---------------------------------------------------------------------------
-- 4) Reemplazo de la URL pegada a mano por el marcador en los 3 escenarios.
-- ---------------------------------------------------------------------------

update public.ai_playbooks p
set response_text = v.texto_nuevo
from _escenarios_valores v
where p.id = v.id_texto::uuid;

-- ---------------------------------------------------------------------------
-- 5) Reemplazo en los 4 mensajes rápidos.
-- ---------------------------------------------------------------------------

update public.quick_replies q
set content = v.texto_nuevo
from _mensajes_rapidos_valores v
where q.id = v.id_texto::uuid;

-- ---------------------------------------------------------------------------
-- 6) Verificación final — ninguna de las filas TOCADAS puede seguir con una
--    URL de drive.google.com cruda: si el reemplazo de la sección 4/5 no
--    surtió efecto de verdad (id equivocado, texto de relleno que todavía
--    trae la URL vieja pegada al lado del marcador, etc.), el script entero
--    falla y no queda nada a medias.
-- ---------------------------------------------------------------------------

do $$
declare
  v_restantes integer;
begin
  select count(*) into v_restantes
  from public.ai_playbooks p
  join _escenarios_valores v on v.id_texto::uuid = p.id
  where p.response_text ilike '%drive.google.com%';

  if v_restantes > 0 then
    raise exception 'Quedan % escenario(s) de ai_playbooks con una URL de drive.google.com sin reemplazar por el marcador.', v_restantes;
  end if;

  select count(*) into v_restantes
  from public.quick_replies q
  join _mensajes_rapidos_valores v on v.id_texto::uuid = q.id
  where q.content ilike '%drive.google.com%';

  if v_restantes > 0 then
    raise exception 'Quedan % mensaje(s) rápido(s) de quick_replies con una URL de drive.google.com sin reemplazar por el marcador.', v_restantes;
  end if;

  raise notice 'Carga inicial de catalog_links (8 filas) y reemplazo de marcadores en 3 escenarios + 4 mensajes rápidos: verificado, sin drive.google.com pendiente.';
end
$$;

commit;
