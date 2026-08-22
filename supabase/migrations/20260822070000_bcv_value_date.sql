-- ---------------------------------------------------------------------------
-- La tasa del BCV tiene dos fechas, no una
--
-- `rate_date` guardaba el día en que se leía la tasa, y eso mezclaba dos
-- cosas distintas: cuándo la leímos y desde cuándo rige. El BCV publica el
-- sábado la tasa que entra en vigencia el lunes — su página lo dice con
-- todas las letras ("Fecha Valor: Lunes, 24 Agosto 2026").
--
-- A partir de acá `rate_date` es la vigencia que publica el BCV, y
-- `fetched_on` es el día en que salimos a buscarla. Con las dos separadas ya
-- no hay que adivinar: se muestra la vigencia real y se decide el refresco
-- por la fecha de lectura.
-- ---------------------------------------------------------------------------

alter table public.exchange_rates
  add column fetched_on date;

comment on column public.exchange_rates.rate_date is
  'Fecha de vigencia que publica el BCV ("Fecha Valor"). El sábado ya trae la del lunes.';
comment on column public.exchange_rates.fetched_on is
  'Día en que se leyó bcv.org.ve. Decide cuándo toca volver a consultar; null en filas viejas o sembradas.';

create index exchange_rates_fetched_on_idx
  on public.exchange_rates (fetched_on desc nulls last);
