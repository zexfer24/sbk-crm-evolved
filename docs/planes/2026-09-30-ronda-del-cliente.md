# Plan: "La ronda del cliente" (30/9/2026)

Ocho pedidos del cliente, agrupados en seis tareas de código más una migración.
Decisiones del operador (30/9/2026):

- **D1 Usuarios.** Pestaña «Equipo» dentro de Control IA. Solo la ve y la usa
  un **admin**. Edita el nombre visible y la contraseña. No crea ni borra
  cuentas. Sin migración.
- **D2 Mensajes rápidos personales.** Nadie más que el dueño los ve, ni
  siquiera un supervisor o un admin. La base lo garantiza por RLS.
- **D3 Kanban.** Arrastrar una tarjeta cambia la etiqueta del contacto.
- **D4 Kanban.** Entran solo las conversaciones abiertas, más una columna
  «Sin etiqueta» al final.

Modelos: las tareas **T6 (usuarios)** y **T7 (Kanban)** van con **Opus 5.5**
de punta a punta, como pidió el cliente. Las demás van con Sonnet 5.5, y la
T1 con Haiku 4.5 porque es mecánica.

---

## T1 — La URL de un catálogo no se sale de la tarjeta (Haiku)

- **Causa:** `.ac-pb-card-trigger` (`agent-control.css:619`) no parte las
  palabras largas, y una URL no tiene puntos de corte. Además, `.ac-pb-card`
  (`:584`) es un ítem del grid con `min-width: auto`, así que la URL también
  ensancha la tarjeta.
- **Arreglo:**
  - `.ac-pb-card { min-width: 0; }`
  - `.ac-pb-card-trigger { overflow-wrap: anywhere; }`
  - Es compartida con las tarjetas de escenarios, y a ellas también les
    sirve.
- **Test:** `agent-control-css.test.ts` fija las dos reglas. Lee la hoja,
  porque jsdom no calcula layout.
- **Verificación visual:** Playwright sobre el build de producción, con una
  URL de Drive de más de 150 caracteres, a 1280 y a 390 px. Hay que medir que
  `scrollWidth <= clientWidth` en la tarjeta.

## T2 — El modal de mensajes rápidos sin la píldora detrás (Sonnet)

- **Diagnóstico primero:** reproducir en el navegador antes de tocar nada.
  - Candidatos, sin confirmar:
    - (a) El tooltip «Mensajes rápidos» del botón ⚡, que queda abierto por
      foco detrás del backdrop.
    - (b) Las `.lm-pills` de la bandeja, que se ven a través del backdrop
      translúcido.
  - Hay que confirmar cuál es con Playwright: capturas y
    `elementFromPoint`.
- **Arreglo:** según la causa.
  - Si es (a): cerrar el tooltip o quitarle el foco al abrir el modal.
  - Si es (b): un backdrop más opaco o con `backdrop-filter: blur` solo en
    este modal.
  - Nada de cambios globales al Modal de HeroUI.
- **Test:** según la causa.
  - Si es (a): el test del composer verifica que al abrir el modal no queda
    ningún tooltip visible.
  - Si es (b): un test CSS de la clase nueva.
- **Criterio:** captura antes y después, en claro y en oscuro.

## T3 — Inventario del chat: mayor stock primero y botón ✕ (Sonnet)

- **Orden:** en `searchProductsForLookup` (`inventory-data.ts:257-277`) el
  orden pasa a ser:
  1. `is_active desc`
  2. `stock_quantity desc nullsFirst:false`
  3. `name asc`
  4. `id asc`
  - Va en SQL, no en memoria, porque «Ver más» pagina con `range()` y
    ordenar en memoria rompería el orden entre páginas.
  - Los retirados siguen al final aunque tengan stock.
  - Hay que verificar que la página Inventario **no** use esta función. Si
    la usa, se separa el orden por parámetro.
- **Botón ✕:** va dentro de `.crm-lookup-search` y solo aparece con texto.
  - `aria-label="Borrar búsqueda"`.
  - Vacía el campo, vuelve a idle por el mismo camino que ya existe (el que
    invalida la búsqueda en vuelo) y devuelve el foco al input.
  - **No toca el carrito.**
- **Tests:**
  - En `inventory-data`: el mock registra la secuencia exacta de `.order()`.
  - En `inventory-lookup.test.tsx`:
    - la ✕ no existe con el campo vacío;
    - al pulsarla limpia el campo y los resultados, y deja el foco en el
      input;
    - no llama a ninguna función del carrito.
  - Ese archivo usa timers falsos: nada de `waitFor`, hay que usar
    `flush()` y `flushPromises()`.

## T4 — Copiar y «Enviar al chat» el carrito (Sonnet)

- **Función pura** `cartSummaryText(lines, totals)` en `conversation-cart.ts`.
  - Formato, con un bloque por producto y la cantidad solo si es mayor que 1:

    ```
    Caucho 90/90-18 Kenda
    SKU: 12345
    Precio: $25,00

    Casco LS2 FF353 (x2)
    SKU: 67890
    Precio: $40,00 c/u · $80,00

    Total: $105,00
    ```

  - SKU = `saint_code`; si es `null`, «SKU: sin código».
  - El precio sale de `priceCartLines` (el vigente, ya redondeado por
    `usdFromBs`). No se recalcula nada, y el formato de moneda es el que ya
    usa el bloque del carrito.
  - Si **algún** renglón no tiene precio (sin tasa), la función devuelve
    `null`: los botones se deshabilitan con el motivo en un tooltip.
- **Botones** en `ConversationCartBlock`:
  - «Copiar»: `navigator.clipboard.writeText` y un toast «Carrito copiado».
    Si falla, un toast de error.
  - «Enviar al chat»: mete el texto en el cuadro del composer **sin
    enviarlo**. Si ya había texto, lo agrega con un salto de línea, igual
    que un mensaje rápido. Después enfoca el cuadro.
  - Con el carrito vacío, los dos botones no aparecen.
- **Tubería al composer:** hoy no existe. Se crea con el mismo patrón por
  señal que usa `openTemplateModalSignal`.
  - `CrmShell` guarda `{ text, seq }` y lo baja por `ChatPanel` hasta
    `Composer`.
  - Un efecto en `Composer` aplica el texto cuando `seq` cambia.
  - Si el composer está deshabilitado (ventana de 24 h cerrada), el botón
    avisa con un toast en vez de insertar.
- **Tests:**
  - `conversation-cart.test.ts`: formato exacto con 1 y con 2 productos,
    cantidad mayor que 1, SKU nulo, sin precio → `null`.
  - `conversation-cart-block.test.tsx`: copiar llama al portapapeles con el
    texto exacto. Hay que espiar **después** de `userEvent.setup()`.
  - `composer.test.tsx`: la señal inserta el texto, lo agrega a lo que ya
    había y **no** envía.

## T5 — Mensajes rápidos personales (Sonnet) · migración aparte

- **T5a `[migración]` `20261001010000_mensajes_rapidos_personales.sql`**, en
  un commit solo:
  - `quick_replies.owner_id uuid null references agents(id) on delete
    cascade`, con un índice. `null` = compartido, como todos los de hoy.
  - Se reemplaza `quick_replies_all` por cuatro políticas:
    - select/delete: `is_agent() and (owner_id is null or owner_id =
      auth.uid())`.
    - insert: el mismo predicado en `with check`.
    - update: el mismo predicado en `using` y en `with check`, así nadie
      puede «regalar» ni adueñarse de un mensaje ajeno.
  - `notify pgrst`, `lock_timeout` con su guarda, y la autoverificación de
    que las cuatro políticas existen.
  - Realtime ya respeta la RLS de select, así que el cambio de un mensaje
    personal no le llega a nadie más.
- **Test SQL** `supabase/tests/quick_replies_personales.sql`, con dos
  asesores y `set local role authenticated` más los claims:
  - A no ve, no edita y no borra los personales de B, y un supervisor
    tampoco.
  - Los compartidos siguen como hoy.
  - No se puede insertar con `owner_id` de otro.
  - Borrar al asesor borra sus personales.
- **T5b código:**
  - Tipos: `database.types.ts` y `QuickReply.ownerId: string | null`.
  - `fetchQuickReplies` pide `owner_id`.
  - `createQuickReply(supabase, label, content, ownerId?)`.
    `updateQuickReply` y `deleteQuickReply` verifican las filas afectadas
    (`assertRowsAffected`), porque un bloqueo de la RLS da 0 filas sin
    error.
  - Modal: dos pestañas, «Compartidos» y «Mis mensajes». Al crear, un
    interruptor «Solo para mí», que viene encendido si la pestaña activa es
    «Mis mensajes».
  - El composer lista los míos primero, en su propia sección.
- **Tests:**
  - Mutaciones con `owner_id` y filas afectadas.
  - Modal: pestañas, crear personal y crear compartido.
  - Composer: orden de las secciones.
- Choca con T2 (mismo modal) y con T4 (composer): va **después** de las dos.

## T6 — Pestaña «Equipo»: nombre y contraseña de los asesores (Opus)

- **Ruta** `src/app/api/agents/[id]/route.ts`, `PATCH`. El body se valida
  con zod: `{ displayName?: string (1–60, trim), password?: string (8–72) }`,
  y al menos uno de los dos.
  - Mismo patrón que `conversations/[id]/close/route.ts`:
    1. `createClient()` + `fetchCurrentAgent`; si no hay sesión → 401.
    2. Si `role !== "admin"` → 403. El admin client **no se crea** antes de
       pasar esta guarda.
    3. `agents` por id; si no existe → 404.
    4. `displayName` → `agents.display_name` y
       `auth.admin.updateUserById(id, { user_metadata: { display_name } })`.
    5. `password` → `auth.admin.updateUserById(id, { password })`.
  - Si una parte falla y la otra no, la respuesta dice cuál quedó aplicada
    (`{ ok, nameUpdated, passwordUpdated, error }`). Nunca un «guardado» a
    medias en silencio.
  - **La contraseña no aparece jamás** en logs, en la respuesta ni en los
    errores.
  - Logs `asesor_editado`, con `{ targetId, byId, campos }`. El log lleva los
    nombres de los campos, no los valores.
  - Un admin puede cambiar su propia contraseña. Su sesión sigue viva.
- **UI:** pestaña «Equipo» en `agent-control-view.tsx`, montada solo si
  `currentAgent.role === "admin"`.
  - Lista de asesores con nombre, rol y estado, y un botón «Editar».
  - Modal con nombre, contraseña nueva y confirmación, con botón de
    mostrar/ocultar.
  - Si la contraseña queda vacía, no se cambia.
  - Validación por campo, en el mismo estilo que el cierre de venta.
  - El cliente llama a la ruta por `fetch`. Al guardar el nombre, refresca
    el roster.
- **Fuera de alcance, anotado como deuda:**
  - Hoy la política `agents_update_by_supervisor` deja que un supervisor
    renombre a cualquiera por la API directa. No se toca en esta ronda.
  - Los eventos viejos («X cerró la conversación») conservan el nombre
    anterior, porque son texto.
- **Tests** `route.test.ts`:
  - 401, 403 para supervisor y asesor. En los dos, el admin client no se
    llama.
  - 400: body vacío, contraseña corta, nombre vacío.
  - 404.
  - Éxito solo con nombre, solo con contraseña y con los dos.
  - Falla parcial.
  - La contraseña no aparece en ningún `log.*` ni en la respuesta, espiando
    `lib/log`.
  - Panel: la pestaña no existe para un supervisor, y la validación de
    confirmación funciona.

## T7 — Sección «Casos»: tablero Kanban por etiqueta (Opus, con cuidado visual)

- **Ruta** `/casos`, con `page.tsx` (patrón de `ventas/`), `loading.tsx`
  (`SectionSkeleton`) y `error.tsx` (patrón con `retry` que importa
  `dashboard.css`).
  - Entrada en `SECTIONS` de `app-rail.tsx`, con el ícono `SquareKanban` de
    lucide, entre Clientes y Ventas.
  - `app-rail.test.tsx` sigue exigiendo un solo hijo directo.
- **Datos** `fetchCaseBoard(supabase)` en `data.ts`:
  - Conversaciones **abiertas** con `CONVERSATION_LIST_SELECT` (trae las
    etiquetas del contacto), orden `last_message_at desc`, tope 500.
  - Si se llega al tope, la pantalla lo dice. No se hace un corte
    silencioso.
  - Además, `fetchTags` para las columnas.
  - En vivo con `useLiveConversations({ watchContactTags: true })`.
- **Módulo puro** `src/lib/case-board.ts`:
  - `buildCaseBoard(conversations, tags)` arma las columnas.
    - Una columna por etiqueta, por orden alfabético.
    - «Sin etiqueta» al final.
    - Una conversación cuyo contacto tiene dos etiquetas sale en las dos
      columnas, porque las etiquetas son del CONTACTO.
    - Cada columna lleva su conteo y sus atascados (`isStalled`, la
      definición única de siempre).
    - Dentro de la columna, más reciente arriba.
  - `planTagMove(from, to, contactTagIds)` devuelve `{ remove?: tagId, add?:
    tagId } | null`:
    - de una etiqueta a otra: quita una y pone la otra;
    - desde «Sin etiqueta»: solo pone;
    - hacia «Sin etiqueta»: solo quita;
    - si el contacto ya tiene la etiqueta de destino: solo quita la de
      origen;
    - a la misma columna: `null`.
- **Vista** `case-board-view.tsx` más `case-board.css`:
  - Arrastre nativo de HTML5, sin librerías nuevas.
  - Actualización optimista con reversión y toast si falla
    `addTagToContact`/`removeTagFromContact`.
  - El arrastre no funciona en pantallas táctiles ni con teclado, así que
    cada tarjeta tiene además un menú «Mover a…» con las mismas reglas.
  - Tarjeta:
    - avatar con iniciales y nombre;
    - el último mensaje (preview);
    - tiempo relativo;
    - asesor asignado;
    - globo de no leídos;
    - punto de atascado.
    - Clic → `/inbox?conversation=<id>` (ya existe).
  - Arriba: búsqueda por nombre o teléfono y un filtro por asesor.
  - **Diseño que destaca, dentro de la estética de la casa:**
    - columnas como paneles `.lm-panel` con una franja superior del color de
      la etiqueta (el patrón `data-color` de `.crm-tag`);
    - título en `.dash-display` y números en `.dash-num`;
    - la tarjeta se levanta al arrastrar (`--lm-shadow-lg`, una leve
      rotación);
    - la columna destino se resalta;
    - entrada escalonada con `dash-content-rise`;
    - estados vacíos con texto propio;
    - respeta `prefers-reduced-motion`;
    - claro y oscuro;
    - a 390 px las columnas se deslizan en horizontal con scroll-snap y no
      desbordan la página.
  - El subagente carga las skills `frontend-design` y `emil-design-eng`
    antes de escribir la vista.
- **Tests:**
  - `case-board.test.ts`: agrupación, doble etiqueta, «Sin etiqueta»,
    orden, conteos, y las cinco ramas de `planTagMove`.
  - `case-board-view.test.tsx`:
    - soltar llama a quitar y poner en ese orden, con los ids correctos;
    - si falla, revierte la tarjeta y avisa;
    - «Mover a…» usa las mismas reglas;
    - la búsqueda filtra.
  - Test CSS: el carril horizontal, `min-width: 0` y la regla de reduced
    motion.
  - **Verificación visual obligatoria** con Playwright sobre el build de
    producción:
    - claro y oscuro, a 1440 y a 390 px, sin desborde;
    - arrastrar de verdad una tarjeta y ver la etiqueta cambiada en la base.

---

## Orden y oleadas

| Oleada | Tareas en paralelo | Por qué así |
|---|---|---|
| 1 | T1 (Haiku) · T3 (Sonnet) · T6 (Opus) · T7 (Opus) | No comparten archivos |
| 2 | T2 (Sonnet) · T4 (Sonnet) | T2 toca el modal; T4 toca el composer, el shell y el carrito |
| 3 | T5a migración → T5b código (Sonnet) | Comparte el modal con T2 y el composer con T4 |

- Un commit por tarea. Los mensajes son narrativos y en español, y cada
  commit actualiza su línea del glosario.
- T5a va con `[migración]` en el título y en un commit aparte.
- **Primero el test, después el código:** cada brief exige el test en rojo
  antes de implementar.
- Pruebas de mutación que ya están decididas:
  - T3: quitar el orden por stock tiene que poner rojo el test de
    `inventory-data`.
  - T5: quitar `owner_id = auth.uid()` del `with check` de update tiene que
    poner rojo el test SQL.
  - T6: quitar la guarda de admin tiene que dar rojo en el caso 403.
  - T7: invertir `remove`/`add` en `planTagMove` tiene que dar rojo.
- Mutaciones con respaldo `cp`, nunca con `git checkout --`.
- Al cierre: suite completa, `tsc`, lint, `rtk proxy npm run build` con el
  timestamp de `BUILD_ID`, y los tests SQL sobre la base local.

## Entrega

- Hay una migración (T5a), así que la entrega va por una rama
  `entrega/ronda-del-cliente`. El VPS aplica la migración y después hace el
  fast-forward de `main`.
- Antes del reporte de entrega hay que preguntar en qué commit está
  producción.
- La pestaña «Equipo» usa `auth.admin` con `service_role`, que ya existe en
  producción: no hace falta ninguna variable nueva.
