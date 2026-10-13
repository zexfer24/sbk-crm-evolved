# Plan "Carrito de cotización en el Inventario, con Cashea" (12/10/2026)

Aprobado por el operador el 12/10/2026 ("te apruebo el plan que vos decidas"). Entrega única:
rama `entrega/carrito-inventario-cashea` (incluye la calculadora Cashea por producto). Sin migración.

## Base y rebase

- Base: `origin/main` = `5799edd` (producción) + `3884c07` (`cashea.ts`, T1 de la calculadora,
  que estaba sin commitear en el worktree `SBK CRM-cashea`). La rama `entrega/calculadora-cashea`
  quedó vacía (= `5799edd`) y esta entrega la reemplaza.
- No se parte de `entrega/precio-estandar-mrw` (`6477ca8`): trae una migración que el VPS todavía
  no aplicó. Choca en `producto-fila.tsx` (imports, estado `vivo`), `inventario.css` y
  `producto-fila.test.tsx`. Si MRW llega primero a `main`, esta rama se rebasa encima: lo nuevo de
  la fila son dos botones dentro de `.inv-status` y no toca el precio. Se ensaya el rebase al cierre.

## Decisiones (pendientes del operador con su valor por defecto)

- P1: sin stock o por encima del stock se puede agregar, y el renglón avisa. Los inactivos no se
  pueden agregar desde la fila; si uno guardado pasó a inactivo, el renglón avisa "Saint lo dio de baja".
- P2: se financia el precio promoción en $ (`productPriceUsd`).
- P3: inicial y cuotas en Bs. = $ × tasa del día (`bsDeCents`).
- P4: el carrito se guarda en `localStorage` del asesor (`sbk:inventario-carrito:v1:<agentId>`), solo
  ids y cantidades. Precio siempre vigente (D6).
- P5: no hay "pasar a una conversación" (fase 2).
- P6: aplican los pendientes de la calculadora (misma constante `CASHEA`).
- Panel: `Drawer` de HeroUI 3.2.4 (sí existe, `placement="right"`). Si no funciona en jsdom, se
  usa `Modal`.
- Las cuotas pedidas se conservan en el estado y la UI muestra las efectivas (`plan.cuotas`). Con el
  total ≤ $100 se ve "3" y el aviso fijo; si el total vuelve a superar $100, reaparece "6".
- Cashea (encendido, nivel, cuotas, bajada) vive en el provider: sobrevive a cerrar el panel, pero
  no se guarda.
- Formato: los montos en pantalla salen en es-VE (`formatUsd`, `formatBs` de `cashea.ts`). El texto
  para WhatsApp reutiliza `cartSummaryText` tal cual (su formato `$218.00`) y agrega el Bs. en es-VE
  y el bloque Cashea. La mezcla de formatos queda anotada como mejora fuera de alcance.
- Calculadora por producto (botón "Cashea" en la fila): no hubo un spec fuera de `cashea.ts`, así
  que el modal se arma con lo que ese módulo exporta: monto editable (`parseMontoInput`, precargado
  con el precio promoción), controles, resumen, cronograma, comparativa N6→N1 y copiar
  `mensajeWhatsApp`.

## Tareas y orden

| Tarea | Qué | Modelo | Depende de |
|---|---|---|---|
| T0 | `cashea.ts` + tests (hecha, `3884c07`) | — | — |
| T1 | Tipos genéricos en `conversation-cart.ts` + `fetchProductsByIds` | Haiku | T0 |
| T3 | Helpers en `cashea.ts` + `CasheaControles` / `CasheaResumen` | Sonnet | T0 (en paralelo con T1) |
| T2 | `inventario-carrito.ts` (lógica pura) | Sonnet | T1, T3 |
| T4 | Provider + `carrito-panel.tsx` + CSS | Sonnet | T2 |
| T6 | `calculadora-cashea-modal.tsx` | Sonnet | T3 (en paralelo con T4) |
| T5 | Botones de la fila y de la cabecera, cableado en la vista | Sonnet | T4, T6 |

Cierre (orquestador): suite completa, lint, tsc, build; verificación visual con Playwright sobre el
build de producción (escritorio y 375 px; vacío, con 3 productos, con Cashea); ensayo de rebase
sobre MRW; GLOSARIO; reporte de entrega.

## Tests (terminado = todo en verde)

- `cashea.test.ts`: `bsDeCents`, `formatBs`, `lineaInicial`/`lineaResto`, `AVISO_SEIS_CUOTAS`, y
  `mensajeWhatsApp` idéntico al de antes.
- `inventory-data.test.ts`: `fetchProductsByIds` (vacío → sin consulta; `.in("id", …)` con ids
  únicos; lanza ante error).
- `inventario-carrito.test.ts`: los casos del pedido del operador (reducer, lectura de lo guardado,
  totales con y sin Cashea, redondeo por renglón, sin tasa, USD, texto exacto, avisos por renglón).
- `cashea-controles.test.tsx`, `cashea-resumen.test.tsx`, `carrito-panel.test.tsx`,
  `calculadora-cashea-modal.test.tsx`, `producto-fila.test.tsx` (los botones nuevos) e
  `inventario-view.test.tsx` (el botón de la cabecera).
- Sin editar y en verde: `conversation-cart.test.ts`, `cart-lines`, `conversation-cart-block` y los
  tests actuales de la fila, la vista e `inventario-css.test.ts`.
- Regla del operador: primero el test en rojo, después el código.

## Cambio de base durante la ejecución (12/10/2026, noche)

Mientras corría este plan, otra sesión terminó y subió la calculadora por producto
(`entrega/calculadora-cashea` = `fbbf793`, y `-sobre-mrw` = `24d82cf`), construida encima del mismo
`3884c07`. Como el pedido decía "si la calculadora ya está en curso, partí de su rama sin duplicar",
la entrega se rehízo encima de la suya:

- T6 (mi modal `calculadora-cashea-modal.tsx`) se DESCARTÓ: queda la calculadora de la otra sesión,
  que salió del spec original.
- T5 deja solo «Agregar» en la fila; el botón «Cashea» es el de la calculadora.
- T7 (nueva): la calculadora pasa a usar `CasheaControles`/`CasheaResumen`, que adoptan su marcado y
  sus textos (era la referencia; lo que ve el asesor no cambia), y el carrito adopta su regla de
  cuotas (≤ $100 con 6 → 3, sin revivir el 6). El resumen del carrito suma "N cuotas, cada 14 días,
  sin intereses" porque el operador pidió ver el número de cuotas en el total.
- Las ramas `entrega/carrito-inventario-cashea[-sobre-mrw]` se reescribieron con esta versión.
