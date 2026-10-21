# Entrega «Presupuestos guardados y mensajes rápidos que se encuentran» (21/10/2026)

Rama `entrega/presupuestos-y-mensajes-rapidos`, partida de `main` = `dc6fdc2`. Ronda del cliente del 21/10/2026: 12 solicitudes, plan aprobado con las decisiones D1 a D8 recomendadas. **DOS migraciones**, que se aplican ANTES del fast-forward de `main`. Sin variables de entorno nuevas. No toca a Seba (`src/lib/ai/` intacto).

## Pasos en el VPS
1. Confirmar que producción tiene aplicada `20261014030000_caja_sin_precio_estandar`. El test `rol_caja.sql` de esta rama lo presupone: la caja recibe `null` en `tarifa_mrw_usd`.
2. Aplicar en este orden, cada una con `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f <archivo>`:
   - `supabase/migrations/20261021010000_presupuestos.sql` → `NOTICE: 20261021010000: autoverificación de presupuestos correcta.`
   - `supabase/migrations/20261021020000_mensajes_rapidos_usos.sql` → `NOTICE: 20261021020000: autoverificación de quick_reply_uses / quick_replies_mas_usados correcta.`
   - Sin `-1`, las dos abortan a propósito con «Esta migración se aplica dentro de una transacción…».
3. Comprobar los permisos:
   - `select has_function_privilege('anon', 'public.quick_replies_mas_usados(timestamptz,integer,integer)', 'execute');` → `false`;
   - `select relname, relrowsecurity from pg_class where relname in ('presupuestos','presupuesto_items','quick_reply_uses');` → las tres con `true`.
4. Fast-forward de `main` a `entrega/presupuestos-y-mensajes-rapidos`. **Esto despliega.**
5. Mirar el CI del push a `main`.

## Commits (`dc6fdc2..` HEAD de la rama)
| # | Commit | Migración | Variables de entorno | UI / servidor |
|---|---|---|---|---|
| 1 | `e052ddd` [migración] Los presupuestos de cada cliente se guardan en la base | **Sí**, `20261021010000_presupuestos.sql` (+ `supabase/tests/presupuestos.sql`) | No | Solo base |
| 2 | `0472110` Los mensajes rápidos se buscan, se filtran por fotos y piden confirmar antes de borrarse | No | No | UI |
| 3 | `c86a841` [migración] Cada envío de un mensaje rápido queda contado para el ranking de los más usados | **Sí**, `20261021020000_mensajes_rapidos_usos.sql` (+ test SQL y guardián de permisos: 31 funciones definer) | No | Solo base |
| 4 | `2fb7822` Los mensajes rápidos muestran arriba los cinco más usados del equipo | No (usa la 3) | No | UI |
| 5 | `26fe9ae` Guardar el peso avisa si la base no lo guardó de verdad | No | No | UI (mensaje de error) |
| 6 | `b3d25a2` El carrito cobra el precio estándar, copia sin «incluye envío» y se guarda como presupuesto del cliente | No (usa la 1) | No | UI |
| 7 | `58911b3` El Inventario suma los presupuestos guardados y una calculadora de mostrador siempre a la vista | No (usa la 1) | No | UI |
| 8 | `4d51f93` El glosario, las trampas y producción explican los presupuestos y los mensajes rápidos más usados | No | No | Docs |
| 9 | `4bdf01f` El test de la caja acepta que guarde presupuestos y sigue vigilando cualquier otra escritura | No | No | Test SQL |
| 10 | `576acd9` La calculadora del mostrador ya no le quita ancho a la lista del Inventario | No | No | UI (CSS) |
| 11 | (este reporte) | No | No | Docs |

Todo es rebuild completo (~5 min): los commits de UI cambian el bundle del cliente.

**Sin las migraciones:**
- el panel «Presupuestos guardados» y la franja «Más usados» dan 400;
- guardar un presupuesto falla con un error visible;
- el registro de usos falla en silencio, sin frenar ningún envío.

## Qué cambia para los asesores
- **/inventario:**
  - El carrito de cotización tiene el interruptor «Cobrar precio estándar (envío por peso)». Era el bug: cobraba siempre la promoción. Un producto sin peso queda «Sin precio estándar» y no deja copiar hasta cargarle el peso.
  - Casillas «Qué incluir al copiar» y una vista previa del texto.
  - «Guardar presupuesto» con nombre y apellido.
  - Panel «Presupuestos guardados»: Míos / De todo el equipo, buscar, abrir en el carrito, copiar, borrar, y «Borrar mis presupuestos (N)» con ventana de confirmación.
  - Calculadora fija a la derecha: monto en Bs ÷ tasa BCV (acepta «18.524,40»), o en $, más el nivel Cashea con la inicial y las cuotas. Se pliega en pantallas angostas.
- **Chat:**
  - Cada resultado de la búsqueda de Inventario muestra el peso y deja cargarlo o editarlo. El estándar se recalcula al guardar.
  - «Lo que lleva el cliente» tiene «Qué copiar» y «Guardar presupuesto».
  - Debajo aparecen los presupuestos guardados de ese contacto, con «Pasar al carrito».
- **Texto copiado de cualquier carrito:**
  - dice «Precio» y ya no «Precio (incluye envío)»;
  - por defecto agrega «Total en bolívares», también en el chat, donde antes no salía;
  - la descripción de la venta y de la factura sigue diciendo «incluye envío MRW», a propósito.
- **Mensajes rápidos:**
  - buscador sin acentos (primero por título, después «También en el texto»);
  - filtro Todos / Solo texto / Con fotos;
  - franja «Más usados» con los 5 más enviados del equipo en 30 días, cortada a la medianoche de Caracas;
  - borrar pide confirmar dentro del renglón.
- **Caja:**
  - ve y guarda presupuestos, siempre en promoción (no ve el interruptor de estándar);
  - usa la calculadora;
  - no registra usos de mensajes rápidos (no tiene chat).

## Verificado en local
- **Suite completa, sobre el HEAD final:** 5411 en verde, 1 omitido y 1 todo. 246 archivos.
- **`tsc`:** sin errores.
- **Lint:** 0 errores (7 advertencias viejas de `no-unused-vars` en tests ajenos).
- **Build:** `rtk proxy npm run build` OK, con `BUILD_ID` nuevo.
- **Las dos migraciones**, aplicadas en limpio sobre la base de `dc6fdc2` con `psql -1`, con autoverificación OK. Sin `-1` abortan.
- **Los 40 tests de `supabase/tests/`** en verde, incluidos `presupuestos.sql`, `mensajes_rapidos_usos.sql` (20.000 usos medidos como `authenticated`: 22–70 ms) y `rol_caja.sql` (con la excepción de presupuestos, D4).
- **Mutaciones en rojo**, una por tarea:
  - la guarda de la caja contra el estándar;
  - el filtro de mensajes personales ajenos en el ranking;
  - «incluye envío» de vuelta;
  - `borrarMisPresupuestos` con `.neq`;
  - borrar sin confirmar (en mensajes rápidos y en presupuestos);
  - registrar el uso con `await` antes del envío;
  - pasar al carrito sin `quantity`;
  - `updateProductWeight` sin verificar filas;
  - el punto de miles en Bs;
  - `position: sticky` de la calculadora.
- **Verificación visual con Playwright** (Chromium, build de producción contra la base local, usuario supervisor):
  - **Ancho de pantalla:** nunca hay scroll horizontal, a 375, 1024, 1440 ni 1920 px.
  - **/inventario:**
    - Con el estándar encendido, el carrito pasa de $7,75 a $11,95 y la vista previa no dice «incluye envío». Desmarcar «Código» quita las líneas «SKU:».
    - Guardar presupuesto da el toast y la tarjeta en «Presupuestos guardados». «Borrar mis presupuestos» abre la ventana; Cancelar conserva y confirmar borra.
    - El Drawer a 375 px no desborda.
  - **Calculadora:** «18.524,40» Bs con la tasa 884,75 da $21,00; con N3, la inicial es $6,30 (30 %) y quedan 3 cuotas de $4,90.
  - **Chat:** el peso «1,5» con Enter da «Peso guardado», y el estándar se recalcula de $6,60 a $5,90.
  - **Mensajes rápidos:**
    - El buscador resalta lo que coincide y los filtros Solo texto y Con fotos funcionan.
    - La confirmación de borrado muestra el nombre del mensaje.
    - «Más usados» aparece con usos de ayer.
  - **Primera ronda:** encontró que, a 1440 px, la calculadora lateral dejaba ~60 px al nombre del producto y que los niveles Cashea se pisaban. Se corrigió en `576acd9`: el nombre mide 358 px a 1440 y 274 px a 1024, la calculadora sigue fija al bajar y los niveles ya no se solapan.

## No verificado / pendiente
- **Defectos que ya estaban y esta entrega no toca:**
  - A 761-1000 px, la fila de /inventario deja el nombre muy angosto. Sus 6 columnas fijas (`.inv-row`) no caben; ya pasaba en `dc6fdc2`.
  - En la lista de la bandeja, «cerrada» y el nombre del asesor se superponen en la tarjeta seleccionada.
- **Altura de la calculadora en barra:** 161 px a 1440 y 262 px a 1024 (en ese ancho el plan baja a una segunda fila).
- El job del CI no corrió: solo dispara en `main` y en los PR. Se reprodujo en local salvo el arnés del catálogo, que esta entrega no toca (ni `catalog-search.ts`, ni `tools.ts`, ni `products`).
- «Más usados» en producción empieza vacío: solo cuenta usos desde el deploy, y como corta en la medianoche, recién al día siguiente muestra algo.
- Pasar dos veces el mismo presupuesto al carrito del chat duplica las cantidades (`addToCart` suma). Está documentado y no hay confirmación.
- El envío a Saint queda fuera hasta que el operador averigüe el módulo. Cada renglón ya guarda el código Saint, la cantidad y el tipo de precio.
