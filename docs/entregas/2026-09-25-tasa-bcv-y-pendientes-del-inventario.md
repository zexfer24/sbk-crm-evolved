# Entrega del 25/9/2026: la tasa BCV cuatro veces al día + lo que falta del inventario desde Saint

Para el Claude del VPS. Tiene dos partes:

- **Parte A.** El commit `8cfc56a`, pusheado a `main` el 25/9/2026.
- **Parte B.** Los dos pasos que quedaron pendientes de la entrega anterior,
  `docs/entregas/2026-09-25-inventario-desde-saint.md`.

**Esta entrega no trae ninguna migración.** No hay que aplicar nada contra la
base antes del código.

## 0. Antes de empezar: ¿en qué commit está producción?

Confirmar qué commit corre hoy en la app de Dokploy. `origin/main` es
`8cfc56a` y no hay nada más por encima. El push a `main` no despliega, así
que lo esperable es que producción siga en `782e0a4`: desplegar `8cfc56a`
desde Dokploy. Si ya estuviera en `8cfc56a`, pasar directo a la
verificación de la Parte A.

---

## Parte A: `8cfc56a`, "La tasa del BCV se lee cuatro veces al día y a las 18:00 ya trae la de mañana"

Los cinco puntos de siempre:

1. **Hash y título:** `8cfc56a`, "La tasa del BCV se lee cuatro veces al día y
   a las 18:00 ya trae la de mañana".
2. **Migración:** no trae. La tabla `exchange_rates` ya tiene todo lo que usa
   (`rate_date`, `usd_to_ves`, `fetched_at`, `fetched_on`). Lo único nuevo es
   que el upsert ahora escribe `fetched_at` de forma explícita. Antes esa
   columna solo tomaba su `default now()` cuando se creaba la fila.
3. **Variables de entorno:** no hay ninguna nueva. La ruta nueva usa el
   `CRON_SECRET` que ya existe.
4. **UI o servidor:** son las dos cosas, así que hace falta **rebuild
   completo** (~5 min). El chip de la bandeja (`bcv-rate-chip.tsx`) cambia su
   texto. Del lado del servidor hay una ruta nueva,
   `POST /api/cron/bcv-refresh`, y cambia la lógica de `getBcvRate`.
   **Además cambia `docker-compose.dokploy.yml`:** el servicio `cron` gana un
   segundo `curl` por minuto. Ese servicio **tiene que recrearse** para que
   tome el comando nuevo; ver el paso A1.
5. **Qué se verificó en local:**
   - La suite pasa en verde y el build también.
   - Tests de la ruta: sin token responde 401, sin `CRON_SECRET` responde 503
     y con el token correcto responde 200 con
     `{ rate, rateDate, isStale, refreshed }`.
   - Tests de la regla de horarios: `shouldRefetchBcv` y `lastScheduledRead`
     contra 00/06/12/18 hora de Venezuela.
   - Se mutó `bcv-schedule.ts` para confirmar que los tests se ponen en rojo,
     y el archivo quedó restaurado.
   - **Lo que no se pudo probar en local:** el cron real del compose, y la
     página del BCV a las 18:00 publicando la tasa del día hábil siguiente.
     Las dos cosas solo se ven en producción.

### Qué cambió, en una frase

Hasta ahora la tasa se releía una vez por día calendario, y solo si un asesor
abría la bandeja. Caso real: el 24/9 a las 23:53 el chip mostraba la tasa leída
a las 07:08, aunque el BCV ya había publicado la del 25. Ahora se relee a las
00:00, 06:00, 12:00 y 18:00 hora de Venezuela, que en UTC son las **04:00,
10:00, 16:00 y 22:00**. La relectura la dispara el servicio `cron` cada minuto,
y la ruta decide si de verdad toca salir a `bcv.org.ve`. Cuando no toca, la
llamada es solo una lectura de la base.

### A1. El servicio `cron` quedó recreado con el comando nuevo

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -i cron
docker inspect <contenedor-cron> --format '{{join .Args " "}}' | grep -o 'bcv-refresh'
```

Tiene que aparecer `bcv-refresh`, y el `Status` tiene que mostrar un arranque
posterior al deploy. Si no aparece, el contenedor sigue con el comando viejo.
En ese caso, recrearlo con un redeploy del compose en Dokploy, o con
`docker compose up -d --force-recreate cron` desde el directorio del compose.

### A2. La ruta responde, con token y sin él

Correr esto desde dentro del contenedor `cron`, que ya tiene `CRON_SECRET` y
ve a la app como `app:3000`:

```bash
docker exec <contenedor-cron> sh -c 'curl -s -X POST http://app:3000/api/cron/bcv-refresh -H "Authorization: Bearer $CRON_SECRET"'
# esperado: 200 con {"rate":...,"rateDate":"2026-09-..","isStale":false,"refreshed":true|false}

docker exec <contenedor-cron> sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -X POST http://app:3000/api/cron/bcv-refresh'
# esperado: 401
```

`refreshed: false` es lo normal fuera de los horarios: significa que la ruta
leyó la base y no salió a la red. En cambio, `isStale: true` quiere decir que
la última lectura del BCV falló y se está cotizando con la tasa guardada. Si
aparece, avisar.

### A3. `fetched_at` se mueve en los horarios

```sql
select rate_date, usd_to_ves, fetched_at, fetched_on
from public.exchange_rates
order by fetched_at desc
limit 5;
```

- Después del primer horario que pase tras el deploy (04:00, 10:00, 16:00 o
  22:00 UTC), el `fetched_at` más reciente tiene que caer **dentro de los
  primeros minutos** posteriores a ese horario.
- Si el BCV falla, la ruta reintenta cada minuto hasta leer.
- Cuando el BCV todavía publica la misma tasa, la fila de ese `rate_date` solo
  actualiza su `fetched_at`. No aparece una fila nueva, y es lo esperado.

Si pasa un horario completo sin que `fetched_at` se mueva, buscar
`bcv_refresh_fallido` y `[BCV]` en los logs de la app:

```bash
docker logs <contenedor-app> --since 2h 2>&1 | grep -E 'bcv_refresh_fallido|\[BCV\]'
```

### A4. A las 18:00 VE (22:00 UTC) de un día hábil, la tasa de mañana

Pasada la lectura de las 18:00, si el BCV ya publicó la tasa del día hábil
siguiente:

- `exchange_rates` tiene que tener una fila con `rate_date` = **mañana** (o el
  lunes, si es viernes).
- En la bandeja, el chip tiene que decir **"rige <día> <mes>."** en vez de solo
  la fecha.

Si a las 18:00 la página del BCV todavía no trae "Fecha Valor", **no se guarda
nada, a propósito**. La tasa de hoy queda puesta y se vuelve a intentar al
minuto siguiente. Guardar sin esa fecha pisaría la tasa vigente del día.
Reportar a qué hora apareció de verdad la fila de mañana. Todavía no sabemos
con qué retraso publica el BCV.

---

## Parte B: pendientes de "El inventario llega de Saint" (`77941ff` + `782e0a4`)

La migración `20260925010000` ya se aplicó y el código `782e0a4` ya se
desplegó. Faltan dos cosas.

### B1. El revoke de `updated_at`

Correr esto recién con `782e0a4` o `8cfc56a` en producción. Los dos traen la
pantalla nueva de Inventario, que ya no manda `updated_at`.

Primero, ver si alguien ya lo hizo:

```sql
select has_column_privilege('authenticated', 'public.products', 'updated_at', 'update') as updated_at_abierto,
       has_column_privilege('authenticated', 'public.products', 'weight_kg',  'update') as weight_kg_abierto;
```

Si `updated_at_abierto` da `true`:

```sql
revoke update (updated_at) on public.products from authenticated;
```

y repetir la consulta de arriba. Lo esperado es `updated_at_abierto = false` y
`weight_kg_abierto = true`. El grant de `weight_kg` se queda para siempre: es
el único campo que se edita a mano.

**Efecto esperado:** un navegador que todavía tenga en caché el bundle de
antes del 25/9 va a ver un toast de error al guardar un peso, hasta que
recargue la página. Si un asesor lo reporta, la solución es Ctrl+Shift+R.

### B2. Inventario en producción

Primero la sincronización, que tiene que seguir sana:

```sql
select created_at, fuente, duracion_ms, actualizados, insertados, bajas,
       reactivados, desactivados_por_saint, confirmados, guarda_activada, error
from saint.sync_log
order by created_at desc
limit 10;

select jrd.status, count(*)
from cron.job_run_details jrd
join cron.job j on j.jobid = jrd.jobid
where j.jobname = 'saint-sync-products'
  and jrd.start_time > now() - interval '24 hours'
group by 1;
```

Lo esperado: `error` en `null`, `guarda_activada` en `false` y las corridas del
job en `succeeded`. Si alguna tiene `guarda_activada = true`, **no forzar
bajas**. Primero leer la sección "La guarda de bajas por ausencia" de la
entrega del inventario.

También reportar el estado de dos cosas que quedaron abiertas:

- ¿Ya existe `liminal.agent_status`, con latido en los últimos 15 minutos?
- ¿Qué valores trae `activo` en la fuente (`saint.saprod` o `public.saprod`)?
  Si aparece algo distinto de `0`, `1` o `null`, avisar.

Después, la pantalla de Inventario, entrando como asesor:

- Stock y precio se ven como **texto, no como campos editables**.
- El peso **sí** se puede guardar.
- Los productos nuevos de Saint muestran su badge durante 7 días.

---

## Qué tiene que devolver el Claude del VPS

1. El commit que corre en producción antes y después de esta entrega.
2. **A1:** el comando del contenedor `cron` con `bcv-refresh`, y cuándo
   arrancó.
3. **A2:** la respuesta JSON con token y el 401 sin token.
4. **A3:** las filas de `exchange_rates` después de al menos un horario
   (04/10/16/22 UTC), con la hora exacta de `fetched_at`.
5. **A4:** si el chip mostró "rige …" pasadas las 22:00 UTC, y a qué hora
   apareció la fila con `rate_date` de mañana. Si todavía no llegó esa hora,
   decirlo.
6. **B1:** el resultado de `has_column_privilege` antes y después del revoke.
7. **B2:** las últimas corridas de `saint.sync_log`, el conteo de
   `cron.job_run_details`, el estado de `liminal.agent_status` y de `activo`,
   y lo que se vio en la pantalla de Inventario.
8. Cualquier resultado dudoso, aunque no parezca grave.
