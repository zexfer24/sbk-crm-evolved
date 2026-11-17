-- ===========================================================================
-- Seba v2: borradores de sombra y copiloto, revisiones y gasto separado (S1,
-- entrega 3 del rework de Seba, 17/11/2026, migración 20261117010000)
--
-- Qué fija:
--   * `agent_shadow_drafts` guarda lo que Seba v2 redacta SIN enviar. Un
--     supervisor/admin lee TODO; un asesor lee SOLO los de modo `copiloto` (la
--     sugerencia que ve en su chat) y solo puede resolverla (estado, quién, cuándo)
--     por permiso de COLUMNA; nada de insert ni delete para usuarios.
--   * `shadow_reviews` es solo de supervisor/admin (cuatro políticas).
--   * El gasto de la sombra vive APARTE (`shadow_spend_today()`): no mueve
--     `agent_spend_today()` ni, por tanto, el tope del turno en vivo.
--   * `shadow_can_run()` (solo service_role) enciende la sombra únicamente en
--     modo sombra/copiloto y por debajo del tope diario.
--   * `agent_turns` distingue v1 de v2 y `conversation_cart_items.origin` acepta
--     'seba'.
--
-- Bajo RLS, un UPDATE que la política no deja pasar NO falla: afecta 0 filas
-- (mismo criterio que formas_de_pago.sql). Un permiso de COLUMNA sí lanza 42501.
--
-- Corre como `authenticated` con claims de un agente real donde importa la RLS
-- (como postgres se la salta y no mediría nada). Termina en `rollback`.
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
-- Caso a · estructura
-- ---------------------------------------------------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.agent_shadow_drafts'::regclass) then
    insert into _errores(msg) values ('a: agent_shadow_drafts no tiene RLS activa.');
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.shadow_reviews'::regclass) then
    insert into _errores(msg) values ('a: shadow_reviews no tiene RLS activa.');
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'agent_shadow_drafts'
        and policyname in ('agent_shadow_drafts_select', 'agent_shadow_drafts_update')) <> 2 then
    insert into _errores(msg) values ('a: faltan las políticas agent_shadow_drafts_select/update.');
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'agent_shadow_drafts') <> 2 then
    insert into _errores(msg) values ('a: agent_shadow_drafts debía tener exactamente dos políticas.');
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'shadow_reviews'
        and policyname in ('shadow_reviews_select', 'shadow_reviews_insert',
                           'shadow_reviews_update', 'shadow_reviews_delete')) <> 4 then
    insert into _errores(msg) values ('a: faltan las políticas shadow_reviews_select/insert/update/delete.');
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'shadow_reviews') <> 4 then
    insert into _errores(msg) values ('a: shadow_reviews debía tener exactamente cuatro políticas.');
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_shadow_drafts') then
    insert into _errores(msg) values ('a: agent_shadow_drafts no está publicada en supabase_realtime.');
  end if;
  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shadow_reviews') then
    insert into _errores(msg) values ('a: shadow_reviews no debía estar publicada en supabase_realtime.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preparación como postgres (sin RLS)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('5b5b0000-0000-0000-0000-0000000000a1', 'asesor-sombra@sbk.test', jsonb_build_object('display_name', 'Asesor sombra'), '{}'::jsonb),
  ('5b5b0000-0000-0000-0000-0000000000a2', 'super-sombra@sbk.test',  jsonb_build_object('display_name', 'Supervisor sombra'), '{"role":"supervisor"}'::jsonb),
  ('5b5b0000-0000-0000-0000-0000000000c1', 'caja-sombra@sbk.test',   jsonb_build_object('display_name', 'Caja sombra'), '{"role":"caja"}'::jsonb);

insert into public.whatsapp_channels (id, label, phone_number) values
  ('5b5b0000-1000-0000-0000-000000000001', 'Canal sombra', '+580000009500');
insert into public.contacts (id, phone_number) values
  ('5b5b0000-2000-0000-0000-000000000001', '+580000009501');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('5b5b0000-3000-0000-0000-000000000001', '5b5b0000-2000-0000-0000-000000000001', '5b5b0000-1000-0000-0000-000000000001');
insert into public.products (id, name, price, currency, stock_quantity) values
  ('5b5b0000-4000-0000-0000-000000000001', 'Producto sombra', 10, 'USD', 5);

-- Dos borradores: uno de sombra (solo supervisor) y uno de copiloto pendiente.
insert into public.agent_shadow_drafts
  (id, conversation_id, modo, rafaga, mensajes, contexto, sugerencia_estado) values
  ('5b5b0000-5000-0000-0000-000000000001', '5b5b0000-3000-0000-0000-000000000001', 'sombra',
   '["hola"]'::jsonb, '[{"orden":1,"tipo":"texto","texto":"borrador sombra","origen":"modelo"}]'::jsonb,
   '{"ia_global":true,"asesor_asignado":false,"asesor_escribio_hace_min":null}'::jsonb, null),
  ('5b5b0000-5000-0000-0000-000000000002', '5b5b0000-3000-0000-0000-000000000001', 'copiloto',
   '["hola"]'::jsonb, '[{"orden":1,"tipo":"texto","texto":"borrador copiloto","origen":"modelo"}]'::jsonb,
   '{"ia_global":true,"asesor_asignado":true,"asesor_escribio_hace_min":3}'::jsonb, 'pendiente');

-- ---------------------------------------------------------------------------
-- Caso b · quién lee
-- ---------------------------------------------------------------------------
do $$
begin
  if has_table_privilege('anon', 'public.agent_shadow_drafts', 'select') then
    insert into _errores(msg) values ('b: anon tiene SELECT sobre agent_shadow_drafts.');
  end if;
  if has_table_privilege('anon', 'public.shadow_reviews', 'select') then
    insert into _errores(msg) values ('b: anon tiene SELECT sobre shadow_reviews.');
  end if;
end $$;

set local role authenticated;
set local "request.jwt.claim.sub" = '5b5b0000-0000-0000-0000-0000000000a1';
select pg_temp.esperar('b: asesor lee solo el de copiloto',
  $q$select 1 from public.agent_shadow_drafts where conversation_id = '5b5b0000-3000-0000-0000-000000000001'$q$,
  '^filas=1$');
select pg_temp.esperar('b: asesor no ve el de sombra',
  $q$select 1 from public.agent_shadow_drafts where id = '5b5b0000-5000-0000-0000-000000000001'$q$,
  '^filas=0$');

set local "request.jwt.claim.sub" = '5b5b0000-0000-0000-0000-0000000000a2';
select pg_temp.esperar('b: supervisor lee los dos',
  $q$select 1 from public.agent_shadow_drafts where conversation_id = '5b5b0000-3000-0000-0000-000000000001'$q$,
  '^filas=2$');

set local "request.jwt.claim.sub" = '5b5b0000-0000-0000-0000-0000000000c1';
select pg_temp.esperar('b: caja no lee ninguno',
  $q$select 1 from public.agent_shadow_drafts where conversation_id = '5b5b0000-3000-0000-0000-000000000001'$q$,
  '^filas=0$');
reset role;

-- ---------------------------------------------------------------------------
-- Caso c · el asesor solo resuelve la sugerencia de copiloto, por columna
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '5b5b0000-0000-0000-0000-0000000000a1';

select pg_temp.esperar('c: asesor resuelve la sugerencia de copiloto',
  $q$update public.agent_shadow_drafts
        set sugerencia_estado = 'enviada',
            sugerencia_resuelta_por = '5b5b0000-0000-0000-0000-0000000000a1',
            sugerencia_resuelta_at = now()
      where id = '5b5b0000-5000-0000-0000-000000000002'$q$,
  '^filas=1$');
select pg_temp.esperar('c: el mismo UPDATE sobre el de sombra afecta 0 filas',
  $q$update public.agent_shadow_drafts
        set sugerencia_estado = 'enviada',
            sugerencia_resuelta_por = '5b5b0000-0000-0000-0000-0000000000a1',
            sugerencia_resuelta_at = now()
      where id = '5b5b0000-5000-0000-0000-000000000001'$q$,
  '^filas=0$');
select pg_temp.esperar('c: asesor no toca otra columna (nota)',
  $q$update public.agent_shadow_drafts set nota = 'x' where id = '5b5b0000-5000-0000-0000-000000000002'$q$,
  '^error 42501');
select pg_temp.esperar('c: asesor no toca otra columna (mensajes)',
  $q$update public.agent_shadow_drafts set mensajes = '[]'::jsonb where id = '5b5b0000-5000-0000-0000-000000000002'$q$,
  '^error 42501');
select pg_temp.esperar('c: asesor INSERT',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto)
       values ('5b5b0000-3000-0000-0000-000000000001', 'copiloto', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)$q$,
  '^error 42501');
select pg_temp.esperar('c: asesor DELETE',
  $q$delete from public.agent_shadow_drafts where id = '5b5b0000-5000-0000-0000-000000000002'$q$,
  '^error 42501');
reset role;

do $$
begin
  if (select sugerencia_estado from public.agent_shadow_drafts where id = '5b5b0000-5000-0000-0000-000000000002') is distinct from 'enviada' then
    insert into _errores(msg) values ('c: la sugerencia de copiloto no quedó en "enviada".');
  end if;
  if (select sugerencia_estado from public.agent_shadow_drafts where id = '5b5b0000-5000-0000-0000-000000000001') is not null then
    insert into _errores(msg) values ('c: el asesor logró tocar el borrador de sombra.');
  end if;
  if (select nota from public.agent_shadow_drafts where id = '5b5b0000-5000-0000-0000-000000000002') is not null then
    insert into _errores(msg) values ('c: el asesor logró escribir la nota.');
  end if;
  if not has_column_privilege('authenticated', 'public.agent_shadow_drafts', 'sugerencia_estado', 'update') then
    insert into _errores(msg) values ('c: authenticated no puede actualizar sugerencia_estado.');
  end if;
  if has_column_privilege('authenticated', 'public.agent_shadow_drafts', 'nota', 'update') then
    insert into _errores(msg) values ('c: authenticated puede actualizar la columna nota (el grant debía ser por columna).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso d · CHECK de agent_shadow_drafts (como postgres: miden la tabla, no la RLS)
-- ---------------------------------------------------------------------------
select pg_temp.esperar('d: modo = vivo',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto)
       values ('5b5b0000-3000-0000-0000-000000000001', 'vivo', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)$q$,
  '^error 23514: .*agent_shadow_drafts_modo_check');
select pg_temp.esperar('d: sugerencia_estado = otra',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto, sugerencia_estado)
       values ('5b5b0000-3000-0000-0000-000000000001', 'copiloto', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'otra')$q$,
  '^error 23514: .*agent_shadow_drafts_sugerencia_estado_check');
select pg_temp.esperar('d: rafaga objeto',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto)
       values ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)$q$,
  '^error 23514: .*agent_shadow_drafts_rafaga_array');
select pg_temp.esperar('d: mensajes escalar',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto)
       values ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '[]'::jsonb, '"x"'::jsonb, '{}'::jsonb)$q$,
  '^error 23514: .*agent_shadow_drafts_mensajes_array');
select pg_temp.esperar('d: contexto arreglo',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto)
       values ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)$q$,
  '^error 23514: .*agent_shadow_drafts_contexto_object');
select pg_temp.esperar('d: area = cobranzas',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto, area)
       values ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'cobranzas')$q$,
  '^error 23514: .*agent_shadow_drafts_area_check');
select pg_temp.esperar('d: un borrador mínimo válido entra',
  $q$insert into public.agent_shadow_drafts (conversation_id, modo, rafaga, mensajes, contexto, area)
       values ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pagos')$q$,
  '^filas=1$');

-- ---------------------------------------------------------------------------
-- Caso e · shadow_reviews: solo supervisor/admin
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '5b5b0000-0000-0000-0000-0000000000a1';
select pg_temp.esperar('e: asesor INSERT de revisión',
  $q$insert into public.shadow_reviews (draft_id, veredicto, reviewed_by)
       values ('5b5b0000-5000-0000-0000-000000000001', 'igual', '5b5b0000-0000-0000-0000-0000000000a1')$q$,
  '^error 42501');

set local "request.jwt.claim.sub" = '5b5b0000-0000-0000-0000-0000000000a2';
select pg_temp.esperar('e: supervisor INSERT de revisión',
  $q$insert into public.shadow_reviews (draft_id, veredicto, error_tipo, correccion, destino, reviewed_by)
       values ('5b5b0000-5000-0000-0000-000000000001', 'cambio_menor', 'tono', 'Más cercano.', 'leccion',
               '5b5b0000-0000-0000-0000-0000000000a2')$q$,
  '^filas=1$');
select pg_temp.esperar('e: supervisor lee su revisión',
  $q$select 1 from public.shadow_reviews where draft_id = '5b5b0000-5000-0000-0000-000000000001'$q$,
  '^filas=1$');
select pg_temp.esperar('e: supervisor actualiza su revisión',
  $q$update public.shadow_reviews set veredicto = 'no' where draft_id = '5b5b0000-5000-0000-0000-000000000001'$q$,
  '^filas=1$');

set local "request.jwt.claim.sub" = '5b5b0000-0000-0000-0000-0000000000a1';
select pg_temp.esperar('e: asesor no lee revisiones',
  $q$select 1 from public.shadow_reviews$q$,
  '^filas=0$');
select pg_temp.esperar('e: asesor UPDATE de revisión afecta 0 filas',
  $q$update public.shadow_reviews set veredicto = 'igual' where draft_id = '5b5b0000-5000-0000-0000-000000000001'$q$,
  '^filas=0$');
select pg_temp.esperar('e: asesor DELETE de revisión afecta 0 filas',
  $q$delete from public.shadow_reviews where draft_id = '5b5b0000-5000-0000-0000-000000000001'$q$,
  '^filas=0$');
reset role;

do $$
begin
  if (select veredicto from public.shadow_reviews where draft_id = '5b5b0000-5000-0000-0000-000000000001') is distinct from 'no' then
    insert into _errores(msg) values ('e: la revisión no quedó en "no" (o el asesor la tocó).');
  end if;
end $$;

select pg_temp.esperar('e: veredicto = quizas',
  $q$insert into public.shadow_reviews (draft_id, veredicto, reviewed_by)
       values ('5b5b0000-5000-0000-0000-000000000002', 'quizas', '5b5b0000-0000-0000-0000-0000000000a2')$q$,
  '^error 23514: .*shadow_reviews_veredicto_check');
select pg_temp.esperar('e: correccion de 2001 caracteres',
  $q$insert into public.shadow_reviews (draft_id, veredicto, correccion, reviewed_by)
       values ('5b5b0000-5000-0000-0000-000000000002', 'no', repeat('x', 2001), '5b5b0000-0000-0000-0000-0000000000a2')$q$,
  '^error 23514: .*shadow_reviews_correccion_length');
select pg_temp.esperar('e: correccion de 2000 caracteres (el tope exacto entra)',
  $q$insert into public.shadow_reviews (draft_id, veredicto, correccion, reviewed_by)
       values ('5b5b0000-5000-0000-0000-000000000002', 'no', repeat('x', 2000), '5b5b0000-0000-0000-0000-0000000000a2')$q$,
  '^filas=1$');
select pg_temp.esperar('e: error_tipo inventado',
  $q$update public.shadow_reviews set error_tipo = 'raro' where draft_id = '5b5b0000-5000-0000-0000-000000000002'$q$,
  '^error 23514: .*shadow_reviews_error_tipo_check');
select pg_temp.esperar('e: destino inventado',
  $q$update public.shadow_reviews set destino = 'raro' where draft_id = '5b5b0000-5000-0000-0000-000000000002'$q$,
  '^error 23514: .*shadow_reviews_destino_check');

-- Borrar el borrador borra su revisión (cascade).
delete from public.agent_shadow_drafts where id = '5b5b0000-5000-0000-0000-000000000002';
do $$
begin
  if exists (select 1 from public.shadow_reviews where draft_id = '5b5b0000-5000-0000-0000-000000000002') then
    insert into _errores(msg) values ('e: borrar el borrador no borró su revisión (cascade).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso f · el gasto de la sombra va aparte
-- ---------------------------------------------------------------------------
insert into public.model_pricing (model, input_price_per_million, output_price_per_million)
values ('prueba/sombra-con-tarifa', 2.0000, 4.0000)
on conflict (model) do update
  set input_price_per_million = excluded.input_price_per_million,
      output_price_per_million = excluded.output_price_per_million;
delete from public.model_pricing where model = 'prueba/sombra-sin-tarifa';

do $$
declare
  sombra_antes numeric;
  vivo_antes numeric;
  sombra_despues numeric;
  vivo_despues numeric;
begin
  sombra_antes := public.shadow_spend_today();
  vivo_antes := public.agent_spend_today();

  -- 1.000.000 de entrada a 2 $/M + 500.000 de salida a 4 $/M = 4.00
  insert into public.agent_shadow_drafts
    (conversation_id, modo, rafaga, mensajes, contexto, model, input_tokens, output_tokens) values
    ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
     'prueba/sombra-con-tarifa', 1000000, 500000);
  sombra_despues := public.shadow_spend_today();
  vivo_despues := public.agent_spend_today();
  if sombra_despues - sombra_antes is distinct from 4.00 then
    insert into _errores(msg) values (format('f: shadow_spend_today subió %s, se esperaba 4.00 (antes %s, después %s).',
      sombra_despues - sombra_antes, sombra_antes, sombra_despues));
  end if;
  if vivo_despues is distinct from vivo_antes then
    insert into _errores(msg) values (format('f: agent_spend_today cambió por un borrador de sombra (%s -> %s).', vivo_antes, vivo_despues));
  end if;

  -- Un borrador de ayer no suma.
  sombra_antes := sombra_despues;
  insert into public.agent_shadow_drafts
    (conversation_id, modo, rafaga, mensajes, contexto, model, input_tokens, output_tokens, created_at) values
    ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
     'prueba/sombra-con-tarifa', 1000000, 500000, now() - interval '2 days');
  sombra_despues := public.shadow_spend_today();
  if sombra_despues is distinct from sombra_antes then
    insert into _errores(msg) values (format('f: un borrador de hace 2 días movió el gasto de %s a %s.', sombra_antes, sombra_despues));
  end if;

  -- Un modelo sin tarifa no suma (y no rompe la suma).
  insert into public.agent_shadow_drafts
    (conversation_id, modo, rafaga, mensajes, contexto, model, input_tokens, output_tokens) values
    ('5b5b0000-3000-0000-0000-000000000001', 'sombra', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
     'prueba/sombra-sin-tarifa', 1000000, 500000);
  sombra_despues := public.shadow_spend_today();
  if sombra_despues is distinct from sombra_antes then
    insert into _errores(msg) values (format('f: un modelo sin tarifa movió el gasto de %s a %s.', sombra_antes, sombra_despues));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso g · shadow_can_run() según el modo y el tope
-- ---------------------------------------------------------------------------
do $$
declare
  gasto numeric := public.shadow_spend_today();
  r boolean;
begin
  update public.agent_settings set seba_v2_modo = 'apagado', shadow_daily_cap_usd = gasto + 1;
  r := public.shadow_can_run();
  if r is distinct from false then
    insert into _errores(msg) values (format('g: con modo apagado shadow_can_run dio %s.', r));
  end if;

  update public.agent_settings set seba_v2_modo = 'sombra', shadow_daily_cap_usd = gasto + 1;
  r := public.shadow_can_run();
  if r is distinct from true then
    insert into _errores(msg) values (format('g: con modo sombra y tope holgado shadow_can_run dio %s.', r));
  end if;

  update public.agent_settings set seba_v2_modo = 'copiloto', shadow_daily_cap_usd = gasto + 1;
  r := public.shadow_can_run();
  if r is distinct from true then
    insert into _errores(msg) values (format('g: con modo copiloto y tope holgado shadow_can_run dio %s.', r));
  end if;

  update public.agent_settings set seba_v2_modo = 'sombra', shadow_daily_cap_usd = 0.01;
  r := public.shadow_can_run();
  if r is distinct from false then
    insert into _errores(msg) values (format('g: con el tope por debajo del gasto (%s) shadow_can_run dio %s.', gasto, r));
  end if;

  update public.agent_settings set seba_v2_modo = 'siempre', shadow_daily_cap_usd = gasto + 1;
  r := public.shadow_can_run();
  if r is distinct from false then
    insert into _errores(msg) values (format('g: con modo siempre shadow_can_run dio %s.', r));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso h · agent_turns (versión) y conversation_cart_items.origin
-- ---------------------------------------------------------------------------
do $$
declare
  id_turno uuid;
begin
  insert into public.agent_turns (conversation_id, action)
    values ('5b5b0000-3000-0000-0000-000000000001', 'answered') returning id into id_turno;
  if (select agent_version from public.agent_turns where id = id_turno) is distinct from 'v1' then
    insert into _errores(msg) values ('h: agent_version no nace en v1.');
  end if;
end $$;

select pg_temp.esperar('h: agent_version = v3',
  $q$insert into public.agent_turns (conversation_id, action, agent_version)
       values ('5b5b0000-3000-0000-0000-000000000001', 'answered', 'v3')$q$,
  '^error 23514: .*agent_turns_agent_version_check');
select pg_temp.esperar('h: agent_version = v2 entra',
  $q$insert into public.agent_turns (conversation_id, action, agent_version, escalation_motivo, escalation_area)
       values ('5b5b0000-3000-0000-0000-000000000001', 'answered', 'v2', 'intencion_compra', 'ventas')$q$,
  '^filas=1$');
select pg_temp.esperar('h: escalation_area = cobranzas',
  $q$insert into public.agent_turns (conversation_id, action, escalation_area)
       values ('5b5b0000-3000-0000-0000-000000000001', 'answered', 'cobranzas')$q$,
  '^error 23514: .*agent_turns_escalation_area_check');
select pg_temp.esperar('h: escalation_motivo de 61 caracteres',
  $q$insert into public.agent_turns (conversation_id, action, escalation_motivo)
       values ('5b5b0000-3000-0000-0000-000000000001', 'answered', repeat('x', 61))$q$,
  '^error 23514: .*agent_turns_escalation_motivo_length');

select pg_temp.esperar('h: carrito con origin = seba',
  $q$insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin)
       values ('5b5b0000-3000-0000-0000-000000000001', '5b5b0000-4000-0000-0000-000000000001', 1, 'seba')$q$,
  '^filas=1$');
select pg_temp.esperar('h: carrito con origin = otro',
  $q$insert into public.conversation_cart_items (conversation_id, product_id, quantity, origin)
       values ('5b5b0000-3000-0000-0000-000000000001', '5b5b0000-4000-0000-0000-000000000001', 1, 'otro')$q$,
  '^error 23514: .*conversation_cart_items_origin_check');

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'agent_turn_calls' and column_name = 'model') then
    insert into _errores(msg) values ('h: falta agent_turn_calls.model.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso i · permisos de las funciones
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.shadow_can_run()', 'execute') then
    insert into _errores(msg) values ('i: anon puede ejecutar shadow_can_run().');
  end if;
  if has_function_privilege('authenticated', 'public.shadow_can_run()', 'execute') then
    insert into _errores(msg) values ('i: authenticated puede ejecutar shadow_can_run() (es solo de service_role).');
  end if;
  if not has_function_privilege('service_role', 'public.shadow_can_run()', 'execute') then
    insert into _errores(msg) values ('i: service_role no puede ejecutar shadow_can_run().');
  end if;
  if has_function_privilege('anon', 'public.shadow_spend_today()', 'execute') then
    insert into _errores(msg) values ('i: anon puede ejecutar shadow_spend_today().');
  end if;
  if not has_function_privilege('authenticated', 'public.shadow_spend_today()', 'execute') then
    insert into _errores(msg) values ('i: authenticated no puede ejecutar shadow_spend_today() (el panel la lee).');
  end if;
  if not has_function_privilege('service_role', 'public.shadow_spend_today()', 'execute') then
    insert into _errores(msg) values ('i: service_role no puede ejecutar shadow_spend_today().');
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
    raise exception E'seba_v2_sombra roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'seba_v2_sombra: todas las aserciones pasaron.'
