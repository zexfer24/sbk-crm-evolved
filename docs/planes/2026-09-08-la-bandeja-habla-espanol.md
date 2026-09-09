# Plan · La bandeja habla español y el número nuevo queda a un clic

Corrida chica (8/9/2026). Base: `origin/main` = producción = `ad7553e`.
Rama nueva `bandeja-habla-espanol` desde ahí. **Una migración** (T1, commit
`[migración]` aparte, aplicable en caliente, idempotente, con backfill).

## Contexto

La deuda registrada como "de la bandeja" traía cinco puntos. Tres ya se
cerraron el 5/9 como C1–C3 de "El reloj dice la verdad" (`cd1c1ef` píldora
"Sin dueño", `d357879` "23h 60m", `87318a7` simulador sin `conversationId`);
la memoria estaba desactualizada y ya se corrigió. Quedan dos, los dos
heredados de "El cliente que cambió de número" (6/9/2026):

1. **La lista muestra "Image", "Audio", "Sticker", "Unsupported".** El
   trigger `handle_new_message()` (versión vigente en
   `supabase/migrations/20260907010000_ventana_24h_dice_la_verdad.sql`,
   líneas 83-86) escribe `initcap(replace(message_type, '_', ' '))` en
   `last_message_preview` cuando el mensaje no trae `content`, y la lista
   (`src/components/inbox/conversation-list-item.tsx:153`) pinta esa cadena
   tal cual. Un CRM en español para asesores de Barinas no puede decir
   "Unsupported" en la vista previa. El operador eligió corregirlo en la
   base: una sola fuente de verdad, y el backfill limpia las filas ya
   guardadas.

2. **El aviso de cambio de número no lleva a ningún lado.** Desde S1 (6/9)
   el webhook mueve el contacto al número nuevo cuando llega
   `user_changed_number`. Si el número nuevo YA tenía contacto (D2), no
   fusiona nada: deja un `system_event` con
   `payload = {type: "system", systemType: "user_changed_number",
   previousPhone, newPhone}` (`src/app/api/webhooks/whatsapp/route.ts:722-737`)
   y la frase "…que ya tiene conversación en el CRM". El asesor lee el
   aviso y tiene que buscar ese chat a mano. El operador eligió poner el
   botón en la burbuja del evento, no en la burbuja del envío fallido con
   131026 (`failureAction` no se toca).

## Decisiones del operador (8/9/2026, no re-litigar)

- Preview: **en la base, con migración**, no en la interfaz.
- 131026: **botón en el evento de sistema** ("Abrir el chat de +58…").
  La fusión de historiales (D2) sigue fuera.
- Los tres bugs C1–C3 no se tocan.

Supuestos que el orquestador ajusta sin volver al operador: textos exactos
de las etiquetas y del botón mientras digan lo mismo; nombre del evento de
log; nombre de la lectura nueva en `data.ts`.

## Alcance — lo que NO entra

- `failureAction(131026)` y `failure-reason.ts`: sin cambios.
- Fusión de historiales cuando el número nuevo ya tiene contacto.
- Los "detalles menores" del 5/9 (`display_name` pisado, píldora "No
  leídas" con pestaña oculta, "Desfijá", "Todos" con cerradas).
- El marcador de `unsupported` en la burbuja (S3b) ya está en español.

---

## T1 · `[migración]` La vista previa de la lista habla español

**Archivo nuevo:** `supabase/migrations/20260908020000_preview_en_espanol.sql`.

1. **Función de etiqueta**, `public.message_preview_label(message_type text)
   returns text language sql immutable strict`. NO es `security definer`
   (no hace falta revoke/grant; el guardián de `permisos_funciones.sql`
   solo recorre `prosecdef = true`). Tabla:

   | `message_type` | etiqueta |
   |---|---|
   | `image` | `📷 Foto` |
   | `video` | `🎥 Video` |
   | `audio` | `🎤 Audio` |
   | `document` | `📄 Documento` |
   | `sticker` | `Sticker` |
   | `template` | `Plantilla` (solo si llegara sin `content`) |
   | `unsupported` | `Mensaje que WhatsApp no entrega` |
   | cualquier otro | `initcap(replace(message_type, '_', ' '))` (lo de hoy) |

   Vocabulario alineado con `history-line.ts` ("foto", "documento") y con
   el marcador de la burbuja S3b ("WhatsApp no entrega este mensaje…").
   `interactive`/`order`/`text` siempre traen `content`; `system_event`
   nunca es `visible`.

2. **`create or replace function public.handle_new_message()`**: copia
   EXACTA de la versión de 20260907010000 (líneas 91-172) cambiando SOLO la
   expresión de `last_message_preview` a
   `left(coalesce(new.content, public.message_preview_label(new.message_type)), 280)`.
   Candados A/B, `has_reply`, `unread_count`, `last_reply_*`: intactos.
   Sin `security definer` nueva → sin revokes (mismo criterio que
   20260907010000; el `create or replace` conserva el ACL).

3. **Backfill exacto e idempotente**: recalcula `last_message_preview` de
   las conversaciones cuyo preview actual es IGUAL a
   `initcap(replace(m.message_type, '_', ' '))` del último mensaje visible
   `m` (mismo `distinct on (conversation_id)` que el paso 5 de
   20260905010000, líneas 213-231, con el mismo predicado de visibilidad).
   Un cliente que escribió literalmente "Image" como texto queda intacto
   (su `message_type` es `text`, `initcap` da "Text"). `raise notice` con
   el conteo. Aplicado dos veces no cambia nada.

**Test nuevo:** `supabase/tests/preview_en_espanol.sql` (arnés de
`ventana_24h.sql`: transacción con rollback, `_errores` temporal, varios
bloques `do $$`, `created_at` explícitos crecientes). Casos:

1. Entrante `image` sin `content` → preview `📷 Foto`.
2. Entrante `image` con pie "mira esta" → preview `mira esta` (el pie manda).
3. Entrante `unsupported` → `Mensaje que WhatsApp no entrega`, y
   `last_customer_message_at`/`unread_count` NO se mueven (candado A sigue).
4. Saliente `document` del asesor sin `content` → `📄 Documento`.
5. `system_event` → preview no cambia (no visible, igual que hoy).
6. Backfill vía `\i`: sembrar con el trigger `on_message_inserted`
   desactivado (a) una conversación con preview "Image" y último visible
   `image` → pasa a `📷 Foto`; (b) una con preview "Image" cuyo último
   visible es `text` con content "Image" → queda "Image"; (c) una con
   preview "Unsupported" → etiqueta nueva. Reaplicar `\i` una segunda vez:
   mismo resultado.

**Cableado:** paso nuevo en `.github/workflows/ci.yml`, job `migraciones`,
después de `traspaso_sin_contenido_legible.sql` (líneas 173-186), con el
comentario narrativo de siempre.

**Mutación de verificación:** cambiar `📷 Foto` por `Foto` en la función →
caso 1 y 6a en rojo; quitar el `and c.last_message_preview = initcap(...)`
del backfill → caso 6b en rojo.

**Validación local:** Docker Desktop arriba + base local reconstruida
(receta en memoria `cli-de-supabase-rota-usar-docker-exec`); correr
`preview_en_espanol.sql`, `ventana_24h.sql`, `awaiting_reply.sql`,
`permisos_funciones.sql` con `psql -v ON_ERROR_STOP=1`.

---

## T2 · El aviso de cambio de número abre el otro chat

Sin migración. El dato ya viaja en `messages.payload`.

**`src/lib/types.ts`** — `MessagePayload` (líneas 316-326) gana, documentados
como "solo cuando `messageType === 'system_event'` y
`systemType === 'user_changed_number'`": `systemType?: string`,
`previousPhone?: string`, `newPhone?: string`.

**`src/lib/data.ts`** — lectura nueva junto a `fetchConversationRow`
(línea 1181): `fetchConversationIdByPhone(supabase, phone): Promise<string | null>`.
Dos consultas: `contacts` por `phone_number` (`maybeSingle`), luego
`conversations` por `contact_id`, `order("last_message_at", {ascending:
false, nullsFirst: false})`, `limit(1)` — el UNIQUE es
`(contact_id, whatsapp_channel_id)`, puede haber más de una. Test nuevo
`src/lib/data-conversation-by-phone.test.ts` con el fake de cliente al
estilo de `data-unassigned-conversations.test.ts`: encuentra la más
reciente; sin contacto → `null`; contacto sin conversación → `null`.

**`src/components/chat/message-bubble.tsx`** — rama `system_event` (líneas
251-259). Props nuevas, opcionales como `onOpenTemplatePicker`:
`contactPhone?: string` y
`onOpenConversationByPhone?: (phone: string) => Promise<boolean>`. Pinta
el botón "Abrir el chat de {newPhone}" debajo de la nota SOLO si
`payload.systemType === "user_changed_number"`, hay `payload.newPhone`,
`newPhone !== contactPhone` (si son iguales el contacto SÍ se movió: no
hay otro chat) y llegó el callback. Si el callback devuelve `false`, la
burbuja muestra en línea "No hay conversación con ese número" (el shell no
tiene toasts; no inventar uno). Ojo con el hook: la rama `system_event`
retorna antes de los hooks de menú (línea 246-249) — el estado del aviso
en línea va ANTES de ese `return`, junto a `menuAt`.

Tests en `message-bubble.test.tsx`, `describe("MessageBubble — el aviso de
cambio de número")`: (1) conflicto → botón con el número, clic llama al
callback con `newPhone`; (2) contacto ya movido (`contactPhone ===
newPhone`) → sin botón; (3) sin callback → sin botón; (4) otro
`system_event` (`systemType: "customer_identity_changed"`) → sin botón;
(5) callback devuelve `false` → aparece la nota en línea.

**`src/components/chat/chat-panel.tsx`** — prop nueva
`onOpenConversationByPhone?`; en el `<MessageBubble>` (línea 322) pasa
`contactPhone={conversation.contact.phoneNumber}` y el callback. Un caso
en `chat-panel.test.tsx`: el evento de conflicto en el hilo muestra el
botón y el clic llega al callback del panel.

**`src/components/crm-shell.tsx`** — `handleOpenConversationByPhone`
(`useCallback`, junto a `handleReopenConversation`, línea 608):
`fetchConversationIdByPhone` → si hay id, `openConversation(id)` (línea
459; el detalle se carga por id aunque la fila no esté en la ventana de
la lista — `selectedConversation` cae a `detail`, líneas 477-500) y
devuelve `true`; si no, `false`; un error de red se registra y devuelve
`false`. Pasa el callback al `<ChatPanel>`. Un caso en
`crm-shell.test.tsx` (tiene arnés propio, ver líneas 327-634): clic en
el botón del evento → la conversación seleccionada pasa a ser la del
número nuevo.

**Mutación de verificación:** invertir `newPhone !== contactPhone` → casos
1 y 2 en rojo; en `data.ts`, quitar el `order` → el test "encuentra la
más reciente" en rojo.

---

## T3 · Documentación (orquestador, sin subagente)

- `docs/GLOSARIO.md`: fila nueva en la tabla de migraciones (línea 185+)
  para 20260908020000; actualizar `message-bubble`/`chat-panel`
  (línea 152) y la línea del webhook (línea 50: la deuda "vista previa
  queda en Unsupported" pasa a historia); `data.ts` con la lectura nueva;
  `types.ts`.
- `CLAUDE.md`: en Trampas, una línea: el preview de la lista lo escribe
  `message_preview_label()` desde 20260908020000; no traducir en la UI.
- Copiar este plan a `docs/planes/2026-09-08-la-bandeja-habla-espanol.md`.
- Memoria: cerrar la deuda en
  `corrida-el-cliente-que-cambio-de-numero-6-9-2026.md`; nota de la
  corrida nueva; producción no cambia hasta el deploy.

---

## Orden, subagentes y commits

- T1 ‖ T2 en paralelo (archivos disjuntos; T2 no depende del preview),
  cada uno con su subagente (Sonnet). Ninguno toca GLOSARIO/CLAUDE.md.
- Commits, uno por tarea, los hace el orquestador:
  1. `[migración] La vista previa de la bandeja habla español`
  2. `El aviso de cambio de número abre el chat del número nuevo`
  3. `La documentación cuenta cómo la bandeja habla español y a dónde lleva el aviso de cambio de número`
- Cada subagente reporta: qué hizo, archivos, tests en verde, desvíos.
  El orquestador valida y corre las mutaciones antes de commitear
  (respaldando con `cp`, nunca `git checkout --`).

## Verificación de cierre

- `rtk npm run test`, `rtk npm run lint`, `rtk npx tsc --noEmit`,
  `rtk proxy npm run build` (timestamp de `.next/BUILD_ID`).
- Tests SQL contra la base local reconstruida (T1).
- A mano contra `npm run dev` + webhook local (receta en memoria
  `entorno-local-para-ver-la-app-en-brave`): mandar una foto sin pie por
  el simulador → la lista dice "📷 Foto"; un `system` de
  `user_changed_number` hacia un número que ya tiene contacto → el evento
  muestra el botón y salta al otro chat.

## Entrega

Reporte por commit para el Claude del VPS (rango `ad7553e..HEAD`):
respaldo → aplicar 20260908020000 a mano en caliente (idempotente; el
`raise notice` dice cuántas vistas previas corrigió) → registrar en
`schema_migrations` (62) → push a `main` (webhook de Dokploy) → verificar
en la bandeja que ninguna fila diga "Image"/"Unsupported". Sin variables
de entorno nuevas.
