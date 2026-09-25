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
| `AI_AGENT_REASONING` | `on`/`off`/`none`, default `on`. **Corregido el 22/9/2026** (antes esta fila decía que `gpt-5.6-luna` "no soporta razonamiento" — falso, medido en contra): `off` NO apaga el razonamiento de Luna — solo deja de mandar el parámetro `reasoningEffort`, y el proveedor razona igual con su propio default (58,5 % de la salida medida el 21/9/2026 con `off` puesto). `none` es el apagado REAL (`reasoningEffort: "none"` → el SDK lo traduce a `reasoning: { effort: "none" }`). `on`/ausente/basura mandan el esfuerzo de siempre (`medium`/`low`). Producción corre hoy en `off`; decidir si pasar a `none` DESPUÉS de leer `agent_turn_calls.reasoning_tokens` por fase (tabla nueva, ver §12) — no a ciegas |
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
paso, después de `20260916010000` y antes de `20260917020000` (la
siguiente de la cadena, `ai_lessons`). **Errata corregida el 19/9/2026
(T9, plan "Seba sale sin pisar a nadie"):** esta línea decía "antes de
`20260915010000` si esa tampoco estuviera aplicada todavía", que no tiene
sentido — `20260915010000` es POSTERIOR en fecha a esta migración solo en
apariencia de número de commit, pero su timestamp (15/9) es ANTERIOR al de
`20260917010000` (17/9) y ya estaba aplicada en producción desde antes
(confirmado en `3802fad`, medición del 18/9/2026); nunca podría ir
"después" de una migración más vieja que ella misma. Trae:

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
ningún `select`.

**Errata corregida el 19/9/2026 (T9, plan "Seba sale sin pisar a nadie",
hallazgo A1): esto NO "deja el saludo de Seba mudo hasta que la migración
entre" — es justo lo contrario, y es la ventana de saludo real que hay que
cuidar.** Bajo la semántica VIEJA, `welcome_sent_at` solo se llenaba al
mandar la plantilla de bienvenida de WhatsApp, y
`WHATSAPP_WELCOME_TEMPLATE` está vacía desde siempre — esa plantilla nunca
se mandó, así que `welcome_sent_at` es `null` en prácticamente TODAS las
conversaciones que existen hoy, tengan un mensaje o quinientos. Si el
código de esta corrida llega a producción ANTES que la migración (o antes
que su backfill), el turno lee esa misma columna, la encuentra en `null`
para cualquier conversación —nueva o con meses de historial— y hace que
Seba se presente a mitad de charla en cada una que reciba un turno: no hay
ningún estado "mudo" intermedio. Por eso el orden importa tanto: la
migración (con su backfill de `coalesce(last_reply_at, last_message_at,
created_at)` para todo lo que tenga `has_reply`) tiene que estar aplicada
ANTES del código, nunca al revés — y el paso 4 del orden de once pasos
(§11) agrega un backfill acotado DESPUÉS del deploy para las conversaciones
que recibieron su primera respuesta humana justo en el hueco entre la
migración y el código.

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
  Desde el plan "La tasa BCV se lee cuatro veces al día" (25/9/2026) el mismo
  bucle también pregunta cada minuto si toca releer el BCV (`/api/cron/bcv-refresh`):
  el shell no calcula horarios, la ruta decide contra `BCV_READ_HOURS`
  (00/06/12/18 hora de Venezuela, `shouldRefetchBcv` en `bcv-schedule.ts`) si
  de verdad hace falta salir a la red o si la llamada es solo una lectura de
  la base.

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

**CORRECCIÓN del 25/9/2026 (plan "La búsqueda encuentra lo que el cliente
pide"): "push a `main` NO despliega" era FALSO — desde el 21/9/2026 esta
sección lo daba por cierto (y una corrección anterior, también del
21/9/2026, ya lo había escrito así), pero el operador lo verificó contra el
VPS el 25/9/2026: el commit `34a5b65` se pusheó a las 05:40:18 UTC y
Dokploy desplegó SOLO, sin que nadie lo lanzara a mano, a las 05:42
(contenedor recreado, dominio respondiendo 200). Push a `main` SÍ
despliega — Dokploy está configurado para redesplegar en cada push a esa
rama. Por eso una entrega con migración (o que necesite verificarse ANTES
de que el código llegue a producción) no se pushea a `main`: se pushea a
una rama `entrega/<nombre>`, el VPS aplica la migración contra la base
real y recién después hace `git checkout main && git merge --ff-only
entrega/<nombre> && git push origin main` — ese fast-forward es lo que
dispara el deploy. Los pasos de abajo (de antes de esta corrección) siguen
describiendo bien EL ORDEN entre migración/variable/código; lo único que
cambió es CUÁNDO se pushea a `main`: nunca antes de que la migración ya
esté aplicada.**

**Cuando el deploy lleva migración Y una variable de entorno nueva**
(caso de la corrida "La IA ve lo que llega", 8/9/2026, migración
`20260908010000` + `AI_AGENT_REASONING`): la variable va ANTES que el
código, porque el contenedor nuevo lee el Environment al arrancar y el
código llegaría antes que la base y que la variable si no se ordena así.
Orden completo (con la corrección de arriba: el paso 4 es el push/merge a
`main`, no un redeploy manual aparte):

1. Respaldo (`scripts/backup.sh`, ver §8).
2. La variable nueva (`AI_AGENT_REASONING=off` en el caso de esa corrida)
   en la pestaña **Environment** de Dokploy, **sin desplegar todavía**.
3. Migración a mano contra `supabase-db` (pasos 2-3 de arriba) y su
   registro en `supabase_migrations.schema_migrations`.
4. Recién ahora, el fast-forward de `main` a la rama de la entrega (o el
   redeploy desde el panel si el código ya estaba en `main`): ESO es lo que
   dispara el deploy.
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

**Los logs del contenedor sobreviven al deploy desde el 22/9/2026** (T8, plan
"Nada se pierde en un corte ni en un deploy"). El servicio `app` de
`docker-compose.dokploy.yml` trae `logging: { driver: journald, options: {
tag: "sbk-crm-app" } }`. El driver por defecto (`json-file`) guarda los logs
DENTRO del contenedor, y Dokploy recrea el contenedor en cada deploy — se
lleva los logs con él; el 21/9/2026 esto impidió comparar la tasa de cortes
app↔PostgREST entre dos versiones desplegadas el mismo día, no había con qué.
Con journald los logs quedan en el propio VPS (`/var/log/journal`,
persistente) y sobreviven al recreate:

```bash
journalctl -o cat CONTAINER_TAG=sbk-crm-app --since "2h" | jq
```

`docker logs <contenedor>` sigue funcionando igual que siempre con este
driver — nada se pierde, journald es un destino adicional, no un reemplazo.
**No hay nada que fusionar a mano.** Dokploy REGENERA el `docker-compose`
completo en cada deploy a partir del archivo del repo, inyectando los labels
de Traefik desde su pestaña Domains — lo que en el servidor puede parecer
"un compose editado a mano" es en realidad una reserialización de YAML hecha
por la propia Dokploy; el bloque `logging:` viaja con el resto del archivo,
sin ningún paso extra.

Lo que sí conviene verificar tras el PRIMER deploy con este cambio:

- Que el dominio sigue respondiendo (`curl -I https://<tu-dominio>`, arriba).
- Que el contenedor conserva los labels de Traefik que Dokploy le inyecta:
  ```bash
  docker inspect <contenedor-app> --format '{{json .Config.Labels}}' | jq
  ```
  Si faltan los `traefik.*`, el dominio cae a 502 — volver a desplegar desde
  el panel de Dokploy (no a mano) suele bastar.

**Un `git reset --hard` A MANO en el servidor, fuera de un deploy real de
Dokploy, sí tira los labels de Traefik** — el dominio cae a 502 hasta el
próximo despliegue desde el panel, porque esa reserialización de YAML solo la
hace Dokploy al desplegar, no algo que viva en el repo. No tocar el checkout
del servidor a mano; si hace falta revertir, revertir el commit en Git y
dejar que Dokploy redespliegue.

Prerrequisitos de journald ya verificados por el VPS el 21/9/2026:
`/var/log/journal` existe y es persistente, 422 MB usados, 162 GB libres, sin
tocar `journald.conf`.

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
| El cron relee el BCV con su token | 200, `refreshed` según toque o no |
| El cron de BCV sin token | 401 |

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

Desde el plan "La tasa BCV se lee cuatro veces al día" (25/9/2026), sumar
otra línea de cron con el mismo `CRON_SECRET` contra `/api/cron/bcv-refresh`
(en Dokploy ya lo hace el propio servicio `cron` del compose, ver más
arriba): el minuto no fuerza nada, la ruta decide contra
`BCV_READ_HOURS`/`shouldRefetchBcv` (00/06/12/18 hora de Venezuela) si de
verdad toca salir a bcv.org.ve.

```cron
* * * * * curl -fsS -X POST https://<tu-dominio>/api/cron/bcv-refresh -H "Authorization: Bearer $CRON_SECRET" > /dev/null
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

- **Sigue sin haber agregador de registros ni alertas — lo que cambió el
  22/9/2026 (T8, plan "Nada se pierde en un corte ni en un deploy") es que
  los logs YA NO se pierden en cada deploy.** El código emite una línea JSON
  por evento (`{"level","event","ts",...}`), lista para que Loki, Datadog o
  CloudWatch la indexen sin parsear texto, y oculta solo los valores
  sensibles; con `logging: driver: journald` (ver §7 → "En Dokploy") esa
  salida ahora vive en `/var/log/journal` del propio VPS y sobrevive al
  `recreate` del contenedor en cada deploy — antes se iba con el contenedor
  viejo, y comparar la tasa de un evento entre dos versiones desplegadas el
  mismo día era imposible por falta de datos, no de análisis. Sigue faltando
  apuntar un recolector de verdad (Loki/Datadog/CloudWatch) a
  `journalctl`/`docker logs` y armar las alertas — hoy la única forma de
  mirar estos eventos es un `journalctl ... | jq` a mano (§12). Los eventos
  que merecen una alerta real: `cola_encolar_fallido`, `cola_turno_fallido`,
  `webhook_sin_secreto_en_produccion`, `webhook_firma_invalida`,
  `identidad_reescrita` (una reescritura de la guarda de identidad funcionó:
  vale la pena contarlas), `identidad_bloqueada` (un turno terminó escalado
  por esta guarda) y, desde el 22/9/2026, `webhook_mensaje_no_guardado`/
  `webhook_contacto_no_guardado`/`webhook_conversacion_no_creada`
  (persistencia perdida, con o sin reintento de Meta), `base_agotada` (un
  corte de la base que ni el reintento del cliente admin pudo resolver) y
  `turno_llamadas_no_escritas` (la telemetría de un turno no se pudo volcar
  — no afecta al cliente, pero sí a la visibilidad de §12).
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

**Corrección del 25/9/2026: "el push a main no despliega" era falso (ver la
corrección grande en §7 → "En Dokploy"); esta sección describe un deploy que
ya ocurrió el 15/9/2026 y se deja tal cual, pero el orden real desde el
25/9/2026 en adelante es aplicar la migración ANTES de pushear a `main` (o
pushear a una rama `entrega/<nombre>` y hacer fast-forward recién con la
migración ya aplicada), no pushear y esperar a un deploy manual aparte.**

Todo lo que necesita la base va ANTES del deploy, que es un paso aparte
desde Dokploy (el push a `main` no despliega).

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
   `AI_MAX_REQUESTS_PER_MINUTE=160`), sin desplegar: el deploy del paso
   siguiente las carga.
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

## 11. Entrega de "Seba atiende el mostrador" + "Nada sin leer, un solo catálogo y la factura Saint" + "Seba sale sin pisar a nadie" (19/9/2026)

Producción se midió por última vez en `3802fad` el 18/9/2026 (base en
`20260915010000`, árbol y base coincidían). Todo lo commiteado después —las
tres migraciones de "La IA no vuelve a pedir lo que ya pidió"/Seba
(`20260916010000`, `20260917010000`, `20260917020000`), la corrida completa
de "Seba atiende el mostrador", "Nada sin leer, un solo catálogo y la
factura Saint" (migraciones `20260918010000`/`20260918020000`) y las
correcciones de "Seba sale sin pisar a nadie" (T1-T3, T5, T6, T7, T8, T10,
sin migración propia — solo TOCA las cinco de arriba, editadas antes de que
ninguna saliera de la máquina) — sigue pendiente de entrega. **Antes de
calcular qué falta por entregar, confirmar en qué commit está producción de
verdad** (`produccion..HEAD`, nunca el HEAD local): puede haber cambiado
desde el 18/9 si otra sesión ya entregó parte de esto. El reporte por
commit de "Nada sin leer, un solo catálogo y la factura Saint" ya está
escrito aparte —
`docs/entregas/2026-09-19-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`—
y el de "Seba sale sin pisar a nadie" en
`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`: esta sección da
el ORDEN operativo completo, los dos documentos dan el detalle commit por
commit.

**Nota de estado (19/9/2026, al escribir esta sección): T4 ("El job
`migraciones` del CI vuelve a verde") estaba en curso al empezar a
documentar este orden y terminó su cambio de código mientras tanto —
verificar en el reporte de entrega (`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`)
si ya confirmó la suite completa de `supabase/tests/` en verde sobre una
base reconstruida desde cero antes de dar el paso 6 por bueno.**

**Sumado el 21/9/2026 (T5, plan "El catálogo configurado sale siempre"):
una sexta migración se agrega al final del orden, `20260921010000_escenario_cede_al_inventario.sql`
(columna `ai_playbooks.cede_al_inventario`) — ver el paso 3, más abajo. El
reporte de entrega de esa corrida está en
`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`, sección "El
catálogo configurado sale siempre (21/9/2026)" (agregada ese mismo día).

**Medición de solo lectura, 21/9/2026 (VPS, 00:49 VET):** producción sigue
en `3802fad`, base en `20260915010000` — sin cambios desde el 18/9.
Volumen medido: 5.947 conversaciones, 113.308 mensajes, 50.264 traspasos.
**Ventana recomendada para aplicar las seis migraciones fuera de hora
pico: 03:00–05:00 VET** (1 y 0 mensajes entrantes en los últimos 7 días a
esas horas; el pico del día es a las 11:00, con 1.444 mensajes). El UPDATE
operativo del paso 4 (C1) tocaría **30 conversaciones** con el volumen de
hoy. `buscar_repuesto` sigue **APAGADO en producción desde el 25/8** y,
por decisión del operador, **SE DESPLIEGA APAGADO** — lo enciende él mismo
después desde Control IA → Herramientas, en un horario con asesores
mirando la bandeja; revertirlo es un clic (ver "Al encender la consulta de
productos", después del paso 11).

### Orden corregido, once pasos (inspección pre-despliegue del 19/9/2026)

Nace de tres auditorías de solo lectura sobre `3802fad..HEAD` (ver la
memoria `inspeccion-pre-despliegue-19-9-2026` del operador) que encontraron
dos críticos que el código de "Seba sale sin pisar a nadie" ya corrige
(C1/T10, C2/T1) y varios hallazgos que solo se resuelven con el ORDEN de
esta lista, no con código. Ningún paso se salta ni se reordena.

**1. Medir (solo lectura, antes de tocar nada).** Corre las cuatro consultas
de abajo contra producción y guarda los resultados — son la línea de base
contra la que se compara después de migrar:

```sql
-- C1: cuántos chats asignados hoy corren con la IA todavía encendida (el
-- UPDATE operativo del paso 4 los apaga; sirve para saber cuántas filas
-- tocará antes de correrlo).
select count(*) from public.conversations
where status <> 'closed' and assigned_agent_id is not null and ai_enabled;

-- A1: cuántos chats YA tienen una respuesta real pero welcome_sent_at
-- todavía no existe con la semántica nueva — son los que el backfill de
-- 20260917010000 va a sellar; el número da la magnitud del backfill
-- (M5 lo mide en ~17 mil, hazlo de nuevo contra el volumen real de hoy).
select count(*) from public.conversations
where has_reply and welcome_sent_at is null;

-- Transacciones largas / locks que puedan chocar con las cinco migraciones
-- (todas tocan conversations, messages, orders — tablas calientes del
-- camino de escritura del webhook).
select pid, now() - xact_start as duracion, state, left(query, 100) as query
from pg_stat_activity
where xact_start is not null
order by duracion desc
limit 20;

-- Tope de gasto vigente y consumo del día en curso (M4: con Seba
-- trabajando turnos completos en chats asignados desde D2/T4 de "Seba
-- atiende el mostrador", el gasto sube; mejor saber el margen ANTES de
-- migrar que descubrirlo con el tope ya alcanzado).
select s.daily_spend_cap_usd, public.agent_spend_today() as gasto_hoy
from public.agent_settings s;
```

**2. Respaldo terminado** (`scripts/backup.sh`, §8) — esperar a que termine
de verdad, no lanzarlo en paralelo con el paso 3.

**3. Las seis migraciones, en orden, fuera de hora pico (03:00–05:00 VET,
medición del 21/9/2026 más arriba), avisando al equipo ANTES de migrar.**
Cada una con:

```bash
PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f <archivo>.sql "$DATABASE_URL"
```

(o el equivalente `docker exec -i supabase-db psql -U postgres -d postgres
-1 -v ON_ERROR_STOP=1 -f - < <archivo>.sql` si se corre dentro del
contenedor — `PGOPTIONS` no aplica ahí porque `psql` ya corre local; usar
en su lugar `-c "set lock_timeout='5s'"` como primer statement si hiciera
falta un tope adicional al que cada migración ya trae con `set local
lock_timeout = '5s'` (T5 de "Seba sale sin pisar a nadie" para las cinco
primeras; `20260921010000` lo trae con el mismo criterio, T1 de "El
catálogo configurado sale siempre") — las seis lo traen, no hace falta
pasarlo por fuera).

**Corrección post-revisión (`code-review high`, 19/9/2026, hallazgo 10):
las cinco migraciones de esa revisión ABORTAN solas si `-1`/`ON_ERROR_STOP=1`
falta** (la sexta, `20260921010000` del 21/9, no viene de esa revisión pero
sigue el mismo patrón — ver más abajo). Justo después de su propio `set
local lock_timeout = '5s'`, cada una trae un `do $$ … if
current_setting('lock_timeout') in ('0', '0ms') then raise exception … end
if; $$` — si el comando de arriba se corre sin `-1` (o sin el
`PGOPTIONS`/`-c "set lock_timeout=..."` equivalente), el `set local` es un
NO-OP silencioso y esta guarda lo detecta y aborta la migración ENTERA con
un mensaje explícito, en vez de aplicarse igual sin el freno de lock que la
justifica. Si alguna de las seis aborta con ese mensaje, no es un bug de la
migración: falta `-1 -v ON_ERROR_STOP=1` en el comando — repetir el
comando de arriba tal cual, sin quitar ni bajar el `lock_timeout`.
Verificado el 19/9/2026 con `npx supabase db reset` (CLI 2.117.0): las
cinco de entonces aplican sin abortar. `20260921010000` (21/9/2026) trae la
misma guarda por diseño (ver el propio archivo) y ya corrió sin abortar
contra la base local de esta máquina (aplicada a mano con `psql -1 -v
ON_ERROR_STOP=1`, autoverificación interna en verde) — falta que el cierre
del plan la sume a la corrida de `npx supabase db reset` de las seis
juntas, igual que se hizo con las cinco el 19/9.

**Corrección (revisión "El resguardo antes del push", tarea C5,
20/9/2026): la frase de arriba es cierta a medias.** `npx supabase db
reset` SÍ aplica cada migración de forma atómica (sondeado el 20/9/2026:
una migración de prueba `create table …; select 1/0;` falla y la tabla no
queda), pero con una transacción IMPLÍCITA del protocolo (un lote sin
`BEGIN`), no con un BLOQUE de transacción. Para `set local lock_timeout`
alcanza —por eso la guarda nunca disparó ahí—; para `lock table` no:
Postgres exige un bloque explícito ("LOCK TABLE can only be used in
transaction blocks"). Como el arreglo del interbloqueo del punto siguiente
necesita `lock table`, `20260916010000` y `20260917010000` ahora traen su
propio `begin;`/`commit;` dentro del archivo (no dependen de `-1` ni de la
CLI). Consecuencia: en ESAS dos, olvidarse el `-1` ya no aborta —el
archivo trae su transacción—, que es el lado seguro; con `-1` salen dos
WARNING inofensivos ("already a transaction in progress" / "no transaction
in progress"). Las otras tres no lo necesitaban: no tienen el patrón
"candado de fila retenido + candado de tabla pedido después" que produce
el ciclo, y su guarda sigue abortando sin `-1`.

**Candados de tabla nuevos en `20260916010000` y `20260917010000`
(hallazgo B/gemelo, tarea C5, 20/9/2026) — interbloqueo real, no solo
teórico.** Reproducido contra la base local: 20 conexiones concurrentes
imitando al webhook (`INSERT INTO messages` para `20260917010000`,
`select record_handoff(...)` para `20260916010000`) durante la aplicación
de la migración SIN estos candados producían `deadlock detected` de forma
consistente (ver `docs/entregas/` de esta tarea para el texto exacto del
error). Con los candados —`lock table … in share row exclusive mode` al
principio del archivo, antes de tocar una sola fila de `conversations`—
3 corridas seguidas de cada migración, mismo escenario de carga, dieron
`RC=0` sin ningún deadlock:

| Migración | Candados que toma (orden) | Bloquea | Segundos que el generador quedó esperando (3 corridas) |
|---|---|---|---|
| `20260916010000` | `conversation_handoffs` (SHARE ROW EXCLUSIVE) | Escrituras a `conversation_handoffs` (`record_handoff`, todo `INSERT`/`UPDATE`); las LECTURAS de la bitácora (`escalationOpen`, `humanClaimsChat`) siguen sin bloquearse | 4,1 s / 15,2 s / 4,3 s |
| `20260917010000` | `conversation_handoffs`, después `messages` (SHARE ROW EXCLUSIVE, mismo orden alfabético en las dos migraciones) | Escrituras a `messages` (el `INSERT` del webhook) y a `conversation_handoffs`; las LECTURAS de ambas (la bandeja cargando mensajes, la bitácora) siguen sin bloquearse | 6,2 s / 15,6 s / 7,7 s |

Aplicar las seis fuera de hora pico sigue siendo la recomendación (no
cambia con este arreglo): esos segundos son el tiempo que un webhook
entrante para una conversación cualquiera —no solo las que toca el
backfill— queda esperando a que la migración llegue al `commit;`. **Si
cualquiera de las dos aborta por `lock_timeout` (55P03, "no se pudo
obtener el candado en 5 s")**, no quedó nada a medias —la guarda del
`begin;`/`commit;` explícito hace que el archivo sea atómico— así que se
reintenta el mismo comando tal cual; un `lock_timeout` ahí es señal de
tráfico más alto de lo esperado al momento de migrar, no de una migración
rota. Orden estricto:

1. `20260916010000_devolucion_a_la_ia.sql` (si no está aplicada — regla
   dura, columna GENERADA).
2. `20260917010000_seba_y_escalada_viva.sql`.
3. `20260917020000_ai_lessons.sql`.
4. `20260918010000_catalog_links.sql`.
5. `20260918020000_factura_saint.sql`.
6. `20260921010000_escenario_cede_al_inventario.sql` (T1, "El catálogo
   configurado sale siempre", 21/9/2026 — sin relación de dependencia con
   las cinco de arriba, va al final solo porque es la última en llegar).
   Verificar por efecto, no por registro:
   ```sql
   select column_default, is_nullable from information_schema.columns
   where table_name = 'ai_playbooks' and column_name = 'cede_al_inventario';
   -- 'false' | 'NO'
   ```

**Aviso al equipo, justo antes de este paso, no después:** desde que
`20260917010000` entra, CUALQUIER mensaje real que un asesor mande a un
cliente (no una nota interna) apaga a Seba en ese chat —trigger
`handle_agent_message_silences_ai`, ver CLAUDE.md, "La escalada ya NO apaga
a Seba"—. Es el comportamiento nuevo que el cliente pidió (Seba sigue
vendiendo hasta que una persona escriba de verdad), pero el equipo tiene
que saberlo ANTES de que empiece a pasar: un asesor que manda un mensaje
"solo para probar" en un chat que Seba está atendiendo bien lo silencia ahí
mismo, sin aviso en pantalla más allá del interruptor del chat.

Registrar las seis en `supabase_migrations.schema_migrations` (no se
registran solas) — **después de aplicar cada una con éxito** (o las seis
juntas al final, nunca antes de que la migración correspondiente haya
entrado de verdad):

```sql
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260916010000', '20260916010000_devolucion_a_la_ia'),
  ('20260917010000', '20260917010000_seba_y_escalada_viva'),
  ('20260917020000', '20260917020000_ai_lessons'),
  ('20260918010000', '20260918010000_catalog_links'),
  ('20260918020000', '20260918020000_factura_saint'),
  ('20260921010000', '20260921010000_escenario_cede_al_inventario');
```

Verificar con `select count(*) from supabase_migrations.schema_migrations` →
76 (75 con las primeras cinco, tal como decía esta sección antes del
21/9/2026; +1 con `20260921010000`).

**4. UPDATE operativo de C1** (mitigación para los chats que YA están
asignados a mano desde antes de este deploy — el código de T10 solo
protege las asignaciones que ocurran DESPUÉS de que el código esté vivo):

```sql
update public.conversations
set ai_enabled = false
where assigned_agent_id is not null and ai_enabled and status <> 'closed';
```

Corre DESPUÉS de las seis migraciones (necesita el trigger de
`20260917010000` para que la próxima vez que ese chat cambie de manos deje
rastro en `conversation_handoffs`) y ANTES del push del código — si se
corre después del push, hay una ventana donde Seba ya corre turnos
completos en esos chats con la guarda nueva (`if (!convo.ai_enabled)`)
sin que nada la frene todavía. Con el volumen medido el 21/9/2026 (más
arriba), este UPDATE toca **30 conversaciones** — verificar el "UPDATE 30"
que devuelve contra ese número antes de seguir.

Efecto colateral deseado (T11, "Seba sale sin pisar a nadie"): este UPDATE
deja una fila `silenciada_por_asesor` por cada chat que toca (trigger
`handle_conversation_ownership_change`). Para esos chats, un "Desasignar"
posterior desde el panel —si el asesor nunca le escribió de verdad al
cliente— va a reencender a Seba solo (`reenableAiIfAdvisorNeverWrote`,
`mutations.ts`): es lo esperado, no un efecto secundario a corregir.

**5. `notify pgrst` + los dos GET de humo.** Las seis migraciones ya
terminan en `notify pgrst, 'reload schema'` (T5, hallazgo M1 — antes
NINGUNA lo traía y PostgREST seguía sirviendo el esquema cacheado;
`20260921010000` lo suma con el mismo criterio). Antes de pushear el
código, confirmar que el reload surtió efecto con dos GET directos contra
PostgREST, uno por tabla nueva (`20260921010000` no agrega una tabla
nueva —solo una columna a `ai_playbooks`, que ya se sirve por REST—, así
que no hace falta un tercer GET: si el reload no llegó, el síntoma sería
un 400 al mandar `cede_al_inventario` desde el panel, no un 400 en la
tabla entera):

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://<tu-proyecto>.supabase.co/rest/v1/catalog_links?select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# 200 (con [] o filas) — nunca 400/404

curl -s -o /dev/null -w "%{http_code}\n" "https://<tu-proyecto>.supabase.co/rest/v1/ai_lessons?select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# 200 (con [] o filas) — nunca 400/404
```

Si cualquiera de los dos da 400, `notify pgrst` no alcanzó (o PostgREST
todavía no lo procesó) — esperar unos segundos y repetir antes de seguir;
el código que se va a pushear en el paso 7 golpea estas dos tablas en el
primer turno/carga de panel que le toque.

**6. Comprobación única de tablas/columnas/trigger, ANTES del push.** Una
sola consulta, todas las filas deben dar `ok = true`:

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

(Las dos filas de "publicada en supabase_realtime" ya se autoverifican
DENTRO de sus propias migraciones —`raise exception` si el `alter
publication` no surtió efecto—, así que si las migraciones del paso 3
terminaron sin error esas dos filas ya deberían dar `true`; repetirlas acá
es la comprobación de una sola vez que reemplaza mirar cada migración por
separado.)

**7. Deploy del código.** Recién ahora, desde Dokploy (corrección del
25/9/2026: en esta fecha, 19/9/2026, se creía que el push a `main` no
despliega por sí solo; desde el 25/9/2026 se sabe que SÍ — ver §7 → "En
Dokploy" — así que "recién ahora" pasa a significar "recién ahora se
pushea/hace fast-forward a `main`", no "recién ahora se dispara un deploy
aparte"). Mirar el CI antes de desplegar (API pública de
Actions, ver Comandos de `CLAUDE.md`) y reproducir en local cualquier falla
que no quepa en las 10 anotaciones que muestra GitHub por paso.

**8. Backfill acotado de `welcome_sent_at` + `vacuum analyze`.** El
backfill grande ya corrió DENTRO de `20260917010000` (paso 3); este es
el que cierra el hueco entre ESE backfill y el momento en que el código
del paso 7 queda de verdad sirviendo tráfico —cualquier chat que recibió
su primera respuesta humana justo en ese hueco (minutos, no horas) tiene
`has_reply = true` pero `welcome_sent_at` le siguió quedando en `null`, y
sin este segundo backfill Seba lo saludaría a mitad de charla en su
próximo turno (ver la errata corregida sobre esta misma columna, más
arriba en este documento)—. Es la MISMA sentencia del backfill original,
y es segura de repetir: solo toca las filas que el primer backfill no
alcanzó a tocar.

**Advertencia (hallada en el ensayo del 19/9/2026, ver "Ensayo del
despliegue" en el reporte de entrega): el UPDATE y el `vacuum analyze` NO
pueden ir en el mismo comando** — ni en un solo `psql -c "…; …;"` ni
dentro del mismo archivo corrido con `-1`. En los dos casos Postgres agrupa
las sentencias en una transacción implícita (el protocolo "simple query" de
libpq envuelve varias sentencias separadas por `;` en una sola transacción,
y `-1` fuerza lo mismo sobre un archivo entero), y `VACUUM cannot run inside
a transaction block` aborta — **deshaciendo también el UPDATE**, sin dejar
ningún rastro del backfill. Corren como DOS comandos separados:

```bash
# 8a. El UPDATE, solo. Verificar el "UPDATE n" que devuelve contra el
# número de la línea de base del paso 1 (consulta A1) antes de seguir.
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

El `vacuum analyze` es porque el backfill grande del paso 3 reescribe
~17 mil filas de `conversations` (M5) — cada una dispara un evento de
Realtime hacia cualquier cliente suscrito, y deja hinchazón (`bloat`) que
conviene limpiar antes de que el planner empiece a decidir mal sobre esa
tabla con estadísticas viejas.

**9. Subir el tope de gasto + lección global.** Con Seba corriendo turnos
completos en chats asignados (D2/T4 de "Seba atiende el mostrador") el
gasto diario sube frente a la línea de base del paso 1 — subir
`daily_spend_cap_usd` (panel Control IA, o `update public.agent_settings
set daily_spend_cap_usd = <nuevo_valor>, updated_at = now();`) ANTES de que
el tope viejo se alcance: con el tope agotado, el cron reencola hasta 50
turnos/min (`AGENT_QUEUE_MAX_PER_RUN`) que vuelven a fallar por
`agente_no_puede_correr`, inflando la bitácora sin que la IA responda nada
(M4).

Lección global del primer día (A7 — texto sugerido, cargarlo desde
`/agent-control > Respuestas > Lecciones` como nota, alcance "global"; no
es código, es la única palanca disponible el día 1 porque `PREGUNTA_FILTRO`
—"Claro, ¿para qué modelo y año de moto las buscas?"— está fija en
`tools.ts`, T3 de "Seba atiende el mostrador"). **Ojo:** `ai_lessons.content`
tiene un CHECK de 1 a 200 caracteres (`char_length(btrim(content)) between 1
and 200`, migración `20260917020000`) — el texto sugerido en la primera
versión de este paso medía 362 caracteres y el INSERT desde el panel habría
fallado con `ai_lessons_content_check` (hallado en el ensayo del 19/9/2026,
ver "Ensayo del despliegue" en el reporte de entrega). El de abajo mide 193:

> Cascos, aceites y maletas no dependen del modelo ni del año de la moto:
> no los preguntes. Pregunta la talla del casco, la viscosidad del aceite o
> el tamaño de la maleta, o muestra las opciones.

**10. (OPCIONAL — ya no es parte del camino obligatorio del despliegue)
Catálogos: el operador los carga a mano desde el panel; el script queda
como alternativa.** Decisión del operador del 21/9/2026 (T1 del plan "Los
catálogos se cargan a mano desde el panel; el script pasa a ser opcional",
literal: *"Los urls los pondremos en la sección que creamos en la sesión,
para eso hay que esperar que esté en producción"*) — hasta esa fecha este
paso era obligatorio (D8 del plan "Nada sin leer, un solo catálogo y la
factura Saint") y dependía de dos respuestas del operador que nunca
llegaron (ver más abajo); ya no bloquea nada. **El despliegue obligatorio
termina en el paso 9** (push en el paso 7, backfill+tope de gasto en 8/9);
este paso 10 queda para cuando el operador decida cargar cada catálogo, y
el paso 11 (vigilar) no depende de él.

**Camino principal — a mano, desde Control IA → Enlaces de catálogo, una
vez que el código de esta corrida ya esté en producción:**

1. Crear el catálogo (clave, etiqueta, URL, activo) ANTES de tocar ningún
   texto. La clave solo admite minúsculas, números y guiones (`[a-z0-9-]+`)
   y **NO se puede editar después** (`catalog-links-panel.tsx`, D del plan
   "Nada sin leer…" — el campo queda de solo lectura al editar): acordarla
   de una vez evita crear una fila que después haya que abandonar para
   "renombrar" con una nueva. Claves sugeridas (las mismas que traía el
   script): `cascos`, `resonadores`, `maletas`, `exploradoras-y-bombillos`,
   `defensas`, `lubricantes` (y `lubricantes-2` si el segundo Drive de
   "Lubricantes" resulta ser un catálogo real y no una URL vieja sin
   borrar — ver la pregunta pendiente, en la descripción del script, abajo).
2. Recién DESPUÉS editar el escenario o el mensaje rápido que hoy lleva la
   URL de Drive pegada a mano y reemplazarla por `{{catalogo:<clave>}}` (o
   `{{catalogos}}` para la lista completa). Al revés —marcador antes que el
   catálogo exista y esté activo— fase 0 descarta el escenario de los
   candidatos (log `escenarios_enlace_sin_resolver`) y el cliente se queda
   sin PDF; en el composer, un mensaje rápido con un marcador sin resolver
   se pega crudo con un `toast.warning` de aviso — el asesor lo ve antes de
   mandarlo, no falla en silencio.
3. `{{catalogos}}` lista TODOS los enlaces ACTIVOS de la tabla —no cargar
   ahí "Ubicación" ni ningún enlace que no sea un catálogo de repuestos
   (mismo motivo por el que el script los deja fuera, ver la descripción
   del script más abajo: `formatCatalogList` mezclaría la ubicación de la
   tienda con la lista de catálogos).
4. Se puede migrar catálogo por catálogo, sin apuro: mientras un
   escenario/mensaje rápido no se edite, sigue mandando la URL pegada a
   mano de siempre — nada se rompe por tardar en migrar el resto. Verificar
   cada uno mandando el escenario/mensaje rápido a un número de prueba
   antes de darlo por migrado.

Este camino resuelve solas, sin que nada quede bloqueado, las dos preguntas
que hasta el 21/9/2026 frenaban el script (detalladas más abajo): el
operador carga la URL que él sabe que es la vigente para "cascos", y decide
si "Lubricantes" son uno o dos catálogos, en el momento en que migra cada
escenario — no hace falta esperar su respuesta para nada más.

Mientras nadie edite los textos, los escenarios y mensajes rápidos siguen
mandando las URLs de Drive pegadas a mano, igual que hoy: no hay ningún
apuro el día del deploy por este paso.

**Sobre `ai_playbooks.cede_al_inventario` de "Catálogo general" (T5, "El
catálogo configurado sale siempre", 21/9/2026): la migración
`20260921010000` crea la columna con `default false` para TODOS los
escenarios — quien la marcaba en `true` para "Catálogo general" era el
`UPDATE` de la sección 5c del script, no la migración.** Si el script no se
corre, "Catálogo general" queda con `cede_al_inventario = false` como
cualquier otro escenario: mientras `buscar_repuesto` se despliega APAGADA
(así se despliega, ver la medición del 21/9/2026 al principio de esta
sección) esto no cambia nada, porque la segunda de las cuatro condiciones
de H1/T5 ya frena la cesión sola. Si el operador enciende `buscar_repuesto`
sin haber corrido el script, marcar la casilla "Cede al inventario cuando
preguntan por un repuesto" a mano desde el editor de ese escenario en
Control IA → Respuestas ANTES de encender la herramienta — ver "Al encender
la consulta de productos", más abajo, que ya lo suma como primer punto a
revisar.

**Alternativa opcional — el script, para una carga masiva de una sola vez.**
`scripts/sql/2026-09-18-catalogos-iniciales.sql` sigue en el repo, sin
tocar, para cuando el operador prefiera migrar TODO de una vez en vez de
catálogo por catálogo desde el panel. **El Claude del VPS no lo corre por
su cuenta como parte de un despliegue — solo si el operador lo pide
expresamente.** Si lo pide, sigue corriendo DESPUÉS del código, nunca antes
(un marcador sin código que lo resuelva es peor que la URL vieja que
reemplaza). El archivo llega con marcadores de relleno `<<...>>` a
propósito ("el contenido es del cliente, no del repo"); el implementador no
inventó ningún valor. Pasos:

1. Correr las dos consultas de ayuda que trae el propio archivo (comentario
   en su cabecera, no se ejecutan solas) contra la base de producción para
   encontrar los `id`/textos reales:
   ```sql
   select id, name, left(response_text, 80) as inicio
     from ai_playbooks
     where response_text ilike '%drive.google.com%' or name ilike '%catalog%'
     order by name;

   select id, label, left(content, 80) as inicio
     from quick_replies
     where content ilike '%drive.google.com%'
     order by label;
   ```
   La consulta de `ai_playbooks` ya NO filtra por `name ilike '%ubicac%'`
   (corrección de la revisión `code-review high`, 19/9/2026, punto 3): el
   escenario "Ubicación" queda FUERA de este script a propósito —ver más
   abajo— así que no hace falta encontrar su fila acá.
2. **Las dos preguntas que hasta el 21/9/2026 frenaban este paso** (medidas
   el 21/9/2026, reporte de solo lectura del VPS) **ya NO bloquean el
   despliegue** —el camino principal es el panel, de arriba— pero siguen
   siendo necesarias para completar el script si el operador elige correrlo:
   - "Lubricantes" aparece DOS VECES en el escenario "Catálogo general",
     con dos archivos de Drive distintos (`1db_N7X…` y `1rwcYTw…`) — ¿son
     dos catálogos reales o quedó uno viejo sin borrar? Uno probablemente
     sea "Aceites", no un segundo "Lubricantes". Hasta que el operador
     responda (o los cargue él mismo desde el panel), el script trae como
     default cargar los dos como `lubricantes`/`lubricantes-2`.
   - Los escenarios de la IA y los mensajes rápidos de los asesores usan
     PDFs DISTINTOS para "cascos": los escenarios de la IA apuntan al
     Drive `1iz77Lc…`, los mensajes rápidos de los asesores al `1fP3yQ5…`
     — ¿cuál de los dos es el vigente? El script carga una sola URL para
     la clave `cascos` (compartida por escenarios y mensajes rápidos vía
     `{{catalogo:cascos}}`), así que cargar el que no es no se nota hasta
     que alguien lo abre y encuentra un PDF viejo.
3. Completar los marcadores `<<...>>` de las tres tablas de relleno con los
   valores reales (URLs de los 7 catálogos de "Catálogo general"; `id` y
   texto YA con el marcador de cada uno de los 2 escenarios —"CATALOGO
   CASCOS" y "Catálogo general"— y los 4 mensajes rápidos que hoy llevan la
   URL pegada a mano). Los huecos de texto usan dollar-quoting
   (`$txt$<<...>>$txt$`, T6, "Seba sale sin pisar a nadie"): pegar el texto
   real, con tildes o apóstrofos sin escapar, ya no rompe el INSERT.
   **"Ubicación" NO entra a ninguna de las tres tablas** (corrección del
   19/9/2026, punto 3 de la revisión): meter el Maps de la tienda en
   `catalog_links` lo colaría dentro de `{{catalogos}}` —la lista completa
   mezclaría la ubicación con los catálogos de repuestos— y el Maps no
   tiene el problema de rotación de IDs que esta tabla resuelve; el
   escenario "Ubicación" conserva su URL escrita a mano tal como está hoy.
4. Correr en una sola transacción:
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 \
     -f - < scripts/sql/2026-09-18-catalogos-iniciales.sql
   ```
   Esta es la MISMA forma que trae la cabecera del propio script ("CÓMO
   CORRERLO") — una sola forma recomendada, sin contradicción entre este
   documento y el archivo. **Dos WARNING inofensivos, hallados en el
   ensayo del 19/9/2026 (ver "Ensayo del despliegue" en el reporte de
   entrega):** el script ya trae su propio `begin;`/`commit;`, y corrido
   con `-1` (que abre su propia transacción alrededor de TODO el archivo)
   aparecen "WARNING: there is already a transaction in progress" (al
   llegar al `begin;` del script) y "WARNING: there is no transaction in
   progress" (al final, cuando `-1` intenta cerrar una transacción que el
   `commit;` del script ya cerró). Ninguno de los dos es un error — el
   script sigue corriendo dentro de una sola transacción real, que es lo
   que se busca — y no hay que investigarlos ni cambiar el comando.
   El propio script trae su propia guarda `\set ON_ERROR_STOP on` (T6,
   segunda protección por si el flag de la línea de comandos se olvida),
   aborta solo si queda algún `<<...>>` sin completar, si alguna clave
   `{{catalogo:<key>}}` referenciada en los textos nuevos no existe ni en
   la tabla de relleno ni ya activa en `catalog_links` (sección 2b, T6), si
   algún `update` de la sección 4/5 tocó menos filas de las esperadas
   (corrección del 19/9/2026, punto 2), y falla al final si alguna de las
   filas tocadas todavía contiene `drive.google.com` — no hace falta
   verificar nada de eso a mano. Si una clave ya existía en `catalog_links`
   (un supervisor la creó desde el panel), el script NO la pisa —`on
   conflict (key) do nothing`, decisión D-C— y deja un `NOTICE` con la
   clave, su URL actual y si está ACTIVA o INACTIVA (corrección del
   19/9/2026, hallazgo 7a): leer la salida de `psql` para decidir si hace
   falta actualizarla.

   **Dos secciones más, sumadas en la corrección post-revisión
   (`code-review high`, 19/9/2026, hallazgos 7a y 7b sobre T6) — si el
   script aborta en cualquiera de las dos, NO es un fallo de infraestructura,
   es un dato mal cargado en el propio script:**
   - **Sección 2c** aborta si algún texto nuevo trae un marcador de
     catálogo MAL ESCRITO — `{{catalogo:cascos_nuevos}}` (guion bajo),
     `{{catalogo: exploradoras y bombillos}}` (espacios dentro de la
     clave), sin clave o sin cerrar — porque la aserción 2b (arriba) solo
     mira la forma ESTRICTA del marcador y esos casos se le escapan tal
     cual: el mensaje de la excepción nombra el texto sospechoso. Corregir
     la clave/forma del marcador en el texto de la sección 1 y reintentar
     — `{{Catálogo: cascos}}` (mayúscula, acento, espacios alrededor del
     `:`) NO dispara esta guarda, resuelve normal.
   - **Sección 3b** aborta DESPUÉS del INSERT de la sección 3 si alguna
     clave referenciada por los textos nuevos sigue SIN estar ACTIVA en
     `catalog_links` — pasa cuando esa clave YA existía INACTIVA (creada
     desde el panel, o de una corrida anterior) y el `on conflict (key) do
     nothing` la dejó tal cual: el script NO la activa por su cuenta (D-C,
     es una decisión humana). Si esto aborta: activar la clave desde
     `/agent-control` (panel de enlaces de catálogo) y volver a correr el
     script — el `on conflict do nothing` hace la segunda corrida segura.

**11. Vigilar `escenario_cedido_al_catalogo` y turnos con error**, durante
las primeras horas después del deploy:

- **A8 — "pásame el catálogo" cedido al catálogo de productos.** H1 de
  "Seba atiende el mostrador" hace que un escenario calzado se CEDA al
  flujo de catálogo cuando la intención clasificada es
  `consulta_disponibilidad` — la sospecha es que un pedido genérico de
  catálogo (sin nombrar un repuesto) también clasifique así y se ceda sin
  necesidad, dejando al cliente sin el enlace que un escenario le habría
  dado directo. Medir contra los últimos 100 turnos que tocaron el
  escenario "Catálogo general", de dos maneras que se complementan (el
  cedido NO dice "Catálogo general" en su resumen, así que ninguna de las
  dos sola alcanza):
  ```sql
  -- Turnos donde el escenario "Catálogo general" SALIÓ tal cual (no se
  -- cedió) en los últimos 100 turnos de esa conversación/escenario.
  select count(*) from (
    select summary from public.agent_turns
    where summary = 'Escenario "Catálogo general".'
    order by created_at desc
    limit 100
  ) as recientes;
  ```
  ```bash
  # Turnos donde SÍ se cedió al catálogo (log estructurado, no queda en la
  # base — event: escenario_cedido_al_catalogo, ver src/lib/log.ts).
  # Ajustar al recolector de logs real de Dokploy/el VPS.
  docker logs <contenedor-app> --since 24h 2>&1 | grep '"escenario_cedido_al_catalogo"' | grep '"Catálogo general"' | wc -l
  ```
  Si el número de cedidos es alto frente a los enviados tal cual, y el
  cliente confirma que eran pedidos genéricos de catálogo (no de un
  repuesto puntual), es una señal para revisar la precedencia de H1 en una
  corrida futura — no se toca nada hoy, solo se mide.
- **Turnos con error.** `select action, count(*) from public.agent_turns
  where created_at > now() - interval '24 hours' group by action;` — vigilar
  que `error` no suba frente al día anterior; cruzar con
  `turno_conversacion_no_consultable` (C2/T1: ahora LANZA y la cola
  reintenta, así que un pico ahí es infraestructura, no un bug mudo como
  antes) y `entrega_fallida` en `conversation_handoffs` (T2: nuevo desde
  esta corrida, solo debería aparecer tras un fallo real del proveedor
  DESPUÉS del saludo de Seba).

### Al encender la consulta de productos (T5, "El catálogo configurado sale siempre", 21/9/2026)

`buscar_repuesto` se despliega APAGADO, tal como está en producción desde
el 25/8 (ver la medición del 21/9/2026, al principio de esta sección) — el
operador decide cuándo encenderla, desde Control IA → Herramientas, en un
horario con asesores mirando la bandeja (se revierte con un clic). Con la
herramienta apagada, la cuarta condición de H1/T5 nunca importa: ningún
escenario cede al inventario porque la segunda de las cuatro condiciones
(`buscar_repuesto` encendida) ya falla sola, así que "CATALOGO CASCOS" y
"Catálogo general" siguen mandando su PDF de siempre.

**Antes de encenderla (sumado el 21/9/2026, T1 del plan "Los catálogos se
cargan a mano desde el panel; el script pasa a ser opcional"): verificar
que "Catálogo general" tiene marcada la casilla "Cede al inventario cuando
preguntan por un repuesto" en su editor de escenario.** Esa marca
(`ai_playbooks.cede_al_inventario = true`) la ponía el `UPDATE` de la
sección 5c del script de carga de catálogos (paso 10, arriba) — la
migración `20260921010000` crea la columna con `default false` para TODOS
los escenarios, la marca no es automática. Si el paso 10 se resolvió a mano
desde el panel (el camino principal desde el 21/9/2026) en vez de con el
script, nadie marcó esa casilla todavía: sin ella, la cuarta condición de
H1/T5 falla y "Catálogo general" nunca cede al inventario aunque las otras
tres se cumplan — no es un bug, pero conviene decidirlo a propósito antes
de encender la herramienta, no descubrirlo después mirando por qué nunca
cede. Al encenderla, vigilar durante las primeras horas:

- `turno_tiempos` con `buscarRepuesto` en su columna `herramientas` en TODA
  fila con intención `consulta_disponibilidad` — si falta, la herramienta
  no le está llegando al modelo en ese turno.
- Los logs `escenario_no_cedido` y `escenario_cedido_al_catalogo`, contados
  por motivo — cuántos escenarios calzados terminan cediendo al inventario
  contra cuántos se mandan tal cual (mismas dos consultas del paso 11,
  arriba, ahora con la herramienta encendida de verdad).
- Escaladas por `sin_stock`: con el catálogo real, el volumen medido en la
  auditoría anterior a esta corrida traía maletas (8 con existencia real,
  pese al `sin_stock`), resonadores (3) y lubricantes (1) — revisar si esos
  mismos productos se repiten con la herramienta ya encendida en
  producción, o si eran ruido de una medición hecha con datos de otro
  momento del inventario.

### Verificación posterior completa (secciones 4 y 7 del plan "Nada sin leer…" + criterio de terminado de "Seba sale sin pisar a nadie")

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
- **Solo si se corrió el script de carga inicial** (paso 10, ahora
  OPCIONAL — 21/9/2026, T1): ninguna de las 2 filas de `ai_playbooks` ni
  las 4 de `quick_replies` tocadas conserva `drive.google.com` (el propio
  script ya lo exige para no dejar nada a medias, pero conviene mirarlo de
  nuevo con la consulta del paso 1 de arriba, ahora vacía). Si en cambio el
  operador migró a mano desde el panel, esta verificación se hace escenario
  por escenario a medida que se editan (ver el paso 3 del camino principal
  del paso 10): un escenario sin editar sigue con `drive.google.com` a
  propósito hasta que le toque su turno.
- Cerrar una venta sin factura Saint muestra el error bajo el campo y no
  llama a la mutación; con los nueve datos guarda, el evento de sistema
  nombra la factura y el detalle en Ventas la muestra (o "Sin número de
  factura Saint" en una venta anterior al 18/9).
- Asignarse un chat ("Asignarme"/"Intervenir") apaga la IA en ese chat de
  inmediato (T10); tomar un chat que Seba ya tenía asignado desde antes del
  deploy ya no compite con ella (paso 4, UPDATE operativo de C1).
- Provocar un error en `/agent-control` y en `/ventas` (por ejemplo,
  cortando la red un instante) muestra la pantalla con rail y "Reintentar"
  en vez del 500 genérico de Next (T7) — verificación visual obligatoria en
  Brave, jsdom no calcula layout.

---

## 12. Entrega de "Nada se pierde en un corte ni en un deploy" (22/9/2026)

Origen: el informe de solo lectura del Claude del VPS del 21/9/2026 (tras
desplegar `83bc558`) dejaba abiertos cortes app↔PostgREST sin diagnóstico, un
500 opaco al bajar una imagen, instrumentación pendiente
(`maxOutputTokens`/`toolChoice` sin prueba directa, tokens por fase
inferidos, `agent_token_usage` sin razonamiento), el caché "cacheando cero"
en la mitad de los turnos y que cada deploy destruye los logs. El plan
completo, con las seis objeciones que la revisión del VPS incorporó, está en
`docs/planes/2026-09-21-nada-se-pierde-en-un-corte-ni-en-un-deploy.md`; el
reporte por commit, con marcadores para pegar los hashes reales, está en
`docs/entregas/2026-09-22-nada-se-pierde-en-un-corte-ni-en-un-deploy.md` —
esta sección da el ORDEN operativo, ese documento da el detalle commit por
commit.

### Orden

1. **Confirmar que producción sigue en `83bc558` con 78 migraciones** (lo
   que el informe del VPS del 21/9/2026 midió a las 23:27 UTC): `git -C
   <checkout> rev-parse HEAD` y `select count(*) from
   supabase_migrations.schema_migrations`. El rango de esta entrega es
   `83bc558..HEAD` (7 commits, una sola migración, 78→79). Si producción ya
   no está ahí, recalcular `produccion..HEAD` antes de seguir — nunca sobre
   el HEAD local.
2. Respaldo (`scripts/backup.sh`, §8).
3. **Migración `20260921040000_telemetria_del_turno.sql` ANTES que el
   código** — nace columnas nuevas en `agent_turns`, la tabla
   `agent_turn_calls` (RLS habilitada SIN ninguna política, se lee solo por
   RPC) y recrea `agent_token_usage()`. Aplicarla igual que las anteriores
   de este mismo mes (`20260916010000` en adelante): la cabecera trae `set
   local lock_timeout = '5s'` con una guarda que ABORTA si no corre dentro de
   una transacción, así que hace falta `-1`:
   ```bash
   docker exec -i supabase-db env PGOPTIONS="-c lock_timeout=5s" psql -U postgres -d postgres \
     -1 -v ON_ERROR_STOP=1 \
     < supabase/migrations/20260921040000_telemetria_del_turno.sql
   ```
   Sale con `NOTICE: 20260921040000: autoverificación de agent_turn_calls y
   sus tres RPC correcta.` si entró bien; con `EXCEPTION` si algo quedó a
   medias — no seguir al paso 4 hasta que el NOTICE aparezca. Registrarla en
   `supabase_migrations.schema_migrations` (paso 3 del patrón de §7 → "En
   Dokploy"): el conteo pasa de **78 a 79** sobre lo que ya dejó "La
   escalada se hace una vez y la búsqueda responde" (`20260921020000`,
   `20260921030000`) — si producción todavía no tiene esas dos, aplicarlas
   primero, en su propio orden, antes de esta.
4. Deploy desde Dokploy (esta sección es del 22/9/2026, cuando se creía que
   el push a `main` no despliega; desde el 25/9/2026 se sabe que SÍ — ver
   §7 → "En Dokploy" — así que "deploy desde Dokploy" acá equivale a
   pushear/fast-forward a `main`): el código de T1-T8 no funciona sin
   la migración ya aplicada: `logTurn` pide `.select("id").single()` para
   poder escribir en `agent_turn_calls`, y sin la tabla ese insert falla).
5. **Verificar que el dominio sigue respondiendo y que el contenedor
   conserva los labels de Traefik** tras este deploy en particular (ver §7 →
   "En Dokploy", el bloque nuevo sobre journald) — es el primer deploy con
   `logging: driver: journald` en el compose, y aunque Dokploy regenera el
   YAML solo, vale la pena confirmarlo una vez:
   ```bash
   curl -I https://<tu-dominio>
   docker inspect <contenedor-app> --format '{{json .Config.Labels}}' | jq
   ```
6. **Activar el access log de Traefik** (objeción 3 de la revisión del VPS:
   el 500 real que un asesor vio al bajar una imagen el 21/9/2026 NO fue de
   `/api/media`, ni de Storage, ni de Envoy — Storage registró la subida y
   la firma en 200, y Envoy no vio NINGUNA petición de `facebookexternalua`
   a esa hora. La petición de Meta murió ANTES de Envoy, en Traefik o el
   borde TLS, y Traefik no tenía access log activado: ese es el hueco real,
   no algo que este plan haya podido arreglar en el código). En la
   configuración de Traefik de Dokploy (servicio `dokploy-traefik`), sumar:
   ```yaml
   accessLog:
     filePath: /var/log/traefik/access.log
     format: json
     fields:
       headers:
         names:
           User-Agent: keep
   ```
   y reiniciar Traefik. El próximo `131053` (o cualquier otro fallo de Meta
   al bajar un adjunto saliente) se busca por `facebookexternalua` en ese
   access log, cruzado con la hora del mensaje en `messages.created_at` —
   esto es lo que hace falta para saber si la petición llegó a Traefik y qué
   código le devolvió, cosa que hoy no se puede saber.

### Verificación en producción, 24-48 h después

- **Tokens por fase, la promesa 7.4 del informe del VPS del 21/9/2026**
  ("maxOutputTokens/toolChoice sin prueba directa"):
  ```sql
  select phase, count(*), sum(reasoning_tokens), sum(cached_input_tokens),
         max(max_output_tokens)
  from agent_turn_calls
  group by 1;
  ```
  La fase `escenario` deja de cachear cero (T6 movió el reloj al final del
  prompt); `redactar` trae `1500` en todas (el techo que puso T5/T4b).
- **`tool_choice = 'none'` en toda fila `redactar` posterior a una escalada
  del mismo turno** — la prueba directa que faltaba (7.4 del informe):
  ```sql
  select turn_id, sequence, tool_choice, finish_reason
  from agent_turn_calls
  where phase = 'redactar'
  order by turn_id, sequence;
  ```
  en un turno con dos filas `redactar`, la segunda (posterior a la escalada)
  trae `tool_choice = 'none'`.
- **Conteos de los eventos nuevos del webhook y del cliente admin** (cruzar
  con `journalctl`, ver §7):
  - `webhook_mensaje_no_guardado` con `retry` → cada uno seguido de un
    `23505` (la reentrega de Meta lo encontró ya guardado) o de un guardado
    exitoso — nunca un mensaje que se pierda dos veces seguidas.
  - `webhook_canal_no_consultable` — debería ser rarísimo; si aparece
    seguido, es un corte de la base más largo que lo que el reintento
    cubre.
  - `base_reintento`/`base_agotada` — el primero sin el segundo inmediato
    después es la señal de que el reintento está funcionando; `base_agotada`
    solo debería aparecer en cortes más largos que los ~1,3 s que cubren los
    dos reintentos por defecto.
  - `webhook_error_actualizar_estado` debería BAJAR frente a `base_reintento`
    — los cortes cortos ya no llegan a ese llamador (hallazgo del plan
    original, a confirmar en dato).
- **`telemetria_purgada` una vez al día**, con `filas` creciendo a medida que
  la tabla pasa los 90 días de retención — nunca dos veces el mismo día
  (`journalctl`, evento `telemetria_purgada`, o su ausencia junto con
  `telemetria_purga_lock_no_disponible` si Redis estuvo caído ese día).
- **Tras el SIGUIENTE deploy** (no este, el que viene después):
  ```bash
  journalctl CONTAINER_TAG=sbk-crm-app --since "1 day" | head
  ```
  debe seguir mostrando los turnos del contenedor ANTERIOR — la prueba de
  que journald sí sobrevive al `recreate` (antes de T8, `docker logs` contra
  el contenedor nuevo no traía nada de antes del deploy).
- **El 500 de la imagen**: si se repite, buscarlo primero en el access log
  de Traefik (paso 6 de arriba) por `facebookexternalua`, no en la app —
  ver el hallazgo 1 del plan y la trampa nueva en CLAUDE.md.
- **`agent_turns.wait_ms` cambia de significado en el deploy de T7 del plan
  "Seba no habla de más" (23/9/2026):** hasta ese commit guardaba
  `esperaMs` (ventana de silencio + espera en cola); desde ese commit guarda
  SOLO `colaMs` (la espera en cola, que es lo que el comentario de la
  columna siempre dijo). Cualquier percentil o serie histórica calculado
  sobre `wait_ms` de ANTES de ese deploy mezcla ~7,5 s de debounce (diseño,
  no atraso) que las filas de DESPUÉS ya no traen — no comparar ambos lados
  del corte como si fueran la misma métrica.

### Qué NO cambia para el operador

Ningún interruptor nuevo en Control IA. `AI_AGENT_REASONING=none` es
OPCIONAL — producción sigue en `off` tras este deploy, y pasar a `none` es
una decisión que se toma DESPUÉS de leer `agent_turn_calls.reasoning_tokens`
por fase durante unos días, no algo que este plan decida de antemano (ver
§1, fila de la variable). El resto del comportamiento visible para un
asesor o un cliente no cambia: esta corrida es observabilidad y resiliencia
de infraestructura, no una funcionalidad nueva.

---

## 13. Entrega de "El inventario llega de Saint y no se toca a mano" (25/9/2026)

Origen: `public.products` (5.438 filas) se cargó una sola vez el 24/8/2026 y
quedó congelada mientras la réplica Liminal ya copiaba `SAPROD` de Saint en
vivo a `public.saprod`; el reporte completo con el paso a paso operativo
(permisos a verificar ANTES de aplicar, comando de aplicación, verificación,
la guarda de bajas y su forzado manual, la mudanza de `public.saprod` a
`saint.saprod`, y qué revocar DESPUÉS del deploy del código) está en
`docs/entregas/2026-09-25-inventario-desde-saint.md` — esta sección solo dice
el orden y qué es nuevo en el stack.

**Migración `20260925010000_inventario_desde_saint.sql`, SIEMPRE antes del
código** — el commit de código lee `products.saint_added_at`/`saint_removed_at`,
que no existen hasta que esta migración entra; sin ella, la pantalla de
Inventario se cae al pedirlas en el `select`. Mismo patrón `set local
lock_timeout` + guarda contra el no-op silencioso + `notify pgrst` que el
resto de septiembre — `psql -1 -v ON_ERROR_STOP=1`, ver la entrega para el
comando completo. Medida en local con volumen real (5.438 productos + 6.035
filas de fuente): **0,79 s en total**, `saint.sync_products()` sola 260 ms —
con `psql -1` el `ACCESS EXCLUSIVE` del `ALTER TABLE` dura hasta el COMMIT,
así que la IA no lee `products` durante ese lapso.

**Job de pg_cron nuevo en este stack** — hasta esta entrega, todo lo que
corría "solo" en el servidor era el cron de Linux del VPS (`/api/cron/process-queue`,
§7). Esta migración crea el PRIMER job de **pg_cron dentro de Postgres**:
`saint-sync-products` (`* * * * *`, corre `saint.sync_products()`) y
`saint-sync-log-purge` (`30 3 * * *`, purga `saint.sync_log`/`cron.job_run_details`).
Verificar que la extensión existe y los jobs están agendados y activos:

```sql
select extname from pg_extension where extname = 'pg_cron';
select jobid, jobname, schedule, active from cron.job order by jobname;
```

Reversa de emergencia sin tocar datos: `select cron.unschedule('saint-sync-products');`
(detiene la sincronización; el candado sobre `products` se queda activo
igual, la app sigue sin poder editar el inventario a mano).

**Sin variables de entorno nuevas.** El único paso posterior al deploy del
código es `revoke update (updated_at) on public.products from authenticated;`
(la entrega trae el detalle completo y su verificación con
`has_column_privilege`).

---

## 14. Entrega de "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026)

Origen: `buscar_repuesto` está apagada en producción desde el 25/8/2026; al
simularla contra el catálogo real (6.035 productos que llegan de Saint) la
búsqueda vieja fallaba en casi la mitad de los casos — `.limit(31)` SIN
`order`, subcadenas ("rin" traía ORINGS), sin plurales, sin números cortos
("45", "DT 200"), filtrando por `product_compatibility` (0 filas). El
reporte completo con el paso a paso operativo está en
`docs/entregas/2026-09-26-la-busqueda-encuentra.md` — esta sección solo dice
el orden.

**Esta entrega NO se pushea a `main` directo — llega por la rama
`entrega/busqueda-que-encuentra`.** Desde el 25/9/2026 push a `main` SÍ
despliega (ver §7 → "En Dokploy"), así que una entrega con migración se
verifica ANTES de que el código le llegue a producción: se pushea a una rama
`entrega/<nombre>`, se aplica y verifica la migración contra la base real, y
recién con eso confirmado se hace fast-forward de `main` a esa rama (ese
fast-forward SÍ dispara el deploy). El orden completo:

1. **Respaldo** (`scripts/backup.sh`, §8).
2. **Simulacro de la migración** dentro de `BEGIN … ROLLBACK` contra
   `supabase-db` — corre la migración entera, deja que el `NOTICE`/
   `EXCEPTION` de autoverificación se vea, y revierte sin dejar nada
   aplicado. Sirve para confirmar que entra limpia contra el esquema real de
   producción (columnas, extensiones, nombres) antes de aplicarla de verdad.
3. **Aplicar la migración**, ahora sí, con `psql -1 -v ON_ERROR_STOP=1`
   (mismo patrón que el resto de septiembre — sin `-1` el `set local
   lock_timeout` de la cabecera es un NO-OP silencioso y la guarda de la
   propia migración aborta):
   ```bash
   docker exec -i supabase-db env PGOPTIONS="-c lock_timeout=5s" psql -U postgres -d postgres \
     -1 -v ON_ERROR_STOP=1 \
     < supabase/migrations/20260926010000_busqueda_ordena_antes_de_recortar.sql
   ```
   Esta migración solo CREA una función — no toca `products` ni bloquea
   nada, así que no hace falta ninguna ventana de mantenimiento.
4. **Verificar los permisos de la función** contra la base real (los dos
   revokes + el grant a `service_role`, nunca confiar en leer el `.sql`):
   ```sql
   select
     has_function_privilege('anon', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') as anon_puede,
     has_function_privilege('authenticated', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') as authenticated_puede,
     has_function_privilege('service_role', 'public.buscar_productos(jsonb, jsonb, int)', 'execute') as service_role_puede;
   ```
   Esperado: `anon_puede` y `authenticated_puede` en `false`,
   `service_role_puede` en `true`. Si alguno da distinto, NO seguir al paso
   siguiente — ver la trampa de "los dos revokes" en `CLAUDE.md`.
5. **Fast-forward de `main` a `entrega/busqueda-que-encuentra`** — ESTE es
   el paso que despliega:
   ```bash
   git fetch origin
   git checkout main
   git merge --ff-only origin/entrega/busqueda-que-encuentra
   git push origin main
   ```
   Confirmar en Dokploy que el contenedor se recreó con el SHA nuevo
   (`docker inspect <contenedor-app> --format '{{.Config.Image}}'`/logs de
   arranque) y que el dominio sigue respondiendo (`curl -I
   https://<tu-dominio>`).
6. **Re-correr la simulación de §2.1/§2.3 del plan** (los 6 nombres reales
   más "rin delantero bera kavak") llamando a `buscar_productos` DIRECTO
   contra el catálogo real, ya con la función en producción, y comparar
   contra la simulación vieja (la que midió 7 fallas de 16). Ver
   `docs/entregas/2026-09-26-la-busqueda-encuentra.md` para las consultas
   SQL exactas y cómo contar genérico/no_identificado sobre el resultado.
7. **Recién entonces** el operador enciende `buscar_repuesto` desde Control
   IA (interruptor por herramienta, `agent_tools`) — nunca antes: sin este
   orden, un catálogo real que todavía no se verificó contra la función
   nueva queda expuesto a los mismos 7 fallos de 16 que esta ola corrige.
8. **Medir 48 h** tras encender la herramienta: turnos que cotizan (con
   `TEXTO_CONFIRMAR_INVENTARIO`), turnos que preguntan (genérico,
   `PREGUNTA_FILTRO`/`PREGUNTA_FILTRO_PRODUCTO`), `no_identificado`,
   `log.warn("cifra_sin_fuente")` y 20 cotizaciones reales revisadas a mano
   contra el precio de Saint. Consultas concretas en la entrega.

**Sin variables de entorno nuevas.**

---

## Comprobación final

Con todo configurado, esta lista debe pasar entera:

- [ ] Una restauración de prueba devuelve los datos completos
- [ ] `npm run build` sin errores ni warnings
- [ ] `select count(*) from supabase_migrations.schema_migrations` devuelve 81 en LOCAL tras `20260926010000` ("La búsqueda encuentra lo que el cliente pide", 25-26/9/2026; ver §14) — 80 tras `20260925010000` ("El inventario llega de Saint y no se toca a mano", 25/9/2026; ver §13), 79 tras `20260921040000` ("Nada se pierde en un corte ni en un deploy", 22/9/2026; ver §12), 78 tras `20260921020000`/`20260921030000` ("La escalada se hace una vez y la búsqueda responde"), 76 el 21/9/2026 tras `20260921010000` ("El catálogo configurado sale siempre"), 75 el 19/9/2026 tras `20260918010000`/`20260918020000`, 73 el 18/9/2026 tras `20260916010000`/`20260917010000`/`20260917020000`, 70 el 15/9/2026 y 61 cuando se escribió esta guía. **El número en PRODUCCIÓN depende de cuántas de estas corridas ya se aplicaron allá — preguntar en qué commit está producción antes de asumir un valor (ver §11/§12/§13/§14).**
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
