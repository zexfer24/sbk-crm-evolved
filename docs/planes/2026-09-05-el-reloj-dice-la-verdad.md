# Plan · El reloj dice la verdad

Aprobado con decisiones del operador el 5/9/2026. Base: `main` en `01e0943`
(local, sin push; producción sigue en `26d356d`). Origen: el documento
"Recorrido del cliente, por dentro" (artefacto del 5/9/2026) y el pedido de
cierre de entrega: (1) que "Atascados" cuente solo lo que de verdad está
atascado, (2) que la IA sepa si es mañana, tarde o noche y cuál es el
horario de trabajo, (3) auditoría de la bandeja.

Decisiones del operador (5/9/2026):
- **El recorrido es**: Primer contacto (primera vez que escribe, se le manda
  la bienvenida y se espera su siguiente mensaje) → Consulta (el cliente
  pregunta y espera respuesta) → Clasificando (la IA, si está activa,
  determina la intención) → Herramienta (la IA usa una herramienta, p. ej.
  busca en inventario) → Con asesor (la IA asignó a un asesor disponible o
  el asesor tomó el chat). Sin columna nueva.
- **Fuera de horario la IA sigue vendiendo**; cobros y el resto del proceso
  para concretar la venta los hace un asesor: la IA le explica al lead que
  pasará la conversación al departamento de ventas y que en el horario
  regular su venta será procesada.
- **El agente de IA se modifica de último** (Frente B3–B5 cierra la corrida).
- **Frente C completo** (C1, C2, C3).
- Supuestos del orquestador, corregibles desde el panel o en una línea:
  horario default L–V 08:00–18:00 (sábado y domingo cerrado, es lo que dice
  el seed); umbral de "Con asesor" = 60 minutos DE HORARIO LABORAL (antes
  24 h de pared); una conversación donde la IA ya respondió y el cliente
  calla se queda en "Consulta" en gris, nunca atascada.

Este archivo es la fuente de verdad de la implementación. El orquestador
reparte una tarea por subagente y cada subagente recibe SOLO su sección más
las "Reglas para todos".

---

## Reglas para todos (orquestador y subagentes)

- Metodología `liminalwork`: el orquestador no implementa; delega, valida el
  reporte, corre la suite completa él mismo y hace el commit. Un subagente
  por tarea, contexto limpio, modelo Sonnet con razonamiento alto.
- Todo en español: comentarios que cuentan el porqué y la fecha (5/9/2026),
  logs vía `lib/log.ts`, UI en español de Venezuela (nada de voseo).
- **Los subagentes NO hacen commit, NO editan `docs/GLOSARIO.md` ni
  `CLAUDE.md`**: entregan en su reporte la línea de glosario propuesta por
  archivo tocado y el orquestador la aplica al commitear. Motivo: varios
  subagentes corren en paralelo sobre el mismo árbol.
- Cada subagente toca SOLO los archivos de su sección. Si necesita tocar
  otro, lo dice en el reporte y no lo hace.
- Un cambio de lógica trae su test al lado del módulo. Antes de cerrar, el
  subagente corre `rtk npx vitest run <sus archivos de test>`, `rtk npx tsc
  --noEmit` y `rtk npm run lint`, y pega el resultado en el reporte. La
  suite completa la corre el orquestador.
- **Cada migración va en su propio commit con `[migración]` en el título**,
  antes del código que la usa. Nombre `supabase/migrations/20260906NN0000_*.sql`.
- La invariante "ningún lead invisible" sigue vigente: ningún `return` de
  `lib/ai/` abandona una conversación sin su fila en `conversation_handoffs`.
- Trampas vigentes de `CLAUDE.md`: `rtk next build` miente (compilar con
  `rtk proxy npm run build`); un `vi.mock` con `importOriginal()` arrastra
  el grafo entero; las tres fábricas del webhook se mantienen en espejo;
  `has_reply` es vitalicio y no sirve como corte.
- Sin `git push`, sin tocar producción, sin `supabase db push`.
- Reporte obligatorio al terminar: (1) qué implementó y qué decidió sobre la
  marcha, (2) archivos creados/modificados con la línea de glosario
  propuesta para cada uno, (3) salida de los tests/tsc/lint, (4) desvíos,
  deuda o dudas.

## Orden de ejecución

1. **Tanda 1 (paralela, independientes)**: B1, B2, A3, C1, C2, C3.
2. **Tanda 2**: A1 (necesita B2 en el árbol).
3. **Tanda 3**: A4 (necesita A1).
4. **Tanda 4 (el agente, de último)**: B3 → luego {B4, B5} en paralelo.
5. Verificación final y reporte de entrega.

Cada tanda cierra con `tsc` + lint + suite completa en verde antes de abrir
la siguiente; las migraciones además con `supabase db reset` (o `docker
exec` al Postgres si la CLI falla) y los `.sql` de `supabase/tests`.

---

## FRENTE B · La IA sabe qué hora es y cuál es el horario

### Diagnóstico

La hora llega al modelo como texto ("viernes, 5 de septiembre de 2026,
4:45 p. m.") en el bloque `TURNO ACTUAL` de `prompt.ts`, y la regla de qué
saludo va con qué hora está en prosa en la sección 6 del `SYSTEM_PROMPT`.
El modelo tiene que leer "4:45 p. m." y deducir "tarde" él solo; a veces no
lo hace. `greeting-window.ts` ya resuelve la franja de forma determinista
para los escenarios (`playbooksAtTime`), pero el flujo genérico no la
recibe. El horario de trabajo NO existe en el sistema: solo como texto en
una respuesta rápida del seed y en lo que haya en la biblioteca.
`escalate.ts` elige "asesor activo" por `agents.is_active` (cuenta
habilitada), no por turno. La despedida al escalar sin asesores no puede
decir cuándo lo atienden porque no sabe cuándo abre la tienda.

### B1 · [migración] La configuración del agente guarda el horario de la tienda

Archivo: `supabase/migrations/20260906010000_agent_settings_business_hours.sql`.
Sin TypeScript.

- `alter table public.agent_settings add column business_hours jsonb not null
  default '{"mon":[["08:00","18:00"]],"tue":[["08:00","18:00"]],"wed":[["08:00","18:00"]],"thu":[["08:00","18:00"]],"fri":[["08:00","18:00"]],"sat":[],"sun":[]}'::jsonb`.
  Forma: lista de franjas `[inicio, fin]` en `HH:MM` por día (permite
  horario partido); lista vacía = cerrado.
- `alter table ... add constraint agent_settings_business_hours_object check
  (jsonb_typeof(business_hours) = 'object')`.
- `comment on column` diciendo que las horas son locales de `America/Caracas`
  (la zona vive en `src/lib/time-zone.ts`, no acá), que la IA lo lee en
  cada turno y el tablero lo usa para medir el atasco de "Con asesor".
- RLS no cambia: `agent_settings_update` ya exige supervisor/admin
  (migración 20260820050000), lectura para cualquier agente. Sin funciones
  `security definer`.
- Test de base `supabase/tests/business_hours.sql` (transacción +
  `rollback`, estilo `supabase/tests/invariante_leads.sql`): el default se
  lee con los siete días; un `update` a `'[]'::jsonb` falla por el check.
  Cablear en el job `migraciones` de `.github/workflows/ci.yml` igual que
  los demás `.sql` de esa carpeta.

### B2 · Un módulo puro sabe si la tienda está abierta y en qué franja del día estamos

Archivos: nuevo `src/lib/business-hours.ts` + `business-hours.test.ts`;
`src/lib/time-zone.ts` (+ `time-zone.test.ts`, crear si no existe) gana
`crmWeekday(instant, timeZone): 0..6` (0 = domingo, en la zona del equipo,
con `Intl`, nunca `getDay()`); `src/lib/ai/greeting-window.ts` importa las
franjas del módulo nuevo en vez de tener las suyas (sus tests siguen
pasando sin cambios).

Exports de `business-hours.ts` (puro: sin React, sin Supabase):
- `type DayKey = "mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun"`, `type TimeRange
  = [string, string]`, `type BusinessHours = Record<DayKey, TimeRange[]>`.
- `DEFAULT_BUSINESS_HOURS` (L–V 08:00–18:00, sáb/dom `[]`), igual al default
  de B1.
- `parseBusinessHours(raw: unknown): BusinessHours` — valida forma, `HH:MM`
  y `inicio < fin`; ante cualquier cosa rota devuelve `DEFAULT_BUSINESS_HOURS`.
  Nunca lanza: lo llama un turno de IA.
- `DAY_BANDS` con los bordes de `greeting-window.ts` (mañana 00:00–11:59,
  tarde 12:00–19:00, noche 19:01–23:59) y `dayBand(now, tz): "mañana" |
  "tarde" | "noche"`; `greetingFor(band)`: "buenos días" / "buenas tardes" /
  "buenas noches".
- `businessStatus(now, hours, tz): { open: boolean; closesAt: string | null;
  nextOpening: { dayLabel: string; time: string } | null }` — `closesAt` y
  `time` en "6:00 pm"; `dayLabel` "hoy", "mañana" o el día ("el lunes").
  `nextOpening` null solo si todo está cerrado los siete días.
- `describeSchedule(hours): string` — "lunes a viernes de 8:00 am a 6:00
  pm" (agrupa días contiguos con la misma franja; "cerrado todos los días"
  si no hay ninguna).
- `businessMinutesBetween(from, to, hours, tz): number` — minutos de horario
  laboral entre dos instantes (0 si `to <= from`). Iterar día a día en la
  zona del equipo; no hace falta optimizar (rangos de días, no de años).
- `turnClockLine(now, hours, tz): string` — la línea para el prompt:
  `Hora local: viernes 5 de septiembre, 4:45 pm — franja: tarde (saluda
  "buenas tardes"). Horario de atención: lunes a viernes de 8:00 am a 6:00
  pm. Ahora mismo: ABIERTA, cierra a las 6:00 pm.` / `CERRADA, abre el lunes
  a las 8:00 am.`

Tests (mínimo): bordes 11:59/12:00 y 19:00/19:01 y medianoche; abierta y
cerrada en cada borde de franja laboral; `nextOpening` cruzando el fin de
semana y con horario partido; jsonb inválido (string, null, hora "25:00",
fin antes que inicio) → default; `businessMinutesBetween` que salta la
noche y el domingo y que devuelve 0 fuera de horario; todo con instantes
en UTC y `timeZone: "America/Caracas"`, sin depender del `TZ` del proceso.

### B3 · El turno de la IA recibe la franja y el horario calculados, no los deduce (tanda 4)

Archivos: `src/lib/ai/prompt.ts` (+ test), `src/lib/ai/agent.ts`,
`src/lib/ai/playbooks.ts` (+ test), `src/lib/data.ts` (`fetchAgentSettings`
suma `business_hours` → `businessHours: BusinessHours` vía
`parseBusinessHours`), `src/lib/types.ts` (`AgentSettings`), el tipo
`Database` si es generado a mano, y `src/components/dashboard/dashboard-view.tsx`
+ su página para pasar `businessHours` a `buildJourney` (A1 ya lo acepta
con default).

- `TurnContext` gana `businessHours`. `buildInstructions` reemplaza "Fecha y
  hora local: …" por `turnClockLine(...)`. El bloque estático sigue siendo
  prefijo exacto (caché); lo dinámico al final.
- Sección 6 del `SYSTEM_PROMPT`: la regla de saludo pasa a "usa la franja y
  el saludo que te llegan en TURNO ACTUAL, tal cual"; la frase "Saber la
  hora no es saber el horario…" se reemplaza por: el horario de atención y
  si la tienda está abierta ahora te llegan en TURNO ACTUAL; puedes decirlo
  tal cual y no inventes otro.
- Regla nueva (decisión del operador) en la sección del caso
  `intencion_compra`/escalación: fuera de horario puedes seguir cotizando
  y resolviendo dudas; cobros y cierre de la venta los hace un asesor: si
  el cliente quiere comprar y la tienda está cerrada, explícale que pasas
  la conversación al departamento de ventas y que en el horario regular
  (nómbralo: "el lunes a partir de las 8:00 am") su venta será procesada.
- `agent.ts`: donde lee `agent_settings`, traer `business_hours`, pasarlo a
  `buildInstructions` y a `matchPlaybook`. Si la lectura falla,
  `parseBusinessHours(undefined)` → default; el turno nunca se cae por el
  horario.
- `playbooks.ts` `buildPrompt`: la línea de fecha incluye la franja
  calculada ("… — franja: tarde").
- Tests: con `now` a las 20:30 Caracas (`2026-09-05T00:30:00Z`) el texto
  contiene "noche" y "buenas noches"; a las 08:10 del domingo contiene
  "CERRADA" y "abre el lunes a las 8:00 am"; `SYSTEM_PROMPT` sigue siendo
  prefijo exacto de la salida.

### B4 · Al escalar sin asesores, la despedida dice cuándo lo van a atender (tanda 4)

Archivos: `src/lib/ai/agent.ts` (la despedida del anexo A1, ver
`send.ts:107` y `tools.ts:71`), `src/lib/ai/escalate.ts` (+ tests).

- La instrucción con la que la IA redacta la despedida al escalar sin
  asesor recibe `businessStatus`: cerrada → "un asesor te escribe el lunes
  a partir de las 8:00 am"; abierta → "en breve". Sigue siendo
  `is_auto_reply` (no apaga `awaiting_reply`).
- El evento de sistema de `escalate.ts` ("IA escaló sin asesores
  disponibles…") agrega "(fuera de horario)" o "(en horario)".
- Test: con `now` en domingo la instrucción contiene "lunes".

### B5 · El panel de control del agente permite editar el horario (tanda 4)

Archivos: `src/components/agent-control/business-hours-panel.tsx` (+ test),
`agent-control-view.tsx` (engancharlo junto a `spend-cap-panel.tsx`),
`src/lib/mutations.ts` (`updateBusinessHours`; RLS ya limita a
supervisor/admin, la UI lo oculta al resto igual que el tope de gasto).

- Siete filas (lunes a domingo), cada una "Cerrado" o hasta dos franjas
  `HH:MM`–`HH:MM`. Validación con `parseBusinessHours`.
- Vista previa en vivo: `describeSchedule` y `businessStatus` ("Ahora:
  abierta, cierra a las 6:00 pm").
- Test: guardar llama a la mutación con el jsonb correcto; una franja con
  fin antes del inicio no deja guardar.

---

## FRENTE A · "Atascados" cuenta solo lo que de verdad está atascado

### Diagnóstico (confirmado en `dashboard.ts:123-224`)

1. `minutesInStage` mide desde `lastMessageAt`: una nota interna, un evento
   o una respuesta de la IA reinician el reloj, y no distingue de qué lado
   está la pelota.
2. `stageOf` etiqueta "Clasificando" (umbral 5 min) a un cliente que
   simplemente no ha contestado tras la respuesta de la IA.
3. `journey_stage = 'assigned'` sin asesor se pinta "Con asesor" con umbral
   de 24 h: el lead sin dueño disfrazado de atendido.
4. `rejectedByMeta` en `agent.ts` devuelve antes del reset de
   `journey_stage`: "Clasificando"/"Herramienta" quedan congelados.
5. `dashboard.test.ts` no cubre `stageOf`, `minutesInStage` ni `buildJourney`.

### Definición nueva (gobierna el frente)

> Una conversación está **atascada** si y solo si está abierta, espera
> respuesta (`awaitingReply`) y el tiempo desde el último mensaje del
> cliente supera el umbral de su etapa. Si la pelota está del lado del
> cliente no está atascada, esté donde esté.

El reloj es UNO: `lastCustomerMessageAt`. En "Con asesor" el tiempo se mide
en minutos de horario laboral (`businessMinutesBetween`, B2): de noche o el
domingo un asesor no está atascado. En las etapas de la IA (Consulta,
Clasificando, Herramienta), reloj de pared: la IA trabaja las 24 h.

### A1 · El tablero deduce la etapa como la describe el operador y mide el atasco desde el último mensaje del cliente (tanda 2)

Archivos: `src/lib/dashboard.ts`, `src/lib/dashboard.test.ts`. NO tocar
`inbox-filters.ts` (la píldora "Escaladas" mira el campo crudo
`journeyStage === "assigned"` y sigue igual) ni `types.ts`.

Primero tests de resguardo de `awaitingReply` (ya existen) y de la escalera
nueva; después el cambio.

Escalera nueva de `stageOf(c)`, en este orden, primer peldaño que cumple:
1. `c.assignedAgent` → `assigned` (la IA asignó o el asesor tomó el chat;
   `journey_stage = 'assigned'` sin asesor YA NO cuenta: sigue bajando).
2. `awaitingReply(c) && (c.activeTool || c.journeyStage === "tool_running")`
   → `tool_running`.
3. `awaitingReply(c) && c.journeyStage === "classifying" && c.aiEnabled`
   → `classifying`. (Sin `awaitingReply`, un `classifying`/`tool_running`
   escrito es un resto congelado —punto 4 del diagnóstico— y no se honra.)
4. `!awaitingReply(c) && c.welcomeSentAt && c.lastCustomerMessageAt &&
   lastCustomerMessageAt <= welcomeSentAt` → `first_contact` (recibió la
   bienvenida y todavía no escribió su siguiente mensaje).
5. Todo lo demás → `inquiry`. Incluye: el cliente pregunta y espera
   (atascable), Y el cliente calló tras la respuesta de la IA (no
   atascable, se pinta en gris).

Reloj y atasco:
- `waitingMinutes(c, now, hours = DEFAULT_BUSINESS_HOURS): number | null` —
  `null` si está cerrada o no espera respuesta; si no, minutos desde
  `lastCustomerMessageAt`; en `assigned`, `businessMinutesBetween`.
- `STAGE_DEFINITIONS.stallMinutes: number | null`: first_contact `null`
  (nunca), inquiry 15, classifying 5, tool_running 3, assigned 60 (laborales).
  Actualizar las leyendas a las frases del operador: "Escribió por primera
  vez; recibió la bienvenida y esperamos su siguiente mensaje", "Pregunta
  y espera respuesta", "La IA determina qué necesita", "La IA consulta o
  ejecuta una herramienta", "Un asesor lleva el caso".
- `stalled` = `waitingMinutes !== null && stallMinutes !== null &&
  waitingMinutes >= stallMinutes`. Exportar `isStalled(c, now, hours)` para
  que la UI (A4) no duplique la fórmula.
- `buildJourney(conversations, now, hours = DEFAULT_BUSINESS_HOURS)`. Orden
  dentro de la columna: primero las que esperan (mayor espera arriba),
  después las que no, por `lastMessageAt` descendente.
- `minutesInStage` se conserva SOLO para la cola de reclamos
  (`ticketQueue`/`dashboard-tickets`); su comentario dice que ya no es el
  reloj del tablero.
- `stageDetail`: `first_contact` → "esperando su siguiente mensaje";
  `inquiry` sin `awaitingReply` → "sin respuesta del cliente"; el resto
  como hoy.

Tests (tabla de casos, sección 8 del artefacto, con `now` fijo): Diana
(espera > 15 min, sin bienvenida → `inquiry` atascada), Carlos (IA
respondió, cliente callado 16 h → `inquiry` NO atascada, `waitingMinutes`
null), Laura (nota interna reciente no reinicia: `waitingMinutes` sigue
contando desde el mensaje del cliente), Ana (con asesor, 13 h de pared
pero < 60 min laborales según `hours` → no; con 61 min laborales → sí),
"Cliente de prueba" (`journey_stage = assigned`, sin asesor, espera 20 min
→ `inquiry` atascada), Roberto (cerrada → null). Más: los cinco peldaños;
`classifying` con `!awaitingReply` cae a `inquiry`; `first_contact` nunca
atascada; un `lastReplyAt` posterior al cliente → null.

### A3 · Un rechazo de Meta ya no congela la etapa (tanda 1)

Archivo: `src/lib/ai/agent.ts` (+ el test que ya cubre `rechazado_por_meta`;
buscar `rejectedByMeta`).

- En el camino `rejectedByMeta`, antes del `return`, `journey_stage = null`
  y `active_tool = null` en `conversations` (la fila de traspaso
  `rechazado_por_meta` ya existe y se conserva). Un solo `update`.
- Test: tras un envío `failed`, la conversación queda con `journey_stage`
  null y `active_tool` null, y la fila de traspaso sigue escribiéndose.

### A4 · El tablero dice cuánto lleva esperando el cliente y por qué está en rojo (tanda 3)

Archivos: `src/components/dashboard/journey-board.tsx`,
`src/components/dashboard/dashboard-view.tsx` (+ tests existentes de
`components/dashboard`).

- La tarjeta muestra "espera 23 min" (desde el mensaje del cliente) cuando
  `waitingMinutes` no es null; si es null, muestra `stageDetail` en gris
  ("sin respuesta del cliente", "esperando su siguiente mensaje").
- El punto rojo usa `isStalled`; su `title`: "Umbral de esta etapa: 15 min"
  y en "Con asesor" "60 min en horario de atención".
- `buildJourney` recibe `hours` desde la vista (default hasta que B3
  conecte `fetchAgentSettings`).
- Nada más cambia de estructura: cinco columnas, mismos hilos.

---

## FRENTE C · Bandeja: lo que la auditoría encontró y se corrige ahora

### Diagnóstico (auditoría del 5/9/2026, código en `01e0943`)

La bandeja es sólida en lo que importa: el predicado de cada píldora existe
una vez en la base (`data.ts`) y se re-verifica en memoria
(`inbox-filters.ts`) con tests de contrato entre las dos; el outbox es puro
y probado; la suscripción realtime refetchea al volver a la pestaña y
debouncea. La deuda real:

1. **Bug vivo: "Sin dueño" lista toda la ventana cargada.** `matchesFilter`
   devuelve `true` para `unassigned` (`inbox-filters.ts`) y
   `searchableConversations` (`inbox-sidebar.tsx`) mezcla las ~30 filas en
   memoria con las resueltas en servidor. El conteo es correcto. Mismo
   código en producción.
2. **Dos fuentes para "de quién es"**: etapa por columnas, dueño por la
   última fila de `conversation_handoffs`. Es la Etapa 2 (`owner_kind` +
   `response_due_at`), pendiente en `CLAUDE.md`. NO entra: migración con
   backfill que toca el turno entero.
3. `journey_stage = 'assigned'` es pegajoso; "Escaladas" depende de él más
   `ai_enabled`. Se mitiga en A1 para el tablero; la píldora queda anotada.
4. `WindowCountdown` muestra "23h 60m".
5. `api/dev/simulate-message` sin `conversationId` falla siempre.
6. Tamaño: `inbox-sidebar.tsx` (1233 líneas) y `crm-shell.tsx` (946). Bien
   comentados y con test grande; no se refactorizan ahora.
7. Índice de "Pendientes" sin `id DESC`: sigue no urgente.

### C1 · La píldora "Sin dueño" lista solo lo que de verdad está sin dueño (tanda 1)

Archivos: `src/lib/inbox-filters.ts` (+ test),
`src/components/inbox/inbox-sidebar.tsx` (+ test).

- `InboxCriteria` gana `unassignedIds?: ReadonlySet<string> | null`;
  `matchesFilter("unassigned")` devuelve `unassignedIds?.has(conversation.id)
  ?? false`.
- La sidebar arma el set con los ids de `resolvedRows` cuando
  `filter === "unassigned"` (null mientras la consulta viaja: la lista
  muestra el estado "Buscando…" que ya existe para las píldoras resueltas
  en servidor) y lo pasa a `applyInboxFilters`. Actualizar el comentario
  de `case "unassigned"` con la historia (bug detectado el 5/9/2026 en la
  verificación visual: contaba bien, listaba toda la ventana).
- Tests: en `inbox-filters.test.ts` solo pasan los ids del set; en
  `inbox-sidebar.test.tsx`, con 30 filas en memoria y 2 resueltas por
  `fetchUnassignedConversations`, la píldora pinta 2.

### C2 · La cuenta regresiva de la ventana no dice "23h 60m" (tanda 1)

Archivo: el componente `WindowCountdown` (ubicarlo con `docs/GLOSARIO.md` o
grep) + su test (crear si no existe). Calcular los minutos totales
redondeados una vez y derivar horas y minutos de ahí. Test: un restante de
23 h 59 min 40 s muestra "24h 0m", no "23h 60m".

### C3 · El simulador de mensajes funciona sin `conversationId` (tanda 1)

Archivo: `src/app/api/dev/simulate-message/route.ts` (+ test). Su contacto
fijo lleva un `wa_id` con espacios ("+00 000 0000001") que
`src/lib/ai/turn-target.ts` rechaza ("Identidad no verificable"). Leer las
reglas de `turn-target.ts` y usar un `wa_id` que las cumpla (solo dígitos,
p. ej. `580000000001`). Test: sin `conversationId` el turno llega a
`runAgentTurn` (mockeado) en vez de fallar.

---

## Verificación final (orquestador)

1. `npx tsc --noEmit`, `npm run lint`, suite completa, `rtk proxy npm run
   build` con `.next/BUILD_ID` fresco.
2. Base local desde cero + `supabase/tests/*.sql` (B1).
3. Escenario a mano con `api/dev/simulate-message` (C3): un "hola" a las
   3 pm recibe "buenas tardes"; a las 8 pm "buenas noches"; con
   `business_hours` en "todo cerrado" desde el panel, escalar sin asesores
   produce una despedida que nombra el próximo día de apertura, y una
   intención de compra fuera de horario explica el paso a ventas.
4. Tablero con la base del artefacto (sección 8): **1 atascado** (Diana),
   no 2; Carlos en Consulta en gris; "Cliente de prueba" fuera de "Con
   asesor" y en rojo a los 15 min.
5. Mutaciones manuales: quitar `awaitingReply` de `waitingMinutes` → el test
   de Carlos se pone rojo; mover el borde 19:00→19:01 en `DAY_BANDS` → el
   test de `dayBand` se pone rojo.
6. Reporte de entrega por commit para el Claude del VPS (formato
   `docs/PRODUCCION.md`), migraciones contra `26d356d` (preguntar antes si
   producción avanzó).
