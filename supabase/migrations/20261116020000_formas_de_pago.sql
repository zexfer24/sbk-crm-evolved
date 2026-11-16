-- ============================================================================
-- Formas de pago de contado (T1, plan "Entrega 2 de Seba v2: los datos del
-- negocio", 16/11/2026)
--
-- Qué es: `public.payment_methods` guarda las formas de pago de CONTADO del
-- negocio (pago móvil, transferencia, Binance…) con el texto de instrucciones
-- que se le da al cliente. Hasta esta fecha ese texto vivía suelto en mensajes
-- rápidos y en la cabeza de los asesores; Seba v2 necesita una fuente única que
-- pueda leer en el turno (entrega 3, herramienta `prepararPago`).
--
-- `seba_entrega` decide qué hace Seba con una forma: `true` = envía
-- `instructions` junto con el total; `false` = la ofrece y pasa a ventas (el
-- caso de Binance, donde el monto en divisa lo confirma un asesor).
--
-- `key <> 'cashea'`: la herramienta `prepararPago` arma su enum con `"cashea"`
-- más las claves activas de esta tabla. Cashea no es una forma de contado (tiene
-- su propia calculadora); si alguien creara una fila `cashea`, el enum tendría
-- el valor duplicado y la herramienta se rompería. El CHECK lo impide en la base.
--
-- Quién lee y quién escribe: cualquier asesor (`is_agent()`: agent, supervisor,
-- admin; la caja no) LEE; solo supervisor/admin escribe, y EN RLS, no solo en la
-- interfaz (CLAUDE.md, "Base"). `service_role` queda con todo: el turno de Seba
-- la leerá con el cliente admin.
--
-- La migración NO inserta filas: los datos reales (cuentas, teléfonos, cédulas)
-- los carga el VPS; el repo es público. El seed de desarrollo trae filas
-- INVENTADAS.
--
-- No entra a `supabase_realtime`: cambia rara vez y se lee al abrir el panel.
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

-- ---------------------------------------------------------------------------
-- La tabla
-- ---------------------------------------------------------------------------
create table if not exists public.payment_methods (
  key          text primary key
                 constraint payment_methods_key_format check (key ~ '^[a-z_]{3,30}$')
                 constraint payment_methods_key_no_cashea check (key <> 'cashea'),
  label        text not null
                 constraint payment_methods_label_length check (char_length(label) between 1 and 60),
  currency     text not null
                 constraint payment_methods_currency_check check (currency in ('VES', 'USD')),
  instructions text not null
                 constraint payment_methods_instructions_length check (char_length(instructions) between 1 and 1500),
  seba_entrega boolean not null default false,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.agents (id) on delete set null
);

comment on table public.payment_methods is
  'Formas de pago de contado del negocio y el texto de instrucciones que se le da al cliente (T1, plan "Entrega 2 de Seba v2", 16/11/2026). Cashea NO va aquí: tiene su propia calculadora y la clave `cashea` está prohibida por CHECK. Los datos reales los carga el VPS; el repo es público.';
comment on column public.payment_methods.key is
  'Clave estable (minúsculas y guion bajo, 3-30). La usa la herramienta `prepararPago` de Seba como valor de su enum; por eso `cashea` está prohibida: la herramienta ya agrega ese valor por su cuenta.';
comment on column public.payment_methods.seba_entrega is
  'true: Seba envía `instructions` junto con el total; false: Seba la ofrece y pasa a ventas, el caso de Binance.';
comment on column public.payment_methods.updated_by is
  'El agente que hizo el último cambio. on delete set null: borrar el agente no debe borrar la forma de pago.';

-- updated_at: reutiliza public.set_updated_at(), el trigger genérico de la
-- migración inicial.
drop trigger if exists set_payment_methods_updated_at on public.payment_methods;
create trigger set_payment_methods_updated_at before update on public.payment_methods
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: el asesor lee, el supervisor/admin escribe
-- ---------------------------------------------------------------------------
alter table public.payment_methods enable row level security;

drop policy if exists "payment_methods_select" on public.payment_methods;
create policy "payment_methods_select" on public.payment_methods
  for select to authenticated
  using (public.is_agent());

drop policy if exists "payment_methods_insert" on public.payment_methods;
create policy "payment_methods_insert" on public.payment_methods
  for insert to authenticated
  with check (public.is_supervisor_or_admin());

drop policy if exists "payment_methods_update" on public.payment_methods;
create policy "payment_methods_update" on public.payment_methods
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "payment_methods_delete" on public.payment_methods;
create policy "payment_methods_delete" on public.payment_methods
  for delete to authenticated
  using (public.is_supervisor_or_admin());

-- Los DOS caminos de privilegio de fábrica (CLAUDE.md, "Trampas"): se quita
-- todo y se da de vuelta solo lo que hace falta. `anon` queda sin nada.
revoke all on public.payment_methods from public;
revoke all on public.payment_methods from anon, authenticated;
grant select, insert, update, delete on public.payment_methods to authenticated;
grant select, insert, update, delete on public.payment_methods to service_role;

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.payment_methods'::regclass) then
    raise exception '20261116020000: payment_methods no tiene RLS activa';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'payment_methods') <> 4 then
    raise exception '20261116020000: payment_methods debía tener exactamente cuatro políticas (select, insert, update, delete)';
  end if;
  if has_table_privilege('anon', 'public.payment_methods', 'select') then
    raise exception '20261116020000: anon todavía puede leer payment_methods';
  end if;
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payment_methods'
  ) then
    raise exception '20261116020000: payment_methods no debía estar publicada en supabase_realtime';
  end if;
end $$;

notify pgrst, 'reload schema';
