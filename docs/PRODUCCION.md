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
| `AI_AGENT_REASONING` | `on`/`off`, default `on`. En `off` el agente y el clasificador no mandan `reasoningEffort` al proveedor. Ponla en `off` en producción mientras el modelo sea `gpt-5.6-luna` vía OpenRouter: no soporta razonamiento y con `on` el SDK deja el warning `reasoningEffort is not supported` varias veces por turno sin que el parámetro se aplique |
| `AI_HUMAN_GRACE_MINUTES` | Default 30. Minutos que un asesor "conserva" un chat después de escribir, aunque el cliente ya haya vuelto a escribir después de él. Súbela sin redeploy (solo cambiar la variable) si aparece `turno_persona_se_adelanto` sobre una conversación que un asesor está atendiendo ahora mismo |
| `AGENT_MAX_CONCURRENT_TURNS` | Default 8 (antes 3, hasta el 7/9/2026). Turnos con el modelo abierto a la vez, en todo el sistema. Ver "Rampa de los topes" más abajo. Vuelta atrás: bajarla en Dokploy y redesplegar (~20 s de corte, sin rebuild si no cambió el código) |
| `AGENT_MAX_TURNS_PER_MINUTE` | Default 30 (antes 4). El freno real de la cola: la espera de un cliente es cola ÷ este número. Medido el 7/9/2026: con 4, hasta 90 min de espera con 360 turnos acumulados. Ver "Rampa de los topes". Vuelta atrás: bajarla en Dokploy — es la palanca más rápida que hay, se lee en cada pasada |
| `AGENT_QUEUE_MAX_PER_RUN` | Default 30 (antes fijo en diez, sin variable). Turnos que una sola pasada de la cola atiende. Ver "Rampa de los topes" |
| `AI_MAX_CONCURRENT_REQUESTS` | Default 12 (antes 3). Peticiones al proveedor en vuelo a la vez. Tiene que subir junto con `AGENT_MAX_TURNS_PER_MINUTE`, ver "Rampa de los topes" |
| `AI_MAX_REQUESTS_PER_MINUTE` | Default 120 (antes 15). El "15 contra 20" viejo era el techo de la cuenta gratuita de OpenRouter; en producción `is_free_tier: false` y `limit: null`. Tiene que subir junto con `AGENT_MAX_TURNS_PER_MINUTE`, ver "Rampa de los topes" |

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

**`20260905070000_auto_reply_recalcula`** (anexo B1, "Bandeja que no
pierde", 5/9/2026): su backfill marca `is_auto_reply = true` en la despedida
de las escalaciones sin asesor guardadas ANTES del anexo A1 —conversaciones
que hoy `awaiting_reply` da en `false` porque esa despedida quedó registrada
como si fuera una respuesta real, cuando el cliente seguía esperando a una
persona. Tras aplicarla van a REAPARECER en "Pendientes" y "Sin dueño"
escalaciones viejas sin asesor, y **eso es lo correcto**: avísale al equipo
antes de aplicarla, para que no lea el salto en esas píldoras como un bug.
Para medir cuántas filas va a tocar antes de aplicarla:

```sql
select count(*)
from public.messages m
join public.conversations c on c.id = m.conversation_id
where c.journey_stage = 'assigned'
  and not c.ai_enabled
  and c.assigned_agent_id is null
  and c.status <> 'closed'
  and not c.awaiting_reply
  and c.last_reply_sender = 'ai'
  and m.direction = 'outbound' and m.sender_type = 'ai'
  and not m.is_internal_note and not m.is_auto_reply
  and m.created_at = c.last_reply_at;
```

**Verificación:**

```sql
select count(*) from supabase_migrations.schema_migrations;  -- 60
select public from storage.buckets where id = 'whatsapp-media';  -- false
select public.agent_can_run();  -- true
```

**`20260907010000_ventana_24h_dice_la_verdad`** (corrida "La ventana de 24 h
dice la verdad", 7/9/2026): corrige el caso de la conversación `aa75ef33…`
(+593987317372), que mostraba la caja de texto habilitada y "quedan 11 h"
mientras Meta rechazaba todo con el código 131047 (ventana de 24 h cerrada).
`create or replace` de `handle_new_message()` y `handle_message_status_change()`
con dos candados sobre `last_customer_message_at` (lcma): un entrante
`message_type = 'unsupported'` deja de mover lcma/`unread_count` (sigue
visible en el chat y la lista); un saliente `failed` con 131047 cierra lcma a
`created_at − 24 h`. Sin función `security definer` nueva, sin revokes ni
grants. Trae un backfill idempotente en tres pasos — mide cuántas filas toca
cada uno ANTES de aplicarla:

```sql
-- Paso (a): mensajes históricos (anteriores a T3.2, 5/9/2026) que se
-- reclasifican de 'text' a 'unsupported'
select count(*)
from public.messages
where direction = 'inbound'
  and message_type = 'text'
  and content like 'El cliente envió un mensaje que el CRM todavía no sabe mostrar%';

-- Paso (b): conversaciones cuyo last_customer_message_at apunta al
-- created_at de un entrante unsupported (real o recién reclasificado en (a))
-- y se recalcula contra el último entrante que sí cuenta (puede quedar null)
select count(*)
from public.conversations c
where exists (
  select 1
  from public.messages m
  where m.conversation_id = c.id
    and m.direction = 'inbound'
    and m.message_type = 'unsupported'
    and m.created_at = c.last_customer_message_at
);

-- Paso (c): conversaciones con lcma no nulo (tras (b)) que tienen salientes
-- failed/131047 posteriores a esa fecha, y se atrasan a
-- least(lcma, min(created_at de esos) - 24h)
select count(*)
from public.conversations c
where c.last_customer_message_at is not null
  and exists (
    select 1
    from public.messages m
    where m.conversation_id = c.id
      and m.direction = 'outbound'
      and m.whatsapp_status = 'failed'
      and m.whatsapp_error_code = 131047
      and m.created_at > c.last_customer_message_at
  );
```

`unread_count` NO se recalcula en el backfill (deuda declarada: no hay forma
fiable de saber cuántos de los no leídos actuales vinieron de un
`unsupported` sin reconstruir el historial de lecturas).

**Verificación después de aplicarla:**

```sql
select last_customer_message_at
from public.conversations
where id = 'aa75ef33-38e8-4ff4-8422-7e7f49615795';
-- 2026-08-31 16:50:35+00
```

**`20260908010000_traspaso_sin_contenido_legible`** (corrida "La IA ve lo
que llega", 8/9/2026): corrige el caso de la conversación `cea69118…`, un
audio del cliente sin texto previo que dejaba el turno salir por historial
vacío SIN escribir traspaso (violaba "ningún lead invisible") y que el
reconciliador reencoló 30 veces hasta que un asesor contestó a mano. Amplía
el CHECK de `conversation_handoffs.reason` con `sin_contenido_legible` (los
24 valores vigentes desde 20260905030000, más este). Sin función `security
definer` nueva, sin revokes ni grants. Trae un backfill único (no en pasos,
a diferencia de `20260907010000`): limpia `journey_stage`/`active_tool` a
`null` en las conversaciones que el bug de `journey_stage='classifying'`
dejó congeladas, sin lock vigente. Para medir cuántas filas va a tocar
antes de aplicarla:

```sql
select count(*) from conversations
where journey_stage in ('classifying','tool_running')
  and (ai_turn_lock_until is null or ai_turn_lock_until < now());
-- 17 el 7/9/2026
```

**Verificación después de aplicarla:**

```sql
select count(*) from conversations
where journey_stage in ('classifying','tool_running')
  and (ai_turn_lock_until is null or ai_turn_lock_until < now());
-- 0
```

El CHECK admite `sin_contenido_legible` como valor válido de
`conversation_handoffs.reason`; el código de esta misma corrida
(`src/lib/ai/agent.ts`) lo usa cuando el turno queda sin nada legible que
contestar tras describir la media con `historyLine`.

**`20260916010000_devolucion_a_la_ia`** (revisión del plan "La IA no vuelve
a pedir lo que ya pidió", 16/9/2026). Caso reportado: un cliente pide un
asesor, la IA escala y se despide ("te paso con un asesor"); un asesor
desasigna la conversación y reactiva la IA a mano; en menos de un minuto el
reconciliador la reencolaba y la IA repetía la misma promesa sobre el MISMO
mensaje viejo — el mecanismo que el 13/9 volvió a escalar 63 casos.

**Regla dura, sin excepción: esta migración va ANTES del código, nunca
junto ni después.** El código nuevo de `src/lib/ai/agent.ts`,
`src/lib/ai/reconciler.ts` y `src/lib/data.ts` (`unansweredFreeWork`) lee
`ai_resume_cutoff_at`/`new_since_ai_resume` en su `select`/`.eq()`. Sin las
columnas: el `select` de `runAgentTurn` falla y se caen TODOS los turnos de
IA (no solo los que pasarían por la guarda nueva), `reconcileOrphanTurns`
devuelve vacío EN SILENCIO para quien lo llama (PostgREST responde con un
error 42703 por la columna desconocida, el reconciliador lo registra como
`reconciliador_consulta_fallida` y devuelve el resultado vacío en vez de
lanzar — `reconcileOrphanTurns` en `reconciler.ts`) y el botón "encender la
IA" de la bandeja LANZA (`fetchBacklogConversationIds`, `data.ts`).
Desplegar el código antes que la migración deja la cola de IA muda: el
único rastro es ese evento en el log y las filas que dejan de aparecer en
`agent_turns`.

**`lock_timeout` corto, y qué hacer si falla.** La migración fija `set
local lock_timeout = '5s'` antes de crear `new_since_ai_resume`: agregar
una columna GENERADA reescribe `conversations` entera con un lock `ACCESS
EXCLUSIVE` (a diferencia de una columna común con default, que desde PG11
es solo metadato) — `conversations` es la tabla del camino caliente de
cada mensaje de WhatsApp, así que es mejor que la migración falle y se
reintente a que un `ACCESS EXCLUSIVE` prolongado encole detrás suyo a los
webhooks entrantes. **Si `db push` falla por bloqueo, reintentar en un
momento de menos tráfico — no quitar el `lock_timeout` ni subirlo "para
que pase".** Aplicada a mano, tiene que ir con `psql -1 -v
ON_ERROR_STOP=1` (ver "En Dokploy" → "Aplicarla a mano", §7) — sin `-1` el
`set local` de esta sección no aplica a nada.

Sin backfill: `ai_resume_cutoff_at` nace `null` en todas las conversaciones
existentes —ninguna "acaba de ser devuelta" al momento de desplegar esta
migración—, así que no hay nada que medir antes de aplicarla como sí hacía
falta con `20260907010000`/`20260908010000`.

**Verificación después de aplicarla** (solo lectura):

```sql
-- Las dos columnas, y que la segunda sea GENERADA
select column_name, is_generated
from information_schema.columns
where table_schema = 'public' and table_name = 'conversations'
  and column_name in ('ai_resume_cutoff_at', 'new_since_ai_resume');
-- new_since_ai_resume debe dar is_generated = 'ALWAYS'

-- Los dos triggers
select tgname from pg_trigger
where tgrelid = 'public.conversations'::regclass
  and tgname in (
    'conversations_ai_resume_before_trigger',
    'conversations_ownership_change_handoff_trigger'
  )
  and not tgisinternal;
-- deben salir las dos filas

-- El CHECK de conversation_handoffs.reason trae los dos valores nuevos
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.conversation_handoffs'::regclass
  and conname = 'conversation_handoffs_reason_check';
-- debe contener 'desasignada_por_asesor' y 'mensaje_previo_a_devolucion'

-- anon no puede ejecutar ninguna de las dos funciones de esta migración
-- (la consulta única de la sección "Permisos de las funciones security
-- definer", más abajo, ya las incluye — esta es la específica de esta
-- migración, mismo criterio que usan awaiting_reply.sql/ventana_24h.sql)
select
  has_function_privilege('anon', 'public.handle_conversation_ai_resume()', 'execute') as ai_resume,
  has_function_privilege('anon', 'public.handle_conversation_ownership_change()', 'execute') as ownership_change;
-- las dos en false

select count(*) from supabase_migrations.schema_migrations;  -- 71
```

**Consulta de la Verificación · 5 del plan** (solo lectura, para decidir con
el operador si el número no da ~0): cuenta conversaciones con la IA
encendida, sin asesor, esperando respuesta y con una escalada posterior a
su último mensaje del cliente — casos devueltos ANTES de esta migración que
no van a tener sello (el reconciliador ya los habrá vuelto a escalar, así
que se espera un número mínimo):

```sql
select count(*) from public.conversations c
where c.ai_enabled
  and c.assigned_agent_id is null
  and c.awaiting_reply
  and c.last_customer_message_at is not null
  and exists (
    select 1 from public.conversation_handoffs h
    where h.conversation_id = c.id
      and h.reason in ('escalada', 'escalada_sin_asesor')
      and h.created_at > c.last_customer_message_at
  );
```

Test: `tests/devolucion_a_la_ia.sql` (doce casos, transacción con rollback),
cableado al job `migraciones` del CI.

**`20260917010000_seba_y_escalada_viva`** (T0 del plan "Seba atiende el
mostrador", `docs/planes/2026-09-17-seba-atiende-el-mostrador.md`,
18/9/2026). Va DESPUÉS de `20260916010000` (reusa `new_since_ai_resume` en
`handle_conversation_ownership_change`) y ANTES del código de la misma
corrida, con la misma regla dura de siempre: aplicada a mano con `psql -1
-v ON_ERROR_STOP=1` (§7 → "En Dokploy" → "Aplicarla a mano"), en su propio
paso, después de `20260916010000` y antes de `20260915010000` si esa
tampoco estuviera aplicada todavía. Trae:

- Backfill de `welcome_sent_at` (deja de ser "última vez que se mandó la
  plantilla de bienvenida" — nunca se usó, `WHATSAPP_WELCOME_TEMPLATE` está
  vacía desde siempre — y pasa a ser el sello de "Seba ya se presentó").
- `conversation_handoffs.reason` suma `silenciada_por_asesor`.
- `handle_conversation_ownership_change()` (`create or replace`, ACL
  intacto): la rama `reclamado` gana `auth.uid() is not null`, y una rama
  nueva escribe `silenciada_por_asesor` cuando `ai_enabled` se apaga SIN que
  `assigned_agent_id` cambie en el mismo UPDATE (la escalada de hoy sigue
  cambiando las dos juntas hasta que una tarea futura de la misma corrida la
  reforme).
- `handle_agent_message_silences_ai()` nueva + trigger `AFTER INSERT ON
  messages` (`messages_agent_silences_ai_trigger`): apaga la IA en cuanto un
  asesor manda su primer mensaje real al cliente.

**El código de esta misma corrida que todavía no existe al escribir esta
migración depende de dos cosas de acá:** la columna `welcome_sent_at` con
la semántica nueva (el turno la usará para decidir si Seba saluda) y la
razón `silenciada_por_asesor` en el CHECK (el código no la escribe — la
escribe el trigger solo —, pero si el CHECK no la admitiera el INSERT del
trigger fallaría en silencio, como cualquier `conversation_handoffs`
roto). No hay guarda de "el `select` falla sin la columna" como en
`20260916010000`: `welcome_sent_at` ya existía desde `20260819030000`, así
que desplegar el código de esta corrida antes que la migración no rompe
ningún `select` — solo deja el saludo de Seba mudo hasta que la migración
entre (la columna sigue existiendo con la semántica vieja, y el código
nuevo la lee igual, solo que con datos que el backfill todavía no corrigió).

**Verificación después de aplicarla** (solo lectura):

```sql
-- El CHECK trae el valor nuevo
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.conversation_handoffs'::regclass
  and conname = 'conversation_handoffs_reason_check';
-- debe contener 'silenciada_por_asesor'

-- El trigger de silencio existe
select tgname from pg_trigger
where tgrelid = 'public.messages'::regclass
  and tgname = 'messages_agent_silences_ai_trigger'
  and not tgisinternal;
-- debe salir la fila

-- anon y authenticated no pueden ejecutar la función nueva
select
  has_function_privilege('anon', 'public.handle_agent_message_silences_ai()', 'execute') as anon,
  has_function_privilege('authenticated', 'public.handle_agent_message_silences_ai()', 'execute') as authenticated;
-- las dos en false

select count(*) from supabase_migrations.schema_migrations;  -- 72 (73 con la de ai_lessons, abajo)
```

**`20260917020000_ai_lessons`** (T1 del mismo plan, 18/9/2026). Va DESPUÉS
de `20260917010000`, también con `psql -1 -v ON_ERROR_STOP=1` y ANTES del
código de la corrida (la interfaz y el turno de la IA la leen; sin la tabla
el `select` de lecciones falla y el turno sigue con lecciones vacías, pero
el menú "Enseñar a Seba…" no puede guardar nada). Crea la tabla
`public.ai_lessons` con RLS (cualquier agente lee; inserta solo con
`created_by = auth.uid()`; edita y borra el autor o un supervisor), sus
CHECK, índices parciales, `set_updated_at` y la publica en
`supabase_realtime` con autoverificación (`raise exception` si no quedó
publicada). No trae funciones `security definer` nuevas.

**Verificación después de aplicarla** (solo lectura):

```sql
select count(*) from pg_policies where tablename = 'ai_lessons';  -- 4
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'ai_lessons';  -- una fila
select count(*) from supabase_migrations.schema_migrations;  -- 73
```

Test: `tests/seba_y_escalada_viva.sql` (ocho casos, transacción con
rollback), cableado al job `migraciones` del CI. Aplicar esta migración
también rompía (antes de corregirlo) dos supuestos de
`tests/devolucion_a_la_ia.sql`: su caso 1 ("escalada simulada no deja
fila") y sus casos 13/14/15 de `reclamado` — ver el comentario al final de
la cabecera de ese archivo, corregido en la misma tanda.

**`20260918010000_catalog_links`** (M1 del plan "Nada sin leer, un solo
catálogo y la factura Saint", 18/9/2026). Va DESPUÉS de las dos migraciones
de Seba (`20260917010000`/`20260917020000`) y ANTES del código de esta
misma corrida: el turno (T3, `agent.ts`/`send.ts`/`playbooks.ts`) y el
shell de la bandeja (T4b) leen `catalog_links` con `fetchActiveCatalogLinks`
— a diferencia de `20260916010000`, acá NO hay guarda dura de "el `select`
falla sin la tabla": esa función NUNCA lanza (T7 la reforzó con un
`try/catch` propio para que tampoco lo haga ante una excepción de red, no
solo ante un `error` devuelto) y cae a `[]` si la tabla todavía no existe,
así que desplegar el código antes que la migración no tumba nada — solo
deja sin resolver cualquier marcador `{{catalogo:...}}` hasta que la
migración entre. Aplicar de todos modos con `psql -1 -v ON_ERROR_STOP=1`,
mismo criterio de higiene que las anteriores. Trae: tabla
`public.catalog_links` (`key`/`label`/`url`/`sort_order`/`is_active`/
`updated_by`), RLS (`is_agent()` lee, `is_supervisor_or_admin()` escribe),
índice parcial `(sort_order) where is_active`, trigger de `updated_at`,
publicada en `supabase_realtime` con autoverificación (`raise exception` si
no quedó publicada). Sin funciones `security definer`: la RLS de la tabla
alcanza, no hacen falta revokes.

Verificación después de aplicarla (solo lectura):

```sql
select count(*) from pg_policies where tablename = 'catalog_links';  -- 2
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'catalog_links';  -- una fila
select count(*) from supabase_migrations.schema_migrations;  -- 74
```

Test: `tests/catalog_links.sql` (nueve casos, transacción con rollback),
cableado al job `migraciones` del CI.

**`20260918020000_factura_saint`** (M2 del mismo plan). Va DESPUÉS de
`20260918010000` (mismo `ci.yml`, tablas distintas, coordinado en el mismo
commit) y ANTES del código: el modal "Cerrar venta" (T5) y
`closeSaleWithContactInfo` (`mutations.ts`) escriben
`orders.saint_invoice_number` en cada venta nueva — sin la columna, el
`insert` de `orders` falla y ninguna venta se puede cerrar mientras el
código nuevo esté arriba. Trae: `orders.saint_invoice_number text`
(nullable — las ventas cerradas antes del 18/9/2026 no lo tienen) con
`orders_saint_invoice_number_check` (recortado, 1-40 caracteres cuando no
es `null`), sin restricción de unicidad a propósito. Sin funciones
`security definer`, sin RLS nueva (`orders_all` ya alcanza).
`database.types.ts` gana la columna en `Row`/`Insert`/`Update` de `orders`.

Verificación después de aplicarla (solo lectura):

```sql
select column_name, is_nullable from information_schema.columns
where table_schema = 'public' and table_name = 'orders'
  and column_name = 'saint_invoice_number';
-- is_nullable = 'YES'

select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.orders'::regclass
  and conname = 'orders_saint_invoice_number_check';

select count(*) from supabase_migrations.schema_migrations;  -- 75
```

Test: `tests/factura_saint.sql` (cinco casos, transacción con rollback),
cableado al job `migraciones` del CI justo después de `catalog_links.sql`.

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
- `20260910010000_resumen_del_dia_del_asesor.sql` — nace `agent_day_summary`
  (resumen del día del asesor que llama, con los dos revokes y el grant a
  `authenticated`) y `agent_metrics` pasa a atribuir las ventas a quien
  cerró (`deal_closed_by`). No crea columnas: `assigned_at` existe desde
  20260822080000.

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
- **`authenticated` en `true`** para `agent_metrics`, `agent_day_summary`, `agent_can_run` y
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

El doble check azul y "escribiendo…" (T3.1, 4/9/2026) usan el mismo
`WHATSAPP_ACCESS_TOKEN` y el mismo `phone_number_id` que un envío normal —no
hace falta ninguna variable nueva— y **no consumen cupo de conversación**:
Meta no las factura como los mensajes de plantilla/texto.

---

## 5. Webhook

Registra en Meta: `https://<tu-dominio>/api/webhooks/whatsapp`, con el
`verify_token` que pusiste en la variable.

Necesita **HTTPS y dominio público**. No funciona con `localhost`; en
desarrollo se usa un túnel (`cloudflared tunnel --url http://localhost:3000`).

**Verificación:** el handshake de Meta debe dar verde al registrar. Después,
manda un mensaje real al número y comprueba que aparece en la bandeja.

**Salud del número y estado de plantillas (T3.4, paso manual del operador):**
en el panel de Meta for Developers, dentro de la app → WhatsApp →
Configuration → Webhook fields, suscribir además de `messages` estos tres
campos: `message_template_status_update`, `phone_number_quality_update` y
`account_update`. Sin suscribirlos, el CRM sigue funcionando igual —son
puramente informativos— pero la tarjeta "Salud del número" de Control de IA
(`/agent-control`) se queda en "sin datos" para siempre, y una plantilla
pausada o un número en riesgo de perder límite de mensajería no se van a
notar hasta que un cliente reclame.

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
- **cron** — procesa cada minuto lo que quede pendiente en la cola de turnos
  (cada 5 minutos hasta el 7/9/2026: ver "Rampa de los topes" más abajo).

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

**Dokploy NO aplica migraciones.** El `compose.deploy` solo reconstruye y
levanta la imagen de `app`; no hay ningún paso de `supabase db push` ni
equivalente en el pipeline de Dokploy. Si el commit que se despliega trae una
migración nueva (título con `[migración]`), el orden es:

1. Respaldo (`scripts/backup.sh`, ver §8).
2. Aplicarla a mano contra el contenedor `supabase-db`, con `psql -1 -v
   ON_ERROR_STOP=1` (desde el 16/9/2026, migración `20260916010000`: sin
   `-1` cada sentencia corre en su propia transacción implícita y un `set
   local lock_timeout` queda en un NO-OP silencioso; sin `ON_ERROR_STOP=1`,
   si una sentencia de en medio falla psql sigue con las siguientes y sale
   con código 0, dejando el esquema a medias. Con `-1`: o entra la
   migración ENTERA, o no entra nada):
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres \
     -1 -v ON_ERROR_STOP=1 \
     < supabase/migrations/<archivo>.sql
   ```
3. Registrarla en `supabase_migrations.schema_migrations` (la migración no se
   registra sola) para que `supabase db push` no intente reaplicarla
   más adelante:
   ```sql
   insert into supabase_migrations.schema_migrations (version, name)
   values ('<timestamp>', '<nombre_del_archivo_sin_extension>');
   ```
4. Solo entonces `compose.deploy` (o el redeploy desde el panel de Dokploy)
   para que el código que asume la migración ya aplicada no corra contra un
   esquema viejo.

**Cuando el deploy lleva migración Y una variable de entorno nueva**
(caso de la corrida "La IA ve lo que llega", 8/9/2026, migración
`20260908010000` + `AI_AGENT_REASONING`): la variable va ANTES que el
código, porque el push a `main` dispara el deploy solo (webhook de
Dokploy) y el código llegaría antes que la base y que la variable si no se
ordena así. Orden completo:

1. Respaldo (`scripts/backup.sh`, ver §8).
2. La variable nueva (`AI_AGENT_REASONING=off` en el caso de esa corrida)
   en la pestaña **Environment** de Dokploy, **sin desplegar todavía**.
3. Migración a mano contra `supabase-db` (pasos 2-3 de arriba) y su
   registro en `supabase_migrations.schema_migrations`.
4. Push a `main` (el webhook de Dokploy despliega solo).
5. Verificar en los logs del contenedor nuevo que NO aparece el warning
   `reasoningEffort is not supported` (confirma que la variable llegó antes
   que el código que la lee) y que `reconciliador_encolo_huerfanas`
   aparece con `encoladas` alto UNA sola vez en los primeros minutos —las
   conversaciones mudas que la corrida libera de golpe: esperado, no un
   bug.

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

Define `CRON_SECRET` (una cadena larga y aleatoria) y llama cada minuto:

```cron
* * * * * curl -fsS -X POST https://<tu-dominio>/api/cron/process-queue -H "Authorization: Bearer $CRON_SECRET" > /dev/null
```

Cada 5 minutos hasta el 7/9/2026: con los topes de turnos calibrados a ~4/min
esa lentitud se creía el freno de emergencia, pero no lo era — ver "Rampa de
los topes" más abajo. Desde T3 de esta corrida la cola se despierta sola a
los 3-30 s cuando una pasada difiere un turno por ritmo (20 s), por cupo (3 s)
o por lock tomado (30 s) — el reintento de un turno que FALLÓ (30 s) queda
afuera a propósito: reintentar un error en caliente tiende a pegarle al mismo
muro, y ese caso lo sigue cubriendo el cron. El cron también sigue siendo la
única red para lo que la continuación no puede ver: el proceso que murió
antes de reencolarse, el turno que Redis perdió del todo, y un atraso más
grande que lo que una sola pasada intenta de una vez (`AGENT_QUEUE_MAX_PER_RUN`,
30 por defecto) cuando esa pasada logra procesar su cupo entero sin que nada
se rechace — ahí no queda ningún turno "frenado" que la continuación pueda
registrar, así que no se programa nada y el resto de la cola espera al cron o
al próximo mensaje entrante. El freno de emergencia real sigue siendo
`agent_can_run()` (interruptor global + tope de gasto diario), consultado en
CADA turno.

Sin `CRON_SECRET` el endpoint responde 503 y no procesa nada: dispara turnos
de IA, o sea gasto, así que falla cerrado siempre.

Para ver qué quedó atascado:

```sql
select conversation_id, status, attempts, last_error from public.agent_turn_queue;
```

Una fila en `failed` con 3 intentos ya no se reintenta sola: revisa
`last_error` y, si corresponde, vuelve a encolarla con
`select public.enqueue_agent_turn('<conversation_id>')`.

### Rampa de los topes

Medido en producción el 7/9/2026 (88 turnos): el turno completo tarda 7,2 s
de mediana. Lo que espera el cliente no es el modelo, es la cola —11,2 min de
mediana, p90 32 min, hasta 90 min— porque tres frenos estaban calibrados a
~4 turnos/min contra una demanda real de 2,54 conversaciones/min de media
(picos de 6): `AGENT_MAX_TURNS_PER_MINUTE=4`, `AI_MAX_REQUESTS_PER_MINUTE=15`
sin subir junto con él (15 peticiones/min son 4,4 turnos/min, no 15, porque un
turno gasta ≈3,4 peticiones) y el cron cada 5 minutos con tope 10 por pasada
(2 turnos/min de red de seguridad). El techo de 20/min que justificaba el 15
no existe: era de la cuenta gratuita de OpenRouter.

El operador sube las cinco variables a mano en la pestaña Environment de
Dokploy, un escalón a la vez, verificando las señales de abajo entre uno y
el siguiente:

| Variable | Escalón 1 | Escalón 2 |
|---|---|---|
| `AGENT_MAX_TURNS_PER_MINUTE` | 10 | 30 |
| `AI_MAX_REQUESTS_PER_MINUTE` | 40 | 120 |
| `AI_MAX_CONCURRENT_REQUESTS` | 6 | 12 |
| `AGENT_MAX_CONCURRENT_TURNS` | 4 | 8 |
| `AGENT_QUEUE_MAX_PER_RUN` | 30 | 30 |

Señales a vigilar en cada escalón, antes de subir al siguiente:

- `cola_ritmo_al_tope` baja de frecuencia (si no baja, el tope de turnos
  sigue por debajo de la demanda real).
- `ia_ritmo_al_tope` NUNCA aparece (si aparece, `AI_MAX_REQUESTS_PER_MINUTE`/
  `AI_MAX_CONCURRENT_REQUESTS` quedaron por debajo de lo que
  `AGENT_MAX_TURNS_PER_MINUTE` ahora permite pedir).
- Cero respuestas 429 del proveedor en los logs.
- `redis-cli zcard liminal:agent:turns` tiende a 0 entre ráfagas (la cola no
  se queda con un remanente permanente).

Vuelta atrás en cualquier momento: bajar `AGENT_MAX_TURNS_PER_MINUTE` en
Dokploy. Se lee en cada pasada de la cola, así que no hace falta tocar código
ni base — pero el Environment de Dokploy solo llega al contenedor con un
redeploy (~20 s de corte, sin rebuild de imagen si no cambió el código). El
freno de emergencia real —`agent_can_run()`, interruptor global + tope de
gasto diario, consultado en CADA turno— no depende de ninguno de estos
números.

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
  `cola_turno_fallido`, `webhook_sin_secreto_en_produccion`,
  `webhook_firma_invalida`, `identidad_reescrita` (una reescritura de la
  guarda de identidad funcionó: vale la pena contarlas) e
  `identidad_bloqueada` (un turno terminó escalado por esta guarda).
- **Un solo token de WhatsApp** para todos los canales. Con más de un número
  hay que extender `whatsapp_channels`.
- **La PII no está cifrada en reposo.** Cédula, dirección y teléfono se
  guardan en claro. Están protegidos por RLS y por la sesión, pero quien
  tenga acceso a la base los ve.

---

## 10. Lista operativa de v1.1 (14/9/2026, actualizada el 15/9)

Lo que el código de la corrida "La voz cercana y la espera visible" NO
reemplaza: son tareas del operador desde el panel (`/agent-control`, la
bandeja y Dokploy). Nacen de la auditoría "72 horas en el buzón" (727
conversaciones, 11/9 → 14/9) y del reporte directo del cliente. Sin
O1–O6 hechas no se etiqueta `v1.1`.

| # | Qué | Por qué | Cómo se verifica |
|---|---|---|---|
| O1 | Contactar a los 80 leads sin respuesta (CSV de la auditoría), empezando por los 11 del viernes y los 29 del domingo. | 3 ventas perdidas y 47 en riesgo ya contadas. | Píldora "Pendientes" baja; los 80 tienen respuesta de asesor. |
| O2 | **Encender "Consulta de productos"** en Control IA tras confirmar que el inventario del 11/9 está al día. | 99 de 151 preguntas sin respuesta propia son precio/existencia; es la causa principal del tono "te paso con un asesor". Desde el 25/8 nunca estuvo encendida. | Un turno de consulta muestra `buscarRepuesto` en `agent_turns`; la tasa de escaladas por `intencion_compra` baja de 438/480. |
| O3 | **Ya no hace falta reemplazar los escenarios de saludo**: desde el 15/9 la IA los ignora (fase 0 descarta todo escenario cuyo texto empiece con hola/buenas/bienvenid…) y saluda sola, por franja, una vez por conversación. Opcional: apagar los tres escenarios de saludo (quitan ruido del log). **Obligatorio:** a cualquier escenario que deba seguir saliendo y cuyo texto empiece saludando, quitarle el saludo del inicio (si no, la IA lo ignora); unificar a "tú" los escenarios con "usted"; estrechar el disparador de la despedida ("Gracias por preferirnos") a *cuando el cliente se despide y no queda nada pendiente*. Antes del push: `select name, left(response_text, 40) from ai_playbooks where is_active` para ver cuáles empiezan saludando. | Decisiones 1, 2 y 4 del plan del 14/9 y 5 del 15/9. El cliente configuró escenarios de saludo y "la IA no funcionaba": el texto y la franja escritos a mano fallaban por hora. | `agent_turns.playbook_id` nunca apunta a un escenario cuyo `response_text` empiece saludando; el log `escenarios_saludo_ignorados` nombra solo escenarios de saludo. |
| O4 | Confirmar el horario del domingo (¿9:30–16:00 o 9:00–16:30?) y corregir `business_hours` en el panel. | La IA dice el horario tal cual está cargado, y desde T7 lo responde ella misma sin escalar. | `turnClockLine` en un turno de domingo. |
| O5 | Cargar la biblioteca con las respuestas validadas de la sección 2 de la auditoría: horario, taller y precios de referencia, métodos de pago aceptados/rechazados (Binance sí, Zelle no), compatibilidades frecuentes, guía MRW y tiempos, Cashea (error de envío gratis), garantía y cambios, RCV. Revisar los enlaces de Drive del catálogo (fallaron 12/9 y 13/9). | 52 preguntas de política sin respuesta propia; hoy la biblioteca tiene 6 entradas. | `consultarBiblioteca` devuelve resultados en esos turnos. |
| O6 | Roster: marcar "Fuera del reparto" a quien no está de turno (fin del día, domingo). No devolver conversaciones a la IA en masa mientras tengan escalada abierta: reasignar. | `claim-agent.ts` reparte por esa bandera; la devolución masiva del 13/9 re-escaló 63 casos y quitó el asesor a 11 leads del viernes. Desde T4 un "gracias" con escalada abierta ya no recibe despedida, pero el lead sigue sin dueño. | Escaladas fuera de horario caen en "Sin dueño" (visibles) en vez de en un asesor ausente. |
| O7 | Rampa de ritmo: pasar `AGENT_MAX_TURNS_PER_MINUTE` 30→40 y `AI_MAX_REQUESTS_PER_MINUTE` 120→160 juntas en Dokploy (las cinco variables suben juntas, ver "Rampa de los topes"; redeploy). | 138 topes de 30/min en 72 h. | `ia_ritmo_al_tope` desaparece en hora pico; `cola_ritmo_al_tope` baja. |
| O8 | Pedir al Claude del VPS revisar los cortes de conexión con la base: `docker logs` del contenedor de la app y de PostgREST/pooler alrededor de los 13 `turno_interruptor_no_consultable` y los 41 `webhook_error_actualizar_estado`; límites de conexiones del pooler; reinicios de contenedores. | Hallazgo 10 de la auditoría. Con T5 el síntoma deja de disfrazarse de "IA apagada", pero la causa es del VPS. | Cero `turno_interruptor_no_consultable` en 48 h. |

### Despliegue de v1.1 (15/9/2026, antes del push y en este orden)

Dokploy despliega con el push, con demora variable y sin esperar al CI, así
que todo lo que necesita la base va ANTES de pushear.

1. Confirmar que producción sigue en `38a540e` (`git log --oneline
   38a540e..HEAD` da los commits del 14/9 y del 15/9).
2. Respaldo (`scripts/backup.sh`, §8).
3. Aplicar y registrar en `supabase_migrations.schema_migrations`, en este
   orden: `20260914010000_intenciones_y_traspasos_completos.sql` y
   `20260915010000_marca_sbk_motors.sql`. Verificar por efecto, no por
   registro: `pg_get_constraintdef` de `agent_turns_intent_check`,
   `conversations_intent_check` y `conversation_handoffs_reason_check`
   contiene `fuera_de_tema`/`cortesia_tras_escalada`; `select description
   from knowledge_categories where name = 'La tienda'` dice SBK Motors;
   `select count(*) from supabase_migrations.schema_migrations` → 70. Los
   dos tests SQL (`tests/intenciones_y_traspasos_completos.sql`,
   `tests/marca_sbk_motors.sql`) revierten su transacción y pueden
   correrse contra producción.
4. `select name, left(response_text, 40) from ai_playbooks where is_active`
   y avisar al operador cuáles empiezan saludando: la IA los va a ignorar
   (O3).
5. O7 en Dokploy → Environment (`AGENT_MAX_TURNS_PER_MINUTE=40`,
   `AI_MAX_REQUESTS_PER_MINUTE=160`), sin desplegar: el push redespliega y
   las carga.
6. `git push origin main`. Mirar el CI (API de Actions: `head_sha`,
   `conclusion`) y `docker logs` del contenedor nuevo: el primer turno
   nuevo deja `escenarios_saludo_ignorados` si quedan escenarios de saludo;
   no deben aparecer `turno_bitacora_no_escrita` ni
   `turno_intencion_no_guardada` (si aparecen, la migración del 14/9 no
   está aplicada).


### Verificación en producción a 48 h y etiqueta v1.1

A las 48 h del despliegue, repetir sobre la base de producción (solo
lectura) las cifras de la auditoría y compararlas:

| Métrica | Antes (72 h al 14/9) | Meta |
|---|---|---|
| **Saludo con la franja correcta y una sola vez por conversación** (invierte la métrica del 14/9, que pedía cero saludos por franja): primer mensaje de la IA por conversación creada en la ventana que NO abre con el saludo de su franja (hora Caracas de `created_at`); y mensajes de la IA posteriores al primero que abren con `buen*`/`hola` | 3 con franja mal; saludos a mitad de conversación | 0 y 0 (excluir turnos con `playbook_id`, que no saludan por diseño) |
| Mensajes de la IA con "SBK Motorcycles" | todos los saludos | 0 |
| `identidad_bloqueada` con fragmento "agente" | no medido | 0 |
| Despedidas de la IA con escalada abierta | no medidas | 0; `cortesia_tras_escalada` > 0 solo si hubo el caso |
| Objetos de audio nuevos en `whatsapp-media` terminados en `.bin` | 100 % | 0 |
| Promesas "un asesor te atiende" que apagaron `awaiting_reply` | 170 ≥ 30 min invisibles | 0 (todas `is_auto_reply`) |
| Repeticiones de "¿qué repuesto buscas?" ante adjuntos sin texto | hasta 10 por chat | ≤ 1 por racha |
| `agent_turns` con `intent = 'fuera_de_tema'` | 0 (rechazados) | = a los turnos fuera de tema del log |
| Escaladas por `intencion_compra` (con catálogo encendido, O2) | 438 / 480 | < 250 |
| Lectura de tono: 20 respuestas de la IA elegidas al azar | "tajante" | ≥ 16 con reconocimiento + explicación (rúbrica de "CÓMO SUENAS") |

Consultas de apoyo (solo lectura):

```sql
-- 15/9/2026: primer mensaje de la IA por conversación creada en 48 h,
-- ¿abre con el saludo de su franja? (meta: saludo_mal = 0)
with primeras as (
  select distinct on (m.conversation_id) m.conversation_id, m.content,
         (m.created_at at time zone 'America/Caracas') as hora_local
  from messages m join conversations c on c.id = m.conversation_id
  where m.sender_type = 'ai' and c.created_at > now() - interval '48 hours'
  order by m.conversation_id, m.created_at
)
select count(*) filter (where content !~* ('^\s*[¡!]?\s*' || case
  when extract(hour from hora_local) < 12 then 'buenos d[ií]as'
  when extract(hour from hora_local)*60 + extract(minute from hora_local) <= 19*60 then 'buenas tardes'
  else 'buenas noches' end)) as saludo_mal, count(*) as total
from primeras;
-- saludos repetidos: mensajes de la IA que no son el primero y abren saludando (meta: 0)
select count(*) from messages m
 where m.sender_type = 'ai' and m.created_at > now() - interval '48 hours'
   and m.content ~* '^\s*[¡!]?\s*(hola|buen[oa]s)'
   and exists (select 1 from messages p where p.conversation_id = m.conversation_id
               and p.sender_type = 'ai' and p.created_at < m.created_at);
-- el nombre viejo (meta: 0)
select count(*) from messages where sender_type = 'ai'
   and created_at > now() - interval '48 hours' and content ilike '%SBK Motorcycles%';
-- saludos por franja que todavía salen (meta: 0)
select count(*) from messages
 where sender_type = 'ai' and created_at > now() - interval '48 hours'
   and content ~* '^\s*[¡!]?\s*buen[ao]s? (d[ií]as|tardes|noches)';
-- textos de la IA en el turno que escaló que NO quedaron como auto_reply (meta: 0)
select count(*) from messages m
  join agent_turns t on t.conversation_id = m.conversation_id
 where m.sender_type = 'ai' and m.is_auto_reply = false
   and t.action = 'escalated'
   and m.created_at between t.created_at and t.created_at + interval '2 minutes'
   and m.created_at > now() - interval '48 hours';
-- fuera de tema registrados (meta: igual a los del log)
select count(*) from agent_turns where intent = 'fuera_de_tema'
   and created_at > now() - interval '48 hours';
-- cortesías calladas con escalada abierta y escaladas
select reason, count(*) from conversation_handoffs
 where created_at > now() - interval '48 hours'
   and reason in ('cortesia_tras_escalada', 'escalada', 'escalada_sin_asesor')
 group by reason;
```

Con eso en verde y O1–O6 hechas: `git tag -a v1.1 -m "SBK CRM v1.1
estable: la voz de mostrador con nombre propio"` sobre el commit desplegado, y
push del tag.

---

## 11. Entrega de "Seba atiende el mostrador" + "Nada sin leer, un solo catálogo y la factura Saint" (19/9/2026)

Producción se midió por última vez en `3802fad` el 18/9/2026 (base en
`20260915010000`, árbol y base coincidían). Todo lo commiteado después —las
tres migraciones de "La IA no vuelve a pedir lo que ya pidió"/Seba
(`20260916010000`, `20260917010000`, `20260917020000`), la corrida completa
de "Seba atiende el mostrador" y esta corrida ("Nada sin leer, un solo
catálogo y la factura Saint", migraciones `20260918010000`/`20260918020000`)
— sigue pendiente de entrega. **Antes de calcular qué falta por entregar,
confirmar en qué commit está producción de verdad** (`produccion..HEAD`,
nunca el HEAD local): puede haber cambiado desde el 18/9 si otra sesión ya
entregó parte de esto.

**Orden de entrega, sin excepción — migración antes que el código en cada
paso:**

1. Respaldo (`scripts/backup.sh`, §8).
2. `20260916010000_devolucion_a_la_ia.sql` con `psql -1 -v
   ON_ERROR_STOP=1` si todavía no está aplicada (ver su entrega detallada
   arriba, en la sección 2 — regla dura, columna GENERADA, `lock_timeout`
   corto).
3. Las dos migraciones de Seba, en orden, cada una con `psql -1 -v
   ON_ERROR_STOP=1`: `20260917010000_seba_y_escalada_viva.sql`, después
   `20260917020000_ai_lessons.sql`.
4. Las dos migraciones de esta corrida, en orden, mismo criterio:
   `20260918010000_catalog_links.sql`, después
   `20260918020000_factura_saint.sql`.
5. Registrar las cinco en `supabase_migrations.schema_migrations` (no se
   registran solas) — verificar con `select count(*) from
   supabase_migrations.schema_migrations` → 75.
6. Recién entonces el código: push a `main` (Dokploy despliega solo con el
   webhook, sin esperar al CI — mirar igual el CI después, con la API de
   Actions de los Comandos de `CLAUDE.md`, y reproducir en local cualquier
   falla que no quepa en las 10 anotaciones que muestra GitHub por paso).

**Después del deploy del código (nunca antes — D8 del plan): completar y
correr `scripts/sql/2026-09-18-catalogos-iniciales.sql`.** El archivo llega
con marcadores de relleno `<<...>>` a propósito ("el contenido es del
cliente, no del repo"): el implementador no inventó ningún valor. Pasos:

1. Correr las dos consultas de ayuda que trae el propio archivo (comentario
   en su cabecera, no se ejecutan solas) contra la base de producción para
   encontrar los `id`/textos reales:
   ```sql
   select id, name, left(response_text, 80) as inicio
     from ai_playbooks
     where response_text ilike '%drive.google.com%' or name ilike '%catalog%' or name ilike '%ubicac%'
     order by name;

   select id, label, left(content, 80) as inicio
     from quick_replies
     where content ilike '%drive.google.com%'
     order by label;
   ```
2. **Preguntar al cliente antes de completar el script**: "Lubricantes"
   aparece DOS VECES en el escenario "Catálogo general", con dos archivos
   de Drive distintos — ¿son dos catálogos reales o quedó uno viejo sin
   borrar? Esto frena el SCRIPT, no el código: hasta la respuesta, cargar
   los dos como `lubricantes`/`lubricantes-2` (el script ya trae ese
   default).
3. Completar los marcadores `<<...>>` de las tres tablas de relleno con los
   valores reales (URLs de los 8 catálogos; `id` y texto YA con el
   marcador de cada uno de los 3 escenarios y los 4 mensajes rápidos que
   hoy llevan la URL pegada a mano).
4. Correr en una sola transacción:
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 \
     -f - < scripts/sql/2026-09-18-catalogos-iniciales.sql
   ```
   El propio script aborta solo si queda algún `<<...>>` sin completar, y
   falla al final si alguna de las filas tocadas todavía contiene
   `drive.google.com` — no hace falta verificar eso a mano.

**Verificación posterior** (secciones 4 y 7 del plan
`docs/planes/2026-09-18-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`):

- Un chat con mensaje de "ayer" sin leer aparece en Pendientes y en el
  número de la píldora con la bandeja en "solo hoy"; al abrirlo sigue en la
  lista; al cambiar de chat, desaparece (R1, D1/D2).
- **`EXPLAIN ANALYZE` de la consulta de Pendientes contra producción, con
  volumen real** — el de la base local (28 filas, el 18/9) no fue
  concluyente para saber si el planner hace `BitmapOr` sobre
  `conversations_unread_pill_idx` o cae a `Seq Scan`; si sale `Seq Scan`,
  el plan B (sección 5 del plan) es una segunda consulta "no leídas fuera
  de hoy" unida en memoria, patrón `searchableConversations`.
- Cargar un catálogo con una URL, escribir `{{catalogo:<key>}}` en un
  escenario y `{{catalogos}}` en otro, y `{{catalogo:<key>}}` en un mensaje
  rápido: el simulador de la IA manda la URL resuelta; "Usar" el mensaje
  rápido pega la URL resuelta; cambiar la URL en el panel cambia los tres
  sin tocar nada más; desactivar la clave hace que el escenario deje de ser
  candidato (`escenarios_enlace_sin_resolver`) y el mensaje rápido avise
  con el toast.
- Tras correr el script de carga inicial, ninguna de las 3 filas de
  `ai_playbooks` ni las 4 de `quick_replies` tocadas conserva
  `drive.google.com` (el propio script ya lo exige para no dejar nada a
  medias, pero conviene mirarlo de nuevo con la consulta del paso 1 de
  arriba, ahora vacía).
- Cerrar una venta sin factura Saint muestra el error bajo el campo y no
  llama a la mutación; con los nueve datos guarda, el evento de sistema
  nombra la factura y el detalle en Ventas la muestra (o "Sin número de
  factura Saint" en una venta anterior al 18/9).

---

## Comprobación final

Con todo configurado, esta lista debe pasar entera:

- [ ] Una restauración de prueba devuelve los datos completos
- [ ] `npm run build` sin errores ni warnings
- [ ] `select count(*) from supabase_migrations.schema_migrations` devuelve 75 (recontado el 19/9/2026 tras `20260918010000`/`20260918020000`, "Nada sin leer, un solo catálogo y la factura Saint"; decía 73 el 18/9/2026 tras `20260916010000`/`20260917010000`/`20260917020000`, 70 el 15/9/2026 y 61 cuando se escribió esta guía)
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
