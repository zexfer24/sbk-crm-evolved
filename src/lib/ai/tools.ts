import "server-only";
import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { BUSINESS_NAME } from "@/lib/brand";
import { getBcvRate } from "@/lib/ai/bcv";
import {
  catalogQuery,
  MARCAS_CONOCIDAS,
  MARCAS_DE_MOTO,
  MARCAS_DE_PRODUCTO,
  motoDesdeTexto,
  MOTOS_CONOCIDAS,
  RELLENO_CATALOGO,
  type MotoCorregida,
  type MotoDesdeTexto,
  type SearchSynonym,
} from "@/lib/ai/catalog-search";
import {
  corregirTerminos,
  describirCorreccion,
  diagnosticarTerminos,
  type CorreccionTermino,
  type DiagnosticoGrupo,
} from "@/lib/ai/catalog-correction";
import { guardarPedido, leerPedido } from "@/lib/ai/catalog-memory";
import { pideVerOpciones, pideVerTodo } from "@/lib/ai/catalog-request";
import { formatQuote } from "@/lib/ai/precio";
import {
  RECLAMO_CATEGORIES,
  escalateConversation,
  type EscalateResult,
  type EscalationMotivo,
  type ReclamoCategory,
} from "@/lib/ai/escalate";
import {
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_NO_IDENTIFICADO,
  TEXTO_SIN_STOCK,
} from "@/lib/ai/seba";
import { inventoryAgeInstruction, inventoryFreshness } from "@/lib/inventory-freshness";
import { usdFromBs } from "@/lib/usd-price";
import { errorText, log } from "@/lib/log";
import type { BusinessHours, BusinessStatus } from "@/lib/business-hours";
// F (20/9/2026, "El resguardo antes del push", C3): mismo escapado de
// literales que `catalog-search.ts` usa para el `.or()` de `products` — acá
// hace falta para no interpolar `conversationId` crudo en el `.or()` de
// `ai_lessons` (ver más abajo).
import { pgrstLiteral } from "@/lib/ai/pgrst";

/**
 * Tope de repuestos que se le pasan al modelo de una vez.
 *
 * Sin tope, un término genérico —«repuesto», «moto», «aceite»— metía el
 * catálogo entero en el contexto, con precios, stock y compatibilidades de
 * cada producto, y se repetía en cada paso del tool loop.
 *
 * Diez no es solo por costo: nadie lee veinticinco repuestos en un mensaje de
 * WhatsApp. Si hay más, conviene que la IA pida precisar antes que enumerar.
 */
const MAX_CATALOG_RESULTS = 10;

/**
 * Tope de sinónimos activos (`ai_lessons.kind = 'sinonimo'`) que se leen en
 * cada búsqueda (T5c, 18/9/2026, ver catalog-search.ts). 200 es
 * generosamente más de lo que un equipo de asesores va a acumular en la
 * práctica; el límite existe para que la consulta nunca sea ilimitada, no
 * porque se espere acercarse a él.
 */
const MAX_SYNONYM_LESSONS = 200;

/**
 * T3, "Seba atiende el mostrador" (18/9/2026, requisitos 2/3/4 del cliente):
 * hasta esta corrida un repuesto en cero solo dejaba un aviso suelto
 * (`SIN_STOCK_INSTRUCTION`, ver abajo qué reemplazó) y nada obligaba a
 * escalar. Ahora TODA llamada al catálogo con resultado termina en una de
 * cuatro instrucciones, en este orden de precedencia (`generico` primero
 * porque es la única que le prohíbe escalar: requisito 5, la única
 * pregunta):
 *   1. `generico` — varios repuestos calzan y ninguna moto los distingue:
 *      UNA pregunta de filtro, sin escalar en este turno.
 *   2. resultados con existencia — cotiza y escala con `confirmar_inventario`.
 *   3. resultados todos en cero — avisa y escala con `sin_stock`.
 *   4. sin resultados (o el motor de búsqueda no encontró términos) — avisa
 *      y escala con `no_identificado`.
 * Los tres textos que el modelo tiene que decir TEXTUAL vienen de `seba.ts`
 * (el cliente los dictó, o el operador los fijó para el caso 4): nunca se
 * escriben literales acá, para que no puedan desincronizarse de lo que dicta
 * el prompt (sección 5.1) ni de lo que exporta `seba.test.ts`.
 *
 * T2, plan "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026, D1
 * del operador): antes de esta ola la pregunta de filtro era SIEMPRE por la
 * moto («¿para qué modelo y año?»), aunque el repuesto no dependiera de
 * ella — un aceite o un casco no necesitan saber la moto, y preguntarla de
 * todos modos era una vuelta de más. Hasta el 28/9/2026 el modelo elegía
 * entre los DOS textos según si el repuesto depende de la moto (piezas de
 * motor, frenos, carrocería, eléctrico, transmisión → `PREGUNTA_FILTRO`) o
 * no (aceites, cascos, intercomunicadores, maletas, accesorios →
 * `PREGUNTA_FILTRO_PRODUCTO`); desde T3a lo declara con `dependeDeLaMoto` y
 * el CÓDIGO elige cuál va (ver `instruccionGenerica`).
 */
/**
 * T3a (28/9/2026): la instrucción de una consulta genérica ya no deja elegir
 * al modelo entre las dos preguntas — el CÓDIGO decide cuál (`preguntaFiltro`,
 * según `dependeDeLaMoto` de la entrada y si el cliente ya dio su moto) y la
 * instrucción trae SOLO esa. Con `motoIgnorada` (el cliente dio la moto pero
 * ninguno de los repuestos que más calzan la nombra: no sirve para filtrar)
 * además se le prohíbe volver a preguntar por ella. "No afirmes que hay
 * existencia": con la pregunta pendiente todavía no se sabe cuál repuesto
 * quiere, y decir "tenemos" antes de tiempo fue lo que el estudio del VPS
 * (25-28/9/2026) encontró en las botas sin una sola unidad.
 */
function instruccionGenerica(pregunta: "moto" | "producto", motoIgnorada: boolean): string {
  const texto = pregunta === "moto" ? PREGUNTA_FILTRO : PREGUNTA_FILTRO_PRODUCTO;
  const yaDioLaMoto = motoIgnorada
    ? " El cliente ya dijo su moto y ninguno de los repuestos que más calzan la menciona: no vuelvas a preguntar por ella."
    : "";
  return `El cliente no dio ningún dato que distinga cuál de los varios repuestos que calzan quiere: haz UNA sola pregunta de filtro, «${texto}», y NO escales en este turno.${yaDioLaMoto} No afirmes que hay existencia ni des precios: todavía no sabes cuál busca. Con la respuesta vuelves a buscar.`;
}

/**
 * Reemplaza a la vieja `SIN_STOCK_INSTRUCTION` ("alguno de estos repuestos
 * está en cero"), que solo avisaba sin obligar a escalar. Ahora, con AL
 * MENOS un resultado con existencia, se cotiza tal cual y se agrega el texto
 * fijo del requisito 3. Hotfix del 29/9/2026: llega UNA sola opción y siempre
 * con existencia (un agotado ya no viaja mezclado con las que tienen stock).
 */
const CONFIRMAR_INVENTARIO_INSTRUCTION =
  `Da nombre, precio y stock tal como llegan (es una sola opción: la mejor; no menciones otras ni ofrezcas más) y agrega textual: «${TEXTO_CONFIRMAR_INVENTARIO}». Luego llama a escalarAAsesor con motivo confirmar_inventario en este mismo turno.`;

/**
 * A2 T5 (30/9/2026, D1/D1b): la búsqueda decidió NO cotizar nada de este
 * pedido y escalar de todos modos: la moto del cliente no calza con ningún
 * producto y no hay universales con existencia (D1), o es un ítem genérico
 * dentro de una lista (D1b). El mensaje que sale lo arma el código
 * (`quote-message.ts`); a la herramienta solo le toca no elegir a ciegas.
 */
const ESCALAR_SIN_COTIZAR_INSTRUCTION =
  "Ninguno de los productos que calzan sirve con seguridad para este cliente (o hay varios y no se distingue cuál): NO cotices ni elijas ninguno de esos. Di que un asesor le confirma cuál le sirve y llama a escalarAAsesor con motivo confirmar_inventario en este mismo turno; en el resumen nombra cada producto pedido y qué pasó con él.";

/** Todos los resultados en cero (requisito 4): el texto fijo reemplaza cualquier oferta de "hay unidades". */
const SIN_STOCK_CASO_INSTRUCTION =
  `Di textual: «${TEXTO_SIN_STOCK}» y llama a escalarAAsesor con motivo sin_stock.`;

/**
 * Sin resultados, o sin términos de búsqueda reconocibles (requisito 2): el
 * catálogo no da para más, así que se pasa el caso de una vez sin inventar
 * alternativas.
 */
const NO_IDENTIFICADO_INSTRUCTION =
  `No encontraste nada, o no queda claro cuál es: di «${TEXTO_NO_IDENTIFICADO}» y llama a escalarAAsesor con motivo no_identificado. No inventes ni sugieras alternativas.`;

/**
 * T3b (28/9/2026): el cliente escribió una palabra que el catálogo no tiene y
 * el segundo intento buscó otra (`corregir_terminos`). El mensaje que sale
 * (`agent.ts`) ya lo dice por código; esta frase le evita al modelo presentar
 * el resultado como si fuera exactamente lo que el cliente pidió. El asesor
 * confirma que es lo que buscaba (por eso la instrucción sigue siendo la de
 * confirmar el inventario, aunque haya stock).
 */
function instruccionDeCorreccion(correcciones: readonly CorreccionTermino[]): string {
  return `Ojo: como el catálogo no tiene lo que el cliente escribió, ${describirCorreccion(correcciones)}. No lo presentes como si fuera exactamente lo que pidió: un asesor confirma que es lo que busca.`;
}

/**
 * A2 T5, D1 (30/9/2026): lo cotizado no nombra la moto del cliente pero sirve
 * (es universal o nombra solo la marca del cliente). El mensaje que sale ya lo
 * dice por código; esta frase evita que el modelo lo presente como si fuera
 * "para tu moto".
 */
const INSTRUCCION_UNIVERSALES =
  "Ojo: lo que llega NO nombra la moto del cliente; es universal o de su marca. Dile que no encontraste uno con el nombre de su moto y que este le puede servir; un asesor confirma.";

/**
 * A2 T5, D3 (30/9/2026): se buscó sin una palabra que el cliente escribió y
 * que no está en el nombre de ningún producto (o no junto al producto). Lo que
 * llega es lo más parecido, no exactamente lo pedido.
 */
function instruccionDeRelajo(terminos: readonly string[]): string {
  return `Ojo: no encontré ${terminos.map((t) => `"${t}"`).join(", ")} en el nombre de ningún producto; lo que llega es lo más parecido. No lo presentes como si fuera exactamente lo que pidió: un asesor confirma que es lo que busca.`;
}

/**
 * K2 (20/9/2026): corrige un efecto colateral de K (commit 3d96863, "Seba
 * consulta el inventario antes de hablar de existencias"). Caso a mano del
 * mismo día, conversación local del +584140000012: el cliente reabrió un
 * chat con "hola, otra consulta"; el clasificador lo marcó
 * `consulta_disponibilidad` (la confusión `consulta_disponibilidad`↔`otro`
 * es el desacuerdo dominante del clasificador, ver CLAUDE.md, trampa "El
 * comparador de clasificación"); `tool-choice.ts` obligó al paso 0 a llamar
 * a `buscarRepuesto` SIN que el cliente hubiera nombrado ningún repuesto; la
 * herramienta devolvió sin resultados (`catalogOutcome.sinResultados =
 * true`) y la red de seguridad de `agent.ts` escaló con `no_identificado`
 * ("El cliente desea realizar otra consulta, pero no especificó qué
 * repuesto…"), quemando un asesor por cada mensaje vago — antes de K, Seba
 * habría preguntado qué necesita.
 *
 * `clienteNoNombroRepuesto` le da al modelo una salida sin tocar la base:
 * reutiliza la MISMA bandera `generico` que el requisito 5 de "Seba atiende
 * el mostrador" («la única pregunta») ya usa para bloquear la red de
 * seguridad del catálogo, así que no hace falta tocar `agent.ts`.
 *
 * K2b (20/9/2026): la primera versión de esta corrección hacía que la
 * bandera SOLO ganara cuando `searchTerms(query)` no encontraba ningún
 * término real, para no dejar de buscar un "casco LS2" nombrado de verdad.
 * Medido contra el modelo real (gemini-3.1-flash-lite, conversación local
 * del +584140000032, "buenas, tienen disponible?"): `query` es un string
 * OBLIGATORIO del esquema, así que el modelo INVENTA un texto para llenarlo
 * aunque marque la bandera — el log temporal capturó el argumento exacto
 * `{"query":"repuesto genérico","clienteNoNombroRepuesto":true}`. Ese texto
 * inventado trae palabras de sobra (≥3 letras) para calzar productos reales
 * del catálogo, así que la precedencia vieja NUNCA protegía nada en la
 * práctica: Seba cotizó carburador/filtros/pastillas al azar y escaló con
 * `confirmar_inventario` sobre un cliente que solo había preguntado si
 * había algo disponible.
 *
 * Ahora la bandera gana SIEMPRE, sin mirar `terms`, sin tocar la base (ni
 * `products` ni `ai_lessons`). Riesgo residual aceptado: si el modelo la
 * marca por error CON un producto de verdad en el `query` (el caso del
 * casco LS2 que motivó la precedencia vieja), Seba pregunta "¿qué buscas?"
 * en vez de buscar — molesto (el cliente tiene que repetirlo) pero
 * inofensivo, frente a cotizar al azar y quemar un asesor de verdad.
 */
export const PREGUNTA_QUE_BUSCA_INSTRUCTION =
  "El cliente todavía no dijo qué repuesto o producto busca: haz UNA sola pregunta para saber qué necesita y NO escales ni prometas un asesor en este turno. Con la respuesta vuelves a buscar.";

interface ToolDeps {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  contactId: string;
  /**
   * Horario de la tienda (Frente B4, "El reloj dice la verdad", 5/9/2026):
   * solo lo usa `buildEscalateTool` para saber cuándo prometer que un asesor
   * escribe. Opcional porque el resto de las herramientas no lo necesitan y
   * `escalateConversation` ya tiene su propio default si llega `undefined`.
   */
  businessHours?: BusinessHours;
  /** Inyectable en tests; en producción usa el reloj real. */
  now?: Date;
  /**
   * Las líneas del cliente que este turno tiene por atender (la ráfaga, la más
   * vieja primero — `pendingCustomerLines` en `agent.ts`). T3a (28/9/2026): la
   * herramienta del catálogo la lee para saber si el cliente pidió ver todo
   * ("no sé", "los que tengas") y no volver a preguntarle (`pideVerTodo`).
   */
  rafagaCliente?: string[];
}

/** Se llena cuando el turno escala, para que el orquestador sepa qué pasó sin volver a tocar la base de datos. */
export interface EscalationOutcome {
  escalated: boolean;
  motivo?: EscalationMotivo;
  assignedAgentName?: string;
  reason?: string;
  /**
   * La escalación quedó sin ningún asesor disponible (anexo A1, 5/9/2026).
   * Hasta el 14/9/2026 el orquestador la usaba para decidir si el mensaje
   * final es una despedida sin nadie detrás —`isAutoReply: true` en
   * `sendAgentText`—; desde la Tarea 5 ("La voz cercana y la espera
   * visible") la promesa de un asesor TAMPOCO es una respuesta real (170
   * promesas ≥ 30 min sin cumplir, 23 de ellas nunca atendidas, medidas en
   * la auditoría de esa tarea), así que `isAutoReply` pasó a depender solo
   * de `escalated` — este campo se sigue usando para elegir QUÉ despedida
   * fija mandar (`DESPEDIDA_SIN_ASESOR` vs. `despedidaConAsesor`, agent.ts).
   */
  unassigned?: boolean;
  /**
   * El horario de la tienda en el momento de escalar (Tarea 5, 14/9/2026):
   * `escalateConversation` lo calcula siempre (ver escalate.ts) y viaja acá
   * para que la despedida fija CON asesor (`despedidaConAsesor`, agent.ts) y
   * la instrucción que lee el modelo (`escalationInstruction`, este
   * archivo) usen el MISMO reloj — nunca uno recalculado después, que podría
   * cruzar el borde de la hora de cierre entre el escalamiento y el envío.
   */
  businessStatus?: BusinessStatus;
}

/**
 * T3, "Seba atiende el mostrador" (18/9/2026): lo que pasó en las llamadas al
 * catálogo durante EL MISMO turno, para que la red de seguridad de
 * `agent.ts` sepa si tiene que escalar en código cuando el modelo se quedó
 * sin pasos sin haberlo hecho (requisitos 2/3/4 del cliente: repuesto
 * encontrado, agotado o no identificado SIEMPRE terminan con un asesor).
 * Mismo patrón que `EscalationOutcome`: un objeto mutable que
 * `buildCatalogTool` va llenando, pasado por el orquestador.
 *
 * Se ACUMULA entre llamadas del mismo turno y nunca se resetea: una consulta
 * con existencia y otra sin resultados dejan `conExistencia = true` Y
 * `sinResultados = true` a la vez. La precedencia de qué motivo escala (si
 * hace falta) la decide `agent.ts`, no este tipo — acá solo se deja
 * constancia de lo que pasó.
 */
export interface CatalogOutcome {
  /** El tool se invocó al menos una vez en este turno. */
  ran: boolean;
  /** Alguna llamada devolvió al menos un repuesto con stock > 0. */
  conExistencia: boolean;
  /** Alguna llamada devolvió repuestos, pero todos en cero. */
  agotados: boolean;
  /** Alguna llamada no encontró nada (o sin términos de búsqueda reconocibles, o falló la consulta a la base). */
  sinResultados: boolean;
  /** Alguna llamada fue una consulta genérica: se le pidió UNA pregunta de filtro, sin escalar. */
  generico: boolean;
  /**
   * T3a (28/9/2026): lo que se le va a cotizar al cliente, acumulado entre
   * llamadas del turno y sin repetir productos: el nombre EXACTO, el precio
   * ya calculado (`usdFromBs`) y el stock. `agent.ts` (T3b) arma con esto el
   * bloque de cotización por código, para que el modelo no pueda cambiar un
   * nombre ni un precio. Un genérico no aporta líneas (no se cotiza).
   */
  cotizacion: LineaCotizada[];
  /**
   * T3a (28/9/2026): cuál pregunta de filtro corresponde ("moto" →
   * `PREGUNTA_FILTRO`, "producto" → `PREGUNTA_FILTRO_PRODUCTO`), o `null` si
   * ninguna llamada del turno terminó en pregunta. La última gana.
   */
  preguntaFiltro: "moto" | "producto" | null;
  /**
   * T3a (28/9/2026): una entrada por cada búsqueda a `buscar_productos` del
   * turno (cada producto de una lista cuenta aparte), para el registro que
   * T6 escribe en `agent_turns`.
   */
  consultas: ConsultaCatalogo[];
  /**
   * A2 T5 (30/9/2026): los avisos de la búsqueda que SE LE DICEN al cliente
   * (D1 universales / moto sin calce, D1b varias opciones, D2 variante agotada,
   * D3 relajo): `quote-message.ts` los pinta con los textos literales de
   * `seba.ts`. Acumulado entre llamadas del turno. Un aviso de una consulta que
   * terminó en pregunta de filtro NO entra acá (el cliente ve la pregunta, no
   * el aviso); ese vive solo en `ConsultaCatalogo.avisos`.
   */
  avisos: AvisoCatalogo[];
  /**
   * A2 T5 (30/9/2026): un motivo de escalada que la red de seguridad de
   * `agent.ts` debe usar aunque NO haya quedado nada cotizado con existencia:
   * la búsqueda decidió no cotizar (moto sin calce, ítem genérico en una lista)
   * o cotizó una alternativa (D2) y el caso tiene que pasar a un asesor de todos
   * modos. `null` = la red decide por los indicadores de siempre. Por ahora
   * solo `confirmar_inventario`.
   */
  motivoForzado: EscalationMotivo | null;
}

/**
 * A2 T5 (30/9/2026): lo que la búsqueda le avisa al cliente sobre UN pedido
 * (`productoPedido`: el de la lista, o `null` en una consulta simple). Cada
 * tipo sale de una decisión del plan (sección 2): D1 (`universales`,
 * `moto_sin_calce`), D1b (`varias_opciones`), D2 (`variante_agotada`), D3
 * (`relajado`, `relajado_agotado`). Es JSON puro: se guarda tal cual en
 * `agent_turns.catalog_queries` (v2) y lo lee el panel de Búsquedas.
 */
export type AvisoCatalogo =
  /** Lo cotizado no nombra la moto del cliente pero sirve: `marca` si es de su marca, `null` si solo universal. */
  | { tipo: "universales"; productoPedido: string | null; marca: string | null }
  /** Nada nombra la moto del cliente y no hay universales con existencia: se escala sin cotizar. */
  | { tipo: "moto_sin_calce"; productoPedido: string | null; moto: string }
  /** Se buscó sin `terminos` (no estaban en el nombre); lo cotizado es lo más parecido. */
  | { tipo: "relajado"; productoPedido: string | null; terminos: string[] }
  /** Igual, pero lo más parecido está agotado. */
  | { tipo: "relajado_agotado"; productoPedido: string | null; terminos: string[] }
  /** La variante pedida existe y está en cero; `conAlternativa` si se ofrece UNA otra con existencia. */
  | { tipo: "variante_agotada"; productoPedido: string | null; variante: string; conAlternativa: boolean }
  /** Ítem genérico dentro de una lista: no se cotiza, el asesor ayuda a elegir. */
  | { tipo: "varias_opciones"; productoPedido: string };

/** Un producto que se le cotiza al cliente. Ver `CatalogOutcome.cotizacion`. */
export interface LineaCotizada {
  productId: string;
  /** El nombre exacto del catálogo, sin reescribir. */
  nombre: string;
  precioUsd: number;
  precioBs: number;
  stock: number;
  /** El producto que el cliente pidió cuando la consulta fue una lista (`productos`); `null` en una búsqueda simple. */
  productoPedido: string | null;
  /**
   * A2 T5 (D2): es la UNA alternativa con existencia que se ofrece porque la
   * variante pedida está agotada. La clave solo existe cuando es `true`.
   */
  esAlternativa?: boolean;
}

/** Cómo terminó una búsqueda. */
export type ResultadoConsulta =
  | "con_existencia"
  | "agotados"
  | "generico"
  | "sin_resultados"
  | "sin_terminos"
  | "error";

/**
 * El rastro de UNA búsqueda a `buscar_productos`. Ver `CatalogOutcome.consultas`.
 *
 * A2 T5 (30/9/2026): pasa a la versión 2 (`v: 2`). ES UN CONTRATO CON EL PANEL
 * DE BÚSQUEDAS (Control IA, T9): se guarda tal cual en
 * `agent_turns.catalog_queries`, y las filas anteriores a A2 (v1, sin `v` y sin
 * los campos nuevos) siguen leyéndose — el panel pinta "—" donde falta algo.
 * Cambiarle la forma exige subir `v` y que el panel siga leyendo las
 * versiones anteriores.
 */
export interface ConsultaCatalogo {
  /** Versión del registro: 2 desde A2. Las filas v1 no traen la clave. */
  v: 2;
  /** El texto que de verdad se buscó (ya combinado con el pedido anterior si era una respuesta suelta). */
  query: string;
  /** La lista completa que mandó el modelo, o `null` si fue una consulta simple. */
  productos: string[] | null;
  /** Los conjuntos que viajaron a SQL. */
  moto: string[][];
  cilindrada: string[][];
  grupos: string[][];
  opcionales: string[][];
  /** Color, acabado, "edge"/"paleta"/"rayo" y talla: estrictas y preferentes (`catalogQuery`). */
  variantes: string[][];
  /** Año de la moto (solo ordena). */
  anio: string[][];
  /** La marca de la moto cuando el cliente dio también el modelo (solo ordena). */
  motoMarca: string[][];
  /** El cliente dio una moto y ningún producto del máximo la nombra: se ignoró para filtrar. */
  motoIgnorada: boolean;
  /** Alguna fila trae TODAS las variantes pedidas (`filas_con_variante > 0`). `false` sin variantes. */
  calzaEntero: boolean;
  /** Los términos que D3 relajó (normalizados), en el orden en que venían. Vacío si no se relajó nada. */
  relajados: string[];
  /** Todos los avisos de esta búsqueda, se hayan mostrado o no (una pregunta de filtro no los muestra). */
  avisos: AvisoCatalogo[];
  /**
   * T3b (28/9/2026): las palabras que se cambiaron para el SEGUNDO intento (el
   * corrector de tipeos T2, y desde A2 también la moto corregida por alias o
   * distancia 1: horsen→horse), o `null` si no hubo corrección. `grupos` ya
   * trae lo corregido (lo que de verdad se buscó); `query` conserva lo que
   * escribió el cliente. Se anota también cuando el reintento no encontró nada.
   */
  corregido: CorreccionTermino[] | null;
  /** Correcciones que el corrector propuso y la guarda de producto descartó (vicera→visera), o `null`. */
  correccionDescartada: CorreccionTermino[] | null;
  /** Un texto corto y fijo, armado por el código, con lo que decidió la búsqueda ("moto SBR calza: cotizó 1 de 5 con existencia"). */
  decision: string;
  /** Lo que se le cotizó al cliente (renglones normales y la alternativa de D2). */
  cotizados: { productId: string; nombre: string; stock: number; precioUsd: number }[];
  /** Las ventanas de la base sobre el conjunto que decidió; `null` si no hubo filas. */
  conteos: { calzan: number; conStock: number; nombranMoto: number; universales: number } | null;
  resultado: ResultadoConsulta;
}

/** Cómo se le cuenta al modelo el estado de cada producto de una lista. */
const DESCRIPCION_DE_ESTADO: Record<ResultadoConsulta, string> = {
  con_existencia: "con existencia",
  agotados: "agotado",
  generico: "hay varios y no se distingue cuál",
  sin_resultados: "no lo encontraste",
  sin_terminos: "no lo encontraste",
  error: "no se pudo consultar",
};

// ---------------------------------------------------------------------------
// Buscar repuesto — consulta_disponibilidad / otro. Solo lectura.
//
// T3a, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026). El estudio del VPS (1.027 turnos, 25-28/9) dio 457
// turnos fallidos; la herramienta del catálogo era responsable de tres de las
// cuatro causas, y esta tarea las cierra aquí:
//
//   1. La tolerancia N-1 (`requerido = grupos - 1` con 4 o más grupos) tiraba
//      la MARCA: "defensa gxs 250" cotizaba una DEFENSA BRZ 250 porque
//      calzaba "defensa" y "250". Ahora `requerido = grupos.length`, siempre:
//      lo que sí puede faltar en el nombre (colores, "semi", "delantero"…) ya
//      no es obligatorio — lo decide `catalogQuery` (T1) — y la moto viaja
//      aparte, con nombre (`p_moto`) y cilindrada (`p_cilindrada`).
//   2. "Genérico" no miraba el stock: siete botas sin una sola unidad se
//      preguntaban como si hubiera de dónde elegir. Ahora se decide con
//      `filas_con_maximo_y_stock`.
//   3. La pregunta de filtro se repetía y nadie recordaba el pedido: la
//      memoria de `catalog-memory.ts` (Redis, 6 h) guarda el último pedido, la
//      moto y por qué producto ya se preguntó.
//
// Sin Redis (o con Redis caído) la memoria es un no-op: la herramienta se
// comporta como antes de esta tarea, sin respuestas sueltas combinadas ni
// "una sola pregunta". Ver CLAUDE.md, trampa "La memoria del pedido".
// ---------------------------------------------------------------------------

/**
 * HOTFIX DE PRODUCCIÓN, 29/9/2026 (decisión del operador): por cada producto
 * que pide el cliente se cotiza UNA sola opción. Hasta esa mañana se
 * cotizaban hasta tres (`MAX_OPCIONES_SIN_PREGUNTA` = 3, más la línea «Hay N
 * opciones más…» y el aviso de recorte) y, cuando lo que calzaba eran tres
 * filas o menos, se mezclaban productos con stock 0 con los que tenían
 * existencia. El cliente amenazó con cancelar el contrato por ese ruido.
 * Con existencia se cotiza la mejor (relevancia de SQL y, a igual relevancia,
 * la de MAYOR `stock_quantity`, `ordenarPorExistencia`); nunca un agotado si
 * hay alguna con stock. Si todo está agotado, se nombra SOLO el producto
 * pedido (la mejor fila). La pregunta de filtro no cambia.
 *
 * A2 T5, D6 (29/9/2026, noche): esa regla vale en TODOS los casos —moto que
 * calza, universales de D1, alternativa de D2— y ya no existe «Hay N más».
 */
const MAX_OPCIONES_COTIZADAS = 1;

/**
 * A2 T5, D6: la ÚNICA excepción. Si el cliente pide de forma EXPLÍCITA ver
 * opciones (`pideVerOpciones`: «muéstrame todas», «qué opciones hay», «cuáles
 * tienes», «qué tienes»), salen hasta tres con existencia, por relevancia y
 * existencia, sin «Hay N más». «No sé», «ni idea», «la que sea» NO la abren.
 */
const MAX_OPCIONES_EXPLICITAS = 3;

/** Hasta este número de filas con existencia no hay nada que preguntar; con más y sin moto que calce, se pregunta (una vez). */
const MAX_SIN_PREGUNTA = 3;

/** Tope de filas al reintentar cuando las que hacen falta quedaron más allá de `MAX_CATALOG_RESULTS` (el máximo que admite la función SQL). */
const LIMITE_REINTENTO = 50;

/** Un grupo es "de producto" si es una palabra (no un número, una medida, una viscosidad ni un modelo con dígitos). */
function esGrupoDeProducto(grupo: string[]): boolean {
  return /^[a-z]+$/.test(grupo[0] ?? "");
}

/**
 * Un número SUELTO ("18", "130", "11.7"): todas sus alternativas son solo
 * dígitos. Un grupo como "30 litros" (`[30lts, "30 lts", …]`) NO lo es: puede
 * ser la cabeza de la búsqueda (resolución 4 del orquestador sobre D3).
 */
function esNumeroSuelto(grupo: string[]): boolean {
  return grupo.length > 0 && grupo.every((alt) => /^[0-9]+(?:\.[0-9]+)?$/.test(alt));
}

/**
 * Prefijos de modelo (dt, cg, gn): NO están en `MOTOS_CONOCIDAS` porque en una
 * consulta casi siempre viajan pegados a su número y solos no son nada, pero un
 * NOMBRE de producto que los trae SÍ nombra una moto. Sin ellos la "DEFENSA
 * DELANTERA SUPER DT LEFOR" pasaba por UNIVERSAL (`nombra_moto` falso) y se le
 * ofrecía a un cliente de Tigrito como "universal" (A2 T5, hallado al correr
 * los casos 2.1). "en" no entra: es una palabra común de los nombres.
 */
const PREFIJOS_DE_MODELO = ["dt", "cg", "gn"];

/** Las palabras con las que la base decide si un NOMBRE de producto nombra una moto (`p_motos_conocidas`). */
export const MOTOS_EN_NOMBRES: readonly string[] = [...MOTOS_CONOCIDAS, ...PREFIJOS_DE_MODELO];

/** El grupo trae alguna marca (comercial o de moto) de la lista cerrada `MARCAS_CONOCIDAS`. */
function esGrupoDeMarca(grupo: string[]): boolean {
  return grupo.some((alt) => MARCAS_CONOCIDAS.has(alt));
}

/** Une dos listas de grupos sin repetir (por el contenido del grupo), conservando el orden de aparición. */
function unirGrupos(a: string[][], b: string[][]): string[][] {
  const vistos = new Set<string>();
  const unidos: string[][] = [];
  for (const grupo of [...a, ...b]) {
    const clave = grupo.join("\u0000");
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    unidos.push(grupo);
  }
  return unidos;
}

/** Lo que se sabe de la moto por el texto que el MODELO escribió en `motoBrand`/`motoModel` (`motoDesdeTexto`). */
type MotoEntrada = Pick<MotoDesdeTexto, "moto" | "motoMarca" | "cilindrada" | "anio" | "motoCorregida">;

/**
 * Con un modelo entre las motos, las marcas pasan a `motoMarca` (solo
 * ordenan): "Bera Milan" no calza las tapas de la Bera SBR por decir "bera".
 * Es lo mismo que `catalogQuery`/`motoDesdeTexto` hacen con SU texto; acá se
 * repite porque la moto puede venir de dos textos (la consulta y el modelo).
 */
function repartirMotoYMarca(moto: string[][], motoMarca: string[][]): { moto: string[][]; motoMarca: string[][] } {
  const esMarca = (g: string[]) => g.length > 0 && MARCAS_DE_MOTO.has(g[0]);
  if (!moto.some((g) => !esMarca(g))) return { moto, motoMarca };
  return { moto: moto.filter((g) => !esMarca(g)), motoMarca: unirGrupos(motoMarca, moto.filter(esMarca)) };
}

/** La moto que dijeron dos textos distintos (el `motoBrand`/`motoModel` del modelo y la respuesta del cliente), unida y con la marca aparte si hay modelo. */
function unirMotoEntrada(a: MotoEntrada, b: MotoEntrada): MotoEntrada {
  const repartida = repartirMotoYMarca(unirGrupos(a.moto, b.moto), unirGrupos(a.motoMarca, b.motoMarca));
  return {
    moto: repartida.moto,
    motoMarca: repartida.motoMarca,
    cilindrada: unirGrupos(a.cilindrada, b.cilindrada),
    anio: unirGrupos(a.anio, b.anio),
    motoCorregida: [...a.motoCorregida, ...b.motoCorregida],
  };
}

/** Las palabras de moto corregidas por alias o distancia 1 (horsen→horse) de las dos fuentes, sin repetir. */
function unirCorregidas(a: readonly MotoCorregida[], b: readonly MotoCorregida[]): CorreccionTermino[] {
  const vistas = new Set<string>();
  const unidas: CorreccionTermino[] = [];
  for (const c of [...a, ...b]) {
    if (vistas.has(c.original)) continue;
    vistas.add(c.original);
    unidas.push({ original: c.original, corregido: c.corregido });
  }
  return unidas;
}

/**
 * La clave del producto que se pidió: los términos obligatorios, ordenados y
 * unidos con "+". Es lo que `preguntaHechaPara` guarda en la memoria.
 */
function claveDelProducto(grupos: string[][]): string {
  return grupos
    .map((g) => g[0])
    .filter((t): t is string => Boolean(t))
    .sort()
    .join("+");
}

/**
 * ¿Ya se preguntó por este producto? Sí si TODOS los términos de la clave
 * preguntada siguen en el pedido de ahora: un pedido que REFINA al
 * preguntado ("aceite" → "aceite 20w50") es el mismo pedido — una sola
 * pregunta por pedido. Un pedido más ancho o distinto ("guante" tras
 * "casco") es otro y vuelve a preguntar.
 */
function yaSePregunto(clave: string, preguntaHechaPara: string | null): boolean {
  if (!preguntaHechaPara) return false;
  const actuales = new Set(clave.split("+"));
  return preguntaHechaPara.split("+").every((t) => actuales.has(t));
}

/** El `updated_at` más viejo de una lista de fechas, o null si ninguna trae fecha. */
function masViejo(fechas: (string | null)[]): string | null {
  const validas = fechas.filter((f): f is string => Boolean(f));
  return validas.length === 0 ? null : validas.reduce((viejo, f) => (f < viejo ? f : viejo));
}

/**
 * Tras preguntar POR LA MOTO ("¿para qué modelo y año?"), un número suelto de
 * dos dígitos ("sbr 24") es el AÑO de la moto y no una medida: se reescribe
 * como año de cuatro cifras para que `catalogQuery` lo mande a `anio` (que solo
 * ordena) en vez de exigirlo como término del producto (A2 T5, plan 2.3: antes
 * exigía "24" y no encontraba nada). Solo 00-35 y 80-99; un número pegado a
 * otro signo ("20/50", "6301-2") no se toca.
 */
function dosDigitosComoAnio(texto: string): string {
  return texto.replace(/(?<![\w/:.-])([0-9]{2})(?![\w/:.-])/g, (entero, dos: string) => {
    const n = Number(dos);
    if (n <= 35) return `20${dos}`;
    if (n >= 80) return `19${dos}`;
    return entero;
  });
}

/** El nombre de la moto como se le dice al cliente: "DT 250", "BERA MILAN". */
function nombreDeMoto(moto: string[][], motoMarca: string[][], cilindrada: string[][]): string {
  return [...motoMarca, ...moto, ...cilindrada]
    .map((g) => g[0])
    .filter((t): t is string => Boolean(t))
    .join(" ")
    .toUpperCase();
}

/**
 * Las filas ordenadas para elegir LA que se cotiza (hotfix del 29/9/2026; con
 * D6 sigue siendo una, salvo el pedido explícito de ver opciones). Se conservan
 * TODAS las llaves de relevancia que trae `buscar_productos`, en su mismo orden
 * (puntaje, moto con nombre, variante, empieza con el producto, marca de moto,
 * cilindrada/año, opcionales): es relevancia. El desempate final es la
 * EXISTENCIA (`stock_quantity` desc) y nunca el nombre: nadie elige por orden
 * alfabético antes que por existencia (decisión del operador). SQL ya desempata
 * así desde M1; acá se repite porque solo se ven las filas que llegaron.
 * `ignorarOpcional` (cauchos y tripas): "trasero"/"delantero" en un caucho es
 * el de la scooter de rin 10, no el de la moto del cliente; ahí el opcional no
 * decide. `Array.sort` es estable: a igualdad total queda el orden de la base.
 */
function ordenarPorExistencia(
  filas: FilaBusqueda[],
  { ignorarOpcional, motoCalza }: { ignorarOpcional: boolean; motoCalza: boolean }
): FilaBusqueda[] {
  return [...filas].sort(
    (a, b) =>
      b.puntaje - a.puntaje ||
      // Solo si la moto calza (T5b): con moto que no calza, una fila de otro producto que la
      // nombra no sube por nombrarla (mismo criterio que el `order by` de SQL).
      (motoCalza ? b.puntaje_moto_nombre - a.puntaje_moto_nombre : 0) ||
      b.puntaje_variante - a.puntaje_variante ||
      Number(b.empieza_con_producto) - Number(a.empieza_con_producto) ||
      b.puntaje_moto_marca - a.puntaje_moto_marca ||
      b.puntaje_moto_cilindrada - a.puntaje_moto_cilindrada ||
      (ignorarOpcional ? 0 : b.puntaje_opcional - a.puntaje_opcional) ||
      b.stock_quantity - a.stock_quantity
  );
}

type FilaBusqueda = Database["public"]["Functions"]["buscar_productos"]["Returns"][number];

/** Un repuesto ya con el precio calculado, listo para mostrarle al modelo y para `cotizacion`. */
interface Cotizado {
  id: string;
  nombre: string;
  marca: string | null;
  precioUsd: number;
  precioBs: number;
  stock: number;
  compatibleCon: string[];
  /** D2: es la UNA alternativa con existencia que se ofrece porque la variante pedida está agotada. */
  esAlternativa?: boolean;
}

/** Lo que decidió UNA búsqueda (un producto de una lista, o la consulta simple). */
interface ResultadoUno {
  estado: ResultadoConsulta;
  /** Lo que se le muestra al modelo y se cotiza: vacío salvo con_existencia/agotados (y la alternativa de D2). */
  quoted: Cotizado[];
  /** Hay más filas del máximo que las que caben. */
  hayMas: boolean;
  /** Caso + (recorte) — la antigüedad del inventario la agrega quien arma la respuesta. */
  instrucciones: string[];
  /** Solo con `estado = "generico"` que ES una pregunta. `null` = no se pregunta (moto sin calce, varias opciones). */
  preguntaFiltro: "moto" | "producto" | null;
  clave: string;
  /** La moto, la cilindrada y el año con los que de verdad se buscó (entrada + memoria). */
  moto: string[][];
  cilindrada: string[][];
  anio: string[][];
  /** El `updated_at` más viejo de lo que se muestra, para el aviso de antigüedad. */
  masViejo: string | null;
  /** Los avisos de esta búsqueda (`AvisoCatalogo`); a la consulta van todos, al `CatalogOutcome` solo si no terminó en pregunta. */
  avisos: AvisoCatalogo[];
  /** El motivo de escalada que hay que usar aunque no haya nada cotizado con existencia (ver `CatalogOutcome.motivoForzado`). */
  motivoForzado: EscalationMotivo | null;
  consulta: ConsultaCatalogo;
  /** Detalle del error de la base, si `estado = "error"`. */
  errorDetail?: string;
}

export function buildCatalogTool(
  { supabase, conversationId, rafagaCliente }: ToolDeps,
  catalogOutcome: CatalogOutcome
) {
  /**
   * Claves por las que YA se preguntó en ESTE turno: una segunda llamada
   * idéntica del modelo en el mismo turno sigue siendo la pregunta — no debe
   * leer la memoria que la primera acaba de escribir como si fuera de un
   * turno anterior.
   */
  const preguntadosEnEsteTurno = new Set<string>();
  let sinonimosMemo: Promise<SearchSynonym[]> | null = null;
  let noCorregirMemo: Promise<string[]> | null = null;
  let tasaMemo: ReturnType<typeof getBcvRate> | null = null;

  const leerSinonimos = (): Promise<SearchSynonym[]> => {
    sinonimosMemo ??= (async () => {
      // Sinónimos de búsqueda (T5c, "Seba atiende el mostrador", 18/9/2026):
      // lo que un asesor le enseñó a Seba desde "Lecciones de Seba" —jerga
      // local que no calza con el nombre real del catálogo. Se leen ANTES de
      // armar los grupos porque el sinónimo tiene que entrar como una
      // alternativa MÁS del mismo grupo, no en una segunda consulta. Un error
      // acá no frena la búsqueda: se sigue con los términos tal cual llegaron.
      //
      // F (20/9/2026, "El resguardo antes del push", C3): se filtra por
      // ALCANCE — `teach-seba-modal.tsx` permite guardar un sinónimo como
      // "Solo este chat" (`scope = 'conversacion'`); sin este `.or()` se
      // aplicaba a cualquier chat. Solo entran los `scope = 'global'` o los
      // que nacieron en ESTA conversación.
      const { data: synonymRows } = await supabase
        .from("ai_lessons")
        .select("synonym_from, synonym_to")
        .eq("kind", "sinonimo")
        .eq("is_active", true)
        .or(`scope.eq.global,conversation_id.eq.${pgrstLiteral(conversationId)}`)
        .limit(MAX_SYNONYM_LESSONS);

      return (synonymRows ?? [])
        .filter(
          (row): row is { synonym_from: string; synonym_to: string } =>
            typeof row.synonym_from === "string" && typeof row.synonym_to === "string"
        )
        .map((row) => ({ from: row.synonym_from, to: row.synonym_to }));
    })();
    return sinonimosMemo;
  };

  /**
   * A2 T5 (D5): las palabras que un asesor marcó «No corregir esta palabra»
   * (`ai_lessons.kind = 'no_corregir'`, migración 20260930050000; la palabra va
   * en `synonym_from`). Se suman a `p_protegidos` del corrector, MISMO alcance
   * que los sinónimos (global o de esta conversación). Solo se lee cuando el
   * corrector va a correr; un error deja `[]` y un `log.warn`: nunca frena la
   * búsqueda.
   */
  const leerNoCorregir = (): Promise<string[]> => {
    noCorregirMemo ??= (async () => {
      try {
        const { data, error } = await supabase
          .from("ai_lessons")
          .select("synonym_from")
          .eq("kind", "no_corregir")
          .eq("is_active", true)
          .or(`scope.eq.global,conversation_id.eq.${pgrstLiteral(conversationId)}`)
          .limit(MAX_SYNONYM_LESSONS);
        if (error) {
          log.warn("lecciones_no_corregir_no_legibles", { conversationId, detail: errorText(error) });
          return [];
        }
        return (data ?? [])
          .map((row) => row.synonym_from)
          .filter((palabra): palabra is string => typeof palabra === "string" && palabra.trim() !== "");
      } catch (err) {
        log.warn("lecciones_no_corregir_no_legibles", { conversationId, detail: errorText(err) });
        return [];
      }
    })();
    return noCorregirMemo;
  };

  const leerTasa = () => {
    tasaMemo ??= getBcvRate(supabase);
    return tasaMemo;
  };

  /**
   * UNA búsqueda contra `buscar_productos` y la decisión completa sobre lo
   * que trajo. Nunca toca `catalogOutcome` ni Redis: solo decide (`registrar`
   * y el orquestador de abajo dejan el rastro).
   *
   * A2 T5 (30/9/2026, plan "Seba no cotiza lo que no es" con D6). El orden:
   *   1. Primer intento con lo que escribió el cliente.
   *   2. Si no calza todos los términos obligatorios: el corrector de tipeos,
   *      con su guarda de producto (el reintento no puede cambiar el producto
   *      pedido: vicera→visera cotizaba una VISERA en vez del CASCO).
   *   3. Si todavía no calza: D3, relajar la palabra que no está en el nombre
   *      (`diagnosticarTerminos`; sin diagnóstico no se relaja nada).
   *   4. La decisión, con esta precedencia (cada paso cotiza UNA opción, D6):
   *        variantes estrictas (D2) → moto que calza → moto que NO calza y
   *        la familia depende de ella (D1: universales / de la marca / se
   *        escala sin cotizar) → ítem genérico (pregunta, o «varias
   *        opciones» dentro de una lista, D1b) → la mejor con existencia.
   */
  async function buscarUno(p: {
    texto: string;
    /** El producto de la lista que se está buscando, o null si es una consulta simple. */
    productoPedido: string | null;
    /** La lista completa que mandó el modelo, o null. */
    productos: string[] | null;
    /** La moto que el modelo escribió en `motoBrand`/`motoModel`. */
    motoEntrada: MotoEntrada;
    /** Solo se usan si ni la consulta ni el modelo dieron moto (respuesta suelta). */
    motoMemoria: string[][];
    cilindradaMemoria: string[][];
    anioMemoria: string[][];
    dependeDeLaMoto: boolean;
    /** Falso en una lista: ahí nunca se pregunta; un ítem genérico queda como «varias opciones» (D1b). */
    permitirPregunta: boolean;
    preguntaHechaPara: string | null;
    /** El cliente dijo que no sabe precisar o que le muestren todo: no se le vuelve a preguntar. */
    verTodo: boolean;
    /** D6: el cliente pidió de forma EXPLÍCITA ver opciones: hasta tres con existencia. */
    verOpciones: boolean;
  }): Promise<ResultadoUno> {
    const consultaMinima = (estado: ResultadoConsulta): ConsultaCatalogo => ({
      v: 2,
      query: p.texto,
      productos: p.productos,
      moto: [],
      cilindrada: [],
      grupos: [],
      opcionales: [],
      variantes: [],
      anio: [],
      motoMarca: [],
      motoIgnorada: false,
      calzaEntero: false,
      relajados: [],
      avisos: [],
      corregido: null,
      correccionDescartada: null,
      decision: "",
      cotizados: [],
      conteos: null,
      resultado: estado,
    });

    const vacio = (estado: ResultadoConsulta, extra: Partial<ResultadoUno> = {}): ResultadoUno => ({
      estado,
      quoted: [],
      hayMas: false,
      instrucciones: [],
      preguntaFiltro: null,
      clave: "",
      moto: [],
      cilindrada: [],
      anio: [],
      masViejo: null,
      avisos: [],
      motivoForzado: null,
      consulta: consultaMinima(estado),
      ...extra,
    });

    // Antes de tocar la base (ni siquiera los sinónimos) se comprueba si el
    // texto deja algún término reconocible. Un sinónimo nunca CREA un grupo
    // de la nada — solo suma una alternativa a uno que ya existe — así que
    // esta comprobación sin sinónimos ya alcanza.
    if (catalogQuery(p.texto).grupos.length === 0) {
      return vacio("sin_terminos", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION] });
    }

    const cq = catalogQuery(p.texto, await leerSinonimos());

    // La moto: la de la consulta y la que escribió el modelo, con la marca
    // aparte cuando también hay un modelo; y, si no hay ninguna, la de la
    // memoria (respuesta suelta). La cilindrada y el año solo ORDENAN.
    const repartida = repartirMotoYMarca(
      unirGrupos(cq.moto, p.motoEntrada.moto),
      unirGrupos(cq.motoMarca, p.motoEntrada.motoMarca)
    );
    const motoNombre = repartida.moto.length === 0 && repartida.motoMarca.length === 0 ? p.motoMemoria : repartida.moto;
    const motoMarca = repartida.motoMarca;
    const cilindradaDicha = unirGrupos(cq.cilindrada, p.motoEntrada.cilindrada);
    const cilindrada = cilindradaDicha.length === 0 ? p.cilindradaMemoria : cilindradaDicha;
    const anioDicho = unirGrupos(cq.anio, p.motoEntrada.anio);
    const anio = anioDicho.length === 0 ? p.anioMemoria : anioDicho;

    // T3b (28/9/2026): `grupos`/`clave`/`correcciones` son `let` porque el
    // segundo intento (corrector) y el tercero (D3) los reemplazan; `consulta`
    // y `salida` los leen al momento de armar el resultado, no al declararse.
    let grupos = cq.grupos;
    let clave = claveDelProducto(grupos);
    // La moto corregida por alias o distancia 1 (horsen→horse) se anota igual
    // que un término corregido: el cliente ve "busqué HORSE en lugar de horsen".
    let correcciones: CorreccionTermino[] = unirCorregidas(cq.motoCorregida, p.motoEntrada.motoCorregida);
    let correccionDescartada: CorreccionTermino[] | null = null;
    let relajados: string[] = [];
    let motoIgnorada = false;
    let calzaEntero = false;
    let conteos: ConsultaCatalogo["conteos"] = null;
    let decision = "";
    let filas: FilaBusqueda[] = [];

    const consulta = (resultado: ResultadoConsulta): ConsultaCatalogo => ({
      v: 2,
      query: p.texto,
      productos: p.productos,
      moto: motoNombre,
      cilindrada,
      grupos,
      opcionales: cq.opcionales,
      variantes: cq.variantes,
      anio,
      motoMarca,
      motoIgnorada,
      calzaEntero,
      relajados,
      avisos: [],
      corregido: correcciones.length > 0 ? correcciones : null,
      correccionDescartada,
      decision,
      cotizados: [],
      conteos,
      resultado,
    });

    /** El resultado de la búsqueda, con la consulta v2 al día (avisos, decisión y lo cotizado). */
    const salida = (estado: ResultadoConsulta, extra: Partial<ResultadoUno> = {}, textoDecision?: string): ResultadoUno => {
      if (textoDecision !== undefined) decision = textoDecision;
      const quoted = extra.quoted ?? [];
      return vacio(estado, {
        clave,
        moto: motoNombre,
        cilindrada,
        anio,
        ...extra,
        consulta: {
          ...consulta(estado),
          avisos: extra.avisos ?? [],
          cotizados: quoted.map((q) => ({ productId: q.id, nombre: q.nombre, stock: q.stock, precioUsd: q.precioUsd })),
        },
      });
    };

    // El orden, el puntaje y los conteos (cuántas filas calzan el máximo, con
    // o sin la moto, con o sin stock, cuántas nombran una moto, cuántas son
    // universales, cuántas traen la variante) se calculan en SQL sobre TODO el
    // conjunto de candidatos, ANTES de recortar — el bug de origen (25/9)
    // era cortar con `.limit()` SIN order y ordenar después esas pocas filas.
    // La firma es de NUEVE parámetros desde M1 (20260930010000):
    // `p_motos_conocidas` y `p_marcas_de_moto` SIEMPRE viajan (sin ellas nada
    // "nombra moto" y todo es universal).
    const consultar = async (limite: number) =>
      supabase.rpc("buscar_productos", {
        p_terminos: grupos,
        p_opcionales: cq.opcionales,
        p_moto: motoNombre,
        p_cilindrada: unirGrupos(cilindrada, anio),
        p_limite: limite,
        p_variantes: cq.variantes,
        p_moto_marca: motoMarca,
        p_motos_conocidas: [...MOTOS_EN_NOMBRES],
        p_marcas_de_moto: [...MARCAS_DE_MOTO],
      });

    const { data, error } = await consultar(MAX_CATALOG_RESULTS);

    if (error) {
      // D3 (6/9/2026): antes este error se tragaba en silencio. El 5/9/2026
      // se buscó en vano el rastro de un "catálogo fuera de servicio" que
      // resultó ser el interruptor por herramienta apagado, pero la
      // búsqueda fue a ciegas porque un error real de la base tampoco
      // habría dejado nada en el log del servidor.
      log.error("herramienta_catalogo_fallo", { conversationId, detail: errorText(error) });
      // T3 (18/9/2026): un error de la base tampoco deja decidir nada — la
      // red de seguridad de `agent.ts` lo trata como "no identificado".
      return salida("error", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION], errorDetail: errorText(error) });
    }

    filas = data ?? [];

    // T3a (28/9/2026): sin N-1. Con 1 o con 10 grupos hace falta que calcen
    // TODOS — la marca ya no se descarta para "salvar" la búsqueda. Lo que
    // antes tumbaba un producto legítimo (una palabra descriptiva que el
    // nombre no trae) ahora es un opcional que solo desempata, o (A2, D3) un
    // término que se relaja con aviso.
    const sinCoincidencia = (lista: FilaBusqueda[]) => lista.length === 0 || lista[0].puntaje_maximo < grupos.length;

    // T3b (28/9/2026): segundo intento tolerante a tipeos (`corregir_terminos`).
    // SOLO si el primero no calzó los grupos obligatorios: un primer intento
    // que calza nunca toca el corrector. Se protegen las motos conocidas
    // ("beta" es una moto, no un tipeo de "bera") y las palabras que un asesor
    // marcó «No corregir» (D5); `p_marcas` son las marcas de PRODUCTO (solo
    // hacia ellas se acepta una distancia 2 o 3; las motos NO van: kenda→honda,
    // T5b, 30/9/2026) y `p_excluidos` el relleno.
    // A2 T5: GUARDA DE PRODUCTO. Si el reintento calza pero ninguna fila
    // empieza con la cabeza del pedido y la cabeza no se corrigió, la
    // corrección cambió el producto (vicera→visera cotizaba VISERA CASCO
    // FRANKIE en vez del CASCO): se descarta, se anota, y D3 relaja la palabra.
    const intentarCorrector = async (): Promise<void> => {
      const propuestas = await corregirTerminos(
        supabase,
        grupos.map((g) => g[0]).filter((t): t is string => Boolean(t)),
        [...MOTOS_CONOCIDAS, ...(await leerNoCorregir())],
        [...MARCAS_DE_PRODUCTO],
        [...RELLENO_CATALOGO],
        conversationId
      );
      if (propuestas.length === 0) return;

      const nuevoTermino = new Map(propuestas.map((c) => [c.original, c.corregido]));
      const originales = grupos;
      grupos = originales.map((g) => {
        const corregido = g[0] === undefined ? undefined : nuevoTermino.get(g[0]);
        return corregido === undefined ? g : [corregido];
      });

      const reintento = await consultar(MAX_CATALOG_RESULTS);
      if (reintento.error) {
        log.error("herramienta_catalogo_fallo", { conversationId, detail: errorText(reintento.error) });
        grupos = originales;
        return;
      }
      const filasReintento = reintento.data ?? [];

      // Un reintento que no calza los términos corregidos no sirvió de nada: se
      // vuelve a los términos originales (D3 los puede relajar) y la corrección
      // queda solo anotada como descartada. Sin esto una "corrección" dudosa
      // (vicera→visera, que existe en el catálogo) tapaba la palabra que D3
      // habría relajado. (kenda→honda ya no llega hasta acá: T5b no pasa las
      // motos como marcas al corrector.)
      if (sinCoincidencia(filasReintento)) {
        correccionDescartada = propuestas;
        grupos = originales;
        return;
      }

      // GUARDA DE PRODUCTO: solo miran las filas que de verdad calzaron (las de
      // mejor puntaje); una fila de menor puntaje que empieza con la cabeza no
      // cuenta.
      const cabeza = originales[0];
      const cabezaSeCorrigio = cabeza?.[0] !== undefined && nuevoTermino.has(cabeza[0]);
      const guardaAplica = cabeza !== undefined && esGrupoDeProducto(cabeza) && !cabezaSeCorrigio;
      const calzaron = filasReintento.filter((r) => r.puntaje === r.puntaje_maximo);
      if (guardaAplica && !calzaron.some((r) => r.empieza_con_producto)) {
        correccionDescartada = propuestas;
        grupos = originales;
        log.info("correccion_descartada_por_producto", {
          conversationId,
          correcciones: JSON.stringify(propuestas),
        });
        return;
      }

      correcciones = [...correcciones, ...propuestas];
      clave = claveDelProducto(grupos);
      filas = filasReintento;
    };

    // A2 T5, D3 (30/9/2026): tercer intento, DESPUÉS del corrector. Una
    // palabra obligatoria que no está en el nombre ("pwk", "bomba", "reborde")
    // tumbaba la búsqueda. `diagnosticarTerminos` dice, por grupo, si existe en
    // el catálogo y si co-ocurre con la cabeza. La CABEZA es el primer grupo
    // que existe y no es un número suelto. Se relaja un grupo que no es la
    // cabeza, ni una marca (salvo una que no aparece en NINGÚN nombre: el caso
    // ICH), y que no existe o no aparece junto a la cabeza; un número que
    // complementa a una palabra relajada ("reborde de 11") se relaja con ella.
    // Sin diagnóstico (`null`: falló la medición) no se relaja NADA.
    const intentarRelajo = async (): Promise<void> => {
      const primeroNoNumero = grupos.findIndex((g) => !esNumeroSuelto(g));
      if (primeroNoNumero === -1) return;

      let diagnostico: DiagnosticoGrupo[] | null = await diagnosticarTerminos(supabase, grupos, primeroNoNumero, conversationId);
      if (!diagnostico || diagnostico.length === 0) return;
      const existe = (i: number) => diagnostico?.find((d) => d.grupoIdx === i)?.enCatalogo === true;

      const cabeza = grupos.findIndex((g, i) => !esNumeroSuelto(g) && existe(i));
      if (cabeza === -1) return;
      if (cabeza !== primeroNoNumero) {
        diagnostico = await diagnosticarTerminos(supabase, grupos, cabeza, conversationId);
        if (!diagnostico) return;
      }

      const relajar = new Set<number>();
      grupos.forEach((g, i) => {
        if (i === cabeza) return;
        const d = diagnostico?.find((x) => x.grupoIdx === i);
        if (!d) return;
        if (esGrupoDeMarca(g) && d.enCatalogo) return;
        if (!d.enCatalogo || d.conCabeza === false) relajar.add(i);
      });
      cq.gruposInfo.forEach((info, i) => {
        if (i !== cabeza && info.numeroDe !== null && relajar.has(info.numeroDe)) relajar.add(i);
      });
      if (relajar.size === 0) return;

      const indices = [...relajar].sort((a, b) => a - b);
      relajados = indices.map((i) => grupos[i][0]).filter((t): t is string => Boolean(t));
      grupos = grupos.filter((_, i) => !relajar.has(i));
      clave = claveDelProducto(grupos);

      const tercero = await consultar(MAX_CATALOG_RESULTS);
      if (tercero.error) {
        log.error("herramienta_catalogo_fallo", { conversationId, detail: errorText(tercero.error) });
        return;
      }
      filas = tercero.data ?? [];
    };

    if (sinCoincidencia(filas)) await intentarCorrector();
    if (sinCoincidencia(filas)) await intentarRelajo();

    if (sinCoincidencia(filas)) {
      return salida("sin_resultados", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION] }, "sin coincidencia con los términos obligatorios");
    }

    // ---- La decisión ------------------------------------------------------
    const puntajeMaximo = filas[0].puntaje_maximo;
    const puntajeMotoMaximo = filas[0].puntaje_moto_maximo;

    // Corrección del operador sobre la moto (plan, 25-26/9/2026): la moto
    // solo "calza" si el cliente la dio Y al menos una de las filas del
    // máximo puntaje la nombra. Si calza, se cotiza SOLO esa moto (nunca
    // genérico: el cliente ya filtró lo que pudo). Si no calza la moto se
    // ignora para filtrar y rige D1 (si la familia depende de la moto) o la
    // regla sin moto.
    //
    // T3a (28/9/2026): `puntaje_moto_maximo` sale SOLO de la moto con nombre
    // (`puntaje_moto_nombre`): la cilindrada ("250"), el año y la marca ordenan
    // pero NUNCA vuelven verdadero `motoCalza`.
    //
    // T5b (30/9/2026): la base calcula `puntaje_moto_maximo` SOLO entre las filas
    // que empiezan con el producto (si alguna lo hace): una BOMBA DE ACEITE que
    // nombra la SBR ya no hace "calzar" la moto de un cliente que pidió aceite.
    const motoDada = motoNombre.length > 0;
    const motoCalza = motoDada && puntajeMotoMaximo > 0;
    motoIgnorada = motoDada && !motoCalza;

    const delMaximo = (lista: FilaBusqueda[]) =>
      lista.filter(
        (r) => r.puntaje === puntajeMaximo && (!motoCalza || r.puntaje_moto_nombre === puntajeMotoMaximo)
      );

    // Los conteos vienen de la base, calculados ANTES del límite: nunca se
    // miden contando el arreglo que llegó acá, que ya puede venir recortado.
    const coinciden = motoCalza ? filas[0].filas_con_maximo_y_moto : filas[0].filas_con_puntaje_maximo;
    // Con la moto calzando, las ventanas ya cuentan solo las de esa moto; sin
    // moto que calce cuentan todas las del máximo.
    const conStockVentana = filas[0].filas_con_maximo_y_stock;
    const nombranMoto = filas[0].filas_que_nombran_moto;
    const conVariante = filas[0].filas_con_variante;
    const conVarianteYStock = filas[0].filas_con_variante_y_stock;
    const hayMas = coinciden > MAX_CATALOG_RESULTS;
    const preguntaFiltro: "moto" | "producto" = p.dependeDeLaMoto && !motoDada ? "moto" : "producto";
    const cabezaEsCaucho = /^(caucho|tripa)$/.test(grupos[0]?.[0] ?? "");
    const cuantas = p.verOpciones ? MAX_OPCIONES_EXPLICITAS : MAX_OPCIONES_COTIZADAS;

    calzaEntero = cq.variantes.length > 0 && conVariante > 0;
    conteos = { calzan: coinciden, conStock: conStockVentana, nombranMoto, universales: filas[0].filas_universales };

    const nVariantes = cq.variantes.length;
    const esVariante = (r: FilaBusqueda) => nVariantes > 0 && r.puntaje_variante === nVariantes;
    /** D2: la variante existe pero ninguna fila que la trae tiene existencia. */
    const varianteAgotada = calzaEntero && conVarianteYStock === 0;
    /** La variante existe con existencia: restringe (estricta y preferente). */
    const restringeVariante = calzaEntero && conVarianteYStock > 0;
    /** D1: el cliente dio una moto que no calza y la familia SÍ depende de la moto (alguna fila del máximo nombra una). */
    const dependeDeMoto = motoIgnorada && nombranMoto > 0;
    const varianteTexto = cq.variantes
      .map((g) => g[0])
      .filter((t): t is string => Boolean(t))
      .join(" ");
    const nombreMotoCliente = nombreDeMoto(motoNombre, motoMarca, cilindrada);
    const ordenar = (lista: FilaBusqueda[]) => ordenarPorExistencia(lista, { ignorarOpcional: cabezaEsCaucho, motoCalza });
    const conExistencia = (lista: FilaBusqueda[]) => lista.filter((r) => r.stock_quantity > 0);

    // Las filas de trabajo: el máximo (y la moto, si calza), restringido a la
    // variante cuando existe con existencia, y a lo compatible (universales o
    // solo de la marca del cliente) cuando D1 aplica.
    const calcularCandidatos = (): FilaBusqueda[] => {
      let c = delMaximo(filas);
      if (restringeVariante) c = c.filter(esVariante);
      if (dependeDeMoto) c = c.filter((r) => !r.nombra_otra_moto);
      return c;
    };
    const hayFilasSinTraer = () => delMaximo(filas).length < coinciden;
    let yaReintento = false;
    /** Una sola vez: pide más filas cuando las que hacen falta quedaron más allá de las primeras. */
    const traerMasFilas = async (): Promise<void> => {
      if (yaReintento) return;
      yaReintento = true;
      const { data: masFilas, error: errorReintento } = await consultar(LIMITE_REINTENTO);
      if (errorReintento) {
        log.error("herramienta_catalogo_fallo", { conversationId, detail: errorText(errorReintento) });
        return;
      }
      filas = masFilas ?? filas;
    };

    // Cuántas con existencia hay en ESTE conjunto: la ventana de la base
    // cuando no se filtra en memoria; lo que llegó cuando D1 filtra.
    const totalConStockDe = (c: FilaBusqueda[]) =>
      dependeDeMoto ? conExistencia(c).length : restringeVariante ? conVarianteYStock : conStockVentana;

    let candidatos = calcularCandidatos();
    // Para elegir bien hacen falta las filas con existencia: si la base dice
    // que hay más de las que llegaron (las primeras `MAX_CATALOG_RESULTS`
    // traen agotadas con mejor coincidencia y el orden deja las de stock
    // detrás), se vuelve a pedir con más filas. Con D1 no se sabe cuántas
    // compatibles hay más allá de lo traído: se pide si llegaron 3 o menos.
    const necesarias = dependeDeMoto ? MAX_SIN_PREGUNTA + 1 : Math.min(cuantas, totalConStockDe(candidatos));
    if (conExistencia(candidatos).length < necesarias && hayFilasSinTraer()) {
      await traerMasFilas();
      candidatos = calcularCandidatos();
    }
    const enStock = conExistencia(candidatos);
    const totalConStock = totalConStockDe(candidatos);
    const textoConteo = `${totalConStock} con existencia de ${coinciden}`;

    /** Precio ya calculado (`usdFromBs`) de las filas que se muestran. */
    const cotizar = async (mostrados: FilaBusqueda[], alternativas: FilaBusqueda[] = []): Promise<Cotizado[]> => {
      const { rate } = await leerTasa();
      const armar = (r: FilaBusqueda, esAlternativa: boolean): Cotizado => ({
        id: r.id,
        nombre: r.name,
        marca: r.brand,
        // 27/9/2026 ("El mostrador busca sin salir del chat", D1/D3): el
        // dólar de un repuesto en VES se redondea hacia arriba con
        // `usdFromBs`, la MISMA regla que Inventario y el carrito del cierre
        // de venta -- si no, el asesor cotiza $2,60 y Seba $2,54 por el
        // mismo repuesto. `getBcvRate` nunca devuelve una tasa <= 0 (lanza
        // antes), así que `usdFromBs` no da null acá.
        precioUsd: r.currency === "USD" ? r.price : (usdFromBs(r.price, rate) as number),
        precioBs: r.currency === "USD" ? Number((r.price * rate).toFixed(2)) : r.price,
        stock: r.stock_quantity,
        compatibleCon: r.compatibilidad.map((c) => `${c.moto_brand} ${c.moto_model}`),
        ...(esAlternativa ? { esAlternativa: true } : {}),
      });
      return [...mostrados.map((r) => armar(r, false)), ...alternativas.map((r) => armar(r, true))];
    };

    const correccion = correcciones.length > 0 ? [instruccionDeCorreccion(correcciones)] : [];
    const relajo = relajados.length > 0 ? [instruccionDeRelajo(relajados)] : [];
    const avisoRelajado = (agotado: boolean): AvisoCatalogo[] =>
      relajados.length > 0
        ? [{ tipo: agotado ? "relajado_agotado" : "relajado", productoPedido: p.productoPedido, terminos: relajados }]
        : [];

    // ---- D2: la variante pedida existe y está en cero ----------------------
    if (varianteAgotada && !(dependeDeMoto && candidatos.length === 0)) {
      // UNA alternativa con existencia de la misma moto (o de la misma familia
      // sin moto): del mismo conjunto del máximo. Si no hay ninguna, se dice
      // que la variante está agotada y se escala sin ofrecer nada más.
      const alternativa = ordenar(enStock).slice(0, 1);
      if (alternativa.length > 0) {
        const quoted = await cotizar([], alternativa);
        return salida(
          "agotados",
          {
            quoted,
            hayMas,
            masViejo: masViejo(alternativa.map((r) => r.updated_at)),
            avisos: [
              { tipo: "variante_agotada", productoPedido: p.productoPedido, variante: varianteTexto, conAlternativa: true },
              ...avisoRelajado(false),
            ],
            motivoForzado: "confirmar_inventario",
            instrucciones: [
              `La variante que pidió el cliente (${varianteTexto}) está AGOTADA: dilo y ofrece SOLO esta otra opción con existencia. ${CONFIRMAR_INVENTARIO_INSTRUCTION}`,
              ...correccion,
              ...relajo,
            ],
          },
          `variante ${varianteTexto} agotada: ofreció 1 alternativa con existencia (${textoConteo})`
        );
      }
      const deLaVariante = candidatos.filter(esVariante);
      const agotado = ordenar(deLaVariante.length > 0 ? deLaVariante : candidatos).slice(0, 1);
      if (agotado.length === 0) {
        return salida("sin_resultados", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION] }, "sin filas que mostrar");
      }
      const quoted = await cotizar(agotado);
      return salida(
        "agotados",
        {
          quoted,
          hayMas,
          masViejo: masViejo(agotado.map((r) => r.updated_at)),
          avisos: [
            { tipo: "variante_agotada", productoPedido: p.productoPedido, variante: varianteTexto, conAlternativa: false },
            ...avisoRelajado(true),
          ],
          instrucciones: [SIN_STOCK_CASO_INSTRUCTION, ...correccion, ...relajo],
        },
        `variante ${varianteTexto} agotada y sin otra opción con existencia`
      );
    }

    // ---- D1: la moto no calza y no hay NADA compatible ----------------------
    // (Si hay compatibles pero todos agotados, se sigue: se nombra el mejor como
    // agotado, más abajo — «lo más parecido está agotado» nunca es «no hay».)
    if (dependeDeMoto && candidatos.length === 0) {
      return salida(
        "generico",
        {
          hayMas,
          avisos: [{ tipo: "moto_sin_calce", productoPedido: p.productoPedido, moto: nombreMotoCliente }],
          motivoForzado: "confirmar_inventario",
          instrucciones: [ESCALAR_SIN_COTIZAR_INSTRUCTION],
        },
        `moto ${nombreMotoCliente} sin calce y sin universales ni de su marca: se escala sin cotizar`
      );
    }

    // ---- Todo lo que calza está agotado -----------------------------------
    if (totalConStock === 0) {
      // Se nombra SOLO el producto pedido, la mejor fila del conjunto. Nunca se
      // listan otros agotados. Lo más parecido en cero (D3) lo dice su aviso.
      const agotado = ordenar(candidatos).slice(0, 1);
      if (agotado.length === 0) {
        return salida("sin_resultados", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION] }, "sin filas que mostrar");
      }
      const quoted = await cotizar(agotado);
      return salida(
        "agotados",
        {
          quoted,
          hayMas,
          masViejo: masViejo(agotado.map((r) => r.updated_at)),
          avisos: avisoRelajado(true),
          instrucciones: [SIN_STOCK_CASO_INSTRUCTION, ...correccion, ...relajo],
        },
        `todo agotado (${coinciden} filas): nombró 1`
      );
    }

    // ---- Hay existencia: ¿se pregunta, se cotiza, o es un ítem genérico? ----
    // Lo único que no cambia del hotfix es la pregunta de filtro: sin moto que
    // calce y con más de tres con existencia, la primera vez se pregunta (una
    // sola vez por pedido); con la moto calzando nunca se pregunta. En una
    // lista (`permitirPregunta` falso) un ítem así NO se cotiza (D1b: nunca se
    // elige a ciegas) y queda como «varias opciones» para el asesor.
    if (!motoCalza && totalConStock > MAX_SIN_PREGUNTA) {
      const yaPreguntado = !preguntadosEnEsteTurno.has(clave) && yaSePregunto(clave, p.preguntaHechaPara);
      if (p.permitirPregunta && !yaPreguntado && !p.verTodo) {
        return salida(
          "generico",
          {
            hayMas,
            preguntaFiltro,
            avisos: [...avisoRelajado(false)],
            instrucciones: [instruccionGenerica(preguntaFiltro, motoIgnorada)],
          },
          `genérico (${textoConteo}): pregunta de filtro por ${preguntaFiltro}`
        );
      }
      if (!p.permitirPregunta) {
        return salida(
          "generico",
          {
            hayMas,
            avisos: [{ tipo: "varias_opciones", productoPedido: p.productoPedido ?? p.texto }],
            motivoForzado: "confirmar_inventario",
            instrucciones: [ESCALAR_SIN_COTIZAR_INSTRUCTION],
          },
          `ítem genérico dentro de una lista (${textoConteo}): no se cotiza`
        );
      }
      // Ya se preguntó (o el cliente dijo que no sabe / que le muestren todo):
      // no se vuelve a preguntar, se entrega la mejor (hotfix del 29/9/2026).
    }

    const mostrados = ordenar(enStock).slice(0, cuantas);
    const quoted = await cotizar(mostrados);
    const avisos: AvisoCatalogo[] = [];
    if (dependeDeMoto) {
      // Lo que se cotiza no nombra la moto del cliente pero sirve: es universal
      // o nombra solo la marca del cliente.
      const deLaMarca = mostrados.some((r) => !r.es_universal);
      avisos.push({
        tipo: "universales",
        productoPedido: p.productoPedido,
        marca: deLaMarca ? (motoMarca[0]?.[0] ?? null) : null,
      });
    }
    avisos.push(...avisoRelajado(false));

    const quien = motoCalza
      ? `moto ${nombreMotoCliente} calza`
      : dependeDeMoto
        ? `moto ${nombreMotoCliente} sin calce: compatibles`
        : "sin moto que decida";
    return salida(
      "con_existencia",
      {
        quoted,
        hayMas,
        masViejo: masViejo(mostrados.map((r) => r.updated_at)),
        avisos,
        instrucciones: [CONFIRMAR_INVENTARIO_INSTRUCTION, ...(dependeDeMoto ? [INSTRUCCION_UNIVERSALES] : []), ...correccion, ...relajo],
      },
      `${quien}: cotizó ${mostrados.length} (${textoConteo})`
    );
  }

  /** Deja en el `CatalogOutcome` lo que decidió una búsqueda (acumulativo entre llamadas del turno). */
  function registrar(r: ResultadoUno, productoPedido: string | null): void {
    catalogOutcome.consultas.push(r.consulta);
    // T6 (28/9/2026): una línea por búsqueda, para leer en el log de producción
    // qué se buscó, con qué conjuntos y cómo terminó sin abrir `agent_turns`.
    // Solo texto de producto y conjuntos de términos: nada del cliente. Ojo con
    // los nombres de clave: `lib/log.ts` tapa cualquier clave que contenga
    // "phone". `LogContext` solo admite valores primitivos, de ahí el JSON.
    const enJson = (valor: unknown): string | null => (valor === null ? null : JSON.stringify(valor));
    log.info("busqueda_catalogo", {
      conversationId,
      query: r.consulta.query,
      productos: enJson(r.consulta.productos),
      moto: enJson(r.consulta.moto),
      grupos: enJson(r.consulta.grupos),
      opcionales: enJson(r.consulta.opcionales),
      corregido: enJson(r.consulta.corregido),
      // A2 T5: la decisión en una línea (texto fijo armado por el código): lo
      // que hace falta para leer POR QUÉ salió así sin abrir `agent_turns`.
      decision: r.consulta.decision,
      resultado: r.consulta.resultado,
    });

    switch (r.estado) {
      case "generico":
        // Solo una PREGUNTA de filtro abre "hay una pregunta pendiente" (bloquea
        // la red de seguridad). Un genérico que NO pregunta (A2: moto sin calce,
        // «varias opciones» de una lista) escala sin cotizar: su motivo viaja en
        // `motivoForzado`, no en este indicador.
        if (r.preguntaFiltro !== null) {
          catalogOutcome.generico = true;
          catalogOutcome.preguntaFiltro = r.preguntaFiltro;
        }
        break;
      case "con_existencia":
        catalogOutcome.conExistencia = true;
        break;
      case "agotados":
        catalogOutcome.agotados = true;
        break;
      default:
        catalogOutcome.sinResultados = true;
    }

    // A2 T5: los avisos se le dicen al cliente salvo que esta búsqueda haya
    // terminado en una pregunta de filtro (ahí el cliente ve la pregunta, y el
    // aviso queda solo en el registro de la consulta).
    if (r.estado !== "generico" || r.preguntaFiltro === null) catalogOutcome.avisos.push(...r.avisos);
    if (r.motivoForzado !== null) catalogOutcome.motivoForzado = r.motivoForzado;

    for (const q of r.quoted) {
      if (catalogOutcome.cotizacion.some((linea) => linea.productId === q.id)) continue;
      catalogOutcome.cotizacion.push({
        productId: q.id,
        nombre: q.nombre,
        precioUsd: q.precioUsd,
        precioBs: q.precioBs,
        stock: q.stock,
        productoPedido,
        ...(q.esAlternativa ? { esAlternativa: true } : {}),
      });
    }
  }

  /**
   * El monto de una venta sale de lo que se cotizó acá, no de un número que
   * el agente escriba a mano al cerrar -- por eso se deja registro de cada
   * resultado que el modelo efectivamente vio, con el precio exacto en el
   * momento de la cotización. Un genérico no cotiza nada (`quoted` vacío).
   */
  async function guardarCotizaciones(quoted: Cotizado[], rate: number): Promise<void> {
    if (quoted.length === 0) return;
    await supabase.from("conversation_quotes").insert(
      quoted.map((q) => ({
        conversation_id: conversationId,
        product_id: q.id,
        product_name: q.nombre,
        price_usd: q.precioUsd,
        price_bs: q.precioBs,
        bcv_rate: rate,
      }))
    );
  }

  /** Los productos como se los entrega al modelo: el precio ya escrito, sin los números crudos. */
  const paraElModelo = (quoted: Cotizado[]) =>
    quoted.map((q) => ({
      nombre: q.nombre,
      marca: q.marca,
      // El precio va como texto ya escrito y los números crudos se quedan
      // acá. Convertir o reformatear un número es aritmética, y es donde
      // los modelos alucinan; sin el número no hay nada que calcular.
      precio: formatQuote(q.precioUsd, q.precioBs),
      stock: q.stock,
      compatibleCon: q.compatibleCon,
    }));

  /** El aviso de antigüedad del inventario (y su `log.warn`), sobre el repuesto MÁS VIEJO de lo que se cotiza. */
  function avisoDeAntiguedad(fecha: string | null) {
    const freshness = inventoryFreshness(fecha);
    if (freshness.isStale) {
      // El mismo aviso que el del BCV y por la misma razón: una función
      // degradada que no se nota es peor que una que falla. Sin esta línea,
      // "el inventario lleva días congelado" solo se ve consultando la base.
      log.warn("inventario_desactualizado", {
        conversationId,
        dias: freshness.ageDays,
        desde: freshness.updatedAt,
      });
    }
    return freshness;
  }

  return tool({
    description:
      `Busca repuestos en el catálogo real de ${BUSINESS_NAME} por nombre o marca del repuesto, y ordena primero los que calzan con la marca/modelo de la moto del cliente. Devuelve precio en USD y Bs (tasa BCV del día) y el stock disponible. Si el cliente pide VARIOS productos en el mismo mensaje, llámala UNA sola vez con \`productos\` (hasta 5). Si el cliente contesta solo con un dato suelto (una talla, una medida, un color), llámala con ese dato: el sistema lo combina con lo que pidió antes. Si no devuelve nada, ese repuesto no existe en el catálogo — no te lo inventes.`,
    inputSchema: z.object({
      // K2b (20/9/2026): "Si el cliente todavía no nombró ningún repuesto,
      // deja este campo vacío ("") y marca clienteNoNombroRepuesto" — se
      // suma esta frase al describe porque `query` sigue siendo obligatorio
      // (no se cambia la forma del esquema: hay proveedores que tratan mal
      // los campos opcionales) y sin esta instrucción el modelo rellena el
      // campo con un texto inventado que la búsqueda real puede llegar a
      // calzar (ver el comentario de PREGUNTA_QUE_BUSCA_INSTRUCTION).
      //
      // T2 (25-26/9/2026): "solo el nombre del repuesto y lo que lo
      // distingue" — nada de relleno ("precio", "tienen", "para"): ese
      // relleno ya lo descarta `catalogQuery` en código (`RELLENO`,
      // catalog-search.ts), pero pedírselo también al modelo evita que
      // arrastre una frase completa que diluye el puntaje de cada grupo.
      query: z
        .string()
        .describe(
          "Solo el nombre del repuesto y lo que lo distingue -- marca, medida o modelo (ej. 'carburador', 'bujía NGK', 'maleta 45 litros'), sin relleno ('precio', 'tienen', 'para'). Si el cliente respondió solo con un dato suelto (talla, medida, color), pon ese dato tal cual. Si el cliente todavía no nombró ningún repuesto, deja este campo vacío (\"\") y marca clienteNoNombroRepuesto. Si pidió varios productos, déjalo vacío y usa `productos`."
        ),
      // T3a (28/9/2026, D5 del operador): hasta cinco productos en una sola
      // llamada — el cliente que pide "batería y motor de arranque para mi
      // Bera Socialista" recibe una respuesta por producto, no una
      // búsqueda que mezcla los dos.
      productos: z
        .array(z.string())
        .max(5)
        .optional()
        .describe(
          "Cuando el cliente pide VARIOS productos a la vez (máximo 5): un elemento por producto, solo el nombre y lo que lo distingue ('bateria', 'motor de arranque'). Úsalo en vez de `query`; la moto se pone una sola vez en motoBrand/motoModel."
        ),
      // T2 (25-26/9/2026): motoBrand/motoModel ya NO filtran -- `product_
      // compatibility` está vacía hoy (ver CLAUDE.md), así que un filtro
      // real no tendría nada contra qué comparar. Lo que hacen es ORDENAR:
      // `buscar_productos` les da un bono de orden a los repuestos cuyo
      // nombre nombra la moto, y las nueve pastillas de freno de una BERA
      // quedan primero entre las pastillas si el cliente ya dijo "BERA".
      motoBrand: z
        .string()
        .optional()
        .describe("Marca de la moto del cliente, si la mencionó (ej. 'Bera'). Ordena los resultados, no filtra."),
      motoModel: z
        .string()
        .optional()
        .describe("Modelo de la moto del cliente, si lo mencionó (ej. 'SBR 200'). Ordena los resultados, no filtra."),
      // T3a (28/9/2026): el CÓDIGO elige cuál de las dos preguntas de filtro
      // va — antes se le dejaba elegir al modelo entre los dos textos.
      dependeDeLaMoto: z
        .boolean()
        .optional()
        .describe(
          "true si el repuesto depende de la moto del cliente (piezas de motor, frenos, carrocería, eléctrico, transmisión). false o vacío si no depende (aceites, cascos, intercomunicadores, maletas, accesorios). Solo decide qué pregunta se le hace al cliente si la consulta es genérica."
        ),
      // K2 (20/9/2026): ver el comentario de PREGUNTA_QUE_BUSCA_INSTRUCTION.
      clienteNoNombroRepuesto: z
        .boolean()
        .optional()
        .describe(
          "Marca true SOLO cuando el cliente todavía no dijo qué repuesto o producto busca (ej. 'tengo una consulta', 'otra pregunta', '¿tienen disponible?'). NUNCA la marques si nombró cualquier producto, aunque parezca que no lo vendemos (ej. 'casco LS2' SÍ es un producto nombrado: se busca)."
        ),
    }),
    execute: async ({ query, productos, motoBrand, motoModel, dependeDeLaMoto, clienteNoNombroRepuesto }) => {
      // T3 (18/9/2026): el tool "corrió" en cuanto el modelo lo invoca, sea
      // cual sea el resultado — la red de seguridad de `agent.ts` necesita
      // distinguir "nunca se consultó el catálogo" de "se consultó y no se
      // pudo decidir nada" (sin términos de búsqueda, o la consulta falló).
      catalogOutcome.ran = true;

      // K2b (20/9/2026): la bandera gana SIEMPRE, sin mirar los grupos ni
      // tocar la base (ni `buscar_productos` ni `ai_lessons`) — ver el
      // comentario largo de PREGUNTA_QUE_BUSCA_INSTRUCTION arriba: `query`
      // es obligatorio, así que el modelo siempre manda algo aunque no haya
      // repuesto que buscar, y ese "algo" puede calzar productos reales por
      // accidente.
      if (clienteNoNombroRepuesto === true) {
        catalogOutcome.generico = true;
        return { results: [], instruccionParaTuRespuesta: PREGUNTA_QUE_BUSCA_INSTRUCTION };
      }

      const pedido = await leerPedido(conversationId);
      const verTodo = pideVerTodo(rafagaCliente ?? []);
      // A2 T5, D6: solo el pedido EXPLÍCITO de ver opciones saca hasta tres.
      const verOpciones = pideVerOpciones(rafagaCliente ?? []);
      // La moto que el modelo escribió: `motoDesdeTexto` la entiende ("Bera
      // Milan", "EK horsen", "GR 250", "MD Aguila 2014"): con marca Y modelo la
      // marca solo ordena, un año y una cilindrada van aparte y una palabra
      // tipeada a distancia 1 se corrige (horsen→horse).
      const motoDelModelo = motoDesdeTexto(`${motoBrand ?? ""} ${motoModel ?? ""}`);
      const lista = (productos ?? []).map((producto) => producto.trim()).filter(Boolean);

      // ---- Lista de productos (D5, hasta cinco) ----------------------------
      if (lista.length > 0) {
        const motoEntrada: MotoEntrada = {
          ...motoDelModelo,
          moto: unirGrupos(motoDelModelo.moto, catalogQuery(query).moto),
        };
        const resultados: ResultadoUno[] = [];
        for (const producto of lista) {
          const r = await buscarUno({
            texto: producto,
            productoPedido: producto,
            productos: lista,
            motoEntrada,
            motoMemoria: [],
            cilindradaMemoria: [],
            anioMemoria: [],
            dependeDeLaMoto: dependeDeLaMoto === true,
            permitirPregunta: false,
            preguntaHechaPara: null,
            verTodo: false,
            verOpciones: false,
          });
          registrar(r, producto);
          resultados.push(r);
        }

        const conProductos = resultados.filter((r) => r.quoted.length > 0);
        const quotedTodos = conProductos.flatMap((r) => r.quoted);
        let rate = 0;
        let isStale = false;
        if (quotedTodos.length > 0) {
          ({ rate, isStale } = await leerTasa());
          await guardarCotizaciones(quotedTodos, rate);
        }
        const freshness = avisoDeAntiguedad(masViejo(conProductos.map((r) => r.masViejo)));

        // Con algo con existencia se cotiza y se escala como siempre; si NO
        // quedó nada con existencia pero algún ítem se escala sin cotizar
        // (`motivoForzado`: moto sin calce, «varias opciones»), esa es la
        // instrucción; y solo con agotados, la de sin stock.
        const hayExistencia = resultados.some((r) => r.quoted.some((q) => q.stock > 0));
        const hayAgotados = resultados.some((r) => r.estado === "agotados");
        const hayForzado = resultados.some((r) => r.motivoForzado !== null);
        const casoLista = hayExistencia
          ? `${CONFIRMAR_INVENTARIO_INSTRUCTION} La lista trae varios productos: nómbralos en el orden en que llegan; los que salen agotados, sin resultados o «varias opciones», dilo tal cual, uno por uno.`
          : hayForzado
            ? ESCALAR_SIN_COTIZAR_INSTRUCTION
            : hayAgotados
              ? SIN_STOCK_CASO_INSTRUCTION
              : NO_IDENTIFICADO_INSTRUCTION;
        const resumen = `Resumen por producto, en el orden pedido: ${resultados
          .map((r, i) => `${lista[i]} (${DESCRIPCION_DE_ESTADO[r.estado]})`)
          .join(", ")}.`;
        const correccionesDeLista = resultados
          .filter((r) => r.quoted.length > 0)
          .flatMap((r) => r.consulta.corregido ?? []);
        const avisoCorreccion = correccionesDeLista.length > 0 ? instruccionDeCorreccion(correccionesDeLista) : null;

        await guardarPedido(conversationId, {
          ultimoQuery: pedido?.ultimoQuery ?? null,
          moto: motoEntrada.moto.length > 0 ? motoEntrada.moto : (pedido?.moto ?? []),
          cilindrada: motoDelModelo.cilindrada.length > 0 ? motoDelModelo.cilindrada : (pedido?.cilindrada ?? []),
          anio: motoDelModelo.anio.length > 0 ? motoDelModelo.anio : (pedido?.anio ?? []),
          preguntaHechaPara: pedido?.preguntaHechaPara ?? null,
          preguntaTipo: pedido?.preguntaTipo ?? null,
        });

        return {
          porProducto: resultados.map((r, i) => ({
            producto: lista[i],
            estado: r.estado,
            results: paraElModelo(r.quoted),
            hayMas: r.hayMas,
          })),
          tasaBcvUsada: rate,
          tasaDesactualizada: isStale,
          inventarioDesactualizado: freshness.isStale,
          instruccionParaTuRespuesta: [casoLista, resumen, avisoCorreccion, inventoryAgeInstruction(freshness)]
            .filter((linea): linea is string => linea !== null)
            .join(" "),
        };
      }

      // ---- Consulta simple ---------------------------------------------------
      // Respuesta suelta: si lo que llegó no trae NINGÚN término de producto
      // (solo talla, color, año, medida, viscosidad, moto, cilindrada o un
      // número), es la respuesta a la pregunta anterior — se combina con el
      // último pedido en vez de buscarse sola ("24" tras "asiento" + sbr).
      // A2 T5: tras la pregunta por la MOTO, un número de dos dígitos ("sbr
      // 24") es el año, no una medida; tras la pregunta por el PRODUCTO sigue
      // siendo una medida.
      //
      // A2 T5: si lo último que se preguntó fue la MOTO y la respuesta trae una
      // ("Bera New Runner", "Toro Rex", "MD Aguila 2014", "sbr 24"), la respuesta
      // ENTERA es la moto: `motoDesdeTexto` la lee toda como moto (la palabra "new"
      // o "toro" no es un repuesto que haya que encontrar) y el producto sigue
      // siendo el pedido anterior. Un número de dos dígitos es el año.
      const respuestaComoAnio = dosDigitosComoAnio(query);
      const q = catalogQuery(respuestaComoAnio);
      const respondeLaMoto =
        pedido?.preguntaTipo === "moto" &&
        pedido.ultimoQuery !== null &&
        (q.moto.length > 0 || q.motoMarca.length > 0 || q.anio.length > 0);
      const esSuelta = !respondeLaMoto && !catalogQuery(query).grupos.some(esGrupoDeProducto);
      const texto = respondeLaMoto
        ? (pedido?.ultimoQuery ?? query)
        : esSuelta && pedido?.ultimoQuery
          ? `${pedido.ultimoQuery} ${query}`.trim()
          : query;

      const r = await buscarUno({
        texto,
        productoPedido: null,
        productos: null,
        motoEntrada: respondeLaMoto ? unirMotoEntrada(motoDelModelo, motoDesdeTexto(respuestaComoAnio)) : motoDelModelo,
        motoMemoria: esSuelta ? (pedido?.moto ?? []) : [],
        cilindradaMemoria: esSuelta ? (pedido?.cilindrada ?? []) : [],
        anioMemoria: esSuelta ? (pedido?.anio ?? []) : [],
        dependeDeLaMoto: dependeDeLaMoto === true,
        permitirPregunta: true,
        preguntaHechaPara: pedido?.preguntaHechaPara ?? null,
        verTodo,
        verOpciones,
      });
      registrar(r, null);

      // La memoria: el pedido acumulado (solo si tiene producto de verdad),
      // la moto, cilindrada y año que rigieron (o los de antes, si esta consulta
      // no dio ninguno) y, si se acaba de preguntar, por qué producto y qué
      // se preguntó (la moto o el producto).
      const tieneProducto = r.consulta.grupos.some(esGrupoDeProducto);
      const sePregunto = r.estado === "generico" && r.preguntaFiltro !== null;
      if (sePregunto) preguntadosEnEsteTurno.add(r.clave);
      await guardarPedido(conversationId, {
        ultimoQuery: tieneProducto ? texto : (pedido?.ultimoQuery ?? null),
        moto: r.moto.length > 0 ? r.moto : (pedido?.moto ?? []),
        cilindrada: r.cilindrada.length > 0 ? r.cilindrada : (pedido?.cilindrada ?? []),
        anio: r.anio.length > 0 ? r.anio : (pedido?.anio ?? []),
        preguntaHechaPara: sePregunto ? r.clave : (pedido?.preguntaHechaPara ?? null),
        preguntaTipo: sePregunto ? r.preguntaFiltro : (pedido?.preguntaTipo ?? null),
      });

      if (r.estado === "error") {
        return {
          results: [],
          error: "No se pudo consultar el catálogo en este momento.",
          instruccionParaTuRespuesta: r.instrucciones.join(" "),
        };
      }

      if (r.estado === "generico") {
        // No se muestra ningún producto ni se cotiza: el turno solo
        // pregunta, sin afirmar existencia. Recortar o listar acá
        // contradiría "pregunta primero".
        return {
          results: [],
          hayMas: r.hayMas,
          instruccionParaTuRespuesta: r.instrucciones.join(" "),
        };
      }

      if (r.quoted.length === 0) {
        return { results: [], instruccionParaTuRespuesta: r.instrucciones.join(" ") };
      }

      const { rate, isStale } = await leerTasa();
      await guardarCotizaciones(r.quoted, rate);
      const freshness = avisoDeAntiguedad(r.masViejo);

      // Las advertencias se juntan en una sola instrucción: el modelo lee una
      // frase, no un formulario.
      return {
        results: paraElModelo(r.quoted),
        tasaBcvUsada: rate,
        tasaDesactualizada: isStale,
        inventarioDesactualizado: freshness.isStale,
        hayMas: r.hayMas,
        instruccionParaTuRespuesta: [r.instrucciones[0], inventoryAgeInstruction(freshness), ...r.instrucciones.slice(1)]
          .filter((linea): linea is string => Boolean(linea))
          .join(" "),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Historial de compras — devolucion. Solo lectura: no hay forma de aprobar,
// rechazar ni modificar nada desde esta herramienta.
// ---------------------------------------------------------------------------
export function buildOrderHistoryTool({ supabase, contactId, conversationId }: ToolDeps) {
  return tool({
    description:
      "Consulta el historial real de compras del cliente (qué compró, cuándo, cuánto pagó). Solo lectura: úsala para armar contexto, nunca para aprobar ni procesar una devolución.",
    inputSchema: z.object({}),
    execute: async () => {
      const { data: orders, error } = await supabase
        .from("orders")
        .select("id, purchased_at, total_amount, currency, order_items(description, quantity, unit_price)")
        .eq("contact_id", contactId)
        .order("purchased_at", { ascending: false })
        .limit(10);

      if (error) {
        // D3 (6/9/2026): mismo rastro que la herramienta de catálogo, misma
        // historia (ver el comentario de arriba en `buildCatalogTool`).
        log.error("herramienta_historial_fallo", { conversationId, detail: errorText(error) });
        return { orders: [], error: "No se pudo consultar el historial de compras." };
      }

      return {
        orders: (orders ?? []).map((o) => ({
          fecha: o.purchased_at,
          total: o.total_amount,
          moneda: o.currency,
          items: o.order_items.map((i) => ({
            descripcion: i.description,
            cantidad: i.quantity,
            precioUnitario: i.unit_price,
          })),
        })),
      };
    },
  });
}

/**
 * La instrucción con la que el modelo redacta la despedida al escalar, con o
 * sin asesor asignado.
 *
 * Nace en el Frente B4 ("El reloj dice la verdad", 5/9/2026) cubriendo solo
 * el caso SIN asesor: hasta ahí la IA no sabía si la tienda estaba abierta,
 * así que no podía decir cuándo la iban a atender sin arriesgarse a prometer
 * un plazo falso ("ya te atienden" a las 2 am de un domingo). La Tarea 5
 * ("La voz cercana y la espera visible", 14/9/2026) encontró la MISMA falla
 * del lado CON asesor —170 promesas "ya te paso con un asesor" en 72 h, 23
 * con la tienda ya cerrada y sin decir cuándo— y la cerró acá, renombrando la
 * función (antes `unassignedEscalationInstruction`) porque dejó de ser
 * exclusiva del caso sin asesor.
 *
 * Con `businessStatus` ya calculado por `escalateConversation` (mismo
 * `now`/horario que dejó el evento de sistema, SIEMPRE presente desde la
 * Tarea 5 — ver escalate.ts), acá solo se traduce a prosa, en las cuatro
 * combinaciones de asesor × horario:
 * - con asesor, abierta: cálida, sin horario ("un asesor toma su caso").
 * - con asesor, cerrada: agradece la paciencia y nombra cuándo escribe el
 *   asesor (día y hora exactos, o "apenas la tienda vuelva a abrir" si no hay
 *   ninguna franja en los próximos 7 días).
 * - sin asesor, abierta: promete "en breve", que sí es cierto porque hay
 *   quién conteste hoy.
 * - sin asesor, cerrada: mismo criterio de B4, con o sin próxima apertura.
 *
 * Tarea 3 ("La voz cercana y la espera visible", 14/9/2026): hasta acá solo
 * la rama "con asesor, cerrada" llevaba calidez explícita ("dile con
 * calidez..."); las otras tres decían el hecho seco ("un asesor lo va a
 * atender", "su caso quedó registrado") sin agradecer ni suavizar. Las
 * cuatro ramas reciben ahora el mismo trato: agradecer la espera o la
 * paciencia, y nombrar con calidez lo que va a pasar.
 *
 * Corrección del 15/9/2026 (verificación final de "La voz de mostrador con
 * nombre propio y el cierre de v1.1"): un chat NUEVO ("buenas tardes,
 * tienen tanque de EK Xpress") no encontró stock, escaló por
 * `escalarAAsesor` (motivo `seguimiento`) y la redacción final salió SIN el
 * saludo de franja que `needsGreeting` pedía en el sufijo de `prompt.ts` —el
 * modelo obedece la ÚLTIMA instrucción que lee, y esta no mencionaba el
 * saludo, así que se lo comía. Las cuatro ramas terminan ahora con
 * `RECORDATORIO_SALUDO` para que el saludo del primer mensaje sobreviva
 * también cuando el turno termina en una escalada.
 *
 * 18/9/2026 (T2b, plan "Seba atiende el mostrador"): el saludo dejó de ser
 * algo que el modelo redacta — sale como mensaje aparte, por código, ANTES
 * del tool loop (`sebaGreeting`, agent.ts). El riesgo que motivó este
 * recordatorio en 15/9 ya no existe (no hay ningún saludo que el modelo
 * pueda "comerse"), pero el texto se conserva con el sentido inverso: sigue
 * siendo la ÚLTIMA instrucción que las cuatro ramas le dejan al modelo, así
 * que tiene que seguir diciendo la verdad — no saludes, ya se presentó.
 */
export const RECORDATORIO_SALUDO =
  " No saludes ni te presentes: Seba ya se presentó en un mensaje aparte.";

function escalationInstruction(status: BusinessStatus | undefined, assignedName: string | null): string {
  const abierta = !status || status.open;

  if (assignedName) {
    if (abierta) {
      return `Ya está asignado a ${assignedName}. Dile al cliente, con calidez, que un asesor toma su caso y le escribe por acá; agradécele la espera.${RECORDATORIO_SALUDO}`;
    }
    const cuando = status?.nextOpening
      ? `${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}`
      : "apenas la tienda vuelva a abrir";
    return `Ya está asignado a ${assignedName}, pero la tienda está cerrada. Dile al cliente, con calidez, que un asesor toma su caso y le escribe ${cuando}; agradécele la paciencia. NO prometas que lo atienden ahora.${RECORDATORIO_SALUDO}`;
  }

  if (abierta) {
    return `No hay ningún asesor conectado ahora. Dile al cliente, con calidez, que su caso quedó registrado y que le escriben en breve, apenas haya alguien disponible; agradécele la espera. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
  }

  if (!status?.nextOpening) {
    return `No hay ningún asesor conectado ahora y la tienda está cerrada. Dile al cliente, con calidez, que su caso quedó registrado y que le escriben apenas la tienda vuelva a abrir; agradécele la paciencia. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
  }

  return `No hay ningún asesor conectado ahora y la tienda está cerrada. Dile al cliente, con calidez, que su caso quedó registrado y que un asesor le escribe ${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}; agradécele la paciencia. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
}

/** Los siete motivos de siempre, sin asesor asignado todavía. */
const MOTIVOS_COMPLETOS = [
  "devolucion",
  "queja",
  "intencion_compra",
  "seguimiento",
  "confirmar_inventario",
  "sin_stock",
  "no_identificado",
] as const;

/**
 * T2, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026,
 * D2 del operador). Medido en producción el 21/9/2026: en la primera hora
 * del deploy, 24 de 34 turnos escalados eran repeticiones sobre un chat que
 * YA tenía asesor asignado (bastaban 9) — el modelo no tenía forma de saber
 * que el caso ya estaba en manos de alguien, así que volvía a llamar
 * `escalarAAsesor` en cada mensaje del cliente. `escalate.ts` ya lo
 * detectaba (rama `alreadyAssigned`, solo deja una nota interna "IA reiteró
 * la escalada…"), pero la vuelta completa al proveedor ya se había pagado.
 * Con un asesor asignado, `buildEscalateTool` recorta el enum de `motivo` a
 * este único valor: la única razón real para volver a tocar la herramienta
 * es que el cliente ACABA de confirmar que quiere comprar (deja
 * `deal_status: "in_progress"`, ver `escalate.ts`), no repetir el pase.
 */
const MOTIVOS_RESTRINGIDOS = ["intencion_compra"] as const;

const RESUMEN_DESCRIBE =
  // T1 (21/9/2026): tope de 600 caracteres — las dos espirales medidas en
  // producción también inflaban este campo en cada llamada repetida a la
  // herramienta. Corrección 4b de la revisión de T1 (21/9/2026): el
  // `.max(600)` ya existía, pero el describe no se lo decía al modelo —
  // se enteraba recién por un error de validación que le quema un paso.
  "Resumen para el asesor: qué quiere el cliente, qué compró si aplica, y por qué se escala. Máximo 600 caracteres.";

/**
 * "Solo si motivo='queja'…": la categoría queda igual en las dos variantes
 * de la herramienta — en modo restringido el modelo nunca podrá elegir
 * `queja` (el enum de `motivo` no la admite), así que este campo queda
 * simplemente sin uso ahí, sin necesidad de un esquema aparte para omitirlo.
 */
function categoriaReclamoField() {
  return z
    .enum(RECLAMO_CATEGORIES)
    .optional()
    .describe("Solo si motivo='queja': la categoría que mejor describe el reclamo.");
}

/**
 * El `execute` de `escalarAAsesor`, compartido entre el modo completo y el
 * restringido — la única diferencia entre los dos es el ESQUEMA de entrada
 * (`inputSchema`, más abajo), nunca qué hace la llamada una vez que zod ya
 * validó `motivo`.
 *
 * `pending` guarda la promesa de la PRIMERA escalada de este turno (T1,
 * 21/9/2026): se asigna de forma SÍNCRONA, antes del primer `await`, así que
 * dos tool calls disparadas juntas en el mismo paso (sin esperar la primera)
 * también quedan cubiertas — la segunda invocación ve `pending` ya asignado
 * por la primera, sin haber corrido todavía ningún código asíncrono de por
 * medio.
 *
 * Corrección 4a de la revisión de T1 (21/9/2026): hasta acá `pending` quedaba
 * cacheado PARA SIEMPRE en cuanto la primera llamada terminaba — si
 * `escalateConversation` lanzaba, o algún día devolviera `escalated: false`,
 * un segundo intento legítimo del modelo en el MISMO turno se topaba con esa
 * promesa rota/negativa sin poder volver a intentarlo de verdad. Ahora, si el
 * resultado no cuajó (`!result.escalated`) o la promesa rechaza, `pending`
 * vuelve a `null` para que la siguiente llamada invoque `escalateConversation`
 * de nuevo — solo una escalada que SÍ salió bien queda cacheada el resto del
 * turno.
 */
function buildEscalateExecute(
  { supabase, conversationId, contactId, businessHours, now }: ToolDeps,
  outcome: EscalationOutcome
) {
  let pending: Promise<EscalateResult & { instruccionParaTuRespuesta: string }> | null = null;

  return async ({
    motivo,
    resumen,
    categoriaReclamo,
  }: {
    motivo: EscalationMotivo;
    resumen: string;
    categoriaReclamo?: ReclamoCategory;
  }) => {
    // T1 (21/9/2026): ya hay una escalada en curso (o resuelta) en este
    // turno — se devuelve el MISMO resultado sin tocar la base ni reclamar
    // otro asesor. `escalateConversation` (escalate.ts) no se toca: la
    // segunda llamada nunca llega a invocarla.
    if (pending) {
      log.info("escalada_repetida_en_el_turno", { conversationId, motivo });
      return pending;
    }

    const attempt = (async () => {
      const result = await escalateConversation(supabase, {
        conversationId,
        contactId,
        motivo,
        resumen,
        categoriaReclamo,
        businessHours,
        now,
      });

      if (!result.escalated) {
        // Corrección 4a: una escalada que no cuajó no puede dejar `pending`
        // cacheado para el resto del turno.
        pending = null;
      }

      outcome.escalated = result.escalated;
      outcome.motivo = motivo;
      outcome.assignedAgentName = result.assignedAgentName ?? undefined;
      outcome.reason = result.reason;
      outcome.unassigned = result.unassigned;
      outcome.businessStatus = result.businessStatus;

      // El modelo redacta el cierre con esto, así que se le dice en palabras
      // qué prometer: ni con asesor ni sin él puede decir «ya te atienden»
      // sin saber si la tienda está abierta (Tarea 5, 14/9/2026).
      return {
        ...result,
        instruccionParaTuRespuesta: escalationInstruction(result.businessStatus, result.assignedAgentName ?? null),
      };
    })();

    // Corrección 4a: si `escalateConversation` LANZA, `pending` se libera
    // igual que cuando devuelve `escalated: false` — de lo contrario una
    // excepción transitoria quedaría cacheada para siempre. El error sigue
    // propagándose a quien esté esperando `attempt` (el tool loop del SDK);
    // este `.catch` es solo para resetear la variable, nunca para tragarlo.
    attempt.catch(() => {
      pending = null;
    });

    pending = attempt;
    return attempt;
  };
}

// ---------------------------------------------------------------------------
// Escalar a un asesor — devolucion, queja, e intención de compra dentro de
// consulta_disponibilidad. Única forma de tocar dinero o cerrar un caso: la
// IA nunca aprueba, rechaza ni cierra nada por su cuenta.
// ---------------------------------------------------------------------------
export function buildEscalateTool(
  deps: ToolDeps,
  outcome: EscalationOutcome,
  /**
   * T2, plan "La escalada se hace una vez y la búsqueda responde"
   * (21/9/2026, D2 del operador). `agent.ts` la pasa en `true` cuando el
   * chat que abre el turno YA tiene asesor asignado — ver `esperandoAsesor`
   * en `runTurnPhases`. Default `false`: sin asesor, la herramienta se
   * arma exactamente como siempre.
   */
  opciones: { restrictedToPurchase?: boolean } = {}
) {
  const restrictedToPurchase = opciones.restrictedToPurchase ?? false;
  const execute = buildEscalateExecute(deps, outcome);

  if (restrictedToPurchase) {
    return tool({
      // T2 (21/9/2026): con asesor asignado, la herramienta deja de ser "la
      // única forma de pasar el caso" (ya está pasado) y pasa a ser
      // solamente el gatillo para marcar que el cliente confirmó la compra.
      description:
        "Este chat YA tiene un asesor asignado que todavía no le escribió al cliente. Úsala SOLO cuando el cliente ACABA de confirmar que quiere comprar (motivo intencion_compra), para dejar marcada la venta en curso — no la llames para volver a pasar el caso ni para pedir que lo atiendan: el asesor ya lo tiene.",
      inputSchema: z.object({
        motivo: z
          .enum(MOTIVOS_RESTRINGIDOS)
          .describe(
            "El único motivo posible en este chat: intencion_compra, cuando el cliente acaba de confirmar que quiere comprar. Deja marcada la venta en curso; no vuelve a pasar el caso, el asesor ya lo tiene."
          ),
        resumen: z.string().max(600).describe(RESUMEN_DESCRIBE),
        categoriaReclamo: categoriaReclamoField(),
      }),
      execute,
    });
  }

  return tool({
    // 18/9/2026 (T2a, plan "Seba atiende el mostrador", requisito 6 del
    // cliente): hasta acá esta descripción decía "pausa la IA" — escalar
    // apagaba el turno en el acto (`escalate.ts`, `ai_enabled: false`). El
    // requisito 6 pide lo contrario: tras pasar el caso, Seba sigue
    // respondiendo lo que el cliente pregunte en ese chat hasta que el
    // asesor escriba su primer mensaje real, y recién ahí se calla. La
    // reescritura de `escalate.ts` para que de verdad deje de apagar
    // `ai_enabled` es tarea aparte (T4 del plan); acá solo se corrige lo que
    // el modelo lee sobre qué hace esta herramienta.
    //
    // Reescrito el 22-23/9/2026 (T5, plan "Seba no habla de más mientras el
    // cliente espera al asesor", opción (b) del operador): "la IA sigue
    // contestando en este chat" dejó de ser cierto — medido en producción el
    // 22/9/2026, 27 % de los mensajes de Seba salían con una escalada
    // abierta, la mayoría puro relleno ("el asesor ya tiene tu caso"), hasta
    // 6 en la misma espera. Desde esta tarea, después de escalar, el chat
    // pasa por el camino "espera abierta" de `runTurnPhases` (agent.ts): ni
    // tool loop ni clasificación, solo un escenario ya redactado del panel
    // si calza con lo que el cliente pregunta — el resto queda anotado para
    // el asesor, sin mensaje nuevo al cliente.
    description:
      "Escala la conversación a un asesor de la tienda: asigna al asesor con más tiempo sin recibir un cliente nuevo, y deja un resumen para que no tenga que volver a preguntar todo. Después de esto YA NO vas a poder redactar respuestas nuevas en este chat: si el cliente escribe algo más mientras espera, solo se le contesta si calza un escenario informativo ya armado del panel — lo demás queda anotado para que el asesor lo vea. Es la única forma de tocar dinero real (devoluciones, ventas) o reclamos — la IA nunca los resuelve sola.",
    inputSchema: z.object({
      // Tarea 7 ("El guion atiende a quien no es cliente…", 14/9/2026): suma
      // `seguimiento` (ya admitido por `EscalationMotivo` en escalate.ts,
      // que no tuvo que tocarse) para el aviso de reposición de un repuesto
      // agotado, las listas largas o de mayoreo, y la postventa en general —
      // casos que no son ni una devolución, ni una queja, ni una venta en
      // curso, y que hasta ahora no tenían dónde caer sin forzar uno de los
      // otros tres motivos.
      // T3 (18/9/2026, requisitos 2/3/4): suma confirmar_inventario, sin_stock
      // y no_identificado — los tres motivos con los que `buildCatalogTool`
      // le pide al modelo que escale tras cotizar. Sin `consulta_generica`:
      // ese caso (requisito 5) pide una pregunta y a propósito no escala.
      motivo: z
        .enum(MOTIVOS_COMPLETOS)
        .describe(
          "Por qué se escala: devolucion (quiere devolver o cambiar algo que ya compró), queja (reclamo), intencion_compra (quiere comprar y hay que cobrarle), seguimiento (avisar cuando llegue un repuesto agotado, una lista larga o de mayoreo, o cualquier postventa que no sea devolución ni queja), confirmar_inventario (el catálogo mostró un repuesto con existencia y hay que confirmar el inventario físico), sin_stock (el catálogo marca cero unidades), no_identificado (no se encontró el repuesto en el catálogo, o no quedó claro cuál es)."
        ),
      resumen: z.string().max(600).describe(RESUMEN_DESCRIBE),
      categoriaReclamo: categoriaReclamoField(),
    }),
    execute,
  });
}
