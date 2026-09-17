# Plan · "La IA no vuelve a pedir lo que ya pidió" — revisión (16/9/2026)

## Contexto

**El caso reportado.** Un cliente pide un asesor, la IA escala y se despide ("te paso con un asesor"). Un asesor quita la asignación y vuelve a encender la IA a mano. En menos de un minuto el reconciliador reencola la conversación, y la IA repite la misma promesa sobre el mismo mensaje viejo. Es el mismo mecanismo que el 13/9 volvió a escalar 63 casos.

**Tus decisiones:**
- **15/9:** al reactivarla, la IA no manda nada y solo responde a lo que el cliente escriba después.
- **16/9:** mientras el cliente no vuelva a escribir, ese chat se ve en "Sin dueño".

**Qué quedó del plan del 15/9:**
- `56fa2df` con la migración `20260915020000`, commiteada y sin push.
- T2 y T3 en el árbol, sin commitear.
- Producción confirmada en `3802fad` con 70 migraciones: la migración vieja nunca salió de esta máquina.

**Por qué se rehace.** La columna `awaiting_any_reply` preguntaba "¿salió algo después del último mensaje del cliente?". Esa pregunta mide lo equivocado, y la validación y la revisión adversarial le encontraron cinco fallas:

1. **Envíos fallidos.** `send.ts:167/198` inserta la fila también cuando falla, esa fila adelanta `last_message_at`, y el reconciliador deja de reintentar `entrega_fallida`.
2. **Carrera de ráfaga.**
   - El cliente escribe mientras la IA redacta, y la respuesta queda con fecha posterior a ese mensaje.
   - La guarda del turno calla el turno siguiente.
   - Resultado: un mensaje sin contestar que además sale de Pendientes.
3. **Bienvenida.** La plantilla (`route.ts:371`) se inserta justo después del primer mensaje del cliente. Con la guarda, la IA callaría el primer turno de cada lead nuevo.
4. **"Sin dueño".** La fila `devuelto_a_ia` va a `'ai'`, así que el cliente con una promesa pendiente sale de "Sin dueño" (`data.ts:1162`).
5. **(Hallado en la revisión) El cliente escribe mientras espera al asesor.**
   - Con la IA apagada por la escalada, el webhook encola igual y el turno sale por `pausada`: queda un mensaje del cliente POSTERIOR a la despedida.
   - Al devolver el chat, cualquier reloj de salidas lo ve como pendiente. El reconciliador escribe `reabierto`, que cierra la escalada para `escalationOpen`, y la IA contesta un mensaje anterior a la devolución.

   Tu decisión depende del **momento de la devolución**, no de la última salida.

## Enfoque: un sello de devolución

**La regla:** la IA solo atiende mensajes del cliente que llegaron después de la última vez que un humano le devolvió el chat.

- **El sello.**
  - Columna `conversations.ai_resume_cutoff_at`.
  - La escribe un trigger BEFORE UPDATE cuando la fila **entra** al estado "la IA gobierna sin asesor": `ai_enabled` en `true` y sin asesor, viniendo de otro estado.
  - Copia el `last_customer_message_at` de ese instante.
  - Cubre los dos órdenes: desasignar y reactivar, o reactivar y desasignar. Cubre también un UPDATE masivo por SQL.
  - Una escalada **sale** de ese estado, así que no sella.
- **Por qué copiar el último mensaje y no `now()`.**
  - `created_at` guarda la marca de tiempo de Meta (`route.ts:1343`).
  - Un mensaje enviado un segundo antes de la devolución pero entregado después quedaría detrás de `now()`.
  - Comparado contra el último mensaje ya conocido, cualquier mensaje que llegue después queda por delante del sello. No hace falta tolerancia.
- **La columna generada.** `new_since_ai_resume` = `lcma is not null and (cutoff is null or lcma > cutoff)`. El reconciliador y el botón de atraso filtran por ella.
- **Una guarda en el turno, ahora segura.**
  - Si `lcma <= cutoff`, el turno sale con traspaso a `unassigned`.
  - No sufre la carrera de ráfaga: el sello solo se mueve con una devolución, nunca con una salida.
  - Tapa además los turnos diferidos por ritmo y los reintentos de la cola que corren después de devolver.
- **Lo que no se toca.** `handle_new_message` y `handle_message_status_change` quedan como están, y no hay backfill sobre `messages`. Las fallas 1 y 3 desaparecen porque ya nada mira salidas.
- **Los traspasos dicen la verdad.** Si queda un mensaje anterior a la devolución sin respuesta, el traspaso va a `unassigned` y el chat se ve en "Sin dueño".

**Consecuencia que apruebas con este plan.** Vale para TODA reactivación, no solo tras una escalada. Si un asesor pausa la IA, el cliente escribe, nadie le contesta y el asesor la reactiva, la IA no contesta ese mensaje: el chat queda en "Sin dueño" hasta que alguien le escriba o el cliente escriba de nuevo.

## Tareas

Subagentes `implementador` (Sonnet), uno por tarea. No commitean. Skills sugeridas: `superpowers:test-driven-development` para quien implementa, y `/code-review high` sobre el diff antes de commitear.

### Tanda 0 · Preparación (orquestador)

1. **Respaldo** del trabajo sin commitear: `git diff > scratchpad/t2-t3-15-9.patch` y `cp` de los 10 archivos. Nunca `git checkout --`.
2. **Base local.**
   - Levantar Docker (supabase + `sbk_redis`) y esperar un minuto (`JWT issued at future`).
   - Mirar `supabase_migrations.schema_migrations`.
   - Si `20260915020000` está aplicada, revertirla a mano en una transacción: trigger, función, índice, columna, CHECK de `20260914010000` y su fila de registro.
3. **Commit viejo:** `git reset --soft HEAD~1` deshace `56fa2df`, que nunca salió. Los cambios se conservan en el árbol.

### Tanda 1

**T1 · [migración] La IA solo atiende lo que llegó después de que se la devolvieron**

- **Archivos:**
  - `git mv` de `20260915020000_devolucion_a_la_ia.sql` a `supabase/migrations/20260916010000_devolucion_a_la_ia.sql`, y reescritura.
  - `supabase/tests/devolucion_a_la_ia.sql`, reescrito.
  - El paso del CI ya existe: `.github/workflows/ci.yml`.
- **Por qué un nombre nuevo.** Una base que registró la versión vieja no se salta la corregida sin avisar.

Contenido:

1. **`set local lock_timeout = '5s'`.** Agregar una columna generada reescribe `conversations` con bloqueo exclusivo. Es mejor fallar y reintentar que dejar en fila a los webhooks.
2. **`ai_resume_cutoff_at timestamptz`** con `comment on column` que cuente el caso.
3. **`new_since_ai_resume boolean generated always as (...) stored`** con su comentario. Sin índice nuevo: el filtro es más angosto que el predicado de `conversations_free_unanswered_idx`, y cada índice extra se paga en cada mensaje.
4. **`handle_conversation_ai_resume()`**, trigger BEFORE UPDATE. `when` cambia `ai_enabled` o `assigned_agent_id`. Si `new.ai_enabled and new.assigned_agent_id is null and not (old.ai_enabled and old.assigned_agent_id is null)`, entonces `new.ai_resume_cutoff_at := new.last_customer_message_at`.
   - Postgres calcula las columnas generadas DESPUÉS de los BEFORE, así que el AFTER ya ve el sello aplicado.
5. **CHECK de `reason`:** copia completa de `20260914010000`, más `desasignada_por_asesor` y `mensaje_previo_a_devolucion`.
6. **`handle_conversation_ownership_change()`**, trigger AFTER UPDATE, `security definer`.
   - **Filas que escribe:** `desasignada_por_asesor` (con `from_kind 'human'` y `from_id` del asesor anterior) y `devuelto_a_ia` (`ai_enabled` de false a true).
   - **`to_kind`, calculado igual para las dos** (si caen en el mismo UPDATE comparten `created_at` y tienen que coincidir):
     - `'human'` con `to_id` si sigue asignada;
     - `'unassigned'` si `not new.ai_enabled`, o si `new.awaiting_reply and not new.new_since_ai_resume`;
     - `'ai'` en otro caso.
   - **`created_by`:** `'user'` si `auth.uid() is not null`, si no `'system'`. Así un script por SQL, el borrado de un asesor (`on delete set null`) o la carrera del UPDATE ciego de `escalate.ts:84` no se registran como acción de un asesor.
7. **Permisos:** las dos funciones con los DOS revokes (`from public` y `from anon, authenticated`), sin grant (son funciones de trigger).
8. **Autoverificación** con `raise exception`:
   - las dos columnas, y que la segunda sea generada;
   - los dos triggers;
   - los dos valores en el CHECK;
   - `has_function_privilege('anon', …) = false` para las dos funciones.

**Test SQL** (patrón de `awaiting_reply.sql`: transacción con rollback, `created_at` explícitos, tabla `_errores`, una conversación por caso de bitácora):
- **Escalada simulada** (IA apagada y asesor X): no sella ni escribe filas.
- **Desasignar y luego reactivar, con el mensaje de la escalada pendiente:**
  - el sello queda igual a `lcma` y `new_since_ai_resume` en `false`;
  - dos filas a `unassigned`.
- **Reactivar y luego desasignar:** `human` con `to_id` y después `unassigned`. Sella recién en el segundo paso.
- **Las dos cosas en un mismo UPDATE:** dos filas con el mismo `to_kind`.
- **Caso 5:** un mensaje del cliente entre la escalada y la devolución no deja `new_since_ai_resume` en `true`.
- **Mensaje nuevo después de devolver:** pasa a `true`. Lo mismo con una marca de tiempo anterior a `now()` pero posterior al sello, que es el caso de la latencia de Meta.
- **Un `unsupported` después de devolver:** sigue en `false`.
- **Reactivar sin nada pendiente:** `'ai'`.
- **Un UPDATE que no toca esas columnas:** ni sello ni filas.
- **Una segunda devolución:** mueve el sello.
- **`created_by`:** `'user'` con `request.jwt.claims` de un usuario, `'system'` sin sesión. Verificar cómo lee `auth.uid()` la base local.
- **Permisos:** `permisos_funciones.sql` sigue en verde.

### Tanda 2 (en paralelo, no comparten archivos)

**T2 · Nadie vuelve a encolar un mensaje anterior a la devolución**
- **Archivos:** `src/lib/ai/reconciler.ts`, `src/lib/data.ts` (`unansweredFreeWork`), `reconciler.test.ts`, `data-backlog.test.ts`, `src/lib/supabase/database.types.ts`.
- **Cambio:** `.eq("awaiting_any_reply", true)` pasa a `.eq("new_since_ai_resume", true)`, en el WHERE y no en memoria (el reconciliador corta en 50 antes de filtrar).
- **Comentarios:** se reescriben con el caso 5.
- **Tipos:** `database.types.ts` suma las dos columnas en `Row`.
- **Tests:**
  - una conversación devuelta con mensaje previo no se encola ni deja `reabierto`;
  - una con mensaje posterior sí se encola;
  - `data-backlog.test.ts` lista la condición nueva.

**T3 · El turno no contesta lo que llegó antes de la devolución, y devolver cierra la escalada**
- **Archivos:** `src/lib/ai/agent.ts`, `src/lib/ai/turn-target.ts`, `src/lib/ai/handoffs.ts`, `agent.test.ts`, `handoffs.test.ts`, `turn-correlation.test.ts`.
- **`agent.ts`:** la guarda de `runAgentTurn` (~1784) queda con esta condición: `convo.ai_resume_cutoff_at && convo.last_customer_message_at && lcma <= cutoff`. Entonces:
  - log `turno_mensaje_previo_a_devolucion`;
  - traspaso `mensaje_previo_a_devolucion` a `unassigned`;
  - `return` sin llamar al modelo.

  Va después de `asignada`/`pausada` y antes de `humanHasWritten`. El select trae `ai_resume_cutoff_at` en lugar de `awaiting_any_reply`, y `turn-target.ts` cambia el campo.
- **`handoffs.ts`:**
  - `HandoffReason` suma `devuelto_a_ia`, `desasignada_por_asesor` y `mensaje_previo_a_devolucion`, y quita `sin_mensaje_nuevo`.
  - `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` suma solo `mensaje_previo_a_devolucion`: se escribe por mensaje sin cambiar de dueño.
  - `devuelto_a_ia` y `desasignada_por_asesor` SÍ cierran la escalada: un humano decidió devolverle el chat a la IA. Si no la cerraran, un "gracias" escrito DESPUÉS de devolver quedaría callado por la guarda de cortesía, contra tu decisión.
- **Tests:**
  - `agent.test.ts`, tres casos:
    - un mensaje anterior o igual al sello: sin modelo ni envío, con traspaso a `unassigned`;
    - un mensaje posterior al sello, con una salida de la IA fechada después (la forma de la ráfaga): el turno redacta y envía;
    - sin sello: camino normal.
  - `handoffs.test.ts`:
    - `escalationOpen` da `false` si después de `escalada` viene `devuelto_a_ia`;
    - ignora `mensaje_previo_a_devolucion`.
  - `turn-correlation.test.ts`: `fila()` con el campo nuevo.

### Cierre (orquestador)

- **Documentación:**
  - `docs/GLOSARIO.md`: la línea de cada archivo tocado.
  - `CLAUDE.md`, trampa nueva:
    - la IA solo atiende lo posterior al sello;
    - el sello copia `lcma` y no `now()`, por la latencia de Meta;
    - toda reactivación sella, no solo tras una escalada;
    - devolver cierra la escalada;
    - `reabierto` no se escribe para mensajes anteriores a la devolución.
  - `docs/PRODUCCION.md`:
    - la migración, con la regla dura de que va ANTES del código. Sin las columnas, el select del turno falla y se caen TODOS los turnos de IA; el reconciliador devuelve vacío en silencio (`reconciler.ts:150`) y el botón de atraso lanza (`data.ts:2439`);
    - las consultas de verificación.
  - Copiar este plan a `docs/planes/2026-09-16-la-ia-no-vuelve-a-pedir.md`.
- **Commits:**
  1. `[migración]` con la migración, el test SQL y el CI.
  2. Código de T2 y T3 con sus líneas del glosario.
  3. Documentación.
- **Memoria:** actualizar la de la corrida y su línea en `MEMORY.md`.

## Verificación

1. **Suite y compilación:** `rtk npm run test` completa en verde, y cada tarea con su archivo aislado. Además `rtk npx tsc --noEmit`, `rtk npm run lint` y `rtk proxy npm run build` (con el timestamp de `.next/BUILD_ID`).
2. **Tests SQL:** los 13 de `supabase/tests/` contra la base local, con `docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction < archivo`.
3. **Mutaciones** (respaldo con `cp` y restauración desde la copia):
   - condición de entrada del BEFORE sin `not (old…)`: el test SQL se pone rojo;
   - sello con `now()` en vez de `lcma`: rojo en el caso de la latencia;
   - `'unassigned'` cambiado por `'ai'` en la regla de pendiente: rojo;
   - quitar el `.eq` del reconciliador y el de `data.ts`: sus tests en rojo;
   - `<=` cambiado por `<` en la guarda del turno: rojo en `agent.test.ts`;
   - volver a poner `devuelto_a_ia` en la constante: rojo en `handoffs.test.ts`.
4. **Escenario a mano** en local (canal simulado, webhook local, Brave):
   1. El cliente pide un asesor y la IA escala.
   2. El cliente escribe "¿ya me atienden?" (el caso 5).
   3. Desasignar y reactivar desde el panel. Quedan dos filas a `unassigned`, el sello en la base y `new_since_ai_resume` en `false`.
   4. El chat se ve en "Sin dueño" y en "Pendientes".
   5. `/api/cron/process-queue` con `CRON_SECRET`, dos veces con más de un minuto de por medio: la IA no manda nada y no aparece `reabierto`.
   6. El diálogo "encender la IA" no lo cuenta.
   7. El cliente escribe algo nuevo: la IA responde y el chat sale de "Sin dueño".
5. **Consulta de producción para la entrega (solo lectura).** Cuenta las conversaciones con IA encendida, sin asesor, `awaiting_reply` y una `escalada`/`escalada_sin_asesor` posterior a su `lcma`: casos devueltos antes de la migración que no tendrán sello. Se espera un número mínimo, porque el reconciliador ya los habrá vuelto a escalar. Si no da ~0, se decide contigo.

## Riesgos y notas

- **Orden de despliegue:** migración antes del código, sin excepción (ver Cierre).
- **"Sin dueño" crece** con cada devolución que deja un mensaje pendiente. Es tu decisión del 16/9.
- **Toda reactivación sella**, también la de una pausa manual (ver Enfoque).
- **Riesgo parecido fuera de alcance:** reabrir a mano una conversación cerrada (`reabierta_por_asesor`, `reopen/route.ts`) permite que el reconciliador conteste mensajes viejos. Queda anotado para otra corrida.
- **Carrera de `escalate.ts:84`:** si un asesor interviene mientras la IA escala sin candidatos, el UPDATE ciego lo desasigna. Queda una fila `desasignada_por_asesor` con `created_by 'system'`. Es un riesgo previo, no se corrige acá.
- **`lcma` puede retroceder** si Meta entrega un mensaje fuera de orden, porque el trigger no protege ese caso. Es raro y previo a este plan.
