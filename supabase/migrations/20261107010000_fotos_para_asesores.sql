-- ============================================================================
-- Los asesores también gestionan las fotos de los repuestos (hotfix del
-- 7/11/2026, pedido del operador: "dale acceso a los asesores para agregar
-- fotos al CRM").
--
-- Contexto: 20261031010000 (D1, 30/10/2026) dejó subir, reemplazar, borrar y
-- marcar la principal solo a supervisor y admin (`is_supervisor_or_admin()`).
-- Con 6.440 repuestos sin foto, dos personas no alcanzan para cargarlas.
--
-- Qué hace: las tres políticas de escritura de `product_photos` y la de
-- subida al bucket `product-photos` pasan a `is_agent()`, que desde
-- 20261013010000 es "agent, supervisor o admin" -- la caja NO pasa, así que
-- sigue solo mirando. Lectura, triggers (tope de 6, una sola principal),
-- bucket y grants no cambian. Storage sigue SIN políticas UPDATE ni DELETE:
-- un asesor tampoco borra ni pisa un objeto que un mensaje ya enviado
-- referencia.
--
-- No crea ninguna función (ni `security definer`): `permisos-funciones.test.ts`
-- no cambia. `is_agent()` se evalúa por fila en estas políticas, igual que en
-- las 49 de siempre; `product_photos` es chica (≤ 6 por repuesto).
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

drop policy if exists "product_photos_insert_supervisor" on public.product_photos;
drop policy if exists "product_photos_insert_agente" on public.product_photos;
create policy "product_photos_insert_agente" on public.product_photos
  for insert to authenticated
  with check (public.is_agent());

drop policy if exists "product_photos_update_supervisor" on public.product_photos;
drop policy if exists "product_photos_update_agente" on public.product_photos;
create policy "product_photos_update_agente" on public.product_photos
  for update to authenticated
  using (public.is_agent())
  with check (public.is_agent());

drop policy if exists "product_photos_delete_supervisor" on public.product_photos;
drop policy if exists "product_photos_delete_agente" on public.product_photos;
create policy "product_photos_delete_agente" on public.product_photos
  for delete to authenticated
  using (public.is_agent());

drop policy if exists "product_photos_storage_insert" on storage.objects;
create policy "product_photos_storage_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-photos' and public.is_agent());

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'product_photos'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and (coalesce(qual, '') like '%is_supervisor_or_admin%' or coalesce(with_check, '') like '%is_supervisor_or_admin%')
  ) then
    raise exception '20261107010000: product_photos todavía tiene una política de escritura solo para supervisor';
  end if;
  if (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'product_photos'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and (coalesce(qual, '') like '%is_agent()%' or coalesce(with_check, '') like '%is_agent()%')
  ) <> 3 then
    raise exception '20261107010000: faltan las tres políticas de escritura con is_agent() en product_photos';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'product_photos_storage_insert'
      and with_check like '%is_agent()%'
  ) then
    raise exception '20261107010000: la subida a product-photos no quedó abierta a is_agent()';
  end if;
end $$;

notify pgrst, 'reload schema';
