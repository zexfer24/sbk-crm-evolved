# Anexo · Bandeja que no pierde — dos hallazgos de la corrida

Aprobado por el operador el 5/9/2026, sobre `main` local en `ef168bd` (la
corrida completa del plan `2026-09-04-bandeja-que-no-pierde.md`, 19 commits,
sin push). Producción sigue en `26d356d`.

Origen: el reporte de entrega de la corrida dejó dos hallazgos que cambiaban
el plan y que el orquestador, correctamente, no aplicó solo. El operador los
aprobó los dos. Este anexo es la fuente de verdad de esa corrección; se
ejecuta con la misma metodología y las mismas "Reglas para todos" del plan
original (sección homónima de ese archivo, que cada subagente recibe
literal). Ninguna de las dos tareas trae migración.

---

## Por qué

**Hallazgo 1.** Cuando la IA escala y no hay ningún asesor activo, le manda
al cliente una cortesía ("Ya dejé tu caso registrado… en cuanto haya alguien
disponible te escriben por acá"). Ese mensaje entra por `sendAgentText` como
un saliente `ai` visible y normal, así que el trigger `handle_new_message`
(20260905010000) lo toma como **respuesta real**: mueve `last_reply_at` y
apaga `awaiting_reply`. Consecuencias: la conversación sale de "Pendientes",
no entra en "Sin dueño" (`isUnassignedLead` exige `awaiting_reply`), no la
cuenta `unassigned_waiting_count()` en `api/health`, y el chip de la ventana
de 24 h desaparece. Solo la píldora "Escaladas" la sigue mostrando, gracias
a la pata `lastReplySender !== "agent"` de su predicado. Pero el cliente
sigue esperando exactamente igual que antes de la cortesía: nadie de carne y
hueso le ha contestado. Es la definición misma de lead invisible, y va contra
la invariante.

**Hallazgo 2.** Cuando un asesor cerró una conversación que ya era suya
(`assigned_agent_id` puesto, IA apagada) y el cliente vuelve a escribir, el
webhook la reabre y deja `reabierta_por_cliente` con destino `unassigned`
(literal del plan T2.1). Acto seguido la cola encola el turno, `openTurn`
evalúa `!convo.ai_enabled` ANTES que `convo.assigned_agent_id` y registra
`pausada` → `unassigned` otra vez. Resultado: la conversación aparece en
"Mías" del asesor (correcto) y a la vez en "Sin dueño" (falso positivo), y
la bitácora dice que nadie la tiene cuando sí tiene dueño. Ruido en la
píldora y en el KPI de salud, y una bitácora que miente.

## Orden de ejecución

Secuencial: **A1 → A2**. Las dos tocan `supabase/tests/invariante_leads.sql`
y su gemelo `src/lib/invariante-leads-contrato.test.ts` (cada una suma un
caso y mueve el `esperado`), así que en paralelo chocarían. Cada tarea cierra
con `tsc` + lint + suite completa + los `.sql` de `supabase/tests` contra la
base local antes de abrir la siguiente. Un commit por tarea, hecho por el
orquestador.

---

### A1 · La despedida de la IA al escalar sin asesores no cuenta como respuesta real

**Decisión:** ese mensaje se guarda con `is_auto_reply = true`, la misma
marca que ya lleva la plantilla de bienvenida (T0.1). El trigger ya sabe qué
hacer con ella: no mueve `last_reply_at`, así que `awaiting_reply` sigue en
`true`, la conversación se queda en "Pendientes", entra en "Sin dueño" (su
último traspaso es `escalada_sin_asesor` → `unassigned`, que `escalate.ts`
ya deja desde T0.3), la cuenta `unassigned_waiting_count()`, y el chip de 24 h
sigue corriendo. Sin migración: la columna existe desde 20260905010000.

**Qué NO cambia:** la IA sigue diciéndole al cliente exactamente lo mismo y
sigue apagándose (`ai_enabled = false`) al escalar. El reconciliador no la
va a "rescatar" hacia la IA: su consulta exige `ai_enabled = true`
(`reconciler.ts`). Un mensaje posterior del cliente encola un turno que sale
por `pausada` sin enviar nada, como hoy.

**Archivos:**
- `src/lib/ai/tools.ts`: `EscalationOutcome` gana `unassigned?: boolean`;
  `buildEscalateTool` lo copia de `result.unassigned` junto con los otros
  campos del outcome.
- `src/lib/ai/send.ts`: `sendAgentText(supabase, target, text, opciones?)`
  con `opciones: { isAutoReply?: boolean }`; el insert lleva
  `is_auto_reply: opciones?.isAutoReply ?? false`. Firma compatible con los
  tres llamadores actuales (`agent.ts` ×2, `sendPlaybookReply`). Comentario
  con el porqué y la fecha (5/9/2026, anexo A1).
- `src/lib/ai/agent.ts`, tool loop: la red de seguridad de
  devolución/queja copia también `outcome.unassigned = forced.unassigned`;
  el envío final pasa `{ isAutoReply: outcome.escalated &&
  outcome.unassigned === true }`. Cubre los DOS caminos por los que la IA se
  despide sin asesor: el texto fijo de la red de seguridad y el que redacta
  el modelo tras recibir `instruccionParaTuRespuesta` de la herramienta.
  Comentario que explique que una despedida sin nadie detrás no es una
  respuesta: el cliente sigue esperando a una persona.
- `src/lib/inbox-filters.ts`, caso `"escalated"`: actualizar el comentario
  (la despedida ya no apaga `awaiting_reply` desde A1; la pata
  `lastReplySender !== "agent"` SE CONSERVA igual, porque sigue cubriendo
  conversaciones escaladas históricas y cualquier otra respuesta de la IA
  previa a la escalación).
- `supabase/tests/invariante_leads.sql`: **caso 7** "escalada sin asesores y
  la IA se despidió con `is_auto_reply`: CUENTA". Contacto y conversación
  nuevos (…107 / …0007). Para que sea el trigger quien decida —no un valor
  escrito a mano en `last_reply_at`—, insertar en `public.messages` un
  entrante del cliente y después un saliente `ai`, `text`, visible, con
  `is_auto_reply = true` y `whatsapp_status = 'sent'`; traspaso
  `unassigned` / `escalada_sin_asesor`. Afirmar que `awaiting_reply` quedó
  `true` y que cuenta. `esperado` pasa de 2 a 3; la lista de ids permitidos
  del bucle final suma …0007. Actualizar el comentario de cabecera (siete
  contactos).
- `src/lib/invariante-leads-contrato.test.ts`: caso 7 gemelo, con el mismo
  nombre. En TypeScript el hecho "la despedida no apagó awaiting_reply" es
  el `true` del primer argumento; el traspaso es `traspaso("unassigned",
  n)`.
- `docs/GLOSARIO.md`: líneas de `tools.ts`, `send.ts`, `agent.ts`,
  `inbox-filters.ts`, `invariante_leads.sql` / `invariante-leads-contrato`.
- `CLAUDE.md`, trampa de `has_reply`/`awaiting_reply`: una frase al final
  del párrafo de 20260905010000: la despedida de la IA al escalar sin
  asesores también es `is_auto_reply` (anexo A1, 5/9/2026) y por eso NO
  apaga `awaiting_reply`.

**Fuera de alcance (deuda documentada, no hacer):** un escenario con
`afterSend = "escalate"` cuando no hay asesores. Su mensaje sale ANTES de
escalar (`sendPlaybookReply` → `escalateConversation`, y T0.3 exige ese
orden: nada acompaña a un mensaje que Meta rechazó), y el trigger de
`messages` solo recalcula `last_reply_at` cuando `whatsapp_status` pasa a
`failed`, no cuando `is_auto_reply` cambia. Marcarlo después exigiría una
migración que amplíe `handle_message_status_change`. Se anota en el reporte
final; la píldora "Escaladas" lo sigue mostrando mientras tanto.

**Tests (mismo commit):**
- `send.test.ts`: `sendAgentText` sin opciones inserta `is_auto_reply:
  false`; con `{ isAutoReply: true }` inserta `true`.
- `agent.test.ts`: (a) red de seguridad de queja sin asesores
  (`escalateConversationMock` devuelve `{ escalated: true,
  assignedAgentName: null, unassigned: true }`, modelo sin texto) →
  `sendAgentTextMock` recibe el texto fijo Y `{ isAutoReply: true }`; (b) el
  modelo llama a la herramienta `escalarAAsesor`, la escalación queda sin
  asesor y el modelo redacta su propia despedida → `isAutoReply: true`
  (mirar cómo el archivo ya simula la llamada a la herramienta en los tests
  de T0.3 alrededor de la línea 1580); (c) escalación CON asesor →
  `isAutoReply` falso o ausente; (d) respuesta normal sin escalar → sin la
  marca.
- Los tests SQL (`invariante_leads.sql`, y `awaiting_reply.sql` sin
  cambios) por `psql`/`docker exec` contra la base local.

**Mutación manual (la corre el orquestador):** quitar el `isAutoReply` del
envío final en `agent.ts` → (a) y (b) en rojo; revertir.

**Terminado cuando:** todo en verde; la consulta 1 de "Medir antes y
después" del reporte de entrega sigue dando 0 sobre el seed; una escalación
sin asesores simulada con `api/dev/simulate-message` aparece en "Pendientes"
y "Sin dueño" además de "Escaladas".

---

### A2 · La reapertura por el cliente devuelve la conversación a su asesor

**Decisión:** si la conversación cerrada tenía `assigned_agent_id`, el
webhook deja `reabierta_por_cliente` → `human` con ese `toId`; si la IA
estaba encendida, `ai` como hoy; solo sin ninguno de los dos, `unassigned`.
Y `openTurn` (`agent.ts`) comprueba `assigned_agent_id` ANTES que
`ai_enabled`, para que un chat con dueño y la IA apagada registre `asignada`
→ `human`, no `pausada` → `unassigned`. El efecto observable del turno
—`return` sin enviar nada— no cambia; solo cambia qué dice la bitácora. Sin
migración: `to_kind = 'human'` y `reason = 'asignada'` existen desde
20260830040000.

**Archivos:**
- `src/app/api/webhooks/whatsapp/route.ts`: el `select` de la conversación
  existente suma `assigned_agent_id` (y el tipo del `maybeSingle`); el
  `recordHandoff` de la reapertura decide `ai` / `human`+`toId` /
  `unassigned` en ese orden. Actualizar el comentario de T2.1 justo encima.
- `src/lib/ai/agent.ts`, `openTurn`: invertir el orden de las dos guardas
  (`assigned_agent_id` primero, luego `ai_enabled`). Reescribir el
  comentario que hoy dice "el orden de evaluación […] queda idéntico a
  antes": ahora explica que el orden cambió el 5/9/2026 (anexo A2) porque un
  chat con dueño y la IA apagada —que es el estado normal tras una
  escalación o un cierre— quedaba en la bitácora como sin dueño.
- `supabase/tests/invariante_leads.sql`: **caso 8** "cerrada, el cliente
  volvió y la conversación tenía asesor: NO CUENTA". Contacto …108,
  conversación …0008 con `assigned_agent_id` a un perfil de prueba (insertar
  el `profiles`/usuario mínimo que exija la FK, mirando cómo lo resuelven
  `pins.sql` o el seed) y `awaiting_reply` en `true` (esperando, pero con
  dueño); traspasos `closed` / `cerrada_por_asesor` y después `human` /
  `reabierta_por_cliente` con `to_id`. Afirmar que NO cuenta. `esperado` no
  cambia respecto a A1 (sigue en 3); el bucle final no debe listarla.
  Actualizar el comentario de cabecera (ocho contactos).
- `src/lib/invariante-leads-contrato.test.ts`: caso 8 gemelo:
  `isUnassignedLead(true, [traspaso("closed", 180), traspaso("human", 10)])`
  es `false`.
- `docs/GLOSARIO.md`: líneas de `webhooks/whatsapp/route.ts`, `agent.ts`,
  la fila "Cerrar/reabrir una conversación (T2.1)", `invariante_leads.sql` /
  `invariante-leads-contrato`.

**Tests (mismo commit):**
- `route.test.ts` (webhook): caso nuevo en el `describe` de T2.1: `status:
  "closed", ai_enabled: false, assigned_agent_id: "agent-7"` → traspaso
  `p_to_kind: "human"`, `p_to_id: "agent-7"`, `p_reason:
  "reabierta_por_cliente"`. Los dos casos existentes siguen igual (la fila
  por defecto de la fábrica debe traer `assigned_agent_id: null`). Revisar
  que las fábricas espejo (`new-contact-race.test.ts`,
  `welcome-race.test.ts`) no afirmen la cadena exacta del `select`; si lo
  hacen, actualizarlas en espejo.
- `handoffs.test.ts`: junto a "pausada: con ai_enabled=false en el chat" y
  "asignada: con un asesor ya asignado", un tercer caso: `ai_enabled=false`
  Y `assigned_agent_id` puesto → `asignada` / `human` / `toId`, y NINGÚN
  `pausada`.
- `agent.test.ts`: el test "con ai_enabled=false en el chat, no corre nada y
  no deja ningún evento en el registro" sigue verde sin tocarlo (no tiene
  asesor); su comentario menciona una línea que ya no existe tal cual —
  actualizarlo si describe el orden viejo.
- Tests SQL por `psql`/`docker exec` contra la base local.

**Mutación manual (la corre el orquestador):** volver a poner `ai_enabled`
antes que `assigned_agent_id` en `openTurn` → el caso nuevo de
`handoffs.test.ts` en rojo; quitar `assigned_agent_id` del `select` del
webhook → el caso nuevo de `route.test.ts` en rojo; revertir ambas.

**Terminado cuando:** todo en verde; con el stack local, cerrar desde la
cabecera una conversación asignada a un asesor y mandarle un mensaje
simulado la devuelve a "Pendientes" y "Mías" del asesor, y NO a "Sin dueño".

---

## Verificación final del anexo (orquestador)

1. `npx tsc --noEmit`, `npm run lint`, `npm run test -- --no-file-parallelism`.
2. `supabase db reset` y los seis `.sql` de `supabase/tests`.
3. Las dos mutaciones manuales de arriba.
4. `rtk proxy npm run build` y el timestamp de `.next/BUILD_ID`.
5. Actualizar el artefacto "Bandeja que no pierde · Entrega": los dos
   hallazgos pasan de "cambia el plan, no aplicado" a "corregido en el
   anexo" con sus commits; sumar la deuda del escenario con
   `afterSend = "escalate"` sin asesores; el reporte por commit para el VPS
   suma los tres commits nuevos (anexo, A1, A2), ninguno con migración ni
   variable de entorno nueva; producción sigue en `26d356d`.

## Fuera de alcance

- La deuda de T1.6, T3.2 y T3.3 del reporte de entrega (fila sin motivo del
  fallo, SKU crudo en pedidos, cabecera de plantilla con variable). Corrida
  aparte, cuando el operador confirme si alguna plantilla aprobada lleva
  variable en la cabecera.
- Renombrar la razón `pausada` que `deliver()` escribe cuando el interruptor
  GLOBAL se apaga a mitad de turno (`stillEnabled` lee `agent_can_run`, no el
  `ai_enabled` del chat; el nombre confunde pero el destino `unassigned` es
  correcto: sin IA global y sin asesor, nadie la tiene).
