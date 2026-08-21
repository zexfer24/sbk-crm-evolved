-- ============================================================================
-- El monto de una venta debe salir de lo que la herramienta de catálogo
-- REALMENTE le cotizó al cliente -- no de un número que el agente escribe a
-- mano al cerrar (eso se presta a error y no queda trazado a nada real).
--
-- 1. conversation_quotes: cada vez que buildCatalogTool devuelve resultados,
--    se guarda una fila por cada uno -- precio, tasa BCV usada y el producto
--    exacto, en el momento exacto en que se cotizó. Es un log de auditoría
--    de lo que la IA dijo, no una tabla operativa que se edite.
-- 2. conversations.order_id: al cerrar la venta se crea una fila en `orders`
--    (que ya existía en el esquema pero nadie insertaba nada ahí) a partir
--    de las cotizaciones que el agente seleccionó, y se enlaza acá para que
--    el módulo de Ventas pueda mostrar el monto sin adivinar.
-- ============================================================================

create table public.conversation_quotes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  price_usd numeric(10,2) not null,
  price_bs numeric(14,2) not null,
  bcv_rate numeric(10,4) not null,
  quoted_at timestamptz not null default now()
);

create index conversation_quotes_conversation_id_idx
  on public.conversation_quotes (conversation_id, quoted_at desc);

alter table public.conversation_quotes enable row level security;

create policy "conversation_quotes_all" on public.conversation_quotes for all
  using (public.is_agent()) with check (public.is_agent());

grant select, insert, update, delete on public.conversation_quotes to authenticated, service_role;

alter table public.conversations
  add column order_id uuid references public.orders(id) on delete set null;
