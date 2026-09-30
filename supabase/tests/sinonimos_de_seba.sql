-- ===========================================================================
-- Sinónimos de Seba (A2 T6, plan "Seba no cotiza lo que no es", 30/9/2026)
--
-- Migración bajo prueba: 20260930040000_sinonimos_de_seba.sql.
--
-- Vuelve a aplicar la migración con `\i` DOS VECES dentro de una transacción
-- con rollback y comprueba que deja exactamente los 16 pares (14 sinónimos
-- de 2.7, "relación" contada dos veces), globales, activos, sin duplicados
-- y con `content` dentro del CHECK de 1-200. La segunda aplicación prueba
-- la idempotencia (`where not exists`).
--
-- Como usa `\i`, hay que correrlo con el repo copiado dentro del contenedor
-- (ver CLAUDE.md, "Un test de supabase/tests/ que hace \i…"):
--   tar -cf - supabase | docker exec -i <contenedor> sh -c "mkdir -p /tmp/repo && cd /tmp/repo && tar -xf -"
--   MSYS_NO_PATHCONV=1 docker exec -w /tmp/repo <contenedor> psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f supabase/tests/sinonimos_de_seba.sql
-- (con `-1` el `begin` de abajo es un aviso inofensivo; sin `-1` el
-- `set local lock_timeout` de la migración corre dentro de ESTE begin.)
-- ===========================================================================

begin;

create temporary table _esperados (desde text, hacia text) on commit drop;
insert into _esperados values
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
  ('relacion', 'piñon');

-- Estado previo: si la base ya trae la siembra (la migración aplicada), el
-- test debe seguir dando 16 -- por eso se cuentan solo estos pares.
\i supabase/migrations/20260930040000_sinonimos_de_seba.sql
\i supabase/migrations/20260930040000_sinonimos_de_seba.sql

create temporary table _errores (msg text) on commit drop;

do $$
declare
  n integer;
  faltan text;
  duplicados integer;
  mal_formadas integer;
begin
  -- 1. Los 16 pares existen, globales y activos (una fila cada uno).
  select count(*) into n
    from _esperados e
    join public.ai_lessons l
      on l.kind = 'sinonimo'
     and l.scope = 'global'
     and l.is_active
     and lower(btrim(l.synonym_from)) = lower(btrim(e.desde))
     and lower(btrim(l.synonym_to)) = lower(btrim(e.hacia));
  if n is distinct from 16 then
    insert into _errores(msg) values (format('Caso 1 (siembra): %s de 16 pares encontrados como sinónimo global activo.', n));
  end if;

  select string_agg(e.desde || ' -> ' || e.hacia, ', ') into faltan
    from _esperados e
    where not exists (
      select 1 from public.ai_lessons l
      where l.kind = 'sinonimo' and l.scope = 'global'
        and lower(btrim(l.synonym_from)) = lower(btrim(e.desde))
        and lower(btrim(l.synonym_to)) = lower(btrim(e.hacia)));
  if faltan is not null then
    insert into _errores(msg) values (format('Caso 1b (siembra): faltan %s', faltan));
  end if;

  -- 2. Ningún par quedó duplicado tras aplicarla dos veces.
  select count(*) into duplicados from (
    select lower(btrim(synonym_from)), lower(btrim(synonym_to))
      from public.ai_lessons
      where kind = 'sinonimo' and scope = 'global'
      group by 1, 2 having count(*) > 1
  ) d;
  if duplicados > 0 then
    insert into _errores(msg) values (format('Caso 2 (idempotencia): %s par(es) global(es) duplicado(s) tras aplicar dos veces.', duplicados));
  end if;

  -- 3. `relación` va dos veces (corona y piñón), con dos filas distintas.
  select count(*) into n from public.ai_lessons
    where kind = 'sinonimo' and scope = 'global' and lower(btrim(synonym_from)) = 'relacion';
  if n is distinct from 2 then
    insert into _errores(msg) values (format('Caso 3 (relacion): %s fila(s), se esperaban 2 (corona y piñon).', n));
  end if;

  -- 4. Las filas sembradas no llevan autor ni conversación, y su content es
  --    legible ("Sinónimo: express → xpress").
  select count(*) into mal_formadas
    from public.ai_lessons l
    join _esperados e
      on lower(btrim(l.synonym_from)) = lower(btrim(e.desde))
     and lower(btrim(l.synonym_to)) = lower(btrim(e.hacia))
    where l.kind = 'sinonimo' and l.scope = 'global'
      and (l.conversation_id is not null
           or l.content <> 'Sinónimo: ' || l.synonym_from || ' → ' || l.synonym_to);
  if mal_formadas > 0 then
    insert into _errores(msg) values (format('Caso 4 (forma): %s fila(s) con conversation_id o content distinto de "Sinónimo: X → Y".', mal_formadas));
  end if;
end $$;

do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'sinonimos_de_seba.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'sinonimos_de_seba.sql: todas las aserciones pasaron.'
