-- ---------------------------------------------------------------------------
-- El índice de "Sin contestar" ordena como pregunta la consulta
--
-- 20260825050000 creó `conversations_free_unanswered_idx` sobre
-- (last_message_at desc) y su comentario afirmaba que la consulta "no ordena
-- nada". Es falso, y el plan real lo desmiente:
--
--   Limit
--     -> Sort  (Sort Key: last_message_at DESC NULLS LAST)
--          -> Index Scan using conversations_free_unanswered_idx
--
-- En Postgres `desc` implica `nulls first`, mientras que la bandeja pide
-- `desc nulls last` (ver el `.order(...)` de fetchConversationRows, que pasa
-- nullsFirst: false para que las conversaciones sin ningún mensaje queden al
-- final en vez de encabezar la lista). Con órdenes distintos, el índice sirve
-- para filtrar pero no para ordenar, y Postgres tiene que ordenar aparte.
--
-- Hoy son 269 filas y medio milisegundo: el motivo de tocarlo no es la
-- velocidad, es que la afirmación quede siendo cierta. Un comentario falso
-- sobre rendimiento se hereda y se cita, y el día que este conjunto crezca
-- nadie va a volver a mirarlo.
--
-- Aditiva en el sentido que importa para el despliegue: recrear un índice no
-- cambia ningún dato ni ninguna columna, y el código viejo y el nuevo
-- funcionan igual con cualquiera de las dos versiones.
-- ---------------------------------------------------------------------------

drop index if exists conversations_free_unanswered_idx;

create index conversations_free_unanswered_idx
  on public.conversations (last_message_at desc nulls last)
  where awaiting_reply
    and assigned_agent_id is null
    and status <> 'closed';

comment on index public.conversations_free_unanswered_idx is
  'Trabajo libre sin contestar, en el mismo orden que pide la bandeja (last_message_at desc nulls last). El orden importa: con nulls first el plan agrega un Sort.';
