-- ---------------------------------------------------------------------------
-- "Sin contestar": el corte lo resuelve Postgres, no el navegador
--
-- La bandeja carga 30 filas y filtra en memoria. Para "Sin leer" o "Sin
-- asignar" alcanza —lo que importa suele estar arriba, porque cualquier
-- movimiento sube la conversación al tope—, pero el chat libre que nadie
-- contestó es exactamente lo contrario: no se movió en días, así que está
-- cientos de filas más abajo. Filtrar la ventana cargada escondería justo al
-- que se busca.
--
-- Se necesita preguntarle a la base, y "el último mensaje del hilo sigue
-- siendo del cliente" es una comparación entre dos columnas de la misma fila.
-- PostgREST no compara columna contra columna en un filtro: solo contra
-- literales. De ahí la columna generada — le da nombre a la condición y la
-- vuelve filtrable con un `eq` normal.
--
-- La definición es la misma que `awaitingReply()` en src/lib/dashboard.ts, y
-- tiene que seguir siéndolo: la bandeja aplica el filtro en memoria sobre lo
-- que ya está cargado y en la base sobre lo que no. Si las dos se separan, la
-- misma conversación entra o sale según de dónde vino su fila.
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column awaiting_reply boolean
  generated always as (
    last_customer_message_at is not null
    and (last_message_at is null or last_message_at <= last_customer_message_at)
  ) stored;

comment on column public.conversations.awaiting_reply is
  'El último mensaje del hilo sigue siendo del cliente: nadie contestó. Generada para que el filtro "Sin contestar" de la bandeja se resuelva en la base y no sobre la ventana cargada. Espeja awaitingReply() en src/lib/dashboard.ts.';

-- El filtro pide las tres condiciones juntas y ordena por last_message_at.
-- Un índice parcial con las tres en el predicado deja adentro solo el trabajo
-- libre pendiente —un puñado de filas frente al histórico entero— y ya
-- ordenado, así que la consulta no ordena nada.
--
-- `desc` y no `asc` porque la bandeja arranca en "más recientes"; el orden
-- inverso lo resuelve el mismo índice leyéndolo al revés.
create index conversations_free_unanswered_idx
  on public.conversations (last_message_at desc)
  where awaiting_reply
    and assigned_agent_id is null
    and status <> 'closed';
