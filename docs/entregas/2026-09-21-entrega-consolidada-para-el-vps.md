# Entrega consolidada para el Claude del VPS (21/9/2026)

Este documento reemplaza, para efectos de EJECUCIÓN, a
`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md` (95 KB) y a
`docs/entregas/2026-09-19-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`
(los dos siguen siendo la fuente de detalle por commit si algo de acá no
alcanza). Todo lo que sigue está copiado o resumido de `docs/PRODUCCION.md`
§11 ("Entrega de 'Seba atiende el mostrador' + 'Nada sin leer…' + 'Seba sale
sin pisar a nadie'", desde la línea ~1210) y de esos dos documentos — cada
bloque cita su origen. No se inventó ningún comando nuevo.

**Decisión del operador del 21/9/2026: el script
`scripts/sql/2026-09-18-catalogos-iniciales.sql` YA NO es un paso del
despliegue.** §11 lo conserva como paso 10 marcado "(OPCIONAL)", solo como
alternativa — no lo corras salvo pedido explícito del operador. El operador
va a cargar las URLs de catálogo a mano, después del deploy, desde
`/agent-control` → Enlaces de catálogo (crear el catálogo, después pegar
`{{catalogo:<clave>}}` en el escenario o mensaje rápido). Ver la sección 3,
paso 10, y la sección 8, más abajo, para el detalle completo de qué cambia
con esto.

---

## 1. Resumen de una pantalla

- **Rango:** `3802fad` (producción, confirmada por última vez el 21/9/2026
  00:49 VET) → HEAD de main local al entregar, `a476f75` (66 commits sobre
  producción; puede haber un commit de documentación más al cerrar este
  encargo — confirmar con `git log --oneline 3802fad..HEAD | wc -l` antes de
  desplegar).
- **Migraciones: SEIS**, en orden de fecha, todas ANTES del código:
  `20260916010000`, `20260917010000`, `20260917020000`, `20260918010000`,
  `20260918020000`, `20260921010000`.
- **Variables de entorno:** ninguna nueva ni cambiada en todo el rango
  `3802fad..HEAD` (verificado: cada commit de los dos reportes de origen
  dice "Variables de entorno: ninguna"; `.env.example` no cambió en el
  rango).
- **Costo:** varios commits tocan UI (Inventario, Control IA, Ventas) →
  rebuild completo, ~5 min.
- **Ventana recomendada: 03:00–05:00 VET** (medición del 21/9/2026: 1 y 0
  mensajes entrantes en los últimos 7 días a esas horas; el pico del día es
  a las 11:00 con 1.444 mensajes). Fuente: `docs/PRODUCCION.md` §11, nota
  "Medición de solo lectura, 21/9/2026".
- **`buscar_repuesto` se despliega APAGADA** (así está en producción desde
  el 25/8/2026) — el operador la enciende después, con asesores mirando.
  Ver sección 5.
- **El UPDATE operativo de C1** (chats asignados a mano con la IA todavía
  encendida) toca **30 conversaciones** con el volumen medido el
  21/9/2026. Ver sección 3, paso 4.

---

## 2. Antes de nada

**No asumas `3802fad`.** Confirmá en qué commit está producción de verdad
antes de calcular qué falta: el hash desplegado (`git rev-parse HEAD` en el
checkout del servidor) y la última migración registrada:

```sql
select version, name from supabase_migrations.schema_migrations
order by version desc limit 1;
-- esperado: 20260915010000
```

- Si producción está en `3802fad` y la última migración es `20260915010000`
  → seguí con este documento tal cual, rango completo.
- Si producción **no** es `3802fad` o la base **no** está en
  `20260915010000` → **PARAR y avisar al operador antes de tocar nada**: otra
  sesión pudo haber entregado parte de este rango, y aplicar una migración
  ya aplicada, o saltarse una, no es seguro a ciegas. (Fuente: patrón exigido
  en los dos documentos de origen, "Antes de nada: confirmar en qué commit
  está producción", y CLAUDE.md, "Preguntar en qué commit está producción".)

---

## 3. Orden operativo

Copiado de `docs/PRODUCCION.md` §11 ("Orden corregido, once pasos"), con el
paso del script de catálogos (antiguo paso 10) sacado por la decisión del
operador del 21/9/2026 — queda renumerado y marcado "FUERA DE ALCANCE" donde
corresponde. Ningún paso se salta ni se reordena.

### 1. Medir (solo lectura, antes de tocar nada)

```sql
-- C1: cuántos chats asignados hoy corren con la IA todavía encendida.
select count(*) from public.conversations
where status <> 'closed' and assigned_agent_id is not null and ai_enabled;

-- A1: cuántos chats ya tienen respuesta real pero welcome_sent_at
-- todavía no existe con la semántica nueva (magnitud del backfill).
select count(*) from public.conversations
where has_reply and welcome_sent_at is null;

-- Transacciones largas / locks que puedan chocar con las migraciones.
select pid, now() - xact_start as duracion, state, left(query, 100) as query
from pg_stat_activity
where xact_start is not null
order by duracion desc
limit 20;

-- Tope de gasto vigente y consumo del día en curso.
select s.daily_spend_cap_usd, public.agent_spend_today() as gasto_hoy
from public.agent_settings s;
```

Guardá los resultados: son la línea de base contra la que se compara
después de migrar. (§11, paso 1.)

### 2. Respaldo terminado

`scripts/backup.sh` (§8 de `docs/PRODUCCION.md`) — esperar a que termine de
verdad, no lanzarlo en paralelo con el paso 3.

### 3. Las seis migraciones, en orden, fuera de hora pico, avisando al equipo ANTES de migrar

Cada una con:

```bash
PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f <archivo>.sql "$DATABASE_URL"
```

o, dentro del contenedor:

```bash
docker exec -i supabase-db psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f - < <archivo>.sql
```

(`PGOPTIONS` no aplica dentro del contenedor porque `psql` ya corre local;
las seis migraciones ya traen `set local lock_timeout = '5s'` adentro, no
hace falta pasarlo por fuera.)

**Las seis ABORTAN solas si falta `-1 -v ON_ERROR_STOP=1`** (guarda interna
que detecta el NO-OP silencioso de `set local lock_timeout` fuera de
transacción). Si una aborta con ese mensaje, no es un bug de la migración:
repetir el comando tal cual, sin quitar el `-1`.

**Salvedad para `20260916010000` y `20260917010000`:** estas dos traen su
propio `begin;`/`commit;` en el archivo (arreglo de un interbloqueo real con
`lock table … in share row exclusive mode` sobre `conversation_handoffs` —y
`messages` en la 0917— antes de tocar filas; `lock table` exige un bloque de
transacción explícito, que `-1` no provee). En **estas dos, y solo estas
dos**, correr SIN `-1` ya NO aborta (el archivo abre y cierra su propia
transacción); CON `-1` salen dos WARNING inofensivos ("already a transaction
in progress" / "no transaction in progress") — no son errores, no hay que
investigarlos. Las otras cuatro no tienen este patrón: su guarda sigue
abortando sin `-1`, sin cambios.

Orden estricto:

1. `20260916010000_devolucion_a_la_ia.sql`
2. `20260917010000_seba_y_escalada_viva.sql`
3. `20260917020000_ai_lessons.sql`
4. `20260918010000_catalog_links.sql`
5. `20260918020000_factura_saint.sql`
6. `20260921010000_escenario_cede_al_inventario.sql` (sin relación de
   dependencia con las otras cinco — va al final solo por ser la última en
   llegar). Verificar por efecto:
   ```sql
   select column_default, is_nullable from information_schema.columns
   where table_name = 'ai_playbooks' and column_name = 'cede_al_inventario';
   -- 'false' | 'NO'
   ```

**Aviso al equipo, justo antes de este paso, no después:** desde que
`20260917010000` entra, cualquier mensaje REAL que un asesor mande a un
cliente (no una nota interna) apaga a Seba en ese chat. Es el comportamiento
que el cliente pidió, pero el equipo tiene que saberlo antes: un mensaje "de
prueba" en un chat que Seba atiende bien la silencia ahí mismo.

Registrar las seis en `supabase_migrations.schema_migrations` (no se
registran solas), después de que cada una haya entrado de verdad:

```sql
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260916010000', '20260916010000_devolucion_a_la_ia'),
  ('20260917010000', '20260917010000_seba_y_escalada_viva'),
  ('20260917020000', '20260917020000_ai_lessons'),
  ('20260918010000', '20260918010000_catalog_links'),
  ('20260918020000', '20260918020000_factura_saint'),
  ('20260921010000', '20260921010000_escenario_cede_al_inventario');
```

Verificar: `select count(*) from supabase_migrations.schema_migrations;` →
**76**.

### 4. UPDATE operativo de C1

Mitigación para los chats que YA están asignados a mano desde antes del
deploy (el código de T10 solo protege las asignaciones que ocurran DESPUÉS
de que el código esté vivo):

```sql
update public.conversations
set ai_enabled = false
where assigned_agent_id is not null and ai_enabled and status <> 'closed';
```

Corre DESPUÉS de las seis migraciones (necesita el trigger de
`20260917010000`) y ANTES del push del código — si se corre después del
push, hay una ventana donde Seba corre turnos completos en esos chats sin
que nada la frene. Con el volumen del 21/9/2026 este UPDATE toca **30
conversaciones**: verificar el "UPDATE 30" que devuelve contra ese número
antes de seguir.

Efecto colateral deseado (no a corregir): este UPDATE deja una fila
`silenciada_por_asesor` por cada chat que toca; un "Desasignar" posterior
sobre esos chats, si el asesor nunca le escribió de verdad al cliente,
reenciende a Seba solo.

### 5. `notify pgrst` + dos GET de humo

Las seis migraciones ya terminan en `notify pgrst, 'reload schema'`. Antes
de pushear el código, confirmar que el reload surtió efecto:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://<tu-proyecto>.supabase.co/rest/v1/catalog_links?select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# 200 — nunca 400/404

curl -s -o /dev/null -w "%{http_code}\n" "https://<tu-proyecto>.supabase.co/rest/v1/ai_lessons?select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# 200 — nunca 400/404
```

`20260921010000` no agrega tabla nueva (solo una columna a `ai_playbooks`,
ya servida por REST), así que no hace falta un tercer GET — si el reload no
llegó ahí, el síntoma sería un 400 al mandar `cede_al_inventario` desde el
panel, no un 400 en la tabla entera.

### 6. Comprobación única de tablas/columnas/trigger, ANTES del push

```sql
select 'conversations.ai_resume_cutoff_at' as chequeo,
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'conversations'
                 and column_name = 'ai_resume_cutoff_at') as ok
union all
select 'conversation_handoffs CHECK trae silenciada_por_asesor/reabierto',
       pg_get_constraintdef(oid) ilike '%silenciada_por_asesor%'
  from pg_constraint
  where conrelid = 'public.conversation_handoffs'::regclass
    and conname = 'conversation_handoffs_reason_check'
union all
select 'trigger messages_agent_silences_ai_trigger',
       exists (select 1 from pg_trigger
               where tgrelid = 'public.messages'::regclass
                 and tgname = 'messages_agent_silences_ai_trigger'
                 and not tgisinternal)
union all
select 'tabla ai_lessons',
       exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = 'ai_lessons')
union all
select 'tabla catalog_links',
       exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = 'catalog_links')
union all
select 'orders.saint_invoice_number',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'orders'
                 and column_name = 'saint_invoice_number')
union all
select 'ai_playbooks.cede_al_inventario',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'ai_playbooks'
                 and column_name = 'cede_al_inventario')
union all
select 'catalog_links publicada en supabase_realtime',
       exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and tablename = 'catalog_links')
union all
select 'ai_lessons publicada en supabase_realtime',
       exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and tablename = 'ai_lessons')
order by chequeo;
```

Todas las filas deben dar `ok = true`.

### 7. Push del código

Recién ahora — Dokploy despliega solo con el webhook, sin esperar al CI.
Mirar igual el CI después (API pública de Actions, ver Comandos de
`CLAUDE.md`) y reproducir en local cualquier falla que no quepa en las 10
anotaciones que muestra GitHub por paso.

### 8. Backfill acotado de `welcome_sent_at` + `vacuum analyze`

Cierra el hueco entre el backfill grande (dentro de `20260917010000`, paso
3) y el momento en que el código del paso 7 empieza a servir tráfico de
verdad. **El UPDATE y el `vacuum analyze` NO pueden ir en el mismo comando**
(Postgres los agrupa en una transacción implícita y `VACUUM cannot run
inside a transaction block` aborta, deshaciendo también el UPDATE). Van como
DOS comandos separados:

```bash
# 8a. Solo el UPDATE. Verificar el "UPDATE n" contra la línea de base
# del paso 1 (consulta A1) antes de seguir.
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
update public.conversations
set welcome_sent_at = coalesce(last_reply_at, last_message_at, created_at)
where welcome_sent_at is null and has_reply;
"
```

```bash
# 8b. Aparte, DESPUÉS de confirmar 8a. Nunca junto con el UPDATE de arriba.
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "vacuum analyze public.conversations;"
```

### 9. Subir el tope de gasto + lección global

Con Seba corriendo turnos completos en chats asignados, el gasto diario sube
frente a la línea de base del paso 1 — subir `daily_spend_cap_usd` (panel
Control IA, o `update public.agent_settings set daily_spend_cap_usd =
<nuevo_valor>, updated_at = now();`) ANTES de que el tope viejo se alcance.

Lección global del primer día (cargarla desde `/agent-control > Respuestas >
Lecciones`, como nota, alcance "global" — `ai_lessons.content` tiene un
CHECK de 1 a 200 caracteres, este texto mide 193):

> Cascos, aceites y maletas no dependen del modelo ni del año de la moto:
> no los preguntes. Pregunta la talla del casco, la viscosidad del aceite o
> el tamaño de la maleta, o muestra las opciones.

### 10. FUERA DE ALCANCE — script de catálogos (decisión del operador, 21/9/2026)

**El paso 10 de §11 —correr `scripts/sql/2026-09-18-catalogos-iniciales.sql`
contra producción, con los huecos `<<...>>` completados a mano— quedó
marcado "(OPCIONAL)" el 21/9/2026. NO lo corras.** El operador decidió cargar las URLs de catálogo desde la interfaz
(`/agent-control` → Enlaces de catálogo) después del deploy, no con este
script. Ver la sección 8 de este documento para el detalle completo:
qué cambia, y qué pasa con `cede_al_inventario = true` en "Catálogo
general" (que el script iba a marcar y ahora no lo hace nadie por código).

Si el operador pide explícitamente correr el script más adelante, la receta
completa —con sus dos preguntas pendientes sobre "Lubricantes" duplicado y
los dos PDFs distintos de "cascos"— está en `docs/PRODUCCION.md` §11, paso
10, y en `docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`, sección
"T6 — Script de catálogos endurecido (`8bc3997`)".

### 11. Vigilar `escenario_cedido_al_catalogo` y turnos con error

Durante las primeras horas después del deploy — ver sección 6, más abajo,
para el detalle de qué mirar.

---

## 4. Commits por corrida

### Tabla resumen por corrida

| Corrida | Rango | Commits | Migraciones |
|---|---|---|---|
| "La IA no vuelve a pedir lo que ya pidió" | `73ef4ac..aac9e74` | 3 | `20260916010000` |
| "Seba atiende el mostrador" | `6ea6877..c9b5959` | 10 | `20260917010000`, `20260917020000` |
| "El precio se lee en bolívares" / ajuste suelto de Control IA | `eba9921..78b62b9` | 2 | ninguna |
| "Nada sin leer, un solo catálogo y la factura Saint" (parte 1) | `f0a6ce6..e7d846e` | 11 | `20260918010000`, `20260918020000` |
| "Nada sin leer…" (parte 2, revisión `code-review high`) | `c9b2ed6..def7484` | 5 | ninguna |
| "Seba sale sin pisar a nadie" | `d9091e0..003ada1` | 12 | ninguna nueva (dos migraciones existentes EDITADAS: `cf8b971`) |
| "El resguardo antes del push" | `ffbe56d..9e2cf1a` | 18 | ninguna |
| "El catálogo configurado sale siempre" | `8f60088..a476f75` | 6 | `20260921010000` |
| **Total** | `3802fad..a476f75` | **66** (verificado: `git log --oneline 3802fad..HEAD \| wc -l` → 66) | **6 archivos nuevos + 2 editados in situ** |

Detalle commit por commit de todo lo que NO trae `[migración]`: en
`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md` (Grupos A–E,
"El resguardo antes del push", "El catálogo configurado sale siempre") y
`docs/entregas/2026-09-19-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`
(Commits 0–15). En los dos, cada commit trae los cinco puntos: qué cambia
para el usuario, migración, variables de entorno, riesgo/reversa, cómo
verificar.

### Los ocho commits `[migración]`, uno por uno

#### `73ef4ac` — La base sella cuándo le devolvieron el chat a la IA y deja rastro de cada cambio de dueño

- **Migración:** `20260916010000_devolucion_a_la_ia.sql`. Trae
  `conversations.ai_resume_cutoff_at` (sellado por trigger BEFORE con
  `last_customer_message_at`, nunca `now()`), la columna generada
  `new_since_ai_resume`, y `HandoffReason` suma
  `devuelto_a_ia`/`desasignada_por_asesor`/`mensaje_previo_a_devolucion` vía
  trigger AFTER `handle_conversation_ownership_change()`.
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** solo servidor/base — nada visible todavía.
- **Verificación:** `supabase/tests/devolucion_a_la_ia.sql` (doce casos, con
  rollback), cableado al job `migraciones` del CI. Contra producción:
  `select column_name from information_schema.columns where table_name =
  'conversations' and column_name = 'ai_resume_cutoff_at';`.
- **Riesgo/reversa:** medio — trigger BEFORE sobre `conversations` (tabla
  caliente del webhook). `drop trigger`/`drop function` + `alter table
  conversations drop column ai_resume_cutoff_at` revierte, pero pierde el
  sello de cualquier devolución ya ocurrida.

#### `6ea6877` — La base apaga a Seba con el primer mensaje del asesor y deja rastro de cada silencio

- **Migración:** `20260917010000_seba_y_escalada_viva.sql`, DESPUÉS de
  `20260916010000`. Trae el backfill de `welcome_sent_at` (de "última
  plantilla de bienvenida" a "Seba ya se presentó",
  `coalesce(last_reply_at, last_message_at, created_at)` para todo
  `has_reply`); `conversation_handoffs.reason` suma `silenciada_por_asesor`;
  `reclamado` exige `auth.uid() is not null`; trigger nuevo
  `handle_agent_message_silences_ai()` (`AFTER INSERT ON messages`).
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** solo servidor/base — plomería.
- **Verificación:** `supabase/tests/seba_y_escalada_viva.sql` (nueve casos)
  y `supabase/tests/devolucion_a_la_ia.sql` actualizado. `select tgname from
  pg_trigger where tgrelid = 'public.messages'::regclass and tgname =
  'messages_agent_silences_ai_trigger';` debe dar una fila.
- **Riesgo/reversa:** medio-alto — backfill sobre TODA `conversations` con
  `has_reply` (~17 mil filas medidas el 19/9, cada una dispara un evento de
  Realtime); correr fuera de hora pico y seguido de `vacuum analyze
  public.conversations` (paso 8 de la sección 3).

#### `62cda1e` — La base guarda las lecciones que los asesores le enseñan a Seba

- **Migración:** `20260917020000_ai_lessons.sql`, DESPUÉS de
  `20260917010000`. Tabla `public.ai_lessons` (`kind`: `nota`/`sinonimo`;
  `scope`: `global`/`conversacion`), RLS, publicada en `supabase_realtime`
  con autoverificación.
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** solo servidor/base — tabla nueva y vacía.
- **Verificación:** `supabase/tests/ai_lessons.sql`, cableado al CI.
- **Riesgo/reversa:** bajo — tabla nueva y vacía.

#### `1e0ca3b` — Los enlaces de catálogo tienen su propia tabla

- **Migración:** `20260918010000_catalog_links.sql`, DESPUÉS de las dos de
  Seba. Tabla `public.catalog_links`
  (`key`/`label`/`url`/`sort_order`/`is_active`/`updated_by`), RLS, índice
  parcial, trigger de `updated_at`, publicada en `supabase_realtime` con
  autoverificación.
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** solo servidor/base — tabla nueva y vacía, nada la
  usa todavía si se aplica antes que el código.
- **Verificación:** `select count(*) from pg_policies where tablename =
  'catalog_links';` → 2. `supabase/tests/catalog_links.sql` (nueve casos),
  cableado al CI.
- **Riesgo/reversa:** bajo — `drop table if exists public.catalog_links;`
  (sin dependencias hacia ella) y quitar su fila de
  `schema_migrations`.

#### `ce9afee` — Cada orden puede llevar su número de factura Saint

- **Migración:** `20260918020000_factura_saint.sql`, DESPUÉS de
  `20260918010000`. Agrega `orders.saint_invoice_number text` (nullable,
  CHECK de recorte y 1-40 caracteres, sin unicidad a propósito — una factura
  Saint puede cubrir más de un chat). **No confundir con `invoices.number`**
  (el correlativo interno "SBK-000123"): son dos numeraciones distintas.
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** solo servidor/base — columna nullable, nada la
  exige todavía si se aplica antes que el código.
- **Verificación:** `select column_name, is_nullable from
  information_schema.columns where table_schema = 'public' and table_name =
  'orders' and column_name = 'saint_invoice_number';` → `is_nullable =
  'YES'`. `supabase/tests/factura_saint.sql` (cinco casos), cableado al CI.
- **Riesgo/reversa:** bajo — `alter table public.orders drop column if
  exists saint_invoice_number;` (pierde valores ya cargados, pero son datos
  nuevos, no históricos) y quitar la fila de `schema_migrations`.

#### `cf8b971` — Las migraciones de la devolución y de Seba toman sus candados de tabla antes de tocar filas, para no interbloquearse con el webhook en vivo

- **Migración:** EDITA IN SITU `20260916010000` y `20260917010000`
  (ninguna de las cinco estaba aplicada en producción al momento del
  commit) — no son archivos nuevos. Agrega `lock table … in share row
  exclusive mode` sobre `conversation_handoffs` (y `messages` en la 0917)
  ANTES de tocar filas, y `begin;`/`commit;` explícito alrededor de cada
  archivo. Reproducido contra base local con 30 mil filas y 20 conexiones
  concurrentes: `deadlock detected` sin el candado; con el candado, 3
  corridas limpias, el webhook esperando entre 4 y 16 s (medido en
  producción: 6,9 s de un INSERT del webhook detrás de un lock parecido).
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** solo servidor/base — ya cubierto por la salvedad
  de la sección 3, paso 3 ("Salvedad para `20260916010000` y
  `20260917010000`").
- **Verificación:** `docs/PRODUCCION.md` §11 (candados, segundos medidos
  bajo carga, qué hacer si aborta por `lock_timeout`).
- **Riesgo/reversa:** medio — cambia el comportamiento de aplicación de dos
  migraciones que TODAVÍA no están en producción (no hay nada que
  revertir en la base; si hiciera falta, revertir es lo mismo que revertir
  `73ef4ac`/`6ea6877` completos).

#### `d9091e0` — Las cinco migraciones pendientes se protegen con lock_timeout, abortan si se aplican sin transacción y avisan a PostgREST

- **Migración:** EDITA IN SITU las cinco migraciones de los Grupos
  A/B/D (`20260916010000`, `20260917010000`, `20260917020000`,
  `20260918010000`, `20260918020000`) — no son archivos nuevos. Las tres
  últimas ganan `set local lock_timeout = '5s'` Y `notify pgrst, 'reload
  schema'`; las dos primeras solo ganan `notify pgrst` (ya traían el
  `lock_timeout`). Suma el bloque que ABORTA si `lock_timeout` sigue en
  `'0'`/`'0ms'` (detecta el NO-OP silencioso sin `-1`).
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** solo servidor/base — protege el despliegue, no
  cambia comportamiento para el usuario.
- **Verificación:** las cinco re-corridas contra `npx supabase db reset`
  (CLI 2.117.0): aplican sin abortar, 17 pruebas de `supabase/tests/` en
  verde.
- **Riesgo/reversa:** bajo — si alguna ya se aplicó a producción con la
  versión vieja, no hace falta reaplicarla completa: alcanza con correr a
  mano el `set local lock_timeout`/`notify pgrst` que le falte.

#### `e8d50e9` — Cada escenario de la IA dice si cede al inventario cuando preguntan por un repuesto

- **Migración:** `20260921010000_escenario_cede_al_inventario.sql`. Agrega
  `ai_playbooks.cede_al_inventario boolean not null default false` — nace en
  `false` para todo, así que ningún escenario cambia de comportamiento el
  día del deploy. Sin backfill (el DEFAULT cubre todas las filas
  existentes). RLS: hereda `ai_playbooks_select`/`ai_playbooks_write`
  (20260821010000), no hace falta tocar `pg_policies`.
- **Variable de entorno:** ninguna.
- **UI o solo servidor:** el commit siguiente (`a9950cc`) agrega la casilla
  "Cede al inventario cuando preguntan por un repuesto" en el editor de
  escenarios de `/agent-control` (`playbooks-panel.tsx`) y un badge en la
  tarjeta — esta migración sola no cambia la UI.
- **Verificación:** `select column_default, is_nullable from
  information_schema.columns where table_name = 'ai_playbooks' and
  column_name = 'cede_al_inventario';` → `'false'` | `'NO'`. CI real en
  verde sobre `4aab349` (21/9/2026, run 35566194167, jobs `verificar` y
  `migraciones`, con el paso nuevo para `escenario_cede_al_inventario.sql`).
- **Riesgo/reversa:** bajo — `alter table public.ai_playbooks drop column if
  exists cede_al_inventario;` y quitar la fila de `schema_migrations`; nada
  depende de la columna si `buscar_repuesto` sigue apagada (ver sección 5).

---

## 5. Estado con el que se despliega

- **`buscar_repuesto` sale APAGADA**, exactamente como está en producción
  desde el 25/8/2026. Con la herramienta apagada, la cuarta condición de
  "el repuesto manda" (`ai_playbooks.cede_al_inventario`) nunca importa:
  ningún escenario cede al inventario porque la segunda de las cuatro
  condiciones ya falla sola, así que "CATALOGO CASCOS" y "Catálogo general"
  siguen mandando su PDF de siempre. El operador la enciende él mismo
  después desde `/agent-control` → Herramientas, en un horario con asesores
  mirando la bandeja — revertirlo es un clic. Registrar
  `escenario_no_cedido` con su `motivo` es lo que permite medir el efecto
  antes de decidir encenderla de forma permanente.
- **Dokploy despliega con el push, sin esperar al CI.** CI real en verde
  sobre `4aab349` (run 35566194167) — mirar igual el CI después del push
  (API pública de GitHub Actions, ver Comandos de `CLAUDE.md`) y reproducir
  en local cualquier falla que no quepa en las 10 anotaciones que GitHub
  muestra por paso.
- **Los enlaces de catálogo salen VACÍOS** (tabla `catalog_links` nueva,
  sin filas — ver sección 8): hasta que el operador cargue al menos un
  catálogo a mano, ningún escenario ni mensaje rápido con
  `{{catalogo:<clave>}}`/`{{catalogos}}` se resuelve. Fase 0
  (`matchPlaybook`) ya descarta un escenario con marcador sin resolver
  (`escenarios_enlace_sin_resolver`) — el texto pegado a mano que
  circulaba hasta ahora en los escenarios (URLs de Drive, sin marcador)
  sigue funcionando igual que hoy, sin cambios, hasta que alguien edite ese
  texto.

---

## 6. Qué mirar en los logs, primeras horas

Eventos verificados con `grep` contra `src/` (existen de verdad en el
código, no son suposición):

- `escenario_cedido_al_catalogo` / `escenario_no_cedido` (con su `motivo`)
  — `src/lib/ai/agent.ts`. Con `buscar_repuesto` apagada, `escenario_no_cedido`
  debería salir con motivo "herramienta apagada" en cada turno que calzó
  "Catálogo general"; `escenario_cedido_al_catalogo` no debería aparecer
  todavía.
- `turno_conversacion_no_consultable` — `agent.ts`. LANZA y la cola
  reintenta; un pico acá es infraestructura (corte de base), no un bug
  mudo.
- `turno_reintentable_tras_saludo` — `agent.ts`. El proveedor falló DESPUÉS
  del saludo de Seba; la cola reintenta sola, sin traspaso.
- `escenarios_enlace_sin_resolver` — `src/lib/ai/playbooks.ts`. Un
  escenario con `{{catalogo:<clave>}}`/`{{catalogos}}` sin resolver quedó
  fuera de los candidatos de fase 0. Con `catalog_links` vacía al deploy,
  solo dispara para escenarios que YA usen el marcador nuevo (ninguno,
  hasta que el operador migre los textos a mano).
- `turno_enlaces_no_legibles` — `src/lib/ai/catalog-links.ts`. Error de
  base al leer `catalog_links` dentro del turno; nunca lanza, el turno
  sigue sin catálogos.
- `turno_interruptor_no_consultable` / `webhook_interruptor_no_consultable`
  — `agent.ts` / `route.ts`. Error real al consultar `agent_can_run`
  (LANZA, no es "IA apagada"); solo un `false` de verdad es el interruptor.
- `turno_sin_texto` / `fuera_de_tema_repetido` /
  `turno_presentacion_reclamo_fallido` — `agent.ts` / `handoffs.ts`. Casos
  nuevos de "El resguardo antes del push" (19-20/9): texto vacío del modelo
  después del saludo, segunda insistencia fuera de tema, y fallo al
  reclamar el sello de presentación de Seba.
- `agent_turns` con `action = 'error'`:
  `select action, count(*) from public.agent_turns where created_at >
  now() - interval '24 hours' group by action;` — vigilar que `error` no
  suba frente al día anterior.
- `entrega_fallida` en `conversation_handoffs` — nuevo desde esta corrida,
  solo debería aparecer tras un fallo real del proveedor DESPUÉS del saludo
  de Seba que la cola no llegó a reintentar con éxito.

Detalle completo de la vigilancia de `escenario_cedido_al_catalogo` (con las
dos consultas — SQL y `docker logs`) en `docs/PRODUCCION.md` §11, paso 11.

---

## 7. Riesgos conocidos y plan de reversa

- **Interbloqueo de `20260916010000`/`20260917010000` con el webhook en
  vivo:** mitigado por `cf8b971` (candados de tabla). Si de todos modos una
  de las dos aborta por `lock_timeout` (55P03), no queda nada a medias — el
  `begin;`/`commit;` explícito hace el archivo atómico — reintentar el
  mismo comando tal cual; una migración que aborta por lock_timeout es
  señal de tráfico más alto de lo esperado, no de una migración rota.
- **Backfill de `welcome_sent_at` (`20260917010000`):** ~17 mil filas de
  `conversations`, cada una dispara un evento de Realtime. Por eso la
  ventana 03:00–05:00 VET y el `vacuum analyze` del paso 8.
- **Reversa por commit/migración:** la tabla de la sección 4 trae "Riesgo /
  reversa" para cada uno de los ocho commits `[migración]` — son los únicos
  puntos de este rango con un `DROP`/reversa explícito en las fuentes.
  Ningún documento de origen define una reversa para el código de
  aplicación (`agent.ts`, `escalate.ts`, etc.) más allá de `git revert` del
  commit puntual — no se inventa ninguna acá. El commit `5f18505`
  ("Escalar ya no apaga a Seba…") está marcado como riesgo ALTO en la
  fuente porque es el cambio de comportamiento central del plan "Seba
  atiende el mostrador" — su mitigación es el paso 4 (UPDATE operativo de
  C1) y el commit `671bafe` (T10), no una reversa de código.
- **`docs/entregas/2026-09-19-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`
  quedó desactualizado** (documenta hasta `e7d846e`; la misma corrida sumó
  cinco commits más de una revisión posterior, `c9b2ed6..def7484`) — esos
  cinco están documentados en
  `docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`, "Grupo D,
  Parte 2".
- **Lo que NO se pudo ensayar en local** (fuente: "Ensayo del despliegue",
  19/9/2026): el respaldo real (`scripts/backup.sh`), el push del código y
  el CI real sobre este rango exacto (el CI real SÍ corrió después, sobre
  `4aab349`, en verde), cargar la lección global desde la UI con sesión de
  supervisor real, cualquier métrica con tráfico real, y el `EXPLAIN
  ANALYZE` de la consulta de Pendientes con volumen real de producción.

---

## 8. Fuera de alcance del VPS / pendientes del operador

- **Cargar los catálogos** (7 URLs de "Catálogo general" + los 2 escenarios
  y 4 mensajes rápidos que hoy llevan la URL pegada a mano): el operador lo
  hace a mano desde `/agent-control` → Enlaces de catálogo, DESPUÉS del
  deploy — ya NO es el script `scripts/sql/2026-09-18-catalogos-iniciales.sql`
  (ver sección 3, paso 10). Consecuencia sobre `cede_al_inventario`: el
  script, si se hubiera corrido, iba a marcar `true` en "Catálogo general" y
  `false` explícito en "CATALOGO CASCOS" (ver el propio archivo,
  `scripts/sql/2026-09-18-catalogos-iniciales.sql`, sección 5c). Sin el
  script, esa marca queda en el operador: tiene que activar la casilla
  "Cede al inventario cuando preguntan por un repuesto" a mano, desde el
  editor de "Catálogo general" en `/agent-control` — pero **solo importa
  cuando `buscar_repuesto` esté encendida** (sección 5), así que no es
  urgente para el día del deploy.
- **Encender `buscar_repuesto`:** decisión y momento del operador (ver
  "Al encender la consulta de productos", `docs/PRODUCCION.md` §11).
- **Error 130497 de Meta** (54 rechazos el 19/9/2026, restricción por país)
  — se revisa en el panel de Meta Business, no es un bug del CRM.
- **"Nivel cashea" apagado el 17/9/2026 sin reemplazo** (116 usos en 15
  días antes de apagarse) — nadie puso una alternativa en su lugar; queda
  para que el operador decida.
- **Rotar la clave de OpenRouter** — quedó expuesta en una sesión de
  diagnóstico del 18/9/2026; sigue pendiente, no es parte de este rango.

---

## 9. Qué debe devolver el Claude del VPS al terminar

1. Hash desplegado (`git rev-parse HEAD` en el checkout del VPS) y
   confirmación de que coincide con el HEAD que este documento cita
   (`a476f75`, o el que resulte de `git log --oneline 3802fad..HEAD | wc -l`
   si hubo un commit de documentación más).
2. Última migración registrada en `supabase_migrations.schema_migrations`
   (debe ser `20260921010000`) y el conteo total (`select count(*) from
   supabase_migrations.schema_migrations;` → 76).
3. Filas tocadas por el UPDATE operativo de C1 (paso 4) — el número exacto
   de "UPDATE n" que devolvió, contra los 30 esperados.
4. Salida de la comprobación única del paso 6 (las nueve filas, todas
   `ok = true`).
5. Resultado de los dos GET de humo del paso 5 (código HTTP de cada uno).
6. Cualquier WARNING/aborto durante las migraciones (esperados: dos WARNING
   inofensivos en `20260916010000`/`20260917010000` si se corren con `-1`;
   cualquier otro aborto o error es una señal real, no ignorarlo).
7. Confirmación del CI real después del push (verde/rojo, y si rojo, qué
   falló).
8. Cualquier cosa rara en los primeros logs (sección 6) — en particular si
   aparece `escenario_cedido_al_catalogo` con `buscar_repuesto` apagada (no
   debería poder pasar; si pasa, es un bug a reportar, no una decisión).
