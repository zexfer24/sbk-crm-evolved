# Entrega A2: estado de la corrida (para retomar si se corta la sesión)

Este archivo lo escribió el orquestador el 29-30/9/2026. Todavía no hay nada commiteado
ni pusheado.

## Dónde está todo

- **Worktree:** `C:\Users\WinterOS\Documents\SBK CRM-a2`, rama `entrega/seba-a2`.
  - Parte de `d3f4055` (`origin/main`, que ya incluye la Entrega B).
  - La rama no tiene upstream, a propósito: nunca se pushea a `main`.
- **Plan aprobado:** `docs/planes/2026-09-30-seba-no-cotiza-lo-que-no-es.md` (versión 2,
  con T9 y D5).
- **Casos del VPS:** `docs/planes/2026-09-30-seba-a2-casos-del-vps.md`.
- **Árbol principal** `C:\Users\WinterOS\Documents\SBK CRM`: ahí trabaja otra sesión. No
  se toca.
- **Base local compartida** `supabase_db_Liminal_CRM` (Kong en 55321, Redis `sbk_redis`):
  nada de `db reset`.

## Tareas

| Tarea | Estado | Qué quedó |
|---|---|---|
| T0 | ✅ | Worktree creado, `npm ci`, `.env.local` copiado, `next typegen` corrido. |
| T1 | ✅ | Fixture y casos: 301 productos (el código `A2FIX-` va en `description`, no en `saint_code`) y 143 casos con 31 tests de coherencia. La base local quedó limpia. Las dudas se resolvieron abajo. |
| T2 | ✅ | M1 `20260930010000_busqueda_por_palabra_moto_y_variantes.sql`, aplicada y registrada en local. Ver el detalle abajo. |
| T3 | ✅ (29/9, retomada) | Tests SQL de M2/M3 en verde; `catalog-correction.ts` con la firma de 4 parámetros y `diagnosticarTerminos()` (devuelve `null` si falla: no se relaja nada sin medir). El relleno de `catalog-search.ts` no está exportado: T5 lo exporta para `p_excluidos`. Texto viejo: | Estado al 29/9 por la tarde, después del corte. **Hecho:** M2 y M3 están aplicadas y registradas en local. Las cinco `20260930010000`…`050000` figuran en `schema_migrations`, y existen `clave_fonetica`, `corregir_terminos` con 4 parámetros y `diagnosticar_terminos`. Los tests SQL están escritos pero falta correrlos. **Falta:** la parte TS. `catalog-correction.ts` no tiene cambios. Hay que relanzar T3 solo con eso y correr sus tests SQL. |
| T4 | ✅ | Parser `catalog-search.ts`, 180 tests. Ver el detalle abajo. |
| T6 | ✅ | M4 y M5, aplicadas en local, y `pideVerTodo`. Ver el detalle abajo. |
| T5 | ✅ (30/9; T5b corrigió los dos hallazgos rechazados: ver «T5b» al final) | `tools.ts` (`buscarUno` con D6), `quote-message.ts`, `catalog-memory.ts`, `seba.ts`, `catalog-request.ts` (`pideVerOpciones`), el gancho de `agent.ts`, el fake de `tools.test.ts` (apoyado en `__fixtures__/simulador-sql-a2.ts`, contrastado contra la base local) y `ConsultaCatalogo` v2. Los 147 casos de `casos-a2.ts` corren dentro de `tools.test.ts`. |
| T7 | ✅ (30/9, implementador) | Arnés `scripts/arnes-catalogo-a2.test.ts` + `vitest.arnes.config.ts` + `npm run test:arnes` (fuera de `npm run test`): 149 casos contra `buildCatalogTool` real, base real y Redis real, 0 peor. Aserciones compartidas con `tools.test.ts` en `__fixtures__/verificar-caso-a2.ts`. Local: `ARNES_SUPABASE_URL=http://127.0.0.1:<puerto de docker port supabase_kong_Liminal_CRM> npm run test:arnes`. CI: el job `migraciones` suma un servicio Redis, `npm ci`, un PostgREST efímero (`public.ecr.aws/supabase/postgrest:v16.2`, service_role firmada en el paso) y el paso del arnés; sin tsx (el arnés arma el SQL con `armarSqlCarga`). El CI real se prueba en el cierre (rama `ci/seba-a2`). Mutaciones (desempate por nombre; `nombra_otra_moto` en falso): ambas en rojo. |
| T9 | en marcha (implementador, 30/9) | Pestaña «Búsquedas» + M6 `resumen_busquedas` (security definer, desvío explicado en el plan). Bloques: [x] M6 `20260930060000` (`resumen_busquedas` + `terminos_de_busquedas`, aplicada y registrada en local, test SQL verde, guardián 28 funciones); [x] `fetchCatalogSearches`/`fetchSearchSummary`/`fetchSearchTerms` + `protectWordFromCorrection` + reglas puras `lib/catalog-searches.ts`; [x] `catalog-searches-panel.tsx` (bloques A-D, contrastado contra la sección 5 del plan el 30/9: completo), pestaña con contador de hoy y refresco por `postgres_changes`, `TeachSebaModal` con `initialKind`/`initialSynonymFrom`/`contextText`, «Lecciones» distingue `no_corregir` (tests del panel, de la vista, de Lecciones y del modal en verde, 155); [x] SQL `resumen_busquedas.sql` verde, tsc limpio, lint 0 errores (7 warnings viejos); [x] suite completa (207 archivos / 4416 tests verdes); [x] mutaciones (a: v:2 asumido en data.ts y avisos sin null en el panel; b: no_corregir en Lecciones; c: precargado en modal y en panel: todas en rojo, restauradas desde la copia); [x] verificación en pantalla (Playwright sobre el build de producción, 1440 y 390 px; capturas en el scratchpad de la sesión; filas de prueba `T9-PRUEBA` insertadas y borradas; sin desbordes propios; el strip de pestañas de `agent-control-view` desborda a 390 px, ya pasaba antes); [x] GLOSARIO. **T9 terminada, pendiente de validación del orquestador.** |
| T8 | ✅ (30/9, implementador; pendiente de validación del orquestador) | Docs escritos. `CLAUDE.md`: 12 viñetas nuevas al final de «Trampas conocidas» (tres errores de diseño de A, contrato `catalog_queries`, `patron_busqueda`, variantes/posicionales, «otra moto» y las dos listas de `tools.ts`, familia del pedido T5b, `p_marcas`, D3, D6, `no_corregir` y `resumen_busquedas`, el arnés, deuda de `conversation_quotes`), notas «Actualizado el 30/9/2026 (A2)» en cinco viñetas anteriores y `npm run test:arnes` en Comandos. `GLOSARIO.md`: migraciones 94 y cinco filas M1-M5, tabla de vocabulario de la búsqueda, `database.types.ts`, `docs/planes` y `docs/entregas`. `PRODUCCION.md`: §17 nueva (seis migraciones en orden, verificaciones SQL, arnés, pestaña «Búsquedas», escenario a mano, medición 48 h), nota de superado en §15 paso 7 y conteo 94. Nota de entrega `docs/entregas/2026-09-30-seba-a2.md` con marcadores `<hash>` para los 11 commits de código y migración, los seis `cambioDeliberado`, los casos con D6 y los pasos del VPS. |
| Cierre | pendiente | Commits en el orden de la sección 7 del plan, push de `entrega/seba-a2` y de `ci/seba-a2`. |

### T2: detalle de M1

- `patron_busqueda(alt, tipo)`.
- `buscar_productos` con **9 parámetros**. Al final van `p_variantes`, `p_moto_marca`,
  `p_motos_conocidas` y `p_marcas_de_moto`.
- `nombra_otra_moto` = `nombra_moto AND puntaje_moto_nombre=0 AND NOT (puntaje_moto_marca>0
  AND NOT nombra_modelo)`.
- Resultado buscado: JAGUAR/BERA sirve para una Bera Socialista; TAPA BERA SBR no sirve
  para una Milan.
- Los tests pasan y las mutaciones quedan en rojo.
- **T5 tiene que pasar siempre `p_motos_conocidas` y `p_marcas_de_moto`.**

### T4: detalle del parser

- **Exporta:** `VARIANTES`, `MOTOS_CONOCIDAS` (ampliada), `MARCAS_DE_MOTO` (incluye
  jaguar), `MARCAS_CONOCIDAS`, `motoDesdeTexto()` y `CatalogQuery`, con `gruposInfo`,
  `variantes`, `motoMarca`, `anio` y `motoCorregida`.
- **Esperado:** `tools.test.ts` tiene 6 fallas hasta que se haga T5.

### T6: detalle

- **M4:** 16 sinónimos, con `created_by` NULL.
- **M5:** `kind` `no_corregir`; la palabra va en `synonym_from`.
- **`pideVerTodo`:** amplía las frases que reconoce.
- **Deuda para T9:** el panel de Lecciones tiene que distinguir las filas `no_corregir`.

## Decisiones que se tomaron sobre la marcha

- La marca de moto sola no rescata un producto. Solo lo rescata si el producto nombra
  únicamente marcas (el caso JAGUAR/BERA).
- `jaguar` es marca de moto. `toro`, `new` y `super` no entran en las listas.
- El relleno nuevo va en `RELLENO_CATALOGO`, aparte del de la biblioteca.

## Cómo retomar

1. Leer este archivo, el plan y la memoria
   `corrida-seba-a2-no-cotiza-lo-que-no-es-30-9-2026`.
2. Ver con `git status` en el worktree qué quedó, y en la base local qué migraciones
   `20260930*` están registradas:
   `docker exec supabase_db_Liminal_CRM psql -U postgres -tAc "select version from supabase_migrations.schema_migrations where version like '20260930%'"`.
3. Relanzar T1 y T3 si no terminaron. Después seguir con T5 → T7 → T9 → T8 → cierre.

## Resoluciones del orquestador a las dudas de T1 (T5 las aplica y ajusta los casos)

1. **2.1-03, la BATERIA JAGUAR/BERA para una Bera Socialista.** Se cotiza, gracias al
   refinamiento de M1: JAGUAR/BERA nombra solo marcas y el cliente es marca bera.
   - Hay que sacarle el `cambioDeliberado` al caso.
   - **Conjunto compatible** cuando la moto no calza: las filas con
     `nombra_otra_moto = false`, es decir los universales más los que nombran solo la
     marca del cliente.
   - La línea que se muestra depende de lo que se cotiza. Si alguno es de la marca:
     «No encontré uno con el nombre de tu moto; estos son de <marca> o universales». Si
     no: «…estos son universales».
2. **Moto dada que no calza, cuando la familia depende de la moto.** Se decide con los
   compatibles que tienen stock:
   - más de 3 → la pregunta de filtro. Si ya se preguntó, se escala sin cotizar.
   - de 1 a 3 → se cotizan con la línea;
   - 0 → se escala (`moto_sin_calce`).

   `nr-08` (defensa gxs 250) da pregunta si el fixture tiene más de 3 defensas
   compatibles con stock; si no, hay que ajustarlo.
3. **Una marca que no aparece en ningún nombre activo** (`en_catalogo = false`) sí se
   puede relajar en D3 (el caso ICH). Si la marca sí existe en el catálogo, nunca se
   relaja.
4. **El grupo de litros** («30 litros») no cuenta como número suelto: puede ser la
   cabeza, y con eso `ibk` se relaja.
5. **«Ya se preguntó y no llegó un dato».** El estado es `generico`, con el aviso
   `varias_opciones`. Además lleva `motivoForzado` = `confirmar_inventario`: escala sin
   cotizar.
6. **Pareja.** Se pregunta sin escalar y el aviso `relajado` queda solo en el registro de
   la consulta. Está bien como lo escribió T1.
7. **D2 cuando se ofrecen otras opciones:** el motivo es `confirmar_inventario`. Está
   bien.
8. **`tsx`** no está en `devDependencies`. T7 lo suma, o usa `npx --yes tsx`.

## Interrupción: hotfix de producción (29/9/2026, tarde)

El operador reportó dos fallas en producción:
- Seba cotiza hasta 3 opciones de todo.
- Mezcla productos con stock 0.

Hay riesgo de perder el cliente. Se pausó la A2 y se abrió un hotfix sin migración:
- **Worktree:** `C:/Users/WinterOS/Documents/SBK CRM-hotfix`.
- **Rama:** `entrega/hotfix-stock`, sobre `d3f4055`.

**Decisión del operador:**
- Con stock, se cotiza UNA opción: la mejor, y a igual relevancia la de más existencia.
- Nunca se cotiza un agotado si hay alguno con stock.
- Sin «Hay N opciones más».
- Si todo está agotado, solo se nombra lo pedido.

**Al retomar la A2:**
1. Rebasar `entrega/seba-a2` sobre el hotfix.
2. Adaptar T5 y D2, que hoy suponen 3 opciones y «Otras opciones con existencia», a esta
   decisión.
3. Preguntar al operador si D2 sigue vigente.

## Retomada tras el hotfix (29/9/2026, noche)

- `entrega/seba-a2` avanzó por fast-forward a `3d3e9a0` (main con el hotfix). Los cambios
  sin commitear no chocaban con el hotfix.
- **D6, decisión del operador (reemplaza toda cifra "hasta 3" del plan):**
  - Se cotiza **1** en todos los casos: la mejor y, a igual relevancia, la de más
    existencia. Sin «Hay N más». Nunca un agotado junto a algo con stock.
  - **Única excepción:** si el cliente pide de forma explícita ver opciones («muéstrame
    todas», «qué opciones hay», «cuáles tienes»), salen hasta 3 con stock, por relevancia y
    existencia, sin «Hay N más».
  - «No sé», «ni idea», «la que sea» NO son la excepción: dan 1, la mejor.
  - Moto que calza y universales de D1: 1.
  - D2: UNA alternativa con existencia de la misma moto o familia; si no hay, «<variante>
    agotado» y escala.
  - Se mantienen los tests del hotfix. El arnés compara contra `3d3e9a0`.

## T5: progreso (implementador, 30/9/2026)

Fila T5 en marcha. Va en bloques; cada uno queda con sus tests en verde.

- [x] Bloque 1, piezas puras:
  - `RELLENO_CATALOGO` exportado desde `catalog-search.ts`.
  - `pideVerOpciones` en `catalog-request.ts`. Es la excepción D6 y `pideVerTodo` la incluye.
  - Textos fijos de los avisos en `seba.ts`: `textoUniversales`, `textoMotoSinCalce`,
    `textoVariasOpciones`, `textoRelajado`, `textoRelajadoAgotado`, `textoVarianteAgotada`,
    `OTRA_OPCION_CON_EXISTENCIA` y `TEXTO_ASESOR_CONFIRMA`.
  - `catalog-memory.ts`: guarda `anio` y `preguntaTipo`, y lee objetos viejos.
  - `quote-message.ts`: pinta los avisos y la alternativa singular de D2.
- [x] Bloque 2: `__fixtures__/simulador-sql-a2.ts` (espejo en TS de M1/M2/M3) y el fake de
  `tools.test.ts` apoyado en él.
- [x] Bloque 3: `tools.ts` (`buscarUno` nuevo con D1/D1b/D2/D3, la guarda de producto,
  `CatalogOutcome.avisos`/`motivoForzado`, `ConsultaCatalogo` v2). `agent.ts`: el gancho
  (`motivoForzado`, `notaDeBusquedas`, avisos al armado). `tools.test.ts` verde (141) con el
  fake nuevo; los tests viejos que cambiaron de semántica quedaron anotados en el reporte.
- [x] Bloque 4: `casos-a2.ts` adaptado a D6 (una sola; `ver-opciones-*` da tres) y el runner
  de los 145+ casos dentro de `tools.test.ts`. Todos en verde. Cambios a los casos anotados
  en el reporte (siriu, ich, express, rallo, nr-08, 2.1-03, bateria-dt-2014, rodamiento, ver-todo-13).
  Fixture: BATERIA JAGUAR/BERA y KIT RODAMIENTO BERA 38T pasan a `correcto`; «BOMBA DE ACEITE
  BERA SBR» se renombró (chocaba con «aceite» de una SBR); «RAYOS» pasó a «RAYO» en el rin trasero.
- [x] Bloque 5a: tests del gancho de `agent.ts` (294 en verde).
- [x] Bloque 5b: test del simulador, mutaciones (a)-(e) (todas en rojo, restauradas desde la
  copia), GLOSARIO, lint, tipos, suite de `src/lib/ai` y suite completa.

### Notas para T8 (CLAUDE.md) y T9 (panel), salidas de T5

- `ConsultaCatalogo` v2 vive en `tools.ts` (`v: 2`); el panel lee `avisos[].tipo` y trata las
  filas v1 (sin `v`) con «—».
- Trampa nueva: `p_motos_conocidas` = `MOTOS_EN_NOMBRES` (las motos conocidas más dt/cg/gn). Sin
  los prefijos, «DEFENSA DELANTERA SUPER DT LEFOR» pasa por universal.
- Trampa nueva: una moto «calza» con UNA sola fila del máximo, aunque sea de otro producto
  («BOMBA DE ACEITE BERA SBR» para el pedido «aceite» de una SBR). Detalle y arreglo propuesto en
  el reporte de T5.
- Trampa nueva: M2 acepta una corrección de MARCA a distancia 2 hacia cualquier marca de la
  lista que exista en el catálogo (kenda→honda). El reintento que no calza se descarta y D3 relaja
  la palabra, pero el SQL sigue proponiéndola.

### Si hay un corte durante T5 (aviso del operador, 29/9 noche)

1. `git status` en el worktree y leer la fila T5 de la tabla: el implementador anota ahí
   cada bloque terminado.
2. Relanzar un `implementador` para T5 con el mismo encargo, diciéndole que continúe desde
   lo anotado y que no rehaga lo que ya está en verde.
3. Después: T9 → T7 → T8 → cierre (sección 7 del plan). Todo cotiza según D6.

### Validación de T5 por el orquestador (29/9 noche)

- T5 ✅ con desvíos aceptados: tests del hotfix por encima de la resolución 5 (tras la
  pregunta se entrega 1), D1b por encima del test del hotfix de lista genérica,
  `MOTOS_EN_NOMBRES`, `TEXTO_ASESOR_CONFIRMA` y el gancho ampliado de `agent.ts`.
- **Rechazado:** el renombre del fixture BOMBA DE ACEITE → BOMBA DE LUBRICACION tapaba un
  error real: la moto calzaba con una fila de otro producto. Y kenda→honda.
- Lanzadas en paralelo: **T5b** (M1: la moto calza solo entre las filas del máximo que
  empiezan con el producto; `p_marcas` sin motos; limpieza de `masOpciones`) y **T9**.
  Si hay un corte, relanzar las dos con el mismo encargo y leer sus filas.
- Después: T7 (arnés; compara contra `3d3e9a0`) → T8 → cierre.

### T5b (30/9/2026, implementador): la moto calza solo entre la familia del pedido, y kenda→honda

Corrige los dos rechazos de la validación de T5. Todo en verde: `tsc`, `lint` (7 warnings viejos),
`src/lib/ai` (2230 tests + 1 todo), tests SQL `buscar_productos.sql` (caso 38 nuevo) y
`corregir_terminos.sql` (caso 13 nuevo).

- **M1 editada in situ** (sigue sin estar en producción; reaplicada en local con `drop` + `create`, sin
  reset): si alguna fila del máximo empieza con la cabeza del pedido (`empieza_con_producto`), la
  FAMILIA son solo esas; si ninguna, todo el máximo. `puntaje_moto_maximo` y `filas_que_nombran_moto`
  salen SOLO de la familia. **Decisión:** las demás ventanas (`filas_con_maximo_y_stock`, universales,
  variante, `filas_con_puntaje_maximo`, `filas_con_maximo_y_moto`) NO se restringen: cuentan el conjunto
  de candidatos tal cual, porque `tools.ts` elige entre esas filas y el hotfix del 29/9 manda "nunca un
  agotado si hay con existencia" (una primera versión las restringía todas y ponía rojos dos tests del
  hotfix: `ZAPATO BOTA IMPERMEABLE` con stock y las `BOTA …` en 0). Con moto que no calza las ventanas
  ya no exigen `puntaje_moto_nombre = 0` (`puntaje_moto_maximo = 0 or …`) y el `order by` usa la moto solo
  si calza (sin eso la bomba, con moto 1, iba primera por nombrar la SBR). Sin columna nueva ni cambio de
  firma. `tools.ts`: `ordenarPorExistencia` recibe `motoCalza` y hace lo mismo.
- **kenda→honda:** `MARCAS_DE_PRODUCTO` (exportada de `catalog-search.ts`) es lo único que `tools.ts` pasa
  como `p_marcas`; `MARCAS_CONOCIDAS` sigue para no relajar marcas en D3. Las motos siguen protegidas por
  `p_protegidos`. horsen→horse, tisum/stinsun→timsun, swhera→switchera, iphone→ipone y
  motopower→motorpower siguen corrigiéndose (test nuevo en `tools.test.ts`).
- **Limpieza:** `masOpciones`, `MasOpciones`, `lineaMasOpciones` y `masOpcionesDe` borrados (nadie los
  producía desde el hotfix) con sus tests; en `usd-price.test.ts` solo cayó la línea del campo.
- **Fixture:** `BOMBA DE ACEITE BERA SBR` vuelve (regenerados `scripts/sql/fixture-catalogo-a2*.sql`);
  casos `nr-08b` («aceite» para una SBR: pregunta de filtro, nunca la bomba) y `nr-08c` («aceite inca»).
- **Contraste con la base real** (fixture cargado y borrado; la base local quedó con sus 5 productos):
  221 llamadas distintas de los casos, 0 diferencias entre `simulador-sql-a2.ts` y `buscar_productos`.
- **Trampa que sigue viva (para T8):** con la moto que no calza, una fila de otro producto que nombra la
  moto SIGUE dentro del conjunto (la moto no filtra) y, si tiene más existencia, ganaría por existencia
  cuando no hay ningún aceite (todos agotados, "nunca un agotado si hay con existencia"). Solo el orden
  de relevancia (empieza con el producto) la deja detrás de los aceites con existencia.
