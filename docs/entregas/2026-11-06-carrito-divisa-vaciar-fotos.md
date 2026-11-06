# Carrito en divisa, Vaciar y fotos desde el chat (6/11/2026)

Entrega: **push directo a `main`** desde `65fef07`, sin rama `entrega/…`, por decisión del operador del 6/11/2026. `main` despliega solo al pushear. Plan: `docs/planes/2026-11-06-carrito-divisa-vaciar-fotos.md`.

## Antes de desplegar

- **Sin migración** ni variable de entorno nueva. No hay nada que aplicar en la base.
- Producción antes del push: `65fef07`. Base: 108 migraciones, igual al árbol. Ambas cosas medidas, no supuestas.
- Costo de despliegue: rebuild de UI (~5 min).

## Commits

| # | Hash y título | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | `fc56488` Los carritos del chat y de /inventario muestran el precio divisa con un interruptor y el del chat se vacía de un clic | No | No | UI |
| 2 | `8d4266d` El buscador del chat abre la ficha de fotos del repuesto para admin y supervisor | No | No | UI |
| 3 | este commit: El plan, el glosario, CLAUDE.md y el reporte cuentan la divisa en el carrito, Vaciar y las fotos desde el chat | No | No | Nada en ejecución |

## Qué cambia

1. **Moneda del carrito (`src/lib/carrito-divisa.ts`, nuevo, puro).** `precioDivisaRenglon` toma `precioDivisaUsd` tal cual, porque ya trae el 16 % de `mapProduct` y no se recarga otra vez. El estándar en divisa es divisa más tarifa MRW, y da `null` si falta alguna de las dos. `lineasEnDivisa` reprecia las mismas líneas, con Bs. y `priceChange` en `null`.
2. **Interruptor «BCV | Divisa» (`MonedaToggle`, `src/components/presupuestos/moneda-toggle.tsx`).** Aparece en los dos carritos: el del chat (en el pie, antes del Total) y el de `/inventario` (primer elemento del pie, siempre visible). Arranca en BCV y no se recuerda: en el chat vuelve a BCV al cambiar de conversación.
3. **Total en divisa.** Muestra `$X` con la leyenda «Divisa», o «Falta divisa (N)». Nunca muestra un total parcial. En `/inventario` el total es una sola fila «Total en divisa».
4. **Copiar y Al chat** (chat) copian el texto en divisa (`cartSummaryText(…, "divisa")` escribe «Total en divisa: $X»). Se deshabilitan si falta alguna divisa. `textoCarritoParaCliente` de `/inventario` tampoco trae el bloque Cashea en divisa.
5. **Cashea en divisa** queda deshabilitado en `/inventario`, con la nota «Cashea se calcula con el precio BCV.», y sin resumen.
6. **Lo que no cambia:** lo que se guarda o se manda sale siempre de las líneas BCV. Eso incluye «Guardar presupuesto», «Enviar a SAINT» (`totalesBcv`), «Enviar/Facturar en SAINT» y «Cerrar venta».
7. **Vaciar (chat).** Botón «Vaciar» en la cabecera «Lo que lleva el cliente», con confirmación (`ConfirmDialog`: «¿Vaciar el carrito?», «Sí, vaciar»). Llama a `actions.clear()` → `clearCart(supabase, conversationId)` en `lib/mutations.ts`, que borra por `conversation_id` y devuelve el conteo (0 no es error). `closeSaleWithContactInfo` mantiene su propio borrado. Estilos `.crm-pcart-cabecera` y `.crm-pcart-vaciar` en `crm.css`.
8. **Fotos desde el chat.** En el buscador del chat (`inventory-lookup.tsx`) aparece el botón «Fotos» junto a «Enviar foto», con `aria-label` «Gestionar fotos de X». Abre UNA `ProductoFicha` con `mostrarAcciones={false}` (sin el pie de «Agregar al carrito» / Cashea). Al cambiar algo, `onCambio` relee el producto con `fetchProduct` y lo reemplaza en la lista. `context-panel.tsx` pasa `puedeEditarFotos` solo a supervisor y admin. La RLS de `product_photos` ya lo exigía y no cambió.
9. **Decisiones del operador:** D1, el interruptor va en los dos carritos. D2, «Fotos» abre la ficha. D3, solo admin y supervisor.
10. **Valores por defecto usados:** P1, estándar en divisa = divisa + MRW. P2, sin Cashea en divisa. P3, el interruptor no se recuerda y arranca en BCV. P4, el rótulo es «Total en divisa».
11. **Texto del tipo.** `types.ts`: el comentario de `precioDivisaUsd` dice ahora que se MUESTRA y se COPIA, pero no se cobra ni se guarda.

## Verificación hecha

Corrida en un contenedor `node:22` del VPS, con 3 CPU.

- `next typegen` + `tsc --noEmit`: 0 errores.
- `npm run lint`: 0 errores y 7 warnings, los mismos que antes.
- Suite completa: 272 archivos pasan y 1 saltado; 6105 tests pasan. Base antes del cambio: 269 archivos pasan.
- `npm run build`: OK, y los textos nuevos están en los chunks del cliente.

**Mutaciones de verificación.** Cada una dejó tests en rojo:

- `lineasEnDivisa` devolviendo el precio BCV: 6 tests en rojo.
- `clear` sin llamar a `clearCart`: 2.
- `MonedaToggle` sin `onChange`: 5.
- El bloque del chat pasando siempre `"bcv"` a `CartLines`: 1. Se agregó un test para cubrirlo.
- «Sí, vaciar» sin `clear`: 1.
- `Renglon` del Inventario ignorando la moneda: 1.
- `guardarCarrito` con las líneas en divisa: 1.
- Permiso de fotos invertido: 3.

## Verificación posterior al deploy

1. El carrito del chat con 3025-02 ×2 y HX179 ×1 da $48,10 en BCV y $39,20 en divisa, si la tasa y los precios de Saint no cambiaron. El reporte debe decir que se recalcula con los valores del día.
2. Copiar en divisa: revisar el texto pegado.
3. Vaciar, visto desde un segundo navegador con la misma conversación (Realtime).
4. Como admin, «Fotos» desde el chat: subir una foto a un repuesto sin foto, ver la miniatura nueva sin recargar y «Enviar foto» habilitado.
5. Como asesor, «Fotos» no aparece.
6. Consola y logs del contenedor limpios.

## Reversa

No hay migración que revertir. Volver a `65fef07` y reconstruir.
