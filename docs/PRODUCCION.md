# Puesta en producción

Estado del código: listo. Lo que falta es infraestructura y credenciales, que
solo puede poner quien tenga las cuentas.

Este documento es la lista de lo que hay que hacer, en orden, con la forma de
comprobar cada paso. Nada de "debería funcionar": cada punto trae cómo se
verifica.

---

## 1. Variables de entorno

Para producción, copia `.env.production.example`. Las que **no pueden faltar**:


| Variable | Por qué |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Instancia de producción, no la local |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave pública del cliente |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo servidor. **Nunca** en el navegador |
| `WHATSAPP_APP_SECRET` | Sin ella el webhook responde 503 y no procesa nada |
| `WHATSAPP_ACCESS_TOKEN` | Token permanente de System User, no el temporal del panel |
| `WHATSAPP_PHONE_NUMBER_ID` | Del número de WhatsApp Business |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | De la cuenta WABA |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | El que registres en Meta |
| `OPENAI_API_KEY` | O `GOOGLE_GENERATIVE_AI_API_KEY` según el proveedor |
| `AI_AGENT_PROVIDER` / `AI_AGENT_MODEL` | Proveedor y modelo del agente |

**El token de Meta caduca.** El que da el panel de desarrollo dura 24 horas.
Genera uno permanente desde un System User en Business Manager, o la IA dejará
de responder al día siguiente sin decir por qué.

**Verificación:** arranca la app y entra a `/agent-control`. La etiqueta del
modelo arriba a la derecha debe mostrar el proveedor y modelo que configuraste.

---

## 2. Base de datos

```bash
supabase link --project-ref <ref-de-produccion>
supabase db push
```

`db push` aplica las migraciones. **No corras `db reset` contra producción**:
borra todo.

El seed (`supabase/seed.sql`) crea tres usuarios con una contraseña que está
escrita en el propio archivo. Tiene un freno que aborta si detecta una base
real, pero la regla simple es: **el seed no se toca en producción**.

**Verificación:**

```sql
select count(*) from supabase_migrations.schema_migrations;  -- 49
select public from storage.buckets where id = 'whatsapp-media';  -- false
select public.agent_can_run();  -- true
```

### El lease del lock de turno de la IA

La migración `20260829020000_conversations_turn_lock_lease.sql` agrega dos
columnas a `conversations` (`ai_turn_lock_until`, `ai_turn_lock_token`) y tres
funciones — `ai_turn_lock_acquire`, `ai_turn_lock_renew`, `ai_turn_lock_release`
—, todas `security definer`: ningún camino con sesión de usuario debe poder
trabar ni destrabar la IA de un chat ajeno. Esta migración las dejó
revocadas a `public` y concedidas a `service_role`, pero eso solo, por sí
solo, **no** las cerraba — ver "Permisos de las funciones `security
definer`" más abajo. Lo que hoy las cierra de verdad es
`20260830010000_security_definer_revoke_roles.sql`.

**Regla dura: esta migración tiene que estar aplicada y visible en PostgREST
antes de desplegar el código que la usa** (commit "El lock de turno de la IA
vence solo: un proceso muerto ya no deja muda una conversación"). Si
PostgREST no recargó el esquema, cada turno de IA falla al intentar tomar el
lock. La migración termina en `notify pgrst, 'reload schema'`, así que
normalmente se entera sola — pero verifícalo, no lo des por hecho:

```sql
-- Las dos columnas existen
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'conversations'
  and column_name in ('ai_turn_lock_until', 'ai_turn_lock_token');

-- Las tres funciones existen
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('ai_turn_lock_acquire', 'ai_turn_lock_renew', 'ai_turn_lock_release');
```

Los permisos de estas tres (y de toda otra función `security definer` de
`public`) se verifican con la consulta única de la sección siguiente — no con
`has_function_privilege` función por función. Esta misma página llegó a
afirmar acá que `ai_turn_lock_acquire` le daba `false` a `authenticated`;
hasta el 30/8/2026 el resultado real era `true`, y ese check daba una
tranquilidad que no existía (ver más abajo).

Y una llamada real por PostgREST, con la service key, contra un uuid que no
existe:

```bash
curl -X POST "https://<tu-proyecto>.supabase.co/rest/v1/rpc/ai_turn_lock_acquire" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_conversation_id":"00000000-0000-0000-0000-000000000000","p_token":"chequeo","p_lease_seconds":90}'
```

Debe responder `false` (el `update` no encontró la fila) — **no un 404**. Un
404 acá es la señal de que PostgREST todavía no recargó el esquema.

**Lo que NO hace falta:** ningún `UPDATE` de reparación sobre
`ai_turn_running`. Esa columna queda (obsoleta, se elimina en una migración
posterior), el mecanismo nuevo la ignora, y las conversaciones que hoy estén
trabadas por un turno zombi se descongelan solas al desplegar — sin acción
manual.

### Permisos de las funciones `security definer`

Auditoría en el VPS el 30/8/2026: las **17 funciones `security definer`** del
esquema `public` eran ejecutables por `anon` y `authenticated`.
`security definer` salta RLS — no hay política que frene una llamada así — y
la anon key es pública: viaja al navegador. Con la anon key y sin sesión,
`POST /rest/v1/rpc/agent_metrics {"p_days":1}` devolvía HTTP 200 con métricas
por asesor, ventas y montos; `ai_turn_lock_acquire` dejaba tomar el lock de
una conversación real y silenciarla para la IA; `claim_agent_turn(integer,
integer)`, que no tiene argumentos obligatorios, dejaba robar turnos de la
cola de IA.

**Causa raíz — dos vías de privilegio, no una:** Postgres —no Supabase—
concede de fábrica `EXECUTE` a toda función nueva al pseudo-rol `PUBLIC`.
Encima, Supabase deja puesto en `public` un `alter default privileges ...
grant execute on functions to anon, authenticated, service_role` (visible en
`pg_default_acl`; lo tienen los roles `postgres` y `supabase_admin`), que le
da a `anon`/`authenticated` un grant explícito, aparte del de `PUBLIC`.
Mientras cualquiera de las dos vías siga abierta, `has_function_privilege
('anon', ...)` da `true` — `anon` hereda de `PUBLIC` — así que **hacen falta
los dos revokes, y ninguno alcanza solo**:
`revoke execute ... from public` corta la primera vía pero deja la segunda
intacta; `revoke execute ... from anon, authenticated` corta la segunda pero
deja la primera intacta. Las migraciones que quisieron cerrar esto
probaron una vía cada una y ninguna cerró nada:
`20260829020000_conversations_turn_lock_lease.sql:113-115` solo tenía el
revoke de `public` (por eso las tres funciones del lock sí quedaron cerradas
a `anon` — les faltaba la otra mitad, pero esa mitad ya la tenían);
`20260822040000_agent_turn_queue.sql:115-119` ni siquiera tiene un `revoke`,
solo grants. La primera versión de
`20260830010000_security_definer_revoke_roles.sql`, aplicada contra una
base real el 30/8/2026, cometió el error inverso: solo tenía el revoke de
`anon, authenticated` y por eso catorce de las diecisiete funciones
siguieron abiertas a `anon` pese a "verse" cerrada en el `.sql` — un revoke
incompleto se lee igual de bien que uno completo, así que **la verificación
tiene que medir `has_function_privilege` contra la base, nunca leer el
archivo**.

Lo cerraron tres migraciones del 30/8/2026:

- `20260830010000_security_definer_revoke_roles.sql` — los dos revokes por
  firma (`public` y `anon, authenticated`) más el `grant` explícito a quien
  conserva el acceso, para las 18 funciones que toca, y
  `notify pgrst, 'reload schema'`.
- `20260830020000_funciones_denegar_por_defecto.sql` — cambia el default de
  `public` para que las funciones futuras nazcan cerradas. No repara ninguna
  función existente; eso lo hace la anterior.
- `20260830030000_agent_metrics_guarda.sql` — `agent_metrics` verifica
  `is_agent()` desde adentro, como segunda línea de defensa detrás del
  revoke, por si un `grant` futuro la vuelve a abrir.

**No verifiques función por función.** Una sola consulta recorre todas las
`security definer` de `public` y muestra qué puede ejecutar cada rol:

```sql
select
  p.proname as funcion,
  pg_get_function_identity_arguments(p.oid) as argumentos,
  has_function_privilege('anon', p.oid, 'execute') as anon,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
  has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
order by anon desc, authenticated desc, p.proname;
```

Qué se espera ver:

- **`anon` en `false` en todas las filas salvo `is_agent` e
  `is_supervisor_or_admin`.** Esas dos tienen que seguir en `true` para los
  tres roles a propósito: 49 políticas de RLS vivas las invocan y 48 no
  llevan cláusula `TO` (o sea que corren `TO public`, para todos los roles
  incluido `anon`). Revocarle `EXECUTE` a `anon` sobre `is_agent` convierte
  una consulta anónima a `contacts` (que hoy devuelve 0 filas) en un `42501
  permission denied for function is_agent`; revocárselo a `authenticated`
  tumba el CRM para todo el equipo. Si aparecen en `true`, es lo correcto —
  no las "arregles".
- **`authenticated` en `false`** para `ai_turn_lock_acquire`,
  `ai_turn_lock_renew`, `ai_turn_lock_release`, `claim_agent_turn`,
  `enqueue_agent_turn`, `finish_agent_turn` y `rate_limit_allow`: el grupo
  que solo llama `service_role` vía `createAdminClient()`.
- **`authenticated` en `true`** para `agent_metrics`, `agent_can_run` y
  `agent_spend_today`: el navegador sí las llama, siempre con sesión de
  asesor. Que una ruta corra en el servidor no basta para service_role —
  `src/app/api/agent/backlog/route.ts:50` arma su cliente con
  `createClient()` de `@/lib/supabase/server` (anon key + cookie de sesión),
  así que viaja como `authenticated`, y por eso `agent_can_run` no se pudo
  cerrar del todo.
- **`service_role` en `true` en todas las filas**, sin excepción.

### Datos que sí van en producción

- `supabase/seeds/moto_catalog_seed.sql` — catálogo de motos. Va.
- `supabase/seeds/ai_playbooks.sql` — las cinco respuestas de la IA. Va, pero
  revisa los textos desde el panel antes de encender la IA: son un borrador.
- `supabase/seed.sql` — **no va.**

### Tarifas del modelo

`model_pricing` viene con precios de ejemplo. Ajústalos desde
`/agent-control` con los reales de tu proveedor, o el costo que muestre el
panel será ficción y el tope de gasto no protegerá lo que crees.

---

## 3. Usuarios reales

Crea las cuentas del equipo desde Supabase Auth (invitación por correo). La
fila en `public.agents` se crea sola al registrarse.

Asigna los roles a mano:

```sql
update public.agents set role = 'supervisor' where id = '<uuid>';
```

Los roles importan: `supervisor`/`admin` son los únicos que pueden verificar
ventas, revertirlas, cambiar tarifas, mover el tope de gasto y editar las
respuestas de la IA. Un `agent` no puede, y eso está respaldado en RLS, no
solo en la interfaz.

**Verificación:** entra con una cuenta `agent` y comprueba que en
`/agent-control > Respuestas` no aparecen los botones de editar.

---

## 4. Canal de WhatsApp

```sql
insert into public.whatsapp_channels (display_name, phone_number, phone_number_id, waba_id, status)
values ('Principal', '+58...', '<phone_number_id>', '<waba_id>', 'connected');
```

Mientras `status` no sea `'connected'`, el CRM simula los envíos: guarda el
mensaje pero no lo manda. Sirve para probar sin gastar.

---

## 5. Webhook

Registra en Meta: `https://<tu-dominio>/api/webhooks/whatsapp`, con el
`verify_token` que pusiste en la variable.

Necesita **HTTPS y dominio público**. No funciona con `localhost`; en
desarrollo se usa un túnel (`cloudflared tunnel --url http://localhost:3000`).

**Verificación:** el handshake de Meta debe dar verde al registrar. Después,
manda un mensaje real al número y comprueba que aparece en la bandeja.

---

## 6. Antes de encender la IA

La IA arranca encendida. Antes de que hable con un cliente real:

1. **Revisa las cinco respuestas** en `/agent-control > Respuestas`. Los
   textos del seed son un borrador.
2. **Configura los links** de catálogo y niveles de Cashea, que quedaron
   vacíos a propósito.
3. **Pon un tope de gasto diario.** Sin tope, una ráfaga de mensajes gasta sin
   límite. Empieza conservador; el panel muestra cuánto se lleva consumido.
4. **Prueba con el simulador** de `/agent-control`, que corre sobre una
   conversación de prueba y nunca toca un número real.
5. **Ten a mano el interruptor global**, que apaga la IA en todo el CRM de una
   vez.

Si un turno se cae a mitad de camino (crash, redeploy), la conversación queda
bloqueada como máximo 90 segundos —`TURN_LOCK_LEASE_SECONDS` en
`src/lib/ai/conversation-lock.ts`— y no para siempre como con el booleano de
antes. Mientras el turno sigue vivo, un latido renueva ese lease cada 30
segundos (`TURN_LOCK_RENEW_SECONDS`), así que un turno normal nunca lo deja
vencer.

---

## 7. Desplegar la aplicación

### Requisito: Node 22 o más

`whatwg-url`, que entra como dependencia transitiva, exige `>=22.14`. Con
Node 20 la instalación avisa `EBADENGINE`. Está declarado en `engines` del
`package.json` y fijado en el Dockerfile y en el CI.

### Desde tu máquina, a un servidor por SSH (lo más corto)

```bash
cp .env.production.example .env.production   # y complétalo
./scripts/deploy.sh usuario@tu-servidor
```

`deploy.sh` valida la configuración **antes de tocar el servidor**, comprueba
que allá haya Docker y que el dominio le resuelva, copia el proyecto —sin
`node_modules` ni `.git` ni respaldos—, levanta el stack, espera a que el CRM
responda sano y verifica el TLS desde fuera. Si algo falla, para y dice qué
mirar. Volver a correrlo actualiza el despliegue.

El `.env.production` viaja aparte y queda en el servidor con permisos `600`.

### En el propio servidor

```bash
cp .env.production.example .env.production   # y complétalo
./scripts/preflight.sh                       # revisa antes de arrancar
docker compose --env-file .env.production up -d
```

El `--env-file` no sobra: sin él Compose lee `.env` para resolver los `${...}`
del archivo, `DOMAIN` llega vacío y Caddy no pide certificado para ningún
dominio.

`preflight.sh` no deja pasar lo que se puede detectar sin encender nada: una
variable que falta, la anon key puesta donde va el service role, la URL de
Supabase apuntando todavía a localhost, un `CRON_SECRET` de juguete o una
versión de Node insuficiente. Sale con error si algo de eso pasa.

`docker compose` levanta tres cosas:

- **app** — el CRM, con `HEALTHCHECK` contra `/api/health`.
- **caddy** — TLS automático de Let's Encrypt, más cabeceras de seguridad. Por
  eso el dominio tiene que resolver a este servidor **antes** de arrancar: si
  no, el certificado no se emite.
- **cron** — procesa cada 5 minutos lo que quede pendiente en la cola de
  turnos.

**Verificación:**

```bash
docker compose --env-file .env.production ps   # los tres arriba, app en "healthy"
curl https://<tu-dominio>/api/health    # 200
```

### En Dokploy

Dokploy despliega desde un repositorio Git, así que el proyecto tiene que estar
en uno. Privado: el `.env.production` no se versiona, pero el código sí es del
negocio.

Create Service → **Compose**, Provider **Git**, Compose Path
`./docker-compose.dokploy.yml`. Lo de `.env.production` se pega en la pestaña
**Environment** —de ahí Dokploy arma el `.env` que lee el stack—, y el dominio
va en **Domains**, apuntando al servicio `app`, puerto 3000, con Let's Encrypt.

Ese compose es este mismo stack menos Caddy: Dokploy ya trae Traefik en los
puertos 80 y 443, y dejar Caddy no es redundante sino que impide que el stack
levante. Las cabeceras de seguridad que ponía el Caddyfile las pone ahora la
propia aplicación, en `headers()` de `next.config.ts`, así que ya no dependen
de qué proxy haya delante.

El DNS tiene que apuntar al servidor **antes** de desplegar, igual que con
Caddy: el certificado se emite al arrancar.

`preflight.sh` no corre en Dokploy —no hay `.env.production` allá—, así que
pásalo localmente contra tu copia antes de pegar las variables en el panel.

**Verificación:**

```bash
curl -I https://<tu-dominio>          # 200, con strict-transport-security
curl https://<tu-dominio>/api/health  # 200
```

### Solo la imagen, sin compose

```bash
docker build -t sbk-motorcycles-crm \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="https://<proyecto>.supabase.co" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon-key>" .

docker run -d -p 3000:3000 --env-file .env.production --restart unless-stopped sbk-motorcycles-crm
```

Las `NEXT_PUBLIC_*` van como `--build-arg` **y** en el `.env.production`: se
incrustan en el bundle al compilar, así que en tiempo de arranque ya es tarde.
No son secretos — la anon key está pensada para viajar al navegador y la
protege RLS. Lo que **nunca** va en un build-arg es la `SUPABASE_SERVICE_ROLE_KEY`.

La imagen corre como usuario sin privilegios y trae `HEALTHCHECK` contra
`/api/health`, así que el orquestador reinicia el contenedor solo si el CRM
deja de alcanzar la base.

### Sin Docker

```bash
npm ci && npm run build
node .next/standalone/server.js     # con las variables en el entorno
```

Detrás de un reverse proxy (Caddy, nginx) que termine TLS. El webhook de Meta
exige HTTPS.

### El stack ya se probó entero

No solo la sintaxis del compose: se levantaron los tres servicios juntos
contra una base real y se comprobó de punta a punta.

| Comprobación | Resultado |
|---|---|
| `app` alcanza la base y queda `healthy` | ✅ |
| HTTPS a través de Caddy | 200 |
| HTTP redirige a HTTPS | 308 |
| HSTS, `X-Frame-Options`, `nosniff` | presentes |
| Cabecera `Server` oculta | ✅ |
| El login no filtra credenciales | ✅ |
| El cron procesa la cola con su token | `{"ok":true}` |
| El cron sin token | 401 |

De ahí salió `extra_hosts`, que hace falta si Supabase corre en el mismo
servidor: en Linux `host.docker.internal` no existe sin esa línea.

### Ráfagas de mensajes

Meta entrega casi siempre **un POST por mensaje**. Sin nada que lo modere, un
cliente que escribe «hola» / «quiero un carburador» / «para una Bera» recibía
tres respuestas sueltas, cada una sin el contexto de las siguientes.

La cola espera **6 segundos de silencio** antes de atender: cada mensaje nuevo
corre esa ventana hacia adelante, así que una ráfaga termina siendo un solo
turno con el hilo completo. Y si el cliente escribe justo mientras la IA está
respondiendo, el turno vuelve a la cola en vez de descartarse.

El valor está en `DEBOUNCE_SECONDS` (`src/lib/ai/queue.ts`). Por debajo de 5
casi no agrupa; por encima de 15 el cliente cree que lo ignoraste.

### Cron de la cola de turnos

Los turnos de la IA se encolan y se procesan aparte, para que un reinicio a
mitad de camino no se lleve la respuesta de un cliente. El camino normal es
que el propio webhook procese lo que encola; el cron es la red de seguridad
para lo que ese camino no cubre — el proceso que murió a mitad, o el turno
que falló y espera otro intento.

Define `CRON_SECRET` (una cadena larga y aleatoria) y llama cada 5 minutos:

```cron
*/5 * * * * curl -fsS -X POST https://<tu-dominio>/api/cron/process-queue -H "Authorization: Bearer $CRON_SECRET" > /dev/null
```

Sin `CRON_SECRET` el endpoint responde 503 y no procesa nada: dispara turnos
de IA, o sea gasto, así que falla cerrado siempre.

Para ver qué quedó atascado:

```sql
select conversation_id, status, attempts, last_error from public.agent_turn_queue;
```

Una fila en `failed` con 3 intentos ya no se reintenta sola: revisa
`last_error` y, si corresponde, vuelve a encolarla con
`select public.enqueue_agent_turn('<conversation_id>')`.

### Monitoreo

Apunta un monitor externo —UptimeRobot, Better Stack, el que uses— a
`https://<tu-dominio>/api/health` cada minuto. Devuelve **200** solo si el CRM
alcanza la base y tiene sus variables; **503** en cualquier otro caso, con el
detalle de qué falló. No expone versiones ni credenciales.

---

## 8. Respaldos

Los scripts están hechos y **probados restaurando de verdad**:

```bash
export DATABASE_URL="postgresql://usuario:clave@host:5432/postgres"

./scripts/backup.sh                     # deja backups/sbk-<fecha>.sql.gz
./scripts/restore.sh backups/sbk-20260822-030000.sql.gz
```

En cron, un respaldo diario a las 3 de la mañana:

```cron
0 3 * * * cd /ruta/al/crm && DATABASE_URL='...' BACKUP_DIR=/var/backups/sbk ./scripts/backup.sh >> /var/log/sbk-backup.log 2>&1
```

`RETENTION_DAYS` (30 por defecto) controla cuántos días se guardan.

### Prueba de restauración

Se verificó el ciclo entero contra la base local: respaldar, **tirar el
esquema `public` completo** y restaurar. Todo volvió — 5 conversaciones, 18
mensajes, 31 familias de motor, 3 usuarios, 12 funciones, 40 políticas RLS,
9 triggers, y el bucket seguía privado.

De esa prueba salieron tres fallas que ningún script sin probar detecta:

1. Volcar los esquemas `auth` o `storage` completos aborta con *"must be
   owner of table"* por tablas internas de Supabase.
2. El `--clean` de `pg_dump` aborta a mitad porque un trigger de `auth.users`
   depende de una función de `public`, y deja la base **peor que antes**.
3. El volcado ya trae su `CREATE SCHEMA public`, así que el restore debe
   tirar el esquema sin recrearlo.

**Repite esta prueba contra una base de repuesto cada tanto.** Un respaldo que
nunca se restauró no es un respaldo.

### Lo que los scripts NO respaldan

Los **archivos del bucket** (fotos, audios, comprobantes). `storage.objects`
guarda las rutas, no el contenido. Para eso:

- Supabase gestionado: los respaldos del plan ya lo cubren.
- Self-hosted: incluye el volumen de Storage en el respaldo del servidor.

---

## 9. Lo que todavía no existe

Honestidad sobre el estado, para que nadie se lleve una sorpresa:

- **No hay agregador de registros configurado.** El código ya emite una línea
  JSON por evento (`{"level","event","ts",...}`), lista para que Loki, Datadog
  o CloudWatch la indexen sin parsear texto, y oculta solo los valores
  sensibles. Falta apuntar un recolector a la salida del contenedor y armar
  las alertas. Los eventos que merecen una: `cola_encolar_fallido`,
  `cola_turno_fallido`, `webhook_sin_secreto_en_produccion` y
  `webhook_firma_invalida`.
- **Un solo token de WhatsApp** para todos los canales. Con más de un número
  hay que extender `whatsapp_channels`.
- **La PII no está cifrada en reposo.** Cédula, dirección y teléfono se
  guardan en claro. Están protegidos por RLS y por la sesión, pero quien
  tenga acceso a la base los ve.

---

## Comprobación final

Con todo configurado, esta lista debe pasar entera:

- [ ] Una restauración de prueba devuelve los datos completos
- [ ] `npm run build` sin errores ni warnings
- [ ] `select count(*) from supabase_migrations.schema_migrations` devuelve 49
- [ ] El bucket `whatsapp-media` es privado (`public = false`)
- [ ] Una URL directa al bucket responde 400
- [ ] `/api/media/...` sin sesión responde 401
- [ ] Un mensaje real llega del número de WhatsApp a la bandeja
- [ ] Una foto enviada desde el CRM llega al teléfono del cliente
- [ ] Una foto que manda el cliente se ve en la bandeja
- [ ] Con la IA encendida, un mensaje de prueba obtiene respuesta
- [ ] El tope de gasto está configurado y el panel muestra el consumo
- [ ] `/agent-control` sigue mostrando las métricas por asesor (es lo que se
      rompe si alguien revoca `authenticated` de `agent_metrics` por error,
      creyendo que hay que cerrarla igual que las del lock de turno)
