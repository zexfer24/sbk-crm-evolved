-- ============================================================================
-- T1 de la corrida "La ventana de 24 h dice la verdad" (7/9/2026)
--
-- El caso que la destapó: la conversación aa75ef33-38e8-4ff4-8422-7e7f49615795
-- (+593987317372) mostraba la caja de texto habilitada y "quedan 11 h"
-- mientras Meta rechazaba todo con el código 131047 (ventana de 24 h
-- cerrada). Causa con dos partes:
--
--   1. El 6/9/2026 02:54 UTC entró un mensaje `unsupported` de Meta (algo
--      que el CRM todavía no sabe representar) y se guardó como `inbound`.
--      `handle_new_message()` movía `last_customer_message_at` (lcma) con
--      CUALQUIER entrante, sin distinguir tipo. Meta no cuenta ese evento
--      como "el cliente escribió" para su propia ventana de 24 h -- el CRM
--      sí lo contaba, y por eso el reloj de la ventana se reiniciaba con un
--      mensaje que, para Meta, nunca abrió nada.
--
--   2. Cuando Meta contesta un envío con el código 131047 -- "ventana de 24 h
--      cerrada", dicho por la fuente de verdad -- el CRM lo guardaba en
--      `whatsapp_error_code` pero nunca lo usaba para corregir su propio
--      reloj (`last_customer_message_at`, que es lo que
--      `isWithin24hWindow()` en `src/lib/whatsapp-window.ts` mira para
--      decidir si la caja de texto se habilita). El aviso más explícito que
--      existe se quedaba sin efecto.
--
-- La solución son dos candados sobre `last_customer_message_at`, los dos en
-- las DOS funciones que pueden mover esa columna (ver hallazgo 1 más abajo):
--
--   Candado A -- un entrante `message_type = 'unsupported'` deja de mover
--   `last_customer_message_at` (y `unread_count`, que cuenta lo mismo que
--   "el cliente escribió"). Sigue siendo VISIBLE en el chat -- `last_message_
--   at`/preview/`direction` no cambian -- solo deja de reabrir la ventana de
--   24 h. Consistente con que Meta tampoco lo cuenta para la suya.
--
--   Candado B -- un saliente que Meta rechaza con 131047 empuja
--   `last_customer_message_at` hacia atrás: `least(lcma, created_at - 24h)`.
--   Si Meta dice que la ventana ya estaba cerrada AL MOMENTO de este envío,
--   entonces el último mensaje real del cliente tiene que ser de más de 24 h
--   antes de ese envío -- como mínimo. `least()` nunca lo adelanta, solo lo
--   puede atrasar (o dejarlo igual si ya estaba más atrás).
--
--   Dos guardas adicionales sobre el candado B, las dos necesarias para no
--   introducir un bug peor que el que arregla:
--     - `last_customer_message_at is not null`: `least(null, x)` devuelve
--       `x` en Postgres, así que sin esta guarda un 131047 sobre una
--       conversación que TODAVÍA no tiene ningún mensaje del cliente le
--       pondría una fecha de la nada -- encendiendo `awaiting_reply` (columna
--       generada) sobre un lead que nunca escribió.
--     - `new.created_at > last_customer_message_at`: un callback de Meta
--       puede llegar tarde (reintentos, colas). Si el mensaje fallido es
--       ANTERIOR al último mensaje real que ya se registró, no tiene sentido
--       cerrar la ventana con él -- el cliente ya volvió a escribir después.
--
-- Por qué en las DOS funciones y no solo una: la IA (`src/lib/ai/send.ts`,
-- `sendAgentText`/`sendAgentMedia`, ~líneas 126 y 157) inserta sus mensajes
-- YA con `whatsapp_status = 'failed'` y `whatsapp_error_code` puestos --
-- nunca hay un UPDATE posterior para esos, así que el trigger de estado
-- (`on_message_status_changed`, que dispara `after update of
-- whatsapp_status, is_auto_reply`) JAMÁS corre para un rechazo de la IA. El
-- candado B tiene que estar en `handle_new_message()` (camino INSERT) para
-- cubrir ese caso, y en `handle_message_status_change()` (camino UPDATE)
-- para cubrir al asesor (`src/app/api/messages/send/route.ts` ~246-267) y el
-- callback de Meta sobre un mensaje que salió `sent` y falló después
-- (`src/app/api/webhooks/whatsapp/route.ts` ~880-894) -- ambos caminos hacen
-- un solo UPDATE con `whatsapp_status` + `whatsapp_error_code` juntos.
--
-- Sin trigger nuevo ni recreado: `on_message_inserted` (dispara
-- `handle_new_message` en cada INSERT) y `on_message_status_changed` (ya
-- dispara por `whatsapp_status`, que es justo lo que cambia en los dos UPDATE
-- de arriba) ya cubren los cuatro caminos. Solo `create or replace function`
-- -- ninguna es `security definer` NUEVA, así que no hacen falta revokes ni
-- grants: `create or replace` conserva el ACL que ya tenían desde
-- 20260830010000 (igual que hizo 20260905070000 con
-- `handle_message_status_change`).
--
-- Migración IDEMPOTENTE: `create or replace function` más un backfill hecho
-- de UPDATEs que no empeoran si se repiten (el paso (a) ya no encuentra el
-- texto histórico la segunda vez; el paso (c) usa `least()`, que aplicado dos
-- veces da el mismo resultado que una vez). `supabase/tests/ventana_24h.sql`
-- la reaplica con `\i` para demostrarlo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. handle_new_message(): parte de la versión vigente en
--    20260905010000_conversations_last_reply.sql. Cambian SOLO
--    `last_customer_message_at` (candados A y B) y `unread_count` (candado
--    A, misma condición). `visible`, `last_message_*`, `has_reply` y
--    `last_reply_*` quedan exactamente igual.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  visible boolean;
begin
  -- "Visible" es lo que la bandeja pinta como el último mensaje del hilo: un
  -- entrante del cliente, o un saliente del asesor/IA que no sea una nota
  -- interna. Un evento de sistema (sender_type='system') o una nota
  -- (is_internal_note) no son visibles: no mueven la preview de la lista.
  visible := new.direction = 'inbound'
    or (new.sender_type in ('agent', 'ai') and not new.is_internal_note);

  update public.conversations
  set
    last_message_at = case when visible then new.created_at else last_message_at end,
    last_message_preview = case when visible
      then left(coalesce(new.content, initcap(replace(new.message_type, '_', ' '))), 280)
      else last_message_preview
    end,
    last_message_direction = case when visible then new.direction else last_message_direction end,
    last_message_status = case when visible then new.whatsapp_status else last_message_status end,
    -- Candado A: un `unsupported` sigue siendo visible arriba (se ve en el
    -- chat) pero no cuenta como "el cliente escribió" para el reloj de la
    -- ventana de 24 h -- Meta tampoco lo cuenta para la suya.
    --
    -- Candado B: un saliente que la IA insertó YA fallido con 131047 (Meta
    -- avisando que la ventana ya estaba cerrada al momento del envío) empuja
    -- el reloj hacia atrás. `last_customer_message_at is not null` evita que
    -- `least(null, x)` invente una fecha sobre un lead sin mensajes; `new.
    -- created_at > last_customer_message_at` evita que un fallo insertado
    -- fuera de orden retroceda un reloj que un mensaje posterior ya adelantó.
    last_customer_message_at = case
      when new.direction = 'inbound' and new.message_type <> 'unsupported' then new.created_at
      when new.direction = 'outbound'
        and new.whatsapp_status = 'failed'
        and new.whatsapp_error_code = 131047
        and last_customer_message_at is not null
        and new.created_at > last_customer_message_at
      then least(last_customer_message_at, new.created_at - interval '24 hours')
      else last_customer_message_at
    end,
    has_reply = has_reply or (
      new.direction = 'outbound'
      and new.sender_type <> 'system'
      and not new.is_internal_note
    ),
    -- Mismo candado A que arriba: un `unsupported` no suma a "no leídos" --
    -- no es un mensaje que el cliente esté esperando que alguien lea, es
    -- Meta avisando de algo que no supo entregar tal cual.
    unread_count = case
      when new.direction = 'inbound' and new.message_type <> 'unsupported' then unread_count + 1
      else unread_count
    end,
    -- Respuesta real: saliente, visible, ni bienvenida automática ni
    -- rechazada por Meta. Una nota, un evento de sistema, la plantilla de
    -- bienvenida o un envío que Meta ya rechazó al insertarse (whatsapp_status
    -- llega 'failed' desde el arranque, no solo por un update posterior) NO
    -- apagan "esperando respuesta".
    last_reply_at = case
      when new.direction = 'outbound'
        and visible
        and not new.is_auto_reply
        and new.whatsapp_status is distinct from 'failed'
      then new.created_at
      else last_reply_at
    end,
    last_reply_sender = case
      when new.direction = 'outbound'
        and visible
        and not new.is_auto_reply
        and new.whatsapp_status is distinct from 'failed'
      then new.sender_type
      else last_reply_sender
    end,
    updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. handle_message_status_change(): parte de la versión vigente en
--    20260905070000_auto_reply_recalcula.sql. Los dos bloques existentes
--    (propagar `last_message_status`, recalcular `last_reply_at`/`last_reply_
--    sender`) NO se tocan -- se suma un tercer bloque, candado B para el
--    camino UPDATE: el asesor (`api/messages/send/route.ts`) y el callback
--    de Meta (`webhooks/whatsapp/route.ts`) marcan `whatsapp_status='failed'`
--    junto con `whatsapp_error_code` en un solo UPDATE, y ese UPDATE es lo
--    que dispara `on_message_status_changed`. Mismas dos guardas que el
--    candado A/B de `handle_new_message()`: sin mensaje del cliente no se
--    inventa fecha, y un callback que llega tarde (posterior a un mensaje
--    real del cliente) no retrocede el reloj.
-- ---------------------------------------------------------------------------
create or replace function public.handle_message_status_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.whatsapp_status is distinct from new.whatsapp_status then
    update public.conversations
    set
      last_message_status = new.whatsapp_status,
      updated_at = now()
    where id = new.conversation_id
      and last_message_at = new.created_at;
  end if;

  if new.whatsapp_status = 'failed' or (new.is_auto_reply and not old.is_auto_reply) then
    update public.conversations c
    set
      last_reply_at = (
        select m.created_at
        from public.messages m
        where m.conversation_id = c.id
          and m.direction = 'outbound'
          and m.sender_type in ('agent', 'ai')
          and not m.is_internal_note
          and not m.is_auto_reply
          and m.whatsapp_status is distinct from 'failed'
        order by m.created_at desc
        limit 1
      ),
      last_reply_sender = (
        select m.sender_type
        from public.messages m
        where m.conversation_id = c.id
          and m.direction = 'outbound'
          and m.sender_type in ('agent', 'ai')
          and not m.is_internal_note
          and not m.is_auto_reply
          and m.whatsapp_status is distinct from 'failed'
        order by m.created_at desc
        limit 1
      ),
      updated_at = now()
    where c.id = new.conversation_id
      and c.last_reply_at = new.created_at;
  end if;

  -- Candado B, camino UPDATE: Meta rechazó este saliente con 131047 --
  -- "ventana de 24 h cerrada" -- así que el último mensaje real del cliente
  -- tiene que ser de más de 24 h antes de este envío, como mínimo.
  if new.whatsapp_status = 'failed' and new.whatsapp_error_code = 131047 and new.direction = 'outbound' then
    update public.conversations
    set
      last_customer_message_at = least(last_customer_message_at, new.created_at - interval '24 hours'),
      updated_at = now()
    where id = new.conversation_id
      and last_customer_message_at is not null
      and new.created_at > last_customer_message_at;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill, en tres pasos con `raise notice` del conteo de cada uno.
--
--    (a) Antes de 20260905050000 (T3.2, 5/9/2026) un `unsupported` sin tipo
--    reconocido se guardaba como `message_type='text'` con una frase fija en
--    castellano ("El cliente envió un mensaje que el CRM todavía no sabe
--    mostrar. Se puede ver desde WhatsApp en el teléfono."). Ese texto
--    histórico se reclasifica a `unsupported` para que los pasos (b) y (c)
--    -- y el candado A de la función de arriba, hacia adelante -- lo traten
--    igual que el `unsupported` real de hoy.
--
--    (b) Conversaciones cuyo `last_customer_message_at` apunta exactamente
--    al `created_at` de un entrante `unsupported` (real o recién
--    reclasificado en (a)): se recalcula contra el último entrante que SÍ
--    cuenta. Puede quedar en null si el cliente nunca escribió nada más.
--    `unread_count` NO se recalcula acá -- no hay forma fiable de saber
--    cuántos de los no leídos actuales vinieron de mensajes `unsupported`
--    sin reconstruir el historial de lecturas, y arriesgar un número
--    inventado es peor que dejar el que hay.
--
--    (c) La regla del candado B aplicada retroactivamente a lo que ya está
--    en la base: por conversación con `last_customer_message_at` no nulo
--    (tras (b)), si tiene salientes `failed`/131047 posteriores a esa fecha,
--    el reloj se atrasa a `least(lcma, min(created_at de esos) - 24h)`.
--
--    Verificación esperada en producción: la conversación
--    aa75ef33-38e8-4ff4-8422-7e7f49615795 tiene que quedar con
--    `last_customer_message_at = 2026-08-31 16:50:35+00` tras aplicar esta
--    migración (ver el `select` de evidencia en
--    `supabase/tests/ventana_24h.sql`, caso 6, para el equivalente en datos
--    de prueba).
-- ---------------------------------------------------------------------------
do $$
declare
  n_reclasificados integer;
begin
  update public.messages
  set message_type = 'unsupported'
  where direction = 'inbound'
    and message_type = 'text'
    and content like 'El cliente envió un mensaje que el CRM todavía no sabe mostrar%';
  get diagnostics n_reclasificados = row_count;
  raise notice 'ventana_24h_dice_la_verdad (a): % mensaje(s) histórico(s) reclasificados de text a unsupported', n_reclasificados;
end $$;

do $$
declare
  n_recalculados integer;
begin
  update public.conversations c
  set
    last_customer_message_at = (
      select max(m.created_at)
      from public.messages m
      where m.conversation_id = c.id
        and m.direction = 'inbound'
        and m.message_type <> 'unsupported'
    ),
    updated_at = now()
  where exists (
    select 1
    from public.messages m
    where m.conversation_id = c.id
      and m.direction = 'inbound'
      and m.message_type = 'unsupported'
      and m.created_at = c.last_customer_message_at
  );
  get diagnostics n_recalculados = row_count;
  raise notice 'ventana_24h_dice_la_verdad (b): % conversación(es) con last_customer_message_at recalculado tras excluir unsupported', n_recalculados;
end $$;

do $$
declare
  n_cerrados integer;
begin
  update public.conversations c
  set
    last_customer_message_at = least(
      c.last_customer_message_at,
      (
        select min(m.created_at)
        from public.messages m
        where m.conversation_id = c.id
          and m.direction = 'outbound'
          and m.whatsapp_status = 'failed'
          and m.whatsapp_error_code = 131047
          and m.created_at > c.last_customer_message_at
      ) - interval '24 hours'
    ),
    updated_at = now()
  where c.last_customer_message_at is not null
    and exists (
      select 1
      from public.messages m
      where m.conversation_id = c.id
        and m.direction = 'outbound'
        and m.whatsapp_status = 'failed'
        and m.whatsapp_error_code = 131047
        and m.created_at > c.last_customer_message_at
    );
  get diagnostics n_cerrados = row_count;
  raise notice 'ventana_24h_dice_la_verdad (c): % conversación(es) con last_customer_message_at cerrado retroactivamente por 131047', n_cerrados;
end $$;
