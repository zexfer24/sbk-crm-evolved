-- ============================================================================
-- Carga inicial de "Un solo catálogo" (D8, tarea T2, plan "Nada sin leer, un
-- solo catálogo y la factura Saint", 18/9/2026).
--
-- QUÉ HACE: en UNA transacción, (1) inserta en `public.catalog_links` los 7
-- enlaces de Google Drive vigentes de producción, los que forman el
-- escenario "Catálogo general" (Cascos, Resonadores, Maletas, Exploradoras y
-- Bombillos, Defensas, Lubricantes ×2) y (2) reemplaza la URL pegada a mano
-- por su marcador (`{{catalogo:<key>}}`/`{{catalogos}}`,
-- `src/lib/catalog-links.ts`) en los 2 escenarios y los 4 mensajes rápidos
-- que hoy la llevan escrita.
--
-- DECISIÓN DE LA REVISIÓN `code-review high` DEL 19/9/2026 (punto 3):
-- "Ubicación" QUEDA FUERA de este script. La primera versión cargaba el
-- Maps de la tienda como un catálogo más (`ubicacion`, sort_order 99) y
-- reemplazaba también el escenario "Ubicación" por
-- `{{catalogo:ubicacion}}`. Eso metía la ubicación DENTRO de
-- `{{catalogos}}` (`formatCatalogList` lista TODO enlace activo): el
-- cliente habría recibido "• Ubicación: https://maps…" mezclado con la
-- lista de catálogos de repuestos, y apagar esa clave para sacarla de la
-- lista habría dejado sin resolver al escenario "Ubicación" (D6). El enlace
-- de Maps de la tienda tampoco rota como los de Drive (no tiene el problema
-- que esta corrida resuelve), así que no gana nada entrando a la tabla. Se
-- deja como estaba: el escenario "Ubicación" conserva su URL escrita a
-- mano, y este script no lo toca. Consecuencia en los conteos: 7 catálogos
-- (no 8) y 2 escenarios tocados (no 3) — el punto 2 de la revisión (más
-- abajo, secciones 2/4/6) verifica esos números CONTRA el tamaño real de
-- las tablas de relleno, así que un ajuste futuro de estos conteos no
-- exige tocar la guarda a mano. Si algún día se necesita distinguir un
-- enlace que NO deba entrar en `{{catalogos}}` (como este caso) de uno que
-- sí, hace falta una columna nueva (`in_list boolean`, por ejemplo) — eso
-- es una migración y una corrida aparte; por ahora "no entra a la tabla" ya
-- resuelve el caso real que había hoy.
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
--     where response_text ilike '%drive.google.com%' or name ilike '%catalog%'
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
-- VERIFICACIÓN (reforzada en la revisión del 19/9/2026, punto 2): antes, los
-- UPDATE de las secciones 4/5 nunca comprobaban cuántas filas tocaron de
-- verdad — con un `id` que no existe en ESTA base (copiado de otro
-- entorno, o mal pegado), el UPDATE afecta CERO filas sin avisar nada, y el
-- chequeo final de la sección 6 (que unía por el mismo id) tampoco lo
-- notaba: un JOIN contra una fila inexistente no aporta ninguna fila al
-- conteo de "pendientes", así que "cero pendientes" pasaba igual aunque no
-- se hubiera escrito nada. Ahora cada UPDATE corre dentro de su propio `do
-- $$ ... $$` para poder leer `GET DIAGNOSTICS ... = ROW_COUNT` en el mismo
-- bloque (fuera de un bloque PL/pgSQL no se puede leer el conteo de un
-- UPDATE suelto) y aborta si no coincide EXACTO con la cantidad de filas de
-- relleno; y la sección 6 pasó de "¿cuántas de las filas unidas quedaron
-- con drive.google.com?" a "¿cuántas de las filas de relleno tienen HOY una
-- fila real sin drive.google.com?" — la resta entre esos dos números es
-- distinta de cero tanto si la URL no se reemplazó como si el `id` no
-- corresponde a ninguna fila.
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
  ('lubricantes-2', 'Lubricantes (2)', '<<URL_LUBRICANTES_2>>', 7);
  -- "Ubicación" NO entra acá — ver la decisión fechada 19/9/2026 en la
  -- cabecera del archivo (punto 3 de la revisión): mezclarla en
  -- `{{catalogos}}` la habría colado dentro de la lista de catálogos de
  -- repuestos, y el Maps de la tienda no tiene el problema de rotación que
  -- esta corrida resuelve.

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
  ('Catálogo general', '<<ID_ESCENARIO_CATALOGO_GENERAL>>', '<<TEXTO_ESCENARIO_CATALOGO_GENERAL>>');
  -- El escenario "Ubicación" NO se toca (ver la decisión de la cabecera):
  -- conserva su URL de Maps escrita a mano, tal como está hoy en producción.

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
-- 3) Carga de los 7 catálogos.
-- ---------------------------------------------------------------------------

insert into public.catalog_links (key, label, url, sort_order)
select key, label, url, sort_order from _catalogo_valores;

-- ---------------------------------------------------------------------------
-- 4) Reemplazo de la URL pegada a mano por el marcador en los 2 escenarios.
--    Corre DENTRO de un `do $$ ... $$` (punto 2 de la revisión, 19/9/2026)
--    para poder leer `GET DIAGNOSTICS ... = ROW_COUNT` del UPDATE en el
--    mismo bloque y comparar contra cuántas filas de relleno había: un
--    `id_texto` que no exista en ESTA base afecta menos filas de las
--    esperadas y el script aborta ahí mismo, en vez de seguir de largo
--    creyendo que ya reemplazó algo que nunca tocó.
-- ---------------------------------------------------------------------------

do $$
declare
  v_afectadas integer;
  v_esperadas integer;
begin
  update public.ai_playbooks p
  set response_text = v.texto_nuevo
  from _escenarios_valores v
  where p.id = v.id_texto::uuid;

  get diagnostics v_afectadas = row_count;
  select count(*) into v_esperadas from _escenarios_valores;

  if v_afectadas <> v_esperadas then
    raise exception 'El UPDATE de ai_playbooks tocó % fila(s) pero se esperaban % (uno por escenario en _escenarios_valores) -- revisa que esos "id_texto" existan de verdad en esta base (¿un id copiado de otro entorno?).', v_afectadas, v_esperadas;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5) Reemplazo en los 4 mensajes rápidos. Mismo patrón que la sección 4.
-- ---------------------------------------------------------------------------

do $$
declare
  v_afectadas integer;
  v_esperadas integer;
begin
  update public.quick_replies q
  set content = v.texto_nuevo
  from _mensajes_rapidos_valores v
  where q.id = v.id_texto::uuid;

  get diagnostics v_afectadas = row_count;
  select count(*) into v_esperadas from _mensajes_rapidos_valores;

  if v_afectadas <> v_esperadas then
    raise exception 'El UPDATE de quick_replies tocó % fila(s) pero se esperaban % (uno por mensaje rápido en _mensajes_rapidos_valores) -- revisa que esos "id_texto" existan de verdad en esta base.', v_afectadas, v_esperadas;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6) Verificación final — reforzada en la revisión del 19/9/2026 (punto 2):
--    ya no cuenta "cuántas filas UNIDAS todavía tienen drive.google.com"
--    (un id inexistente no aporta ninguna fila al JOIN y el conteo daba
--    cero pendientes igual, sin haber verificado nada); ahora cuenta
--    "cuántas de las filas de relleno tienen HOY una fila real, sin
--    drive.google.com" y la compara contra el total esperado. Cualquier
--    diferencia — URL que no se reemplazó O id que no corresponde a
--    ninguna fila — hace fallar el script entero, sin dejar nada a medias.
--    "Ubicación" (Maps) queda fuera de este chequeo a propósito: no está en
--    `_escenarios_valores`, así que un `maps.app.goo.gl` ahí nunca contó ni
--    contará como pendiente.
-- ---------------------------------------------------------------------------

do $$
declare
  v_esperadas integer;
  v_verificadas integer;
begin
  select count(*) into v_esperadas from _escenarios_valores;
  select count(*) into v_verificadas
    from public.ai_playbooks p
    join _escenarios_valores v on v.id_texto::uuid = p.id
    where p.response_text not ilike '%drive.google.com%';

  if v_verificadas <> v_esperadas then
    raise exception 'Verificación de ai_playbooks: % de % escenario(s) esperados quedaron SIN drive.google.com (revisa ids inexistentes o reemplazos que no surtieron efecto).', v_verificadas, v_esperadas;
  end if;

  select count(*) into v_esperadas from _mensajes_rapidos_valores;
  select count(*) into v_verificadas
    from public.quick_replies q
    join _mensajes_rapidos_valores v on v.id_texto::uuid = q.id
    where q.content not ilike '%drive.google.com%';

  if v_verificadas <> v_esperadas then
    raise exception 'Verificación de quick_replies: % de % mensaje(s) rápido(s) esperados quedaron SIN drive.google.com (revisa ids inexistentes o reemplazos que no surtieron efecto).', v_verificadas, v_esperadas;
  end if;

  raise notice 'Carga inicial de catalog_links (7 filas) y reemplazo de marcadores en 2 escenarios + 4 mensajes rápidos: verificado, sin drive.google.com pendiente.';
end
$$;

commit;
