-- ---------------------------------------------------------------------------
-- D1 del plan "Lo pequeño que quedó atrás" (6/9/2026): conversations_pending_idx
-- también ordena por `id`
--
-- Historia del índice: nació el 28/8/2026 (20260828020000_conversations_pending
-- _idx.sql) como `(last_message_at desc nulls last)` a secas, cuando la
-- píldora "Pendientes" todavía no existía en la bandeja. Al día siguiente,
-- 20260829010000_conversations_cursor_idx.sql le agregó `id desc` como
-- desempate a los otros tres índices de la bandeja (`..._last_message_at_id_
-- idx`, `..._unread_pill_idx`, `..._mine_idx`) porque el cursor de "Todos" ya
-- pedía ese segundo orden y un empate de `last_message_at` sin `id` deja a
-- Postgres sin forma de decidir cuál fila ya se entregó — a este índice
-- nadie lo tocó, porque para esa fecha "Pendientes" no paginaba por cursor
-- todavía. Después, 20260905010000_conversations_last_reply.sql dropeó y
-- recreó `awaiting_reply` (pasó a compararse contra `last_reply_at` en vez
-- de `last_message_at`, T0.1) y con ella se fue el índice que dependía de su
-- predicado; se recreó ahí mismo, pero tal cual estaba —sin `id`— porque esa
-- migración no tocaba el orden, solo preservaba lo que ya existía.
--
-- El problema que esto deja: `fetchConversations` (`src/lib/data.ts:931-932`)
-- ya pide `.order("last_message_at", ...).order("id", ...)` para TODAS las
-- píldoras, "Pendientes" incluida — el mismo desempate por `id` que resolvió
-- 20260829010000 para "Todos"/"No leídas"/"Mías" hace falta acá por la misma
-- razón (empates de `last_message_at` existen, medidos en producción). Sin
-- `id` en el índice, ese segundo `.order()` no tiene con qué resolverse
-- desde el índice: Postgres tiene que juntar las filas y ordenarlas aparte
-- (`Sort` o `Incremental Sort`), un costo que crece con el conteo de la
-- píldora (proyección ~24.000 filas a 90 días). El Claude del VPS lo midió
-- en producción el 30/8/2026 con EXPLAIN sobre el índice viejo: sub-
-- milisegundo con 298 filas, así que NO era urgente; el operador decidió
-- ese día que fuera entrega aparte, con `[migración]` y espejando
-- 20260829010000. Con el índice nuevo el plan es Index Scan sin `Sort`
-- (verificado en local con enable_seqscan = off, hacia adelante y
-- Backward).
--
-- Se dropea y se recrea en vez de un `create index concurrently` aparte
-- porque el nombre no cambia (mismo patrón que usó 20260829010000 para los
-- otros tres): recrearlo con el mismo nombre no rompe nada que dependa de
-- él por nombre, y no hay ninguna referencia de ese tipo en el código.
--
-- Sin backfill: es un índice, no una columna. Aplicable en caliente con la
-- app arriba — el rango donde no existe (entre el drop y el create, una
-- transacción implícita de DDL) es el mismo hueco que ya toleraron
-- 20260829010000 y 20260905010000 al recrear sus propios índices.
-- ---------------------------------------------------------------------------

drop index if exists public.conversations_pending_idx;

create index conversations_pending_idx
  on public.conversations (last_message_at desc nulls last, id desc)
  where awaiting_reply
    and status <> 'closed';

comment on index public.conversations_pending_idx is
  'Píldora "Pendientes" de la bandeja: awaiting_reply and status <> closed, sin exigir asesor libre. Calza el orden completo que pide fetchConversations (src/lib/data.ts:931-932): last_message_at desc nulls last + id desc como desempate. "Más antiguas" (order: "oldest") recorre el mismo índice al revés -- asc nulls first, id asc -- con un Index Scan Backward.';
