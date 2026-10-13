# Entrega "Carrito de cotización en el Inventario, con Cashea" (12/10/2026)

Para el operador y el Claude del VPS. **Sin migraciones, sin variables nuevas, sin dependencias
nuevas.** No se pushea a `main` directo: un push a `main` despliega solo (Dokploy).

Plan: `docs/planes/2026-10-12-carrito-inventario-cashea.md`.

**Esta rama contiene la entrega de la calculadora Cashea.** Se apoya en `entrega/calculadora-cashea`
(`fbbf793`, otra sesión) y la incluye entera. Llevando esta rama a `main` sale todo junto:
calculadora y carrito. No hace falta desplegar la calculadora por separado.

## Ramas (se usa una sola, según qué entre primero a `main`)

| Rama | Parte de | Cuándo usarla |
|---|---|---|
| `entrega/carrito-inventario-cashea` | `entrega/calculadora-cashea` (`fbbf793`, sobre `5799edd`) | Si sale ANTES que el precio estándar MRW. |
| `entrega/carrito-inventario-cashea-sobre-mrw` | `entrega/calculadora-cashea-sobre-mrw` (`24d82cf`, sobre `8d59c70`) | Si MRW ya está en `main`. |

La segunda es la primera con los choques con MRW resueltos: la línea de la tarjeta «Sin peso», la
copia viva `vivo` de la fila y `shippingFeeUsd` en las fábricas de los tests. Antes de nada, hay que
confirmar en qué commit está producción.

`hotfix/360dialog-fila` (`64353bd`) solo comparte `docs/GLOSARIO.md` con esta entrega, y en otras
líneas.

## Qué ve el asesor

- **Fila del Inventario.** Al final de los badges de `.inv-status` aparecen dos botones:
  - **«Agregar»**: después del primer clic dice «En carrito ×N» y cada clic suma una unidad. Se
    deshabilita si Saint dio de baja el producto.
  - **«Cashea»**: abre la calculadora del producto, la que hizo la otra sesión.
- **Cabecera.** «Carrito · N» abre un panel lateral; en celular ocupa todo el ancho. El panel trae:
  - El desglose: cantidad editable, unitario y subtotal en Bs. y $, y los avisos «Sin stock», «Solo
    hay N», «Sin precio (falta la tasa)» y «Saint lo dio de baja».
  - El interruptor «Financiar con Cashea», con los mismos controles de la calculadora: nivel N6→N1,
    3 o 6 cuotas y bajada de inicial.
  - Un único bloque de totales, siempre visible al pie: total en Bs., total en $ y, con Cashea,
    inicial, cada cuota con sus Bs., «N cuotas, cada 14 días, sin intereses» y el monto financiado.
  - «Copiar para WhatsApp» y «Vaciar», con confirmación en línea.
- **Persistencia.** El carrito queda en el navegador del asesor: se guardan solo los ids y las
  cantidades, por asesor. Sobrevive a buscar, paginar y recargar. Los precios son siempre los de hoy
  (D6).

## Qué cambió en la calculadora (T7)

Nada que el asesor vea: se comparó la captura a 375 px con la de su entrega y es idéntica. Por
dentro, sus controles y su resumen pasaron a dos piezas compartidas, `CasheaControles` y
`CasheaResumen` (en `src/components/cashea/`), que ahora usa también el carrito. Sus tests siguen
en verde sin editarlos.

El aviso de 6 cuotas queda uno solo, el de la calculadora, en `AVISO_SEIS_CUOTAS`. El carrito
adopta su regla de cuotas: si el total baja a $100 o menos con 6 elegidas, queda en 3 y no vuelve
solo a 6.

## Decisiones (pendientes P1–P6 con su valor por defecto)

- **P1.** Un producto sin stock, o por encima del stock, se puede agregar y el renglón avisa. Los
  inactivos no se pueden agregar.
- **P2.** Se financia el precio promoción en $ (`productPriceUsd`).
- **P3.** La inicial y la cuota en Bs. se calculan como $ × tasa del día. Como el $ se redondea
  hacia arriba por renglón, pueden quedar unos céntimos por encima del N % del total en Bs.
- **P4.** El carrito se guarda en el navegador, sin tabla ni migración.
- **P5.** No hay «pasar a una conversación» (fase 2).
- **P6.** Rigen los mismos pendientes de la constante `CASHEA` que la calculadora.

## Commits (sobre `fbbf793`)

1. «Las reglas de precio del carrito sirven también para un carrito sin conversación» (T1).
2. «Los controles y el resumen de Cashea quedan en dos piezas…» (T3).
3. «El carrito de cotización del Inventario suma en Bs. y en $ con el precio de hoy» (T2).
4. «El carrito del Inventario se abre en un panel lateral…» (T4).
5. «Cada repuesto del Inventario se agrega al carrito desde su fila» (T5).
6. «La calculadora y el carrito muestran Cashea con las mismas dos piezas» (T7).
7. Esta nota, el plan y el GLOSARIO.

En la variante sobre MRW hay además un commit que suma `shippingFeeUsd: null` a las fábricas de
los tests.

## Verificación

- Suite completa (`npx vitest run`): 4764 tests en verde (225 archivos, 1 skipped, el de Redis).
  En la variante sobre MRW, 4792.
- `tsc --noEmit`: limpio en las dos ramas.
- `eslint`: 0 errores; las 7 advertencias ya existían, en archivos ajenos.
- `npm run build` (Turbopack): OK.
- Playwright sobre el build de producción, contra la base local, a 1440×900 y 375×812:
  - Capturas en `docs/entregas/2026-10-12-carrito-inventario-cashea/`: carrito vacío, con 3
    productos y con Cashea encendido.
  - El carrito sigue en «Carrito · 3» después de recargar.
  - Sin desborde horizontal, ni en la página ni dentro del panel.
  - Sin errores de página.

## Mejoras vistas fuera de alcance (solo anotadas)

- **Formatos mezclados en el texto para WhatsApp.** `cartSummaryText` (también lo usa la Bandeja)
  escribe `$218.00`, pero el total en Bs. y el bloque Cashea van en es-VE (`$54,50`).
- **Pie del panel en celular.** Con Cashea encendido, el bloque de totales ocupa casi la mitad de la
  pantalla. Funciona, porque el resto se desplaza, pero un modo compacto lo aliviaría.
- **Advertencia en los tests.** react-aria avisa en jsdom «PressResponder without a pressable
  child», porque el Drawer se controla sin botón disparador. Es inofensivo.
- **Ramas de respaldo locales, sin subir.** `respaldo/carrito-antes-de-unificar` y
  `respaldo/carrito-sobre-mrw-antes-de-unificar` guardan la primera versión, que traía un modal de
  calculadora propio. Se pueden borrar.
