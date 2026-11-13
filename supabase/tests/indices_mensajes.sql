-- ============================================================================
-- Índices de `messages` para los paneles (M3, plan "Paneles", 13/11/2026),
-- migración 20261113030000_indices_mensajes_paneles.sql.
--
-- Qué prueba:
--   1. Los dos índices existen y son válidos (`indisvalid`): un `create index
--      concurrently` fallido deja uno inválido que `if not exists` saltaría.
--   2. Con `enable_seqscan = off`, el plan de las dos consultas de los paneles
--      (entrantes del cliente por fecha; salientes de asesor/IA por fecha y
--      sin notas internas) usa el índice que le corresponde.
--
-- El predicado de cada consulta repite a propósito el del índice parcial:
-- Postgres solo usa un índice parcial si la consulta lo implica.
--
-- Patrón: transacción con rollback, tabla `_errores`, un solo `raise
-- exception` al final.
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- ---------------------------------------------------------------------------
-- Caso 1 · existen y son válidos.
-- ---------------------------------------------------------------------------
do $$
declare
  nombre text;
  valido boolean;
begin
  foreach nombre in array array['messages_salientes_fecha_idx', 'messages_entrantes_fecha_idx'] loop
    select i.indisvalid into valido
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = nombre;
    if valido is null then
      insert into _errores(msg) values (format('Caso 1: no existe el índice %s.', nombre));
    elsif not valido then
      insert into _errores(msg) values (format('Caso 1: el índice %s existe pero es inválido.', nombre));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · el planificador los usa.
-- ---------------------------------------------------------------------------
set local enable_seqscan = off;

do $$
declare
  plan jsonb;
begin
  execute $q$
    explain (format json)
    select created_at, conversation_id from public.messages
     where created_at >= now() - interval '7 days' and sender_type = 'customer'
  $q$ into plan;
  if plan::text not like '%messages_entrantes_fecha_idx%' then
    insert into _errores(msg) values (format('Caso 2a: el plan de entrantes no usa messages_entrantes_fecha_idx: %s', plan::text));
  end if;

  execute $q$
    explain (format json)
    select created_at, sender_agent_id, conversation_id from public.messages
     where created_at >= now() - interval '7 days'
       and sender_type in ('agent', 'ai') and not is_internal_note
  $q$ into plan;
  if plan::text not like '%messages_salientes_fecha_idx%' then
    insert into _errores(msg) values (format('Caso 2b: el plan de salientes no usa messages_salientes_fecha_idx: %s', plan::text));
  end if;
end $$;

do $$
declare
  detalle text;
begin
  select string_agg(msg, E'\n') into detalle from _errores;
  if detalle is not null then
    raise exception E'indices_mensajes.sql: fallaron casos:\n%', detalle;
  end if;
  raise notice 'indices_mensajes.sql: todos los casos en verde.';
end $$;

rollback;
