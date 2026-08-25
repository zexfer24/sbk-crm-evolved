-- ============================================================================
-- Biblioteca de conocimiento del agente de IA
--
-- Lo que la IA sabe de la tienda más allá del catálogo: políticas de envío,
-- formas de pago, garantías, horarios, o lo que el equipo quiera que sepa.
-- Los administradores lo escriben acá (texto directo o subiendo un .md) y la
-- herramienta consultar_biblioteca lo lee en el turno.
--
-- Vive aparte de ai_playbooks a propósito: un playbook es una RESPUESTA
-- exacta que se envía verbatim; una entrada de la biblioteca es INFORMACIÓN
-- con la que el modelo redacta. Confundir las dos haría que la IA recitara
-- documentos enteros por WhatsApp.
--
-- Las categorías las administra el equipo (no son un enum) porque cada
-- negocio divide su información como le sirve; se siembran cuatro típicas
-- para que la biblioteca no arranque en blanco.
-- ============================================================================

create table public.knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.knowledge_categories is
  'Secciones de la biblioteca de conocimiento. Las crea el equipo según cómo divida su información.';

create trigger set_knowledge_categories_updated_at before update on public.knowledge_categories
  for each row execute function public.set_updated_at();

create table public.knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.knowledge_categories (id) on delete cascade,
  title text not null,
  content text not null,
  source_filename text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null
);

comment on table public.knowledge_entries is
  'Una entrada = un tema que la IA puede consultar. El contenido es texto plano o Markdown; la IA lo lee, no lo envía verbatim.';
comment on column public.knowledge_entries.content is
  'Lo que la IA lee cuando el tema calza con la pregunta del cliente. Markdown o texto plano.';
comment on column public.knowledge_entries.source_filename is
  'Nombre del archivo del que se importó el contenido (.md/.txt), si vino de uno. Solo informativo.';
comment on column public.knowledge_entries.is_active is
  'false = la IA no la ve, pero queda guardada. Sirve para retirar información sin borrarla.';

create index knowledge_entries_active_idx on public.knowledge_entries (is_active) where is_active;
create index knowledge_entries_category_idx on public.knowledge_entries (category_id);

create trigger set_knowledge_entries_updated_at before update on public.knowledge_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Categorías de arranque: las cuatro cosas que los clientes preguntan y que
-- no viven en el catálogo. Se pueden renombrar o borrar desde el panel.
-- ---------------------------------------------------------------------------
insert into public.knowledge_categories (name, description) values
  ('Envíos', 'A dónde se envía, con qué empresas, cuánto tarda y cuánto cuesta.'),
  ('Pagos', 'Formas de pago aceptadas: divisas, bolívares, Cashea, transferencias…'),
  ('Garantías y devoluciones', 'Qué garantía tienen los repuestos y cómo funciona un cambio o devolución.'),
  ('La tienda', 'Horario, dirección, cómo llegar y datos generales de SBK Motorcycles.');

-- ---------------------------------------------------------------------------
-- RLS — mismo criterio que ai_playbooks: esto alimenta lo que la IA le dice
-- sola a los clientes, así que cualquier asesor lo VE, pero solo
-- supervisor/admin lo cambia.
-- ---------------------------------------------------------------------------
alter table public.knowledge_categories enable row level security;
alter table public.knowledge_entries enable row level security;

create policy "knowledge_categories_select" on public.knowledge_categories
  for select using (public.is_agent());
create policy "knowledge_categories_write" on public.knowledge_categories
  for all using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

create policy "knowledge_entries_select" on public.knowledge_entries
  for select using (public.is_agent());
create policy "knowledge_entries_write" on public.knowledge_entries
  for all using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

grant select, insert, update, delete on
  public.knowledge_categories,
  public.knowledge_entries
to authenticated, service_role;

-- El panel administra la biblioteca en vivo.
alter publication supabase_realtime add table public.knowledge_categories;
alter publication supabase_realtime add table public.knowledge_entries;
