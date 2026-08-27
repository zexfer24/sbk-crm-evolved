-- ---------------------------------------------------------------------------
-- Por qué no se entregó: el motivo del fallo, no sólo el hecho
--
-- `whatsapp_status = 'failed'` es todo lo que guardábamos. En la burbuja eso
-- se pinta como un triángulo rojo sin explicación, así que el asesor hace lo
-- único que puede hacer con un triángulo rojo: reintentar. Y vuelve a fallar,
-- porque el motivo no era temporal.
--
-- El caso que lo destapó: el chat de Gabriel Becerra, cinco envíos fallidos
-- seguidos contra un contacto cuyo phone_number es la cadena '+undefined'.
-- Desde el registro no se podía diagnosticar — hubo que llegar por el número,
-- consultando la base. Meta manda el código y el motivo en el webhook de
-- estado y los estábamos tirando.
--
-- Con estas dos columnas, "no se envió" pasa a ser "el número no existe" o
-- "pasaron 24 h", que son dos problemas distintos con dos arreglos distintos:
-- el primero se corrige pidiéndole el número al cliente, el segundo esperando
-- a que vuelva a escribir. Hoy los dos se ven igual.
--
-- Dos columnas y no una: el código es para agrupar y alertar (cuántos 131026
-- van hoy), el texto es para que la persona que mira la burbuja entienda.
-- Metidos en una sola cadena, ninguna de las dos cosas sale bien.
--
-- Sin índice ni NOT NULL: la inmensa mayoría de las filas son entregas
-- normales y ahí esto es null. Sólo se consulta mirando un mensaje concreto,
-- que ya llega por la clave primaria o por conversation_id.
-- ---------------------------------------------------------------------------

alter table public.messages
  add column whatsapp_error_code integer,
  add column whatsapp_error_detail text;

comment on column public.messages.whatsapp_error_code is
  'Código de error de la Cloud API de Meta cuando el envío falló (ej. 131026 "Message undeliverable", 131047 fuera de la ventana de 24 h). Null en todo lo que no falló. Para agrupar y alertar.';

comment on column public.messages.whatsapp_error_detail is
  'Motivo del fallo en palabras, tal como lo manda Meta. Es lo que se le muestra al asesor sobre el triángulo rojo, para que sepa si reintentar sirve de algo o no.';
