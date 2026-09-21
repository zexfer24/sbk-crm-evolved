-- ============================================================================
-- Tarea T1 · plan "El catálogo configurado sale siempre" (aprobado 21/9/2026).
--
-- Contexto (reporte de solo lectura de producción, VPS, 21/9/2026 00:49 VET,
-- producción en `3802fad`, base en `20260915010000`): "CATALOGO CASCOS" salió
-- 535 veces y "Catálogo general" 161 en 15 días -- el 30 % de todas las
-- respuestas predeterminadas, segundo motivo de contacto. El código pendiente
-- de desplegar trae H1 ("el repuesto manda", 18/9/2026, `agent.ts`): con
-- intención `consulta_disponibilidad` un escenario calzado se CEDE al
-- inventario, sin mirar si `buscar_repuesto` está encendido -- y esa
-- herramienta está APAGADA en producción desde el 25/8/2026. Desplegar tal
-- cual dejaría sin su PDF a casi todos esos pedidos ("precios de los cascos",
-- "me envías el catálogo" -> disponibilidad -> cedido a un inventario apagado
-- -> "un asesor te lo confirma" + escalada, en vez del catálogo que el
-- escenario ya traía redactado).
--
-- La regla nueva (plan, "La regla"): un escenario calzado se cede al
-- inventario solo si se cumplen LAS CUATRO condiciones -- intención
-- `consulta_disponibilidad`, `buscar_repuesto` encendida, el cliente no pidió
-- el catálogo explícitamente, Y el escenario está marcado para cederlo. Esta
-- columna es la cuarta condición: nace en `false` a propósito, así que
-- NINGÚN escenario existente cambia de comportamiento el día del deploy --
-- el supervisor marca a mano, desde el panel (T4 de este mismo plan, código
-- aparte), cuáles escenarios sí deben ceder (según el plan, solo "Catálogo
-- general"). Sin backfill: el DEFAULT `false` ya cubre todas las filas
-- existentes, no hace falta ningún UPDATE.
--
-- RLS: no cambia. `ai_playbooks_select`/`ai_playbooks_write`
-- (20260821010000) ya cubren la tabla entera -- cualquier asesor lee,
-- solo supervisor/admin escribe -- y una columna nueva hereda esa misma
-- política sin declarar nada más; no hace falta tocar `pg_policies`.
--
-- ESTA MIGRACIÓN TIENE QUE APLICARSE DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que 20260916010000/
-- 20260917010000/20260917020000/20260918010000/20260918020000 (revisión
-- "Seba sale sin pisar a nadie", 19/9/2026, tarea T5): `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso -- en
-- autocommit cada sentencia corre en su propia transacción implícita y el
-- tope de acá abajo quedaría en 0 (sin tope) para el `alter table ... add
-- column` sobre `ai_playbooks`, tabla que el turno de la IA lee en cada
-- fase 0. En la inspección previa al despliegue del 19/9/2026 se midió un
-- INSERT del webhook encolado 6,9 s detrás del lock de una migración
-- parecida.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` -- mismo motivo y misma
-- verificación que las cinco migraciones de arriba (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): sin `psql -1` esto corre con
-- `lock_timeout = 0` sin que `ON_ERROR_STOP` lo note (un warning, no un
-- error), así que falla cerrado acá. `PGOPTIONS="-c lock_timeout=5s"` sin
-- `-1` también pasa: hay un tope real, no es el no-op.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

alter table public.ai_playbooks
  add column cede_al_inventario boolean not null default false;

comment on column public.ai_playbooks.cede_al_inventario is
  'Cuarta condición de "el repuesto manda" (H1, 18/9/2026) para que un escenario calzado se ceda al inventario real en vez de mandar su texto predeterminado -- las otras tres son código, no dato: intención clasificada `consulta_disponibilidad`, la herramienta `buscar_repuesto` encendida, y que el cliente no haya pedido el catálogo explícitamente (`pideCatalogo`, `catalog-request.ts`). Nace en `false` (plan "El catálogo configurado sale siempre", 21/9/2026): producción medía "CATALOGO CASCOS"/"Catálogo general" como el 30 % de las respuestas predeterminadas en 15 días, y desplegar H1 tal cual -- con `buscar_repuesto` apagado desde el 25/8/2026 -- habría cedido esos pedidos a un inventario apagado en vez de mandarles el PDF que el escenario ya trae redactado. El supervisor marca esta casilla a mano, desde el panel, escenario por escenario (T4 del mismo plan): según el plan, solo "Catálogo general" la lleva en `true`.';

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (information_schema), no el texto
-- de este archivo -- mismo criterio que 20260918010000/20260918020000 (ver
-- CLAUDE.md, "Cerrar una función security definer...": el mismo principio de
-- no confiar en el .sql aplica a cualquier verificación de esquema).
-- ---------------------------------------------------------------------------
do $$
declare
  col_exists boolean;
  col_nullable text;
  col_default text;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_playbooks'
      and column_name = 'cede_al_inventario'
  ) into col_exists;

  if not col_exists then
    raise exception '20260921010000: public.ai_playbooks.cede_al_inventario no quedó creada';
  end if;

  select is_nullable, column_default into col_nullable, col_default
    from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_playbooks'
      and column_name = 'cede_al_inventario';

  if col_nullable is distinct from 'NO' then
    raise exception '20260921010000: ai_playbooks.cede_al_inventario debía quedar NOT NULL, encontró is_nullable = %', col_nullable;
  end if;

  if col_default is distinct from 'false' then
    raise exception '20260921010000: ai_playbooks.cede_al_inventario debía tener DEFAULT false, encontró column_default = %', col_default;
  end if;

  raise notice '20260921010000: autoverificación de ai_playbooks.cede_al_inventario (columna not null, default false) correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la columna nueva
-- da 400 hasta que alguien lo recargue a mano -- revisión "Seba sale sin
-- pisar a nadie" (19/9/2026, tarea T5, hallazgo M1).
notify pgrst, 'reload schema';
