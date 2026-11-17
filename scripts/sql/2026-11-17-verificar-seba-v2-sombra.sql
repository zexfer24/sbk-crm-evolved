-- ============================================================================
-- Verificador de la entrega 3 del rework de Seba: Seba v2, sombra y copiloto
-- (17/11/2026)
--
-- Para qué: antes de desplegar el código de `entrega/seba-v2`, comprobar de un
-- solo golpe que la base de producción ya tiene TODO lo que ese código pide.
-- Sin `20261117010000`, la pestaña «Sombra» y la sugerencia de copiloto leen
-- una tabla que no existe (PostgREST responde 400) y el turno de Seba v2 lee y
-- escribe columnas que faltan.
--
-- Es de SOLO LECTURA: no escribe nada. Si algo falta, termina con un error que
-- lista cada cosa; si todo está, imprime la línea final.
--
-- Uso:
--   psql "<url>" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-17-verificar-seba-v2-sombra.sql
--   (o: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < ese archivo)
--
-- Migración que comprueba:
--   20261117010000_seba_v2_sombra.sql
--   20261117020000_sombra_consumo_y_preparacion.sql
--
-- Y, al principio, lo mínimo de las tres migraciones del 16/11 de las que
-- depende (si falta alguna, correr antes
-- scripts/sql/2026-11-16-verificar-seba-v2.sql, que las revisa a fondo):
--   20261116010000_lecturas_de_media.sql
--   20261116020000_formas_de_pago.sql
--   20261116030000_seba_v2_configuracion.sql
-- ============================================================================
do $$
declare
  faltan text[] := '{}';
  v_columna text;
  v_def text;
  v_fn text;
begin
  -- ---------------------------------------------------------------------
  -- Lo mínimo de las migraciones del 16/11 (verificador a fondo: 2026-11-16)
  -- ---------------------------------------------------------------------
  if to_regclass('public.message_readings') is null then
    faltan := array_append(faltan, 'falta la tabla public.message_readings (20261116010000): correr scripts/sql/2026-11-16-verificar-seba-v2.sql'::text);
  end if;
  if to_regclass('public.payment_methods') is null then
    faltan := array_append(faltan, 'falta la tabla public.payment_methods (20261116020000): correr scripts/sql/2026-11-16-verificar-seba-v2.sql'::text);
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'agent_settings' and column_name = 'seba_v2_modo'
  ) then
    faltan := array_append(faltan, 'falta agent_settings.seba_v2_modo (20261116030000): correr scripts/sql/2026-11-16-verificar-seba-v2.sql'::text);
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'conversations' and column_name = 'escalation_area'
  ) then
    faltan := array_append(faltan, 'falta conversations.escalation_area (20261116030000): sin ella la bandeja da 400; correr scripts/sql/2026-11-16-verificar-seba-v2.sql'::text);
  end if;

  -- ---------------------------------------------------------------------
  -- 20261117010000, tabla agent_shadow_drafts
  -- ---------------------------------------------------------------------
  if to_regclass('public.agent_shadow_drafts') is null then
    faltan := array_append(faltan, 'falta la tabla public.agent_shadow_drafts (20261117010000)'::text);
  else
    if not (select relrowsecurity from pg_class where oid = 'public.agent_shadow_drafts'::regclass) then
      faltan := array_append(faltan, 'agent_shadow_drafts no tiene RLS activa'::text);
    end if;
    if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'agent_shadow_drafts') <> 2 then
      faltan := array_append(faltan, 'agent_shadow_drafts debía tener dos políticas (select, update)'::text);
    end if;
    if has_table_privilege('anon', 'public.agent_shadow_drafts', 'select') then
      faltan := array_append(faltan, 'anon puede leer agent_shadow_drafts'::text);
    end if;
    if not has_table_privilege('authenticated', 'public.agent_shadow_drafts', 'select') then
      faltan := array_append(faltan, 'authenticated no puede leer agent_shadow_drafts (el panel y el copiloto no cargarían)'::text);
    end if;
    -- El asesor solo resuelve la sugerencia: UPDATE por columna, nunca de tabla entera.
    if has_column_privilege('authenticated', 'public.agent_shadow_drafts', 'nota', 'update') then
      faltan := array_append(faltan, 'authenticated puede actualizar agent_shadow_drafts.nota: el UPDATE debía ser solo por las columnas de la sugerencia'::text);
    end if;
    if not has_column_privilege('authenticated', 'public.agent_shadow_drafts', 'sugerencia_estado', 'update') then
      faltan := array_append(faltan, 'authenticated no puede resolver la sugerencia (sugerencia_estado)'::text);
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_shadow_drafts'
    ) then
      faltan := array_append(faltan, 'agent_shadow_drafts no está publicada en supabase_realtime: la sugerencia de copiloto no llegaría en vivo'::text);
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- 20261117010000, tabla shadow_reviews
  -- ---------------------------------------------------------------------
  if to_regclass('public.shadow_reviews') is null then
    faltan := array_append(faltan, 'falta la tabla public.shadow_reviews (20261117010000)'::text);
  else
    if not (select relrowsecurity from pg_class where oid = 'public.shadow_reviews'::regclass) then
      faltan := array_append(faltan, 'shadow_reviews no tiene RLS activa'::text);
    end if;
    if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'shadow_reviews') <> 4 then
      faltan := array_append(faltan, 'shadow_reviews debía tener cuatro políticas'::text);
    end if;
    if has_table_privilege('anon', 'public.shadow_reviews', 'select') then
      faltan := array_append(faltan, 'anon puede leer shadow_reviews'::text);
    end if;
    if not has_table_privilege('authenticated', 'public.shadow_reviews', 'select') then
      faltan := array_append(faltan, 'authenticated no puede leer shadow_reviews'::text);
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- 20261117010000, funciones
  -- ---------------------------------------------------------------------
  -- shadow_can_run(): solo service_role (la llama el webhook y el turno).
  v_fn := 'public.shadow_can_run()';
  if to_regprocedure(v_fn) is null then
    faltan := array_append(faltan, 'falta la función public.shadow_can_run() (20261117010000)'::text);
  else
    if has_function_privilege('anon', v_fn, 'execute') then
      faltan := array_append(faltan, 'anon puede ejecutar shadow_can_run()'::text);
    end if;
    if has_function_privilege('authenticated', v_fn, 'execute') then
      faltan := array_append(faltan, 'authenticated puede ejecutar shadow_can_run(): debía ser solo de service_role'::text);
    end if;
    if not has_function_privilege('service_role', v_fn, 'execute') then
      faltan := array_append(faltan, 'service_role no puede ejecutar shadow_can_run(): el webhook no podría decidir la sombra'::text);
    end if;
  end if;

  -- shadow_spend_today(): el panel la lee con sesión de supervisor.
  v_fn := 'public.shadow_spend_today()';
  if to_regprocedure(v_fn) is null then
    faltan := array_append(faltan, 'falta la función public.shadow_spend_today() (20261117010000)'::text);
  else
    if has_function_privilege('anon', v_fn, 'execute') then
      faltan := array_append(faltan, 'anon puede ejecutar shadow_spend_today()'::text);
    end if;
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      faltan := array_append(faltan, 'authenticated no puede ejecutar shadow_spend_today(): el panel «Sombra» no mostraría el gasto'::text);
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- 20261117010000, columnas nuevas
  -- ---------------------------------------------------------------------
  foreach v_columna in array array['agent_version', 'escalation_motivo', 'escalation_area'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'agent_turns' and column_name = v_columna
    ) then
      faltan := array_append(faltan, format('falta agent_turns.%s (20261117010000)', v_columna)::text);
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'agent_turn_calls' and column_name = 'model'
  ) then
    faltan := array_append(faltan, 'falta agent_turn_calls.model (20261117010000)'::text);
  end if;

  -- El CHECK del carrito tiene que aceptar el origen 'seba'.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.conversation_cart_items'::regclass
     and conname = 'conversation_cart_items_origin_check';
  if v_def is null then
    faltan := array_append(faltan, 'falta el CHECK conversation_cart_items_origin_check'::text);
  elsif v_def not like '%seba%' then
    faltan := array_append(faltan, 'el CHECK de conversation_cart_items.origin no acepta ''seba'': Seba v2 no podría guardar su carrito'::text);
  end if;

  -- 20261117020000: el resumen de consumo y preparación de la pestaña «Sombra».
  if to_regprocedure('public.sombra_resumen(timestamptz, timestamptz)') is null then
    faltan := array_append(faltan, 'falta la función public.sombra_resumen(timestamptz, timestamptz) (20261117020000)'::text);
  else
    if has_function_privilege('anon', 'public.sombra_resumen(timestamptz, timestamptz)', 'execute') then
      faltan := array_append(faltan, 'anon puede ejecutar sombra_resumen()'::text);
    end if;
    if not has_function_privilege('authenticated', 'public.sombra_resumen(timestamptz, timestamptz)', 'execute') then
      faltan := array_append(faltan, 'authenticated no puede ejecutar sombra_resumen(): el panel no podría leerla'::text);
    end if;
  end if;

  if cardinality(faltan) > 0 then
    raise exception E'La base NO está lista para el código de entrega/seba-v2 (% cosa(s)):\n  - %',
      cardinality(faltan), array_to_string(faltan, E'\n  - ');
  end if;
end $$;

\echo 'verificar-seba-v2-sombra: la base tiene todo lo que el código de la entrega 3 pide. Se puede desplegar.'
