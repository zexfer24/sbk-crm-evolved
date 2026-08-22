-- ============================================================================
-- El canal de Realtime de notas se filtra por contact_id (una nota por
-- contacto). Con REPLICA IDENTITY por defecto (solo la primary key), el
-- payload de un DELETE únicamente trae "id" — sin contact_id el filtro del
-- canal nunca hace match y el borrado nunca llega al front, aunque la fila
-- sí desapareció de la base. FULL hace que el DELETE viaje con la fila
-- completa para que el filtro funcione.
-- ============================================================================

alter table public.notes replica identity full;
