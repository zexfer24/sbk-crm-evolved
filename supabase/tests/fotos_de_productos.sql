-- ===========================================================================
-- Fotos de los repuestos (30/10/2026, migración
-- 20261031010000_fotos_de_productos.sql, plan "Cada repuesto con su foto", T1).
--
-- Contexto: cada repuesto puede tener hasta 6 fotos, una sola principal. Solo
-- supervisor y admin suben, reemplazan, borran y marcan la principal (D1); la
-- caja y los asesores solo ven. Las fotos viven en el bucket PÚBLICO
-- `product-photos` (D5): la caja las ve sin pasar por /api (que le da 403) y
-- Meta las descarga directo por una URL que no vence.
--
-- Qué fija:
--   a. Supervisor inserta una foto: 1 fila y la primera nace principal.
--   b. Asesor y caja NO insertan (42501) y su UPDATE/DELETE afecta 0 filas.
--   c. Asesor, caja y supervisor LEEN las mismas filas (can_read_inventory).
--   d. Marcar otra como principal desmarca la anterior; borrar la principal
--      promueve la de menor `position`; la séptima da el error del tope.
--   e. La ruta tiene que empezar con el id del producto.
--   f. Storage: supervisor sube a `product-photos`; asesor y caja reciben
--      42501; el bucket es público; anon no toca la tabla.
--
-- Corre como `authenticated` con la `sub` de un usuario real -- como
-- `postgres` se salta la RLS y no mediría nada (mismo criterio que
-- rol_caja.sql y presupuestos.sql). Un UPDATE/DELETE que la RLS bloquea afecta
-- 0 filas SIN error: por eso cada rechazo se mide con el conteo de filas.
--
-- Ojo con el orden: los triggers BEFORE corren ANTES del WITH CHECK de la RLS.
-- Los rechazos de asesor/caja se prueban sobre un producto SIN fotos; sobre uno
-- con 6, el trigger del tope contestaría 23514 antes de que la RLS diera 42501.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- AG asesor, SU supervisor, CJ caja.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('f0f07000-0000-0000-0000-0000000000a1', 'asesor-fotos@sbk.test', jsonb_build_object('display_name', 'Asesor fotos'), '{}'::jsonb),
  ('f0f07000-0000-0000-0000-0000000000a2', 'super-fotos@sbk.test',  jsonb_build_object('display_name', 'Supervisor fotos'), '{"role":"supervisor"}'::jsonb),
  ('f0f07000-0000-0000-0000-0000000000c1', 'caja-fotos@sbk.test',   jsonb_build_object('display_name', 'Caja fotos'), '{"role":"caja"}'::jsonb);

-- P1 tendrá fotos; P2 queda sin fotos (rechazos); P3 prueba la promoción.
insert into public.products (id, name, price, currency, stock_quantity) values
  ('f0f07000-4000-0000-0000-000000000001', 'Producto fotos 1', 10, 'USD', 5),
  ('f0f07000-4000-0000-0000-000000000002', 'Producto fotos 2', 20, 'USD', 5),
  ('f0f07000-4000-0000-0000-000000000003', 'Producto fotos 3', 30, 'USD', 5);

-- Ejecuta una sentencia con los privilegios del rol que la llame y devuelve
-- "filas=N" o "error <sqlstate>: <mensaje>".
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

-- Cuenta las filas que el rol ve en una consulta: "filas=N" o "error ...".
create or replace function pg_temp.contar(q text) returns text
language plpgsql as $$
declare
  n bigint;
begin
  execute 'select count(*) from (' || q || ') s' into n;
  return 'filas=' || n;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

create or replace function pg_temp.esperar(etiqueta text, r text, patron text) returns void
language plpgsql as $$
begin
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso a/d · el supervisor gestiona las fotos de P1
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'f0f07000-0000-0000-0000-0000000000a2';

do $$
declare
  p1 constant uuid := 'f0f07000-4000-0000-0000-000000000001';
  f1 uuid;
  f2 uuid;
  v boolean;
  n integer;
  r text;
begin
  -- a. La primera foto nace principal (sin pedirlo).
  insert into public.product_photos (product_id, storage_path, created_by)
  values (p1, p1 || '/a.jpg', 'f0f07000-0000-0000-0000-0000000000a2')
  returning id, is_primary into f1, v;
  if f1 is null then
    insert into _errores(msg) values ('Caso a: el supervisor no pudo insertar la primera foto.');
    return;
  end if;
  if v is distinct from true then
    insert into _errores(msg) values (format('Caso a: la primera foto debía nacer principal y salió is_primary=%s.', v));
  end if;

  -- La segunda, sin pedir nada, NO es principal.
  insert into public.product_photos (product_id, storage_path, position)
  values (p1, p1 || '/b.jpg', 1)
  returning id, is_primary into f2, v;
  if v is distinct from false then
    insert into _errores(msg) values (format('Caso d: la segunda foto debía nacer no principal y salió is_primary=%s.', v));
  end if;

  -- d. Marcar la segunda como principal desmarca la primera.
  update public.product_photos set is_primary = true where id = f2;
  select is_primary into v from public.product_photos where id = f1;
  if v is distinct from false then
    insert into _errores(msg) values ('Caso d: al marcar la segunda principal, la primera debía quedar en false.');
  end if;
  select count(*) into n from public.product_photos where product_id = p1 and is_primary;
  if n <> 1 then
    insert into _errores(msg) values (format('Caso d: debía haber exactamente 1 principal y hay %s.', n));
  end if;

  -- d. Borrar la principal promueve a la que queda.
  delete from public.product_photos where id = f2;
  select is_primary into v from public.product_photos where id = f1;
  if v is distinct from true then
    insert into _errores(msg) values ('Caso d: al borrar la principal, la foto restante debía volverse principal.');
  end if;

  -- d. Hasta 6 fotos: se suman 5 más (total 6) y la séptima falla.
  for i in 1..5 loop
    insert into public.product_photos (product_id, storage_path, position)
    values (p1, p1 || '/extra' || i || '.jpg', i + 1);
  end loop;
  select count(*) into n from public.product_photos where product_id = p1;
  if n <> 6 then
    insert into _errores(msg) values (format('Caso d: se esperaban 6 fotos y hay %s.', n));
  end if;
  r := pg_temp.probar(format($q$insert into public.product_photos (product_id, storage_path) values (%L, %L)$q$, p1, p1 || '/septima.jpg'));
  perform pg_temp.esperar('Caso d: la séptima foto', r, '^error 23514: Este repuesto ya tiene 6 fotos\.$');
  select count(*) into n from public.product_photos where product_id = p1;
  if n <> 6 then
    insert into _errores(msg) values (format('Caso d: la séptima no debía quedar guardada (hay %s).', n));
  end if;

  -- e. La ruta tiene que empezar con el id del PRODUCTO de la fila.
  r := pg_temp.probar(format($q$insert into public.product_photos (product_id, storage_path) values (%L, %L)$q$, 'f0f07000-4000-0000-0000-000000000003', p1 || '/ajena.jpg'));
  perform pg_temp.esperar('Caso e: ruta de otro producto', r, '^error 23514');
  r := pg_temp.probar(format($q$insert into public.product_photos (product_id, storage_path) values (%L, %L)$q$, 'f0f07000-4000-0000-0000-000000000003', 'f0f07000-4000-0000-0000-000000000003/dup.jpg'));
  perform pg_temp.esperar('Caso e: ruta propia en P3', r, '^filas=1$');
  -- storage_path es único.
  r := pg_temp.probar(format($q$insert into public.product_photos (product_id, storage_path) values (%L, %L)$q$, 'f0f07000-4000-0000-0000-000000000003', 'f0f07000-4000-0000-0000-000000000003/dup.jpg'));
  perform pg_temp.esperar('Caso e: ruta repetida', r, '^error 23505');

  -- d. La promoción elige la de menor position: P3 ya tiene dup.jpg (principal).
  insert into public.product_photos (product_id, storage_path, position)
  values ('f0f07000-4000-0000-0000-000000000003', 'f0f07000-4000-0000-0000-000000000003/p9.jpg', 9),
         ('f0f07000-4000-0000-0000-000000000003', 'f0f07000-4000-0000-0000-000000000003/p2.jpg', 2);
  delete from public.product_photos where storage_path = 'f0f07000-4000-0000-0000-000000000003/dup.jpg';
  select storage_path into r from public.product_photos where product_id = 'f0f07000-4000-0000-0000-000000000003' and is_primary;
  if r is distinct from 'f0f07000-4000-0000-0000-000000000003/p2.jpg' then
    insert into _errores(msg) values (format('Caso d: se debía promover la de position 2 y se promovió %L.', r));
  end if;

  -- Dos principales a la vez no caben ni por UPDATE directo.
  select count(*) into n from public.product_photos where product_id = 'f0f07000-4000-0000-0000-000000000003' and is_primary;
  if n <> 1 then
    insert into _errores(msg) values (format('Caso d: P3 debía tener 1 principal y tiene %s.', n));
  end if;
end $$;

-- Storage: el supervisor sube a product-photos.
select pg_temp.esperar('supervisor: sube a product-photos',
  pg_temp.probar($q$insert into storage.objects (bucket_id, name) values ('product-photos', 'f0f07000-4000-0000-0000-000000000001/x.jpg')$q$),
  '^filas=1$');

reset role;
reset "request.jwt.claim.sub";

-- Total que cada rol debe ver (se mide como postgres, sin RLS).
create temporary table _esperado (total bigint);
insert into _esperado select count(*) from public.product_photos;
grant select on _esperado to authenticated;

do $$
begin
  if (select total from _esperado) <> 8 then
    insert into _errores(msg) values (format('Preparación: se esperaban 8 fotos en total (6 de P1 + 2 de P3) y hay %s.', (select total from _esperado)));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso b/c/f · el asesor y la caja
-- ---------------------------------------------------------------------------
do $$
declare
  rol record;
  r text;
  esperado bigint := (select total from _esperado);
begin
  for rol in
    select * from (values
      ('asesor', 'f0f07000-0000-0000-0000-0000000000a1'),
      ('caja',   'f0f07000-0000-0000-0000-0000000000c1')
    ) v(nombre, sub)
  loop
    perform set_config('request.jwt.claim.sub', rol.sub, true);
    execute 'set local role authenticated';

    -- c. Lectura de todo.
    r := pg_temp.contar('select 1 from public.product_photos');
    perform pg_temp.esperar(rol.nombre || ': lee las fotos', r, '^filas=' || esperado || '$');

    -- b. Insertar: 42501 (sobre P2, sin fotos: ver el comentario del encabezado).
    r := pg_temp.probar($q$insert into public.product_photos (product_id, storage_path) values ('f0f07000-4000-0000-0000-000000000002', 'f0f07000-4000-0000-0000-000000000002/z.jpg')$q$);
    perform pg_temp.esperar(rol.nombre || ': inserta una foto', r, '^error 42501');

    -- b. UPDATE y DELETE afectan 0 filas.
    r := pg_temp.probar($q$update public.product_photos set is_primary = false, position = 99$q$);
    perform pg_temp.esperar(rol.nombre || ': update', r, '^filas=0$');
    r := pg_temp.probar($q$update public.product_photos set is_primary = true where product_id = 'f0f07000-4000-0000-0000-000000000001'$q$);
    perform pg_temp.esperar(rol.nombre || ': marcar principal', r, '^filas=0$');
    r := pg_temp.probar($q$delete from public.product_photos$q$);
    perform pg_temp.esperar(rol.nombre || ': delete', r, '^filas=0$');

    -- f. Storage: no sube al bucket de fotos.
    r := pg_temp.probar(format($q$insert into storage.objects (bucket_id, name) values ('product-photos', 'f0f07000-4000-0000-0000-000000000001/%s.jpg')$q$, rol.nombre));
    perform pg_temp.esperar(rol.nombre || ': sube a product-photos', r, '^error 42501');

    execute 'reset role';
  end loop;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Estado final, grants y bucket (como postgres)
-- ---------------------------------------------------------------------------
do $$
declare
  n bigint;
begin
  -- Nada de lo que intentaron asesor y caja cambió nada.
  select count(*) into n from public.product_photos;
  if n <> (select total from _esperado) then
    insert into _errores(msg) values (format('Estado final: había %s fotos y ahora hay %s.', (select total from _esperado), n));
  end if;
  select count(*) into n from public.product_photos where position = 99 or storage_path like '%/z.jpg';
  if n <> 0 then
    insert into _errores(msg) values ('Estado final: asesor o caja lograron modificar o insertar una foto.');
  end if;
  select count(*) into n from storage.objects where bucket_id = 'product-photos';
  if n <> 1 then
    insert into _errores(msg) values (format('Estado final: debía haber 1 objeto en product-photos (el del supervisor) y hay %s.', n));
  end if;

  -- anon no toca la tabla.
  if has_table_privilege('anon', 'public.product_photos', 'select')
     or has_table_privilege('anon', 'public.product_photos', 'insert')
     or has_table_privilege('anon', 'public.product_photos', 'update')
     or has_table_privilege('anon', 'public.product_photos', 'delete') then
    insert into _errores(msg) values ('Grants: anon no debía tener ningún privilegio sobre product_photos.');
  end if;
  if not has_table_privilege('authenticated', 'public.product_photos', 'select')
     or not has_table_privilege('service_role', 'public.product_photos', 'insert') then
    insert into _errores(msg) values ('Grants: authenticated debía poder leer y service_role escribir product_photos.');
  end if;

  -- RLS encendida.
  if not exists (select 1 from pg_class where oid = 'public.product_photos'::regclass and relrowsecurity) then
    insert into _errores(msg) values ('RLS: product_photos debía tener RLS habilitada.');
  end if;

  -- Los triggers son security invoker (no suben el conteo de funciones definer).
  if exists (
    select 1 from pg_proc p
     join pg_trigger t on t.tgfoid = p.oid
    where t.tgrelid = 'public.product_photos'::regclass and not t.tgisinternal and p.prosecdef
  ) then
    insert into _errores(msg) values ('Triggers: ninguna función de product_photos debía ser security definer.');
  end if;

  -- El bucket es público, con 5 MB y solo JPEG/PNG.
  if not coalesce((select public from storage.buckets where id = 'product-photos'), false) then
    insert into _errores(msg) values ('Bucket: product-photos debía existir y ser público.');
  end if;
  if (select file_size_limit from storage.buckets where id = 'product-photos') is distinct from 5242880 then
    insert into _errores(msg) values ('Bucket: file_size_limit debía ser 5242880.');
  end if;
  if (select allowed_mime_types from storage.buckets where id = 'product-photos') is distinct from array['image/jpeg','image/png'] then
    insert into _errores(msg) values ('Bucket: allowed_mime_types debía ser {image/jpeg,image/png}.');
  end if;

  -- Sin políticas UPDATE ni DELETE sobre el bucket: los objetos no se borran.
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd in ('UPDATE', 'DELETE', 'ALL')
      and (coalesce(qual, '') like '%product-photos%' or coalesce(with_check, '') like '%product-photos%')
  ) then
    insert into _errores(msg) values ('Storage: no debía haber políticas UPDATE/DELETE sobre product-photos.');
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
    raise exception E'fotos_de_productos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'fotos_de_productos.sql: todas las aserciones pasaron.'
