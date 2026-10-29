# Entrega: /inventario ya no se cae al guardar un presupuesto (29/10/2026)

Rama `entrega/hotfix-canal-unico`, dos commits sobre `63b2ee5` (producción).

## Qué pasaba

Al guardar el primer presupuesto (o al abrir en el carrito el único que muestra la lista), `/inventario` caía en «This page couldn't load». Cada recarga volvía a caerse, porque el presupuesto activo vive en localStorage.

La causa:
- `CarritoPanel` y `PresupuestosPanel` montan `useBorradoresSaint("presupuesto", [mismoId])`, y las dos instancias pedían el mismo nombre de canal Realtime.
- realtime-js 2.112.3 devuelve el canal existente con ese topic, y su `on()` lanza `cannot add postgres_changes callbacks … after subscribe()` desde un `useEffect`.

## Qué cambia

- `src/lib/realtime-channel-name.ts` (nuevo): `nombreCanalUnico(base)` agrega un sufijo `:n` de un contador de módulo, pedido dentro del efecto. Cada suscripción tiene su propio canal; el filtro no cambia.
- `useBorradoresSaint` lo usa. Arregla `/inventario`, y además, al desmontar una instancia ya no se cierra el canal de la otra.
- `AssignmentNotifier` también lo usa. `AppRail` vive en la página y en `section-skeleton` durante una navegación, así que podía chocar igual. El dedupe de avisos ya era de módulo: no hay toasts dobles.
- Revisados sin cambios:
  - **Chat:** el canal `carrito` vive solo en `ContextPanel` y `PresupuestosCliente` es una sola instancia.
  - **`crm-shell.tsx`:** sus canales por contacto pertenecen a una sola instancia por página.
  - **`use-live-conversations`:** cada página usa su propio nombre.

## Los cinco puntos

1. **Commits:** dos, ninguno con `[migración]`. Uno es el arreglo con sus tests; el otro, este reporte.
2. **Migraciones:** ninguna.
3. **Variables de entorno:** ninguna.
4. **UI:** solo código de cliente. Rebuild completo.
5. **Verificado:**
   - Suite completa: 5661 tests en verde.
   - `tsc` sin errores; lint con 0 errores (los 7 avisos ya existían y ninguno sale de los archivos tocados).
   - `npm run build` con BUILD_ID nuevo.
   - Los fakes de Realtime de `use-borradores-saint.test.tsx` y `assignment-notifier.test.tsx` imitan ahora la semántica real:
     - `channel()` devuelve el canal existente;
     - `on()` lanza después de `subscribe()`;
     - `removeChannel` deja el canal en «leaving» hasta que el servidor confirma.
   - Con el código viejo, esos tests dieron rojo con el mismo error de producción. Entre ellos están los dos tests de «dos instancias a la vez» del aviso, que antes pasaban solo porque el fake nunca lanzaba.
   - Mutación (volver al nombre fijo): rojo en los dos archivos.
   - Con realtime-js 2.112.3 real en Node: dos canales con el nombre viejo lanzan el error; con el nombre único, no.
   - **No se probó en el navegador contra la app levantada.**

## Mientras no se despliegue

Se destraba borrando del navegador la clave `sbk:inventario-carrito:presupuesto:v1:<agentId>`. Los renglones del carrito no se pierden.
