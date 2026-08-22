-- ============================================================================
-- El bucket de multimedia deja de ser público
--
-- Guardaba fotos, audios y documentos que mandan los clientes, y los
-- comprobantes de pago que se suben al cerrar una venta. Con `public = true`
-- cualquiera con la URL llegaba al archivo sin tener cuenta en el CRM, y una
-- URL filtrada no se puede revocar.
--
-- A partir de acá el archivo se pide a /api/media/..., que valida la sesión y
-- redirige a una URL firmada que vence en un minuto.
-- ============================================================================

update storage.buckets set public = false where id = 'whatsapp-media';

-- La política vieja daba lectura a cualquiera, con sesión o sin ella:
-- `using (bucket_id = 'whatsapp-media')` sin rol es anon incluido.
drop policy if exists "whatsapp_media_select" on storage.objects;

create policy "whatsapp_media_select_authenticated" on storage.objects
  for select to authenticated
  using (bucket_id = 'whatsapp-media' and public.is_agent());

-- ---------------------------------------------------------------------------
-- Los mensajes ya guardados apuntan a la URL pública, que a partir de ahora
-- devuelve 400. Se reescriben a la ruta propia para que el historial siga
-- viéndose.
-- ---------------------------------------------------------------------------
update public.messages
set media_url = '/api/media/' || split_part(media_url, '/storage/v1/object/public/whatsapp-media/', 2)
where media_url like '%/storage/v1/object/public/whatsapp-media/%';

-- Los adjuntos de las respuestas de la IA vienen del mismo bucket.
update public.ai_playbooks
set attachment_url = '/api/media/' || split_part(attachment_url, '/storage/v1/object/public/whatsapp-media/', 2)
where attachment_url like '%/storage/v1/object/public/whatsapp-media/%';
