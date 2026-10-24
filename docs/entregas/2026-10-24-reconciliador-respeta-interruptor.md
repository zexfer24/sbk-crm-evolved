# Entrega «El reconciliador respeta el interruptor y no gira en vacío» (24/10/2026)

Rama `entrega/reconciliador-respeta-interruptor`, partida de `main` = `1224df4` (contiene `efaa96a`). **UNA migración**, que se aplica ANTES del fast-forward de `main`. Sin variables de entorno nuevas. Toca solo `src/lib/ai/` y docs (sin UI).

Decisiones del operador: D1 (a), el reconciliador sigue rescatando todo lo que esté dentro de las 24 h al reencender. D2 (b), razón nueva `sin_mensaje_nuevo` con migración. D3: esta entrega no borra nada (ver al final).

## Pasos en el VPS
1. Aplicar con `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261024010000_traspaso_sin_mensaje_nuevo.sql`.
   - Esperado: `NOTICE: 20261024010000: autoverificación del CHECK de conversation_handoffs.reason (33 razones, incluida sin_mensaje_nuevo) correcta.`
   - Sin `-1`, aborta a propósito con «Esta migración se aplica dentro de una transacción…».
   - Si el código llegara antes que la migración, el turno no se cae, pero `record_handoff` rechaza la razón nueva (`traspaso_no_registrado`) y el bucle del sticker sigue. Por eso va primero.
2. Fast-forward de `main` a `entrega/reconciliador-respeta-interruptor`. **Esto despliega.**
3. Mirar el CI del push a `main`.
4. Medir con `/root/medir-reconciliador.sql` (criterios abajo).

## Commits (`1224df4..` HEAD de la rama)
| # | Commit | Migración | Variables de entorno | UI / servidor |
|---|---|---|---|---|
| 1 | `73df88a` [migración] La bitácora de traspasos admite la razón sin_mensaje_nuevo | **Sí**, `20261024010000_traspaso_sin_mensaje_nuevo.sql` (+ `supabase/tests/traspaso_sin_mensaje_nuevo.sql`, guardián de `seba_y_escalada_viva.sql` a 33 razones) | No | Solo base |
| 2 | `054d76f` El turno que no tiene nada nuevo que contestar deja rastro y el reconciliador deja de reencolarlo | No (usa la 1) | No | Servidor (`agent.ts`, `handoffs.ts`) |
| 3 | `c4894d2` El reconciliador no reencola nada mientras la IA no puede correr | No | No | Servidor (`reconciler.ts`) |
| 4 | (este reporte, glosario y CLAUDE.md) | No | No | Docs |

Verificado en local:
- suite completa en verde (5.432 tests);
- `tsc` limpio y lint sin errores (los 7 warnings ya estaban en `main`);
- `npm run build` correcto;
- la migración, aplicada con `psql -1 -v ON_ERROR_STOP=1`, da su NOTICE de autoverificación;
- los tests `traspaso_sin_mensaje_nuevo.sql` y `seba_y_escalada_viva.sql` pasan contra la base local.

Pruebas de mutación: invertir la condición de `agent_can_run`, quitar `role === "user"`, quitar la razón de cualquiera de las dos listas o escribir `sin_contenido_legible` en su lugar ponen la suite en rojo.

Rebuild completo por el código de servidor; no cambia el bundle del cliente.

## Qué cambia
- **T1, puerta 1:** `reconcileOrphanTurns` llama a `agent_can_run()` antes de consultar `conversations`. Con `false` (interruptor apagado o tope de gasto) no consulta, no encola y no escribe `reabierto`, y devuelve `iaNoPuedeCorrer: true` en el JSON del cron. Con error de la RPC falla cerrado y deja `log.error("reconciliador_agent_can_run_fallido")`. Sin log por pasada.
- **T2, puerta 2:** la salida `turno_sin_mensaje_nuevo` de `runTurnPhases` escribe el traspaso `sin_mensaje_nuevo` cuando el historial cargado termina en el cliente. Va sobre el mismo dueño: `human` con su id si hay asesor, `unassigned` si no. `conversationsWithDecidedSilence` la saca del reconciliador hasta que el cliente escriba algo nuevo.
  - Si el historial termina en una respuesta (un turno duplicado legítimo), no escribe nada, como antes.
  - Las dos puertas que cubre:
    - **sticker tras una respuesta de Seba** (caso `75e26065`): la marca "visto hasta" salta el sticker y el turno salía mudo;
    - **lo ya anotado para el asesor** con la escalada abierta y sin asesor: la nota es interna, no cambia la dirección del último mensaje, y la pasada siguiente la reencolaba; a las 6 h, al vencer la marca, se repetía la nota.
  - `sin_mensaje_nuevo` está en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`: no cierra la escalada para `escalationOpen` ni para la demora. Reusar `sin_contenido_legible` sí la habría cerrado, y Seba habría vuelto a contestar en vez de anotar para el asesor.

## Las salidas del turno (T2, punto 1)
Las salidas de infraestructura de la cola (`queue.ts`) **dejan la conversación en el ZSET con `defer`**, así que el reconciliador la cuenta `yaEnCola`: ritmo (`:503`), cupo (`:514`), lock (`:532`), saludo suelto (`:547`) y error reintentable (`:605`). `NonRetryable` y `MAX_ATTEMPTS` salen de la cola, pero con traspaso.

`runAgentTurnBody`: todas las salidas dejan traspaso (`agente_no_puede_correr`, `asignada`/`pausada`, `mensaje_previo_a_devolucion`, `humano_intervino`, `fuera_de_ventana`, `identidad_no_verificable`, `entrega_fallida`). La excepción es `!convo` (la conversación borrada), muda a propósito porque no hay fila a la que apuntar la clave foránea.

`runTurnPhases`: todas dejan traspaso, una fila en `agent_turns` o un mensaje saliente, salvo dos.
- `turno_sin_mensaje_nuevo` (`agent.ts:~2036`): **era la salida muda del caso `75e26065`, corregida.**
- `turno_saludo_ya_respondido` (reintento de T12): muda, pero el saludo ya fue la respuesta y `awaiting_reply` quedó apagado, así que sale del predicado del reconciliador.

Sin marca y con el sticker al final, el turno no sale mudo: clasifica y redacta, y deja fila en `agent_turns`. Lo fija un test.

## Los 7.706 `reabierto` «sin rastro» del 21-22/10 (IA apagada)
**No son una salida muda: son turnos que llegaron tarde.** Con la IA apagada, el turno escribe siempre `agente_no_puede_correr` (`agent.ts`, `!canRun`). Las cuentas lo muestran:
- 16.530 `agente_no_puede_correr`, menos como mucho 3.852 del webhook, deja unos 12.680 provocados por el reconciliador;
- eso es casi exactamente la cantidad de `reabierto` (12.735): casi cada uno terminó dejando su traspaso.

Lo que falla es la ventana de 3 minutos de M5. El reconciliador revisa 50 conversaciones por minuto pero solo escribe unos 10 `reabierto` por minuto: el resto ya estaba en la cola (`yaEnCola`). Eso significa que la cola se drena a unos 10 turnos por minuto y está siempre cargada, con unas 40 conversaciones esperando. Cada una tarda entre 4 y 5 minutos en atenderse. Lo más probable es que producción tenga `AGENT_MAX_TURNS_PER_MINUTE=10` (el escalón de la rampa, `docs/PRODUCCION.md`). Cada turno con la IA apagada también consume ese ritmo, porque el ritmo se cobra antes de `runAgentTurn`.

Para confirmarlo (solo lectura):
```sql
-- Para cada reabierto de la ventana: cuánto tardó el siguiente agente_no_puede_correr de esa conversación.
with r as (
  select id, conversation_id, created_at from conversation_handoffs
  where reason = 'reabierto' and created_at >= '2026-10-21 20:00' and created_at < '2026-10-22 20:00'
)
select width_bucket(extract(epoch from (n.created_at - r.created_at)), 0, 600, 10) as tramo_60s,
       count(*)
from r
left join lateral (
  select created_at from conversation_handoffs h
  where h.conversation_id = r.conversation_id and h.reason = 'agente_no_puede_correr'
    and h.created_at >= r.created_at - interval '5 seconds'
  order by h.created_at limit 1
) n on true
group by 1 order by 1;
```
Junto con `printenv AGENT_MAX_TURNS_PER_MINUTE AGENT_QUEUE_MAX_PER_RUN` en el contenedor de la app. Si la mayoría cae en los tramos de 3 a 10 minutos, queda confirmado. Con T1, el caso desaparece igual: con la IA apagada no hay `reabierto`.

## D3: las 414.251 filas del bucle (esta entrega no borra nada)
Quién lee `reabierto` y `agente_no_puede_correr`:

| Lector | Efecto si se borran |
|---|---|
| `unassigned_waiting_count()` (KPI «Sin dueño» de `/health`) y `fetchUnassignedConversationIds` + `isUnassignedLead` (píldora «Sin dueño» de la bandeja) | **Cambia.** Miran el `to_kind` de la ÚLTIMA fila. Ver el detalle debajo de la tabla. |
| `escalationOpen` (`handoffs.ts`) y `leerTraspasos` de la demora (`demora-cron.ts`) | Ninguno: las dos razones están en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` y ya se excluyen. |
| `conversationsWithDecidedSilence`, `human-handled.ts`, `mutations.ts`, `agent-day-data.ts`, filtro de escaladas en `demora-cron.ts` | Ninguno: filtran por otras razones. |
| Realtime (`crm-shell.tsx`, `assignment-notifier.tsx`) | Ninguno: solo escuchan INSERT. |
| `agent_day_summary`, `agent_metrics`, triggers | No leen la tabla. |

No hay ninguna pantalla que pinte la bitácora fila por fila.

Detalle del KPI «Sin dueño»:
- Borrar un `agente_no_puede_correr` (`unassigned`) que sea la última fila destapa la anterior. Si era `ai`, `human` o `closed`, el KPI **baja**.
- Si la conversación no tiene fila anterior, queda sin ninguna y sale del KPI: es un lead invisible.
- Borrar un `reabierto` (`ai`) destapa el `unassigned` que tenía debajo y el KPI **sube**.

**Recomendación para el borrado:** borrar solo las filas que NO son la última de su conversación, con el mismo desempate (`created_at desc, id desc`). Hacerlo en lotes de 10.000 a 20.000 por transacción, porque los triggers escriben la tabla en caliente. Medir `unassigned_waiting_count()` antes y después: debe quedar idéntico.

## Criterios de aceptación tras el deploy (`/root/medir-reconciliador.sql`)
1. **IA apagada, al menos una hora entera después del deploy:**
   - M1 `reabierto` = 0;
   - M1 `agente_no_puede_correr` ≤ M1b de la misma ventana (solo queda el del webhook);
   - M5 = 0.
2. **IA encendida, 24 h:**
   - M4 = 0;
   - M3 sin conversaciones en «10-99» ni «100+», salvo las que tengan mensajes nuevos del cliente entre medio;
   - M5 ≤ 1 % de M1 `reabierto`.
3. **Tope de gasto:** si se alcanza `daily_spend_cap_usd`, ningún `reabierto` desde esa hora hasta la medianoche UTC.

## Pendientes conocidos (fuera de alcance, no medidos)
- **Fallo persistente del proveedor sin saludo previo** (clasificar o tool loop): deja una fila `error` en `agent_turns`, pero ningún traspaso. El reconciliador la reencola cada minuto y escribe otra fila `error` en cada vuelta. No es una salida muda (no cuenta en M5), pero también gira.
- **`abandonado`** no es un silencio decidido. Un error que agote los 3 intentos de la cola vuelve a quedar candidata del reconciliador, y el ciclo intento → abandono → reencolado puede repetirse.
- Si cualquiera de los dos aparece en M3 con la IA encendida, se abre con el caso concreto.
