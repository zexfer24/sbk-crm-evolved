# Entrega "El precio estándar también se ve en la búsqueda del buzón" (14/10/2026)

Rama `entrega/precio-estandar-buzon`, partida de `main` = `8989a71`. **Sin migraciones, sin variables de entorno nuevas.**

## Qué cambia
La búsqueda de inventario del panel derecho del chat (`InventoryLookup`) pinta en cada resultado dos líneas etiquetadas:
- **Promoción**: el precio de siempre (Bs. y $).
- **Estándar**: promoción + envío MRW por peso (Bs. y $) y la línea «incluye envío MRW $ X». Sin tarifa dice el motivo («Sin peso cargado», «Más de 80 kg: fuera de la tabla MRW», «Sin tarifa MRW para este peso»).

Usa el mismo cálculo que la fila de Inventario (`standardPriceDisplay`) y el dato `tarifa_envio_usd` que la consulta ya traía desde `20261012010000`. El botón «Agregar» queda siempre abajo a la derecha. **El carrito no cambia: sigue facturando el precio de promoción.**

## Pasos en el VPS
1. Ninguna migración que aplicar (requiere que `20261012010000_precio_estandar_mrw` ya esté aplicada; lo está desde la entrega MRW).
2. Fast-forward de `main` a `entrega/precio-estandar-buzon` (despliega Dokploy).

## Verificación tras el deploy
En `/inbox`, abrir un chat, buscar un repuesto con peso cargado: se ven «Promoción» y «Estándar» con «incluye envío MRW». Buscar uno sin peso: «Estándar — Sin peso cargado».

## Verificado en local
Suite completa 4961 en verde, `tsc` y lint sin errores, mutación (tarifa forzada a null) pone rojo el test con tarifa, maquetado medido con el CSS real a 300 y 268 px sin desborde.
