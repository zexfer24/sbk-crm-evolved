# Plan · "Nada sin leer, un solo catálogo y la factura Saint" — 18/9/2026 (APROBADO el 18/9/2026)

> APROBADO el 18/9/2026 por el operador con las decisiones D1–D11 tal como
> están (enlaces siguen en Drive; sin la ruta `/c/<clave>`). La
> implementación NO arranca hasta el aviso del operador, porque "Seba
> atiende el mostrador" se está implementando en otra sesión. Diseño
> verificado contra HEAD `aac9e74` + el árbol de Seba, y contra el
> diagnóstico de solo lectura del Claude del VPS del 18/9 (producción =
> `3802fad`, base en `20260915010000`).

## Contexto

El cliente (dueño de SBK Motors) pidió tres cosas que no tienen que ver con
la IA vendedora sino con el trabajo diario de los asesores en la bandeja, el
panel de control y el cierre de venta. Se planifican juntas porque salen en
una sola corrida, pero son independientes entre sí.

**Convive con otra corrida en curso.** "Seba atiende el mostrador"
(`docs/planes/2026-09-17-seba-atiende-el-mostrador.md`, aprobado el 18/9) se
está implementando en otra sesión sobre `aac9e74` y toca `agent.ts`,
`send.ts`, `prompt.ts`, `tools.ts`, `data.ts`, `mutations.ts`, `types.ts`,
`database.types.ts` y `agent-control-view.tsx`. Este plan **arranca sobre el
HEAD que deje esa corrida** (sección 4): las migraciones de acá llevan
timestamp `20260918…`, posteriores a `20260917010000_seba_y_escalada_viva.sql`
y `20260917020000_ai_lessons.sql`.

**Producción, medida el 18/9 por el Claude del VPS:** HEAD `3802fad`
(14/9), última migración aplicada `20260915010000`, árbol y base
coinciden. Todo lo commiteado después (`73ef4ac` [migración 20260916010000],
`548cd8d`, `aac9e74`, Seba, y esta corrida) está pendiente de entrega.

## Las tres exigencias, tal como llegaron

1. **No leídos siempre visibles.** Con la bandeja en "solo hoy", un chat con
   mensajes sin leer se muestra igual aunque su último mensaje sea de ayer o
   de la semana pasada. "Si el mensaje no está leído, no importa eso".
2. **Enlaces de catálogo en un solo sitio.** En Control IA, dentro de
   "Respuestas predeterminadas", una sección para cargar los links de los
   catálogos. Esos links alimentan lo que manda la IA **y** los "Mensajes
   rápidos" de los asesores: cambiarlos ahí los cambia en los dos lados.
3. **"Número de factura Saint" en Cerrar venta**, visible en el detalle de la
   venta en el módulo de Ventas, y **todos** los campos obligatorios: Nombre,
   Número de WhatsApp, Cédula, Estado, Ciudad, Dirección, Método de pago,
   Número de factura Saint y comprobante de pago.

## Lo que el código y producción hacen hoy (exploración del 18/9 contra `aac9e74` + diagnóstico del VPS)

- **Bandeja.** El corte "habló hoy" tiene UNA fuente (`useInboxDay` →
  `dayStart`) que viaja como `since` a cuatro sitios y se re-aplica en
  memoria con `matchesDay` (`inbox-filters.ts:116`). En SQL es siempre el
  mismo grupo OR de dos términos (`last_message_at >= hoy` o `sin
  last_message_at y created_at >= hoy`, `data.ts:1006-1015` y
  `data.ts:1397-1402`), cruzado en producto cartesiano con el OR propio de
  cada píldora (`orExpression`). "No leída" = `unread_count > 0 or
  manually_unread` en los tres planos (SQL `data.ts:1005`/`1424`, memoria
  `isUnread` `inbox-filters.ts:81`, índice parcial
  `conversations_unread_pill_idx`). Consecuencia: un cliente que escribió
  anoche y nadie abrió **no aparece ni cuenta** hasta que llegue otro mensaje
  o alguien toque "Ver todo". Ese es el agujero.
- **Enlaces, en producción.** Los catálogos son archivos de **Google Drive
  de un tercero** (no hay ningún PDF en el VPS ni en el bucket). Las URLs
  están **pegadas a mano dentro del texto** (`response_text`) de 3
  escenarios ("CATALOGO CASCOS", "Catálogo general" —siete enlaces:
  Cascos, Resonadores, Maletas, Exploradoras y Bombillos, Defensas,
  Lubricantes ×2— y "Ubicación") y de 4 mensajes rápidos; `attachment_url`
  no se usa para links (el único adjunto real es la foto de una campaña).
  Cada versión nueva en Drive cambia el ID: el catálogo de cascos tuvo
  **cuatro IDs en 25 días** y hoy circulan dos a la vez (la IA manda
  `1iz77Lc…`, el mensaje rápido "Catalogo general" sigue con `1fP3yQ5…`: 8
  clientes recibieron el viejo en 48 h). Además ~470 envíos del mes son
  enlaces que los asesores pegan desde su teléfono y nunca estuvieron en el
  CRM: eso queda fuera del alcance de cualquier panel. `agent_settings` no
  tiene nada de enlaces; la biblioteca solo tiene el Maps de la tienda.
- **Enlaces, en el código.** `playbookMessageText` (`send.ts:223`) anexa
  `attachment_url` cuando `attachment_type = 'link'`; el texto sale
  verbatim; no hay sustitución de variables en escenarios ni en mensajes
  rápidos (`composer.tsx:232` pega el texto tal cual). `quick_replies` los
  edita **cualquier asesor** (RLS `is_agent()`); `ai_playbooks` y
  `agent_settings` exigen supervisor. La IA no manda links por ninguna otra
  vía. La subida de archivos al bucket (`playbooks-panel.tsx:138`) ya
  existe y funciona, pero mandar un archivo como documento de WhatsApp es
  otro camino (`sendAgentMedia`) distinto del texto.
- **Cerrar venta.** `close-sale-modal.tsx` valida solo nombre, carrito y
  método de pago (toast + botón deshabilitado); cédula, estado, ciudad,
  dirección y comprobante son opcionales; el WhatsApp es de solo lectura.
  `orders` no se alteró nunca desde `20260819040000` y no tiene columna
  de referencia externa; método y comprobante viven en `conversations.deal_*`,
  el dinero en `orders`, el cliente en `contacts`. `Sale` (`types.ts:255`)
  embebe `order:orders(total_amount, currency)`. Ojo con la colisión de
  nombres: `invoices.number` es el correlativo INTERNO (`SBK-000123`); el
  número Saint es otro número, externo, y no debe confundirse con él.

## Decisiones (aprobadas el 18/9/2026)

- **D1 — "No leída" pasa el corte del día en TODAS las píldoras y en todos
  los conteos**, no solo en "No leídas". Si una conversación sin leer
  aparece en la lista de Pendientes pero no en el número de la píldora, se
  repite el bug del 8/9 ("entra en la lista pero no en el conteo"). La
  fórmula del corte pasa a ser: `habló hoy` **o** `sin leer`. Sigue habiendo
  UNA sola fuente: cambia la fórmula, no el número de relojes.
- **D2 — La conversación abierta no desaparece al leerse.** Al abrir un chat
  viejo sin leer, `markRead` lo pone en cero y, con D1 sola, dejaría de pasar
  el corte y se esfumaría de la lista mientras el asesor lo está mirando. Se
  mantiene visible mientras sea la seleccionada (`selectedId`, que el
  sidebar ya conoce). Al cambiar de chat, sale de la lista como cualquier
  chat de ayer.
- **D3 — Los enlaces son una TABLA propia, `public.catalog_links`**
  (`key`, `label`, `url`, `sort_order`, `is_active`, `updated_by`,
  `updated_at`), no un jsonb en `agent_settings`: son siete hoy y crecen,
  cada uno tiene su propio ciclo de edición, y una tabla da RLS por fila,
  Realtime y rastro de quién cambió qué. Lectura: cualquier asesor.
  Escritura: supervisor/admin. La sección se pinta dentro de "Respuestas
  predeterminadas", arriba de los escenarios, como pidió el cliente.
- **D4 — La fuente única se consume por MARCADOR, nunca copiando la URL.**
  En un escenario o en un mensaje rápido se escribe `{{catalogo:cascos}}`
  (un enlace) o `{{catalogos}}` (la lista completa de activos, en orden,
  una línea por catálogo `• Cascos: https://…` — es lo que hoy es el
  escenario "Catálogo general" con siete URLs pegadas). La clave la elige
  el supervisor al cargar el enlace; el panel la muestra lista para copiar
  y los dos formularios tienen un botón "Insertar catálogo". La
  sustitución es determinista y ocurre en un solo punto por consumidor:
  `playbookMessageText` para la IA y la selección del mensaje rápido para
  el asesor. Un mensaje rápido editado por cualquier asesor no puede
  desviar el enlace: la URL real siempre sale de la tabla.
- **D5 — La IA sigue mandando enlaces SOLO a través de escenarios.** Sin
  tool ni sección de prompt: hoy ya es así, los escenarios salen verbatim
  (garantía de que el link llega intacto) y Seba está reescribiendo
  `prompt.ts`/`tools.ts`.
- **D6 — Un marcador que no resuelve nunca llega al cliente.** Escenario:
  fase 0 lo saca de los candidatos ANTES de llamar al modelo (como hace con
  los de saludo) y deja `escenarios_enlace_sin_resolver` en el log; el panel
  lo marca con un aviso. Mensaje rápido: se pega con el marcador tal cual y
  un toast avisa; el asesor lo ve antes de enviar.
- **D7 — Los enlaces siguen siendo URLs externas (Drive) en esta corrida.**
  El Claude del VPS propone migrar los PDF al bucket y mandarlos como
  documento de WhatsApp: elimina la rotación de IDs, pero exige un camino de
  envío de archivo para el asesor desde el composer y para la IA desde el
  escenario, y decidir quién sube qué. Es una corrida aparte (v1.3,
  "Catálogos en casa"); esta corrida deja la tabla lista para que un
  enlace pueda apuntar después a un archivo propio. Con la tabla, la
  rotación de Drive se resuelve en UN sitio en vez de cuatro, que es lo que
  el cliente pidió.
- **D8 — Carga inicial por SCRIPT revisado, no por migración.** La
  migración crea la tabla vacía (el contenido es del cliente, no del
  repo). Se entrega `scripts/sql/2026-09-18-catalogos-iniciales.sql`, que
  en UNA transacción inserta los siete catálogos con las URLs vigentes de
  producción y reemplaza las URLs por su marcador en los 3 escenarios y los
  4 mensajes rápidos, y el Claude del VPS lo corre DESPUÉS del deploy del
  código (antes, los marcadores saldrían crudos). Pregunta al cliente que
  frena el script, no el código: "Lubricantes" aparece dos veces con dos
  archivos distintos en "Catálogo general" — ¿son dos catálogos o uno
  viejo? Hasta la respuesta, el script carga los dos como `lubricantes` y
  `lubricantes-2`.
- **D9 — El número Saint se guarda en `orders.saint_invoice_number`**
  (texto, nullable en base porque las ventas ya cerradas no lo tienen;
  obligatorio en el modal y en la mutación). Sin restricción de unicidad a
  propósito: una factura Saint puede cubrir más de un chat y un rechazo por
  duplicado en el mostrador confundiría más de lo que protege. Se muestra
  en el detalle de la venta, como chip en la fila de la lista y en el
  evento de sistema "Venta cerrada por…". La factura interna (`invoices`,
  "Por definir") no cambia.
- **D10 — Validación por campo, no botón mudo.** Con nueve campos
  obligatorios, un botón deshabilitado sin decir por qué no sirve. Una
  función pura `validateSaleDraft` devuelve un mensaje por campo; el modal
  los pinta debajo de cada campo al intentar guardar, enfoca el primero y el
  botón solo se deshabilita mientras guarda. La misma función corre dentro
  de `closeSaleWithContactInfo` como segunda barrera.
- **D11 — Reglas de cada campo obligatorio.** Nombre no vacío; WhatsApp
  siempre presente (`phone_number` es `not null unique`, el campo sigue de
  solo lectura); cédula = tipo V/E + número de 5 a 10 dígitos; estado
  elegido de la lista; ciudad y dirección no vacías; método de pago
  elegido; factura Saint no vacía, ≤ 40 caracteres, se guarda recortada;
  comprobante = una imagen elegida del chat o subida.

**Opcional, fuera del default (P1 para el operador):** una ruta pública
`/c/<clave>` en el CRM que redirija (302) a la URL vigente del catálogo, de
modo que lo que se manda sea `https://crm.sbk.motorcycles/c/cascos` y los
mensajes ya enviados sigan apuntando al catálogo actual cuando Drive rote.
Una ruta + un test; no entra salvo que se pida, porque ata cada enlace a
que el CRM esté arriba.

## 1. Diseño por exigencia

### R1 — Nada sin leer se esconde (D1, D2)

**SQL, `src/lib/data.ts`.** Un solo helper nuevo, `dayCutGroup(since)`,
devuelve el grupo OR de CUATRO términos:
`last_message_at.gte.<since>`, `and(last_message_at.is.null,created_at.gte.<since>)`,
`unread_count.gt.0`, `manually_unread.is.true`. Lo usan los dos sitios que
hoy arman el grupo a mano: `fetchConversationRows` (l.1006-1015) y
`fetchInboxCounts` (l.1397-1402). Sigue siendo un grupo en `orGroups`, así
que `orExpression` lo cruza igual que antes y el `.or()` se emite una sola
vez. Para `unread`/`mineUnread` el grupo es redundante (una no leída ya lo
pasa): se deja de empujar `sinceGroup` en esos dos conteos, y se documenta.
`fetchUnassignedConversationIds` y la siembra de `app/inbox/page.tsx`
cambian solas porque pasan por las mismas funciones. Índices: el OR nuevo
cae en `conversations_unread_pill_idx` (parcial, ya ordenado por
`last_message_at desc, id desc`) más el índice de la píldora; el planner
hace BitmapOr sobre pocas filas. Sin migración.

**Memoria, `src/lib/inbox-filters.ts`.** `matchesDay` NO cambia de
significado (sigue siendo "habló hoy"; la copia privada de `dashboard.ts`
sigue igual, el Recorrido no tiene noción de "leído"). Nace
`passesDayCut(conversation, dayStart, keepId?)` = `!dayStart || isUnread(c)
|| c.id === keepId || matchesDay(c, dayStart)`, y `applyInboxFilters` la usa
en lugar de `matchesDay`. `InboxCriteria` gana `keepId?: string | null`;
`inbox-sidebar.tsx:871-896` le pasa `selectedId`.

**Realtime.** Sin cambios: un UPDATE sobre una fila que no está en memoria
ya dispara `fetchInboxHead`, que ahora trae también las no leídas viejas.

**Docs.** La trampa "El corte 'habló hoy' de la bandeja tiene UNA sola
fuente" (`CLAUDE.md`) se reescribe con la fórmula nueva; los docblocks de
`since` (`data.ts:816-837`) y `matchesDay` (`inbox-filters.ts:85-115`),
que hoy afirman lo contrario, también.

### R2 — Un solo catálogo (D3–D8)

**Migración `20260918010000_catalog_links.sql`** (`[migración]`, commit
aparte):
```sql
create table public.catalog_links (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9-]{1,30}$'),
  label text not null check (char_length(btrim(label)) between 1 and 40),
  url text not null check (url ~* '^https?://'),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null
);
```
RLS: `catalog_links_select using (is_agent())`, `catalog_links_write for
all using/with check (is_supervisor_or_admin())`. `alter publication
supabase_realtime add table public.catalog_links` con autoverificación
(`raise exception` si no quedó publicada — trampa del 8/9). Trigger de
`updated_at` si el esquema ya tiene la función genérica (el implementador
lo verifica). Sin funciones `security definer`. Test SQL
`supabase/tests/catalog_links.sql` (clave con mayúscula rechazada, URL sin
esquema rechazada, clave repetida rechazada, publicada en Realtime,
`anon` sin acceso) + paso en `ci.yml`. Comentario de tabla con la historia
(cuatro IDs de Drive en 25 días, dos en circulación el 18/9).

**Módulo puro `src/lib/catalog-links.ts`** (sin React, sin Supabase):
`CatalogLink`, `validateCatalogLinkDraft(draft, existing)` (mensajes por
campo: clave vacía/inválida/repetida, etiqueta vacía, URL sin
`http(s)://`), `slugifyKey(label)` (propone la clave: "Exploradoras y
Bombillos" → `exploradoras-y-bombillos`), `CATALOG_MARKER =
/\{\{\s*cat[aá]logo\s*:\s*([a-z0-9-]+)\s*\}\}/gi`, `CATALOG_LIST_MARKER =
/\{\{\s*cat[aá]logos\s*\}\}/gi`, `formatCatalogList(links)` (`• Label:
url`, solo activos, por `sort_order`), `resolveCatalogMarkers(text, links):
{ text, missing: string[] }` (inactivo cuenta como `missing`),
`catalogMarkerFor(key)`, `hasRawUrl(text)` (aviso "enlace escrito a mano",
mismo patrón que `hasHardcodedPrice`).

**Datos y mutaciones.** `CatalogLink` en `types.ts`; `fetchCatalogLinks`
(lista completa, para el panel; lanza) y `fetchActiveCatalogLinks` (nunca
lanza, cae a `[]`; para el shell y el turno) en `data.ts`;
`createCatalogLink`, `updateCatalogLink`, `deleteCatalogLink`,
`setCatalogLinkActive` en `mutations.ts` con `updated_by`.

**Consumo por la IA.** `playbookMessageText(playbook, links)` (`send.ts:223`)
resuelve los dos marcadores en `response_text` y en `attachment_url`; la
firma cambia y TypeScript obliga a actualizar a los dos lectores
(`sendPlaybookReply` y `alreadySentPlaybook`, `agent.ts:415`) — la
comparación anti-repetición sigue funcionando porque los dos resuelven con
la misma lista leída al arrancar el turno. El turno carga
`fetchActiveCatalogLinks` en el mismo `Promise.all` donde ya lee
`business_hours` (`agent.ts:1725`). `matchPlaybook` recibe `links` y saca
de los candidatos los escenarios con marcador sin resolver, dejando
`escenarios_enlace_sin_resolver` con sus nombres.

**Consumo por los asesores.** `crm-shell.tsx` carga `catalogLinks`
(siembra + canal Realtime nuevo sobre `catalog_links`, mismo patrón que
`quick_replies` l.991) y lo pasa `crm-shell → chat-panel → composer` como
`quickReplies`. `handleSelectQuickReply` (`composer.tsx:232`) pega
`resolveCatalogMarkers(content, catalogLinks).text` y, si `missing` no
está vacío, `toast.warning("El catálogo «x» no está configurado")`.

**Panel.** Nuevo `src/components/agent-control/catalog-links-panel.tsx`
(`{ links, canEdit, onCreate, onUpdate, onDelete, onToggle }`; filas
etiqueta/clave/URL/activo con "Copiar marcador"; validación por campo
antes de guardar; borrar pide confirmación y avisa cuántos escenarios y
mensajes rápidos usan esa clave — se calcula en memoria sobre los textos
que el panel ya tiene). Se monta al inicio de `PlaybooksPanel`
(`agent-control-view.tsx:942` le pasa `catalogLinks` y los handlers; un
solo toque en ese archivo, sobre la versión con la pestaña "Lecciones" de
Seba; el `AgentControlView` ya tiene canal Realtime por tabla, se suma
`catalog_links`). En el formulario de escenario y en
`quick-replies-modal.tsx`: botón "Insertar catálogo" (menú con "Todos los
catálogos" + una entrada por clave; pega el marcador en la posición del
cursor) y aviso `hasRawUrl` ("Este texto lleva un enlace escrito a mano; si
es un catálogo, usa el marcador para que se actualice solo"). La lista de
escenarios y la de mensajes rápidos marcan los que tienen marcador sin
resolver.

**Script de carga inicial** (`scripts/sql/2026-09-18-catalogos-iniciales.sql`,
D8): `begin; insert into catalog_links (key, label, url, sort_order)
values ('cascos', 'Cascos', 'https://drive.google.com/file/d/1iz77Lc…', 1),
('resonadores', …), ('maletas', …), ('exploradoras-y-bombillos', …),
('defensas', …), ('lubricantes', …), ('lubricantes-2', …), ('ubicacion',
'Ubicación', 'https://maps.app.goo.gl/…', 99); update ai_playbooks set
response_text = <texto con marcadores> where id in (…3 ids…); update
quick_replies set content = <texto con marcadores> where id in (…4
ids…); commit;` — con las URLs y los ids EXACTOS que devolvió el
diagnóstico del 18/9, y un `select` de verificación al final que falle si
queda alguna `drive.google.com` en esas 7 filas. El texto de "Catálogo
general" pasa a ser su frase + `{{catalogos}}`. El script se escribe con
los datos del diagnóstico y lo revisa el Claude del VPS contra la base
real antes de correrlo.

### R3 — La factura Saint y los nueve campos (D9–D11)

**Migración `20260918020000_factura_saint.sql`** (`[migración]`, commit
aparte): `alter table public.orders add column saint_invoice_number text`
+ `check (saint_invoice_number is null or (saint_invoice_number =
btrim(saint_invoice_number) and char_length(saint_invoice_number) between 1
and 40))` + `comment on column` ("número de la factura emitida en Saint, el
sistema administrativo del negocio; nullable porque las ventas anteriores
al 18/9/2026 no lo tienen; obligatorio desde el modal"). Test SQL
`supabase/tests/factura_saint.sql` (acepta `'00123'`, rechaza `''`,
rechaza con espacios, rechaza 41 caracteres) + paso en `ci.yml`.
`database.types.ts` gana la columna en `Row`/`Insert`/`Update` de `orders`.

**Módulo puro `src/lib/sale-draft.ts`**: `SaleDraft` (los nueve campos +
`itemCount`), `SALE_FIELD_LABELS`, `validateSaleDraft(draft):
Partial<Record<SaleField, string>>` con las reglas de D11,
`normalizeSaint(s)` (recorta y colapsa espacios), `isValidCedulaNumber`.

**Modal `close-sale-modal.tsx`.** Estado nuevo `saintInvoiceNumber`, campo
"Número de factura Saint" (`#sale-saint-invoice`, `<Input>`, `maxLength=40`)
entre "Método de pago" y "Cierra la venta"; asteriscos en las nueve
etiquetas; `<p role="alert" class="lm-field-error">` bajo cada campo con el
mensaje de `validateSaleDraft`; el bloque "Comprobante de pago" pasa a un
`<fieldset aria-labelledby>` para que los tests lo alcancen por nombre;
`handleSubmit` valida, pinta, enfoca el primero inválido y solo entonces
llama a `closeSaleWithContactInfo` con `saintInvoiceNumber`; el botón
"Guardar y cerrar venta" queda `isDisabled={isSaving}`.

**Mutación `closeSaleWithContactInfo`** (`mutations.ts:262`):
`ContactSaleDetails.saintInvoiceNumber: string`; segunda barrera con
`validateSaleDraft` (lanza el primer mensaje); `orders.insert` incluye
`saint_invoice_number`; el evento de sistema agrega `· Factura Saint 00123`.

**Ventas.** `Sale.saintInvoiceNumber: string | null` (`types.ts:255`);
`SALE_SELECT` → `order:orders(total_amount, currency, saint_invoice_number)`;
`RawSale.order` y `mapSale`; `sale-detail-modal.tsx` muestra la línea
"Factura Saint N.º 00123" (icono `Receipt`) después del método de pago, y
"Sin número de factura Saint" en las ventas anteriores; `sales-view.tsx`
agrega el chip `Saint 00123` en la meta de la fila cuando existe.

## 2. Tests (el plan no está completo sin esto)

| Tarea | Archivo de test | Casos nuevos / que cambian |
|---|---|---|
| M1 | `supabase/tests/catalog_links.sql` | clave con mayúscula/espacio rechazada; URL sin esquema rechazada; clave repetida rechazada; tabla en `pg_publication_tables`; `anon` no lee (`has_table_privilege` + RLS) |
| M2 | `supabase/tests/factura_saint.sql` | acepta `'00123'`; rechaza vacío, con espacios, 41 chars; las filas viejas quedan `null` |
| T1a | `data-conversations.test.ts:953` | el string exacto del `.or()` pasa a cuatro términos |
| T1a | `data-inbox-counts.test.ts:473-613` | `pending/mine/pendingStale/escalated/unassigned` con el grupo de cuatro; `unread`/`mineUnread` SIN grupo de día; el test de datos reales (l.613) agrega una fila de ayer no leída que ahora cuenta en Pendientes y una leída que no |
| T1b | `inbox-filters.test.ts` | `describe("passesDayCut")`: no leída de ayer pasa; leída de ayer no; apartada a mano pasa; `keepId` pasa aunque esté leída y sea de ayer; `dayStart null` deja pasar todo; `applyInboxFilters` en "pending" muestra la no leída de ayer |
| T1b | `inbox-sidebar.test.tsx` | "la conversación abierta sigue en la lista después de marcarse leída, aunque sea de ayer"; "una no leída de ayer aparece en Pendientes con dayScope today" |
| T2 | `catalog-links.test.ts` | validación por campo; `slugifyKey` con tildes y "y"; resolve reemplaza uno y varios marcadores, tolera `catálogo` con tilde y espacios, `{{catalogos}}` lista solo activos en orden, inactivo → `missing`; `hasRawUrl` |
| T2 | `mutations.test.ts` | `createCatalogLink`/`updateCatalogLink`/`deleteCatalogLink` escriben la fila y `updated_by`; `fetchActiveCatalogLinks` cae a `[]` ante error |
| T3 | `send.test.ts` | `playbookMessageText` resuelve marcador en texto y en `attachment_url`; `{{catalogos}}` expande la lista; sin marcador es byte a byte lo de hoy |
| T3 | `playbooks.test.ts` | un escenario con marcador sin resolver no entra al enum; con resolver sí; log `escenarios_enlace_sin_resolver` |
| T3 | `agent.test.ts` | `alreadySentPlaybook` compara el texto resuelto (no repite un escenario con marcador ya enviado) |
| T4a | `catalog-links-panel.test.tsx` | crea con la clave propuesta; fila inválida no guarda y muestra el mensaje; `canEdit=false` deshabilita; "Copiar marcador"; borrar avisa cuántos textos usan la clave |
| T4a | `playbooks-panel.test.tsx` | "Insertar catálogo" pega el marcador; aviso de enlace escrito a mano; escenario con marcador sin resolver lleva la marca |
| T4b | `quick-replies-modal.test.tsx` (nuevo) | "Insertar catálogo"; `composer.test.tsx`: al usar un mensaje rápido el marcador sale resuelto; sin resolver queda el marcador y sale el toast |
| T5 | `sale-draft.test.ts` | un caso por campo vacío/inválido; cédula 4 y 11 dígitos rechazadas; Saint con espacios se normaliza; borrador completo → `{}` |
| T5 | `close-sale-modal.test.tsx` | helper `completarDatosObligatorios(user)` + `messages` con una foto entrante para el comprobante; los 7 tests que guardan pasan a usarlo; "sin factura Saint muestra el error bajo el campo y no llama a la mutación"; "sin comprobante idem"; "manda `saintInvoiceNumber` recortado"; `:142` y `:286` se reescriben a "no llama y muestra el error" |
| T5 | `mutations.test.ts` | `orders.insert` lleva `saint_invoice_number`; sin Saint/sin comprobante lanza antes de escribir; el evento de sistema nombra la factura |
| T6 | `sale-detail-modal.test.tsx`, `sales-view.test.tsx` | fixture con `saintInvoiceNumber`; detalle la muestra; `null` muestra "Sin número de factura Saint"; chip en la fila |

**Mutaciones de verificación (Fase 3, punto 15):** quitar `isUnread(c)` de
`passesDayCut` → `inbox-filters.test.ts` rojo; devolver `playbook.responseText`
sin resolver en `playbookMessageText` → `send.test.ts` rojo; quitar la regla
de `saintInvoiceNumber` en `validateSaleDraft` → `sale-draft.test.ts` y
`close-sale-modal.test.tsx` rojos. Respaldar con `cp` antes de mutar (trampa
del 7/9).

## 3. Tareas delegables (una por subagente `implementador`, Sonnet, razonamiento alto)

### Tanda 0 — migraciones (dos commits `[migración]`, en paralelo)

- **M1 · `[migración]` Los enlaces de catálogo tienen su propia tabla.** `supabase/migrations/20260918010000_catalog_links.sql`, `supabase/tests/catalog_links.sql`, `.github/workflows/ci.yml` (paso nuevo), `database.types.ts` (tabla nueva), fila en la tabla de migraciones de `docs/GLOSARIO.md`. Verificar antes que ningún archivo `20260918010000_*` exista ya en el árbol de Seba.
- **M2 · `[migración]` Cada orden puede llevar su número de factura Saint.** `supabase/migrations/20260918020000_factura_saint.sql`, `supabase/tests/factura_saint.sql`, `ci.yml`, `database.types.ts` (`orders` Row/Insert/Update — sin él T5 no compila; coordinar con M1: mismo archivo, tablas distintas), `GLOSARIO.md`.

### Tanda 1 (en paralelo; no comparten archivos)

- **T1a · La base devuelve las conversaciones sin leer aunque no hayan hablado hoy.** `src/lib/data.ts` (`dayCutGroup`, `fetchConversationRows`, `fetchInboxCounts`, docblock de `since`), `data-conversations.test.ts`, `data-inbox-counts.test.ts`, `data-unassigned-conversations.test.ts` (solo si cambia el string). Cierra con un `EXPLAIN ANALYZE` de la consulta de Pendientes contra la base local, pegado en el reporte.
- **T1b · La bandeja no esconde lo que nadie leyó ni el chat que está abierto.** `src/lib/inbox-filters.ts` (`passesDayCut`, `InboxCriteria.keepId`, docblock de `matchesDay`), `inbox-filters.test.ts`, `src/components/inbox/inbox-sidebar.tsx` (pasar `selectedId`), `inbox-sidebar.test.tsx`.
- **T2 · Los enlaces de catálogo tienen módulo, tipo, lectura y escritura.** Nuevo `src/lib/catalog-links.ts` + test, `src/lib/types.ts` (`CatalogLink`), `src/lib/data.ts` (`fetchCatalogLinks`, `fetchActiveCatalogLinks` — región distinta de T1a; funciones nuevas al final), `src/lib/mutations.ts` (cuatro mutaciones) + `mutations.test.ts`, `scripts/sql/2026-09-18-catalogos-iniciales.sql` (con los datos del diagnóstico del 18/9), `GLOSARIO.md`.
- **T5 · Cerrar venta exige los nueve datos y guarda la factura Saint.** Nuevo `src/lib/sale-draft.ts` + test, `src/components/context-panel/close-sale-modal.tsx` + test, `src/lib/mutations.ts` (`ContactSaleDetails`, `closeSaleWithContactInfo`) + `mutations.test.ts` (funciones distintas de T2: merge trivial), la hoja de estilos del modal (`.lm-field-error`), `GLOSARIO.md`.

### Tanda 2 (después de T2; T3, T4a y T4b en paralelo)

- **T3 · La IA resuelve el marcador del catálogo y no manda un escenario con enlace roto.** `src/lib/ai/send.ts` (`playbookMessageText(playbook, links)`) + `send.test.ts`, `src/lib/ai/playbooks.ts` (`matchPlaybook` filtra + log) + `playbooks.test.ts`, `src/lib/ai/agent.ts` (carga de enlaces junto a `business_hours`, pasar `links` a `matchPlaybook`, `alreadySentPlaybook`, `runPlaybook`) + `agent.test.ts`. **Sobre el `agent.ts`/`send.ts` que deje Seba** (sus T2b/T3/T5 tocan las mismas regiones).
- **T4a · El supervisor carga los enlaces de catálogo en Respuestas predeterminadas.** Nuevo `src/components/agent-control/catalog-links-panel.tsx` + test, `playbooks-panel.tsx` (sección arriba, "Insertar catálogo", aviso `hasRawUrl`, marca de marcador sin resolver) + test, `agent-control-view.tsx` (props a `PlaybooksPanel`, handlers, canal Realtime `catalog_links`; un solo toque, sobre la versión con la pestaña "Lecciones" de Seba) + `agent-control-view.test.tsx` (espejo de mocks), `agent-control.css`, `GLOSARIO.md`.
- **T4b · Los mensajes rápidos salen con el enlace vigente.** `src/components/chat/quick-replies-modal.tsx` ("Insertar catálogo", marca sin resolver) + test nuevo, `src/components/chat/composer.tsx` (`catalogLinks`, resolver al usar) + `composer.test.tsx`, `src/components/chat/chat-panel.tsx` (prop), `src/components/crm-shell.tsx` (estado, siembra, canal Realtime `catalog_links`) + `crm-shell.test.tsx`, `src/app/inbox/page.tsx` (siembra).

### Tanda 3 (después de M2 y T5)

- **T6 · El módulo de Ventas muestra la factura Saint.** `src/lib/types.ts` (`Sale.saintInvoiceNumber` — add-only, coordinar con T2), `src/lib/data.ts` (`SALE_SELECT`, `RawSale`, `mapSale`), `src/components/sales/sale-detail-modal.tsx` + test, `sales-view.tsx` + test, `GLOSARIO.md`.

### Tanda 4

- **T7 · La documentación cuenta las tres reglas nuevas.** `CLAUDE.md` (reescribir la trampa del corte "habló hoy"; trampa nueva "los enlaces de catálogo viven en `catalog_links` y se consumen por marcador; una URL de Drive pegada en un texto es el bug del 18/9, no un dato"; trampa nueva "`orders.saint_invoice_number` es nullable en base y obligatorio en el modal; no es `invoices.number`"), `docs/GLOSARIO.md` (repaso), `docs/PRODUCCION.md` (orden: migraciones 20260916010000 → Seba → 20260918010000/020000 ANTES del código; DESPUÉS del deploy, el script de carga inicial), reporte de entrega por commit para el Claude del VPS.

## 4. Orden, colisiones y estado de producción

- **Sin colisión de fondo:** R1 (T1a/T1b) y R3 (T5/T6). Seba toca `data.ts:2413` y `mutations.ts` en funciones de lecciones: merge trivial, add-only.
- **Con colisión:** T3 (`agent.ts` l.415/1009-1030/1725, `send.ts`) y T4a (`agent-control-view.tsx`). Se implementan sobre el HEAD final de Seba; no antes.
- **Regla práctica:** esta corrida arranca cuando Seba esté commiteada (o, si el operador lo prefiere, Tanda 0 + T1a/T1b/T2/T5 en una worktree aparte ya, y T3/T4/T6 después). Cada subagente recibe el HEAD exacto sobre el que trabaja.
- **Producción (18/9):** `3802fad`, migraciones hasta `20260915010000`. La entrega acumulada será: `20260916010000` (con `psql -1 -v ON_ERROR_STOP=1`, ver PRODUCCION.md) → migraciones de Seba → `20260918010000`, `20260918020000` → deploy del código → script de carga inicial de catálogos → verificación (un escenario con `{{catalogos}}` en el simulador, un mensaje rápido con `{{catalogo:cascos}}` en el composer).
- Timestamps de migración: `20260918010000` y `20260918020000`; si Seba agregó alguno del 18/9, correr los de acá detrás.

## 5. Riesgos

- **Rendimiento del OR de cuatro términos** en `pending`/`escalated`: BitmapOr entre el índice parcial de la píldora y `conversations_unread_pill_idx`. Las no leídas son pocas; si el `EXPLAIN` de T1a muestra Seq Scan, plan B: segunda consulta "no leídas fuera de hoy" unida en memoria (patrón `searchableConversations`).
- **Asimetría "Ver todo" → "hoy" ya conocida** (`crm-shell.tsx:550-557`): las filas viejas quedan en memoria y `passesDayCut` deja de pintarlas; las no leídas viejas se siguen pintando — deseado.
- **Ventana entre deploy y script**: si el script de carga corre ANTES del código, los marcadores no existen y no pasa nada (los textos siguen con URLs); si corre y luego el deploy falla, los marcadores salen crudos → D6 lo impide para la IA (escenario descartado) pero un asesor podría pegar `{{catalogo:cascos}}` sin resolver (con toast). Orden obligatorio: código primero, script después.
- **"Lubricantes" ×2**: hasta que el cliente diga cuál vale, `{{catalogos}}` lista los dos, igual que hoy.
- **Enlaces pegados desde el teléfono** (~470/mes): fuera del alcance; se informa al cliente como práctica a cortar.
- **`alreadySentPlaybook`** deja de reconocer un envío anterior si el supervisor cambia la URL entre dos turnos: el escenario se repetiría una vez, con el link nuevo. Aceptable y documentado.
- **Ventas viejas sin Saint**: el detalle dice "Sin número de factura Saint"; ningún reporte lo exige.
- **Tests del modal**: siete casos que hoy guardan con solo nombre + método pasan a necesitar el helper y una foto entrante; es el cambio de test más grande de la corrida y va en T5.
- **Dos sesiones a la vez**: nunca `git checkout -- <archivo>` sobre el árbol; respaldo con `cp` antes de cualquier mutación de verificación.

## 6. Skills sugeridas

- `superpowers:test-driven-development` en T1b, T2, T5 (módulos puros nuevos: test primero).
- `superpowers:verification-before-completion` en cada reporte de subagente.
- `code-review high` sobre la corrida completa antes del reporte de entrega (como el 16/9).
- Verificación visual en Brave (memoria "Verificación visual antes de fusionar UI"): sección de enlaces, botón "Insertar catálogo", modal de Cerrar venta con errores por campo, detalle de venta.

## 7. Criterios de cierre

- Suite completa en verde (`rtk npm run test`), `rtk npx tsc --noEmit`, `rtk npm run lint`, `rtk proxy npm run build` con `BUILD_ID` fresco; los dos tests SQL nuevos en verde en local y como pasos del CI.
- Las tres mutaciones de verificación de la sección 2 ponen rojo el test que les corresponde.
- Escenario a mano en local: (1) un chat con mensaje de "ayer" sin leer aparece en Pendientes y en el número de la píldora con "solo hoy"; al abrirlo sigue en la lista; al cambiar de chat, desaparece. (2) Cargar `cascos` con una URL, escribir `{{catalogo:cascos}}` en un escenario y `{{catalogos}}` en otro, y `{{catalogo:cascos}}` en un mensaje rápido; el simulador de la IA manda la URL; "Usar" el mensaje rápido pega la URL; cambiar la URL en el panel cambia los tres sin tocar nada más; desactivar la clave hace que el escenario deje de ser candidato y el mensaje rápido avise. (3) Correr el script de carga inicial contra la base local sembrada con los 7 textos de producción y comprobar que no queda ninguna `drive.google.com` en esas filas. (4) Cerrar una venta sin Saint muestra el error bajo el campo; con los nueve datos guarda, el evento de sistema nombra la factura y el detalle en Ventas la muestra.
- Reporte de entrega por commit para el Claude del VPS, con el script de carga como paso posterior al deploy y la pregunta de "Lubricantes" para el cliente.

## 8. Fuera de este plan (para no perderlo)

- **Catálogos en casa (v1.3):** subir los PDF al bucket y mandarlos como documento de WhatsApp desde escenarios y composer; el diagnóstico del VPS lo recomienda y la tabla de esta corrida lo deja preparado (un enlace podrá apuntar a `storage_path` en vez de `url`).
- **Ruta pública `/c/<clave>`** con redirección a la URL vigente (P1).
- **Seguridad, urgente y aparte del plan:** el Claude del VPS avisó que la clave de OpenRouter (`OPENAI_API_KEY`) quedó impresa en crudo en su sesión de diagnóstico: hay que rotarla en OpenRouter, cargarla en el Environment de Dokploy y redesplegar (el Environment cifrado solo llega al contenedor con un redeploy). También señaló un rol `liminal_replicator` con login y permisos de conexión sobre `postgres`: confirmar si la replicación sigue en uso y, si no, retirarle el login.
