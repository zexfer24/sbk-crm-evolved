# Plan "El panel del chat se ordena y el cierre de venta muestra todo" — 26/10/2026

Plan aprobado por el operador el 26/10/2026. Cinco tareas de interfaz, sin
migraciones. Se ejecuta con la metodología `liminalwork`: el orquestador no
implementa, despliega un subagente por grupo, valida cada reporte y corre la
verificación final.

## Contexto (lo que ya se midió en el código)

- **La cédula ya se pinta** en el panel derecho (`context-panel.tsx:88` y
  `:195-200`), pero solo si el contacto la tiene. Al cerrar una venta,
  `closeSaleWithContactInfo` escribe `contacts.cedula_type/cedula_number`
  (`mutations.ts:699`) ANTES de marcar `conversations.deal_status = 'won'`
  (`mutations.ts:712`); ese UPDATE dispara `scheduleDetailRefresh()` en
  `crm-shell.tsx` (canal `messages-<id>`, ~línea 1465) y el detalle se relee
  con `cedula_type, cedula_number` (`CONVERSATION_DETAIL_SELECT`, `data.ts`).
  O sea: la cédula llega sola tras cerrar la venta; lo que falta es que la
  fila exista siempre.
- **El buscador del panel** (`InventoryLookup`) solo se monta en
  `context-panel.tsx`, pero ~40 tests de `inventory-lookup.test.tsx` lo
  renderizan y esperan el input visible. Por eso lo desplegable entra por un
  prop opcional, no como comportamiento por defecto.
- **El buscador del modal «Cerrar venta»** (`sale-items-editor.tsx`) usa
  `searchActiveProducts` (`inventory-data.ts:301`): `.limit(8)` y orden solo
  por `name`. El del panel usa `searchProductsForLookup` (activos primero,
  `stock_quantity` desc `nullsFirst: false`, `name`, `id`, paginado con
  `range`). El modal NO puede usar esa: incluye productos inactivos (D5), y un
  retirado no se factura.

## Reglas de ejecución

- **Primero el test, después el código**: cada test nuevo se escribe, se corre
  y se ve en ROJO antes de implementar.
- Ningún subagente commitea. Un archivo lo toca un solo grupo.
- Si se hace una mutación de verificación sobre código sin commitear:
  respaldar con `cp` antes y restaurar desde esa copia, nunca con
  `git checkout --`.
- Tests que usan DOM llevan `/** @vitest-environment jsdom */`.
- `localStorage` se lee y escribe siempre dentro de `try/catch`; la UI tiene
  que funcionar si lanza.
- Todo en español: textos, comentarios (el porqué, con fecha 26/10/2026),
  nombres nuevos donde el archivo ya los use en español.

## Grupo A — Panel derecho del chat (tareas 1 y 3)

Archivos: `src/components/context-panel/context-panel.tsx`,
`context-panel.test.tsx`, `conversation-cart-block.tsx`,
`conversation-cart-block.test.tsx`.

### Tarea 1. La fila de cédula se ve siempre

- En el bloque de datos del cliente, la fila `IdCard` se pinta SIEMPRE,
  después de «Principal» (canal).
- Sin cédula: texto «Sin cédula» en gris (`var(--lm-muted)`, misma
  convención que «Sin etiquetas todavía»).
- Con cédula: `V-12345678` / `E-12345678` como hoy (`lm-num`).
- La fila de dirección/ubicación no cambia (sigue apareciendo solo si hay
  datos).

Tests (`context-panel.test.tsx`):
1. Contacto con `cedulaType`/`cedulaNumber` en `null` → se ve «Sin cédula».
2. Contacto con `V` + `12345678` → se ve `V-12345678` y no «Sin cédula».
3. `rerender` del panel con la misma conversación pero el contacto ya con
   cédula (lo que pasa tras cerrar la venta) → pasa de «Sin cédula» a
   `V-12345678`.

### Tarea 3. Se quita «Agregar cotizaciones de Seba»

- En `conversation-cart-block.tsx` se elimina el `<Button>` que llama
  `actions.addAllQuotes()` (y el import de `Sparkles` si queda sin uso).
- Texto de carrito vacío: «Todavía no hay nada. Agrega repuestos desde el
  inventario de arriba.» (sin «o trae lo que Seba cotizó»).
- NO se toca: renglones, «Copiar», «Enviar al chat», «Qué copiar»,
  «Guardar presupuesto», «Enviar a SAINT», `PresupuestosCliente`.
- `addAllQuotes` (hook `use-cart-actions.ts`) y `addQuotesToCart`
  (`mutations.ts`) se QUEDAN sin uso en la UI, a propósito, para la
  reestructuración del panel. No borrarlos ni sus tests.

Tests (`conversation-cart-block.test.tsx`):
1. El test «"Agregar cotizaciones de Seba" dispara la acción» se reemplaza
   por uno que verifica que ese botón NO está en el documento.
2. Con carrito vacío se ve el texto nuevo exacto.
3. Revisar `context-panel.test.tsx` (~línea 319-340): si alguna aserción
   busca el botón o el texto viejo, ajustarla.

## Grupo B — Inventario del panel, desplegable (tarea 2)

Archivos: `src/components/context-panel/inventory-lookup.tsx`,
`inventory-lookup.test.tsx`, `src/components/crm.css`. El grupo A cambia
también una línea de `context-panel.tsx` para pasar el prop: **esa línea la
hace el grupo B** coordinando con A, o el orquestador al integrar (no dos
subagentes sobre el mismo archivo a la vez — recomendado: el orquestador la
agrega al final).

### Tarea 2. «Inventario» se abre y se cierra

- Se elimina el párrafo del estado `idle`: «Escribe un nombre, una marca o
  un código Saint para ver existencia y precio.». Se quedan «Buscando…», el
  de error y «Ningún repuesto coincide con «…»».
- Prop nuevo opcional `desplegable?: boolean` (default `false`). Sin él, el
  componente se ve exactamente como hoy (los ~40 tests existentes no cambian).
- Con `desplegable`:
  - El eyebrow «Inventario» pasa a ser un `<button type="button">` con
    `aria-expanded` y `aria-controls`, chevron (`ChevronRight` cerrado /
    `ChevronDown` abierto, de `lucide-react`; mismo patrón que «Qué copiar»
    en `conversation-cart-block.tsx`, clase `crm-pcart-copy-toggle` como
    referencia de estilo).
  - Arranca CERRADO. La preferencia se guarda por visor en
    `localStorage` con la clave `sbk.panel.inventario.abierto` (`"1"`/`"0"`),
    leída en un inicializador perezoso de `useState` con `try/catch` (si
    lanza o no hay valor → cerrado).
  - Cerrado, el cuerpo (buscador + resultados + avisos) queda MONTADO pero
    con `hidden`: cerrar y volver a abrir conserva lo escrito y los
    resultados.
  - Al abrir con el botón, el foco va al input (`inputRef.current?.focus()`).
- `context-panel.tsx`: `<InventoryLookup … desplegable />`.
- CSS en `crm.css`: el botón del título se ve como el eyebrow actual
  (mayúsculas, mismo tamaño y color), ocupa el ancho, cursor pointer, foco
  visible.

Tests (`inventory-lookup.test.tsx`, bloque nuevo `describe`):
1. Sin `desplegable` el input está visible (resguardo del comportamiento
   viejo).
2. Con `desplegable` y sin preferencia guardada: botón «Inventario» con
   `aria-expanded="false"` y el input no visible.
3. Pulsar el botón → `aria-expanded="true"`, input visible y con el foco.
4. Abrir guarda `"1"` en `sbk.panel.inventario.abierto`; un render nuevo con
   `"1"` guardado arranca abierto.
5. Si `localStorage.getItem` lanza, arranca cerrado y no rompe.
6. Escribir, cerrar y reabrir conserva el texto del input.
7. El texto «Escribe un nombre, una marca o un código Saint…» ya no aparece
   en estado inicial.

## Grupo C — Modal «Cerrar venta» (tareas 4 y 5)

Archivos: `src/lib/inventory-data.ts`, `src/lib/inventory-data.test.ts`,
`src/components/context-panel/sale-items-editor.tsx`,
`src/components/context-panel/close-sale-modal.test.tsx`,
`src/components/crm.css` (**solo** las reglas `.crm-cart-results` y nuevas
del modal; si el grupo B está tocando `crm.css` al mismo tiempo, correr C
después de B o dejar el CSS de C al orquestador).

### Tarea 4. Primero lo que tiene stock, y se puede ver todo

- `searchActiveProducts(supabase, query, limit = 30, offset = 0)`:
  - sigue filtrando `is_active = true` (no se factura un retirado);
  - orden: `stock_quantity` desc con `nullsFirst: false`, luego `name` asc,
    luego `id` asc (orden total para paginar estable, igual criterio que
    `searchProductsForLookup`);
  - `.range(offset, offset + limit - 1)` en lugar de `.limit(limit)`.
  - Actualizar el comentario de la función (por qué: el modal mostraba 8 en
    orden alfabético y los agotados tapaban a los que había, 26/10/2026).
- `sale-items-editor.tsx`:
  - Pide páginas de 30 (`PAGINA_INVENTARIO = 30`). Si la página llegó llena,
    muestra «Ver más» al final de la lista, que pide `offset` siguiente y
    agrega DEBAJO. Mientras carga: «Cargando…» y botón deshabilitado. Si
    falla: toast y se conserva lo que ya se veía.
  - Los resultados siguen atados al término que los produjo (el patrón
    `{ term, items }` actual); una búsqueda nueva reinicia la paginación.
  - Agregar un producto sigue vaciando el buscador como hoy.
- CSS: `.crm-cart-results` con `max-height: 320px; overflow-y: auto;
  overscroll-behavior: contain;` (la barra propia que pidió el operador).

Tests:
- `inventory-data.test.ts` (bloque «searchActiveProducts — buscador del
  cierre de venta»): el builder falso registra `.order(...)` y `.range(...)`;
  verificar `stock_quantity` desc nullsFirst false → `name` → `id`,
  `is_active` en `true`, y `range(0, 29)` por defecto / `range(30, 59)` con
  `offset = 30`. Los tests existentes que esperaban `.limit(8)` se ajustan.
- `close-sale-modal.test.tsx`:
  1. El mock de `searchActiveProducts` se llama con `(…, término, 30, 0)`.
  2. Con 30 resultados aparece «Ver más»; pulsarlo llama con offset 30 y los
     nuevos quedan debajo de los primeros.
  3. Con menos de 30 no aparece «Ver más».
- Lo de la barra NO se prueba en jsdom (no calcula layout): se verifica en el
  navegador (ver Verificación).

### Tarea 5. «Productos a Facturar»

- `<Label>¿Qué lleva el cliente?</Label>` → «Productos a Facturar», un poco
  más grande que las demás etiquetas del modal y en negrita (clase nueva, p.
  ej. `.crm-sale-items-title { font-size: 15px; font-weight: 600; }`; ajustar
  al tamaño real de los `Label` vecinos para que se note la diferencia sin
  gritar).
- Se elimina el `<p className="lm-hint">Es el mismo carrito del panel del
  chat…</p>`.
- No cambia nada más del modal (ni «Cotizado por Seba en este chat», ni el
  texto de carrito vacío del modal).
- Actualizar el comentario de cabecera del componente si nombra el título
  viejo.

Tests (`close-sale-modal.test.tsx`):
1. Se ve «Productos a Facturar».
2. No se ve «Es el mismo carrito del panel del chat».
3. Todo test existente que busque «¿Qué lleva el cliente?» se ajusta.

## Verificación final (orquestador)

```bash
rtk npx vitest run src/components/context-panel src/lib/inventory-data.test.ts
rtk npm run test
rtk npx tsc --noEmit
rtk npm run lint
```

Si un archivo falla en la suite y pasa aislado, es contención (ver
CLAUDE.md), no regresión.

Verificación visual (obligatoria: jsdom no calcula layout), con el dev
server o el build y la base local:
- Panel derecho: fila «Sin cédula» en un contacto sin venta; cerrar una venta
  con cédula y ver que la fila cambia sola a `V-…`.
- «Inventario» arranca cerrado, abre con foco en el buscador, recuerda el
  estado al recargar, sin el texto de ayuda.
- Carrito vacío sin el botón de Seba y con el texto nuevo.
- Modal: buscar «amortiguador» → los que tienen stock arriba, lista con barra
  propia (~320 px), «Ver más» si hay más de 30; título «Productos a
  Facturar» más grande y sin el párrafo.
- Revisar también a 390 px de ancho que nada desborde.

## Cierre

- `docs/GLOSARIO.md`: actualizar las líneas de `context-panel.tsx`,
  `inventory-lookup.tsx`, `conversation-cart-block.tsx`,
  `sale-items-editor.tsx` e `inventory-data.ts`.
- Un solo commit, sin `[migración]` (no hay migración), mensaje narrativo con
  `git commit -F <archivo>`, por ejemplo:

  > El panel del chat muestra la cédula siempre, el inventario se pliega y el
  > cierre de venta ofrece primero lo que hay

  terminando con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No hacer push** sin pedírselo al operador (push a `main` despliega). Al
  no haber migración, puede ir directo a `main` cuando el operador lo diga.
