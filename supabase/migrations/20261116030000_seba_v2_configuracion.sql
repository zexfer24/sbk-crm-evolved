-- ============================================================================
-- Configuración de Seba v2, áreas del asesor y estado del pedido (T2, plan
-- "Entrega 2 de Seba v2: los datos del negocio", 16/11/2026)
--
-- Qué es: la base guarda lo que Seba v2 necesita configurable antes de que la
-- entrega 3 lo lea. Hasta esta fecha nada de esto existía: los textos de
-- bienvenida y de Cashea vivían en mensajes rápidos y en la cabeza de los
-- asesores, y nada decía qué asesor atiende qué tipo de caso. Esta migración
-- solo agrega columnas; NADIE las lee ni las escribe todavía (la entrega 3 las
-- conecta), así que aplicarla antes que el código no cambia ningún
-- comportamiento.
--
-- 1. `agent_settings` (UNA sola fila, `agent_settings_singleton`):
--      · `seba_v2_modo`: apagado | sombra | copiloto | fuera_de_horario |
--        siempre. Nace `apagado`; hasta la entrega 3 nadie lo lee.
--      · `shadow_daily_cap_usd` / `shadow_sample_pct`: topes del modo sombra
--        (Seba v2 redacta en paralelo sin enviar; el tope diario de gasto y el
--        porcentaje de turnos que se muestrean).
--      · `welcome_text` y `welcome_followups`: la bienvenida aprobada el
--        16/11/2026 (decisión D6) y las frases de seguimiento cuando el cliente
--        solo saludó (decisión D7); los defaults son los textos de
--        `docs/seba-v2/system-prompt-seba-v2.md`, sección "3. Textos fijos", y
--        `src/lib/seba-v2-defaults.test.ts` exige que sigan idénticos.
--      · `cashea_datos_text`, `cashea_minimo_usd`,
--        `cashea_seis_cuotas_desde_usd`: el texto con los datos que se piden
--        para generar el enlace de Cashea y los dos montos de la calculadora.
--    Las políticas vigentes (`agent_settings_select` con `is_agent()`,
--    `agent_settings_update` con `is_supervisor_or_admin()` en using y with
--    check) ya cubren las columnas nuevas: NO se crean políticas.
--
-- 2. `agents.areas` (pagos | ventas | envios | reclamos): qué tipos de caso
--    atiende cada asesor. Decisión D2 del operador: todos nacen en las cuatro.
--    Un arreglo vacío es válido (un supervisor que no toma casos).
--    HUECO que esto cierra en el mismo paso: `agents_update_self` deja que un
--    asesor actualice SU fila, y con una columna nueva podría cambiarse él
--    mismo las áreas. Se amplía el trigger `agents_role_guard` (T7b,
--    20260928050000) para que cambiar `areas` exija supervisor/admin. La
--    función sigue siendo `security invoker` A PROPÓSITO (con `definer`,
--    `current_user` sería siempre el dueño y no frenaría a nadie) y por eso
--    no entra al guardián `permisos-funciones.test.ts`.
--
-- 3. `conversations.escalation_area` (a qué área escaló Seba; la escribirá la
--    escalada de Seba v2 en la entrega 3) y `conversations.seba_pedido` (el
--    estado del pedido que arma Seba; su forma la define la entrega 3, aquí
--    solo se exige que sea un objeto JSON). Quedan bajo la política única
--    `conversations_all` (cualquier `is_agent()` escribe cualquier columna): se
--    acepta, y NO se agregan políticas ni triggers a `conversations`. El índice
--    parcial sigue el patrón de `conversations_mine_idx` para la píldora "Área"
--    de la bandeja; como `escalation_area` nace nula en todas las filas, el
--    índice nace vacío y se construye al instante.
--
-- Orden del DDL: lo que retiene un lock más tiempo (el índice de
-- `conversations`) va al final.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso, y `agents` la
-- leen todas las políticas vía `is_agent()`.
--
-- Idempotente: se puede aplicar dos veces sin fallar.
-- ============================================================================
set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. agent_settings
-- ---------------------------------------------------------------------------
alter table public.agent_settings
  add column if not exists seba_v2_modo text not null default 'apagado',
  add column if not exists shadow_daily_cap_usd numeric(8,2) not null default 5,
  add column if not exists shadow_sample_pct integer not null default 100,
  add column if not exists welcome_text text not null default E'¡Hola! Bienvenido a *SBK Motors* 🏍️\nRepuestos, cascos y accesorios para tu moto, con envíos a todo el país.\n\n💳 Compra con *Cashea*: envío gratis por MRW\n💵 También aceptamos pago móvil, transferencia y Binance\n📍 Barinas · L-S 8:30 am a 7:30 pm, D 9:00 am a 4:30 pm',
  add column if not exists welcome_followups text[] not null default array['Cuéntame, ¿qué andas buscando para tu moto?','¿Qué repuesto o accesorio necesitas? Te lo reviso de una vez','Dime en qué te ayudamos y te confirmo precio y disponibilidad','¿Buscas algo para tu moto o un casco?']::text[],
  add column if not exists cashea_datos_text text not null default E'Para generar tu link de compra necesito estos datos:\n✅ Nombre y apellido del titular de Cashea\n✅ Cédula del titular\n✅ Número de teléfono\n✅ Entrega: envío, delivery o retiro en tienda\n\nCon eso un asesor te envía el link por este mismo chat 🙌',
  add column if not exists cashea_minimo_usd numeric(8,2) not null default 25,
  add column if not exists cashea_seis_cuotas_desde_usd numeric(8,2) not null default 100;

alter table public.agent_settings drop constraint if exists agent_settings_seba_v2_modo_check;
alter table public.agent_settings add constraint agent_settings_seba_v2_modo_check
  check (seba_v2_modo in ('apagado', 'sombra', 'copiloto', 'fuera_de_horario', 'siempre'));

alter table public.agent_settings drop constraint if exists agent_settings_shadow_daily_cap_check;
alter table public.agent_settings add constraint agent_settings_shadow_daily_cap_check
  check (shadow_daily_cap_usd >= 0);

alter table public.agent_settings drop constraint if exists agent_settings_shadow_sample_pct_check;
alter table public.agent_settings add constraint agent_settings_shadow_sample_pct_check
  check (shadow_sample_pct between 0 and 100);

alter table public.agent_settings drop constraint if exists agent_settings_welcome_text_length;
alter table public.agent_settings add constraint agent_settings_welcome_text_length
  check (char_length(welcome_text) between 1 and 1000);

-- "Cada frase <= 160" exacto no cabe en un CHECK sin una función: la base acota
-- la cantidad (2 a 8), que no haya frases vacías ni nulas, y el largo TOTAL
-- (8 x 160 = 1280); el tope por frase lo valida la app
-- (`src/lib/seba-v2-config.ts`, tarea siguiente). El mínimo de 2 existe porque
-- el turno elige una frase distinta de la última usada en ese chat.
alter table public.agent_settings drop constraint if exists agent_settings_welcome_followups_check;
alter table public.agent_settings add constraint agent_settings_welcome_followups_check
  check (
    array_ndims(welcome_followups) = 1
    and cardinality(welcome_followups) between 2 and 8
    and array_position(welcome_followups, null) is null
    and array_position(welcome_followups, '') is null
    and char_length(array_to_string(welcome_followups, '')) <= 1280
  );

alter table public.agent_settings drop constraint if exists agent_settings_cashea_datos_text_length;
alter table public.agent_settings add constraint agent_settings_cashea_datos_text_length
  check (char_length(cashea_datos_text) between 1 and 1000);

alter table public.agent_settings drop constraint if exists agent_settings_cashea_montos_check;
alter table public.agent_settings add constraint agent_settings_cashea_montos_check
  check (cashea_minimo_usd >= 0 and cashea_seis_cuotas_desde_usd >= 0);

comment on column public.agent_settings.seba_v2_modo is
  'Modo de Seba v2 (T2, plan "Entrega 2 de Seba v2", 16/11/2026): apagado | sombra | copiloto | fuera_de_horario | siempre. Nace `apagado` y NADIE lo lee hasta la entrega 3: cambiarlo hoy no altera ningún comportamiento.';
comment on column public.agent_settings.shadow_daily_cap_usd is
  'Tope diario de gasto, en USD, del modo sombra de Seba v2 (Seba redacta en paralelo sin enviar). >= 0. Nadie lo lee hasta la entrega 3.';
comment on column public.agent_settings.shadow_sample_pct is
  'Porcentaje (0 a 100) de turnos que el modo sombra de Seba v2 muestrea. Nadie lo lee hasta la entrega 3.';
comment on column public.agent_settings.welcome_text is
  'Bienvenida de Seba v2, mensaje 1 (informativo; sale una vez por ventana de 24 h). Texto aprobado el 16/11/2026 (decisión D6); el default es el de docs/seba-v2/system-prompt-seba-v2.md, sección 3. 1 a 1000 caracteres.';
comment on column public.agent_settings.welcome_followups is
  'Frases del mensaje 2 de la bienvenida, cuando el cliente solo saludó (decisión D7): el turno elige una distinta de la última usada en ese chat, de ahí el mínimo de 2. 2 a 8 frases sin vacíos ni nulos y 1280 caracteres en total; el tope de 160 por frase lo valida la app.';
comment on column public.agent_settings.cashea_datos_text is
  'Texto con los datos que se piden al cliente para generar su enlace de Cashea (lo envía Seba v2; el enlace lo manda el asesor, decisión D1). 1 a 1000 caracteres. Default: el del mensaje rápido "Combo Cashea".';
comment on column public.agent_settings.cashea_minimo_usd is
  'Monto mínimo, en USD, para ofrecer Cashea. >= 0. Nadie lo lee hasta la entrega 3.';
comment on column public.agent_settings.cashea_seis_cuotas_desde_usd is
  'Monto, en USD, desde el cual Cashea ofrece seis cuotas. >= 0. Nadie lo lee hasta la entrega 3.';

-- ---------------------------------------------------------------------------
-- 2. agents.areas y el trigger que impide que un asesor se las cambie
-- ---------------------------------------------------------------------------
alter table public.agents
  add column if not exists areas text[] not null default '{pagos,ventas,envios,reclamos}';

alter table public.agents drop constraint if exists agents_areas_check;
alter table public.agents add constraint agents_areas_check
  check (areas <@ array['pagos', 'ventas', 'envios', 'reclamos']::text[]);

comment on column public.agents.areas is
  'Áreas de casos que atiende el asesor (T2, plan "Entrega 2 de Seba v2", 16/11/2026): subconjunto de pagos, ventas, envios, reclamos. Todos nacen en las cuatro (decisión D2); vacío es válido (un supervisor que no toma casos). Solo un supervisor/admin las cambia (trigger agents_role_guard), no el propio asesor.';

-- Cuerpo EXACTO de 20260928050000 más la rama de `areas` antes del `return`
-- final: bypass de postgres/supabase_admin/service_role, rama del `id` y rama
-- del `role` con la regla de admin quedan idénticos.
create or replace function public.enforce_agents_role_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Migraciones, Studio, scripts del VPS y el cliente admin de la app.
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception 'No se puede cambiar el id de un agente (public.agents.id).'
      using errcode = 'insufficient_privilege';
  end if;

  if new.role is distinct from old.role then
    if not public.is_supervisor_or_admin() then
      raise exception 'Solo un supervisor o admin puede cambiar el rol de un agente (public.agents.role).'
        using errcode = 'insufficient_privilege';
    end if;

    -- Otorgar o quitar 'admin' es cosa de un admin. is_supervisor_or_admin()
    -- ya dejó claro que quien escribe es un agente, así que puede leer su
    -- propia fila bajo RLS.
    if (new.role = 'admin' or old.role = 'admin')
       and not exists (
         select 1 from public.agents
          where id = auth.uid() and role = 'admin'
       ) then
      raise exception 'Solo un admin puede otorgar o quitar el rol admin (public.agents.role).'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- 16/11/2026 (T2, "Entrega 2 de Seba v2"): las áreas que atiende un asesor
  -- las decide un supervisor/admin, no el propio asesor. `agents_update_self`
  -- le deja actualizar su fila y sin esta rama podría darse o quitarse áreas.
  -- Re-escribir las mismas áreas no es un cambio y pasa.
  if new.areas is distinct from old.areas then
    if not public.is_supervisor_or_admin() then
      raise exception 'Solo un supervisor o admin puede cambiar las áreas de un agente (public.agents.areas).'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_agents_role_guard() is
  'Trigger BEFORE UPDATE OF role, id, areas sobre public.agents (T7b, 28/9/2026; areas desde T2, 16/11/2026): un agente no se asciende solo. Rechaza cambiar el id, y cambiar el rol o las áreas sin ser supervisor/admin; otorgar o quitar admin exige ser admin. postgres/supabase_admin/service_role pasan. SECURITY INVOKER a propósito (current_user debe ser el del llamador).';

drop trigger if exists agents_role_guard on public.agents;
create trigger agents_role_guard
  before update of role, id, areas on public.agents
  for each row execute function public.enforce_agents_role_guard();

-- ---------------------------------------------------------------------------
-- 3. conversations (al final: el índice es lo que más retiene su lock)
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column if not exists escalation_area text,
  add column if not exists seba_pedido jsonb;

alter table public.conversations drop constraint if exists conversations_escalation_area_check;
alter table public.conversations add constraint conversations_escalation_area_check
  check (escalation_area is null or escalation_area in ('pagos', 'ventas', 'envios', 'reclamos'));

alter table public.conversations drop constraint if exists conversations_seba_pedido_object;
alter table public.conversations add constraint conversations_seba_pedido_object
  check (seba_pedido is null or jsonb_typeof(seba_pedido) = 'object');

comment on column public.conversations.escalation_area is
  'Área a la que escaló Seba v2 (pagos, ventas, envios, reclamos) o null (T2, plan "Entrega 2 de Seba v2", 16/11/2026). La escribirá la escalada de Seba v2 en la entrega 3; hoy nadie la escribe.';
comment on column public.conversations.seba_pedido is
  'Estado del pedido que arma Seba v2 en esta conversación, un objeto JSON o null (T2, 16/11/2026). Su forma la define la entrega 3; hoy nadie lo escribe, la base solo exige que sea un objeto.';

-- Mismo patrón que `conversations_mine_idx`: parcial, ordenado como la lista de
-- la bandeja, para la píldora "Área".
create index if not exists conversations_escalation_area_idx
  on public.conversations (escalation_area, last_message_at desc nulls last, id desc)
  where escalation_area is not null;

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
declare
  faltan text;
begin
  select string_agg(esperada.tabla || '.' || esperada.columna, ', ') into faltan
    from (values
      ('agent_settings', 'seba_v2_modo'),
      ('agent_settings', 'shadow_daily_cap_usd'),
      ('agent_settings', 'shadow_sample_pct'),
      ('agent_settings', 'welcome_text'),
      ('agent_settings', 'welcome_followups'),
      ('agent_settings', 'cashea_datos_text'),
      ('agent_settings', 'cashea_minimo_usd'),
      ('agent_settings', 'cashea_seis_cuotas_desde_usd'),
      ('agents', 'areas'),
      ('conversations', 'escalation_area'),
      ('conversations', 'seba_pedido')
    ) as esperada(tabla, columna)
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = esperada.tabla
        and c.column_name = esperada.columna
   );
  if faltan is not null then
    raise exception '20261116030000: faltan columnas: %', faltan;
  end if;

  -- No se afirma el VALOR de seba_v2_modo: una segunda aplicación después de
  -- que el operador lo cambió abortaría. Solo que la fila existe y no tiene nulos.
  if not exists (
    select 1 from public.agent_settings
     where seba_v2_modo is not null and welcome_text is not null and welcome_followups is not null
  ) then
    raise exception '20261116030000: la fila de agent_settings quedó con seba_v2_modo, welcome_text o welcome_followups nulos (o no existe)';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.agents'::regclass
       and tgname = 'agents_role_guard'
       and not tgisinternal
       and pg_get_triggerdef(oid) like '%areas%'
  ) then
    raise exception '20261116030000: el trigger agents_role_guard no incluye areas en su UPDATE OF';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'conversations'
       and indexname = 'conversations_escalation_area_idx'
  ) then
    raise exception '20261116030000: falta el índice conversations_escalation_area_idx';
  end if;
end $$;

notify pgrst, 'reload schema';
