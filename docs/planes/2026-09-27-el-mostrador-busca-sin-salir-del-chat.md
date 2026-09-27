# Plan "El mostrador busca sin salir del chat" — 27/9/2026

Pedido del cliente en cinco frentes: (1) panel derecho del buzón con las
etiquetas recogidas y una búsqueda de inventario en su lugar, (2) precios en
dólares redondeados a favor del negocio, (3) Enter envía una imagen pegada,
(4) inventario: código Saint visible, búsqueda por palabras y por código, y
(5) el cuadro de búsqueda que "devuelve" letras borradas.

Estado: **BORRADOR, esperando aprobación del operador.** Sin migraciones:
todo es código, así que la entrega es un push a `main` (despliega solo).

---

## Diagnóstico (lo que se encontró en el código)

| Frente | Causa real | Dónde |
|---|---|---|
| Enter con imagen pegada | `handleKeyDown` llama SIEMPRE a `handleSend` (solo texto). El botón elige `handleSendFiles` si hay adjuntos; el teclado no. Con una imagen y el texto vacío, Enter no hace nada. | `src/components/chat/composer.tsx:449-454` vs `:631` |
| Letras que vuelven | `UrlSearchBox` resincroniza el borrador cada vez que cambia `query` de la URL (`if (query !== lastQuery) setDraft(query)`). Dos caminos lo pisan: (a) una navegación ATRASADA — se empujó "tubo esc", el asesor ya borró a "tub", llega la respuesta de "tubo esc" y el cuadro vuelve a "tubo esc"; (b) `parseInventoryParams` hace `trim()`, así que escribir "tubo " empuja "tubo", la URL vuelve distinta al borrador y se come el espacio. Lo comparten Inventario y Clientes. | `src/components/url-search-box.tsx:38-43`, `src/lib/inventory.ts:276` |
| "tubo cg" no encuentra, "tubo escape cg" sí | La búsqueda es UN solo `ilike '%frase completa%'` sobre `name`/`brand`/`description`. "tubo cg" no es subcadena de "TUBO ESCAPE CG…". | `src/lib/inventory-data.ts:77-83` |
| Los códigos no se encuentran | `saint_code` (columna desde el 25/9) no entra en el filtro. Solo se hallaba si el código seguía escrito en `description`. | mismo lugar |
| Buscador del cierre de venta | Mismo defecto (`searchActiveProducts`, frase completa sobre `name`/`brand`). | `src/lib/inventory-data.ts:208-227` |
| Código no visible | `saintCode` ya viaja en `Product`; la fila no lo pinta. | `src/components/inventario/producto-fila.tsx` |
| Dólares sin redondear | La conversión Bs→USD está copiada en TRES sitios, cada uno con `toFixed(2)`: pantalla de Inventario, carrito del cierre de venta (lo que se guarda en `orders`), y la herramienta de catálogo de la IA. | `inventory.ts:120`, `sale-cart.ts:64`, `ai/tools.ts:474` |
| Etiquetas | El panel pinta las aplicadas Y una segunda lista con TODAS las disponibles como botones "+", que es lo que ocupa el espacio. "Gestionar" hoy solo crea/edita/borra etiquetas globales. | `context-panel.tsx:170-219`, `manage-tags-modal.tsx` |

---

## Decisiones (propuestas — confirmar al aprobar)

- **D1. Regla del redondeo:** hacia ARRIBA al siguiente múltiplo de $0,10
  sobre el valor sin redondear: 2,54 → 2,60; 2,01 → 2,10; 2,60 → 2,60; 2,00
  → 2,00 (un monto exacto no sube). Se protege del ruido de coma flotante
  (2,6 que sale 2,6000000001 no sube a 2,70).
- **D2. A qué precios aplica:** solo a los que se CONVIERTEN de bolívares a
  dólares con la tasa BCV. Un producto cuya moneda en `products` ya es USD
  se muestra tal cual. El precio en bolívares no cambia nunca (es el de
  Saint).
- **D3. Dónde aplica — una sola función, tres consumidores:** pantalla de
  Inventario, búsqueda del panel del buzón, carrito del cierre de venta (y
  por tanto `orders`/factura) **y la herramienta de catálogo de Seba**.
  Recomendado que Seba también cotice el redondeado: si no, el asesor dice
  $2,60 y Seba $2,54 por el mismo repuesto. Seba recibe el número YA
  redondeado desde el código; **el system prompt no se toca ni menciona el
  redondeo** (el prompt ya dice "cópialos tal como te llegan, no los
  redondees"). Un test fija que ni `prompt.ts` ni la descripción de la
  herramienta nombran el redondeo. Riesgo aceptado: $ × tasa ya no da
  exactamente los Bs; es el efecto buscado ("a favor del negocio").
  *Si el operador prefiere que Seba siga cotizando el valor exacto, T1 deja
  `tools.ts` fuera y nada más cambia.*
- **D4. Etiquetas recogidas:** las etiquetas YA aplicadas al contacto siguen
  visibles como chips con su ×. Desaparece la lista de "+ disponibles".
  Aplicar una etiqueta se hace desde "Gestionar", que gana arriba una
  sección "En este chat" con las disponibles para aplicar/quitar; abajo
  queda lo de hoy (crear/editar/borrar).
- **D5. El "menú" de inventario:** una sección "Inventario" en el panel
  derecho, entre Etiquetas y Notas internas, con un cuadro de búsqueda y
  hasta 8 resultados: código Saint, nombre, existencia, Bs y $ (redondeado).
  Solo lectura en esta ola; incluye los inactivos marcados como "Retirado"
  para que el asesor no los venda sin saberlo. *Fuera de alcance (propuesta
  para otra ola): botón "insertar en el mensaje".*
- **D6. Búsqueda por palabras:** cada palabra del texto tiene que aparecer
  (en cualquier orden) en nombre+marca normalizados (`search_text`: sin
  acentos, minúsculas, ya indexado con trigram), en el código Saint o en la
  descripción. "tubo cg" encuentra "TUBO ESCAPE CG 150". Un código tecleado
  entero o en parte encuentra su producto. Misma regla para Inventario, el
  panel del buzón y el buscador del cierre de venta. Sin migración: varios
  `.or()` encadenados en PostgREST se combinan con AND. Plurales y
  sinónimos quedan fuera (los tiene la búsqueda de Seba, no esta).

---

## Tareas (una por subagente `implementador`, Sonnet, test ROJO primero)

### T1 — El dólar sale redondeado a favor del negocio
- Nuevo `src/lib/usd-price.ts` (+ `.test.ts`): `usdFromBs(bs, rate): number | null`
  (null sin tasa) con la regla D1.
- Reemplazar las tres copias: `priceDisplay` (`inventory.ts`),
  `productPriceUsd` (`sale-cart.ts`), `precioUsd` (`ai/tools.ts`).
- Tests: tabla de casos D1 (2,54/2,01/2,60/2,00/ruido flotante/tasa 0);
  `inventory.test.ts`, `sale-cart.test.ts` y el test de `tools.ts` con la
  cifra redondeada; test de resguardo "el prompt y la descripción de la
  herramienta no mencionan redondeo". Correr `price-guard` y `agent.test.ts`
  (la guarda de precios necesita la cifra redondeada en el `toolResult`).
- Mutación: cambiar `ceil` por `round` → la tabla se pone roja.

### T2 — Enter envía la imagen pegada
- `composer.tsx`: Enter sin Shift → `handleSendFiles` si hay adjuntos,
  `handleSend` si no; no hace nada mientras `isUploading` (evita doble envío
  con Enter repetido). Tras pegar un archivo, el foco vuelve al cuadro para
  que Enter funcione sin tocar el ratón.
- Tests en `composer.test.tsx`: pegar imagen + Enter envía (con y sin
  texto); Shift+Enter no envía; dos Enter seguidos suben una sola vez.

### T3 — La búsqueda del inventario encuentra por palabras y por código
- Nuevo `src/lib/inventory-search.ts` (+ test): normaliza (minúsculas, sin
  acentos, colapsa espacios), parte en palabras (tope 6) y devuelve un
  filtro `.or()` por palabra sobre `search_text`, `saint_code`,
  `description`, escapado con `pgrstLiteral`.
- Aplicarlo en `fetchProductsPage` y `searchActiveProducts`
  (`inventory-data.ts`), y exportar una variante para el panel del buzón que
  NO filtre por `is_active` (D5).
- Tests: fake que registre operador+columna+valor de cada `.or()` (trampa
  del 20/9: el fake no puede tragarse el argumento); "tubo cg" → dos
  filtros; código con guion; texto con coma/paréntesis no rompe el filtro.
- Verificación contra la base local como `authenticated` (no superusuario,
  trampa del 21/9): insertar como `postgres` "TUBO ESCAPE CG 150" con un
  `saint_code` y comprobar que "tubo cg", "cg tubo" y el código lo traen.
- Actualizar el placeholder a "Buscar por nombre, marca o código".

### T4 — El cuadro de búsqueda no devuelve lo que se borró
- `url-search-box.tsx`: recordar lo último que el propio cuadro empujó; si
  la URL llega con un valor que este cuadro empujó (o su versión recortada)
  mientras el asesor ya escribió otra cosa, NO se pisa el borrador. Solo una
  navegación EXTERNA (atrás/adelante, un filtro) lo reemplaza.
- Tests (`url-search-box.test.tsx`, timers falsos): escribir "tubo esc",
  dejar pasar el debounce, borrar a "tub", re-render con `query="tubo esc"`
  → sigue "tub"; escribir "tubo " con espacio y re-render con `"tubo"` → el
  espacio queda; navegación externa (query nueva que nunca se empujó) sí
  reemplaza. Cubre Clientes también.

### T5 — El código Saint se ve en cada fila
- `producto-fila.tsx`: código en fuente numérica bajo o junto al nombre
  (`—` si no tiene). `inventario.css`: columnas FIJAS (trampa del 10/9, filas
  que se desalinean). Actualizar `producto-fila.test.tsx` e
  `inventario-css.test.ts`.

### T6 — El panel derecho recoge las etiquetas y busca en el inventario
*(Depende de T1 y T3.)*
- `context-panel.tsx`: quitar la lista de "+ disponibles" (D4); nueva
  sección Inventario (D5) con `InventoryLookup`
  (`context-panel/inventory-lookup.tsx` + test): debounce propio, la regla de
  T4 para el cuadro, cancelación de respuestas atrasadas (una respuesta
  vieja no pisa una nueva), `usdFromBs` para el $.
- `manage-tags-modal.tsx`: sección "En este chat" para aplicar/quitar
  etiquetas del contacto (recibe `contactTags` y el `contactId`).
- La tasa BCV ya llega a `crm-shell` (`bcvRate`): pasarla a `ContextPanel`.
- Tests: el panel ya no pinta botones "+"; aplicar desde Gestionar llama a
  `addTagToContact`; búsqueda muestra código, stock, Bs y $ redondeado;
  respuesta atrasada ignorada.
- **Verificación visual obligatoria** (jsdom no calcula layout): Playwright
  sobre `npm start`, panel derecho a 1366 px y a ancho angosto; que la
  sección nueva no desborde ni empuje el grid.

### Cierre (orquestador)
- Suite completa, `tsc`, lint, `rtk proxy npm run build` (+ `BUILD_ID`).
- Escenario a mano: pegar imagen + Enter en un chat; "tubo cg" y un código
  en Inventario y en el panel; borrar rápido en el cuadro.
- `docs/GLOSARIO.md` en el mismo commit de cada archivo tocado; trampa nueva
  en `CLAUDE.md` para el redondeo (una sola función, jamás en el prompt).
- Commits narrativos (uno por tarea), push a `main` (despliega), CI, y
  nota corta al Claude del VPS: sin migraciones, qué verificar en producción.

## Orden

Tanda 1 en paralelo: T1, T2, T3, T4, T5 (archivos disjuntos).
Tanda 2: T6.

## Skills sugeridas

`superpowers:test-driven-development` (regla del operador: test rojo
primero), `superpowers:verification-before-completion` al cierre, y
`code-review high` sobre el rango antes del push.
