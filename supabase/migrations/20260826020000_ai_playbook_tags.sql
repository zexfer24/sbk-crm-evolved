-- ---------------------------------------------------------------------------
-- Etiquetas por escenario: la relación guarda el id, no el nombre
--
-- El cliente pide que la IA deje el chat etiquetado antes de pasarlo a un
-- asesor, y que la etiqueta se decida al crear el escenario. El mecanismo ya
-- existía a medias en src/lib/ai/escalate.ts, que al escalar una queja hace:
--
--   select id from tags where label = 'Reclamo · ' || categoria
--   if (tag) upsert contact_tags
--
-- Ese `if (tag)` es el problema. Busca por texto, y si nadie renombró la
-- etiqueta pero alguien le cambió un acento, un espacio o el separador, la
-- consulta no encuentra nada y el escalamiento sigue adelante sin etiquetar,
-- sin error y sin rastro. Es el mismo modo de fallo que nos dejó tres días
-- sin tasa del BCV y semanas sin plantilla de bienvenida: la función
-- degradada es indistinguible de la función correcta cuando no pasa nada.
--
-- Una tabla de relación con clave foránea lo cierra de raíz. Guardar
-- `tag_id` significa que la etiqueta o existe —y entonces se aplica— o no se
-- pudo guardar nunca, porque Postgres rechaza la fila. No hay estado
-- intermedio donde el escenario cree tener una etiqueta que no existe.
--
-- Qué NO hace esta migración: mover el etiquetado de los contactos a las
-- conversaciones. Se evaluó y se descartó por ahora — las etiquetas siguen
-- colgando del contacto (public.contact_tags), que es donde ya las pinta la
-- bandeja. Esta tabla dice QUÉ etiqueta corresponde a cada escenario; a
-- QUIÉN se le pega la decide el código que la aplica, y hoy es el contacto.
-- Si algún día se agrega conversation_tags, esta tabla no cambia.
-- ---------------------------------------------------------------------------

create table public.ai_playbook_tags (
  playbook_id uuid not null references public.ai_playbooks (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (playbook_id, tag_id)
);

comment on table public.ai_playbook_tags is
  'Qué etiquetas se aplican cuando un escenario responde. Cero o más por escenario. Guarda el id y no el nombre a propósito: una etiqueta renombrada sigue funcionando y una borrada se va de acá por cascada, en vez de fallar en silencio al buscarla por texto.';

-- La clave primaria ya resuelve "las etiquetas de este escenario", que es la
-- lectura del turno. Este índice es para el otro lado: borrar una etiqueta
-- desde Etiquetas del CRM dispara la cascada, y sin índice sobre tag_id eso
-- es un recorrido secuencial de la tabla entera por cada borrado.
create index ai_playbook_tags_tag_idx on public.ai_playbook_tags (tag_id);

-- ---------------------------------------------------------------------------
-- RLS — la misma asimetría que ai_playbooks, y por el mismo motivo: cualquier
-- asesor puede VER cómo queda clasificado un caso, pero decidir qué etiqueta
-- le pone la IA sola es discurso de la empresa y lo cambia supervisión.
-- ---------------------------------------------------------------------------
alter table public.ai_playbook_tags enable row level security;

create policy "ai_playbook_tags_select" on public.ai_playbook_tags
  for select using (public.is_agent());

create policy "ai_playbook_tags_write" on public.ai_playbook_tags
  for all using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

grant select, insert, update, delete on public.ai_playbook_tags to authenticated, service_role;

-- El panel administra los escenarios en vivo y ya escucha ai_playbooks: sin
-- esto, agregarle una etiqueta a un escenario no se vería hasta recargar.
alter publication supabase_realtime add table public.ai_playbook_tags;
