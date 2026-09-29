-- ===========================================================================
-- Carrito por conversación (T8, plan "Seba encuentra, no insiste, y el
-- mostrador no deja a nadie esperando", 28/9/2026, Entrega B)
--
-- Migración bajo prueba: 20260929010000_carrito_por_conversacion.sql.
--
-- Mismo patrón que catalog_links.sql/config_solo_supervisor.sql: transacción
-- con rollback, tabla temporal `_errores`, un solo `raise exception` al final
-- con todo lo acumulado. La parte de RLS corre con `set local role
-- authenticated` + `set local "request.jwt.claim.sub"` para que las políticas
-- se evalúen como en producción (como `postgres` se saltan y no medirían
-- nada).
--
-- Qué fija:
--   1. Un agente (rol corriente) inserta, lee, actualiza y borra renglones;
--      `added_by` se llena solo con su id.
--   2. `unique (conversation_id, product_id)`: el segundo insert del mismo
--      producto en la misma conversación falla con 23505 (el "suma unidades"
--      lo resuelve la app con concurrencia optimista, no la base).
--   3. `quantity > 0` y `origin in ('quote','inventory')` los hace cumplir la
--      base (CHECK), no solo la interfaz.
--   4. `updated_at` avanza en un UPDATE (trigger set_updated_at).
--   5. Quien está autenticado pero NO es agente no lee ni escribe nada; `anon`
--      ni siquiera tiene el permiso de tabla.
--   6. Borrar la conversación borra su carrito (cascade); borrar la
--      cotización deja el renglón con `quote_id = null` (set null).
--   7. La tabla está en la publicación `supabase_realtime` y con `replica
--      identity full` -- sin lo primero el canal `cart-<id>` calla para
--      siempre; sin lo segundo un DELETE filtrado por `conversation_id` no
--      llega.
--
-- Corre en el job `migraciones` de CI.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated;

-- Un agente corriente (A) y un usuario que NO es agente (X: se quita su fila
-- espejo de public.agents para que is_agent() dé false).
insert into auth.users (id, email, raw_user_meta_data) values
  ('ca7ca7ca-0000-0000-0000-000000000001', 'agente-a-carrito@sbk.test', jsonb_build_object('display_name', 'Agente A (carrito)')),
  ('ca7ca7ca-0000-0000-0000-000000000002', 'no-agente-x-carrito@sbk.test', jsonb_build_object('display_name', 'X (no agente)'));
delete from public.agents where id = 'ca7ca7ca-0000-0000-0000-000000000002';

-- Fixtures (como postgres, sin RLS).
insert into public.whatsapp_channels (id, label, phone_number) values
  ('ca7ca7ca-1000-0000-0000-000000000000', 'Canal de prueba carrito', '+580000009000');
insert into public.contacts (id, phone_number) values
  ('ca7ca7ca-2000-0000-0000-000000000001', '+580000009001'),
  ('ca7ca7ca-2000-0000-0000-000000000002', '+580000009002');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('ca7ca7ca-3000-0000-0000-000000000001', 'ca7ca7ca-2000-0000-0000-000000000001', 'ca7ca7ca-1000-0000-0000-000000000000'),
  ('ca7ca7ca-3000-0000-0000-000000000002', 'ca7ca7ca-2000-0000-0000-000000000002', 'ca7ca7ca-1000-0000-0000-000000000000');
insert into public.products (id, name, price, currency, stock_quantity) values
  ('ca7ca7ca-4000-0000-0000-000000000001', 'Producto carrito 1', 10, 'USD', 5),
  ('ca7ca7ca-4000-0000-0000-000000000002', 'Producto carrito 2', 20, 'USD', 5),
  ('ca7ca7ca-4000-0000-0000-000000000003', 'Producto carrito 3', 30, 'USD', 5);
insert into public.conversation_quotes (id, conversation_id, product_id, product_name, price_usd, price_bs, bcv_rate) values
  ('ca7ca7ca-5000-0000-0000-000000000001', 'ca7ca7ca-3000-0000-0000-000000000002', 'ca7ca7ca-4000-0000-0000-000000000003', 'Producto carrito 3', 30, 3000, 100);

-- Un renglón preexistente en la conversación 1, para el caso del no-agente.
insert into public.conversation_cart_items (id, conversation_id, product_id, quantity, origin) values
  ('ca7ca7ca-6000-0000-0000-000000000001', 'ca7ca7ca-3000-0000-0000-000000000001', 'ca7ca7ca-4000-0000-0000-000000000002', 1, 'inventory');

-- ---------------------------------------------------------------------------
-- Como A (agente)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'ca7ca7ca-0000-0000-0000-000000000001';

-- Caso 1 · insertar, leer y `added_by` automático.
do $$
declare
  n integer;
  quien uuid;
begin
  insert into public.conversation_cart_items (id, conversation_id, product_id, quantity, origin) values
    ('ca7ca7ca-6000-0000-0000-000000000002', 'ca7ca7ca-3000-0000-0000-000000000001', 'ca7ca7ca-4000-0000-0000-000000000001', 2, 'inventory');

  select count(*), max(added_by::text)::uuid into n, quien from public.conversation_cart_items
    where id = 'ca7ca7ca-6000-0000-0000-000000000002';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1: A no ve el renglón que insertó (%s filas).', n));
  end if;
  if quien is distinct from 'ca7ca7ca-0000-0000-0000-000000000001'::uuid then
    insert into _errores(msg) values (format('Caso 1: added_by debía ser el agente de la sesión, es %s.', quien));
  end if;

  -- El renglón que creó otro (postgres) también se ve: la bandeja es compartida.
  select count(*) into n from public.conversation_cart_items
    where conversation_id = 'ca7ca7ca-3000-0000-0000-000000000001';
  if n is distinct from 2 then
    insert into _errores(msg) values (format('Caso 1: A debía ver los 2 renglones de la conversación, ve %s.', n));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso 1: A no pudo insertar/leer -- %s', sqlerrm));
end $$;

-- Caso 2 · unique (conversation_id, product_id).
do $$
declare
  se_inserto boolean := false;
begin
  begin
    insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin) values
      ('ca7ca7ca-3000-0000-0000-000000000001', 'ca7ca7ca-4000-0000-0000-000000000001', 1, 'inventory');
    se_inserto := true;
  exception when unique_violation then
    null;
  end;
  if se_inserto then
    insert into _errores(msg) values ('Caso 2: el mismo producto se insertó dos veces en la misma conversación (falta el unique).');
  end if;
end $$;

-- Caso 3 · el mismo producto en OTRA conversación sí entra.
do $$
begin
  insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin) values
    ('ca7ca7ca-3000-0000-0000-000000000002', 'ca7ca7ca-4000-0000-0000-000000000001', 1, 'inventory');
exception when others then
  insert into _errores(msg) values (format('Caso 3: el mismo producto en otra conversación debía entrar -- %s', sqlerrm));
end $$;

-- Caso 4 · quantity > 0 (0 y negativo rechazados por el CHECK).
do $$
declare
  valor integer;
  se_inserto boolean;
begin
  foreach valor in array array[0, -3] loop
    se_inserto := false;
    begin
      insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin) values
        ('ca7ca7ca-3000-0000-0000-000000000001', 'ca7ca7ca-4000-0000-0000-000000000003', valor, 'inventory');
      se_inserto := true;
    exception when check_violation then
      null;
    end;
    if se_inserto then
      insert into _errores(msg) values (format('Caso 4: quantity = %s se aceptó (el CHECK quantity > 0 no está).', valor));
    end if;
  end loop;

  -- Un UPDATE a 0 también se rechaza.
  se_inserto := false;
  begin
    update public.conversation_cart_items set quantity = 0
      where id = 'ca7ca7ca-6000-0000-0000-000000000002';
    se_inserto := true;
  exception when check_violation then
    null;
  end;
  if se_inserto then
    insert into _errores(msg) values ('Caso 4: un UPDATE a quantity = 0 se aceptó.');
  end if;
end $$;

-- Caso 5 · origin fuera de ('quote','inventory') rechazado.
do $$
declare
  se_inserto boolean := false;
begin
  begin
    insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin) values
      ('ca7ca7ca-3000-0000-0000-000000000001', 'ca7ca7ca-4000-0000-0000-000000000003', 1, 'manual');
    se_inserto := true;
  exception when check_violation then
    null;
  end;
  if se_inserto then
    insert into _errores(msg) values ('Caso 5: origin = manual se aceptó (falta el CHECK de origin).');
  end if;
end $$;

-- Caso 6 · UPDATE afecta 1 fila y el trigger `set_updated_at` está puesto.
-- (now() no avanza dentro de una transacción, así que no se puede medir el
-- avance de updated_at aquí: se comprueba que el trigger exista y apunte a
-- la función.)
do $$
declare
  n integer;
begin
  update public.conversation_cart_items set quantity = 5
    where id = 'ca7ca7ca-6000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 6: el UPDATE afectó %s fila(s), se esperaba 1.', n));
  end if;

  select count(*) into n from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.conversation_cart_items'::regclass
      and not t.tgisinternal
      and p.proname = 'set_updated_at';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 6: se esperaba 1 trigger set_updated_at en la tabla, hay %s.', n));
  end if;
end $$;

-- Caso 7 · DELETE afecta 1 fila.
do $$
declare
  n integer;
begin
  delete from public.conversation_cart_items where id = 'ca7ca7ca-6000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n is distinct from 1 then
    insert into _errores(msg) values (format('Caso 7: el DELETE afectó %s fila(s), se esperaba 1.', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Como X (autenticado pero NO agente): ni lee, ni escribe.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'ca7ca7ca-0000-0000-0000-000000000002';

do $$
declare
  n integer;
  se_inserto boolean := false;
begin
  select count(*) into n from public.conversation_cart_items;
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 8: un usuario que no es agente ve %s renglón(es).', n));
  end if;

  begin
    insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin) values
      ('ca7ca7ca-3000-0000-0000-000000000001', 'ca7ca7ca-4000-0000-0000-000000000003', 1, 'inventory');
    se_inserto := true;
  exception when insufficient_privilege then
    null;
  end;
  if se_inserto then
    insert into _errores(msg) values ('Caso 8: un usuario que no es agente pudo insertar un renglón.');
  end if;

  update public.conversation_cart_items set quantity = 99;
  get diagnostics n = row_count;
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 8: un usuario que no es agente actualizó %s renglón(es).', n));
  end if;

  delete from public.conversation_cart_items;
  get diagnostics n = row_count;
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 8: un usuario que no es agente borró %s renglón(es).', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- Nada de lo de X cambió el carrito (verificado como postgres).
do $$
declare
  n integer;
begin
  select count(*) into n from public.conversation_cart_items where quantity = 99;
  if n is distinct from 0 then
    insert into _errores(msg) values ('Caso 8: el UPDATE de X modificó cantidades.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 9 · anon: sin permiso de tabla.
-- ---------------------------------------------------------------------------
set local role anon;

do $$
declare
  n integer;
  leyo boolean := false;
begin
  begin
    select count(*) into n from public.conversation_cart_items;
    leyo := true;
  exception when insufficient_privilege then
    null;
  end;
  if leyo then
    insert into _errores(msg) values ('Caso 9: anon pudo leer conversation_cart_items.');
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Caso 10 · cascadas (como postgres).
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  q uuid;
begin
  -- set null: un renglón que vino de una cotización sobrevive a su borrado.
  insert into public.conversation_cart_items (id, conversation_id, product_id, quantity, origin, quote_id) values
    ('ca7ca7ca-6000-0000-0000-000000000003', 'ca7ca7ca-3000-0000-0000-000000000002', 'ca7ca7ca-4000-0000-0000-000000000003', 1, 'quote', 'ca7ca7ca-5000-0000-0000-000000000001');
  delete from public.conversation_quotes where id = 'ca7ca7ca-5000-0000-0000-000000000001';
  select count(*), max(quote_id::text)::uuid into n, q from public.conversation_cart_items
    where id = 'ca7ca7ca-6000-0000-0000-000000000003';
  if n is distinct from 1 or q is not null then
    insert into _errores(msg) values (format('Caso 10: borrar la cotización debía dejar el renglón con quote_id null (filas=%s, quote_id=%s).', n, q));
  end if;

  -- cascade: borrar la conversación borra su carrito.
  delete from public.conversations where id = 'ca7ca7ca-3000-0000-0000-000000000002';
  select count(*) into n from public.conversation_cart_items
    where conversation_id = 'ca7ca7ca-3000-0000-0000-000000000002';
  if n is distinct from 0 then
    insert into _errores(msg) values (format('Caso 10: borrar la conversación dejó %s renglón(es) huérfano(s).', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 11 · Realtime: publicada y con réplica completa.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'conversation_cart_items'
  ) then
    insert into _errores(msg) values ('Caso 11: conversation_cart_items no está en supabase_realtime (el canal cart-<id> callaría para siempre).');
  end if;

  if (select relreplident from pg_class where oid = 'public.conversation_cart_items'::regclass) is distinct from 'f' then
    insert into _errores(msg) values ('Caso 11: conversation_cart_items no tiene replica identity full (un DELETE filtrado no llegaría).');
  end if;
end $$;

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
    raise exception E'carrito_por_conversacion.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'carrito_por_conversacion.sql: todas las aserciones pasaron.'
