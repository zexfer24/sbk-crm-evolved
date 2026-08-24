-- ---------------------------------------------------------------------------
-- La reacción del cliente, pegada al mensaje al que reacciona
--
-- Cuando el cliente mantiene pulsado un mensaje y le pone 👍 ❤️ 😂, Meta no
-- manda "un mensaje con un emoji": manda un evento aparte que dice a qué
-- mensaje reacciona y con qué. Hasta ahora el webhook no conocía ese tipo y
-- lo guardaba como texto suelto — quedan 5 en producción con el cartel
-- "[reaction] Tipo de mensaje no soportado todavía".
--
-- Se guarda como columna del mensaje y no como fila propia porque en un chat
-- de WhatsApp uno a uno hay una sola reacción por mensaje: la del cliente, y
-- reemplaza a la anterior. Una tabla aparte modelaría un "varias personas
-- reaccionando" que en este canal no existe.
--
-- Null significa las dos cosas que en la práctica son la misma: nunca
-- reaccionó, o quitó la reacción. Meta manda el retiro como una reacción con
-- el emoji vacío, y eso vuelve a dejar la columna en null.
-- ---------------------------------------------------------------------------

alter table public.messages
  add column reaction_emoji text;

comment on column public.messages.reaction_emoji is
  'Emoji con el que el cliente reaccionó a este mensaje. Null si no hay reacción o si la quitó.';
