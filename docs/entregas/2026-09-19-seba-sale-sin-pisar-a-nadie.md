# Entrega — rango completo pendiente desde `3802fad` + "Seba sale sin pisar a nadie" (19/9/2026)

Para el Claude del VPS. Metodología `liminalwork`: contexto → plan
(`docs/planes/2026-09-19-seba-sale-sin-pisar-a-nadie.md`) → subagentes
`implementador` → reportes → este documento. Sigue los cinco puntos por
commit de la memoria del operador (hash/título, ¿migración?, ¿variable de
entorno?, ¿toca UI o solo servidor?, qué se verificó).

## Antes de nada: confirmar en qué commit está producción

**No asumas `3802fad`.** Esa fue la última medición del Claude del VPS,
el 18/9/2026 (base en `20260915010000`, árbol y base coincidían). Puede
que otra sesión ya haya entregado parte de lo que sigue. **Corre `git log
--oneline <tu-HEAD-en-producción>..<HEAD de esta corrida>` antes de
calcular qué falta** — el rango correcto es siempre `producción..HEAD`,
nunca `3802fad..HEAD` a ciegas.

Si producción sigue en `3802fad`, el rango pendiente son **31 commits
commiteados** (`3802fad..def7484`, cinco migraciones) **más los
commits de la corrida "Seba sale sin pisar a nadie"** (desde `d9091e0` hasta HEAD,
sobre `def7484`: ocho de código —el último es `824b56e`, T11— y dos de
documentación; ninguna migración
NUEVA, `d9091e0` edita in situ las cinco pendientes). Este documento cubre TODO ese rango,
agrupado por corrida/tarea, en el orden en que hay que desplegarlo. **El
orden operativo detallado, con las consultas SQL literales, está en
`docs/PRODUCCION.md` §11 ("Entrega de 'Seba atiende el mostrador' + 'Nada
sin leer, un solo catálogo y la factura Saint' + 'Seba sale sin pisar a
nadie'") — este documento da el detalle por commit, esa sección da el
ORDEN de once pasos a seguir. Leer las dos, en ese orden: primero §11,
después el detalle de cada commit acá abajo cuando haga falta.**

**Recordatorio permanente:** Dokploy despliega con el push, sin esperar al
CI. Todo lo que la base necesita va ANTES de pushear. Después de cada push,
mira igual el CI (API pública de Actions, sin `gh`, ver Comandos de
`CLAUDE.md`) y reproduce en local cualquier falla que no quepa en las 10
anotaciones que GitHub muestra por paso.

---

## Grupo A · "La IA no vuelve a pedir lo que ya pidió" (3 commits, migración `20260916010000`)

Plan: `docs/planes/2026-09-16-la-ia-no-vuelve-a-pedir.md`. El sello de
devolución (`conversations.ai_resume_cutoff_at`): la IA no vuelve a
contestar un mensaje del cliente anterior al momento en que un humano le
devolvió el chat — evita el bucle real del 13/9/2026 (63 casos reescalados).

### `73ef4ac` — `[migración]` La base sella cuándo le devolvieron el chat a la IA y deja rastro de cada cambio de dueño

- **Qué cambia para el usuario:** nada todavía — la columna nace vacía
  para todo, el código que la usa es el commit siguiente.
- **Migración:** sí, `supabase/migrations/20260916010000_devolucion_a_la_ia.sql`.
  Aplicar con `psql -1 -v ON_ERROR_STOP=1` (regla dura: trae una columna
  GENERADA — `new_since_ai_resume` — que sin `-1` puede quedar a medias).
  Trae `conversations.ai_resume_cutoff_at` (sellado por el trigger BEFORE
  `handle_conversation_ai_resume()` al ENTRAR al estado "IA encendida y sin
  asesor", con `last_customer_message_at`, nunca `now()` — ver CLAUDE.md,
  "El sello copia `last_customer_message_at`, nunca `now()`"), la columna
  generada `new_since_ai_resume`, y suma `HandoffReason` con
  `devuelto_a_ia`/`desasignada_por_asesor`/`mensaje_previo_a_devolucion`
  vía el trigger AFTER `handle_conversation_ownership_change()`. Termina en
  `notify pgrst, 'reload schema'` (T5 de "Seba sale sin pisar a nadie" se
  lo agregó el 19/9 — ver Grupo E — así que si esta migración ya se aplicó
  ANTES de esa edición, correr a mano `notify pgrst, 'reload schema';`
  después de aplicar `20260917010000`/`20260917020000` no hace daño, es
  idempotente).
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** medio — trigger BEFORE sobre `conversations`,
  tabla caliente del camino del webhook. `drop trigger`/`drop function` +
  `alter table conversations drop column ai_resume_cutoff_at` revierte,
  pero perdería el sello de cualquier devolución ya ocurrida.
- **Cómo verificar:** `supabase/tests/devolucion_a_la_ia.sql` (doce casos,
  transacción con rollback), cableado al job `migraciones` del CI. Contra
  producción: `select column_name from information_schema.columns where
  table_name = 'conversations' and column_name = 'ai_resume_cutoff_at';`.

### `548cd8d` — La IA solo atiende lo que el cliente escribió después de que se la devolvieron

- **Qué cambia para el usuario:** un chat que un asesor devolvió a la IA
  (desasignó, o la reactivó) ya no repite la misma promesa vieja sobre el
  mensaje que ya estaba ahí antes de la devolución — se queda en "Sin
  dueño" hasta que alguien (humano o la IA con un mensaje nuevo del
  cliente) lo atienda.
- **Migración:** no (ya entró en `73ef4ac`).
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** medio — toca el camino caliente del turno
  (`agent.ts`: nueva guarda en la apertura de `runAgentTurn`, después de
  `pausada` y antes de `humanHasWritten`) y el reconciliador
  (`reconciler.ts`, filtra por `new_since_ai_resume` en el WHERE).
- **Cómo verificar:** `rtk npx vitest run src/lib/ai/agent.test.ts
  src/lib/ai/handoffs.test.ts src/lib/ai/reconciler.test.ts
  src/lib/ai/turn-correlation.test.ts src/lib/data-backlog.test.ts
  src/lib/permisos-funciones.test.ts`.

### `aac9e74` — La documentación cuenta el sello de devolución y por qué la migración va antes que el código

- **Qué cambia:** solo documentación (`CLAUDE.md`, `docs/PRODUCCION.md`,
  el plan). Sin migración, sin variables, sin UI.
- **Cómo verificar:** lectura.

---

## Grupo B · "Seba atiende el mostrador" (10 commits, migraciones `20260917010000` + `20260917020000`)

Plan: `docs/planes/2026-09-17-seba-atiende-el-mostrador.md`. Los seis
requisitos del cliente: la IA se llama Seba, se presenta una vez por
conversación, cotiza con los textos exactos que dictó el cliente, no frena
la venta con preguntas de más, sigue contestando tras escalar (hasta que un
asesor escriba de verdad) y aprende de lo que corrigen los asesores.

### `6ea6877` — `[migración]` La base apaga a Seba con el primer mensaje del asesor y deja rastro de cada silencio

- **Qué cambia para el usuario:** nada todavía — plomería para los commits
  siguientes.
- **Migración:** sí, `supabase/migrations/20260917010000_seba_y_escalada_viva.sql`.
  Aplicar con `psql -1 -v ON_ERROR_STOP=1`, DESPUÉS de `20260916010000`
  (reusa `new_since_ai_resume`) y ANTES del código de esta corrida. Trae:
  el backfill de `welcome_sent_at` que le cambia el significado de "última
  vez que se mandó la plantilla de bienvenida" (nunca usada,
  `WHATSAPP_WELCOME_TEMPLATE` vacía desde siempre) a "Seba ya se presentó"
  (`coalesce(last_reply_at, last_message_at, created_at)` para todo
  `has_reply`, nunca `now()`); `conversation_handoffs.reason` suma
  `silenciada_por_asesor`; `handle_conversation_ownership_change()` gana la
  rama `silenciada_por_asesor` (`ai_enabled` se apaga SIN que
  `assigned_agent_id` cambie en el mismo UPDATE) y `reclamado` exige
  `auth.uid() is not null`; función + trigger nuevos
  `handle_agent_message_silences_ai()` (`AFTER INSERT ON messages`) que
  apaga la IA en cuanto un asesor manda su primer mensaje REAL (no una
  nota interna). Ver la errata corregida el 19/9/2026 sobre el riesgo real
  de aplicar el CÓDIGO antes que esta migración (`docs/PRODUCCION.md`,
  cerca de la línea 330: bajo la semántica vieja `welcome_sent_at` es
  `null` en casi TODAS las conversaciones, así que el código sin la
  migración/backfill saludaría a mitad de charla en cada chat, no se
  quedaría "mudo" como decía la versión anterior del documento).
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** medio-alto — backfill sobre TODA
  `conversations` con `has_reply` (M5: ~17 mil filas medidas el 19/9,
  cada una dispara un evento de Realtime); correr fuera de hora pico y
  seguido de `vacuum analyze public.conversations` (ver `docs/PRODUCCION.md`
  §11, paso 3/8).
- **Cómo verificar:** `supabase/tests/seba_y_escalada_viva.sql` (nueve
  casos desde el 19/9 — T10 de "Seba sale sin pisar a nadie" sumó el caso
  9, ver Grupo E) y `supabase/tests/devolucion_a_la_ia.sql` actualizado
  (56 líneas de diff en este commit). `select tgname from pg_trigger where
  tgrelid = 'public.messages'::regclass and tgname =
  'messages_agent_silences_ai_trigger';` debe dar una fila.

### `62cda1e` — `[migración]` La base guarda las lecciones que los asesores le enseñan a Seba

- **Qué cambia para el usuario:** nada todavía — plomería.
- **Migración:** sí, `supabase/migrations/20260917020000_ai_lessons.sql`,
  DESPUÉS de `20260917010000`. Tabla `public.ai_lessons` (`kind`: `nota`/
  `sinonimo`; `scope`: `global`/`conversacion`; `synonym_from`/`synonym_to`
  para sinónimos de búsqueda del catálogo), RLS, publicada en
  `supabase_realtime` (autoverificación: `raise exception` si no queda
  publicada). Trae `set local lock_timeout = '5s'` y `notify pgrst,
  'reload schema'` DESDE que se escribió (T5 de "Seba sale sin pisar a
  nadie" solo le agregó el comentario explicando por qué — la migración ya
  tenía el `set local lock_timeout` desde este commit del 18/9, revisar el
  diff de Grupo E antes de asumir que cambió algo funcional).
- **Variables de entorno:** ninguna.
- **Riesgo / cómo revertir:** bajo — tabla nueva y vacía.
- **Cómo verificar:** `supabase/tests/ai_lessons.sql` (cableado al CI).

### `245aa61` — La IA se llama Seba, cotiza con los textos que dictó el cliente y no frena la venta con preguntas

- **Qué cambia para el usuario:** la IA se presenta como "Seba" (nunca como
  "SBK Motors" ni describiéndose a sí misma con esos términos —
  `identity-guard.ts` gana los patrones nuevos); los tres textos fijos de
  confirmación de inventario/sin stock/no identificado son ahora literales
  (`seba.ts`); la regla de la única pregunta entra al prompt.
- **Migración:** no. **Variables de entorno:** ninguna.
- **Riesgo:** medio — toca `identity-guard.ts` (la guarda que decide qué
  texto NO puede salir al cliente) y `prompt.ts`.
- **Cómo verificar:** `rtk npx vitest run src/components/chat/message-bubble.test.tsx
  src/lib/ai/identity-guard.test.ts src/lib/ai/prompt.test.ts
  src/lib/ai/saludo.test.ts src/lib/ai/seba.test.ts src/lib/brand.test.ts`.

### `5f18505` — Escalar ya no apaga a Seba: sigue contestando hasta que el asesor escribe

- **Qué cambia para el usuario:** al escalar, Seba SIGUE contestando en el
  chat (existencia, listas, dudas nuevas) hasta que una persona le escribe
  de verdad al cliente — antes, escalar apagaba la IA en el acto. La
  guarda de apertura de `runAgentTurn` se reduce a `if (!convo.ai_enabled)`
  (deja de mirar `assigned_agent_id` por separado). Toda salida de Seba
  mientras hay un asesor asignado queda `is_auto_reply` (no apaga
  `awaiting_reply`); `stageFor` evita que el chat se caiga de "Escaladas"
  mientras el turno trabaja. Banner de estado del chat (`ai-status-banner`)
  actualizado.
- **Migración:** no. **Variables de entorno:** ninguna.
- **Riesgo:** alto — es el cambio de comportamiento central de este plan,
  toca `agent.ts`, `escalate.ts`, `handoffs.ts`, `send.ts`, `reconciler.ts`,
  `data.ts`. **Este es el commit que la corrección C1 de "Seba sale sin
  pisar a nadie" (Grupo E) mitiga**: sin el UPDATE operativo y sin T10
  (Grupo E), un asesor que toma un chat a mano compite con Seba hasta que
  alguien le escriba — ver `docs/PRODUCCION.md` §11, pasos 3-4.
- **Cómo verificar:** `rtk npx vitest run src/components/chat/ai-status-banner.test.tsx
  src/lib/ai/agent.test.ts src/lib/ai/escalate.test.ts
  src/lib/ai/handoffs.test.ts src/lib/ai/reconciler.test.ts
  src/lib/ai/send.test.ts src/lib/data-backlog.test.ts`.

### `5470142` — Seba se presenta con el saludo del día en el primer mensaje y vuelve a hacerlo cuando el cliente reabre un chat cerrado

- **Qué cambia para el usuario:** el primer mensaje de cada conversación
  (nueva o reabierta) empieza con "Hola, buen día, mi nombre es Seba. Soy
  tu asistente el día de hoy en SBK MOTORS, ¿cómo puedo ayudarte?" (con la
  franja del día correcta), mandado por CÓDIGO como mensaje propio, antes
  de fase 0/1 — el modelo ya no redacta el saludo. El webhook pone
  `welcome_sent_at = null` al reabrir un chat cerrado.
- **Migración:** no. **Variables de entorno:** ninguna.
- **Riesgo:** alto — toca el webhook (`route.ts`) y la apertura del turno.
- **Cómo verificar:** `rtk npx vitest run src/app/api/webhooks/whatsapp/route.test.ts
  src/lib/ai/agent.test.ts src/lib/ai/prompt.test.ts`.

### `e8b2d64` — Cada consulta al catálogo termina en manos de un asesor, con el texto que dictó el cliente

- **Qué cambia para el usuario:** toda llamada al catálogo con resultado
  termina en una de cuatro instrucciones (filtro genérico sin escalar /
  con existencia / sin stock / no identificado), con los tres textos fijos
  del cliente y escalada obligatoria salvo el caso genérico (única
  pregunta).
- **Migración:** no. **Variables de entorno:** ninguna.
- **Riesgo:** medio-alto — `tools.ts` (161 líneas tocadas), `escalate.ts`,
  `agent.ts`.
- **Cómo verificar:** `rtk npx vitest run src/lib/ai/agent.test.ts
  src/lib/ai/escalate.test.ts src/lib/ai/tools.test.ts`.

### `4c98856` — Seba lee las lecciones que le enseñan los asesores y busca en el catálogo con sus sinónimos

- **Qué cambia para el usuario:** las lecciones globales (prosa) se pegan
  al prompt (dentro del prefijo cacheable); los sinónimos de búsqueda
  (`ai_lessons.kind = 'sinonimo'`) expanden los términos que
  `buildCatalogTool` usa para buscar en `products`, ANTES de armar el
  filtro.
- **Migración:** no (la tabla ya entró en `62cda1e`). **Variables de
  entorno:** ninguna.
- **Riesgo:** medio — `lessons.ts` nuevo, `catalog-search.ts`,
  `mutations.ts` (mutaciones de lecciones), `data.ts`.
- **Cómo verificar:** `rtk npx vitest run src/lib/ai/agent.test.ts
  src/lib/ai/catalog-search.test.ts src/lib/ai/lessons.test.ts
  src/lib/ai/prompt.test.ts src/lib/ai/tools.test.ts
  src/lib/mutations.test.ts`.

### `0ccf6d8` — La documentación cuenta cómo atiende Seba

- **Qué cambia:** solo `CLAUDE.md`/`docs/PRODUCCION.md`.

### `9811cd4` — El asesor le enseña a Seba desde el menú de cualquier mensaje y revisa las lecciones en Control IA

- **Qué cambia para el usuario:** nuevo panel "Lecciones" en Control IA
  (crear/activar/desactivar/borrar); nuevo modal "Enseñarle a Seba" desde
  el menú contextual de cualquier mensaje del chat.
- **Migración:** no. **Variables de entorno:** ninguna. **UI:** sí, rebuild
  completo (~5 min).
- **Cómo verificar:** `rtk npx vitest run src/components/agent-control/agent-control-view.test.tsx
  src/components/agent-control/lessons-panel.test.tsx
  src/components/chat/chat-panel.test.tsx
  src/components/chat/message-bubble.test.tsx
  src/components/chat/message-context-menu.test.tsx
  src/components/chat/teach-seba-modal.test.tsx`. Escenario a mano: enseñar
  una lección desde un mensaje, verla en el panel.

### `c9b5959` — Una consulta de repuesto ya no la contesta un escenario del panel, y el chat reabierto no espera la gracia del asesor

- **Qué cambia para el usuario:** H1 — "el repuesto manda": un escenario
  calzado se CEDE al catálogo cuando la intención clasificada es
  `consulta_disponibilidad` (nunca por su cuenta); H2 — un chat reabierto
  por el cliente ya no espera los `AI_HUMAN_GRACE_MINUTES` si el último
  mensaje del asesor fue ANTES del cierre (`humanClaimsChat` descuenta
  mensajes anteriores a la última fila `reabierta_por_cliente`).
- **Migración:** no. **Variables de entorno:** ninguna.
- **Riesgo:** medio — `agent.ts`, `human-handled.ts` (168 líneas).
- **Cómo verificar:** `rtk npx vitest run src/lib/ai/agent.test.ts
  src/lib/ai/handoffs.test.ts src/lib/ai/human-handled.test.ts
  src/lib/ai/reconciler.test.ts`.

**Nota sobre el conteo de commits:** la memoria del operador
(`plan-seba-atiende-el-mostrador-17-9-2026`) decía "13 commits
(`6ea6877…c9b5959`)"; el `git log` real de esta sesión cuenta **10**
commits en ese rango (`6ea6877`, `62cda1e`, `245aa61`, `5f18505`,
`5470142`, `e8b2d64`, `4c98856`, `0ccf6d8`, `9811cd4`, `c9b5959`). Se
documentan los 10 que existen de verdad — la memoria puede estar contando
distinto o estar desactualizada; no se inventó ningún commit para llegar a
13.

---

## Grupo C · "El precio se lee en bolívares" (1 commit, sin migración)

Plan: `docs/planes/2026-09-19-el-precio-se-lee-en-bolivares.md`.

### `eba9921` — Inventario muestra el precio en bolívares con el dólar debajo, y ya no deja editarlo

- **Qué cambia para el usuario:** en Inventario, el precio se lee en
  bolívares (con el dólar debajo) y deja de ser editable desde el CRM — el
  precio llega de `products`, cargado por fuera. `updateProductPrice` se
  borró de `mutations.ts` (no tenía test propio).
- **Migración:** no. **Variables de entorno:** ninguna. **UI:** sí, rebuild
  completo.
- **Riesgo:** bajo-medio — quita una mutación de escritura (deuda anotada
  en el plan: la RLS de `products` sigue abierta a escritura de precio, el
  candado es solo de pantalla).
- **Cómo verificar:** `rtk npx vitest run src/components/inventario/inventario-css.test.ts
  src/components/inventario/producto-fila.test.tsx
  src/lib/inventory.test.ts src/lib/mutations.test.ts`.

(El commit `78b62b9`, "Control IA dice cuándo responde Seba y el panel de
lecciones refleja lo que el asesor acaba de hacer", es un ajuste de UI
menor sobre el panel de lecciones de Control IA — no es parte de esta
corrida ni de "Nada sin leer…"; se documenta suelto abajo porque no calza
en ningún grupo con nombre propio.)

### `78b62b9` — Control IA dice cuándo responde Seba y el panel de lecciones refleja lo que el asesor acaba de hacer

- **Qué cambia para el usuario:** ajuste de UI en `agent-control-view.tsx`
  y `lessons-panel.tsx` — indicador de cuándo Seba responde en el panel, y
  el panel de lecciones refleja de inmediato una acción reciente del
  asesor (crear/activar/desactivar).
- **Migración:** no. **Variables de entorno:** ninguna. **UI:** sí.
- **Cómo verificar:** `rtk npx vitest run src/components/agent-control/agent-control-view.test.tsx
  src/components/agent-control/lessons-panel.test.tsx`.

---

## Grupo D · "Nada sin leer, un solo catálogo y la factura Saint"

### Parte 1 — commits `f0a6ce6..e7d846e` (11 commits, 2 migraciones): YA DOCUMENTADA

**Ver `docs/entregas/2026-09-19-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`
— reporte completo por commit, no se repite acá.** Cubre: el plan
(`f0a6ce6`), la migración `20260918010000_catalog_links.sql` (`1e0ca3b`),
la reforma de la bandeja "solo hoy" (`a8426e8`, `30f6512`), la migración
`20260918020000_factura_saint.sql` (`ce9afee`), el módulo de enlaces de
catálogo (`e3f6a2c`), el modal "Cerrar venta" con los nueve campos
(`7dc4d5b`), mensajes rápidos con enlace vigente (`68f3757`), la IA
resuelve marcadores de catálogo (`7354021`), el panel de enlaces en
Control IA (`a94df35`), y Ventas muestra la factura Saint (`e7d846e`).

### Parte 2 — commits `c9b2ed6..def7484` (5 commits): NUEVA, no cubierta por el documento de arriba

El documento de la Parte 1 quedó escrito con HEAD `e7d846e`. Estos cinco
commits son correcciones de una revisión `code-review high` posterior
sobre la MISMA corrida, hechas después de que ese documento se cerró —
documentados acá por primera vez.

#### `c9b2ed6` — Un corte de red al leer los enlaces de catálogo ya no tumba el turno de la IA

- **Qué cambia para el usuario:** si la lectura de `catalog_links` falla
  al arrancar un turno (corte de red, tabla temporalmente inaccesible), la
  IA sigue funcionando con `links: []` en vez de que el turno entero falle.
  `agent.ts` pasa de leer `fetchActiveCatalogLinks` (`data.ts`, que puede
  lanzar) a `fetchTurnCatalogLinks` (nuevo, `src/lib/ai/catalog-links.ts`),
  que nunca lanza y avisa con `log.warn("turno_enlaces_no_legibles")`.
- **Migración:** no. **Variables de entorno:** ninguna.
- **Riesgo:** bajo — hace más tolerante una lectura existente, no cambia
  el comportamiento cuando la lectura funciona.
- **Cómo verificar:** `rtk npx vitest run src/lib/ai/catalog-links.test.ts
  src/lib/ai/agent.test.ts`. Cualquier test que ejercite
  `runAgentTurn`/`reconcileOrphanTurns` con un fake de Supabase necesita el
  caso `catalog_links` en su `from()` desde este commit.

#### `de34373` — La documentación cuenta las tres reglas nuevas: nada sin leer, un solo catálogo y la factura Saint

- **Qué cambia:** solo documentación.

#### `aa9acf5` — Cerrar venta frena el carrito vacío también en la mutación y limpia el error del campo que se corrige

- **Qué cambia para el usuario:** cerrar una venta con el carrito vacío ya
  se frenaba con un toast desde la Parte 1; ahora `closeSaleWithContactInfo`
  (la mutación, no solo el modal) también lo frena como SEGUNDA barrera —
  un llamador que se salte el modal no puede crear una orden de $0,00.
  Corregir un campo inválido en el modal borra SOLO el error de ESE campo
  al instante (antes había que reintentar guardar para que desapareciera);
  reabrir el modal ya no arrastra los errores de la vez anterior.
- **Migración:** no. **Variables de entorno:** ninguna. **UI:** sí.
- **Riesgo:** bajo — endurece una validación ya existente, no cambia el
  camino feliz.
- **Cómo verificar:** `rtk npx vitest run src/lib/sale-draft.test.ts
  src/lib/mutations.test.ts src/components/context-panel/close-sale-modal.test.tsx`.

#### `a854eed` — Un marcador de catálogo mal escrito ya no le llega crudo al cliente, y el panel avisa antes de romper una clave en uso

- **Qué cambia para el usuario:** un marcador mal escrito
  (`{{catalogo:cascos_nuevos}}` con guion bajo, con espacios, sin cerrar)
  ya NO se filtra tal cual al cliente — `resolveCatalogMarkers` lo detecta
  como "sin resolver" con una regex laxa de segunda pasada
  (`LOOSE_UNRESOLVED_MARKER`) y lo trata igual que una clave inexistente
  (fase 0 descarta el escenario; el composer avisa con toast). La clave de
  un catálogo ya creado NO se puede editar desde el panel (cambiarla
  rompería en silencio todo lo que ya la referencia) — para "renombrar"
  hay que crear un catálogo nuevo. Desactivar sigue el mismo patrón
  "armar y confirmar" que borrar.
- **Migración:** no. **Variables de entorno:** ninguna. **UI:** sí
  (`catalog-links-panel.tsx`).
- **Riesgo:** bajo-medio — toca `catalog-links.ts` (usado por `agent.ts` en
  caliente) y el panel de supervisor.
- **Cómo verificar:** `rtk npx vitest run src/lib/catalog-links.test.ts
  src/lib/ai/playbooks.test.ts
  src/components/agent-control/catalog-links-panel.test.tsx`.

#### `def7484` — La documentación recoge las correcciones de la revisión de código del 19/9/2026

- **Qué cambia:** solo documentación (`CLAUDE.md`, el entrega doc de la
  Parte 1 lo referencia).

---

## Grupo E · "Seba sale sin pisar a nadie"

Plan: `docs/planes/2026-09-19-seba-sale-sin-pisar-a-nadie.md`. **Nota
sobre el título de esta sección (T9b, 19/9/2026): el orquestador ya
commiteó este trabajo MIENTRAS se escribía esta documentación** —7
commits, `6cc62ae..8bc3997`, sobre `def7484`— así que el título original
"SIN COMMITEAR al escribir este reporte" (T9) quedó desactualizado; se
deja el detalle de los hashes en cada tarea de abajo, confirmados contra
`git log`, no adivinados. **T1, T2 y T3 quedaron en UN SOLO commit**
(`6cc62ae`, junto con los hallazgos 4/8/9 de la revisión post-T9) — las
tres secciones de abajo comparten ese mismo hash, no son tres commits
distintos; ver la sección 6 del plan para la tabla completa
hallazgo→commit. Ninguna de estas tareas trae una migración NUEVA: T5
EDITA las cinco migraciones de los Grupos A/B/D en el propio archivo
(todavía no aplicadas a producción, así que editarlas in situ fue seguro —
no hay que "migrar dos veces"). Si alguna de las cinco YA se aplicó a
producción ANTES de que este trabajo llegue al VPS, **NO reaplicar el
archivo entero**: correr a mano solo lo que falta (`set local
lock_timeout`/`notify pgrst` donde no estén, ver el diff de cada migración
en el commit `d9091e0`, T5).

### T1 — El turno lanza si no puede leer la conversación (`6cc62ae`)

- **Archivos:** `src/lib/ai/agent.ts`, `src/lib/ai/agent.test.ts`.
- **Qué cambia para el usuario:** nada visible en el camino feliz. Si la
  base rechaza el `select` de la conversación al arrancar un turno (por
  ejemplo, un 400 de PostgREST por una migración faltante), la IA ya no
  queda muda sin rastro — el turno LANZA (`turno_conversacion_no_consultable`)
  y la cola reintenta, en vez de archivar el turno como si el lead no
  existiera.
- **Migración:** no.
- **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** solo servidor (recrear contenedor, ~20 s).
- **Qué se verificó:** `rtk npx vitest run src/lib/ai/agent.test.ts` en
  verde; mutación de verificación (quitar el `throw`) puso el test nuevo en
  rojo, como exige el criterio de terminado del plan; restaurado con `cp`
  de respaldo (nunca `git checkout --`).

### T2 — Un fallo del proveedor después del saludo deja traspaso (`6cc62ae`)

- **Archivos:** `src/lib/ai/agent.ts`, `src/lib/ai/agent.test.ts`.
- **Qué cambia para el usuario:** si el proveedor de IA falla DESPUÉS de
  que Seba ya mandó el saludo (`introducedThisTurn`), ahora queda un
  traspaso `entrega_fallida` en `conversation_handoffs` — antes ese lead
  quedaba sin traspaso, invisible para "Sin dueño", porque el comentario
  "el reconciliador la recoge sola" dejó de ser cierto el 18/9/2026 (ver
  la trampa nueva en `CLAUDE.md`).
- **Migración:** no (la razón `entrega_fallida` ya existía en el CHECK de
  `conversation_handoffs` desde antes de este plan — decisión D-B: no se
  necesitó ninguna razón nueva).
- **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** solo servidor.
- **Qué se verificó:** `rtk npx vitest run src/lib/ai/agent.test.ts` en
  verde, con casos para las dos salidas (clasificación fallida y el
  `catch` del tool loop), con y sin saludo previo. **A comprobar en la UI
  antes de dar esto por cerrado (pendiente, ver "Problemas/desvíos"
  abajo):** que ninguna etiqueta de la bandeja pinte `entrega_fallida` con
  un texto engañoso para este caso nuevo — el plan pedía que el
  implementador lo revisara y reportara sin tocarlo si encontraba algo.

### T3 — El saludo y la cortesía miran la ráfaga entera (`6cc62ae`)

- **Archivos:** `src/lib/ai/history-line.ts`, `src/lib/ai/history-line.test.ts`,
  `src/lib/ai/agent.ts`, `src/lib/ai/agent.test.ts`.
- **Qué cambia para el usuario:** un cliente que manda dos mensajes
  seguidos ("Precio del casco LS2" + "Buenas tardes") ya no recibe solo el
  saludo de Seba sin que le contesten la pregunta real — `customerBurst`
  junta la ráfaga completa y las dos guardas (`soloSaludo`, cortesía tras
  escalada) exigen que TODA la ráfaga sea saludo/cortesía, no solo la
  última línea.
- **Migración:** no.
- **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** solo servidor.
- **Qué se verificó:** `rtk npx vitest run src/lib/ai/history-line.test.ts
  src/lib/ai/agent.test.ts` en verde. Mutación (volver a mirar solo la
  última línea) puso el primer test en rojo, confirmado antes de seguir.
- **Corrección post-revisión (`code-review high`, 19/9/2026, hallazgos 4 y
  8), sobre la MISMA versión de `customerBurst` de este commit — ya
  incluida en el código, sin commit propio nuevo al escribir este punto:**
  la primera versión no acotaba la ráfaga por tiempo (un "hola" de HOY se
  pegaba a una pregunta sin responder de hace DÍAS, en un chat cerrado sin
  respuesta) ni saltaba un sticker (un sticker del cliente hacía fallar la
  guarda de cortesía y dejaba pasar una segunda despedida). Ver la trampa
  actualizada en `CLAUDE.md` (`CUSTOMER_BURST_GAP_MINUTES = 10`,
  `CUSTOMER_STICKER_MARKER`) y la línea de `history-line.ts` en
  `docs/GLOSARIO.md`.

### T8 — `reabierto` no cierra la escalada (`68dacfb`)

- **Archivos:** `src/lib/ai/handoffs.ts`, `src/lib/ai/handoffs.test.ts`.
- **Qué cambia para el usuario:** un reencolado del reconciliador sobre una
  escalada abierta ya no tapa la fila `escalada`/`escalada_sin_asesor` —
  `reabierto` se suma a `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`, así que la
  guarda de cortesía sigue funcionando aunque el reconciliador haya vuelto
  a intentar el turno.
- **Migración:** no. **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** solo servidor.
- **Qué se verificó:** `rtk npx vitest run src/lib/ai/handoffs.test.ts` en
  verde (caso: `escalada_sin_asesor` → `reabierto` → `escalationOpen` da
  `true`).

### T5 — Las cinco migraciones se protegen y avisan a PostgREST (`d9091e0`, `[migración]` en el título)

- **Archivos:** las cinco migraciones de los Grupos A/B/D, EDITADAS in
  situ (ninguna es un archivo nuevo): `20260916010000_devolucion_a_la_ia.sql`,
  `20260917010000_seba_y_escalada_viva.sql` (solo ganan `notify pgrst,
  'reload schema'` al final — ya traían `set local lock_timeout`),
  `20260917020000_ai_lessons.sql`, `20260918010000_catalog_links.sql`,
  `20260918020000_factura_saint.sql` (estas tres ganan `set local
  lock_timeout = '5s'` Y `notify pgrst, 'reload schema'`).
- **Qué cambia para el usuario:** nada directamente — protege el
  despliegue (evita que un lock largo bloquee el webhook, evita que
  PostgREST sirva esquema cacheado tras migrar).
- **Migración:** sí, pero son las MISMAS cinco de los grupos A/B/D, no
  archivos nuevos — **si alguna ya se aplicó a producción con la versión
  vieja (sin este endurecimiento), no hace falta reaplicarla completa: solo
  correr a mano el `set local lock_timeout`/`notify pgrst` que le falte**
  (ver el diff exacto de cada una en este commit).
- **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** solo servidor/base.
- **Qué se verificó:** las cinco migraciones se re-corrieron contra una
  base local reconstruida desde cero con `npx supabase db reset` (CLI
  2.117.0) — **CONFIRMADO por T4: las 17 pruebas de `supabase/tests/`
  quedaron en verde sobre esa base** (ver T4 abajo, ya cerrado).
- **Corrección post-revisión (`code-review high`, 19/9/2026, hallazgo 10),
  ya incluida en el diff de este commit, sin commit propio nuevo al
  escribir este punto:** las cinco ganan, justo después de su propio `set
  local lock_timeout = '5s'`, un bloque que ABORTA la migración si
  `current_setting('lock_timeout')` sigue en `'0'`/`'0ms'` — antes, aplicar
  sin `psql -1 -v ON_ERROR_STOP=1` era un NO-OP silencioso (la migración
  "funcionaba" igual, sin el freno de lock que la justifica); ahora falla
  cerrado con un mensaje explícito. Verificado con `npx supabase db reset`:
  las cinco aplican sin abortar (esa CLI envuelve cada archivo en su propia
  transacción). Ver `docs/PRODUCCION.md` §11, paso 3.

### T6 — Script de catálogos endurecido (`8bc3997`)

- **Archivo:** `scripts/sql/2026-09-18-catalogos-iniciales.sql` (no es
  código de la app ni una migración — script de una sola vez, revisado por
  un humano antes de correr).
- **Qué cambia:** cinco endurecimientos sobre la versión del Grupo D —
  `\set ON_ERROR_STOP on` dentro del archivo (segunda guarda contra el
  falso éxito); huecos de texto con dollar-quoting (`$txt$…$txt$`, ya no
  rompe con una comilla simple del texto real del cliente); aserción nueva
  de que toda clave `{{catalogo:<key>}}` referenciada existe antes de
  cargar nada; `on conflict (key) do nothing` + `NOTICE` por clave saltada
  (decisión D-C: si un supervisor ya creó la clave desde el panel, el
  script no la pisa); aviso informativo que barre CUALQUIER escenario/
  mensaje rápido con `drive.google.com` residual, incluido
  `attachment_url`.
- **Corrección post-revisión (`code-review high`, 19/9/2026, hallazgos 7a y
  7b), ya incluida en el archivo de este commit, sin commit propio nuevo al
  escribir este punto:** dos secciones más, después de la aserción de
  arriba. **Sección 2c** — la aserción original (2b) solo detecta la forma
  ESTRICTA de un marcador; un marcador MAL ESCRITO
  (`{{catalogo:cascos_nuevos}}` con guion bajo,
  `{{catalogo: exploradoras y bombillos}}` con espacios en la clave) se le
  escapaba y se habría guardado tal cual, llegando crudo al cliente en
  producción. 2c es el espejo SQL de `LOOSE_UNRESOLVED_MARKER`
  (`src/lib/catalog-links.ts`) y aborta el script si algo no calza ninguna
  de las dos formas válidas. **Sección 3b** — el `on conflict (key) do
  nothing` de la sección 3 (D-C) puede dejar una clave EXISTENTE pero
  INACTIVA sin tocar; 3b aborta DESPUÉS del INSERT si alguna clave
  referenciada por los textos nuevos sigue sin estar ACTIVA — el script no
  la activa solo (D-C es una decisión humana). Ver `docs/PRODUCCION.md`
  §11, paso 10, para qué hacer si cualquiera de las dos secciones aborta.
- **Migración:** no (sigue siendo un script aparte, se corre DESPUÉS del
  deploy del código, con los huecos `<<...>>` completados contra la base
  real — ver `docs/PRODUCCION.md` §11, paso 10).
- **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** ninguno — es un script de operación.
- **Qué se verificó:** corrida a mano contra la base local con los huecos
  rellenos de prueba (corrida limpia, segunda corrida idempotente, clave
  inexistente, texto con comilla simple, supervisor que ya creó una
  clave), dentro de transacciones desechables.

### T7 — Control IA y Ventas no dan 500 a ciegas (`a6e5932`)

- **Archivos nuevos:** `src/app/agent-control/error.tsx`,
  `src/app/agent-control/degradable-reads.ts` (+ sus tests),
  `src/app/ventas/error.tsx` (+ su test).
- **Archivo tocado:** `src/app/agent-control/page.tsx` (envuelve
  `fetchLessons`/`fetchCatalogLinks` con `readListIfTableExists` —
  renombrada de `readOptionalList`, ver la corrección más abajo).
- **Qué cambia para el usuario:** si Control IA o Ventas fallan al cargar
  (por ejemplo, una tabla nueva que todavía no existe en la base de
  destino), la pantalla muestra un boundary en español con "Reintentar" en
  vez del 500 genérico de Next — el interruptor global de la IA sigue
  alcanzable. En Control IA, las dos lecturas MÁS NUEVAS (`ai_lessons`,
  `catalog_links`) degradan solas a lista vacía en vez de tumbar las otras
  diecisiete lecturas del panel.
- **Migración:** no. **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** UI — rebuild completo (~5 min).
- **Qué se verificó:** `rtk npx vitest run src/app/agent-control/degradable-reads.test.ts
  src/app/agent-control/error.test.tsx src/app/ventas/error.test.tsx` en
  verde. **Verificación visual en Brave HECHA el 19/9/2026 (cierra el
  pendiente que dejó T9):** rail intacto y grilla con exactamente 2 hijos
  directos en columnas de 72px/1848px, provocando el error a mano en las
  dos pantallas (`/agent-control`, `/ventas`) — ver el punto 2 corregido en
  "Problemas/desvíos" abajo.
- **Corrección post-revisión (`code-review high`, 19/9/2026, hallazgos 5 y
  6), ya incluida en el código de este commit, sin commit propio nuevo al
  escribir este punto:** (1) la función se llamaba `readOptionalList` y
  tragaba CUALQUIER error sin mirar cuál — un timeout o un 5xx transitorio
  pintaba el panel vacío como si de verdad no hubiera ningún catálogo/
  lección, justo lo que CLAUDE.md prohíbe. Renombrada
  `readListIfTableExists`: SOLO degrada a `[]` si el error es "la tabla no
  existe" (`42P01`/`PGRST205`); cualquier otro error se relanza y lo atrapa
  `error.tsx`. (2) los dos `error.tsx` dependían de que otro componente
  (que NO se monta cuando la página lanza) ya hubiera insertado
  `dashboard.css` — ahora importan esa hoja de forma explícita.

### T8 y T10 comparten migración con Grupo B (T10 detalle):

### T10 — Tomar un chat a mano apaga a Seba (`671bafe`)

- **Archivos:** `src/lib/mutations.ts`, `src/lib/mutations.test.ts`,
  `supabase/tests/seba_y_escalada_viva.sql` (caso 9 nuevo).
- **Qué cambia para el usuario:** "Asignarme"/"Intervenir" ahora apagan la
  IA en ese chat con un SEGUNDO `UPDATE` (`ai_enabled = false`), DESPUÉS
  del que mueve `assigned_agent_id` — un asesor que toma un chat a mano ya
  no compite con Seba mientras redacta su primera respuesta. Decisión D-A
  del operador.
- **Migración:** no (usa el trigger y el CHECK que ya trajo
  `20260917010000` del Grupo B — no hay columna ni razón nueva).
- **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** cliente — `mutations.ts` viaja en el bundle
  del navegador (la mutación la ejecuta el panel con la sesión del asesor),
  así que necesita el rebuild completo (~5 min), no solo recrear el
  contenedor. Sin cambios visibles en pantalla.
- **Qué se verificó:** `rtk npx vitest run src/lib/mutations.test.ts` en
  verde (orden de los dos `UPDATE`); caso 9 de
  `supabase/tests/seba_y_escalada_viva.sql` (dos `UPDATE` en serie con
  sesión real de asesor deja `reclamado` y luego `silenciada_por_asesor`,
  ninguna espuria).
- **IMPORTANTE — este código SOLO protege asignaciones nuevas.** Los chats
  que un asesor YA tenía asignados desde antes de este deploy necesitan el
  UPDATE OPERATIVO de C1 (`docs/PRODUCCION.md` §11, paso 4) — sin él, Seba
  sigue corriendo turnos completos en esos chats hasta que alguien note el
  problema en la conversación real.
- **Corrección post-revisión (`code-review high`, 19/9/2026, hallazgo 3),
  ya incluida en el código de este commit, sin commit propio nuevo al
  escribir este punto:** la primera versión de `silenceAiForManualTakeover`,
  si el segundo `UPDATE` fallaba, lanzaba directo sin compensación — dejaba
  el chat ASIGNADO con Seba ENCENDIDA, el mismo C1 que T10 existe para
  cerrar, esta vez por un corte de red en vez de por el diseño del UPDATE
  único. Ahora reintenta el apagado UNA vez y, si vuelve a fallar, compensa
  devolviendo `assigned_agent_id` al valor que tenía ANTES de la toma
  manual (leído con `readAssignedAgentId` antes de cualquiera de los dos
  `UPDATE`) y lanza el error original igual. La frase "no hay una 'deshacer
  la asignación' que valga la pena ahí", del plan original, quedó FALSA —
  ver la trampa actualizada en `CLAUDE.md`.

### T11 — `unassign` reenciende a Seba solo si el asesor nunca le escribió al cliente (`824b56e`)

- **Archivos:** `src/lib/mutations.ts`, `src/lib/mutations.test.ts`.
- **Qué cambia para el usuario:** cierra la decisión abierta #2 de la
  revisión `code-review high` del 19/9/2026 (ver sección 6 del plan y
  "Decisiones abiertas para el operador" abajo, ahora CERRADA). Hasta este
  commit, "Asignarme"/"Intervenir" (T10) apagaban `ai_enabled` con un
  segundo `UPDATE`, pero `unassign` — el mismo interruptor de
  `chat-panel.tsx`, del otro lado — solo tocaba `assigned_agent_id`: un
  asesor que se asignaba un chat por error y lo desasignaba enseguida
  dejaba el chat SIN dueño Y con Seba APAGADA, sin ningún mecanismo que la
  reencendiera sola (el reconciliador exige `ai_enabled = true`, el turno
  del webhook sale por `pausada`). Ahora `unassign` reenciende con un
  SEGUNDO `UPDATE` aparte del que desasigna, `reenableAiIfAdvisorNeverWrote`,
  SOLO si se cumplen las CINCO condiciones: la IA estaba apagada, el chat
  no está cerrado, `assigned_at` no es `null`, existe una fila
  `silenciada_por_asesor` posterior a `assigned_at` (la apagó el PROPIO
  tomar-a-mano de esta desasignación, no una pausa manual de antes de
  asignarse el chat) y el asesor NUNCA le mandó un mensaje real al cliente
  desde que se le asignó (mismo predicado que apaga la IA por trigger:
  `sender_type = 'agent'`, `direction = 'outbound'`,
  `is_internal_note = false`; una nota interna no cuenta). Consecuencia del
  sello: Seba NO contesta el mensaje que ya estaba pendiente antes de
  desasignar (cae en "Sin dueño"), solo los mensajes nuevos — igual que
  desasignar y reactivar a mano ya se comportaba.
- **Migración:** no (usa el trigger y el CHECK que ya trajo
  `20260917010000` del Grupo B — mismo mecanismo que T10, sin columna ni
  razón nueva).
- **Variables de entorno:** ninguna.
- **Toca UI o solo servidor:** cliente — `mutations.ts` viaja en el bundle
  del navegador, necesita el rebuild completo (~5 min). Sin cambios en
  `chat-panel.tsx`: el botón sigue llamando a `unassign` igual que antes.
  Comprobado además contra la base local con sesión de asesor
  (`set local role authenticated`): la secuencia tomar → desasignar deja
  las cuatro filas (`reclamado`, `silenciada_por_asesor`,
  `desasignada_por_asesor`, `devuelto_a_ia`), las dos lecturas de T11 pasan
  la RLS y `ai_resume_cutoff_at` queda sellado.
- **Qué se verificó:** `rtk npx vitest run src/lib/mutations.test.ts` — **67
  tests en verde** (suite completa del archivo, no solo los de `unassign`).
  Mutación de verificación (respaldo con `cp`, nunca `git checkout --`):
  forzar `reenableAiIfAdvisorNeverWrote` a saltarse la condición de
  `aiWasSilencedByThisTakeover` (reencender sin comprobar que fue el propio
  tomar-a-mano el que apagó la IA) puso en rojo el caso del archivo que
  cubre "una pausa manual de antes de asignarse el chat NO se reenciende al
  desasignar" — confirmado antes de restaurar desde la copia.
- **Ajuste sobre la primera versión, mismo día (corrección del
  orquestador):** la primera versión de T11 reencendía con solo mirar "¿el
  asesor escribió?", sin distinguir POR QUÉ estaba apagada la IA —
  reencendía también sobre una pausa manual explícita de antes de
  asignarse el chat, pisando esa decisión. `aiWasSilencedByThisTakeover`
  (la condición del reloj contra `silenciada_por_asesor`) se sumó para
  cerrar ese hueco. Ver la trampa nueva en `CLAUDE.md` y la línea de
  `mutations.ts` en `docs/GLOSARIO.md`.
- **Límite conocido y aceptado, no corregido en esta corrida:** reencender
  a mano, pausar de nuevo y desasignar sin escribir, todo con el chat
  todavía asignado, deja una fila `silenciada_por_asesor` indistinguible de
  la del tomar-a-mano — no hay ninguna columna que diga cuál de los tres
  caminos (pausa manual, primer mensaje real del asesor, tomar-a-mano)
  escribió esa fila, y la IA se reenciende igual. Distinguirlo exigiría una
  columna nueva; queda para una corrida futura si llega a importar en la
  práctica.

### T4 — El job `migraciones` del CI vuelve a verde (`932cb9e`)

- **Archivo:** `supabase/tests/traspaso_sin_contenido_legible.sql`.
- **Estado:** estaba EN CURSO cuando esta documentación (T9) arrancó a
  escribirse y terminó mientras tanto — el archivo quedó modificado en el
  árbol de trabajo antes de cerrar este reporte (confirmado con `git
  status`/`git diff` de la propia sesión de T9, no de memoria).
- **Qué cambia para el usuario:** nada — es un test de CI. Antes del `\i`
  que reaplica la migración `20260908010000` (para probar el backfill y la
  idempotencia del CHECK), borra de `conversation_handoffs` las filas cuya
  `reason` no exista en el CHECK viejo que esa migración va a recrear —
  `supabase/seed.sql` deja un mensaje saliente de asesor en la conversación
  4 que, desde `20260917010000` (Grupo B), dispara
  `messages_agent_silences_ai_trigger` y deja una fila `silenciada_por_asesor`
  que el CHECK viejo todavía no admitía, tumbando el job `migraciones` del
  CI en CUALQUIER checkout limpio (el seed corre siempre antes de este
  test).
- **Migración:** no (test, no migración).
- **Variables de entorno:** ninguna. **Toca UI o solo servidor:** ninguno.
- **Qué se verificó — CERRADO (confirmado al escribir este punto, T9b):**
  base local reconstruida desde cero con `npx supabase db reset` (CLI
  2.117.0, migraciones + seeds), las cinco migraciones de T5 aplicaron sin
  abortar (guarda del hallazgo 10 incluida), y los **17 archivos de
  `supabase/tests/` (no 18 — el conteo real del directorio es 17, ver la
  lista completa en `docs/GLOSARIO.md`/el árbol del repo) quedaron en
  verde**, en el orden del job `migraciones` del CI. El job `migraciones`
  del CI ya no debería caer en un checkout limpio por este motivo — sigue
  pendiente el primer CI real sobre este rango para la certeza total (ver
  la trampa de las cinco migraciones en `CLAUDE.md`, hallazgo 10).

### T9 — Esta misma documentación (el commit de documentación que cierra esta corrida)

- **Archivos:** `docs/PRODUCCION.md`, `CLAUDE.md`, `docs/GLOSARIO.md`, este
  documento (`docs/entregas/2026-09-19-seba-sale-sin-pisar-a-nadie.md`).
- **Qué cambia:** solo documentación — el orden operativo de once pasos con
  las consultas literales (`docs/PRODUCCION.md` §11), siete trampas nuevas
  y una actualización a una trampa existente en `CLAUDE.md`, las líneas de
  `history-line.ts`/`mutations.ts`/`handoffs.ts`/`agent.ts`/el script de
  catálogos en `docs/GLOSARIO.md`, y este reporte de entrega. Dos erratas
  de `docs/PRODUCCION.md` corregidas (ver más abajo).
- **Migración:** no. **Variables de entorno:** ninguna. **UI:** ninguna.

### T9b — La documentación recoge las correcciones de la revisión de código del 19/9/2026 sobre este mismo plan (el mismo commit de documentación)

- **Archivos:** `CLAUDE.md`, `docs/GLOSARIO.md`, `docs/PRODUCCION.md`, este
  documento, `docs/planes/2026-09-19-seba-sale-sin-pisar-a-nadie.md`
  (sección 6 nueva, al final).
- **Qué cambia:** solo documentación. T9 (arriba) documentó T1-T10 con la
  versión del código ANTERIOR a la revisión `code-review high` del
  19/9/2026 sobre esta MISMA corrida (8 de 10 hallazgos de esa revisión se
  corrigieron en código, sin commit propio — quedaron dentro de los diffs
  de T3, T5, T6, T7 y T10, ya en el árbol de trabajo). Este commit alinea
  la documentación con lo que el código hace HOY: las cinco correcciones
  post-revisión (R-A ráfaga por tiempo + sticker en `customerBurst`, R-B
  reintento + compensación en `silenceAiForManualTakeover`, R-C
  `readListIfTableExists` con códigos específicos + import explícito de
  `dashboard.css`, R-D secciones 2c/3b del script de catálogos, R-E la
  guarda que aborta sin `psql -1`) quedaron anotadas en cada tarea de
  arriba (Grupo E), en las trampas de `CLAUDE.md`, en las líneas de
  `docs/GLOSARIO.md` y en `docs/PRODUCCION.md` §11. Cierra dos pendientes
  que T9 había dejado abiertos (T4 y la verificación visual de T7, ver
  "Problemas/desvíos" abajo) y revisa el pendiente de T2 sobre la etiqueta
  de `entrega_fallida` en la UI (sin tocar código — ver el mismo punto).
- **Migración:** no. **Variables de entorno:** ninguna. **UI:** ninguna.

---

## Problemas, deuda o desvíos que el Claude del VPS debe saber

1. **T4 (job del CI) — CERRADO (T9b).** Confirmado: base local
   reconstruida desde cero con `npx supabase db reset` (CLI 2.117.0), las
   cinco migraciones de T5 aplicaron sin abortar y los 17 archivos de
   `supabase/tests/` quedaron en verde, en el orden del job `migraciones`
   del CI. Sigue pendiente el primer CI real sobre este rango (el CI usa
   `supabase/setup-cli@v1` con `version: latest`) para la certeza total —
   local no es lo mismo que el runner de GitHub, aunque hoy coincidan.
2. **T7 — verificación visual en Brave — CERRADA (T9b), hecha el
   19/9/2026.** Rail intacto y grilla con exactamente 2 hijos directos, en
   columnas de 72px/1848px, provocando el error a mano en las dos pantallas
   (`/agent-control`, `/ventas`).
3. **T2 — revisada la etiqueta de `entrega_fallida` en la UI (T9b), sin
   tocar código.** `grep -r "entrega_fallida" src/components src/lib`
   (además de `src/lib/ai/`) no encuentra NINGÚN componente que pinte esa
   razón como texto: `entrega_fallida` vive solo en la bitácora
   `conversation_handoffs`, escrita por `agent.ts`/`reconciler.ts`/
   `handoffs.ts`. El único consumidor de `conversation_handoffs` en la UI
   que mira `reason` de verdad es el aviso de asignación
   (`assignment-notifier.tsx` + `src/lib/assignment-notice.ts`,
   `isAssignmentNotice`), que filtra ESTRICTAMENTE `reason === "escalada"`
   — un `entrega_fallida` con `to_kind: "human"` NO dispara ese toast. Los
   demás lugares que consultan la tabla (`agent-control-view.tsx`,
   `inbox-sidebar.tsx`, `crm-shell.tsx`, `data.ts`) cuentan filas para
   píldoras ("Sin dueño", conteos) sin renderizar la razón como texto. **No
   hay ninguna etiqueta engañosa que corregir hoy** — si en el futuro se
   agrega una vista que sí muestre `reason` al asesor, revisar que el texto
   para `entrega_fallida` no insinúe "Meta rechazó el mensaje" (ese es
   `rechazado_por_meta`, una razón distinta): `entrega_fallida` es "el
   saludo salió pero la redacción de verdad falló después".
4. **Dos erratas corregidas en `docs/PRODUCCION.md` el 19/9/2026 (T9):**
   - La descripción de qué pasa si el código de "Seba atiende el
     mostrador" llega ANTES que su migración/backfill decía que el saludo
     de Seba quedaba "mudo" hasta que la migración entrara — es lo
     contrario: bajo la semántica vieja, `welcome_sent_at` es `null` en
     casi TODAS las conversaciones (la plantilla de bienvenida nunca se
     usó), así que el código sin la migración saludaría a mitad de charla
     en CADA conversación que reciba un turno, no se quedaría callado.
   - La migración `20260917010000` decía que iba "después de
     `20260916010000` y antes de `20260915010000`" — no tiene sentido,
     `20260915010000` es anterior en fecha y ya estaba aplicada en
     producción antes que las tres migraciones de Seba. Corregido a "antes
     de `20260917020000`" (la siguiente real de la cadena).
5. **El conteo de commits de "Seba atiende el mostrador" en la memoria del
   operador (13) no coincide con el `git log` real (10)** — documentado
   con el número real, sin inventar los tres que faltan para cuadrar.
6. **`docs/entregas/2026-09-19-nada-sin-leer-un-solo-catalogo-y-la-factura-saint.md`
   quedó desactualizado** (su HEAD es `e7d846e`, pero la misma corrida
   sumó cinco commits más de una revisión `code-review high` posterior,
   `c9b2ed6..def7484`) — no se reescribió ese documento (instrucción:
   enlazar en vez de reescribir lo que ya está cubierto), pero los cinco
   commits que le faltan quedaron documentados en el Grupo D, Parte 2, de
   este reporte.
7. **Rotar la clave de OpenRouter** (quedó expuesta en una sesión de
   diagnóstico del 18/9, según la memoria del operador) sigue pendiente —
   no es parte de este rango, se menciona para no perderlo.

---

## Decisiones abiertas para el operador

Dos hallazgos de DISEÑO de la revisión `code-review high` del 19/9/2026.
Una sigue abierta; la otra la cerró el operador el mismo día con T11.

1. **ABIERTA — Tras el saludo, un fallo del proveedor deja `entrega_fallida`
   y NADIE reintenta el turno.** T2 (arriba) deja el traspaso correcto para
   que el lead no quede invisible, pero eso es solo el registro — no hay
   ningún mecanismo que vuelva a intentar redactar la respuesta real para
   ese cliente; el chat queda esperando a un humano (o a que el cliente
   vuelva a escribir) hasta que alguien lo note. El revisor propone que el
   reconciliador reencole ese turno en vez de solo dejar constancia — pero
   reencolarlo hoy no serviría de mucho: `welcome_sent_at` ya quedó
   sellado por `claimPresentation`, así que el turno reencolado NO volvería
   a saludar (correcto), pero además correría de nuevo la fase 0/1 y el
   tool loop desde cero sobre el mismo mensaje del cliente que ya falló una
   vez — reabre la decisión D-B de este mismo plan ("no existe una razón
   'falló el proveedor', `entrega_fallida` ya significa esto") y probablemente
   necesite ese reencolado explícito, no solo el traspaso. Se deja ABIERTA
   a propósito: no se toca el camino caliente del turno en la víspera del
   despliegue.
2. **CERRADA el 19/9/2026 por T11 (ver su sección arriba, Grupo E).** El
   operador decidió que `unassign` SÍ debe volver a encender `ai_enabled`
   automáticamente, pero solo cuando fue la propia toma-a-mano de ESE
   asesor la que la apagó (no una pausa manual de antes de asignarse el
   chat) y el asesor nunca le escribió de verdad al cliente mientras lo
   tuvo asignado. Antes de T11: con T10 (D-A), tomar un chat a mano
   ("Asignarme"/"Intervenir") apagaba a Seba en ese chat con un `UPDATE`
   explícito, pero `unassign` solo quitaba `assigned_agent_id`, nunca
   volvía a prender `ai_enabled` — un asesor que se asignaba un chat "por
   error" y lo desasignaba de inmediato dejaba el chat SIN dueño Y con Seba
   apagada, hasta que alguien la encendiera a mano desde el interruptor del
   chat. Límite conocido y aceptado que SÍ queda sin resolver: reencender a
   mano, pausar de nuevo y desasignar sin escribir, todo con el chat
   asignado, deja una fila `silenciada_por_asesor` indistinguible de la del
   tomar-a-mano y la IA se reenciende igual — distinguir los tres caminos
   que escriben esa razón exigiría una columna nueva.

---

## Ensayo del despliegue (19/9/2026)

El 19/9/2026 se ENSAYÓ `docs/PRODUCCION.md` §11 de punta a punta contra una
base LOCAL llevada al estado de producción: `npx supabase db reset
--version 20260915010000` + los datos sembrados, y desde ahí las cinco
migraciones a mano con `PGOPTIONS="-c lock_timeout=5s"` + `psql -1 -v
ON_ERROR_STOP=1`, el UPDATE operativo de C1, los dos GET de humo contra
PostgREST local, el backfill acotado del paso 8, el script de catálogos
(dos corridas), y los 17 tests de `supabase/tests/`.

**Resultado bueno:**

- `pg_dump --schema-only --schema=public` del camino "producción + las
  cinco migraciones a mano" es IDÉNTICO al de un reset completo desde cero
  con `npx supabase db reset` (solo difieren los tokens aleatorios
  `\restrict`/`\unrestrict` que `pg_dump` genera en cada corrida) — las
  cinco migraciones, aplicadas a mano en el orden y con los flags que
  indica §11, dejan el esquema exactamente igual que aplicarlas todas
  seguidas desde una base vacía.
- La guarda de transacción (el bloque que aborta si `lock_timeout` sigue
  en `'0'`/`'0ms'`, hallazgo 10 de la sección 6 del plan) es la SEGUNDA
  sentencia de las cinco migraciones, sin ningún DDL antes — abortar sin
  `-1` no deja NADA aplicado de esa migración, confirmado corriendo cada
  una sin el flag y verificando que el esquema queda intacto.
- El UPDATE operativo de C1 (paso 4) dejó exactamente una fila
  `silenciada_por_asesor` por cada chat que tocó (`created_by = 'system'`,
  sin sesión) y CERO filas `reclamado` — el trigger se comporta como
  documenta la migración.
- `notify pgrst, 'reload schema'` hizo visibles `catalog_links`,
  `ai_lessons` y `orders.saint_invoice_number` al primer GET contra
  PostgREST local después de aplicar las migraciones — sin necesidad de
  reiniciar el contenedor ni esperar más de unos segundos.

**Defectos encontrados y corregidos en `docs/PRODUCCION.md` §11 (esta
tarea, T9c):** ver los cinco puntos del punto A del encargo — el texto de
la lección global medía 362 caracteres contra un CHECK de 200 (corregido a
193); el backfill + `vacuum analyze` del paso 8 no pueden ir en el mismo
comando (corregido a dos comandos separados, con la advertencia de por qué);
faltaba el INSERT literal para registrar las cinco migraciones en
`supabase_migrations.schema_migrations` (agregado); el script de catálogos
deja dos WARNING inofensivos al correr con `-1` porque ya trae su propio
`begin;`/`commit;` (documentado, sin cambiar el comando — §11 y la cabecera
del propio script ya recomendaban la MISMA forma, sin contradicción entre
los dos); repaso del resto del documento sin encontrar ningún otro bloque
con `VACUUM`/similar ni otro texto sugerido que exceda un CHECK de longitud
de la base (`catalog_links.label` ≤ 40, `ai_lessons.content` ≤ 200,
confirmados contra las migraciones).

**Lo que NO se pudo ensayar** (queda para el despliegue real, no es parte
de esta tarea):

- El respaldo real (`scripts/backup.sh`, §8) — el ensayo no lo corrió
  contra la base local.
- El push del código y el CI real sobre este rango (el ensayo se hizo
  enteramente contra una base local; ningún commit de este rango salió de
  esta máquina).
- Cargar la lección global desde el panel `/agent-control > Respuestas >
  Lecciones` con una sesión de supervisor real contra producción (el
  ensayo verificó el CHECK con un INSERT directo, no el flujo de la UI).
- Cualquier métrica con tráfico real (gasto diario, `escenario_cedido_al_
  catalogo`, turnos con error) — el paso 11 de §11 exige volumen real de
  producción, que una base local sembrada no reproduce.
- El `EXPLAIN ANALYZE` de la consulta de Pendientes con volumen real (ya
  señalado como pendiente en "Verificación posterior completa" — el de la
  base local, 28 filas, no fue concluyente el 18/9/2026 y esta tarea no lo
  repitió).

---

## Verificación posterior completa

Ver `docs/PRODUCCION.md` §11 para el orden operativo con las consultas
literales (medición previa, las cinco migraciones, el UPDATE de C1, los
GET de humo, la comprobación de tablas/columnas/trigger, el backfill
acotado, subir el tope de gasto, el script de catálogos, y qué vigilar las
primeras horas). Antes de dar por cerrada la entrega completa de este
documento:

- **CONFIRMADO por el orquestador sobre `824b56e`, el último commit de
  código (19/9/2026; lo que sigue a ese commit es solo documentación):**
  `rtk npm run test` — suite completa en verde, **2571 tests**, con Redis
  levantado (`docker run -d --name sbk_redis -p 6379:6379 redis:7-alpine
  redis-server --appendonly yes`, ver CLAUDE.md); `rtk npx tsc --noEmit` —
  **sin errores**; `rtk npm run lint` — **0 errores** (4 warnings
  preexistentes de variables sin usar en tests, no introducidos por este
  rango); `rtk proxy npm run build` — **OK**, con `.next/BUILD_ID` nuevo
  (16:57 del 19/9/2026).
- **CONFIRMADO (T9b):** los **17 archivos** de `supabase/tests/` (no 18 —
  ver el punto 1 de "Problemas/desvíos") en verde sobre una base
  reconstruida desde cero.
- Las tres mutaciones de verificación (T1, T3, y T2 si el subagente la
  hizo) rompen su test correspondiente. **T11 (nueva, T9c):** mutación
  sobre `reenableAiIfAdvisorNeverWrote` (saltarse `aiWasSilencedByThisTakeover`)
  puso en rojo el caso que cubre "una pausa manual de antes de asignarse
  el chat no se reenciende al desasignar", restaurado desde una copia
  hecha con `cp` — **67 tests de `src/lib/mutations.test.ts` en verde**.
- **CONFIRMADO (T9b):** verificación visual de T7 en Brave hecha el
  19/9/2026 (punto 2 de "Problemas/desvíos", arriba).
- **CONFIRMADO (19/9/2026): réplica completa del job `verificar` del
  CI**, en un contenedor `node:22` (v22.23.2, la misma major que usa el CI
  — esta máquina corre Node 26 en local, ver la trampa "La suite local y el
  CI no corren el mismo Node" en `CLAUDE.md`) sobre un CLON LIMPIO de
  `824b56e`, el último commit de código de la corrida (se corrió antes
  sobre `8ef9883` con el mismo resultado y 2560 tests; los commits
  posteriores a `824b56e` son solo documentación): `npm ci`,
  generación de tipos, `tsc --noEmit`, lint, **2571 tests** con
  `--no-file-parallelism` (mismo flag que usa el job del CI, para
  reproducir su contención real) y `npm run build` — los cinco pasos
  terminaron OK.
