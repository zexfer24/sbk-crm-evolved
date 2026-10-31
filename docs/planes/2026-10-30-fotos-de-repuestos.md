# Plan "Cada repuesto con su foto" — 30/10/2026

**Estado: APROBADO por el operador el 30/10/2026.** Se trabaja en el worktree
`SBK CRM-fotos`, rama `entrega/fotos-de-repuestos` (desde `bd4d98e`). Se
ejecuta con `liminalwork`: el orquestador
no implementa; despliega un subagente por tarea, valida cada reporte y corre
la verificación final.

Referencia visual: el mockup `mockups/inventario-fotos/index.html` (sin
trackear; se sirve con `python -m http.server 4321` desde esa carpeta). Es la
fuente de verdad del diseño. Donde el mockup y este plan difieran, manda el
plan.

## Decisiones del operador (30/10/2026)

- **D1 — Quién sube:** solo supervisor y admin suben, reemplazan, borran y
  marcan la foto principal. Se exige en RLS y en las políticas de Storage, no
  solo en la interfaz. Asesores y caja solo ven.
- **D2 — Pie de foto al enviar:** nombre + precio, con el mismo formato con el
  que cotiza Seba (`formatQuote`, `src/lib/ai/precio.ts:27`), por ejemplo
  «DISCO DE FRENO DELANTERO BERA SBR — $14.10 BCV (Bs. 12500.00)». El asesor
  lo puede quitar con una casilla. Nunca dice «incluye envío» (trampa de
  `cartSummaryText`).
- **D3 — Desde dónde se envía:** solo desde el buscador de inventario del
  panel del chat. En esta entrega no hay «Enviar al chat» en la ficha de
  /inventario.
- **D4 — Vista inicial:** Lista. Después se recuerda la última vista que eligió
  cada asesor.
- **D5 — Almacenamiento:** bucket NUEVO `product-photos`, de lectura pública.
  Solo supervisor y admin escriben en él. Así la caja ve las fotos sin abrirle
  `/api`, y Meta las descarga directo por la URL pública, que no vence.
- **D6 — Pedidos del mockup que entran a producción:**
  - Lista compacta: encabezado único, foto de 72 px, insignias bajo el nombre
    y sin texto de compatibilidad.
  - Etiquetas centradas sobre su caja.
  - «incluye envío» en lugar de «incluye envío MRW».
  - Botones de ícono: carrito con «+» y el logo de Cashea.
  - Stock en verde con más de 5, naranja de 1 a 5 y rojo en 0.
  - Una sola caja «Ordenar por» con dos secciones, Mostrar y Ordenar.
  - Números de página en el paginador.
  - Tarjeta de la cuadrícula según la referencia del operador.

## Contexto (lo que ya se midió en el código)

- **`products` es de solo lectura** (trigger `enforce_products_read_only`,
  `20260925010000`). Una tabla aparte con FK a `products(id)` no lo dispara:
  ya funcionan así `product_weight_audit`, `conversation_cart_items` y
  `presupuesto_items`. `products.id` es uuid y Saint nunca borra filas (las
  bajas son `is_active = false`).
- **La caja no pasa `is_agent()`** (`20261013010000_rol_caja.sql:76`). Las
  tablas de inventario la dejan leer con `can_read_inventory()` en políticas
  `<tabla>_select_inventario`. El middleware le devuelve 403 en todo `/api`, y
  `/api/media` también la rechaza. Por eso existe D5.
- **Meta solo acepta JPEG o PNG** de hasta 5 MB para `image`
  (`quick-reply-media.ts`). WebP no sirve: el mockup decía WebP y queda
  corregido aquí.
- **El envío de medios** pasa por `sendMediaMessage(conversationId, mediaUrl,
  mediaType, caption?)` (`mutations.ts:141`) → `/api/messages/send`. Una
  `mediaUrl` http que no es del bucket privado pasa TAL CUAL a Meta
  (`media-link.ts`). La burbuja pinta `message.mediaUrl` directo
  (`message-bubble.tsx:205`). El servidor NO revisa la ventana de 24 h: lo hace
  el cliente con `isComposerWindowOpen` (`whatsapp-window.ts:87`).
- **El outbox es solo de texto**; las fotos llaman directo a
  `sendMediaMessage`. Las fotos del bucket nunca se borran porque los mensajes
  enviados apuntan a ellas (mismo criterio que `quick-replies/`).
- **«Ir a la página» YA EXISTE** en producción (`inventario-paginador.tsx`,
  `paginaDestino`). Este plan solo le suma los números de página.
- **Umbral de bajo stock:** `LOW_STOCK_THRESHOLD = 3` (`inventory.ts:22`). Lo
  usan solo `stockLevel`, `aplicarFiltros`, `fetchInventoryTotals` y el texto
  vacío de la vista; la IA no lo usa. Pasa a 5.
- **Filtros y orden:**
  - `FILTERS` y `INVENTORY_FILTER_LABELS` están en `inventory.ts:392/412`.
  - La vista ofrece `["nombre", "stock", "precio"]` (`inventario-view.tsx:39`).
  - Todo va por URL (`q`, `filtro`, `orden`, `page`; `parseInventoryParams`).
- **Tests CSS que fijan la lista actual** y que cambian A PROPÓSITO: en
  `inventario-css.test.ts`, la plantilla exacta de 8 columnas, la de la caja y
  las de 761–1180 y teléfono. La barra sticky (`mostrador.css:194-243` y su
  test) no cambia de mecánica: la caja «Ordenar por» vive dentro de ella.
- **Docker está apagado** en esta máquina. Hay que encenderlo antes de T1 y de
  T2 para correr los tests SQL y comprobar PostgREST.
- **Última migración:** `20261030010000_precio_divisa_saint.sql`.

## Diseño

**Tabla `public.product_photos`:**

| Columna | Definición |
|---|---|
| `id` | uuid pk default `gen_random_uuid()` |
| `product_id` | uuid not null references `products(id)` on delete cascade |
| `storage_path` | text not null unique, check `storage_path like product_id::text \|\| '/%'` |
| `is_primary` | boolean not null default false |
| `position` | smallint not null default 0 |
| `width`, `height` | integer |
| `bytes` | integer |
| `created_by` | uuid references `agents(id)` on delete set null |
| `created_at` | timestamptz default `now()` |

Índices y triggers:
- Índice único parcial `(product_id) where is_primary`: una sola principal por
  repuesto.
- Índice en `(product_id, position)`.
- Trigger BEFORE INSERT que rechaza la séptima foto, con el mensaje «Este
  repuesto ya tiene 6 fotos.».
- Trigger BEFORE INSERT/UPDATE: si la fila queda `is_primary`, desmarca las
  demás del mismo producto. Además, la primera foto de un producto nace
  principal.
- Trigger AFTER DELETE: si se borró la principal, promueve la de menor
  `position`.
- Los tres triggers son `security invoker`: corren con los permisos de quien
  escribe, que ya es supervisor o admin. No suben el contador de
  `permisos-funciones.test.ts`.

**RLS:**
- `select` para `can_read_inventory()`, caja incluida.
- `insert`, `update` y `delete` para `is_supervisor_or_admin()`.
- Grants: `revoke all … from anon` explícito (trampa del `alter default
  privileges`); `select, insert, update, delete` a `authenticated`; `all` a
  `service_role`.
- `notify pgrst`.

**Bucket `product-photos`:**
- `insert into storage.buckets (id, name, public, file_size_limit,
  allowed_mime_types)` con `true`, 5 MB y `image/jpeg`/`image/png`.
- Política `storage.objects` INSERT para `bucket_id = 'product-photos' and
  is_supervisor_or_admin()`.
- Sin UPDATE ni DELETE: los objetos no se borran nunca, porque los mensajes
  enviados los referencian.
- La lectura es pública por URL: `storage.from('product-photos').getPublicUrl(path)`.

**Ruta del archivo:** `<product_id>/<uuid>.jpg`. El navegador la reduce a 1600
px como máximo por lado, en JPEG con escalera de calidad hasta ≤ 1 MB, antes
de subirla.

**Borrar una foto** borra la FILA, no el objeto. El objeto queda huérfano a
propósito.

## Reglas de ejecución

- **Primero el test, después el código:** cada test nuevo se ve en ROJO antes
  de implementar.
- Ningún subagente commitea. Un archivo lo toca una sola tarea; la tabla de
  archivos de cada tarea es la lista cerrada.
- La migración va en su propio commit con `[migración]` en el título.
- La entrega va por una rama `entrega/fotos-de-repuestos`. El VPS aplica la
  migración ANTES del fast-forward de `main`.
- Mutaciones de verificación: respaldar con `cp` y restaurar desde la copia,
  nunca con `git checkout --`.
- Tests con DOM: `/** @vitest-environment jsdom */`. `localStorage` y
  cookies, siempre dentro de `try/catch`.
- Todo en español; los comentarios explican el porqué con la fecha 30/10/2026.
- Toda mutación de escritura lleva `.select("id")` + `assertRowsAffected`
  (`config-write.ts:53`), con mensajes nuevos en `config-write.ts`.

## Olas

| Ola | Tareas | Depende de |
|---|---|---|
| 1 | T1 migración | — |
| 2 | T2 datos y reglas puras | T1 |
| 3 | T3 subida y mutaciones · T5b tarjeta · T6 enviar desde el chat (en paralelo) | T2 |
| 4 | T4 ficha del repuesto | T3 |
| 5 | T5a lista, barra y montaje de la vista | T4, T5b |
| 6 | T7 documentación + verificación final | todas |

Modelos:
- T1–T6: Sonnet 5.5, esfuerzo medio-alto.
- T7: Haiku 4.5, esfuerzo bajo.

---

## T1 [migración] — Tabla `product_photos` y bucket `product-photos`

1. **Objetivo:** la base guarda las fotos de cada repuesto con una sola
   principal, un tope de 6 y escritura solo para supervisor o admin.
2. **Contexto:** sección Diseño de este plan. Plantilla de migración con
   `set local lock_timeout = '5s'` + guarda de `psql -1`
   (`20261013010000_rol_caja.sql:53-62`). Trampa de los grants por defecto de
   Supabase (CLAUDE.md, «Toda función security definer…» y `saint.sync_log`).
3. **Archivos:**
   - Leer: `20261013010000_rol_caja.sql` (`can_read_inventory`, políticas
     `_select_inventario`, insert en `storage.objects`),
     `20260909020000_stickers.sql`, `supabase/tests/presupuestos.sql` y
     `supabase/tests/rol_caja.sql`.
   - Crear: `supabase/migrations/20261031010000_fotos_de_productos.sql` y
     `supabase/tests/fotos_de_productos.sql`.
   - Modificar: `.github/workflows/ci.yml` (cablear el test SQL nuevo en el
     job `migraciones`, igual que los demás).
4. **Fuera de alcance:** `products`, su trigger, `whatsapp-media`, los tipos
   TS y `database.types.ts`.
5. **Especificación:** exactamente la de la sección Diseño. Mensajes de los
   triggers en español. Bucket `public = true`, `file_size_limit = 5242880`,
   `allowed_mime_types = '{image/jpeg,image/png}'`. Sin funciones `security
   definer`. Termina con una autoverificación (`raise exception` si el bucket
   no quedó público o la tabla no tiene RLS).
6. **Tests** (`fotos_de_productos.sql`, como `authenticated` con
   `request.jwt.claim.sub` de cada rol):
   - Escritura en la tabla:
     - supervisor inserta 1 fila;
     - asesor y caja reciben 42501 al insertar;
     - asesor y caja hacen UPDATE o DELETE y afectan 0 filas.
   - Lectura: caja, asesor y supervisor leen la fila.
   - La primera foto nace principal; marcar otra desmarca la anterior; borrar
     la principal promueve la siguiente; la séptima da el error.
   - Bucket:
     - INSERT en `storage.objects` con `bucket_id='product-photos'`:
       supervisor 1 fila, asesor y caja 42501;
     - el bucket es público.
   - Se corre con
     `docker exec … psql -1 -v ON_ERROR_STOP=1 -f supabase/tests/fotos_de_productos.sql`
     tras aplicar la migración.
   - Aplicarla dos veces sobre la base local no puede fallar (idempotencia
     donde aplique: `on conflict do nothing` para el bucket).
7. **Modelo:** Sonnet 5.5, medio-alto.
8. **Reporte:** compacto, con la salida del test SQL reducida a las líneas de
   resultado.

## T2 — Datos y reglas puras del inventario

1. **Objetivo:** cada `Product` trae sus fotos, existe el filtro «Sin foto»,
   el total «Con foto», el umbral de bajo stock en 5 y las funciones puras que
   usan las tareas siguientes.
2. **Contexto:**
   - `PRODUCT_SELECT`/`mapProduct` (`inventory-data.ts:30-67`),
     `aplicarFiltros` (:111), `fetchInventoryTotals` (:234) e
     `InventoryTotals` (:217).
   - `FILTERS`, `INVENTORY_FILTER_LABELS`, `stockLevel` y
     `LOW_STOCK_THRESHOLD` (`inventory.ts`); `Product` (`types.ts:1103`).
   - D5: URL pública del bucket.
3. **Archivos:**
   - Modificar `src/lib/types.ts`: tipo `ProductPhoto` y campo
     `fotos: ProductPhoto[]` en `Product`.
   - Modificar `src/lib/inventory.ts`:
     - umbral 5;
     - filtro `sin-foto` con etiqueta «Sin foto», agregado a `FILTERS`;
     - `casheaReadiness`;
     - `INVENTORY_VIEW_COOKIE` y `parseInventoryView`.
   - Modificar `src/lib/inventory-data.ts`:
     - embed de fotos en `PRODUCT_SELECT` y su mapeo;
     - filtro anti-join;
     - total `conFoto`.
   - Crear `src/lib/product-photos.ts`: `productPhotoUrl(path)` con
     `getPublicUrl` y `fotoPrincipal(product)`.
   - Modificar los tests vecinos `inventory.test.ts` e
     `inventory-data.test.ts`, y crear `product-photos.test.ts`.
   - Si algún test de otro módulo arma un `Product` a mano y se rompe por el
     campo nuevo, se le agrega `fotos: []` (y nada más).
4. **Fuera de alcance:** componentes, CSS y mutaciones de escritura.
5. **Especificación:**
   - `ProductPhoto = { id: string; storagePath: string; url: string;
     isPrimary: boolean; position: number }`.
   - El embed en `PRODUCT_SELECT` es
     `product_photos(id, storage_path, is_primary, position)`. `mapProduct`
     ordena principal primero y luego por `position`.
   - El filtro `sin-foto` usa el alias `sin_foto:product_photos!left(id)` en el
     select + `.is("sin_foto", null)`. Se comprueba contra la base local; si
     el PostgREST local no lo soporta, el subagente se DETIENE y lo reporta.
   - `InventoryTotals.conFoto` = count `head` de `product_photos` con
     `is_primary = true`.
   - `LOW_STOCK_THRESHOLD = 5`, con un comentario que lo explique.
   - `casheaReadiness(product): { listo: boolean; faltan: string[] }`, con los
     criterios «Foto principal», «Peso cargado», «Precio divisa en SAINT» y
     «Activo en Saint».
   - `parseInventoryView(valor): "lista" | "cuadricula"`; si el valor es
     cualquier otra cosa, devuelve `"lista"` (D4).
   - `INVENTORY_VIEW_COOKIE = "sbk-inventario-vista"`.
6. **Tests:**
   - `stockLevel`: 0 → agotado, 1 y 5 → bajo, 6 → disponible, con literales y
     no con el símbolo (trampa del 20/9).
   - `casheaReadiness`: los cuatro casos.
   - `parseInventoryView`.
   - `mapProduct`: orden de las fotos.
   - El filtro `sin-foto` arma la consulta correcta (fake que registra operador
     y argumento).
   - `productPhotoUrl` usa el bucket `product-photos`.
   - Comando: `rtk npx vitest run src/lib/inventory.test.ts
     src/lib/inventory-data.test.ts src/lib/product-photos.test.ts`.
7. **Modelo:** Sonnet 5.5, medio-alto.
8. **Reporte:** compacto.

## T3 — Subir y gestionar fotos (lógica, sin interfaz)

1. **Objetivo:** existen funciones probadas para comprimir, subir, borrar y
   marcar la foto principal.
2. **Contexto:**
   - Patrón de stickers y quick replies: `uploadQuickReplyPhoto`
     (`mutations.ts:1220`), `deleteSticker` (:1951), `assertRowsAffected`.
   - La compresión con canvas imita `sticker-canvas.ts:67`, con dependencias
     inyectables (:37).
   - Meta solo acepta JPEG o PNG.
3. **Archivos:**
   - Crear `src/lib/product-photo-image.ts` con
     `renderProductPhotoJpeg(file, deps?)` y su test.
   - Crear `src/lib/product-photo-mutations.ts` y su test. Es archivo propio
     para no chocar con `mutations.ts`.
   - Modificar `src/lib/config-write.ts`: mensaje
     `PRODUCT_PHOTO_DENIED_MESSAGE = "Solo un supervisor o administrador puede
     cambiar las fotos."`.
4. **Fuera de alcance:** componentes y `mutations.ts`.
5. **Especificación:**
   - `renderProductPhotoJpeg(file: Blob): Promise<{ blob: Blob; width:
     number; height: number } | null>`:
     - lado mayor ≤ 1600 sin agrandar;
     - fondo blanco, porque JPEG no tiene transparencia;
     - `toBlob("image/jpeg", q)` con q de 0.9 a 0.5, hasta ≤ 1 MB;
     - devuelve `null` si nada entra.
   - Entrada aceptada: `image/jpeg`, `image/png` o `image/webp` hasta 15 MB.
     Cualquier otra cosa lanza «Formato no admitido: usa JPG, PNG o WebP.».
   - `uploadProductPhoto(supabase, productId, file)`:
     - comprime;
     - sube a `product-photos/<productId>/<uuid>.jpg` con `contentType
       image/jpeg`;
     - inserta la fila con `.select("id, storage_path, is_primary,
       position").single()`;
     - si el insert falla, NO borra el objeto (no hay política DELETE) y lanza
       el error con el mensaje de la base. El tope de 6 llega como error del
       trigger.
   - `deleteProductPhoto(supabase, photoId)` y
     `setPrimaryProductPhoto(supabase, photoId)` llevan `.select("id")` +
     `assertRowsAffected(data, PRODUCT_PHOTO_DENIED_MESSAGE)`.
   - `replaceProductPhoto(supabase, photo, file)`: sube la nueva con el mismo
     `position` y la misma marca de principal, y después borra la fila vieja.
6. **Tests:**
   - Compresión con deps falsas: reduce 4000×3000 a 1600×1200, baja la
     calidad hasta entrar, devuelve null y rechaza un tipo inválido.
   - Mutaciones con un fake que registre tabla, operación, columna y valor
     (trampa del 20/9): ruta exacta y bucket, `contentType`, error de 0 filas
     → `ConfigWriteDeniedError`, el reemplazo conserva `position`.
7. **Modelo:** Sonnet 5.5, medio-alto.
8. **Reporte:** compacto.

## T4 — Ficha del repuesto

1. **Objetivo:** al tocar la foto o el nombre de un repuesto se abre una ficha
   lateral. Muestra la galería, los datos de Saint y «Para Cashea»; supervisor
   y admin gestionan las fotos ahí.
2. **Contexto:**
   - Mockup, función `ficha()`.
   - Drawer de HeroUI como en `carrito-panel.tsx` (`drawer__dialog`).
   - D1: la caja y los asesores no ven los botones de gestión. Leer
     `currentAgent.role` desde un prop.
   - D3: SIN «Enviar foto al chat».
3. **Archivos:**
   - Crear `src/components/inventario/producto-ficha.tsx`,
     `producto-ficha.test.tsx` y `producto-ficha.css`.
   - Leer `carrito-panel.tsx`, `cashea-calculadora.tsx`,
     `inventario-carrito-context.ts`, `product-photo-mutations.ts` e
     `inventory.ts`.
4. **Fuera de alcance:** el montaje en la vista (lo hace T5a) y
   `producto-fila.tsx`.
5. **Especificación:**
   - Props: `ProductoFicha({ product, bcvRate, puedeEditarFotos, isOpen,
     onOpenChange, onCambio })`. `onCambio` llama a `router.refresh()` desde
     el padre.
   - Galería: foto principal 4:3, miniaturas y una estrella en la principal.
   - Gestión (solo si `puedeEditarFotos`):
     - «Agregar foto» con input file que acepta jpg, png y webp;
     - «Reemplazar», «Eliminar» con confirmación y «Marcar como principal»;
     - hasta 6 fotos: la casilla de agregar desaparece a la sexta.
   - Sin fotos:
     - supervisor y admin ven la zona «Agregar la primera foto»;
     - el resto ve «Este repuesto todavía no tiene foto».
   - Datos: stock con su color, precio promoción, divisa, estándar (no para la
     caja), con «incluye envío $X», y peso.
   - «Para Cashea»: viene de `casheaReadiness`, con la nota «La sincronización
     con Cashea todavía no existe».
   - Pie: «Agregar al carrito» (ícono carrito +) y «Cashea» (logo), que reusan
     el contexto del carrito y `CasheaCalculadora`.
   - Errores en `toast.danger` con `configErrorMessage`.
6. **Tests (jsdom):**
   - Por rol: supervisor ve los botones de gestión; asesor y caja no.
   - Agregar llama a `uploadProductPhoto` y luego a `onCambio`; un error
     muestra el toast.
   - Eliminar pide confirmación.
   - Sin fotos, cada rol ve su texto.
   - «Para Cashea» lista lo que falta.
   - La caja no ve el precio estándar.
7. **Modelo:** Sonnet 5.5, medio-alto.
8. **Reporte:** compacto. Si el Drawer exige algo del provider, que lo diga.

## T5b — Tarjeta de la cuadrícula

1. **Objetivo:** existe `ProductoTarjeta`, igual a la tarjeta del mockup.
2. **Contexto:** mockup, función `tarjeta()` y CSS de `.inv-card`
   (container query `tarjeta`). D6.
3. **Archivos:**
   - Crear `src/components/inventario/producto-tarjeta.tsx`,
     `producto-tarjeta.test.tsx` e `inventario-cuadricula.css`. El CSS es
     propio: no se toca `inventario.css`.
   - Crear `src/components/inventario/cashea-logo.tsx` con el SVG del logo
     amarillo, y `iconos.tsx` con el ícono carrito + si `lucide-react` no lo
     trae. T5a también los usa.
4. **Fuera de alcance:** `inventario-view.tsx`, `producto-fila.tsx` e
   `inventario.css`.
5. **Especificación:**
   - Props: `ProductoTarjeta({ product, bcvRate, soloLectura, puedeEditarFotos,
     onAbrirFicha })`.
   - Foto en recuadro 16:10, con la píldora de estado arriba a la derecha:
     En stock / Bajo stock / Agotado / Oculto a la IA.
   - Si tiene varias fotos, el contador abajo a la izquierda.
   - Sin foto: «Agregar foto» si `puedeEditarFotos`, «Sin foto» si no.
   - Cifras: Stock | Precio promoción | Precio estándar. Para la caja, Precio
     divisa en vez de estándar.
   - Pie: peso o «Sin peso», y la divisa.
   - Dos botones de ícono con `aria-label` y `title`:
     - carrito +: deshabilitado si inactivo; si ya está en el carrito,
       `aria-label` «Sumar otra unidad de X (hay N en el carrito)»;
     - Cashea: abre `CasheaCalculadora`.
   - Grilla `repeat(auto-fill, minmax(280px, 1fr))`. Con la tarjeta de 230 px
     o menos, las cifras se apilan.
6. **Tests:**
   - Cada estado de la píldora.
   - «Agregar foto» solo con permiso.
   - La caja ve divisa y no estándar.
   - El botón del carrito llama a `carrito.agregar`.
   - `aria-label` de los dos botones.
   - Tocar la foto llama a `onAbrirFicha`.
7. **Modelo:** Sonnet 5.5, medio-alto.
8. **Reporte:** compacto.

## T6 — Enviar la foto desde el chat

1. **Objetivo:** en el buscador de inventario del panel del chat, cada
   resultado muestra su miniatura y un botón «Enviar foto». Ese botón manda la
   foto principal al cliente con el pie de D2.
2. **Contexto:**
   - `inventory-lookup.tsx`: props en :111-125, resultado en :455, grupo de
     botones en :525.
   - `context-panel.tsx:260` monta el buscador y tiene `conversation` y
     `messages`.
   - `sendMediaMessage` (`mutations.ts:141`) e `isComposerWindowOpen`
     (`whatsapp-window.ts:87`).
   - `formatQuote` (`ai/precio.ts:27`) y `usdFromBs`.
3. **Archivos:**
   - Modificar `src/components/context-panel/inventory-lookup.tsx` y su test.
   - Modificar `context-panel.tsx` y su test.
   - Crear `src/lib/product-photo-caption.ts` y su test.
4. **Fuera de alcance:** composer, outbox, `/api/messages/send` e
   `/inventario`.
5. **Especificación:**
   - `productPhotoCaption(product, bcvRate): string` devuelve
     `${name} — ${formatQuote(usd, bs)}` con el precio promoción. Sin tasa,
     solo el nombre. Nunca dice «envío».
   - Props nuevas de `InventoryLookup`:
     - `onEnviarFoto?(product, caption: string | null): Promise<void>`;
     - `enviarFotoDeshabilitado?: string`, el motivo para el `title`.
   - Botón «Enviar foto» (ícono cámara):
     - deshabilitado sin foto («Este repuesto no tiene foto»);
     - deshabilitado con la ventana cerrada («La ventana de 24 h está
       cerrada»).
   - Casilla «Poner nombre y precio en el pie», marcada por defecto.
   - Miniatura de 56 px con la principal, o un ícono vacío.
   - `context-panel` calcula la ventana con `isComposerWindowOpen` y llama a
     `sendMediaMessage(conversation.id, fotoPrincipal.url, "image", caption)`.
   - Tras enviar: `toast.success("Foto enviada")`. Un error muestra el toast
     y no deja estado colgado; doble clic no envía dos veces.
6. **Tests:**
   - El pie con y sin tasa; nunca contiene «envío».
   - Botón deshabilitado sin foto y con la ventana cerrada.
   - El clic llama a `sendMediaMessage` con la URL pública, `"image"` y el
     pie; sin la casilla, el pie va `null`/vacío.
   - Doble clic = un envío.
7. **Modelo:** Sonnet 5.5, medio-alto.
8. **Reporte:** compacto.

## T5a — Lista rediseñada, «Ordenar por», interruptor de vista y montaje

1. **Objetivo:** /inventario muestra la lista nueva o la cuadrícula según la
   vista elegida, con la caja «Ordenar por», la ficha y los números de página.
2. **Contexto:**
   - Mockup completo (lista, `.inv-head`, container query `invpanel`, caja
     `#orden`).
   - `producto-fila.tsx` y su estructura (:164-456); `inventario-view.tsx`.
   - `inventario-paginador.tsx` (ya trae «Ir a la página»).
   - `app/inventario/page.tsx` para leer la cookie de vista.
   - Tests CSS que cambian a propósito (sección Contexto).
3. **Archivos:**
   - Modificar `producto-fila.tsx`, `inventario-view.tsx`,
     `inventario-paginador.tsx`, `inventario.css`, `app/inventario/page.tsx` y
     sus tests: `producto-fila*.test.tsx`, `inventario-view*.test.tsx`,
     `inventario-paginador.test.tsx` e `inventario-css.test.ts`.
   - Crear `src/components/inventario/orden-menu.tsx` y su test.
4. **Fuera de alcance:** la mecánica sticky de `mostrador.css` (solo se
   comprueba que la caja abierta queda por encima de las filas); tarjeta,
   ficha y mutaciones, que ya existen.
5. **Especificación:**
   - **Fila:**
     - foto de 72 px (botón que abre la ficha);
     - nombre (también abre la ficha), código, marca e insignias (Sin peso,
       Oculto a la IA, Nuevo desde Saint) bajo el nombre;
     - SE QUITA la compatibilidad;
     - SE QUITA la columna `.inv-status` y su insignia «Sin stock» (el color
       del stock ya lo dice).
   - **Encabezado único** `.inv-head`: Repuesto, Stock, Promoción, Divisa,
     Estándar, Peso (kg); centrado salvo «Repuesto». Etiquetas centradas
     también en tableta y teléfono.
   - **Stock:** caja con borde y fondo verde, naranja o rojo según
     `stockLevel`.
   - **Pies:** alineados a la derecha; «incluye envío $X».
   - **Botones:** dos de ícono (carrito +, logo de Cashea) a la derecha.
   - **Plantilla de columnas:**
     - con 1080 px de panel o más: `minmax(0,1fr) 64px 116px 88px 140px 76px
       84px` (caja: sin el 140);
     - menos de 1080: datos en 5 columnas (caja 4) y botones a la derecha del
       nombre;
     - menos de 760: 3 columnas;
     - menos de 600: 2 columnas y botones abajo.
     - Container queries sobre `.inv-panel-lista`, con la regla del
       `min-width: 0`.
   - **«Ordenar por»:** botón disclosure con `aria-expanded` y una lista de
     ENLACES (la URL sigue mandando).
     - Sección «Mostrar»: los 6 filtros.
     - Sección «Ordenar»: nombre, stock y precio.
     - Marca de check en lo activo y un punto azul en el botón si algo no
       está en su valor por defecto.
     - Se cierra al tocar fuera y con Esc.
     - Reemplaza las dos tiras de píldoras.
   - **Interruptor Lista / Cuadrícula:**
     - escribe la cookie `INVENTORY_VIEW_COOKIE` (con `path=/inventario`,
       365 días, dentro de `try/catch`) y llama a `router.refresh()`;
     - `page.tsx` lee la cookie y pasa `vista` a la vista: sin parpadeo;
     - la cuadrícula usa `ProductoTarjeta`.
   - **Ficha:** la vista monta UNA `ProductoFicha` controlada por el id del
     repuesto abierto. `puedeEditarFotos = role in (supervisor, admin)`.
   - **Paginador:** números de página: primera, actual ± 1, última y «…»,
     como enlaces. Se mantiene el form «Ir a la página».
   - **Totales:** tarjeta «Con foto N / total» con su barra, junto a las
     demás; la nota de «Bajo stock» pasa a «De 1 a 5 unidades.».
6. **Tests:**
   - La fila ya no tiene «Sin compatibilidad declarada»; tiene el encabezado y
     los `data-level`.
   - `inventario-css.test.ts` reescrito para la plantilla nueva, con literales.
   - «Ordenar por»: abre, cierra con Esc y sus enlaces conservan `q` y la
     página 1.
   - La cookie se escribe; con la cookie `cuadricula`, `page.tsx` pasa
     `vista="cuadricula"`.
   - Se monta la ficha.
   - Paginador numerado.
   - La caja: sin estándar, sin gestión de fotos.
7. **Modelo:** Sonnet 5.5, alto (es la tarea más grande).
8. **Reporte:** compacto, con la lista de tests CSS que cambiaron y por qué.

## T7 — Documentación (Haiku)

- `docs/GLOSARIO.md`: línea de cada archivo nuevo y actualización de los
  tocados.
- `CLAUDE.md`, trampa nueva en ≤ 8 líneas:
  - bucket PÚBLICO `product-photos`: solo supervisor y admin escriben;
  - JPEG, nunca WebP;
  - borrar una foto deja el objeto (los mensajes lo referencian);
  - la caja lee las fotos por `can_read_inventory()`;
  - umbral de bajo stock en 5.
- `docs/PRODUCCION.md`: sección de la migración con verificación
  (`select public from storage.buckets where id='product-photos'`).
- `docs/entregas/2026-10-3x-fotos-de-repuestos.md`: reporte de los cinco
  puntos por commit para el Claude del VPS.

## Verificación final (orquestador)

1. Suite completa, `tsc`, lint y `rtk proxy npm run build` (BUILD_ID nuevo).
2. Tests SQL de T1 sobre la base local recién reseteada.
3. **Mutaciones manuales** (respaldo con `cp`), cada una debe poner un test en
   rojo:
   - quitar el `is_supervisor_or_admin()` de la política INSERT;
   - poner el umbral en 3;
   - mandar el pie con «envío»;
   - habilitar «Enviar foto» con la ventana cerrada.
4. **Pantalla** (Playwright/Chromium sobre el build de producción, porque
   jsdom no calcula layout): lista y cuadrícula a 390, 768, 1280 y 1700 px, sin
   scroll horizontal; caja «Ordenar por» abierta dentro de la barra sticky;
   ficha abierta; buscador del chat con «Enviar foto». Capturas al operador.
5. **Envío real en local:** canal en `pending` (envío simulado, ver trampa del
   seed). Comprobar la fila en `messages` con `media_url` pública y el pie.

## Riesgos y puntos a confirmar en el VPS

- **Que Meta alcance la URL pública** del Storage de producción. El 21/9 una
  descarga de Meta murió en Traefik antes de llegar a Envoy. Antes de anunciar
  la función, se hace un envío real de prueba a un número del equipo y se mira
  el access log de Traefik.
- **El Storage de producción tiene que servir `/storage/v1/object/public/…`**
  a través de Envoy, sin sesión. Lo verifica el VPS con `curl` tras la
  migración.
- **Ventana de 24 h:** una foto no se puede mandar con la ventana cerrada (no
  hay plantilla con imagen). El botón queda deshabilitado con el motivo a la
  vista.
- **Objetos huérfanos:** borrar o reemplazar deja el archivo en el bucket.
  Crece poco (≤ 1 MB por foto) y es a propósito.
- **6.440 repuestos sin foto al arrancar:** la carga es manual, foto por foto,
  y la tarjeta «Con foto» mide el avance.

## Skills sugeridas

- `superpowers:test-driven-development` en cada subagente: el test en rojo
  primero.
- `frontend-design` / `emil-design-eng` para T5a/T5b si el operador quiere
  pulir microinteracciones de la tarjeta y la caja «Ordenar por».
- `security-review` sobre el diff de T1 antes del push (políticas de Storage
  y bucket público).
- `code-review` (alto) sobre la rama completa antes de entregar al VPS.

## Fuera de esta entrega (siguientes)

- «Enviar foto al chat» desde la ficha de /inventario (D3).
- Que Seba mande la foto cuando cotiza.
- Sincronización con Cashea, que usaría `casheaReadiness` como filtro.
- Carga masiva de fotos (por ejemplo, por código Saint en el nombre del
  archivo).
