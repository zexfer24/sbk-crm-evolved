# Entrega «Cada repuesto con su foto» (31/10/2026)

Rama `entrega/fotos-de-repuestos`, partida de `main` = `bd4d98e`. Lleva **UNA migración propia** (`20261031010000_fotos_de_productos.sql`) y ninguna variable de entorno nueva. Toca la base, el Storage (un bucket público nuevo), la interfaz y los tests.

**Producción está en `a1db46c` (lo confirmó el operador el 30/10/2026).** Por eso esta entrega despliega, además de las fotos, los 5 commits del precio divisa (`51d86ce..bd4d98e`), que `main` ya tiene pero producción no. Las dos migraciones del rango se aplican **en este orden**:

1. `20261030010000_precio_divisa_saint.sql`. Puede estar ya aplicada: el operador la estaba aplicando el 30/10. El Paso 0 lo comprueba. Si no lo está, se aplica siguiendo `docs/entregas/2026-10-30-precio-divisa.md`.
2. `20261031010000_fotos_de_productos.sql`.

Qué hace: cada repuesto puede tener hasta 6 fotos, con una sola principal. Solo supervisor y admin las suben, reemplazan, borran y marcan como principal; asesores y caja solo las ven. En `/inventario` la vista es Lista (por defecto) o Cuadrícula, con la caja «Ordenar por», la ficha del repuesto, el filtro «Sin foto», el total «Con foto» y el bajo stock de 1 a 5 unidades. En el buscador del chat, «Enviar foto» manda la principal al cliente con el pie «nombre — $X BCV (Bs. Y)», el mismo formato de Seba; nunca dice «envío».

Plan: `docs/planes/2026-10-30-fotos-de-repuestos.md`.

## ⚠ Orden: la migración ANTES que el código

`PRODUCT_SELECT` pide `product_photos(...)`, y el filtro «Sin foto» hace un `left join` contra esa tabla. Sin la migración, PostgREST responde 400 a cada lectura que use ese select: `/inventario`, el buscador del chat, el carrito y los presupuestos (`data.ts`, `inventory-data.ts`, `presupuestos-data.ts`). Por eso se entrega en rama: aplicar la migración primero y recién después hacer fast-forward de `main`, que es lo que despliega.

## ⚠ Paso 0, antes de aplicar (solo lectura)

1. El operador confirma en qué commit está producción (`<produccion>`). Con ese commit se calcula el rango de migraciones:

   ```bash
   git diff --name-only <produccion>..entrega/fotos-de-repuestos -- supabase/migrations
   ```

   Con `<produccion>` = `a1db46c` salen DOS: `20261030010000_precio_divisa_saint.sql` y `20261031010000_fotos_de_productos.sql` (comprobado por el orquestador el 30/10/2026). Si aparece `20261028010000` («Facturar en SAINT», teléfono opcional) y no está aplicada en producción, **NO aplicarla con esta entrega**: sigue esperando la confirmación de LiminalReplicant (ver `docs/entregas/2026-10-30-precio-divisa.md`).

2. Consultas de solo lectura:

   ```sql
   -- 1. ¿Existe ya algo de la entrega? Deben salir null y 0.
   select to_regclass('public.product_photos') as tabla,
          (select count(*) from storage.buckets where id = 'product-photos') as bucket;

   -- 2. Las funciones de las que cuelgan las políticas. Deben salir las dos.
   select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('can_read_inventory', 'is_supervisor_or_admin')
    order by proname;

   -- 3. La migración de la entrega anterior (precio divisa), de la que depende bd4d98e. Debe salir true.
   select to_regprocedure('public.precio_divisa_usd(public.products)') is not null as precio_divisa_aplicada;
   ```

Cómo leerlo:
- `tabla` o `bucket` distintos de null o de 0: ya existe algo. **NO aplicar** sin hablarlo con el operador. La migración es re-ejecutable, pero hay que saber qué quedó.
- Falta una de las dos funciones: **NO aplicar**. La migración aborta al crear las políticas.
- `precio_divisa_aplicada` = false: **todavía NO aplicar la de fotos**. Primero aplicar `20261030010000` siguiendo su propio reporte (`docs/entregas/2026-10-30-precio-divisa.md`, con su Paso 0), volver a correr esta consulta y recién con `true` seguir con `20261031010000`.

## Pasos en el VPS

1. El Paso 0.
2. Aplicar con `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261031010000_fotos_de_productos.sql`.
   - Es re-ejecutable: `create ... if not exists`, `drop policy if exists` y `on conflict ... do update` para el bucket.
   - Sin `-1` la guarda de la migración aborta con un mensaje explícito.
   - Termina con una autoverificación (bucket público, RLS activa, `anon` sin lectura, política de subida presente) y `notify pgrst`.
   - Debe terminar sin error. Si la autoverificación falla, el mensaje dice qué falló: no seguir al paso 4.
3. Comprobar (solo lectura):

   ```sql
   select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'product-photos';  -- true | 5242880 | {image/jpeg,image/png}
   select relrowsecurity from pg_class where relname = 'product_photos';                                -- true
   select has_table_privilege('anon', 'public.product_photos', 'select');                                -- false
   select count(*) from public.product_photos;                                                           -- 0 justo después de aplicar
   ```

4. Fast-forward de `main` a `entrega/fotos-de-repuestos`. Es lo que despliega. **Toca la interfaz: rebuild completo.**

## Verificación en producción (después del deploy)

- `/inventario` abre sin error en la vista Lista, que es la de por defecto. Cambiar a Cuadrícula y recargar: la vista se mantiene (cookie `sbk-inventario-vista`).
- Con repuestos sin foto, el filtro «Sin foto» los lista, y el total «Con foto» arranca en 0. Al arrancar hay 6.440 repuestos sin foto: la carga es manual, foto por foto.
- Como supervisor, en la ficha de un repuesto: agregar una foto de prueba. Aparece en la lista, en la tarjeta y como principal. Su URL pública responde 200 sin sesión (ver `docs/PRODUCCION.md`, sección «Fotos de los repuestos»).
- Como asesor y como caja: ven la foto, pero no los botones de agregar, reemplazar, borrar ni marcar principal. La caja ve «Precio divisa» y no el precio estándar.
- En un chat de prueba (número del equipo), «Enviar foto» manda la principal con el pie «nombre — $X BCV (Bs. Y)». Con la ventana de 24 h cerrada, el botón queda deshabilitado y dice por qué.
- **Riesgo del plan, antes de anunciar la función:** tras ese envío real, el access log de Traefik tiene que mostrar la descarga de Meta (user agent `facebookexternalua`) con 200. El 21/9 una descarga de Meta murió en Traefik antes de llegar a Envoy. Si no aparece, no anunciar la función.
- Costo: si `/inventario` se nota más lento, medir como `authenticated` y no como superusuario (ver la trampa de las búsquedas en CLAUDE.md): `set local role authenticated` y `request.jwt.claims` con el `sub` de un agente, dentro de una transacción, y `explain analyze` sobre la consulta de `PRODUCT_SELECT`.

## Reversa

- **El código:** revertir a `bd4d98e` y desplegar. El código viejo no lee `product_photos` ni el bucket.
- **La migración:** no se revierte. La tabla y el bucket quedan inertes. Las fotos que ya salieron por el chat siguen en el bucket, porque los mensajes las referencian: el bucket no se vacía ni se borra.
- **Orden:** revertir el código ANTES de cualquier cambio en la base. Quitar la tabla (`drop table public.product_photos;`) solo a mano, después de revertir el código.

## Commits

De más viejo a más nuevo. Ninguno agrega variables de entorno.

### `a1317c9`

1. Hash y título: `a1317c9`, «[migración] La base guarda las fotos de cada repuesto y solo un supervisor puede cargarlas».
2. Migración: **sí**, solo este commit: `supabase/migrations/20261031010000_fotos_de_productos.sql`. Va ANTES del código. También cablea el test en `.github/workflows/ci.yml` (job `migraciones`).
3. Variables de entorno: ninguna.
4. Interfaz: no. Solo base; no requiere rebuild por este commit.
5. Qué se verificó: suite completa en verde (5945 tests), `tsc` y lint limpios, test SQL `fotos_de_productos.sql` en verde; verificación en la app real: ver «Verificación del orquestador» al final.

### `5491c46`

1. Hash y título: `5491c46`, «El inventario trae las fotos de cada repuesto, el filtro «Sin foto» y el bajo stock pasa a 1–5».
2. Migración: no.
3. Variables de entorno: ninguna.
4. Interfaz: sí, toca `src/components/inventario/inventario-view.tsx` y sus tests. **Rebuild completo.**
5. Qué se verificó: suite completa en verde (5945 tests), `tsc` y lint limpios, test SQL `fotos_de_productos.sql` en verde; verificación en la app real: ver «Verificación del orquestador» al final.

### `605e86c`

1. Hash y título: `605e86c`, «Un supervisor puede subir, reemplazar, borrar y marcar principal la foto de un repuesto».
2. Migración: no.
3. Variables de entorno: ninguna.
4. Interfaz: no. Solo `src/lib` (`config-write.ts` y los helpers de fotos, que todavía no monta ningún componente). No requiere rebuild por este commit.
5. Qué se verificó: suite completa en verde (5945 tests), `tsc` y lint limpios, test SQL `fotos_de_productos.sql` en verde; verificación en la app real: ver «Verificación del orquestador» al final.

### `222e915`

1. Hash y título: `222e915`, «La tarjeta de la cuadrícula del inventario muestra la foto, el estado del stock y los botones de carrito y Cashea».
2. Migración: no.
3. Variables de entorno: ninguna.
4. Interfaz: sí, componentes nuevos de `src/components/inventario` (la tarjeta todavía no está montada en la vista). **Rebuild completo.**
5. Qué se verificó: suite completa en verde (5945 tests), `tsc` y lint limpios, test SQL `fotos_de_productos.sql` en verde; verificación en la app real: ver «Verificación del orquestador» al final.

### `c16b560`

1. Hash y título: `c16b560`, «El asesor manda la foto de un repuesto al cliente desde el buscador del chat».
2. Migración: no.
3. Variables de entorno: ninguna.
4. Interfaz: sí, `src/components/context-panel` y `src/components/crm.css`. **Rebuild completo.**
5. Qué se verificó: suite completa en verde (5945 tests), `tsc` y lint limpios, test SQL `fotos_de_productos.sql` en verde; verificación en la app real: ver «Verificación del orquestador» al final.

### `d3e628a`

1. Hash y título: `d3e628a`, «La ficha del repuesto muestra su galería, sus datos de Saint y qué le falta para Cashea».
2. Migración: no.
3. Variables de entorno: ninguna.
4. Interfaz: sí, componentes nuevos de `src/components/inventario` (la ficha todavía no está montada en la vista). **Rebuild completo.**
5. Qué se verificó: suite completa en verde (5945 tests), `tsc` y lint limpios, test SQL `fotos_de_productos.sql` en verde; verificación en la app real: ver «Verificación del orquestador» al final.

### `437cef5`

1. Hash y título: `437cef5`, «El inventario se ve en lista compacta o en cuadrícula con fotos, y filtros y orden van en una sola caja «Ordenar por»».
2. Migración: no.
3. Variables de entorno: ninguna.
4. Interfaz: sí, `src/app/inventario/page.tsx` y `src/components/inventario`. Es el commit que monta la vista nueva. **Rebuild completo.**
5. Qué se verificó: suite completa en verde (5945 tests), `tsc` y lint limpios, test SQL `fotos_de_productos.sql` en verde; verificación en la app real: ver «Verificación del orquestador» al final.

### (este commit)

1. Hash y título: todavía no existen. El título se fija al commitear.
2. Migración: no.
3. Variables de entorno: ninguna.
4. Interfaz: no; solo documentación. No requiere rebuild.
5. Qué se verificó: `git diff --stat` muestra solo `docs/GLOSARIO.md`, `CLAUDE.md`, `docs/PRODUCCION.md` y este archivo.

## Verificación del orquestador (30/10/2026, base local)

- **Build de producción** (`rtk proxy npm run build`): terminó sin errores, con `BUILD_ID` nuevo.
- **Suite completa:** 5945 tests en verde. `tsc` y lint, limpios.
- **Test SQL** `fotos_de_productos.sql`: en verde.
- **Mutaciones manuales** (respaldo con `cp`, restauradas). Cada una puso tests en rojo:

  | Mutación | Resultado |
  |---|---|
  | Umbral de bajo stock en 3 | 4 rojos |
  | Pie de foto con «incluye envío» | 3 rojos |
  | «Enviar foto» habilitado con la ventana cerrada | 1 rojo |
  | Política INSERT de storage sin `is_supervisor_or_admin()` | el test SQL detectó que asesor y caja podían subir |

- **App real** (`next dev` contra la base local, supervisor del seed, 4 fotos de muestra subidas a `product-photos`):
  - **Lista a 1280 px:** sin scroll horizontal; fotos cargadas; colores de stock correctos; botones a la derecha.
  - **«Ordenar por»:** se abre por encima de las filas. «Sin foto» deja exactamente los 2 repuestos sin foto.
  - **Cuadrícula:** la cookie se escribe y el servidor pinta la cuadrícula (3 columnas a 1280 px, 2 a 390 px).
  - **Ficha:** galería y «Para Cashea»; sin «Enviar foto». «Marcar como principal» cambió la principal en la base (el trigger desmarcó la otra).
  - **Teléfono (390 px):** lista y cuadrícula sin scroll horizontal y sin cifras cortadas.
  - **Chat:** con la ventana cerrada, «Enviar foto» queda deshabilitado con el motivo. Con la ventana abierta y el canal en `pending` (envío simulado), se insertó un `messages` de tipo `image` con la URL pública de la principal y el pie «… — $35,50 BCV (Bs. 31.579,93)». La URL responde 200 sin sesión.
- **NO verificado en la app real:** 768 px y 1700 px. El panel del navegador quedó oculto y la página no se maquetaba. Esos anchos solo quedaron verificados en el mockup y en los tests de la hoja CSS.
- **Hallazgo del entorno local, no del código:**
  - **El problema:** el Storage local (v1.72.1) fallaba TODA subida, incluida la de `whatsapp-media`, con 42P10, porque a `storage.objects` le faltaba el índice único `(bucket_id, name)` que usa su `ON CONFLICT`.
  - **Arreglo local:** se creó `bucketid_objname` como `supabase_admin`.
  - **En producción:** comprobar la subida de una foto de prueba ANTES de anunciar la función (paso de curl en `docs/PRODUCCION.md`).
