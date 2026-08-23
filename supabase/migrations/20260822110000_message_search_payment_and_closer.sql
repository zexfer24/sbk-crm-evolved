-- ============================================================================
-- Buscar por lo que se dijo, cobrar por un método concreto y saber quién cerró
--
-- Tres cosas que la bandeja y el módulo de ventas no podían responder:
--
-- 1. "¿En qué chats hablamos de bujías?" — el buscador solo miraba el nombre
--    del contacto y su número, así que la única forma de encontrar una
--    conversación era acordarse de quién era.
-- 2. Con qué pagó el cliente. Quedaba en el comprobante, es decir, en una
--    imagen que hay que abrir una por una.
-- 3. Quién cerró la venta. La sección Ventas mostraba el agente *asignado*,
--    que no es lo mismo: la conversación puede reasignarse después, o cerrarla
--    el supervisor sobre un hilo que tiene otro dueño.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Búsqueda dentro de los mensajes
--
-- Mismo tratamiento que ya recibió el catálogo (`products.search_text`): el
-- texto se guarda una vez sin acentos y en minúsculas, porque por WhatsApp
-- nadie escribe "bujía" con tilde y nadie va a escribir "Bujía" con mayúscula.
-- `immutable_unaccent` ya existe desde la migración del catálogo.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists search_text text
  generated always as (public.immutable_unaccent(lower(coalesce(content, '')))) stored;

comment on column public.messages.search_text is
  'Contenido del mensaje sin acentos y en minúsculas. Es lo que consulta el buscador de la bandeja.';

-- El filtro lleva comodín al principio ('%bujia%'), así que un btree no sirve.
create index if not exists messages_search_text_trgm
  on public.messages using gin (search_text gin_trgm_ops);

/*
 * Conversaciones donde se dijo algo.
 *
 * Devuelve una fila por conversación —no una por mensaje— con el mensaje
 * coincidente más reciente, que es el que la bandeja muestra como fragmento.
 * Buscar palabra por palabra en vez de con la frase completa: quien escribe
 * "bujia ngk" quiere los mensajes que hablan de las dos cosas, y ningún
 * mensaje contiene esa secuencia literal.
 *
 * Los eventos de sistema quedan fuera: "Venta cerrada por Luis" no es algo
 * que alguien haya dicho, y aparecería en cada búsqueda de un nombre propio.
 */
create or replace function public.search_conversations_by_message(
  p_query text,
  p_limit integer default 40
)
returns table (
  conversation_id uuid,
  message_id uuid,
  content text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with terms as (
    select unnest(
      string_to_array(
        regexp_replace(trim(public.immutable_unaccent(lower(p_query))), '\s+', ' ', 'g'),
        ' '
      )
    ) as term
  ),
  hits as (
    select distinct on (m.conversation_id)
      m.conversation_id,
      m.id as message_id,
      m.content,
      m.created_at
    from public.messages m
    where m.message_type <> 'system_event'
      and m.content is not null
      and not exists (
        select 1 from terms t
        where t.term <> '' and m.search_text not like '%' || t.term || '%'
      )
      and exists (select 1 from terms t where t.term <> '')
    order by m.conversation_id, m.created_at desc
  )
  select conversation_id, message_id, content, created_at
  from hits
  order by created_at desc
  limit greatest(p_limit, 0);
$$;

comment on function public.search_conversations_by_message(text, integer) is
  'Conversaciones cuyo historial contiene todas las palabras buscadas, con el mensaje coincidente más reciente de cada una.';

grant execute on function public.search_conversations_by_message(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Método de pago y autor del cierre
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column deal_payment_method text
    check (deal_payment_method in ('pago_movil', 'transferencia', 'zelle', 'cashea')),
  add column deal_closed_by uuid references public.agents (id) on delete set null;

comment on column public.conversations.deal_payment_method is
  'Con qué pagó el cliente. Se elige al cerrar la venta y no se edita después.';
comment on column public.conversations.deal_closed_by is
  'Quién cerró la venta. No es el agente asignado: la conversación puede reasignarse, o puede cerrarla el supervisor.';

-- Las ventas que ya están cerradas sí dejaron rastro de su autor: el evento de
-- sistema que escribe `closeSaleWithContactInfo` guarda el agente que lo
-- disparó. Se recupera de ahí en vez de dejar la columna vacía para siempre.
update public.conversations c
set deal_closed_by = m.sender_agent_id
from (
  select distinct on (conversation_id)
    conversation_id, sender_agent_id
  from public.messages
  where message_type = 'system_event'
    and sender_agent_id is not null
    and content like 'Venta cerrada por %'
  order by conversation_id, created_at desc
) m
where m.conversation_id = c.id
  and c.deal_closed_by is null
  and c.deal_status in ('won', 'returned');

-- ---------------------------------------------------------------------------
-- 3. El doble check no camina hacia atrás
--
-- Meta manda los avisos de estado por webhook y no garantiza el orden: un
-- "delivered" que llega tarde pisaba un "read" que ya había llegado, y el chat
-- pasaba de dos checks azules a dos grises solo. Como el estado solo avanza
-- (enviado → recibido → leído), se descarta cualquier retroceso.
--
-- 'failed' es la excepción: no es un paso del recorrido sino su final, y
-- siempre debe poder pisar lo que haya.
-- ---------------------------------------------------------------------------
create function public.whatsapp_status_rank(status text)
returns integer
language sql
immutable
parallel safe
as $$
  select case status
    when 'sent' then 1
    when 'delivered' then 2
    when 'read' then 3
    else 0
  end
$$;

create function public.keep_whatsapp_status_moving_forward()
returns trigger
language plpgsql
as $$
begin
  if new.whatsapp_status is distinct from old.whatsapp_status
     and new.whatsapp_status <> 'failed'
     and old.whatsapp_status is not null
     and public.whatsapp_status_rank(new.whatsapp_status)
         < public.whatsapp_status_rank(old.whatsapp_status)
  then
    new.whatsapp_status := old.whatsapp_status;
  end if;
  return new;
end;
$$;

create trigger on_message_status_regression
  before update of whatsapp_status on public.messages
  for each row
  execute function public.keep_whatsapp_status_moving_forward();
