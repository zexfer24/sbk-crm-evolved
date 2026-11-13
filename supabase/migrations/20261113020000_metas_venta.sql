-- ============================================================================
-- Metas de venta de los paneles (M2, plan "Paneles", 13/11/2026).
--
-- Los tres paneles nuevos (Dashboard de ventas, Analíticas, Asesores) miden el
-- avance contra una meta diaria por canal (`online` y `tienda`). La meta tiene
-- HISTORIA: cada fila vale desde `vigente_desde` hasta que otra posterior la
-- reemplaza, así que cambiarla hoy no reescribe el avance de ayer. La meta de
-- un día es la fila con `vigente_desde <= día` más reciente
-- (`order by vigente_desde desc limit 1`).
--
-- Solo supervisor/admin la leen o la cambian, y EN RLS, no solo en la
-- interfaz (CLAUDE.md, "Base"). No hay `delete`: una meta mal puesta se
-- corrige con otra fila o con un `update`, nunca borrándola, para que la
-- historia no tenga huecos.
--
-- Semilla: noviembre de 2026 (online 2.600 $, tienda 1.800 $), la que dio el
-- cliente. `on conflict do nothing` la hace idempotente.
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

create table if not exists public.metas_venta (
  canal text not null check (canal in ('online', 'tienda')),
  vigente_desde date not null,
  monto_usd numeric(12, 2) not null check (monto_usd > 0),
  created_by uuid null default auth.uid() references public.agents(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (canal, vigente_desde)
);

alter table public.metas_venta enable row level security;

-- Los DOS caminos de privilegio de fábrica (CLAUDE.md, "Trampas"): se quita
-- todo y se da de vuelta solo lo que hace falta. `anon` queda sin nada.
revoke all on public.metas_venta from public;
revoke all on public.metas_venta from anon, authenticated;
grant select, insert, update on public.metas_venta to authenticated;

drop policy if exists "metas_venta_select" on public.metas_venta;
create policy "metas_venta_select" on public.metas_venta
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "metas_venta_insert" on public.metas_venta;
create policy "metas_venta_insert" on public.metas_venta
  for insert to authenticated
  with check (public.is_supervisor_or_admin());

drop policy if exists "metas_venta_update" on public.metas_venta;
create policy "metas_venta_update" on public.metas_venta
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

insert into public.metas_venta (canal, vigente_desde, monto_usd) values
  ('online', date '2026-11-01', 2600),
  ('tienda', date '2026-11-01', 1800)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.metas_venta'::regclass) then
    raise exception '20261113020000: metas_venta no tiene RLS activa';
  end if;
  if (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'metas_venta'
      and cmd in ('SELECT', 'INSERT', 'UPDATE')
      and (coalesce(qual, '') like '%is_supervisor_or_admin()%' or coalesce(with_check, '') like '%is_supervisor_or_admin()%')
  ) <> 3 then
    raise exception '20261113020000: faltan las tres políticas (select, insert, update) con is_supervisor_or_admin() en metas_venta';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'metas_venta' and cmd in ('DELETE', 'ALL')
  ) then
    raise exception '20261113020000: metas_venta no debe tener política de delete';
  end if;
  if has_table_privilege('anon', 'public.metas_venta', 'select')
     or has_table_privilege('anon', 'public.metas_venta', 'insert')
     or has_table_privilege('anon', 'public.metas_venta', 'update')
     or has_table_privilege('anon', 'public.metas_venta', 'delete') then
    raise exception '20261113020000: anon todavía tiene privilegios sobre metas_venta';
  end if;
  if has_table_privilege('authenticated', 'public.metas_venta', 'delete') then
    raise exception '20261113020000: authenticated no debe poder borrar metas_venta';
  end if;
  if (select count(*) from public.metas_venta where vigente_desde = date '2026-11-01') < 2 then
    raise exception '20261113020000: falta la semilla de noviembre en metas_venta';
  end if;
end $$;

notify pgrst, 'reload schema';
