# Entrega "Precio estándar en el buzón y el carrito elige qué precio cobrar" (14/10/2026)

Rama `entrega/precio-estandar-buzon`, partida de `main` = `8989a71`. **UNA migración: `20261014010000_carrito_precio_elegido`** (requiere `20261012010000_precio_estandar_mrw` ya aplicada). Sin variables de entorno nuevas.

## Commits
1. `6a617f7` — La búsqueda de inventario del buzón muestra también el precio estándar. Solo interfaz.
2. `[migración]` — `conversation_cart_items.price_kind text not null default 'promocion'` con `check in ('promocion','estandar')`. Lleva `lock_timeout` con su guarda, autoverificación (columna, check y tabla en `supabase_realtime`) y `notify pgrst`. Los renglones que ya existen quedan en promoción.
3. Código: el asesor elige promoción o estándar. **Lee `price_kind`: sin la migración, el carrito del chat da 400 (patrón C2).**

## Qué cambia
- **Búsqueda del buzón:** cada resultado muestra «Promoción» y «Estándar» (promoción + envío MRW) y tiene dos botones, «+ Promoción» y «+ Estándar». Este último queda deshabilitado, con el motivo, cuando no hay tarifa MRW.
- **«Lo que lleva el cliente» y el editor de «Cerrar venta»:** cada renglón tiene un selector Promoción / Estándar. Si se agrega un repuesto que ya está con el otro precio, se suma 1 y el renglón pasa al precio recién elegido, con un aviso.
- **Renglón estándar sin tarifa** (por ejemplo, le borraron el peso): queda «Sin precio», con el aviso «cámbialo a promoción», y no deja cerrar la venta. Nunca se cobra un número incompleto.
- **Al cerrar la venta:** `order_items.unit_price` lleva el precio elegido y la descripción dice «(precio estándar, incluye envío MRW)». El resumen para el cliente dice «Precio (incluye envío)».
- **Cotizaciones de Seba:** entran en promoción. El aviso «cotizado vs hoy» solo compara en promoción.
- **El carrito de la página Inventario no cambia** (decisión del operador).

## Pasos en el VPS
1. Aplicar la migración ANTES del código: `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261014010000_carrito_precio_elegido.sql`. Debe imprimir `NOTICE: 20261014010000: autoverificación de price_kind correcta.`
2. Comprobar: `select price_kind, count(*) from conversation_cart_items group by 1;` → todos en `promocion`.
3. Fast-forward de `main` a `entrega/precio-estandar-buzon` (despliega Dokploy).

## Verificación tras el deploy
En `/inbox`, abrir un chat y buscar un repuesto con peso: se ven los dos precios y los dos botones. Pulsar «+ Estándar»: el renglón entra marcado Estándar, con el subtotal promoción + envío. Cambiarlo a Promoción con el selector baja el precio. Un repuesto sin peso tiene «+ Estándar» deshabilitado.

## Verificado en local
- Suite completa: 5014 en verde. `tsc` sin errores y lint con 0 errores.
- Test SQL `supabase/tests/carrito_precio_elegido.sql` verde y `carrito_por_conversacion.sql` sigue verde. Mutación sin el check → rojo.
- Mutaciones de código en rojo: ignorar `priceKind` en `priceCartLines`, no mandar `price_kind` en el update, y que el botón Estándar mande promoción.
- Maquetado del lookup y del carrito medido con el CSS real a 300 y 268 px, sin desborde.
