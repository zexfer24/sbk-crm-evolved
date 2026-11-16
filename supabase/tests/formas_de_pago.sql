-- ===========================================================================
-- `payment_methods`: el asesor lee, solo el supervisor/admin escribe (T1, plan
-- "Entrega 2 de Seba v2: los datos del negocio", 16/11/2026, migración
-- 20261116020000)
--
-- Qué fija: las formas de pago de contado (pago móvil, transferencia, Binance…)
-- y su texto de instrucciones son configuración del negocio. Cualquier asesor
-- las LEE (el chat las muestra y Seba las entrega) pero solo un supervisor o
-- admin las cambia, y EN RLS, no solo en la interfaz.
--
-- Bajo RLS, un UPDATE/DELETE que la política no deja pasar NO falla: afecta 0
-- filas y PostgREST responde 200/204 (mismo criterio que
-- config_solo_supervisor.sql; es la razón de `assertRowsAffected` en
-- `mutations.ts`). Solo el INSERT lanza 42501. Por eso el asesor se mide con
-- "0 filas y estado intacto visto como postgres", no con un error.
--
-- Casos:
--   a. RLS activa y las cuatro políticas existen con sus nombres.
--   b. `anon` no tiene SELECT ni INSERT.
--   c. Preparación como postgres: tres usuarios (asesor, supervisor, caja) y
--      dos filas propias (`prueba_uno`, `prueba_dos`). El test NO supone la
--      tabla vacía: `supabase/seed.sql` también corre en el CI y carga las
--      formas de pago de desarrollo.
--   d. Asesor: lee las dos filas; INSERT -> 42501; UPDATE y DELETE -> 0 filas
--      y la fila sigue igual.
--   e. Supervisor: INSERT, UPDATE (con `updated_at` que avanza) y DELETE.
--   f. Caja: no lee ninguna fila (no es `is_agent()`).
--   g. CHECK: clave mal formada o `cashea`, moneda fuera de VES/USD,
--      instrucciones de más de 1500 caracteres y etiqueta vacía -> 23514, con
--      el nombre del CHECK en el mensaje (así un CHECK roto no lo tapa otro).
--
-- Corre como `authenticated` con claims de un agente real: como `postgres` se
-- salta la RLS y no mediría nada. Termina en `rollback`.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- Ejecuta una sentencia con los privilegios del rol que la llame (security
-- invoker) y devuelve "filas=N" o "error <sqlstate>: <mensaje>".
create or replace function pg_temp.probar(q text) returns text
language plpgsql as $$
declare
  n integer;
begin
  execute q;
  get diagnostics n = row_count;
  return 'filas=' || n;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

-- Anota en _errores si el resultado de `q` no calza con el patrón esperado.
create or replace function pg_temp.esperar(etiqueta text, q text, patron text) returns void
language plpgsql as $$
declare
  r text;
begin
  r := pg_temp.probar(q);
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso a · RLS activa y las cuatro políticas (sin la tabla, falla acá)
-- ---------------------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.payment_methods'::regclass) then
    insert into _errores(msg) values ('a: payment_methods no tiene RLS activa.');
  end if;
  if (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'payment_methods'
      and policyname in ('payment_methods_select', 'payment_methods_insert',
                         'payment_methods_update', 'payment_methods_delete')
  ) <> 4 then
    insert into _errores(msg) values ('a: faltan políticas con los nombres payment_methods_select/insert/update/delete.');
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'payment_methods') <> 4 then
    insert into _errores(msg) values ('a: payment_methods debía tener exactamente cuatro políticas.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso b · anon no toca la tabla
-- ---------------------------------------------------------------------------
do $$
begin
  if has_table_privilege('anon', 'public.payment_methods', 'select') then
    insert into _errores(msg) values ('b: anon tiene SELECT sobre payment_methods.');
  end if;
  if has_table_privilege('anon', 'public.payment_methods', 'insert') then
    insert into _errores(msg) values ('b: anon tiene INSERT sobre payment_methods.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso c · preparación como postgres (sin RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('e1e1f0a0-0000-0000-0000-0000000000a1', 'asesor-pagos@sbk.test', jsonb_build_object('display_name', 'Asesor pagos'), '{}'::jsonb),
  ('e1e1f0a0-0000-0000-0000-0000000000a2', 'super-pagos@sbk.test',  jsonb_build_object('display_name', 'Supervisor pagos'), '{"role":"supervisor"}'::jsonb),
  ('e1e1f0a0-0000-0000-0000-0000000000c1', 'caja-pagos@sbk.test',   jsonb_build_object('display_name', 'Caja pagos'), '{"role":"caja"}'::jsonb);

insert into public.payment_methods (key, label, currency, instructions, seba_entrega, sort_order) values
  ('prueba_uno', 'Prueba uno', 'VES', 'Instrucciones de prueba uno', true,  901),
  ('prueba_dos', 'Prueba dos', 'USD', 'Instrucciones de prueba dos', false, 902);

-- El trigger de `updated_at` pisaría el valor viejo que se fija a mano: se
-- apaga mientras se prepara la fila y se vuelve a encender. Dentro de una
-- transacción `now()` no avanza, así que sin esta diferencia forzada el caso e
-- no podría distinguir "el trigger corrió" de "no corrió".
alter table public.payment_methods disable trigger set_payment_methods_updated_at;
update public.payment_methods set updated_at = now() - interval '1 day' where key = 'prueba_uno';
alter table public.payment_methods enable trigger set_payment_methods_updated_at;

create temporary table _antes (updated_at timestamptz) on commit drop;
insert into _antes select updated_at from public.payment_methods where key = 'prueba_uno';

-- ---------------------------------------------------------------------------
-- Caso d · asesor: lee, no escribe
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e1e1f0a0-0000-0000-0000-0000000000a1';

select pg_temp.esperar('d: asesor lee las dos filas',
  $q$select 1 from public.payment_methods where key in ('prueba_uno', 'prueba_dos')$q$,
  '^filas=2$');
select pg_temp.esperar('d: asesor INSERT',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('prueba_asesor', 'X', 'VES', 'X')$q$,
  '^error 42501');
select pg_temp.esperar('d: asesor UPDATE de label',
  $q$update public.payment_methods set label = 'Editado por asesor' where key = 'prueba_uno'$q$,
  '^filas=0$');
select pg_temp.esperar('d: asesor DELETE',
  $q$delete from public.payment_methods where key = 'prueba_uno'$q$,
  '^filas=0$');

reset role;

-- Visto como postgres: nada de lo que intentó el asesor dejó rastro.
do $$
begin
  if (select label from public.payment_methods where key = 'prueba_uno') is distinct from 'Prueba uno' then
    insert into _errores(msg) values ('d: el asesor logró cambiar el label de prueba_uno.');
  end if;
  if not exists (select 1 from public.payment_methods where key = 'prueba_uno') then
    insert into _errores(msg) values ('d: el asesor logró borrar prueba_uno.');
  end if;
  if exists (select 1 from public.payment_methods where key = 'prueba_asesor') then
    insert into _errores(msg) values ('d: el asesor logró insertar prueba_asesor.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso e · supervisor: escribe
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e1e1f0a0-0000-0000-0000-0000000000a2';

select pg_temp.esperar('e: supervisor INSERT',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('prueba_tres', 'Prueba tres', 'VES', 'Instrucciones tres')$q$,
  '^filas=1$');
select pg_temp.esperar('e: supervisor UPDATE',
  $q$update public.payment_methods set label = 'Editado por supervisor' where key = 'prueba_uno'$q$,
  '^filas=1$');
select pg_temp.esperar('e: supervisor DELETE',
  $q$delete from public.payment_methods where key = 'prueba_tres'$q$,
  '^filas=1$');

reset role;

do $$
begin
  if (select label from public.payment_methods where key = 'prueba_uno') is distinct from 'Editado por supervisor' then
    insert into _errores(msg) values ('e: el UPDATE del supervisor no quedó guardado.');
  end if;
  if not ((select updated_at from public.payment_methods where key = 'prueba_uno') > (select updated_at from _antes)) then
    insert into _errores(msg) values ('e: updated_at no avanzó tras el UPDATE (¿falta el trigger set_payment_methods_updated_at?).');
  end if;
  if exists (select 1 from public.payment_methods where key = 'prueba_tres') then
    insert into _errores(msg) values ('e: el DELETE del supervisor no borró prueba_tres.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso f · caja: no lee nada (no es is_agent())
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e1e1f0a0-0000-0000-0000-0000000000c1';

select pg_temp.esperar('f: caja no lee ninguna fila',
  $q$select 1 from public.payment_methods$q$,
  '^filas=0$');

reset role;

-- ---------------------------------------------------------------------------
-- Caso g · los CHECK (como postgres: miden la tabla, no la RLS)
-- ---------------------------------------------------------------------------
select pg_temp.esperar('g: clave con mayúsculas',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('PagoMovil', 'X', 'VES', 'X')$q$,
  '^error 23514: .*payment_methods_key_format');
select pg_temp.esperar('g: clave demasiado corta',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('ab', 'X', 'VES', 'X')$q$,
  '^error 23514: .*payment_methods_key_format');
select pg_temp.esperar('g: clave con guion',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('pago-movil', 'X', 'VES', 'X')$q$,
  '^error 23514: .*payment_methods_key_format');
select pg_temp.esperar('g: clave cashea',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('cashea', 'X', 'VES', 'X')$q$,
  '^error 23514: .*payment_methods_key_no_cashea');
select pg_temp.esperar('g: moneda EUR',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('prueba_eur', 'X', 'EUR', 'X')$q$,
  '^error 23514: .*payment_methods_currency_check');
select pg_temp.esperar('g: instrucciones de 1501 caracteres',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('prueba_larga', 'X', 'VES', repeat('x', 1501))$q$,
  '^error 23514: .*payment_methods_instructions_length');
select pg_temp.esperar('g: instrucciones de 1500 caracteres (el tope exacto entra)',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('prueba_tope', 'X', 'VES', repeat('x', 1500))$q$,
  '^filas=1$');
select pg_temp.esperar('g: etiqueta vacía',
  $q$insert into public.payment_methods (key, label, currency, instructions) values ('prueba_vacia', '', 'VES', 'X')$q$,
  '^error 23514: .*payment_methods_label_length');

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
    raise exception E'formas_de_pago roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'formas_de_pago: todas las aserciones pasaron.'
