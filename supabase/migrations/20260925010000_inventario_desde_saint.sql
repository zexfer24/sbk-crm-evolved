-- ============================================================================
-- Tarea T1 · plan "El inventario llega de Saint y no se toca a mano"
-- (aprobado 25/9/2026).
--
-- Contexto (medido el 24-25/9/2026): `public.products` se cargó una sola vez
-- el 24/8/2026 y quedó congelada -- precios 13,4 % por debajo de Saint, 602
-- códigos que la IA no conoce, 24 nombres viejos -- mientras la réplica
-- Liminal ya copia SAPROD de Saint en vivo (rol `liminal_replicator`, UPSERT
-- por `codprod`, hoy en `public.saprod`, pronto en `saint.saprod`) y
-- cualquier asesor logueado puede hoy cambiar stock/precio o borrar
-- productos llamando a la API directo. Esta migración hace de Saint el único
-- dueño del inventario: `saint.sync_products()`, corrida cada minuto por
-- pg_cron, es la ÚNICA vía de escritura real; la base (grants + un candado
-- por trigger) impide editar `products` a mano salvo el peso, que queda
-- auditado en `public.product_weight_audit`.
--
-- pg_cron y no un trigger sobre `saprod`: un trigger correría DENTRO de la
-- transacción del agente replicador y, si fallara, bloquearía la réplica en
-- vivo -- un job de cron es independiente, idempotente (compara con
-- IS DISTINCT FROM, no reescribe lo que no cambió) y se pone al día solo en
-- el peor de los casos (un minuto de atraso).
--
-- Producto de esta migración: dos columnas nuevas de vínculo con Saint
-- (`saint_code`/`saint_added_at`/`saint_removed_at`), el esquema `saint`
-- con su bitácora `sync_log`, la función `saint.sync_products()` (con la
-- guarda del operador: solo cuenta para el freno lo que DESAPARECE de la
-- fuente, nunca lo que Saint marca `activo <> 1` a propósito), los dos
-- triggers del candado y los dos jobs de pg_cron.
--
-- Requisito de producción (documentado acá, la entrega -- T4 del mismo
-- plan -- trae la consulta de verificación): el dueño de `sync_products`
-- (`postgres`) tiene que poder hacer SELECT sobre `saint.saprod`/
-- `public.saprod` y sobre `liminal.*` -- tablas de `liminal_replicator`,
-- con RLS activada por el event trigger del esquema `saint` en producción.
-- Si no puede, la función NO lanza: el error queda en `sync_log.error`.
--
-- Patrón de las migraciones recientes (20260921040000, 20260918020000):
-- `set local lock_timeout` + guarda contra el no-op silencioso de `set
-- local` fuera de una transacción + autoverificación contra el catálogo
-- real + `notify pgrst` al final. Con `psql -1` la migración entera es una
-- transacción: el ACCESS EXCLUSIVE de los `alter table` sobre `products`
-- dura hasta el COMMIT, carga inicial incluida -- la IA no lee `products`
-- durante TODO ese tiempo. Por eso T1 mide la migración completa con
-- volumen real y el número va en la entrega al VPS.
-- ============================================================================
set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. pg_cron -- ya está en shared_preload_libraries de esta imagen de
--    Supabase (event trigger `issue_pg_cron_access`, dueño `supabase_admin`,
--    que concede acceso al esquema `cron` tras crear la extensión). `with
--    schema extensions` sigue la convención de Supabase para extensiones,
--    aunque pg_cron ignora esa cláusula en la práctica y crea su propio
--    esquema `cron` de todas formas (verificado en local: `extnamespace`
--    queda en `pg_catalog` con o sin la cláusula) -- no hace daño dejarla.
--    `if not exists`: esta migración puede reaplicarse sobre una base que
--    ya tenga la extensión (reintentos de CI, entornos reseteados a medias).
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. products: tres columnas de vínculo con Saint. `saint_code` se
--    backfillea desde `description` con la forma exacta que ya usa el
--    catálogo cargado el 24/8/2026 ("Código ERP: <codprod>") -- `products`
--    no tiene columna de código propia, vive ahí. Índice único parcial
--    (where not null): dos productos nunca deberían compartir el mismo
--    código de Saint, pero un producto sin vínculo (los 5 del seed, o
--    cualquier fila cargada a mano antes de esta ola) sigue sin restricción.
-- ---------------------------------------------------------------------------
alter table public.products
  add column saint_code text,
  add column saint_added_at timestamptz,
  add column saint_removed_at timestamptz;

comment on column public.products.saint_code is
  'El codprod de Saint (SAPROD.codprod) que identifica este producto en el sistema administrativo del negocio -- la fuente real del inventario desde esta migración (T1, plan "El inventario llega de Saint y no se toca a mano", 25/9/2026). Se backfillea desde description (formato exacto "Código ERP: <codprod>", el único lugar donde vivía el código antes de esta migración) y de ahí en más lo escribe saint.sync_products() al insertar productos nuevos. null = producto sin vínculo con Saint (los 5 del seed local, o cualquier fila cargada a mano antes de esta ola): saint.sync_products() nunca lo toca ni lo da de baja.';
comment on column public.products.saint_added_at is
  'Cuándo saint.sync_products() insertó este producto por primera vez desde Saint. Nullable, sin backfill: no hay forma de reconstruir cuándo entró un producto ya cargado el 24/8/2026 -- mismo criterio que weight_kg (20260909030000). Usado por isNewFromSaint() (inventory.ts, T2 del mismo plan) para el badge "Nuevo desde Saint" (7 días).';
comment on column public.products.saint_removed_at is
  'Cuándo saint.sync_products() detectó que este producto YA NO aparece en Saint (dado de baja por ausencia). null mientras el producto siga en Saint o nunca haya estado vinculado. Un producto que Saint marca activo=0 mientras SIGUE presente en la fuente NO sella esta columna -- decisión explícita del operador (25/9/2026): "activo<>1" es una baja administrativa de Saint, no una desaparición; is_active pasa a false igual, pero saint_removed_at queda null.';

create unique index products_saint_code_idx on public.products (saint_code) where saint_code is not null;

comment on index public.products_saint_code_idx is 'Un código de Saint identifica UN producto. Parcial (where not null) porque los productos sin vínculo (seed local, carga manual previa a esta ola) no tienen código que deba ser único entre sí.';

update public.products
set saint_code = substring(description from '^Código ERP: (.+)$')
where saint_code is null
  and description ~ '^Código ERP: (.+)$';

-- ---------------------------------------------------------------------------
-- 3. Esquema saint + bitácora de corridas. `sync_log` es de uso interno
--    exclusivo -- revoke all explícito de anon/authenticated/service_role
--    (aunque un esquema nuevo no hereda el `alter default privileges` que
--    Supabase deja en `public`, verificado en local contra pg_default_acl:
--    esta migración no confía en esa ausencia, la deja explícita como el
--    resto del repo). RLS habilitada sin ninguna política, mismo criterio
--    que agent_turn_calls (20260921040000): nadie la lee por la API, ni
--    siquiera con una RPC -- el VPS la consulta por psql directo.
-- ---------------------------------------------------------------------------
create schema if not exists saint;

comment on schema saint is 'Todo lo que pertenece a la sincronización del inventario contra Saint (el sistema administrativo del negocio) -- separado de public porque nada de acá se expone por la API. Nace en la migración 20260925010000 (T1, plan "El inventario llega de Saint y no se toca a mano", 25/9/2026).';

create table saint.sync_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  fuente text,
  duracion_ms integer,
  actualizados integer not null default 0,
  insertados integer not null default 0,
  bajas integer not null default 0,
  reactivados integer not null default 0,
  desactivados_por_saint integer not null default 0,
  confirmados integer not null default 0,
  saltados integer not null default 0,
  precio_conservado integer not null default 0,
  guarda_activada boolean not null default false,
  forzado boolean not null default false,
  error text
);

comment on table saint.sync_log is 'Una fila por cada corrida de saint.sync_products() -- éxito o error, nunca lanza. Sin grants a la API: revoke all explícito más abajo, RLS habilitada sin ninguna política. El VPS la lee por psql directo (docs/entregas/2026-09-25-inventario-desde-saint.md).';
comment on column saint.sync_log.fuente is 'La tabla que se usó como fuente en esta corrida (p_source resuelto, o el default saint.saprod/public.saprod), como texto -- null si no se llegó a resolver ninguna.';
comment on column saint.sync_log.actualizados is 'Productos ya vinculados (saint_code) cuyo nombre, precio, stock o estado cambió en esta corrida (IS DISTINCT FROM contra el valor anterior) -- incluye, como subconjunto, a los contados aparte en reactivados/desactivados_por_saint.';
comment on column saint.sync_log.insertados is 'Productos nuevos de Saint (sin vínculo previo) insertados en esta corrida -- solo los activos, con nombre y precio válidos.';
comment on column saint.sync_log.bajas is 'Productos vinculados que DESAPARECIERON de la fuente en esta corrida y se marcaron is_active=false (saint_removed_at sellado). Frenado por la guarda si supera 50 o si la cobertura de la fuente cae bajo el 90 % -- ver guarda_activada.';
comment on column saint.sync_log.reactivados is 'Productos vinculados que estaban is_active=false y volvieron a is_active=true en esta corrida (reaparecieron en la fuente con activo=1, o Saint dejó de marcarlos activo<>1).';
comment on column saint.sync_log.desactivados_por_saint is 'Productos vinculados, PRESENTES en la fuente, que Saint marca activo<>1 explícitamente en esta corrida -- decisión del operador: se aplica siempre, sin tope y sin contar para la guarda (no es una desaparición, es una baja administrativa de Saint).';
comment on column saint.sync_log.confirmados is 'Productos vinculados y no removidos a los que se les tocó updated_at (sin cambiar ningún otro dato) para confirmar "seguimos viendo esto en Saint" -- solo corre si no hubo una confirmación en las últimas 6 h y el agente replicador está vivo (ver el comentario de saint.sync_products()).';
comment on column saint.sync_log.saltados is 'Productos nuevos de Saint (activos, sin vínculo previo) que NO se insertaron por venir sin nombre o sin precio válido (precio3 <= 0).';
comment on column saint.sync_log.precio_conservado is 'Productos vinculados donde precio3 <= 0 en esta corrida: el precio anterior se conserva tal cual (no se pisa con cero) -- este contador cuenta cuántos.';
comment on column saint.sync_log.guarda_activada is 'true si esta corrida encontró la fuente con menos del 90 % de los productos vinculados presentes, o si iba a dar de baja por ausencia a más de 50 -- en ese caso NO se dio de baja nada por ausencia, salvo que forzado sea true.';
comment on column saint.sync_log.forzado is 'El valor de p_forzar_bajas con el que se llamó a esta corrida -- el cron nunca lo pasa en true; solo un operador desde el VPS, tras revisar sync_log.';
comment on column saint.sync_log.error is 'Mensaje de la excepción si esta corrida falló -- saint.sync_products() nunca lanza, así que un error real queda acá en vez de tumbar el job de cron.';

create index saint_sync_log_created_at_idx on saint.sync_log (created_at desc);

comment on index saint.saint_sync_log_created_at_idx is 'El purgado diario (>14 días) y la comprobación de "confirmado en las últimas 6h" dentro de sync_products() filtran por created_at.';

alter table saint.sync_log enable row level security;

revoke all on saint.sync_log from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. product_weight_audit -- una fila por cada cambio real de weight_kg,
--    venga de quien venga (incluido postgres corriendo SQL a mano). RLS
--    habilitada SIN ninguna política (nadie la lee por la API todavía -- si
--    algún día hace falta un panel, esa es otra migración con su propia RPC
--    security definer) + revoke all explícito: a diferencia de saint.*, esta
--    tabla SÍ vive en `public`, donde el `alter default privileges` de
--    Supabase le da ALL a anon/authenticated/service_role de fábrica a
--    cualquier tabla nueva -- la misma trampa que las funciones security
--    definer (ver CLAUDE.md).
-- ---------------------------------------------------------------------------
create table public.product_weight_audit (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  peso_anterior numeric(8, 3),
  peso_nuevo numeric(8, 3),
  changed_by uuid references public.agents (id) on delete set null,
  db_role text,
  changed_at timestamptz not null default now()
);

comment on table public.product_weight_audit is 'Bitácora de cada cambio real de products.weight_kg -- la ÚNICA columna del inventario que la app sigue pudiendo escribir desde que products pasó a ser de solo lectura salvo el peso (T1, plan "El inventario llega de Saint y no se toca a mano", 25/9/2026). La escribe el trigger products_weight_audit_after_trigger, sin importar el rol que hizo el cambio. RLS habilitada sin ninguna política + revoke all: nadie la lee todavía por la API.';
comment on column public.product_weight_audit.changed_by is 'auth.uid() al momento del cambio -- null si no hubo sesión (un UPDATE corrido a mano como postgres, por ejemplo).';
comment on column public.product_weight_audit.db_role is 'El rol de Postgres con el que viajó la escritura -- coalesce(nullif(current_setting(''role''), ''none''), session_user): dentro del trigger (security definer, corre como el dueño de la función) current_user siempre sería el dueño, así que lo que de verdad distingue "quién escribió" es el rol de SESIÓN (el que PostgREST fija con SET ROLE/SET LOCAL ROLE según el JWT), no current_user.';

create index product_weight_audit_product_id_idx on public.product_weight_audit (product_id, changed_at desc);

alter table public.product_weight_audit enable row level security;

revoke all on public.product_weight_audit from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. saint.sync_products() -- el corazón de la migración. SECURITY DEFINER
--    (corre como el dueño de la función, que en toda ruta de aplicación de
--    esta migración es postgres/supabase_admin -- los dos roles que el
--    candado de la sección 6 deja pasar) + `set search_path = ''` (todo
--    nombre va calificado por esquema: la función toca public, saint y una
--    tabla temporal, y sin un search_path fijo resolvería distinto según
--    quién la invoque).
--
--    NUNCA lanza: todo el cuerpo, salvo el intento del advisory lock, vive
--    dentro de un bloque BEGIN/EXCEPTION WHEN OTHERS que deja el error en
--    sync_log en vez de tumbar el job de cron. pg_try_advisory_xact_lock
--    evita que dos corridas se superpongan (el cron cada minuto + una
--    corrida manual del VPS, por ejemplo): si no consigue el lock, registra
--    y sale sin tocar una fila.
--
--    La fuente se copia con SQL DINÁMICO (drop + create as select con
--    format('%s', ...)) -- verificado en local (24-25/9/2026): un `select`
--    ESTÁTICO contra una tabla temporal creada más arriba en la MISMA
--    función SÍ funciona sin necesitar EXECUTE (PL/pgSQL prepara cada
--    sentencia recién en su primera ejecución, no al crear la función), así
--    que solo el paso que depende de un regclass resuelto en tiempo de
--    ejecución (la fuente puede ser saint.saprod, public.saprod o lo que
--    pase el llamador) necesita ser dinámico. `drop table if exists
--    pg_temp._saint_src` antes de crearla: dos llamadas en la misma
--    transacción (los tests) no chocan con "relation already exists".
--    `activo` se lee SOLO si la columna existe en la fuente
--    (pg_attribute): antes de la ventana de la réplica, public.saprod no la
--    tiene, y se trata como si todo estuviera activo (activo=1).
--
--    Guarda del operador (25/9/2026): cuenta SOLO lo que DESAPARECE de la
--    fuente. Un producto presente con activo<>1 se desactiva SIEMPRE, sin
--    tope y sin contar para la guarda -- es una baja administrativa de
--    Saint, no una desaparición. Si la fuente cubre menos del 90 % de los
--    productos ya vinculados, o la corrida daría de baja por ausencia a más
--    de 50, no se da de baja NADA por ausencia (guarda_activada=true en el
--    log); las actualizaciones, inserciones y bajas por activo<>1 siguen
--    igual. p_forzar_bajas=true salta el freno -- el cron nunca lo pasa; lo
--    corre el VPS a mano tras revisar sync_log.
--
--    "Confirmado cada 6 h" (decisión de diseño 4 del plan): si no hay
--    ninguna fila de sync_log con confirmados > 0 en las últimas 6 h Y el
--    agente replicador está vivo, se toca updated_at de todo lo vinculado y
--    no removido -- así updated_at sigue significando "la última vez que se
--    confirmó contra Saint" aunque nada haya cambiado. "Vivo": si existe
--    liminal.agent_status (to_regclass, puede no existir todavía -- el
--    proyecto de la réplica aún no la agregó al 24-25/9/2026), alguna fila
--    con last_capture_ok_at y last_heartbeat_at de hace menos de 15 min; si
--    no existe esa tabla, se mira liminal.applied_events con applied_at de
--    menos de 36 h (existe desde antes). Si ninguna de las dos existe, no
--    se considera vivo -- fallar cerrado (menos confirmaciones, nunca
--    inventar que el agente está vivo cuando no hay cómo saberlo).
--
--    Devuelve el id de la fila de sync_log que dejó (en vez de void: hace
--    a la función mucho más fácil de probar y de encadenar desde el VPS).
-- ---------------------------------------------------------------------------
create function saint.sync_products(p_source regclass default null, p_forzar_bajas boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_log_id uuid := gen_random_uuid();
  v_start timestamptz := clock_timestamp();
  v_source regclass;
  v_source_text text;
  v_has_activo boolean;
  v_linked_count integer := 0;
  v_matched_count integer := 0;
  v_coverage numeric := 1;
  v_would_deactivate integer := 0;
  v_guarda_activada boolean := false;
  v_actualizados integer := 0;
  v_insertados integer := 0;
  v_bajas integer := 0;
  v_reactivados integer := 0;
  v_desactivados_por_saint integer := 0;
  v_confirmados integer := 0;
  v_saltados integer := 0;
  v_precio_conservado integer := 0;
  v_recent_confirm boolean;
  v_agent_alive boolean;
  v_error text;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('saint.sync_products', 0)) then
    insert into saint.sync_log (id, fuente, error, duracion_ms)
    values (
      v_log_id,
      p_source::text,
      'ya hay una corrida de saint.sync_products() en curso; esta se saltó sin tocar nada.',
      round(extract(epoch from (clock_timestamp() - v_start)) * 1000)
    );
    return v_log_id;
  end if;

  begin
    v_source := coalesce(p_source, to_regclass('saint.saprod'), to_regclass('public.saprod'));

    if v_source is null then
      insert into saint.sync_log (id, error, duracion_ms)
      values (
        v_log_id,
        'no se encontró ninguna tabla fuente (ni saint.saprod ni public.saprod) y no se pasó p_source.',
        round(extract(epoch from (clock_timestamp() - v_start)) * 1000)
      );
      return v_log_id;
    end if;

    v_source_text := v_source::text;

    execute 'drop table if exists pg_temp._saint_src';

    select exists (
      select 1
      from pg_attribute a
      where a.attrelid = v_source
        and a.attname = 'activo'
        and a.attnum > 0
        and not a.attisdropped
    ) into v_has_activo;

    if v_has_activo then
      execute format(
        $q$create temporary table _saint_src as
           select
             codprod::text as codprod,
             nullif(btrim(descrip), '') as name,
             case when precio3 > 0 then round(precio3, 2) end as price,
             greatest(0, round(existen))::int as stock_quantity,
             coalesce(activo, 1) = 1 as activo
           from %s$q$,
        v_source_text
      );
    else
      execute format(
        $q$create temporary table _saint_src as
           select
             codprod::text as codprod,
             nullif(btrim(descrip), '') as name,
             case when precio3 > 0 then round(precio3, 2) end as price,
             greatest(0, round(existen))::int as stock_quantity,
             true as activo
           from %s$q$,
        v_source_text
      );
    end if;

    -- -------------------------------------------------------------------
    -- a) Actualizar coincidentes: solo lo que cambia (IS DISTINCT FROM).
    --    reactivados/desactivados_por_saint/precio_conservado se miden
    --    ANTES del UPDATE (contra el estado viejo, que el UPDATE va a
    --    pisar).
    -- -------------------------------------------------------------------
    select
      count(*) filter (where p.is_active = false and s.activo) as reactivados,
      count(*) filter (where p.is_active = true and not s.activo) as desactivados,
      count(*) filter (where s.price is null) as precio_conservado
    into v_reactivados, v_desactivados_por_saint, v_precio_conservado
    from public.products p
    join pg_temp._saint_src s on p.saint_code = s.codprod;

    update public.products p
    set
      name = coalesce(s.name, p.name),
      price = coalesce(s.price, p.price),
      stock_quantity = s.stock_quantity,
      currency = 'VES',
      is_active = s.activo,
      saint_removed_at = case when s.activo then null else p.saint_removed_at end,
      updated_at = now()
    from pg_temp._saint_src s
    where p.saint_code = s.codprod
      and (
        p.name is distinct from coalesce(s.name, p.name)
        or p.price is distinct from coalesce(s.price, p.price)
        or p.stock_quantity is distinct from s.stock_quantity
        or p.currency is distinct from 'VES'
        or p.is_active is distinct from s.activo
        or p.saint_removed_at is distinct from (case when s.activo then null else p.saint_removed_at end)
      );
    get diagnostics v_actualizados = row_count;

    -- -------------------------------------------------------------------
    -- b) Insertar nuevos de Saint activos -- saltar (y contar) los sin
    --    nombre o sin precio válido.
    -- -------------------------------------------------------------------
    insert into public.products (name, price, stock_quantity, currency, description, saint_code, saint_added_at, is_active)
    select s.name, s.price, s.stock_quantity, 'VES', 'Código ERP: ' || s.codprod, s.codprod, now(), true
    from pg_temp._saint_src s
    where s.activo
      and s.name is not null
      and s.price is not null
      and not exists (select 1 from public.products p where p.saint_code = s.codprod);
    get diagnostics v_insertados = row_count;

    select count(*) into v_saltados
    from pg_temp._saint_src s
    where s.activo
      and (s.name is null or s.price is null)
      and not exists (select 1 from public.products p where p.saint_code = s.codprod);

    -- -------------------------------------------------------------------
    -- c) Ausentes: guarda solo para esto. Cobertura = vinculados TODAVÍA NO
    --    REMOVIDOS que SIGUEN presentes / vinculados todavía no removidos;
    --    si cae bajo 90 %, o la corrida daría de baja por ausencia a más de
    --    50, no se da de baja nada por ausencia salvo p_forzar_bajas.
    --
    --    CORRECCIÓN (25/9/2026, hallazgo del operador sobre la primera
    --    versión de esta migración): el denominador/numerador de la
    --    cobertura y el conteo de "daría de baja" tienen que excluir a los
    --    productos que YA tienen saint_removed_at -- no solo a los que ya
    --    están is_active=false. Con `saint_code is not null` a secas como
    --    denominador, cada baja real que la corrida aplicaba quedaba
    --    contada PARA SIEMPRE como "vinculado" sin nunca volver a estar
    --    "presente": la cobertura solo podía bajar, nunca recuperarse, y
    --    pasado el 10 % del catálogo removido la guarda saltaba en TODAS
    --    las corridas siguientes -- ninguna ausencia nueva se volvía a
    --    aplicar sin forzar, para siempre. Y `p.is_active = true` como
    --    filtro de "daría de baja" dejaba afuera a un producto que Saint
    --    desactivó (activo<>1: is_active=false, saint_removed_at TODAVÍA
    --    null porque sigue presente) y que en una corrida POSTERIOR
    --    desaparece de la fuente -- ese caso tiene que contar para la
    --    guarda igual que cualquier otra ausencia nueva, así que el mismo
    --    predicado (`saint_removed_at is null`, sin mirar is_active) se usa
    --    acá y en el UPDATE de más abajo, que ahora sella `saint_removed_at`
    --    para CUALQUIER vinculado no removido que desaparezca, esté activo
    --    o ya desactivado por Saint.
    -- -------------------------------------------------------------------
    select count(*) into v_linked_count
    from public.products
    where saint_code is not null
      and saint_removed_at is null;

    select count(*) into v_matched_count
    from public.products p
    where p.saint_code is not null
      and p.saint_removed_at is null
      and exists (select 1 from pg_temp._saint_src s where s.codprod = p.saint_code);

    v_coverage := case when v_linked_count = 0 then 1 else v_matched_count::numeric / v_linked_count end;

    select count(*) into v_would_deactivate
    from public.products p
    where p.saint_code is not null
      and p.saint_removed_at is null
      and not exists (select 1 from pg_temp._saint_src s where s.codprod = p.saint_code);

    v_guarda_activada := (v_coverage < 0.9) or (v_would_deactivate > 50);

    if v_guarda_activada and not p_forzar_bajas then
      v_bajas := 0;
    else
      update public.products p
      set
        is_active = false,
        saint_removed_at = coalesce(p.saint_removed_at, now()),
        updated_at = now()
      where p.saint_code is not null
        and p.saint_removed_at is null
        and not exists (select 1 from pg_temp._saint_src s where s.codprod = p.saint_code);
      get diagnostics v_bajas = row_count;
    end if;

    -- -------------------------------------------------------------------
    -- d) Confirmación cada 6 h -- solo si el agente replicador está vivo.
    -- -------------------------------------------------------------------
    select exists (
      select 1 from saint.sync_log l
      where l.confirmados > 0
        and l.created_at >= now() - interval '6 hours'
    ) into v_recent_confirm;

    if to_regclass('liminal.agent_status') is not null then
      execute $q$select exists (
        select 1 from liminal.agent_status
        where last_capture_ok_at is not null
          and last_heartbeat_at is not null
          and last_heartbeat_at >= now() - interval '15 minutes'
      )$q$ into v_agent_alive;
    elsif to_regclass('liminal.applied_events') is not null then
      execute $q$select exists (
        select 1 from liminal.applied_events
        where applied_at >= now() - interval '36 hours'
      )$q$ into v_agent_alive;
    else
      v_agent_alive := false;
    end if;

    if (not v_recent_confirm) and v_agent_alive then
      update public.products p
      set updated_at = now()
      where p.saint_code is not null
        and p.saint_removed_at is null;
      get diagnostics v_confirmados = row_count;
    else
      v_confirmados := 0;
    end if;

    insert into saint.sync_log (
      id, fuente, duracion_ms, actualizados, insertados, bajas, reactivados,
      desactivados_por_saint, confirmados, saltados, precio_conservado,
      guarda_activada, forzado
    ) values (
      v_log_id, v_source_text, round(extract(epoch from (clock_timestamp() - v_start)) * 1000),
      v_actualizados, v_insertados, v_bajas, v_reactivados,
      v_desactivados_por_saint, v_confirmados, v_saltados, v_precio_conservado,
      v_guarda_activada, p_forzar_bajas
    );

    return v_log_id;
  exception when others then
    get stacked diagnostics v_error = message_text;
    insert into saint.sync_log (id, fuente, error, duracion_ms)
    values (
      v_log_id,
      v_source_text,
      v_error,
      round(extract(epoch from (clock_timestamp() - v_start)) * 1000)
    );
    return v_log_id;
  end;
end;
$fn$;

comment on function saint.sync_products(regclass, boolean) is 'Sincroniza public.products contra Saint (SAPROD, vía la réplica Liminal) -- la única vía de escritura real del inventario desde el 25/9/2026 (T1, plan "El inventario llega de Saint y no se toca a mano"). Nunca lanza: todo error queda en saint.sync_log.error. p_source por defecto resuelve saint.saprod o public.saprod (to_regclass); p_forzar_bajas=true salta la guarda de bajas por ausencia -- el cron nunca lo pasa, solo un operador desde el VPS. Cerrada a la API por completo (ver los dos revoke de abajo): SECURITY DEFINER, corre como el dueño (postgres/supabase_admin), a quien el candado de products deja pasar.';

revoke execute on function saint.sync_products(regclass, boolean) from public;
revoke execute on function saint.sync_products(regclass, boolean) from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Candado sobre products -- dos triggers, no uno (decisión de diseño 1
--    del plan):
--
--      · products_read_only_before_trigger (BEFORE, security INVOKER a
--        propósito: si fuera definer, current_user sería siempre el dueño
--        de la función y nunca frenaría a nadie). Deja pasar sin más a
--        postgres/supabase_admin -- los dos roles con los que corre
--        saint.sync_products() y cualquier operación manual del VPS.
--        Cualquier otro rol: INSERT y DELETE rechazados siempre; en UPDATE,
--        rechazado si cambia cualquier columna que no sea weight_kg (la
--        lista exacta que pidió el plan), y se fuerza NEW.updated_at :=
--        OLD.updated_at -- incluso para un cambio de peso legítimo, porque
--        updated_at pasó a significar "última vez que se confirmó contra
--        Saint", no "última vez que se tocó esta fila".
--
--      · products_weight_audit_after_trigger (AFTER UPDATE OF weight_kg,
--        security DEFINER -- así puede escribir en product_weight_audit sin
--        que ese rol necesite ningún grant sobre esa tabla). Audita
--        CUALQUIER cambio real de peso, venga de quien venga (incluido
--        postgres).
--
--    Los grants de columna (INSERT/UPDATE/DELETE/TRUNCATE revocados por
--    completo, UPDATE de weight_kg/updated_at concedido aparte) ya bloquean
--    a authenticated/anon/service_role antes de que el trigger llegue a
--    evaluarse en la mayoría de los casos -- el trigger es la segunda capa,
--    no la única, mismo criterio que "los dos revokes" de las funciones
--    security definer (ver CLAUDE.md): ninguna capa se banca sola.
-- ---------------------------------------------------------------------------
create function public.enforce_products_read_only()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'El inventario llega de Saint y no se edita a mano.';
  end if;

  if tg_op = 'DELETE' then
    raise exception 'El inventario llega de Saint y no se edita a mano.';
  end if;

  -- UPDATE: el único cambio permitido para un rol distinto de postgres/
  -- supabase_admin es weight_kg (y updated_at, que igual se fuerza abajo).
  if new.name is distinct from old.name
    or new.price is distinct from old.price
    or new.stock_quantity is distinct from old.stock_quantity
    or new.currency is distinct from old.currency
    or new.is_active is distinct from old.is_active
    or new.description is distinct from old.description
    or new.brand is distinct from old.brand
    or new.saint_code is distinct from old.saint_code
    or new.saint_added_at is distinct from old.saint_added_at
    or new.saint_removed_at is distinct from old.saint_removed_at
  then
    raise exception 'El inventario llega de Saint y no se edita a mano.';
  end if;

  new.updated_at := old.updated_at;
  return new;
end;
$$;

comment on function public.enforce_products_read_only is 'Candado de products: rechaza INSERT/DELETE y todo UPDATE que no sea weight_kg, salvo para postgres/supabase_admin (saint.sync_products() y el VPS). security INVOKER a propósito -- si fuera definer, current_user sería siempre el dueño de la función y no frenaría a nadie. Segunda capa además de los grants de columna (ver el comentario de la sección 6, más arriba).';

drop trigger if exists products_read_only_before_trigger on public.products;

create trigger products_read_only_before_trigger
  before insert or update or delete on public.products
  for each row
  execute function public.enforce_products_read_only();

create function public.log_product_weight_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.product_weight_audit (product_id, peso_anterior, peso_nuevo, changed_by, db_role)
  values (
    new.id,
    old.weight_kg,
    new.weight_kg,
    auth.uid(),
    coalesce(nullif(current_setting('role', true), 'none'), session_user)
  );
  return new;
end;
$$;

comment on function public.log_product_weight_change is 'Escribe una fila en product_weight_audit por cada cambio real de weight_kg, venga de quien venga. security DEFINER: escribe en una tabla que no tiene ningún grant a la API. db_role usa current_setting(''role''), no current_user -- dentro de una función security definer current_user siempre sería el dueño de la función; el rol de SESIÓN (el que PostgREST fija con SET ROLE según el JWT) es lo que de verdad distingue quién escribió.';

revoke execute on function public.log_product_weight_change() from public;
revoke execute on function public.log_product_weight_change() from anon, authenticated, service_role;

drop trigger if exists products_weight_audit_after_trigger on public.products;

create trigger products_weight_audit_after_trigger
  after update of weight_kg on public.products
  for each row
  when (old.weight_kg is distinct from new.weight_kg)
  execute function public.log_product_weight_change();

-- Grants de tabla: el candado real. Ningún rol de la API puede insertar,
-- actualizar (salvo las dos columnas de abajo) o borrar productos, ni
-- truncar la tabla.
revoke insert, update, delete, truncate on public.products from anon, authenticated, service_role;

-- Temporal (comentario a propósito, para que no se olvide): esta migración
-- se aplica ANTES de que llegue el código nuevo, y el código VIEJO que sigue
-- en producción en ese hueco manda `updated_at` en el payload de "guardar
-- peso" (el nuevo manda solo `weight_kg`). Mientras tanto, authenticated
-- necesita poder tocar esa columna
-- también -- el trigger de la sección 6 la fuerza de vuelta al valor viejo
-- de todas formas. El VPS revoca esta columna después de desplegar el
-- código nuevo (docs/entregas/2026-09-25-inventario-desde-saint.md):
--   revoke update (updated_at) on public.products from authenticated;
grant update (weight_kg, updated_at) on public.products to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Jobs de pg_cron -- idempotentes por nombre (cron.schedule con nombre
--    actualiza el job existente en vez de duplicarlo, verificado en local).
--    El bootstrap de la sección 8 corre una vez, ya, además del cron.
-- ---------------------------------------------------------------------------
select cron.schedule('saint-sync-products', '* * * * *', $$select saint.sync_products()$$);

select cron.schedule(
  'saint-sync-log-purge',
  '30 3 * * *',
  $$
    delete from saint.sync_log where created_at < now() - interval '14 days';
    delete from cron.job_run_details where end_time < now() - interval '7 days';
  $$
);

-- ---------------------------------------------------------------------------
-- 8. Bootstrap -- una corrida ahora mismo. En local/CI no hay fuente
--    (ni saint.saprod ni public.saprod): tiene que registrar el motivo y
--    salir sin fallar la migración.
-- ---------------------------------------------------------------------------
select saint.sync_products();

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real, no el texto de este archivo.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text := '';
  v_count integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    v_missing := v_missing || E'\n  - pg_cron no quedó instalada.';
  end if;

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'products'
    and column_name in ('saint_code', 'saint_added_at', 'saint_removed_at');
  if v_count is distinct from 3 then
    v_missing := v_missing || format(E'\n  - products: encontró %s de las 3 columnas nuevas.', v_count);
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'products_saint_code_idx') then
    v_missing := v_missing || E'\n  - products_saint_code_idx no quedó creado.';
  end if;

  if not exists (select 1 from pg_namespace where nspname = 'saint') then
    v_missing := v_missing || E'\n  - el esquema saint no quedó creado.';
  end if;

  if not exists (select 1 from pg_tables where schemaname = 'saint' and tablename = 'sync_log') then
    v_missing := v_missing || E'\n  - saint.sync_log no quedó creada.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'saint.sync_log'::regclass) then
    v_missing := v_missing || E'\n  - saint.sync_log no tiene RLS habilitada.';
  end if;

  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'product_weight_audit') then
    v_missing := v_missing || E'\n  - public.product_weight_audit no quedó creada.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.product_weight_audit'::regclass) then
    v_missing := v_missing || E'\n  - product_weight_audit no tiene RLS habilitada.';
  end if;

  if not exists (
    select 1 from pg_proc
    where pronamespace = 'saint'::regnamespace and proname = 'sync_products'
  ) then
    v_missing := v_missing || E'\n  - saint.sync_products no quedó creada.';
  end if;

  if has_function_privilege('anon', 'saint.sync_products(regclass, boolean)', 'execute') then
    v_missing := v_missing || E'\n  - saint.sync_products: anon todavía puede ejecutarla.';
  end if;
  if has_function_privilege('authenticated', 'saint.sync_products(regclass, boolean)', 'execute') then
    v_missing := v_missing || E'\n  - saint.sync_products: authenticated todavía puede ejecutarla.';
  end if;
  if has_function_privilege('service_role', 'saint.sync_products(regclass, boolean)', 'execute') then
    v_missing := v_missing || E'\n  - saint.sync_products: service_role todavía puede ejecutarla.';
  end if;

  if has_function_privilege('anon', 'public.log_product_weight_change()', 'execute') then
    v_missing := v_missing || E'\n  - log_product_weight_change: anon todavía puede ejecutarla.';
  end if;
  if has_function_privilege('authenticated', 'public.log_product_weight_change()', 'execute') then
    v_missing := v_missing || E'\n  - log_product_weight_change: authenticated todavía puede ejecutarla.';
  end if;

  if has_table_privilege('authenticated', 'public.products', 'insert') then
    v_missing := v_missing || E'\n  - products: authenticated todavía puede INSERT.';
  end if;
  if has_table_privilege('authenticated', 'public.products', 'delete') then
    v_missing := v_missing || E'\n  - products: authenticated todavía puede DELETE.';
  end if;
  if not has_column_privilege('authenticated', 'public.products', 'weight_kg', 'update') then
    v_missing := v_missing || E'\n  - products.weight_kg: authenticated debería poder actualizarla y no puede.';
  end if;
  if has_column_privilege('authenticated', 'public.products', 'price', 'update') then
    v_missing := v_missing || E'\n  - products.price: authenticated todavía puede actualizarla.';
  end if;

  if not exists (select 1 from cron.job where jobname = 'saint-sync-products') then
    v_missing := v_missing || E'\n  - el job de cron saint-sync-products no quedó agendado.';
  end if;
  if not exists (select 1 from cron.job where jobname = 'saint-sync-log-purge') then
    v_missing := v_missing || E'\n  - el job de cron saint-sync-log-purge no quedó agendado.';
  end if;

  if v_missing <> '' then
    raise exception E'20260925010000: autoverificación falló:%', v_missing;
  end if;

  raise notice '20260925010000: autoverificación del inventario desde Saint correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y las columnas
-- nuevas dan 400 hasta que alguien lo recargue a mano.
notify pgrst, 'reload schema';
