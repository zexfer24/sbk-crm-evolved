-- ============================================================================
-- corregir_terminos: el segundo intento tolerante a tipeos (T2, plan "Seba
-- encuentra, no insiste, y el mostrador no deja a nadie esperando",
-- 28/9/2026; reescrito por T3 de la Entrega A2 "Seba no cotiza lo que no es",
-- 30/9/2026)
--
-- Migración bajo prueba: 20260930020000_corrector_con_limites.sql (reemplaza a
-- 20260928020000_corrector_de_terminos.sql: firma de cuatro parámetros,
-- prefijo, mínimo de 5 letras, lista cerrada de marcas y `clave_fonetica`). La
-- tabla de casos es la de 4.3 del plan: los 7 casos peor y 3 igual del
-- estudio del VPS del 29/9/2026 (sección 2.4 de casos-del-vps).
--
-- Los casos buenos salen de los tipeos reales del estudio del VPS (1.027
-- turnos, 25/9 → 28/9/2026): "horsen" por HORSE, "tisum"/"stinsun" por
-- TIMSUN, "express" por XPRESS, "iphone" por IPONE, "motopower" por
-- MOTORPOWER, "swhera" por SWITCHERA, "ciguañal" por CIGUEÑAL, y "rallo"
-- por RAYO / "vicera" por VISERA (suenan igual). Los malos son los que NO
-- pueden corregirse: palabras válidas que el corrector de la Entrega A
-- cambiaba por otra que también existe ("pareja"→para, "llanta"→lata,
-- "carplay"→cara, "kenda"→anda, "dama"→gama, "frente"→freno,
-- "compresion"→compresor, "alante"→aislante, "numero"→nuevo,
-- "relacion"→reparacion, "medida"→media), los singulares que armó el propio
-- código ("diente", "brazo", "manga", "bidon", "bota", "proteccion",
-- "guarda", "siriu": el término es PREFIJO de una palabra del catálogo) y
-- "beta" (una moto conocida, protegida) que no pasa a "bera".
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que buscar_productos.sql). Todo
-- corre como `postgres` salvo el caso de `service_role`, que baja de rol con
-- `set local role` para probar el grant de verdad.
--
-- Como el vocabulario sale de TODOS los productos activos con precio > 0, la
-- base local (cientos de productos de un ensayo previo) contaminaría los
-- casos: el test desactiva todo producto preexistente al entrar, dentro de la
-- transacción que hace `rollback`, igual que buscar_productos.sql.
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;

update public.products set is_active = false;

-- ---------------------------------------------------------------------------
-- Fixture: nombres reales del catálogo. "beta" NO aparece en ningún nombre
-- (si estuviera, dejaría de necesitar corrección y el caso no probaría nada).
-- ---------------------------------------------------------------------------
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c1000000-0000-0000-0000-000000000001', 'ASIENTO HORSE TX', null, 40.00, 'USD', 2, true),
  ('c1000000-0000-0000-0000-000000000002', 'CAUCHO TIMSUN 90/90-18', 'TIMSUN', 30.00, 'USD', 2, true),
  ('c1000000-0000-0000-0000-000000000003', 'PALANCA XPRESS', null, 8.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000004', 'ACEITE IPONE 20W50', null, 9.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000005', 'GUAYA MOTORPOWER', null, 3.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000006', 'SWITCHERA CLAXON', null, 6.00, 'USD', 5, true),
  ('c1000000-0000-0000-0000-000000000007', 'CIGUEÑAL BERA SBR', null, 90.00, 'USD', 1, true),
  ('c1000000-0000-0000-0000-000000000008', 'RIN BERA KAVAK', null, 25.00, 'USD', 3, true);

-- Desempate por frecuencia: "cesco" está a distancia 1 de casco y de cosco
-- con la MISMA similitud de trigramas; casco aparece en 3 productos y cosco
-- en 1, así que gana casco.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c2000000-0000-0000-0000-000000000001', 'CASCO ABATIBLE', null, 90.00, 'USD', 1, true),
  ('c2000000-0000-0000-0000-000000000002', 'CASCO INTEGRAL', null, 80.00, 'USD', 1, true),
  ('c2000000-0000-0000-0000-000000000003', 'CASCO ABIERTO', null, 70.00, 'USD', 1, true),
  ('c2000000-0000-0000-0000-000000000004', 'COSCO ESPECIAL', null, 10.00, 'USD', 1, true);

-- Desempate por similitud ANTES que por frecuencia: "bujis" está a distancia
-- 1 de bujia y de bujes; bujia se parece más (4 de 8 trigramas contra 3 de
-- 9) aunque bujes aparezca en 3 productos y bujia en 1.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c3000000-0000-0000-0000-000000000001', 'BUJIA NGK', null, 4.00, 'USD', 1, true),
  ('c3000000-0000-0000-0000-000000000002', 'BUJES SWING ARM', null, 4.00, 'USD', 1, true),
  ('c3000000-0000-0000-0000-000000000003', 'BUJES SUSPENSION', null, 4.00, 'USD', 1, true),
  ('c3000000-0000-0000-0000-000000000004', 'BUJES PIÑON', null, 4.00, 'USD', 1, true);

-- Fuera del vocabulario: un producto INACTIVO y uno con precio 0. "filtra"
-- y "pistones" solo existen en ellos, así que NO son palabras válidas: "filtra"
-- y "pistone" se corrigen hacia FILTRO / PISTON (activos, con precio).
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c4000000-0000-0000-0000-000000000001', 'FILTRO ACEITE', null, 5.00, 'USD', 1, true),
  ('c4000000-0000-0000-0000-000000000002', 'FILTRA VIEJO', null, 5.00, 'USD', 1, false),
  ('c4000000-0000-0000-0000-000000000003', 'PISTON STD', null, 20.00, 'USD', 1, true),
  ('c4000000-0000-0000-0000-000000000004', 'PISTONES SIN PRECIO', null, 0.00, 'USD', 1, true);

-- Fixture A2 (30/9/2026): las palabras REALES del catálogo que el corrector
-- de la Entrega A daba por buenos candidatos de palabras que el cliente
-- escribió bien (2.4 del estudio del VPS). EL RUIDO VA PRIMERO: las palabras
-- "equivocadas" (para, lata, cara, anda, gama, freno, compresor, aislante,
-- nuevo, reparacion, media, guaya) se insertan ANTES que las correctas
-- (rayo, visera), como manda CLAUDE.md para los tests de orden.
insert into public.products (id, name, brand, price, currency, stock_quantity, is_active) values
  ('c5000000-0000-0000-0000-000000000001', 'INTERCOMUNICADOR PARA CASCO', null, 60.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000002', 'LIGA FRENO LATA', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000003', 'PROTECTOR CARA', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000004', 'CINTA ANDA', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000005', 'KIT GAMA ALTA', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000006', 'PASTILLA FRENO DELANTERO', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000007', 'COMPRESOR AIRE', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000008', 'CINTA AISLANTE', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000009', 'KIT NUEVO MODELO', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000010', 'KIT REPARACION CALIPER', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000011', 'MEDIA CARETA', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000012', 'GUAYA ACELERADOR', null, 5.00, 'USD', 3, true),
  -- Palabras que el cliente escribe en singular y el catálogo trae en plural
  -- o compuestas: el término ES prefijo de una palabra del vocabulario.
  ('c5000000-0000-0000-0000-000000000013', 'GUARDABARRO DELANTERO', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000014', 'CORONA 36 DIENTES', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000015', 'CAUCHO BRAZOS SUSPENSION', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000016', 'MANGAS PARA FRENO', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000017', 'BIDONES DE ACEITE', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000018', 'BOTAS TEXTIL', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000019', 'PROTECCIONES CODO', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000020', 'CASCO ELECTRON SIRIUS 3120', null, 5.00, 'USD', 3, true),
  -- Las correctas por sonido.
  ('c5000000-0000-0000-0000-000000000021', 'LUZ RAYO LED', null, 5.00, 'USD', 3, true),
  ('c5000000-0000-0000-0000-000000000022', 'VISERA CASCO FRANKIE', null, 5.00, 'USD', 3, true),
  -- T5b (30/9/2026): HONDA está en el catálogo (una moto) a distancia 2 de "kenda".
  ('c5000000-0000-0000-0000-000000000023', 'PASTILLA FRENO DELANTERO HONDA CBF150', null, 5.00, 'USD', 3, true);

-- ---------------------------------------------------------------------------
-- Casos que DEBEN corregirse
--
-- p_marcas es la lista cerrada que `tools.ts` pasa: las marcas de PRODUCTO
-- (`MARCAS_DE_PRODUCTO`, sin motos desde T5b, 30/9/2026; con las motos dentro
-- "kenda" quedaba a distancia 2 de HONDA y se proponía): solo hacia una marca
-- se aceptan las distancias 2 y 3. "tisum"/"stinsun" →
-- timsun y "swhera" → switchera dependen de ella; sin la marca (caso 1b) NO
-- se corrigen.
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
  v_corregido text;
begin
  for caso in
    select * from (values
      ('horsen', 'horse'),
      ('HORSEN', 'horse'),
      ('tisum', 'timsun'),
      ('stinsun', 'timsun'),
      ('express', 'xpress'),
      ('iphone', 'ipone'),
      ('motopower', 'motorpower'),
      ('swhera', 'switchera'),
      ('ciguañal', 'ciguenal'),
      ('ciguanal', 'ciguenal'),
      ('Ciguañal', 'ciguenal'),
      ('cesco', 'casco'),
      ('bujis', 'bujia'),
      ('filtra', 'filtro'),
      -- "pistone" es prefijo de PISTONES, que solo existe con precio 0 (fuera del
      -- vocabulario): si ese producto contara, el prefijo lo protegería.
      ('pistone', 'piston'),
      -- Por sonido: "rallo" suena igual que "rayo" (ll→y) aunque esté a
      -- distancia 2, y "rayo" tiene 4 letras (solo la fonética lo permite).
      ('rallo', 'rayo'),
      -- "vicera" suena igual que "visera" (v→b, c antes de e→s).
      ('vicera', 'visera')
    ) as t(entrada, esperado)
  loop
    select c.corregido into v_corregido
    from public.corregir_terminos(array[caso.entrada], '{}'::text[], array['timsun', 'switchera', 'xpress'], '{}'::text[]) c;
    if v_corregido is distinct from caso.esperado then
      insert into _errores(msg) values (format('Caso 1: "%s" se corrigió a %s; se esperaba "%s".', caso.entrada, coalesce('"' || v_corregido || '"', 'nada'), caso.esperado));
    end if;
  end loop;
end $$;

-- Las distancias 2 y 3 SOLO valen hacia una marca de la lista cerrada: sin
-- p_marcas, "tisum", "stinsun" y "swhera" no se corrigen (dos o tres teclas
-- de diferencia hacia una palabra cualquiera es cambiar de palabra).
do $$
declare
  caso record;
  n integer;
begin
  for caso in select unnest(array['tisum', 'stinsun', 'swhera']) as t loop
    select count(*) into n from public.corregir_terminos(array[caso.t], '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 1b: "%s" se corrigió sin marca en la lista (las distancias 2-3 exigen p_marcas).', caso.t));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Casos que NO pueden corregirse
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
  n integer;
begin
  -- "beta" está a distancia 1 de "bera" (que sí existe); protegida NO cambia.
  select count(*) into n from public.corregir_terminos(array['beta'], array['beta', 'bera']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 2: "beta" protegida se corrigió (una moto conocida jamás pasa a otra).');
  end if;

  -- Desde A2, "beta" ni siquiera sin proteger se corrige a "bera" (el
  -- candidato tiene 4 letras y no suena igual). Para probar que la
  -- protección es la que frena y no otra regla se usa "kavas": sin proteger
  -- se corrige a "kavak" (distancia 1, 5 letras); protegida, no.
  select count(*) into n from public.corregir_terminos(array['kavas'], array['kavas']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 2b: "kavas" protegida se corrigió.');
  end if;
  select count(*) into n from public.corregir_terminos(array['kavas'], '{}'::text[]);
  if n <> 1 then
    insert into _errores(msg) values ('Caso 2b: "kavas" sin proteger debía corregirse a "kavak" (el caso anterior no probaría nada si esto no pasa).');
  end if;

  -- La protección se compara normalizada (acentos, mayúsculas).
  select count(*) into n from public.corregir_terminos(array['BÉTA'], array['beta']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 2c: la lista de protegidos debe compararse sin acentos ni mayúsculas.');
  end if;

  -- Números y términos con dígitos: nunca.
  for caso in select unnest(array['250', 'dt2000', '20w50', '90/90-18', 'xpres2']) as t loop
    select count(*) into n from public.corregir_terminos(array[caso.t], '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 3: el término con dígitos "%s" se corrigió.', caso.t));
    end if;
  end loop;

  -- Una palabra que YA está en el vocabulario no se toca, aunque otra
  -- parecida exista ("bera" está a distancia 1 de "beta"/"rin"...).
  for caso in select unnest(array['horse', 'bera', 'casco', 'bujes', 'BERA']) as t loop
    select count(*) into n from public.corregir_terminos(array[caso.t], '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 4: la palabra "%s", que ya está en el vocabulario, se corrigió.', caso.t));
    end if;
  end loop;

  -- Tres letras o menos: nunca ("ber" está a distancia 1 de "bera").
  for caso in select unnest(array['ber', 'rim', 'xy']) as t loop
    select count(*) into n from public.corregir_terminos(array[caso.t], '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 5: el término corto "%s" se corrigió.', caso.t));
    end if;
  end loop;

  -- Una palabra sin parecido con nada del vocabulario queda como está.
  select count(*) into n from public.corregir_terminos(array['zzzzzzzz', 'quimera'], '{}'::text[]);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 6: una palabra sin parecido con el vocabulario se corrigió a algo.');
  end if;

  -- Arreglo vacío y nulo: cero filas, sin error.
  select count(*) into n from public.corregir_terminos('{}'::text[], '{}'::text[]);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 7: el arreglo vacío devolvió filas.');
  end if;
  select count(*) into n from public.corregir_terminos(null, null);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 7: el arreglo nulo devolvió filas.');
  end if;
  -- Marcas y excluidos nulos: se tratan como vacíos.
  select count(*) into n from public.corregir_terminos(array['horsen'], null, null, null);
  if n <> 1 then
    insert into _errores(msg) values (format('Caso 7: con p_marcas/p_excluidos nulos, "horsen" devolvió %s fila(s); se esperaba 1.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Varios términos a la vez: solo vuelven los corregidos, con `original` tal
-- como se pasó (el llamador lo usa para nombrar "busqué X en lugar de Y").
-- ---------------------------------------------------------------------------
do $$
declare
  v_filas integer;
  v_original text;
  v_corregido text;
begin
  select count(*), min(original), min(corregido) into v_filas, v_original, v_corregido
  from public.corregir_terminos(array['aceite', 'iphone', '20w50', 'bera', 'beta'], array['beta']);
  if v_filas <> 1 or v_original is distinct from 'iphone' or v_corregido is distinct from 'ipone' then
    insert into _errores(msg) values (format('Caso 8: mezcla de términos devolvió %s fila(s) (%s → %s); se esperaba solo iphone → ipone.', v_filas, v_original, v_corregido));
  end if;

  -- El mismo término repetido no duplica filas.
  select count(*) into v_filas from public.corregir_terminos(array['iphone', 'iphone'], '{}'::text[]);
  if v_filas <> 1 then
    insert into _errores(msg) values (format('Caso 8: un término repetido devolvió %s filas; se esperaba 1.', v_filas));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Casos del estudio del VPS del 29/9/2026 (2.4): palabras VÁLIDAS que la
-- Entrega A cambiaba por otra que también existe en el catálogo. Ninguna se
-- corrige, ni con p_excluidos vacío ni con el relleno.
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
  n integer;
  v_relleno text[] := array['para', 'medida', 'media'];
  v_marcas text[] := array['timsun', 'switchera', 'xpress'];
begin
  for caso in
    select * from (values
      ('pareja',     'distancia 2 hacia "para" (4 letras, no suena igual)'),
      ('llanta',     'lata: 4 letras y no suena igual'),
      ('carplay',    'cara: 4 letras'),
      ('kenda',      'anda: 4 letras'),
      ('dama',       'gama: distancia 1 pero 4 letras y no suena igual'),
      ('frente',     'freno: distancia 2 y freno no es marca'),
      ('compresion', 'compresor: distancia 3, no es marca'),
      ('alante',     'aislante: distancia 2, no es marca'),
      ('numero',     'nuevo: distancia 2, no es marca'),
      ('relacion',   'reparacion: distancia 3, no es marca'),
      -- Prefijos: el término ya existe (el catálogo trae una palabra que
      -- EMPIEZA con él), el corrector no debe "pluralizarlo".
      ('siriu',      'prefijo de sirius'),
      ('guarda',     'prefijo de guardabarro'),
      ('diente',     'prefijo de dientes'),
      ('brazo',      'prefijo de brazos'),
      ('manga',      'prefijo de mangas'),
      ('bidon',      'prefijo de bidones'),
      ('bota',       'prefijo de botas'),
      ('proteccion', 'prefijo de protecciones'),
      -- El plural/singular que arma el propio código nunca es "corrección".
      ('frenos',     'plural de freno'),
      ('guayas',     'plural de guaya'),
      ('pistones',   'plural de piston')
    ) as t(entrada, motivo)
  loop
    select count(*) into n from public.corregir_terminos(array[caso.entrada], '{}'::text[], v_marcas, '{}'::text[]);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 13: "%s" se corrigió (%s).', caso.entrada, caso.motivo));
    end if;
    select count(*) into n from public.corregir_terminos(array[caso.entrada], '{}'::text[], v_marcas, v_relleno);
    if n <> 0 then
      insert into _errores(msg) values (format('Caso 13: "%s" se corrigió con p_excluidos (%s).', caso.entrada, caso.motivo));
    end if;
  end loop;

  -- "beta" es una moto: protegida no se corrige.
  select count(*) into n from public.corregir_terminos(array['beta'], array['beta', 'bera'], v_marcas, v_relleno);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 13: "beta" protegida se corrigió.');
  end if;

  -- "medida" sí se corregiría a "media" (distancia 1, 5 letras): por eso
  -- existe p_excluidos (el RELLENO de tools.ts). Este caso prueba que las dos
  -- exclusiones (el término y el candidato) funcionan y que "medida" no era
  -- intocable de por sí.
  select count(*) into n from public.corregir_terminos(array['medida'], '{}'::text[], v_marcas, '{}'::text[]);
  if n <> 1 then
    insert into _errores(msg) values ('Caso 14: sin p_excluidos, "medida" debía corregirse a "media" (si no, el caso 14 no prueba nada).');
  end if;
  select count(*) into n from public.corregir_terminos(array['medida'], '{}'::text[], v_marcas, array['medida']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 14: "medida" está en p_excluidos (el relleno) y se corrigió igual.');
  end if;
  select count(*) into n from public.corregir_terminos(array['medida'], '{}'::text[], v_marcas, array['media']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 14: "media" está en p_excluidos y el corrector la usó de candidato.');
  end if;

  -- Un excluido con mayúsculas y acentos se compara normalizado.
  select count(*) into n from public.corregir_terminos(array['medida'], '{}'::text[], v_marcas, array['MÉDIDA']);
  if n <> 0 then
    insert into _errores(msg) values ('Caso 14: p_excluidos debe compararse sin acentos ni mayúsculas.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- clave_fonetica: suena igual = misma clave.
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
begin
  for caso in
    select * from (values
      ('rallo', 'rayo'),
      ('vicera', 'visera'),
      ('bicera', 'visera'),
      ('casa', 'caza'),
      ('kilo', 'quilo'),
      ('iphone', 'ipone'),
      ('hola', 'ola'),
      ('carro', 'caro'),
      ('cemento', 'semento'),
      ('cielo', 'sielo')
    ) as t(a, b)
  loop
    if public.clave_fonetica(caso.a) is distinct from public.clave_fonetica(caso.b) then
      insert into _errores(msg) values (format('Caso 15: clave_fonetica("%s") = %s y clave_fonetica("%s") = %s; debían coincidir.', caso.a, public.clave_fonetica(caso.a), caso.b, public.clave_fonetica(caso.b)));
    end if;
  end loop;

  -- Y estas NO suenan igual (claves distintas).
  for caso in
    select * from (values
      ('dama', 'gama'),
      ('lata', 'llanta'),
      ('pareja', 'para'),
      ('chino', 'sino'),
      ('frente', 'freno')
    ) as t(a, b)
  loop
    if public.clave_fonetica(caso.a) = public.clave_fonetica(caso.b) then
      insert into _errores(msg) values (format('Caso 15: clave_fonetica("%s") y ("%s") coinciden (%s); no debían.', caso.a, caso.b, public.clave_fonetica(caso.a)));
    end if;
  end loop;

  if public.clave_fonetica(null) is not null then
    insert into _errores(msg) values ('Caso 15: clave_fonetica(null) debía ser null.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Permisos y forma: la llama solo service_role; security invoker; stable.
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig regprocedure := 'public.corregir_terminos(text[], text[], text[], text[])'::regprocedure;
  v_sig_fon regprocedure := 'public.clave_fonetica(text)'::regprocedure;
  v_seg_definer boolean;
  v_volatilidad "char";
  v_ns_trgm regnamespace;
  v_ns_fuzzy regnamespace;
  v_filas integer;
  v_old_existe boolean;
begin
  if has_function_privilege('anon', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: anon puede ejecutar corregir_terminos.');
  end if;
  if has_function_privilege('authenticated', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: authenticated puede ejecutar corregir_terminos.');
  end if;
  if not has_function_privilege('service_role', v_sig, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: service_role NO puede ejecutar corregir_terminos.');
  end if;

  -- La firma vieja de dos parámetros se retiró (dos sobrecargas harían
  -- ambigua la llamada por nombres).
  select exists (
    select 1 from pg_proc
    where proname = 'corregir_terminos' and pronargs = 2 and pronamespace = 'public'::regnamespace
  ) into v_old_existe;
  if v_old_existe then
    insert into _errores(msg) values ('Caso 9: sigue existiendo corregir_terminos(text[], text[]); la migración debía retirarla con drop.');
  end if;

  if has_function_privilege('anon', v_sig_fon, 'EXECUTE') or has_function_privilege('authenticated', v_sig_fon, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: anon/authenticated pueden ejecutar clave_fonetica.');
  end if;
  if not has_function_privilege('service_role', v_sig_fon, 'EXECUTE') then
    insert into _errores(msg) values ('Caso 9: service_role NO puede ejecutar clave_fonetica.');
  end if;
  if (select provolatile from pg_proc where oid = v_sig_fon) <> 'i' then
    insert into _errores(msg) values ('Caso 10: clave_fonetica debe ser immutable.');
  end if;

  select prosecdef, provolatile into v_seg_definer, v_volatilidad from pg_proc where oid = v_sig;
  if v_seg_definer then
    insert into _errores(msg) values ('Caso 10: corregir_terminos es security definer; debe ser security invoker (la llama service_role, que ya salta RLS).');
  end if;
  if v_volatilidad <> 's' then
    insert into _errores(msg) values (format('Caso 10: corregir_terminos tiene volatilidad %s; debe ser stable.', v_volatilidad));
  end if;

  -- fuzzystrmatch en el MISMO schema que pg_trgm (el search_path fijo de la
  -- función enumera schemas conocidos; si divergen, una de las dos
  -- funciones no se resuelve en producción).
  select extnamespace::regnamespace into v_ns_trgm from pg_extension where extname = 'pg_trgm';
  select extnamespace::regnamespace into v_ns_fuzzy from pg_extension where extname = 'fuzzystrmatch';
  if v_ns_fuzzy is null then
    insert into _errores(msg) values ('Caso 11: fuzzystrmatch no está instalada.');
  elsif v_ns_fuzzy is distinct from v_ns_trgm then
    insert into _errores(msg) values (format('Caso 11: fuzzystrmatch vive en %s y pg_trgm en %s; deben ser el mismo schema.', v_ns_fuzzy, v_ns_trgm));
  end if;

  -- Ejecutada COMO service_role (la llamada real): necesita leer products y
  -- resolver levenshtein/similarity/clave_fonetica con el search_path fijo.
  set local role service_role;
  select count(*) into v_filas from public.corregir_terminos(array['horsen', 'rallo'], '{}'::text[], '{}'::text[], '{}'::text[]);
  reset role;
  if v_filas <> 2 then
    insert into _errores(msg) values (format('Caso 12: como service_role, "horsen" y "rallo" devolvieron %s fila(s); se esperaban 2.', v_filas));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 13 · kenda NO se corrige hacia una MOTO (T5b, 30/9/2026). `tools.ts`
-- pasa como p_marcas solo las marcas de producto; con una moto (honda) dentro
-- de la lista, "kenda" a distancia 2 se proponía. La función sigue aceptando
-- cualquier marca que reciba (dato del llamador): el candado es de quien la
-- llama, y este caso fija las dos caras.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from public.corregir_terminos(array['kenda'], '{}'::text[], array['timsun', 'switchera', 'ipone'], '{}'::text[]);
  if n <> 0 then
    insert into _errores(msg) values (format('Caso 13: "kenda" con solo marcas de producto en p_marcas devolvió %s fila(s); se esperaban 0.', n));
  end if;

  select count(*) into n from public.corregir_terminos(array['kenda'], '{}'::text[], array['timsun', 'honda'], '{}'::text[]);
  if n <> 1 then
    insert into _errores(msg) values (format('Caso 13: con honda en p_marcas, "kenda" devolvió %s fila(s); se esperaba 1 (la fuga que tools.ts ya no abre).', n));
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
    raise exception E'corregir_terminos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'corregir_terminos.sql: todas las aserciones pasaron.'
