-- ===========================================================================
-- La bandeja habla español: la preview de la lista ya no muestra "Image",
-- "Audio", "Sticker", "Unsupported" en inglés crudo (T1, corrida "La bandeja
-- habla español y el número nuevo queda a un clic", 8/9/2026)
--
-- Migración bajo prueba: 20260908020000_preview_en_espanol.sql.
--
-- Antes de esta migración, `handle_new_message()` escribía en
-- `last_message_preview` el `initcap(replace(message_type, '_', ' '))` del
-- tipo cuando el mensaje no traía `content` -- el tipo crudo en inglés, sin
-- traducir -- y `conversation-list-item.tsx:153` lo pintaba tal cual en la
-- lista de la bandeja. `message_preview_label(message_type)` (función nueva,
-- SQL pura, NO security definer) traduce ese tipo a la etiqueta en español
-- que sí debe verse.
--
-- Casos 1 a 5 corren sobre una sola conversación (A), en orden cronológico,
-- con `created_at` explícitos y crecientes -- dentro de una transacción
-- `now()` es constante, mismo motivo que documentan awaiting_reply.sql y
-- ventana_24h.sql. El caso 3 (unsupported) demuestra de paso que el candado
-- A de 20260907010000 sigue vigente: la preview cambia (es visible) pero
-- `last_customer_message_at`/`unread_count` no se mueven. El caso 6 prueba
-- el BACKFILL de la migración, no el trigger en caliente: necesita `\i`
-- (metacomando de psql, no SQL) para reejecutar la migración sobre datos
-- sembrados después de que la base ya la corrió una vez al construirse --
-- mismo mecanismo que ventana_24h.sql caso 6 y
-- traspaso_sin_contenido_legible.sql casos 3-4. Por eso este archivo tiene
-- VARIOS bloques `do $$` en vez de uno solo: `\i` no puede ir dentro de un
-- bloque plpgsql. Los errores de todos los bloques se acumulan en una tabla
-- temporal y se revisan al final, una sola vez.
--
-- Para correrlo LOCAL contra el contenedor (psql no vive en el host, y el
-- repo no está montado dentro del contenedor): `docker cp` la carpeta
-- `supabase/` del repo a `/tmp/repo/supabase` dentro del contenedor y
-- corré `psql -f supabase/tests/preview_en_espanol.sql` con
-- `docker exec -w /tmp/repo <contenedor> ...` -- el `\i` de abajo, igual que
-- en CI, resuelve su ruta relativa al cwd de psql (repo root), no al
-- directorio del script que lo contiene.
--
-- Corre en el job `migraciones` de CI. Transacción con rollback, no ensucia
-- la base.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

-- Un solo canal para las cuatro conversaciones de este archivo (A: casos
-- 1-5; B, C, D: caso 6, backfill).
insert into public.whatsapp_channels (id, label, phone_number) values
  ('77777777-7777-7777-7777-777777777800', 'Canal de prueba preview_en_espanol', '+580000004000');

insert into public.contacts (id, phone_number) values
  ('77777777-7777-7777-7777-777777777801', '+580000004001');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('77777777-7777-7777-7777-777777777802',
   '77777777-7777-7777-7777-777777777801',
   '77777777-7777-7777-7777-777777777800');

-- ---------------------------------------------------------------------------
-- Casos 1 a 5 (conversación A, en orden cronológico)
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '77777777-7777-7777-7777-777777777802';
  t0 timestamptz := now() - interval '3 hours';
  v_preview text;
  v_lcma timestamptz;
  v_unread integer;
begin
  -- Caso 1 · inbound image sin content -> preview "📷 Foto"
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'image', null, t0);

  select last_message_preview, last_customer_message_at, unread_count
    into v_preview, v_lcma, v_unread
    from public.conversations where id = conv_id;
  if v_preview is distinct from '📷 Foto' then
    insert into _errores(msg) values (format('caso 1 (inbound image sin content): last_message_preview = %L, se esperaba "📷 Foto".', v_preview));
  end if;
  if v_lcma is distinct from t0 then
    insert into _errores(msg) values (format('caso 1: last_customer_message_at = %s, se esperaba t0 (%s).', v_lcma, t0));
  end if;
  if v_unread is distinct from 1 then
    insert into _errores(msg) values (format('caso 1: unread_count = %s, se esperaba 1.', v_unread));
  end if;

  -- Caso 2 · inbound image CON content -> el pie manda, la etiqueta no aplica
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'inbound', 'customer', 'image', 'mira esta', t0 + interval '5 minutes');

  select last_message_preview, last_customer_message_at, unread_count
    into v_preview, v_lcma, v_unread
    from public.conversations where id = conv_id;
  if v_preview is distinct from 'mira esta' then
    insert into _errores(msg) values (format('caso 2 (inbound image con content): last_message_preview = %L, se esperaba "mira esta" (el pie manda sobre la etiqueta).', v_preview));
  end if;
  if v_lcma is distinct from (t0 + interval '5 minutes') then
    insert into _errores(msg) values (format('caso 2: last_customer_message_at = %s, se esperaba t0+5min (%s).', v_lcma, t0 + interval '5 minutes'));
  end if;
  if v_unread is distinct from 2 then
    insert into _errores(msg) values (format('caso 2: unread_count = %s, se esperaba 2.', v_unread));
  end if;

  -- Caso 3 · inbound unsupported -> preview en español, pero el candado A de
  -- 20260907010000 sigue vigente: last_customer_message_at/unread_count NO
  -- se mueven respecto al caso 2 (es visible -- la preview sí cambia --
  -- pero no cuenta como "el cliente escribió" para la ventana de 24h).
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, payload, created_at)
  values (conv_id, 'inbound', 'customer', 'unsupported', null, jsonb_build_object('type', 'video_note'), t0 + interval '10 minutes');

  select last_message_preview, last_customer_message_at, unread_count
    into v_preview, v_lcma, v_unread
    from public.conversations where id = conv_id;
  if v_preview is distinct from 'Mensaje que WhatsApp no entrega' then
    insert into _errores(msg) values (format('caso 3 (inbound unsupported): last_message_preview = %L, se esperaba "Mensaje que WhatsApp no entrega".', v_preview));
  end if;
  if v_lcma is distinct from (t0 + interval '5 minutes') then
    insert into _errores(msg) values (format('caso 3 (candado A): last_customer_message_at = %s, se esperaba que siguiera en t0+5min (%s) -- un unsupported no debe mover la ventana.', v_lcma, t0 + interval '5 minutes'));
  end if;
  if v_unread is distinct from 2 then
    insert into _errores(msg) values (format('caso 3 (candado A): unread_count = %s, se esperaba que siguiera en 2 -- un unsupported no debe sumar a no leídos.', v_unread));
  end if;

  -- Caso 4 · outbound document del asesor, sin content -> "📄 Documento"
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'outbound', 'agent', 'document', null, t0 + interval '15 minutes');

  select last_message_preview into v_preview from public.conversations where id = conv_id;
  if v_preview is distinct from '📄 Documento' then
    insert into _errores(msg) values (format('caso 4 (outbound document del asesor sin content): last_message_preview = %L, se esperaba "📄 Documento".', v_preview));
  end if;

  -- Caso 5 · system_event (outbound, sender_type='system') no es visible ->
  -- la preview no cambia, sigue siendo la del caso 4.
  insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at)
  values (conv_id, 'outbound', 'system', 'system_event', 'La IA se desactivó para esta conversación', t0 + interval '20 minutes');

  select last_message_preview into v_preview from public.conversations where id = conv_id;
  if v_preview is distinct from '📄 Documento' then
    insert into _errores(msg) values (format('caso 5 (system_event no es visible): last_message_preview = %L, se esperaba que siguiera en "📄 Documento" (el evento de sistema no debe pintarse como último mensaje).', v_preview));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 6 · el backfill corrige EXACTAMENTE las previews que quedaron como el
-- initcap en inglés crudo del tipo del último mensaje visible, y no toca
-- ninguna otra.
--
-- Tres conversaciones que simulan el estado que dejó producción ANTES de
-- esta migración -- `on_message_inserted` se desactiva para los inserts: la
-- base ya corrió esta migración una vez al construirse, así que el trigger
-- YA ARREGLADO le pondría la etiqueta en español en caliente y la
-- conversación nunca llegaría a verse como la dejó la producción real.
-- `last_message_preview` se fija a mano al valor "de producción" -- es lo
-- único que el backfill tiene que corregir.
--
--   (a) preview "Image", último visible: image sin content -> el backfill
--       SÍ debe corregirla a "📷 Foto" (message_type de ese último visible es
--       'image', initcap(replace('image','_',' ')) = 'Image' = preview
--       actual -> calza el predicado).
--   (b) preview "Image", último visible: text con content = 'Image' -> el
--       backfill NO debe tocarla (message_type es 'text',
--       initcap(replace('text','_',' ')) = 'Text' <> 'Image' -> no calza --
--       un cliente que escribió literalmente "Image" queda intacto). Ojo:
--       el VALOR recalculado sin el predicado sería igual ('Image', porque
--       el content real domina el coalesce) -- comparar solo el texto de la
--       preview no distingue "se excluyó del backfill" de "se recalculó y
--       coincidió por casualidad". Por eso este caso también fija
--       `updated_at` a un centinela ANTES de reaplicar la migración y
--       comprueba que sigue igual después: si el backfill tocó la fila (aunque
--       el resultado diera el mismo texto) `updated_at` se mueve, y eso es lo
--       que expone la mutación que le quita la condición al backfill.
--   (c) preview "Unsupported", último visible: unsupported -> el backfill SÍ
--       debe corregirla a "Mensaje que WhatsApp no entrega".
-- ---------------------------------------------------------------------------
insert into public.contacts (id, phone_number) values
  ('77777777-7777-7777-7777-777777777805', '+580000004005'),
  ('77777777-7777-7777-7777-777777777807', '+580000004007'),
  ('77777777-7777-7777-7777-777777777809', '+580000004009');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('77777777-7777-7777-7777-777777777806', '77777777-7777-7777-7777-777777777805', '77777777-7777-7777-7777-777777777800'),
  ('77777777-7777-7777-7777-777777777808', '77777777-7777-7777-7777-777777777807', '77777777-7777-7777-7777-777777777800'),
  ('77777777-7777-7777-7777-777777777810', '77777777-7777-7777-7777-777777777809', '77777777-7777-7777-7777-777777777800');

alter table public.messages disable trigger on_message_inserted;

-- (a) último visible: image sin content
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('77777777-7777-7777-7777-777777777806', 'inbound', 'customer', 'image', null, now() - interval '5 days');

-- (b) último visible: text con content literal 'Image'
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('77777777-7777-7777-7777-777777777808', 'inbound', 'customer', 'text', 'Image', now() - interval '5 days');

-- (c) último visible: unsupported
insert into public.messages (conversation_id, direction, sender_type, message_type, content, created_at) values
  ('77777777-7777-7777-7777-777777777810', 'inbound', 'customer', 'unsupported', null, now() - interval '5 days');

alter table public.messages enable trigger on_message_inserted;

update public.conversations set last_message_preview = 'Image', updated_at = '2020-01-01T00:00:00+00' where id = '77777777-7777-7777-7777-777777777806';
update public.conversations set last_message_preview = 'Image', updated_at = '2020-01-01T00:00:00+00' where id = '77777777-7777-7777-7777-777777777808';
update public.conversations set last_message_preview = 'Unsupported', updated_at = '2020-01-01T00:00:00+00' where id = '77777777-7777-7777-7777-777777777810';

-- Reaplica la migración sobre los datos recién sembrados: demuestra el
-- backfill Y, de paso, que `create or replace function` no rompe nada al
-- reaplicarse (ya corrió una vez al construir la base).
\i supabase/migrations/20260908020000_preview_en_espanol.sql

do $$
declare
  v_preview text;
  v_updated_at timestamptz;
begin
  select last_message_preview, updated_at into v_preview, v_updated_at from public.conversations where id = '77777777-7777-7777-7777-777777777806';
  if v_preview is distinct from '📷 Foto' then
    insert into _errores(msg) values (format('caso 6a (backfill, image sin content): last_message_preview = %L, se esperaba "📷 Foto".', v_preview));
  end if;
  if v_updated_at = '2020-01-01T00:00:00+00' then
    insert into _errores(msg) values ('caso 6a (backfill, image sin content): updated_at no se movió -- el backfill debía tocar esta fila (calza el predicado).');
  end if;

  select last_message_preview, updated_at into v_preview, v_updated_at from public.conversations where id = '77777777-7777-7777-7777-777777777808';
  if v_preview is distinct from 'Image' then
    insert into _errores(msg) values (format('caso 6b (backfill, text con content literal "Image"): last_message_preview = %L, se esperaba que quedara intacto en "Image" (no calza el predicado -- su message_type es text, no image).', v_preview));
  end if;
  if v_updated_at is distinct from '2020-01-01T00:00:00+00'::timestamptz then
    insert into _errores(msg) values ('caso 6b (backfill, text con content literal "Image"): updated_at se movió -- el backfill NO debía tocar esta fila (no calza el predicado), aunque el texto recalculado hubiera coincidido con el actual por casualidad.');
  end if;

  select last_message_preview, updated_at into v_preview, v_updated_at from public.conversations where id = '77777777-7777-7777-7777-777777777810';
  if v_preview is distinct from 'Mensaje que WhatsApp no entrega' then
    insert into _errores(msg) values (format('caso 6c (backfill, unsupported): last_message_preview = %L, se esperaba "Mensaje que WhatsApp no entrega".', v_preview));
  end if;
  if v_updated_at = '2020-01-01T00:00:00+00' then
    insert into _errores(msg) values ('caso 6c (backfill, unsupported): updated_at no se movió -- el backfill debía tocar esta fila (calza el predicado).');
  end if;
end $$;

-- Reaplicar una segunda vez: idempotencia -- ninguna de las tres previews ya
-- corregidas debe volver a moverse ni romperse.
\i supabase/migrations/20260908020000_preview_en_espanol.sql

do $$
declare
  v_preview text;
begin
  select last_message_preview into v_preview from public.conversations where id = '77777777-7777-7777-7777-777777777806';
  if v_preview is distinct from '📷 Foto' then
    insert into _errores(msg) values (format('caso 6a (segunda pasada del backfill, idempotencia): last_message_preview = %L, se esperaba que siguiera en "📷 Foto".', v_preview));
  end if;

  select last_message_preview into v_preview from public.conversations where id = '77777777-7777-7777-7777-777777777808';
  if v_preview is distinct from 'Image' then
    insert into _errores(msg) values (format('caso 6b (segunda pasada del backfill, idempotencia): last_message_preview = %L, se esperaba que siguiera en "Image".', v_preview));
  end if;

  select last_message_preview into v_preview from public.conversations where id = '77777777-7777-7777-7777-777777777810';
  if v_preview is distinct from 'Mensaje que WhatsApp no entrega' then
    insert into _errores(msg) values (format('caso 6c (segunda pasada del backfill, idempotencia): last_message_preview = %L, se esperaba que siguiera en "Mensaje que WhatsApp no entrega".', v_preview));
  end if;
end $$;

\echo '--- caso 6: evidencia legible para el reporte ---'
select
  c.id as conversation_id,
  c.last_message_preview,
  m.message_type,
  left(coalesce(m.content, ''), 40) as content,
  m.created_at
from public.conversations c
join public.messages m on m.conversation_id = c.id
where c.id in (
  '77777777-7777-7777-7777-777777777806',
  '77777777-7777-7777-7777-777777777808',
  '77777777-7777-7777-7777-777777777810'
)
order by c.id, m.created_at;

-- ---------------------------------------------------------------------------
-- Veredicto: si algún bloque insertó una fila en _errores, se listan todas
-- de una sola vez.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'preview_en_espanol.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'preview_en_espanol.sql: todas las aserciones pasaron.'
