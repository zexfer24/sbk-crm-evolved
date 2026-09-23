# Entrega "Seba no habla de más mientras el cliente espera al asesor", 23/9/2026

Para el Claude del VPS. Responde a tu pedido del 23/9/2026 (medido sobre el
22/9 en `cd5fbd3`): 20-27 % de los mensajes de Seba salían con una escalada
abierta y 45-51 % a menos de 60 s de otro suyo. Plan completo en
`docs/planes/2026-09-23-seba-no-habla-de-mas.md` (opción (b) del operador,
"un solo acuse por espera").

**Base: producción = `cd5fbd3` con 79 migraciones.** Rango a desplegar:
`cd5fbd3..HEAD`, **SIN migraciones** (79 → 79). Antes de desplegar,
confirmá `git rev-parse HEAD` y `select count(*) from
supabase_migrations.schema_migrations`; si producción ya no está en
`cd5fbd3`, avisá antes de seguir. Solo código: redeploy normal, sin variables
nuevas. Todo lo nuevo usa el Redis que ya existe (`REDIS_URL`).

## Por commit

| Commit | Qué cambia | Qué mirar después |
|---|---|---|
| `88fe103` (T3) | El turno que choca con el lock arranca apenas termina el que estaba en vuelo, no 30 s después. | `cola_turno_pospuesto_lock` seguido de un turno en ~1 s. |
| `511e166` (T1) | Marca "visto hasta" en Redis: un turno no vuelve a contestar lo que contestó el anterior. Sin pendientes, sale sin modelo. | Evento `turno_sin_mensaje_nuevo`; 0 escenarios "Gracias" con escalada abierta. |
| `fb5526c` (T4) | El sufijo del prompt lista los mensajes pendientes y marca como "conversación anterior, ya atendida" lo que queda antes de un hueco de 12 h. | Escaladas que ya no hablan de preguntas viejas (caso RK200). |
| `554285e` (T2) | Si el cliente escribe mientras Seba redacta, el borrador no sale y el turno encolado contesta todo junto (tope 2 cesiones seguidas). | Evento `turno_cedido_a_rafaga`; `agent_turns` con estado `skipped`. |
| `d78fdaa` (T5) | Con la escalada abierta: sin tool loop. Solo un escenario informativo (nunca despedida ni `after_send = escalate`); si no calza, nota interna para el asesor. | Eventos `turno_anotado_para_asesor`; notas «Mientras espera al asesor, el cliente agregó: …». |
| `3f4bc65` (T6) | Saludo suelto de un cliente que ya conocía a Seba: espera 8 s la pregunta; si no llega, saludo fijo sin modelo. | `turno_saludo_suelto_diferido` / `cola_turno_diferido_saludo_suelto`. |
| `88cc02b` (T7) | `agent_turns.wait_ms` = solo espera en cola (`colaMs`). **Cambia el significado de la serie**: no comparar percentiles de antes y después del deploy. | `wait_ms` mediana cerca de 0-1 s (antes ~7,5 s de debounce). |
| último | Trampas en `CLAUDE.md` y esta entrega. | — |

## Verificación en producción (a las 24-48 h)

- Mensajes de Seba con escalada abierta: **casi 0** (antes 20-27 %).
- Mensajes de Seba a < 60 s de otro suyo: **≤ ~25 %** (antes 45-51 %).
- 0 escenarios de despedida enviados con escalada abierta.
- Sin romper: 0 escaladas dobles en un turno, 0 turnos > 20.000 tokens de
  salida, ningún saludo que se trague una pregunta (buscar
  `turno_saludo_suelto_diferido` seguido de un saludo fijo cuando el
  cliente SÍ había preguntado).
- Después de medir esto, queda aprobado probar `AI_AGENT_REASONING=none`
  (palanca sin código del reporte de latencia), midiendo
  `agent_turn_calls_by_phase(7)` antes y después.

## Verificado en local

Suite completa verde (3019 tests, Redis real) y build OK. Escenario a mano
con el modelo real: caso 1 (RK200: "Vale"/"Gracias" tras la escalada →
`cortesia_tras_escalada`, sin escenario "Gracias"), caso 2 (cuatro
fragmentos tras escalar → cero mensajes al cliente, una nota con los
cuatro), saludo suelto sin pregunta (saludo fijo a los 8 s) y saludo con la
pregunta dentro de los 8 s (un solo turno con los dos, sin saludo aparte).
