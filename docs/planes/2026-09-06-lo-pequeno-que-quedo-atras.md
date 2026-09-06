# Plan · Lo pequeño que quedó atrás

Corrida chica del 6/9/2026, después del push de `1379b2c` ("El reloj dice la
verdad"). Base: `main` en `1379b2c` (= `origin/main`; producción sigue en
`26d356d`, con las dos corridas anteriores pendientes de aplicar en el VPS).

Origen: cuatro deudas anotadas en planes y reportes anteriores que no
justificaban una corrida propia y que, juntas, sí. Ninguna cambia el
comportamiento que ve el cliente; tres cambian lo que ve el equipo (bitácora,
log del servidor, formulario del horario) y una es un índice.

Este documento se escribió DESPUÉS de implementar las cuatro tareas —la
corrida quedó a medio cerrar en el árbol de trabajo, sin commits— y es el
registro de lo que se hizo y por qué, en el formato de los planes anteriores.

## Decisiones del operador (6/9/2026)

- D1 va en commit aparte con `[migración]` en el título, como decidió el
  30/8/2026 (ver `docs/planes/2026-09-05-el-reloj-dice-la-verdad.md`, deuda 7).
- D2: las dos guardas del mismo apagado global escriben la MISMA razón en
  `conversation_handoffs`. `pausada` queda solo para el `ai_enabled` del chat.
- D3: un error de la base en una herramienta del tool loop deja rastro en el
  log del servidor. La respuesta al modelo no cambia.
- D4: las franjas solapadas se rechazan en el formulario, no en
  `parseBusinessHours`: si el parser rechazara el jsonb, el turno de la IA
  caería al horario por defecto en silencio. No se reordenan solas.

## Tareas

### D1 · `conversations_pending_idx` también ordena por `id`

Archivo: `supabase/migrations/20260906020000_conversations_pending_idx_id.sql`.

Dropea y recrea el índice de "Pendientes" como
`(last_message_at desc nulls last, id desc) where awaiting_reply and status
<> 'closed'`. Mismo predicado; ahora calza el orden completo que pide
`fetchConversations` (`src/lib/data.ts`), el mismo desempate que
`20260829010000` le dio a los otros tres índices de la bandeja. Sin backfill,
sin código de app; aplicable en caliente. Verificado en local con
`enable_seqscan = off`: Index Scan sin `Sort`, hacia adelante y Backward.

Cierra la nota del 30/8/2026 ("no urgente, medido sub-milisegundo en
producción").

### D2 · La guarda de `deliver()` dice por qué se calló

Archivos: `src/lib/ai/agent.ts`, `src/lib/ai/handoffs.test.ts`.

`stillEnabled` vuelve a consultar la RPC `agent_can_run` (interruptor global
+ tope de gasto del día) a mitad de turno. Escribía `pausada` en la bitácora;
la otra guarda del mismo hecho, en `openTurn`, escribía
`agente_no_puede_correr`. Ahora las dos escriben `agente_no_puede_correr`.
El test existente cambia de nombre y de razón esperada.

### D3 · Un error de la base en una herramienta deja rastro

Archivos: `src/lib/ai/tools.ts`, `src/lib/ai/knowledge.ts`,
`src/lib/ai/tools.test.ts`, `src/lib/ai/knowledge.test.ts` (nuevo).

`buildCatalogTool`, `buildOrderHistoryTool` y `buildKnowledgeTool` devolvían
al modelo "No se pudo consultar…" y se tragaban el `error` de Supabase. El
5/9/2026 se buscó a ciegas el rastro de un "catálogo fuera de servicio" que
resultó ser el interruptor por herramienta apagado; un error real de la base
tampoco habría dejado nada. Ahora cada una hace `log.error` con
`herramienta_catalogo_fallo` / `herramienta_historial_fallo` /
`herramienta_biblioteca_fallo`, `conversationId` y `detail`.
`buildKnowledgeTool` gana `conversationId` en sus deps (todos los llamadores
ya lo tenían).

Tests: por cada herramienta, con un Supabase falso que devuelve `error`, se
verifica (a) que la respuesta al modelo es la de siempre (lista vacía +
mensaje) y (b) que `log.error` recibió el evento y el `conversationId`. Y el
camino feliz sigue sin escribir en el log.

### D4 · El panel de horario rechaza franjas solapadas

Archivos: `src/components/agent-control/business-hours-panel.tsx` (+ test).

Dos franjas solapadas suman dos veces los minutos en común en
`businessMinutesBetween` (`business-hours.ts`), y eso adelanta el umbral de
60 min laborales que pinta "Con asesor" en rojo en el tablero. Si la segunda
franja empieza antes de que termine la primera —incluidas las que vienen al
revés— la fila muestra "Las franjas se solapan." y Guardar queda
deshabilitado. Contiguas (fin de la primera = inicio de la segunda) son
válidas. Tres tests nuevos.

## Orden de commits

1. `[migración]` D1, solo.
2. D2 (`agent.ts` + `handoffs.test.ts`).
3. D4 (`business-hours-panel.tsx` + test) más este plan.
4. D3 (`tools.ts`, `knowledge.ts` y sus tests), último porque sus tests se
   escribieron al cierre, por un subagente aparte.

Cada commit lleva su propia fila del glosario.

## Verificación

- `rtk npx tsc --noEmit` limpio.
- Suite completa en verde.
- Base local reconstruida con las migraciones (`db reset` o `docker exec`)
  y `explain` del orden de "Pendientes" sin `Sort`.

## Entrega

Sin variables de entorno nuevas. Una migración (D1), aplicable en caliente.
Producción sigue en `26d356d`: el reporte de entrega se calcula sobre ese
rango, preguntando antes si el VPS ya avanzó.
