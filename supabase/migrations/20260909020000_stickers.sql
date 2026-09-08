-- ============================================================================
-- Biblioteca de stickers: tabla `stickers`
--
-- T3a del plan "Seis frentes del buzón" (8/9/2026). El operador quiere poder
-- guardar los stickers que mandan los clientes (clic derecho → "Guardar
-- sticker" en el chat) y crear stickers propios, para volver a mandarlos
-- después sin tener que pedirle a Meta el mismo archivo dos veces. Esta
-- migración solo abre la tabla; el camino de guardado/envío vive en código
-- (`stickers-data.ts`, `mutations.ts`, `meta-client.ts`).
--
-- El archivo en sí NO se duplica en un bucket aparte: vive en el mismo
-- bucket privado `whatsapp-media` que ya sirve todo el multimedia de
-- WhatsApp (`storage.ts`), bajo `stickers/<uuid>.webp` — mismas políticas de
-- storage, mismo camino de lectura por `/api/media/...` con sesión.
-- ============================================================================

create table if not exists public.stickers (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  name text,
  animated boolean not null default false,
  created_by uuid references public.agents (id) on delete set null,
  source_message_id uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.stickers is
  'Biblioteca de stickers reutilizables: guardados de un mensaje entrante (source_message_id) o creados desde cero. El archivo vive en el bucket privado whatsapp-media, bajo stickers/<uuid>.webp — storage_path guarda esa ruta, no una URL. T3a, "Seis frentes del buzón", 8/9/2026.';
comment on column public.stickers.storage_path is
  'Ruta dentro del bucket whatsapp-media (stickers/<uuid>.webp). mediaUrlFor() la convierte en la ruta propia del CRM que sirve /api/media/...';
comment on column public.stickers.name is
  'Nombre opcional para ubicarlo en la biblioteca. Null en los guardados desde el chat hasta que alguien lo nombre.';
comment on column public.stickers.animated is
  'true si el WebP trae animación (chunk ANIM). Por ahora se guarda siempre false al crearlo desde código — T3a no detecta animación al copiar/subir; T3b decide si vale la pena detectarla.';
comment on column public.stickers.source_message_id is
  'El mensaje del que se guardó, si vino de un sticker que mandó un cliente. Null en los creados desde cero. on delete set null: borrar el mensaje original no debe borrar el sticker ya guardado.';

-- ---------------------------------------------------------------------------
-- RLS — mismo criterio compartido del resto del CRM (cualquier agente
-- autenticado lee/escribe), salvo borrar: ahí sí importa quién lo creó,
-- para que un asesor no pueda vaciarle la biblioteca a otro por error. Un
-- supervisor/admin sí puede, para poder limpiar duplicados o basura.
-- Sin funciones security definer: no hace falta ninguna, la RLS de la tabla
-- alcanza para las tres operaciones que expone mutations.ts.
-- ---------------------------------------------------------------------------
alter table public.stickers enable row level security;

drop policy if exists "stickers_select" on public.stickers;
create policy "stickers_select" on public.stickers
  for select using (public.is_agent());

drop policy if exists "stickers_insert" on public.stickers;
create policy "stickers_insert" on public.stickers
  for insert with check (public.is_agent());

drop policy if exists "stickers_delete" on public.stickers;
create policy "stickers_delete" on public.stickers
  for delete using (created_by = auth.uid() or public.is_supervisor_or_admin());

grant select, insert, delete on public.stickers to authenticated;
grant select, insert, update, delete on public.stickers to service_role;

notify pgrst, 'reload schema';
