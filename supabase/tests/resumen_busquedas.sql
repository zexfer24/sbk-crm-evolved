-- ============================================================================
-- Pestaña «Búsquedas» de Control IA (T9, plan "Seba no cotiza lo que no es",
-- 30/9/2026): `resumen_busquedas` y `terminos_de_busquedas`, migración
-- 20260930060000_resumen_busquedas.sql.
--
-- Qué prueba:
--   1. Los conteos del bloque A con filas v1 (sin `v`, anteriores a A2) y v2
--      MEZCLADAS: una fila v1 cuenta como búsqueda y como resultado, pero no
--      aporta avisos, relajos ni cotizados (no los tiene, no se inventan).
--   2. Una fila con `catalog_queries` que NO es un arreglo (`{}`), una con
--      `null` y una anterior a `p_desde` no rompen ni suman nada.
--   3. Los términos del bloque C (los obligatorios de una búsqueda sin
--      resultados y los que D3 relajó) y las correcciones del bloque D con en
--      qué terminó cada una.
--   4. Quien no es agente (sesión válida, sin fila en `agents`) recibe `null`:
--      las funciones son `security definer`, así que ese chequeo es SUYO.
--   5. Permisos: `anon` NO ejecuta, `authenticated` y `service_role` SÍ (los
--      DOS revokes de la migración + el grant).
--
-- Los conteos esperados están hechos a mano sobre el fixture de abajo, no
-- calculados con la misma consulta que la función.
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que search_conversations_by_message.sql).
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b6b6b6b6-0000-0000-0000-000000000001', 'agente-a-busquedas@sbk.test', jsonb_build_object('display_name', 'Agente A (búsquedas)')),
  ('b6b6b6b6-0000-0000-0000-000000000002', 'agente-na-busquedas@sbk.test', jsonb_build_object('display_name', 'Agente NA (búsquedas, sin fila en agents)'));

-- Sesión válida de Supabase Auth pero sin fila en `agents` (ver la nota de
-- search_conversations_by_message.sql: `is_active = false` no sirve para esto).
delete from public.agents where id = 'b6b6b6b6-0000-0000-0000-000000000002';

insert into public.whatsapp_channels (id, label, phone_number) values
  ('b7b7b7b7-0000-0000-0000-000000000000', 'Canal de prueba (búsquedas)', '+580000008000');
insert into public.contacts (id, phone_number) values
  ('b8b8b8b8-0000-0000-0000-000000000001', '+580000008001');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('b9b9b9b9-0000-0000-0000-000000000001', 'b8b8b8b8-0000-0000-0000-000000000001', 'b7b7b7b7-0000-0000-0000-000000000000');

-- ---------------------------------------------------------------------------
-- Fixture. Todo dentro de los últimos 7 días salvo la fila vieja.
--
--   t1  v1  sin_resultados      grupos pastilla/freno            (hace 1 día)
--   t2  v1  con_existencia      corregido iphone->ipone          (hace 2 días)
--   t3  v2  DOS consultas (una lista):                           (hace 3 días)
--        q1 con_existencia, avisos universales + relajado, relajados [semi],
--           correccionDescartada vicera->visera, cotizados p1 + p2
--        q2 generico, aviso varias_opciones
--   t4  v2  agotados            aviso variante_agotada, corregido iphone->ipone, cotizados p1
--   t5  v2  sin_resultados      grupos pareja/freno              (hace 5 días)
--   t6  fila de hace 40 días (fuera de p_desde = hace 7 días)
--   t7  catalog_queries = {} (no es un arreglo)
--   t8  catalog_queries = null
-- ---------------------------------------------------------------------------
insert into public.agent_turns (id, conversation_id, action, created_at, catalog_queries) values
  ('ba000000-0000-0000-0000-000000000001', 'b9b9b9b9-0000-0000-0000-000000000001', 'answered', now() - interval '1 day',
   '[{"query":"pastilla freno","productos":null,"moto":[],"grupos":[["pastilla","pastillas"],["freno"]],"opcionales":[],"corregido":null,"resultado":"sin_resultados"}]'::jsonb),
  ('ba000000-0000-0000-0000-000000000002', 'b9b9b9b9-0000-0000-0000-000000000001', 'answered', now() - interval '2 days',
   '[{"query":"aceite iphone","productos":null,"moto":[],"grupos":[["aceite"],["ipone"]],"opcionales":[],"corregido":[{"original":"iphone","corregido":"ipone"}],"resultado":"con_existencia"}]'::jsonb),
  ('ba000000-0000-0000-0000-000000000003', 'b9b9b9b9-0000-0000-0000-000000000001', 'escalated', now() - interval '3 days',
   '[{"v":2,"query":"visera","productos":["visera","guantes"],"moto":[],"cilindrada":[],"grupos":[["visera"]],"opcionales":[],"variantes":[],"anio":[],"motoMarca":[],"motoIgnorada":false,"calzaEntero":false,"relajados":["semi"],"avisos":[{"tipo":"universales","productoPedido":"visera","marca":null},{"tipo":"relajado","productoPedido":"visera","terminos":["semi"]}],"corregido":null,"correccionDescartada":[{"original":"vicera","corregido":"visera"}],"decision":"x","cotizados":[{"productId":"p1","nombre":"VISERA A","stock":3,"precioUsd":5},{"productId":"p2","nombre":"VISERA B","stock":1,"precioUsd":6}],"conteos":{"calzan":2,"conStock":2,"nombranMoto":0,"universales":2},"resultado":"con_existencia"},
     {"v":2,"query":"guantes","productos":["visera","guantes"],"moto":[],"cilindrada":[],"grupos":[["guantes"]],"opcionales":[],"variantes":[],"anio":[],"motoMarca":[],"motoIgnorada":false,"calzaEntero":false,"relajados":[],"avisos":[{"tipo":"varias_opciones","productoPedido":"guantes"}],"corregido":null,"correccionDescartada":null,"decision":"y","cotizados":[],"conteos":null,"resultado":"generico"}]'::jsonb),
  ('ba000000-0000-0000-0000-000000000004', 'b9b9b9b9-0000-0000-0000-000000000001', 'answered', now() - interval '4 days',
   '[{"v":2,"query":"aceite iphone","productos":null,"moto":[],"cilindrada":[],"grupos":[["aceite"],["ipone"]],"opcionales":[],"variantes":[],"anio":[],"motoMarca":[],"motoIgnorada":false,"calzaEntero":false,"relajados":[],"avisos":[{"tipo":"variante_agotada","productoPedido":null,"variante":"rojo","conAlternativa":false}],"corregido":[{"original":"iphone","corregido":"ipone"}],"correccionDescartada":null,"decision":"z","cotizados":[{"productId":"p1","nombre":"VISERA A","stock":0,"precioUsd":5}],"conteos":null,"resultado":"agotados"}]'::jsonb),
  ('ba000000-0000-0000-0000-000000000005', 'b9b9b9b9-0000-0000-0000-000000000001', 'escalated', now() - interval '5 days',
   '[{"v":2,"query":"pareja freno","productos":null,"moto":[],"cilindrada":[],"grupos":[["pareja"],["freno"]],"opcionales":[],"variantes":[],"anio":[],"motoMarca":[],"motoIgnorada":false,"calzaEntero":false,"relajados":[],"avisos":[],"corregido":null,"correccionDescartada":null,"decision":"w","cotizados":[],"conteos":null,"resultado":"sin_resultados"}]'::jsonb),
  ('ba000000-0000-0000-0000-000000000006', 'b9b9b9b9-0000-0000-0000-000000000001', 'answered', now() - interval '40 days',
   '[{"query":"vieja","productos":null,"moto":[],"grupos":[["vieja"]],"opcionales":[],"corregido":null,"resultado":"sin_resultados"}]'::jsonb),
  ('ba000000-0000-0000-0000-000000000007', 'b9b9b9b9-0000-0000-0000-000000000001', 'answered', now() - interval '1 day', '{}'::jsonb),
  ('ba000000-0000-0000-0000-000000000008', 'b9b9b9b9-0000-0000-0000-000000000001', 'answered', now() - interval '1 day', null);

set local role authenticated;
set local "request.jwt.claim.sub" = 'b6b6b6b6-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- Caso 1 · el resumen (bloque A) con v1 y v2 mezcladas.
-- ---------------------------------------------------------------------------
do $$
declare
  r jsonb := public.resumen_busquedas(now() - interval '7 days');
  esperado jsonb := jsonb_build_object(
    'turnos', 5,
    'busquedas', 6,
    'v1', 2,
    'resultados', jsonb_build_object(
      'con_existencia', 2, 'agotados', 1, 'generico', 1, 'sin_resultados', 2, 'sin_terminos', 0, 'error', 0),
    'avisos', jsonb_build_object(
      'universales', 1, 'moto_sin_calce', 0, 'relajado', 1, 'relajado_agotado', 0,
      'variante_agotada', 1, 'varias_opciones', 1),
    'correcciones', 2,
    'descartadas', 1,
    'relajos', 1,
    'relajos_cotizaron', 1,
    'cotizaciones', 3,
    'productos_distintos', 2
  );
  k text;
begin
  if r is null then
    insert into _errores(msg) values ('Caso 1 (resumen): devolvió null para un agente.');
    return;
  end if;
  for k in select jsonb_object_keys(esperado) loop
    if r -> k is distinct from esperado -> k then
      insert into _errores(msg) values (format('Caso 1 (resumen): «%s» dio %s, se esperaba %s.', k, r -> k, esperado -> k));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2 · una ventana más ancha suma la fila de hace 40 días (y solo esa);
-- una más angosta deja solo lo de hace menos de 36 horas.
-- ---------------------------------------------------------------------------
do $$
declare
  ancha jsonb := public.resumen_busquedas(now() - interval '60 days');
  angosta jsonb := public.resumen_busquedas(now() - interval '36 hours');
begin
  if (ancha ->> 'busquedas')::int is distinct from 7 or (ancha ->> 'v1')::int is distinct from 3 then
    insert into _errores(msg) values (format('Caso 2a (ventana de 60 días): busquedas=%s v1=%s, se esperaba 7 y 3.', ancha ->> 'busquedas', ancha ->> 'v1'));
  end if;
  -- Hace 1 día cae dentro de 36 h: solo t1 (una búsqueda).
  if (angosta ->> 'busquedas')::int is distinct from 1 or (angosta ->> 'turnos')::int is distinct from 1 then
    insert into _errores(msg) values (format('Caso 2b (ventana de 36 horas): busquedas=%s turnos=%s, se esperaba 1 y 1.', angosta ->> 'busquedas', angosta ->> 'turnos'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · los términos (bloque C) y las correcciones (bloque D).
-- ---------------------------------------------------------------------------
do $$
declare
  r jsonb := public.terminos_de_busquedas(now() - interval '7 days');
  freno jsonb;
  pastilla jsonb;
  pareja jsonb;
  semi jsonb;
  ipone jsonb;
  n_co int;
begin
  if r is null then
    insert into _errores(msg) values ('Caso 3 (términos): devolvió null para un agente.');
    return;
  end if;

  select e into freno    from jsonb_array_elements(r -> 'sin_calce') e where e ->> 'termino' = 'freno';
  select e into pastilla from jsonb_array_elements(r -> 'sin_calce') e where e ->> 'termino' = 'pastilla';
  select e into pareja   from jsonb_array_elements(r -> 'sin_calce') e where e ->> 'termino' = 'pareja';
  select e into semi     from jsonb_array_elements(r -> 'sin_calce') e where e ->> 'termino' = 'semi';

  if (freno ->> 'sin_resultados')::int is distinct from 2 or (freno ->> 'relajado')::int is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3a («freno»): %s, se esperaba sin_resultados=2 relajado=0.', freno));
  end if;
  if (pastilla ->> 'sin_resultados')::int is distinct from 1 then
    insert into _errores(msg) values (format('Caso 3b («pastilla»): %s, se esperaba sin_resultados=1 (solo la primera alternativa del grupo).', pastilla));
  end if;
  if exists (select 1 from jsonb_array_elements(r -> 'sin_calce') e where e ->> 'termino' = 'pastillas') then
    insert into _errores(msg) values ('Caso 3b2: «pastillas» (la segunda alternativa del grupo) aparece como término aparte.');
  end if;
  if (pareja ->> 'sin_resultados')::int is distinct from 1 then
    insert into _errores(msg) values (format('Caso 3c («pareja»): %s, se esperaba sin_resultados=1.', pareja));
  end if;
  if (semi ->> 'relajado')::int is distinct from 1 or (semi ->> 'sin_resultados')::int is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3d («semi», lo relajó D3): %s, se esperaba relajado=1 sin_resultados=0.', semi));
  end if;
  -- La búsqueda de hace 40 días («vieja») queda fuera.
  if exists (select 1 from jsonb_array_elements(r -> 'sin_calce') e where e ->> 'termino' = 'vieja') then
    insert into _errores(msg) values ('Caso 3e: «vieja» (hace 40 días) aparece en los términos de los últimos 7 días.');
  end if;
  -- Orden: el que más se repite va primero.
  if (r -> 'sin_calce' -> 0 ->> 'termino') is distinct from 'freno' then
    insert into _errores(msg) values (format('Caso 3f: el primero debía ser «freno» (el más repetido), es %s.', r -> 'sin_calce' -> 0 ->> 'termino'));
  end if;

  select count(*) into n_co from jsonb_array_elements(r -> 'correcciones');
  select e into ipone from jsonb_array_elements(r -> 'correcciones') e
    where e ->> 'original' = 'iphone' and e ->> 'corregido' = 'ipone';
  if n_co is distinct from 1 then
    insert into _errores(msg) values (format('Caso 3g: %s correcciones distintas, se esperaba 1 (iphone->ipone).', n_co));
  end if;
  if (ipone ->> 'veces')::int is distinct from 2
     or (ipone ->> 'con_existencia')::int is distinct from 1
     or (ipone ->> 'agotados')::int is distinct from 1
     or (ipone ->> 'sin_resultados')::int is distinct from 0
     or (ipone ->> 'otros')::int is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3h (iphone->ipone): %s, se esperaba veces=2 con_existencia=1 agotados=1 sin_resultados=0 otros=0.', ipone));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 4 · un `authenticated` que NO es agente recibe null en las dos.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b6b6b6b6-0000-0000-0000-000000000002';

do $$
begin
  if public.resumen_busquedas(now() - interval '7 days') is not null then
    insert into _errores(msg) values ('Caso 4a (no agente): resumen_busquedas devolvió datos, se esperaba null.');
  end if;
  if public.terminos_de_busquedas(now() - interval '7 days') is not null then
    insert into _errores(msg) values ('Caso 4b (no agente): terminos_de_busquedas devolvió datos, se esperaba null.');
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 5 · permisos: anon NO, authenticated y service_role SÍ, en las dos.
-- ---------------------------------------------------------------------------
do $$
declare
  errores text := '';
  f text;
begin
  foreach f in array array[
    'public.resumen_busquedas(timestamptz)',
    'public.terminos_de_busquedas(timestamptz)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      errores := errores || format(E'\n  - anon puede ejecutar %s y no debería.', f);
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      errores := errores || format(E'\n  - authenticated NO puede ejecutar %s y sí debería.', f);
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      errores := errores || format(E'\n  - service_role NO puede ejecutar %s y sí debería.', f);
    end if;
  end loop;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 5 (permisos):%s', errores));
  end if;
end $$;

do $$
declare
  detalle text;
begin
  select string_agg(msg, E'\n') into detalle from _errores;
  if detalle is not null then
    raise exception E'resumen_busquedas.sql: fallaron casos:\n%', detalle;
  end if;
  raise notice 'resumen_busquedas.sql: todos los casos en verde.';
end $$;

rollback;
