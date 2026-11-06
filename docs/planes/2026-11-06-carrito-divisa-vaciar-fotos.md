# Plan: carritos en divisa, vaciar el carrito del chat y fotos desde el chat (6/11/2026)

Metodología liminalwork (contexto → plan → implementación con subagentes y reportes). Son
cuatro pedidos del cliente, todos de UI y lógica pura. **No hay migración ni variable de
entorno nueva.** Tests en verde antes de entregar. Plan aprobado por el operador el 6/11/2026
(D1-D3 abajo); P1-P4 van con su valor por defecto.

Referencias de línea medidas el 6/11/2026 sobre `main` = producción = `65fef07` («El glosario,
CLAUDE.md y el reporte para el VPS cuentan el 16 % sobre todo precio de producto»). Ese commit
está desplegado desde las 18:41 UTC del 6/11. La base tiene 108 migraciones, igual al árbol.

---

## 0. Qué pidió el cliente (textual) y qué decidió el operador

El operador lo pasó así:

> Agregar:
> - Botón de borrar carrito en general.
> - Botón para cambiar al carrito completo a precio de divisa.
> - Antes estaba en la opción de modificar la imagen desde el sidebar, agrégalo nuevamente.
>
> Bug: al agregar al carrito en el sidebar se pierde la opción de ver el precio de divisas.

Mensajes del cliente:

- Captura del carrito del chat («Lo que lleva el cliente»): *«Al agregar al carrito aquí, no me
  sale el precio divisa, puedes agregarlo para que se vea igualmente arriba en cada producto y
  el total? Porque los clientes después que se les arma todo van y preguntan por divisa.»*
- Captura del carrito de `/inventario` («Carrito de cotización»): *«Puede ser un botón que al
  darle cambie los precios y refleje la divisa.»*

Decisiones del operador (6/11/2026), ya tomadas, no las reabras:

- **D1, divisa:** el mismo interruptor **«BCV | Divisa»** en los **dos** carritos (chat e
  Inventario). En «Divisa», cada renglón y el total pasan a precio divisa, y Copiar / Al chat
  mandan el texto en divisa. La tarjeta del chat NO suma una línea fija de divisa.
- **D2, fotos desde el chat:** un botón **«Fotos»** en cada resultado del buscador de
  inventario del chat. Abre la **misma ficha** de `/inventario` (`ProductoFicha`), con Subir,
  Reemplazar, Eliminar y Marcar principal, y el resultado se refresca.
- **D3, permisos:** solo **admin y supervisor**, como hoy en `/inventario`. La RLS no cambia:
  `product_photos_insert/update/delete_supervisor` y `product_photos_storage_insert` exigen
  `is_supervisor_or_admin()`. Asesores y caja no ven el botón.
- **«Borrar carrito en general»** va en el carrito del **chat**: el de `/inventario` ya tiene
  «Vaciar» (`carrito-panel.tsx:497`).

## 1. Diagnóstico (leído en `65fef07`)

### 1.1 El carrito del chat no muestra la divisa en ningún lado

- El buscador del chat sí la muestra: `inventory-lookup.tsx:662-672` pinta la línea gris
  «Divisa $X» (`precioDivisaDisplay`).
- Al agregar, el renglón pasa a `CartLines` (`cart-lines.tsx:138`). Ahí solo hay $ BCV c/u
  (`:223`), subtotal $ y Bs. (`:236`). El pie de `ConversationCartBlock` (`:211-217`) muestra el
  total en $ y Bs. Nadie lee `product.precioDivisaUsd`.
- El carrito de `/inventario` tampoco: `Renglon` (`carrito-panel.tsx:162`) pinta
  «c/u Bs. · $» y los totales (`:420-431`) son «Total en bolívares» y «Total en dólares».
- `types.ts:1138-1146` documenta la divisa como «solo informativo: no entra al carrito,
  presupuestos, factura ni a Seba». **Eso sigue valiendo para lo que se cobra y se guarda** (ver
  §2). Lo que cambia es que ahora el carrito la puede **mostrar y copiar**. Actualizá ese
  comentario.

Ejemplo real de las capturas, con la tasa del 6/11 (896,1225) y el 16 % ya en producción:

| Repuesto | `products.price` | Bs. con 16 % | $ BCV | `precio_divisa_usd` | Divisa con 16 % |
|---|---|---|---|---|---|
| 3025-02 BOMBA FRENO DELANTERA HORSE/SBR | 4.266,90 | 4.949,60 | 5,60 | 3,88 | 4,60 |
| HX179 VISERA UNIVERSAL MOTO BEISITE | 28.448,20 | 33.000,11 | 36,90 | 25,86 | 30,00 |

El carrito de la captura (2 bombas + 1 visera) da **$48,10 en BCV y $39,20 en divisa**. La
divisa ya llega recargada desde `mapProduct` (`usdConRecargo`, `inventory-data.ts:115`): **no
vuelvas a aplicar el 16 %**.

### 1.2 El carrito del chat no se puede vaciar

`CartActions` (`use-cart-actions.ts:26`) solo tiene `remove` por renglón. No hay mutación para
vaciar. La única que borra por conversación vive dentro de `closeSaleWithContactInfo`
(`mutations.ts:736-745`, `.delete().eq("conversation_id", conversationId)`). La RLS permite el
borrado: `conversation_cart_items_delete` es `is_agent()`.

### 1.3 Fotos: nunca hubo edición en el chat

En la historia de `main`, el buscador del chat solo tuvo «Enviar foto» (`c16b560`, plan
`docs/planes/2026-10-30-fotos-de-repuestos.md`, D1 y D3). La gestión vive solo en
`ProductoFicha` (`producto-ficha.tsx:82`), que monta `inventario-view.tsx:443` con
`puedeEditarFotos = role ∈ {supervisor, admin}` (`:167`). Funciona en producción: hay 36 fotos
cargadas entre el 5/11 16:23 y el 6/11 19:00 UTC. El pedido es llevar esa ficha al chat (D2).

## 2. Diseño decidido

### 2.1 Qué es «precio divisa» de un renglón

- **Promoción:** `product.precioDivisaUsd` si es finito y > 0. Si no, `null` («Sin precio
  divisa»), el mismo criterio que `precioDivisaDisplay` (`inventory.ts:153`).
- **Estándar:** divisa + `product.shippingFeeUsd`, con `round2`. Es `null` si falta cualquiera de
  los dos. La tarifa MRW no lleva recargo ni pasa por la tasa (ver `recargo-precio.ts`).
  *(P1, valor por defecto: el envío se cobra igual en divisa.)*
- Subtotal = unitario × cantidad, con `round2`. En divisa **no hay bolívares**: `unitPriceBs` y
  `subtotalBs` son `null`.
- **No hay total parcial.** Si algún renglón no tiene divisa, el total en divisa NO se muestra
  como número: se muestra la píldora «Falta divisa (N)», con el mismo criterio que «Faltan
  pesos (N)» (`aviso-peso.tsx`). Copiar y Al chat quedan deshabilitados con su motivo. El
  asesor le dicta este número al cliente, y un total al que le falta un renglón es un precio
  falso.
- El aviso «cotizado $X · hoy $Y» (`quoteComparisonLabel`) es de BCV: en divisa no se muestra.

### 2.2 Qué cambia el interruptor y qué NO

| | En «Divisa» |
|---|---|
| Precio c/u, subtotal y total en pantalla | Pasan a divisa, sin Bs. |
| Texto de Copiar / Al chat | Precios en divisa. El total dice «Total en divisa: $X». No sale la línea «Total en bolívares» ni el plan Cashea. |
| Peso total | Igual |
| Promoción / Estándar por renglón (chat) y «Cobrar precio estándar» (Inventario) | Siguen funcionando: el estándar en divisa es divisa + tarifa |
| Cashea (Inventario) | Se calcula sobre el $ BCV. En divisa, el interruptor de Cashea queda deshabilitado con la nota «Cashea se calcula con el precio BCV», y `CasheaResumen` no se pinta. *(P2)* |
| Guardar presupuesto | **No cambia**: guarda como hoy (`renglonesParaGuardar` sobre las líneas BCV) |
| Facturar / Enviar a SAINT | No cambia: SAINT pone su propio precio |
| Cerrar venta (`close-sale-modal`) | No cambia: cobra BCV (D6) |

- **Estado no persistido.** El interruptor arranca en «BCV» cada vez:
  - **Chat:** `useState` en `ConversationCartBlock`. Vuelve a «BCV» al cambiar `conversationId`,
    con el patrón «ajustar el estado cuando cambia un prop» durante el render, como en
    `producto-ficha.tsx:115-119` (no con un efecto).
  - **Inventario:** `useState` en `CarritoPanel`. Dura mientras la página esté montada.

  Motivo: nadie deja la divisa puesta sin darse cuenta y le copia al siguiente cliente un precio
  que no era. *(P3)*
- **Ubicación, siempre visible, nunca dentro de un desplegable** (el cliente pidió «un botón»):
  - **Chat:** primera fila del pie pegado `crm-pcart-foot` (`conversation-cart-block.tsx:211`),
    antes de «Total».
  - **Inventario:** primera fila de `inv-carrito-pie-ajustes`, antes del desplegable «Opciones de
    cotización» (`carrito-panel.tsx:329`).
- **La caja** ve el interruptor en `/inventario`: ya ve la columna Divisa (`producto-fila.tsx:349`,
  decisión del operador del 30/10). Como no tiene Copiar, solo le cambia la pantalla.

### 2.3 Vaciar el carrito del chat

- Botón «Vaciar» con ícono `Trash2`, en la fila del eyebrow «Lo que lleva el cliente»
  (`conversation-cart-block.tsx:183`), alineado a la derecha. Solo aparece con renglones. No va en
  la fila de atajos: Copiar / Al chat / Guardar ya llenan los 268 px.
- Confirmación con `ConfirmDialog` (`components/confirm-dialog.tsx`), con `peligro`:
  - título «¿Vaciar el carrito?»;
  - descripción «Se quitan los N productos de esta conversación, también para los demás
    asesores. Los presupuestos guardados no se tocan.»;
  - botón «Sí, vaciar».

  Usa un diálogo y no la confirmación en línea de `/inventario` porque el carrito del chat es
  compartido en vivo.
- Si la conversación tuvo un envío a SAINT, su estado sigue visible con el carrito vacío. Eso ya
  existe: `cart.length === 0 && ultimoEnvio` → `soloEstado`, `conversation-cart-block.tsx:342`.

### 2.4 Fotos desde el chat

- `InventoryLookup` recibe la prop nueva `puedeEditarFotos?: boolean` (default `false`).
  `ContextPanel` le pasa `currentAgent.role === "supervisor" || currentAgent.role === "admin"`.
- Con la prop encendida y `onEnviarFoto` presente, la fila `crm-lookup-photo-row`
  (`inventory-lookup.tsx:675`) suma, a la derecha de «Enviar foto», el botón «Fotos» (ícono
  `Images`, `aria-label` «Gestionar fotos de <nombre>»). Con la prop apagada, la fila queda
  exactamente igual que hoy.
- El buscador guarda `fichaProductId: string | null` y monta **una sola** `ProductoFicha` para
  toda la lista. El `product` sale de `state.products` por id, no de una copia: así, al
  refrescar, la galería pinta la foto nueva. Props de la ficha:
  - `bcvRate={rate}`;
  - `soloLectura={false}`;
  - `puedeEditarFotos`;
  - `mostrarAcciones={false}`;
  - `onCambio`: `fetchProduct(createClient(), id)` (`inventory-data.ts:242`) y, si no es `null`,
    `reemplazarProducto(fresco)` (`:450`). Con eso se actualizan la miniatura y el estado de
    «Enviar foto».
- `ProductoFicha` gana `mostrarAcciones?: boolean` (default `true`). Con `false` no pinta
  `Drawer.Footer` (`producto-ficha.tsx:437`: «Agregar al carrito» y «Cashea»). En el chat se
  agrega con «+ Promoción/+ Estándar» del buscador; la calculadora Cashea no es parte del
  pedido.
- No se agrega «Enviar foto al chat» a la ficha (sigue D3 del 30/10).

## 3. Especificación por tarea

### T1. Lógica pura de la divisa (Sonnet, Medio-Alto)

- **Crear** `src/lib/carrito-divisa.ts` y su `.test.ts`:
  ```ts
  export type MonedaCarrito = "bcv" | "divisa";
  /** Divisa por unidad de un renglón (§2.1). */
  export function precioDivisaRenglon(item: PriceableCartItem): number | null;
  /** Las mismas líneas repreciadas en divisa: Bs. en null, priceChange en null,
      quotedPriceUsd intacto. No muta la entrada. */
  export function lineasEnDivisa<T extends PriceableCartItem>(lines: PricedCartLine<T>[]): PricedCartLine<T>[];
  ```
  Sobre esas líneas, `cartTotals` da `usd` (solo de las que tienen precio), `bs: null`,
  `unpricedCount` = renglones sin divisa, y el peso igual que en BCV. No se escribe otro sumador.
- **Modificar** `src/lib/conversation-cart.ts`: `cartSummaryText(lines, totals, opciones,
  moneda: MonedaCarrito = "bcv")`. En `"divisa"`, la línea del total dice `Total en divisa: $X`
  en vez de `Total: $X`. El resto del texto no cambia. Con `"bcv"`, la salida es **idéntica
  byte a byte** a la de hoy.
- **Modificar** `src/lib/inventario-carrito.ts`:
  - `totalesCarrito(lineas, bcvRate, cashea, moneda = "bcv")`. En `"divisa"`: `lineas` =
    `lineasEnDivisa(priced)`, totales sobre ellas, y `cashea`, `inicialBs` y `cuotaBs` en `null`.
  - `textoCarritoParaCliente(totales, opciones, moneda = "bcv")` le pasa la moneda a
    `cartSummaryText`.
  - `avisosRenglon(linea, moneda = "bcv")`. En divisa, un renglón sin precio dice
    «Sin precio divisa en SAINT», o «Sin precio estándar: <motivo>» si lo que falta es la
    tarifa.
- **Fuera de alcance:** `priceCartLines`, `cartToSaleLines`, `renglonesParaGuardar`,
  `usd-price.ts`, `recargo-precio.ts`.

### T2. Vaciar el carrito: mutación y acción (Sonnet, Medio)

- **Modificar** `src/lib/mutations.ts`: `export async function clearCart(supabase, conversationId:
  string): Promise<number>`. Hace `.delete().eq("conversation_id", conversationId).select("id")`,
  lanza el error de PostgREST si lo hay y devuelve cuántas filas borró. Un carrito que ya estaba
  vacío (0 filas) **no** es error: otro asesor pudo vaciarlo antes. `closeSaleWithContactInfo`
  no se toca.
- **Modificar** `use-cart-actions.ts`: `CartActions.clear: () => Promise<void>`, con
  `run("No se pudo vaciar el carrito.", () => clearCart(createClient(), conversationId).then(() =>
  undefined))`. Se agrega al `return` (`:160`).
- Tests en `use-cart-actions.test.tsx` y en `src/lib/mutations-cart.test.ts` (donde ya se prueban
  `removeFromCart` y `setCartQuantity`).

### T3. Carrito del chat: interruptor y Vaciar (Sonnet, Medio-Alto; después de T1 y T2)

- **Crear** `src/components/presupuestos/moneda-toggle.tsx`, que comparten los dos carritos:
  ```ts
  export function MonedaToggle(props: { value: MonedaCarrito; onChange: (m: MonedaCarrito) => void;
    disabled?: boolean; className?: string }): JSX.Element;
  ```
  Es un `radiogroup` con `aria-label="Moneda del carrito"` y dos `role="radio"`, «BCV» y
  «Divisa», con el mismo patrón que `PriceKindToggle` (`cart-lines.tsx:101-136`). Elegir la
  opción ya marcada no llama a `onChange`.
- **Modificar** `cart-lines.tsx`: prop `moneda?: MonedaCarrito` (default `"bcv"`). En
  `"divisa"`:
  - las líneas salen de `lineasEnDivisa(priceCartLines(...))`;
  - c/u y subtotal en divisa, sin la línea Bs.;
  - un renglón sin precio dice «Sin divisa»;
  - `comparison` no se pinta;
  - el aviso de tasa (`:251`) no aplica;
  - si `mostrarTotal`, se pinta el total en divisa o «Falta divisa (N)».

  El modal «Cerrar venta» no pasa la prop y queda igual.
- **Modificar** `conversation-cart-block.tsx`:
  - estado `moneda` (§2.2, con reinicio por `conversationId`);
  - `MonedaToggle` al inicio de `crm-pcart-foot`;
  - `<CartLines moneda={moneda} …>`;
  - total del pie: en BCV como hoy; en divisa, `$X` con la leyenda «Divisa» en el lugar de la
    línea Bs., o «Falta divisa (N)»;
  - `summary = cartSummaryText(lineasMostradas, totalesMostrados, opcionesCopia, moneda)`;
  - motivos de Copiar/Al chat y de la vista previa: en divisa, «Hay productos sin precio
    divisa en SAINT» (o el de la tarifa, si es un estándar sin tarifa);
  - `handleGuardarPresupuesto` sigue usando las líneas BCV;
  - el botón «Vaciar» con su `ConfirmDialog` (§2.3) llama a `actions.clear()`.
- **CSS:** `crm.css` (o el `.css` del bloque), con test de CSS como los vecinos
  (`carrito-pie-css.test.ts`).

### T4. Carrito de `/inventario`: interruptor (Sonnet, Medio-Alto; después de T3)

- **Modificar** `carrito-panel.tsx`:
  - estado `moneda`;
  - `MonedaToggle` (§2.2);
  - `totalesCarrito(..., moneda)` y `textoCarritoParaCliente(totales, opcionesCopia, moneda)`;
  - `Renglon` recibe `moneda`. En divisa pinta «c/u $X» y el subtotal en $, sin Bs., con
    `avisosRenglon(linea, moneda)`;
  - totales en divisa: una sola fila «Total en divisa» (con `formatUsd(toCents())`, igual que
    hoy) o «Falta divisa (N)», en lugar de «Total en bolívares» y «Total en dólares»;
  - peso igual;
  - Cashea según P2;
  - Guardar presupuesto y Enviar a SAINT siguen usando las líneas BCV. `guardarCarrito` usa
    `renglonesParaGuardar` y necesita las líneas BCV aunque la pantalla muestre divisa:
    calculá las dos con `totalesCarrito(..., "bcv")` para guardar.

### T5. Fotos desde el buscador del chat (Sonnet, Medio-Alto; en paralelo con T1-T4)

- **Modificar** `inventory-lookup.tsx` (§2.4), `context-panel.tsx` (`:279`, la prop) y
  `producto-ficha.tsx` (la prop `mostrarAcciones`). No toca ningún archivo de T1-T4.
- **Fuera de alcance:** la RLS, `product-photo-mutations.ts`, `inventario-view.tsx` y la forma
  en que `/inventario` abre la ficha.

### T6. Documentación (Haiku, Bajo; al final)

- `docs/GLOSARIO.md`: las líneas de `carrito-divisa.ts`, `moneda-toggle.tsx`, `cart-lines`,
  `conversation-cart-block`, `carrito-panel`, `inventory-lookup`, `producto-ficha`,
  `use-cart-actions` y `mutations` (`clearCart`).
- El comentario de `types.ts:1138` (§1.1).
- Reporte de entrega `docs/entregas/2026-11-0X-carrito-divisa-vaciar-fotos.md`, con el formato
  de `2026-11-06-hotfix-recargo-16.md`.

## 4. Tests (terminado = suite, tipos, lint y build en verde)

Los tests existentes de `conversation-cart.test.ts`, `inventario-carrito.test.ts`,
`cart-lines.test.tsx`, `close-sale-modal.test.tsx` y `carrito-panel.test.tsx` **no se editan**.
Que pasen sin tocarlos demuestra que con `"bcv"` todo sigue igual. Lo nuevo va en `describe`
nuevos.

1. `carrito-divisa.test.ts`:
   - promoción con divisa;
   - divisa `null`, `0`, negativa y `NaN` → `null`;
   - estándar = divisa + tarifa, con `round2` (4,60 + 1,40 = 6,00; 0,1 + 0,2 sin cola de coma
     flotante);
   - estándar sin tarifa → `null`;
   - estándar sin divisa → `null`;
   - `lineasEnDivisa`: Bs. en `null`, `priceChange` en `null`, cantidad 3, sin mutar la entrada;
   - `cartTotals` sobre esas líneas: el caso de las capturas da **39,20** con `bs: null`; un
     renglón sin divisa da `unpricedCount: 1`.
2. `conversation-cart.test.ts` (describe nuevo): divisa → «Total en divisa: $39.20», sin
   «Total en bolívares»; con un renglón sin divisa y casillas de precio → `null`.
3. `inventario-carrito.test.ts` (describe nuevo):
   - en divisa, Cashea activo → `cashea`, `inicialBs` y `cuotaBs` en `null`;
   - el texto sin bloque Cashea;
   - `avisosRenglon` en divisa.
4. Mutaciones y `use-cart-actions.test.tsx`:
   - `clearCart` filtra por `conversation_id` y devuelve el conteo;
   - 0 filas no lanza;
   - con error de PostgREST, `clear` muestra el toast «No se pudo vaciar el carrito.» y
     siempre llama a `onCartChanged`.
5. `cart-lines.test.tsx` y `conversation-cart-block.test.tsx`:
   - el interruptor arranca en BCV;
   - «Divisa» cambia c/u, subtotal y total, y desaparece «Bs.»;
   - con un renglón sin divisa → «Falta divisa (1)» y Copiar deshabilitado con su motivo;
   - Copiar en divisa escribe en el portapapeles el texto con «Total en divisa»;
   - Guardar en divisa llama a `guardarPresupuesto` con las referencias BCV;
   - al cambiar `conversationId`, vuelve a BCV;
   - «Vaciar»: abre el diálogo, «Sí, vaciar» llama a `actions.clear` una vez y «Cancelar» no lo
     llama;
   - con el carrito vacío no hay botón.
6. `carrito-panel.test.tsx`:
   - el interruptor está visible con «Opciones de cotización» cerrado;
   - en divisa: renglón y «Total en divisa», sin «Total en bolívares» ni «Total en dólares»;
   - el interruptor de Cashea queda deshabilitado con su nota;
   - con rol caja, el interruptor está y Copiar no;
   - Guardar presupuesto en divisa guarda las líneas BCV.
7. `inventory-lookup.test.tsx`, `context-panel.test.tsx` y el test de la ficha:
   - con `puedeEditarFotos` está «Fotos» y abre el diálogo «Ficha de <nombre>»;
   - sin la prop no hay botón;
   - `onCambio` llama a `fetchProduct` y la miniatura cambia a la URL nueva;
   - admin y supervisor → `true`; agent → `false`;
   - `mostrarAcciones={false}` → no hay «Agregar al carrito» ni «Cashea».
8. **Mutaciones de verificación:** cada una tiene que poner al menos un test en rojo.
   - Que `lineasEnDivisa` devuelva el precio BCV.
   - Que `clear` no haga nada.
   - Que `MonedaToggle` no llame a `onChange`.
   - Respaldá con `cp` antes de mutar (trampa del 7/9 en CLAUDE.md).

## 5. Pendientes del operador (el plan arranca con estos valores por defecto)

- **P1:** el estándar en divisa es divisa + tarifa MRW.
- **P2:** en divisa no se financia con Cashea, porque Cashea es sobre $ BCV.
- **P3:** el interruptor no se recuerda: arranca en BCV cada vez y en cada conversación.
- **P4:** la etiqueta del texto copiado es «Total en divisa: $X». Si el cliente prefiere otra
  palabra («Total en efectivo», «Total en dólares efectivo»), es un solo string en
  `cartSummaryText`.

## 6. Entrega

- **Cambio del 6/11/2026 (pedido del operador):** se implementa en el VPS con subagentes, en
  un clon aparte (`/root/sbk-entrega-divisa`; el checkout de Dokploy no se toca), con la suite
  corriendo en un contenedor `node:22` limitado a 3 CPU. La entrega es un push directo a `main`
  desde `65fef07`, que despliega solo. Es posible porque no hay migración: el código nuevo no
  depende de nada de la base que no exista hoy.
- Sin migración, sin variable de entorno. El costo es un rebuild de UI (~5 min).
- El reporte por commit queda en `docs/entregas/`. Verificación posterior al deploy:
  1. El carrito del chat con 3025-02 ×2 y HX179 ×1 da $48,10 en BCV y $39,20 en divisa, si la
     tasa y los precios de Saint no cambiaron. El reporte debe decir que se recalcula con los
     valores del día.
  2. Copiar en divisa: el texto pegado.
  3. Vaciar, visto desde un segundo navegador con la misma conversación (Realtime).
  4. Como admin, «Fotos» desde el chat: subir una foto a un repuesto sin foto, ver la miniatura
     nueva sin recargar y «Enviar foto» habilitado.
  5. Como asesor, «Fotos» no aparece.
  6. Consola y logs del contenedor limpios.
