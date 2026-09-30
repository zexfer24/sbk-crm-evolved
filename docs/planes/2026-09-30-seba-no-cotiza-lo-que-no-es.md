# Entrega A2 — "Seba no cotiza lo que no es" (versión 2)

## 1. Contexto

La Entrega A (`6c8ce24`) está en producción desde el 29/9 a las 17:00 UTC. El VPS volvió
a pasar por ella los 597 turnos del estudio: 116 mejoran y 53 empeoran.

El mismo 29/9 a las 13:14 VE pasó esto en producción. Un cliente con una SBR 2025 pidió
una lista, y salió así:

| Pidió | Seba le cotizó |
|---|---|
| caucho n° 18 delantero | nada: quedó como `n18` y dio no identificado |
| caucho trasero | cauchos rin 10 de scooter |
| rodamiento | kits de rodamiento de otras motos |
| aceite | un aditivo para metales y un aceite de bastones |
| asiento | el asiento SBR (el único acierto) |

Hay cinco causas. Todas están en `catalog-search.ts`, en `tools.ts` (`buscarUno`) y en
las dos funciones SQL.

1. **La moto.** Calza por pedazo de palabra: `gr` calza con GRIS. Con la marca sola ya
   alcanza (bera calza con las tapas SBR aunque la moto sea una Milan). Y cuando no calza,
   se cotizan las tres primeras por orden alfabético: BRZ, KAVAK, KLR.
2. **Los números.**
   - `130 - 70 - 12` se lee como cilindrada.
   - `n° 18` queda como `n18`.
   - `45` no calza con 45T.
   - `20:50` no se lee como viscosidad.
   - El año se vuelve un término obligatorio.
3. **El corrector no tiene límites.**
   - pareja→para (da un agotado falso) y llanta→lata.
   - Vuelve a poner en plural lo que el propio código pasó a singular.
   - Cambia el producto pedido: vicera→visera cotiza una VISERA en vez del CASCO.
4. **El opcional que calza entero** («azul», «edge», «paleta») queda tapado por el tope,
   el stock o la pregunta.
5. **Una palabra obligatoria que no está en el nombre** («pwk», «bomba», «reborde») tumba
   la búsqueda.

**Objetivo:** 0 turnos peor que `6c8ce24` en el arnés del VPS. Los 53 casos «peor»
quedan resueltos o explicados uno por uno.

**No se toca** lo que la A dejó bien:
- la marca obligatoria, sin N−1;
- mirar el stock antes de decir «tenemos»;
- una sola pregunta por pedido;
- la cotización armada por código;
- las listas por producto;
- la memoria del pedido;
- `catalog_queries`, que se amplía con versión y no se rompe.

Además, se suma **T9**: una pestaña «Búsquedas» en Control IA para supervisar todo lo que
hace la búsqueda, sin abrir la base ni los logs.

## 2. Decisiones del operador (29/9/2026)

**D1 — Moto que no calza.** Opción (a), con una precisión.
- **Cuándo una familia depende de la moto.** Lo decide el código con la ventana
  `filas_que_nombran_moto` que devuelve SQL. Si ninguna fila del máximo nombra una moto
  (cauchos, tripas, aceites), la moto no decide nada y rige la pregunta de filtro. Si la
  bandera `dependeDeLaMoto` del modelo no está de acuerdo, gana la ventana.
- **Qué es «otra moto».** Un producto nombra otra moto cuando su nombre calza alguna de
  `MOTOS_CONOCIDAS` **y no calza la moto del cliente**. Por eso «ASIENTO SBR /SOC
  ORIGINAL» nombra dos motos y sí le sirve a una SBR.
- **Qué es «universal».** Lo que no nombra ninguna moto, o lo que dice UNIVERSAL.
- **Qué se hace.** Nunca se cotiza un producto de otra moto. Si hay universales con
  stock, se cotizan (hasta 3) con la línea de universales. Si no hay, se escala
  `confirmar_inventario` con «el asesor te confirma cuál le sirve a tu <moto>».
- **Si ya se preguntó y no llegó un dato que distinga,** se escala sin cotizar.
- **Nunca se elige por orden alfabético.**

**D1b — Ítem genérico en una lista.** Opción (a): no se cotiza. Queda la línea
«<ítem>: hay varias opciones; el asesor te ayuda a elegir», en el bloque y en la nota de
la escalada.

**D2 — Variante agotada.** Opción (a): se dice «<variante> agotado» (hasta 3) y se
agregan hasta 3 «Otras opciones con existencia».
- Con la moto del cliente: son de esa misma moto (tanque azul SBR → otros tanques SBR,
  nunca de EK).
- Sin moto: son de la misma familia y del mismo conjunto del máximo, por relevancia y
  después por stock.

**D3 — Palabra que tumba la búsqueda.** Opción (a), afinada con datos. Hay un tercer
intento, después del corrector.
- **La cabeza** es el primer grupo que existe en el catálogo y no es un número suelto.
- **Se relaja un grupo** que no es la cabeza, ni una marca, ni una moto, y que cumple
  una de dos: no aparece en ningún nombre activo, o ningún producto lo trae junto con la
  cabeza.
- **Números.** Un número que va detrás de una palabra relajada («reborde de 11») se
  relaja con ella. Tiene que quedar al menos un grupo que no sea un número suelto.
- **Qué se dice.**
  - Si calza: la línea «No encontré "X" en el nombre; esto es lo más parecido» y se
    escala `confirmar_inventario`.
  - Si lo parecido está en 0: «lo más parecido que encontré está agotado» y se escala.
    **Nunca un agotado a secas.**

**D4 — Sinónimos.** Opción (a): una migración de datos los siembra en `ai_lessons`
(globales y editables). El código gana soporte para sinónimos de dos palabras («boca
pato», «porta maleta»), que hoy no calzan nunca.

**D5 — Una corrección mala.** Opción (a): un botón «No corregir esta palabra» guarda una
lección `kind='no_corregir'` (global, se puede apagar). `corregirTerminos` la suma a
`p_protegidos`.

**El corrector usa una lista cerrada.** `products.brand` está vacía: 0 de 6.065
productos.
- La distancia máxima es 1 en general.
- Distancia 2 o 3 solo en dos casos: hacia una palabra de `MARCAS_CONOCIDAS`, o si las
  dos palabras suenan igual.
- **El reintento no puede cambiar el producto pedido.** El test lo fija con «casco
  frankie negro vicera azul», que tiene que dar CASCO FRANKIE NEGRO MATE V/AZUL.

**Ver todo.**
- Con «no sé», «muéstrame todos» o una frase equivalente, salen las 3 más relevantes y, a
  igual relevancia, las de mayor existencia. Van con «Hay N opciones más» y se escala.
- Si ya se preguntó y el cliente no pidió ver todo ni dio un dato, se escala sin cotizar.
- `pideVerTodo` gana frases, cada una con su test: «ni idea», «no tengo idea», «la que
  sea», «el que tengas», «los que tengan», «no tengo marca», «recomiéndame», «cuál me
  recomiendas», «el más económico», «la más barata».

## 3. Dónde se trabaja

- **Un worktree aparte.** En `C:\Users\WinterOS\Documents\SBK CRM` sigue corriendo la
  sesión de la Entrega B, con archivos sin commitear, y no se toca. Comando:
  `git worktree add "../SBK CRM-a2" -b entrega/seba-a2 origin/main`. Después, `npm ci` y
  una copia de `.env.local`. Todos los subagentes trabajan ahí.
- **La base local es compartida con B.** Las migraciones son compatibles con B: solo
  suman parámetros con default y columnas nuevas. **Nada de `db reset`.** La base
  reconstruida desde cero la da el CI, en la rama desechable `ci/seba-a2`.
- **La numeración de las migraciones** es `20260930*`, sin depender de B. La nota de
  entrega avisa lo siguiente: si A2 sale antes que B, las `20260929*` de B entran
  después con un número menor. El VPS las aplica con `psql` y el insert manual en
  `schema_migrations`, así que funciona igual, pero `migration list` las va a mostrar
  fuera de orden.
- **Conflictos previstos al fusionar con B.** B también toca `agent.ts`, `seba.ts`,
  `agent-control-view.tsx` y `CLAUDE.md`. Por eso acá se cambian lo mínimo:
  - `agent.ts`: solo un gancho;
  - `seba.ts`: solo los textos nuevos;
  - `agent-control-view.tsx`: solo la pestaña, con el panel en un archivo propio.

## 4. Contrato entre tareas

### 4.1 `catalogQuery` (`catalog-search.ts`)

Devuelve estos campos:
- `grupos`: los obligatorios. Cada uno con `trasPreposicion` y `numeroDe`.
- `opcionales`: las posicionales y de calidad (delantero, trasero, semi, original…).
- `variantes`: lista cerrada con test. Colores, mate, brillante, cromado, edge, paleta,
  rayo, tornasol y tallas.
- `moto`, `motoMarca`, `cilindrada`, `anio`.

Reglas, todas con test:

- **Años.** 1980-2035 van a `anio` y nunca a `grupos`. Lo mismo el que va después de
  «año». «dt 2014» no se une.
- **Medidas.** Se reconocen `130/70-12`, `130/70/12`, `130 70 12`, `130-70-12`,
  `130 - 70 - 12`, `130/60/R13`, `130/60 R13`, `130-80-17` y `90 90 19`. Cada número
  queda como grupo obligatorio y ninguno es cilindrada. `R13` → `13`.
- **Rin.** «rin 17», «#17», «n° 18», «nº18», «no 18», «nro 18» y «numero 18» dejan solo
  el número. «rin» sigue siendo producto únicamente si no hay otro sustantivo antes.
- **Viscosidad.** «20:50» se lee como `20w50`.
- **Litros.** «N litros/litro/lts/lt» es un solo grupo:
  `[Nlts, "N lts", "N litro", Nlt]`.
- **Pulgadas y centímetros.** «N pulgadas» deja solo `N`. «58cm» va a `variantes`.
- **Tallas.** «talla X» y una talla suelta van a `variantes`, con 2xl↔xxl.
- **Relleno.** `RELLENO` suma medida, tipo, modelo, marca, numero y pulgada.
- **Opcionales.** «kit» y «set» pasan a `opcionales`.
- **«semitaco».** «semi taco» y «semi-taco» se leen como «semitaco».
- **Moto.**
  - `MOTOS_CONOCIDAS` se amplía con: milan, runner, leon, rex, aguila, rkv, hj, cool,
    vstrom, gy6, bws, dr, más las que salgan de los casos.
  - `MARCAS_DE_MOTO` (bera, ek, empire, md, yamaha, honda…) sirve para separar la marca
    del modelo: si el cliente dio modelo, la marca va a `motoMarca`, que solo ordena.
  - En contexto de moto, `gr250` y `dt250` se parten en moto `gr`/`dt` + cilindrada
    `250`.
  - Un alias o una distancia 1 contra las motos conocidas corrige la moto:
    horsen→horse, express→xpress.
- **`MARCAS_CONOCIDAS`.** Lista cerrada, exportada y con test, que usan el corrector y
  D3: timsun, switchera, ipone, motorpower, motul, inca, oilstone, givi, ls2, ich, benf,
  lefor, ejeas… y las motos.
- **Sinónimos de dos palabras o más.** Si la frase aparece seguida en la consulta, se
  vuelve un solo grupo: `[frase, destino]`.
- **Palabras cortas.** Un término alfabético de 3 letras o menos calza como palabra
  entera, con plural. Así «cro» no calza con CROMADO.

### 4.2 M1 `20260930010000_busqueda_por_palabra_moto_y_variantes.sql`

- **Helper nuevo `public.patron_busqueda(alt text, tipo text)`,** `immutable`. Es la
  única fuente de los patrones; lo usan M1 y M3.
  - `prod`/`opc`/`var`: empieza en `\m`.
    - Si la alternativa es alfabética de 3 letras o menos, termina en `(s|es)?\M`.
    - Si termina en dígito, termina en `([^0-9]|$)`: 45 calza 45T y 45LTS, 50 sigue sin
      calzar 5000, dt200 sigue sin calzar DT2000.
    - Si empieza en dígito y trae punto, acepta una letra antes (H11.7).
  - `moto` y `moto_marca`: `\m alt ([0-9]|\M)`. GR250 calza, GRIS no.
  - `cil`/`anio`: `(\m|[a-z]) alt ([^0-9]|$)`.
- **`buscar_productos`** se retira con `drop` y se recrea con parámetros nuevos, todos con
  default: `p_variantes`, `p_moto_marca` y `p_motos_conocidas`. El año viaja dentro de
  `p_cilindrada`.
- **Columnas nuevas por fila:**
  - `puntaje_variante` y `puntaje_moto_marca`;
  - `nombra_otra_moto`: calza alguna moto conocida y no calza la moto del cliente;
  - `es_universal`: no nombra ninguna moto, o dice «universal».
- **Ventanas nuevas.** Se calculan sobre el máximo (y sobre la moto, si calza), antes del
  límite:
  - `filas_que_nombran_moto`;
  - `filas_universales` y `filas_universales_con_stock`;
  - `filas_con_variante` y `filas_con_variante_y_stock`, que exigen todas las variantes.
- **Orden:** puntaje, moto con nombre, variante, empieza con el producto, marca de moto,
  cilindrada o año, opcional, con stock, `stock_quantity desc` y el nombre al final.
- Cierre de siempre: los dos revokes, el grant a `service_role`, `lock_timeout` con su
  guarda y `notify pgrst`. Se actualiza `database.types.ts`.

### 4.3 M2 `20260930020000_corrector_con_limites.sql`

`corregir_terminos(p_terminos, p_protegidos, p_marcas text[] default '{}', p_excluidos
text[] default '{}')`. La firma vieja se retira. Reglas:

- Un término que es **prefijo** de alguna palabra del vocabulario ya existe y no se
  corrige. Cubre siriu, guarda y diente.
- El candidato no puede estar en `p_excluidos`, que recibe el `RELLENO`.
- El candidato necesita al menos 5 letras, salvo que suene igual.
- El candidato se acepta con cualquiera de estas tres:
  - distancia 1 o menos;
  - la misma `clave_fonetica`, un helper `immutable` (ll→y, v→b, z→s, c[ei]→s, qu→k, la
    h muda);
  - que esté en `p_marcas`, con distancia dentro del umbral por largo (5 letras → 2; 6 o
    más → 3).
- Desempate: distancia, similarity y frecuencia.

| Caso | Resultado |
|---|---|
| horsen→horse, iphone→ipone, motopower→motorpower, ciguañal→cigueñal | se corrigen (distancia 1) |
| tisum→timsun, stinsun→timsun, swhera→switchera | se corrigen (marca) |
| rallo→rayo | se corrige (suena igual) |
| siriu | ya existe (prefijo) |
| pareja, llanta, carplay, kenda, dama, frente, compresion, alante, numero, relacion | no se corrigen |
| medida | sale por relleno |
| guarda, diente, brazo, manga, bidon, bota, proteccion | son prefijos: no se corrigen |

### 4.4 M3 `20260930030000_terminos_relajables.sql`

`diagnosticar_terminos(p_terminos jsonb, p_cabeza int) returns table(grupo_idx int,
en_catalogo boolean, con_cabeza boolean)`.
- Recorre los productos activos con precio, con `patron_busqueda`.
- Solo corre cuando fallaron el primer intento y el corrector.
- Es `security invoker`, con los dos revokes y el grant a `service_role`.

### 4.5 M4 `20260930040000_sinonimos_de_seba.sql` (D4)

- Siembra en `ai_lessons` los 14 sinónimos de 2.7, con `kind='sinonimo'` y
  `scope='global'`. «relación» va dos veces: →corona y →piñón.
- Es idempotente (`where not exists`).
- `created_by` se valida contra el esquema real.

### 4.6 M5 `20260930050000_leccion_no_corregir.sql` (D5)

- Amplía el CHECK de `ai_lessons.kind` a `nota`, `sinonimo` y `no_corregir`, con una
  columna o regla para la palabra: el implementador la verifica contra las constraints
  de hoy.
- Deja la RLS igual que para las demás lecciones.

### 4.7 M6 `20260930060000_resumen_busquedas.sql` (T9)

`resumen_busquedas(p_desde timestamptz)` agrega `agent_turns.catalog_queries` en SQL.

**Desvío sobre la nota del operador (lo explico):** se hace `security definer` con
`is_agent()` chequeado UNA vez, no `invoker`.
- La RLS de `agent_turns` es `is_agent()` por fila. Recorrer 30 días así es la misma
  trampa que tumbó la búsqueda de `/inbox` (migración `20260921030000`).
- Lleva los dos revokes y el grant a `authenticated`, y se suma al guardián
  `permisos-funciones.test.ts`.
- Maneja las filas v1 y v2 juntas.

### 4.8 El registro por búsqueda (`ConsultaCatalogo`, v2)

Es lo que se persiste en `catalog_queries`, y se vuelve un contrato con el panel.
- **Versión.** Suma `v: 2`. Las filas v1 (sin `v`) se leen igual y lo que falta se pinta
  «—».
- **Lo que viene del parser:** `variantes`, `anio` y `motoMarca`.
- **Lo que decidió la búsqueda:**
  - `motoIgnorada`, `calzaEntero`, `relajados`;
  - `avisos: AvisoCatalogo[]`, con estos tipos: `universales`, `moto_sin_calce`,
    `relajado`, `relajado_agotado`, `variante_agotada`, `varias_opciones`.
- **El corrector:** `corregido` y `correccionDescartada` (por la guarda de producto).
- **`decision`:** un texto corto y fijo que arma el código. Por ejemplo, «moto SBR calza:
  cotizó 3 de 5, hay 2 más» o «corrector: vicera→visera descartado por la guarda de
  producto».
- **`cotizados`:** `{productId, nombre, stock, precioUsd}[]`.
- **`conteos`:** `{calzan, conStock, nombranMoto, universales}`.

## 5. Tareas

Cada tarea la hace un subagente `implementador` (Sonnet). Primero se escribe el test que
falla y después el código. Al terminar, cada subagente entrega su reporte.

**T0 — orquestador.**
- Crear el worktree, correr `npm ci` y copiar `.env.local`.
- Levantar Redis local con la receta de `redis-queue.ts`.
- Comprobar que la base local responde (Kong con `docker port`).

**T1 — Fixture y casos.**
- `src/lib/ai/__fixtures__/catalogo-a2.ts` trae los nombres de Saint citados en 2.1 a
  2.7, con su stock. Suma el ruido que tapaba los correctos: BRZ/KAVAK/KLR, GRIS, OWEN
  2014, VISERA CASCO FRANKIE, LIGA FRENO LATA, TACOMETRO, CROMADO, 120/70 y los cauchos
  rin 10. **El ruido va primero.**
- `src/lib/ai/__fixtures__/casos-a2.ts` trae, cada uno con su resultado esperado según
  las decisiones:
  - los casos de 2.1 a 2.6;
  - la tabla de no regresión;
  - la tabla del corrector;
  - las conversaciones de dos turnos;
  - la lista de producción del 29/9 (ver la sección 6).
- `scripts/fixture-a2-sql.ts` genera `scripts/sql/fixture-catalogo-a2.sql`, que inserta
  con el prefijo `A2FIX-` y trae también su borrado.

**En paralelo, después de T1:**
- **T2 — M1.** Tests en `supabase/tests/buscar_productos.sql`: GR contra GRIS, 45 contra
  45T y 5000, las variantes, los universales, «ASIENTO SBR /SOC», y el desempate por stock
  antes que por nombre. Actualiza `database.types.ts`.
- **T3 — M2 y M3.**
  - Tests SQL: `corregir_terminos.sql` (la tabla de 4.3) y `diagnosticar_terminos.sql`.
  - `catalog-correction.ts` recibe los parámetros nuevos y gana `diagnosticarTerminos()`,
    que nunca lanza. Con sus tests.
- **T4 — `catalog-search.ts`.** Todo 4.1, con su test. Es TS puro.
- **T6 — M4 y M5.**
  - Tests SQL `sinonimos_de_seba.sql` y el caso nuevo en `ai_lessons.sql`.
  - `pideVerTodo` gana las frases nuevas, con sus tests.

**T5 — `tools.ts` y compañía (después de T2, T3, T4 y T6).**

`buscarUno` sigue este orden:
1. Primer intento.
2. Corrector. `p_protegidos` lleva las motos y las lecciones `no_corregir`; `p_marcas` y
   `p_excluidos` vienen de las listas. Tiene una **guarda de producto**: si la cabeza no
   se corrigió y ninguna fila del reintento empieza con ella, el reintento se descarta y
   se anota.
3. D3: `diagnosticarTerminos`, relajar y tercer intento.
4. La decisión, con esta precedencia:
   - **La moto calza:** tope de 3 + «Hay N más», como hoy.
   - **D1** (ventana `filas_que_nombran_moto`; si no está de acuerdo con la bandera,
     gana la ventana).
   - **Variantes estrictas y D2.** Las posicionales son preferentes: restringen solo si
     ese subconjunto tiene stock, y nunca en caucho ni en tripa.
   - **D1b** dentro de una lista.
   - **«Ya se preguntó y no llegó un dato»:** escala sin cotizar.
   - **«Ver todo»:** 3 por relevancia y después por stock.

Qué cambia en cada archivo:
- `CatalogOutcome` suma `avisos` y `motivoForzado`, y `ConsultaCatalogo` pasa a v2
  (sección 4.8).
- `quote-message.ts` pinta los avisos y el bloque «Otras opciones con existencia».
- `seba.ts` recibe los textos fijos nuevos, literales y con test.
- `catalog-memory.ts` guarda `anio` y `preguntaTipo`, y sigue leyendo los objetos
  viejos. Una respuesta suelta que es un año, o un número de 2 dígitos después de la
  pregunta por la moto, va a `anio`. La misma respuesta después de la pregunta por el
  producto sigue siendo una medida.
- `agent.ts` solo cambia en la red de seguridad: `motivoForzado` y la nota con los
  renglones.
- `tools.test.ts`: el fake de `buscar_productos` pasa a la semántica nueva, con todos
  los casos de `casos-a2.ts`.
- `buildCatalogTool(deps, outcome)` conserva la firma, porque el arnés del VPS la llama
  así.

**T7 — Arnés local y en el CI.**
- `scripts/arnes-catalogo-a2.test.ts` va fuera de la suite normal. Pasos:
  1. carga el fixture con psql como postgres (`products` es de solo lectura);
  2. corre el `buildCatalogTool` real con Redis real sobre todos los casos, incluidas
     las conversaciones de dos turnos;
  3. compara contra lo esperado, con la regla **cero casos peor**;
  4. borra el fixture.
- En `.github/workflows/ci.yml`, el job que reconstruye la base suma un servicio Redis y
  un paso que carga el fixture y corre el arnés. **Queda para todas las entregas
  siguientes.**

**T9 — Pestaña «Búsquedas» en Control IA (después de T5 y T6).**
- **Dónde vive.**
  - Un componente propio, `catalog-searches-panel.tsx`.
  - En `agent-control-view.tsx` solo se suman la pestaña (al lado de «Lecciones», con el
    contador de hoy) y el refresco que ya hay por `postgres_changes` sobre
    `agent_turns`.
  - `fetchCatalogSearches` y `fetchSearchSummary` en `lib/data.ts`.
- **Bloque A, resumen.** Hoy, 7 o 30 días, leído de `resumen_busquedas`. Cuenta:
  - los resultados;
  - los avisos por tipo;
  - las correcciones y las descartadas;
  - los relajos y los que terminaron cotizando;
  - las cotizaciones y los productos distintos.
- **Bloque B, lista.**
  - Filtros: resultado, aviso, con corrección, relajadas, listas y texto libre.
  - Al expandir una fila se ve lo que se buscó, el corrector, el relajo, la decisión con
    sus conteos, lo cotizado, los avisos y el motivo de la escalada.
  - Dos botones: «Abrir chat» y «Enseñar sinónimo». Este último abre `TeachSebaModal`
    con el primer obligatorio que no calzó y alcance global.
- **Bloque C, lo que Seba no encuentra.** 30 días: los términos obligatorios que dieron
  `sin_resultados`, agrupados, con la cantidad, la fecha y el botón de sinónimo.
- **Bloque D, correcciones.** 30 días: original→corregido, cuántas veces y en qué
  terminó. Botón «No corregir esta palabra» (D5).
- **«Lecciones de Seba»** lista y deja apagar las `no_corregir`.
- **Tests.**
  - SQL de `resumen_busquedas`, con filas v1 y v2 mezcladas.
  - `fetchCatalogSearches` con filas sin `v`.
  - Componente: los filtros, expandir una fila, una fila v1, el sinónimo precargado y
    «Abrir chat».
- **Verificación en pantalla.** Con Playwright sobre el build de producción: jsdom no
  calcula el layout.

**T8 — Docs.**
- **`CLAUDE.md` (trampas):**
  - los tres errores de diseño de la A: la moto por prefijo, el año como término, el
    corrector sin límites;
  - `catalog_queries` es un contrato con el panel: cambiarle la forma exige subir `v` y
    que el panel siga leyendo las versiones anteriores;
  - `patron_busqueda` es la única fuente de los patrones;
  - las variantes son estrictas y las posicionales, preferentes;
  - qué es «otra moto»;
  - D3 por co-ocurrencia;
  - el arnés corre en el CI.
- **`docs/GLOSARIO.md`:** Búsquedas, aviso, relajo, corrección descartada, universal.
- **`docs/PRODUCCION.md`:** las 6 migraciones en orden y antes del código; en §15, cómo
  verificar la pestaña.
- **`docs/entregas/2026-09-30-seba-a2.md`:**
  - la rama, los commits y las migraciones en orden;
  - los casos de la sección 6, cada uno con su resultado;
  - los cambios que D1 hace a propósito. Por ejemplo, «rin trasero paleta» para TX250 ya
    no cotiza el RIN EK XPRESS: escala, porque nombra otra moto;
  - la nota sobre la numeración frente a B.

## 6. Resultados esperados clave

- **Lista de producción del 29/9:**
  - asiento → los 3 ASIENTO SBR de mayor existencia, con «Hay N opciones más»;
  - «caucho n° 18 delantero» → se busca «caucho 18» → varias opciones;
  - «caucho n° trasero» → varias opciones;
  - rodamiento → varias opciones (los KIT RODAMIENTO BERA no nombran SBR);
  - aceite → varias opciones.

  Una sola escalada, `confirmar_inventario`, con los cinco renglones en la nota.
- **Corrector:**
  - «casco frankie negro vicera azul» → CASCO FRANKIE NEGRO MATE V/AZUL, nunca la VISERA;
  - «llanta» → sin resultados, nunca LIGA FRENO LATA;
  - «intercomunicador para parejas» → no sale agotado.
- **No regresión:** la tabla de la sección 5 del prompt, completa (Inca, oilstone, motul
  15w50, las rolineras, ipone, botas impermeables, tanque rkv, defensa gxs 250, asiento
  sbr, pastillas GR250, givi h11.7, la lista de cauchos, timsun pista, guardafango horse,
  motul 20/50, horsen, beta).

## 7. Commits en `entrega/seba-a2`

Van en este orden. Cada commit con migración lleva `[migración]` en el título y va solo.

1. M1: la búsqueda, la moto por palabra y las variantes.
2. M2: el corrector con límites.
3. M3: los términos que se pueden relajar.
4. M4: los sinónimos de Seba.
5. M5: la lección «no corregir».
6. M6: el resumen de búsquedas.
7. Código: el parser.
8. Código: el corrector y el relajo.
9. Código: `tools`, la cotización, la memoria y `pideVerTodo`.
10. El arnés y el CI.
11. La pestaña «Búsquedas» (8b).
12. Los docs.

Los mensajes van en español y narrativos, con `git commit -F`. Se pushea
`entrega/seba-a2` y también `ci/seba-a2`. **`main`, nunca.**

## 8. Verificación

- **Suite, tipos y lint:** `rtk npx tsc --noEmit`, `rtk npm run lint` y
  `rtk npm run test`, todos en verde.
- **Base local:**
  - las 6 migraciones se aplican con `psql -1 -v ON_ERROR_STOP=1`;
  - todos los `supabase/tests/*.sql` en verde (los que usan `\i`, con la receta de
    `docker cp` o tar).
- **Arnés:** en verde, en local y en el CI, sobre la base reconstruida más el fixture.
- **Build:** `rtk proxy npm run build`, mirando el timestamp de `.next/BUILD_ID`. La
  pestaña se verifica en pantalla con Playwright.
- **Mutaciones.** Respaldo con `cp`, nunca `git checkout --`. Cada una tiene que poner
  algo en rojo:
  - la moto con `\m` a secas (vuelve GRIS);
  - `\M` en lugar de `([^0-9]|$)` (se pierde 45T), y al revés (vuelve 5000);
  - el año de vuelta a los grupos;
  - sin la guarda de producto (vuelve la VISERA);
  - el corrector sin la regla de prefijo (vuelve «dientes»);
  - D3 sin mirar co-ocurrencia;
  - desempate por nombre en lugar de por stock;
  - los universales sin excluir otra moto;
  - `pideVerTodo` sin «ni idea» (el caso del intercomunicador);
  - `catalog_queries` sin `v` (el panel tiene que seguir en verde con filas v1).
- **CI real** en verde sobre `ci/seba-a2`.
- **VPS:** su arnés contra `entrega/seba-a2`, con 0 turnos peor. Recién después viene el
  fast-forward.
