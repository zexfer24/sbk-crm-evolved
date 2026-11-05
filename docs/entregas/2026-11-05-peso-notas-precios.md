# Entrega «Peso total, precios en tarjetas y notas verdes» (5/11/2026)

Rama `entrega/peso-notas-precios`, partida de `main` = `d426fa6`. **No lleva migración** ni variable de entorno nueva. Toca solo la UI del cliente (React y CSS).

## Antes de desplegar: confirmar el commit de producción

Esta entrega no trae migración, pero sale de `d426fa6`. Preguntar al operador en qué commit está producción (`<produccion>`). La última referencia conocida es `a1db46c`. Si producción está detrás de `d426fa6`, el deploy arrastra código que depende de tres migraciones que deben estar aplicadas **antes** y **en este orden**:

```bash
git diff --name-only <produccion>..entrega/peso-notas-precios -- supabase/migrations
```

1. `20261030010000_precio_divisa_saint.sql` (precio divisa). Pasos en `docs/entregas/2026-10-30-precio-divisa.md`.
2. `20261031010000_fotos_de_productos.sql` (fotos de repuestos). Pasos en `docs/entregas/2026-10-31-fotos-de-repuestos.md`.
3. `20261031020000_precio_divisa_precioi3.sql` (hotfix PrecioI3, con su **paso 0** de solo lectura). Pasos en `docs/entregas/2026-10-31-precio-divisa-precioi3.md`.

No se repiten aquí. `20261028010000` («Facturar en SAINT») sigue fuera: espera a LiminalReplicant. Si producción ya está en `d426fa6` o posterior, no hay nada que aplicar.

## Commits


| # | Hash y título | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | `a160a4a` El carrito suma el peso para el envío, los precios del chat van en tarjetas y las notas se ven en verde (peso total, tarjetas de precio y notas verdes en un solo commit) | No | No | Solo UI |
| 2 | el commit que trae este reporte: Documentación de la entrega (GLOSARIO, CLAUDE.md, este reporte) | No | No | Nada en ejecución |

Costo de despliegue: **rebuild completo (~5 min)**, porque toca UI. El corte de servicio de ~22 s al recrear el contenedor es el de siempre.

## Qué cambia

1. **Peso total del carrito** (el cliente lo usa para calcular envíos).
   - `cartTotals` (`conversation-cart.ts`) y `totalesCarrito` (`inventario-carrito.ts`) devuelven `pesoKg` y `sinPesoCount`. La suma va en gramos enteros. `pesoKg` es `null` si a CUALQUIER renglón le falta peso.
   - `formatPesoKg` (`inventory.ts`) reemplaza a la privada `pesoLegible` de `inventory-lookup.tsx`.
   - Carrito del chat: el pie dice «Peso total 12,5 kg» o la píldora «Faltan pesos (N)», sin ningún número parcial. Cada renglón sin peso muestra «Sin peso» (prop `mostrarSinPeso` de `cart-lines.tsx`; el modal «Cerrar venta» no la enciende).
   - /inventario: fila «Peso total» en `carrito-panel.tsx`.
   - Copia al cliente: la casilla nueva «Peso total» nace **apagada**. Encendida y con el peso completo, `cartSummaryText` agrega «Peso total: X kg» tras los totales y antes de Cashea. Con el peso incompleto omite la línea, así que al cliente nunca le llega «faltan pesos»; el asesor ve un aviso bajo la vista previa (`presupuestos/aviso-peso.tsx`).
2. **Precios del resultado de inventario en el panel del chat** (variante «A2 · Tarjetitas»). Promoción y Estándar van en dos tarjetas lado a lado, cada una con su botón «+ Promoción» / «+ Estándar». La Divisa va debajo, en gris. «Enviar foto» queda en su propia fila. Orden: Promoción, Estándar, Divisa (antes Divisa iba en el medio). Estándar sin precio: tarjeta vacía y botón deshabilitado.
3. **Notas internas del panel del chat en verde.** La ficha del cliente (`.cli-note`) no cambia.

## Verificación hecha

- Suite completa: 6020 tests en verde. Build con `rtk proxy npm run build`: OK.
- 10 mutaciones de verificación, todas en rojo.
- Playwright en tema claro y oscuro, con el panel a 268 y 300 px.
- **Límite conocido:** a menos de 1080 px el panel del chat no se muestra (regla previa a esta entrega). Las tarjetas y las notas verdes no se pueden ver en una ventana angosta.
- No se verificó en producción: lo de abajo queda para después del deploy.

## Verificación posterior al deploy

1. **Peso total, pesos completos.** En un chat, agregar al carrito dos productos con peso cargado. El pie dice «Peso total X kg» (coma decimal) y la suma coincide con la de los pesos de la ficha. En /inventario, el carrito muestra la misma fila «Peso total».
2. **Peso total, pesos incompletos.** Agregar un producto sin peso («Sin peso» en el filtro de /inventario). El pie del chat dice «Faltan pesos (N)» **sin ningún número de kg**, y el renglón sin peso muestra «Sin peso». En /inventario, la fila muestra el aviso y no un total parcial.
3. **Casilla apagada.** En «Qué copiar» la casilla «Peso total» aparece desmarcada de fábrica. Copiar el resumen: no trae línea de peso. Encenderla con peso completo: trae «Peso total: X kg» después de los totales. Encenderla con peso incompleto: el texto no trae esa línea y el asesor ve el aviso bajo la vista previa.
4. **Tarjetas de precio.** En el buscador del chat, un resultado muestra Promoción y Estándar lado a lado con su botón al pie, la Divisa debajo en gris y «Enviar foto» en su fila. Un producto sin tarifa estándar muestra esa tarjeta vacía con el botón deshabilitado. Revisar tema claro y oscuro, con la ventana de 1080 px o más.
5. **Notas verdes.** Las notas internas del panel del chat tienen fondo verde tenue, borde izquierdo verde y el autor en verde oscuro. La ficha del cliente conserva su estilo anterior.
6. Consola del navegador sin errores nuevos.

## Reversa

No hay migración que revertir. Volver al commit anterior de producción y reconstruir.

## Pendientes y notas

- La casilla «Peso total» arranca apagada para todos los asesores; cada uno la enciende y su preferencia se guarda por asesor (como las demás casillas de la copia).
- Los pesos de `products.weight_kg` los cargan los asesores a mano; hasta que se completen, «Faltan pesos» será frecuente. Es el comportamiento pedido, no una falla.
