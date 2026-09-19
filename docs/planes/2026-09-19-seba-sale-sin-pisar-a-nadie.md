# Plan "Seba sale sin pisar a nadie" — 19/9/2026

Correcciones previas al push de `3802fad..def7484` (31 commits, 5 migraciones:
`20260916010000`, `20260917010000`, `20260917020000`, `20260918010000`,
`20260918020000`). Nace de la inspección pre-despliegue del 19/9/2026 (tres
auditorías de solo lectura). Nada de este rango salió de esta máquina ni pasó
por el CI; producción sigue en `3802fad` con la base en `20260915010000`.

**Estado: APROBADO por el operador el 19/9/2026 (tras el corte de luz), con
D-A = SÍ, D-B = `entrega_fallida`, D-C = no pisar + NOTICE. En ejecución.**

## 1. Qué se corrige y qué no

Cada hallazgo se volvió a verificar contra el código el 19/9 antes de escribir
este plan:

| # | Hallazgo | Verificado en | Sale como |
|---|---|---|---|
| C1 | Seba habla encima de asesores en chats tomados a mano | `mutations.ts:183-195` y `:232-244` solo escriben `assigned_agent_id`; la guarda de apertura es `if (!convo.ai_enabled)` | Operación (UPDATE único) + **T10** (decisión D-A) |
| C2 | IA muda sin rastro si falta `20260916010000` | `agent.ts:2026` desestructura `{ data: conversation }` sin `error` | **T1** + comprobación previa al push |
| A1 | Seba se presenta a mitad de conversación | backfill de `welcome_sent_at` corre una vez; el código viejo no sella | Operación (backfill acotado tras el deploy) + **T9** |
| A2 | Proveedor falla después del saludo → lead sin respuesta ni traspaso | `agent.ts:1636-1643` y `:1798-1812`: `return` sin traspaso; comentarios "el reconciliador la recoge sola" ya falsos | **T2** |
| A3 | Pregunta perdida en una ráfaga | `lastCustomerMessage` (`agent.ts:289`) devuelve solo la última línea; la usan `soloSaludo` (`:1332`) **y la guarda de cortesía** (`:1421`) | **T3** |
| A4 | `/agent-control` y `/ventas` dan 500 | no existe ningún `error.tsx` en `src/app`; `agent-control/page.tsx` hace 19 lecturas en un `Promise.all` | **T7** |
| A5 | Tres migraciones sin `lock_timeout` | `grep`: `20260917020000`, `20260918010000`, `20260918020000` = 0 | **T5** |
| A6 | CI rojo | `seed.sql:129/136` (saliente de asesor) + `traspaso_sin_contenido_legible.sql:122` (`\i` de la migración con el CHECK viejo) | **T4** |
| A7 | Pregunta de filtro en productos universales | — | Operación: lección global el primer día (sin código) |
| A8 | "Pásame el catálogo" cedido al catálogo de productos (sospecha) | — | Operación: medir antes; vigilar `escenario_cedido_al_catalogo` |
| M1 | Ninguna de las cinco trae `notify pgrst` | `grep` = 0 en las cinco | **T5** |
| M2 | Script de catálogos frágil | `scripts/sql/2026-09-18-catalogos-iniciales.sql`: sin `on conflict`, sin aserción de claves, sin `attachment_url` | **T6** |
| M3 | El apagado por mensaje de asesor empieza al migrar | — | **T9** (aviso al equipo) |
| M4 | Gasto y bitácora con el tope alcanzado | — | Operación (subir tope) + **T9** |
| M5 | Backfill = ~17 mil eventos de Realtime | — | **T9** (fuera de hora pico + `vacuum analyze`) |
| M6 | `reabierto` cierra la escalada | `handoffs.ts:324-332` no lo incluye | **T8** |

Hallazgo nuevo de esta verificación (no estaba en el informe): la guarda de
cortesía tras escalada tiene el **mismo** defecto de ráfaga que `soloSaludo`
— "¿tienen la bomba de aceite?" seguido de "gracias" con una escalada abierta
calla el turno entero. Entra en T3 con el mismo helper.

## 2. Decisiones que necesito del operador

**D-A (recomiendo SÍ).** Que "Asignarme" e "Intervenir" apaguen a Seba en ese
chat. El UPDATE de C1 silencia los chats tomados a mano *hasta hoy*, pero
después del deploy un asesor que pulse "Intervenir" y tarde dos minutos en
escribir vería a Seba contestar primero: antes el turno cortaba por `asignada`
y ahora no corta. El requisito 6 del cliente ("Seba sigue hasta que el asesor
escriba") habla de los chats que **Seba escaló**, no de los que una persona
tomó por su cuenta. Sin D-A, el UPDATE de C1 y el comportamiento futuro se
contradicen. El asesor puede reencender a Seba con el interruptor del chat.

**D-B (recomiendo `entrega_fallida`).** Razón del traspaso de T2. No existe una
razón "falló el proveedor". `entrega_fallida` ya significa "falló después de
haber intentado entregar y no se reintenta para no duplicar", que es
exactamente el caso (el saludo ya salió). La alternativa —una razón nueva—
exige una sexta migración con su CHECK, y no la vale.

**D-C (recomiendo `do nothing` + aviso).** En T6, si una clave de catálogo ya
existe (un supervisor la creó desde el panel), el script **no la pisa**: los
IDs de Drive rotan y la del panel puede ser la más nueva. Emite un `NOTICE`
con cada clave saltada y su URL actual para que el Claude del VPS decida.

## 3. Tareas

Orden y paralelismo: `T1 → T2 → T3` en serie (las tres tocan `agent.ts`; regla
del `cp` de respaldo antes de cualquier mutación). En paralelo con esa cadena:
`T8`, `T6`, `T7`, `T10`. Después `T5 → T4` en serie (T4 se valida reconstruyendo
la base desde cero con las migraciones ya editadas por T5). `T9` al final.
Un subagente `implementador` por tarea; ninguno commitea.

### T1 — El turno lanza si no puede leer la conversación (C2)
- **Archivos:** `src/lib/ai/agent.ts`, `src/lib/ai/agent.test.ts`.
- **Cambio:** desestructurar `{ data: conversation, error: conversationError }`;
  si hay error → `log.error("turno_conversacion_no_consultable", { conversationId,
  detail: errorText(error) })` + `throw`. Mismo patrón y misma posición que
  `turno_interruptor_no_consultable` (antes de `entrega.intentado`, así la cola
  reintenta sin riesgo de doble envío). `data === null` **sin** error sigue por
  la rama actual "la conversación no existe".
- **Tests:** (1) la consulta devuelve `error` → `runAgentTurn` rechaza, no se
  envía nada, no se escribe traspaso; (2) `data: null` sin error → sale como hoy.
- **Mutación:** quitar el `throw` → el test 1 debe ponerse rojo.

### T2 — Un fallo del proveedor después del saludo deja traspaso (A2)
- **Archivos:** `agent.ts`, `agent.test.ts`.
- **Cambio:** en las dos salidas (`!classified.ok` y el `catch` del tool loop),
  **solo si `introducedThisTurn`**: `recordHandoff` con `reason:
  "entrega_fallida"` (D-B), `toKind`/`toId` según `convo.assigned_agent_id`
  (`human` o `unassigned`), igual que la guarda de cortesía. Sin el saludo el
  último mensaje sigue siendo del cliente y el reconciliador lo recoge como
  siempre: ahí no se escribe nada nuevo. Reescribir los dos comentarios
  ("el reconciliador la recoge sola") contando por qué dejó de ser cierto tras
  el saludo (predicado `last_message_direction`), y revisar el de `:680`.
- **Tests:** por cada salida, con saludo → una fila `entrega_fallida`; sin
  saludo → ninguna fila nueva.
- **A comprobar por el subagente:** que ninguna etiqueta de la UI pinte
  `entrega_fallida` con un texto que aquí resulte engañoso; si lo hace, lo
  reporta sin tocarlo.

### T3 — El saludo y la cortesía miran la ráfaga entera (A3)
- **Archivos:** `src/lib/ai/history-line.ts` (+ test) o `saludo.ts` — donde
  calce mejor; `agent.ts`, `agent.test.ts`.
- **Cambio:** helper puro `customerBurst(history): string[]` = las líneas `user`
  consecutivas desde el final hasta la última línea que no sea del cliente.
  `soloSaludo` pasa a ser "la ráfaga no está vacía y **todas** sus líneas son
  `isGreetingOnly || isCourtesyOnly`" (un marcador de media no lo es → el turno
  sigue y `MEDIA_RULES` hace su trabajo). La guarda de cortesía: "**todas** las
  líneas de la ráfaga son `isCourtesyOnly`". `customerMessage` no cambia de
  significado para la bitácora.
- **Tests:** "Precio del casco LS2" + "Buenas tardes" → no es solo saludo, el
  turno llega a clasificar; "hola" + "buenas" → sigue siendo solo saludo; foto
  sin pie + "hola" → no es solo saludo; pregunta + "gracias" con escalada
  abierta → no se calla; tests del helper con historial vacío y con respuesta
  intermedia de la IA.
- **Mutación:** volver a mirar solo la última línea → el primer test rojo.

### T8 — `reabierto` no cierra la escalada (M6)
- **Archivos:** `src/lib/ai/handoffs.ts`, `handoffs.test.ts`.
- **Cambio:** sumar `"reabierto"` a `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` y a su
  comentario (la escribe el reconciliador por mensaje, sin cambiar de dueño).
- **Test:** `escalada_sin_asesor` → `reabierto` → `escalationOpen` da `true`.

### T10 — Tomar un chat a mano apaga a Seba (C1 hacia adelante; solo con D-A)
- **Archivos:** `src/lib/mutations.ts` (+ su test), `tests/seba_y_escalada_viva.sql`
  si hace falta un caso.
- **Cambio:** `assignToMe` e `intervene` hacen **dos** UPDATE en serie: primero
  `assigned_agent_id`, después `ai_enabled = false`. Tienen que ser dos: el
  trigger `handle_conversation_ownership_change` escribe `reclamado` solo si
  `ai_enabled` no cambia en el mismo UPDATE, y `silenciada_por_asesor` solo si
  `assigned_agent_id` no cambia; un UPDATE conjunto no dejaría **ninguna** fila
  (la invariante "ningún lead invisible" lo prohíbe). Si el segundo falla, se
  lanza: el chat queda asignado y el asesor ve el error.
- **Tests:** unitario del orden y de los dos UPDATE; caso SQL: asignar y apagar
  en dos sentencias con sesión deja `reclamado` y luego `silenciada_por_asesor`.

### T6 — Script de catálogos endurecido (M2)
- **Archivo:** `scripts/sql/2026-09-18-catalogos-iniciales.sql` (y su prueba, si
  `tests/catalog_links.sql` lo ejercita).
- **Cambio:** `\set ON_ERROR_STOP on` dentro del propio archivo (una comilla
  simple ya no da falso éxito con `rc=0`) y los huecos de texto entre
  `$txt$…$txt$`; aserción de que **toda** clave `{{catalogo:<key>}}` de los
  textos nuevos existe en `_catalogo_valores` o ya está activa en
  `catalog_links` (hoy da "verificado" con una clave inexistente);
  `on conflict (key) do nothing` + `NOTICE` por clave saltada (D-C), para que
  una segunda corrida no muera con `duplicate key`; la verificación final mira
  también `attachment_url` de escenarios y mensajes rápidos.
- **Verificación:** contra la base local, con los huecos rellenos de prueba:
  corrida limpia, segunda corrida, clave inexistente, texto con comilla simple,
  supervisor que ya creó `cascos`. Todo dentro de transacciones desechables.

### T7 — Control IA y Ventas no dan 500 a ciegas (A4)
- **Antes de escribir:** leer `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`
  (AGENTS.md: este Next no es el de memoria).
- **Archivos:** `src/app/agent-control/error.tsx`, `src/app/ventas/error.tsx`
  (+ tests), `src/app/agent-control/page.tsx`, `docs/GLOSARIO.md`.
- **Cambio:** (a) en Control IA, las dos lecturas **nuevas** (`fetchLessons`,
  `fetchCatalogLinks`) degradan a lista vacía con `console.error` en vez de
  tumbar las otras 17 — es lo que mantiene alcanzable el interruptor global,
  que un `error.tsx` solo no resuelve; (b) `error.tsx` en las dos rutas, en
  español, con "Reintentar" y el `AppRail`, respetando la grilla de dos columnas
  (trampa del fragmento, 9/9/2026). En Ventas no hay degradación posible: la
  columna `saint_invoice_number` va dentro del `select`.
- **Verificación visual obligatoria en Brave** (jsdom no calcula layout):
  provocar el error en local y mirar las dos pantallas.

### T5 — Las cinco migraciones se protegen y avisan a PostgREST (A5, M1)
- **Archivos:** las tres sin `lock_timeout` ganan `set local lock_timeout =
  '5s'` al inicio; las cinco terminan en `notify pgrst, 'reload schema'`. Se
  pueden editar porque ninguna salió de esta máquina. **Commit aparte con
  `[migración]` en el título.**
- **Verificación:** la de T4 (base desde cero).

### T4 — El job `migraciones` del CI vuelve a verde (A6)
- **Archivo:** `supabase/tests/traspaso_sin_contenido_legible.sql`.
- **Cambio:** dentro de su transacción (termina en `rollback`), antes del `\i`,
  borrar de `conversation_handoffs` las filas cuya razón no existía en el CHECK
  de `20260908010000` — las deja el seed al disparar triggers posteriores. El
  test sigue probando lo que probaba (backfill + idempotencia del CHECK).
- **Verificación:** reconstruir la base local desde cero (migraciones + seeds,
  vía `docker exec`; la CLI de supabase falla en esta máquina) y correr los 18
  archivos de `supabase/tests/` en el orden del CI, todos con `ON_ERROR_STOP=1`.

### T9 — La documentación y la entrega cuentan el orden corregido
- **Archivos:** `docs/PRODUCCION.md`, `CLAUDE.md` (trampas nuevas: C1/D-A, C2,
  traspaso tras saludo, ráfaga, `reabierto`), `docs/GLOSARIO.md`, reporte de
  entrega por commit para el Claude del VPS.
- **Contenido:** el orden de once pasos de la inspección, con las consultas
  literales: medición de C1 (`select count(*) … where status <> 'closed' and
  assigned_agent_id is not null and ai_enabled`), chats con `has_reply` y
  `welcome_sent_at is null`, transacciones largas (`pg_stat_activity`), tope de
  gasto; `PGOPTIONS="-c lock_timeout=5s"` + `psql -1 -v ON_ERROR_STOP=1`; el
  UPDATE de C1; los dos GET de humo; la comprobación única de tablas/columnas/
  trigger **antes** del push; el backfill acotado de `welcome_sent_at` tras el
  deploy + `vacuum analyze`; el aviso al equipo **al migrar**; subir el tope; el
  texto de la lección global (productos universales); la medición de "pásame el
  catálogo" sobre los últimos 100 calces de "Catálogo general".
- **Erratas:** la de `welcome_sent_at` (PRODUCCION.md afirma que no hay ventana
  de saludo) está localizada. La segunda no quedó escrita en la memoria de la
  inspección; candidata: `PRODUCCION.md:300` ("después de `20260916010000` y
  antes de `20260915010000`"). Se confirma al ejecutar T9; si no aparece, se
  reporta así, sin inventarla.

## 4. Criterio de terminado

1. `rtk npm run test` en verde (con Redis levantado: `queue.test.ts` se salta
   entero sin él), `rtk npx tsc --noEmit`, `rtk npm run lint`,
   `rtk proxy npm run build` con `.next/BUILD_ID` nuevo.
2. Los 18 tests SQL en verde sobre una base reconstruida desde cero.
3. Las tres mutaciones (T1, T2 opcional, T3) rompen su test.
4. Verificación visual de T7 en Brave.
5. Commits narrativos en español; T5 aparte con `[migración]`. **Sin push**: el
   push es el paso 7 del orden de despliegue y lo decide el operador con el
   Claude del VPS, después de las mediciones.
6. Tras el push, mirar el CI (API pública de GitHub): Dokploy despliega aunque
   esté rojo.

## 5. Skills sugeridas

`superpowers:test-driven-development` para T1–T3 y T8 (el test rojo primero);
`superpowers:verification-before-completion` al cerrar; `code-review high`
sobre el diff completo antes de redactar la entrega.

## 6. Correcciones post-revisión (19/9/2026)

Después de T9 (documentación de T1-T10), una revisión `/code-review high`
sobre el diff COMPLETO de este plan encontró 10 hallazgos más. Ocho se
corrigieron en código, dentro de los diffs ya existentes de T3/T5/T6/T7/T10
(sin commit propio nuevo). Dos quedan como decisiones de diseño para el
operador, sin corregir (sección siguiente).

**Nota al cerrar T9b:** mientras se escribía esta documentación, el
orquestador ya había commiteado el Grupo E completo (7 commits,
`6cc62ae..8bc3997`, sobre `def7484`) — la columna "Commit" de abajo trae
los hashes reales, confirmados leyendo cada mensaje de commit, no
adivinados. **T1, T2 y T3 del plan quedaron en UN SOLO commit** (`6cc62ae`)
junto con los hallazgos 4, 8 y 9 — no en tres commits separados como
sugiere la sección 3 de este plan; el mensaje de ese commit lo dice
explícito ("T1, T2 y T3 del plan... más los hallazgos 4, 8 y 9"). El
reporte de entrega (`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`)
sigue documentando T1/T2/T3 en tres secciones separadas (así lo pedía el
plan original), cada una con el mismo hash `6cc62ae` — no son tres commits.

| Hallazgo | Corrección | Tarea que la contiene | Commit | Estado |
|---|---|---|---|---|
| 3 | `silenceAiForManualTakeover` (T10) lanzaba directo si el segundo `UPDATE` fallaba, sin compensación — dejaba el chat ASIGNADO con Seba ENCENDIDA. Ahora reintenta UNA vez y, si vuelve a fallar, compensa devolviendo `assigned_agent_id` al valor previo antes de lanzar el error original. | T10 | `671bafe` | Corregido |
| 4 | `customerBurst` (T3) no acotaba la ráfaga por TIEMPO — un "hola" de hoy se pegaba a una pregunta sin responder de hace días en un chat cerrado sin respuesta (`pausada`). `CUSTOMER_BURST_GAP_MINUTES = 10` corta la ráfaga por hueco de tiempo entre líneas del cliente. | T1/T2/T3 | `6cc62ae` | Corregido |
| 5 | Los dos `error.tsx` (T7) dependían de que otro componente (que NO se monta cuando la página lanza) ya hubiera insertado `dashboard.css`. Import explícito de la hoja en los dos `error.tsx`. | T7 | `a6e5932` | Corregido |
| 6 | `readOptionalList` (T7) tragaba CUALQUIER error, degradando el panel a vacío incluso ante un timeout/5xx transitorio — pintaba "sin catálogos" como si fuera verdad. Renombrada `readListIfTableExists`: solo degrada con `42P01`/`PGRST205` (tabla no existe); cualquier otro error se relanza al boundary. | T7 | `a6e5932` | Corregido |
| 7a | El script de catálogos (T6) daba por resuelta cualquier clave presente en `_catalogo_valores`, pero el `on conflict do nothing` (D-C) puede dejarla EXISTENTE e INACTIVA sin tocar — nunca resolvería nada en producción. Sección 3b: aborta después del INSERT si alguna clave referenciada sigue sin estar ACTIVA. | T6 | `8bc3997` | Corregido |
| 7b | La aserción 2b del script (T6) solo detecta la forma ESTRICTA de un marcador — un marcador MAL ESCRITO (`{{catalogo:cascos_nuevos}}`, `{{catalogo: exploradoras y bombillos}}`) se le escapaba y habría llegado crudo al cliente. Sección 2c, espejo de `LOOSE_UNRESOLVED_MARKER`: aborta si algo no calza ninguna forma válida. | T6 | `8bc3997` | Corregido |
| 8 | Un STICKER del cliente hacía fallar el `every(isCourtesyOnly)` de la guarda de cortesía tras escalada (T3) — "gracias" + sticker dejaba pasar una segunda despedida encima de la primera. `customerBurst` salta el sticker sin contarlo ni cortar la ráfaga. | T1/T2/T3 | `6cc62ae` | Corregido |
| 9 | El comentario de `reconciler.ts` sobre el diseño descartado (`awaiting_any_reply`) no reflejaba todavía que `reabierto` (T8) ya no cierra la escalada — quedaba como si el caso 5 de la revisión adversarial del 16/9 siguiera abierto. Comentario actualizado con la referencia cruzada a T8/`RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`. **Va en el commit de T1/T2/T3, no en el de T8** (`68dacfb` solo toca `handoffs.ts`/su test). | T1/T2/T3 (comentario cruzado a T8) | `6cc62ae` | Corregido |
| 10 | Las cinco migraciones (T5) traían `set local lock_timeout` pero, sin `psql -1`, era un NO-OP SILENCIOSO — la migración "funcionaba" igual sin el freno de lock. Cada una gana un bloque que ABORTA si `current_setting('lock_timeout')` sigue en `'0'`/`'0ms'`. | T5 | `d9091e0` | Corregido |
| (sin número confirmado) | Tras el saludo de Seba, un fallo del proveedor deja `entrega_fallida` (T2) pero nada reintenta el turno — el chat queda esperando a un humano o a que el cliente vuelva a escribir. Reencolarlo reabriría la decisión D-B (`welcome_sent_at` ya sellado no volvería a saludar, pero sí repetiría fase 0/1/tool loop desde cero). | `ProviderFailedAfterGreetingError` (`turn-delivery.ts`) reemplaza el `recordHandoff(entrega_fallida)` de T2 en las dos salidas post-saludo; `runAgentTurn` la deja pasar tal cual (sin envolver en `NonRetryableTurnError`) y la cola la reintenta como cualquier fallo transitorio — el reintento reconoce el saludo ya enviado y no vuelve a saludar. | T12 | (sin commitear) | **Corregido (decisión #1 del operador — ver "Decisiones abiertas", más abajo, CERRADA)** |
| (sin número confirmado) | `unassign` (`mutations.ts`) no vuelve a encender `ai_enabled` — a diferencia de `assignToMe`/`intervene` (T10), que sí lo apagan. Un "Asignarme" por error + "Desasignar" deja el chat sin dueño Y con Seba apagada, sin ningún mecanismo que la reencienda sola. | `reenableAiIfAdvisorNeverWrote` reenciende con un segundo `UPDATE` aparte SOLO si la IA se apagó por el propio tomar-a-mano (`aiWasSilencedByThisTakeover`, mira `silenciada_por_asesor` con `created_at >= assigned_at`) y el asesor nunca le escribió de verdad al cliente (`advisorWroteToCustomerSince`); nunca lanza, falla cerrado. | T11 | `824b56e` | **Corregido (decisión #2 del operador — ver "Decisiones abiertas", más abajo, CERRADA)** |

(T4 y T8 también quedaron commiteados — `932cb9e` y `68dacfb`
respectivamente — pero no traen ningún hallazgo de esta revisión, así que
no aparecen en la tabla de arriba.)

### Decisiones abiertas para el operador

No se corrigieron porque son decisiones de diseño, no bugs de una línea —
quedan documentadas también en el Grupo E de
`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`:

1. **Reencolar tras `entrega_fallida` post-saludo. CERRADA el 19/9/2026 por
   T12** ("El turno se reintenta solo cuando el proveedor falla después del
   saludo", mismo plan). El operador decidió que SÍ, con la condición de
   que sea SEGURO: reabre D-B solo en este punto puntual (en todos los
   demás caminos `entrega_fallida` sigue significando "no se reintenta
   para no duplicar"). Las dos salidas que pueden caer justo después del
   saludo ya no dejan `recordHandoff(entrega_fallida)` — lanzan
   `ProviderFailedAfterGreetingError` (`turn-delivery.ts`), que
   `runAgentTurn` deja pasar TAL CUAL en su `catch` (sin envolver en
   `NonRetryableTurnError`) para que la cola la reintente igual que
   cualquier fallo transitorio, sin tocar `queue.ts`. El reintento
   reconoce el saludo ya enviado (`isSebaGreeting`, `seba.ts`), lo recorta
   del historial ANTES de calcular nada más y no vuelve a presentarse. Ver
   la sección T12 más abajo, la trampa correspondiente en `CLAUDE.md` y la
   sección de T12 en `docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`
   (Grupo E).
2. **`unassign` y `ai_enabled`. CERRADA el 19/9/2026 por T11 (mismo día,
   corrección del orquestador sobre este mismo plan).** El operador decidió
   que SÍ: `unassign` vuelve a encender la IA, pero solo cuando la propia
   toma-a-mano de ESTE asesor fue lo que la apagó (no una pausa manual de
   antes de asignarse el chat) y el asesor nunca le escribió de verdad al
   cliente mientras lo tuvo asignado — ver `reenableAiIfAdvisorNeverWrote`
   en `mutations.ts`, la trampa correspondiente en `CLAUDE.md` y la sección
   de T11 en `docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`
   (Grupo E). Límite conocido y aceptado: reencender a mano, pausar de
   nuevo y desasignar sin escribir, todo con el chat asignado, deja una
   fila `silenciada_por_asesor` indistinguible de la del tomar-a-mano y la
   IA se reenciende igual — distinguir los tres caminos que escriben esa
   razón (pausa manual, primer mensaje real del asesor, tomar-a-mano)
   exigiría una columna nueva; no se hizo en esta corrida.

La decisión #1 (reencolar el turno tras un `entrega_fallida` post-saludo)
quedó CERRADA por T12, más abajo en este mismo plan (ver la sección "T12 —
El turno se reintenta solo cuando el proveedor falla después del saludo").
Antes de T12 los chats que caían en ese caso quedaban silenciosos pero NO
invisibles (seguían en "Sin dueño"/"Pendientes" con su traspaso
correspondiente) — nunca fue una regresión de la invariante "ningún lead
invisible", solo trabajo pendiente; con T12 ya ni siquiera quedan mudos:
el turno se reintenta solo.

## T12 — El turno se reintenta solo cuando el proveedor falla después del saludo (cierra la decisión abierta #1)

**Decisión del operador (19/9/2026, tras el tercer corte de luz):** T12 sale
ANTES del despliegue. Reabre D-B solo en este punto: `entrega_fallida` sigue
significando "no se reintenta para no duplicar" en todos los demás caminos;
acá el reintento es seguro y se explica por qué.

**Por qué es seguro reintentar (verificado en el código el 19/9/2026):**

1. Ningún `deliver()` vive fuera de `agent.ts`: las herramientas del tool
   loop (`tools.ts`) no le envían nada al cliente. En las dos salidas que
   toca T12 —clasificación fallida y el `catch` del tool loop— lo ÚNICO que
   ya salió en el turno es la presentación de Seba.
2. `claimPresentation` selló `welcome_sent_at` antes de enviar: el reintento
   no vuelve a presentarse.
3. La cola ya sabe reintentar un error común: `recordFailure` →
   `RETRY_AFTER_ERROR_SECONDS`, y a los `MAX_ATTEMPTS = 3` deja `abandonado`
   a `unassigned`. `queue.ts` NO se toca.

**Cambios (un solo subagente, un solo commit, sin migración):**

- `turn-delivery.ts`: `ProviderFailedAfterGreetingError` (con
  `conversationId` y `cause`) + `isProviderFailedAfterGreeting`. Error
  REINTENTABLE a propósito: es la única excepción a "si `entrega.intentado`,
  no se reintenta".
- `seba.ts`: `isSebaGreeting(text)` — ¿es EXACTAMENTE la presentación, en
  cualquiera de las tres franjas? Construida sobre `sebaGreeting`, sin
  repetir literales. (Ya escrita con sus tests antes del corte; está en
  `git stash`, "T12 a medias".)
- `agent.ts`, `runTurnPhases`:
  - **Principio: el reintento ve EXACTAMENTE lo que vio el primer intento.**
    `saludoPendienteDeRespuesta`: la última línea del historial es del
    asistente y `isSebaGreeting` la reconoce → este turno ES el reintento.
    En ese caso la línea del saludo se RECORTA de `history` Y de
    `historyCreatedAt` (los dos arreglos, mismo índice) justo después de
    `loadHistory`, antes de cualquier otro cálculo, y `introducedThisTurn =
    true`. Así `customerMessage`, `rafagaCliente`, `mediaStreakWithoutText`,
    fase 0, la clasificación y el tool loop reciben lo mismo que en el primer
    intento (historial que termina en el cliente + el sufijo "el saludo ya
    salió"). Revisión adversarial del 19/9/2026 — la primera versión de este
    plan recortaba el saludo SOLO para la ráfaga y dejaba dos huecos:
    (1) `agent.generate` recibía un historial terminado en un mensaje del
    ASISTENTE — hay proveedores que lo tratan como prefill o devuelven
    vacío, y el modelo "ya contestó"; (2) `mediaStreakWithoutText` y fase 0
    veían un historial distinto al del primer intento.
  - Turno espurio sobre un saludo que YA fue la respuesta completa: si
    `saludoPendienteDeRespuesta` y la ráfaga recortada es solo
    saludo/cortesía (el caso `soloSaludo` del primer intento, que retorna
    ANTES de llamar al proveedor y por eso nunca es un reintento de T12), el
    turno cierra con `resetStage` sin llamar al modelo ni escribir traspaso
    (`awaiting_reply` ya quedó apagado por ese saludo): evita un segundo
    "¿en qué te ayudo?" encima de la presentación.
  - El reconocimiento depende de que el texto viaje sin transformar. Está
    verificado: `send.ts` guarda `content: text` tal cual y `historyLine`
    devuelve `row.content` crudo para un `text`. Si el reconocimiento
    fallara, el lead quedaría mudo SIN rastro (sin `introducedThisTurn` no
    hay ni throw ni traspaso, y el último mensaje visible es saliente) — por
    eso el test (d) pasa por `loadHistory` de verdad con la fila que insertó
    `sendAgentText`, no por un literal armado a mano.
  - En las dos salidas por falla del proveedor, cuando `introducedThisTurn`:
    se conservan `logTurn` y `resetStage`, se QUITA el `recordHandoff
    (entrega_fallida)` de T2 y se lanza `ProviderFailedAfterGreetingError`.
    Sin saludo previo no cambia nada (el reconciliador la recoge como hoy).
- `agent.ts`, `runAgentTurn`: en el `catch`, antes de `if
  (!entrega.intentado) throw err`, dejar pasar tal cual un
  `ProviderFailedAfterGreetingError` (la cola lo reintenta). Log
  `turno_reintentable_tras_saludo`.
- La invariante "ningún lead invisible" se sostiene: mientras hay intentos,
  el turno está en la cola; al agotarlos, `abandonado` → "Sin dueño".
  Límite aceptado: `abandonado` va siempre a `unassigned`, también si el chat
  tenía asesor (T2 lo mandaba a `human`); con asesor asignado el chat sigue
  en "Tuyas"/"Pendientes" por `awaiting_reply` (el saludo es `is_auto_reply`).
- Si el modelo llegó a escalar dentro del tool loop antes de que `generate`
  lanzara, el reintento puede escalar otra vez: con asesor asignado cae en
  la rama `alreadyAssigned` (solo nota); sin asesor deja una segunda fila
  `escalada_sin_asesor`. Aceptado: es bitácora repetida, no un mensaje
  repetido.
- Casos revisados que NO necesitan código (quedan en la trampa de CLAUDE.md):
  - El cliente escribe durante la espera del reintento (30 s + cron): su
    mensaje queda DESPUÉS del saludo, la última línea es del cliente, no se
    reconoce como reintento y el turno corre normal con el saludo en medio
    del historial; si el proveedor vuelve a fallar, el último mensaje es
    entrante y el reconciliador lo recoge como siempre.
  - Un asesor escribe o toma el chat entre intentos: el reintento sale por
    las guardas de apertura de siempre (`pausada`, `humano_se_adelanto`).
  - Ráfaga en carrera (`hola` → turno `soloSaludo`; `precio…` llegó antes
    del saludo): el segundo turno ve `[hola, precio, saludo]`, hoy mandaría
    al modelo un historial terminado en asistente y, si el proveedor falla,
    quedaría INVISIBLE (sin `introducedThisTurn`, último mensaje saliente).
    Con T12 se recorta, contesta sin volver a saludar y, si falla, reintenta.
  - `runAgentTurn` solo tiene dos llamadores: la cola y
    `api/dev/simulate-message` (solo desarrollo, atrapa y devuelve 502). Al
    quitar el traspaso de T2, la visibilidad de este caso depende de la
    cola; no hay otro llamador en producción.
  - `abandonado` NO está en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`: si el
    intento 1 llegó a escalar y los tres intentos fallan, esa fila cierra la
    escalada para `escalationOpen` y un "gracias" posterior lo contesta
    Seba en vez de callarse. Semántica que `abandonado` ya tenía; no se toca.
  - Costo: bajo una caída del proveedor cada primer contacto reintenta hasta
    3 veces (fase 0 + clasificación por intento, solo si responden); el tope
    de gasto diario sigue mandando.
- Docs en el mismo commit: trampa nueva en `CLAUDE.md` (y corrección de la
  trampa de T2, que pasa a describir solo el caso sin reintento posible),
  línea de `docs/GLOSARIO.md`, sección T12 en
  `docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`, y el cierre de
  la decisión #1 más arriba en este plan.

**Tests (en el mismo commit):**

- `seba.test.ts`: los de `isSebaGreeting` (ya escritos).
- `turn-delivery.test.ts`: el error nuevo NO es `isNonRetryable`.
- `agent.test.ts`: (a) clasificación fallida tras el saludo → lanza el error
  reintentable, NO escribe `entrega_fallida`, `welcome_sent_at` queda
  sellado; (b) lo mismo en el `catch` del tool loop; (c) sin saludo previo,
  las dos salidas se comportan como hoy (no lanzan, no escriben traspaso);
  (d) reintento: historial que termina en la presentación → no vuelve a
  saludar, `buildInstructions` recibe `introducedThisTurn: true`, el
  historial que llega a `generate` y a `classifyIntent` termina en el
  mensaje del CLIENTE (no en el saludo), el turno contesta — y la fila del
  saludo la arma el mismo camino que `sendAgentText`, leída por `loadHistory`
  real; (d2) turno espurio sobre `[hola, saludo]` → cierra sin llamar al
  modelo ni escribir traspaso; (d3) el cliente escribió después del saludo →
  NO se trata como reintento, el saludo se queda en el historial; (e) reintento con "gracias" + escalada abierta → la guarda de
  cortesía sigue callando (la ráfaga se calcula sin el saludo final);
  (f) `runAgentTurn` deja pasar el error sin convertirlo en
  `NonRetryableTurnError`. Los tests de T2 que esperaban `entrega_fallida`
  se reescriben, no se borran sin reemplazo.
- Mutación manual (con `cp`, nunca `git checkout --`): quitar la excepción
  del `catch` de `runAgentTurn` → (f) debe romperse; quitar el recorte del
  saludo en la ráfaga → (e) debe romperse.
- Criterio de cierre: tsc, lint 0 errores, suite completa verde CON Redis,
  build; después se sube a la rama del PR y se espera el CI real.
