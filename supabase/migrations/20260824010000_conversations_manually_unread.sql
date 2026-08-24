-- ---------------------------------------------------------------------------
-- "Marcar como no leído" en la bandeja
--
-- El asesor a veces abre un chat, ve que no puede atenderlo ahora y quiere
-- dejarlo apartado para volver. Hasta hoy no había forma: abrir el chat ponía
-- `unread_count` en 0 y la conversación desaparecía del filtro "Sin leer".
--
-- Se resuelve con una columna aparte y no subiendo `unread_count` a 1. El
-- contador cuenta mensajes que el cliente mandó y nadie leyó; falsearlo haría
-- que la bandeja mostrara un "1" que no corresponde a ningún mensaje, y que
-- cualquier cosa que lea ese número más adelante —un reporte, una alerta de
-- chats desatendidos— arrastre la mentira. Con el flag aparte, `unread_count`
-- sigue diciendo la verdad y la bandeja combina las dos señales.
--
-- Un mensaje entrante nuevo no lo toca: ese caso ya sube `unread_count` y la
-- conversación sale igual en "Sin leer". El flag se limpia cuando alguien
-- vuelve a abrir el chat, junto con el contador.
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column manually_unread boolean not null default false;

comment on column public.conversations.manually_unread is
  'El asesor apartó el chat a propósito, aunque no le queden mensajes sin leer. Aparte de unread_count para no falsear el conteo real.';

-- El filtro "Sin leer" recorre la bandeja entera en cada carga. `unread_count
-- > 0` ya tiene su índice parcial (conversations_unread_idx); las apartadas a
-- mano necesitan el suyo, porque para ellas el contador está en 0.
create index conversations_manually_unread_idx
  on public.conversations (last_message_at desc)
  where manually_unread;
