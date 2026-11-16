-- ===========================================================================
-- Configuración de Seba v2, áreas del asesor y estado del pedido (T2, plan
-- "Entrega 2 de Seba v2: los datos del negocio", 16/11/2026, migración
-- 20261116030000)
--
-- Qué fija:
--   · `agent_settings` (UNA fila) gana el modo de Seba v2 (`seba_v2_modo`, nace
--     'apagado' y nadie lo lee hasta la entrega 3), sus topes de sombra, los
--     dos textos de bienvenida, el texto de datos de Cashea y los dos montos de
--     Cashea. Sus políticas vigentes (select `is_agent()`, update solo
--     supervisor/admin) ya los cubren: la migración no crea políticas.
--   · `agents.areas` (pagos/ventas/envios/reclamos) la cambia SOLO un
--     supervisor o admin: la política `agents_update_self` dejaría a un asesor
--     cambiar las suyas, así que se amplía el trigger `agents_role_guard`
--     (ahora BEFORE UPDATE OF role, id, areas). Este test exige el mensaje del
--     TRIGGER en el rechazo, no el de la RLS.
--   · `conversations` gana `escalation_area` y `seba_pedido` (nadie las escribe
--     todavía; solo se fija su forma y su CHECK).
--
-- Bajo RLS, un UPDATE que la política no deja pasar NO falla: afecta 0 filas
-- (mismo criterio que formas_de_pago.sql y config_solo_supervisor.sql).
--
-- Casos:
--   a. DEFAULTS DE COLUMNA (leídos de information_schema, no de la fila: otra
--      corrida pudo haber cambiado los valores) y que la fila no tiene nulos.
--   b. Asesor: UPDATE de agent_settings -> 0 filas y nada cambia. Supervisor: 1.
--   c. Los CHECK de agent_settings (23514 con el nombre del CHECK) y los bordes
--      que SÍ entran.
--   d. Un usuario nuevo nace con las cuatro áreas.
--   e. `areas` con un valor ajeno -> 23514; `'{}'` entra.
--   f. Asesor: no cambia SUS áreas (mensaje del trigger, 42501), tampoco las de
--      otro (0 filas); sí su display_name; re-escribir las mismas áreas no es
--      un cambio.
--   g. Supervisor y service_role sí cambian áreas.
--   h. `conversations`: escalation_area y seba_pedido con sus CHECK.
--   i. El índice existe y agent_settings NO ganó políticas.
--
-- Termina en `rollback`.
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
-- Preparación como postgres: asesor A, asesor B, supervisor S
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('e3e3f0a0-0000-0000-0000-0000000000a1', 'asesor-a-areas@sbk.test', jsonb_build_object('display_name', 'Asesor A areas'), '{}'::jsonb),
  ('e3e3f0a0-0000-0000-0000-0000000000a2', 'asesor-b-areas@sbk.test', jsonb_build_object('display_name', 'Asesor B areas'), '{}'::jsonb),
  ('e3e3f0a0-0000-0000-0000-0000000000a3', 'super-areas@sbk.test',    jsonb_build_object('display_name', 'Supervisor areas'), '{"role":"supervisor"}'::jsonb);

-- ---------------------------------------------------------------------------
-- Caso a · defaults de columna y fila sin nulos (como postgres)
-- ---------------------------------------------------------------------------
do $$
declare
  d text;
  r record;
begin
  -- Las ocho columnas de agent_settings y sus defaults.
  for r in
    select * from (values
      ('seba_v2_modo',                '%apagado%',                     'like'),
      ('shadow_daily_cap_usd',        '5',                             'eq'),
      ('shadow_sample_pct',           '100',                           'eq'),
      ('cashea_minimo_usd',           '25',                            'eq'),
      ('cashea_seis_cuotas_desde_usd','100',                           'eq'),
      ('welcome_text',                '%Bienvenido a *SBK Motors*%',   'like'),
      ('cashea_datos_text',           '%Para generar tu link de compra%', 'like'),
      ('welcome_followups',           '%Cuéntame, ¿qué andas buscando para tu moto?%', 'like')
    ) as t(columna, esperado, modo)
  loop
    select column_default into d
      from information_schema.columns
     where table_schema = 'public' and table_name = 'agent_settings' and column_name = r.columna;
    if d is null then
      insert into _errores(msg) values (format('a: agent_settings.%s no existe o no tiene default.', r.columna));
    elsif r.modo = 'eq' and d is distinct from r.esperado then
      insert into _errores(msg) values (format('a: default de %s = %s, se esperaba %s.', r.columna, d, r.esperado));
    elsif r.modo = 'like' and d not like r.esperado then
      insert into _errores(msg) values (format('a: default de %s no contiene %s (salió %s).', r.columna, r.esperado, d));
    end if;
  end loop;

  -- agents.areas nace con las cuatro.
  select column_default into d
    from information_schema.columns
   where table_schema = 'public' and table_name = 'agents' and column_name = 'areas';
  if d is null or d not like '%pagos,ventas,envios,reclamos%' then
    insert into _errores(msg) values (format('a: default de agents.areas = %s, se esperaban las cuatro áreas.', coalesce(d, 'null')));
  end if;

  -- Las dos columnas de conversations existen y son anulables, sin default.
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'conversations'
         and column_name in ('escalation_area', 'seba_pedido')
         and is_nullable = 'YES' and column_default is null) <> 2 then
    insert into _errores(msg) values ('a: conversations.escalation_area y seba_pedido debían existir, anulables y sin default.');
  end if;
end $$;

do $$
begin
  if (select count(*) from public.agent_settings) <> 1 then
    insert into _errores(msg) values ('a: agent_settings debía tener exactamente una fila.');
  end if;
  if exists (
    select 1 from public.agent_settings
     where seba_v2_modo is null or shadow_daily_cap_usd is null or shadow_sample_pct is null
        or welcome_text is null or welcome_followups is null or cashea_datos_text is null
        or cashea_minimo_usd is null or cashea_seis_cuotas_desde_usd is null
        or cardinality(welcome_followups) < 2
  ) then
    insert into _errores(msg) values ('a: la fila de agent_settings tiene nulos en las columnas nuevas o menos de 2 frases de seguimiento.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso d · un usuario nuevo nace con las cuatro áreas (como postgres)
-- ---------------------------------------------------------------------------
do $$
begin
  if (select areas from public.agents where id = 'e3e3f0a0-0000-0000-0000-0000000000a1')
       is distinct from array['pagos','ventas','envios','reclamos']::text[] then
    insert into _errores(msg) values ('d: un agente nuevo debía nacer con las cuatro áreas (pagos, ventas, envios, reclamos).');
  end if;
end $$;

-- Valor de partida del modo, para comprobar que el asesor no lo movió.
create temporary table _antes (modo text) on commit drop;
insert into _antes select seba_v2_modo from public.agent_settings;

-- ---------------------------------------------------------------------------
-- Caso b · el asesor no cambia la configuración; el supervisor sí
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e3e3f0a0-0000-0000-0000-0000000000a1';

select pg_temp.esperar('b: asesor lee agent_settings',
  $q$select 1 from public.agent_settings$q$,
  '^filas=1$');
select pg_temp.esperar('b: asesor UPDATE de seba_v2_modo',
  $q$update public.agent_settings set seba_v2_modo = 'sombra'$q$,
  '^filas=0$');

reset role;

do $$
begin
  if (select seba_v2_modo from public.agent_settings) is distinct from (select modo from _antes) then
    insert into _errores(msg) values ('b: el asesor logró cambiar seba_v2_modo.');
  end if;
end $$;

set local role authenticated;
set local "request.jwt.claim.sub" = 'e3e3f0a0-0000-0000-0000-0000000000a3';

select pg_temp.esperar('b: supervisor UPDATE de seba_v2_modo',
  $q$update public.agent_settings set seba_v2_modo = 'sombra'$q$,
  '^filas=1$');

reset role;

do $$
begin
  if (select seba_v2_modo from public.agent_settings) is distinct from 'sombra' then
    insert into _errores(msg) values ('b: el UPDATE del supervisor no quedó guardado.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso c · los CHECK de agent_settings (como postgres: miden la tabla, no la RLS)
-- ---------------------------------------------------------------------------
select pg_temp.esperar('c: modo desconocido',
  $q$update public.agent_settings set seba_v2_modo = 'encendido'$q$,
  '^error 23514: .*agent_settings_seba_v2_modo_check');
select pg_temp.esperar('c: modo fuera_de_horario (entra)',
  $q$update public.agent_settings set seba_v2_modo = 'fuera_de_horario'$q$,
  '^filas=1$');
select pg_temp.esperar('c: muestreo de sombra de 101',
  $q$update public.agent_settings set shadow_sample_pct = 101$q$,
  '^error 23514: .*agent_settings_shadow_sample_pct_check');
select pg_temp.esperar('c: tope diario de sombra negativo',
  $q$update public.agent_settings set shadow_daily_cap_usd = -1$q$,
  '^error 23514: .*agent_settings_shadow_daily_cap_check');
select pg_temp.esperar('c: bienvenida vacía',
  $q$update public.agent_settings set welcome_text = ''$q$,
  '^error 23514: .*agent_settings_welcome_text_length');
select pg_temp.esperar('c: bienvenida de 1001 caracteres',
  $q$update public.agent_settings set welcome_text = repeat('x', 1001)$q$,
  '^error 23514: .*agent_settings_welcome_text_length');
select pg_temp.esperar('c: bienvenida de 1000 caracteres (el tope exacto entra)',
  $q$update public.agent_settings set welcome_text = repeat('x', 1000)$q$,
  '^filas=1$');
select pg_temp.esperar('c: una sola frase de seguimiento',
  $q$update public.agent_settings set welcome_followups = array['una sola']$q$,
  '^error 23514: .*agent_settings_welcome_followups_check');
select pg_temp.esperar('c: frase de seguimiento vacía',
  $q$update public.agent_settings set welcome_followups = array['hola', '']$q$,
  '^error 23514: .*agent_settings_welcome_followups_check');
select pg_temp.esperar('c: frase de seguimiento nula',
  $q$update public.agent_settings set welcome_followups = array['hola', null, 'adios']::text[]$q$,
  '^error 23514: .*agent_settings_welcome_followups_check');
select pg_temp.esperar('c: nueve frases de seguimiento',
  $q$update public.agent_settings set welcome_followups = array['1','2','3','4','5','6','7','8','9']$q$,
  '^error 23514: .*agent_settings_welcome_followups_check');
select pg_temp.esperar('c: frases con más de 1280 caracteres en total',
  $q$update public.agent_settings set welcome_followups = array_fill(repeat('x', 161), array[8])$q$,
  '^error 23514: .*agent_settings_welcome_followups_check');
select pg_temp.esperar('c: exactamente dos frases (el mínimo entra)',
  $q$update public.agent_settings set welcome_followups = array['una', 'dos']$q$,
  '^filas=1$');
select pg_temp.esperar('c: ocho frases de 160 caracteres (el tope exacto entra)',
  $q$update public.agent_settings set welcome_followups = array_fill(repeat('x', 160), array[8])$q$,
  '^filas=1$');
select pg_temp.esperar('c: datos de Cashea vacíos',
  $q$update public.agent_settings set cashea_datos_text = ''$q$,
  '^error 23514: .*agent_settings_cashea_datos_text_length');
select pg_temp.esperar('c: datos de Cashea de 1001 caracteres',
  $q$update public.agent_settings set cashea_datos_text = repeat('x', 1001)$q$,
  '^error 23514: .*agent_settings_cashea_datos_text_length');
select pg_temp.esperar('c: monto mínimo de Cashea negativo',
  $q$update public.agent_settings set cashea_minimo_usd = -1$q$,
  '^error 23514: .*agent_settings_cashea_montos_check');
select pg_temp.esperar('c: monto de seis cuotas negativo',
  $q$update public.agent_settings set cashea_seis_cuotas_desde_usd = -0.01$q$,
  '^error 23514: .*agent_settings_cashea_montos_check');

-- ---------------------------------------------------------------------------
-- Caso e · agents.areas: valores ajenos fuera, vacío dentro (como postgres)
-- ---------------------------------------------------------------------------
select pg_temp.esperar('e: área ajena',
  $q$update public.agents set areas = '{pagos,cobranzas}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a2'$q$,
  '^error 23514: .*agents_areas_check');
select pg_temp.esperar('e: áreas vacías (un supervisor que no toma casos)',
  $q$update public.agents set areas = '{}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a2'$q$,
  '^filas=1$');
select pg_temp.esperar('e: de vuelta a una sola área válida',
  $q$update public.agents set areas = '{envios}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a2'$q$,
  '^filas=1$');

-- Estado de partida de los casos f y g.
update public.agents set areas = '{pagos,ventas,envios,reclamos}'
 where id in ('e3e3f0a0-0000-0000-0000-0000000000a1', 'e3e3f0a0-0000-0000-0000-0000000000a2');

-- ---------------------------------------------------------------------------
-- Caso f · el asesor no cambia sus áreas (ni las de otro), pero sí lo suyo
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e3e3f0a0-0000-0000-0000-0000000000a1';

select pg_temp.esperar('f: A cambia SUS áreas',
  $q$update public.agents set areas = '{pagos}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a1'$q$,
  '^error 42501: .*áreas de un agente');
select pg_temp.esperar('f: A cambia las áreas de B',
  $q$update public.agents set areas = '{pagos}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a2'$q$,
  '^filas=0$');
select pg_temp.esperar('f: A cambia su display_name',
  $q$update public.agents set display_name = 'A editado' where id = 'e3e3f0a0-0000-0000-0000-0000000000a1'$q$,
  '^filas=1$');
select pg_temp.esperar('f: A re-escribe sus mismas áreas (sin cambio real)',
  $q$update public.agents set areas = areas where id = 'e3e3f0a0-0000-0000-0000-0000000000a1'$q$,
  '^filas=1$');

reset role;

do $$
begin
  if (select areas from public.agents where id = 'e3e3f0a0-0000-0000-0000-0000000000a1')
       is distinct from array['pagos','ventas','envios','reclamos']::text[] then
    insert into _errores(msg) values ('f: las áreas de A cambiaron aunque el trigger debía rechazarlo.');
  end if;
  if (select areas from public.agents where id = 'e3e3f0a0-0000-0000-0000-0000000000a2')
       is distinct from array['pagos','ventas','envios','reclamos']::text[] then
    insert into _errores(msg) values ('f: A logró cambiar las áreas de B.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso g · el supervisor y service_role sí cambian áreas
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e3e3f0a0-0000-0000-0000-0000000000a3';

select pg_temp.esperar('g: supervisor cambia las áreas de B',
  $q$update public.agents set areas = '{pagos}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a2'$q$,
  '^filas=1$');
select pg_temp.esperar('g: supervisor cambia SUS áreas a vacío',
  $q$update public.agents set areas = '{}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a3'$q$,
  '^filas=1$');

reset role;

do $$
begin
  if (select areas from public.agents where id = 'e3e3f0a0-0000-0000-0000-0000000000a2')
       is distinct from array['pagos']::text[] then
    insert into _errores(msg) values ('g: el cambio de áreas del supervisor no quedó guardado.');
  end if;
end $$;

reset "request.jwt.claim.sub";
set local role service_role;

select pg_temp.esperar('g: service_role cambia las áreas de B',
  $q$update public.agents set areas = '{reclamos,envios}' where id = 'e3e3f0a0-0000-0000-0000-0000000000a2'$q$,
  '^filas=1$');

reset role;

-- ---------------------------------------------------------------------------
-- Caso h · conversations.escalation_area y seba_pedido (como postgres)
-- ---------------------------------------------------------------------------
insert into public.whatsapp_channels (id, label, phone_number) values
  ('e3e3f0a0-1000-0000-0000-000000000001', 'Canal areas', '+580000000095');
insert into public.contacts (id, phone_number) values
  ('e3e3f0a0-2000-0000-0000-000000000001', '+580000000096');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('e3e3f0a0-3000-0000-0000-000000000001', 'e3e3f0a0-2000-0000-0000-000000000001', 'e3e3f0a0-1000-0000-0000-000000000001');

select pg_temp.esperar('h: área de escalada ajena',
  $q$update public.conversations set escalation_area = 'cobranzas' where id = 'e3e3f0a0-3000-0000-0000-000000000001'$q$,
  '^error 23514: .*conversations_escalation_area_check');
select pg_temp.esperar('h: área de escalada válida',
  $q$update public.conversations set escalation_area = 'pagos' where id = 'e3e3f0a0-3000-0000-0000-000000000001'$q$,
  '^filas=1$');
select pg_temp.esperar('h: área de escalada nula',
  $q$update public.conversations set escalation_area = null where id = 'e3e3f0a0-3000-0000-0000-000000000001'$q$,
  '^filas=1$');
select pg_temp.esperar('h: pedido que es un arreglo',
  $q$update public.conversations set seba_pedido = '[]'::jsonb where id = 'e3e3f0a0-3000-0000-0000-000000000001'$q$,
  '^error 23514: .*conversations_seba_pedido_object');
select pg_temp.esperar('h: pedido que es un escalar',
  $q$update public.conversations set seba_pedido = '"texto"'::jsonb where id = 'e3e3f0a0-3000-0000-0000-000000000001'$q$,
  '^error 23514: .*conversations_seba_pedido_object');
select pg_temp.esperar('h: pedido objeto vacío',
  $q$update public.conversations set seba_pedido = '{}'::jsonb where id = 'e3e3f0a0-3000-0000-0000-000000000001'$q$,
  '^filas=1$');
select pg_temp.esperar('h: pedido nulo',
  $q$update public.conversations set seba_pedido = null where id = 'e3e3f0a0-3000-0000-0000-000000000001'$q$,
  '^filas=1$');

-- ---------------------------------------------------------------------------
-- Caso i · el índice existe y agent_settings no ganó políticas
-- ---------------------------------------------------------------------------
do $$
declare
  nombres text;
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'conversations'
       and indexname = 'conversations_escalation_area_idx'
  ) then
    insert into _errores(msg) values ('i: falta el índice conversations_escalation_area_idx.');
  end if;

  select string_agg(policyname, ',' order by policyname) into nombres
    from pg_policies where schemaname = 'public' and tablename = 'agent_settings';
  if nombres is distinct from 'agent_settings_select,agent_settings_update' then
    insert into _errores(msg) values (format('i: agent_settings debía tener solo agent_settings_select y agent_settings_update, y tiene: %s.', coalesce(nombres, 'ninguna')));
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
    raise exception E'seba_v2_configuracion roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'seba_v2_configuracion: todas las aserciones pasaron.'
