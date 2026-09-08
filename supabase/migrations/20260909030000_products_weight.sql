-- ============================================================================
-- T4 del plan "Seis frentes del buzón" (8/9/2026)
--
-- Cashea (la financiera venezolana que muchos clientes usan para pagar) exige
-- que todo producto tenga un peso: lo usa para calcular si el envío sale
-- gratis. El inventario del CRM (misma tabla `products` que lee la
-- herramienta de catálogo de la IA) todavía no tenía dónde guardarlo.
--
-- Decisión del operador: kilogramos con 3 decimales (`numeric(8,3)`, hasta
-- 99999.999 kg, de sobra para un repuesto de moto). `null` significa "sin
-- cargar" -- la mayoría del catálogo hoy, hasta que alguien lo complete a
-- mano desde Inventario. La IA NO lee esta columna (fuera de alcance de T4):
-- `buildCatalogTool` sigue sin seleccionarla.
--
-- `add column if not exists` porque esta migración puede correr sobre una
-- base que ya la tenga (reintentos de CI, entornos que se resetean a medias).
-- ============================================================================

alter table public.products
  add column if not exists weight_kg numeric(8, 3)
    check (weight_kg is null or weight_kg >= 0);

comment on column public.products.weight_kg is
  'Peso en kilogramos para el envío; Cashea lo exige para calcular el envío gratis. Null = sin cargar. Plan Seis frentes del buzón, T4, 8/9/2026.';
