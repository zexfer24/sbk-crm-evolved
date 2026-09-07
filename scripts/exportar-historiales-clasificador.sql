-- ============================================================================
-- Export de historiales reales para el comparador grande×chico (T2, corrida
-- "La respuesta llega en siete segundos", 7/9/2026).
--
-- Este archivo NO se corre desde acá: se ejecuta contra la base de
-- PRODUCCIÓN, por SSH, con el contenedor `supabase-db` del stack
-- `supabase-squad`. El operador (no un subagente: nadie más tiene acceso a
-- producción) lo trae con:
--
--   ssh <host-vps> \
--     'docker exec -i supabase-db psql -U postgres -d postgres -At -f -' \
--     < scripts/exportar-historiales-clasificador.sql \
--     > scripts/historiales-clasificador.json
--
-- (equivalente en dos pasos si el shell remoto ya está abierto: subir este
-- .sql con `scp scripts/exportar-historiales-clasificador.sql <host-vps>:/tmp/`
-- y correr en el VPS
--   docker exec -i supabase-db psql -U postgres -d postgres -At -f - \
--     < /tmp/exportar-historiales-clasificador.sql > /tmp/historiales-clasificador.json
-- y luego traerlo con
--   scp <host-vps>:/tmp/historiales-clasificador.json scripts/historiales-clasificador.json)
--
-- `-At`: "tuples only" + "unaligned" — sin encabezado de columna ni
-- separadores de tabla, así el archivo que cae a disco es el JSON crudo que
-- devuelve la única fila de la única columna que produce esta consulta, y
-- `scripts/comparar-clasificador.test.ts` lo puede `JSON.parse()` tal cual.
--
-- `scripts/historiales-clasificador.json` trae texto real de clientes: es
-- entrada de `.gitignore` (ver ese archivo) y NUNCA se commitea. El
-- comparador por default usa un fixture sintético commiteable
-- (`scripts/comparar-clasificador.fixture-sintetico.json`); para correrlo
-- contra este export real hay que apuntarlo con
-- `COMPARAR_CLASIFICADOR_FIXTURE=scripts/historiales-clasificador.json`.
--
-- Qué trae, en un solo documento JSON:
--   - conversaciones: hasta 200 conversaciones con al menos un turno de IA
--     (agent_turns) en los últimos 7 días, cada una con sus últimas 20 filas
--     de `messages` en orden ASCENDENTE (mismas columnas que lee
--     `loadHistory` en agent.ts: sender_type, content, is_internal_note,
--     message_type, más created_at porque el comparador necesita la hora del
--     último mensaje para llamar a matchPlaybook igual que lo llama el turno
--     real).
--   - escenarios: los `ai_playbooks` activos con sus etiquetas, mismas
--     columnas que lee `fetchActivePlaybooks` en playbooks.ts.
--   - horario: `agent_settings.business_hours` (fila única, id = true).
-- ============================================================================

with conversaciones_recientes as (
  select conversation_id, max(created_at) as ultimo_turno
  from public.agent_turns
  where created_at > now() - interval '7 days'
  group by conversation_id
  order by ultimo_turno desc
  limit 200
),
historiales as (
  select
    cr.conversation_id,
    coalesce(
      (
        select json_agg(fila order by fila.created_at asc)
        from (
          select sender_type, content, is_internal_note, message_type, created_at
          from public.messages
          where messages.conversation_id = cr.conversation_id
          order by created_at desc
          limit 20
        ) fila
      ),
      '[]'::json
    ) as mensajes
  from conversaciones_recientes cr
),
escenarios as (
  select json_agg(
    json_build_object(
      'id', p.id,
      'name', p.name,
      'trigger_description', p.trigger_description,
      'response_text', p.response_text,
      'attachment_url', p.attachment_url,
      'attachment_type', p.attachment_type,
      'after_send', p.after_send,
      'is_active', p.is_active,
      'tags', coalesce(
        (
          select json_agg(json_build_object('id', t.id, 'label', t.label, 'color', t.color))
          from public.ai_playbook_tags pt
          join public.tags t on t.id = pt.tag_id
          where pt.playbook_id = p.id
        ),
        '[]'::json
      )
    )
    order by p.name
  ) as lista
  from public.ai_playbooks p
  where p.is_active = true
)
select json_build_object(
  'conversaciones', coalesce(
    (
      select json_agg(json_build_object('conversation_id', h.conversation_id, 'mensajes', h.mensajes))
      from historiales h
    ),
    '[]'::json
  ),
  'escenarios', coalesce((select lista from escenarios), '[]'::json),
  'horario', (select business_hours from public.agent_settings where id = true)
);
