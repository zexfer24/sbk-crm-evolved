# Plan · Seis frentes del buzón (8/9/2026)

Corrida grande bajo `liminalwork`. Base: `origin/main` = producción = `ad7553e`
(memoria "Producción en ad7553e desde el 7/9/2026 20:42 UTC"). Orquestador:
Fable. Implementan subagentes `general-purpose` con `model: "sonnet"`, uno por
tarea, **cada uno en su propio worktree** (ver "Mecánica de ejecución"),
contexto limpio, reporte obligatorio. Copia final del plan en
`docs/planes/2026-09-08-seis-frentes-del-buzon.md` (T7).

## Contexto

El operador pidió seis mejoras prioritarias del CRM, todas visibles para los
asesores de Barinas o para el cliente que habla con la IA:

1. **Buzón del día**: la bandeja se ve colapsada por conversaciones viejas;
   por defecto debe mostrar solo las que hablaron hoy (00:00–24:00
   `America/Caracas`), sin borrar nada.
2. **Doble confirmación antes de pasar a ventas**: hoy la IA escala al primer
   "sí"; debe reconfirmar y solo escalar con el segundo "sí" del cliente.
3. **Emojis y stickers**: selector de emojis en el compositor, envío de
   stickers, biblioteca del equipo con "Guardar sticker" (clic derecho sobre
   el sticker del cliente) y creación de stickers propios.
4. **Peso del producto**: Cashea exige peso por producto para calcular el
   envío gratis; el inventario debe permitir cargarlo y guardarlo.
5. **Factura (bases)**: modelo, numeración, snapshot y hoja imprimible; los
   datos fiscales quedan como marcadores porque el operador aún no los tiene.
6. **Agregar contacto desde la bandeja**: hoy un contacto solo nace cuando
   escribe por WhatsApp.

## Decisiones del operador (8/9/2026, no re-litigar)

- T1: "habló hoy" = **cualquier mensaje de hoy** (`last_message_at`), de
  cliente, asesor o IA. Interruptor "Ver todo" para salir del corte; la
  búsqueda siempre mira todo el historial.
- T2: la segunda confirmación aplica **solo al pase a ventas**
  (`motivo = "intencion_compra"`). Devolución, queja, escenarios con
  `afterSend = "escalate"` y la guarda de identidad siguen escalando de
  inmediato.
- T4: peso en **kilogramos con 3 decimales** (`weight_kg numeric(8,3)`).
- T3: selector de emojis con la librería **`emoji-picker-react`** (MIT, sin
  dependencias propias; peer `react >= 16.8`), cargada bajo demanda con
  `next/dynamic` para no engordar la bandeja.

Supuestos que el orquestador ajusta sin volver al operador: textos exactos de
etiquetas, botones y notas mientras digan lo mismo; nombres de eventos de
log; nombres de funciones nuevas de lectura/escritura.

## Hallazgos de la lectura que condicionan el diseño

1. **El árbol de trabajo principal está ocupado por otra sesión**: rama
   `bandeja-habla-espanol` con `data.ts` y `types.ts` modificados sin
   commitear y una migración `20260908020000_preview_en_espanol.sql` sin
   agregar (memoria "La bandeja habla español, EN CURSO"). **Nadie de esta
   corrida toca `C:\Users\WinterOS\Documents\SBK CRM`**: todo va en
   worktrees hermanos. Esa corrida NO se solapa con las seis tareas (preview
   en español + botón al chat del número nuevo).
2. **Cuatro tareas tocan `mutations.ts` y `types.ts`** (T3, T4, T5, T6) y
   todas tocan `docs/GLOSARIO.md` y `database.types.ts` (a mano, sin
   `supabase gen types`). Los cambios son anexos (funciones/interfaces
   nuevas al final de su sección), así que los conflictos de fusión son
   triviales; los resuelve el orquestador en T7, no los subagentes.
3. **`sticker` ya existe como `message_type`** (migración 20260819050000), el
   webhook ya descarga el WebP al bucket privado (`route.ts:1381-1394`) y la
   burbuja ya lo pinta (`message-bubble.tsx:142`, vía `MediaThumb`). Lo que
   falta es el camino de SALIDA (`send/route.ts:234` acota `mediaType` a 4
   tipos; `sendWhatsappMedia` idem) y la biblioteca.
4. **Meta acepta stickers salientes por `link`** (`type: "sticker"`,
   `sticker: {link}`, sin `caption`): WebP estático de 512×512 px y ≤ 100 KB;
   animado ≤ 500 KB (el artefacto "Anatomía de WhatsApp" §13 y §5 lo
   registra: "sticker WebP subido" es lo único enviable). Un sticker guardado
   del cliente ya cumple; uno creado se normaliza en el navegador con canvas
   (Chromium exporta `image/webp`), sin `sharp` ni dependencia de servidor.
5. **Las políticas del bucket permiten copiar desde el navegador**: `select`
   para `authenticated` + `is_agent()` (20260822020000) e `insert` para
   `authenticated` (20260819010000). `storage.copy()` necesita justo esas
   dos. Si en local no funcionara, el respaldo es descargar por `/api/media`
   y volver a subir.
6. **La escalación tiene cuatro puertas**, y solo una es la del pase a ventas:
   `buildEscalateTool` (`tools.ts:295`, el modelo la invoca), la red de
   seguridad devolución/queja (`agent.ts:1331`), la guarda de identidad
   (`agent.ts:879`) y los escenarios con `afterSend` (`agent.ts:936`). La
   doble confirmación vive SOLO en la primera y SOLO para
   `intencion_compra`; las otras tres no cambian.
7. **La venta ya está enlazada a su orden**: `conversations.order_id`
   (20260820060000) apunta a `orders` + `order_items`, que
   `closeSaleWithContactInfo` (`mutations.ts:251`) crea al cerrar. La factura
   se arma desde ahí, con snapshot propio (una factura no debe cambiar si
   después editan el producto o el contacto).
8. **`currentDayRange(timeZone, now)` ya existe** (`time-zone.ts:37`) y
   `useClock` (`use-clock.ts`) late por minuto: el corte "hoy" se calcula con
   los dos y rueda solo a medianoche sin código de fechas nuevo.
9. **Una conversación recién creada no tiene `last_message_at`**: el corte de
   T1 debe dejar pasar `last_message_at is null and created_at >= hoy`, si
   no el contacto nuevo de T6 no se vería en la bandeja del día.
10. **Realtime ya cubre el INSERT de conversaciones**: en
    `use-live-conversations.ts:193` todo evento que no sea UPDATE cae a
    `requestListRefresh()`. T6 no necesita canal nuevo.
11. **`queue.test.ts`/`redis-queue.test.ts` se saltan sin Redis** (trampa
    conocida) — ninguna tarea toca la cola, así que no hace falta levantarlo.
12. **Docker Desktop puede estar apagado** (memoria 8/9): la validación SQL de
    las cuatro migraciones se apoya en el job `migraciones` de CI tras el
    push, salvo que el operador arranque Docker. Todas se escriben
    idempotentes (`add column if not exists`, `create table if not exists`,
    `drop policy if exists`).

## Alcance — lo que NO entra (deuda declarada)

- La IA no lee ni menciona el peso (la herramienta de catálogo no cambia).
- Datos fiscales de la factura (RIF, dirección, serie, IVA): marcadores
  "Por definir" en `INVOICE_ISSUER`; sin PDF generado en servidor (se imprime
  desde el navegador).
- Integración con la API de Cashea.
- Stickers animados salientes: se envían igual; si Meta los rechaza, el
  camino de `failed` + `failure-reason.ts` ya lo muestra.
- Bibliotecas de stickers por asesor (la biblioteca es del equipo).
- Reacciones con emoji hacia Meta (hoy solo se muestran las entrantes).
- Fusión de contactos duplicados; edición del número desde el modal nuevo.
- Los "detalles menores" del 5/9 y lo que lleva la corrida concurrente.

---

## Mecánica de ejecución (orquestador)

**Worktrees hermanos, uno por tarea**, para que seis subagentes editen en
paralelo sin pisarse ni pisar a la sesión concurrente:

```
C:\Users\WinterOS\Documents\SBK-CRM-wt\<tarea>\
git -C "C:\Users\WinterOS\Documents\SBK CRM" worktree add "..\SBK-CRM-wt\<tarea>" -b <rama> origin/main
cmd /c mklink /J "..\SBK-CRM-wt\<tarea>\node_modules" "C:\Users\WinterOS\Documents\SBK CRM\node_modules"
copy ".env.local" "..\SBK-CRM-wt\<tarea>\.env.local"
```

El orquestador crea los siete worktrees ANTES de despachar y verifica en uno
que `rtk npx vitest run src/lib/inbox-filters.test.ts` corre sobre la
junction. Rama de integración `seis-frentes-del-buzon` desde `origin/main`;
cada tarea se fusiona ahí con `git merge --no-ff` en el orden de abajo; PR a
`main` al final (misma vía que "La IA ve lo que llega", PR #1).

| Tarea | Rama | Migración (timestamp fijo) | Ola |
|---|---|---|---|
| T1 Buzón del día | `buzon-del-dia` | — | 1 |
| T2 Confirmación antes de ventas | `confirmacion-antes-de-ventas` | `20260909010000_handoff_confirmation.sql` | 1 |
| T3a Stickers: base y envío | `stickers-base` | `20260909020000_stickers.sql` | 1 |
| T4 Peso para Cashea | `peso-para-cashea` | `20260909030000_products_weight.sql` | 1 |
| T5 Factura: bases | `factura-bases` | `20260909040000_invoices.sql` | 1 |
| T6 Agregar contacto | `agregar-contacto` | — | 1 |
| T3b Stickers y emojis en el compositor | `stickers-compositor` (desde la integración con T3a ya fusionada) | — | 2 |
| T7 Integración y documentación | `seis-frentes-del-buzon` | — | orquestador |

Orden de fusión en T7: T4 → T5 → T6 → T2 → T1 → T3a → T3b (de menos a más
conflictos en `mutations.ts`/`types.ts`/`inbox-sidebar.tsx`).

**Contrato de cada subagente** (va en el prompt, verbatim): trabaja SOLO en su
worktree; lee `CLAUDE.md` y `docs/GLOSARIO.md` antes de tocar nada; todo en
español; commits narrativos (efecto observable, sin `feat:`); la migración va
en su propio commit con `[migración]` en el título y ANTES del código que la
usa; test al lado del módulo en el mismo commit; `errorText` es el único
traductor de errores; jamás `git checkout -- <archivo>`; no hace push; no
toca `mutations.ts`/`types.ts` más allá de anexar lo suyo; actualiza su línea
del glosario y `database.types.ts` si agregó columnas/tablas; corre `rtk npx
tsc --noEmit`, `rtk npm run lint` y los tests de los archivos que tocó (no
la suite completa: la corre el orquestador en T7); reporta con los cinco
puntos (qué implementó y decisiones, archivos, tests en verde/fallos,
problemas y desvíos, deuda). Modelo `sonnet`, razonamiento alto.

---

## T1 · La bandeja abre en el día de hoy

**Archivos:** `src/lib/types.ts` (`InboxDayScope`, `InboxCriteria.dayStart`),
`src/lib/inbox-filters.ts` (+test), `src/lib/data.ts` (+
`data-conversations.test.ts`, `data-inbox-counts.test.ts`,
`data-unassigned-conversations.test.ts`), `src/lib/use-inbox-day.ts` (nuevo,
+test), `src/components/inbox/inbox-sidebar.tsx` (+test),
`src/components/crm-shell.tsx`, `src/app/inbox/page.tsx`, `crm.css`.

**Diseño:**
- `InboxDayScope = "today" | "all"`; default `"today"`; se persiste por
  visor en `localStorage` (`sbk.inbox.scope`, con `try/catch` — memoria
  "localStorage undefined en jsdom").
- `useInboxDay(scope)` (hook nuevo): con `useClock()` y
  `currentDayRange(CRM_TIME_ZONE, new Date(clock)).from` devuelve el ISO de
  la medianoche de Caracas, o `null` si `scope === "all"`. Cambia solo a
  medianoche (el `useMemo` depende del día, no del minuto). ÚNICA fuente del
  corte: el mismo valor viaja a las consultas, a los contadores y al filtro
  en memoria.
- `FetchConversationsOptions.since?: string` en `data.ts`: se suma al
  acumulador `orGroups` de `fetchConversationRows` como
  `["last_message_at.gte.<since>", "and(last_message_at.is.null,created_at.gte.<since>)"]`
  (hallazgo 9). `fetchInboxCounts(supabase, viewerId, now, { since })`
  aplica el mismo `.or()` a las cinco cuentas y
  `fetchUnassignedConversationIds`/`fetchUnassignedConversations` lo
  reciben también (la píldora "Sin dueño" cuenta ids, no filas).
- `inbox-filters.ts`: `matchesDay(conversation, dayStart)` con la misma
  fórmula (`lastMessageAt >= dayStart`, o sin `lastMessageAt` y
  `createdAt >= dayStart`; si `ConversationSummary` no trae `createdAt`, se
  agrega al select y al mapeo). Se vuelve a comprobar en memoria por la
  misma razón que `unread`/`pending`: la lista mezcla filas vivas. Con
  búsqueda activa (`search` no vacío) el corte NO aplica.
- `inbox-sidebar.tsx`: interruptor junto al botón de orden (icono
  `CalendarDays`/`History`, `aria-label` "Ver solo hoy"/"Ver todo el
  historial"); `pillQueryOptions` y el `fetchPage` de "Sin dueño" reciben
  `since`; al cambiar el scope o al rodar el día se reinicia el paginador
  (`INBOX_PAGE_SIZE`, misma vía que al cambiar de píldora).
- `crm-shell.tsx`: el scope vive donde vive `counts` (el shell) y baja al
  sidebar; `fetchInboxHead` y el paginador de "Todos" pasan `since`.
- `inbox/page.tsx`: siembra la primera página y los contadores YA con el
  corte de hoy (calculado en servidor con `currentDayRange`); si el visor
  tenía "Ver todo" guardado, el sidebar refetchea al montar.
- Abrir `?conversation=<id>` de un chat de ayer sigue funcionando: el hilo se
  carga por id (`crm-shell.tsx:329`), no desde la lista. El subagente lo
  verifica con un test si hace falta ajustar.
- Fijados y píldora por defecto (`pending`) no cambian.

**Tests:** `matchesDay` (hoy, ayer, exactamente 00:00 Caracas, sin
`lastMessageAt` con `createdAt` hoy/ayer, scope `all`); `applyInboxFilters`
ignora el día cuando hay búsqueda; `since` en la consulta y en los seis
contadores (`toHaveBeenCalledWith`); `useInboxDay` rueda a medianoche con
`vi.useFakeTimers` y devuelve `null` en `all`; sidebar: abre en "hoy",
el interruptor persiste, el paginador se reinicia.

**Terminado cuando:** con datos de ayer y de hoy la bandeja muestra solo hoy
en las seis píldoras, los números de las píldoras coinciden con la lista,
"Ver todo" trae lo viejo, y la búsqueda encuentra un cliente de la semana
pasada sin tocar el interruptor.

---

## T2 · La IA reconfirma antes de pasar el caso a ventas

**Archivos:** `supabase/migrations/20260909010000_handoff_confirmation.sql`
(commit `[migración]` aparte), `src/lib/supabase/database.types.ts`,
`src/lib/ai/handoff-confirmation.ts` (nuevo, PURO, +test),
`src/lib/ai/tools.ts` (+test), `src/lib/ai/escalate.ts` (+test),
`src/lib/ai/prompt.ts` (+test), `src/lib/ai/agent.ts` (+test).

**Migración:** `alter table conversations add column if not exists
handoff_confirmation_pending_at timestamptz;` + `comment` ("La IA ofreció
pasar el caso a ventas y espera el segundo sí del cliente; null = sin oferta
pendiente"). Sin RLS ni permisos nuevos.

**Diseño:**
- `handoff-confirmation.ts`: `HANDOFF_CONFIRMATION_TTL_MS = 6 h` (mismo
  plazo que la no-repetición de escenarios) y
  `handoffConfirmationState({ pendingAt, lastCustomerMessageAt, now })` →
  `"none" | "awaiting" | "confirmed" | "expired"`. `confirmed` exige que el
  ÚLTIMO mensaje del cliente sea POSTERIOR a `pendingAt`: así el modelo no
  puede llamar dos veces a la herramienta en el mismo turno y saltarse la
  confirmación (el turno responde a un mensaje anterior a la oferta).
- `ToolContext` (tools.ts) gana `lastCustomerMessageAt` (agent.ts ya lo
  tiene en el turno) y `handoffConfirmationPendingAt` (se lee en la misma
  consulta con la que el turno carga la conversación).
- `buildEscalateTool`, solo cuando `motivo === "intencion_compra"`:
  - `none`/`expired` → escribe `handoff_confirmation_pending_at = now`,
    inserta nota interna `system_event` ("La IA ofreció pasar el caso a
    ventas y espera que el cliente lo confirme"), devuelve
    `{ escalated: false, instruction: "Todavía NO pasaste el caso. Dile en
    una sola frase que lo pasas con un asesor de ventas y pídele que te lo
    confirme con un sí. No vuelvas a usar esta herramienta en este turno." }`.
    `outcome.escalated` queda `false`.
  - `awaiting` → misma instrucción, sin volver a escribir (idempotente).
  - `confirmed` → `escalateConversation` como hoy.
- `escalateConversation` SIEMPRE pone `handoff_confirmation_pending_at =
  null` en su `update` (cualquier escalación cierra la oferta, incluidas las
  otras tres puertas del hallazgo 6).
- `prompt.ts`: bloque nuevo exportado `SALES_HANDOFF_RULES` en la sección 3 y
  referenciado en 5.1: después del primer sí (o de un pedido explícito de
  hablar con alguien de ventas) se confirma una vez más en una frase
  natural, sin sonar a trámite; solo tras el segundo sí se usa la
  herramienta; si el cliente duda o dice que después, se respeta y no se
  insiste. El test lo pasa por `revealsIdentity` (trampa de la guarda).
- `agent.ts`: un turno en que la herramienta devolvió "pendiente" termina
  como un turno normal con texto (no queda `classifying`/`tool_running`, no
  dispara red de seguridad — `intencion_compra` no la tiene).

**Tests:** máquina de estados con los cuatro bordes de TTL y de "mensaje
posterior"; herramienta: primera llamada no escala y sella + nota; segunda
llamada en el mismo turno no escala; con mensaje posterior escala y limpia;
oferta vencida vuelve a sellar; `devolucion`/`queja` no pasan por la puerta;
`escalateConversation` limpia el sello; prompt contiene el bloque y no calza
con la guarda; un turno completo con oferta pendiente entrega texto y deja
`journey_stage` sano.

**Terminado cuando:** en el simulador (`api/dev/simulate-message`) la
secuencia "¿tienen X?" → cotiza → "sí, lo quiero" → la IA reconfirma → "sí"
→ escala con asesor, y la bandeja muestra la nota interna intermedia.

---

## T3a · Stickers: biblioteca, guardado desde el chat y envío por Meta

**Archivos:** `supabase/migrations/20260909020000_stickers.sql` (commit
`[migración]` aparte), `database.types.ts`, `src/lib/types.ts` (`Sticker`),
`src/lib/stickers-data.ts` (nuevo, +test), `src/lib/mutations.ts` (+test),
`src/lib/sticker-image.ts` (nuevo, PURO, +test),
`src/lib/whatsapp/meta-client.ts` (+test),
`src/app/api/messages/send/route.ts` (+test),
`src/components/chat/message-context-menu.tsx` (+test nuevo),
`src/lib/ai/history-line.ts` (solo si un sticker SALIENTE no tiene marcador).

**Migración:** tabla `stickers (id uuid pk default gen_random_uuid(),
storage_path text not null unique, name text, animated boolean not null
default false, created_by uuid references agents on delete set null,
source_message_id uuid references messages on delete set null, created_at
timestamptz not null default now())`; RLS: `select`/`insert` con
`is_agent()`, `delete` con `created_by = auth.uid() or
is_supervisor_or_admin()`; `grant select, insert, delete to authenticated`;
sin funciones `security definer` (no aplica la regla de los dos revokes).
Los archivos viven en el bucket privado existente `whatsapp-media` bajo
`stickers/<uuid>.webp` (servidos por `/api/media`, firmados para Meta por
`signedUrlForSending`).

**Diseño:**
- `sticker-image.ts` (puro, sin DOM): `STICKER_SIDE = 512`,
  `STICKER_STATIC_MAX_BYTES = 100 * 1024`, `fitInSquare(width, height)` →
  rectángulo centrado con `contain`, `qualityLadder()` (0.92 → 0.5 en
  pasos) e `isWithinStickerLimit(bytes)`. El uso de canvas queda en T3b.
- `stickers-data.ts`: `fetchStickers(supabase)` (más recientes primero,
  `mediaUrlFor(storage_path)`).
- `mutations.ts`: `saveStickerFromMessage(supabase, message, agent)` (copia
  `storage.copy(src → stickers/<uuid>.webp)` con `storagePathFromUrl`,
  inserta la fila; respaldo por descarga+subida si `copy` no está),
  `createSticker(supabase, blob, name, agent)` (sube + inserta),
  `deleteSticker(supabase, id)` (borra fila y objeto),
  `sendStickerMessage(conversationId, mediaUrl)` (`kind: "media"`,
  `mediaType: "sticker"`, sin `content`).
- `send/route.ts`: `mediaType` admite `"sticker"`; `meta-client.ts`:
  `MediaKind` incluye `"sticker"` y el payload de sticker es `{ link }` sin
  `caption` (Meta lo rechaza con caption).
- `message-context-menu.tsx`: opción "Guardar sticker" (icono `Sticker` o
  `BookmarkPlus`) cuando `messageType === "sticker"` y hay `mediaUrl`;
  toast "Sticker guardado" / "No se pudo guardar el sticker".
- `history-line.ts`: verificar que un sticker saliente del asesor produce
  `[El asesor envió un sticker]`; si no, agregarlo (mismo patrón del 8/9).

**Tests:** `fitInSquare` (horizontal, vertical, cuadrada, más chica que
512), escalera de calidad, límite de bytes; `fetchStickers` mapea la URL
propia; `saveStickerFromMessage` copia e inserta con `source_message_id`;
`createSticker` sube WebP; `sendWhatsappMedia("sticker")` manda `{link}` sin
caption; el route acepta `sticker` y guarda `message_type = 'sticker'` con
`content` null; el menú muestra "Guardar sticker" solo en stickers.

**Terminado cuando:** con un sticker entrante en local, clic derecho →
"Guardar sticker" crea la fila y el objeto, y `sendStickerMessage` deja una
burbuja de sticker saliente (canal simulado).

---

## T3b · Emojis y stickers en el compositor (ola 2, tras T3a)

**Archivos:** `package.json` (`emoji-picker-react` fijado),
`src/components/chat/composer.tsx` (+test), `src/lib/composer-text.ts`
(nuevo, PURO, +test), `src/components/chat/emoji-sticker-popover.tsx`
(nuevo, +test), `src/components/chat/create-sticker-modal.tsx` (nuevo,
+test), `src/lib/sticker-canvas.ts` (nuevo, navegador), `crm.css`.

**Diseño:**
- Botón `Smile` a la izquierda del cuadro (junto al clip), `aria-label`
  "Emojis y stickers"; abre un popover anclado con dos pestañas.
- Pestaña **Emojis**: `emoji-picker-react` vía `next/dynamic({ ssr: false })`
  (se descarga al abrir por primera vez), categorías rotuladas en español
  (`categories`), `searchPlaceholder="Buscar emoji"`,
  `previewConfig={{ showPreview: false }}`, tema según `useTheme`.
  `onEmojiClick` inserta en el caret con `insertAtCaret(text, start, end,
  emoji)` (`composer-text.ts`) y devuelve el foco al cuadro. Recientes los
  maneja la librería (localStorage propio).
- Pestaña **Stickers**: rejilla de `fetchStickers` (se pide al abrir la
  pestaña), clic → `sendStickerMessage` (deshabilitada fuera de la ventana de
  24 h, mismo `withinWindow` del compositor, con el mismo aviso); clic
  derecho/`⋯` → "Quitar de la biblioteca" (confirmación; `deleteSticker`,
  el error de RLS se muestra como "Solo quien lo guardó o un supervisor
  puede quitarlo"); botón "Crear sticker".
- `CreateStickerModal`: elegir imagen (archivo o pegar), `sticker-canvas.ts`
  la centra en 512×512 transparente y exporta `image/webp` bajando por la
  escalera de calidad hasta ≤ 100 KB (si ni a 0.5 entra, aviso "La imagen
  es muy pesada, prueba una más simple"); vista previa; nombre opcional;
  "Guardar" → `createSticker` → la rejilla se refresca.
- Sin cambios en `crm-shell.tsx`: el sticker sale por `sendMediaMessage`
  como los adjuntos, no por la cola de textos.

**Tests:** `insertAtCaret` (inicio, medio, fin, selección reemplazada,
emoji compuesto con ZWJ); composer: el botón existe y abre el popover;
elegir un emoji (picker mockeado) inserta en el caret y mantiene el foco;
la pestaña de stickers lista, envía y se deshabilita con ventana cerrada;
el modal de crear valida y llama a `createSticker` con un blob (canvas
inyectado como dependencia para poder probarlo en jsdom).

**Terminado cuando:** en la app local se inserta un emoji en medio del texto,
se envía un sticker guardado y se crea uno desde una foto que queda ≤ 100 KB.

---

## T4 · El inventario guarda el peso que Cashea exige

**Archivos:** `supabase/migrations/20260909030000_products_weight.sql`
(commit `[migración]` aparte), `database.types.ts`, `src/lib/types.ts`
(`Product.weightKg`), `src/lib/inventory-data.ts`, `src/lib/inventory.ts`
(+test), `src/lib/mutations.ts` (+test),
`src/components/inventario/producto-fila.tsx` (+test nuevo),
`src/components/inventario/inventario-view.tsx` (+test), `inventario.css`.

**Migración:** `alter table products add column if not exists weight_kg
numeric(8,3) check (weight_kg is null or weight_kg >= 0);` + `comment`
("Peso en kilogramos para el envío; Cashea lo exige para calcular el envío
gratis. Null = sin cargar"). Sin RLS nueva (`products_all` ya cubre
`is_agent()`).

**Diseño:**
- `inventory.ts`: `parseWeightInput(raw)` (acepta coma o punto, vacío →
  `null`, rechaza negativos y más de 3 decimales, tope 9999.999),
  `InventoryFilter` gana `"sin-peso"` ("Sin peso") y `summarizeInventory`
  cuenta `withoutWeight` sobre los activos.
- `inventory-data.ts`: select/mapeo de `weight_kg`; el filtro `sin-peso` es
  `.is("weight_kg", null).eq("is_active", true)`; `fetchInventoryTotals`
  suma el conteo de activos sin peso.
- `mutations.ts`: `updateProductWeight(supabase, productId, weightKg | null)`
  (mismo patrón que `updateProductPrice`, con `updated_at`).
- `producto-fila.tsx`: tercer campo "Peso (kg)" con el mismo guardar-al-salir
  (`commitWeight`), marca de guardado, y badge "Sin peso" (`data-tone="wait"`,
  título "Cashea exige el peso para el envío gratis") cuando es null.
- `inventario-view.tsx`: tarjeta "Sin peso" en el resumen y píldora
  "Sin peso" en los filtros.

**Tests:** `parseWeightInput` (coma, punto, vacío, negativo, 4 decimales,
tope), filtro y resumen; `updateProductWeight` manda `weight_kg`; la fila
guarda al salir del campo, revierte con error y muestra el badge; la vista
muestra la tarjeta y la píldora.

**Terminado cuando:** en Inventario se escribe `0,250`, se guarda, sobrevive
al refresh y el producto sale del filtro "Sin peso".

---

## T5 · Las bases de la factura

**Archivos:** `supabase/migrations/20260909040000_invoices.sql` (commit
`[migración]` aparte), `database.types.ts`, `src/lib/types.ts` (`Invoice`,
`InvoiceStatus`), `src/lib/invoices.ts` (nuevo, PURO, +test),
`src/lib/invoices-data.ts` (nuevo, +test), `src/lib/mutations.ts` (+test),
`src/components/sales/sale-detail-modal.tsx` (+test nuevo),
`src/components/sales/invoice-sheet.tsx` (nuevo, +test),
`src/app/ventas/factura/[id]/page.tsx` (nuevo), `sales.css`.

**Migración:** `create sequence if not exists invoice_number_seq`; tabla
`invoices (id uuid pk, number bigint not null unique default
nextval('invoice_number_seq'), conversation_id uuid references conversations
on delete set null, order_id uuid references orders on delete set null,
contact_id uuid not null references contacts, customer jsonb not null, items
jsonb not null, subtotal numeric(12,2) not null, tax_rate numeric(5,4) not
null default 0, tax_amount numeric(12,2) not null, total numeric(12,2) not
null, currency text not null default 'USD' check (currency in
('USD','VES')), bcv_rate numeric(12,4), status text not null default 'draft'
check (status in ('draft','issued','void')), issued_at timestamptz,
issued_by uuid references agents on delete set null, voided_at timestamptz,
notes text, created_at/updated_at)`; índice por `conversation_id`; RLS:
`select`/`insert` con `is_agent()`, `update` con
`is_supervisor_or_admin()` (emitir y anular son acciones sensibles, en RLS y
no solo en la interfaz), sin `delete`; grants a `authenticated`; `comment`
en `customer`/`items` ("snapshot al momento de facturar: no cambia si
después editan el contacto o el producto").

**Diseño:**
- `invoices.ts` (puro): `formatInvoiceNumber(n)` → `SBK-000001`;
  `computeInvoiceTotals(items, taxRate)` con redondeo a centavos;
  `buildInvoiceDraft({ sale, orderItems, contact, bcvRate })`;
  `INVOICE_ISSUER` con `name: "SBK Motorcycles"` y `rif`, `address`,
  `phone` en `null` (comentario: "Por definir por el operador"),
  `DEFAULT_TAX_RATE = 0` (comentario: IVA pendiente de decisión).
- `invoices-data.ts`: `fetchInvoicesForSale(conversationId)`,
  `fetchInvoice(id)`, `fetchOrderItems(orderId)`.
- `mutations.ts`: `createInvoiceForSale(supabase, sale, agent, bcvRate)`
  (lee `conversations.order_id` + ítems; sin orden → error claro "Esta venta
  no tiene orden registrada"); `issueInvoice(id, agent)`;
  `voidInvoice(id)`.
- `sale-detail-modal.tsx`: sección "Factura": sin factura → "Generar
  factura"; con factura → número, estado y enlace "Ver e imprimir"
  (`/ventas/factura/<id>`); "Emitir"/"Anular" solo para supervisor/admin
  (la RLS lo respalda).
- `invoice-sheet.tsx` + página: hoja imprimible con encabezado del emisor
  (marcadores "Por definir" visibles), datos del cliente, ítems, subtotal,
  impuesto, total en USD y Bs a la tasa guardada, `@media print` y botón
  "Imprimir" (`window.print()`). La página exige sesión como las demás
  (`fetchCurrentAgent` → `redirect("/login")`).

**Tests:** totales con redondeo (0.005), número formateado, snapshot del
borrador (no depende de objetos vivos); `createInvoiceForSale` inserta el
snapshot y falla sin orden; el modal muestra el botón y luego el número; la
hoja pinta ítems y totales.

**Terminado cuando:** desde Ventas se genera la factura de una venta cerrada,
se abre la hoja y se imprime desde el navegador.

---

## T6 · Un contacto nuevo nace desde la bandeja

**Archivos:** `src/lib/whatsapp/phone.ts` (+test), `src/lib/mutations.ts`
(+test), `src/lib/data.ts` (solo si falta un lector del canal por defecto),
`src/components/inbox/new-contact-modal.tsx` (nuevo, +test),
`src/components/inbox/inbox-sidebar.tsx` (+test), `src/components/crm-shell.tsx`.

**Diseño:**
- `phone.ts`: `normalizePhoneInput(raw, defaultCountryCode = "58")`: quita
  espacios, guiones y paréntesis; `0414…` → `+58414…`; `58414…` → `+58…`;
  `0058…` → `+58…`; `+…` se respeta; devuelve `null` si no pasa
  `isDeliverablePhoneNumber`.
- `mutations.ts`: `createContactConversation(supabase, { displayName,
  phoneNumber, agent })` → `{ conversationId, existed }`: canal =
  la fila de `whatsapp_channels` que ya usa el CRM (reusar el lector
  existente de `data.ts:1693-1704`); `insert` en `contacts` (unique
  violation `23505` → seleccionar el existente); `insert` en
  `conversations` con `status: "open"`, `ai_enabled: true` (unique
  `contact_id + channel` → `23505` → seleccionar); nota interna
  `system_event` "Contacto agregado desde la bandeja por <asesor>". Sin
  mensaje del cliente `awaiting_reply` es `false`, así que la invariante de
  leads no exige traspaso.
- `new-contact-modal.tsx`: campos Nombre (obligatorio) y Teléfono
  (obligatorio, ayuda "+58 o 04xx…"); errores en línea; al guardar llama a
  la mutación y `onCreated(conversationId, existed)`; si `existed`, toast
  "Ese número ya tiene conversación: te la abrimos".
- `inbox-sidebar.tsx`: botón `UserPlus` en la cabecera (`aria-label`
  "Agregar contacto"), a la derecha del título.
- `crm-shell.tsx`: `onCreated` selecciona la conversación
  (`setSelectedId`), pide `fetchInboxHead` y deja que realtime traiga la
  fila (hallazgo 10). El hilo abre con el compositor bloqueado por ventana
  (no hay mensaje del cliente): el aviso existente ya dice que solo salen
  plantillas — comportamiento correcto de WhatsApp.
- Con T1 fusionado, la conversación aparece en "hoy" por `created_at`.

**Tests:** normalización (los cinco formatos + inválidos); la mutación crea
contacto y conversación, reutiliza los existentes ante `23505` y deja la
nota; el modal valida, llama y distingue `existed`; la cabecera abre el
modal.

**Terminado cuando:** en la app local se agrega "+58 412 1234567", aparece
en la bandeja seleccionado, el compositor ofrece plantillas, y repetir el
número abre el mismo chat.

---

## T7 · Integración y documentación (orquestador, sin subagente)

1. Fusionar en `seis-frentes-del-buzon` en el orden indicado; resolver los
   anexos en `mutations.ts`, `types.ts`, `database.types.ts`,
   `docs/GLOSARIO.md`, `inbox-sidebar.tsx`.
2. Verificación completa en el worktree de integración: `rtk npx tsc
   --noEmit`, `rtk npm run lint`, `rtk npm run test` (suite completa;
   diagnóstico de contención según la trampa conocida), `rtk proxy npm run
   build` + timestamp de `.next/BUILD_ID`.
3. Pruebas de mutación manuales (verificación reforzada) en tres puntos
   críticos, respaldando con `cp` antes: (a) invertir `>=` por `>` en
   `matchesDay` → el test del borde 00:00 debe caer; (b) quitar la
   condición "mensaje posterior a la oferta" en `handoffConfirmationState`
   → el test "segunda llamada en el mismo turno" debe caer; (c) quitar el
   `caption` condicional del sticker en `meta-client.ts` → su test debe caer.
4. `CLAUDE.md`: nuevas trampas (el corte del día vive en un solo hook;
   `intencion_compra` pasa por una oferta pendiente; stickers salientes
   solo por `link` WebP ≤ 100 KB; `weight_kg` es nullable y la IA no lo
   lee; la factura es snapshot). `docs/GLOSARIO.md` revisado línea por
   línea. Plan copiado a `docs/planes/2026-09-08-seis-frentes-del-buzon.md`.
5. Memoria: corrida registrada (commits, migraciones, deuda), y la de
   producción sin tocar hasta el despliegue.
6. Push de la rama de integración, PR a `main` con el reporte de entrega por
   commit para el Claude del VPS (cinco puntos; migraciones a aplicar =
   `ad7553e..HEAD` → las cuatro de esta corrida, más la 20260908020000 de la
   corrida concurrente si ya se fusionó antes; van en orden de timestamp).
   El push y el merge del PR se hacen solo con el visto bueno del operador.

## Verificación de cierre (orquestador, tras T7)

- Suite completa en verde, tipos y lint limpios, build real con `BUILD_ID`
  nuevo.
- Recorrido manual en local (`npm run dev` + base local; si Docker está
  apagado se anota como pendiente): los seis "Terminado cuando" de arriba.
- `git log --oneline origin/main..seis-frentes-del-buzon` muestra cada
  migración en su commit `[migración]` propio y anterior a su código.

## Entrega

Reporte al operador con: commits por tarea, las cuatro migraciones (todas
aplicables en caliente: `add column` nullable / `create table` nuevas, sin
backfill ni locks largos), la dependencia nueva (`emoji-picker-react`,
requiere `npm install` en el VPS → el Dockerfile ya instala desde
`package-lock.json`), la deuda declarada arriba, y lo que queda para el
operador: datos fiscales de la factura, decidir el IVA, y verificar en
producción que Meta acepte el primer sticker saliente.
