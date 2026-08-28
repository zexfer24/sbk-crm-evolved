-- ---------------------------------------------------------------------------
-- La píldora "Sin contestar" se quedó vacía con pendientes reales
--
-- 20260827020000 le sumó `not has_reply` al predicado del índice para separar
-- "nadie contestó nunca" de "el último mensaje es del cliente". El problema es
-- que `has_reply` es un flag vitalicio: se enciende y no se apaga, y tanto la
-- IA como la plantilla de bienvenida lo encienden casi siempre. El resultado,
-- reportado el 28 de agosto de 2026: en producción "Sin contestar" dejó de
-- mostrar conversaciones que sí tenían trabajo pendiente porque casi todas
-- pasaban alguna vez por un `has_reply = true`.
--
-- El hotfix (commit hermano de esta migración) le saca `not has_reply` a la
-- consulta de la bandeja y al filtro en memoria de src/lib/inbox-filters.ts.
-- Este índice tiene que volver a espejar exactamente esa consulta o deja de
-- servir para filtrar: se devuelve al predicado de tres condiciones de
-- 20260826010000 (`awaiting_reply and assigned_agent_id is null and status <>
-- 'closed'`), con el mismo orden `last_message_at desc nulls last` que evita
-- el Sort aparte.
--
-- La misma columna sigue sirviendo al otro lado: fetchBacklogConversationIds /
-- unansweredFreeWork (src/lib/data.ts:1492-1504, el atraso que la IA puede
-- tomar al encenderse) nunca pidió `has_reply` y por eso había perdido el
-- índice cuando 20260827020000 le agregó la cuarta condición al predicado.
-- Esta migración se lo devuelve también a esa consulta.
--
-- No se toca la columna `has_reply` ni el trigger que la mantiene: siguen
-- existiendo, solo que el filtro "Sin contestar" y este índice dejan de
-- usarlos. Aditiva para el despliegue: recrear un índice no cambia datos ni
-- columnas, y el código viejo y el nuevo funcionan igual contra cualquiera de
-- las dos versiones.
-- ---------------------------------------------------------------------------

drop index if exists conversations_free_unanswered_idx;

create index conversations_free_unanswered_idx
  on public.conversations (last_message_at desc nulls last)
  where awaiting_reply
    and assigned_agent_id is null
    and status <> 'closed';

comment on index public.conversations_free_unanswered_idx is
  'Trabajo libre sin contestar, en el mismo orden que pide la bandeja (last_message_at desc nulls last). Sin `has_reply` en el predicado: ese flag es vitalicio y casi toda conversación lo enciende alguna vez, así que exigirlo vaciaba la píldora con pendientes reales (28/8/2026).';
