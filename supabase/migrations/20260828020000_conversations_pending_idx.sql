-- ---------------------------------------------------------------------------
-- La píldora "Pendientes" no exige "sin asesor"
--
-- La reforma de la bandeja del 28/8/2026 reemplaza el filtro "Sin contestar"
-- por tres píldoras, con "Pendientes" por defecto. Su predicado es
-- `awaiting_reply and status <> 'closed'`, sin la condición
-- `assigned_agent_id is null` que llevaba el filtro viejo. Se saca a
-- propósito: `assigned_agent_id` no es confiable como señal de "hace falta
-- responder" (hay asesores que contestan sin asignarse la conversación), y
-- exigirla escondía el caso más grave — un chat escalado y asignado que
-- nadie respondió — precisamente detrás de la asignación que se supone
-- iba a resolverlo.
--
-- `conversations_free_unanswered_idx` (recreado en 20260828010000) tiene
-- `assigned_agent_id is null` en su predicado, así que no sirve para esta
-- consulta: un índice parcial solo cubre condiciones que impliquen su propio
-- WHERE, y "sin agente" no está implícito en "pendiente". Este índice nuevo
-- es aditivo, no un reemplazo: `conversations_free_unanswered_idx` sigue
-- existiendo porque unansweredFreeWork (src/lib/data.ts:1492-1504), el
-- repaso de atraso que la IA usa para tomar trabajo libre al encenderse,
-- sigue necesitando esa condición de "sin asesor" — ahí sí importa que nadie
-- se lo haya apropiado todavía.
--
-- Mismo orden que los índices hermanos, `last_message_at desc nulls last`,
-- para que coincida con el `.order(...)` de la bandeja (nullsFirst: false)
-- y el plan no le agregue un Sort aparte.
--
-- Aditiva para el despliegue: crear un índice no cambia datos ni columnas,
-- y no se borra ningún índice existente.
-- ---------------------------------------------------------------------------

create index conversations_pending_idx
  on public.conversations (last_message_at desc nulls last)
  where awaiting_reply
    and status <> 'closed';

comment on index public.conversations_pending_idx is
  'Píldora "Pendientes" de la bandeja: awaiting_reply and status <> closed, sin exigir asesor libre. Mismo orden que pide la bandeja (last_message_at desc nulls last).';
