# Entrega: el carrito de cotización se ordena (28/10/2026)

Rama `entrega/carrito-opciones-cotizacion`, un commit sobre `a01e29d`.

## Qué cambia

- **Cuerpo del carrito del Inventario:** lleva solo los artículos, con barra de scroll visible. El último artículo siempre se alcanza.
- **Pie fijo,** en este orden:
  1. El desplegable «Opciones de cotización», cerrado por defecto. Adentro: precio estándar, Cashea y qué incluir al copiar.
  2. Los totales.
  3. Los botones Enviar a SAINT · Guardar presupuesto · Copiar · Vaciar.
- **Desplegable y totales comparten una zona que desplaza por dentro;** los botones no se mueven.
- **Rol caja:**
  - En el desplegable ve solo Cashea, para sacar cálculos.
  - No tiene Copiar.
  - Nunca ve el precio estándar (como desde el 14/10).
- **Siempre en promoción:** cada carrito arranca en promoción. La preferencia de estándar ya no se guarda en el navegador, y la clave vieja se borra al montar.
- **«Enviar a SAINT» desde el carrito:**
  - Guarda el carrito como presupuesto (actualiza el abierto si se puede editar; si no, crea uno nuevo) con el nombre y apellido del formulario de SAINT.
  - Después envía ese presupuesto por la RPC `enviar_borrador_saint` de siempre (`origen = 'presupuesto'`).
  - Si el carrito va con estándar, avisa que SAINT pone su propio precio.

## Los cinco puntos

1. **Commits:** uno, sin `[migración]`.
2. **Migraciones:** ninguna. Usa `guardar_presupuesto` y `enviar_borrador_saint`, que ya están en producción. El envío a SAINT necesita aplicada la migración `20261025010000` (entrega del 25/10).
3. **Variables de entorno:** ninguna nueva.
4. **UI:** solo UI (Inventario). Rebuild completo.
5. **Verificado:**
   - Suite completa: 5579 tests en verde.
   - `tsc` sin errores; lint con 0 errores.
   - `npm run build` con BUILD_ID nuevo.
   - Mutaciones confirmadas en rojo:
     - Copiar visible para la caja.
     - Cashea dentro del cuerpo.
     - Acciones dentro de la zona desplazable.
     - Guardar la preferencia de estándar.
     - Enviar antes de guardar, o ignorar el id guardado.
   - Layout medido en Chromium con el DOM real y las hojas reales, a 1366×768, 1366×600 y 390×844, en tres estados (asesor cerrado, asesor abierto con Cashea, caja abierto). En los nueve casos: el último artículo se alcanza, los totales se alcanzan, los botones quedan dentro de la ventana y no hay desborde horizontal.
   - **No se probó contra la app levantada:** Docker estaba apagado. Tampoco se probó un envío real a SAINT; la RPC está cubierta por tests con mocks.

## Advertencias

- **Contenido del presupuesto que se envía.** Un envío desde el carrito deja un presupuesto en «Presupuestos guardados». Si había un presupuesto abierto que el usuario podía editar, sus renglones se reemplazan por los del carrito: lo que se envía es siempre lo que se ve en el carrito.
- **Envío fallido.** Si guardar falla, no se envía nada y el formulario queda abierto. Si guardar funciona pero el envío falla, el presupuesto queda guardado y activo, y se puede reintentar.
