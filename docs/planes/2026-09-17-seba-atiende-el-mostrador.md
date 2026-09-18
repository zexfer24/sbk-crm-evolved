# Plan · "Seba atiende el mostrador" — 17/9/2026 (APROBADO el 18/9/2026)

> APROBADO el 18/9/2026: el operador volvió a pasar las ocho exigencias del
> cliente, delegó la comparación contra este plan y autorizó implementar con
> subagentes `implementador` (Sonnet, razonamiento alto) si era viable. La
> comparación requisito por requisito está en "Cotejo final". Diseño
> verificado contra HEAD `aac9e74` (3 commits sin push sobre `3802fad` =
> producción).

## Contexto

El cliente (dueño de SBK Motors) redactó ocho solicitudes sobre cómo debe
comportarse la IA vendedora. Su motivación: que la conexión al inventario no
convierta a la IA en "una máquina de dar precios", que el cliente sienta
confianza desde el primer mensaje y no "hable con una pared". El operador
pide un plan liminalwork para aplicarlas.

## Las ocho solicitudes, tal como llegaron

1. **Identidad y saludo**: se llama "Seba", educado, acompaña sin atosigar,
   detecta la hora. Primer mensaje (conversación nueva o reabierta tras
   cierre) estrictamente: "Hola, buen [día/tarde/noche], mi nombre es Seba.
   Soy tu asistente el día de hoy en SBK MOTORS, ¿cómo puedo ayudarte?"
2. **Base confusa**: si no sabe o el producto no sale claro, dice que no
   maneja esa información y pasa de inmediato a un asesor.
3. **Repuesto encontrado**: da precio y stock con la aclaración fija de que
   un asesor verifica el inventario físico, y escala.
4. **Stock 0**: "el sistema marca que no nos quedan unidades" + escala para
   confirmar reposición o alternativa compatible.
5. **Única pregunta**: prohibido frenar la venta con preguntas; excepción:
   consulta genérica → UNA pregunta de filtro (modelo y año) → escalar.
6. **Intervención continua sin pisarse**: tras escalar, si el cliente sigue
   preguntando inventario, la IA sigue respondiendo; en el instante en que el
   asesor manda su primer mensaje, la IA se silencia en ese chat.
7. **Aprendizaje manual**: clic derecho/botón sobre cualquier mensaje del
   cliente para escribir una corrección o nota que la IA lea y use
   (palabras, compatibilidades, situaciones nuevas).
8. **Sincronización en tiempo real**: la IA consulta el inventario del Saint
   o de las hojas de cálculo en tiempo real.

## Lo que el código hace hoy y choca con el brief (exploración del 17/9)

- El prompt PROHÍBE tener nombre (`prompt.ts:161`) y describirse como
  asistente (`:163`); la guarda de identidad bloquea "mi nombre es" como
  identidad de persona. Un escenario del panel con ese saludo no se puede ni
  guardar. Hay que reescribir esas reglas a propósito.
- Escalar APAGA la IA en el acto (`escalate.ts:78`, `ai_enabled: false`). El
  requisito 6 exige el modelo contrario: asignar sin apagar, y apagar cuando
  el asesor manda su primer mensaje real.
- Escalar en cada repuesto encontrado / no encontrado / en cero significa
  que casi el 100 % de las consultas de inventario terminan asignadas.
- "Saint" no aparece en ninguna parte del repo. Los 5.438 productos entraron
  el 24/8 por una aplicación aparte del dueño que nunca volvió a correr. No
  hay importador, cron ni columna de código externo.
- La reapertura tras cierre NO re-saluda: `needsGreeting` (`agent.ts:369`)
  mira si hay respuestas de la IA en los últimos 15 mensajes, sin mirar el
  cierre.

## Decisiones del operador (17/9/2026, 16:57)

- **D1 — Saludo**: lo manda el CÓDIGO, texto literal, como mensaje propio
  antes de cualquier redacción del modelo. Garantiza el "estrictamente".
- **D2 — Ciclo de la IA**: tras escalar, la IA sigue respondiendo hasta que
  el asesor escriba y ahí se apaga en ese chat. Vuelve a encenderse al
  reabrirse tras cierre (el chat arranca de cero: IA encendida, sin asesor,
  Seba saluda de nuevo) y, además, a mano con el interruptor por chat.
- **D3 — Asignación**: round-robin entre asesores activos, como hoy. Aviso
  aceptado: "Con asesor" subirá a casi todas las consultas.
- **D4 — Requisito 8 (Saint / hojas de cálculo)**: FUERA de esta corrida.
  Textual: "Deja esto sin hacer, luego te explico."

## Decisiones del operador, segunda tanda (18/9/2026)

- **P1 — Sin asesor disponible (noche / domingo): Seba SIGUE contestando.**
  Coherente con el requisito 6. Cada mensaje gasta un turno; el chat queda
  en "Sin dueño" y "Pendientes" hasta que un asesor lo tome, y la IA nombra
  cuándo se procesa la venta, como hoy. El freno contra el bucle es el
  predicado nuevo del reconciliador (hallazgo 2), no el interruptor.
- **P2 — Alcance por defecto de una lección: "Todos los chats"**, con "Solo
  este chat" opcional en el modal; un supervisor revisa y desactiva desde
  Control IA.
- **P3 — Sinónimos de búsqueda: ENTRAN ahora** (T5c sobre
  `catalog-search.ts`).

---

## 0. Hallazgos que cambian el diseño respecto al brief (verificados el 17/9 contra `aac9e74`)

1. **`escalationOpen` y el trigger de dueño se rompen con D2 si no se corrige el trigger.** `handle_conversation_ownership_change()` (`supabase/migrations/20260916010000_devolucion_a_la_ia.sql:338-357`) escribe `reclamado` cuando `assigned_agent_id` cambia a no-nulo **sin que `ai_enabled` cambie**. Hoy la escalada cambia las dos columnas juntas y por eso no dispara; con D2 (escalar sin apagar la IA) **cada escalada dejaría una fila `reclamado` espuria** antes de la fila `escalada`, y el caso 1 del test SQL (`supabase/tests/devolucion_a_la_ia.sql`, "escalada simulada no deja fila") se pondría rojo. Corrección mínima: la rama `reclamado` exige además `auth.uid() is not null` (la escalada corre con `service_role`; el único camino "sistema" que asigna un asesor es `escalate.ts`).
2. **El reconciliador entra en bucle con D2 sin asesor disponible.** `reconciler.ts:148-163` reencola `awaiting_reply && ai_enabled && assigned_agent_id is null && new_since_ai_resume`. Con `escalada_sin_asesor` y la IA encendida, la despedida es `is_auto_reply` (awaiting sigue true), nadie asignado, el sello no se mueve → el cron reencola cada minuto, el modelo vuelve a escalar, y así hasta que alguien escriba. Hoy lo frenaba `ai_enabled=false`. Hace falta un predicado nuevo en `reconciler.ts` y en `unansweredFreeWork` (`data.ts:2413`): "el último mensaje visible es del cliente, o el último saliente falló" (`last_message_direction = 'inbound' OR last_message_status = 'failed'`, columnas que `handle_new_message()` ya mantiene desde `20260822060000`). Sin migración.
3. **Reescalar en cada pregunta reasignaría round-robin a un asesor distinto.** Con D2 la IA sigue respondiendo (y por las reglas 3/4, escalando) en cada consulta de inventario. `escalateConversation` (`escalate.ts:70`) llama a `claimNextAvailableAgent` siempre. Hace falta una rama "ya asignada": no reclama, no escribe traspaso (el aviso de asignación solo dispara con `escalada`, `assignment-notice.ts`), deja la nota de sistema con el resumen nuevo y devuelve `escalated: true` con el asesor actual.
4. **`needsGreeting` por historial no sirve para la reapertura ni para el backlog.** `agent.ts:369-371` mira "ningún `assistant` en los últimos 15" (y `history-line.ts:100` mapea también los mensajes de asesores humanos a `assistant`). En un chat reabierto el historial trae respuestas viejas → nunca saludaría. El sello pasa a ser **solo la columna** `welcome_sent_at` (= "Seba se presentó"), con un **backfill** en la migración: `welcome_sent_at = coalesce(last_reply_at, last_message_at, created_at)` donde `has_reply` (vitalicio: IA, asesor o bienvenida). Así: chat nuevo → null → saluda; backlog con alguna respuesta → sellado → no saluda; backlog jamás contestado → saluda (es de verdad lo primero que decimos); reapertura por cliente → el webhook lo pone en null.
5. **El orden del webhook ya es el correcto para la carrera con `ai_resume_cutoff_at`.** El reopen (`route.ts:1084-1088`) corre ANTES del insert del entrante (`route.ts:1331`). Si en ese mismo UPDATE se pone `ai_enabled: true, assigned_agent_id: null, welcome_sent_at: null`, el trigger BEFORE sella `cutoff := last_customer_message_at` **viejo**, y el mensaje que se inserta después (con `created_at` de Meta, necesariamente posterior) queda por delante del sello. No hace falta RPC. Sí conviene convertir el UPDATE en reclamo (`.eq("status", "closed").select("id")`) para que dos webhooks concurrentes del mismo lote no dupliquen el evento ni el traspaso.
6. **`escalationOpen` no necesita cambios**: la rama "ya asignada" no escribe filas, así que la última fila que cambia de manos sigue siendo `escalada`; y la razón nueva `silenciada_por_asesor` sí cierra la escalada (un humano tomó el chat), luego NO va en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`.
7. **`motivo` no tiene CHECK**: solo viaja en el texto del `system_event` (`escalate.ts:97-99`) y en `agent_turns.summary`. Los motivos nuevos no exigen migración.
8. **Tests SQL existen y corren en CI** (`supabase/tests/*.sql` vía `psql -f` en `.github/workflows/ci.yml:90-249`, un paso por archivo). Las dos migraciones traen su test SQL y su paso de CI.
9. **`sinonimos_busqueda` (`20260821000000`) solo se CUENTA** para el panel de Inventario (`inventory-data.ts:175`); nadie la consulta para buscar. Se deja durmiente y documentada; no se reutiliza (otra RLS, otro panel).

---

## 1. Diseño por requisito

### R1 — Identidad y saludo literal (D1)

**Dónde vive el texto.** `AI_NAME = "Seba"` en `src/lib/brand.ts` (puro, lo importan servidor y cliente: el menú "Enseñar a Seba…" y la etiqueta de burbuja lo necesitan). Nuevo módulo puro `src/lib/ai/seba.ts` (sin `server-only`, imports solo de `brand.ts` y del tipo `DayBand`):

- `presentationGreetingFor(band)`: `mañana → "buen día"`, `tarde → "buenas tardes"`, `noche → "buenas noches"` (no se toca `greetingFor` de `business-hours.ts`, que sigue usándolo `playbooks.buildPrompt`).
- `sebaGreeting(band)`: `` `Hola, ${saludo}, mi nombre es ${AI_NAME}. Soy tu asistente el día de hoy en ${BUSINESS_NAME.toUpperCase()}, ¿cómo puedo ayudarte?` `` (respeta la regla de `brand.ts`: ningún archivo de `src/` escribe el literal).
- `isGreetingOnly(text)`: misma mecánica que `isCourtesyOnly` (`saludo.ts:61-73`, tope 6 palabras) con lista `hola|buenas|buenos|buen|dia|dias|tarde|tardes|noche|noches|saludos|hey|que|tal|hi`. Se retiró el 15/9 sin llamadores; vuelve con llamador real. Vive en `saludo.ts`.
- Los tres textos fijos de R2/R3/R4 también acá, para que `prompt.ts`, `tools.ts` y `agent.ts` interpolen la misma constante. Los dos que el cliente dictó van LITERALES:
  - `TEXTO_CONFIRMAR_INVENTARIO` = "En inventario parece que quedan unidades disponibles en este precio. Sin embargo, para confirmar, te pasaré con un asesor para que verifique el inventario físico y te dé respuesta lo antes posible."
  - `TEXTO_SIN_STOCK` = "Actualmente el sistema marca que no nos quedan unidades, pero te paso con un asesor para que confirme si nos llega pronto o si hay alguna alternativa compatible." ("sistema" suelto no está anclado en la guarda; ver CLAUDE.md).
  - `TEXTO_NO_IDENTIFICADO` (el cliente no dictó texto; pidió "decirle que no maneja esa información y pasarlo inmediatamente") = "Esa información no la manejo por acá, pero te paso de una vez con un asesor que te la confirma lo antes posible."
  Los tres contienen "asesor", así que la red de seguridad de `agent.ts` no los duplica cuando el modelo ya los dijo.

**Quién lo manda.** El TURNO, no el webhook: el turno tiene el lock, `deliver()` (lease, `agent_can_run`, `humanWroteMeanwhile`), la ventana de 24 h y el `TurnTarget` congelado. Mandarlo desde el webhook saltaría todas esas guardas y correría contra el propio turno. Nuevo paso en `runTurnPhases` (`agent.ts`), justo después de la guarda `history.length === 0` (l.1151-1172) y ANTES de la guarda de cortesía (l.1199):

```
if (convo.welcome_sent_at === null) {
  claim: UPDATE conversations SET welcome_sent_at = now WHERE id = ? AND welcome_sent_at IS NULL RETURNING id   // mismo patrón que claimWelcome, route.ts:316-333
  if (claimed) {
    soloSaludo = customerMessage !== null && (isGreetingOnly(customerMessage) || isCourtesyOnly(customerMessage))
    salida = deliver(..., "presentacion", lcma, () => sendAgentText(supabase, target, sebaGreeting(dayBand(now)), { isAutoReply: !soloSaludo }))
    if (!salida || deliveryFailed(...)) { revertir welcome_sent_at a null (como bienvenida_rechazada_por_meta, route.ts:391); return }
    if (soloSaludo) { logTurn answered "Seba se presentó; el cliente solo saludó"; resetStage; return }   // sin fase 0/1 ni tool loop: tres llamadas ahorradas
    introducedThisTurn = true
  }
}
```
`isAutoReply: !soloSaludo`: cuando solo se saluda, el saludo ES la respuesta (apaga `awaiting_reply`); cuando sigue una redacción, no debe apagarla antes de tiempo (si esa redacción escala, `awaiting_reply` tiene que quedar en true — trampa T5 del 14/9). `SendPhase` (`agent.ts:579`) gana `"presentacion"`.

**Ventana de Meta.** El paso vive dentro de `runTurnPhases`, o sea DESPUÉS de `withinFreeformWindow` (l.1893): el saludo solo sale con ventana abierta. Un turno de backlog fuera de ventana sale por `fuera_de_ventana` con `welcome_sent_at` todavía null y Seba saluda cuando el cliente vuelva a escribir. `WHATSAPP_WELCOME_TEMPLATE` sigue vacía; si algún día se configurara, `claimWelcome` sellaría primero y Seba no saludaría — son excluyentes por diseño, documentarlo en CLAUDE.md.

**Prompt (`src/lib/ai/prompt.ts`).** Cambia el prefijo cacheable UNA vez:
- Sección 1, l.161: reemplazar "No tienes nombre propio…" por "Te llamas Seba. Seba ya se presentó al cliente en el primer mensaje de esta conversación (lo manda el sistema antes que tú, con el saludo del día): si preguntan con quién hablan, eres Seba, el asistente de SBK Motors por WhatsApp. Educado, acompañas sin atosigar."
- l.163: la línea SIGUE empezando con "Nunca te describas como" (`prompt.test.ts:309-311` y `394` filtran por ese prefijo) pero pasa a: "Nunca te describas como asistente virtual, asistente automatizado, agente virtual, agente automatizado, bot, sistema, programa ni inteligencia artificial…". "Asistente" a secas queda permitido.
- Sección 6, l.244: "No saludas ni te presentas: Seba ya se presentó en un mensaje aparte que el sistema manda antes que el tuyo. Ni al abrir la conversación ni cuando el cliente vuelva a saludar." (`prompt.test.ts:174-184` se reescribe.)
- `MEDIA_RULES` l.87: quitar "saluda y" ("Si es lo primero que llega, pregunta en qué lo puedes ayudar").
- `buildInstructions` l.344-346: `needsGreeting` se renombra `introducedThisTurn` (semántica invertida). `true` → " Seba acaba de presentarse en un mensaje aparte que salió antes que el tuyo, con el saludo del día: no saludes ni te presentes, contesta directo lo que preguntó."; `false` → " Ya te presentaste como Seba en esta conversación: no saludes ni te presentes de nuevo, ve directo a lo que preguntó." Se eliminan los imports de `dayBand`/`greetingFor` y el helper `capitalizar`.
- `tools.ts:322-323` `RECORDATORIO_SALUDO` → " No saludes ni te presentes: Seba ya se presentó en un mensaje aparte." (los seis `toContain(RECORDATORIO_SALUDO)` de `tools.test.ts` siguen verdes).

**Guarda de identidad (`src/lib/ai/identity-guard.ts`).** El saludo literal no pasa por `applyIdentityGuard` (solo corre sobre el texto del tool loop, `agent.ts:1596`), así que no lo bloquea. Lo que sí hay que abrir es la prosa del modelo:
- Quitar `/soy (el|la|un|una) asistente/` (l.74-77) y sacar `asistente` de `/como (ia|inteligencia artificial|asistente)\b/` (l.91).
- `PATRONES_PERSONA` l.129-130: `/me llamo (?!seba\b)/` y `/mi nombre es (?!seba\b)/` (corren sobre texto normalizado en minúsculas). Cualquier otro nombre sigue bloqueado. "Soy Seba" no calza con nada hoy.
- `rewriteSuffix` l.169: "asistente" → "asistente virtual".
- `assertPlaybookIdentity` (`mutations.ts:522-525`) no cambia: hereda las excepciones. Un escenario "Hola, soy Seba…" igual se descarta en fase 0 por `isGreetingPlaybook` (`playbooks.ts:233`), que no cambia.
- Test nuevo en `seba.test.ts`: `revealsIdentity(sebaGreeting(band)) === null` para las tres franjas (prueba de que la excepción está bien anclada), más "mi nombre es Carlos" → `persona`.

**Cosmético opcional (misma tarea):** `senderLabel` (`message-bubble.tsx:127`) "IA" → `AI_NAME`.

### R2/R3/R4 — Textos fijos, catálogo y escalada

**Motivos nuevos** en `EscalationMotivo` (`escalate.ts:19`) y en el `z.enum` de `buildEscalateTool` (`tools.ts:369-373`): `confirmar_inventario`, `sin_stock`, `no_identificado`. No hay `consulta_generica`: el caso genérico NO escala en ese turno. `intencion_compra` sigue abriendo `deal_status: in_progress` (`escalate.ts:82`).

**Herramienta de catálogo (`tools.ts:106-237`).** Recibe un segundo parámetro `catalogOutcome: CatalogOutcome` (mismo patrón que `EscalationOutcome`): `{ ran, conExistencia, agotados, sinResultados, generico }`, acumulado entre llamadas del mismo turno. `generico = !motoBrand && !motoModel && quoted.length > 3` (o `hayMas`). Instrucciones (`instruccionParaTuRespuesta`), en este orden de precedencia:
- `generico` → `PREGUNTA_FILTRO_INSTRUCTION`: "El cliente no dijo modelo ni año de su moto y hay varios repuestos que calzan: haz UNA sola pregunta de filtro («Claro, ¿para qué modelo y año de moto las buscas?») y NO escales en este turno. Con la respuesta vuelves a buscar."
- `conExistencia` → "Da nombre, precio y stock tal como llegan (si alguno está en cero, dilo como agotado) y agrega textual: «TEXTO_CONFIRMAR_INVENTARIO». Luego llama a escalarAAsesor con motivo confirmar_inventario en este mismo turno."
- todos `stock <= 0` → "Di textual: «TEXTO_SIN_STOCK» y llama a escalarAAsesor con motivo sin_stock." (reemplaza `SIN_STOCK_INSTRUCTION` l.50-51).
- `results: []` (hoy sin instrucción, l.120 y l.218) → "No encontraste nada, o no queda claro cuál es: di «TEXTO_NO_IDENTIFICADO» y llama a escalarAAsesor con motivo no_identificado. No inventes ni sugieras alternativas." Texto propuesto: "Esa información no la manejo por acá, pero te paso de una vez con un asesor que te la confirma." (pasa la guarda; "sistema"/"manejo" no están anclados).
- El error de base (l.142) mantiene su forma y además `sinResultados = true`.
- Descripción del tool de escalar (l.360) "pausa la IA" → "asigna al asesor con más tiempo sin recibir un cliente nuevo; la IA sigue contestando hasta que el asesor escriba".

**Red de seguridad en código (`agent.ts`, después de l.1555-1589).** Nuevo bloque: si `catalogOutcome.ran && !outcome.escalated && !catalogOutcome.generico` → motivo = `conExistencia ? confirmar_inventario : agotados ? sin_stock : no_identificado`; `escalateConversation(...)`; copiar a `outcome` los cinco campos como hace la red de devolución/queja; si el texto del modelo no contiene `/asesor/i`, anexar el texto fijo del motivo (evita duplicar cuando el modelo ya lo dijo). El envío de l.1636-1648 ya marca `isAutoReply: outcome.escalated`. `buildCatalogTool(deps, catalogOutcome)` en l.1467.

**Prompt.** Sección 3 (l.185-199): sustituir l.189 ("da un paso hacia el cierre") y l.193 por la REGLA DE LA ÚNICA PREGUNTA: "Nunca frenes una venta con preguntas o datos que no hacen falta. Si el cliente ya dijo qué repuesto y para qué moto, buscas y respondes: cero preguntas. Única excepción: una consulta genérica («¿tienen pastillas de freno?») admite UNA sola pregunta de filtro — «Claro, ¿para qué modelo y año de moto las buscas?» — y con la respuesta buscas y pasas el caso. Nunca dos preguntas seguidas, nunca pidas cédula, nombre, ciudad ni forma de pago: eso lo pide el asesor." Mantener `SALES_ACCEPTANCE_RULES` y la regla de listas (l.195). Sección 4, párrafo de escalar (l.211): "escalas en cuanto tienes un resultado de catálogo (con o sin existencia) o cuando no manejas la información; el asesor confirma el inventario físico". Sección 5.1 (l.219-224): reescribir con los tres casos y los tres textos interpolados desde `seba.ts`; conservar el párrafo "avísame cuando llegue → seguimiento" y el de fuera de horario (los tests `prompt.test.ts:735-745` y `467-475` siguen buscando `motivo seguimiento`, `agotado`, `escala con motivo intencion_compra`).

Test estático nuevo en `prompt.test.ts`: sección 3 contiene "única pregunta" y la pregunta de filtro literal; 5.1 contiene los tres textos y los tres motivos; los tres textos pasan `revealsIdentity`; el prefijo sigue > 1024 tokens.

### R6 — Escalada viva y silencio durable (D2, D3)

**`escalate.ts:77-84`.** Quitar `ai_enabled: false` del UPDATE. Antes del claim, leer `assigned_agent_id, ai_enabled` de la conversación (una consulta más; el fake de `escalate.test.ts` debe soportar `.from("conversations").select().eq().maybeSingle()`):
- Ya asignada → no reclama; UPDATE solo `deal_status` si `intencion_compra`; nota de sistema "IA reiteró la escalada a X. Motivo: … resumen"; SIN `recordHandoff`; devuelve `{ escalated: true, assignedAgentName, alreadyAssigned: true, businessStatus }`.
- No asignada → como hoy, menos `ai_enabled`. Sin asesor: sigue `journey_stage: 'assigned'` + `escalada_sin_asesor`, IA encendida (decisiones D2 y P1).
El comentario de l.72-76 ("Sin asesores la IA se pausa IGUAL") se reescribe con la historia nueva.

**`agent.ts` apertura (l.1774-1786).** Las dos guardas se fusionan: `if (!convo.ai_enabled) { assigned ? asignada/human : pausada/unassigned; return }`. Asignada con IA encendida → sigue. Guardas siguientes intactas: `mensaje_previo_a_devolucion`, `humanHasWritten` (una nota interna sigue callando a la IA 30 min por la gracia — no es el silencio durable, y está bien: la nota significa que alguien trabaja el caso), ventana 24 h.

**Salidas `is_auto_reply` mientras hay asesor asignado.** `const esperandoAsesor = Boolean(convo.assigned_agent_id)`; en `sendAgentText` de l.1645 `isAutoReply: outcome.escalated || esperandoAsesor`; en fuera de tema l.1429 igual; para escenarios, `sendPlaybookReply` (`send.ts:240`) gana `opciones?: SendAgentTextOptions` que pasa a `sendAgentText`, y `runPlaybook` (l.1025) la recibe. Efecto: `awaiting_reply` sigue true hasta la primera respuesta real del humano — el chat se queda en Pendientes/Tuyas y "Con asesor" cuenta atascados.

**`journey_stage` en chats asignados.** Hoy el turno escribe `classifying`/`tool_running` y al final `null` (l.1145-1148, 1505, 1657, 1435, 1112, `resetStage` l.783). En un chat asignado eso sacaría la conversación de la píldora "Escaladas" (`inbox-filters.ts` mira el campo crudo). Helper `stageFor(convo, etapa)` → `convo.assigned_agent_id ? "assigned" : etapa` en las seis escrituras.

**Silencio durable = trigger, no route.** Trigger `AFTER INSERT ON messages` (`handle_agent_message_silences_ai()`, `WHEN new.sender_type = 'agent' AND NOT new.is_internal_note AND new.direction = 'outbound'`) que hace `UPDATE conversations SET ai_enabled = false WHERE id = new.conversation_id AND ai_enabled`. Razones: (a) cubre cualquier vía que escriba `'agent'` (hoy solo `api/messages/send`, pero `human-handled.ts:44-48` ya advierte que eso puede cambiar), (b) es atómico con el insert (el route inserta y responde en `after()`; una segunda escritura desde TS puede quedar a medias), (c) la bitácora sale gratis del trigger de dueño. `security definer set search_path = public` + los DOS revokes, sin grant (patrón `handle_new_message`). El route no cambia. Efecto UI: `crm-shell.tsx:1205-1206` ya escucha `UPDATE conversations` del chat abierto → el banner cambia solo.

**Trigger de dueño (`handle_conversation_ownership_change`).** Dos cambios en la misma migración: (1) rama nueva `if old.ai_enabled and not new.ai_enabled → insert reason 'silenciada_por_asesor'` con `to_kind` ya calculado (`human` si asignada, `unassigned` si no) — cubre TAMBIÉN la pausa manual de `setAiEnabled(false)` (`mutations.ts:200-219`), que hoy no deja fila; (2) rama `reclamado` + `and auth.uid() is not null` (hallazgo 1). CHECK de `reason` recibe `silenciada_por_asesor`. `HandoffReason` (`handoffs.ts:43-143`) suma el valor; NO entra en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` (l.305-313).

**Trigger `handle_conversation_ai_resume`.** Sin cambios: la escalada ahora pasa de "IA on, sin asesor" a "IA on, con asesor" — sale del estado, no entra; sin asesor no cambia nada (`old.ai_enabled and old.assigned_agent_id is null` verdadero → no sella). Verificar con un caso en el test SQL.

**Reconciliador y botón de atraso** (hallazgo 2): `reconciler.ts:148-163` y `unansweredFreeWork` (`data.ts:2413-2426`) suman `.or("last_message_direction.eq.inbound,last_message_status.eq.failed")`. Decisión: chats ASIGNADOS sin respuesta humana NO se reencolan (el humano es el dueño; la IA responde a lo que llegue por el webhook, que ya encola siempre). Un `entrega_fallida` en un chat asignado lo recoge el asesor (se ve atascado a 60 min laborales), no el reconciliador.

**UI.** `AiStatusBanner` (`ai-status-banner.tsx`) gana `waitingForHuman: boolean` (`chat-panel.tsx:288` pasa `Boolean(conversation.assignedAgent)`); con IA encendida y asesor asignado el texto es "Seba responde mientras el asesor no escriba; se apaga con tu primer mensaje". `conversation-list-item.tsx:115` ("La IA responde") ya es verdad bajo D2. `stageOf` (`dashboard.ts:227-243`) no cambia. `agent-control-view.tsx:369` ("en manos de la IA") sigue excluyendo asignadas: correcto.

**Reapertura (D2).** `route.ts:1084-1127`: el UPDATE pasa a `{ status: "open", ai_enabled: true, assigned_agent_id: null, welcome_sent_at: null }` con `.eq("status", "closed").select("id")`; solo si afectó una fila: evento "El cliente volvió a escribir" + `recordHandoff({ toKind: "ai", reason: "reabierta_por_cliente" })` (ya no hay ramas por `ai_enabled`/`assigned`). El trigger AFTER escribirá además `desasignada_por_asesor`/`devuelto_a_ia` con `created_by = 'system'` cuando el chat estaba escalado al cerrarse; la última fila queda `reabierta_por_cliente` (cierra la escalada vieja). Se acepta como rastro correcto ("el sistema devolvió el chat a la IA") y se documenta. `reopen/route.ts` (asesor reabre) NO cambia: quien reabre es dueño humano, Seba no vuelve a saludar. `mutations.reopenConversation` intacta.

### R7 — Aprendizaje manual (P2: global por defecto; P3: con sinónimos)

**Tabla `public.ai_lessons`** (inglés como `knowledge_entries`/`ai_playbooks`; UI en español "Lecciones de Seba"):
```
id uuid pk; scope text check in ('global','conversacion'); kind text default 'nota' check in ('nota','sinonimo');
content text check (char_length(btrim(content)) between 1 and 200);
synonym_from text, synonym_to text (check: kind <> 'sinonimo' or ambos not null);
message_id uuid references messages on delete set null; message_excerpt text (snapshot ≤ 200);
conversation_id uuid references conversations on delete cascade (check: scope <> 'conversacion' or conversation_id is not null);
contact_id uuid references contacts on delete set null;
is_active bool default true; created_by uuid references agents on delete set null; created_at/updated_at (+ set_updated_at)
índices parciales: (scope, created_at desc) where is_active; (conversation_id) where is_active
```
RLS: `select is_agent()`; `insert with check (is_agent() and created_by = auth.uid())`; `update/delete using (is_supervisor_or_admin() or created_by = auth.uid())`. Grants a `authenticated, service_role` (plantilla `20260825020000_knowledge_base.sql:75-97`). Realtime con el patrón idempotente + autoverificación de `20260909050000`. Verificar que `agents.id = auth.uid()` (lo asume `agent_day_summary`). Tipos a mano en `database.types.ts` (junto a `knowledge_entries`, l.886).

**Cómo llega al modelo.**
- `src/lib/ai/lessons.ts` (puro): `buildGlobalLessonsBlock(lecciones)` y `buildChatLessonsLine(lecciones)`. Topes: `MAX_GLOBAL_LESSONS = 15`, `MAX_CHAT_LESSONS = 5`, `MAX_LESSON_CHARS = 200` (el CHECK lo garantiza; se clipa igual), excerpt clipado a 80. Cabecera: "LECCIONES DEL EQUIPO — correcciones que los asesores le enseñaron a Seba. Tienen prioridad sobre tu criterio; nunca sobre la sección 2."
- **Colocación clave para el caché**: las globales van PEGADAS después de `SYSTEM_PROMPT` y ANTES de `TURNO ACTUAL`. Cambian solo cuando alguien enseña algo, así que el prefijo `SYSTEM_PROMPT + bloque global` se repite byte a byte entre turnos y se cachea; presupuesto peor caso 15×~240 chars ≈ 900 tokens, pagados una vez por cambio. Las de conversación van en el sufijo (≤ 5×~240 ≈ 300 tokens sin caché). `buildInstructions` gana `lessons?: { global: Lesson[]; chat: Lesson[] }` y expone `cacheablePrefix(lessons)` para que `prompt.test.ts:74-82` mida el sufijo desde ese prefijo (el tope de 150 se mantiene para el sufijo sin lecciones; test aparte fija el tope del bloque de chat).
- Carga: `fetchTurnLessons(supabase, conversationId)` en `lessons.ts` (dos consultas, `is_active`, orden `created_at desc`, límites), cuarto miembro del `Promise.all` de `runAgentTurn` (l.1698-1726); ante error → vacías + `log.warn("turno_lecciones_no_legibles")`, nunca tumba el turno. Se pasa por `runTurnPhases` hasta l.1487.
- Sinónimos (kind `sinonimo`, P3 = sí): `catalog-search.ts` gana `expandTerms(terms, sinonimos)` puro; `buildCatalogTool` lee los `sinonimo` activos (una consulta, límite 200) y expande antes de `catalogFilter`. NO se reutiliza `sinonimos_busqueda` (hallazgo 9).
- Cerradura: `createLesson` pasa `content` por `revealsIdentity` y lanza `LessonIdentityError` (mismo patrón que `PlaybookIdentityError`, `mutations.ts:508-525`); el texto final igual pasa por `applyIdentityGuard`.

**UI.**
- `message-context-menu.tsx`: opción "Enseñar a Seba…" (icono `GraduationCap`) cuando `agent` existe y el mensaje es entrante o `senderType === "ai"`; recibe `onTeach?: (message) => void` (mismo cableado que `onReply`: `message-bubble.tsx` → `chat-panel.tsx:329-343`).
- Nuevo `src/components/chat/teach-seba-modal.tsx`: cita del mensaje, textarea (maxLength 200 con contador), alcance "Todos los chats" / "Solo este chat" (default "Todos los chats", P2), opcional kind sinónimo (jerga → término). Llama `createLesson(supabase, agent, draft)`.
- Control IA: `AgentControlTab` (`agent-control-view.tsx:108`) suma `"lecciones"`; nuevo `lessons-panel.tsx` (lista con alcance, autor, fecha, extracto; activar/desactivar; borrar si supervisor o autor); realtime `.on("postgres_changes", { table: "ai_lessons" })` junto a l.315-316; `fetchLessons` en `data.ts` (al lado de `fetchKnowledgeEntries`, l.2198) y tipo `AiLesson` en `types.ts`.

### R8 — Sincronización con Saint / hojas de cálculo

FUERA de esta corrida por decisión D4. Cuando el operador explique la fuente
real, se planifica aparte (receptor genérico: endpoint seguro + código
externo por producto + upsert; o cron que lea una hoja publicada).

---

## 2. Tareas delegables (una por subagente Sonnet)

### Tanda 1 — migraciones (dos commits `[migración]`, en paralelo)

**T0 — `[migración] 20260917010000_seba_y_escalada_viva.sql`**
- `set local lock_timeout = '5s'` (aplicar con `psql -1 -v ON_ERROR_STOP=1`, como la 20260916010000).
- Backfill `welcome_sent_at` (hallazgo 4) + `comment on column` nuevo ("sello de que Seba se presentó").
- CHECK `conversation_handoffs.reason` = copia completa de `20260916010000:190-220` + `silenciada_por_asesor`.
- `create or replace function handle_conversation_ownership_change()` con la rama `silenciada_por_asesor` y `auth.uid() is not null` en `reclamado` (conserva ACL: no es security definer NUEVA).
- `create function handle_agent_message_silences_ai()` security definer + dos revokes + trigger `messages_agent_silences_ai_trigger AFTER INSERT ON messages`.
- Autoverificación (`pg_constraint`, `pg_trigger`, `has_function_privilege`).
- `supabase/tests/seba_y_escalada_viva.sql` (patrón `devolucion_a_la_ia.sql`: transacción con rollback, `_errores`, `created_at` explícitos): (1) escalada simulada con `service_role` (asigna sin tocar `ai_enabled`) → solo la fila `escalada` que escribe TS, ninguna `reclamado`; (2) mismo UPDATE con `request.jwt.claims` de un asesor → `reclamado`; (3) insert `agent` real → `ai_enabled=false` + fila `silenciada_por_asesor` to_kind `human`; (4) nota interna → no apaga; (5) `ai` o `system` → no apaga; (6) pausa manual → `silenciada_por_asesor` `unassigned`; (7) escalada con IA encendida no sella `ai_resume_cutoff_at`; (8) backfill: con `has_reply` sellado, sin él null.
- Paso nuevo en `.github/workflows/ci.yml` (copiar el bloque l.247-249).
- Doc: nota en `docs/PRODUCCION.md`.

**T1 — `[migración] 20260917020000_ai_lessons.sql`**
- Tabla, CHECKs, índices, trigger `set_updated_at`, RLS, grants, realtime idempotente con autoverificación; `comment on table/column`.
- `supabase/tests/ai_lessons.sql`: agente inserta con `created_by = auth.uid()`; otro agente no puede editar/borrar; supervisor sí; `scope='conversacion'` sin `conversation_id` rechazado; `content` > 200 rechazado; tabla publicada en `pg_publication_tables`.
- Paso de CI.

### Tanda 2 (en paralelo; no comparten archivos)

**T2a — Seba: nombre, textos fijos, guarda y prompt**
Archivos: `src/lib/brand.ts` (+`AI_NAME`), nuevo `src/lib/ai/seba.ts` + `seba.test.ts`, `src/lib/ai/saludo.ts` (+`isGreetingOnly`) + `saludo.test.ts`, `src/lib/ai/identity-guard.ts` + `identity-guard.test.ts`, `src/lib/ai/prompt.ts` (secciones 1, 3, 4, 5.1, 6, `MEDIA_RULES`, `buildInstructions`/`TurnContext.introducedThisTurn`) + `prompt.test.ts`, `src/lib/ai/tools.ts` solo `RECORDATORIO_SALUDO` (l.322-323), `src/components/chat/message-bubble.tsx:127` + test (opcional).
Tests: las tres franjas de `sebaGreeting` (con `now` fijo, nunca el reloj real — trampa del 14/9), `isGreetingOnly` (tabla: "hola", "Buenas tardes!", "hola tienen pastillas" → false), guarda (excepciones Seba, bloqueo de otros nombres, "asistente virtual" sigue bloqueado, "soy el asistente de SBK Motors" pasa), prompt estático (única pregunta, tres textos y motivos en 5.1, prefijo > 1024, `startsWith`, sufijo < 150, ninguna franja en `SYSTEM_PROMPT`, "no te presentes" en ambas ramas del sufijo, `revealsIdentity` sobre cada bloque).
Nota: `prompt.ts` importa las constantes de texto desde `seba.ts`; `seba.ts` no importa `server-only`.

**T4 — Escalada viva (D2/D3)**
Archivos: `src/lib/ai/escalate.ts` (+`alreadyAssigned`, sin `ai_enabled:false`, lectura previa) + `escalate.test.ts` (reescribir "asigna y pausa la IA" l.88 y "pausa la IA igual" l.148; casos nuevos: ya asignada no reclama ni deja traspaso, sí nota y `deal_status`), `src/lib/ai/handoffs.ts` (+`silenciada_por_asesor`) + `handoffs.test.ts`, `src/lib/ai/agent.ts` (guardas l.1774-1786, `stageFor` en seis sitios, `isAutoReply` en l.1429/1645 y en `runPlaybook`) + `agent.test.ts` (asignada+IA on corre y marca auto_reply; asignada+IA off → `asignada`; sin asignar+off → `pausada`; el escenario en chat asignado sale `is_auto_reply`; `journey_stage` queda `assigned`), `src/lib/ai/send.ts` (`sendPlaybookReply` con opciones) + `send.test.ts` (existe), `src/lib/ai/reconciler.ts` + `reconciler.test.ts` (no reencola cuando el último visible es saliente no fallido; sí cuando es `failed`), `src/lib/data.ts:2413` + `data-*.test.ts` correspondiente, `src/components/chat/ai-status-banner.tsx` + test, `src/components/chat/chat-panel.tsx:288`, `src/lib/ai/tools.ts:360` (descripción del tool; coordinar: T2a toca solo l.322-323 del mismo archivo — merge trivial).
Riesgo a vigilar: `agent.test.ts` tiene aserciones de que la escalada deja `ai_enabled: false` en `conversationUpdates`.

### Tanda 3

**T2b — El turno presenta a Seba y el webhook reabre encendiendo la IA**
Archivos: `src/lib/ai/agent.ts` (paso de presentación tras l.1172; `SendPhase` "presentacion"; borrar `needsGreeting` l.360-371; pasar `introducedThisTurn` en l.1487-1493; `AgentConversation.welcome_sent_at` ya viaja), `agent.test.ts` (fake: UPDATE condicional sobre `welcome_sent_at` devolviendo filas; casos: chat nuevo + pregunta → dos envíos en orden saludo→respuesta, el primero `is_auto_reply` true y el segundo no; chat nuevo + "hola" → un solo envío `is_auto_reply` false, sin `classifyIntent`; sellado → cero saludos; guarda de `deliver` bloquea → sello revertido; Meta rechaza → sello revertido; reescritura de l.2294-2300), `src/app/api/webhooks/whatsapp/route.ts:1084-1127` + `route.test.ts` (y espejo de fábricas en `new-contact-race.test.ts`/`welcome-race.test.ts` SOLO si el encadenado `.update().eq().eq().select()` no está soportado en sus fakes — trampa de CLAUDE.md), `src/lib/ai/turn-target.ts:28` (comentario).
Test del webhook: chat cerrado y escalado → UPDATE con los cuatro campos y `.eq("status","closed")`; handoff `reabierta_por_cliente` a `ai`; segundo mensaje concurrente (0 filas) → sin evento ni traspaso.

### Tanda 4

**T3 — Catálogo que escala y red de seguridad**
Archivos: `src/lib/ai/escalate.ts:19` (motivos), `src/lib/ai/tools.ts` (`CatalogOutcome`, instrucciones, enum, `results: []` con instrucción) + `tools.test.ts` (fake ya existe l.53-87; casos: con existencia → texto 3 + motivo; todos cero → texto 4; sin resultados → texto 2; genérico → pregunta de filtro y `generico=true`; con `motoModel` no es genérico; textos pasan `revealsIdentity`), `src/lib/ai/agent.ts` (red de seguridad tras l.1589; `buildCatalogTool(deps, catalogOutcome)` l.1467) + `agent.test.ts` (mockea tools: simular `catalogOutcome` lleno sin escalada → escala en código con el motivo correcto; genérico → no escala; texto sin "asesor" → se anexa el fijo).

### Tanda 5

**T5 — Lecciones: backend y prompt**
Archivos: `src/lib/supabase/database.types.ts` (+`ai_lessons`), `src/lib/types.ts` (+`AiLesson`), `src/lib/data.ts` (+`fetchLessons`, mapeo fila→tipo), `src/lib/mutations.ts` (+`createLesson`/`setLessonActive`/`deleteLesson`, `LessonIdentityError`) + `mutations.test.ts` (fake insert con `created_by`, `message_excerpt` recortado, identidad rechazada), nuevo `src/lib/ai/lessons.ts` + `lessons.test.ts` (puro: topes, clip, orden, bloque vacío → "" ; `fetchTurnLessons` con fake y con error), `src/lib/ai/prompt.ts` (`lessons`, `cacheablePrefix`) + `prompt.test.ts` (prefijo idéntico con las mismas globales; sufijo sin lecciones < 150; bloque de chat ≤ tope; `revealsIdentity` sobre un bloque de ejemplo), `src/lib/ai/agent.ts` (cuarta consulta en l.1698-1726, paso a `buildInstructions`) + `agent.test.ts` (fake `ai_lessons` vacío por defecto; con lecciones, `buildInstructions` las recibe; error → turno sigue).
T5c (P3 = sí, misma tarea): `catalog-search.ts` `expandTerms` + `catalog-search.test.ts` (expande "pastilla" → "pastilla|pastillas de freno", no duplica, ignora inactivos); `tools.ts` lee sinónimos activos (límite 200) y `tools.test.ts` prueba que un término de jerga encuentra el producto.

### Tanda 6 (en paralelo)

**T6 — Lecciones: UI**
Archivos: `src/components/chat/message-context-menu.tsx` (+`onTeach`) + `message-context-menu.test.tsx` (jsdom: aparece en entrante y en IA, no en salientes de asesor ni sin `agent`), nuevo `src/components/chat/teach-seba-modal.tsx` + test (jsdom: contador 200, alcance default "Todos los chats", llama `createLesson` con `messageId`/`conversationId`/`contactId`, error de identidad se muestra), `src/components/chat/message-bubble.tsx` y `chat-panel.tsx:329-343` (cableado, estado `teachingMessage`), `src/components/agent-control/agent-control-view.tsx` (tab `"lecciones"`, realtime, fetch) + `agent-control-view.test.tsx` (mock de `fetchLessons` en el espejo de mocks l.65), nuevo `src/components/agent-control/lessons-panel.tsx` + test, `agent-control.css`.
Verificación visual en Brave obligatoria antes de fusionar (memoria: jsdom no calcula layout; ver la trampa del fragmento de `AppRail`).

**T7 — Documentación**
`CLAUDE.md` (trampas nuevas: Seba se presenta por código y `welcome_sent_at` es su sello; la escalada ya no apaga la IA y quién sí la apaga; `reclamado` exige sesión; reconciliador y "último visible"; lecciones y el caché; `desasignada_por_asesor` con `created_by=system` en reapertura), `docs/GLOSARIO.md` (líneas de `seba.ts`, `lessons.ts`, `teach-seba-modal.tsx`, `lessons-panel.tsx`, actualizar `prompt.ts`/`tools.ts`/`escalate.ts`/`agent.ts`/`identity-guard.ts`/`reconciler.ts`), `docs/PRODUCCION.md` (las dos migraciones y el orden: migraciones ANTES del código — `silenciada_por_asesor` y el trigger de silencio son requisito de T4).

**Orden de commits:** T0, T1 (cada uno `[migración]`) → T2a → T4 → T2b → T3 → T5 → T6 → T7. Después de cada push, mirar el CI (API pública, ver CLAUDE.md Comandos).

**Prerrequisito de entrega:** los 3 commits de "La IA no vuelve a pedir lo que ya pidió" (`73ef4ac`…`aac9e74`) siguen sin push y su migración `20260916010000` sin aplicar en producción. Esta corrida se apoya en ese trigger; la entrega al VPS lleva las tres migraciones en orden (20260916010000 → 20260917010000 → 20260917020000), cada una con `psql -1 -v ON_ERROR_STOP=1`, ANTES del código.

---

## 3. Riesgos

- **Bucle del reconciliador sin asesor** (hallazgo 2): el predicado nuevo es la única barrera; `reconciler.test.ts` debe cubrir el estado exacto (`ai_enabled`, sin asignar, `awaiting_reply`, último visible saliente no fallido).
- **`reclamado` espurio** (hallazgo 1): si T4 sale antes que T0, cada escalada deja una fila `reclamado` y el test SQL viejo rompe. Orden obligatorio.
- **Modelo que no escala o parafrasea los textos fijos**: la red de seguridad cubre la escalada; el texto solo se garantiza si el modelo no menciona "asesor" (heurística). Medir en producción `agent_turns.summary` los primeros días.
- **Genérico mal detectado** (`> 3 resultados sin moto`): un catálogo con ≤ 3 pastillas no pregunta y escala directo — aceptable; un término amplio con modelo dado no pregunta (correcto).
- **Backfill de `welcome_sent_at`**: UPDATE masivo sobre `conversations` (tabla caliente) bajo `lock_timeout 5s`; conversaciones nunca contestadas recibirán el saludo en su próximo mensaje (decisión consciente).
- **Caché del prompt**: cada lección global nueva invalida el prefijo una vez; con 15 lecciones el prefijo crece ~900 tokens (cacheados). Las de chat se pagan siempre (≤ 300).
- **Fakes de tests de rutas en espejo** (CLAUDE.md Trampas): el cambio del UPDATE de reapertura puede exigir tocar tres fábricas.
- **`agents.id = auth.uid()`** para la RLS de `ai_lessons`: verificar en `20260819000001_initial_schema.sql`/`handle_new_agent()` antes de escribir la política.
- **Volumen en "Con asesor"** (D3 aceptada): casi toda consulta de inventario termina asignada round-robin. Medir los primeros días cuántas escaladas por hora recibe cada asesor.
- **Módulos sin cobertura que se tocan**: `chat-panel.tsx` y `message-bubble.tsx` tienen tests pero no del cableado del menú (T6 los agrega).

## 4. Cotejo final contra las exigencias del cliente (18/9/2026)

| # | Exigencia | Cómo la cumple el plan | Observación |
|---|---|---|---|
| 1 | Se llama Seba; saluda por hora; texto estricto al abrir o reabrir tras cierre | D1 + R1: el turno manda `sebaGreeting(dayBand(now))` literal, `welcome_sent_at` es el sello, el webhook lo anula al reabrir | La hora es la de Barinas (`America/Caracas`), no la del teléfono del cliente: WhatsApp no la expone. "buen [tarde/noche]" se rinde en español correcto: "buenas tardes"/"buenas noches". |
| 2 | Base confusa → "no manejo esa información" + asesor de inmediato | R2: `results: []` → `TEXTO_NO_IDENTIFICADO` + motivo `no_identificado`, con red de seguridad en código | Cubre el catálogo. Para lo que no es catálogo, la sección 4 del prompt ya manda escalar lo que no sabe. |
| 3 | Encontrado → precio y stock + texto literal + asesor | R3: `conExistencia` → texto literal + motivo `confirmar_inventario`, red de seguridad | Texto del cliente, byte a byte. |
| 4 | Stock 0 → texto + asesor | R4: todos en cero → `TEXTO_SIN_STOCK` + motivo `sin_stock` | Texto del cliente, byte a byte. |
| 5 | Única pregunta; genérico → una de filtro → asesor | Prompt sección 3 reescrita; `generico` en `CatalogOutcome` → pregunta de filtro sin escalar; con la respuesta busca y cae en 2/3/4, que escalan | Cumple. |
| 6 | Tras pasar al asesor sigue contestando; se calla en el instante en que el asesor escribe | D2 + R6: la escalada no apaga la IA; trigger `AFTER INSERT ON messages` con `sender_type = 'agent'` apaga `ai_enabled` en la misma transacción; `humanWroteMeanwhile` en `deliver()` corta un turno ya en vuelo | Sin asesor de noche sigue contestando (P1). |
| 7 | Clic derecho / botón sobre un mensaje para corregir; la IA lo lee y aprende palabras y compatibilidades | R7: `ai_lessons`, menú "Enseñar a Seba…", lecciones globales en el prefijo cacheable, sinónimos expanden la búsqueda del catálogo | No es "aprendizaje" del modelo: son instrucciones que el equipo escribe y la IA lee en cada turno. Es lo único viable sin reentrenar. |
| 8 | Consultar el Saint o las hojas de cálculo en tiempo real | FUERA (D4, por decisión del operador) | Hoy la IA ya lee `products` en vivo, sin caché; lo que no existe es la sincronía Saint → `products`. Se planifica cuando el operador explique la fuente. |

**Veredicto:** viable. Siete de ocho exigencias quedan cubiertas por este
plan; la octava está excluida a propósito y necesita información que el
cliente no ha dado (versión de Saint, base de datos o archivos, o qué hoja).

## 5. Criterios de cierre

- Suite completa en verde (`rtk npm run test`), `tsc`, lint y `rtk proxy npm run build` con `BUILD_ID` fresco.
- Los dos tests SQL nuevos en verde contra la base local y como pasos del CI.
- Mutaciones mínimas: quitar `auth.uid() is not null` de `reclamado` → test SQL (1) rojo; quitar el `.or(...)` del reconciliador → `reconciler.test.ts` rojo; quitar la excepción `(?!seba\b)` → `seba.test.ts` rojo.
- Escenario a mano en local: chat nuevo "hola" → solo el saludo de Seba; chat nuevo "tienen pastillas para bera sbr 2020" → saludo + cotización + escalada con `is_auto_reply`, IA sigue encendida; asesor escribe → `ai_enabled=false` + fila `silenciada_por_asesor`; cierre + mensaje del cliente → reapertura con IA encendida y saludo nuevo.
- Verificación visual en Brave del banner, del menú "Enseñar a Seba…" y de la pestaña Lecciones.
