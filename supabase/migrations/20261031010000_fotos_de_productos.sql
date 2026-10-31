-- ============================================================================
-- Fotos de los repuestos (30/10/2026, plan "Cada repuesto con su foto", T1).
--
-- Contexto: /inventario no mostraba ninguna foto (6.440 repuestos sin foto al
-- arrancar). El operador decidió (D1, D5) que cada repuesto lleve hasta 6, con
-- UNA principal, que solo supervisor y admin las gestionen, y que vivan en un
-- bucket PÚBLICO: la caja no pasa `is_agent()` y `/api` le da 403, y Meta
-- descarga directo por una URL que no vence (una URL firmada de 60 s o de 10
-- min no sirve para un mensaje que el cliente puede abrir días después).
--
-- Qué hace:
--   1. `public.product_photos`: una fila por foto. `products` es de solo
--      lectura por trigger (`enforce_products_read_only`, 25/9/2026), pero una
--      tabla APARTE con FK no lo dispara -- así ya funcionan
--      `product_weight_audit`, `conversation_cart_items` y `presupuesto_items`.
--   2. Reglas en triggers `security invoker` (corren con los permisos de quien
--      escribe, que ya es supervisor o admin; no suben el conteo de funciones
--      `security definer` de `permisos-funciones.test.ts`):
--        - tope de 6 fotos por repuesto;
--        - la primera foto de un repuesto nace principal;
--        - marcar una principal desmarca la anterior;
--        - borrar la principal promueve a la de menor `position`.
--      Postgres dispara los triggers BEFORE por orden alfabético de nombre:
--      `..._primera_es_principal` < `..._tope` < `..._una_sola_principal`, que
--      es el orden que hace falta (la primera se marca ANTES de que "una sola"
--      desmarque a las demás).
--   3. RLS: lee todo el que `can_read_inventory()` (la caja incluida);
--      inserta, actualiza y borra solo `is_supervisor_or_admin()`.
--   4. Bucket `product-photos` (público, 5 MB, JPEG/PNG: Meta no acepta WebP
--      para `image`). Solo supervisor/admin insertan en él. SIN políticas
--      UPDATE ni DELETE en `storage.objects`: borrar una foto borra la FILA y
--      deja el objeto huérfano a propósito, porque los mensajes ya enviados
--      apuntan a esa URL (mismo criterio que `quick-replies/`).
--
-- Trampa de grants: el `alter default privileges` de Supabase le da ALL a
-- anon/authenticated/service_role a toda tabla nueva de `public`, así que el
-- `revoke all ... from anon` va EXPLÍCITO (CLAUDE.md, trampa de las funciones
-- `security definer` y de `saint.sync_log`). Esta migración no crea ninguna
-- función `security definer`.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. Crear la FK
-- toma un lock sobre `products`; sin tope de espera, un lock largo congelaría
-- el inventario y la IA.
--
-- Idempotente: se puede aplicar dos veces sin fallar.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. La tabla
-- ---------------------------------------------------------------------------
create table if not exists public.product_photos (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references public.products(id) on delete cascade,
  storage_path  text not null unique,
  is_primary    boolean not null default false,
  position      smallint not null default 0,
  width         integer,
  height        integer,
  bytes         integer,
  created_by    uuid references public.agents(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- La ruta cuelga de la carpeta del repuesto: una foto no puede apuntar al
  -- archivo de otro producto.
  constraint product_photos_path_del_producto
    check (storage_path like product_id::text || '/%')
);

comment on table public.product_photos is
  'Fotos de los repuestos (hasta 6 por producto, una sola principal). El archivo vive en el bucket PÚBLICO product-photos bajo <product_id>/<uuid>.jpg; storage_path guarda esa ruta, no una URL. Solo supervisor/admin escriben. Borrar una fila NO borra el objeto: los mensajes enviados lo referencian. 30/10/2026, plan "Cada repuesto con su foto".';
comment on column public.product_photos.is_primary is
  'La foto que se ve en la lista y la que viaja al chat. Una sola por producto (índice único parcial); la primera foto de un producto nace principal.';

-- Una sola principal por repuesto.
create unique index if not exists product_photos_una_principal
  on public.product_photos (product_id) where is_primary;
create index if not exists product_photos_producto_posicion
  on public.product_photos (product_id, position);

-- ---------------------------------------------------------------------------
-- 2. Triggers (security invoker: corren con los permisos de quien escribe)
-- ---------------------------------------------------------------------------
create or replace function public.product_photos_tope()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if (select count(*) from public.product_photos where product_id = new.product_id) >= 6 then
    raise exception 'Este repuesto ya tiene 6 fotos.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function public.product_photos_primera_es_principal()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (select 1 from public.product_photos where product_id = new.product_id) then
    new.is_primary := true;
  end if;
  return new;
end $$;

create or replace function public.product_photos_una_sola_principal()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.is_primary then
    update public.product_photos
       set is_primary = false
     where product_id = new.product_id
       and id <> new.id
       and is_primary;
  end if;
  return new;
end $$;

create or replace function public.product_photos_promover_principal()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.is_primary then
    update public.product_photos
       set is_primary = true
     where id = (
       select id from public.product_photos
        where product_id = old.product_id
        order by position, created_at, id
        limit 1
     );
  end if;
  return null;
end $$;

drop trigger if exists product_photos_primera_es_principal on public.product_photos;
create trigger product_photos_primera_es_principal
  before insert on public.product_photos
  for each row execute function public.product_photos_primera_es_principal();

drop trigger if exists product_photos_tope on public.product_photos;
create trigger product_photos_tope
  before insert on public.product_photos
  for each row execute function public.product_photos_tope();

drop trigger if exists product_photos_una_sola_principal on public.product_photos;
create trigger product_photos_una_sola_principal
  before insert or update of is_primary on public.product_photos
  for each row execute function public.product_photos_una_sola_principal();

drop trigger if exists product_photos_promover_principal on public.product_photos;
create trigger product_photos_promover_principal
  after delete on public.product_photos
  for each row execute function public.product_photos_promover_principal();

-- ---------------------------------------------------------------------------
-- 3. RLS y grants
-- ---------------------------------------------------------------------------
alter table public.product_photos enable row level security;

drop policy if exists "product_photos_select_inventario" on public.product_photos;
create policy "product_photos_select_inventario" on public.product_photos
  for select to authenticated
  using (public.can_read_inventory());

drop policy if exists "product_photos_insert_supervisor" on public.product_photos;
create policy "product_photos_insert_supervisor" on public.product_photos
  for insert to authenticated
  with check (public.is_supervisor_or_admin());

drop policy if exists "product_photos_update_supervisor" on public.product_photos;
create policy "product_photos_update_supervisor" on public.product_photos
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "product_photos_delete_supervisor" on public.product_photos;
create policy "product_photos_delete_supervisor" on public.product_photos
  for delete to authenticated
  using (public.is_supervisor_or_admin());

revoke all on public.product_photos from anon;
grant select, insert, update, delete on public.product_photos to authenticated;
grant all on public.product_photos to service_role;

-- ---------------------------------------------------------------------------
-- 4. El bucket público y su política de subida
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 5242880, '{image/jpeg,image/png}')
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Solo INSERT: sin UPDATE ni DELETE los objetos no se borran ni se pisan.
drop policy if exists "product_photos_storage_insert" on storage.objects;
create policy "product_photos_storage_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-photos' and public.is_supervisor_or_admin());

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
begin
  if not coalesce((select public from storage.buckets where id = 'product-photos'), false) then
    raise exception '20261031010000: el bucket product-photos no quedó público';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.product_photos'::regclass and relrowsecurity) then
    raise exception '20261031010000: product_photos no tiene RLS habilitada';
  end if;
  if has_table_privilege('anon', 'public.product_photos', 'select') then
    raise exception '20261031010000: anon puede leer product_photos';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'product_photos_storage_insert'
  ) then
    raise exception '20261031010000: falta la política de subida a product-photos';
  end if;
end $$;

notify pgrst, 'reload schema';
