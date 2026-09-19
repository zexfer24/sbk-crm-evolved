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
-- ENDURECIDO el 19/9/2026 (T6, plan "Seba sale sin pisar a nadie", hallazgo
-- M2 de la inspección pre-despliegue): esta primera versión (commit del
-- 18/9) tenía cuatro huecos que solo se iban a notar corriéndola de verdad
-- contra la base del cliente, con el operador mirando:
--   (a) `\set ON_ERROR_STOP on` ahora vive DENTRO del archivo. Sin `-1 -v
--       ON_ERROR_STOP=1` en la línea de comandos (un copy-paste incompleto,
--       o correrlo con `\i` desde una sesión interactiva de psql), una
--       sentencia rota a mitad de archivo —el caso real: una comilla simple
--       sin escapar dentro del texto pegado— pasaba de largo y el script
--       terminaba con `rc=0` sin haber escrito nada, un falso éxito. Esta
--       línea hace que psql aborte solo con que el archivo se ejecute,
--       tenga o no el flag el que lo invoca (ver CLAUDE.md, "Aplicar esta
--       migración a mano exige `psql -1 -v ON_ERROR_STOP=1`" — mismo
--       mecanismo, esta vez la guarda va en el propio script, no solo en la
--       receta).
--   (b) Los huecos `<<TEXTO_...>>` de escenarios y mensajes rápidos pasan de
--       `'<<...>>'` (comilla simple) a `$txt$<<...>>$txt$` (dollar-quoting).
--       Es la causa real de (a): el texto que manda el cliente casi siempre
--       trae una tilde o un "no sé", y una comilla simple sin escapar
--       adentro de un literal `'...'` corta el literal a la mitad y rompe
--       la sintaxis del INSERT completo. Con `$txt$...$txt$` una comilla
--       simple es un carácter más, sin escapar nada.
--   (c) Aserción nueva (sección 2b): toda clave `{{catalogo:<key>}}` que
--       aparezca DENTRO de los textos nuevos de escenarios/mensajes rápidos
--       tiene que existir en `_catalogo_valores` (lo que este script va a
--       cargar) o ya estar ACTIVA en `catalog_links` (un catálogo que el
--       supervisor ya haya creado desde el panel). Antes de esta sección el
--       script podía "verificar" un escenario que apuntaba a una clave que
--       nunca iba a resolver nada — el texto se guardaba igual y
--       `resolveCatalogMarkers` lo iba a dejar tal cual (D6, marcador sin
--       resolver) recién cuando la IA intentara mandarlo, mucho después de
--       correr este script.
--   (d) `on conflict (key) do nothing` + un `NOTICE` por cada clave saltada,
--       con su URL ACTUAL (D-C, decisión del operador del 19/9/2026): un
--       supervisor puede haber creado ya una de estas siete claves desde el
--       panel de Control IA con una URL más nueva que la de este script (los
--       IDs de Drive rotan); pisarla a ciegas perdería esa URL más nueva.
--       El script ya no muere con "duplicate key" en una segunda corrida, y
--       el `NOTICE` le da al Claude del VPS lo que necesita para decidir si
--       hace falta actualizar esa fila a mano.
--   (e) La verificación final (sección 6) suma un aviso informativo (6b)
--       que también mira `attachment_url` de `ai_playbooks` (columna que
--       `response_text`/`content` no cubren y que este script NUNCA
--       escribe) buscando URLs de Drive viejas — tanto en los dos
--       escenarios que este script sí toca como, en barrido amplio, en
--       CUALQUIER escenario o mensaje rápido de la base. Es solo un
--       `NOTICE`, no aborta: son filas fuera del alcance de este script
--       (`quick_replies` ni siquiera tiene columna `attachment_url`), y
--       fallar el script entero por algo que no le corresponde arreglar
--       sería peor que avisar y seguir.
--
-- CORREGIDO el 19/9/2026, `code-review high` sobre T6 (hallazgos 7a y 7b de
-- la revisión): la primera versión de este endurecimiento tenía dos huecos
-- propios, encontrados releyendo el script contra `on conflict (key) do
-- nothing` y contra `CATALOG_MARKER`/`LOOSE_UNRESOLVED_MARKER`
-- (`src/lib/catalog-links.ts`), no corriéndolo:
--   (f) Hallazgo 7a — la aserción 2b (arriba, punto (c)) daba por resuelta
--       cualquier clave presente en `_catalogo_valores`, asumiendo que el
--       INSERT de la sección 3 la iba a dejar ACTIVA. Pero con `on conflict
--       (key) do nothing` (D-C), si la clave YA existe en `catalog_links`
--       —el supervisor la creó desde el panel, e INACTIVA, por lo que
--       sea— el conflicto la deja EXACTAMENTE como estaba: 2b decía
--       "verificado" antes de escribir una sola fila, sin que la clave
--       fuera a resolver nunca (`resolveCatalogMarkers` solo lee enlaces
--       ACTIVOS). El NOTICE de la sección 3 ahora dice si la fila existente
--       que se conserva está ACTIVA o INACTIVA, y una aserción NUEVA
--       (sección 3b) corre DESPUÉS del INSERT real y ANTES de tocar
--       `ai_playbooks`/`quick_replies`: vuelve a mirar la base con el
--       estado YA DEFINITIVO de cada clave y aborta si alguna referenciada
--       sigue sin estar activa — sin activarla por su cuenta (D-C: el
--       script no pisa lo del panel; activar es una decisión humana).
--   (g) Hallazgo 7b — la aserción 2b solo captura claves que calzan la
--       forma ESTRICTA (`[a-z0-9-]+` entre `{{catalogo: … }}`), la misma
--       que usa `CATALOG_MARKER` en TypeScript. Un marcador mal escrito
--       —`{{catalogo:cascos_nuevos}}` (guion bajo, fuera del alfabeto
--       permitido), `{{catalogo: exploradoras y bombillos}}` (espacios
--       dentro de la clave)— sencillamente no calzaba ESA regex, así que
--       nunca aparecía en la lista de "claves referenciadas": el texto se
--       guardaba tal cual, creyendo que había "verificado" algo, y en
--       producción ese marcador jamás iba a resolver (D6: fase 0 lo saca
--       de los candidatos en cada turno con `escenarios_enlace_sin_resolver`,
--       o el mensaje rápido lo pega crudo). La sección 2c (nueva) es el
--       espejo SQL de `LOOSE_UNRESOLVED_MARKER`: detecta cualquier resto
--       que empiece como `{{catalogo`/`{{catalogos` (cualquier
--       capitalización o acento, con o sin cerrar) y que NO calce ni la
--       forma estricta de un marcador puntual ni la de `{{catalogos}}` —y
--       aborta nombrando el texto sospechoso.
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
-- que una falla a mitad de archivo no deje nada aplicado a medias; desde el
-- 19/9/2026 el archivo también trae su propio `\set ON_ERROR_STOP on` como
-- segunda guarda, pero el flag de la línea de comandos sigue siendo la
-- receta oficial — no depender solo del contenido del archivo):
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

-- Segunda guarda contra el falso éxito (endurecimiento (a) de arriba,
-- 19/9/2026): si quien corre esto olvidó `-v ON_ERROR_STOP=1` en la línea de
-- comandos, esta línea lo deja igual de protegido. Un metacomando de psql,
-- no SQL -- tiene que ir ANTES de cualquier sentencia, fuera de la
-- transacción.
\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- 1) DATOS DE RELLENO — editar SOLO acá, con los valores reales de
--    producción. El resto del script no se toca.
--
--    `texto_nuevo` usa dollar-quoting (`$txt$…$txt$`, endurecimiento (b) de
--    la cabecera) en vez de comillas simples: pegar el texto real de un
--    escenario o mensaje rápido con una tilde, un "no sé" o cualquier
--    apóstrofo sin escapar ya NO rompe el INSERT a mitad de camino.
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
  ('CATALOGO CASCOS', '<<ID_ESCENARIO_CATALOGO_CASCOS>>', $txt$<<TEXTO_ESCENARIO_CATALOGO_CASCOS>>$txt$),
  -- D4: el texto de "Catálogo general" pasa a ser su frase de siempre +
  -- `{{catalogos}}` (la lista completa), en vez de las siete URLs pegadas.
  ('Catálogo general', '<<ID_ESCENARIO_CATALOGO_GENERAL>>', $txt$<<TEXTO_ESCENARIO_CATALOGO_GENERAL>>$txt$);
  -- El escenario "Ubicación" NO se toca (ver la decisión de la cabecera):
  -- conserva su URL de Maps escrita a mano, tal como está hoy en producción.

create temporary table _mensajes_rapidos_valores (
  mensaje_rapido text primary key,
  id_texto text not null,
  texto_nuevo text not null
) on commit drop;

insert into _mensajes_rapidos_valores (mensaje_rapido, id_texto, texto_nuevo) values
  ('mensaje rápido 1', '<<ID_MENSAJE_RAPIDO_1>>', $txt$<<TEXTO_MENSAJE_RAPIDO_1>>$txt$),
  ('mensaje rápido 2', '<<ID_MENSAJE_RAPIDO_2>>', $txt$<<TEXTO_MENSAJE_RAPIDO_2>>$txt$),
  ('mensaje rápido 3', '<<ID_MENSAJE_RAPIDO_3>>', $txt$<<TEXTO_MENSAJE_RAPIDO_3>>$txt$),
  ('mensaje rápido 4', '<<ID_MENSAJE_RAPIDO_4>>', $txt$<<TEXTO_MENSAJE_RAPIDO_4>>$txt$);

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
-- 2b) ASERCIÓN NUEVA (endurecimiento (c), 19/9/2026, T6) — toda clave
--     `{{catalogo:<key>}}` que aparezca dentro de los textos nuevos de
--     escenarios y mensajes rápidos tiene que resolver a algo: o está en
--     `_catalogo_valores` (lo que la sección 3 va a insertar) o ya está
--     ACTIVA en `catalog_links` (un catálogo que un supervisor ya haya
--     creado desde el panel). Mismo regex que `CATALOG_MARKER`
--     (`src/lib/catalog-links.ts`) -- `cat[aá]logo` con flag `i`, así que la
--     clave capturada se compara en minúsculas igual que hace
--     `resolveCatalogMarkers` (`rawKey.toLowerCase()`).
--
--     Sin esta aserción el script podía dar "verificado" (sección 6, que
--     solo mira que no quede `drive.google.com` en el texto) sobre un
--     escenario que en realidad apunta a una clave que NUNCA va a
--     resolver nada -- el marcador queda sin resolver recién cuando la IA
--     intenta mandarlo (D6), mucho después de que este script terminó.
-- ---------------------------------------------------------------------------

do $$
declare
  v_pendientes text;
begin
  select string_agg(distinct clave, ', ' order by clave) into v_pendientes
  from (
    select lower(m[1]) as clave
      from _escenarios_valores v,
           regexp_matches(v.texto_nuevo, '\{\{\s*cat[aá]logo\s*:\s*([a-z0-9-]+)\s*\}\}', 'gi') as m
    union all
    select lower(m[1]) as clave
      from _mensajes_rapidos_valores v,
           regexp_matches(v.texto_nuevo, '\{\{\s*cat[aá]logo\s*:\s*([a-z0-9-]+)\s*\}\}', 'gi') as m
  ) as referenciadas
  where clave not in (select key from _catalogo_valores)
    and clave not in (select key from public.catalog_links where is_active);

  if v_pendientes is not null then
    raise exception 'scripts/sql/2026-09-18-catalogos-iniciales.sql: los textos nuevos referencian {{catalogo:<key>}} con clave(s) que no existen en _catalogo_valores ni están activas en catalog_links: %. Agrégalas a la sección 1 (o corrige la clave escrita en el texto) -- no se escribió nada.', v_pendientes;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2c) ASERCIÓN NUEVA (corrección del 19/9/2026, `code-review high`,
--     hallazgo 7b sobre T6) — 2b solo mira coincidencias con la forma
--     ESTRICTA de un marcador (`\{\{\s*cat[aá]logo\s*:\s*([a-z0-9-]+)\s*\}\}`,
--     el mismo patrón que `CATALOG_MARKER` en `src/lib/catalog-links.ts`):
--     un marcador mal escrito no calza esa regex y por eso 2b ni lo veía.
--     Ejemplos reales que 2b deja pasar sin avisar nada:
--     `{{catalogo:cascos_nuevos}}` (guion bajo, fuera de `[a-z0-9-]+`),
--     `{{catalogo: exploradoras y bombillos}}` (espacios dentro de la
--     clave, no solo alrededor del `:`). Ese texto se guardaría tal cual y
--     en producción nunca resuelve nada (D6): fase 0 lo saca de los
--     candidatos en cada turno con `escenarios_enlace_sin_resolver`, o el
--     mensaje rápido lo pega crudo por WhatsApp.
--
--     Espejo de `LOOSE_UNRESOLVED_MARKER` (`src/lib/catalog-links.ts`):
--     busca cualquier resto que empiece como `{{catalogo`/`{{catalogos`
--     (cualquier capitalización o acento en la palabra, con o sin cerrar)
--     y lo deja pasar SOLO si calza exactamente la forma estricta de un
--     marcador puntual (`{{catalogo:<key>}}`, la misma regex de 2b) o la
--     de `{{catalogos}}` (la lista completa) — cualquier otra cosa aborta
--     el script, nombrando el texto sospechoso tal cual apareció (recortado
--     a 60 caracteres, mismo tope que usa `resolveCatalogMarkers` en
--     TypeScript para su versión de `missing`).
-- ---------------------------------------------------------------------------

do $$
declare
  v_pendientes text;
begin
  select string_agg(distinct left(bruto, 60), ', ' order by left(bruto, 60)) into v_pendientes
  from (
    select m[1] as bruto
      from _escenarios_valores v,
           regexp_matches(v.texto_nuevo, '\{\{\s*cat[aá]logos?\M[^}]*\}?\}?', 'gi') as m
    union all
    select m[1] as bruto
      from _mensajes_rapidos_valores v,
           regexp_matches(v.texto_nuevo, '\{\{\s*cat[aá]logos?\M[^}]*\}?\}?', 'gi') as m
  ) as sospechosos
  where bruto !~* '^\{\{\s*cat[aá]logo\s*:\s*[a-z0-9-]+\s*\}\}$'
    and bruto !~* '^\{\{\s*cat[aá]logos\s*\}\}$';

  if v_pendientes is not null then
    raise exception 'scripts/sql/2026-09-18-catalogos-iniciales.sql: los textos nuevos contienen marcador(es) de catálogo MAL ESCRITOS -- no calzan {{catalogo:<key>}} ni {{catalogos}}: %. Corrige la clave o la forma del marcador en la sección 1 -- no se escribió nada.', v_pendientes;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3) Carga de los 7 catálogos.
--
--    D-C (decisión del operador, 19/9/2026): si una clave YA existe en
--    `catalog_links` -- un supervisor la creó desde el panel de Control IA,
--    quizás con una URL más nueva, porque los IDs de Drive rotan -- este
--    script NO la pisa. `on conflict (key) do nothing`, y un `NOTICE` por
--    cada clave saltada con su URL ACTUAL, para que el Claude del VPS
--    decida si hace falta actualizarla a mano. Sin esto, correr el script
--    una segunda vez (o correrlo después de que el supervisor ya cargó
--    "cascos" a mano) moría con "duplicate key value violates unique
--    constraint".
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select v.key, c.url as url_actual, c.is_active
      from _catalogo_valores v
      join public.catalog_links c on c.key = v.key
      order by v.key
  loop
    -- El estado ACTIVA/INACTIVA se suma al NOTICE el 19/9/2026 (code-review
    -- high, hallazgo 7a sobre T6): una clave existente INACTIVA se conserva
    -- tal cual (D-C, este script no pisa lo del panel) y por eso NO resuelve
    -- en producción (`resolveCatalogMarkers` solo lee enlaces activos) hasta
    -- que alguien la active a mano -- la sección 3b, más abajo, aborta el
    -- script si eso deja sin resolver alguna clave que los textos nuevos
    -- referencian.
    if r.is_active then
      raise notice 'catalog_links.%: ya existe y está ACTIVA (creada desde el panel o de una corrida anterior) -- se conserva la URL actual y NO se pisa: %', r.key, r.url_actual;
    else
      raise notice 'catalog_links.%: ya existe pero está INACTIVA (creada desde el panel o de una corrida anterior) -- se conserva tal cual, INACTIVA, y NO se pisa: %. Si algún texto nuevo la referencia por {{catalogo:%}}, la sección 3b va a abortar el script hasta que se active desde el panel de Control IA.', r.key, r.url_actual, r.key;
    end if;
  end loop;

  insert into public.catalog_links (key, label, url, sort_order)
  select key, label, url, sort_order from _catalogo_valores
  on conflict (key) do nothing;
end
$$;

-- ---------------------------------------------------------------------------
-- 3b) ASERCIÓN NUEVA (corrección del 19/9/2026, `code-review high`,
--     hallazgo 7a sobre T6) — 2b (arriba) daba por resuelta cualquier clave
--     presente en `_catalogo_valores`, asumiendo que el INSERT de la
--     sección 3 la iba a dejar ACTIVA. Pero el INSERT es `on conflict (key)
--     do nothing` (D-C): si la clave YA existía -- creada desde el panel,
--     inactiva por lo que sea -- el conflicto la deja EXACTAMENTE como
--     estaba, y 2b igual decía "verificado" antes de escribir una sola
--     fila. Acá, DESPUÉS del INSERT real (ya se sabe el estado definitivo
--     de cada clave) y ANTES de tocar `ai_playbooks`/`quick_replies`, se
--     vuelve a mirar la base: toda clave `{{catalogo:<key>}}` referenciada
--     por los textos nuevos tiene que estar ACTIVA en `catalog_links` EN
--     ESTE MOMENTO. Si no, el script aborta nombrando la(s) clave(s) --
--     D-C: este script NO las activa por su cuenta, esa es una decisión del
--     panel (o del Claude del VPS, a mano, si el operador ya la confirmó).
-- ---------------------------------------------------------------------------

do $$
declare
  v_pendientes text;
begin
  select string_agg(distinct clave, ', ' order by clave) into v_pendientes
  from (
    select lower(m[1]) as clave
      from _escenarios_valores v,
           regexp_matches(v.texto_nuevo, '\{\{\s*cat[aá]logo\s*:\s*([a-z0-9-]+)\s*\}\}', 'gi') as m
    union all
    select lower(m[1]) as clave
      from _mensajes_rapidos_valores v,
           regexp_matches(v.texto_nuevo, '\{\{\s*cat[aá]logo\s*:\s*([a-z0-9-]+)\s*\}\}', 'gi') as m
  ) as referenciadas
  where clave not in (
    select key from public.catalog_links where is_active
  );

  if v_pendientes is not null then
    raise exception 'scripts/sql/2026-09-18-catalogos-iniciales.sql: la(s) clave(s) % sigue(n) SIN estar activa(s) en catalog_links después del INSERT -- ya existían (creadas desde el panel) e INACTIVAS, y el script no las pisa (D-C). Actívalas desde el panel de Control IA, o decide a mano si corresponde otra cosa, antes de reintentar -- no se tocaron ai_playbooks ni quick_replies.', v_pendientes;
  end if;
end
$$;

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

-- ---------------------------------------------------------------------------
-- 6b) AVISO INFORMATIVO (endurecimiento (e), 19/9/2026, T6) — la sección 6
--     solo mira `response_text`/`content`. `ai_playbooks` tiene además una
--     columna `attachment_url` (`quick_replies` NO tiene esa columna) que
--     este script nunca escribe: si alguno de los DOS escenarios que sí
--     toca -- o cualquier OTRO escenario o mensaje rápido de la base, fuera
--     del alcance de esta corrida -- todavía tiene una URL de Drive ahí (en
--     `attachment_url`) o en su texto, se avisa con `NOTICE`. NO aborta:
--     son filas que este script no tiene cómo arreglar (no sabe a qué clave
--     de `catalog_links` correspondería un `attachment_url` suelto, y
--     "Ubicación" a propósito conserva su URL de Maps escrita a mano), así
--     que fallar el script entero por algo fuera de su alcance sería peor
--     que avisar y seguir.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  v_avisos integer := 0;
begin
  for r in
    select id, name, 'response_text' as columna, left(response_text, 80) as fragmento
      from public.ai_playbooks
      where response_text ilike '%drive.google.com%'
    union all
    select id, name, 'attachment_url' as columna, left(attachment_url, 80) as fragmento
      from public.ai_playbooks
      where attachment_url ilike '%drive.google.com%'
    order by name, columna
  loop
    v_avisos := v_avisos + 1;
    raise notice 'ai_playbooks.% ("%"): URL de Drive residual en %: %', r.id, r.name, r.columna, r.fragmento;
  end loop;

  for r in
    select id, label, left(content, 80) as fragmento
      from public.quick_replies
      where content ilike '%drive.google.com%'
      order by label
  loop
    v_avisos := v_avisos + 1;
    raise notice 'quick_replies.% ("%"): URL de Drive residual en content: %', r.id, r.label, r.fragmento;
  end loop;

  if v_avisos = 0 then
    raise notice 'Aviso informativo (6b): ningún escenario ni mensaje rápido quedó con una URL de Drive suelta (ni en attachment_url).';
  else
    raise notice 'Aviso informativo (6b): % fila(s) con una URL de Drive residual, fuera del alcance de este script -- revisar a mano si conviene migrarlas a catalog_links.', v_avisos;
  end if;
end
$$;

commit;
