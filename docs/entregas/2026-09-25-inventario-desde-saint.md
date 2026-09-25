# Entrega "El inventario llega de Saint y no se toca a mano", 25/9/2026

Para el Claude del VPS. Plan aprobado: "El inventario llega de Saint y no se
toca a mano" (operador, 24-25/9/2026). Contexto: `public.products` (5.438
filas) se cargó una sola vez el 24/8/2026 y quedó congelada — precios 13,4 %
por debajo de Saint, 602 códigos que la IA no conocía, 24 nombres viejos —
mientras la réplica Liminal ya copiaba `SAPROD` de Saint en vivo a
`public.saprod` (pronto `saint.saprod`) y cualquier asesor logueado podía
cambiar stock/precio o borrar productos llamando a la API directo. Esta
entrega hace de Saint el único dueño real del inventario.

**Este documento se escribió ANTES de que el orquestador commiteara nada**
(tarea de documentación, T4 del plan — commit y push todavía no existen al
momento de escribir esto). Cuando el orquestador cierre la corrida vas a
recibir dos commits, en este orden estricto:

1. Un commit `[migración]` con `supabase/migrations/20260925010000_inventario_desde_saint.sql`,
   su test `supabase/tests/saint_sync_products.sql` y el paso nuevo de CI.
2. Un commit de código con la pantalla de Inventario y `src/lib/*` — este
   commit lee `saint_added_at` y compañero: **sin la migración ya aplicada,
   Inventario se cae** (falta la columna en el `select`).

## Orden obligatorio (no invertir)

El push a `main` dispara el deploy de Dokploy, que **no aplica migraciones
por sí solo**. Por eso:

1. Se pushea SOLO el commit `[migración]` primero.
2. Vos la aplicás contra la base (sección "Aplicación", abajo) y confirmás
   los conteos.
3. Recién con esa confirmación, el orquestador pushea el commit de código.

Al revés no es grave, pero sí visible: con la migración aplicada y el
código VIEJO todavía corriendo, el campo Stock sigue mostrándose como
`<input>` en pantalla y cualquier intento de guardarlo falla con un toast
("No se pudo guardar el cambio.") porque la base ya rechaza el `UPDATE` —
no rompe nada, pero confunde al asesor. Lo peligroso es el orden contrario
(código antes que migración): eso sí revienta la pantalla entera, porque el
`select` de `inventory-data.ts` pide columnas que todavía no existen.

---

## Antes de aplicar (solo lectura, no toca nada)

### (a) Permisos: `postgres` tiene que poder leer la fuente y la réplica

`saint.sync_products()` es `security definer`, corre como su dueño
(`postgres`/`supabase_admin` en cualquier ruta de aplicación de esta
migración). Si `postgres` no puede leer `saint.saprod`/`public.saprod` o
`liminal.*`, la función NO lanza — el error queda en `saint.sync_log.error`
y el cron sigue corriendo cada minuto sin sincronizar nada, en silencio.
Verificar ANTES de aplicar:

```sql
select has_table_privilege('postgres', 'public.saprod', 'select') as puede_leer_public_saprod;
-- si ya existe saint.saprod (mudanza en curso o completa):
select has_table_privilege('postgres', 'saint.saprod', 'select') as puede_leer_saint_saprod;
select has_table_privilege('postgres', 'liminal.applied_events', 'select') as puede_leer_applied_events;
select has_table_privilege('postgres', 'liminal.agent_status', 'select') as puede_leer_agent_status; -- puede no existir todavía, ver más abajo

select rolbypassrls from pg_roles where rolname = 'postgres';
```

Si alguna de las tablas fuente tiene RLS y `postgres` NO tiene
`rolbypassrls`, hace falta una política o un grant explícito antes de que
la sincronización sirva de algo — la función seguiría sin lanzar, solo
dejaría de sincronizar nada útil.

### (b) Si la "ventana de mantenimiento" (la columna `activo` en la fuente) ya pasó

```sql
select activo, count(*) from saint.saprod group by 1 order by 1;
-- (o public.saprod si saint.saprod todavía no existe)
```

La función trata `coalesce(activo, 1) = 1` como "activo", cualquier otro
valor como "inactivo". Si aparecen valores además de `1`/`0`/`null` (por
ejemplo `2`, `-1`), **avisá antes de aplicar** — la migración no falla con
esos valores, pero pueden estar codificando algo que el operador no
consideró (una baja distinta de "fuera de Saint", por ejemplo).

### (c) Cuántos productos están vinculados hoy

```sql
select count(*) from public.products where description ~ '^Código ERP: ';
-- esperado: 5.438, sin duplicados de "Código ERP: <codprod>"
select codprod, count(*)
from (select substring(description from '^Código ERP: (.+)$') as codprod
      from public.products where description ~ '^Código ERP: ') s
group by codprod having count(*) > 1;
-- esperado: 0 filas
```

Si aparece algún duplicado, el `create unique index ... where saint_code is
not null` de la migración va a fallar al crearse — mejor saberlo antes que
ver el `ON_ERROR_STOP` abortar a mitad de camino.

### (d) Transacciones largas / locks que puedan chocar

Mismo chequeo que en las entregas anteriores (§11 de `docs/PRODUCCION.md`):

```sql
select pid, now() - xact_start as duracion, state, left(query, 100) as query
from pg_stat_activity
where xact_start is not null
order by duracion desc
limit 20;
```

---

## Aplicación

```bash
PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260925010000_inventario_desde_saint.sql \
  "$DATABASE_URL"
```

o, dentro del contenedor:

```bash
docker exec -i supabase-db env PGOPTIONS="-c lock_timeout=5s" psql -U postgres -d postgres \
  -1 -v ON_ERROR_STOP=1 \
  -f - < supabase/migrations/20260925010000_inventario_desde_saint.sql
```

**Aborta sola si falta `-1`** (la guarda de cabecera detecta el NO-OP
silencioso de `set local lock_timeout` fuera de transacción, mismo patrón
que todas las migraciones desde el 16/9/2026). Si aborta con ese mensaje,
repetir el comando tal cual, sin quitar el `-1`.

**Tiempo medido en local con volumen real** (24-25/9/2026, 5.438 productos +
`public.saprod` de 6.035 filas, SIN columna `activo`): **0,79 s en total**
(`\timing`), de los cuales `saint.sync_products()` sola tomó **260 ms**.
Con `psql -1` la migración entera es una transacción: el `ACCESS EXCLUSIVE`
de los `ALTER TABLE` sobre `products` dura hasta el COMMIT, carga inicial
incluida — **la IA no puede leer `products` durante ese lapso**. Menos de un
segundo es corto, pero igual conviene aplicarla fuera de hora pico, como
el resto de las migraciones de septiembre.

Sale con `NOTICE: 20260925010000: autoverificación del inventario desde
Saint correcta.` si entró bien; con `EXCEPTION` (18 chequeos posibles, ver
el bloque final del archivo) si algo quedó a medias.

Registrar en `supabase_migrations.schema_migrations` (no se registra sola):

```sql
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260925010000', '20260925010000_inventario_desde_saint');
```

Verificar: `select count(*) from supabase_migrations.schema_migrations;` →
el número que tenía producción antes de esta entrega, **+1**.

---

## Verificación inmediata (tras aplicar, antes de confirmar al orquestador)

### 1. La fila de la carga inicial en `saint.sync_log`

```sql
select id, created_at, fuente, duracion_ms, actualizados, insertados, bajas,
       reactivados, desactivados_por_saint, confirmados, saltados,
       precio_conservado, guarda_activada, forzado, error
from saint.sync_log
order by created_at desc
limit 3;
```

**Esperado en producción** (mismo orden de magnitud que la medición en
local, no números exactos — producción tiene datos reales que local no
puede replicar del todo):

- `error` debe ser `null`. Si no lo es, revisar el punto (a) de "Antes de
  aplicar" (permisos) antes de seguir con cualquier otro paso.
- `actualizados`: **~5.425-5.433** (5.425 por el ajuste de precio ×1,134
  más los 24 nombres renombrados — pueden solaparse: un producto que cambia
  de precio Y de nombre cuenta una sola vez en `actualizados`).
- `insertados`: **602** (los códigos que la IA no conocía).
- `bajas`: **5** (`GE02`, `MTG002`, `MTG003`, `MTG004`, `MTG005` — quedan
  `is_active = false` con `saint_removed_at` sellado; ninguno se borra).
- `reactivados`: **2** (`11312AM`, `2555`).
- `guarda_activada`: debe ser `false` (5 bajas está muy por debajo del tope
  de 50, y la cobertura debería estar cerca del 100 % en una carga inicial
  sana). Si sale `true`, algo no cuadra con lo esperado — no forzar sin
  entender por qué antes.
- `confirmados`: depende de si `liminal.applied_events` (o
  `liminal.agent_status`, si ya existe) tiene alguna fila de las últimas
  36 h (o 15 min, respectivamente) al momento de la corrida — puede dar
  `0` o el total de vinculados, los dos son válidos según el estado de la
  réplica en ese instante.

### 2. Los dos jobs de pg_cron quedaron agendados

```sql
select jobid, jobname, schedule, active from cron.job order by jobname;
```

Esperado: `saint-sync-products` (`* * * * *`) y `saint-sync-log-purge`
(`30 3 * * *`), los dos `active = true`.

### 3. El job corre solo (esperar ~2 minutos)

```sql
select jrd.jobid, j.jobname, jrd.status, jrd.start_time, jrd.end_time
from cron.job_run_details jrd
join cron.job j on j.jobid = jrd.jobid
where j.jobname = 'saint-sync-products'
order by jrd.start_time desc
limit 5;
```

Debe verse al menos una corrida con `status = 'succeeded'`, distinta de la
que dejó la migración al aplicarse (esa corrió DENTRO de la transacción de
`psql -1`, no la ve `pg_cron`).

### 4. Nadie de la API puede ejecutar `sync_products()`

```sql
select
  has_function_privilege('anon', 'saint.sync_products(regclass, boolean)', 'execute') as anon_puede,
  has_function_privilege('authenticated', 'saint.sync_products(regclass, boolean)', 'execute') as authenticated_puede,
  has_function_privilege('service_role', 'saint.sync_products(regclass, boolean)', 'execute') as service_role_puede;
-- las tres: false
```

### 5. El candado sobre `products`, como `authenticated` de verdad

Dentro de una transacción con `rollback` (no toca datos reales):

```sql
begin;
set local role authenticated;
-- un UUID de un producto real de la base, cualquiera:
-- select id from products limit 1;
update public.products set stock_quantity = 999999 where id = '<uuid-de-un-producto-real>';
-- esperado: ERROR ("El inventario llega de Saint y no se edita a mano." o
-- "permission denied for table products", según si el grant de columna o
-- el trigger es lo que frena primero)
rollback;

begin;
set local role authenticated;
update public.products set weight_kg = 1.234 where id = '<mismo-uuid>';
-- esperado: UPDATE 1, sin error
select product_id, peso_anterior, peso_nuevo, db_role
from public.product_weight_audit
where product_id = '<mismo-uuid>'
order by changed_at desc limit 1;
-- esperado: una fila con peso_nuevo = 1.234 y db_role = 'authenticated'
rollback; -- deshace el UPDATE de peso también, no queda nada aplicado
```

### 6. Un precio de ejemplo, 13,4 % sobre el viejo

```sql
-- comparar el precio de un producto conocido ANTES/DESPUÉS con tu propio
-- registro, o simplemente confirmar que el aumento promedio sobre los
-- 5.425 actualizados por precio ronda 13,4 % — es el ajuste que el
-- operador ya confirmó esperar (precio3 de Saint es el vigente).
```

---

## Después del deploy del código (paso 2 del orden obligatorio)

Una vez que el commit de código ya está en producción y la pantalla de
Inventario funciona sin el campo Stock editable:

```sql
revoke update (updated_at) on public.products from authenticated;
```

Verificar:

```sql
select has_column_privilege('authenticated', 'public.products', 'updated_at', 'update');
-- esperado: false
select has_column_privilege('authenticated', 'public.products', 'weight_kg', 'update');
-- esperado: true (este grant se queda para siempre — es el único campo que sigue editándose)
```

Sin este paso, `authenticated` sigue pudiendo tocar `updated_at` de forma
inocua (el trigger la revierte igual para cualquier UPDATE real de
`weight_kg`), pero es un permiso de más que no tiene motivo de seguir vivo
una vez que el código deja de mandarlo en el payload.

---

## La mudanza de `public.saprod` a `saint.saprod`

`saint.sync_products()` resuelve la fuente con `coalesce(p_source,
to_regclass('saint.saprod'), to_regclass('public.saprod'))` — en cuanto el
proyecto de la réplica Liminal complete la mudanza y `saint.saprod` exista,
la función empieza a preferirla sola, sin ningún cambio de código ni de
migración de este lado.

**Durante la mudanza**, si una corrida del cron ve la tabla nueva vacía o a
medio llenar, la guarda de bajas por ausencia va a frenar (cobertura por
debajo del 90 %) y quedará `guarda_activada = true` en `saint.sync_log` —
es el comportamiento correcto, no un bug: mejor que la sincronización se
frene sola a que desactive medio catálogo por una réplica incompleta. **No
forzar bajas (`p_forzar_bajas = true`) hasta que la réplica esté completa**
y `saint.sync_log` muestre corridas normales sin `guarda_activada`.

Si después de la mudanza `public.saprod` sigue existiendo pero queda vacía
o desactualizada mientras `saint.saprod` ya tiene datos: **`saint.saprod`
tiene prioridad siempre que exista**, así que no hay nada que hacer del
lado de esta migración — el `coalesce` ya la prefiere.

---

## La guarda de bajas por ausencia: cuándo leer `sync_log` y cuándo forzar

La guarda frena las bajas por ausencia (nunca las de `activo ≠ 1`, esas se
aplican siempre) cuando la fuente cubre menos del 90 % de los productos
vinculados todavía no removidos, o cuando la corrida daría de baja por
ausencia a más de 50 de una vez. Las dos situaciones dejan
`guarda_activada = true` en `saint.sync_log`, con `bajas = 0`.

Antes de forzar, **leer por qué se activó**:

```sql
select created_at, fuente, guarda_activada, bajas, error
from saint.sync_log
where guarda_activada
order by created_at desc
limit 10;
```

Si la razón es una réplica incompleta o un corte real de la fuente (no una
baja masiva legítima de Saint), **no forzar** — esperar a que la fuente se
normalice y la corrida siguiente sin forzar ya se encarga sola (como
prueba el caso 12 del test: la corrida normal siguiente, con la fuente
completa de nuevo, reactiva sin volver a activar la guarda).

Si la razón es una baja masiva real (Saint dio de baja un lote grande de
productos a propósito), forzar UNA vez:

```sql
select saint.sync_products(null, true);
```

El cron nunca pasa `p_forzar_bajas = true` por su cuenta — esto es
exclusivamente un comando manual del VPS, después de leer `sync_log`.

---

## Confirmación cada 6 horas y el "vivo" del agente de réplica

Con SOLO `liminal.applied_events` (sin `liminal.agent_status` todavía, que
es el estado de hoy, 25/9/2026), un fin de semana sin cambios en Saint
(sábado tarde → lunes temprano) puede superar la ventana de 36 h: durante
esas horas el catálogo se muestra "sin confirmar" en el panel de
Inventario (más de dos días de antigüedad en `updated_at`) aunque no haya
pasado nada malo — la sincronización sigue corriendo, solo que no tiene
ningún evento reciente contra el cual medir que el agente sigue vivo. Esto
se resuelve solo cuando el proyecto Liminal agregue `liminal.agent_status`
(la función ya la prefiere en cuanto exista, sin ningún cambio de este
lado) — no es nada que el VPS tenga que corregir a mano mientras tanto.

---

## Monitoreo — consultas útiles

```sql
-- Últimas 20 corridas, resumen.
select created_at, fuente, duracion_ms, actualizados, insertados, bajas,
       reactivados, desactivados_por_saint, confirmados, guarda_activada, forzado, error
from saint.sync_log
order by created_at desc
limit 20;

-- Solo las que dejaron error.
select created_at, fuente, error
from saint.sync_log
where error is not null
order by created_at desc
limit 20;

-- Solo las que activaron la guarda.
select created_at, fuente, bajas, guarda_activada
from saint.sync_log
where guarda_activada
order by created_at desc
limit 20;

-- Historial del job de cron (éxitos/fallos).
select jrd.status, count(*)
from cron.job_run_details jrd
join cron.job j on j.jobid = jrd.jobid
where j.jobname = 'saint-sync-products'
  and jrd.start_time > now() - interval '24 hours'
group by 1;
```

**Purga diaria** (job `saint-sync-log-purge`, 3:30 am): `saint.sync_log` se
recorta a 14 días, `cron.job_run_details` a 7 días. No hace falta ninguna
intervención manual para eso.

---

## Reversa de emergencia

Si algo sale mal y hace falta parar la sincronización SIN tocar los datos
ya escritos:

```sql
select cron.unschedule('saint-sync-products');
```

Esto detiene el job (deja de correr cada minuto) sin revertir ninguna fila
de `products` ni deshacer el candado — el candado (grants + trigger) se
queda activo, así que la app sigue sin poder editar el inventario a mano
aunque la sincronización esté parada. Para reanudar, reaplicar la sección
7 de la migración (`select cron.schedule('saint-sync-products', '* * * * *', $$select saint.sync_products()$$);`)
o simplemente reaplicar el archivo completo (es idempotente: `cron.schedule`
por nombre actualiza el job existente, no lo duplica).

Revertir el candado en sí (si hiciera falta volver a permitir la edición
manual, algo que el plan no contempla como escenario normal) exige
deshacer los grants y los dos triggers — no hay un `DROP` de una sola línea
preparado para eso a propósito: es una decisión de negocio, no un ajuste
técnico reversible con un comando.

---

## El precio sube 13,4 % de golpe

Confirmado por el operador (24/9/2026): `precio3` de Saint es el precio
vigente, y `public.products` venía 13,4 % por debajo desde la carga del
24/8/2026. Los **5.425 productos actualizados por precio** de la carga
inicial van a mostrar ese salto de una vez — no es un error de la
migración, es el catálogo poniéndose al día con el precio real. Vale la
pena que el operador avise al equipo de ventas antes de que un asesor vea
el salto y pregunte.

---

## Qué debe devolver el Claude del VPS

1. Resultado del punto (a)/(b)/(c) de "Antes de aplicar" — en particular si
   `postgres` no pudo leer alguna tabla fuente, o si aparecieron valores de
   `activo` fuera de `0`/`1`/`null`.
2. Confirmación de que la migración entró con el `NOTICE` de
   autoverificación (o el `EXCEPTION` completo si abortó).
3. La fila de `saint.sync_log` de la carga inicial (los conteos reales,
   contra los esperados de la sección "Verificación inmediata").
4. Los dos jobs de `cron.job` y al menos una corrida `succeeded` de
   `cron.job_run_details` tras ~2 minutos.
5. El resultado de las pruebas de permisos/candado (secciones 4 y 5 de
   "Verificación inmediata").
6. `select count(*) from supabase_migrations.schema_migrations;` antes y
   después.
7. Recién con todo eso en verde, dar luz verde al orquestador para pushear
   el commit de código — y, después de que ese código esté en producción,
   confirmar el `revoke update (updated_at)` final.
