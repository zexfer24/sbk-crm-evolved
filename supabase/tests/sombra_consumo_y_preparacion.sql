-- ===========================================================================
-- Pestaña «Sombra»: consumo de la sombra y preparación para desplegar (P1,
-- 17/11/2026, migración 20261117020000_sombra_consumo_y_preparacion.sql)
--
-- Qué fija de `public.sombra_resumen(p_desde, p_hasta)`:
--   * Solo supervisor/admin: un asesor y la caja reciben 42501; `anon` no puede
--     ejecutarla ni por privilegio ni llamándola; un rango vacío da 22023.
--   * El costo de un día es EXACTO y usa la cuenta de shadow_spend_today():
--     tokens × tarifa por millón de `model_pricing` (1.000.000 de entrada a 2 +
--     500.000 de salida a 10 = 7,00).
--   * Un borrador con un modelo sin tarifa suma tokens pero no costo y cuenta
--     en `sin_tarifa`; un día con solo borradores sin tarifa da `costo_usd`
--     null (no 0).
--   * Los días son de CARACAS: un borrador a las 03:30 UTC cae en el día
--     anterior de Caracas.
--   * Los tres ejes (búsqueda, conversación, pago) con su población, revisados,
--     reprobados y cambios menores: un «no» por `precio` reprueba `pago` y NO
--     `busqueda` aunque el borrador también buscó; un «no» sin tipo de error
--     cuenta como `otro` (conversación).
--   * `herramientas` que no es un arreglo no rompe el agregado.
--   * El rango es [desde, hasta) y el período se acota a 90 días.
--   * Las señales automáticas.
--
-- Las fechas están en marzo de 2026 a propósito: lejos de cualquier dato real
-- de la base local. Corre como `authenticated` con claims de un agente real
-- donde importa el rol (como postgres se saltaría la comprobación). Termina en
-- `rollback`.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to anon, authenticated, service_role;

create temporary table _res (k text primary key, v jsonb) on commit drop;
grant insert, select on _res to authenticated;

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
-- Preparación como postgres (sin RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('5c5c0000-0000-0000-0000-0000000000a1', 'asesor-resumen@sbk.test', jsonb_build_object('display_name', 'Asesor resumen'), '{}'::jsonb),
  ('5c5c0000-0000-0000-0000-0000000000a2', 'super-resumen@sbk.test',  jsonb_build_object('display_name', 'Supervisor resumen'), '{"role":"supervisor"}'::jsonb),
  ('5c5c0000-0000-0000-0000-0000000000c1', 'caja-resumen@sbk.test',   jsonb_build_object('display_name', 'Caja resumen'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('5c5c0000-1000-0000-0000-000000000001', 'Canal resumen', '+580000009600');
insert into public.contacts (id, phone_number) values
  ('5c5c0000-2000-0000-0000-000000000001', '+580000009601');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('5c5c0000-3000-0000-0000-000000000001', '5c5c0000-2000-0000-0000-000000000001', '5c5c0000-1000-0000-0000-000000000001');

-- Precios redondos para que la cuenta sea exacta. `prueba/sin-tarifa` NO tiene fila.
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('prueba/modelo-sombra', 2, 10);

-- Borradores. Caracas es UTC-4 (sin horario de verano).
--   d1  15/3 12:00  busca            1.000.000 de entrada + 500.000 de salida  -> 7,00
--   d2  15/3 13:00  busca + paga     0 tokens, con guarda y pasaría a un asesor
--   d3  14/3 23:30 (= 15/3 03:30 UTC) sin tarifa, sin mensajes
--   d4  13/3        sin tarifa, herramientas = texto suelto (no arreglo)
--   d5  12/3        herramientas = objeto (no arreglo), 500.000 de entrada     -> 1,00
--   d6  16/3        paga             1.000.000 de entrada                      -> 2,00
--   d9  11/3        sin revisar su tipo de error (un «no» sin tipo)
--   d8  9/3 23:59   antes del período normal (entra solo al ampliar el rango)
--   d7  20/3 00:00  justo en el `hasta` (el rango es [desde, hasta): no entra)
--   d10 1/12/2025   más viejo que 90 días antes del `hasta`
insert into public.agent_shadow_drafts
  (id, conversation_id, modo, rafaga, mensajes, herramientas, escalaria, guardas, contexto, model,
   input_tokens, output_tokens, cached_input_tokens, created_at) values
  ('5c5c0000-5000-0000-0000-000000000001', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '["buscarRepuesto"]', false, '[]', '{}',
   'prueba/modelo-sombra', 1000000, 500000, 100, '2026-03-15 12:00:00-04'),
  ('5c5c0000-5000-0000-0000-000000000002', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '["buscarRepuesto","prepararPago"]', true,
   '[{"guarda":"identidad","fragmento":"x"}]', '{}',
   'prueba/modelo-sombra', 0, 0, 0, '2026-03-15 13:00:00-04'),
  ('5c5c0000-5000-0000-0000-000000000003', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[]', '[]', false, '[]', '{}',
   'prueba/sin-tarifa', 2000, 1000, 0, '2026-03-15 03:30:00+00'),
  ('5c5c0000-5000-0000-0000-000000000004', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '"buscarRepuesto"', false, '[]', '{}',
   'prueba/sin-tarifa', 100, 50, 0, '2026-03-13 12:00:00-04'),
  ('5c5c0000-5000-0000-0000-000000000005', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '{"buscarRepuesto": true}', false, '[]', '{}',
   'prueba/modelo-sombra', 500000, 0, 0, '2026-03-12 12:00:00-04'),
  ('5c5c0000-5000-0000-0000-000000000006', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '["prepararPago"]', false, '[]', '{}',
   'prueba/modelo-sombra', 1000000, 0, 0, '2026-03-16 12:00:00-04'),
  ('5c5c0000-5000-0000-0000-000000000009', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '[]', false, '[]', '{}',
   'prueba/modelo-sombra', 0, 0, 0, '2026-03-11 12:00:00-04'),
  ('5c5c0000-5000-0000-0000-000000000008', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '[]', false, '[]', '{}',
   'prueba/modelo-sombra', 0, 0, 0, '2026-03-09 23:59:00-04'),
  ('5c5c0000-5000-0000-0000-000000000007', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '[]', false, '[]', '{}',
   'prueba/modelo-sombra', 0, 0, 0, '2026-03-20 00:00:00-04'),
  ('5c5c0000-5000-0000-0000-000000000010', '5c5c0000-3000-0000-0000-000000000001', 'sombra', '["a"]',
   '[{"orden":1,"tipo":"texto","texto":"x","origen":"modelo"}]', '[]', false, '[]', '{}',
   'prueba/modelo-sombra', 0, 0, 0, '2025-12-01 12:00:00-04');

-- Revisiones (error_tipo null en d9: un «no» sin tipo debe contar como «otro»).
insert into public.shadow_reviews (draft_id, veredicto, error_tipo, correccion, reviewed_by) values
  ('5c5c0000-5000-0000-0000-000000000001', 'no',           'producto_equivocado', 'x', '5c5c0000-0000-0000-0000-0000000000a2'),
  ('5c5c0000-5000-0000-0000-000000000002', 'no',           'precio',              'x', '5c5c0000-0000-0000-0000-0000000000a2'),
  ('5c5c0000-5000-0000-0000-000000000006', 'cambio_menor', 'forma_de_pago',       'x', '5c5c0000-0000-0000-0000-0000000000a2'),
  ('5c5c0000-5000-0000-0000-000000000003', 'no',           'tono',                'x', '5c5c0000-0000-0000-0000-0000000000a2'),
  ('5c5c0000-5000-0000-0000-000000000005', 'cambio_menor', 'otro',                'x', '5c5c0000-0000-0000-0000-0000000000a2'),
  ('5c5c0000-5000-0000-0000-000000000009', 'no',           null,                  'x', '5c5c0000-0000-0000-0000-0000000000a2');

-- ---------------------------------------------------------------------------
-- Caso a · quién la puede ejecutar
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.sombra_resumen(timestamptz, timestamptz)', 'execute') then
    insert into _errores(msg) values ('a: anon tiene EXECUTE sobre sombra_resumen.');
  end if;
  if not has_function_privilege('authenticated', 'public.sombra_resumen(timestamptz, timestamptz)', 'execute') then
    insert into _errores(msg) values ('a: authenticated no tiene EXECUTE sobre sombra_resumen (la llama el navegador).');
  end if;
  if not has_function_privilege('service_role', 'public.sombra_resumen(timestamptz, timestamptz)', 'execute') then
    insert into _errores(msg) values ('a: service_role no tiene EXECUTE sobre sombra_resumen.');
  end if;
end $$;

set local role anon;
select pg_temp.esperar('a: anon llamándola',
  $q$select public.sombra_resumen('2026-03-10 00:00:00-04', '2026-03-20 00:00:00-04')$q$,
  '^error 42501');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '5c5c0000-0000-0000-0000-0000000000a1';
select pg_temp.esperar('a: un asesor corriente recibe 42501',
  $q$select public.sombra_resumen('2026-03-10 00:00:00-04', '2026-03-20 00:00:00-04')$q$,
  '^error 42501');

set local "request.jwt.claim.sub" = '5c5c0000-0000-0000-0000-0000000000c1';
select pg_temp.esperar('a: la caja recibe 42501',
  $q$select public.sombra_resumen('2026-03-10 00:00:00-04', '2026-03-20 00:00:00-04')$q$,
  '^error 42501');

set local "request.jwt.claim.sub" = '5c5c0000-0000-0000-0000-0000000000a2';
select pg_temp.esperar('a: un rango vacío da 22023',
  $q$select public.sombra_resumen('2026-03-20 00:00:00-04', '2026-03-10 00:00:00-04')$q$,
  '^error 22023');
select pg_temp.esperar('a: un rango con null da 22023',
  $q$select public.sombra_resumen(null, '2026-03-10 00:00:00-04')$q$,
  '^error 22023');

-- El supervisor recibe el jsonb: período normal y período ampliado (corte de 90 días).
insert into _res select 'normal', public.sombra_resumen('2026-03-10 00:00:00-04', '2026-03-20 00:00:00-04');
insert into _res select 'ancho',  public.sombra_resumen('2025-01-01 00:00:00-04', '2026-03-20 00:00:00-04');
reset role;

-- ---------------------------------------------------------------------------
-- Caso b · consumo
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb := (select r.v from _res r where r.k = 'normal');
  dias jsonb;
begin
  if v is null then
    insert into _errores(msg) values ('b: el supervisor no recibió el jsonb.');
    return;
  end if;
  dias := v #> '{consumo,dias}';

  if jsonb_array_length(dias) <> 6 then
    insert into _errores(msg) values (format('b: se esperaban 6 días y salieron %s.', jsonb_array_length(dias)));
  end if;
  -- Del más reciente al más viejo, y por día de CARACAS: d3 (03:30 UTC del 15) cae el 14.
  if (select array_agg(e ->> 'dia' order by ord) from jsonb_array_elements(dias) with ordinality as t(e, ord))
       is distinct from array['2026-03-16', '2026-03-15', '2026-03-14', '2026-03-13', '2026-03-12', '2026-03-11'] then
    insert into _errores(msg) values (format('b: los días salieron %s.', (select array_agg(e ->> 'dia') from jsonb_array_elements(dias) e)));
  end if;

  -- 16/3: d6, 1.000.000 de entrada a 2 = 2,00.
  if (dias -> 0 ->> 'costo_usd')::numeric is distinct from 2 or (dias -> 0 ->> 'borradores')::int <> 1 then
    insert into _errores(msg) values (format('b: el 16/3 debía costar 2 con 1 borrador: %s.', dias -> 0));
  end if;
  -- 15/3: d1 (7,00 exactos) + d2 (0).
  if (dias -> 1 ->> 'costo_usd')::numeric is distinct from 7 then
    insert into _errores(msg) values (format('b: el 15/3 debía costar exactamente 7: %s.', dias -> 1 ->> 'costo_usd'));
  end if;
  if (dias -> 1 ->> 'borradores')::int <> 2
     or (dias -> 1 ->> 'input_tokens')::bigint <> 1000000
     or (dias -> 1 ->> 'output_tokens')::bigint <> 500000
     or (dias -> 1 ->> 'cached_input_tokens')::bigint <> 100 then
    insert into _errores(msg) values (format('b: tokens o borradores del 15/3 incorrectos: %s.', dias -> 1));
  end if;
  -- 14/3 y 13/3: solo borradores sin tarifa -> costo null (no 0), pero con sus tokens.
  if jsonb_typeof(dias -> 2 -> 'costo_usd') <> 'null' then
    insert into _errores(msg) values (format('b: el 14/3 (sin tarifa) debía dar costo null y dio %s.', dias -> 2 -> 'costo_usd'));
  end if;
  if jsonb_typeof(dias -> 3 -> 'costo_usd') <> 'null' then
    insert into _errores(msg) values (format('b: el 13/3 (sin tarifa) debía dar costo null y dio %s.', dias -> 3 -> 'costo_usd'));
  end if;
  if (dias -> 2 ->> 'input_tokens')::bigint <> 2000 or (dias -> 2 ->> 'output_tokens')::bigint <> 1000 then
    insert into _errores(msg) values (format('b: un borrador sin tarifa debía sumar sus tokens: %s.', dias -> 2));
  end if;
  -- 12/3: 500.000 de entrada a 2 = 1,00. 11/3: con tarifa y 0 tokens = 0 (no null).
  if (dias -> 4 ->> 'costo_usd')::numeric is distinct from 1 then
    insert into _errores(msg) values (format('b: el 12/3 debía costar 1: %s.', dias -> 4 ->> 'costo_usd'));
  end if;
  if (dias -> 5 ->> 'costo_usd')::numeric is distinct from 0 then
    insert into _errores(msg) values (format('b: el 11/3 (con tarifa y 0 tokens) debía costar 0, no null: %s.', dias -> 5 ->> 'costo_usd'));
  end if;

  -- Total del período.
  if (v #>> '{consumo,total,borradores}')::int <> 7 then
    insert into _errores(msg) values (format('b: total.borradores debía ser 7 y fue %s.', v #>> '{consumo,total,borradores}'));
  end if;
  if (v #>> '{consumo,total,input_tokens}')::bigint <> 2502100 or (v #>> '{consumo,total,output_tokens}')::bigint <> 501050 then
    insert into _errores(msg) values (format('b: tokens totales incorrectos: %s.', v #> '{consumo,total}'));
  end if;
  if (v #>> '{consumo,total,costo_usd}')::numeric is distinct from 10 then
    insert into _errores(msg) values (format('b: total.costo_usd debía ser 10 (2 + 7 + 1; lo sin tarifa no suma): %s.', v #>> '{consumo,total,costo_usd}'));
  end if;
  if (v #>> '{consumo,total,sin_tarifa}')::int <> 2 then
    insert into _errores(msg) values (format('b: total.sin_tarifa debía ser 2 y fue %s.', v #>> '{consumo,total,sin_tarifa}'));
  end if;

  -- Gasto de hoy, tope y muestreo vienen en el jsonb (los dos últimos de agent_settings).
  if not (v #> '{consumo}' ? 'hoy_usd' and v #> '{consumo}' ? 'tope_usd' and v #> '{consumo}' ? 'muestreo_pct') then
    insert into _errores(msg) values ('b: faltan hoy_usd, tope_usd o muestreo_pct en consumo.');
  elsif jsonb_typeof(v #> '{consumo,hoy_usd}') <> 'number' then
    insert into _errores(msg) values ('b: hoy_usd debía ser un número.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso c · preparación: los tres ejes
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb := (select r.v from _res r where r.k = 'normal');
  eje jsonb;
begin
  if jsonb_array_length(v #> '{preparacion,ejes}') <> 3 then
    insert into _errores(msg) values ('c: debían salir tres ejes.');
    return;
  end if;

  -- Búsqueda: d1 y d2 la usaron (d4 trae «buscarRepuesto» como texto suelto y d5
  -- como objeto: no son arreglos y no cuentan, ni rompen nada). Solo d1 es un
  -- «no» por producto_equivocado; el «no» por precio de d2 NO reprueba la búsqueda.
  select e into eje from jsonb_array_elements(v #> '{preparacion,ejes}') e where e ->> 'eje' = 'busqueda';
  if (eje ->> 'poblacion')::int <> 2 or (eje ->> 'revisados')::int <> 2
     or (eje ->> 'reprobados')::int <> 1 or (eje ->> 'cambios_menores')::int <> 0 then
    insert into _errores(msg) values (format('c: eje búsqueda incorrecto: %s.', eje));
  end if;

  -- Pago: d2 y d6. d2 es un «no» por precio (reprueba), d6 un cambio menor por forma_de_pago.
  select e into eje from jsonb_array_elements(v #> '{preparacion,ejes}') e where e ->> 'eje' = 'pago';
  if (eje ->> 'poblacion')::int <> 2 or (eje ->> 'revisados')::int <> 2
     or (eje ->> 'reprobados')::int <> 1 or (eje ->> 'cambios_menores')::int <> 1 then
    insert into _errores(msg) values (format('c: eje pago incorrecto: %s.', eje));
  end if;

  -- Conversación: los 7 borradores; revisados 6 (todos menos d4). Reprueban d3
  -- (tono) y d9 (un «no» sin tipo cuenta como «otro»); cambio menor, d5 (otro).
  -- Los «no» por producto_equivocado y precio NO son de este eje.
  select e into eje from jsonb_array_elements(v #> '{preparacion,ejes}') e where e ->> 'eje' = 'conversacion';
  if (eje ->> 'poblacion')::int <> 7 or (eje ->> 'revisados')::int <> 6
     or (eje ->> 'reprobados')::int <> 2 or (eje ->> 'cambios_menores')::int <> 1 then
    insert into _errores(msg) values (format('c: eje conversación incorrecto: %s.', eje));
  end if;

  -- Señales automáticas.
  if (v #>> '{preparacion,senales,total}')::int <> 7
     or (v #>> '{preparacion,senales,con_guardas}')::int <> 1
     or (v #>> '{preparacion,senales,pasarian_a_asesor}')::int <> 1
     or (v #>> '{preparacion,senales,sin_mensajes}')::int <> 1 then
    insert into _errores(msg) values (format('c: señales incorrectas: %s.', v #> '{preparacion,senales}'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso d · el corte de 90 días y el `hasta` exclusivo
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb := (select r.v from _res r where r.k = 'ancho');
begin
  -- Pidiendo desde 2025: el corte es 90 días antes del `hasta` (20/12/2025), así
  -- que d10 (1/12/2025) no entra; d8 (9/3) sí entra por ser anterior al período
  -- normal; d7 (justo en el `hasta`) no entra jamás.
  if (v #>> '{consumo,total,borradores}')::int <> 8 then
    insert into _errores(msg) values (format('d: con el corte de 90 días debían entrar 8 borradores y entraron %s.', v #>> '{consumo,total,borradores}'));
  end if;
  if exists (select 1 from jsonb_array_elements(v #> '{consumo,dias}') e where e ->> 'dia' in ('2025-12-01', '2026-03-20')) then
    insert into _errores(msg) values ('d: entró un día que el corte de 90 días o el `hasta` exclusivo debían dejar fuera.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Resultado
-- ---------------------------------------------------------------------------
do $$
declare
  fallas text;
begin
  select string_agg(msg, E'\n  - ') into fallas from _errores;
  if fallas is not null then
    raise exception E'sombra_consumo_y_preparacion.sql: fallas:\n  - %', fallas;
  end if;
  raise notice 'sombra_consumo_y_preparacion.sql: todos los casos pasan.';
end $$;

rollback;
