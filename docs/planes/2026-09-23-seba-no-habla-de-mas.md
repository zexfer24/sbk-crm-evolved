# Plan "Seba no habla de más mientras el cliente espera al asesor" (23/9/2026)

Origen: pedido del Claude del VPS del 23/9/2026, medido en producción
(`cd5fbd3`) sobre el 22/9. Desde el deploy del 21/9, 20-27 % de los mensajes
de Seba salen con una escalada abierta (antes 0-2 %) y 45-51 % salen a menos
de 60 s de otro suyo (antes ~25 %). El operador además nota que la IA tarda
mucho más en contestar (antes < 10 s).

**Decisión del operador (23/9/2026): opción (b), "un solo acuse por espera".**
Implementar ya; el reporte de latencia del VPS (T0) corre en paralelo.

## Diagnóstico

- **Causa madre:** desde "Seba atiende el mostrador" (18/9, requisito 6) la
  escalada ya no apaga `ai_enabled`. Antes, los fragmentos que el cliente
  mandaba después de escalar morían en `pausada`; ahora cada uno es un turno
  completo con modelo y mensaje.
- **Lentitud:** un fragmento que llega con un turno en vuelo choca con el lock
  y vuelve a la cola con `RETRY_WHEN_LOCKED_SECONDS = 30` (`queue.ts`). Antes
  ese turno moría mudo; ahora es el que contesta lo que el cliente preguntó de
  verdad. Más turnos también empujan el ritmo del escalón 1 (hipótesis, T0).
- **A (retrovisores):** el turno cargó el historial cuando solo existía
  "Buenas tardes"; lo más reciente con contenido era una pregunta del 3/9 ya
  respondida. Nada le dice al modelo que eso es viejo.
- **B (una respuesta por fragmento):** cada fragmento que llega durante un
  turno genera otro turno completo, sin saber qué contestó el anterior.
- **C ("Gracias" con escalada abierta):** `isCourtesyOnly("Vale")` es `true`.
  El turno de las 15:25:06 corrió con el historial terminado en la respuesta
  de Seba de las 15:24:59 (fechada DESPUÉS de "Vale"/"Gracias"): ráfaga vacía
  → la guarda exige `rafagaCliente.length > 0` y no dispara → fase 0 compara
  contra el último mensaje del cliente ("Gracias") y manda el escenario.

## Tareas

- **T0 (VPS, solo lectura):** percentiles de `wait_ms`/`classification_ms`/
  `generation_ms`/`delivery_ms`, tiempo primer mensaje de la ráfaga → primera
  y última respuesta, conteos de `cola_turno_pospuesto_lock`/
  `ia_ritmo_al_tope`/`cola_ritmo_al_tope`/`base_agotada`,
  `agent_turn_calls_by_phase(7)`, variables de modelo y ritmo.
- **T1 — Lo ya respondido no se vuelve a responder.** Marca en Redis de hasta
  qué mensaje del cliente vio el último turno que atendió; los "pendientes"
  del turno siguiente se calculan contra esa marca. Sin pendientes, el turno
  sale sin modelo. Las guardas de saludo/cortesía miran los pendientes. Sin
  Redis, como hoy.
- **T2 — Borrador cedido.** Si llegó otro mensaje del cliente mientras el
  turno redactaba y todavía no escaló ni mandó la respuesta, no manda nada: lo
  contesta todo junto el turno que ya está en cola. Tope de 2 cesiones
  seguidas.
- **T3 — El turno que espera el lock arranca apenas se libera.** Al terminar
  un turno se adelanta la entrada pendiente de esa conversación en la cola.
- **T4 — Historial viejo marcado.** El sufijo del prompt lista los mensajes
  pendientes y marca como "conversación anterior, ya atendida" todo lo que
  queda antes de un hueco de más de 12 h.
- **T5 — Opción (b).** Con la escalada abierta: sin tool loop. Si un escenario
  INFORMATIVO calza (nunca de despedida ni con `after_send = escalate`), se
  manda; si no, los pendientes van a una nota interna para el asesor. Además,
  `isFarewellPlaybook` y la corrección de los textos que dicen "la IA sigue
  contestando" (`tools.ts`, `ai-status-banner.tsx`, `handoffs.ts`).

- **T6 — Saludo suelto de un cliente que ya conocía a Seba** (agregada el
  23/9 tras el reporte de latencia del VPS; decisión del operador: "esperar la
  pregunta"). Si los pendientes son SOLO saludo, Seba ya se presentó antes y
  no hay escalada abierta, el turno no llama al modelo: se reprograma UNA vez
  8 s más. Si en ese lapso llega la pregunta, se contesta todo junto; si no,
  Seba devuelve un saludo fijo. Caso RK200: el turno arrancó con solo "Buenas
  tardes", la pregunta llegó 10 s después y el modelo escaló sobre el
  historial viejo.
- **T7 — `agent_turns.wait_ms` guarda la espera en cola (`colaMs`)**, como
  dice su comentario, y no la ventana de silencio más la cola (`esperaMs`).
  Sin migración.

Orden: T1 ∥ T3 → T4 → T2 → T5 → T6 → T7 (todas menos T3 tocan `agent.ts`).

## Reporte de latencia del VPS (23/9/2026)

- La mediana del último mensaje del cliente a la primera respuesta es de
  ~11-13 s y es igual que antes del 21/9. Nunca fue "menos de 10 s" en
  mediana.
- Desglose: ~7,5 s de ventana de silencio (debounce más la entrega de Meta),
  ~2,9 s de escenario y clasificación, ~2,7 s de redacción y ~0,6 s de envío.
- El lock de 30 s aparece en 0-2 % de las ráfagas por día, y el freno de ritmo
  nunca se alcanzó (pico de 6 turnos por minuto, con tope de 10).
- Lo que se percibe como lento es que la respuesta útil llega en el segundo o
  tercer mensaje.
- Palanca sin código aprobada para probar DESPUÉS de este deploy:
  `AI_AGENT_REASONING=none`, midiendo `agent_turn_calls` por fase.
- No aprobadas: modelo chico para clasificar y bajar la ventana de silencio.
Sin migración: la entrega puede ir a `main` (rango contra `cd5fbd3`).

## Verificación

- Test rojo primero en cada tarea.
- Secuencia exacta del caso 1 (Buenas tardes / tapas / ? / Coño negro /
  Color * / Vale / Gracias, con horas): no sale "Gracias"; los pendientes del
  turno que escala traen "tapas"; el prompt marca "retrovisores" como viejo.
- Caso 2 con (b): como máximo un mensaje al cliente tras escalar; el resto en
  notas.
- Mutaciones sobre la marca "visto hasta", la cesión y la guarda de despedida.
- Tests de cola con Redis real levantado.
- Escenario a mano en local con el modelo real.
- En producción (VPS): "con escalada abierta" casi 0, ráfaga ≤ ~25 %, 0
  despedidas con escalada abierta, y sin romper: 0 escaladas dobles, 0 turnos
  > 20.000 tokens de salida, ningún saludo que se trague una pregunta.
