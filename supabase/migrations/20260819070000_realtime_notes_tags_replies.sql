-- ============================================================================
-- Notas internas, etiquetas y mensajes rápidos quedaban fuera de la
-- publicación de Realtime: las mutaciones (crear/editar/borrar) se
-- guardaban bien en la base, pero como nada dispara el evento
-- postgres_changes que escuchan los canales del front, la UI se quedaba
-- con los datos viejos hasta que alguien recargaba la página a mano. Desde
-- fuera esto se ve exactamente como "no funciona".
-- ============================================================================

alter publication supabase_realtime add table public.notes;
alter publication supabase_realtime add table public.tags;
alter publication supabase_realtime add table public.contact_tags;
alter publication supabase_realtime add table public.quick_replies;
alter publication supabase_realtime add table public.agents;
