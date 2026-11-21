# Entrega «La tasa BCV no vuelve a quedarse sin leer» (21/11/2026)

Rama `entrega/bcv-cadena-tls`, commit `<<commit>>`. Trae **una migración** (`20261121010000`), sin
variables de entorno nuevas y sin cambios en la interfaz de los asesores salvo el chip de la bandeja y
una nota en `/inventario`. El procedimiento completo con las consultas de verificación está en
`docs/PRODUCCION.md` §21.

## Qué pasó

Desde el **19/11/2026 04:00 UTC** cada lectura de `bcv.org.ve` falló con
`unable to verify the first certificate`. El BCV renovó la hoja `*.bcv.org.ve` (vigente 2026-11-13 a
2027-05-30) y ahora la firma **Sectigo Public Server Authentication CA OV R36**. Antes la firmaba la DV
R36, que era la única embebida en el código. Nadie lo vio en dos días: el único aviso era un
`console.error` por minuto. La tasa se cargó a mano el 20/11 (918,7662) y el 24/11 (919,8227).

## Antes de nada

1. **Confirmar con el operador en qué commit está producción** y listar las migraciones del rango con
   `git diff --name-only <produccion>..HEAD -- supabase/migrations`. Esta entrega agrega una sola:
   `20261121010000`.
2. **El código va ANTES que la migración.** Sin la tabla `bcv_fetch_status` todo funciona igual: el
   contador de fallos queda en memoria del proceso y la alerta no se muestra. La migración puede aplicarse
   después del deploy, en cualquier momento; lo único que espera es el chip rojo y la nota de Inventario.

## Orden de aplicación

1. **Deploy del código** (`<<commit>>`), como cualquier entrega.
2. **Migración**, con `psql -1 -v ON_ERROR_STOP=1`, fuera de hora pico (aunque es una tabla nueva y
   chica):

   ```bash
   psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261121010000_bcv_fetch_status.sql
   ```

   Crea `public.bcv_fetch_status` (una fila), la RPC `public.bcv_registrar_intento(boolean, text)`
   (solo `service_role`) y hace el backfill de `last_success_at` con el último `fetched_at` de
   `exchange_rates` con `source = 'bcv.org.ve'`. Las filas manuales NO cuentan.
3. **Verificación** (sección siguiente). No hace falta ningún paso de relleno ni script.

Si el procedimiento del VPS registra las migraciones en `schema_migrations`, registrar
`20261121010000` igual que las anteriores.

## Commits

| # | Hash y título (provisional, lo fija el orquestador) | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | `<<commit>>` [migración] Estado de la lectura de la tasa BCV en la base | **Sí**, `20261121010000_bcv_fetch_status.sql` | No | Base |
| 2 | `<<commit>>` La tasa BCV vuelve a leerse aunque el BCV cambie de certificado (cadena TLS, logs, alerta, chip y nota de Inventario) | No | No (`CRON_SECRET` ya existe) | Servidor y UI |

El código de la fila 2 tolera que la tabla de la fila 1 no exista; la migración puede aplicarse después del
deploy.

## Qué cambia para el equipo

- **La cadena TLS del BCV se arma sola, sin bajar la verificación.** `bcv-intermediate-ca.ts` embebe
  DV R36 y OV R36. Si una lectura falla por la cadena, `bcv-fetch.ts` hace lo siguiente, en orden:
  1. Lee la hoja del servidor con un `tls.connect` **sin verificar**. Es la única excepción en todo el
     módulo, y solo lee el certificado.
  2. Descarga el intermedio desde el AIA de la hoja, **solo** de hosts `.sectigo.com`, `.usertrust.com` o
     `.comodoca.com`, con 10 s de tiempo, 64 KB de tope y sin redirecciones.
  3. Verifica el intermedio antes de usarlo: firma la hoja, es CA, está vigente y encadena a una raíz del
     almacén del sistema. Si algo falla, lo descarta.
  4. Reintenta el GET **con verificación completa**.
  Un fallo de búsqueda en el AIA se recuerda 5 minutos (en memoria) para no pegarle al AIA cada minuto.
- **Señal para embeber el intermedio en el próximo commit.** Cada vez que se baja un intermedio se loguea
  `bcv_intermedio_descargado` con `{subject, sha256, url}`. Es la señal de que hay que agregarlo a
  `bcv-intermediate-ca.ts` en el siguiente commit, para no depender del AIA.
- **El fallo se ve.** Tabla `bcv_fetch_status`: `last_attempt_at`, `last_success_at`, `last_failure_at`,
  `last_error` y `consecutive_failures`. `getBcvRate` devuelve además `alerta` cuando el último éxito tiene
  **más de 8 horas**. La alerta mira `last_success_at`, no `exchange_rates`: una tasa cargada a mano no la
  apaga.
- **Logs nuevos, y el ruido se fue.** `bcv_lectura_fallida` solo en el primer fallo, cuando cambia el motivo
  o cada 60 fallos seguidos; `bcv_sin_actualizar` una sola vez, exactamente en el fallo 240 (~4 h de cron);
  `bcv_lectura_recuperada` al volver a leer; `bcv_sin_tasa_guardada` si no hay ninguna tasa. El `console.error`
  por minuto ya no existe.
- **Chip de la bandeja** (`src/components/inbox/bcv-rate-chip.tsx`): cuando hay alerta se pone rojo y dice
  «sin actualizar desde <fecha VE>»; el último error va en el `title`.
- **Tarjeta «Tasa BCV» de `/inventario`:** la nota «Sin actualizar desde …» aparece con la misma condición.
- **Simulacro para el VPS:** `POST /api/cron/bcv-refresh?simulacro=aia` con `Authorization: Bearer $CRON_SECRET`.
  Arma la cadena con las raíces del sistema y SOLO la DV R36 (sin la OV), busca por AIA, no escribe en la base
  y responde `{simulacro: "aia", ok, armadoPorAia, intermedio: {subject, sha256, url}}`: 200 si `ok`, 502 si no.
- **Sin la tabla todo sigue igual.** Si `bcv_fetch_status` no existe, el estado se lleva en un contador de
  memoria del proceso y la lectura de la tasa no cambia.

## Verificación paso a paso

Ejecutar en este orden, después del deploy y de la migración. Reemplazar `<tu-dominio>`, `<contenedor-app>` y
`<base>` por los reales del VPS.

**1. Sin el error de cadena en los logs.** Desde el deploy:

```bash
docker logs <contenedor-app> --since 30m 2>&1 | grep -cE "unable to verify the first certificate|bcv_lectura_fallida|bcv_aia_fallo"
```

Resultado esperado: `0`. Ojo: con el código nuevo un fallo de cadena ya no sale con el texto en inglés como
línea propia, sale como `bcv_lectura_fallida` (con el motivo en español) y, si falló la búsqueda por AIA,
`bcv_aia_fallo`; por eso el grep busca los tres. Si sale mayor que cero, la lectura sigue fallando y la cadena no se armó: no seguir
con los pasos siguientes hasta entender por qué (buscar `bcv_lectura_fallida` y `bcv_intermedio_descargado`).

**2. La tasa se relee en el horario.** En la base, la fila más reciente de BCV:

```sql
select rate_date, usd_to_ves, fetched_at
from exchange_rates
where source = 'bcv.org.ve'
order by fetched_at desc
limit 3;
```

`fetched_at` tiene que moverse en el próximo horario de lectura (00, 06, 12 o 18 hora de Venezuela). Si no se
mueve en ese horario, revisar el cron de `/api/cron/bcv-refresh` antes de seguir.

**3. El simulacro de la cadena por AIA:**

```bash
curl -s -X POST "https://<tu-dominio>/api/cron/bcv-refresh?simulacro=aia" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Resultado esperado: HTTP 200 con `"simulacro":"aia"`, `"ok":true` y `"armadoPorAia":true`. El simulacro no
escribe en la base: se puede correr en producción sin riesgo. Un 502 quiere decir que la cadena no se pudo armar: la
respuesta trae `"ok":false` y un `motivo` que nombra qué falló (hoja ilegible, AIA fuera de la lista de hosts,
descarga, o cuál de los cuatro chequeos rechazó el certificado).

**4. El estado de la lectura, tras la primera lectura buena:**

```sql
select last_attempt_at, last_success_at, last_failure_at, consecutive_failures
from bcv_fetch_status;
```

Resultado esperado: `consecutive_failures = 0` y `last_success_at` de hace menos de 8 horas. Si la fila no existe
(error de tabla no encontrada), la migración no se aplicó todavía: aplicarla, no es un fallo del código.

**5. El chip.** Recargar la bandeja: el chip de la tasa no debe estar rojo. Si lo está, el texto dice desde cuándo
no se actualiza y el `title` trae el último error.

## Lo que queda a medias o sin verificar

- **Pendiente de Seba (la IA), fuera de esta entrega por decisión del operador.** La cotización la arma el código
  (`src/lib/ai/quote-message.ts`) y reemplaza el texto que escribe el modelo. Con una tasa vieja, lo que se
  desfasa es el "$ BCV" (Bs ÷ tasa), no el Bs de SAINT. Falta una línea fija en `quote-message.ts` que avise de
  la tasa desactualizada. No hay que hacerlo en el VPS.
- **Verificado en local el 21/11/2026 contra el BCV real:** el simulacro dio `armadoPorAia: true` con el
  intermedio de sha256 `65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30`,
  y la lectura normal dio `919,82270000`. Esas dos cosas son la referencia para comparar en el VPS.
- **Los certificados de prueba** (`src/lib/ai/__fixtures__/bcv-certs/`) son sintéticos (los válidos rigen
  hasta 2099; el vencido lo está a propósito desde 2021). No son los de Sectigo. Si se regeneran, usar `scripts/generar-certs-prueba-bcv.sh` (openssl 3.4 o
  más nuevo).
