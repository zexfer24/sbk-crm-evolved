-- ============================================================================
-- conversation_handoffs entra a la publicación de Realtime (8/9/2026)
--
-- Repara un canal que nunca corrió: `crm-shell.tsx` tiene desde el 30/8/2026
-- un canal "unassigned-handoffs" suscrito a postgres_changes sobre
-- conversation_handoffs (filtro to_kind=eq.unassigned) para mantener viva la
-- píldora "Sin dueño" de la bandeja sin esperar un refresh manual. La
-- suscripción se arma bien y jamás recibe nada: verificado contra
-- pg_publication_tables en producción, conversation_handoffs no está entre
-- las 15 tablas publicadas (agent_settings, agent_suggestions, agent_tools,
-- agent_turns, agents, ai_playbook_tags, ai_playbooks, contact_tags,
-- conversations, knowledge_categories, knowledge_entries, messages, notes,
-- quick_replies, tags). La tabla existe desde 20260830040000 pero nadie la
-- agregó a la publicación en esa migración ni en ninguna posterior.
--
-- Esta migración también habilita, de rebote, el aviso de asignación de esta
-- misma ola (T6): sin la tabla en la publicación, ese aviso —que escucha
-- INSERT sobre conversation_handoffs— tampoco recibiría nada.
--
-- No hace falta tocar RLS: la política `conversation_handoffs_select using
-- (is_agent())` ya existe (20260830040000) y Realtime la respeta sola. No
-- hace falta tocar la replica identity: solo se escuchan INSERT, y el
-- payload de un INSERT ya trae la fila nueva completa con el
-- `relreplident = 'd'` (default, por primary key) que la tabla ya tiene.
--
-- Envuelto en `do $$ ... $$` con guarda `if not exists` porque
-- `alter publication ... add table` no es idempotente por sí solo (falla si
-- la tabla ya está publicada) y esta migración se aplica a mano en el VPS
-- antes de mergear a main, además de correr en CI cada vez que reconstruye
-- la base desde cero: tiene que poder ejecutarse dos veces sin romperse.
-- ============================================================================

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'conversation_handoffs'
  ) then
    alter publication supabase_realtime add table public.conversation_handoffs;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Autoverificación: un `alter publication` mal escrito (nombre de tabla
-- equivocado, publicación equivocada) no puede pasar en silencio. Si después
-- del bloque anterior la tabla sigue sin aparecer en pg_publication_tables,
-- se rompe la migración —y con ella el pipeline de CI— en vez de dejar el
-- canal muerto otra vez sin que nadie se entere.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'conversation_handoffs'
  ) then
    raise exception 'conversation_handoffs no quedó publicada en supabase_realtime tras el alter publication';
  end if;
end
$$;
