-- ============================================================================
-- Verificador de las entregas 1 y 2 del rework de Seba (16/11/2026)
--
-- Para qué: antes de avanzar `main`, comprobar de un solo golpe que la base de
-- producción ya tiene TODO lo que el código nuevo pide. Con el código de
-- `entrega/seba-v2-datos` y sin estas migraciones, la bandeja entera responde
-- 400 (falta `conversations.escalation_area`) y el chat no carga mensajes
-- (falta `message_readings`).
--
-- Es de SOLO LECTURA: no escribe nada. Si algo falta, termina con un error que
-- lista cada cosa; si todo está, imprime la línea final.
--
-- Uso:
--   psql "<url>" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-16-verificar-seba-v2.sql
--
-- Migraciones que comprueba, en el orden en que se aplican:
--   20261116010000_lecturas_de_media.sql
--   20261116020000_formas_de_pago.sql
--   20261116030000_seba_v2_configuracion.sql
-- ============================================================================
do $$
declare
  faltan text[] := '{}';
  v_columna text;
  v_def text;
begin
  -- 20261116010000: lectura de fotos y audios.
  if to_regclass('public.message_readings') is null then
    faltan := array_append(faltan, 'falta la tabla public.message_readings (20261116010000)'::text);
  elsif not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_readings'
  ) then
    faltan := array_append(faltan, 'message_readings no está publicada en supabase_realtime (20261116010000)'::text);
  end if;

  -- 20261116020000: formas de pago.
  if to_regclass('public.payment_methods') is null then
    faltan := array_append(faltan, 'falta la tabla public.payment_methods (20261116020000)'::text);
  else
    if not (select relrowsecurity from pg_class where oid = 'public.payment_methods'::regclass) then
      faltan := array_append(faltan, 'payment_methods no tiene RLS activa'::text);
    end if;
    if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'payment_methods') <> 4 then
      faltan := array_append(faltan, 'payment_methods debía tener cuatro políticas'::text);
    end if;
    if has_table_privilege('anon', 'public.payment_methods', 'select') then
      faltan := array_append(faltan, 'anon puede leer payment_methods'::text);
    end if;
    if not has_table_privilege('authenticated', 'public.payment_methods', 'select') then
      faltan := array_append(faltan, 'authenticated no puede leer payment_methods'::text);
    end if;
  end if;

  -- 20261116030000: configuración de Seba v2, áreas y pedido.
  foreach v_columna in array array[
    'seba_v2_modo', 'shadow_daily_cap_usd', 'shadow_sample_pct', 'welcome_text',
    'welcome_followups', 'cashea_datos_text', 'cashea_minimo_usd', 'cashea_seis_cuotas_desde_usd'
  ] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'agent_settings' and column_name = v_columna
    ) then
      faltan := array_append(faltan, format('falta agent_settings.%s (20261116030000)', v_columna)::text);
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'agents' and column_name = 'areas'
  ) then
    faltan := array_append(faltan, 'falta agents.areas (20261116030000)'::text);
  end if;

  foreach v_columna in array array['escalation_area', 'seba_pedido'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'conversations' and column_name = v_columna
    ) then
      faltan := array_append(faltan, format('falta conversations.%s (20261116030000): sin ella la bandeja da 400', v_columna)::text);
    end if;
  end loop;

  select pg_get_triggerdef(oid) into v_def
    from pg_trigger
   where tgrelid = 'public.agents'::regclass and tgname = 'agents_role_guard' and not tgisinternal;
  if v_def is null then
    faltan := array_append(faltan, 'falta el trigger agents_role_guard'::text);
  elsif v_def not like '%areas%' then
    faltan := array_append(faltan, 'el trigger agents_role_guard no cubre areas: un asesor podría cambiarse las suyas'::text);
  end if;

  if to_regclass('public.conversations_escalation_area_idx') is null then
    faltan := array_append(faltan, 'falta el índice conversations_escalation_area_idx'::text);
  end if;

  if cardinality(faltan) > 0 then
    raise exception E'La base NO está lista para el código de entrega/seba-v2-datos (% cosa(s)):\n  - %',
      cardinality(faltan), array_to_string(faltan, E'\n  - ');
  end if;
end $$;

\echo 'verificar-seba-v2: la base tiene todo lo que el código pide. Se puede avanzar main.'
