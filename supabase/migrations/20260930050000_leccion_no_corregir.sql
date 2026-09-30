-- ============================================================================
-- A2 T6 · M5 -- Lección "No corregir esta palabra" (kind = 'no_corregir')
-- (plan "Seba no cotiza lo que no es", 30/9/2026, decisión D5).
--
-- Contexto: el corrector de tipeos (`public.corregir_terminos`, 20260928020000)
-- reintenta una búsqueda sin coincidencia con la palabra "corregida" y se lo
-- dice al cliente ("busqué IPONE en lugar de iphone"). Una corrección mala
-- existe: el caso que motivó D5 es "pareja" -> "para" -- la palabra es
-- legítima, el corrector la ve como un tipeo a distancia corta de otra del
-- vocabulario y Seba busca lo que el cliente nunca pidió. Hasta hoy, evitarlo
-- exigía tocar código (`p_protegidos` viene de `MOTOS_CONOCIDAS`, una lista
-- cerrada). Decisión D5 del operador, opción (a): un botón "No corregir esta
-- palabra" guarda una lección global `kind = 'no_corregir'`, que un
-- supervisor puede apagar (`is_active = false`), y `corregirTerminos` la suma
-- a `p_protegidos`. Esta migración solo abre el esquema; leerla en el
-- corrector y el botón son tareas de código aparte.
--
-- DÓNDE VIVE LA PALABRA: en `synonym_from`, sin columna nueva. Se evaluó
-- `protected_word` y se descartó: (1) `synonym_from` ya es una columna de
-- texto nullable, sin CHECK propio salvo el de `sinonimo`, y "el término que
-- el cliente escribe y que se debe respetar tal cual" es exactamente su
-- significado también aquí; (2) una columna nueva obligaría a regenerar
-- `database.types.ts`, a tocar el panel de Lecciones y a sumar otro `comment`
-- y otro índice sin ganar nada -- las dos lecturas que existen
-- (`fetchTurnLessons` filtra `kind = 'nota'`, `leerSinonimos` filtra
-- `kind = 'sinonimo'`) discriminan por `kind`, así que una fila
-- `no_corregir` nunca se cuela al prompt ni al diccionario de sinónimos.
-- Contrapartida aceptada: quien lea `synonym_from` sin mirar `kind` vería
-- palabras que no son sinónimos; por eso el `comment on column` lo dice y la
-- constraint de abajo blinda la forma (`synonym_to` siempre null).
--
-- La constraint `ai_lessons_no_corregir_requires_word` exige, para
-- `no_corregir`: `synonym_from` presente, `synonym_to` null y `scope =
-- 'global'` (la protección de una palabra vale para todo el negocio; una
-- versión "solo este chat" no tiene sentido para un corrector que corre sobre
-- el catálogo). El CHECK de `kind` se AMPLÍA de dos a tres valores, no se
-- abre. Su nombre `ai_lessons_kind_check` es el que Postgres le dio al CHECK
-- de columna en 20260917020000; se vuelve a crear con el mismo nombre.
--
-- RLS: las políticas NO cambian. `ai_lessons_insert`/`_update`/`_delete` no
-- miran `kind`: un agente inserta con `created_by = auth.uid()` y el autor o
-- un supervisor/admin edita y borra, igual que un sinónimo o una nota. La
-- autoverificación de abajo confirma que siguen siendo las cuatro de siempre.
-- ============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

alter table public.ai_lessons drop constraint if exists ai_lessons_kind_check;
alter table public.ai_lessons
  add constraint ai_lessons_kind_check check (kind in ('nota', 'sinonimo', 'no_corregir'));

alter table public.ai_lessons drop constraint if exists ai_lessons_no_corregir_requires_word;
alter table public.ai_lessons
  add constraint ai_lessons_no_corregir_requires_word check (
    kind <> 'no_corregir'
    or (synonym_from is not null and synonym_to is null and scope = 'global')
  );

comment on column public.ai_lessons.kind is
  'nota (default) = texto libre que el modelo lee como instrucción o corrección. sinonimo (P3) = un par synonym_from/synonym_to que catalog-search.ts usa para expandir términos de búsqueda del catálogo, nunca se le muestra al modelo como prosa. no_corregir (D5, 30/9/2026) = una palabra que el corrector de tipeos no debe tocar; la palabra vive en synonym_from, synonym_to es null y el alcance es siempre global (ver ai_lessons_no_corregir_requires_word).';
comment on column public.ai_lessons.synonym_from is
  'Con kind=sinonimo: el término que el cliente usa (jerga, error común). Con kind=no_corregir (D5): la palabra protegida, tal como el cliente la escribe, que corregir_terminos no debe reemplazar (synonym_to queda null). Obligatorio para ambos kinds -- ver los CHECK ai_lessons_synonym_requires_terms y ai_lessons_no_corregir_requires_word.';

-- Autoverificación contra el catálogo real (no contra este archivo): el CHECK
-- de kind acepta los tres valores y no queda ningún CHECK viejo de dos
-- valores conviviendo con el nuevo, la constraint de forma existe, y las
-- políticas RLS siguen siendo las cuatro de siempre.
do $$
declare
  kind_checks integer;
  kind_def text;
  word_checks integer;
  policy_count integer;
begin
  select count(*), max(pg_get_constraintdef(oid)) into kind_checks, kind_def
    from pg_constraint
    where conrelid = 'public.ai_lessons'::regclass
      and contype = 'c'
      and conname = 'ai_lessons_kind_check';
  if kind_checks is distinct from 1 or kind_def not like '%no_corregir%' then
    raise exception '20260930050000: ai_lessons_kind_check no quedó ampliado (%, %)', kind_checks, kind_def;
  end if;

  -- Ningún otro CHECK que restrinja `kind` a la lista vieja.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_lessons'::regclass
      and contype = 'c'
      and conname <> 'ai_lessons_kind_check'
      and pg_get_constraintdef(oid) like '%kind%''nota''%'
      and pg_get_constraintdef(oid) not like '%no_corregir%'
      and pg_get_constraintdef(oid) not like '%<>%'
  ) then
    raise exception '20260930050000: queda un CHECK viejo que restringe kind a nota/sinonimo';
  end if;

  select count(*) into word_checks
    from pg_constraint
    where conrelid = 'public.ai_lessons'::regclass
      and conname = 'ai_lessons_no_corregir_requires_word';
  if word_checks is distinct from 1 then
    raise exception '20260930050000: ai_lessons_no_corregir_requires_word no quedó creada';
  end if;

  select count(*) into policy_count
    from pg_policies
    where schemaname = 'public' and tablename = 'ai_lessons';
  if policy_count is distinct from 4 then
    raise exception '20260930050000: ai_lessons esperaba 4 políticas RLS, encontró %', policy_count;
  end if;

  raise notice '20260930050000: autoverificación de ai_lessons.kind = no_corregir correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado (hallazgo M1 del
-- 19/9/2026, misma práctica que las demás migraciones de Seba).
notify pgrst, 'reload schema';
