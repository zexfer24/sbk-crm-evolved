# Hotfix «Todo precio de producto lleva el 16 %» (6/11/2026)

Rama `entrega/hotfix-recargo-16`, partida de `main` = `629484b`. **No lleva migración** ni variable de entorno nueva. Toca código de servidor (la herramienta de catálogo de Seba) y de cliente (Inventario, caja, carrito, presupuestos, cierre de venta).

## Antes de desplegar: confirmar el commit de producción

Esta entrega no trae migración, pero sale de `629484b`. Preguntar al operador en qué commit está producción (`<produccion>`) y revisar qué migraciones arrastra el rango:

```bash
git diff --name-only <produccion>..entrega/hotfix-recargo-16 -- supabase/migrations
```

Si producción está detrás de `d426fa6`, hacen falta antes, y en este orden, las tres migraciones que lista `docs/entregas/2026-11-05-peso-notas-precios.md` (precio divisa, fotos de repuestos, PrecioI3 con su paso 0). No se repiten aquí. `20261028010000` («Facturar en SAINT») sigue fuera: espera a LiminalReplicant. Si producción ya está en `d426fa6` o posterior, no hay nada que aplicar.

## Commits

| # | Hash y título | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | `930c715` Todo precio de producto sale con el 16 % que pidió el cliente, en la pantalla del asesor y en lo que cotiza Seba | No | No | UI y servidor |
| 2 | el commit que trae este reporte: documentación (GLOSARIO, CLAUDE.md, este reporte) | No | No | Nada en ejecución |

Costo de despliegue: **rebuild completo (~5 min)**. El corte de ~22 s al recrear el contenedor es el de siempre.

## Qué cambia

1. `src/lib/recargo-precio.ts` (nuevo): `RECARGO_PRECIO = 0.16`.
   - `bsConRecargo`: bolívares × 1,16, al céntimo.
   - `usdConRecargo`: dólares × 1,16, hacia arriba al siguiente múltiplo de $0,10. Un valor ≤ 0 se deja tal cual («Sin precio en SAINT»).
2. `mapProduct` (`inventory-data.ts`) recarga `price` y `precioDivisaUsd`. De ahí salen Inventario, la caja, el carrito del chat, los presupuestos, el precio estándar, Cashea, el pie de foto y el cierre de venta con su factura del CRM.
3. La cotización de `buscarRepuesto` (`ai/tools.ts`) recarga el `price` crudo de `buscar_productos` ANTES de `usdFromBs`. Seba y el asesor cotizan el mismo número. `conversation_quotes` guarda desde ahora el precio recargado.
4. La tarifa de envío MRW **no** lleva recargo: estándar = producto recargado en $ + tarifa.
5. Es invisible: ni la UI, ni el texto copiado, ni el prompt dicen «IVA», «16 %» ni «recargo».
6. La base y SAINT **no cambian**: `products.price` y `saprod` siguen siendo el precio de SAINT.

## Lo que el operador ya sabe

- **SAINT no trae el 16 %.** «Enviar a SAINT» no manda precio; SAINT factura con el suyo. Si allá no se suben los precios, la factura de SAINT sale 16 % por debajo de lo cotizado en el CRM.
- El «valor del inventario» del resumen de Inventario sube 16 %.
- Las cotizaciones y presupuestos guardados antes del deploy conservan su precio de referencia viejo. Se cobra el de hoy (ya recargado) y el carrito muestra «cotizado $X · hoy $Y».

## Verificación hecha

- Tipos y lint sin errores (7 warnings viejos). Suite completa en verde. Build con `rtk proxy npm run build`: OK.
- Arnés del catálogo (`npm run test:arnes`) contra base y Redis locales: 151/151.
- Tests nuevos en rojo antes del código. Dos mutaciones (sin recargo en `mapProduct`, sin recargo en `tools.ts`): 6 y 7 tests en rojo.

## Verificación posterior al deploy

1. **Inventario.** Tomar un repuesto en VES y anotar su `price` en la base (`select price from products where saint_code = '<código>'`). En /inventario debe verse ese número × 1,16 en Bs, y el $ BCV calculado sobre el Bs ya recargado.
2. **Precio divisa.** Un repuesto con `precio_divisa_usd` = P: la ficha muestra P × 1,16 hacia arriba a $0,10 (10,00 → 11,60).
3. **Estándar.** El estándar es el $ del producto recargado + la tarifa MRW sin recargo.
4. **Seba.** Pedirle por WhatsApp de prueba un repuesto: el precio cotizado coincide con el que ve el asesor en /inventario.
5. **Textos.** Ni la ficha, ni el texto copiado, ni la cotización de Seba dicen «IVA» ni «16 %».
6. Consola del navegador y logs del contenedor sin errores nuevos.

## Reversa

No hay migración que revertir. Volver al commit anterior de producción y reconstruir.
