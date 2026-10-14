# Entrega "Las respuestas rápidas pueden llevar fotos" (14/10/2026)

Rama `entrega/respuestas-rapidas-con-fotos`, partida de `main` = `b1a4fbd`. **UNA migración: `20261014020000_respuestas_rapidas_con_fotos`.** Sin variables de entorno nuevas.

## Commits
1. `[migración]`: agrega `quick_replies.media_paths text[] not null default '{}'` con un check de máximo 10 rutas. Cada ruta debe empezar por `quick-replies/` y no puede tener `..` ni nulls. La validación vive en la función inmutable `quick_reply_media_paths_ok(text[])`, que es `security invoker`, NO definer, así que no cambia el conteo del guardián. La migración trae `lock_timeout` con su guarda, autoverificación y `notify pgrst`. Las respuestas existentes quedan sin fotos.
2. Código. Lee `media_paths`, así que **sin la migración el modal y el composer dan 400** (patrón C2).

## Qué cambia
- **Modal de respuestas rápidas:** «Agregar fotos» acepta JPG/PNG de hasta 5 MB y máximo 10 por respuesta. Muestra miniaturas que se pueden quitar y un contador. La lista marca «📷 N». Una respuesta puede ser solo fotos.
- **Al usarla en el chat:** el texto se pega como hoy y las fotos entran como adjuntos con vista previa, que se pueden quitar antes de enviar. No se vuelven a subir: se manda la misma foto guardada, y el texto va como pie de la primera.
- **Las fotos se guardan en el bucket privado `whatsapp-media/quick-replies/`** y nunca se borran: los mensajes ya enviados apuntan a esa misma ruta.

## Pasos en el VPS
1. Aplicar la migración ANTES del código: `PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261014020000_respuestas_rapidas_con_fotos.sql`. Debe imprimir `NOTICE: 20261014020000: autoverificación de quick_replies.media_paths correcta.`
2. Fast-forward de `main` a `entrega/respuestas-rapidas-con-fotos`. Esto despliega.

## Verificación tras el deploy
1. Crear una respuesta rápida con 2 fotos.
2. Usarla en un chat: se ven los 2 adjuntos.
3. Enviar: el cliente recibe 2 fotos, con el texto como pie de la primera.

Si Meta rechaza el envío, buscar `send.enlace_no_firmado` en el log.

## Verificado en local
- Suite completa: 5045 en verde.
- `tsc` sin errores.
- Test SQL `supabase/tests/respuestas_rapidas_con_fotos.sql` y `quick_replies_personales.sql` en verde.
- Mutaciones en rojo:
  - check sin prefijo;
  - el composer que vuelve a subir las fotos guardadas;
  - validación sin el tope de peso;
  - `createQuickReply` sin `media_paths`.

Pendiente: probar un envío real con una foto guardada. No se puede hacer en local porque el token de Meta del seed está vencido.
