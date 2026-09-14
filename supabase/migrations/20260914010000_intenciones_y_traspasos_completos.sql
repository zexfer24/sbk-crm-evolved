-- ============================================================================
-- Tarea 1 del plan "La voz cercana y la espera visible" (14/9/2026)
--
-- `agent_turns.intent` y `conversations.intent` nacieron con cuatro valores
-- (20260819040000_agent_backend.sql:114,157: 'consulta_disponibilidad',
-- 'devolucion', 'queja', 'otro') y `classify.ts` devuelve CINCO desde que
-- existe `fuera_de_tema` (INTENT_VALUES, src/lib/ai/classify.ts) -- patrocinios,
-- listas de precios ajenas, pedir tareas/código/recetas a la IA. Cada turno
-- que la clasifica como `fuera_de_tema` falla en silencio: el `insert` de
-- `logTurn` en `agent_turns` y el `update` de `conversations.intent` chocan
-- contra un CHECK que no la admite, y ninguno de los dos vuelve a intentarse
-- -- el turno sigue, pero la bitácora del panel de control miente sobre qué
-- intención tuvo.
--
-- La Tarea 4 de este mismo plan (código, no esta migración) va a escribir
-- `record_handoff(..., reason => 'cortesia_tras_escalada')` cuando el
-- cliente cierra con un simple "gracias"/"ok" tras una escalada sin que un
-- asesor haya escrito todavía: el turno se calla (no hay nada que agregar a
-- lo ya dicho) pero deja rastro, como exige la invariante "ningún lead
-- invisible" de CLAUDE.md. El CHECK de `conversation_handoffs.reason`
-- (última versión en 20260908010000_traspaso_sin_contenido_legible.sql) no
-- admite esa razón todavía.
--
-- Sin backfill: los tres CHECK solo IMPIDEN escrituras, nunca las corrigen
-- después -- los inserts/updates rechazados nunca llegaron a existir como
-- fila, no hay nada que reparar.
--
-- Sin funciones `security definer` nuevas -> sin revokes ni grants.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- agent_turns.intent -- nace como CHECK inline sin nombre explícito
-- (20260819040000_agent_backend.sql:114), así que Postgres le puso el
-- nombre de fábrica `<tabla>_<columna>_check`. Verificado contra la base
-- local con `\d agent_turns` / `pg_constraint`: `agent_turns_intent_check`.
-- ---------------------------------------------------------------------------
alter table public.agent_turns
  drop constraint agent_turns_intent_check;

alter table public.agent_turns
  add constraint agent_turns_intent_check
  check (intent in ('consulta_disponibilidad', 'devolucion', 'queja', 'fuera_de_tema', 'otro'));

-- ---------------------------------------------------------------------------
-- conversations.intent -- ya nace con nombre explícito
-- (20260819040000_agent_backend.sql:155-157: `add constraint
-- conversations_intent_check`).
-- ---------------------------------------------------------------------------
alter table public.conversations
  drop constraint conversations_intent_check;

alter table public.conversations
  add constraint conversations_intent_check
  check (intent is null or intent in ('consulta_disponibilidad', 'devolucion', 'queja', 'fuera_de_tema', 'otro'));

comment on column public.conversations.intent is 'Última intención que clasificó la IA para esta conversación (classify.ts, INTENT_VALUES). Tarea 1, "La voz cercana y la espera visible" (14/9/2026): suma fuera_de_tema, que existía en el código desde la corrida "El reloj dice la verdad" (5/9/2026) sin que la base lo admitiera -- cada turno fuera de tema fallaba este update en silencio.';

-- ---------------------------------------------------------------------------
-- conversation_handoffs.reason -- lista cerrada por CHECK (no enum, a
-- propósito: ver 20260830040000). Copia completa de la última versión
-- (20260908010000_traspaso_sin_contenido_legible.sql) más
-- `cortesia_tras_escalada`.
-- ---------------------------------------------------------------------------
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
    'sin_contenido_legible',
    -- Tarea 1, "La voz cercana y la espera visible" (14/9/2026):
    'cortesia_tras_escalada'
  ));

comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: ver 20260830040000). T2.1 (5/9/2026) sumó cerrada_por_asesor/reabierta_por_asesor/reabierta_por_cliente; "La IA ve lo que llega" (8/9/2026) sumó sin_contenido_legible; "La voz cercana y la espera visible" (14/9/2026, Tarea 1) suma cortesia_tras_escalada: el cliente cerró con una cortesía ("gracias", "ok", 👍) tras una escalada sin que un asesor hubiera escrito todavía, y el turno se calla en vez de repetir la despedida -- pero deja este rastro (Tarea 4, código, misma corrida).';

-- ----------------------------------------------------------------------------
-- Autoverificación: lee la definición real de los tres CHECK desde
-- `pg_get_constraintdef` (no el texto de este archivo -- lo mismo por lo
-- que se detectó el defecto: leer el .sql no prueba qué quedó en la base) y
-- falla la migración entera si algún valor nuevo no aparece ahí. Sin
-- insertar filas de prueba: los tres CHECK ya se ejercitan de sobra en
-- `supabase/tests/intenciones_y_traspasos_completos.sql`, que sí siembra e
-- inserta contra una transacción con rollback -- acá basta con demostrar
-- que la definición que quedó en el catálogo es la que se pretendía.
-- ----------------------------------------------------------------------------
do $$
declare
  def_agent_turns text;
  def_conversations text;
  def_handoffs text;
begin
  select pg_get_constraintdef(oid) into def_agent_turns
    from pg_constraint
    where conrelid = 'public.agent_turns'::regclass
      and conname = 'agent_turns_intent_check';

  select pg_get_constraintdef(oid) into def_conversations
    from pg_constraint
    where conrelid = 'public.conversations'::regclass
      and conname = 'conversations_intent_check';

  select pg_get_constraintdef(oid) into def_handoffs
    from pg_constraint
    where conrelid = 'public.conversation_handoffs'::regclass
      and conname = 'conversation_handoffs_reason_check';

  if def_agent_turns is null or def_agent_turns not like '%fuera_de_tema%' then
    raise exception '20260914010000: agent_turns_intent_check no quedó con fuera_de_tema (definición: %)', def_agent_turns;
  end if;

  if def_conversations is null or def_conversations not like '%fuera_de_tema%' then
    raise exception '20260914010000: conversations_intent_check no quedó con fuera_de_tema (definición: %)', def_conversations;
  end if;

  if def_handoffs is null or def_handoffs not like '%cortesia_tras_escalada%' then
    raise exception '20260914010000: conversation_handoffs_reason_check no quedó con cortesia_tras_escalada (definición: %)', def_handoffs;
  end if;

  raise notice '20260914010000: autoverificación de los tres CHECK ampliados, correcta.';
end $$;
