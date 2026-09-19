-- ============================================================================
-- Tarea 1 · "Lecciones de Seba" -- plan "Seba atiende el mostrador"
-- (aprobado 18/9/2026).
--
-- Requisito 7 del cliente, tal cual llegó: "clic derecho sobre un mensaje
-- para escribir una corrección o nota que la IA lea y use (palabras,
-- compatibilidades, situaciones nuevas)". Hoy la única forma de corregir a
-- la IA es reescribir el prompt o un escenario del panel -- los dos exigen
-- a un desarrollador. Esta tabla es el primer paso: un asesor cualquiera
-- deja una nota desde el chat y el turno de la IA la lee en la próxima
-- respuesta, sin tocar código.
--
-- Nombre en inglés (`ai_lessons`), como `knowledge_entries`/`ai_playbooks`:
-- la tabla vive en inglés, la interfaz dice "Lecciones de Seba" en español.
--
-- No es "aprendizaje" del modelo -- nadie reentrena nada. Es una lista de
-- instrucciones cortas que el equipo escribe y que el turno de la IA
-- concatena en el prompt en cada respuesta (código de una tarea posterior
-- del mismo plan, `src/lib/ai/lessons.ts`). Esta migración solo abre la
-- tabla, la RLS y el canal de Realtime del panel; leerla desde el turno y
-- el menú "Enseñar a Seba…" del chat son tareas de código aparte.
--
-- Dos decisiones del operador (segunda tanda, 18/9/2026, ver el plan):
--   P2 -- el alcance por defecto de una lección nueva es "Todos los chats"
--        (scope = 'global'); "Solo este chat" (scope = 'conversacion') es
--        la opción, no el default -- por eso conversation_id es NULLable
--        y solo se exige cuando scope = 'conversacion'.
--   P3 -- los sinónimos de búsqueda ENTRAN en esta corrida: kind =
--        'sinonimo' expande lo que catalog-search.ts busca en el
--        catálogo ("pastilla" también encuentra "pastillas de freno"),
--        no es una nota de prosa para el modelo.
--
-- ESTA MIGRACIÓN TIENE QUE APLICARSE DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que 20260916010000/
-- 20260917010000 (revisión "Seba sale sin pisar a nadie", 19/9/2026, tarea
-- T5): `set local lock_timeout` fuera de una transacción es un NO-OP
-- silencioso -- en autocommit cada sentencia corre en su propia transacción
-- implícita y el tope de acá abajo quedaría en 0 (sin tope) justo para el
-- `create table`/los `alter publication` de más abajo. En la inspección
-- previa al despliegue (19/9/2026) se midió un INSERT del webhook encolado
-- 6,9 s detrás del lock de una de estas cinco migraciones -- sin
-- `lock_timeout` esta migración corre el mismo riesgo sobre cualquier tabla
-- con la que llegue a cruzarse.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` -- mismo motivo y misma
-- verificación que 20260916010000 (hallazgo 10, revisión `/code-review
-- high` del 19/9/2026): sin `psql -1` esto corre con `lock_timeout = 0`
-- sin que `ON_ERROR_STOP` lo note (un warning, no un error), así que falla
-- cerrado acá. `PGOPTIONS="-c lock_timeout=5s"` sin `-1` también pasa: hay
-- un tope real, no es el no-op.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

create table public.ai_lessons (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'conversacion')),
  kind text not null default 'nota' check (kind in ('nota', 'sinonimo')),
  content text not null check (char_length(btrim(content)) between 1 and 200),
  synonym_from text,
  synonym_to text,
  message_id uuid references public.messages (id) on delete set null,
  message_excerpt text,
  conversation_id uuid references public.conversations (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  is_active boolean not null default true,
  created_by uuid references public.agents (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_lessons_synonym_requires_terms check (
    kind <> 'sinonimo' or (synonym_from is not null and synonym_to is not null)
  ),
  constraint ai_lessons_conversacion_requires_conversation check (
    scope <> 'conversacion' or conversation_id is not null
  ),
  constraint ai_lessons_message_excerpt_length check (
    message_excerpt is null or char_length(message_excerpt) <= 200
  )
);

comment on table public.ai_lessons is
  'Lecciones de Seba (requisito 7 del cliente, 18/9/2026): correcciones y notas cortas que un asesor escribe desde el chat -- clic derecho sobre un mensaje, "Enseñar a Seba…" -- para que el turno de la IA las lea. No es aprendizaje del modelo: son instrucciones de texto que el equipo escribe y el prompt concatena en cada turno. scope=''global'' (default en la UI, decisión P2) aplica a toda conversación; scope=''conversacion'' solo a la que la originó. kind=''nota'' es prosa libre para el modelo; kind=''sinonimo'' (decisión P3) expande la búsqueda del catálogo (catalog-search.ts), no es una instrucción de redacción.';
comment on column public.ai_lessons.scope is
  'global = se aplica a cualquier chat (default de la UI, P2); conversacion = solo aplica a conversation_id, que entonces es obligatorio (ver el CHECK ai_lessons_conversacion_requires_conversation).';
comment on column public.ai_lessons.kind is
  'nota (default) = texto libre que el modelo lee como instrucción o corrección. sinonimo (P3) = un par synonym_from/synonym_to que catalog-search.ts usa para expandir términos de búsqueda del catálogo (ej. jerga local -> nombre real del repuesto), nunca se le muestra al modelo como prosa.';
comment on column public.ai_lessons.content is
  'El texto de la lección tal como lo escribió el asesor. Tope de 200 caracteres (mismo criterio que knowledge_entries.title/ai_playbooks: una lección es una corrección puntual, no un documento) para que el bloque que se pega en el prompt de cada turno no crezca sin límite.';
comment on column public.ai_lessons.synonym_from is
  'Con kind=sinonimo: el término que el cliente usa (jerga, error común). Obligatorio solo cuando kind=sinonimo -- ver el CHECK ai_lessons_synonym_requires_terms.';
comment on column public.ai_lessons.synonym_to is
  'Con kind=sinonimo: el término real del catálogo al que synonym_from debe expandir la búsqueda. Obligatorio solo cuando kind=sinonimo.';
comment on column public.ai_lessons.message_id is
  'El mensaje del chat sobre el que se escribió la lección (clic derecho -> "Enseñar a Seba…"), si vino de ahí. on delete set null: borrar el mensaje original no debe borrar la lección ya guardada -- por eso existe message_excerpt, la copia del texto en el momento de crear la lección.';
comment on column public.ai_lessons.message_excerpt is
  'Copia (snapshot) del texto del mensaje citado en el momento de crear la lección, igual que invoices.customer/items son snapshot de la venta: el mensaje original puede borrarse o editarse después y la cita de la lección no debe cambiar con él. Null si la lección no nació de un mensaje puntual. Mismo tope de 200 caracteres que content (ver el CHECK ai_lessons_message_excerpt_length).';
comment on column public.ai_lessons.conversation_id is
  'La conversación de origen. Solo obligatoria cuando scope=conversacion (ver el CHECK ai_lessons_conversacion_requires_conversation); en scope=global queda como referencia informativa de dónde nació la lección. on delete cascade: sin conversación no tiene sentido conservar una lección que solo aplicaba a ella.';
comment on column public.ai_lessons.contact_id is
  'El contacto de la conversación de origen, informativo (filtros del panel). on delete set null: borrar el contacto no debe borrar la lección.';
comment on column public.ai_lessons.is_active is
  'false = la IA no la lee, pero queda guardada -- un supervisor la desactiva desde Control IA sin perder el historial. Mismo patrón que knowledge_entries.is_active.';
comment on column public.ai_lessons.created_by is
  'El agente que escribió la lección. on delete set null: borrar el agente no debe borrar sus lecciones. La RLS de insert exige que sea igual a auth.uid() (nadie puede crear una lección a nombre de otro).';

-- ---------------------------------------------------------------------------
-- Índices parciales: el turno de la IA solo necesita lecciones ACTIVAS, y
-- las dos consultas que va a hacer (todas las globales recientes; las de
-- una conversación puntual) son justo estos dos filtros -- where is_active
-- deja fuera lo desactivado sin que la IA lo vuelva a mirar en cada turno.
-- ---------------------------------------------------------------------------
create index ai_lessons_scope_created_at_idx on public.ai_lessons (scope, created_at desc) where is_active;
create index ai_lessons_conversation_idx on public.ai_lessons (conversation_id) where is_active;

-- updated_at: reutiliza public.set_updated_at(), el mismo trigger que ya
-- llevan agents/whatsapp_channels/contacts/knowledge_categories/
-- knowledge_entries -- no es security definer, no hace falta revoke.
create trigger set_ai_lessons_updated_at before update on public.ai_lessons
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS -- mismo criterio de stickers (20260909020000): cualquier agente
-- autenticado LEE todo (comparten pizarrón con el modelo), pero solo el
-- autor o un supervisor/admin puede editar o borrar una lección -- un
-- asesor no debería poder alterar en silencio lo que otro le enseñó a
-- Seba, y un supervisor necesita poder limpiar lecciones erróneas o
-- duplicadas sin depender de que el autor original siga activo.
-- ---------------------------------------------------------------------------
alter table public.ai_lessons enable row level security;

create policy "ai_lessons_select" on public.ai_lessons
  for select using (public.is_agent());

create policy "ai_lessons_insert" on public.ai_lessons
  for insert with check (public.is_agent() and created_by = auth.uid());

create policy "ai_lessons_update" on public.ai_lessons
  for update using (public.is_supervisor_or_admin() or created_by = auth.uid())
  with check (public.is_supervisor_or_admin() or created_by = auth.uid());

create policy "ai_lessons_delete" on public.ai_lessons
  for delete using (public.is_supervisor_or_admin() or created_by = auth.uid());

grant select, insert, update, delete on public.ai_lessons to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime -- mismo patrón idempotente + autoverificación de
-- 20260909050000 (conversation_handoffs): "suscribirse a un canal muerto
-- no falla, calla para siempre" (CLAUDE.md). El panel de Lecciones
-- (Control IA) necesita ver en vivo lo que otro asesor acaba de enseñar,
-- sin depender de que alguien recargue la página.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_lessons'
  ) then
    alter publication supabase_realtime add table public.ai_lessons;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (information_schema/pg_indexes/
-- pg_trigger/pg_policies/pg_publication_tables), no el texto de este
-- archivo -- mismo criterio que 20260909050000/20260916010000 (ver
-- CLAUDE.md, "Cerrar una función security definer..." -- el mismo
-- principio de no confiar en el .sql aplica a cualquier verificación de
-- permisos o de Realtime).
-- ---------------------------------------------------------------------------
do $$
declare
  tbl_exists boolean;
  idx_scope_count integer;
  idx_conv_count integer;
  trg_count integer;
  policy_count integer;
begin
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'ai_lessons'
  ) into tbl_exists;

  if not tbl_exists then
    raise exception '20260917020000: public.ai_lessons no quedó creada';
  end if;

  select count(*) into idx_scope_count
    from pg_indexes
    where schemaname = 'public' and tablename = 'ai_lessons'
      and indexname = 'ai_lessons_scope_created_at_idx';

  if idx_scope_count is distinct from 1 then
    raise exception '20260917020000: ai_lessons_scope_created_at_idx no quedó creado';
  end if;

  select count(*) into idx_conv_count
    from pg_indexes
    where schemaname = 'public' and tablename = 'ai_lessons'
      and indexname = 'ai_lessons_conversation_idx';

  if idx_conv_count is distinct from 1 then
    raise exception '20260917020000: ai_lessons_conversation_idx no quedó creado';
  end if;

  select count(*) into trg_count
    from pg_trigger
    where tgrelid = 'public.ai_lessons'::regclass
      and tgname = 'set_ai_lessons_updated_at'
      and not tgisinternal;

  if trg_count is distinct from 1 then
    raise exception '20260917020000: set_ai_lessons_updated_at no quedó creado (encontrados: %)', trg_count;
  end if;

  select count(*) into policy_count
    from pg_policies
    where schemaname = 'public' and tablename = 'ai_lessons';

  if policy_count is distinct from 4 then
    raise exception '20260917020000: ai_lessons esperaba 4 políticas RLS, encontró %', policy_count;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_lessons'
  ) then
    raise exception '20260917020000: ai_lessons no quedó publicada en supabase_realtime tras el alter publication';
  end if;

  raise notice '20260917020000: autoverificación de ai_lessons (tabla, índices, trigger, políticas RLS y Realtime) correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la tabla/columnas
-- nuevas dan 400 hasta que alguien lo recargue a mano -- revisión "Seba sale
-- sin pisar a nadie" (19/9/2026, tarea T5, hallazgo M1: ninguna de las cinco
-- migraciones de esta corrida lo traía).
notify pgrst, 'reload schema';
