-- ===========================================================================
-- Precio elegido por renglón del carrito (14/10/2026)
--
-- Migración bajo prueba: 20261014010000_carrito_precio_elegido.sql.
--
-- Mismo patrón que carrito_por_conversacion.sql: transacción con rollback,
-- tabla temporal `_errores`, un solo `raise exception` al final con todo lo
-- acumulado, y la parte de RLS con `set local role authenticated` para que las
-- políticas se evalúen como en producción.
--
-- Qué fija:
--   a. Un insert sin `price_kind` queda en 'promocion'.
--   b. Insertar y actualizar a 'estandar' funciona.
--   c. Un valor fuera de ('promocion','estandar') lo rechaza la base con
--      check_violation, tanto en INSERT como en UPDATE.
--   d. Un agente autenticado (rol corriente, no postgres) puede cambiar
--      `price_kind` de un renglón con un UPDATE.
--
-- Corre en el job `migraciones` de CI.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('ca7ca7cb-0000-0000-0000-000000000001', 'agente-precio-carrito@sbk.test', jsonb_build_object('display_name', 'Agente (precio carrito)'));

insert into public.whatsapp_channels (id, label, phone_number) values
  ('ca7ca7cb-1000-0000-0000-000000000000', 'Canal de prueba precio carrito', '+580000009100');
insert into public.contacts (id, phone_number) values
  ('ca7ca7cb-2000-0000-0000-000000000001', '+580000009101');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('ca7ca7cb-3000-0000-0000-000000000001', 'ca7ca7cb-2000-0000-0000-000000000001', 'ca7ca7cb-1000-0000-0000-000000000000');
insert into public.products (id, name, price, currency, stock_quantity) values
  ('ca7ca7cb-4000-0000-0000-000000000001', 'Producto precio carrito 1', 10, 'USD', 5),
  ('ca7ca7cb-4000-0000-0000-000000000002', 'Producto precio carrito 2', 20, 'USD', 5),
  ('ca7ca7cb-4000-0000-0000-000000000003', 'Producto precio carrito 3', 30, 'USD', 5);

-- Caso a · sin price_kind => 'promocion' (como postgres, sin RLS).
do $$
declare
  v text;
begin
  insert into public.conversation_cart_items (id, conversation_id, product_id, quantity, origin) values
    ('ca7ca7cb-6000-0000-0000-000000000001', 'ca7ca7cb-3000-0000-0000-000000000001', 'ca7ca7cb-4000-0000-0000-000000000001', 1, 'inventory');
  select price_kind into v from public.conversation_cart_items
    where id = 'ca7ca7cb-6000-0000-0000-000000000001';
  if v is distinct from 'promocion' then
    insert into _errores(msg) values (format('Caso a: el default de price_kind debía ser promocion, es %L.', v));
  end if;
end $$;

-- Caso b · insert y update a 'estandar'.
do $$
declare
  v text;
begin
  insert into public.conversation_cart_items (id, conversation_id, product_id, quantity, origin, price_kind) values
    ('ca7ca7cb-6000-0000-0000-000000000002', 'ca7ca7cb-3000-0000-0000-000000000001', 'ca7ca7cb-4000-0000-0000-000000000002', 1, 'inventory', 'estandar');
  select price_kind into v from public.conversation_cart_items
    where id = 'ca7ca7cb-6000-0000-0000-000000000002';
  if v is distinct from 'estandar' then
    insert into _errores(msg) values (format('Caso b: el insert con estandar quedó como %L.', v));
  end if;

  update public.conversation_cart_items set price_kind = 'estandar'
    where id = 'ca7ca7cb-6000-0000-0000-000000000001';
  select price_kind into v from public.conversation_cart_items
    where id = 'ca7ca7cb-6000-0000-0000-000000000001';
  if v is distinct from 'estandar' then
    insert into _errores(msg) values (format('Caso b: el update a estandar quedó como %L.', v));
  end if;

  update public.conversation_cart_items set price_kind = 'promocion'
    where id = 'ca7ca7cb-6000-0000-0000-000000000001';
  select price_kind into v from public.conversation_cart_items
    where id = 'ca7ca7cb-6000-0000-0000-000000000001';
  if v is distinct from 'promocion' then
    insert into _errores(msg) values (format('Caso b: el update de vuelta a promocion quedó como %L.', v));
  end if;
end $$;

-- Caso c · valores fuera de la lista (INSERT y UPDATE) => check_violation.
do $$
declare
  se_acepto boolean;
begin
  se_acepto := false;
  begin
    insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin, price_kind) values
      ('ca7ca7cb-3000-0000-0000-000000000001', 'ca7ca7cb-4000-0000-0000-000000000003', 1, 'inventory', 'otro');
    se_acepto := true;
  exception when check_violation then
    null;
  end;
  if se_acepto then
    insert into _errores(msg) values ('Caso c: un INSERT con price_kind = otro se aceptó (falta el CHECK).');
  end if;

  se_acepto := false;
  begin
    update public.conversation_cart_items set price_kind = 'otro'
      where id = 'ca7ca7cb-6000-0000-0000-000000000001';
    se_acepto := true;
  exception when check_violation then
    null;
  end;
  if se_acepto then
    insert into _errores(msg) values ('Caso c: un UPDATE a price_kind = otro se aceptó (falta el CHECK).');
  end if;

  -- null tampoco: la columna es not null.
  se_acepto := false;
  begin
    update public.conversation_cart_items set price_kind = null
      where id = 'ca7ca7cb-6000-0000-0000-000000000001';
    se_acepto := true;
  exception when not_null_violation then
    null;
  end;
  if se_acepto then
    insert into _errores(msg) values ('Caso c: un UPDATE a price_kind = null se aceptó (debía ser not null).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso d · un agente autenticado (RLS evaluada de verdad) cambia price_kind.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'ca7ca7cb-0000-0000-0000-000000000001';

do $$
declare
  n integer;
  v text;
begin
  update public.conversation_cart_items set price_kind = 'estandar'
    where id = 'ca7ca7cb-6000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso d: el UPDATE de price_kind como agente afectó %s fila(s), se esperaba 1.', n));
  end if;

  select price_kind into v from public.conversation_cart_items
    where id = 'ca7ca7cb-6000-0000-0000-000000000001';
  if v is distinct from 'estandar' then
    insert into _errores(msg) values (format('Caso d: price_kind quedó %L tras el UPDATE del agente.', v));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso d: el agente no pudo actualizar price_kind -- %s', sqlerrm));
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Veredicto
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'carrito_precio_elegido.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'carrito_precio_elegido.sql: todas las aserciones pasaron.'
