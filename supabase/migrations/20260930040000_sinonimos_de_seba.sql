-- ============================================================================
-- A2 T6 · M4 -- Sinónimos de Seba sembrados como lecciones globales
-- (plan "Seba no cotiza lo que no es", 30/9/2026, decisión D4 y 2.7 del
-- estudio del VPS).
--
-- MIGRACIÓN DE DATOS: no cambia ningún esquema, solo inserta filas en
-- `public.ai_lessons` (kind = 'sinonimo', scope = 'global', is_active).
--
-- Por qué existe: hoy la jerga del cliente no encuentra el nombre real del
-- catálogo y produce AGOTADOS FALSOS -- Seba dice que no hay lo que sí hay:
--   - "asiento express" sale agotado con el FORRO ASIENTO EK EXPRESS (0 u.),
--     mientras ASIENTO EK XPRESS BENF tiene 2 u.  (express -> xpress)
--   - "balaclava" no encuentra PASAMONTAÑA BUFF MUJER, 3 u.
--   - "litros"/"litro" no encuentran MALETA CUADRADA 45 LTS, con stock:
--     Saint escribe "LTS".
--   - "direccional" no encuentra LUZ CRUCE HORSE 1, 20 u.
--   - "boca pato" no encuentra el pico de pato del GR250, 12 u.
--   - "luz" no encuentra CUBRE LEVAS LED, 31 u.
--   - y espejo/retrovisor, porta maleta/base maleta, empaque/empacadura,
--     scuda/escuda, rones/rin, kit de rodaje/kit rodamiento, foco/faro,
--     relación -> corona y relación -> piñón (dos filas: una relación de
--     transmisión es el juego corona + piñón).
-- Decisión D4 del operador: opción (a), globales y EDITABLES desde el panel
-- de Lecciones de Seba (Control IA) -- no una tabla ni una lista en código.
--
-- created_by queda NULL a propósito: la columna es nullable con `on delete
-- set null` (20260917020000) y la RLS de insert exige `created_by =
-- auth.uid()` SOLO para quien inserta desde la app; esta migración corre
-- como postgres, sin sesión, y ningún agente real escribió estos pares.
-- Inventar un "autor de sistema" (o tomar el primer admin) le atribuiría a
-- una persona algo que no escribió. Con NULL, un supervisor/admin sí puede
-- editarlas, desactivarlas o borrarlas (`ai_lessons_update`/`_delete`:
-- is_supervisor_or_admin() or created_by = auth.uid()); un asesor corriente
-- no, que es lo que se quiere para un diccionario compartido.
--
-- Idempotente: cada par entra `where not exists` por (from, to) normalizado
-- (minúsculas, sin espacios de borde) y scope global -- si el operador ya
-- cargó a mano "express -> xpress" o lo editó, la migración no lo duplica.
-- Un par que el operador BORRÓ y que esta migración vuelve a sembrar al
-- reaplicarse es una consecuencia aceptada: la migración corre una sola vez
-- en producción.
--
-- `content` lleva el texto legible del par ("Sinónimo: express → xpress"),
-- dentro del CHECK de 1-200 caracteres: es lo que muestra el panel.
--
-- Va con lock_timeout + guarda + notify pgrst como las demás migraciones de
-- Seba, aunque sea de datos: el INSERT toma un lock de fila/tabla ligero
-- pero el patrón es el mismo y la guarda falla cerrado sin `psql -1`.
-- ============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

insert into public.ai_lessons (scope, kind, content, synonym_from, synonym_to, is_active, created_by)
select 'global', 'sinonimo', 'Sinónimo: ' || v.desde || ' → ' || v.hacia, v.desde, v.hacia, true, null
from (values
  ('express', 'xpress'),
  ('balaclava', 'pasamontaña'),
  ('litros', 'lts'),
  ('litro', 'lts'),
  ('espejo', 'retrovisor'),
  ('direccional', 'luz cruce'),
  ('porta maleta', 'base maleta'),
  ('boca pato', 'pico pato'),
  ('luz', 'led'),
  ('empaque', 'empacadura'),
  ('scuda', 'escuda'),
  ('rones', 'rin'),
  ('kit de rodaje', 'kit rodamiento'),
  ('foco', 'faro'),
  ('relacion', 'corona'),
  ('relacion', 'piñon')
) as v (desde, hacia)
where not exists (
  select 1
  from public.ai_lessons l
  where l.kind = 'sinonimo'
    and l.scope = 'global'
    and lower(btrim(l.synonym_from)) = lower(btrim(v.desde))
    and lower(btrim(l.synonym_to)) = lower(btrim(v.hacia))
);

-- Autoverificación: los 16 pares quedaron como sinónimo global (activo o no:
-- si el operador ya había desactivado uno, sigue existiendo).
do $$
declare
  n integer;
begin
  select count(*) into n
  from public.ai_lessons
  where kind = 'sinonimo'
    and scope = 'global'
    and (lower(btrim(synonym_from)), lower(btrim(synonym_to))) in (
      ('express', 'xpress'), ('balaclava', 'pasamontaña'), ('litros', 'lts'),
      ('litro', 'lts'), ('espejo', 'retrovisor'), ('direccional', 'luz cruce'),
      ('porta maleta', 'base maleta'), ('boca pato', 'pico pato'), ('luz', 'led'),
      ('empaque', 'empacadura'), ('scuda', 'escuda'), ('rones', 'rin'),
      ('kit de rodaje', 'kit rodamiento'), ('foco', 'faro'),
      ('relacion', 'corona'), ('relacion', 'piñon')
    );
  if n < 16 then
    raise exception '20260930040000: se esperaban al menos 16 sinónimos sembrados y hay %', n;
  end if;
  raise notice '20260930040000: % sinónimos de Seba presentes.', n;
end
$$;

-- Sin esto PostgREST podría seguir sirviendo datos cacheados de la tabla
-- (mismo patrón que el resto de las migraciones de Seba, hallazgo M1 del
-- 19/9/2026).
notify pgrst, 'reload schema';
