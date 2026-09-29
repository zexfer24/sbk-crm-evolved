# Plan · "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando" (28/9/2026)

## Contexto

El estudio del VPS (1.027 turnos, 25/9 14:29 → 28/9 19:07 UTC) dio 457 turnos fallidos en 280 conversaciones, 45 de ellos graves. Casi todos vienen de cuatro causas:

1. La búsqueda descarta la marca por la tolerancia N−1, y una palabra descriptiva que no está en el nombre del producto la tumba.
2. "Genérico" no mira el stock.
3. La pregunta de filtro se repite y nadie recuerda el pedido anterior.
4. En la espera con escalada abierta se reenvían escenarios.

Además, el operador pidió cinco cambios del mostrador: el carrito persistente, los links de catálogo que "no se guardan", el scroll, el stock visible y la reasignación por demora.

Lo que hay que conservar: 1.788 cotizaciones con el precio correcto y 221 cifras con fuente. `cifra_sin_fuente` y `usdFromBs` no se tocan.

Producción y `origin/main` están en `08e0fa5`, con 81 migraciones. La última es `20260926010000`.

### Decisiones del operador (cerradas)

| # | Decisión |
|---|---|
| D1 | El reloj cuenta desde el **último mensaje del cliente** sin respuesta real posterior. A los 10 min responde Seba; a los 15 min se reasigna. |
| D2 | Seba responde **aunque la IA esté pausada o haya asesor**, con límites: no escala, no promete precio especial, descuento, apartado ni envío, y deja una nota interna. No reactiva la IA. |
| D3 | Tope de **2 reasignaciones por episodio de espera**. Al llegar al tope se avisa a los supervisores y no se rota más. |
| D4 | La reasignación sigue el reparto actual entre `agents.is_active` y **excluye al asesor actual** y a los que ya rotaron en el episodio. No hay estado "conectado". |
| D5 | Máximo **5 productos por lista**. |
| D6 | **Precio vigente al facturar.** El carrito guarda `product_id` y cantidad; el precio sale de `products` + BCV vía `productPriceUsd`/`usdFromBs`. |
| D7 | `disponible_en_espera = true` solo para **Ubicación, Envio gratis Cashea y Postventa Cashea**. |
| D8 | Leer imágenes queda **fuera** de esta ola. |
| Entregas | **Dos entregas.** A = Seba, en `entrega/seba-encuentra`. B = Mostrador, en `entrega/mostrador-sin-esperas`, creada desde la punta de A. Ninguna toca `main`. |

### Hallazgos de la exploración que cambian el pedido

- **La tolerancia N−1 no vive en SQL**, sino en `tools.ts:410` (`requerido`). La regex `\m` y los conteos sí están en `20260926010000`.
- `catalog-search.ts` vive en **`src/lib/ai/`**. `expandTerms` ya no existe: los sinónimos entran en `catalogTermGroups` (L288).
- **`customer_message` queda en null con foto + pie** porque `lastCustomerMessage` (agent.ts:395) descarta todo lo que calza `isHistoryMarker`, y eso incluye `[El cliente envió una foto. Pie: …]`.
- **3.2 confirmado por lectura.** 20 mutaciones de configuración en `mutations.ts` solo miran `error`. Un UPDATE o DELETE que la RLS bloquea afecta 0 filas y pasa por éxito. Solo `createPlaybook`, `issueInvoice` y `voidInvoice` usan `.select()`.
- Los paneles ya ocultan la edición de catálogos a un `agent`. Aun así, el guardado desde una sesión con otro rol, o desde una página que quedó abierta después de un cambio de rol, "funciona" sin cambiar nada. **Hay tres controles sin puerta de rol:** el interruptor global de la IA (`agent-control-view.tsx:779`), las tarifas de modelos (L1079) y la disponibilidad del roster (L1264). La reproducción con un usuario `agent` confirma el mecanismo antes de corregir.
- `agent_can_run()` solo mira el interruptor global y el tope de gasto. El turno por demora puede respetarlo sin cambios.
- **No hay tipo de turno en la cola:** el ZSET guarda solo el `conversationId`. `deliver()` corta con `humano_se_adelanto` si un asesor escribió en los últimos 30 min. El turno por demora necesita **su propio camino**, fuera de la cola, con otra puerta de envío.
- `isAssignmentNotice` solo dispara con `reason === "escalada"`. El último CHECK de `conversation_handoffs.reason` está en `20260917010000:270-310`.
- **Desvío sobre la sección 6 del pedido.** "defensa 250" a secas calza de verdad con DEFENSA BRZ 250, porque "250" es un token completo del nombre. El caso real que falló era **"defensa gxs 250"** y **"defensa ava mustang 250"**: calzaban por N−1 con solo el 250. Esos dos casos son los que entran al test. Además, `250`/`200cc` sueltos se leen como cilindrada: pasan a moto, que solo ordena.

---

## ENTREGA A — Seba (`entrega/seba-encuentra`)

### T1 · Búsqueda: opcionales, marca obligatoria, números completos — migración `20260928010000_busqueda_marca_obligatoria`

**SQL (commit `[migración]` aparte)**
- Firma nueva: `buscar_productos(p_terminos jsonb, p_moto jsonb default '[]', p_limite int default 10, p_opcionales jsonb default '[]')`.
- La vieja se retira con `drop function` en la misma migración. La nueva lleva los dos revokes por firma más `grant … to service_role`, conserva `security invoker` y termina con `notify pgrst`, `lock_timeout` y la guarda de `-1`.
- Columnas nuevas en el retorno:
  - `puntaje_opcional int`: cantidad de grupos opcionales que calzan. Solo sirve para desempatar.
  - `empieza_con_producto boolean`: `search_text` empieza con alguna alternativa del primer grupo obligatorio. Pone "RIN TRASERO BERA" antes que "EJE RIN TRASERO BERA".
  - `filas_con_maximo_y_stock bigint`: ventana sobre las filas del máximo (y de la moto, si calza) con `stock_quantity > 0`.
- Orden: `puntaje, puntaje_moto, empieza_con_producto, puntaje_opcional, stock>0, name`.
- Regex:
  - Una alternativa que **termina en dígito** lleva `\M` al final. Así `50` no calza con `5000` y `dt200` no calza con `dt2000`.
  - Una alternativa que **empieza en dígito y trae punto** (`11.7`) acepta un prefijo de letras: `(\m|[a-z])11\.7\M`. Con eso "11.7" calza con "h11.7".
- **Test:** `supabase/tests/buscar_productos.sql` se amplía con nombres reales y el **ruido insertado antes** que los productos correctos. Casos:
  - Todos los de la sección 6.
  - "defensa gxs 250" y "defensa ava mustang 250" no traen DEFENSA BRZ 250. Se prueba **también con la moto normalizada** (query "defensa", moto `{gxs}` o `{ava mustang}`, cilindrada `{250}`): la cilindrada sola no calza la moto, así que no restringe a BRZ 250 ni la cotiza. Lleva además un test en `tools.test.ts`: con esa entrada no se cotiza DEFENSA BRZ 250.
  - "leva racing 200cc" encuentra ARBOL DE LEVA CG150 RACING.
  - "rin trasero" + moto bera pone primero RIN, no EJE.
  - "11.7" encuentra el Givi H11.7.
  - Los casos 1-13 de hoy siguen en verde, ajustando solo lo que dependía de N−1 o de `\m50`.

**TypeScript (`src/lib/ai/catalog-search.ts`)**
- Exporta `DESCRIPTIVAS`, la lista cerrada del pedido: colores, mate, brillante, delantero/a, trasero/a, izquierdo/a, derecho/a, semi, sintético, mineral, original, genérico, universal, económico, bueno/a, integral, cromado, moto, talla, 4t/2t, edge, juego, par y adaptable. Se compara ya singularizada y sin acentos, y lleva test.
- Función nueva `catalogQuery(query, synonyms) → { grupos, opcionales, moto }`:
  - Los términos de `DESCRIPTIVAS` van a `opcionales`.
  - "4 tiempos" y "2 tiempos" se convierten en el opcional `{4t}` o `{2t}`.
  - `NNNcc` y los números sueltos de 3 dígitos entre 50 y 400 son **cilindrada**. Van a un campo aparte, `cilindrada`, que se pasa a SQL como grupo de moto **solo para ordenar**.
  - **Corrección del operador:** la cilindrada nunca vuelve verdadero a `motoCalza` ni restringe resultados. `motoCalza` exige que calce una marca o un modelo **con nombre**. Por eso el SQL devuelve `puntaje_moto_nombre` separado de `puntaje_moto_cilindrada`, y `tools.ts` restringe solo con el primero.
  - Las marcas y modelos de moto conocidos van a `moto`. La lista `MOTOS_CONOCIDAS` es exportada y tiene test: bera, sbr, kavak, horse, ek, xpress, tx, gs, gr, rk, owen, jaguar, lechuza, socialista, brz, ava, mustang, empire, md, beta, etc.
  - `catalogTermGroups` queda como envoltorio o se retira si nadie más lo usa. `knowledge.ts` usa `searchTerms` y no cambia.
- **Viscosidad:** `(0|5|10|15|20|25)\s*[/\-\s]\s*(20|30|40|50|60)` produce un solo grupo `{NNwNN}`. Se restringe a esos valores a propósito, para que "90/90-18" (medida de caucho) no se lea como aceite.
- **No unir palabras cortas con el número siguiente:** de, del, en, y, o, a, al, la, el, es, un, por, con, x. "año" y "ano" se suman al `RELLENO`. Así "maleta de 45" da `{maleta}{45}`.

### T2 · Segundo intento tolerante a tipeos — migración `20260928020000_corrector_de_terminos`

**SQL**
- `fuzzystrmatch` se crea **en el mismo schema que `pg_trgm`**. Un bloque `do $$` lee `extnamespace::regnamespace` de `pg_extension where extname = 'pg_trgm'` y ejecuta `create extension if not exists fuzzystrmatch with schema <ese>`. Las llamadas van calificadas con ese schema, o dentro de un `search_path` que lo incluya.
- Función `public.corregir_terminos(p_terminos text[], p_protegidos text[]) returns table(original text, corregido text)`. Se revisó el pedido de justificar `security definer` y la conclusión es **`security invoker`**, igual que `buscar_productos`:
  - La única llamada llega con `service_role`, que ya salta la RLS. No hay costo de política por fila, que es el único motivo por el que otras funciones son definer (`20260921030000`).
  - Un definer solo agregaría superficie de ataque.
  - Lleva igual los dos revokes y `grant … to service_role`, y `set search_path` fijo.
  - Si el subagente encuentra un motivo real para definer, lo escala al orquestador en vez de decidirlo solo.
- Vocabulario: las palabras distintas de `search_text` de los productos activos, calculadas al vuelo. Son unas 6.000 filas y solo se consultan en el camino sin coincidencia.
- Se corrige un término solo si se cumple todo esto:
  - tiene 4 letras o más;
  - no tiene dígitos;
  - no está ya en el vocabulario;
  - no está en `p_protegidos`, que es `MOTOS_CONOCIDAS`. Por eso **beta no pasa a bera**.
- El candidato se elige por `levenshtein` ≤ umbral según el largo, desempatado por `similarity` y por frecuencia. El umbral lo ajusta el subagente con los casos: horsen→horse, tisum/stinsun→timsun, express→xpress, iphone→ipone, motopower→motorpower, swhera→switchera, ciguañal→ciguenal. Los casos que no pueden corregirse mal: beta y números.
- Test SQL con los casos buenos y los malos.

**TypeScript**
- Envoltorio puro `src/lib/ai/catalog-correction.ts` (llamada a la RPC + tipo), con test.
- La integración con la herramienta la hace T3b.

### T3a · Herramienta `buscarRepuesto` (`src/lib/ai/tools.ts`)

1. **Sin N−1:** `requerido = grupos.length`. El comentario de la tolerancia se reescribe.
2. **Genérico según stock:** se decide con `filas_con_maximo_y_stock`.
   - Si el total calza con más de 3 filas pero ninguna tiene stock, sale **sin_stock**.
   - Si hay 1 a 3 con stock, se cotizan esas.
   - Si hay más de 3 con stock, sale genérico.
   - `GENERICO_INSTRUCTION` suma «no afirmes que hay existencia».
3. **Memoria del pedido en Redis:** clave `catalogo:pedido:<conversationId>`, TTL 6 h. Guarda `{ultimoQuery, moto, preguntaHechaPara}`. El módulo nuevo es `src/lib/ai/catalog-memory.ts`, con API `leer`/`guardar` que nunca lanza y un test con `FakeRedis`. Sin Redis se comporta como hoy; va como trampa en el CLAUDE.md.
4. **Una sola pregunta por pedido.** Si la búsqueda sale genérica y la pregunta ya se hizo para ese producto, o si la ráfaga del cliente pide ver todo (`pideVerTodo`: "no sé", "cualquiera", "muéstrame todos", "los que tengas"), no se pregunta. Se devuelven las 3 opciones con stock más relevantes con la instrucción `confirmar_inventario`. La ráfaga llega a la herramienta por `deps`.
5. **Respuesta suelta:** si el query no tiene ningún término de producto (solo talla, color, año, medida, viscosidad, marca de moto o número), se combina con `ultimoQuery` y la moto guardada. Casos:
   - "24" después de asiento + sbr;
   - "20w50" después de "aceite inca";
   - "Talla M" después de "casco frankie negro".
6. **La moto se normaliza siempre** con `catalogQuery().moto`, sumada a `motoBrand`/`motoModel`. "asiento sbr" da lo mismo que "asiento" + moto "sbr".
7. **Listas:** `productos?: string[]` (máximo 5, D5). Se hace una búsqueda por producto y sale un resultado por producto. Si alguno tiene stock, la instrucción es `confirmar_inventario`. El resumen lleva la lista ordenada.
8. `CatalogOutcome` suma `cotizacion: LineaCotizada[]` y `preguntaFiltro: "moto" | "producto" | null`. El modelo elige cuál pregunta con la entrada nueva `dependeDeLaMoto?: boolean`. El código sigue insertando en `conversation_quotes` como hoy.

### T3b · Cotización y pregunta armadas por código, corrector y promesa falsa (`agent.ts`, integración de T2 en `tools.ts`)

- **Integración de T2.** Si el primer intento no calza, se llama a `corregir_terminos` y se reintenta una vez. Si hubo corrección, `instruccionParaTuRespuesta` la nombra ("busqué IPONE en lugar de iphone") y la instrucción queda en `confirmar_inventario`.
- **Cotización.** Si el turno tiene `catalogOutcome.cotizacion` no vacía, el mensaje al cliente se arma así:
  - un preámbulo opcional del modelo: una sola línea de 240 caracteres como máximo, sin cifras de dinero (`moneyFigures`) y sin ser el mismo texto fijo;
  - el bloque que arma `armarCotizacion()`, un módulo puro nuevo en `seba.ts` o `quote-message.ts` con test: nombre exacto, "$X BCV (Bs. Y)" y "N disponibles/Agotado";
  - el **texto fijo literal** (`TEXTO_CONFIRMAR_INVENTARIO` o `TEXTO_SIN_STOCK`).

  La escalada sigue ocurriendo por la herramienta o por la red de seguridad, pero ya no se puede tragar la cotización (caso de la cinta). Todo el texto pasa por `price-guard` (las cifras vienen del `toolResult`) y por la guarda de identidad. Hay un test que lo afirma.
- **Pregunta de filtro:** con `preguntaFiltro`, el texto enviado es `PREGUNTA_FILTRO` o `PREGUNTA_FILTRO_PRODUCTO` **literal**, más el preámbulo opcional. El código marca `preguntaHechaPara` en la memoria.
- **Guarda de promesa falsa.** Si el texto afirma que un asesor ya tiene, revisa o va a atender el caso, no hubo escalada en el turno y no hay asesor asignado, se escala con `seguimiento`, para que la afirmación sea verdad. Módulo puro con test.
- **Una queja siempre escala:** test en `agent.test.ts`, incluso con escalada abierta y asesor asignado (hoy la red devolución/queja exige `!esperandoAsesor`; con asesor queda nota de reiteración).

### T4 · Guion (`src/lib/ai/prompt.ts`, prefijo cacheable)
- Solo políticas que trae la biblioteca en el turno. Divisas, retiro en tienda, garantías y agencias sin fuente se pasan al asesor.
- Nunca "un asesor ya tiene tu caso" sin haber llamado a escalar en ese turno. La guarda en código es T3b.
- No retomar pedidos de antes de `PREVIOUS_CONVERSATION_GAP_HOURS` (vive en `history-line.ts:613`).
- "No me abre el link": no reenviar el mismo link; ofrecer que un asesor mande fotos, y si la tienda está cerrada decir cuándo abre.
- Explicar al modelo que el código envía la cotización y la pregunta, y que él solo agrega una línea previa si hace falta.
- Test: el prefijo sigue siendo idéntico entre turnos y el texto nuevo pasa la guarda de identidad.

### T5 · Espera con escalada abierta — migración `20260928030000_escenario_disponible_en_espera`
- Columna `ai_playbooks.disponible_en_espera boolean not null default false`. Se marcan por nombre, sin distinguir acentos ni mayúsculas, Ubicación, Envio gratis Cashea y Postventa Cashea, con un `raise notice` que informa cuántas filas cambiaron. No aborta si falta alguna.
- En la rama `escalationOpenNow` (`agent.ts` ~2046), el filtro pasa a ser: `disponibleEnEspera`, no despedida, no `escalate`. Además se aplican `alreadySentPlaybook` y `playbookSentRecently` (6 h), la misma regla que la fase 0.
- Panel: interruptor "Puede salir mientras espera al asesor" en `playbooks-panel.tsx`. También cambian `playbookRow`, `fetchPlaybooks`, el tipo `Playbook` y `database.types.ts`.
- **Tarea del operador, no de código:** marcar `cede_al_inventario` en "CATALOGO CASCOS" desde el panel.

### T6 · Registro — migración `20260928040000_turnos_registran_busquedas`
- `agent_turns.catalog_queries jsonb`. Guarda un arreglo con `{query, productos, moto, grupos, opcionales, corregido, resultado}` por cada llamada, y `logTurn` lo escribe.
- `lastCustomerMessage` devuelve el pie de una foto: el marcador con `Pie:` da el texto del pie. `messages.content` sigue igual.
- `log.info("busqueda_catalogo", …)` por llamada.

### T7 · Guardados de configuración que no mienten (3.2)
- **Primero:** reproducir con un usuario `agent` contra la base local. `update catalog_links` como `authenticated` debe afectar 0 filas sin error. Se deja un test SQL `supabase/tests/config_solo_supervisor.sql` que lo fija para cada tabla.
- Helper `assertRowsAffected(data, accion)` en `mutations.ts`, que lanza `"Solo un supervisor o administrador puede cambiar esto."`. Se aplica con `.select("id")` a las 20 mutaciones listadas: agent_settings ×3, playbooks ×3 más tags, lessons ×2, agent_tools, knowledge ×6, agents, suggestions, model_pricing, catalog_links ×4, stickers. Test por mutación con un fake que registra `.select`.
- Puertas de rol en el panel para los tres controles que no las tienen: interruptor global de la IA, tarifas por modelo y roster. Los demás ya tienen `canEdit`.
- El reporte lleva la tabla de auditoría.
- **Corrección del operador.** Como el panel ya oculta la edición de catálogos a un `agent`, el guardado silencioso **puede no ser la causa** del reclamo. La corrección se hace igual, y el reporte tiene que listar, con evidencia, qué caminos reales quedan para que un guardado "funcione" sin cambiar la base:
  - una sesión vieja con el rol cambiado después de cargar la página, porque `currentAgent` sale del servidor al cargar;
  - un usuario cuyo `agents.role` no es el que cree;
  - otros paneles o formularios que escriben `catalog_links` o el texto de escenarios y mensajes rápidos donde vive la URL. Por ejemplo, un mensaje rápido con la URL escrita a mano en vez del marcador: **eso explicaría el `1wWJ1PvF…` que mandan los asesores**, porque `quick_replies` la escribe cualquier agente;
  - la RLS de `catalog_links` contra el rol real.

  El operador lo reproduce en paralelo como admin en producción; el reporte deja listo qué mirar allá.
- **Causa CONFIRMADA en producción por el operador.** El mensaje rápido `quick_replies` "CATALOGO CASCOS" tiene la URL escrita a mano (`1wWJ1PvF…`, editada el 28/9 a las 15:44 UTC). `catalog_links.cascos` sigue en `1oDrYm…` desde el 25/9. Asesores y Seba leen de lugares distintos. Además de lo anterior:
  - **Mensajes rápidos con marcadores de verdad.** Los marcadores `{{catalogo:clave}}` y `{{catalogos}}` se resuelven contra `catalog_links` **al enviarse**, igual que en los escenarios, con `resolveCatalogMarkers` de `src/lib/catalog-links.ts`. Hoy el composer ya reemplaza el marcador al pegar el mensaje rápido (18/9). El subagente verifica ese camino y además resuelve en el envío cualquier marcador que haya quedado en el texto. Así una sola fuente gobierna, aunque el asesor pegue el mensaje y tarde en mandarlo. Un marcador sin resolver no sale nunca: se aplica el mismo aviso que hoy.
  - **Aviso en el panel de mensajes rápidos.** Si el texto trae una URL de Google Drive que coincide con un catálogo configurado, o que parece un catálogo (Drive + nombre/atajo con "catálogo"), el panel muestra: "Usá el marcador para que Seba y los asesores manden el mismo link". Si la URL coincide, ofrece el marcador exacto.
  - **Test:** un mensaje rápido con `{{catalogo:cascos}}` envía la URL vigente de `catalog_links`. Si cambia el link en `catalog_links`, el mismo mensaje rápido manda el nuevo. El aviso aparece con una URL de Drive escrita a mano.
  - **Tarea del operador (nota de entrega):** reemplazar la URL a mano de "CATALOGO CASCOS" en `quick_replies` por `{{catalogo:cascos}}` y decidir cuál de los dos links es el vigente (`1wWJ1PvF…` o `1oDrYm…`) para cargarlo en `catalog_links`.

### Tandas de A (sin archivos compartidos dentro de una tanda)
1. **T1 ‖ T4 ‖ T7**
2. **T2 ‖ T3a ‖ T5**. T5 toca la rama de espera de `agent.ts` y `playbooks-panel`; T3a toca solo `tools.ts` y `catalog-memory`.
3. **T3b**
4. **T6**
5. **T11a:** docs de A.

Entrega A lleva 4 migraciones, en este orden: `20260928010000` → `020000` → `030000` → `040000`. Cada una va en su commit `[migración]`, antes del código que la usa.

---

## ENTREGA B — Mostrador (`entrega/mostrador-sin-esperas`, desde la punta de A)

### T8 · Carrito por conversación — migración `20260929010000_carrito_por_conversacion`
- Tabla `conversation_cart_items`:

| Columna | Detalle |
|---|---|
| `id` | |
| `conversation_id` | fk con cascade |
| `product_id` | fk |
| `quantity` | int > 0 |
| `origin` | `quote` o `inventory` |
| `quote_id` | null |
| `added_by` | |
| `created_at`, `updated_at` | |

  - `unique(conversation_id, product_id)`, porque un repetido suma unidades.
  - RLS `is_agent()` para select, insert, update y delete.
  - `replica identity full`, publicación `supabase_realtime` con autoverificación, y `grant` a `authenticated`.
- Datos: `fetchCart` en `data.ts`; `addToCart` (upsert que suma), `setCartQuantity` y `removeFromCart` en `mutations.ts`. Todas verifican filas.
- Módulo puro `conversation-cart.ts`: precio con `productPriceUsd` (D6, vigente), total en Bs y $ con `usdFromBs`. No se duplica el redondeo.
- Panel: bloque "Lo que lleva el cliente" en `context-panel.tsx`, entre la búsqueda y Notas. Tiene botón **Agregar** en cada resultado de `InventoryLookup`, cantidades editables, quitar, total, y "Agregar cotizaciones de Seba" (`fetchConversationQuotes`).
- Realtime: canal `cart-${conversationId}` en `crm-shell.tsx` con el patrón `realtimeStatusHandler`.
- Modal: `CloseSaleModal` arranca con el carrito persistido y sus cambios escriben en la tabla.
- Cierre: `closeSaleWithContactInfo` crea `orders`/`order_items` desde el carrito; ese es el vínculo, por `product_id`. Después vacía el carrito. Si falla el vaciado queda un toast de aviso, sin revertir la venta.
- **Cambio visible por D6:** una cotización de Seba se factura al precio vigente, no al cotizado. Va escrito en la nota de entrega.
- **Pedido del operador.** El renglón que vino de una cotización de Seba guarda `quote_id`. Si el precio cotizado (`conversation_quotes.price_usd`) difiere del vigente, muestra "cotizado $X · hoy $Y". Se factura el de hoy. La comparación vive en `conversation-cart.ts` y tiene test.

### T9 · Scroll, "Ver más" y pastilla de existencia (3.3 + 3.5)
- `LOOKUP_LIMIT` pasa de 8 a 20, con paginado `range()` y "Ver más". La lista lleva `max-height` y `overflow-y: auto`, sin empujar Notas. Se reescribe el comentario.
- Componente `StockPill` ("12 en stock" en verde, "Agotado" en rojo o apagado) con tokens de `theme.css` que cumplen contraste en tema claro y oscuro. Se usa en la búsqueda, en el carrito y en `sale-items-editor.tsx`. El renglón del carrito se marca si el producto quedó en 0.
- Test de componentes (jsdom) más **Playwright** sobre el build de producción: 1366 y 1100 px, tema claro y oscuro, 30 resultados con scroll, "Ver más" y pastillas. Las capturas van al reporte. **Si el operador ve otra cosa en su pantalla, se pide su captura antes de cerrar.**

### T10 · Nadie sin atender (3.4)

**Migración `20260929020000_demora_del_asesor`**
- Agrega al CHECK de `reason` (lista completa copiada de `20260917010000`): `reasignada_por_demora` y `demora_sin_asesor`.
- `agent_settings.demora_activa boolean default false` y `demora_activa_desde timestamptz`, con un interruptor sup/admin en Control IA.
- Tabla `conversation_delay_episodes(conversation_id, episode_at, origen text check in ('escalada','cliente'), responded_at, reassignments int default 0, agentes_previos uuid[] default '{}', ultima_reasignacion_at timestamptz, supervisor_notified_at)` con `primary key(conversation_id, episode_at)`. Es el candado de idempotencia: la fila se reclama con `insert … on conflict do nothing` y `update … where responded_at is null returning`. Tiene RLS sin políticas y se lee solo con `service_role`. Los traspasos van con `recordHandoff`.

**Lógica**
- Módulo puro `src/lib/ai/demora.ts`: `evaluarDemora(estado, now, businessHours)` → `nada | responder | reasignar | avisar_supervisor`.
- **Corrección del operador, medida en producción.** Hubo 283 escaladas en 3 días; 201 quedaron sin mensaje del asesor en 15 min, y en 62 de esas el cliente no volvió a escribir. La despedida de Seba al escalar mueve `last_reply_at` y deja `awaiting_reply` en false, así que un reloj atado solo a `awaiting_reply` o al "último mensaje sin respuesta" **nunca arrancaría**. Por eso hay **dos orígenes de episodio**, y gana el más reciente:
  1. **Escalada abierta sin mensaje de asesor desde la escalada.** El episodio es el `created_at` del traspaso **original**, `escalada` o `escalada_sin_asesor`. **`reasignada_por_demora` no abre un episodio nuevo** (segunda corrección del operador): continúa el de la escalada original, con el mismo `episode_at`, y `reassignments` y `agentes_previos` se acumulan en esa fila. Los 15 min siguientes se cuentan desde la **última reasignación**, que se guarda en la columna `ultima_reasignacion_at` del episodio. Si no fuera así, cada reasignación reiniciaría el contador en 0 y el tope de 2 no llegaría nunca: rotaría cada 15 min sin fin. **Test:** escalada a las 10:00 sin respuesta → reasigna a las 10:15 y a las 10:30 → a las 10:45 avisa al supervisor y no rota más. Se cuenta desde el traspaso, sin importar `awaiting_reply`. En este origen **Seba no responde a los 10 min** (ya respondió al escalar), salvo que el cliente haya escrito algo nuevo después de esa respuesta. A los 15 min se reasigna.
  2. **Mensaje del cliente sin respuesta real**, con las condiciones de abajo.

  **Test:** escalada a las 10:00, el cliente no escribe más y ningún asesor escribe. A las 10:10 no pasa nada; a las 10:15 se reasigna a otro asesor. La clave del episodio en `conversation_delay_episodes` es `episode_at` = la fecha de su origen.
- Origen 2: episodio = `last_customer_message_at`. Solo cuenta si:
  - `awaiting_reply` es true;
  - la conversación está abierta;
  - está dentro de la ventana de 24 h;
  - `lcma > demora_activa_desde`, para que el backlog no dispare de golpe al encender. Esto vale también para el origen 1, con la fecha del traspaso;
  - la ráfaga no es solo cortesía o sticker (`isCourtesyOnly`, `customerBurst`);
  - ningún asesor escribió después de `lcma`.
- **A los 10 min**, `runDelayTurn` (`src/lib/ai/delay-turn.ts`):
  - camino propio fuera de la cola, con `withConversationTurnLock`;
  - respeta `agent_can_run()` (interruptor global y gasto);
  - se salta a propósito las guardas `ai_enabled` y `humanHasWritten`; su puerta de envío solo corta si un asesor escribió después de `lcma`;
  - usa `runTurnPhases` con opción `modo: "demora"`, que implica: sin herramienta de escalar, sin escalada en las redes de seguridad ni en `price-guard`, sin saludo, escenarios solo `disponible_en_espera` no enviados, y sufijo de límites D2;
  - si no hay texto, manda el texto fijo `TEXTO_ESPERA_DEMORA`. Fuera de horario, el texto nombra la próxima apertura (`businessStatus().nextOpening`);
  - sale con `isAutoReply: true`, deja la nota interna "Seba respondió por demora de N min" y `log.info("respuesta_por_demora")`;
  - no cambia `ai_enabled`.
- **A los 15 min, solo en horario:**
  - si hay asesor asignado, o la escalada está abierta sin asesor, se reclama un asesor con `claimNextAvailableAgent(supabase, { excluir })` (parámetro nuevo);
  - traspaso `reasignada_por_demora`, nota al anterior y `log.info("reasignada_por_demora")`;
  - `isAssignmentNotice` también acepta `reasignada_por_demora`;
  - `escalationOpen` trata `reasignada_por_demora` como escalada abierta.
- **Con 2 reasignaciones:** traspaso `demora_sin_asesor` al mismo dueño (entra en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`) y aviso tipo toast a supervisores y admins en el `AssignmentNotifier`. No se rota más.
- **Ruta** `/api/cron/asesor-sin-responder` con Bearer `CRON_SECRET` y `timingSafeEqual`. Máximo 5 conversaciones por pasada. El `curl` se suma en `docker-compose.yml` **y** en `docker-compose.dokploy.yml`.
- **Tests** con reloj falso: todos los de la sección 3.4, incluidos 9:59 contra 10:00, nunca el mismo asesor, fuera de horario, tope, ok/gracias, dos pasadas en el mismo minuto que dan una sola acción, y que la IA no queda reactivada. Más un test SQL de la tabla y del CHECK.

### Tandas de B
1. **T8**
2. **T9 ‖ T10a** (migración). Luego **T10b** (lógica). T9 y T10 no comparten archivos.
3. **T11b:** docs de B.

Entrega B lleva 2 migraciones: `20260929010000` → `20260929020000`.

---

## Secuencia acordada con el operador
1. Guardar el plan en `docs/planes/2026-09-28-seba-encuentra-y-el-mostrador-no-deja-esperando.md` y el progreso en la memoria. El progreso se actualiza en la memoria después de cada tarea validada.
2. Entrega A completa y verificada → **push de `entrega/seba-encuentra`** (nunca `main`) → nota de entrega → aviso al operador.
3. Continuar sin esperar con la Entrega B, sobre la punta de A → **push de `entrega/mostrador-sin-esperas`** → nota de entrega → aviso al operador.

## Reglas para los subagentes (tipo `implementador`, Sonnet)
- **Primero el test en rojo, después el código.** Va en cada prompt.
- No commitean. El orquestador commitea cada tarea validada, con commits narrativos en español y `[migración]` en un commit aparte (`git commit -F`).
- `redis-queue`/`queue` se prueban con Redis levantado (`sbk_redis`). Los tests SQL se corren con `docker exec -w /tmp/repo … psql -1 -v ON_ERROR_STOP=1`.
- **Ninguna migración se aplica desde esta máquina a producción.** En local, sí contra la base de Docker.
- Cada reporte actualiza `docs/GLOSARIO.md` para los archivos que toca.
- Mutaciones manuales, respaldando con `cp`:

| Mutación | Tarea | Test que tiene que ponerse rojo |
|---|---|---|
| (a) volver a N−1 | T3a | Inca |
| (b) `\m50` sin `\M` | T1 | iphone 20/50 |
| (c) genérico sin stock | T3a | botas |
| (d) sin no-repetir en espera | T5 | escenario |
| (e) sin `.select()` en `updateCatalogLink` | T7 | 3.2 |
| (f) sin excluir al asesor actual | T10 | reasignación |
| (g) la cilindrada vuelve verdadero a `motoCalza` | T3a | defensa gxs 250 con la moto normalizada |
| (h) `reasignada_por_demora` abre un episodio nuevo | T10 | 10:00 → 10:15 → 10:30 → aviso a las 10:45 |

## Verificación (el orquestador, al cierre de cada entrega)
- Tipos, lint y suite completa: `rtk npx tsc --noEmit`, `rtk npm run lint`, `rtk npm run test`.
- Todo `supabase/tests/` contra una base reconstruida desde cero.
- Build: `rtk proxy npm run build` y el timestamp de `BUILD_ID`.
- Escenario a mano en local con la búsqueda nueva: Inca, botas, "asiento sbr" → "24", lista batería + arranque, espera con escalada sin repetir el PDF.
- En B: Playwright para 3.1, 3.3 y 3.5, y cron a mano con reloj forzado para 3.4.
- Réplica del CI en Node 22 con una rama `ci/**` desechable.
- Push **solo** de las ramas `entrega/*`.
- Nota de entrega en `docs/entregas/2026-09-28-…md`: SHA, `git ls-remote --heads origin`, migraciones en orden, pasos del VPS (respaldo, `BEGIN…ROLLBACK`, aplicar, fast-forward), orden de encendido de la demora (desplegar B, avisar a los asesores, encender `demora_activa`) y cómo medir 48 h.
- El **T11** actualiza `GLOSARIO.md`, las trampas del `CLAUDE.md` (sin N−1, memoria del pedido en Redis, cotización por código, `disponible_en_espera`, `assertRowsAffected`, carrito con precio vigente, turno por demora fuera de la cola) y `docs/PRODUCCION.md` (ruta de cron y encendido).
