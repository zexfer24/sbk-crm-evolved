-- ============================================================================
-- Enviar a SAINT (25/10/2026), plan "Enviar a SAINT", T1.
--
-- Contexto: el asesor (o la caja) prepara un presupuesto o un carrito de chat y
-- hoy tiene que volver a teclearlo en SAINT, el sistema administrativo. El plan
-- agrega el botón "Enviar a SAINT": el CRM inserta una fila `pendiente` en
-- `liminal.saint_borradores`; el agente LiminalReplicant (corre en la PC del
-- cliente y se conecta con el rol `liminal_replicator`) la reclama con UPDATE,
-- crea la factura EN ESPERA en SAINT y escribe `estado = 'creado'` +
-- `numero_saint`, o `estado = 'error'` + `error`. El CRM ve el resultado por
-- Realtime.
--
-- La tabla es un CONTRATO FIJO con ese agente: sus columnas y CHECK se copian
-- tal cual (el agente ya los espera) y no se agregan ni se quitan.
--
-- PostgREST NO expone el esquema `liminal` (solo `public` y `graphql_public`;
-- tocar `supabase/config.toml` está fuera de alcance), así que el CRM no
-- escribe ni lee la tabla directo: lo hace por dos RPC en `public`.
--
--   · `enviar_borrador_saint(...)` ARMA los renglones desde la base (presupuesto
--     o carrito del chat + `products`): el navegador no manda códigos ni
--     cantidades, así que no puede mandar a SAINT algo distinto de lo que el
--     CRM tiene. Valida con los MISMOS textos del agente (el cliente los
--     muestra tal cual). Rechaza productos sin `saint_code` o dados de baja.
--     Si el origen es un carrito, guarda la cédula tipeada en el contacto SOLO
--     si le faltaba (nunca pisa una existente, ni toca teléfono ni nombre).
--   · `borradores_saint(p_origen_ids)` devuelve el ÚLTIMO envío de cada origen,
--     para pintar el estado (pendiente / creado N° / error) junto a cada uno.
--   Las dos son `security INVOKER`: la RLS manda (mismo criterio que
--   `guardar_presupuesto`, 20261021010000).
--
-- Quién puede: lectura y envío con `can_read_inventory()` (cualquier fila de
-- `agents`, la CAJA incluida; 20261013010000). Pero el origen `carrito` exige
-- `is_agent()`: la caja no ve los chats. Nadie de la app hace UPDATE ni DELETE
-- sobre la tabla; esas operaciones son del agente externo.
--
-- Un solo envío en curso por origen: el índice único parcial
-- `ux_saint_borradores_en_curso` hace saltar `23505` si ya hay uno `pendiente`
-- o `procesando`. La RPC NO lo captura: el cliente lo traduce a "ya está en
-- camino".
--
-- Realtime: la tabla entra a `supabase_realtime` (sin replica identity full:
-- nadie borra filas, no hay DELETE que escuchar). Si el esquema `liminal` o el
-- rol `liminal_replicator` no existen (local, CI), la migración crea el esquema
-- y se salta lo del rol con un aviso; en producción el rol existe.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. Es re-ejecutable
-- (todo `if not exists` / `or replace` / `drop ... if exists`).
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tabla (contrato con el agente LiminalReplicant: NO cambiar la forma)
-- ---------------------------------------------------------------------------
create schema if not exists liminal;

create table if not exists liminal.saint_borradores (
  id uuid not null default gen_random_uuid() primary key,
  origen text not null,
  origen_id uuid not null,
  creado_por uuid not null,
  cedula_tipo char(1) not null,
  cedula_numero text not null,
  nombre text not null,
  apellido text not null,
  telefono text not null,
  items jsonb not null,
  estado text not null default 'pendiente',
  intentos int not null default 0,
  numero_saint text,
  codclie text,
  cliente_creado boolean,
  error text,
  created_at timestamptz not null default now(),
  reclamado_at timestamptz,
  procesado_at timestamptz,
  constraint ck_saint_borradores_estado check (estado in ('pendiente', 'procesando', 'creado', 'error')),
  constraint ck_saint_borradores_origen check (origen in ('presupuesto', 'carrito')),
  constraint ck_saint_borradores_cedula_tipo check (cedula_tipo in ('V', 'E')),
  constraint ck_saint_borradores_items check (
    case when jsonb_typeof(items) = 'array' then jsonb_array_length(items) between 1 and 100 else false end
  )
);

comment on table liminal.saint_borradores is
  'Cola de borradores hacia SAINT (plan "Enviar a SAINT", 25/10/2026). CONTRATO con el agente LiminalReplicant: el CRM inserta filas pendiente (por public.enviar_borrador_saint); el agente (rol liminal_replicator) las reclama con UPDATE, crea la factura en espera en SAINT y deja estado creado + numero_saint, o error + error. items = [{"codprod": text, "cantidad": int}, ...] (1 a 100). Un solo envío en curso por origen_id. No cambiar columnas ni CHECK sin avisar al agente.';

create unique index if not exists ux_saint_borradores_en_curso
  on liminal.saint_borradores (origen_id) where estado in ('pendiente', 'procesando');
create index if not exists ix_saint_borradores_pendientes
  on liminal.saint_borradores (created_at) where estado = 'pendiente';
create index if not exists ix_saint_borradores_origen
  on liminal.saint_borradores (origen_id, created_at desc);

-- Avisa al agente (LISTEN) apenas entra un borrador, para no esperar al sondeo.
create or replace function liminal.saint_borradores_notify() returns trigger
language plpgsql
as $$
begin
  perform pg_notify('saint_borradores', new.id::text);
  return new;
end;
$$;

drop trigger if exists trg_saint_borradores_notify on liminal.saint_borradores;
create trigger trg_saint_borradores_notify
  after insert on liminal.saint_borradores
  for each row execute function liminal.saint_borradores_notify();

-- ---------------------------------------------------------------------------
-- 2. Permisos y RLS
-- ---------------------------------------------------------------------------
-- El `alter default privileges` de Supabase puede darle privilegios a
-- anon/authenticated sobre tablas nuevas: se corta todo y se concede solo lo
-- necesario (mismo criterio que `product_weight_audit`, 20260925010000).
revoke all on liminal.saint_borradores from public, anon, authenticated;

grant usage on schema liminal to authenticated;
grant select on liminal.saint_borradores to authenticated, service_role;
-- Solo estas columnas: estado, intentos, numero_saint, etc. son del agente.
-- Nunca UPDATE ni DELETE para la app.
grant insert (origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items)
  on liminal.saint_borradores to authenticated;

alter table liminal.saint_borradores enable row level security;

drop policy if exists saint_borradores_select on liminal.saint_borradores;
create policy saint_borradores_select on liminal.saint_borradores
  for select to authenticated
  using (public.can_read_inventory());

drop policy if exists saint_borradores_insert on liminal.saint_borradores;
create policy saint_borradores_insert on liminal.saint_borradores
  for insert to authenticated
  with check (public.can_read_inventory() and creado_por = auth.uid());

-- El rol del agente existe en producción y NO en local ni en el CI: todo lo que
-- lo nombra va con `execute` tras mirar `pg_roles`.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'liminal_replicator') then
    execute 'grant usage on schema liminal to liminal_replicator';
    execute 'grant select, update on liminal.saint_borradores to liminal_replicator';
    if not exists (
      select 1 from pg_policies
       where schemaname = 'liminal' and tablename = 'saint_borradores' and policyname = 'saint_borradores_agente'
    ) then
      execute 'create policy saint_borradores_agente on liminal.saint_borradores for all to liminal_replicator using (true) with check (true)';
    end if;
  else
    raise notice '20261025010000: el rol liminal_replicator no existe en esta base; se omiten sus permisos (esperado en local y en el CI).';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Realtime
-- ---------------------------------------------------------------------------
-- Un canal suscrito a una tabla NO publicada no falla, calla (trampa del
-- 8/9/2026, `conversation_handoffs`): se publica y se autoverifica al final.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'liminal' and tablename = 'saint_borradores'
  ) then
    alter publication supabase_realtime add table liminal.saint_borradores;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. enviar_borrador_saint(): arma los renglones desde la base y encola
-- ---------------------------------------------------------------------------
-- Devuelve el id del borrador. Errores:
--   · 22023 `saint_dato_invalido` con un `detail` en español (los textos son los
--     del agente: el cliente los muestra tal cual);
--   · 42501 `saint_sin_permiso`;
--   · 23505 del índice de "un envío en curso por origen": NO se captura.
create or replace function public.enviar_borrador_saint(
  p_origen text,
  p_origen_id uuid,
  p_cedula_tipo text,
  p_cedula_numero text,
  p_nombre text,
  p_apellido text,
  p_telefono text
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tipo text := upper(btrim(coalesce(p_cedula_tipo, '')));
  v_numero text := btrim(coalesce(p_cedula_numero, ''));
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_apellido text := btrim(coalesce(p_apellido, ''));
  v_telefono text := btrim(coalesce(p_telefono, ''));
  v_rows jsonb;
  v_n integer;
  v_lista text;
  v_codigo text;
  v_items jsonb;
  v_id uuid;
begin
  if p_origen is null or p_origen not in ('presupuesto', 'carrito') then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Origen inválido.';
  end if;

  if not public.can_read_inventory() then
    raise exception 'saint_sin_permiso' using errcode = '42501';
  end if;
  -- La caja no ve los chats: el carrito es de la conversación.
  if p_origen = 'carrito' and not public.is_agent() then
    raise exception 'saint_sin_permiso' using errcode = '42501';
  end if;

  if v_tipo not in ('V', 'E') then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Tipo de cédula inválido: solo V o E.';
  end if;
  if v_numero !~ '^[0-9]{5,10}$' or v_numero ~ '^0+$' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Cédula inválida: use solo dígitos (5 a 10).';
  end if;
  if v_nombre = '' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Falta el nombre del cliente.';
  end if;
  if v_apellido = '' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Falta el apellido del cliente.';
  end if;
  if v_telefono !~ '^\+?[0-9]{7,19}$' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Teléfono inválido.';
  end if;

  -- Renglones desde la base, con la RLS de quien llama: lo que no ve, no existe.
  if p_origen = 'presupuesto' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'nombre', p.name,
             'codigo', btrim(coalesce(p.saint_code, '')),
             'activo', p.is_active,
             'cantidad', pi.quantity,
             'creado', pi.created_at)), '[]'::jsonb)
      into v_rows
      from public.presupuesto_items pi
      join public.products p on p.id = pi.product_id
     where pi.presupuesto_id = p_origen_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'nombre', p.name,
             'codigo', btrim(coalesce(p.saint_code, '')),
             'activo', p.is_active,
             'cantidad', ci.quantity,
             'creado', ci.created_at)), '[]'::jsonb)
      into v_rows
      from public.conversation_cart_items ci
      join public.products p on p.id = ci.product_id
     where ci.conversation_id = p_origen_id;
  end if;

  if jsonb_array_length(v_rows) = 0 then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'El borrador no tiene artículos.';
  end if;

  select string_agg(distinct x.nombre, ', ' order by x.nombre)
    into v_lista
    from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
   where x.codigo = '';
  if v_lista is not null then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Sin código SAINT: ' || v_lista || '.';
  end if;

  select string_agg(distinct x.nombre, ', ' order by x.nombre)
    into v_lista
    from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
   where not x.activo;
  if v_lista is not null then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Dados de baja en el inventario: ' || v_lista || '.';
  end if;

  -- Misma cantidad que el agente acepta por línea: entera, de 1 a 9999 POR CÓDIGO
  -- (dos productos del CRM pueden compartir el código SAINT y se suman).
  select min(g.codigo)
    into v_codigo
    from (
      select x.codigo, sum(x.cantidad::bigint) as suma
        from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
       group by x.codigo
    ) g
   where g.suma > 9999 or g.suma < 1;
  if v_codigo is not null then
    raise exception 'saint_dato_invalido' using errcode = '22023',
      detail = 'Cantidad inválida en ' || v_codigo || ': debe ser un entero entre 1 y 9999.';
  end if;

  select jsonb_agg(jsonb_build_object('codprod', g.codigo, 'cantidad', g.suma) order by g.primero, g.codigo),
         count(*)
    into v_items, v_n
    from (
      select x.codigo, sum(x.cantidad)::integer as suma, min(x.creado) as primero
        from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
       group by x.codigo
    ) g;
  if v_n > 100 then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'El borrador supera 100 líneas.';
  end if;

  -- Desde el carrito la cédula tipeada se guarda en el contacto SOLO si le
  -- faltaba. El teléfono y el nombre del contacto nunca se tocan.
  if p_origen = 'carrito' then
    update public.contacts
       set cedula_type = v_tipo, cedula_number = v_numero
     where id = (select c.contact_id from public.conversations c where c.id = p_origen_id)
       and (cedula_number is null or btrim(cedula_number) = '');
  end if;

  -- El 23505 del índice de "un envío en curso por origen" sube tal cual.
  insert into liminal.saint_borradores (
    origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items
  ) values (
    p_origen, p_origen_id, auth.uid(), v_tipo, v_numero, v_nombre, v_apellido, v_telefono, v_items
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) is
  'Encola un borrador hacia SAINT (plan "Enviar a SAINT", 25/10/2026): arma los renglones desde presupuesto_items o conversation_cart_items (agrupados por saint_code, sumando cantidades), valida con los textos del agente y, desde el carrito, completa la cédula del contacto solo si faltaba. security invoker: la RLS manda; el carrito exige is_agent() (la caja no ve chats). 23505 = ya hay un envío en curso de ese origen.';

revoke execute on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) from public;
revoke execute on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) from anon, authenticated;
grant execute on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. borradores_saint(): el último envío de cada origen
-- ---------------------------------------------------------------------------
-- Tope de 500 orígenes por llamada: se TRUNCA al recibir más (no lanza), porque
-- la interfaz pinta estados de listas que ya están paginadas y un error aquí
-- dejaría la lista entera sin estado.
create or replace function public.borradores_saint(p_origen_ids uuid[])
returns table (
  id uuid,
  origen text,
  origen_id uuid,
  creado_por uuid,
  cedula_tipo text,
  cedula_numero text,
  nombre text,
  apellido text,
  telefono text,
  estado text,
  numero_saint text,
  codclie text,
  cliente_creado boolean,
  error text,
  created_at timestamptz,
  procesado_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (b.origen_id)
         b.id, b.origen, b.origen_id, b.creado_por, b.cedula_tipo::text, b.cedula_numero,
         b.nombre, b.apellido, b.telefono, b.estado, b.numero_saint, b.codclie,
         b.cliente_creado, b.error, b.created_at, b.procesado_at
    from liminal.saint_borradores b
   where b.origen_id = any (p_origen_ids[1:500])
   order by b.origen_id, b.created_at desc, b.id;
$$;

comment on function public.borradores_saint(uuid[]) is
  'Último envío a SAINT de cada origen (presupuesto o conversación) del arreglo, máximo 500 orígenes (el resto se ignora). security invoker: la RLS de saint_borradores manda. Plan "Enviar a SAINT", 25/10/2026.';

revoke execute on function public.borradores_saint(uuid[]) from public;
revoke execute on function public.borradores_saint(uuid[]) from anon, authenticated;
grant execute on function public.borradores_saint(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
  t text;
  n integer;
begin
  if not exists (
    select 1 from pg_class where oid = 'liminal.saint_borradores'::regclass and relrowsecurity
  ) then
    raise exception '20261025010000: liminal.saint_borradores quedó sin RLS habilitada';
  end if;

  select count(*) into n
    from pg_policy
   where polrelid = 'liminal.saint_borradores'::regclass
     and polname in ('saint_borradores_select', 'saint_borradores_insert');
  if n <> 2 then
    raise exception '20261025010000: se esperaban 2 políticas de authenticated y hay %', n;
  end if;

  if has_table_privilege('authenticated', 'liminal.saint_borradores', 'UPDATE')
     or has_table_privilege('authenticated', 'liminal.saint_borradores', 'DELETE') then
    raise exception '20261025010000: authenticated no debía poder UPDATE ni DELETE sobre saint_borradores';
  end if;
  if has_table_privilege('anon', 'liminal.saint_borradores', 'SELECT')
     or has_table_privilege('anon', 'liminal.saint_borradores', 'INSERT') then
    raise exception '20261025010000: anon tiene privilegios sobre saint_borradores';
  end if;

  foreach f in array array[
    'public.enviar_borrador_saint(text,uuid,text,text,text,text,text)',
    'public.borradores_saint(uuid[])'
  ]
  loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('public', f, 'EXECUTE') then
      raise exception '20261025010000: anon o PUBLIC pueden ejecutar %', f;
    end if;
    if not has_function_privilege('authenticated', f, 'EXECUTE')
       or not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception '20261025010000: authenticated y service_role deben poder ejecutar %', f;
    end if;
    if exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
      raise exception '20261025010000: % debía quedar security invoker', f;
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'liminal.saint_borradores'::regclass
       and tgname = 'trg_saint_borradores_notify'
       and not tgisinternal
       and (tgtype & 1) = 1      -- por fila
       and (tgtype & 4) = 4      -- INSERT
       and (tgtype & 2) = 0      -- no BEFORE (AFTER)
  ) then
    raise exception '20261025010000: falta el trigger AFTER INSERT trg_saint_borradores_notify';
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'liminal' and tablename = 'saint_borradores'
  ) then
    raise exception '20261025010000: liminal.saint_borradores no quedó publicada en supabase_realtime';
  end if;

  if exists (select 1 from pg_roles where rolname = 'liminal_replicator') then
    if not has_table_privilege('liminal_replicator', 'liminal.saint_borradores', 'SELECT')
       or not has_table_privilege('liminal_replicator', 'liminal.saint_borradores', 'UPDATE') then
      raise exception '20261025010000: liminal_replicator debe poder SELECT y UPDATE sobre saint_borradores';
    end if;
  end if;

  -- El esquema `liminal` es del replicador: lo que ya vivía ahí (si existe) no
  -- puede haberse abierto a la app por darle USAGE sobre el esquema.
  foreach t in array array['liminal.agent_status', 'liminal.applied_events']
  loop
    if to_regclass(t) is not null and has_table_privilege('authenticated', t, 'SELECT') then
      raise exception '20261025010000: authenticated no debía poder leer %', t;
    end if;
  end loop;

  raise notice '20261025010000: autoverificación de saint_borradores correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
