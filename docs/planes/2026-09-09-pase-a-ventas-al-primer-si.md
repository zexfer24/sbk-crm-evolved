# Plan · El pase a ventas al primer sí

Corrida chica del 9/9/2026, sobre `origin/main` en `2fddce6` ("Seis frentes
del buzón", PR #2) — no sobre `sticker-y-aviso` (38b83ba), que sigue sin PR y
sin fusionar.

Este documento se escribió al cerrar la corrida, con las dos tareas de código
ya commiteadas (`2e5d0b7` y `f71848a`): es el registro de lo que se hizo y por
qué, en el formato de los planes anteriores, no un plan previo a implementar.

## El problema en producción

T2 del plan "Seis frentes del buzón" (8/9/2026) le había puesto a la IA una
segunda confirmación antes de pasar un caso a ventas: el primer "sí" del
cliente no bastaba, había que pedirle que lo confirmara y recién con un
segundo "sí" LITERAL se llamaba a la herramienta de escalar
(`handoff-confirmation.ts`, sellando
`conversations.handoff_confirmation_pending_at`).

En producción esa reconfirmación se rompió: el cliente no repite la palabra
"sí", contesta "ok", "está bien" o "dale" al primer paso hacia el cierre. El
modelo no contaba esos sinónimos como el segundo "sí" que el prompt exigía
textualmente, y la conversación quedaba dando vueltas pidiendo confirmación
sin escalar nunca.

## Decisión del operador (9/9/2026)

Eliminar la doble confirmación por completo y volver a escalar con el primer
aviso — igual que ya escalan devolución y queja, que nunca pasaron por esta
puerta.

## Tareas

### 1 · Borrar la máquina de estados en código

Archivos: `src/lib/ai/handoff-confirmation.ts` y su test (borrados),
`src/lib/ai/tools.ts` (+ `tools.test.ts`), `src/lib/ai/escalate.ts`
(+ `escalate.test.ts`), `src/lib/ai/agent.ts` (+ `agent.test.ts`),
`src/lib/ai/turn-target.ts`, `src/lib/ai/turn-correlation.test.ts`.

`buildEscalateTool` perdió la rama `if (motivo === "intencion_compra")` y
`SALES_HANDOFF_PENDING_INSTRUCTION`: los tres motivos
("devolucion", "queja", "intencion_compra") caen ahora directo en
`escalateConversation`, con el primer aviso. Salieron los campos
`lastCustomerMessageAt`/`handoffConfirmationPendingAt` de `ToolDeps`, el
`handoff_confirmation_pending_at: null` del update en `escalate.ts` (ya no
hay ningún sello que limpiar), las dos propiedades que `agent.ts` armaba en
`deps` y la columna en su `.select(...)`, y el campo homónimo en
`AgentConversation` (`turn-target.ts`).

La columna `conversations.handoff_confirmation_pending_at` (migración
`20260909010000`) se queda en la base sin uso, a propósito.

### 2 · Sacar la reconfirmación del prompt

Archivo: `src/lib/ai/prompt.ts` (+ `prompt.test.ts`).

`SALES_HANDOFF_RULES` se reemplaza por `SALES_ACCEPTANCE_RULES` — misma
forma que `MEDIA_RULES`, exportada aparte para pasarla sola por
`revealsIdentity`. La sección 3 ahora manda pasar el caso de una vez sin
pedir una segunda confirmación, y nombra explícitamente las formas de
aceptar que no son un "sí" literal: "ok", "está bien", "dale", "listo",
"claro", "por favor", un pulgar arriba — la causa real del bucle. La sección
5.1 y el párrafo de fuera de horario vuelven a mandar escalar directo con
motivo `intencion_compra`, sin remitir a ninguna reconfirmación.

## Orden de commits

1. `2e5d0b7` — la máquina de estados en código (tarea 1).
2. `f71848a` — el prompt (tarea 2), sobre el commit anterior.

Sin migración nueva en ninguno de los dos: la columna ya estaba aplicada.

## Verificación

Por cada tarea: suite del módulo tocado en verde y prueba de mutación
verificada a mano.

- Tarea 1: `tools.test.ts`, `escalate.test.ts`, `agent.test.ts`,
  `turn-correlation.test.ts` reemplazan sus describes de reconfirmación por
  uno que prueba lo contrario (la primera llamada escala directo). El fake
  de Supabase en `tools.test.ts` revienta si `buildEscalateTool` toca
  `conversations`/`messages` por su cuenta, para confirmar que ya no hay
  escritura propia antes de `escalateConversation`.
- Tarea 2: prueba de mutación agregando "confirma dos veces" de vuelta al
  `SYSTEM_PROMPT` — rompe el test nuevo de `prompt.test.ts` — revertida con
  `cp` desde una copia de respaldo, nunca con `git checkout --`.

## Decisiones tomadas

- La columna `conversations.handoff_confirmation_pending_at` se queda sin
  migración de reversa: `drop column` es irreversible y ya está aplicada en
  producción; dropearla es una operación aparte que no le corresponde a esta
  corrida.
- `database.types.ts` conserva el campo a propósito, porque el esquema real
  de la base todavía lo tiene, aunque nadie lo lea ni lo escriba.
- La rama sale de `origin/main` (`2fddce6`), no de `sticker-y-aviso`
  (`38b83ba`), que sigue sin PR.

## Entrega

Sin variables de entorno nuevas, sin migración. Dos commits de código puro
más este plan y el glosario. Producción sigue atrás de `2fddce6`; el reporte
de entrega se calcula preguntando primero en qué commit está el VPS.
