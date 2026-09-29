-- ============================================================================
-- Tarea T6 · plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
-- esperando" (28/9/2026).
--
-- Contexto: cuando Seba no encuentra un repuesto o cotiza el equivocado, hoy
-- solo se ve el `summary` del turno; nadie puede saber QUÉ se buscó, con qué
-- conjuntos de términos, si el corrector de tipeos (T2) intervino ni cómo
-- terminó cada búsqueda. `buildCatalogTool` ya acumula ese rastro en
-- `CatalogOutcome.consultas` (T3a); esta columna lo guarda con el turno.
--
-- `agent_turns.catalog_queries jsonb`, NULLABLE y sin default: `null` =
-- "el turno no tocó el catálogo" (o es anterior a esta migración; lo viejo no
-- se puede reconstruir). Se escribe un arreglo, uno por búsqueda, con
-- `{query, productos, moto, cilindrada, grupos, opcionales, corregido,
-- resultado}`; un turno sin búsquedas escribe `null`, no `[]`, para que la
-- columna solo pese donde hay algo que decir. Sin índice: se lee por turno
-- (Control IA / consulta a mano), nunca se filtra por contenido.
--
-- RLS/grants: no cambian. `agent_turns` ya tiene sus políticas (20260819040000)
-- y la escribe `service_role`; una columna nueva hereda ambos.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que 20260928030000: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. `add column`
-- nullable sin default no reescribe la tabla, pero pide el lock exclusivo un
-- instante sobre `agent_turns`, donde el turno inserta al terminar.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

alter table public.agent_turns
  add column if not exists catalog_queries jsonb;

comment on column public.agent_turns.catalog_queries is
  'Rastro de las búsquedas al catálogo del turno (T6, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", 28/9/2026): arreglo de {query, productos, moto, cilindrada, grupos, opcionales, corregido, resultado}, una entrada por llamada a buscar_productos. null = el turno no tocó el catálogo o es anterior a la migración.';

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real (information_schema).
-- ---------------------------------------------------------------------------
do $$
declare
  col_type text;
  col_nullable text;
begin
  select data_type, is_nullable into col_type, col_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_turns'
      and column_name = 'catalog_queries';

  if col_type is null then
    raise exception '20260928040000: public.agent_turns.catalog_queries no quedó creada';
  end if;

  if col_type is distinct from 'jsonb' then
    raise exception '20260928040000: agent_turns.catalog_queries debía ser jsonb, encontró %', col_type;
  end if;

  if col_nullable is distinct from 'YES' then
    raise exception '20260928040000: agent_turns.catalog_queries debía ser nullable, encontró is_nullable = %', col_nullable;
  end if;

  raise notice '20260928040000: autoverificación de agent_turns.catalog_queries (jsonb, nullable) correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la columna nueva
-- da 400 hasta que alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
