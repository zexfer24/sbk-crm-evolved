-- ---------------------------------------------------------------------------
-- Índices para el cursor de la bandeja: el orden real necesita `id desc`
--
-- La reforma del 29/8/2026 cambió "Todos" de `offset` a un cursor por valor
-- (`inbox-paging.ts`, `fetchConversationRows` en `data.ts`): el orden que
-- pide la bandeja ya no es solo `last_message_at desc nulls last`, es ESE
-- orden más `id desc` como desempate — sin el segundo término, un empate de
-- `last_message_at` (hay 3 en 1.851 filas de producción, 29/8/2026) deja al
-- cursor sin forma de decidir cuál de las filas empatadas ya se entregó.
--
-- En Postgres `desc` implica `nulls first`, así que ninguno de los índices
-- existentes (`last_message_at desc nulls last`, sin `id`) sirve para ordenar
-- una consulta que ahora también compara `id`: le faltaría la columna y
-- Postgres tendría que ordenar aparte (`Sort`) igual que si el índice no
-- existiera para ese propósito. Se recrean los tres índices que la bandeja
-- usa para ordenar+paginar, agregando `id desc` al final de cada uno:
--
--   1. `conversations_last_message_at_id_idx` (NUEVO): la píldora "Todos".
--      Reemplaza en el uso, sin reemplazar en el nombre, al desajustado
--      `conversations_last_message_at_idx` del esquema inicial — ver el
--      punto 3.
--   2. `conversations_unread_pill_idx` (recreado, mismo nombre): la píldora
--      "No leídas", `unread_count > 0 or manually_unread` + cursor.
--   3. `conversations_mine_idx` (recreado, mismo nombre): la píldora "Mías",
--      `assigned_agent_id = <id>` + cursor.
--
-- El plan de producción (orden de trabajo del 29/8/2026, 1.851 filas,
-- proyección ~24.000 a 90 días) midió con `EXPLAIN` que la consulta de la
-- bandeja hace Seq Scan + Sort: `conversations_last_message_at_idx`
-- (esquema inicial) es `(last_message_at desc)` = `nulls first`, y la
-- bandeja pide `desc nulls last` — el índice no calzaba ni siquiera antes de
-- este cursor. Punto 3: se DROPEA. No sirve a la consulta para la que
-- existía (el Seq Scan medido lo confirma: Postgres prefería no usarlo) y
-- cada mensaje entrante —cada `last_message_at` que cambia— paga su
-- mantenimiento sin que nadie lo use para leer.
--
-- Verificación reforzada contra Supabase local con ~8.000 conversaciones
-- sintéticas (generate_series, con contactos y canal reales, 391 con
-- unread_count > 0 o manually_unread, 200 con assigned_agent_id, empates de
-- last_message_at cada ~30 filas) y `vacuum analyze conversations`,
-- construyendo el SQL equivalente a lo que emite PostgREST para las tres
-- consultas reales de `fetchConversationRows` (`order by last_message_at
-- desc nulls last, id desc limit 30` + el predicado `.or()` del cursor,
-- distribuido con `orExpression` para "No leídas"), con un cursor de una
-- página intermedia (ni la primera ni la última) en cada caso:
--
-- "Todos" (cursor solo) -> conversations_last_message_at_id_idx, sin Sort:
--   Limit (actual time=0.081..0.100 rows=30) — Buffers: shared hit=14
--     -> Index Only Scan using conversations_last_message_at_id_idx
--        (actual time=0.078..0.094 rows=30) — Buffers: shared hit=14
--        Filter: (cursor de 3 términos)
--
-- "No leídas" (unread_count > 0 or manually_unread, distribuido en OR de
-- ANDs con el cursor) -> conversations_unread_pill_idx, sin Sort:
--   Limit (actual time=0.143..0.183 rows=30) — Buffers: shared hit=27
--     -> Index Scan using conversations_unread_pill_idx
--        (actual time=0.141..0.178 rows=30) — Buffers: shared hit=27
--        Filter: (6 términos, cruce de orExpression)
--
-- "Mías" (assigned_agent_id = X + cursor) -> conversations_mine_idx, sin Sort:
--   Limit (actual time=0.071..0.076 rows=30) — Buffers: shared hit=4
--     -> Index Only Scan using conversations_mine_idx
--        (actual time=0.069..0.071 rows=30) — Buffers: shared hit=4
--        Index Cond: (assigned_agent_id = ...) Filter: (cursor de 3 términos)
--
-- (Los tres planes completos van en el reporte de la tarea.)
--
-- HALLAZGO, reportado y no tapado: en la ÚLTIMA página de cada píldora —el
-- momento en que quedan menos filas restantes que el `limit` de 30, la
-- misma que dispara `reachedEnd` en el cliente y no vuelve a pedirse— los
-- tres índices ceden el paso a un plan con `Sort` (Bitmap Heap Scan o Index
-- Scan por un índice más chico, según el caso, + Sort de un puñado de
-- filas). Confirmado variando el cursor a mano en las tres píldoras: se
-- mantiene mientras las filas restantes son <= 30 y desaparece apenas son
-- más. Es Postgres decidiendo, con costo, que para un resto ya chico es más
-- barato juntarlo todo y ordenarlo que seguir el índice fila por fila — la
-- misma cuenta que ya elige `Sort Method: top-N heapsort` en vez de un
-- `Index Scan` completo en cualquier `ORDER BY ... LIMIT` con pocas filas
-- de sobra. Acotado y barato en los tres casos medidos (156, 27 y 31
-- buffers; bajo 2 ms) — nada parecido al Seq Scan sobre la tabla entera que
-- resolvieron las migraciones anteriores — y ocurre una sola vez por
-- recorrido completo de una píldora (al llegar al fondo, no se vuelve a
-- pedir esa página). No se persigue una forma de índice que lo elimine: no
-- existe una que lo haga —es inherente a "quedan pocas filas que ordenar",
-- no a la forma del índice— y la decisión de si amerita la RPC dedicada
-- del plan B es del orquestador. Detalle completo, con los planes de la
-- última página de las tres píldoras, en el reporte de esta tarea.
--
-- Seguro para desplegar ANTES que el código que lo usa: el orden viejo
-- (`last_message_at desc nulls last` a secas, sin `id`) es PREFIJO del orden
-- nuevo (`last_message_at desc nulls last, id desc`) en los tres índices.
-- Cualquier consulta que hoy pide solo por `last_message_at` sigue
-- resolviendo con el índice nuevo exactamente igual que con el viejo — un
-- índice compuesto sirve a un prefijo de sus columnas. El código desplegado
-- hoy (sin cursor, sin `id` en el `.order()`) queda igual de servido.
-- ---------------------------------------------------------------------------

create index conversations_last_message_at_id_idx
  on public.conversations (last_message_at desc nulls last, id desc);

comment on index public.conversations_last_message_at_id_idx is
  'Píldora "Todos" de la bandeja, paginada por cursor: last_message_at desc nulls last + id desc como desempate (empates de last_message_at existen: 3 en 1.851 filas de producción, 29/8/2026). Reemplaza en el uso a conversations_last_message_at_idx (dropeado en esta misma migración), que ordenaba nulls first y no calzaba con la bandeja.';

drop index public.conversations_unread_pill_idx;

create index conversations_unread_pill_idx
  on public.conversations (last_message_at desc nulls last, id desc)
  where unread_count > 0
    or manually_unread;

comment on index public.conversations_unread_pill_idx is
  'Píldora "No leídas" de la bandeja, paginada por cursor: unread_count > 0 or manually_unread + last_message_at desc nulls last + id desc como desempate. Reemplaza la versión sin id desc de 20260828030000.';

drop index public.conversations_mine_idx;

create index conversations_mine_idx
  on public.conversations (assigned_agent_id, last_message_at desc nulls last, id desc)
  where assigned_agent_id is not null;

comment on index public.conversations_mine_idx is
  'Píldora "Mías" de la bandeja, paginada por cursor: assigned_agent_id = <id> + last_message_at desc nulls last + id desc como desempate. Reemplaza la versión sin id desc de 20260828030000. Parcial porque la consulta siempre trae un id concreto (implica not null).';

drop index public.conversations_last_message_at_idx;
