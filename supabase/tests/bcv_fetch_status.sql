-- ============================================================================
-- Estado de la lectura de la tasa BCV (migración 20261121010000_bcv_fetch_status,
-- 21/11/2026).
--
-- Qué prueba:
--   1. Tras la migración hay exactamente una fila.
--   2. Como service_role, `bcv_registrar_intento`: un fallo da (1, previo 0);
--      otro fallo con otro texto da (2, previo 1, previo_error = el primero);
--      un éxito da (0, previo 2), mueve last_success_at y conserva last_error.
--      Un fallo sin texto guarda 'sin detalle'; un texto largo se recorta a 1000.
--   3. EXECUTE: anon y authenticated NO; service_role SÍ.
--   4. Como authenticated (agente): el select ve 1 fila; un update directo da
--      42501 (la tabla no le da `update`, el permiso falla antes que la RLS).
--   5. Como anon: el select da 42501.
--   6. Una segunda fila con id = false viola el check.
--
-- Usa los usuarios del seed (maria = asesora). Transacción con rollback, tabla
-- temporal `_errores`, un solo `raise exception` al final (mismo estilo que
-- metas_venta.sql). Correr con:
--   docker exec -i <contenedor-db> psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/bcv_fetch_status.sql
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, anon, service_role;

-- Punto de partida controlado: la fila única con contador 0 (el backfill de la
-- migración la deja con lo que hubiera en exchange_rates).
update public.bcv_fetch_status
   set consecutive_failures = 0, last_error = null, last_success_at = null, last_failure_at = null;

-- ---------------------------------------------------------------------------
-- Caso 1 · exactamente una fila.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from public.bcv_fetch_status;
  if n <> 1 then
    insert into _errores(msg) values (format('Caso 1: hay %s filas en bcv_fetch_status, se esperaba 1.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · la RPC como service_role.
-- ---------------------------------------------------------------------------
set local role service_role;

do $$
declare
  r record;
  s record;
begin
  -- 2a: primer fallo.
  select * into r from public.bcv_registrar_intento(false, 'error uno');
  if r.consecutive_failures is distinct from 1 or r.previous_failures is distinct from 0 or r.previous_error is not null then
    insert into _errores(msg) values (format('Caso 2a: primer fallo dio (%s, %s, %s), se esperaba (1, 0, null).',
      r.consecutive_failures, r.previous_failures, r.previous_error));
  end if;

  -- 2b: segundo fallo con otro texto.
  select * into r from public.bcv_registrar_intento(false, 'error dos');
  if r.consecutive_failures is distinct from 2 or r.previous_failures is distinct from 1 or r.previous_error is distinct from 'error uno' then
    insert into _errores(msg) values (format('Caso 2b: segundo fallo dio (%s, %s, %s), se esperaba (2, 1, error uno).',
      r.consecutive_failures, r.previous_failures, r.previous_error));
  end if;

  select * into s from public.bcv_fetch_status;
  if s.last_error is distinct from 'error dos' or s.last_failure_at is null or s.last_attempt_at is null then
    insert into _errores(msg) values ('Caso 2b: la fila no guardó el último error / last_failure_at / last_attempt_at.');
  end if;

  -- 2c: éxito.
  select * into r from public.bcv_registrar_intento(true);
  if r.consecutive_failures is distinct from 0 or r.previous_failures is distinct from 2 or r.previous_error is distinct from 'error dos' then
    insert into _errores(msg) values (format('Caso 2c: el éxito dio (%s, %s, %s), se esperaba (0, 2, error dos).',
      r.consecutive_failures, r.previous_failures, r.previous_error));
  end if;

  select * into s from public.bcv_fetch_status;
  if s.consecutive_failures <> 0 then
    insert into _errores(msg) values ('Caso 2c: el contador no volvió a 0.');
  end if;
  if s.last_success_at is null or s.last_success_at < now() - interval '1 minute' then
    insert into _errores(msg) values ('Caso 2c: last_success_at no es reciente.');
  end if;
  if s.last_error is distinct from 'error dos' then
    insert into _errores(msg) values ('Caso 2c: el éxito no conservó last_error como histórico.');
  end if;

  -- 2d: fallo sin texto y texto largo.
  perform public.bcv_registrar_intento(false);
  select * into s from public.bcv_fetch_status;
  if s.last_error is distinct from 'sin detalle' or s.consecutive_failures <> 1 then
    insert into _errores(msg) values (format('Caso 2d: fallo sin texto dejó (%s, %s), se esperaba (sin detalle, 1).',
      s.last_error, s.consecutive_failures));
  end if;

  perform public.bcv_registrar_intento(false, repeat('x', 5000));
  select * into s from public.bcv_fetch_status;
  if length(s.last_error) is distinct from 1000 then
    insert into _errores(msg) values (format('Caso 2d: el error largo quedó de %s caracteres, se esperaba 1000.', length(s.last_error)));
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso 2: la RPC falló como service_role: %s', sqlerrm));
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Caso 3 · EXECUTE: anon y authenticated no; service_role sí.
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.bcv_registrar_intento(boolean,text)', 'execute') then
    insert into _errores(msg) values ('Caso 3: anon puede ejecutar bcv_registrar_intento.');
  end if;
  if has_function_privilege('authenticated', 'public.bcv_registrar_intento(boolean,text)', 'execute') then
    insert into _errores(msg) values ('Caso 3: authenticated puede ejecutar bcv_registrar_intento.');
  end if;
  if not has_function_privilege('service_role', 'public.bcv_registrar_intento(boolean,text)', 'execute') then
    insert into _errores(msg) values ('Caso 3: service_role NO puede ejecutar bcv_registrar_intento.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · authenticated (asesora): lee 1 fila; el update directo da 42501.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

do $$
declare
  n int;
begin
  select count(*) into n from public.bcv_fetch_status;
  if n <> 1 then
    insert into _errores(msg) values (format('Caso 4a: la asesora ve %s filas, se esperaba 1.', n));
  end if;

  begin
    update public.bcv_fetch_status set consecutive_failures = 99;
    insert into _errores(msg) values ('Caso 4b: la asesora pudo hacer update directo.');
  exception when insufficient_privilege then
    null; -- 42501: la tabla no le da update, como debe.
  end;

  begin
    insert into public.bcv_fetch_status (id) values (false);
    insert into _errores(msg) values ('Caso 4c: la asesora pudo insertar.');
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.bcv_registrar_intento(true);
    insert into _errores(msg) values ('Caso 4d: la asesora pudo llamar a la RPC.');
  exception when insufficient_privilege then
    null;
  end;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 5 · anon: el select da 42501.
-- ---------------------------------------------------------------------------
set local role anon;

do $$
declare
  n int;
begin
  begin
    select count(*) into n from public.bcv_fetch_status;
    insert into _errores(msg) values (format('Caso 5: anon pudo leer la tabla (%s filas).', n));
  exception when insufficient_privilege then
    null;
  end;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Caso 6 · una segunda fila (id = false) viola el check.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.bcv_fetch_status (id) values (false);
    insert into _errores(msg) values ('Caso 6: se aceptó una segunda fila con id = false.');
  exception when check_violation then
    null;
  end;
end $$;

do $$
declare
  detalle text;
begin
  select string_agg(msg, E'\n') into detalle from _errores;
  if detalle is not null then
    raise exception E'bcv_fetch_status.sql: fallaron casos:\n%', detalle;
  end if;
  raise notice 'bcv_fetch_status.sql: todos los casos en verde.';
end $$;

rollback;
