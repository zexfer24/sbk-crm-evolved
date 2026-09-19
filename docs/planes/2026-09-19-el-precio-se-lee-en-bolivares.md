# El precio se lee en bolívares y no se toca

Plan aprobado por el operador el 19/9/2026, sobre `c9b5959` (HEAD de "Seba
atiende el mostrador", sin push). Sin migración. Sale en la misma entrega que
Seba.

## Origen

Pedido del operador tras la verificación visual del 19/9/2026:

1. En Inventario los precios van **en bolívares arriba y el USD debajo** — lo
   contrario de lo que se hizo el 10/9 (USD arriba, línea chica "Bs. …").
2. Los precios **no se modifican desde el CRM**: llegan de la tabla
   `products`, que se carga por fuera.
3. Los arreglos que la verificación visual dejó a la vista (T2).

## Decisiones

- **D1. El precio se cierra solo en la pantalla.** No hay candado en RLS: pide
  migración aparte y antes hay que saber con qué rol se cargan los precios en
  producción (un candado a ciegas rompería esa carga). Queda anotado como
  deuda.
- **D2. "La tabla donde están realmente" es `products`.** Si algún día vienen
  de otro sistema (Saint, una hoja), eso es una sincronización y otra corrida.
- **D3. Stock y Peso siguen editables.** El pedido habla solo de precios.
- **D4. El "undefined responde mientras…" del banner NO se arregla**: era un
  chunk viejo del navegador en `next dev` (trampa ya documentada), el fuente
  está bien y producción compila desde cero.

## T1 — Inventario: bolívares arriba, USD debajo, precio de solo lectura

Archivos: `src/lib/inventory.ts` (+ test), `src/components/inventario/producto-fila.tsx`
(+ test), `src/lib/mutations.ts` (+ test), `docs/GLOSARIO.md`.

- Helper puro nuevo `priceDisplay(product, rate)` en `inventory.ts`, que
  devuelve `{ principal, pie }` ya formateados:
  - USD con tasa: principal `Bs. <precio × tasa>`, pie `$ <precio>`.
  - VES con tasa: principal `Bs. <precio>`, pie `$ <precio ÷ tasa>`.
  - Sin tasa (o tasa 0/negativa): principal en la moneda del producto
    (`$ …` o `Bs. …`), pie `null`. No se inventa un número.
  - Reutiliza `priceInBs`; dos decimales, mismo formato que la fila usa hoy.
- `producto-fila.tsx`: el input de precio se reemplaza por texto (clase
  `lm-num`), se van `priceDraft`, `commitPrice` y el caso `"precio"` de
  `savedField`. Etiqueta "Precio" a secas. El pie `.inv-bs` se reserva
  SIEMPRE (con o sin contenido): la grilla de `.inv-row` no se toca (trampa de
  alineación del 10/9/2026).
- `updateProductPrice` se borra de `mutations.ts` con sus tests, y
  `parsePriceInput` de `inventory.ts` si nadie más la usa (verificar con grep).

Tests:
- `inventory.test.ts`: los cuatro casos de `priceDisplay` (USD con tasa, VES
  con tasa, sin tasa, tasa 0).
- `producto-fila.test.tsx`: no existe un textbox "Precio de …"; se ve "Bs."
  como cifra principal y "$" en el pie; Stock y Peso siguen guardando.
- `inventario-css.test.ts` sigue en verde sin tocarlo.

## T2 — Control IA: el texto dice la verdad y las lecciones no dependen de Realtime

Archivos: `src/components/agent-control/agent-control-view.tsx` (+ test),
`src/components/agent-control/lessons-panel.tsx` (+ test), `docs/GLOSARIO.md`.

- **Texto desactualizado** (`agent-control-view.tsx:629`): "Responde en
  cualquier conversación sin asesor asignado." es falso desde D2 de Seba
  (18/9/2026: la escalada ya no apaga la IA). Nuevo texto: "Responde en toda
  conversación hasta que un asesor le escribe al cliente."
- **El panel de Lecciones no reflejaba su propia acción.** Hoy `LessonsPanel`
  recibe `lessons` por props y solo se pone al día por el canal Realtime de
  `ai_lessons` → `useLiveRefresh`, que pospone a propósito con la pestaña
  oculta y no llega nunca si el canal está caído. Visto el 19/9/2026: la base
  quedó en `is_active = false` y la pantalla siguió diciendo "Activa". Arreglo:
  prop nueva `onChanged: () => void | Promise<void>` que el panel llama tras
  un `setLessonActive`/`deleteLesson` exitoso; la vista le pasa su `refresh`
  directo (no el `scheduleRefresh`, que es el que se pospone). Realtime queda
  para los cambios de OTROS asesores.

Tests:
- `lessons-panel.test.tsx`: tras apagar y tras borrar con éxito se llama
  `onChanged`; si la mutación falla NO se llama y sale el toast de error.
- `agent-control-view.test.tsx`: el texto nuevo aparece y el viejo no.

## Verificación del orquestador

- Suite completa, `tsc`, lint, build (`rtk proxy npm run build` + `BUILD_ID`).
- Mutación manual: invertir principal/pie en `priceDisplay` → el test de la
  fila se rompe; quitar la llamada a `onChanged` → el test del panel se rompe
  (respaldo con `cp`, nunca `git checkout --`).
- Visual en Brave: Inventario (alineación de Stock/Precio/Peso con
  `getBoundingClientRect` en filas USD y VES) y Lecciones (apagar sin recargar).

## Commits previstos

1. "Inventario muestra el precio en bolívares con el dólar debajo, y ya no deja editarlo"
2. "Control IA dice cuándo responde Seba y el panel de lecciones refleja lo que el asesor acaba de hacer"
