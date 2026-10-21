-- ============================================================================
-- Presupuestos guardados (21/10/2026), plan "Presupuestos y mensajes rápidos".
--
-- Contexto: el cliente pidió guardar VARIOS carritos o presupuestos por
-- cliente, con nombre y apellido, para reabrirlos después -- desde el carrito
-- de /inventario y desde el carrito del chat. Hasta hoy el carrito de la
-- conversación (`conversation_cart_items`, 20260929010000) es uno solo por
-- chat y el de Inventario vive en memoria: cerrar la pestaña lo pierde.
--
-- Decisiones aprobadas del plan:
--   D1. Se cobra el PRECIO DE HOY. `precio_cotizado_usd` y `total_cotizado_usd`
--       son solo referencia (para mostrar "cotizado $X · hoy $Y"), nunca se
--       facturan -- misma regla D6 de 20260929010000: una copia de precio se
--       desactualiza en cuanto Saint cambia el precio o el BCV la tasa.
--   D2. Todo el equipo VE y REABRE presupuestos; solo el autor o un
--       supervisor/admin los cambia o borra, EN RLS, no solo en la interfaz.
--   D3. "Borrar todos" borra solo los propios (lo filtra el cliente con
--       `created_by = auth.uid()`; un supervisor igual podría borrar los
--       ajenos uno por uno).
--   D4. La caja (rol `caja`: `is_agent()` la excluye y `can_read_inventory()`
--       la incluye, 20261013010000) puede VER y GUARDAR presupuestos, pero
--       NUNCA con `price_kind = 'estandar'`: ese precio lleva la tarifa de
--       envío MRW y la caja no la ve (20261014030000). La guarda vive en la
--       política de INSERT de los renglones (`or public.is_agent()`), no en la
--       interfaz: un cliente de API directo tampoco la salta.
--
-- Diseño:
--   · `presupuestos` (cabecera) + `presupuesto_items` (renglones, un producto
--     por presupuesto). Los renglones NO se actualizan: se REEMPLAZAN (borrar +
--     insertar), por eso no llevan grant de UPDATE.
--   · `guardar_presupuesto(...)` guarda cabecera y renglones en UNA llamada, así
--     que es atómica: un renglón inválido (producto inexistente, caja con
--     estándar) revierte también la cabecera. Es `security INVOKER` a
--     propósito: la RLS se evalúa como quien llama (el autor, un supervisor, la
--     caja); un `definer` se saltaría justo la guarda de D4. Una RLS que
--     filtra el UPDATE con 0 filas NO lanza error (trampa de CLAUDE.md,
--     28/9/2026): la RPC lo convierte en `42501` explícito.
--   · Las tablas NO se publican por Realtime (fuera de alcance de este plan).
--
-- `products` no se toca: sigue de solo lectura para la app salvo `weight_kg`.
-- Las FKs a `products`/`contacts`/`conversations` son de ESTA tabla hacia
-- ellas; ninguna ALTER sobre las tablas existentes, así que no hay lock largo
-- que temer más allá del breve de la FK.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso.
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
-- 1. Tablas
-- ---------------------------------------------------------------------------
create table public.presupuestos (
  id uuid primary key default gen_random_uuid(),
  cliente_nombre text not null check (char_length(btrim(cliente_nombre)) between 1 and 80),
  cliente_apellido text not null check (char_length(btrim(cliente_apellido)) between 1 and 80),
  contact_id uuid null references public.contacts(id) on delete set null,
  conversation_id uuid null references public.conversations(id) on delete set null,
  origen text not null default 'inventario' check (origen in ('inventario', 'chat')),
  nota text null check (nota is null or char_length(nota) <= 280),
  total_cotizado_usd numeric(12,2) null,          -- referencia (D1), nunca se cobra
  created_by uuid null default auth.uid() references public.agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.presupuestos is
  'Presupuesto guardado de un cliente (plan "Presupuestos y mensajes rápidos", 21/10/2026). Cabecera; los renglones están en presupuesto_items. total_cotizado_usd es REFERENCIA: se cobra el precio de hoy (D1). Se escribe por guardar_presupuesto().';
comment on column public.presupuestos.total_cotizado_usd is
  'Suma de precio_cotizado_usd * quantity al guardar; null si algún renglón no traía precio. Solo referencia (D1), nunca se factura.';

create index presupuestos_created_by_updated_idx on public.presupuestos (created_by, updated_at desc);
create index presupuestos_updated_idx on public.presupuestos (updated_at desc);
create index presupuestos_contact_idx on public.presupuestos (contact_id) where contact_id is not null;

create trigger set_presupuestos_updated_at
  before update on public.presupuestos
  for each row execute function public.set_updated_at();

create table public.presupuesto_items (
  id uuid primary key default gen_random_uuid(),
  presupuesto_id uuid not null references public.presupuestos(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null check (quantity between 1 and 9999),
  price_kind text not null default 'promocion' check (price_kind in ('promocion', 'estandar')),
  precio_cotizado_usd numeric(12,2) null,          -- precio unitario vigente al guardar
  created_at timestamptz not null default now(),
  unique (presupuesto_id, product_id)
);

comment on column public.presupuesto_items.precio_cotizado_usd is
  'Precio unitario vigente al guardar. Solo referencia (D1): al reabrir y facturar se usa el precio de hoy.';
comment on column public.presupuesto_items.price_kind is
  '''promocion'' | ''estandar''. La caja no puede guardar ''estandar'' (D4): lo frena la política presupuesto_items_insert.';

-- El unique (presupuesto_id, product_id) ya cubre las lecturas por prefijo
-- presupuesto_id, pero el índice explícito mantiene la forma del plan y no
-- cuesta nada a este volumen.
create index presupuesto_items_presupuesto_idx on public.presupuesto_items (presupuesto_id);

-- ---------------------------------------------------------------------------
-- 2. Permisos de tabla
-- ---------------------------------------------------------------------------
-- El `alter default privileges` de Supabase le da ALL a anon/authenticated/
-- service_role a toda tabla nueva de `public`: se corta todo y se concede solo
-- lo que hace falta (mismo criterio que `product_weight_audit`, 20260925010000).
revoke all on public.presupuestos from public;
revoke all on public.presupuestos from anon, authenticated;
revoke all on public.presupuesto_items from public;
revoke all on public.presupuesto_items from anon, authenticated;

grant select, insert, update, delete on public.presupuestos to authenticated, service_role;
-- Los renglones no se actualizan: se reemplazan (borrar + insertar).
grant select, insert, delete on public.presupuesto_items to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------
alter table public.presupuestos enable row level security;
alter table public.presupuesto_items enable row level security;

-- Lectura: todo el equipo, caja incluida (D2, D4). `can_read_inventory()` es
-- "tiene fila en agents, con cualquier rol" y es definer: se evalúa una vez
-- por consulta, no por fila.
create policy presupuestos_select on public.presupuestos
  for select using (public.can_read_inventory());

-- Crear: cualquiera que lea el inventario, y a SU nombre (no se firma por otro).
create policy presupuestos_insert on public.presupuestos
  for insert with check (public.can_read_inventory() and created_by = auth.uid());

-- Cambiar y borrar: el autor o un supervisor/admin (D2).
create policy presupuestos_update on public.presupuestos
  for update
  using (public.can_read_inventory() and (created_by = auth.uid() or public.is_supervisor_or_admin()))
  with check (public.can_read_inventory() and (created_by = auth.uid() or public.is_supervisor_or_admin()));

create policy presupuestos_delete on public.presupuestos
  for delete
  using (public.can_read_inventory() and (created_by = auth.uid() or public.is_supervisor_or_admin()));

create policy presupuesto_items_select on public.presupuesto_items
  for select using (public.can_read_inventory());

-- Insertar renglones: el padre tiene que ser propio (o el usuario ser
-- supervisor/admin) Y, si el renglón es de precio estándar, quien lo guarda
-- tiene que ser un agente de verdad (`is_agent()` excluye a la caja: D4).
create policy presupuesto_items_insert on public.presupuesto_items
  for insert with check (
    exists (
      select 1 from public.presupuestos p
       where p.id = presupuesto_id
         and (p.created_by = auth.uid() or public.is_supervisor_or_admin())
    )
    and (price_kind = 'promocion' or public.is_agent())
  );

create policy presupuesto_items_delete on public.presupuesto_items
  for delete using (
    exists (
      select 1 from public.presupuestos p
       where p.id = presupuesto_id
         and (p.created_by = auth.uid() or public.is_supervisor_or_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- 4. guardar_presupuesto(): cabecera + renglones en una sola llamada atómica
-- ---------------------------------------------------------------------------
-- p_items: [{"product_id": uuid, "quantity": int, "price_kind": text,
--            "precio_cotizado_usd": number|null}, ...]  (1 a 100 elementos)
-- p_id null => presupuesto nuevo; si no, REEMPLAZA nombre/apellido/nota/total
-- y los renglones del existente (created_by, contact_id, conversation_id y
-- origen no se tocan). Devuelve el id.
create function public.guardar_presupuesto(
  p_id uuid,
  p_cliente_nombre text,
  p_cliente_apellido text,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_origen text,
  p_nota text,
  p_items jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_nombre text := btrim(p_cliente_nombre);
  v_apellido text := btrim(p_cliente_apellido);
  v_nota text := nullif(btrim(coalesce(p_nota, '')), '');
  v_total numeric(12,2);
  v_sin_precio boolean;
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'presupuesto_sin_renglones' using errcode = '22023';
  end if;

  -- Total de referencia (D1): null si algún renglón no trae precio, para no
  -- publicar una suma a medias que parezca verdad.
  select
    round(sum((e ->> 'precio_cotizado_usd')::numeric * (e ->> 'quantity')::integer), 2),
    coalesce(bool_or((e ->> 'precio_cotizado_usd') is null), false)
    into v_total, v_sin_precio
    from jsonb_array_elements(p_items) e;
  if v_sin_precio then
    v_total := null;
  end if;

  if p_id is null then
    insert into public.presupuestos (
      cliente_nombre, cliente_apellido, contact_id, conversation_id, origen, nota, total_cotizado_usd
    ) values (
      v_nombre, v_apellido, p_contact_id, p_conversation_id, coalesce(p_origen, 'inventario'), v_nota, v_total
    )
    returning id into v_id;
  else
    update public.presupuestos
       set cliente_nombre = v_nombre,
           cliente_apellido = v_apellido,
           nota = v_nota,
           total_cotizado_usd = v_total,
           updated_at = now()
     where id = p_id;
    -- La RLS que bloquea un UPDATE lo deja en 0 filas SIN error: se vuelve un
    -- error explícito (ajeno, inexistente o sin permiso dan lo mismo).
    if not found then
      raise exception 'presupuesto_ajeno_o_inexistente' using errcode = '42501';
    end if;
    v_id := p_id;
    delete from public.presupuesto_items where presupuesto_id = v_id;
  end if;

  insert into public.presupuesto_items (presupuesto_id, product_id, quantity, price_kind, precio_cotizado_usd)
  select
    v_id,
    (e ->> 'product_id')::uuid,
    (e ->> 'quantity')::integer,
    coalesce(e ->> 'price_kind', 'promocion'),
    (e ->> 'precio_cotizado_usd')::numeric
  from jsonb_array_elements(p_items) e;

  return v_id;
end;
$$;

comment on function public.guardar_presupuesto(uuid, text, text, uuid, uuid, text, text, jsonb) is
  'Guarda (p_id null) o reemplaza (p_id) un presupuesto y sus renglones en una sola llamada atómica. security invoker: la RLS manda (D2, D4). Plan "Presupuestos y mensajes rápidos", 21/10/2026.';

-- Los dos revokes (PUBLIC y anon/authenticated) y el grant a quien sí la usa,
-- por firma completa (convención de CLAUDE.md). `authenticated` la necesita:
-- es la RPC que llama la interfaz.
revoke execute on function public.guardar_presupuesto(uuid, text, text, uuid, uuid, text, text, jsonb) from public;
revoke execute on function public.guardar_presupuesto(uuid, text, text, uuid, uuid, text, text, jsonb) from anon, authenticated;
grant execute on function public.guardar_presupuesto(uuid, text, text, uuid, uuid, text, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
begin
  foreach t in array array['presupuestos', 'presupuesto_items']
  loop
    if not exists (
      select 1 from pg_class
       where oid = ('public.' || t)::regclass and relrowsecurity
    ) then
      raise exception '20261021010000: public.% quedó sin RLS habilitada', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('anon', 'public.' || t, 'INSERT') then
      raise exception '20261021010000: anon tiene privilegios sobre public.%', t;
    end if;
  end loop;

  select count(*) into n
    from pg_policy
   where polrelid in ('public.presupuestos'::regclass, 'public.presupuesto_items'::regclass)
     and polname in (
       'presupuestos_select', 'presupuestos_insert', 'presupuestos_update', 'presupuestos_delete',
       'presupuesto_items_select', 'presupuesto_items_insert', 'presupuesto_items_delete'
     );
  if n <> 7 then
    raise exception '20261021010000: se esperaban 7 políticas de presupuestos y hay %', n;
  end if;

  -- D4: la guarda de la caja vive en la política de INSERT de los renglones.
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.presupuesto_items'::regclass
       and polname = 'presupuesto_items_insert'
       and pg_get_expr(polwithcheck, polrelid) like '%is_agent()%'
  ) then
    raise exception '20261021010000: presupuesto_items_insert perdió la guarda de la caja (is_agent())';
  end if;

  if has_table_privilege('authenticated', 'public.presupuesto_items', 'UPDATE') then
    raise exception '20261021010000: authenticated no debía poder UPDATE sobre presupuesto_items';
  end if;

  if has_function_privilege('anon', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('public', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE') then
    raise exception '20261021010000: anon o PUBLIC pueden ejecutar guardar_presupuesto()';
  end if;
  if not has_function_privilege('authenticated', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)', 'EXECUTE') then
    raise exception '20261021010000: authenticated y service_role deben poder ejecutar guardar_presupuesto()';
  end if;
  if exists (
    select 1 from pg_proc
     where oid = 'public.guardar_presupuesto(uuid,text,text,uuid,uuid,text,text,jsonb)'::regprocedure and prosecdef
  ) then
    raise exception '20261021010000: guardar_presupuesto() debía quedar security invoker';
  end if;

  raise notice '20261021010000: autoverificación de presupuestos correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
