# Plan · El cliente que cambió de número

Corrida chica aprobada el 6/9/2026. Base: `main` en `8ee97d7` (= producción
desde el deploy de hoy a las 14:08 UTC). **Sin migraciones**: todo lo que
necesita ya existe en la base (`messages.payload` y `message_type` con
`'unsupported'`, T3.2, migración 20260905050000; `message_type =
'system_event'` con `sender_type = 'system'`, 261 filas en producción).

## Origen

El 5/9/2026 a las 21:54 (hora Ecuador) el lead +593987317372 mandó algo que el
webhook no supo clasificar. La versión que corría esa noche (anterior a
`ef168bd`) escribió en `content` la frase fija "El cliente envió un mensaje
que el CRM todavía no sabe mostrar", sin guardar el tipo real ni en la base ni
en el log. A la mañana siguiente Asesor 1 le escribió y Meta rechazó el envío
con **131026 Message Undeliverable**, aunque los cuatro mensajes del 31/8 a ese
número figuran como leídos y en las mismas 24 h salieron 1.553 mensajes bien
por el mismo canal. El wamid del aviso lleva un identificador numérico de 10
dígitos; todos los demás entrantes de la base llevan 32 hexadecimales.

Por descarte del código de esa noche (texto, multimedia, ubicación, contactos,
reacción y el `unsupported` de Meta no pasaban por esa rama), lo más
consistente es un mensaje `type: "system"` con `system.type:
"user_changed_number"`: Meta avisa al webhook que el cliente cambió de número
y, desde ese momento, el número viejo deja de ser una cuenta de WhatsApp. El
CRM no maneja `system` en ninguna versión: hoy (F10) cae en el `else` final
como `unsupported` con `payload.type = "system"`, sin leer el número nuevo, y
el asesor lo descubre igual que ayer: reintentando.

Encaja con el estudio "Anatomía de WhatsApp" (§13, entrantes: `system` →
"Cambio de número o identidad. Mensaje de sistema centrado"; `unsupported` →
"Marcador explícito. Nunca silencio") y con la invariante del proyecto:
ningún lead invisible.

## Decisiones del operador (6/9/2026)

- **D1 · El contacto sigue al número nuevo.** Cuando el número nuevo no
  pertenece a ningún contacto, `contacts.phone_number` pasa al nuevo. La
  conversación, el historial, los pines, el pedido y la bitácora cuelgan de
  `contact_id`, así que siguen al cliente sin tocar nada más; la cabecera del
  chat y el envío pasan a usar el número bueno. El viejo queda en el evento
  del chat y en `payload`.
- **D2 · Si el número nuevo ya tiene contacto, no se fusiona nada.** El
  evento lo dice ("… que ya tiene conversación en el CRM"), queda
  `log.error("webhook_cambio_numero_conflicto")` y el asesor decide. Fusionar
  dos historiales es una decisión de persona.
- **D3 · Los `unsupported` de Meta que vienen solos se guardan.** Como
  `message_type: "unsupported"`, con el tipo real en `payload.type`, pintados
  con un marcador explícito, **sin turno de IA** (no hay texto que atender)
  pero contando como mensaje del cliente, para que caigan en "Pendientes" y
  una persona los mire en el teléfono. Los que llegan junto a multimedia del
  mismo remitente se siguen descartando: son el aviso que acompaña a las
  galerías.
- **D4 · La frase del 131026** pasa a: "Este número ya no recibe WhatsApp. Si
  en el chat hay un aviso de cambio de número, escríbele al nuevo; si no,
  confírmalo con el cliente por otro medio."

Supuestos que el orquestador puede ajustar sin volver al operador: el texto
exacto de los eventos y del marcador (mientras digan lo mismo); el nombre de
los eventos de log; si el número nuevo de un `user_changed_number` no es un
teléfono válido, se trata como `system.type` desconocido.

## Reglas para todos (orquestador y subagentes)

- Metodología `liminalwork`: el orquestador no implementa; delega, valida el
  reporte, corre la suite completa él mismo y hace el commit. Un subagente
  por tarea, contexto limpio, modelo Sonnet con razonamiento alto.
- Todo en español: comentarios que cuentan el porqué y la fecha (6/9/2026),
  logs vía `lib/log.ts`, UI en español de Venezuela (nada de voseo).
- **Los subagentes NO hacen commit, NO editan `docs/GLOSARIO.md` ni
  `CLAUDE.md`**: entregan en su reporte la línea de glosario propuesta por
  archivo tocado y el orquestador la aplica al commitear.
- Cada subagente toca SOLO los archivos de su sección. Si necesita tocar
  otro, lo dice en el reporte y no lo hace.
- Un cambio de lógica trae su test al lado del módulo. Antes de cerrar, el
  subagente corre `rtk npx vitest run <sus archivos de test>`, `rtk npx tsc
  --noEmit` y `rtk npm run lint`, y pega el resultado en el reporte. La suite
  completa la corre el orquestador.
- Sin migraciones en esta corrida. Si una tarea cree necesitar una, se para
  y lo reporta.
- La invariante "ningún lead invisible" sigue vigente.
- Trampas vigentes de `CLAUDE.md`: `rtk next build` miente (compilar con
  `rtk proxy npm run build`); un `vi.mock` con `importOriginal()` arrastra el
  grafo entero; las tres fábricas del webhook (`route.test.ts`,
  `new-contact-race.test.ts`, `welcome-race.test.ts`) se mantienen en espejo.
- Sin `git push`, sin tocar producción, sin `supabase db push`.
- Reporte obligatorio al terminar: (1) qué implementó y qué decidió sobre la
  marcha, (2) archivos creados/modificados con la línea de glosario propuesta
  para cada uno, (3) salida de los tests/tsc/lint, (4) desvíos, deuda o dudas.

## Orden de ejecución

- **Tanda 1, en paralelo, archivos disjuntos:** S1 (`route.ts` +
  `route.test.ts`), S2 (`failure-reason.ts` + su test), S3b
  (`message-bubble.tsx` + su test, y `types.ts` si hace falta).
- **Tanda 2:** S3a (`route.ts` + `route.test.ts`), cuando S1 ya esté
  commiteada. S1 y S3a tocan el mismo archivo: no corren juntas nunca.
- **S4** la hace el orquestador al commitear cada tarea (glosario) y al final
  (este plan en `docs/planes/`).
- Cada tanda cierra con la suite completa en verde antes de abrir la
  siguiente.

## Tareas

### S1 · El webhook entiende `system` y mueve al cliente a su número nuevo (tanda 1)

Archivos: `src/app/api/webhooks/whatsapp/route.ts`,
`src/app/api/webhooks/whatsapp/route.test.ts`.

Contexto para leer antes de escribir: `CLAUDE.md` (Arquitectura, "Camino de
un mensaje entrante"; Trampas), la línea de `webhooks/whatsapp/route.ts` en
`docs/GLOSARIO.md`, `src/lib/whatsapp/phone.ts`, y en `route.ts` la rama
`reaction` / `unsupported`, el upsert de contacto, el SELECT de
`existingConversation` y la reapertura de conversaciones `closed`, y los dos
inserts de `system_event` que ya existen ("El cliente volvió a escribir" y
"Llegó desde el anuncio …"): el evento nuevo se escribe con la misma forma.

Forma del webhook de Meta (Cloud API, verificada contra un payload real
reportado por terceros el 27/6/2023):

```json
{
  "from": "593987317372",
  "id": "wamid.…",
  "timestamp": "1757127251",
  "type": "system",
  "system": {
    "body": "User A changed from 593987317372 to 5939XXXXXXXX",
    "wa_id": "5939XXXXXXXX",
    "type": "user_changed_number"
  }
}
```

La documentación on-premises llama `new_wa_id` al mismo campo, y el otro
subtipo documentado es `customer_identity_changed` (trae `identity`, no
`wa_id`). Se leen `wa_id` y `new_wa_id`, en ese orden.

1. `WebhookMessage` gana `system?: { body?: string; type?: string; wa_id?:
   string; new_wa_id?: string; identity?: string }`, con un comentario que
   cuente el caso del 5/9/2026.
2. La rama `message.type === "system"` entra **después** de
   `phoneNumberFromWaId(message.from)` (necesita el teléfono viejo) y
   **antes** del upsert de contacto y de todo lo que sigue. Dentro:
   - Contacto por `select("id").eq("phone_number", viejo).maybeSingle()`, NO
     upsert. Conversación por `contact_id` + `whatsapp_channel_id =
     channel.id`, `select("id")`. Si falta cualquiera de las dos:
     `log.info("webhook_system_sin_conversacion", {...})` y `continue`. Un
     cambio de número de alguien que nunca escribió no crea nada.
   - No se reabre una conversación `closed`, no se registra
     `reabierta_por_cliente`, no se toca `referral`, no se guarda cita.
   - `system.type === "user_changed_number"` con `nuevo =
     phoneNumberFromWaId(system.wa_id ?? system.new_wa_id)` válido:
     - `select("id").eq("phone_number", nuevo).maybeSingle()` sobre
       `contacts`. Si no hay fila: `update contacts set phone_number = nuevo
       where id = contact.id`. Si el UPDATE devuelve `23505` (otro webhook
       ganó la carrera), se sigue por la rama de conflicto.
     - Con fila (o 23505): no se toca el contacto;
       `log.error("webhook_cambio_numero_conflicto", { conversationId,
       previo: viejo, nuevo, contactoExistenteId })`.
     - En los dos casos, un insert en `messages` con `conversation_id`,
       `direction: "outbound"`, `sender_type: "system"`, `message_type:
       "system_event"`, `content` = `El cliente cambió su número de WhatsApp
       a ${nuevo}` (en conflicto: `El cliente cambió su número de WhatsApp a
       ${nuevo}, que ya tiene conversación en el CRM`) y `payload: { type:
       "system", systemType: "user_changed_number", previousPhone: viejo,
       newPhone: nuevo }`. Error del insert → `log.error`, sin tumbar el
       lote.
     - `log.info("webhook_cliente_cambio_numero", { conversationId, previo,
       nuevo, contactoMovido: boolean })`.
   - Cualquier otro `system.type` (`customer_identity_changed`, uno nuevo, o
     `user_changed_number` con número inválido): `system_event` con `content`
     = `WhatsApp avisó: ${system.body}` (o `WhatsApp envió un aviso de
     sistema` si no hay `body`) y `payload: { type: "system", systemType:
     system.type ?? null }`; sin cambios de datos; `log.info`.
   - `continue` antes de la inserción normal: sin `customerText`, sin turno de
     IA, sin `unread_count`, sin `last_customer_message_at`.
3. **Verificación obligatoria del trigger.** Buscar en
   `supabase/migrations/` la función del trigger de `messages` que mueve
   `last_customer_message_at`, `unread_count`, `last_message_at`,
   `last_message_preview`, `last_reply_at` y `awaiting_reply` (empezar por
   `grep -rn last_customer_message_at supabase/migrations`) y confirmar
   leyéndola qué hace con una fila `direction = 'outbound'`, `sender_type =
   'system'`, `message_type = 'system_event'`. Anotar en el reporte, con la
   migración y las líneas, qué columnas mueve y cuáles no. Si mueve
   `last_reply_at`/`awaiting_reply` (es decir, si un evento de sistema cuenta
   como "respuesta del equipo" y saca el chat de "Pendientes"), NO cambiar el
   trigger: reportarlo como hallazgo y seguir. Es el mismo comportamiento que
   ya tienen los 261 eventos existentes; corregirlo sería una migración y va
   en otra corrida.

Tests en `route.test.ts`, con el espejo de mocks existente (el test de
reapertura ya tiene `conversationRow`/`conversationUpdates`/`handoffCalls`
mutables: reutilizarlos):

- Cambio a un número libre: un UPDATE sobre `contacts` con `phone_number =
  nuevo`; un insert `system_event` cuyo `content` contiene el número nuevo y
  cuyo `payload.newPhone` es el nuevo; cero inserts `direction: "inbound"`;
  cero llamadas a `enqueueAgentTurns`; respuesta 200.
- Cambio a un número que ya tiene contacto: cero UPDATE sobre `contacts`; el
  evento dice "ya tiene conversación"; `log.error` con `previo` y `nuevo`.
- `system` de un número sin conversación: cero inserts, cero UPDATE, 200.
- `system.type` desconocido (`customer_identity_changed`): evento con
  `payload.systemType` igual a ese valor, cero UPDATE.
- Conversación `closed` que recibe `system`: cero `update({status:"open"})`,
  cero `recordHandoff`, y el evento igual se inserta.

Terminado cuando: los cinco tests en verde junto al resto de `route.test.ts`,
`new-contact-race.test.ts` y `welcome-race.test.ts` (espejo intacto), `tsc` y
`lint` limpios, y el reporte trae la verificación del trigger con la
migración citada.

### S2 · El 131026 dice qué hacer (tanda 1)

Archivos: `src/lib/whatsapp/failure-reason.ts`,
`src/lib/whatsapp/failure-reason.test.ts`.

Solo la frase (D4), en `MOTIVOS_CONOCIDOS[131026]`:

> Este número ya no recibe WhatsApp. Si en el chat hay un aviso de cambio de
> número, escríbele al nuevo; si no, confírmalo con el cliente por otro medio.

Comentario encima con el caso del 6/9/2026 (el envío a un número que había
leído todo el 31/8). `failureAction(131026)` sigue devolviendo `null`: el
botón "abrir la conversación del número nuevo" necesita que la burbuja sepa
el número, y eso es otra corrida (queda en deuda).

Test: la tabla de `failure-reason.test.ts` toma la frase nueva; si el test
afirma la frase vieja literal, se actualiza; si afirma solo que existe, se
agrega un caso que afirme un fragmento distintivo ("aviso de cambio de
número").

### S3b · La burbuja pinta lo que WhatsApp no entrega por API (tanda 1)

Archivos: `src/components/chat/message-bubble.tsx`,
`src/components/chat/message-bubble.test.tsx`, y `src/lib/types.ts` solo si
`MessagePayload` no admite `type`/`code` (agregar `type?: string | null;
code?: number | null` con comentario; no tocar nada más del archivo).

Contexto: la línea de `message-bubble` en `docs/GLOSARIO.md` (T3.2/T3.3:
`interactive` pinta chip, `order` pinta `OrderCard`, `failed` pinta motivo);
`MessageType` y `MessagePayload` en `types.ts`.

1. Mirar primero qué pinta hoy una fila `messageType === "unsupported"` con
   `content: null` (probablemente una burbuja vacía o el fallback de
   multimedia) y anotarlo en el reporte.
2. Con `messageType === "unsupported"`, burbuja del lado del cliente (misma
   alineación y color que un texto entrante) con el texto fijo:

   > WhatsApp no entrega este mensaje por la API (encuesta, foto de ver una
   > vez, evento…). Ábrelo en el teléfono.

   y, si `payload.type` viene, una segunda línea en tono apagado: `Tipo:
   ${payload.type}`. Sin `content` en prosa (es null). La hora y el menú
   contextual como en cualquier burbuja entrante.
3. Nada de lógica nueva de datos: `payload` ya viaja en `MESSAGE_SELECT` y
   `mapMessage` (T3.2).

Tests en `message-bubble.test.tsx`: una fila `unsupported` sin `payload`
muestra el marcador; con `payload.type = "poll"` muestra además "poll"; no
muestra el aviso de multimedia sin `media_url`.

### S3a · El webhook guarda los `unsupported` que vienen solos (tanda 2, después de S1)

Archivos: `src/app/api/webhooks/whatsapp/route.ts`,
`src/app/api/webhooks/whatsapp/route.test.ts`.

Contexto: la rama actual `message.type === "unsupported"` (hoy: `console.info`
y `continue`, con el comentario que cuenta por qué se descartaba); la
construcción de la lista `conversaciones` que se pasa a
`enqueueAgentTurns` al final del lote; el `else` final que ya escribe
`message_type: "unsupported"` con `payload: { type }` (F10). El estudio
"Anatomía de WhatsApp" §13: desde nov 2025 el objeto `unsupported` trae
`type` con el tipo real (encuesta, ver una vez, evento, temporal, grupo,
llamada nativa); `errors[0].code` es 131051 "Message type unknown" o 131060
"This message is currently unavailable".

1. `WebhookMessage` gana `unsupported?: { type?: string }` (los `errors` ya
   están tipados).
2. En la rama `type === "unsupported"`:
   - Si en `value.messages` hay OTRO mensaje con el mismo `from` cuyo `type`
     está en `MEDIA_TYPES`, se descarta como hoy (mismo `console.info`,
     actualizando el comentario: ahora dice que SOLO se descarta el que
     acompaña a una galería).
   - Si no, sigue el camino normal del mensaje entrante (contacto,
     conversación, reapertura si estaba `closed`: sí es el cliente
     escribiendo) y se inserta con `direction: "inbound"`, `sender_type:
     "customer"`, `message_type: "unsupported"`, `content: null`,
     `customerText: null`, `payload: { type: message.unsupported?.type ??
     null, code: message.errors?.[0]?.code ?? null }`. La forma más simple es
     que la rama, en vez de `continue`, deje una bandera `esUnsupportedSolo`
     y que el `if/else` de tipos la atienda como una rama más, antes del
     `else` final.
   - `log.info("webhook_unsupported_guardado", { conversationId, tipo, code
     })`.
3. **Sin turno de IA** (D3): la conversación NO entra en la lista de
   `enqueueAgentTurns` por causa de esta fila. Si en el mismo lote la misma
   conversación tiene además un mensaje normal, ese sí la encola, como
   siempre. Implementar en el punto donde hoy se decide qué conversaciones
   encolar; documentar en un comentario que la IA no tiene nada que atender y
   que `loadHistory` (T3.2) ya salta estas filas.
4. El trigger de `messages` mueve `last_customer_message_at`, `unread_count` y
   `awaiting_reply` para esta fila como para cualquier entrante: es lo que
   se quiere (D3, "cae en Pendientes"). Confirmarlo leyendo la misma función
   que S1 citó en su reporte (el orquestador pega ese hallazgo en el prompt).

Tests en `route.test.ts`:

- Lote con un solo `unsupported` (`unsupported.type = "poll"`, `errors[0].code
  = 131051`): un insert `inbound` con `message_type: "unsupported"`,
  `content: null` y `payload: { type: "poll", code: 131051 }`; cero llamadas a
  `enqueueAgentTurns`; 200.
- Lote con `unsupported` + `image` del mismo `from`: cero inserts
  `unsupported`; la `image` se guarda y encola como siempre.
- Lote con `unsupported` de A y `text` de B: se guarda el de A sin encolar a
  A; B se guarda y encola.
- Lote con `unsupported` y `text` del MISMO remitente (sin multimedia): se
  guardan los dos y la conversación se encola una vez (por el texto).

Terminado cuando: los cuatro tests en verde junto al resto del espejo, `tsc`
y `lint` limpios, y el comentario de la rama cuenta la historia completa
(por qué se descartaba, por qué desde el 6/9/2026 se guarda cuando viene
solo).

### S4 · Documentación (orquestador)

`docs/GLOSARIO.md`: las líneas de `webhooks/whatsapp/route.ts` (S1 y S3a),
`whatsapp/failure-reason.ts` (S2), `chat/message-bubble` (S3b) y `types.ts` si
S3b lo tocó, con las líneas propuestas por cada subagente. `CLAUDE.md`: solo
si algún reporte cambia doctrina (no se espera). Este plan en
`docs/planes/2026-09-06-el-cliente-que-cambio-de-numero.md` y el prompt en
`docs/planes/2026-09-06-prompt-orquestador.md`, en el commit de S1.

## Commits

Uno por tarea, narrativos en español, en este orden:

1. "El CRM sigue al cliente cuando cambia de número de WhatsApp" (S1 + plan
   y prompt en `docs/planes/` + glosario).
2. "El 131026 dice a qué número escribir" (S2 + glosario).
3. "La burbuja marca lo que WhatsApp no entrega por API" (S3b + glosario).
4. "Lo que WhatsApp no entrega por API deja marca en el chat" (S3a +
   glosario).

Sin `[migración]`. Mensajes largos con `git commit -F <archivo>`.

## Verificación final (orquestador)

1. `rtk npx tsc --noEmit`, `rtk npm run lint`, `rtk npm run test --
   --no-file-parallelism`, `rtk proxy npm run build` (verificar el timestamp
   de `.next/BUILD_ID`).
2. Escenario a mano contra el dev local (`npm run dev` con Supabase local y
   sin `WHATSAPP_APP_SECRET`: fuera de producción el webhook procesa sin
   firma): tres `POST /api/webhooks/whatsapp` con la forma real de Meta
   —un `text` de un número de prueba, luego un `system`
   `user_changed_number` de ese número hacia otro libre, luego un
   `unsupported` con `unsupported.type = "poll"` desde el número nuevo— y
   comprobar en la base: `contacts.phone_number` movido, el `system_event`
   con el número nuevo, la fila `unsupported` con `payload.type = "poll"`, y
   en `agent_turn_queue` un solo encolado (el del texto).
3. Dos mutaciones manuales: (a) quitar en S3a la condición que descarta el
   `unsupported` cuando hay multimedia del mismo remitente → el test "lote con
   `unsupported` + `image`" debe ponerse rojo; (b) en S1, quitar el
   `continue` que evita la reapertura → el test de conversación `closed` debe
   ponerse rojo. Revertir las dos.
4. Antes del reporte de entrega, confirmar con el operador en qué commit está
   producción (hoy `8ee97d7`).

## Entrega a producción

Sin migraciones: `compose.deploy` por la API de Dokploy y esperar `status:
done` en `deployment.allByCompose`. Después, dos verificaciones en el VPS:

1. El log del contenedor no muestra errores de arranque; a la primera
   ocurrencia real, `webhook_cliente_cambio_numero` o
   `webhook_unsupported_guardado` en el log y el evento en el chat.
2. Nada retroactivo para +593987317372: el aviso original no se guardó. El
   asesor abre ese chat en el teléfono vinculado; si WhatsApp muestra "cambió
   su número a …", se escribe al nuevo y el CRM lo enlaza como contacto nuevo
   hasta que el cliente vuelva a escribir.

## Lo que el estudio sugiere agregar por Cloud API, y dónde está

| Patrón (§13/§15/§18) | Estado en el CRM | En este plan |
|---|---|---|
| Marcar como leído + "escribiendo…" hacia el cliente | Hecho (T3.1, `meta-client.ts`) | — |
| `system` (cambio de número / identidad) como mensaje centrado | No existe | S1 |
| `unsupported.type` con marcador explícito, "nunca silencio" | Se descarta con log | S3a + S3b |
| Errores traducidos con acción (131026 → "marcar contacto · sugerir llamada") | Frase sí, acción no | S2 (frase) |
| Etiqueta ↪ con `context.forwarded` / `frequently_forwarded` | No existe | Fuera: corrida propia |
| Reacciones salientes (👍 a confirmaciones triviales) | Solo entrantes | Fuera |
| `contacts[].user_id` (BSUID) cuando falta `wa_id` | No se lee; el remitente sin teléfono ya se descarta con log | Fuera |
| Descarga inmediata de medios (id 7 días, URL 5 min) | Hecho (`after()` del webhook) | — |

## Deuda que deja anotada esta corrida

- `failureAction(131026)`: botón "abrir chat del número nuevo" en la burbuja
  fallida (necesita que la burbuja conozca el número).
- Fusionar historiales cuando el número nuevo ya tiene contacto (D2).
- Si el trigger de `messages` trata un `system_event` saliente como
  respuesta del equipo (lo dirá el reporte de S1), corregirlo es una
  migración y una corrida propia.
- Etiqueta de reenviado, reacciones salientes, BSUID.
