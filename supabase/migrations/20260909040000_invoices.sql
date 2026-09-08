-- ============================================================================
-- Las bases de la factura (T5, plan "Seis frentes del buzón", 8/9/2026)
--
-- El operador quiere poder generar una factura de una venta cerrada, pero
-- todavía no tiene todos los datos fiscales del negocio (RIF, dirección
-- fiscal, serie, si aplica IVA). Esta tabla deja las bases hechas SIN
-- inventar ninguno de esos datos: `INVOICE_ISSUER` (src/lib/invoices.ts) los
-- trae en null y la hoja imprimible los pinta como "Por definir" mientras lo
-- sigan siendo. No hay generación de PDF en servidor: la hoja se imprime
-- desde el navegador con window.print().
--
-- `customer`/`items` son SNAPSHOT, no referencias vivas -- ver el comentario
-- de esas dos columnas más abajo. Una venta es una conversación con
-- `deal_status in ('won','returned')` (ver Sale en src/lib/types.ts); al
-- cerrarla, `closeSaleWithContactInfo` ya deja `orders`/`order_items` y
-- enlaza `conversations.order_id` (migración 20260820060000) -- de ahí sale
-- el contenido de la factura, nunca de un número escrito a mano.
--
-- `number` es un correlativo propio (secuencia aparte, no el `id` uuid): es
-- lo que un cliente espera ver en una factura ("Factura N° 000123"), y tiene
-- que ser una serie continua independiente de cuántas filas tenga cualquier
-- otra tabla. `formatInvoiceNumber` (src/lib/invoices.ts) lo pinta como
-- "SBK-000001".
--
-- Emitir y anular son acciones sensibles (una vez emitida, una factura no se
-- debería poder alterar en la práctica) -- por eso el `update` exige
-- `is_supervisor_or_admin()` en RLS, no solo en la interfaz. Generar el
-- borrador SÍ lo puede hacer cualquier asesor (`is_agent()`): es apenas la
-- primera mitad del trabajo de cerrar una venta.
-- ============================================================================

create sequence if not exists public.invoice_number_seq;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.invoice_number_seq'),
  conversation_id uuid references public.conversations (id) on delete set null,
  order_id uuid references public.orders (id) on delete set null,
  contact_id uuid not null references public.contacts (id),
  customer jsonb not null,
  items jsonb not null,
  subtotal numeric(12, 2) not null,
  tax_rate numeric(5, 4) not null default 0,
  tax_amount numeric(12, 2) not null,
  total numeric(12, 2) not null,
  currency text not null default 'USD' check (currency in ('USD', 'VES')),
  bcv_rate numeric(12, 4),
  status text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  issued_at timestamptz,
  issued_by uuid references public.agents (id) on delete set null,
  voided_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.invoices.customer is
  'Snapshot del contacto al momento de facturar (nombre, teléfono, cédula, dirección) -- copiado, no una referencia. Si después editan el contacto, la factura ya generada no cambia.';
comment on column public.invoices.items is
  'Snapshot de los renglones de order_items al momento de facturar -- copiado, no una referencia. Si después editan el producto, la factura ya generada no cambia.';
comment on column public.invoices.bcv_rate is
  'Tasa BCV vigente al generar la factura, para poder mostrar el total también en bolívares. Null si no se pudo leer la tasa ese día -- la hoja lo muestra como "Por definir" en vez de inventar un número.';
comment on column public.invoices.tax_rate is
  'IVA pendiente de decisión del operador -- 0 por defecto (DEFAULT_TAX_RATE en src/lib/invoices.ts) hasta que lo defina.';

create index if not exists invoices_conversation_id_idx
  on public.invoices (conversation_id);

-- ---------------------------------------------------------------------------
-- Mismo trigger genérico que ya usan ai_playbooks y demás tablas con
-- updated_at (public.set_updated_at(), 20260819000001_initial_schema.sql).
-- ---------------------------------------------------------------------------
drop trigger if exists set_invoices_updated_at on public.invoices;
create trigger set_invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Generar el borrador (select/insert) es trabajo de cualquier asesor,
-- igual que cerrar la venta que lo origina. Emitir o anular (update) es
-- sensible -- exige supervisor/admin EN LA BASE, no solo un botón escondido
-- en la interfaz (misma regla que model_pricing, 20260820050000). Sin
-- policy de delete: una factura no se borra, se anula -- el rastro se
-- conserva siempre.
-- ---------------------------------------------------------------------------
alter table public.invoices enable row level security;

drop policy if exists "invoices_select" on public.invoices;
create policy "invoices_select" on public.invoices
  for select using (public.is_agent());

drop policy if exists "invoices_insert" on public.invoices;
create policy "invoices_insert" on public.invoices
  for insert with check (public.is_agent());

drop policy if exists "invoices_update" on public.invoices;
create policy "invoices_update" on public.invoices
  for update using (public.is_supervisor_or_admin()) with check (public.is_supervisor_or_admin());

grant select, insert, update on public.invoices to authenticated;
grant all on public.invoices to service_role;
grant usage, select on public.invoice_number_seq to authenticated, service_role;

notify pgrst, 'reload schema';
