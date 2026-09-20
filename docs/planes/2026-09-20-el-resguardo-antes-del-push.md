# Plan "El resguardo antes del push" (20/9/2026)

## Contexto

`main` local está 43 commits por delante de producción (`3802fad..003ada1`): cinco corridas
(La IA no vuelve a pedir · Seba atiende el mostrador · El precio en bolívares · Nada sin leer /
catálogo / Saint · Seba sale sin pisar a nadie), 5 migraciones, ~18.700 líneas. Después de este
push **no habrá actualizaciones por un tiempo**, así que el operador pidió asegurarse de que no
salga ninguna falla de lógica.

El inventario de hoy (tres exploradores, solo lectura, ~250 guardas revisadas) dice:

- La suite (2591) y los 17 tests SQL están en verde, pero **verde no es lo mismo que cubierto**:
  hay ~30 guardas sin test y ~20 con test débil (el test pasaría igual con la condición rota).
- **Rangos SIN revisión de código formal:** `6ea6877..c9b5959` ("Seba atiende el mostrador",
  10 commits, incluye las migraciones `20260917010000` y `20260917020000`), `eba9921`+`78b62b9`,
  y `824b56e` (T11) + `9888b40` (T12), escritos DESPUÉS de la revisión del 19/9.
- **Mutaciones planeadas que nunca se registraron como ejecutadas:** las de "Seba atiende el
  mostrador", "Nada sin leer…" y "El precio en bolívares".
- `scripts/sql/2026-09-18-catalogos-iniciales.sql` (611 líneas, 14 guardas) **no tiene ningún
  test automático**.

Resultado buscado: cada guarda crítica del rango tiene un test que **se rompe** cuando la guarda
se rompe; los rangos sin revisar quedan revisados; los flujos nuevos se ven funcionar de punta a
punta en local; y recién entonces se pasa a §11 (producción).

**Vocabulario (para no confundir):** en el código, "catálogo" nombra DOS cosas. (1) La
herramienta de búsqueda de Seba (`buildCatalogTool`, `CatalogOutcome`, "red de seguridad") —
eso **ES el inventario**: consulta `products` (`tools.ts:234`), la misma tabla de la sección
Inventario. En este plan se la llama **"búsqueda en inventario"**. (2) Los **enlaces de
catálogo** (`catalog_links`, marcadores `{{catalogo:…}}`): URLs a los PDF de Drive que mandan
escenarios y mensajes rápidos; Seba NO cotiza desde ahí. La regla H1 (`cedeAlCatalogo`)
garantiza que una consulta de repuesto vaya al inventario y no al PDF.

**Regla de oro de esta corrida:** no se toca código de producción salvo que aparezca un bug
real. Si aparece: se frena, se le muestra al operador el test que lo demuestra, y el arreglo
entra con su propio mini-plan. Lo demás son tests, y documentación.

---

## Tanda 0 — Preparación (orquestador)

1. Guardar este plan en `docs/planes/2026-09-20-el-resguardo-antes-del-push.md`.
2. Rama `resguardo-antes-del-push` desde `003ada1` (main no se toca hasta el final).
3. Entorno: Docker Desktop → esperar 1 min → `docker start sbk_redis` → base local arriba.
4. Línea base: `rtk npm run test` (con Redis), `rtk npx tsc --noEmit`, `rtk npm run lint`.
   Si algo está rojo ANTES de empezar, se resuelve primero.

## Tanda 1 — Revisión de código de los rangos sin revisar (3 subagentes en paralelo, solo lectura)

Cada revisor recibe su rango, busca **bugs de lógica con escenario de falla concreto** (entrada →
resultado malo), y contrasta contra las trampas de `CLAUDE.md` y la invariante "ningún lead
invisible". No proponen estilo. El orquestador verifica cada hallazgo contra el código antes de
aceptarlo (los falsos positivos se descartan con su razón).

| Revisor | Rango | Foco |
|---|---|---|
| R1 | `6ea6877..c9b5959` — código (`agent.ts`, `escalate.ts`, `tools.ts`, `seba.ts`, `prompt.ts`, `lessons.ts`, `human-handled.ts`, webhook, modal "Enseñar a Seba", panel de lecciones) | presentación por código, red del catálogo, escalada viva, reapertura, H1/H2 |
| R2 | `6ea6877..c9b5959` — SQL (`20260917010000`, `20260917020000` y sus tests) tal como quedaron tras `d9091e0` | triggers, backfill de ~17 mil filas, RLS de `ai_lessons`, los dos revokes |
| R3 | `824b56e`, `9888b40`, `eba9921`, `78b62b9` | T11 (cinco condiciones), T12 (reintento, recorte del saludo, turno espurio), precio solo lectura |

Salida: lista de hallazgos CONFIRMADO / PLAUSIBLE / DESCARTADO. Los confirmados pasan al
operador antes de seguir (decide: corregir ahora con mini-plan, o aceptar por escrito).

## Tanda 2 — Matriz de mutaciones (subagentes `implementador`, sin commit)

**Protocolo por mutación** (convención del repo): `cp` del archivo al scratchpad → aplicar UNA
mutación → correr SOLO el archivo de test indicado (`rtk npx vitest run <ruta>`) → anotar
**MUERE** (test rojo, bien) o **SOBREVIVE** (verde, hueco) → restaurar desde la copia (nunca
`git checkout --`) → `git diff --quiet` debe dar limpio antes de la siguiente. Redis arriba
siempre (`queue.test.ts`/`redis-queue.test.ts` se saltan enteros sin él).
Para SQL: `create or replace` de la función mutada (o `alter table` del CHECK) sobre la base
local → correr el test SQL (receta `tar | docker exec` + `MSYS_NO_PATHCONV=1`, `psql -1 -v
ON_ERROR_STOP=1`) → restaurar; al cerrar la tanda, `npx supabase db reset` + los 17 tests.

M1 y M3 corren en paralelo (no comparten archivos); M2 después de M1.

### M1 — `src/lib/ai/` + webhook (~40 mutaciones)
Primero las que DEBEN morir (confirman que los tests valen):
apertura `!ai_enabled` · throw `turno_conversacion_no_consultable` · sello `<=`→`<` ·
`claimPresentation` sin `.is(null)` · las dos reversiones del sello · `soloSaludo` `.every`→`.some` ·
`isAutoReply: !soloSaludo` · recorte T12 sin `historyCreatedAt.pop()` · espurio antes que cortesía ·
cortesía `.every`→`.some` y sin `escalationOpen` · red de seguridad de la búsqueda en inventario
sin `!generico` / sin `!escalated` · `cedeAlCatalogo` sin `classified.ok` (H1: el inventario le
gana al escenario con el PDF) · los dos `ProviderFailedAfterGreetingError` ·
`customerBurst` (constante 10, `>`→`>=`, sticker `continue`→`break`, sin-fecha) · `alreadyAssigned`
sin `return` · escalada reañadiendo `ai_enabled:false` · sacar `reabierto` / meter `devuelto_a_ia`
en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` · reconciler: cada término del `.or` y
`new_since_ai_resume` · `humanClaimsChat` `<=`→`<` y orden de los dos `if` · playbooks sin el
descarte de marcador · `tools.ts` `>3`→`>=3`, sin `!motoBrand`, `stock>0`→`>=0` · `expandTerms`
inactivos · `fetchTurnLessons`/`fetchTurnCatalogLinks` sin try/catch · `isSebaGreeting` `===`→
`includes` · `cacheablePrefix` siempre con bloque · webhook: sin `.eq("status","closed")`, sin
`welcome_sent_at:null`.
Después las SOSPECHOSAS de sobrevivir (el explorador las marcó; hay que confirmarlo):
`isAutoReply: esperandoAsesor` de fuera de tema (`agent.ts:1849`) · orden `pausada`→sello ·
`stageFor` revertido solo en `"classifying"`/`"tool_running"` · precedencia del motivo de la
búsqueda en inventario con dos banderas · rama texto vacío → `textoFijo` · `!generico && hayMas` ·
`(?!seba\b)` sin `\b` ("Sebastián") · reapertura más reciente (`ascending`, `> previo`) ·
`.eq("kind","nota")` de lecciones · topes 15/5/200 y `MAX_SYNONYM_LESSONS` · `rankByTerms`
con `terms` · `PALABRAS_SALUDO` sin "buenos"/"dias" · rama de error de `claimPresentation`.

### M2 — `mutations.ts`, `data.ts`, filtros, venta, catálogos, UI (~35 mutaciones)
Deben morir: `silenceAiForManualTakeover` (sin reintento, `if(error) return`, compensar a `null`,
`throw compensationError`, fusionar los dos UPDATE) · las cinco condiciones de
`reenableAiIfAdvisorNeverWrote` una por una + quitar el try/catch + fusionar el UPDATE ·
`setAiEnabled` · `validateSaleCart` después del insert · segunda barrera de `validateSaleDraft` ·
`dayCutGroup` a 3 términos · `unread` cruzando el día · `passesDayCut` (sin `isUnread`, `keepId`
sin comparar id) · `unansweredFreeWork` sin cada filtro · `resolveCatalogMarkers` (sin filtro de
activos, `return ""`, cero activos, sin reset de `lastIndex`, sin flag `g`) · `KEY_PATTERN` sin
anclas · `readListIfTableExists` (`return []` incondicional, código extra en el Set) · `error.tsx`
con tercer hijo · modal de venta (reseteo al reabrir, `clearFieldError` que limpia todo, sin
`return` tras validar) · composer pegando el crudo · panel de catálogos (clave editable, sin
confirmación al desactivar) · `puedeAdministrar` · `priceDisplay` `rate>=0`.
Sospechosas de sobrevivir: **`.gte("created_at", assignedAt)`→`.lte`/`.eq` en
`aiWasSilencedByThisTakeover` y `advisorWroteToCustomerSince`** (el fake no distingue operador —
es la condición más delicada de T11) · `.limit(1)`→`.limit(0)` · **quitar el `.eq("id", …)` de los
UPDATE** (el fake ignora argumentos) · `wouldEmptyList` → `true` · `otherLinks = links` ·
`waitingForHuman={false}` en `chat-panel.tsx` · envolver la lectura equivocada en
`agent-control/page.tsx` · `fetchCatalogLinks` → `return []` · `URL_SCHEME_PATTERN` sin `^` ·
`.slice(0,60)` · `saint_invoice_number` fuera del `select` de Ventas · rama `attachmentUrl` del
badge y de `usageOf`.

### M3 — SQL y script de catálogos (~25 mutaciones + 6 corridas negativas)
Deben morir: `>`→`>=` de `new_since_ai_resume` · sello con `now()` · `v_to_kind` sin `closed`
primero · `reclamado` sin `auth.uid() is not null` · `silenciada_por_asesor` sin `IS NOT DISTINCT
FROM` · trigger de silencio sin `sender_type='agent'` / sin `not is_internal_note` · backfill sin
`has_reply` · RLS insert de lecciones sin `created_by = auth.uid()` · RLS de `catalog_links` a
`is_agent()` · CHECKs de Saint (1→0, 40→41, sin `btrim`) · `unique` de `key` · publicación Realtime.
Sospechosas de sobrevivir: **`revoke … from anon` sin `authenticated` en `20260916010000:198,407`**
(los tres chequeos solo miran `anon`) · **`and ai_enabled` del trigger de silencio** (¿doble fila
por cada mensaje del asesor?) · `direction = 'outbound'` · `from_kind` de `silenciada_por_asesor`
invertido · ramas `last_message_at`/`created_at` del COALESCE del backfill · RLS update de
lecciones sin `or created_by = auth.uid()` · RLS select `using (true)` · `unique` añadido a Saint
(viola D9) · topes de `label`/`message_excerpt` · `set search_path`.
Script de catálogos — corridas negativas contra base local en estado de producción
(`db reset --version 20260915010000` + las 5 migraciones): (a) con huecos `<<…>>` → aborta;
(b) `id` inexistente → aborta por `row_count`; (c) clave existente e INACTIVA → aborta (3b);
(d) marcador mal escrito en un texto de relleno → aborta (2c); (e) corrida completa válida → OK;
(f) segunda corrida → idempotente, NOTICE, no pisa. Cada corrida verifica que la transacción
no dejó nada a medias.

**Salida de la Tanda 2:** una tabla única MUERE / SOBREVIVE / EQUIVALENTE (con su razón). Los
mutantes equivalentes ya conocidos (`not (old…)` del BEFORE, `String(code)`) se anotan, no se
persiguen.

## Tanda 3 — Cerrar los huecos (subagentes `implementador`, SOLO tests)

Por cada SOBREVIVE y cada "sin test" con riesgo real: escribir el test al lado del módulo →
verlo verde → **volver a aplicar la mutación y verlo rojo** → restaurar. Tres tareas, mismos
cortes que M1/M2/M3. Mínimo obligatorio (si el explorador tenía razón):

- **T3-a (`lib/ai`)**: fuera de tema con asesor sale `is_auto_reply`; `pausada` gana al sello;
  chat asignado nunca escribe `classifying`/`tool_running`; motivo con `conExistencia` + otra
  bandera; red de la búsqueda en inventario con texto vacío; genérico sin `RECORTE_INSTRUCTION`; "mi nombre es
  Sebastián" bloqueado; dos reaperturas (unitaria y en lote); lecciones no dejan pasar sinónimos
  al prompt; "buenos días"/"buenas noches"/"saludos" pelados son solo-saludo; error al reclamar
  la presentación.
- **T3-b (datos/UI)**: endurecer los fakes de `mutations.test.ts` para que registren **operador y
  argumentos** (`eq`/`gte`/`limit`) y assertar `.eq("id", conversationId)` en cada UPDATE;
  `wouldEmptyList` con dos activos; editar un enlace sin cambiar la clave guarda sin "clave
  repetida"; `chat-panel` pasa `waitingForHuman` real; `page.tsx` envuelve exactamente
  `fetchLessons` y `fetchCatalogLinks`; `fetchCatalogLinks` lanza; URL con texto delante se
  rechaza; recorte a 60; `mapSale` con y sin orden.
- **T3-c (SQL)**: casos nuevos en `devolucion_a_la_ia.sql` (ni `anon` ni `authenticated` ejecutan
  las dos funciones), `seba_y_escalada_viva.sql` (dos mensajes del asesor = UNA fila; entrante
  con `sender_type='agent'` no apaga; `from_kind`; backfill por `last_message_at` y por
  `created_at`), `ai_lessons.sql` (el autor edita lo suyo; bordes 200/vacío; sinónimo sin
  `synonym_from`), `factura_saint.sql` (dos órdenes con el mismo número; borde 40),
  `catalog_links.sql` (clave de 31, guion bajo). Si algún caso nuevo sale ROJO contra la
  migración real → es un bug: se frena y se escala (las 5 migraciones aún no están en
  producción, se pueden corregir in situ, en commit `[migración]` aparte).

Lo que se ACEPTA sin test (se documenta, no se persigue): import de `dashboard.css` y `flushSync`
(jsdom no los ve — se cubren en la Tanda 4), logs sin efecto, `set search_path`, `lock_timeout` y
`notify pgrst` (los cubre el ensayo de §11 ya hecho).

## Tanda 4 — Escenarios de punta a punta en local (orquestador + operador)

Webhook local por el canal `mock-phone-id-soporte` (envío simulado), app en Brave con la
**pestaña al frente**. Se verifica en la base (`messages`, `conversation_handoffs`,
`conversations`) además de la pantalla:

1. Lead nuevo "hola" → solo el saludo de Seba, `welcome_sent_at` sellado, `awaiting_reply` apagado.
2. "Precio del casco LS2" + "Buenas tardes" → saludo + respuesta real (no solo saludo).
3. **Consulta con producto que SÍ existe en Inventario y con stock** (nunca se vio en vivo) →
   Seba lo cotiza con el nombre/precio de `products` (NO manda el PDF), texto fijo "confirmar
   inventario" + escalada; Seba sigue encendida; `is_auto_reply`.
3b. La misma consulta con un escenario "Catálogo general" activo que calce → gana el inventario
   (`escenario_cedido_al_catalogo` en el log), el PDF no sale.
4. Producto con stock 0 → texto "sin stock" + escalada. Consulta genérica → UNA pregunta, sin escalar.
5. Segunda consulta en el chat ya escalado → no cambia de asesor, solo nota de reiteración.
6. El asesor escribe → `ai_enabled=false` + una sola fila `silenciada_por_asesor`; segundo mensaje → ninguna fila más.
7. "Asignarme" → Seba apagada; "Desasignar" sin escribir → Seba encendida y sello; el mensaje previo cae en "Sin dueño".
8. Cerrar chat → el cliente escribe → reabre, Seba se presenta de nuevo, sin gracia de 30 min.
9. "gracias" con escalada abierta → silencio + `cortesia_tras_escalada`.
10. Proveedor caído tras el saludo (clave inválida temporal en `.env.local`) → reintento solo, sin segundo saludo; al restaurar la clave, responde.
11. Escenario con `{{catalogo:cascos}}` → sale la URL; clave apagada → el escenario no sale.
12. Cerrar venta: nueve errores por campo → con Saint → chip en Ventas.
13. **Como SUPERVISOR** (pendiente del 19/9): crear/editar/desactivar/borrar enlace e "Insertar catálogo".
14. Las seis secciones sin grid desarmado; `error.tsx` de Control IA y Ventas (forzando un error) en **build de producción** (`rtk proxy npm run build` + `npm start`), que es donde importa el CSS.

## Tanda 5 — Cierre (orquestador)

1. Suite completa con Redis, `tsc`, `lint`, `rtk proxy npm run build` (verificar `.next/BUILD_ID`),
   `db reset` + todos los tests SQL, réplica del CI en `node:22` sobre clon limpio.
2. Commits narrativos en español, tests por área; cualquier corrección de código o `[migración]`
   en commit aparte. Rama subida + rama desechable `ci/**` para ver el **CI real en verde**.
3. Documentación: tabla de mutaciones en `docs/entregas/2026-09-19-…` (sección nueva), trampas
   nuevas en `CLAUDE.md` si aparecen (p. ej. "los fakes de `mutations.test.ts` no distinguían
   operador"), `docs/GLOSARIO.md` si nace algún archivo de test nuevo, memoria del proyecto.
4. Fusionar la rama a `main` local. **Sin push**: el push sigue siendo el paso 7 de §11, con el
   Claude del VPS y las migraciones aplicadas antes.

## Criterio de "listo para §11"

- 0 mutantes vivos en la lista obligatoria (o aceptados por escrito por el operador, uno por uno).
- 0 hallazgos CONFIRMADOS de la Tanda 1 sin resolver o sin aceptar.
- Los 14 escenarios de la Tanda 4 vistos y anotados.
- Todo lo de la Tanda 5.1 en verde + CI real en verde sobre el commit final.

## Archivos que se tocan

Solo tests y docs, salvo bug: `src/lib/ai/*.test.ts`, `src/lib/mutations.test.ts`,
`src/lib/catalog-links.test.ts`, `src/lib/data-*.test.ts`, tests de
`src/components/{chat,agent-control}/`, `src/app/agent-control/` (test nuevo del cableado),
`supabase/tests/{devolucion_a_la_ia,seba_y_escalada_viva,ai_lessons,catalog_links,factura_saint}.sql`,
`docs/planes/`, `docs/entregas/`, `CLAUDE.md`, `docs/GLOSARIO.md`.

## Skills y modelos

Orquestador: Fable, razonamiento alto. Subagentes `implementador` (Sonnet) para M1–M3 y T3-a/b/c;
revisores R1–R3 de solo lectura. Skills: `superpowers:verification-before-completion` antes de
declarar cada tanda cerrada; `superpowers:systematic-debugging` si aparece un bug;
`code-review high` como segunda pasada si la Tanda 1 encuentra algo serio.

## Lo que este plan NO hace

No agrega Stryker ni tests a los 64 archivos heredados sin test hermano (`customers-data`,
`inventory-data`, `turn-target`…): no cambian en este rango; quedan para una corrida posterior.
No rota la clave de OpenRouter (solo el operador). No ejecuta §11.

---

## Anexo — Correcciones de la Tanda 1 (aprobadas por el operador el 20/9/2026: "los diez, A–J")

La revisión de código de los rangos sin revisar encontró diez fallas de lógica. Se corrigen ANTES
de la matriz de mutaciones (tocan los mismos archivos). Cada una: test que falla primero →
arreglo mínimo → test verde → mutación de verificación con respaldo `cp`. Un subagente por grupo
de archivos, sin commit; el orquestador valida y commitea.

| Tarea | Hallazgos | Archivos |
|---|---|---|
| C1 | **A** — el reconciliador reencola cada minuto el chat que el turno calló por cortesía tras una escalada sin asesor (y cualquier otra salida silenciosa con traspaso posterior al último mensaje del cliente) | `src/lib/ai/reconciler.ts`, `src/lib/ai/handoffs.ts`, sus tests |
| C2 | **C** — turno con texto vacío tras el saludo de Seba queda mudo y sin rastro · **G** — sello de presentación sin saludo si algo lanza entre el reclamo y el envío | `src/lib/ai/agent.ts`, `agent.test.ts` |
| C3 | **D** — el UPDATE que reenciende a Seba al desasignar no condiciona `assigned_agent_id is null` ni `status` · **E** — queja en chat ya asignado sin etiqueta "Reclamo" · **F** — sinónimo "solo este chat" aplicado a todos · **I** — contador de fallos de la cola sin limpiar al abandonar | `src/lib/mutations.ts`, `src/lib/ai/escalate.ts`, `src/lib/ai/tools.ts`, `src/lib/ai/queue.ts`, sus tests |
| C4 | **H** — la reapertura de un chat cerrado corre antes del dedupe por `wamid` | `src/app/api/webhooks/whatsapp/route.ts` y sus tres tests espejo |
| C5 | **B** — interbloqueo de `20260917010000` con el webhook en vivo (backfill antes del DDL sobre `messages`); ensayar también el gemelo plausible de `20260916010000` · **J** — guarda de prerrequisito | las dos migraciones (in situ: no están aplicadas en producción), sus tests SQL, `docs/PRODUCCION.md` §11 |

Menores verificados que se DOCUMENTAN sin corregir: mensaje de asesor `failed` que igual apaga a
Seba; sinónimo de varias palabras o <3 letras que nunca calza; nota interna que calla a Seba 30
min (preexistente); toast de error de lecciones si falla el refresco; bitácora doble en la
compensación de T10; el límite aceptado de T11 es más amplio de lo escrito (una sola pausa manual
en un chat escalado basta).
