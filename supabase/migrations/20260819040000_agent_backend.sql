-- ============================================================================
-- Backend del agente de IA (SBK Motors)
--
-- Catálogo de repuestos, historial de compras, caché de la tasa BCV, turno de
-- asesores para el escalamiento, bitácora de turnos del agente (panel de
-- control en vivo) e interruptor global de la IA.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRODUCTS / PRODUCT_COMPATIBILITY
-- Catálogo real que consulta la herramienta "buscar repuesto". El precio vive
-- en dólares; la conversión a bolívares se hace en tiempo de consulta con la
-- tasa BCV cacheada (ver exchange_rates).
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand text,
  price numeric(12, 2) not null,
  currency text not null default 'USD' check (currency in ('USD', 'VES')),
  stock_quantity integer not null default 0,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.products.price is 'Precio en la moneda indicada por currency. Por convención, USD.';
comment on column public.products.stock_quantity is 'Una sola sucursal: el stock vive directo en el producto, sin tabla de inventario aparte.';

create table public.product_compatibility (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  moto_brand text not null,
  moto_model text not null
);

comment on table public.product_compatibility is 'Con qué motos (marca + modelo) calza un repuesto. Un repuesto puede servir para varias motos.';

create index product_compatibility_product_id_idx on public.product_compatibility (product_id);
create index product_compatibility_moto_idx on public.product_compatibility (moto_brand, moto_model);

-- ---------------------------------------------------------------------------
-- ORDERS / ORDER_ITEMS
-- Historial real de compras por contacto. La herramienta de devolución lo
-- consulta en modo solo-lectura: el agente de IA nunca aprueba ni procesa
-- nada aquí, solo arma contexto para el asesor humano.
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  purchased_at timestamptz not null default now(),
  total_amount numeric(12, 2) not null,
  currency text not null default 'USD' check (currency in ('USD', 'VES')),
  bcv_rate numeric(12, 4),
  created_at timestamptz not null default now()
);

comment on column public.orders.bcv_rate is 'Tasa BCV vigente el día de la venta, para que el monto quede trazable aunque la tasa cambie después.';

create index orders_contact_id_idx on public.orders (contact_id, purchased_at desc);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  description text not null,
  quantity integer not null default 1,
  unit_price numeric(12, 2) not null
);

comment on column public.order_items.product_id is 'Null si el producto ya no está en catálogo (descontinuado) o se vendió antes de que existiera el catálogo.';

create index order_items_order_id_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- EXCHANGE_RATES
-- Caché diaria de la tasa oficial del BCV, leída directo de bcv.org.ve. Si la
-- lectura del día falla, el código usa la fila más reciente en vez de fallar.
-- ---------------------------------------------------------------------------
create table public.exchange_rates (
  rate_date date primary key,
  usd_to_ves numeric(12, 4) not null,
  fetched_at timestamptz not null default now(),
  source text not null default 'bcv.org.ve'
);

-- ---------------------------------------------------------------------------
-- AGENT_SETTINGS
-- Fila única: interruptor global para apagar la IA en todo el CRM de una vez
-- (kill switch), sin tener que pausarla conversación por conversación.
-- ---------------------------------------------------------------------------
create table public.agent_settings (
  id boolean primary key default true,
  ai_globally_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null,
  constraint agent_settings_singleton check (id)
);

insert into public.agent_settings (id, ai_globally_enabled) values (true, true);

comment on table public.agent_settings is 'Fila única (id siempre true). ai_globally_enabled en false apaga la IA en todo el CRM sin tocar cada conversación.';

-- ---------------------------------------------------------------------------
-- AGENT_TURNS
-- Bitácora de cada turno que corre el agente de IA: qué intención detectó,
-- qué hizo (respondió / escaló / se quedó sin pasos) y con qué modelo.
-- Alimenta el feed en vivo del panel de control.
-- ---------------------------------------------------------------------------
create table public.agent_turns (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  intent text check (intent in ('consulta_disponibilidad', 'devolucion', 'queja', 'otro')),
  action text not null check (action in ('answered', 'escalated', 'error', 'skipped')),
  summary text,
  model text,
  created_at timestamptz not null default now()
);

comment on column public.agent_turns.action is 'answered: resolvió sola. escalated: pasó a un asesor. error: falló y se detuvo. skipped: no corrió (guardrail).';

create index agent_turns_conversation_id_idx on public.agent_turns (conversation_id, created_at desc);
create index agent_turns_created_at_idx on public.agent_turns (created_at desc);

-- ---------------------------------------------------------------------------
-- Turno de asesores: quién lleva más tiempo sin recibir una asignación.
-- Se actualiza solo, con cualquier asignación (de la IA o manual).
-- ---------------------------------------------------------------------------
alter table public.agents add column last_assigned_at timestamptz;

comment on column public.agents.last_assigned_at is 'Última vez que se le asignó una conversación (IA o manual). Base del reparto por turno al escalar.';

create function public.handle_conversation_assigned()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.assigned_agent_id is not null
     and (TG_OP = 'INSERT' or new.assigned_agent_id is distinct from old.assigned_agent_id) then
    update public.agents set last_assigned_at = now() where id = new.assigned_agent_id;
  end if;
  return new;
end;
$$;

create trigger on_conversation_assigned
  after insert or update of assigned_agent_id on public.conversations
  for each row execute function public.handle_conversation_assigned();

-- ---------------------------------------------------------------------------
-- La intención que escribe la IA solo puede ser una de las 4 categorías.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add constraint conversations_intent_check
  check (intent is null or intent in ('consulta_disponibilidad', 'devolucion', 'queja', 'otro'));

-- ---------------------------------------------------------------------------
-- Realtime: el panel de control necesita ver conversaciones y turnos en vivo.
-- public.conversations ya está publicada desde el schema inicial.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.agent_turns;
alter publication supabase_realtime add table public.agent_settings;

-- ---------------------------------------------------------------------------
-- RLS — mismo criterio que el resto del CRM: cualquier agente autenticado
-- puede leer/escribir todo.
-- ---------------------------------------------------------------------------
alter table public.products enable row level security;
alter table public.product_compatibility enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.agent_settings enable row level security;
alter table public.agent_turns enable row level security;

create policy "products_all" on public.products for all
  using (public.is_agent()) with check (public.is_agent());
create policy "product_compatibility_all" on public.product_compatibility for all
  using (public.is_agent()) with check (public.is_agent());
create policy "orders_all" on public.orders for all
  using (public.is_agent()) with check (public.is_agent());
create policy "order_items_all" on public.order_items for all
  using (public.is_agent()) with check (public.is_agent());
create policy "exchange_rates_all" on public.exchange_rates for all
  using (public.is_agent()) with check (public.is_agent());
create policy "agent_settings_all" on public.agent_settings for all
  using (public.is_agent()) with check (public.is_agent());
create policy "agent_turns_all" on public.agent_turns for all
  using (public.is_agent()) with check (public.is_agent());

grant select, insert, update, delete on
  public.products,
  public.product_compatibility,
  public.orders,
  public.order_items,
  public.exchange_rates,
  public.agent_settings,
  public.agent_turns
to authenticated, service_role;
