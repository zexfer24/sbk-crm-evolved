-- ===========================================================================
-- Lecturas de audio e imagen (M1, plan "Seba lee fotos y audios", 16/11/2026,
-- migración 20261116010000)
--
-- Fija: (1) un agente LEE `message_readings` y no escribe nada (la escribe solo
-- `service_role`); (2) quien no es agente no ve filas; (3) `agent_spend_today()`
-- suma el costo de las lecturas de HOY (hora de Caracas) y no las de otros días,
-- y una lectura sin costo no rompe la suma; (4) los CHECK de `kind`/`status`;
-- (5) la tabla está publicada en Realtime; (6) los grants de la función.
--
-- Corre como `authenticated` con claims de un agente real donde importa la RLS
-- (como postgres se la salta y no mediría nada), y como postgres para medir la
-- suma de gasto. Termina en rollback.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d1d1d1d1-0000-0000-0000-000000000001', 'agente-lecturas@sbk.test', jsonb_build_object('display_name', 'Agente lecturas'));

insert into public.whatsapp_channels (id, label, phone_number) values
  ('d1d1d1d1-1000-0000-0000-000000000001', 'Canal lecturas', '+580000000090');
insert into public.contacts (id, phone_number) values
  ('d1d1d1d1-2000-0000-0000-000000000001', '+580000000091');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('d1d1d1d1-3000-0000-0000-000000000001', 'd1d1d1d1-2000-0000-0000-000000000001', 'd1d1d1d1-1000-0000-0000-000000000001');
insert into public.messages (id, conversation_id, direction, sender_type, message_type, content) values
  ('d1d1d1d1-4000-0000-0000-000000000001', 'd1d1d1d1-3000-0000-0000-000000000001', 'inbound', 'customer', 'audio', null),
  ('d1d1d1d1-4000-0000-0000-000000000002', 'd1d1d1d1-3000-0000-0000-000000000001', 'inbound', 'customer', 'image', null),
  ('d1d1d1d1-4000-0000-0000-000000000003', 'd1d1d1d1-3000-0000-0000-000000000001', 'inbound', 'customer', 'audio', null),
  ('d1d1d1d1-4000-0000-0000-000000000004', 'd1d1d1d1-3000-0000-0000-000000000001', 'inbound', 'customer', 'audio', null);

-- Fila base creada como postgres, con costo 0 para no mover la medición.
insert into public.message_readings (message_id, conversation_id, kind, status, text, cost_usd) values
  ('d1d1d1d1-4000-0000-0000-000000000001', 'd1d1d1d1-3000-0000-0000-000000000001', 'audio', 'ok', 'hola quiero pastillas', 0);

-- Casos 4, 5 y 6: la suma de gasto, medida como postgres.
do $$
declare
  antes numeric;
  despues numeric;
begin
  antes := public.agent_spend_today();
  insert into public.message_readings (message_id, conversation_id, kind, status, cost_usd, created_at) values
    ('d1d1d1d1-4000-0000-0000-000000000002', 'd1d1d1d1-3000-0000-0000-000000000001', 'image', 'ok', 0.123456, now());
  despues := public.agent_spend_today();
  if despues - antes is distinct from 0.123456 then
    insert into _errores(msg) values (format('caso 4: la suma subió %s, se esperaba 0.123456 (antes %s, después %s).', despues - antes, antes, despues));
  end if;

  antes := despues;
  insert into public.message_readings (message_id, conversation_id, kind, status, cost_usd, created_at) values
    ('d1d1d1d1-4000-0000-0000-000000000003', 'd1d1d1d1-3000-0000-0000-000000000001', 'audio', 'ok', 5.000000, now() - interval '2 days');
  despues := public.agent_spend_today();
  if despues is distinct from antes then
    insert into _errores(msg) values (format('caso 5: una lectura de hace 2 días movió la suma de %s a %s.', antes, despues));
  end if;

  antes := despues;
  begin
    insert into public.message_readings (message_id, conversation_id, kind, status, cost_usd) values
      ('d1d1d1d1-4000-0000-0000-000000000004', 'd1d1d1d1-3000-0000-0000-000000000001', 'audio', 'fallo', null);
    despues := public.agent_spend_today();
    if despues is null or despues is distinct from antes then
      insert into _errores(msg) values (format('caso 6: una lectura con cost_usd null dejó la suma en %s (antes %s).', despues, antes));
    end if;
  exception when others then
    insert into _errores(msg) values (format('caso 6: lanzó error -- %s', sqlerrm));
  end;
end $$;

-- Caso 7: CHECK de status y kind (sobre message_id libres de la unique).
do $$
begin
  begin
    insert into public.message_readings (message_id, conversation_id, kind, status) values
      ('d1d1d1d1-4000-0000-0000-000000000004', 'd1d1d1d1-3000-0000-0000-000000000001', 'audio', 'inventado');
    insert into _errores(msg) values ('caso 7: un status inválido se aceptó.');
  exception when check_violation then null;
  end;
  begin
    delete from public.message_readings where message_id = 'd1d1d1d1-4000-0000-0000-000000000004';
    insert into public.message_readings (message_id, conversation_id, kind, status) values
      ('d1d1d1d1-4000-0000-0000-000000000004', 'd1d1d1d1-3000-0000-0000-000000000001', 'video', 'ok');
    insert into _errores(msg) values ('caso 7: un kind inválido se aceptó.');
  exception when check_violation then null;
  end;
end $$;

-- Caso 8: publicación en Realtime.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_readings') then
    insert into _errores(msg) values ('caso 8: message_readings no está en supabase_realtime.');
  end if;
end $$;

-- Caso 9: grants de la función.
do $$
begin
  if has_function_privilege('anon', 'public.agent_spend_today()', 'execute') then
    insert into _errores(msg) values ('caso 9: anon puede ejecutar agent_spend_today().');
  end if;
  if not has_function_privilege('authenticated', 'public.agent_spend_today()', 'execute') then
    insert into _errores(msg) values ('caso 9: authenticated no puede ejecutar agent_spend_today().');
  end if;
  if not has_function_privilege('service_role', 'public.agent_spend_today()', 'execute') then
    insert into _errores(msg) values ('caso 9: service_role no puede ejecutar agent_spend_today().');
  end if;
end $$;

-- Casos 1 y 2: el agente lee y no escribe.
set local role authenticated;
set local "request.jwt.claim.sub" = 'd1d1d1d1-0000-0000-0000-000000000001';

do $$
declare
  n integer;
begin
  select count(*) into n from public.message_readings
   where message_id = 'd1d1d1d1-4000-0000-0000-000000000001';
  if n is distinct from 1 then
    insert into _errores(msg) values (format('caso 1: el agente vio %s fila(s), se esperaba 1.', n));
  end if;

  begin
    insert into public.message_readings (message_id, conversation_id, kind, status) values
      ('d1d1d1d1-4000-0000-0000-000000000004', 'd1d1d1d1-3000-0000-0000-000000000001', 'audio', 'ok');
    insert into _errores(msg) values ('caso 2: el agente pudo insertar.');
  exception when insufficient_privilege then null;
  end;

  begin
    update public.message_readings set text = 'editado';
    insert into _errores(msg) values ('caso 2: el agente pudo actualizar (sin error de permiso).');
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.message_readings;
    insert into _errores(msg) values ('caso 2: el agente pudo borrar (sin error de permiso).');
  exception when insufficient_privilege then null;
  end;
end $$;

-- Caso 3: quien no es agente (sub sin fila en agents) no ve nada.
set local "request.jwt.claim.sub" = 'd1d1d1d1-0000-0000-0000-0000000000ff';

do $$
declare
  n integer;
begin
  select count(*) into n from public.message_readings;
  if n is distinct from 0 then
    insert into _errores(msg) values (format('caso 3: un no-agente vio %s fila(s), se esperaban 0.', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'lecturas_de_media.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'lecturas_de_media: todas las aserciones pasaron.'
