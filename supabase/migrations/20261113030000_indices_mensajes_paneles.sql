-- ============================================================================
-- Índices de `messages` para los paneles (M3, plan "Paneles", 13/11/2026).
--
-- Los paneles Dashboard de ventas, Analíticas y Asesores cuentan mensajes por
-- RANGO DE FECHA y, en el de salientes, por quién respondió (`sender_agent_id`)
-- y en qué conversación. El único índice útil de `messages` hoy es
-- `(conversation_id, created_at)`: para "todo lo de los últimos 7 días" no
-- sirve de punta y el planificador recorre la tabla entera (la más grande de
-- la base). Dos índices PARCIALES, uno por cada pregunta:
--
--   * `messages_salientes_fecha_idx`: respuestas reales de asesor o IA (no
--     notas internas), por fecha, con quién respondió y la conversación
--     incluidas para que el recuento salga solo del índice.
--   * `messages_entrantes_fecha_idx`: mensajes del cliente, por fecha, con la
--     conversación incluida.
--
-- EN EL VPS SE CREAN ANTES A MANO con `create index concurrently` (mismos
-- nombres y mismas definiciones) para no bloquear escrituras sobre `messages`
-- en hora pico; allí esta migración queda sin efecto (`if not exists`) y solo
-- su autoverificación corre. La CLI de Supabase envuelve cada migración en una
-- transacción y `concurrently` no puede correr dentro de una, por eso este
-- archivo NO lo usa: en la base local y en el CI (tablas chicas) el
-- `create index` común es instantáneo.
--
-- La autoverificación exige `indisvalid`: un `create index concurrently`
-- que falló a medias deja un índice INVÁLIDO con el mismo nombre, y el
-- `if not exists` lo saltaría sin avisar -- ahí la migración aborta.
--
-- Sin funciones `security definer`: no entra al guardián de permisos.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso.
--
-- Idempotente: se puede aplicar dos veces sin fallar.
-- ============================================================================
set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

create index if not exists messages_salientes_fecha_idx
  on public.messages (created_at) include (sender_agent_id, conversation_id)
  where sender_type in ('agent', 'ai') and not is_internal_note;

create index if not exists messages_entrantes_fecha_idx
  on public.messages (created_at) include (conversation_id)
  where sender_type = 'customer';

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
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
      raise exception '20261113030000: no existe el índice %', nombre;
    elsif not valido then
      raise exception '20261113030000: el índice % existe pero es INVÁLIDO (un create index concurrently fallido); hay que borrarlo (drop index) y recrearlo', nombre;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
