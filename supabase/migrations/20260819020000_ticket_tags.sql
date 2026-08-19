-- ============================================================================
-- Etiquetas de reclamo
--
-- Un reclamo se marca etiquetando al contacto. El dashboard cuenta como
-- reclamo cualquier etiqueta cuyo nombre empiece por "Reclamo", y usa lo que
-- va después del separador como categoría. Para abrir una categoría nueva
-- basta con crear la etiqueta: no hace falta tocar el código.
-- ============================================================================
insert into public.tags (label, color) values
  ('Reclamo · Envío', 'danger'),
  ('Reclamo · Pago', 'danger'),
  ('Reclamo · Producto', 'danger'),
  ('Reclamo · Atención', 'danger'),
  ('Reclamo · Garantía', 'danger')
on conflict (label) do nothing;
