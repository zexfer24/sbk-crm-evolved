import "server-only";
import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { BUSINESS_NAME } from "@/lib/brand";
import { getBcvRate } from "@/lib/ai/bcv";
import { catalogQuery, type SearchSynonym } from "@/lib/ai/catalog-search";
import { guardarPedido, leerPedido } from "@/lib/ai/catalog-memory";
import { pideVerTodo } from "@/lib/ai/catalog-request";
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
 * Se le dice en palabras qué hacer con el recorte: si no, el modelo enumera
 * los que le llegaron como si fueran todo el catálogo.
 */
const RECORTE_INSTRUCTION =
  "Hay más resultados de los que caben acá. Muestra estos y pídele al cliente que precise (marca del repuesto, modelo de su moto) en vez de dar a entender que esto es todo lo que hay.";

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
 * MENOS un resultado con existencia, se cotiza tal cual (los que estén en
 * cero se dicen como agotados) y se agrega el texto fijo del requisito 3.
 */
const CONFIRMAR_INVENTARIO_INSTRUCTION =
  `Da nombre, precio y stock tal como llegan (si alguno está en cero, dilo como agotado) y agrega textual: «${TEXTO_CONFIRMAR_INVENTARIO}». Luego llama a escalarAAsesor con motivo confirmar_inventario en este mismo turno.`;

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
}

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
}

/** Cómo terminó una búsqueda. */
export type ResultadoConsulta =
  | "con_existencia"
  | "agotados"
  | "generico"
  | "sin_resultados"
  | "sin_terminos"
  | "error";

/** El rastro de UNA búsqueda a `buscar_productos`. Ver `CatalogOutcome.consultas`. */
export interface ConsultaCatalogo {
  /** El texto que de verdad se buscó (ya combinado con el pedido anterior si era una respuesta suelta). */
  query: string;
  /** La lista completa que mandó el modelo, o `null` si fue una consulta simple. */
  productos: string[] | null;
  /** Los conjuntos que viajaron a SQL. */
  moto: string[][];
  cilindrada: string[][];
  grupos: string[][];
  opcionales: string[][];
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

/** Cuántos productos con existencia se entregan cuando NO se pregunta (ya se preguntó, o el cliente pidió ver todo). */
const MAX_OPCIONES_SIN_PREGUNTA = 3;

/** Cuántos agotados se listan: alcanzan tres para que el asesor vea de qué se habla; siete agotados son ruido. */
const MAX_AGOTADOS_LISTADOS = 3;

/** Con este número de filas del máximo o menos no hay nada que preguntar: se cotizan todas. */
const MAX_SIN_PREGUNTA = 3;

/** Tope de filas al reintentar cuando las que tienen stock quedaron más allá de `MAX_CATALOG_RESULTS` (el máximo que admite la función SQL). */
const LIMITE_REINTENTO = 50;

/** Un grupo es "de producto" si es una palabra (no un número, una medida, una viscosidad ni un modelo con dígitos). */
function esGrupoDeProducto(grupo: string[]): boolean {
  return /^[a-z]+$/.test(grupo[0] ?? "");
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

/**
 * La moto y la cilindrada que el MODELO pasó en `motoBrand`/`motoModel`: lo
 * que ese texto trae se toma como moto CON NOMBRE aunque no esté en
 * `MOTOS_CONOCIDAS` ("GN 125" llega como el grupo "gn125"): el modelo lo dijo
 * explícitamente como moto, a diferencia del `query`, donde una palabra
 * suelta puede ser cualquier cosa.
 */
function motoDeTexto(texto: string): { moto: string[][]; cilindrada: string[][] } {
  const q = catalogQuery(texto);
  return { moto: unirGrupos(q.moto, q.grupos), cilindrada: q.cilindrada };
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
}

/** Lo que decidió UNA búsqueda (un producto de una lista, o la consulta simple). */
interface ResultadoUno {
  estado: ResultadoConsulta;
  /** Lo que se le muestra al modelo y se cotiza: vacío salvo con_existencia/agotados. */
  quoted: Cotizado[];
  /** Hay más filas del máximo que las que caben. */
  hayMas: boolean;
  /** Caso + (recorte) — la antigüedad del inventario la agrega quien arma la respuesta. */
  instrucciones: string[];
  /** Solo con `estado = "generico"`. */
  preguntaFiltro: "moto" | "producto" | null;
  clave: string;
  /** La moto y la cilindrada con las que de verdad se buscó (entrada + memoria). */
  moto: string[][];
  cilindrada: string[][];
  /** El `updated_at` más viejo de lo que se muestra, para el aviso de antigüedad. */
  masViejo: string | null;
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

  const leerTasa = () => {
    tasaMemo ??= getBcvRate(supabase);
    return tasaMemo;
  };

  /**
   * UNA búsqueda contra `buscar_productos` y la decisión completa sobre lo
   * que trajo. Nunca toca `catalogOutcome` ni Redis: solo decide (`registrar`
   * y el orquestador de abajo dejan el rastro).
   */
  async function buscarUno(p: {
    texto: string;
    /** El producto de la lista que se está buscando, o null si es una consulta simple. */
    productoPedido: string | null;
    /** La lista completa que mandó el modelo, o null. */
    productos: string[] | null;
    motoEntrada: string[][];
    cilindradaEntrada: string[][];
    /** Solo se usan si ni la consulta ni el modelo dieron moto (respuesta suelta). */
    motoMemoria: string[][];
    cilindradaMemoria: string[][];
    dependeDeLaMoto: boolean;
    /** Falso en una lista: ahí nunca se pregunta, se entregan opciones. */
    permitirPregunta: boolean;
    preguntaHechaPara: string | null;
    verTodo: boolean;
  }): Promise<ResultadoUno> {
    const vacio = (estado: ResultadoConsulta, extra: Partial<ResultadoUno> = {}): ResultadoUno => ({
      estado,
      quoted: [],
      hayMas: false,
      instrucciones: [],
      preguntaFiltro: null,
      clave: "",
      moto: [],
      cilindrada: [],
      masViejo: null,
      consulta: {
        query: p.texto,
        productos: p.productos,
        moto: [],
        cilindrada: [],
        grupos: [],
        opcionales: [],
        resultado: estado,
      },
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
    let moto = unirGrupos(cq.moto, p.motoEntrada);
    if (moto.length === 0) moto = p.motoMemoria;
    let cilindrada = unirGrupos(cq.cilindrada, p.cilindradaEntrada);
    if (cilindrada.length === 0) cilindrada = p.cilindradaMemoria;
    const clave = claveDelProducto(cq.grupos);

    const consulta = (resultado: ResultadoConsulta): ConsultaCatalogo => ({
      query: p.texto,
      productos: p.productos,
      moto,
      cilindrada,
      grupos: cq.grupos,
      opcionales: cq.opcionales,
      resultado,
    });
    const base = (estado: ResultadoConsulta, extra: Partial<ResultadoUno> = {}) =>
      vacio(estado, { clave, moto, cilindrada, consulta: consulta(estado), ...extra });

    // El orden, el puntaje y los conteos (cuántas filas calzan el máximo, con
    // o sin la moto, con o sin stock) se calculan en SQL sobre TODO el
    // conjunto de candidatos, ANTES de recortar — el bug de origen (25/9)
    // era cortar con `.limit()` SIN order y ordenar después esas pocas filas.
    const consultar = async (limite: number) =>
      supabase.rpc("buscar_productos", {
        p_terminos: cq.grupos,
        p_opcionales: cq.opcionales,
        p_moto: moto,
        p_cilindrada: cilindrada,
        p_limite: limite,
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
      return base("error", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION], errorDetail: errorText(error) });
    }

    let filas: FilaBusqueda[] = data ?? [];

    // T3a (28/9/2026): sin N-1. Con 1 o con 10 grupos hace falta que calcen
    // TODOS — la marca ya no se descarta para "salvar" la búsqueda. Lo que
    // antes tumbaba un producto legítimo (una palabra descriptiva que el
    // nombre no trae) ahora es un opcional que solo desempata.
    const requerido = cq.grupos.length;

    if (filas.length === 0 || filas[0].puntaje_maximo < requerido) {
      return base("sin_resultados", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION] });
    }

    const puntajeMaximo = filas[0].puntaje_maximo;
    const puntajeMotoMaximo = filas[0].puntaje_moto_maximo;

    // Corrección del operador sobre la moto (plan, 25-26/9/2026): la moto
    // solo "calza" si el cliente la dio Y al menos una de las filas del
    // máximo puntaje la nombra. Si calza, se cotiza SOLO esa moto (nunca
    // genérico: el cliente ya filtró lo que pudo). Si no calza la moto se
    // ignora y rige la regla sin moto.
    //
    // T3a (28/9/2026): `puntaje_moto_maximo` sale SOLO de la moto con nombre
    // (`puntaje_moto_nombre`, ver 20260928010000): la cilindrada ("250")
    // ordena pero NUNCA vuelve verdadero `motoCalza` — antes "defensa gxs
    // 250" trataba como coincidencia de moto a una DEFENSA BRZ 250 solo por
    // compartir el 250.
    const motoDada = moto.length > 0;
    const motoCalza = motoDada && puntajeMotoMaximo > 0;
    const motoIgnorada = motoDada && !motoCalza;

    const delMaximo = (lista: FilaBusqueda[]) =>
      lista.filter(
        (r) => r.puntaje === puntajeMaximo && (!motoCalza || r.puntaje_moto_nombre === puntajeMotoMaximo)
      );
    let candidatos = delMaximo(filas);

    // Los conteos vienen de la base, calculados ANTES del límite:
    // `coinciden` nunca se mide contando el arreglo que llegó acá, que ya
    // puede venir recortado a MAX_CATALOG_RESULTS.
    const coinciden = motoCalza ? filas[0].filas_con_maximo_y_moto : filas[0].filas_con_puntaje_maximo;
    // Con la moto calzando, `filas_con_maximo_y_stock` ya cuenta solo las de
    // esa moto; sin moto que calce cuenta todas las del máximo.
    const conStock = filas[0].filas_con_maximo_y_stock;
    const hayMas = coinciden > MAX_CATALOG_RESULTS;
    const preguntaFiltro: "moto" | "producto" = p.dependeDeLaMoto && !motoDada ? "moto" : "producto";

    let estado: ResultadoConsulta;
    let mostrados: FilaBusqueda[];
    // Solo el camino "se cotiza todo lo del máximo" puede haber recortado la
    // lista; los otros muestran una selección a propósito y no dicen "hay más".
    let avisarRecorte = false;

    if (motoCalza || coinciden <= MAX_SIN_PREGUNTA) {
      mostrados = candidatos;
      estado = mostrados.some((r) => r.stock_quantity > 0) ? "con_existencia" : "agotados";
      avisarRecorte = estado === "con_existencia" && hayMas;
    } else if (conStock === 0) {
      // T3a: más de tres filas calzan pero NINGUNA tiene stock: sin_stock,
      // nunca genérico (siete botas en cero se preguntaban como si hubiera
      // de dónde elegir).
      mostrados = candidatos;
      estado = "agotados";
    } else {
      // Más de tres filas calzan, la moto no las distingue y alguna tiene
      // stock. Lo que se cotiza son las que tienen existencia; si las que
      // tienen stock quedaron más allá de `p_limite` (el orden las deja
      // detrás de las agotadas con mejor coincidencia de nombre), se vuelve
      // a pedir con más filas para encontrarlas.
      const necesarias = Math.min(conStock, MAX_OPCIONES_SIN_PREGUNTA);
      if (candidatos.filter((r) => r.stock_quantity > 0).length < necesarias) {
        const { data: masFilas, error: errorReintento } = await consultar(LIMITE_REINTENTO);
        if (errorReintento) {
          log.error("herramienta_catalogo_fallo", { conversationId, detail: errorText(errorReintento) });
        } else {
          filas = masFilas ?? filas;
          candidatos = delMaximo(filas);
        }
      }
      const enStock = candidatos.filter((r) => r.stock_quantity > 0);

      if (conStock <= MAX_SIN_PREGUNTA) {
        mostrados = enStock;
        estado = "con_existencia";
      } else {
        const yaPreguntado = !preguntadosEnEsteTurno.has(clave) && yaSePregunto(clave, p.preguntaHechaPara);
        if (p.permitirPregunta && !yaPreguntado && !p.verTodo) {
          return base("generico", {
            hayMas,
            preguntaFiltro,
            instrucciones: [instruccionGenerica(preguntaFiltro, motoIgnorada)],
          });
        }
        // Ya se preguntó (o el cliente dijo que no sabe / que le muestren
        // todo, o es una lista): no se vuelve a preguntar, se entregan las
        // tres opciones con existencia más relevantes.
        mostrados = enStock.slice(0, MAX_OPCIONES_SIN_PREGUNTA);
        estado = "con_existencia";
      }
    }

    if (estado === "agotados") mostrados = mostrados.slice(0, MAX_AGOTADOS_LISTADOS);

    if (mostrados.length === 0) {
      // Defensivo: la base dijo que había filas del máximo y no llegó
      // ninguna que mostrar (error del reintento). Mejor pasar el caso que
      // cotizar con datos a medias.
      return base("sin_resultados", { instrucciones: [NO_IDENTIFICADO_INSTRUCTION] });
    }

    const { rate } = await leerTasa();
    const quoted: Cotizado[] = mostrados.map((r) => ({
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
    }));

    return base(estado, {
      quoted,
      hayMas,
      masViejo: masViejo(mostrados.map((r) => r.updated_at)),
      instrucciones: [
        estado === "con_existencia" ? CONFIRMAR_INVENTARIO_INSTRUCTION : SIN_STOCK_CASO_INSTRUCTION,
        ...(avisarRecorte ? [RECORTE_INSTRUCTION] : []),
      ],
    });
  }

  /** Deja en el `CatalogOutcome` lo que decidió una búsqueda (acumulativo entre llamadas del turno). */
  function registrar(r: ResultadoUno, productoPedido: string | null): void {
    catalogOutcome.consultas.push(r.consulta);

    switch (r.estado) {
      case "generico":
        catalogOutcome.generico = true;
        catalogOutcome.preguntaFiltro = r.preguntaFiltro;
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

    for (const q of r.quoted) {
      if (catalogOutcome.cotizacion.some((linea) => linea.productId === q.id)) continue;
      catalogOutcome.cotizacion.push({
        productId: q.id,
        nombre: q.nombre,
        precioUsd: q.precioUsd,
        precioBs: q.precioBs,
        stock: q.stock,
        productoPedido,
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
      const motoDelModelo = motoDeTexto(`${motoBrand ?? ""} ${motoModel ?? ""}`);
      const lista = (productos ?? []).map((producto) => producto.trim()).filter(Boolean);

      // ---- Lista de productos (D5, hasta cinco) ----------------------------
      if (lista.length > 0) {
        const motoEntrada = unirGrupos(motoDelModelo.moto, catalogQuery(query).moto);
        const resultados: ResultadoUno[] = [];
        for (const producto of lista) {
          const r = await buscarUno({
            texto: producto,
            productoPedido: producto,
            productos: lista,
            motoEntrada,
            cilindradaEntrada: motoDelModelo.cilindrada,
            motoMemoria: [],
            cilindradaMemoria: [],
            dependeDeLaMoto: dependeDeLaMoto === true,
            permitirPregunta: false,
            preguntaHechaPara: null,
            verTodo: false,
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

        const hayExistencia = resultados.some((r) => r.estado === "con_existencia");
        const hayAgotados = resultados.some((r) => r.estado === "agotados");
        const casoLista = hayExistencia
          ? `${CONFIRMAR_INVENTARIO_INSTRUCTION} La lista trae varios productos: nómbralos en el orden en que llegan; los que salen agotados o sin resultados, dilo tal cual, uno por uno.`
          : hayAgotados
            ? SIN_STOCK_CASO_INSTRUCTION
            : NO_IDENTIFICADO_INSTRUCTION;
        const resumen = `Resumen por producto, en el orden pedido: ${resultados
          .map((r, i) => `${lista[i]} (${DESCRIPCION_DE_ESTADO[r.estado]})`)
          .join(", ")}.`;

        await guardarPedido(conversationId, {
          ultimoQuery: pedido?.ultimoQuery ?? null,
          moto: motoEntrada.length > 0 ? motoEntrada : (pedido?.moto ?? []),
          cilindrada: motoDelModelo.cilindrada.length > 0 ? motoDelModelo.cilindrada : (pedido?.cilindrada ?? []),
          preguntaHechaPara: pedido?.preguntaHechaPara ?? null,
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
          instruccionParaTuRespuesta: [casoLista, resumen, inventoryAgeInstruction(freshness)]
            .filter((linea): linea is string => linea !== null)
            .join(" "),
        };
      }

      // ---- Consulta simple ---------------------------------------------------
      // Respuesta suelta: si lo que llegó no trae NINGÚN término de producto
      // (solo talla, color, año, medida, viscosidad, moto, cilindrada o un
      // número), es la respuesta a la pregunta anterior — se combina con el
      // último pedido en vez de buscarse sola ("24" tras "asiento" + sbr).
      const esSuelta = !catalogQuery(query).grupos.some(esGrupoDeProducto);
      const texto = esSuelta && pedido?.ultimoQuery ? `${pedido.ultimoQuery} ${query}`.trim() : query;

      const r = await buscarUno({
        texto,
        productoPedido: null,
        productos: null,
        motoEntrada: motoDelModelo.moto,
        cilindradaEntrada: motoDelModelo.cilindrada,
        motoMemoria: esSuelta ? (pedido?.moto ?? []) : [],
        cilindradaMemoria: esSuelta ? (pedido?.cilindrada ?? []) : [],
        dependeDeLaMoto: dependeDeLaMoto === true,
        permitirPregunta: true,
        preguntaHechaPara: pedido?.preguntaHechaPara ?? null,
        verTodo,
      });
      registrar(r, null);

      // La memoria: el pedido acumulado (solo si tiene producto de verdad),
      // la moto y cilindrada que rigieron (o las de antes, si esta consulta
      // no dio ninguna) y, si se acaba de preguntar, por qué producto.
      const tieneProducto = r.consulta.grupos.some(esGrupoDeProducto);
      if (r.estado === "generico") preguntadosEnEsteTurno.add(r.clave);
      await guardarPedido(conversationId, {
        ultimoQuery: tieneProducto ? texto : (pedido?.ultimoQuery ?? null),
        moto: r.moto.length > 0 ? r.moto : (pedido?.moto ?? []),
        cilindrada: r.cilindrada.length > 0 ? r.cilindrada : (pedido?.cilindrada ?? []),
        preguntaHechaPara: r.estado === "generico" ? r.clave : (pedido?.preguntaHechaPara ?? null),
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
