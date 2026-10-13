# Entrega "Calculadora Cashea en el Inventario", 12/10/2026

Para el operador y el Claude del VPS. **Sin migraciones, sin variables nuevas,
sin dependencias nuevas.** No se pushea a `main` directo: un push a `main`
despliega solo (Dokploy).

Hay **dos ramas con el mismo contenido**; se usa una sola, según qué entre
primero:

| Rama | Parte de | Cuándo usarla |
|---|---|---|
| `entrega/calculadora-cashea` | `5799edd` (producción al 12/10) | Si la calculadora sale ANTES que el precio estándar MRW |
| `entrega/calculadora-cashea-sobre-mrw` | `8d59c70` (`entrega/precio-estandar-mrw`) | Si MRW ya está en `main` |

La segunda es la primera rebasada sobre MRW con los choques resueltos (ver
«Choque con MRW»). Antes de nada, confirmar en qué commit está producción.

## Qué hace

Cada fila del Inventario lleva un botón **«Cashea»** al final de sus badges.
Sale también en productos inactivos o sin stock, porque es una cuenta y no una
venta. El botón abre el modal **«Calcular con Cashea»**:

- **Monto**: precio unitario × cantidad. El precio sale de `productPriceUsd`,
  el mismo $ que muestran la fila, el carrito y Seba. Un **monto manual en
  dólares** lo reemplaza y cubre el caso de un carrito sumado a mano. Si no hay
  tasa BCV y el producto está en bolívares, el modal avisa y funciona solo con
  el monto manual.
- **Nivel**: de N6 a N1, con su %.
- **Cuotas**: 3 o 6. El 6 está deshabilitado con $100 o menos y queda un aviso
  fijo. Si había 6 y el monto baja, el modal pasa a 3.
- **Interruptor «Bajada de inicial»**, apagado por defecto.
- **Resumen**: inicial, cada cuota (con una nota si la última difiere),
  financiado y total.
- **Cronograma**: un pago cada 14 días, en hora de Caracas, con la nota
  «Fechas de referencia; las fija Cashea».
- **Comparativa**: los 6 niveles, con el elegido resaltado.
- **Mensaje para WhatsApp**: listo para copiar con el botón «Copiar».

El modal no guarda nada, ni en la base ni en `localStorage`. **Seba no lo
usa**: su prompt y `price-guard.ts` siguen prohibiéndole calcular cuotas.

## Commits

1. `3884c07`: «Las cuentas de Cashea viven en código y en centavos, listas
   para el mostrador». Agrega `src/lib/cashea.ts` y su test (22 casos).
2. `c151e9c`: «El asesor calcula el plan Cashea de un producto sin salir del
   Inventario». Agrega el modal, el botón de la fila, el CSS `inv-cashea-*` y
   el glosario.

En la rama sobre MRW son `fdb1db6` y `69d4a6c`.

**Ojo:** `3884c07` también está en la rama `entrega/carrito-inventario-cashea`
de otra sesión, que lo tomó como su T0 («Carrito de cotización en el
Inventario con Cashea»). Es el mismo commit, así que las dos ramas comparten
`cashea.ts` y no lo duplican.

## Valores que quedaron por defecto (P1–P7 del plan)

Todos viven en la constante `CASHEA` de `src/lib/cashea.ts`. Cambiar uno es
cambiar un número.

| Pendiente | Valor por defecto |
|---|---|
| P1 | N3 estándar al 30 %. La respuesta rápida «Nivel cashea» dice 40 %: hay que corregir una de las dos desde el panel. |
| P2 | Bajada de inicial con interruptor, apagado. Si es la tabla definitiva, se borra el bloque marcado «P2» en el modal. |
| P3 | Con $100 exactos no hay 6 cuotas: el umbral es estrictamente mayor. |
| P4 | 6 cuotas en las dos tablas. |
| P5 | No se bloquea la compra mínima de $25. |
| P6 | Un producto × cantidad, más el monto manual. El mensaje lleva "$" a secas. |
| P7 | Se financia el precio promoción (`productPriceUsd`). |

El mensaje va en **texto plano, sin asteriscos de negrita**: la plantilla de la
especificación no traía ninguno.

## Decisiones tomadas sobre la marcha

- **El interruptor apagado va en gris** (`--lm-muted`), no en el rojo heredado
  de Control IA. Allá el rojo avisa de algo apagado; acá «sin bajada» es la
  tabla normal. Se decidió mirando las capturas.
- **El aviso sin tasa dice «escribe»**, no «escribí»: es el tuteo del resto de
  la app.
- **`parseMontoInput` rechaza "1.234"**: admite hasta dos decimales y no tiene
  separador de miles.
- **Cantidad inválida** (vacía, 0 o con decimales): el cálculo usa 1.
- **El modal muestra el nombre del producto** en la primera línea del cuerpo.

## Verificación

- **Suite completa** en `entrega/calculadora-cashea`: 4670 tests en verde
  (220 archivos). Nuevos:
  - `cashea.test.ts`, 22 tests: umbral, ajuste, suma exacta en centavos sobre
    7 montos × 6 niveles × bajada × cuotas, el caso real del 13/9 ($122, N3, 6
    cuotas → $36,60 + 5×$14,23 + $14,25), configuración inyectada, cronograma,
    comparativa, mensaje y `parseMontoInput`;
  - `cashea-calculadora.test.tsx`, 15 tests;
  - 2 tests nuevos en `producto-fila.test.tsx`.
- **`npm run lint`**: 0 errores. Quedan 7 avisos, ya existentes, en otros
  archivos de test.
- **`tsc --noEmit`**: sin errores.
- **`npm run build`**: compila.
- **Mutaciones**. Las dos se restauraron después:
  - el umbral cambiado de `>` a `>=` pone en rojo el test del umbral;
  - quitar `aria-current` de la fila elegida pone en rojo el test de la
    comparativa.
- **Pantalla**: Playwright sobre el build de producción contra la base local,
  logueado como asesor, a 1440 × 900 y a 375 × 812:
  - el documento y el modal no desbordan a lo ancho;
  - el cuerpo del modal scrollea;
  - la tabla entra en su contenedor;
  - no hay errores de consola;
  - el mensaje de $118 / N4 / bajada / 6 cuotas sale exacto;
  - con $85, el botón 6 se deshabilita y el 3 queda marcado.

  Capturas en `2026-10-12-calculadora-cashea/`: `escritorio.png`,
  `telefono-arriba.png` y `telefono-abajo.png`.
- **Rama sobre MRW**: suite completa con 4698 tests en verde, `tsc` y ESLint
  limpios.

## Choque con MRW (ya resuelto en `entrega/calculadora-cashea-sobre-mrw`)

`producto-fila.tsx` y `producto-fila.test.tsx` chocan porque las dos ramas
agregan cosas al final de los mismos bloques. La resolución es quedarse con
las dos, más tres ajustes:

1. En la fila, la calculadora recibe `vivo` (el producto que MRW relee tras
   guardar el peso) en lugar de `product`.
2. En el test de la fila, se restaura el cierre `}); });` del `describe` de
   MRW, que la resolución automática se comía.
3. En `cashea-calculadora.test.tsx`, el fixture gana `shippingFeeUsd: null`,
   porque MRW lo vuelve obligatorio en `Product`.

## Para el VPS

Llevar `main` a la rama que corresponda, con fast-forward. No hay nada que
aplicar en la base. Después del deploy, en `/inventario`:

1. Abrir «Cashea» en un producto en bolívares.
2. Comprobar que el monto coincida con el $ del pie de la fila.
3. Elegir 6 cuotas en uno de más de $100.
4. Copiar el mensaje.

## Visto fuera de alcance (solo anotado)

- **Cada fila monta su propio modal** (cerrado, no pinta nada). Con 50 filas
  por página no se nota. Si algún día pesa, se puede montar uno solo en
  `InventarioView`.
- **La respuesta rápida «Nivel cashea»** quedará desalineada de la
  calculadora en N3 (ver P1).
- **Fase 2 posible**: un botón «enviar plan al chat» desde la Bandeja.
