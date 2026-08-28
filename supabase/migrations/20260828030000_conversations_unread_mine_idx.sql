-- ---------------------------------------------------------------------------
-- Índices parciales para las píldoras "No leídas" y "Mías" de la bandeja
--
-- Acompaña la reforma del 28/8/2026 que cambia las píldoras de la bandeja a
-- Todos/No leídas/Mías. Las dos nuevas píldoras pasan a resolverse con
-- consultas a la base, ordenadas por `last_message_at desc nulls last` +
-- `limit`, para no perder los chats viejos que quedan fuera de la ventana de
-- 30 filas que trae la bandeja por defecto.
--
-- "No leídas": `.or("unread_count.gt.0,manually_unread.is.true")` + ese
-- orden. Los índices existentes no la cubren juntos:
-- `conversations_unread_idx` (20260822060000) es sobre `(unread_count)` sin
-- orden, y `conversations_manually_unread_idx` (20260824010000) ordena
-- `last_message_at desc` a secas (nulls first en desc, que no coincide con
-- el `nullsFirst: false` de la bandeja); resolver el OR con esos dos sería
-- BitmapOr + Sort. El índice nuevo implica funcionalmente a los dos: se
-- dejan los viejos porque retirarlos es decisión aparte, no de esta
-- migración.
--
-- "Mías": `.eq("assigned_agent_id", <id>)` + el mismo orden. El índice
-- plano `conversations_assigned_agent_id_idx` (esquema inicial) resuelve el
-- `eq` pero no el orden: con `limit`, cada apertura de la píldora pagaría
-- un Sort de todo lo del asesor. Parcial porque la consulta siempre trae un
-- id concreto (implica `is not null`) y así el índice no carga las filas
-- sin asignar.
--
-- Aditiva para el despliegue: crear un índice no cambia datos ni columnas,
-- y no se borra ningún índice existente.
-- ---------------------------------------------------------------------------

create index conversations_unread_pill_idx
  on public.conversations (last_message_at desc nulls last)
  where unread_count > 0
    or manually_unread;

comment on index public.conversations_unread_pill_idx is
  'Píldora "No leídas" de la bandeja: unread_count > 0 or manually_unread. Mismo orden que pide la bandeja (last_message_at desc nulls last). Implica funcionalmente a conversations_unread_idx y conversations_manually_unread_idx, que se dejan (retirarlos es decisión aparte).';

create index conversations_mine_idx
  on public.conversations (assigned_agent_id, last_message_at desc nulls last)
  where assigned_agent_id is not null;

comment on index public.conversations_mine_idx is
  'Píldora "Mías" de la bandeja: assigned_agent_id = <id> + orden last_message_at desc nulls last. Parcial porque la consulta siempre trae un id concreto (implica not null) y así no carga las filas sin asignar.';
