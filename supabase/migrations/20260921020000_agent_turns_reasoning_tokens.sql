-- ============================================================================
-- Tarea T4a · plan "La escalada se hace una vez y la búsqueda responde"
-- (aprobado 21/9/2026, Frente 4).
--
-- Contexto: el 21/9/2026 dos turnos generaron ~65.800 tokens de SALIDA contra
-- un mensaje visible al cliente de apenas ~40 tokens (esas mismas espirales
-- son la medición que T1 de este plan usa para fijar `maxOutputTokens: 1500`
-- en `agent.ts`). La hipótesis es razonamiento interno del modelo que hoy NO
-- se mide en ningún lado: `AI_AGENT_REASONING=off` (ver CLAUDE.md, trampa de
-- `errorText`/OpenRouter, 8/9/2026) no manda ningún parámetro de razonamiento
-- al proveedor, deja el default de fábrica -- así que un modelo que razone
-- por su cuenta (como `gpt-5.6-luna`, el de producción) puede estar gastando
-- miles de tokens de "pensamiento" que `output_tokens` ya cuenta pero que
-- nadie separa del texto real. Esta columna es solo el hueco donde T4b (la
-- tarea siguiente del mismo plan, después de T2 y esta) va a escribir ese
-- número si el proveedor lo reporta aparte -- acá no se lee ni se escribe
-- nada todavía.
--
-- Estilo: mismas columnas vecinas de tokens en agent_turns
-- (20260820010000_agent_tokens_pricing.sql: input_tokens/output_tokens/
-- total_tokens, todas nullable sin default porque los turnos previos a esa
-- migración de verdad no se midieron) y `cached_input_tokens`
-- (20260822090000, también nullable sin default, mismo motivo). Esta
-- columna se aparta a propósito: nace `not null default 0` porque `0`
-- tokens de razonamiento medidos es un valor legítimo y distinguible --
-- "no razonó" -- mientras que `null` en las columnas vecinas significa "no
-- se sabe, la medición no existía". Sin backfill: el DEFAULT constante ya
-- cubre las filas existentes sin reescribir la tabla entera (a diferencia
-- de un `update` posterior, que sí la reescribiría fila por fila).
--
-- RLS: no cambia. `agent_turns_all` (20260819040000) ya cubre la tabla
-- entera con `is_agent()` para todo (select/insert/update/delete) -- una
-- columna nueva hereda esa misma política sin declarar nada más.
--
-- ESTA MIGRACIÓN TIENE QUE APLICARSE DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las migraciones previas
-- desde 20260916010000 (revisión "Seba sale sin pisar a nadie", 19/9/2026,
-- tarea T5, hallazgo 10): `set local lock_timeout` fuera de una transacción
-- es un NO-OP silencioso -- en autocommit cada sentencia corre en su propia
-- transacción implícita y el tope de acá abajo quedaría en 0 (sin tope)
-- para el `alter table ... add column` sobre `agent_turns`, tabla que
-- `logTurn` escribe en cada turno de la IA.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` -- mismo motivo y misma
-- verificación que las migraciones anteriores (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): sin `psql -1` esto corre con
-- `lock_timeout = 0` sin que `ON_ERROR_STOP` lo note (un warning, no un
-- error), así que falla cerrado acá. `PGOPTIONS="-c lock_timeout=5s"` sin
-- `-1` también pasa: hay un tope real, no es el no-op.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

alter table public.agent_turns
  add column reasoning_tokens integer not null default 0;

comment on column public.agent_turns.reasoning_tokens is 'Tokens de razonamiento interno del modelo, separados de output_tokens cuando el proveedor los reporta aparte. Nace en 0 (no null): el 21/9/2026 dos turnos gastaron ~65.800 tokens de salida contra un mensaje visible de ~40, y la hipótesis es razonamiento no medido -- AI_AGENT_REASONING=off no manda ningún parámetro, deja el default del proveedor. `0` es un valor medido ("no razonó" o el proveedor no lo separa); todavía no se escribe desde código (ver T4b, plan "La escalada se hace una vez y la búsqueda responde", 21/9/2026).';

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (information_schema), no el texto
-- de este archivo -- mismo criterio que las migraciones anteriores (ver
-- CLAUDE.md, "Cerrar una función security definer...": el mismo principio de
-- no confiar en el .sql aplica a cualquier verificación de esquema).
-- ---------------------------------------------------------------------------
do $$
declare
  col_exists boolean;
  col_nullable text;
  col_default text;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_turns'
      and column_name = 'reasoning_tokens'
  ) into col_exists;

  if not col_exists then
    raise exception '20260921020000: public.agent_turns.reasoning_tokens no quedó creada';
  end if;

  select is_nullable, column_default into col_nullable, col_default
    from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_turns'
      and column_name = 'reasoning_tokens';

  if col_nullable is distinct from 'NO' then
    raise exception '20260921020000: agent_turns.reasoning_tokens debía quedar NOT NULL, encontró is_nullable = %', col_nullable;
  end if;

  if col_default is distinct from '0' then
    raise exception '20260921020000: agent_turns.reasoning_tokens debía tener DEFAULT 0, encontró column_default = %', col_default;
  end if;

  raise notice '20260921020000: autoverificación de agent_turns.reasoning_tokens (columna not null, default 0) correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la columna nueva
-- da 400 hasta que alguien lo recargue a mano -- revisión "Seba sale sin
-- pisar a nadie" (19/9/2026, tarea T5, hallazgo M1).
notify pgrst, 'reload schema';
