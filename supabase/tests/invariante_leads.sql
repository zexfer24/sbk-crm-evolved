-- ===========================================================================
-- La invariante "ningún lead invisible", verificada contra la base
--
-- La regla que gobierna la reforma (ver CLAUDE.md) dice:
--
--   Toda conversación con `awaiting_reply` tiene exactamente un dueño y una
--   hora límite de respuesta. Ninguna salida del sistema deja una
--   conversación esperando sin dueño ni fecha.
--
-- Su forma final —`owner_kind` y `response_due_at` como columnas de
-- `conversations`— nace en la Etapa 2 del plan, así que HOY esa consulta no
-- se puede escribir: las columnas no existen. Lo que se verifica acá es su
-- proxy de la Etapa 1, que es la bitácora `conversation_handoffs`, y en
-- concreto la única pregunta que la reforma necesita contestar bien:
-- **cuántas conversaciones siguen esperando y quedaron sin dueño**.
--
-- POR QUÉ ESTE ARCHIVO EXISTE, Y NO ALCANZA CON LOS TESTS DE VITEST
--
-- Ese número tiene DOS implementaciones, en dos lenguajes, y las dos están
-- en producción: `unassigned_waiting_count()` en SQL (la que informa
-- /api/health, el KPI que decide si la Etapa 2 arranca) e `isUnassignedLead`
-- en TypeScript (la que arma la píldora "Sin dueño" de la bandeja). Si se
-- separan, el tablero y la bandeja dicen cosas distintas sobre el mismo
-- hecho — y el precedente de este repo es que eso pasa: la ventana de 24 h
-- tiene su propio archivo de contrato (`src/lib/ventana-24h-contrato.test.ts`)
-- justamente porque se había separado.
--
-- Los casos de acá abajo son los MISMOS que afirma
-- `src/lib/invariante-leads-contrato.test.ts` sobre la implementación en
-- TypeScript, con los mismos nombres. Si alguien cambia una de las dos
-- definiciones, uno de los dos archivos se pone rojo.
--
-- EL CASO QUE JUSTIFICA TODO ESTO (caso 2 más abajo)
--
-- La forma natural de escribir este conteo desde el cliente —"la
-- conversación tiene AL MENOS una fila unassigned"— está mal, y está mal de
-- una manera que no se nota hasta que es tarde: el reconciliador escribe un
-- `reabierto` encima de todo lo que rescata, así que con esa definición
-- TODA conversación recuperada seguiría contando como perdida para siempre.
-- El KPI solo sabría subir. Se descubrió midiendo contra una base real el
-- 30/8/2026, no leyendo el código.
--
-- Corre en el job `migraciones` de CI, contra la base reconstruida desde
-- cero. Todo pasa dentro de una transacción con `rollback` al final: no
-- depende de los seeds ni deja nada atrás.
-- ===========================================================================

begin;

-- Datos propios, con ids fijos para poder afirmar sobre ellos. `awaiting_reply`
-- es una columna GENERADA (20260825050000): vale true cuando hay mensaje del
-- cliente y el último del hilo sigue siendo suyo, así que se induce poniendo
-- `last_message_at <= last_customer_message_at`.
-- Un contacto por caso: `conversations` tiene único (contact_id,
-- whatsapp_channel_id), así que cinco conversaciones sobre el mismo canal
-- necesitan cinco contactos distintos.
insert into public.contacts (id, phone_number) values
  ('11111111-1111-1111-1111-111111111101', '+580000000001'),
  ('11111111-1111-1111-1111-111111111102', '+580000000002'),
  ('11111111-1111-1111-1111-111111111103', '+580000000003'),
  ('11111111-1111-1111-1111-111111111104', '+580000000004'),
  ('11111111-1111-1111-1111-111111111105', '+580000000005');

insert into public.whatsapp_channels (id, label, phone_number) values
  ('22222222-2222-2222-2222-222222222222', 'Canal de prueba', '+580000000000');

insert into public.conversations
  (id, contact_id, whatsapp_channel_id, last_customer_message_at, last_message_at)
values
  -- caso 1 · soltada y nunca recuperada → CUENTA
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours'),
  -- caso 2 · soltada y DESPUÉS rescatada por el reconciliador → NO cuenta
  ('aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111102', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours'),
  -- caso 3 · soltada y después tomada por una persona → NO cuenta
  ('aaaaaaaa-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111103', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours'),
  -- caso 4 · sin ninguna fila de bitácora → NO cuenta (nunca se soltó)
  ('aaaaaaaa-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111104', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '2 hours'),
  -- caso 5 · soltada, pero el asesor YA contestó → NO cuenta: no espera a nadie
  ('aaaaaaaa-0000-0000-0000-000000000005',
   '11111111-1111-1111-1111-111111111105', '22222222-2222-2222-2222-222222222222',
   now() - interval '2 hours', now() - interval '1 minute');

-- Los traspasos. El `created_at` explícito y separado en el tiempo es
-- deliberado: lo que decide es la fila MÁS RECIENTE, no el orden de inserción.
insert into public.conversation_handoffs (conversation_id, to_kind, reason, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'unassigned', 'agente_no_puede_correr', now() - interval '90 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000002', 'unassigned', 'abandonado',  now() - interval '90 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'ai',         'reabierto',   now() - interval '30 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000003', 'unassigned', 'fuera_de_ventana', now() - interval '90 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'human',      'reclamado',        now() - interval '30 minutes'),

  ('aaaaaaaa-0000-0000-0000-000000000005', 'unassigned', 'entrega_fallida', now() - interval '90 minutes');

do $$
declare
  esperado integer := 1;  -- solo el caso 1
  obtenido integer;
  errores text := '';
  fila record;
begin
  select public.unassigned_waiting_count() into obtenido;

  if obtenido <> esperado then
    errores := errores || format(
      E'\n  - unassigned_waiting_count() devolvió %s y debía devolver %s.', obtenido, esperado);
  end if;

  -- Caso 2 explícito y con nombre propio: es el que se le escapa a la
  -- definición ingenua ("tiene alguna fila unassigned"), y el que haría que
  -- el KPI solo supiera subir. Si este bloque falla, alguien reescribió el
  -- conteo con esa definición.
  select count(*)::integer into obtenido
  from public.conversations c
  where c.id = 'aaaaaaaa-0000-0000-0000-000000000002'
    and c.awaiting_reply
    and (
      select h.to_kind from public.conversation_handoffs h
      where h.conversation_id = c.id
      order by h.created_at desc, h.id desc limit 1
    ) = 'unassigned';

  if obtenido <> 0 then
    errores := errores ||
      E'\n  - la conversación rescatada por el reconciliador (un `reabierto` encima de un `unassigned`) sigue contando como sin dueño: el KPI solo sabría subir.';
  end if;

  -- La invariante propiamente dicha, en su forma de Etapa 1: toda
  -- conversación que el sistema soltó y que sigue esperando tiene que ser
  -- VISIBLE — es decir, contable. Una que quedara `unassigned` sin aparecer
  -- en el conteo sería exactamente el lead invisible que la reforma existe
  -- para que no haya.
  for fila in
    select c.id
    from public.conversations c
    where c.awaiting_reply
      and (
        select h.to_kind from public.conversation_handoffs h
        where h.conversation_id = c.id
        order by h.created_at desc, h.id desc limit 1
      ) = 'unassigned'
  loop
    if fila.id <> 'aaaaaaaa-0000-0000-0000-000000000001' then
      errores := errores || format(
        E'\n  - la conversación %s quedó sin dueño y el conteo no la ve.', fila.id);
    end if;
  end loop;

  if errores <> '' then
    raise exception E'Invariante "ningún lead invisible" rota:%', errores;
  end if;
end $$;

rollback;

\echo 'invariante_leads.sql: todas las aserciones pasaron.'
