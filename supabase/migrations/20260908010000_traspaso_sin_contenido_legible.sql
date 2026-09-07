-- ============================================================================
-- T1 de la corrida "La IA ve lo que llega" (8/9/2026)
--
-- El caso que la destapó: la conversación
-- cea69118-5d17-4f08-84c6-925755672b87 recibió un audio del cliente a las
-- 21:39 UTC del 6/9/2026 SIN ningún texto previo en el hilo. `loadHistory`
-- (`src/lib/ai/agent.ts`) descartaba toda fila sin `content` -- un audio no
-- trae texto -- así que el historial que armaba quedaba vacío, y el turno
-- salía por `if (history.length === 0) return;` sin escribir ningún
-- traspaso: viola la invariante "ningún lead invisible" de CLAUDE.md, que
-- exige que TODA salida silenciosa del turno deje rastro en
-- `conversation_handoffs`. El reconciliador (`src/lib/ai/reconciler.ts`)
-- encontró la conversación sin dueño una y otra vez y la reencoló 30 veces
-- seguidas, sin que ningún turno lograra avanzarla, hasta que un asesor le
-- contestó a mano el 7/9/2026 a las 13:15 UTC.
--
-- Agrava el mismo bug que ese `return` ocurre DESPUÉS de que el turno ya
-- escribió `journey_stage = 'classifying'` y ANTES de cualquier limpieza de
-- esa etapa: medido en producción el 7/9/2026 había 17 conversaciones
-- congeladas en `classifying` sin lock vigente (`ai_turn_lock_until` null o
-- vencido), la más vieja desde el 27/8/2026 -- diez días mudas, sin que
-- nada en el sistema volviera a tocarlas.
--
-- El código de T4 (misma corrida) cierra el `return` de verdad: registra
-- `record_handoff(..., to_kind => 'unassigned', reason =>
-- 'sin_contenido_legible')` y limpia `journey_stage`/`active_tool` antes de
-- salir. Esta migración solo prepara la base para que ese código pueda
-- correr: amplía el CHECK de `conversation_handoffs.reason` con la razón
-- nueva y, como saneamiento de lo que el bug ya dejó tirado, hace un
-- backfill único de las etapas congeladas de hoy.
--
-- Sin funciones `security definer` nuevas -> sin revokes ni grants.
-- ============================================================================

alter table public.conversation_handoffs
  drop constraint conversation_handoffs_reason_check;

alter table public.conversation_handoffs
  add constraint conversation_handoffs_reason_check
  check (reason in (
    'agente_no_puede_correr',
    'conversacion_inexistente',
    'pausada',
    'asignada',
    'humano_intervino',
    'humano_se_adelanto',
    'fuera_de_ventana',
    'identidad_no_verificable',
    'lock_perdido',
    'abandonado',
    'entrega_fallida',
    'reabierto',
    'escalado_por_ia',
    'reclamado',
    'devuelto_a_ia',
    'cerrado',
    'ventana_vencida',
    'sla_vencido',
    'escalada',
    'escalada_sin_asesor',
    'rechazado_por_meta',
    'cerrada_por_asesor',
    'reabierta_por_asesor',
    'reabierta_por_cliente',
    -- corrida "La IA ve lo que llega" (8/9/2026)
    'sin_contenido_legible'
  ));

comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: ver 20260830040000). T2.1 (5/9/2026) sumó cerrada_por_asesor (cierre manual, close/route.ts), reabierta_por_asesor (reabrir manual, reopen/route.ts) y reabierta_por_cliente (el webhook reabre sola una conversación cerrada cuando el cliente vuelve a escribir, ANTES de guardar su mensaje). La corrida "La IA ve lo que llega" (8/9/2026) suma sin_contenido_legible: el turno arrancó sin nada legible que mostrarle al modelo -- historial vacío tras descartar filas sin content, típicamente un chat que abre con un audio, foto o sticker sin texto -- y salió sin escribir traspaso hasta entonces (caso cea69118-5d17-4f08-84c6-925755672b87, 30 reencolados por el reconciliador).';

-- ----------------------------------------------------------------------------
-- Backfill S5: sanea lo que el bug ya dejó tirado en producción -- 17
-- conversaciones en `classifying`/`tool_running` sin lock vigente medidas el
-- 7/9/2026, la más vieja del 27/8/2026. `ai_turn_lock_until is null or
-- ai_turn_lock_until < now()` es la misma condición de "libre" que usa
-- `ai_turn_lock_acquire()` (20260829020000): si el lock sigue vigente, un
-- turno de verdad podría estar corriendo AHORA MISMO sobre esa conversación,
-- así que el backfill no la toca. Idempotente: una segunda pasada (`\i`) no
-- encuentra ya nada que limpiar porque `journey_stage`/`active_tool` quedan
-- en null la primera vez -- fuera del `in (...)` del where.
-- ----------------------------------------------------------------------------
do $$
declare
  n_limpiadas integer;
begin
  update public.conversations
  set journey_stage = null,
      active_tool = null
  where journey_stage in ('classifying', 'tool_running')
    and (ai_turn_lock_until is null or ai_turn_lock_until < now());
  get diagnostics n_limpiadas = row_count;
  raise notice 'traspaso_sin_contenido_legible: % conversación(es) con etapa congelada limpiadas', n_limpiadas;
end $$;
