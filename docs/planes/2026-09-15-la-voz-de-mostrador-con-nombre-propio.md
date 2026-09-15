# Plan · La voz de mostrador con nombre propio y el cierre de v1.1 (15/9/2026)

> **Para quien ejecute:** metodología `liminalwork` (plan aprobado → un
> subagente `implementador` por tarea, Sonnet esfuerzo alto → reporte →
> validación del orquestador). Casillas `- [ ]`. Formato hermano de
> `docs/planes/2026-09-14-la-voz-cercana-y-la-espera-visible.md`. Aprobado por el
> operador el 15/9/2026, con las respuestas a las cuatro preguntas ya incorporadas.

## Contexto

El 14/9 se ejecutó "La voz cercana y la espera visible" (10 commits sobre los 3
del CI, sin push). Al revisarla, el operador pidió cuatro cosas más y el cierre
definitivo de la versión estable:

1. **Identidad:** la IA es *alguien sumamente amable que clasifica los mensajes
   y pasa la conversación a un asesor de ventas cuando el cliente quiere
   concretar una venta, tiene un reclamo o cualquier intención específica*.
   Alcance acordado: **orienta y cotiza** (catálogo cuando está encendido,
   biblioteca para lo general) **y pasa lo específico**. Jamás dice que es IA.
2. **Nombre:** el negocio se llama **SBK Motors**, no "SBK Motorcycles". En
   todo el producto (IA, interfaz, factura, docs).
3. **Saludo por franja:** el operador SÍ quiere "buenos días / buenas tardes /
   buenas noches", **una sola vez por conversación**, decidido por el código
   con la hora de Barinas y **sin depender de escenarios del panel** (el
   cliente configuró escenarios "y la IA no funcionaba"). Esto revierte en
   parte la Decisión 1 del 14/9: la franja vuelve, pero SOLO al sufijo del
   primer mensaje, nunca a `turnClockLine` (que la mandaba en cada turno y
   por eso la IA saludaba a mitad de conversación).
4. **Cierre de v1.1:** todo lo que quedó pendiente el 14/9 entra a este plan:
   deuda de código cerrable ahora, el diagnóstico de las notas de voz con el
   dato nuevo (los asesores usan **Android o PC con Chrome/Brave/Edge**, así
   que el contenedor Ogg NO es la causa), las tareas operativas, el despliegue
   y la etiqueta.

**Base:** `main` local = `a409461`; `origin/main` = producción = `38a540e`
(confirmado por el operador el 14/9); 13 commits sin push. Dos migraciones
pendientes de aplicar ANTES del push: `20260914010000` (ya commiteada) y
`20260915010000` (esta corrida). Sin variables de entorno nuevas (O7 cambia
dos existentes).

## Hallazgos de la exploración (15/9/2026, verificados en código)

| # | Hallazgo | Dónde |
|---|---|---|
| 1 | "SBK Motorcycles" está escrito a mano en ~20 sitios: prompt (5 veces, una llega al cliente en cada saludo), clasificador, dos herramientas, `INVOICE_ISSUER`, título, login, seis cabeceras `dash-brand-name`, README, `package.json`. "SBK Motors" solo aparece en dos comentarios (`sbk-logo.tsx:4`, `theme.css:27`). | `prompt.ts:145,149,155,167,333`; `classify.ts:32`; `tools.ts:108`; `knowledge.ts:50`; `invoices.ts:30`; `layout.tsx:27`; `login-form.tsx:42`; `agent-control-view.tsx:546`, `cliente-ficha.tsx:41`, `clientes-view.tsx:99`, `dashboard-view.tsx:211`, `inventario-view.tsx:130`, `sales-view.tsx:204` |
| 2 | La categoría "La tienda" de la biblioteca se sembró con el nombre viejo y ya es un dato en producción; el operador puede haberlo repetido en entradas y escenarios, que SÍ llegan al cliente. | `supabase/migrations/20260825020000_knowledge_base.sql:68` |
| 3 | `greetingFor` (`business-hours.ts:122`) no tiene ningún llamador en `src`; `dayBand` solo lo usa `buildPrompt` de fase 0. `TurnContext.now` ya existe y los tests lo inyectan. | `business-hours.ts:114-131`; `prompt.ts:296-359` |
| 4 | Fase 0 descarta los escenarios que empiezan saludando SOLO si el mensaje trae más que un saludo: un "hola" pelado sigue eligiendo el escenario del panel. Los tres patrones de `greetingWindow` son subconjunto estricto de `isGreetingPlaybook`: con el descarte incondicional, `playbooksAtTime` no puede filtrar nada. | `playbooks.ts:218,230-236`; `greeting-window.ts:62-66`; `saludo.ts:175-178` |
| 5 | `escalationOpen` mira SOLO la última fila de `conversation_handoffs`: la tapan `asignada` (cada mensaje a un chat con dueño), `pausada` (IA apagada sin dueño) y la propia `cortesia_tras_escalada` (el segundo "gracias" recibe despedida). | `handoffs.ts:242-282`; `agent.ts:1761-1773` |
| 6 | `EXTENSION_BY_MIME` no corta en `;`: toda nota de voz (`audio/ogg; codecs=opus`) queda como `.bin` en Storage. Solo afecta el nombre al descargar. | `route.ts:278-288,1382` |
| 7 | El `<audio>` de la burbuja usa `preload="metadata"` y su `src` es `/api/media/...`, que responde **307 a una URL firmada de 60 s**. Si el asesor pulsa play más de un minuto después de abrir el chat, Chrome pide los rangos a la URL ya resuelta y vencida, Storage responde 400 con JSON y `<audio>` reporta **código 4**, que la burbuja traduce como "este navegador no puede reproducir" y esconde Reintentar. Encaja con Chrome/Android. | `message-bubble.tsx:29-92`; `api/media/[...path]/route.ts:19,62` |
| 8 | `supabase/tests/intenciones_y_traspasos_completos.sql` (T1 del 14/9) no está en `ci.yml`: el job `migraciones` corre los tests por nombre. | `.github/workflows/ci.yml:~200` |
| 9 | La guarda de identidad no reconoce "agente virtual/automatizado/de IA" (sí "asistente virtual", "bot", "IA"). | `identity-guard.ts:58-110` |

## Decisiones (cerradas con el operador; no se reabren)

1. **Identidad y alcance.** Sección 1 del `SYSTEM_PROMPT`: *eres alguien sumamente amable que recibe cada mensaje, entiende qué necesita el cliente, lo orienta y le cotiza, y le pasa la conversación a un asesor de ventas en cuanto quiere concretar una compra, tiene un reclamo o una devolución, o pide algo específico que un asesor tiene que resolver (seguimiento de un pedido, un encargo, compra al mayor)*. Alcance: orientar y cotizar (catálogo con `buscar_repuesto` encendido; biblioteca para lo general) y pasar lo específico. La línea de prohibición suma "agente virtual, agente automatizado"; `identity-guard.ts` gana el patrón `agente (virtual|automatizad\w*|de ia|de inteligencia artificial|conversacional)` ("agente" suelto NO se bloquea: los asesores son `agents`). 5.1–5.5, `TONE_RULES`, `SALES_ACCEPTANCE_RULES` y `MEDIA_RULES` no cambian de fondo.
2. **Nombre: SBK Motors, en `brand.ts`.** `src/lib/brand.ts` (puro) con `BUSINESS_NAME = "SBK Motors"` y `APP_TITLE = "SBK Motors CRM"`. Lo importan prompt (interpolado en el template literal de módulo: sigue siendo un string evaluado una vez, byte por byte idéntico entre turnos, el prefijo cacheable no se rompe), `classify.ts`, `tools.ts`, `knowledge.ts`, `invoices.ts`, `layout.tsx`, `login-form.tsx` y las seis cabeceras. También `README.md`, `package.json` (+ lock, solo `name`), `CLAUDE.md` (título) y comentarios de cabecera. **No se renombran:** identificadores de infraestructura (tag de imagen `sbk-motorcycles-crm`, `REMOTE_DIR` de `deploy.sh`, `.claude/launch.json`: son rutas en el VPS), migraciones ya aplicadas, `supabase/tests/awaiting_reply.sql`, el User-Agent `SbkMotorcyclesCRM/1.0` de `bcv-fetch.ts`, ni las citas históricas de frases reales en comentarios/tests de `identity-guard`/`agent` (son evidencia, no marca).
3. **Migración de datos `20260915010000_marca_sbk_motors.sql`**, commit propio `[migración]`, primera de la corrida: `replace('SBK Motorcycles','SBK Motors')` idempotente sobre `knowledge_categories(name, description)`, `knowledge_entries(title, content)` y `ai_playbooks(trigger_description, response_text)`, con autoverificación `raise exception`. No toca `templates` (texto aprobado en Meta). Suma al CI ese test SQL y el que faltaba del 14/9.
4. **Saludo por franja, nativo y único.** `buildInstructions` calcula `instante = now ?? new Date()` y, si `needsGreeting`, el sufijo trae el saludo ya resuelto con `greetingFor(dayBand(instante))` capitalizado ("¡Buenas noches!"). `turnClockLine` NO cambia (sigue sin franja). Sección 6: *saludas UNA sola vez, con el saludo exacto que te da TURNO ACTUAL, ya calculado con la hora de Barinas; nunca lo deduces tú; en cualquier otro mensaje no saludas*. `needsGreeting(welcomeSentAt, history)` de `agent.ts:369` no cambia.
5. **Fase 0 ignora SIEMPRE los escenarios que empiezan saludando.** `matchPlaybook` pierde el quinto parámetro; el filtro `isGreetingPlaybook` corre incondicional; log `escenarios_saludo_ignorados` con `{ ignorados, nombres }`. `isPureGreeting` queda sin llamadores y se borra con sus tests. Un "hola" pelado va al flujo genérico, que saluda con la franja y pregunta qué busca. **Riesgo asumido (O3):** un escenario cuyo texto empiece con hola/buenas/bienvenid… se ignora aunque no sea "de saludo"; el log nombra cuáles.
6. **`greeting-window.ts` se retira** (módulo, test, `playbooksAtTime` en `playbooks.ts`, test de `prompt.test.ts:183-193`, comentarios en `saludo.ts`, `business-hours.ts:88-92`, `time-zone.ts:71`, fila del glosario). Sus fixtures pasan a `saludo.test.ts` como positivos de `isGreetingPlaybook`. `DAY_BANDS`/`dayBand` siguen vivos.
7. **`escalationOpen` mira la última fila QUE CAMBIA DE MANOS.** Constante `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA = ["asignada", "pausada", "agente_no_puede_correr", "cortesia_tras_escalada", "humano_intervino", "humano_se_adelanto"]` excluida en la consulta con `.not("reason", "in", …)`. El resto del criterio (última = `escalada`/`escalada_sin_asesor` y ningún `messages.sender_type='agent'` después) no cambia; falla cerrado igual; una razón desconocida futura cuenta como cierre.
8. **`extensionForMime` puro** en `src/lib/whatsapp/media-extension.ts`: minúsculas, corte en `;`, `trim`, lookup, `"bin"`. Sin backfill de los `.bin` ya guardados (el `Content-Type` es lo que manda).
9. **Notas de voz en Chrome/Android:** tarea de diagnóstico dirigido (T7) con hipótesis ordenadas y evidencia que decide cada una. Único arreglo de código permitido: la rama código 4 de `AudioContent` deja de culpar al navegador y ofrece Reintentar además de Descargar (un 401/400 con cuerpo JSON produce el mismo código 4 en Chrome). **El TTL de la URL firmada NO se toca** (el operador lo decidió el 15/9): si H1 se confirma, el arreglo (TTL más largo o streaming con `Range` en `api/media`) queda documentado con su costo para v1.2. Transcodificar ya no aplica.
10. **Cierre v1.1:** O1–O8 ajustadas (O3 ya no reemplaza escenarios: opcional apagarlos; obligatorio quitar el saludo inicial a los que deban seguir saliendo y unificar a "tú"); métricas a 48 h corregidas (la de saludos se invierte: ahora se mide "saludo con la franja correcta y una sola vez"); despliegue del rango `38a540e..HEAD` con las dos migraciones y O7 ANTES del push; etiqueta `v1.1` sobre el commit desplegado con las 48 h en verde.
11. **Fuera de alcance (v1.2 / Etapa 2):** presencia de asesores y `response_due_at`; registro de avisos de reposición; `drop column handoff_confirmation_pending_at`; gate de CI en Dokploy; streaming/transcodificar audio; `api/media` sin sanear el path; User-Agent del BCV; bandera `es_saludo` en `ai_playbooks` si algún día hacen falta saludos por campaña.

## Reglas para todos

- Leer `CLAUDE.md` y `docs/GLOSARIO.md` antes de tocar nada. Todo en español; comentarios con el porqué y la fecha (15/9/2026).
- Los subagentes NO commitean, NO hacen push, NO editan `docs/GLOSARIO.md` ni `CLAUDE.md`: entregan la línea de glosario propuesta por archivo tocado. T8 la hace el orquestador.
- Reporte obligatorio: qué implementaron y decidieron, archivos tocados, salida de sus tests, de `rtk npx tsc --noEmit` y de `rtk npm run lint`, desvíos y dudas. El orquestador corre los tres comandos y la suite (`rtk npm run test`, con `VITEST_MAX_WORKERS=4` si Docker acaba de arrancar) al cerrar cada tanda.
- Mutaciones: `cp <archivo> <scratchpad>/<archivo>.bak` antes, restaurar con `cp`. **Nunca `git checkout -- <archivo>`.** Si un paso que debe dar rojo da verde, parar y reportar.
- Todo texto nuevo que pueda llegarle al cliente pasa por `revealsIdentity` en un test estático (patrón `prompt.test.ts` "identidad: ni IA ni persona").
- El nombre del negocio se escribe UNA vez, en `brand.ts`; ningún archivo de `src/` tocado escribe "SBK Motors" literal salvo `brand.ts` y sus tests.
- No editar migraciones ya aplicadas: los datos se corrigen con la migración nueva.
- `queue.test.ts`/`redis-queue.test.ts` se saltan sin Redis: ninguna tarea toca la cola.

## Archivos

| Archivo | Tarea | Cambio |
|---|---|---|
| `docs/planes/2026-09-15-la-voz-de-mostrador-con-nombre-propio.md` | 0 | Este plan |
| `supabase/migrations/20260915010000_marca_sbk_motors.sql` | 1 | Crear: `replace` idempotente en 3 tablas + autoverificación |
| `supabase/tests/marca_sbk_motors.sql` | 1 | Crear: cero filas con el nombre viejo; idempotencia |
| `.github/workflows/ci.yml` | 1 | Sumar `marca_sbk_motors.sql` e `intenciones_y_traspasos_completos.sql` |
| `src/lib/brand.ts` + `.test.ts` | 2 | Crear: `BUSINESS_NAME`, `APP_TITLE` |
| `src/lib/ai/prompt.ts` + `.test.ts` | 2 | Cabecera, §1 identidad/alcance, prohibición ampliada, `BUSINESS_NAME` en 145/149/155/167/333 |
| `src/lib/ai/identity-guard.ts` + `.test.ts` | 2 | Patrón `agente (virtual|…)`; `rewriteSuffix`; negativos "agente de ventas" |
| `src/lib/ai/classify.ts`, `tools.ts`, `knowledge.ts` (+ tests si afirman el nombre) | 2 | `BUSINESS_NAME` |
| `src/lib/invoices.ts` + `.test.ts` | 2 | `INVOICE_ISSUER.name = BUSINESS_NAME` |
| `src/app/layout.tsx`, `src/components/auth/login-form.tsx` | 2 | `APP_TITLE` |
| Seis vistas con `dash-brand-name` | 2 | `{BUSINESS_NAME}` |
| `README.md`, `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose*.yml`, `src/app/theme.css`, `.env.*.example` | 2 | Nombre nuevo en título/`name`/comentarios (tags e imágenes intactos) |
| `src/lib/ai/prompt.ts` + `.test.ts` | 3 | §6 saludo por franja una vez; sufijo `needsGreeting` con `greetingFor(dayBand(instante))` |
| `src/lib/business-hours.ts` | 3 | Solo el docblock de `turnClockLine` |
| `src/lib/ai/playbooks.ts` + `.test.ts` | 4 | Descarte incondicional; sin `playbooksAtTime`; sin 5.º parámetro; log |
| `src/lib/ai/saludo.ts` + `.test.ts` | 4 | Borrar `isPureGreeting`; cabecera; fixtures de franja |
| `src/lib/ai/greeting-window.ts` + `.test.ts` | 4 | **Borrar** |
| `src/lib/ai/prompt.test.ts` | 4 | Quitar import y test de `greetingWindow` |
| `src/lib/ai/agent.ts` | 4 | `:1309` deja de pasar `customerMessage`; comentario |
| `src/lib/business-hours.ts:88-92`, `src/lib/time-zone.ts:71` | 4 | Comentarios sin `greeting-window` |
| `src/lib/ai/handoffs.ts` + `.test.ts` | 5 | `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`; `.not(...)`; fake que aplica filtros |
| `src/lib/ai/agent.ts:1176-1188` | 5 | Comentario de la guarda |
| `src/lib/whatsapp/media-extension.ts` + `.test.ts` | 6 | Crear: `extensionForMime` |
| `src/app/api/webhooks/whatsapp/route.ts` + `.test.ts` | 6 | Usar `extensionForMime`; test `.ogg` |
| `docs/diagnosticos/2026-09-15-notas-de-voz-chrome.md` | 7 | Crear: hipótesis, evidencia, veredicto |
| `src/components/chat/message-bubble.tsx` + `.test.tsx` | 7 | Rama código 4: texto neutro + Reintentar + Descargar |
| `CLAUDE.md`, `docs/GLOSARIO.md`, `docs/PRODUCCION.md`, `docs/diagnosticos/2026-09-14-notas-de-voz.md` | 8 | Título, trampas reescritas, glosario, §10 reescrita, enlace |

**Archivos que se pisan entre tareas** (gobiernan las tandas): `prompt.ts`/`prompt.test.ts` (T2, T3, T4), `agent.ts` (T4, T5), `business-hours.ts` (T3, T4), `saludo.ts` (solo T4).

---

## Tarea 0 · El plan a mano (orquestador)

- [ ] Guardar este plan en `docs/planes/2026-09-15-la-voz-de-mostrador-con-nombre-propio.md`.
- [ ] Commit: `El plan de la voz de mostrador con nombre propio queda escrito`.

## Tarea 1 · [migración] La base dice SBK Motors donde decía SBK Motorcycles

**Contexto.** Hallazgos 2 y 8. Las migraciones aplicadas no se editan: se corrige con una nueva, idempotente.

- [ ] Crear `supabase/migrations/20260915010000_marca_sbk_motors.sql` con cabecera (porqué, fecha, decisiones 2-3):
  - `update public.knowledge_categories set name = replace(name, 'SBK Motorcycles', 'SBK Motors'), description = replace(description, 'SBK Motorcycles', 'SBK Motors') where name like '%SBK Motorcycles%' or description like '%SBK Motorcycles%';`
  - Ídem `public.knowledge_entries (title, content)` — comentario: el trigger de `updated_at` moverá esa columna en las filas tocadas; aceptado.
  - Ídem `public.ai_playbooks (trigger_description, response_text)`.
  - NO tocar `templates` (comentario: texto aprobado en Meta).
  - `do $$ … raise exception … end $$` que cuenta `like '%SBK Motorcycles%'` en las seis columnas.
- [ ] Crear `supabase/tests/marca_sbk_motors.sql` (patrón `preview_en_espanol.sql`): (1) cero filas con el nombre viejo en las tres tablas; (2) la categoría "La tienda" existe y su `description` contiene "SBK Motors"; (3) idempotencia: insertar una categoría de prueba con el nombre viejo, correr la sentencia otra vez, verificar "SBK Motors"; en transacción revertida.
- [ ] `.github/workflows/ci.yml`: dos pasos nuevos con el patrón de `preview_en_espanol.sql`: `intenciones_y_traspasos_completos.sql` y `marca_sbk_motors.sql`.
- [ ] Verificar contra la base local (`docker exec … psql`, receta de `CLAUDE.md`): aplicar la migración dos veces (la segunda no cambia nada ni falla) y correr el test SQL.
- [ ] Mutación: comentar el `update` de `knowledge_categories` → el test (2) falla y el `do $$` lanza. Restaurar.
- [ ] Reporte: filas tocadas por tabla en local; confirmar que el CI lista 12 tests SQL.

**Commit (aparte, primero):** `[migración] La base dice SBK Motors donde decía SBK Motorcycles, y el CI corre los tests SQL que faltaban`.

## Tarea 2 · La IA se presenta como alguien amable de SBK Motors que orienta, cotiza y pasa lo específico

**Contexto.** Hallazgos 1 y 9. Decisiones 1 y 2.

- [ ] Crear `src/lib/brand.ts` (puro; comentario: 15/9/2026, el operador confirmó el nombre; hasta entonces estaba repetido en ~20 sitios y uno llegaba al cliente en cada saludo) con `export const BUSINESS_NAME = "SBK Motors"` y `export const APP_TITLE = \`${BUSINESS_NAME} CRM\``. `brand.test.ts`: es "SBK Motors", no contiene "Motorcycles", `APP_TITLE` termina en " CRM".
- [ ] `prompt.ts`: importar `BUSINESS_NAME`. Línea 145: `${BUSINESS_NAME.toUpperCase()} · ATENCIÓN POR WHATSAPP`. Reescribir §1 (149-157): mantener "Atiendes el WhatsApp de ${BUSINESS_NAME}, una repuestera de motos en Barinas…"; párrafo nuevo de identidad (Decisión 1, redacción ajustable, debe pasar `revealsIdentity` y no usar "asistente/agente/bot/IA" fuera de la línea de prohibición); reemplazar "Tu alcance es corto y definido…" por *Tu alcance: orientar y cotizar —buscas en el catálogo cuando tienes esa herramienta, respondes lo general de la tienda con la biblioteca— y pasar lo específico. Nada más.*; plural y "si preguntan con quién hablan, la respuesta es ${BUSINESS_NAME}"; líneas 167 y 333 con `${BUSINESS_NAME}`; la línea de prohibición sigue EMPEZANDO con "Nunca te describas como" (el test la filtra por ese prefijo) y suma "agente virtual, agente automatizado". Cabecera del archivo con el nombre nuevo.
- [ ] `prompt.test.ts`: importar `BUSINESS_NAME`; las aserciones del nombre comparan contra la constante; nuevos: `SYSTEM_PROMPT` no contiene "Motorcycles"; contiene "sumamente amable", "asesor de ventas", "orientar y cotizar"; §1 sin la línea de prohibición pasa `revealsIdentity`; la prohibición nombra "agente virtual".
- [ ] `identity-guard.ts`: en `PATRONES_AUTOMATIZACION`, tras `asistente (automatizad|virtual)`: `/agente (virtual|automatizad\w*|de ia|de inteligencia artificial|conversacional)/` con comentario (15/9/2026: "jamás dice que es un agente de IA"; "agente" suelto no se bloquea porque los asesores son `agents`). `rewriteSuffix` suma "agente virtual". Tests: positivos "soy un agente virtual", "agente automatizado de SBK Motors", "como agente de IA"; negativos "un agente de ventas te escribe por acá", "tu agente asignado".
- [ ] `classify.ts:32`, `tools.ts:108`, `knowledge.ts:50`: `${BUSINESS_NAME}` (si sus tests afirman el nombre, comparar contra la constante).
- [ ] `invoices.ts:30`: `name: BUSINESS_NAME`; `invoices.test.ts`: `toBe(BUSINESS_NAME)` + `not.toContain("Motorcycles")`.
- [ ] `layout.tsx:27`: `title: APP_TITLE`. `login-form.tsx:42`: `{APP_TITLE}`. Seis vistas: `{BUSINESS_NAME}` dentro del `<span className="dash-brand-name">`.
- [ ] `README.md` (título), `package.json` `name: "sbk-motors-crm"` y `npm install --package-lock-only` (verificar con `git diff --stat` que el lock solo cambió las dos líneas `name`; si arrastra otra cosa, revertir y editar a mano); comentarios de `Dockerfile:2`, `docker-compose.yml:2`, `docker-compose.dokploy.yml:2`, `theme.css:2`, `.env.local.example:34` y su par de producción. **No tocar** tags `sbk-motorcycles-crm` de `Dockerfile:4-5`, `docs/PRODUCCION.md:578-582`, `scripts/*.sh`, `.claude/launch.json`.
- [ ] `grep -rn "SBK Motorcycles" src --include=*.ts --include=*.tsx | grep -v test`: solo pueden quedar comentarios con citas históricas (`agent.ts:874`, `identity-guard.ts:5,60`); reportar la lista final.
- [ ] Mutación 1: `BUSINESS_NAME = "SBK Motorcycles"` → `brand.test.ts`, `prompt.test.ts` e `invoices.test.ts` rojos. Restaurar. Mutación 2: quitar el patrón nuevo de la guarda → "soy un agente virtual" rojo. Restaurar.

**Commit:** `La IA se presenta como alguien amable de SBK Motors que orienta, cotiza y pasa lo específico a un asesor`.

## Tarea 3 · La IA da los buenos días una sola vez, con la hora de Barinas y sin escenarios del panel

**Contexto.** Hallazgo 3. Decisión 4. El 14/9 (T2) el saludo pasó a neutro porque la franja viajaba en CADA turno vía `turnClockLine`; ahora vuelve SOLO al sufijo del primer mensaje.

- [ ] `prompt.ts` `buildInstructions`: `const instante = now ?? new Date();` usado en `turnClockLine(instante, …)` y en el saludo. Sufijo `needsGreeting`: *` Es el primer mensaje que recibe de nosotros: abre con "¡${Saludo}!" —exactamente ese saludo, ya calculado con la hora de Barinas; no lo cambies por otro ni lo repitas después—, dile que le escribes de ${BUSINESS_NAME} y responde en el mismo mensaje lo que preguntó.`* con `Saludo = capitalizar(greetingFor(dayBand(instante)))`. El sufijo "ya hubo saludo" queda como está. Docblock 315-320: la historia (14/9 neutro por el bug de "cada turno"; 15/9 vuelve la franja, solo acá, una vez).
- [ ] `prompt.ts` §6 (238): *Saludas UNA sola vez por conversación, y solo cuando TURNO ACTUAL te diga que es el primer mensaje: con el saludo exacto que te da ahí —buenos días, buenas tardes o buenas noches, ya calculado con la hora de Barinas—, nunca uno que deduzcas tú, y diciendo de dónde escribes. En cualquier otro mensaje no saludas, aunque el cliente vuelva a saludar: respóndele lo que preguntó.*
- [ ] `business-hours.ts:273-285`: docblock de `turnClockLine`: `greetingFor` volvió a tener llamador el 15/9/2026 (`buildInstructions`), solo en el sufijo del primer mensaje; esta línea sigue sin franja a propósito.
- [ ] `prompt.test.ts`: (a) reescribir 174-181 a la regla nueva (`/Saludas UNA sola vez/`, `/ya calculado con la hora de Barinas/`, `not.toMatch(/Nunca saludes por la hora/)`); (b) cuatro casos con `needsGreeting: true`: 8:30 pm (`2026-09-05T00:30:00Z`) → `¡Buenas noches!` y no `buenos días|buenas tardes`; 8:10 am domingo (`2026-09-06T12:10:00Z`) → `¡Buenos días!` + "CERRADA"; 12:00 pm (`2026-09-05T16:00:00Z`) → `¡Buenas tardes!`; 7:01 pm (`2026-09-05T23:01:00Z`) → `¡Buenas noches!`; (c) `needsGreeting: false` a las 8:30 pm → el sufijo NO contiene `buen[oa]s? (días|tardes|noches)` ni `franja`; (d) el bloque estático no contiene `¡Buen` y `instructions.startsWith(SYSTEM_PROMPT)` sigue; (e) el sufijo con saludo pasa `revealsIdentity`.
- [ ] Mutación: reemplazar `greetingFor(dayBand(instante))` por el literal `"hola"` → (b) rojo. Restaurar.

**Commit:** `La IA da los buenos días una sola vez, con la hora de Barinas y sin depender de escenarios`.

## Tarea 4 · Fase 0 ignora los escenarios de saludo y el reloj de los escenarios se retira

**Contexto.** Hallazgo 4. Decisiones 5 y 6.

- [ ] `playbooks.ts`: quitar `import { playbooksAtTime }` y el parámetro `lastCustomerText`; `let candidatos = playbooks.filter((p) => !isGreetingPlaybook(p.responseText))`; si descartó alguno, `log.info("escenarios_saludo_ignorados", { ignorados, nombres })`. Reescribir el comentario 211-236 (historia: 27/8 saludos por reloj → 14/9 descarte condicional → 15/9 el saludo lo da el código, ningún escenario saluda). Quitar `isPureGreeting` del import. `buildPrompt` no cambia.
- [ ] `agent.ts:1309`: `matchPlaybook(history, playbooks, undefined, businessHours)`; ajustar el comentario 1287-1295. Verificar `agent.test.ts` (`calls[0][3]` = horario) sigue verde; borrar cualquier aserción sobre `calls[0][4]`.
- [ ] `saludo.ts`: borrar `isPureGreeting` y `PALABRAS_SALUDO`; reescribir cabecera y docblocks sin `greeting-window`; `isGreetingPlaybook`: "desde el 15/9/2026 se aplica SIEMPRE". `saludo.test.ts`: borrar los tests de `isPureGreeting`; sumar positivos de `isGreetingPlaybook` con las fixtures de `greeting-window.test.ts` ("¡Buenos días! …", "Buenas tardes, ¿en qué…", "🌙 Buenas noches…", "Buen día…", "Bienvenido a SBK Motors") y negativos ("Claro, dame un momento", "¡Gracias por tu compra!").
- [ ] Borrar `src/lib/ai/greeting-window.ts` y su test. `prompt.test.ts`: quitar import y test (11, 183-193). `business-hours.ts:88-92` y `time-zone.ts:71`: comentarios sin `greeting-window`.
- [ ] `playbooks.test.ts` 127-208: (a) con "hola" pelado el enum NO incluye "Saludo"; (b) con "Buenas tardes, tienen tanque…" tampoco; (c) con solo escenarios de saludo activos no se llama al modelo y `usage` es cero; (d) log `escenarios_saludo_ignorados` con `{ ignorados: 1, nombres: ["Saludo"] }`; (e) "Postventa Cashea" (empieza "¡Gracias…") sigue en el enum. Conservar 104-114 ("franja: noche").
- [ ] `grep -rn "greeting-window\|playbooksAtTime\|isPureGreeting\|greetingWindow" src docs/GLOSARIO.md CLAUDE.md` → solo menciones históricas en `docs/planes/`; reportar.
- [ ] Mutación: envolver el filtro en `if (false)` → (a) y (c) rojos. Restaurar.

**Commit:** `Fase 0 ignora los escenarios que saludan y el reloj de los escenarios se retira`.

## Tarea 5 · La guarda de cortesía ve la escalada aunque después haya filas que no cambian de manos

**Contexto.** Hallazgo 5 (hueco medido el 14/9, `CLAUDE.md` trampa "solo puede correr SIN asesor"). Decisión 7.

- [ ] `handoffs.ts`: `const RAZONES_QUE_NO_CIERRAN_LA_ESCALADA: HandoffReason[] = [...]` con un comentario por razón (por qué se escribe sin que la escalada cambie). En la consulta: `.not("reason", "in", \`(${lista.join(",")})\`)` entre `.eq(...)` y `.order(...)`. Docblock: criterio 1 pasa a "la última fila QUE CAMBIA DE MANOS"; una razón desconocida cuenta como cierre.
- [ ] `handoffs.test.ts`: la fábrica de `escalationOpen` recibe `filas` y aplica genéricamente `.eq`, `.not(col, "in", "(a,b)")`, `.order desc`, `.limit(1)` (mini PostgREST de ~20 líneas, para probar el comportamiento y no la constante). Casos nuevos: `[escalada, asignada, asignada]` → true; `[escalada, cortesia_tras_escalada]` → true; `[escalada_sin_asesor, pausada, pausada]` → true; `[escalada, cerrada_por_asesor]` → false; `[escalada, reabierta_por_cliente]` → false; `[escalada, asignada]` + mensaje `agent` posterior → false; los existentes siguen verdes.
- [ ] `agent.ts:1176-1188`: comentario de la guarda: el hueco de `asignada` (y el de `pausada`/segunda cortesía) quedó cerrado el 15/9.
- [ ] Mutación: quitar el `.not(...)` → los tres `true` nuevos rojos. Restaurar.

**Commit:** `La guarda de cortesía ve la escalada aunque después haya filas que no cambian de manos`.

## Tarea 6 · Las notas de voz se guardan como .ogg, no como .bin

**Contexto.** Hallazgo 6. Decisión 8.

- [ ] Crear `src/lib/whatsapp/media-extension.ts` (puro): mover la tabla; `extensionForMime(mime)` → `(mime ?? "").split(";")[0].trim().toLowerCase()` → lookup → `"bin"`. Tests: `"audio/ogg; codecs=opus"`→`ogg`, `"audio/ogg;codecs=opus"`→`ogg`, `"AUDIO/OGG"`→`ogg`, `"image/jpeg"`→`jpg`, `"application/octet-stream"`→`bin`, `undefined`→`bin`.
- [ ] `route.ts`: borrar `EXTENSION_BY_MIME`; `:1382` → `extensionForMime(mimeType)`. `contentType: mimeType` no cambia.
- [ ] `route.test.ts`: el fake de Storage registra `uploadedPaths`; test nuevo: `getMetaMediaUrl` con `mimeType: "audio/ogg; codecs=opus"`, mensaje `audio` → `vi.waitFor(() => expect(uploadedPaths[0]).toMatch(/\.ogg$/))`.
- [ ] Mutación: quitar el `.split(";")[0]` → los dos primeros casos y el del webhook rojos. Restaurar.

**Commit:** `Las notas de voz se guardan como .ogg y no como .bin`.

## Tarea 7 · Diagnóstico dirigido: por qué en Chrome/Android tampoco se oyen las notas de voz

**Contexto.** Hallazgo 7; el operador confirmó Android/PC con Chrome/Brave/Edge. Decisión 9.

Hipótesis en orden, con la evidencia que decide cada una (medir en producción desde un navegador con sesión, DevTools → Network con "Preserve log", un chat con nota de voz reciente):

| # | Hipótesis | Confirma | Descarta |
|---|---|---|---|
| H1 | La URL firmada caduca antes del play: `preload="metadata"` resuelve el 307 al montar; al pulsar play >60 s después, Chrome pide rangos a la URL YA RESUELTA, Storage responde 400 JSON y `<audio>` reporta código 4 → la burbuja "culpa al navegador" y esconde Reintentar. | Abrir chat, esperar 90 s, play → Network muestra `object/sign/…` 400; `audio.error.code === 4`; recargar y pulsar play en <60 s funciona. | Play a los 90 s funciona; o la petición nueva va a `/api/media/...`. |
| H2 | 401 de sesión en el `src` (`proxy.ts` refresca en navegaciones, no al cargar un `<audio>`) → JSON → código 4. | `api/media/...` → 401 tras inactividad; recargar lo arregla. | Siempre 307. |
| H3 | Sin `Accept-Ranges`/206 en Storage self-hosted: reproduce pero no busca ni conoce duración; el asesor ve "0:00". | `curl -sI <url firmada>` sin `Accept-Ranges`; `Range: bytes=0-1` → 200. | 206 + `Accept-Ranges`. |
| H4 | `Content-Type` normalizado a `application/octet-stream` por Storage. | `curl -sI` lo muestra. | `audio/ogg; codecs=opus`. |
| H5 | El `.bin` (T6): no afecta a `<audio>`, solo al nombre al descargar. | — | — |
| H6 | La descarga desde Meta falló y `media_url` quedó `null`: la burbuja muestra "sin archivo". | `select count(*) from messages where message_type='audio' and media_url is null and created_at > now()-interval '7 days'` > 0. | Cero. |

- [ ] Reunir la evidencia de H1–H4 y H6 contra producción (solo lectura; pedirle al operador la captura de Network con los pasos escritos si no hay navegador con sesión). Anotar `audio.error.code` real y el status HTTP de la última petición.
- [ ] Escribir `docs/diagnosticos/2026-09-15-notas-de-voz-chrome.md`: tabla con veredicto por hipótesis, causa, salidas con costo (TTL; streaming con `Range` en `api/media`; `preload="none"`; transcodificar ya no aplica).
- [ ] Único arreglo de código, independiente del veredicto: `message-bubble.tsx:37-54` → *No se pudo reproducir el audio.* con **Reintentar** (mismo `setAttempt`) y **Descargar**; comentario: en Chrome el código 4 también sale de un 401/400 con cuerpo JSON. `message-bubble.test.tsx:50-64`: "código 4 ofrece reintentar Y descargar"; el de código 2 sigue.
- [ ] **No tocar `api/media/[...path]/route.ts`** (decisión del operador, 15/9): si H1 se confirma, el documento deja escritas las dos salidas con costo (TTL más largo; streaming con `Range` sin URL firmada) para v1.2.
- [ ] Mutación: revertir el arreglo de la burbuja → el test nuevo rojo. Restaurar.

**Commit:** `El aviso de audio ofrece reintentar y el diagnóstico cuenta por qué Chrome tampoco lo oía`.

## Tarea 8 · Documentación y cierre (orquestador)

- [ ] `CLAUDE.md`: título "SBK Motors CRM"; trampa "La IA no saluda por franja" reescrita (*saluda por franja UNA sola vez, calculado en `buildInstructions` con `greetingFor(dayBand(now))`; `turnClockLine` sigue sin franja; ningún escenario del panel saluda; el 14/9 el saludo fue neutro un día porque la franja viajaba en cada turno*); trampa "Fase 0 descarta…" reescrita (*ignora SIEMPRE los escenarios cuyo texto empieza saludando; `greeting-window.ts` se retiró el 15/9; un escenario que deba salir no puede empezar con hola/buenas/bienvenid*); trampa de la guarda de cortesía: el hueco cerrado (razones neutras); trampa de notas de voz: el `.bin` cerrado y el diagnóstico de Chrome; trampa nueva: *agregar una razón que `openTurn` escriba por mensaje exige sumarla a `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`*; trampa nueva: *el nombre vive en `brand.ts`; los identificadores de infraestructura conservan `sbk-motorcycles-crm` a propósito*.
- [ ] `docs/GLOSARIO.md`: filas nuevas `brand.ts`, `media-extension.ts`, migración y test SQL, diagnóstico 15/9; borrar `greeting-window.ts`; actualizar `saludo.ts`, `prompt.ts`, `playbooks.ts`, `handoffs.ts`, `identity-guard.ts`, `business-hours.ts`, `time-zone.ts`, `webhooks/whatsapp/route.ts`, `media/[...path]/route.ts` (si TTL), `invoices.ts`, `layout.tsx`, `classify.ts`, `knowledge.ts`, `tools.ts`, `message-bubble.tsx`, `ci.yml`; conteo de migraciones 70.
- [ ] `docs/PRODUCCION.md` §10: reescribir O3 y las métricas (ver "Cierre de v1.1"); sumar `20260915010000` a los pasos de despliegue; comprobación final: 70 migraciones.
- [ ] `docs/diagnosticos/2026-09-14-notas-de-voz.md`: párrafo inicial: "el operador confirmó Android/Chrome el 15/9: ver la segunda vuelta".

**Commit:** `La documentación cuenta que el negocio se llama SBK Motors y cómo la IA saluda por franja una sola vez`.

---

## Orden de ejecución

- **Tanda 1 (paralelo, archivos disjuntos):** T1 (SQL + `ci.yml`), T2 (`brand.ts`, `prompt.ts` §1 + nombre, `identity-guard`, `classify`/`tools`/`knowledge`/`invoices`, UI, README/package), T5 (`handoffs.ts` + comentario de `agent.ts:1176-1188`), T6 (`media-extension.ts`, webhook), T7 (doc + `message-bubble.tsx`). Commit de T1 primero.
- **Tanda 2:** T3 sola (`prompt.ts` §6 + `buildInstructions` + tests; `business-hours.ts:273-285`). Pegar el reporte de T2.
- **Tanda 3:** T4 sola (`playbooks.ts`, `saludo.ts`, borrado de `greeting-window`, `prompt.test.ts`, `agent.ts:1309`, comentarios). Pegar los reportes de T3 y T5.
- **Cierre:** T8 y la verificación final.

Cada tanda cierra con `rtk npx tsc --noEmit`, `rtk npm run lint`, `rtk npm run test` en verde.

## Commits (en este orden)

1. `[migración] La base dice SBK Motors donde decía SBK Motorcycles, y el CI corre los tests SQL que faltaban` (T1)
2. `El plan de la voz de mostrador con nombre propio queda escrito` (T0)
3. `La IA se presenta como alguien amable de SBK Motors que orienta, cotiza y pasa lo específico a un asesor` (T2)
4. `La guarda de cortesía ve la escalada aunque después haya filas que no cambian de manos` (T5)
5. `Las notas de voz se guardan como .ogg y no como .bin` (T6)
6. `El aviso de audio ofrece reintentar y el diagnóstico cuenta por qué Chrome tampoco lo oía` (T7)
7. `La IA da los buenos días una sola vez, con la hora de Barinas y sin depender de escenarios` (T3)
8. `Fase 0 ignora los escenarios que saludan y el reloj de los escenarios se retira` (T4)
9. `La documentación cuenta que el negocio se llama SBK Motors y cómo la IA saluda por franja una sola vez` (T8)

## Verificación final (orquestador)

- [ ] Suite, tipos, lint; `rtk proxy npm run build` y `.next/BUILD_ID` posterior al último commit; `grep -rn "SBK Motorcycles" src --include=*.ts --include=*.tsx | grep -v test` → solo citas históricas en comentarios.
- [ ] Mutaciones de T2 (dos), T3, T4, T5, T6 y T7 repetidas por el orquestador, con respaldo `cp`.
- [ ] Escenario a mano contra el dev local (Supabase local + Redis `sbk_redis` + `api/dev/simulate-message` o el webhook local; IA y catálogo encendidos; dejar activo un escenario de saludo "¡Buenas tardes! ¿En qué podemos ayudarle?" y otro "Postventa Cashea"). La franja esperada es la de la hora real al probar (los bordes los cubre `prompt.test.ts`):
  1. Chat nuevo, `"hola"` → NO sale el escenario de saludo (log `escenarios_saludo_ignorados` con su nombre); la respuesta abre con la franja actual, nombra **SBK Motors** y pregunta qué busca; sin "Motorcycles".
  2. Segundo `"hola"` → sin saludo.
  3. Chat nuevo, `"buenas tardes, tienen tanque de EK Xpress"` → saluda con la franja REAL, una vez, y cotiza/pregunta marca; no sale el escenario.
  4. `"¿con quién hablo?"` → "SBK Motors", sin "asistente/agente/bot"; `"¿eres un agente virtual?"` → no lo afirma; sin `identidad_bloqueada`.
  5. `"acabo de comprar por Cashea"` → "Postventa Cashea" sigue saliendo.
  6. `"sí, lo quiero"` → escala; dos mensajes más del cliente (filas `asignada`); quitar asesor y reactivar IA; `"gracias"` → silencio + `cortesia_tras_escalada`; segundo `"gracias"` → silencio otra vez.
  7. Burbuja de audio: forzar `error.code = 4` → "No se pudo reproducir el audio." con Reintentar y Descargar.
  8. Panel: cabecera "SBK Motors" en las seis secciones, título de pestaña, login, hoja de factura, categoría "La tienda".
- [ ] Verificación visual (login y las seis cabeceras; solo cambia texto).
- [ ] Reporte de entrega por commit (formato `docs/PRODUCCION.md`).

## Cierre de v1.1

### A. Antes del push (orden estricto; Dokploy despliega con el push, sin esperar al CI)

1. Confirmar producción = `38a540e` (`git log --oneline 38a540e..HEAD` = 13 commits del 14/9 + 9 de esta corrida = 22).
2. Respaldo (`scripts/backup.sh`, §8 de `PRODUCCION.md`).
3. Aplicar y registrar, en este orden, `20260914010000_intenciones_y_traspasos_completos.sql` y `20260915010000_marca_sbk_motors.sql`; `select count(*) from supabase_migrations.schema_migrations` → 70. Verificar por efecto: `pg_get_constraintdef` de los tres CHECK; `select description from knowledge_categories where name = 'La tienda'` dice SBK Motors; `select name, left(response_text, 40) from ai_playbooks where is_active` para avisar al operador cuáles empiezan saludando (los ignorará la IA).
4. O7 en Dokploy → Environment (`AGENT_MAX_TURNS_PER_MINUTE=40`, `AI_MAX_REQUESTS_PER_MINUTE=160`), sin desplegar (el push redespliega y las carga).
5. `git push origin main`; mirar el CI (API de Actions) y `docker logs` del contenedor nuevo: primer turno nuevo con `escenarios_saludo_ignorados` si quedan escenarios de saludo; sin `turno_bitacora_no_escrita`.

### B. Tareas operativas (operador, desde el panel)

| # | Qué | Cambio respecto del 14/9 |
|---|---|---|
| O1 | Contactar los 80 leads sin respuesta. | Igual. |
| O2 | Encender "Consulta de productos" tras confirmar inventario. | Igual; es lo que hace real el "cotiza" de la identidad nueva. |
| O3 | Ya no hace falta reemplazar los escenarios de saludo: la IA los ignora. Opcional apagarlos. **Obligatorio:** a cualquier escenario que deba seguir saliendo y cuyo texto empiece con hola/buenas/bienvenid…, quitarle el saludo del inicio. Unificar a "tú" los que digan "usted". Estrechar el disparador de la despedida. | Reescrita. Verificación: `agent_turns.playbook_id` nunca apunta a un escenario cuyo texto empiece saludando. |
| O4 | Horario del domingo. | Igual. |
| O5 | Biblioteca. | Igual; ninguna entrada dice "SBK Motorcycles" (la migración las corrigió). |
| O6 | Roster / no devolver en masa. | Igual; con T5 un "gracias" con escalada abierta se calla aunque haya `asignada`/`pausada` en medio. |
| O7 | Rampa de ritmo. | Se hace en A.4. |
| O8 | Cortes de base al VPS. | Igual. |

### C. Métricas a 48 h (solo lectura sobre producción)

| Métrica | Antes | Meta |
|---|---|---|
| **Saludo con la franja correcta y una sola vez** (invierte la del 14/9): primer mensaje de la IA por conversación creada en la ventana que NO abre con el saludo de su franja (hora Caracas); mensajes posteriores al primero que abren con `buen*`/`hola`. | 3 con franja mal; saludos a mitad | 0 y 0 (excluir turnos con `playbook_id`) |
| Mensajes de la IA con "SBK Motorcycles" | todos los saludos | 0 |
| `identidad_bloqueada` con fragmento "agente" | no medido | 0 |
| Promesas de asesor que apagaron `awaiting_reply` | 170 | 0 |
| Despedidas de la IA con escalada abierta | no medidas | 0; `cortesia_tras_escalada` > 0 solo si hubo el caso |
| Objetos de audio nuevos en `whatsapp-media` terminados en `.bin` | 100 % | 0 |
| `agent_turns` con `intent='fuera_de_tema'` | 0 | = log |
| Escaladas por `intencion_compra` con catálogo encendido | 438/480 | < 250 |
| Tono: 20 respuestas al azar | tajante | ≥ 16 con reconocimiento + explicación |

SQL de apoyo (T8 lo deja en `PRODUCCION.md`):

```sql
-- primer mensaje de la IA por conversación creada en 48 h: ¿abre con el saludo de su franja?
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
-- saludos repetidos
select count(*) from messages m
 where m.sender_type = 'ai' and m.created_at > now() - interval '48 hours'
   and m.content ~* '^\s*[¡!]?\s*(hola|buen[oa]s)'
   and exists (select 1 from messages p where p.conversation_id = m.conversation_id
               and p.sender_type = 'ai' and p.created_at < m.created_at);
select count(*) from messages where sender_type='ai' and created_at > now()-interval '48 hours' and content ilike '%SBK Motorcycles%';
```

### D. Etiqueta

Con C en verde y O1–O6 hechas: `git tag -a v1.1 -m "SBK CRM v1.1 estable: la voz de mostrador con nombre propio"` sobre el commit desplegado y `git push origin v1.1`. `docs/PRODUCCION.md` y la memoria registran el hash.

## Para v1.2 / Etapa 2

- Presencia de asesores y `response_due_at` (rotación: 155/375 escaladas las respondió otro).
- Registro de avisos de reposición (hoy `seguimiento` a mano).
- `drop column conversations.handoff_confirmation_pending_at` (irreversible: migración propia, decisión aparte).
- Dokploy sin gate de CI.
- Audio según T7: TTL más largo de la URL firmada, streaming con `Range` en `api/media` (elimina la URL firmada de raíz) o `preload="none"`; decisión del operador pendiente con la evidencia del diagnóstico.
- `api/media` no sanea el path (D5).
- `bcv-fetch.ts` User-Agent con el nombre viejo; tags/rutas `sbk-motorcycles-crm` del VPS.
- Bandera `es_saludo` en `ai_playbooks` si algún día hacen falta saludos por campaña.

## Riesgos y decisiones que vuelven al operador

1. **Escenarios que empiezan con "¡Hola!" y no son saludos** quedan ignorados (Decisión 5). Mitigación: log con nombres + O3 + la consulta de A.3 antes del push.
2. **TTL de la URL firmada:** el operador decidió el 15/9 que NO se toca en esta corrida; si H1 se confirma, las notas de voz seguirán fallando en Chrome hasta v1.2 y el asesor tendrá el botón Reintentar como salida.
3. **La migración de datos toca `ai_playbooks` y `knowledge_entries` escritos por el operador** (solo el literal "SBK Motorcycles"; `updated_at` se mueve). Aprobado por el operador el 15/9.
4. `npm install --package-lock-only`: verificar que el lock solo cambió `name`.
5. Cambiar `SYSTEM_PROMPT` invalida el caché del proveedor una vez (T2 y T3 salen juntas).
6. `intenciones_y_traspasos_completos.sql` entra al CI por primera vez: si falla, arreglar antes del push.
7. El escenario manual no puede fijar la hora: los bordes de franja se prueban solo por unit test.
