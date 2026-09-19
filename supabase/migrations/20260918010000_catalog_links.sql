-- ============================================================================
-- Tarea M1 · "Un solo catálogo" -- plan "Nada sin leer, un solo catálogo y
-- la factura Saint" (aprobado 18/9/2026).
--
-- Historia (exploración del 18/9 contra producción, D3 del plan): los
-- catálogos de SBK Motors son archivos de Google Drive de un tercero, y sus
-- URLs están pegadas A MANO dentro del texto de tres escenarios ("CATALOGO
-- CASCOS", "Catálogo general" -- siete enlaces: Cascos, Resonadores,
-- Maletas, Exploradoras y Bombillos, Defensas, Lubricantes ×2--, y
-- "Ubicación") y de cuatro mensajes rápidos. Cada versión nueva en Drive
-- cambia el ID del archivo: el catálogo de CASCOS tuvo CUATRO IDs distintos
-- en 25 días, y el 18/9/2026 circulaban DOS a la vez -- la IA mandaba
-- `1iz77Lc…` en el escenario de la IA mientras el mensaje rápido "Catalogo
-- general" seguía con `1fP3yQ5…` (8 clientes recibieron el enlace viejo en
-- 48 h). Con la URL copiada en cuatro sitios distintos, arreglar la
-- rotación exige editar cuatro textos cada vez y siempre queda alguno
-- atrasado.
--
-- Esta tabla es la fuente única (D3): un catálogo se edita UNA vez acá y
-- los escenarios/mensajes rápidos lo consumen por MARCADOR (D4,
-- `{{catalogo:<key>}}`/`{{catalogos}}`, tarea T2/T3/T4 de este mismo plan --
-- código aparte, esta migración solo abre la tabla vacía). D8: la carga de
-- los siete catálogos vigentes de producción va por script revisado
-- (`scripts/sql/2026-09-18-catalogos-iniciales.sql`), no por esta
-- migración -- el contenido es del cliente, no del repo.
--
-- Sin funciones `security definer`: la RLS de la tabla alcanza para las dos
-- operaciones que expone `mutations.ts` (leer, escribir), mismo criterio
-- que `stickers`/`ai_lessons`.
-- ============================================================================

create table public.catalog_links (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9-]{1,30}$'),
  label text not null check (char_length(btrim(label)) between 1 and 40),
  url text not null check (url ~* '^https?://'),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null
);

comment on table public.catalog_links is
  'Fuente única de los enlaces de catálogo que manda la IA y que usan los "Mensajes rápidos" de los asesores (D3, plan "Nada sin leer, un solo catálogo y la factura Saint", 18/9/2026). Reemplaza la URL pegada a mano en textos: el catálogo de cascos tuvo cuatro IDs de Google Drive distintos en 25 días y el 18/9/2026 circulaban dos versiones a la vez porque la IA y un mensaje rápido tenían la URL copiada por separado. Un escenario o un mensaje rápido consume el enlace por MARCADOR (`{{catalogo:<key>}}`/`{{catalogos}}`, código de una tarea posterior del mismo plan), nunca copiando `url`: cambiar la fila acá cambia el enlace en los dos lados a la vez.';
comment on column public.catalog_links.key is
  'La clave del marcador (`{{catalogo:cascos}}`). Solo minúsculas, dígitos y guion, 1-30 caracteres -- el mismo alfabeto que ya usan las claves de `intent`/`reason` en este esquema, para que el marcador sea fácil de escribir a mano sin errores de mayúscula o espacio.';
comment on column public.catalog_links.label is
  'Nombre visible en el panel y en la lista de `{{catalogos}}` ("• Cascos: https://…"). Tope de 40 caracteres, mismo criterio que `ai_playbooks`/`ai_lessons`.';
comment on column public.catalog_links.url is
  'La URL vigente del catálogo (hoy siempre un archivo de Google Drive de un tercero -- D7: esta corrida no sube nada al bucket propio). Exige esquema `http(s)://` explícito para que un valor pegado sin protocolo no llegue crudo a un cliente de WhatsApp.';
comment on column public.catalog_links.sort_order is
  'Orden en que aparece dentro de `{{catalogos}}` (la lista completa) y en el panel. Menor primero; sin restricción de unicidad porque reordenar es mover un número, no renumerar todo.';
comment on column public.catalog_links.is_active is
  'false = el catálogo sigue guardado pero deja de ser candidato: `{{catalogos}}` lo omite y un escenario o mensaje rápido que lo referencie por `{{catalogo:<key>}}` pasa a tener un marcador SIN RESOLVER (D6) -- fase 0 lo saca de los candidatos antes de llamar al modelo, y el composer avisa con un toast.';
comment on column public.catalog_links.updated_by is
  'El agente que hizo el último cambio (D3: "una tabla da... rastro de quién cambió qué"). on delete set null: borrar el agente no debe borrar el enlace.';

-- ---------------------------------------------------------------------------
-- Índice parcial: `fetchActiveCatalogLinks` (el turno de la IA y el shell de
-- la bandeja) siempre pide los catálogos ACTIVOS ordenados por `sort_order`
-- -- mismo criterio que los índices parciales `where is_active` de
-- `ai_lessons` (20260917020000).
-- ---------------------------------------------------------------------------
create index catalog_links_active_sort_idx on public.catalog_links (sort_order) where is_active;

-- updated_at: reutiliza public.set_updated_at(), el mismo trigger genérico
-- que ya llevan agents/whatsapp_channels/contacts/knowledge_categories/
-- knowledge_entries/ai_lessons -- no es security definer, no hace falta
-- revoke.
create trigger set_catalog_links_updated_at before update on public.catalog_links
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS -- D3: "Lectura: cualquier asesor. Escritura: supervisor/admin." Una
-- sola política de escritura `for all` (insert/update/delete) en vez de tres
-- separadas: las tres comparten exactamente la misma condición, y un asesor
-- corriente no puede alterar el enlace que la IA y los mensajes rápidos
-- comparten -- solo un supervisor decide qué URL circula.
-- ---------------------------------------------------------------------------
alter table public.catalog_links enable row level security;

create policy "catalog_links_select" on public.catalog_links
  for select using (public.is_agent());

create policy "catalog_links_write" on public.catalog_links
  for all using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

grant select, insert, update, delete on public.catalog_links to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime -- mismo patrón idempotente + autoverificación de 20260909050000
-- (conversation_handoffs) y 20260917020000 (ai_lessons): "suscribirse a un
-- canal muerto no falla, calla para siempre" (CLAUDE.md). El panel de
-- catálogos (Control IA) y el composer de los asesores necesitan ver en
-- vivo el cambio de URL que hace un supervisor, sin depender de un refresh
-- manual -- es justo la mitad del problema que esta tabla viene a resolver.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'catalog_links'
  ) then
    alter publication supabase_realtime add table public.catalog_links;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (information_schema/pg_indexes/
-- pg_trigger/pg_policies/pg_publication_tables), no el texto de este
-- archivo -- mismo criterio que 20260909050000/20260917020000 (ver
-- CLAUDE.md, "Cerrar una función security definer...": el mismo principio
-- de no confiar en el .sql aplica a cualquier verificación de permisos o de
-- Realtime).
-- ---------------------------------------------------------------------------
do $$
declare
  tbl_exists boolean;
  idx_count integer;
  trg_count integer;
  policy_count integer;
begin
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'catalog_links'
  ) into tbl_exists;

  if not tbl_exists then
    raise exception '20260918010000: public.catalog_links no quedó creada';
  end if;

  select count(*) into idx_count
    from pg_indexes
    where schemaname = 'public' and tablename = 'catalog_links'
      and indexname = 'catalog_links_active_sort_idx';

  if idx_count is distinct from 1 then
    raise exception '20260918010000: catalog_links_active_sort_idx no quedó creado';
  end if;

  select count(*) into trg_count
    from pg_trigger
    where tgrelid = 'public.catalog_links'::regclass
      and tgname = 'set_catalog_links_updated_at'
      and not tgisinternal;

  if trg_count is distinct from 1 then
    raise exception '20260918010000: set_catalog_links_updated_at no quedó creado (encontrados: %)', trg_count;
  end if;

  select count(*) into policy_count
    from pg_policies
    where schemaname = 'public' and tablename = 'catalog_links';

  if policy_count is distinct from 2 then
    raise exception '20260918010000: catalog_links esperaba 2 políticas RLS, encontró %', policy_count;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'catalog_links'
  ) then
    raise exception '20260918010000: catalog_links no quedó publicada en supabase_realtime tras el alter publication';
  end if;

  raise notice '20260918010000: autoverificación de catalog_links (tabla, índice, trigger, políticas RLS y Realtime) correcta.';
end
$$;
