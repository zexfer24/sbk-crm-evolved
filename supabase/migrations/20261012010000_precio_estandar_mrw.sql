-- ============================================================================
-- Precio estándar = precio + tarifa de envío MRW por peso (12/10/2026).
--
-- Contexto: el negocio quiere mostrar al asesor (y a Seba) un "precio
-- estándar" que suma al precio del producto la tarifa de envío de MRW según su
-- peso. `products.price` está en bolívares (VES) y `products.weight_kg`
-- (numeric(8,3), nullable, ver 20260909030000) trae el peso; la tarifa de MRW
-- está en USD y depende del tramo de peso.
--
-- Decisión de diseño: la tarifa se CALCULA AL LEER, nunca se guarda en
-- `products`. `products` es de solo lectura para la app salvo `weight_kg`
-- (20260925010000) y Saint es su dueño: una columna nueva ahí se tendría que
-- mantener al día cuando cambie el peso o la tabla de tarifas, y se
-- desactualizaría en silencio. Por eso `products` NO recibe ninguna columna ni
-- se toca `enforce_products_read_only()`: la tarifa vive en `shipping_rates` y
-- se expone como un CAMPO CALCULADO de PostgREST (`tarifa_envio_usd(products)`,
-- que el cliente pide como `select=...,tarifa_envio_usd`).
--
-- Tramos [desde_kg, hasta_kg): 1.000 kg ya es el tramo de 1-2 kg, y 80 kg o
-- más no tiene tarifa (null: se sale de la tabla de MRW). Una exclusión con
-- `btree_gist` impide que dos tramos de un mismo transportista se solapen.
--
-- OJO, dato pendiente de confirmar con MRW (P1): la tarifa BAJA al pasar de
-- 42-43 kg (14,70) a 43-45 kg (13,91). Se carga tal cual por decisión del
-- operador; si MRW lo corrige, es un `update` sobre `shipping_rates` (la
-- escritura es solo de supervisor/admin, no hace falta otra migración).
--
-- RLS: cualquier agente lee (`is_agent()`); insertar, actualizar y borrar
-- exige supervisor/admin EN RLS, igual que el resto de la configuración
-- (20260820050000). Un UPDATE/DELETE que la política bloquea afecta 0 filas
-- sin error (ver CLAUDE.md, `assertRowsAffected`).
--
-- Las dos funciones son `security invoker` a propósito: leen `shipping_rates`
-- con los privilegios (y la RLS) de quien las llama, y la tabla es de 34
-- filas, así que la política por fila no cuesta nada. Llevan los dos revokes
-- (PUBLIC y anon) y el grant a quien sí las usa.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores. Solo crea
-- una tabla nueva y dos funciones; no reescribe ninguna tabla existente.
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

-- Necesaria para que la exclusión compare `carrier` (texto) con `=` dentro de
-- un índice GiST junto a un rango numérico.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Tabla de tarifas
-- ---------------------------------------------------------------------------
create table public.shipping_rates (
  id uuid primary key default gen_random_uuid(),
  carrier text not null default 'mrw',
  desde_kg numeric(8, 3) not null,
  hasta_kg numeric(8, 3) not null,
  tarifa_usd numeric(8, 2) not null check (tarifa_usd > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  constraint shipping_rates_desde_no_negativo check (desde_kg >= 0),
  constraint shipping_rates_rango_valido check (hasta_kg > desde_kg),
  constraint shipping_rates_sin_solape exclude using gist (
    carrier with =,
    numrange(desde_kg, hasta_kg, '[)') with &&
  )
);

comment on table public.shipping_rates is
  'Tarifas de envío por tramo de peso [desde_kg, hasta_kg) y transportista, en USD (12/10/2026). Alimenta el campo calculado products.tarifa_envio_usd: el precio estándar = precio + tarifa, calculado al leer, nunca guardado. Escritura solo supervisor/admin.';
comment on column public.shipping_rates.desde_kg is 'Límite inferior del tramo, INCLUIDO.';
comment on column public.shipping_rates.hasta_kg is 'Límite superior del tramo, EXCLUIDO.';
comment on column public.shipping_rates.updated_by is 'Quién la cambió por última vez (auth.uid() de la sesión; null si fue un script).';

create trigger set_shipping_rates_updated_at before update on public.shipping_rates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. RLS y permisos
-- ---------------------------------------------------------------------------
alter table public.shipping_rates enable row level security;

create policy shipping_rates_select on public.shipping_rates
  for select using (public.is_agent());
create policy shipping_rates_insert on public.shipping_rates
  for insert with check (public.is_supervisor_or_admin());
create policy shipping_rates_update on public.shipping_rates
  for update using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());
create policy shipping_rates_delete on public.shipping_rates
  for delete using (public.is_supervisor_or_admin());

-- El `alter default privileges` de Supabase le da ALL a anon/authenticated/
-- service_role a toda tabla nueva de `public`: se deja explícito lo que cada
-- rol necesita (anon, nada).
revoke all on public.shipping_rates from anon;
grant select, insert, update, delete on public.shipping_rates to authenticated;
grant all on public.shipping_rates to service_role;

-- ---------------------------------------------------------------------------
-- 3. Siembra: tarifas MRW (34 tramos)
-- ---------------------------------------------------------------------------
-- La baja de 14,70 (42-43 kg) a 13,91 (43-45 kg) se carga tal cual por
-- decisión del operador (P1, pendiente de confirmar con MRW).
insert into public.shipping_rates (carrier, desde_kg, hasta_kg, tarifa_usd) values
  ('mrw', 0.001, 0.500, 0.70),
  ('mrw', 0.500, 1, 0.70),
  ('mrw', 1, 2, 1.40),
  ('mrw', 2, 3, 2.10),
  ('mrw', 3, 4, 2.80),
  ('mrw', 4, 5, 3.50),
  ('mrw', 5, 6, 4.20),
  ('mrw', 6, 8, 4.90),
  ('mrw', 8, 10, 5.60),
  ('mrw', 10, 12, 6.30),
  ('mrw', 12, 14, 7.00),
  ('mrw', 14, 16, 7.70),
  ('mrw', 16, 18, 8.40),
  ('mrw', 18, 21, 9.10),
  ('mrw', 21, 24, 9.80),
  ('mrw', 24, 27, 10.50),
  ('mrw', 27, 30, 11.20),
  ('mrw', 30, 33, 11.90),
  ('mrw', 33, 36, 12.60),
  ('mrw', 36, 39, 13.30),
  ('mrw', 39, 42, 14.00),
  ('mrw', 42, 43, 14.70),
  ('mrw', 43, 45, 13.91),
  ('mrw', 45, 48, 14.58),
  ('mrw', 48, 51, 15.24),
  ('mrw', 51, 54, 15.90),
  ('mrw', 54, 57, 16.56),
  ('mrw', 57, 60, 17.23),
  ('mrw', 60, 63, 17.89),
  ('mrw', 63, 66, 18.55),
  ('mrw', 66, 69, 19.21),
  ('mrw', 69, 72, 19.88),
  ('mrw', 72, 75, 20.54),
  ('mrw', 75, 80, 21.20);

-- ---------------------------------------------------------------------------
-- 4. Funciones
-- ---------------------------------------------------------------------------
create function public.tarifa_mrw_usd(p_peso numeric)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when p_peso is null or p_peso <= 0 or p_peso >= 80 then null
    else (
      select r.tarifa_usd
      from public.shipping_rates r
      where r.carrier = 'mrw'
        and r.desde_kg <= p_peso
        and p_peso < r.hasta_kg
    )
  end;
$$;

comment on function public.tarifa_mrw_usd(numeric) is
  'Tarifa MRW en USD para un peso en kg: null si el peso es null, <= 0 o >= 80, o si ningún tramo lo cubre. Tramos [desde, hasta).';

-- Campo calculado de PostgREST: `select=...,tarifa_envio_usd` sobre products.
create function public.tarifa_envio_usd(p public.products)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select public.tarifa_mrw_usd(p.weight_kg);
$$;

comment on function public.tarifa_envio_usd(public.products) is
  'Campo calculado de PostgREST sobre products: la tarifa MRW en USD según weight_kg (null sin peso). Precio estándar = precio + esta tarifa, calculado al leer, nunca guardado.';

revoke execute on function public.tarifa_mrw_usd(numeric) from public;
revoke execute on function public.tarifa_mrw_usd(numeric) from anon;
grant execute on function public.tarifa_mrw_usd(numeric) to authenticated, service_role;

revoke execute on function public.tarifa_envio_usd(public.products) from public;
revoke execute on function public.tarifa_envio_usd(public.products) from anon;
grant execute on function public.tarifa_envio_usd(public.products) to authenticated, service_role;

notify pgrst, 'reload schema';
