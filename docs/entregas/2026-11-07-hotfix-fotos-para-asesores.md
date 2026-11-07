# Hotfix «Los asesores gestionan las fotos de los repuestos» (7/11/2026)

Push directo a `main`, partiendo de `c0273b6`. **Trae una migración** (`20261107010000_fotos_para_asesores.sql`) y ninguna variable de entorno nueva. El deploy es manual: aplicar la migración primero y desplegar después.

## Antes de desplegar: confirmar el commit de producción

Preguntar al operador en qué commit está producción (`<produccion>`) y listar las migraciones del rango:

```bash
git diff --name-only <produccion>..main -- supabase/migrations
```

Esta migración modifica las políticas de `20261031010000_fotos_de_productos.sql`. Si producción todavía no la tiene, hay que aplicarla antes, junto con las que lista `docs/entregas/2026-11-05-peso-notas-precios.md`. `20261028010000` («Facturar en SAINT») sigue fuera: espera a LiminalReplicant.

## Commits

| # | Hash y título | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | `e10e530` [migración] Los asesores pueden subir, reemplazar, borrar y marcar la foto principal de un repuesto | **Sí**, `20261107010000` | No | Base |
| 2 | `e8295a0` Los asesores ven los botones de fotos en Inventario y en el buscador del chat | No | No | UI |
| 3 | el commit que trae este reporte: documentación (GLOSARIO, CLAUDE.md, este reporte) | No | No | Nada en ejecución |

Costo: la migración tarda menos de un segundo (cambia 4 políticas y no toca filas). El deploy es un rebuild completo (~5 min), con el corte de ~22 s de siempre al recrear el contenedor.

## Aplicar la migración (antes del deploy)

```bash
PGOPTIONS="-c lock_timeout=5s" psql "<url de la base>" -1 -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20261107010000_fotos_para_asesores.sql
```

Si falta una política, la migración se autoverifica y aborta (`raise exception`). Se puede aplicar dos veces sin error.

El orden no es crítico. Con el código nuevo y sin la migración, el asesor ve los botones y la base lo rechaza con «Tu usuario no puede cambiar las fotos.». Nada se rompe.

## Qué cambia

1. RLS de `product_photos`: INSERT, UPDATE y DELETE pasan de `is_supervisor_or_admin()` a `is_agent()`, que cubre agent, supervisor y admin. La caja sigue solo leyendo.
2. Storage: la subida al bucket `product-photos` también pasa a `is_agent()`. Sigue sin haber políticas UPDATE ni DELETE sobre los objetos: nadie borra ni pisa un archivo que un mensaje enviado referencia.
3. UI: `puedeEditarFotos(role)` (`src/lib/product-photos.ts`) es la única regla de quién gestiona fotos (todos menos la caja). La usan /inventario (lista, cuadrícula y ficha) y el buscador del chat.
4. Textos: el aviso de rechazo dice «Tu usuario no puede cambiar las fotos.», y la ficha sin foto que ve la caja dice «Un asesor puede cargarla desde aquí.».

## Verificación hecha

- Tests nuevos en rojo antes del código (12 fallas). Después: tipos sin errores, lint sin errores (7 warnings viejos) y la suite completa en verde (6110).
- **Sin verificar en local:** `supabase/tests/fotos_de_productos.sql` no se corrió porque Docker Desktop no arrancó en esta máquina. Lo corre el CI en el job `migraciones` con el push a `main`. **Revisar que ese job salga verde antes de desplegar.**

## Verificación posterior al deploy

1. Probar los permisos en la base, como en el test (rol `authenticated` y el `sub` de un asesor real, dentro de una transacción con `rollback`): el INSERT de una foto da 1 fila.
2. En la app, entrar con un asesor a /inventario, abrir un repuesto sin foto y subir una. Tiene que aparecer en la lista y en la cuadrícula.
3. En el chat, con el mismo asesor: el buscador muestra «Fotos» en cada resultado y abre la ficha.
4. Una cuenta de caja no ve «Agregar foto» y su ficha dice «Un asesor puede cargarla desde aquí.».
5. Consola del navegador y logs del contenedor sin errores nuevos.

## Reversa

Para volver al acceso de solo supervisor y admin, reaplicar las cuatro políticas de `20261031010000_fotos_de_productos.sql`, sección 3 y la política `product_photos_storage_insert`. Hay que borrar antes las políticas `product_photos_*_agente`. Después, volver al commit anterior de producción y reconstruir.
