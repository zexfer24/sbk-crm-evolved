-- ===========================================================================
-- Tarea T4a · plan "La escalada se hace una vez y la búsqueda responde"
-- (21/9/2026, Frente 4).
--
-- Migración bajo prueba: 20260921020000_agent_turns_reasoning_tokens.sql.
--
-- Cuatro casos: (1) la columna existe, es NOT NULL y su DEFAULT es `0` --
-- lee el catálogo real (information_schema), no confía en que la migración
-- haya corrido "a ojo"; (2) un insert que NO nombra la columna queda en 0
-- (el default cubre las filas viejas igual que si hubiera backfill, sin
-- reescribir la tabla); (3) un insert que SÍ la nombra persiste el valor
-- dado; (4) un update también la deja en el valor nuevo. No hace falta
-- probar RLS: `agent_turns_all` (20260819040000) ya cubre la tabla entera
-- con `is_agent()` para todo, y esta columna no le agrega ninguna regla
-- propia -- mismo motivo por el que intenciones_y_traspasos_completos.sql
-- tampoco la prueba para `agent_turns.intent`.
--
-- Mismo patrón que el resto: transacción con rollback, tabla temporal
-- `_errores`, un solo `raise exception` al final con todo lo acumulado.
--
-- Corre en el job `migraciones` de CI, junto a
-- intenciones_y_traspasos_completos.sql/escenario_cede_al_inventario.sql.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

insert into public.whatsapp_channels (id, label, phone_number) values
  ('99999999-9999-9999-9999-999999999900', 'Canal de prueba agent_turns_reasoning_tokens', '+580000005000');

insert into public.contacts (id, phone_number) values
  ('99999999-9999-9999-9999-999999999901', '+580000005001');

insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('99999999-9999-9999-9999-999999999902',
   '99999999-9999-9999-9999-999999999901',
   '99999999-9999-9999-9999-999999999900');

-- ---------------------------------------------------------------------------
-- Caso 1 · la columna existe, es NOT NULL y su DEFAULT es `0`.
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
    insert into _errores(msg) values ('Caso 1 (columna existe): public.agent_turns.reasoning_tokens no existe.');
  else
    select is_nullable, column_default into col_nullable, col_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'agent_turns'
        and column_name = 'reasoning_tokens';

    if col_nullable is distinct from 'NO' then
      insert into _errores(msg) values (format('Caso 1 (columna NOT NULL): is_nullable = %L, se esperaba ''NO''.', col_nullable));
    end if;

    if col_default is distinct from '0' then
      insert into _errores(msg) values (format('Caso 1 (DEFAULT 0): column_default = %L, se esperaba ''0''.', col_default));
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · un insert sin nombrar la columna queda en 0.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '99999999-9999-9999-9999-999999999902';
  v_id uuid;
  v_valor integer;
begin
  insert into public.agent_turns (conversation_id, action)
  values (conv_id, 'answered')
  returning id into v_id;

  select reasoning_tokens into v_valor from public.agent_turns where id = v_id;
  if v_valor is distinct from 0 then
    insert into _errores(msg) values (format('Caso 2 (insert sin nombrar la columna): reasoning_tokens = %s, se esperaba 0.', v_valor));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 2 (insert sin nombrar la columna): el insert falló y no debía -- %s', sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · un insert que SÍ nombra la columna persiste el valor dado.
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '99999999-9999-9999-9999-999999999902';
  v_id uuid;
  v_valor integer;
begin
  insert into public.agent_turns (conversation_id, action, reasoning_tokens)
  values (conv_id, 'answered', 12345)
  returning id into v_id;

  select reasoning_tokens into v_valor from public.agent_turns where id = v_id;
  if v_valor is distinct from 12345 then
    insert into _errores(msg) values (format('Caso 3 (insert con valor): reasoning_tokens = %s, se esperaba 12345.', v_valor));
  end if;
exception
  when others then
    insert into _errores(msg) values (format('Caso 3 (insert con valor): el insert falló y no debía -- %s', sqlerrm));
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · un update también deja el valor nuevo (mismo camino que T4b va a
-- usar al medir el razonamiento después de que termine el turno).
-- ---------------------------------------------------------------------------
do $$
declare
  conv_id uuid := '99999999-9999-9999-9999-999999999902';
  v_id uuid;
  v_valor integer;
  filas integer;
begin
  insert into public.agent_turns (conversation_id, action)
  values (conv_id, 'answered')
  returning id into v_id;

  update public.agent_turns set reasoning_tokens = 65800 where id = v_id;
  get diagnostics filas = row_count;
  if filas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 4 (UPDATE): afectó %s fila(s), se esperaba 1.', filas));
  end if;

  select reasoning_tokens into v_valor from public.agent_turns where id = v_id;
  if v_valor is distinct from 65800 then
    insert into _errores(msg) values (format('Caso 4 (UPDATE): reasoning_tokens = %s, se esperaba 65800.', v_valor));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Veredicto
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'agent_turns_reasoning_tokens.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'agent_turns_reasoning_tokens.sql: todas las aserciones pasaron.'
