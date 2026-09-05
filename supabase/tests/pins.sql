-- ===========================================================================
-- Pines de conversación (T2.2, plan "La bandeja que no pierde", 5/9/2026)
--
-- Dos reglas nuevas sobre public.conversation_pins
-- (20260905040000_conversation_pins.sql), y las dos se verifican acá contra
-- la base de verdad, no leyendo el .sql:
--
--   1. El trigger conversation_pins_limit_before_insert rechaza el cuarto pin
--      de un mismo agente con un mensaje en español.
--   2. La política RLS aísla a cada agente: uno no ve los pines del otro, y
--      no puede fijar una conversación a nombre de otro agente aunque lo
--      intente a propósito.
--
-- Corre con `set local role authenticated` + `set local
-- "request.jwt.claim.sub"` para que auth.uid() responda como responde en
-- producción (verificado contra esta misma base el 5/9/2026: auth.uid() lee
-- primero request.jwt.claim.sub y, si falta, cae a ->>'sub' de
-- request.jwt.claims -- la primera forma alcanza y es la más simple de las
-- dos). Todo dentro de una transacción con rollback, estilo
-- invariante_leads.sql / awaiting_reply.sql: no depende de los seeds ni deja
-- nada atrás -- los dos agentes, el canal, los contactos y las conversaciones
-- son propios de este archivo.
-- ===========================================================================

begin;

-- Dos agentes de prueba. Insertar en auth.users dispara handle_new_agent()
-- (security definer) y crea la fila espejo en public.agents con is_active en
-- true por default -- lo que is_agent() necesita para dejarlos pasar por RLS.
insert into auth.users (id, email, raw_user_meta_data) values
  ('a1a1a1a1-0000-0000-0000-000000000001', 'agente-a-pins@sbk.test', jsonb_build_object('display_name', 'Agente A (pins)')),
  ('b2b2b2b2-0000-0000-0000-000000000002', 'agente-b-pins@sbk.test', jsonb_build_object('display_name', 'Agente B (pins)'));

-- Un canal y cuatro contactos/conversaciones propios: hacen falta cuatro
-- conversaciones distintas para poder intentar el cuarto pin (conversations
-- tiene único (contact_id, whatsapp_channel_id), así que cada una necesita su
-- propio contacto).
insert into public.whatsapp_channels (id, label, phone_number) values
  ('c3c3c3c3-0000-0000-0000-000000000000', 'Canal de prueba (pins)', '+580000009000');

insert into public.contacts (id, phone_number) values
  ('d1d1d1d1-0000-0000-0000-000000000001', '+580000009001'),
  ('d1d1d1d1-0000-0000-0000-000000000002', '+580000009002'),
  ('d1d1d1d1-0000-0000-0000-000000000003', '+580000009003'),
  ('d1d1d1d1-0000-0000-0000-000000000004', '+580000009004');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('e1e1e1e1-0000-0000-0000-000000000001', 'd1d1d1d1-0000-0000-0000-000000000001', 'c3c3c3c3-0000-0000-0000-000000000000'),
  ('e1e1e1e1-0000-0000-0000-000000000002', 'd1d1d1d1-0000-0000-0000-000000000002', 'c3c3c3c3-0000-0000-0000-000000000000'),
  ('e1e1e1e1-0000-0000-0000-000000000003', 'd1d1d1d1-0000-0000-0000-000000000003', 'c3c3c3c3-0000-0000-0000-000000000000'),
  ('e1e1e1e1-0000-0000-0000-000000000004', 'd1d1d1d1-0000-0000-0000-000000000004', 'c3c3c3c3-0000-0000-0000-000000000000');

-- A partir de acá se corre como el agente A correría desde el navegador: rol
-- `authenticated` de verdad, no `postgres` (que no tiene RLS activa y
-- escondería cualquier agujero de la política). `set local` alcanza con las
-- dos instrucciones -- vive solo dentro de esta transacción.
set local role authenticated;
set local "request.jwt.claim.sub" = 'a1a1a1a1-0000-0000-0000-000000000001';

-- Tres inserts SEPARADOS y no un solo INSERT con VALUES múltiples: así el
-- trigger cuenta, para el segundo y el tercero, lo que el primero y el
-- segundo ya dejaron confirmado -- con un único INSERT de varias filas la
-- visibilidad de las filas anteriores del MISMO comando no está garantizada
-- de la misma forma.
insert into public.conversation_pins (agent_id, conversation_id) values
  ('a1a1a1a1-0000-0000-0000-000000000001', 'e1e1e1e1-0000-0000-0000-000000000001');
insert into public.conversation_pins (agent_id, conversation_id) values
  ('a1a1a1a1-0000-0000-0000-000000000001', 'e1e1e1e1-0000-0000-0000-000000000002');
insert into public.conversation_pins (agent_id, conversation_id) values
  ('a1a1a1a1-0000-0000-0000-000000000001', 'e1e1e1e1-0000-0000-0000-000000000003');

-- ---------------------------------------------------------------------------
-- 1. El cuarto pin falla, y falla por el motivo correcto (el tope de tres),
--    no por cualquier otro error que hiciera parecer que el trigger
--    funciona sin funcionar.
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.conversation_pins (agent_id, conversation_id) values
      ('a1a1a1a1-0000-0000-0000-000000000001', 'e1e1e1e1-0000-0000-0000-000000000004');
    se_insertó := true;
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%tres%' then
        raise exception 'El cuarto pin falló, pero con un mensaje que no menciona el tope de tres: %', sqlerrm;
      end if;
      -- Mensaje esperado: el trigger lo rechazó por el tope. Correcto.
  end;

  if se_insertó then
    raise exception 'El cuarto pin se insertó y no debía: conversation_pins_limit_before_insert no está frenando el tope de tres.';
  end if;
end $$;

-- Los tres pines de A siguen ahí -- el intento fallido del cuarto no debe
-- haber dejado nada a medias.
do $$
declare
  n integer;
begin
  select count(*) into n from public.conversation_pins where agent_id = 'a1a1a1a1-0000-0000-0000-000000000001';
  if n <> 3 then
    raise exception 'El agente A debía seguir con exactamente 3 pines y tiene %.', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Otro agente no ve los pines ajenos: RLS filtra por agent_id = auth.uid(),
--    así que una consulta sin condición de B solo puede devolver las suyas
--    (cero, en este caso).
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'b2b2b2b2-0000-0000-0000-000000000002';

do $$
declare
  n integer;
begin
  select count(*) into n from public.conversation_pins;
  if n <> 0 then
    raise exception 'El agente B ve % fila(s) de conversation_pins y debía ver 0 -- está leyendo pines ajenos (los de A).', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Ni siquiera puede fijar una conversación a nombre de A: el `with check`
--    de la política rechaza la fila aunque el trigger del tope (que corre
--    con los privilegios de B, y por lo tanto solo ve los pines de B) la
--    hubiera dejado pasar.
-- ---------------------------------------------------------------------------
do $$
declare
  se_insertó boolean := false;
begin
  begin
    insert into public.conversation_pins (agent_id, conversation_id) values
      ('a1a1a1a1-0000-0000-0000-000000000001', 'e1e1e1e1-0000-0000-0000-000000000001')
      on conflict do nothing;
    se_insertó := true;
  exception
    when insufficient_privilege then
      -- Esperado: 42501, "new row violates row-level security policy".
      null;
  end;

  if se_insertó then
    raise exception 'El agente B pudo insertar un pin con agent_id de A: la política RLS no está aislando la escritura.';
  end if;
end $$;

reset role;

rollback;

\echo 'pins.sql: todas las aserciones pasaron.'
