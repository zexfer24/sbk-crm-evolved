-- ============================================================================
-- Tarea T8 · plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
-- esperando" (28/9/2026), Entrega B: el carrito vive en la CONVERSACIÓN.
--
-- Contexto: hasta hoy "lo que lleva el cliente" solo existía en el estado de
-- React de `CloseSaleModal` (`useState<SaleCartItem[]>`): el asesor lo armaba
-- al pulsar "Cerrar venta", y cerrar el modal o recargar la pestaña lo perdía
-- todo. El operador pidió (28/9/2026) un carrito PERSISTENTE que el asesor va
-- llenando mientras conversa (desde la búsqueda del panel derecho o desde lo
-- que Seba cotizó), que otro asesor vea en vivo y que "Cerrar venta" tome
-- tal cual.
--
-- Decisión D6 del plan: PRECIO VIGENTE AL FACTURAR. La tabla guarda solo
-- `product_id` y `quantity`; el precio NO se copia acá. Sale de `products` +
-- tasa BCV (`productPriceUsd`/`usdFromBs`) en el momento de mirar el carrito
-- y de facturar. Por eso no hay columna de precio: una copia se desactualizaría
-- en cuanto Saint cambie el precio o el BCV la tasa, y el cierre de venta
-- cobraría algo distinto de lo que el asesor ve en pantalla.
--
-- Columnas:
--   · `quote_id` (nullable): la cotización de Seba (`conversation_quotes`)
--     de la que vino el renglón, para poder mostrar "cotizado $X · hoy $Y"
--     cuando el precio cambió. `on delete set null`: la cotización es un log
--     de auditoría y el renglón sigue siendo válido sin ella.
--   · `origin`: 'quote' (vino de una cotización de Seba) o 'inventory' (lo
--     agregó el asesor desde la búsqueda). Es la misma distinción de
--     `SaleItemOrigin` en el modal de cierre.
--   · `added_by`: quién lo agregó, por defecto el agente de la sesión.
--
-- `unique (conversation_id, product_id)`: un repetido SUMA unidades (lo hace
-- `addToCart` en `mutations.ts`), nunca duplica el renglón.
--
-- RLS: cualquier agente autenticado lee y escribe (`is_agent()`), igual que
-- `conversation_quotes` y el resto de la bandeja compartida; cuatro políticas
-- explícitas, una por operación. `anon` no recibe nada.
--
-- Realtime: la tabla entra a `supabase_realtime` con `replica identity full`
-- (un DELETE filtrado por `conversation_id` solo llega al canal si la réplica
-- trae el registro viejo completo -- misma lección que `notes`,
-- 20260819080000, y `contact_tags`, ver CLAUDE.md), y la migración se
-- autoverifica: un canal suscrito a una tabla NO publicada no falla, calla
-- para siempre (trampa del 8/9/2026, `conversation_handoffs`).
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. Solo crea
-- una tabla nueva y toca la publicación (`alter publication` pide un lock
-- breve sobre el catálogo), no reescribe ninguna tabla existente.
--
-- No hay función `security definer` nueva: el "upsert que suma" lo hace
-- `addToCart` en TypeScript con concurrencia optimista, sin RPC.
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

create table public.conversation_cart_items (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  origin text not null check (origin in ('quote', 'inventory')),
  quote_id uuid references public.conversation_quotes(id) on delete set null,
  added_by uuid references public.agents(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_cart_items_unique_product unique (conversation_id, product_id)
);

comment on table public.conversation_cart_items is
  'Carrito persistente de una conversación (T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", 28/9/2026). Guarda solo product_id y quantity: el precio es el VIGENTE (products + BCV) al mirar y al facturar (D6), nunca una copia.';
comment on column public.conversation_cart_items.quote_id is
  'Cotización de Seba (conversation_quotes) de la que vino el renglón, para mostrar "cotizado $X · hoy $Y". null si lo agregó el asesor desde el inventario o si la cotización se borró.';

create trigger set_conversation_cart_items_updated_at
  before update on public.conversation_cart_items
  for each row execute function public.set_updated_at();

-- Para leer el carrito de una conversación (siempre filtra por ella). El
-- índice del unique (conversation_id, product_id) ya cubre ese prefijo, así
-- que no hace falta uno aparte.

alter table public.conversation_cart_items enable row level security;

create policy "conversation_cart_items_select" on public.conversation_cart_items
  for select using (public.is_agent());
create policy "conversation_cart_items_insert" on public.conversation_cart_items
  for insert with check (public.is_agent());
create policy "conversation_cart_items_update" on public.conversation_cart_items
  for update using (public.is_agent()) with check (public.is_agent());
create policy "conversation_cart_items_delete" on public.conversation_cart_items
  for delete using (public.is_agent());

-- El `alter default privileges` de Supabase le da ALL a anon/authenticated/
-- service_role a toda tabla nueva de `public`: se corta lo de anon y se deja
-- explícito lo que sí hace falta (mismo criterio que `product_weight_audit`,
-- 20260925010000). La RLS igual frena a anon (`is_agent()` da false).
revoke all on public.conversation_cart_items from public;
revoke all on public.conversation_cart_items from anon;
grant select, insert, update, delete on public.conversation_cart_items to authenticated, service_role;

-- Un DELETE filtrado por conversation_id solo llega por Realtime si la
-- réplica trae la fila vieja entera.
alter table public.conversation_cart_items replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'conversation_cart_items'
  ) then
    alter publication supabase_realtime add table public.conversation_cart_items;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real: la publicación (un canal sobre una
-- tabla no publicada calla para siempre), la réplica completa, el unique, la
-- RLS y que anon no tenga acceso.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'conversation_cart_items'
  ) then
    raise exception '20260929010000: conversation_cart_items no quedó publicada en supabase_realtime';
  end if;

  if (select relreplident from pg_class where oid = 'public.conversation_cart_items'::regclass) is distinct from 'f' then
    raise exception '20260929010000: conversation_cart_items debía quedar con replica identity full';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.conversation_cart_items'::regclass) then
    raise exception '20260929010000: conversation_cart_items debía tener la RLS activa';
  end if;

  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'conversation_cart_items';
  if n is distinct from 4 then
    raise exception '20260929010000: se esperaban 4 políticas en conversation_cart_items, hay %', n;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.conversation_cart_items'::regclass and contype = 'u'
  ) then
    raise exception '20260929010000: falta el unique (conversation_id, product_id)';
  end if;

  if has_table_privilege('anon', 'public.conversation_cart_items', 'select') then
    raise exception '20260929010000: anon no debía poder leer conversation_cart_items';
  end if;

  raise notice '20260929010000: autoverificación de conversation_cart_items correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la tabla nueva da
-- 404 hasta que alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
