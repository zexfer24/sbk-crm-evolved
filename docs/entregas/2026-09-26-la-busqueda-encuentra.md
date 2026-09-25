# Entrega "La búsqueda encuentra lo que el cliente pide", 25-26/9/2026

Para el Claude del VPS. Plan aprobado:
`docs/planes/2026-09-26-la-busqueda-encuentra-lo-que-el-cliente-pide.md`.
Contexto: `buscar_repuesto` está apagada en producción desde el 25/8/2026. Al
simularla contra el catálogo real (6.035 productos que llegan de Saint) la
búsqueda vieja falló en casi la mitad de los casos — `tools.ts` cortaba con
`.limit(31)` SIN `order` y recién después ordenaba esas 31 filas en memoria
("rin delantero bera kavak" devolvía ORINGS primero, y el producto correcto
faltaba en 7 de 16 consultas), no entendía plurales, descartaba números
cortos ("45", "DT 200") y filtraba la moto por `product_compatibility`
(0 filas). Además Seba copiaba precios del historial ("108$ BCV" repetido
diez días después de que la tasa BCV cambiara) y calculaba cuotas de Cashea
de memoria. Esta entrega corrige la búsqueda en SQL, decide cuándo una
consulta es genérica según lo que de verdad calza, agrega una guarda en
código contra cifras sin fuente y ajusta el guion y el formato del precio.

## CORRECCIÓN sobre el orden de entrega (leer antes de todo lo demás)

**Push a `main` SÍ despliega**, confirmado por el operador el 25/9/2026
contra el VPS: `34a5b65` se pusheó a las 05:40:18 UTC y Dokploy desplegó
SOLO, sin que nadie lo lanzara a mano, a las 05:42 (contenedor recreado,
dominio respondiendo 200). Esto reemplaza la creencia anterior ("push a
`main` no despliega", escrita en `CLAUDE.md`/`docs/PRODUCCION.md` entre el
21/9 y el 25/9/2026) — ver la corrección con fecha en esos dos documentos y
en las dos entregas del 25/9/2026 que la repetían
(`2026-09-25-inventario-desde-saint.md`,
`2026-09-25-tasa-bcv-y-pendientes-del-inventario.md`).

**Por eso esta entrega NO se pushea a `main` directo.** Los cuatro commits
de código/migración de esta ola están en la rama **`entrega/busqueda-que-encuentra`**,
partida de `origin/main` en `34a5b65`. El orden real:

1. Fetch + checkout de la rama de la entrega (o trabajar directo sobre lo
   que ya está pusheado ahí — ver §"Qué hay en la rama", abajo).
2. Respaldo.
3. Simulacro de la migración con `BEGIN … ROLLBACK`.
4. Aplicar la migración de verdad, con `psql -1 -v ON_ERROR_STOP=1`.
5. Verificar `has_function_privilege` (anon/authenticated en `false`,
   service_role en `true`).
6. **Fast-forward de `main` a `entrega/busqueda-que-encuentra` — ESE es el
   paso que despliega**, no un botón aparte de Dokploy:
   ```bash
   git fetch origin
   git checkout main
   git merge --ff-only origin/entrega/busqueda-que-encuentra
   git push origin main
   ```
7. Re-correr la re-simulación (§2.1/§2.3 del plan) con la función ya en
   producción y comparar contra la medición vieja (7 fallas de 16).
8. Recién entonces el operador enciende `buscar_repuesto` desde Control IA.
9. Medir 48 h.

El CI solo corre sobre `main`/PR — una rama `entrega/**` no dispara nada,
así que ya se reprodujo la suite en local antes de pushear (ver
"Verificación" del plan). Si hace falta la certeza del CI real, se puede
abrir una rama `ci/**` desechable desde `entrega/busqueda-que-encuentra`.

## Qué hay en la rama

`git log --oneline 34a5b65..entrega/busqueda-que-encuentra`:

```
7f89ec6 Una cifra de dinero sin fuente en el turno no le llega al cliente
5f55c85 Seba busca con plurales, medidas y modelos como DT200, pregunta solo cuando calzan varios y cotiza en dólares BCV
f517182 Seba no repite precios del historial ni hace cuentas, y pregunta por la moto solo cuando importa
c41e8f0 [migración] La búsqueda del catálogo ordena y cuenta en la base antes de recortar
```

Va a sumarse un quinto commit de documentación (este archivo + `CLAUDE.md` +
`docs/GLOSARIO.md` + `docs/PRODUCCION.md` + la sección "Correcciones durante
la ejecución" del plan) — sin migración, sin variable de entorno, sin tocar
`src/`. Ese quinto commit es la punta de la rama, y como este archivo vive
dentro de él no puede traer su propio SHA: el SHA exacto lo pasa el operador
junto con este reporte. Antes de tocar nada en el VPS, confirmar que el
remoto apunta a ese mismo SHA:

```
git fetch origin
git ls-remote --heads origin entrega/busqueda-que-encuentra   # debe dar el SHA que pasó el operador
git log --oneline 34a5b65..origin/entrega/busqueda-que-encuentra   # 5 commits, el primero [migración]
```

---

## Los cinco puntos por commit

### 1. `c41e8f0` — `[migración] La búsqueda del catálogo ordena y cuenta en la base antes de recortar`

1. **Hash y título:** `c41e8f0f85d38aecaf431843572eeef3b5de6e61` — "La
   búsqueda del catálogo ordena y cuenta en la base antes de recortar".
2. **¿Incluye migración? Sí.**
   `supabase/migrations/20260926010000_busqueda_ordena_antes_de_recortar.sql`.
   Crea `public.buscar_productos(p_terminos jsonb, p_moto jsonb, p_limite
   int)` — `security invoker` (la llama `service_role`, que ya se salta
   RLS). Solo CREA la función: no toca `products`, no bloquea nada, no
   necesita `lock_timeout` por eso, pero SÍ conserva el patrón de septiembre
   (revokes + grant + `notify pgrst`). Trae también
   `supabase/tests/buscar_productos.sql` (13 casos) como parte del mismo
   commit, y el paso de CI que lo corre.
3. **¿Variable de entorno nueva? No.**
4. **¿Toca la UI o solo el servidor? Solo servidor/base** — es una función
   SQL, no hay ningún cambio de frontend en este commit. Costo de deploy:
   recrear contenedor (~20 s), no rebuild completo — pero la migración va
   ANTES del deploy de todos modos (ver el orden de arriba).
5. **Qué se verificó:**
   - `supabase/tests/buscar_productos.sql` en verde contra la base local
     reconstruida (`docker exec … psql -1 -v ON_ERROR_STOP=1`), 13/13 casos.
   - `EXPLAIN (ANALYZE, BUFFERS)` con ~6.000 productos sintéticos insertados
     dentro de `BEGIN … ROLLBACK`: `pechera ava deer` → **6,3 ms**, `disco
     freno delantero dt200` → **40,7 ms**; los dos usan `Bitmap Index Scan`
     sobre `products_search_text_trgm` (`Index Cond: search_text ~~*
     ANY(...)`). El `left join lateral` sobre `product_compatibility` corre
     por cada candidato antes del límite (1.202 loops en el caso de
     "disco freno delantero dt200", ~0 ms hoy por estar la tabla vacía) —
     deuda menor anotada, no bloqueante mientras esa tabla siga en 0 filas.
   - Mutaciones verificadas (respaldo con `cp`, restauradas desde esa
     copia, nunca `git checkout --`):
     - **(a) El límite antes del orden** (aplicar `limit` directo sobre
       `candidatos_relevantes`, antes del `order by`): el test SQL se puso
       ROJO. **Corrección de la fixture en el camino:** la primera versión
       insertaba los 6 productos correctos ANTES que el ruido, y con esa
       fixture la mutación (a) seguía dando VERDE — los correctos, por
       orden físico de inserción, ya quedaban entre las primeras filas que
       Postgres devuelve sin `order by`, así que el bug no se manifestaba.
       Se reordenó la fixture (ruido primero, correctos después) y recién
       ahí la mutación puso el test en rojo como correspondía. Ver la
       trampa nueva en `CLAUDE.md`.
     - **(e) Quitar `price > 0` del prefiltro:** el test SQL se puso ROJO
       (el caso 8, "el producto con price = 0 no aparece nunca", falla).
   - `has_function_privilege`: `anon`/`authenticated` en `false`,
     `service_role` en `true` (caso 13 del test SQL, y a repetir contra la
     base real como paso de esta entrega — ver más abajo).

### 2. `f517182` — `Seba no repite precios del historial ni hace cuentas, y pregunta por la moto solo cuando importa`

1. **Hash y título:** `f517182fc194be3e35ec477c4a21844dbc6f52b8`.
2. **¿Incluye migración? No.**
3. **¿Variable de entorno nueva? No.**
4. **¿Toca la UI o solo el servidor?** Solo servidor — `src/lib/ai/prompt.ts`
   y `src/lib/ai/seba.ts` son módulos `server-only`/puros que arma el turno,
   no hay componente de React tocado. Costo de deploy: recrear contenedor.
   **Todo el cambio de `prompt.ts` queda DENTRO de `SYSTEM_PROMPT`, el
   prefijo cacheable** — nada nuevo en el sufijo, así que no rompe el caché
   de prompts del proveedor entre turnos.
5. **Qué se verificó:** `prompt.test.ts` (130 líneas nuevas/cambiadas) y
   `seba.test.ts` en verde — la sección 2 ya no dice "no lo tenemos en el
   catálogo" (esa orden quedó redundante con `TEXTO_NO_IDENTIFICADO`), la
   regla de historial/cuentas está en `cacheablePrefix()`, aparecen los dos
   textos de filtro (`PREGUNTA_FILTRO`/`PREGUNTA_FILTRO_PRODUCTO`) y el
   prefijo entero sigue pasando `revealsIdentity` (la guarda de identidad no
   se rompe con el texto nuevo). `TEXTO_PRECIO_A_CONFIRMAR` pasa
   `revealsIdentity` también.

### 3. `5f55c85` — `Seba busca con plurales, medidas y modelos como DT200, pregunta solo cuando calzan varios y cotiza en dólares BCV`

1. **Hash y título:** `5f55c859e734255f364f4698f5d933b40788b793`.
2. **¿Incluye migración? No** (usa la de `c41e8f0`, ya aplicada por el
   orden de esta entrega).
3. **¿Variable de entorno nueva? No.**
4. **¿Toca la UI o solo el servidor?** Solo servidor —
   `catalog-search.ts`/`tools.ts`/`precio.ts` son el tool loop del agente;
   `database.types.ts` gana la firma de `buscar_productos` a mano en
   `Functions` (sin generador automático, coherente con el resto del repo).
   Costo de deploy: recrear contenedor.
5. **Qué se verificó:** `catalog-search.test.ts` (247 líneas
   nuevas/cambiadas), `tools.test.ts` (el fake de Supabase suma `.rpc()` y
   registra nombre + argumentos), `precio.test.ts` en verde. Mutaciones:
   - **(c) `generico` por `quoted.length > 3`** (en vez de `coinciden`,
     el conteo que trae la base): "motul 5100 20w50" se puso ROJO.
     **Corrección durante la implementación:** la primera versión de esta
     mutación solo tocaba la condición de `generico`, sin revertir también
     la SELECCIÓN vieja de filas (`ranked.slice(0, MAX_CATALOG_RESULTS)`
     sobre TODO lo devuelto, en vez de filtrar por `puntaje ===
     puntaje_maximo`) — con la selección nueva ya en su sitio, mutar solo
     `generico` no alcanzaba para poner el test en rojo, porque la lista de
     `quoted` que se cotiza de verdad seguía siendo la correcta y el caso
     que se rompía era otro. Hubo que revertir las DOS cosas juntas para
     que la mutación fuera fiel a "¿qué pasaría si `generico` se calculara
     como antes de esta ola?".
   - **(d) Sin la tolerancia N−1:** el caso N = 4 con máximo 3 se puso ROJO
     (queda como `no_identificado` en vez de cotizar).
   - **(f) Sin la restricción por `puntaje_moto_maximo`** (decisión del
     operador): el caso de las 5 pastillas con moto BERA se puso ROJO — sin
     la restricción, cotiza las 5 en vez de solo la BERA.
   - Escenario a mano en local, simulador con `buscar_repuesto` encendida:
     "¿tienen intercomunicadores?" → pregunta de producto
     (`PREGUNTA_FILTRO_PRODUCTO`); "rin delantero bera kavak" → cotiza con
     "BCV" en el precio y escala con `confirmar_inventario`.

### 4. `7f89ec6` — `Una cifra de dinero sin fuente en el turno no le llega al cliente`

1. **Hash y título:** `7f89ec6c7817dcb779daec840410a3e14a25528e`.
2. **¿Incluye migración? No** — no hace falta columna nueva: la marca
   `"[cifra sin fuente] "` se antepone al `summary` de `logTurn`, igual que
   `identityPrefix`.
3. **¿Variable de entorno nueva? No.**
4. **¿Toca la UI o solo el servidor?** Solo servidor —
   `price-guard.ts` (módulo PURO, sin imports) + su integración en
   `agent.ts`. Costo de deploy: recrear contenedor.
5. **Qué se verificó:** `price-guard.test.ts` (119 líneas), `agent.test.ts`
   (170 líneas nuevas/cambiadas) en verde. Mutación (b): aceptar el
   historial como fuente puso rojo el caso del 20/9/2026 ("108$ BCV"
   copiado de un mensaje de un asesor de 244 h antes). Los tests de "red de
   seguridad del catálogo" que ya existían antes de esta ola siguen VERDES
   **sin editar sus aserciones** — sus mocks ya traían la cifra cotizada
   dentro de un `toolResult`, así que la guarda nueva no los tocaba.
   Escenario a mano: con asesor asignado no hay segunda escalada; sin
   asesor, escala con `confirmar_inventario` y el texto sale
   `TEXTO_PRECIO_A_CONFIRMAR`.

---

## Suite completa y tipos/lint

- `rtk npm run test`: **3.115 tests verdes** (incluye los cuatro commits de
  arriba más el resto de la suite, sin regresiones).
- `supabase/tests/*.sql` contra la base local reconstruida: **22 tests SQL
  verdes** (incluye `buscar_productos.sql`, 13 casos, y el resto de la
  batería que ya existía).
- `rtk npx tsc --noEmit`: sin errores.
- `rtk npm run lint`: sin errores.
- `rtk proxy npm run build`: build OK, `.next/BUILD_ID` con timestamp
  posterior al último commit.

---

## Antes de aplicar (solo lectura, no toca nada)

### (a) Confirmar en qué commit está producción

```bash
curl -s "https://api.github.com/repos/zexfer24/sbk-crm-evolved/actions/runs?per_page=3"
```

Esperado: producción en `34a5b65` (o en cualquier commit posterior que YA
esté fusionado a `main` por fuera de esta entrega — confirmar con el
operador si hay dudas). El rango de esta entrega es `34a5b65..entrega/busqueda-que-encuentra`.

### (b) Transacciones largas / locks que puedan chocar

Mismo chequeo que en entregas anteriores:

```sql
select pid, now() - xact_start as duracion, state, left(query, 100) as query
from pg_stat_activity
where xact_start is not null
order by duracion desc
limit 20;
```

### (c) `buscar_productos` no debe existir todavía

```sql
select proname from pg_proc where proname = 'buscar_productos';
-- esperado: 0 filas
```

---

## Simulacro de la migración (`BEGIN … ROLLBACK`)

Antes de aplicar de verdad, correr la migración ENTERA dentro de una
transacción que se revierte, para confirmar que entra limpia contra el
esquema real de producción (nombres de tabla/columna, extensiones) sin
dejar nada aplicado:

```bash
docker exec -i supabase-db psql -U postgres -d postgres <<'SQL'
begin;
\i /dev/stdin
rollback;
SQL
< supabase/migrations/20260926010000_busqueda_ordena_antes_de_recortar.sql
```

O, más simple, con `psql -1` y matando la conexión antes del COMMIT
implícito (equivalente, pero exige interrumpir el proceso — preferir la
forma de arriba). El `NOTICE`/comportamiento esperado es que la sentencia
`create function` y los `revoke`/`grant` corran sin error; al hacer
`rollback` nada queda en el catálogo (repetir la consulta de "(c)" arriba
para confirmarlo).

---

## Aplicación de verdad

```bash
docker exec -i supabase-db env PGOPTIONS="-c lock_timeout=5s" psql -U postgres -d postgres \
  -1 -v ON_ERROR_STOP=1 \
  -f - < supabase/migrations/20260926010000_busqueda_ordena_antes_de_recortar.sql
```

Esta migración solo CREA una función — no hay `ACCESS EXCLUSIVE` sobre
`products` ni ninguna ventana de mantenimiento que respetar; puede aplicarse
en cualquier momento, aunque conviene seguir la costumbre de hacerlo fuera
de hora pico.

Registrar en `supabase_migrations.schema_migrations`:

```sql
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260926010000', '20260926010000_busqueda_ordena_antes_de_recortar');
```

`select count(*) from supabase_migrations.schema_migrations;` → el número
que tenía producción antes de esta entrega, **+1** (81 en LOCAL tras esta
migración, según `docs/GLOSARIO.md`/`docs/PRODUCCION.md`; el número real en
producción depende de cuántas corridas previas ya se aplicaron allá).

---

## Verificación inmediata (tras aplicar, antes de pushear a `main`)

### 1. Permisos de la función, contra la base real

```sql
select
  has_function_privilege('anon', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') as anon_puede,
  has_function_privilege('authenticated', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') as authenticated_puede,
  has_function_privilege('service_role', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') as service_role_puede;
```

**Esperado:** `anon_puede` = `false`, `authenticated_puede` = `false`,
`service_role_puede` = `true`. Si alguno da distinto, **NO seguir** — ver
"los dos revokes" en `CLAUDE.md`.

### 2. La función responde contra el catálogo real (sanity check rápido, sin código todavía en producción)

```sql
select name, price, puntaje, puntaje_maximo, filas_con_puntaje_maximo
from public.buscar_productos('[["rin"]]'::jsonb, '[]'::jsonb, 5);
-- esperado: NINGÚN nombre que sea "ORINGS ..." (o equivalente con "rin" en
-- medio de la palabra) — "rin" calza por inicio de palabra (\m), nunca por
-- subcadena.
```

---

## Fast-forward de `main` (el paso que despliega)

```bash
git fetch origin
git checkout main
git merge --ff-only origin/entrega/busqueda-que-encuentra
git push origin main
```

Confirmar que Dokploy redesplegó (contenedor recreado con el SHA nuevo,
dominio respondiendo):

```bash
docker inspect <contenedor-app> --format '{{.Config.Image}}'
curl -I https://<tu-dominio>          # 200
curl https://<tu-dominio>/api/health  # 200
```

---

## Re-simulación de §2.1/§2.3 del plan, con la función ya en producción

El objetivo es comparar contra la medición vieja (7 fallas de 16 consultas
reales). Con la función ya aplicada y el código ya desplegado, correr las
mismas consultas que se usaron para diagnosticar el problema originalmente
(el reporte de solo lectura que motivó este plan) y confirmar que ahora
traen primero un resultado razonable, sin ORINGS ni ruido. Como referencia
concreta y reproducible, estos son los casos canónicos que ya probó el test
SQL sintético (`buscar_productos.sql`) — repetirlos contra el catálogo REAL
no va a dar los mismos IDs (son productos sintéticos en el test), pero sí
tiene que dar la MISMA FORMA de resultado: puntaje alto, sin ruido, orden
correcto:

```sql
-- Caso 1: "rin delantero bera kavak" -- primero debe salir un rin de
-- delantero de Bera/Kavak si existe en el catálogo real, nunca un producto
-- que no tenga "rin" como palabra.
select name, brand, price, puntaje, puntaje_maximo, filas_con_puntaje_maximo
from public.buscar_productos('[["rin"],["delantero"],["bera"],["kavak"]]'::jsonb, '[]'::jsonb, 10);

-- Caso 2: "disco freno delantero dt200".
select name, brand, price, puntaje, puntaje_maximo
from public.buscar_productos('[["disco"],["freno"],["delantero"],["dt200"]]'::jsonb, '[]'::jsonb, 10);

-- Caso 3: "asiento sbr".
select name, brand, price, puntaje
from public.buscar_productos('[["asiento"],["sbr"]]'::jsonb, '[]'::jsonb, 10);

-- Caso 4: "pechera ava deer".
select name, brand, price, puntaje
from public.buscar_productos('[["pechera"],["ava"],["deer"]]'::jsonb, '[]'::jsonb, 10);

-- Caso 5: "maleta 45 litros".
select name, brand, price, puntaje
from public.buscar_productos('[["maleta"],["45"],["litro", "lts"]]'::jsonb, '[]'::jsonb, 10);

-- Caso 6: "intercomunicador" -- genérico esperado (filas_con_puntaje_maximo > 3).
select count(*) as filas, max(filas_con_puntaje_maximo) as coinciden
from public.buscar_productos('[["intercomunicador"]]'::jsonb, '[]'::jsonb, 50);

-- Caso 7 (control negativo): "rin" solo no debe traer ningún producto cuyo
-- nombre no tenga "rin" como palabra completa (nada de "ORINGS" ni similar).
select name from public.buscar_productos('[["rin"]]'::jsonb, '[]'::jsonb, 20);
```

**Cómo contar genérico/no_identificado sobre el resultado:** para cada
consulta, `N` = cantidad de grupos en `p_terminos` (contar los arreglos de
primer nivel del jsonb que se mandó); `requerido = N <= 3 ? N : N - 1`. Si
la fila devuelta en la posición 1 tiene `puntaje_maximo < requerido` (o no
hay filas), esa consulta habría dado `no_identificado`. Si
`filas_con_puntaje_maximo > 3` y ninguna moto calzó (`puntaje_moto_maximo`
= 0 o `p_moto` vacío), habría dado genérico (pregunta de filtro). Cualquier
otro caso con `puntaje_maximo >= requerido` habría cotizado.

Documentar el ANTES/DESPUÉS en la respuesta al orquestador: cuántas de las
16 consultas originales ahora traen primero un resultado razonable, contra
las 7 que fallaban.

---

## Encender `buscar_repuesto` (recién con todo lo de arriba en verde)

Desde Control IA, el interruptor por herramienta (`agent_tools`). Es un
`UPDATE` desde la interfaz, sin SQL directo necesario — confirmar con una
consulta de sanity después:

```sql
select tool_key, enabled from public.agent_tools where tool_key = 'buscar_repuesto';
-- esperado: enabled = true, después de que el operador lo prenda desde el panel
```

---

## Medir 48 h

### Turnos que cotizan, que preguntan, `no_identificado`

```sql
select
  count(*) filter (where summary ilike '%Escalado a%confirmar_inventario%') as cotizo_y_escalo,
  count(*) filter (where summary ilike '%no_identificado%' or summary ilike '%No identificado%') as no_identificado,
  count(*) filter (where summary ilike '%generico%' or summary ilike '%pregunta de filtro%') as pregunto_filtro,
  count(*) as total_turnos
from public.agent_turns
where created_at > now() - interval '48 hours';
```

(Ajustar los patrones de `ilike` contra el `summary` real que arma
`buildCatalogTool`/`runTurnPhases` — el texto exacto de cada rama está en
`tools.ts`/`agent.ts`, sección `GENERICO_INSTRUCTION`/
`NO_IDENTIFICADO_INSTRUCTION`/`escalationInstruction`.)

### Cifras sin fuente (la guarda de T3)

```sql
select count(*) as turnos_con_cifra_sin_fuente
from public.agent_turns
where created_at > now() - interval '48 hours'
  and summary ilike '[cifra sin fuente]%';
```

Por logs (journald, T8 "Nada se pierde en un corte ni en un deploy"):

```bash
journalctl -o cat CONTAINER_TAG=sbk-crm-app --since "48h ago" | jq -c 'select(.event == "cifra_sin_fuente")'
```

**Esperado en 48 h normales: cerca de 0.** Cada aparición hay que revisarla
a mano — puede ser un falso positivo de la guarda (una cifra real con una
fuente que el código no reconoció) o un caso real que la guarda atrapó bien
(precio del historial, cuenta hecha de memoria).

### Cotizaciones registradas, para cruzar contra Saint

```sql
select cq.quoted_at, cq.product_name, cq.price_usd, cq.price_bs, cq.bcv_rate,
       cq.conversation_id
from public.conversation_quotes cq
where cq.quoted_at > now() - interval '48 hours'
order by cq.quoted_at desc;
```

Tomar **20 filas al azar** de esta consulta (o las primeras 20 si son
pocas) y revisar a mano contra el precio real en Saint — confirmar que
`price_usd`/`price_bs` coinciden con lo que Saint tiene registrado para ese
`product_name` en ese momento (dentro de la tasa BCV del día).

---

## Reversa de emergencia

**Si algo sale mal DESPUÉS del fast-forward pero ANTES de encender
`buscar_repuesto`:** no hay nada que revertir en el negocio — la
herramienta sigue apagada, así que el código nuevo no está corriendo
ningún turno real todavía. Alcanza con NO encender el interruptor y avisar
al orquestador.

**Si algo sale mal DESPUÉS de encender la herramienta:** apagarla de nuevo
desde Control IA (mismo interruptor) — eso detiene los turnos nuevos sin
tocar la base ni revertir el código. La función `buscar_productos` puede
quedarse aplicada sin problema (no la usa nada más que el tool loop con la
herramienta encendida).

**Revertir la migración en sí** (si hiciera falta, algo que el plan no
espera):

```sql
drop function if exists public.buscar_productos(jsonb, jsonb, int);
delete from supabase_migrations.schema_migrations where version = '20260926010000';
```

No hay backfill ni dato mutado que deshacer — la migración solo crea una
función.

---

## Qué debe devolver el Claude del VPS

1. Confirmación de en qué commit estaba producción antes de esta entrega
   (paso "(a)" de "Antes de aplicar").
2. Resultado del simulacro `BEGIN … ROLLBACK` (entró limpio, sin error).
3. Confirmación de que la migración real entró (`NOTICE`/sin `EXCEPTION`) y
   el conteo de `supabase_migrations.schema_migrations` antes/después.
4. Los tres `has_function_privilege` (verificación inmediata, punto 1).
5. Confirmación del fast-forward y de que el dominio responde 200 tras el
   deploy.
6. El ANTES/DESPUÉS de la re-simulación de §2.1/§2.3 — cuántas de las 16
   consultas originales mejoraron.
7. Confirmación de que el operador encendió `buscar_repuesto` (con fecha y
   hora, para poder medir la ventana de 48 h desde ahí).
8. A las 48 h: los números de la sección "Medir 48 h" — turnos que cotizan,
   que preguntan, `no_identificado`, `cifra_sin_fuente` (con el detalle de
   cada aparición si hay alguna) y el resultado de revisar 20 cotizaciones
   contra Saint (cuántas coincidieron, cuántas no y por qué).
