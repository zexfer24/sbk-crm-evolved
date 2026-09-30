import { normalize } from "@/lib/ai/catalog-search";

// ---------------------------------------------------------------------------
// Tarea 2, plan "El catálogo configurado sale siempre" (21/9/2026).
//
// Reporte de solo lectura de producción (VPS, 21/9/2026): "CATALOGO CASCOS" y
// "Catálogo general" son, juntos, el 30 % de las respuestas de escenario en
// 15 días. El plan cede un escenario calzado al inventario cuando la
// intención es `consulta_disponibilidad`, pero eso NO puede aplicarse cuando
// el cliente pidió el catálogo COMO DOCUMENTO ("me envías el PDF", "tienen
// lista de precios"): el inventario responde con texto sobre productos
// puntuales, no con el archivo que el cliente quiere. `pideCatalogo` es la
// condición 3 de esa regla (ver el plan, `docs/planes/2026-09-21-…`): si
// devuelve `true`, el escenario NO se cede, sale tal cual (con su enlace).
//
// Pura, sin `server-only` ni SDK — mismo estilo que `saludo.ts`: una función
// sobre la FORMA del texto que escribió el cliente, sin tocar Supabase ni el
// modelo. Recibe la RÁFAGA (`customerBurst` de `history-line.ts`, que este
// módulo NO importa a propósito — solo respeta su forma: un arreglo de
// líneas de texto del cliente, la más vieja primero) porque un cliente puede
// nombrar el catálogo en una línea y saludar o preguntar otra cosa en la
// siguiente ("Me pasas el catálogo" + "Buenas tardes"): CUALQUIER línea que
// lo pida alcanza — por eso `.some`, no `.every`.
//
// Reusa el normalizador de `catalog-search.ts` (minúsculas + sin acentos, ya
// probado contra "bujía"/"bujia") en vez de escribir uno nuevo: es la misma
// operación que necesita "catálogo" === "catalogo" === "CATÁLOGO".
//
// Qué cuenta como pedir el catálogo, con los errores de tipeo reales del
// reporte del VPS (no se inventan más: "catlogo" no aparece en ningún
// mensaje real, así que no entra):
//   - "catalogo"/"catalogos", y el typo "catalago"/"catalagos".
//   - "pdf".
//   - "lista de precios"/"listas de precios"/"lista de precio".
// Con límites de palabra (`\b`) en los dos extremos: "pdf" no calza dentro de
// otra palabra, y una futura "catalogación" (que hoy no existe en el
// catálogo del negocio) tampoco calzaría por accidente.
//
// Qué NO cuenta, a propósito: "precios de los cascos" sin la palabra
// catálogo (esa decisión es del escenario marcado, no de esta función),
// preguntas de disponibilidad sueltas ("¿tienen pastillas de freno?"), y un
// marcador de media entre corchetes ("[El cliente envió una foto…]") — no
// hace falta descartarlo aparte: ninguno de esos textos contiene ninguna de
// las palabras de arriba.
//
// Decisión documentada del plan: una frase NEGATIVA sobre el catálogo ("No
// están en el catálogo", "el catálogo no me abre") TAMBIÉN devuelve `true`.
// No es un descuido — esta función no decide qué escenario sale, solo si un
// escenario YA CALZADO por la fase 0 se puede ceder al inventario. Para una
// queja sobre el catálogo, fase 0 calza "Error de comentario" (que escala a
// un asesor); ceder ESE escenario al inventario respondería con productos
// sueltos a alguien que está reportando que el enlace no le sirve, que es
// peor que dejarlo escalar como siempre.
// ---------------------------------------------------------------------------

const PATRON_CATALOGO = /\b(catal[oa]gos?|pdf|listas?\s+de\s+precios?)\b/;

/**
 * `true` si ALGUNA línea de la ráfaga del cliente pide el catálogo como
 * documento (ver el comentario de cabecera para la lista exacta y las
 * exclusiones).
 */
export function pideCatalogo(lineas: readonly string[]): boolean {
  return lineas.some((linea) => PATRON_CATALOGO.test(normalize(linea)));
}

// ---------------------------------------------------------------------------
// Tarea 3, plan "El catálogo configurado sale siempre" (21/9/2026).
//
// "El repuesto manda" (H1, "Seba atiende el mostrador", 18/9/2026) cedía un
// escenario calzado al inventario con UNA sola condición: que la intención
// clasificada fuera `consulta_disponibilidad`. El reporte de solo lectura de
// producción del 21/9/2026 (VPS, base en `20260915010000`, sin H1 desplegado
// todavía) midió "CATALOGO CASCOS" (535 usos) y "Catálogo general" (161) como
// el 30 % de todas las respuestas de escenario en 15 días — y
// `buscar_repuesto` está APAGADO en producción desde el 25/8/2026. Desplegar
// H1 tal cual habría cedido esos pedidos a un inventario que no responde
// nada, dejando sin PDF a casi todos los clientes que preguntan por el
// catálogo o por precios de un producto ya cubierto por un escenario.
//
// `debeCederAlInventario` reemplaza esa única condición por las CUATRO que
// aprobó el plan, evaluadas en el orden en que el operador pidió poder
// medirlas (para que el log de abajo, en `agent.ts`, diga SIEMPRE la primera
// que aplica, nunca varias a la vez):
//   1. la clasificación salió bien y la intención es `consulta_disponibilidad`
//      (la condición original de H1; si falla, no hay motivo que loguear —
//      esto ni siquiera es un caso de "el repuesto manda").
//   2. la herramienta del catálogo (`buscar_repuesto`) está encendida.
//   3. el cliente NO pidió el catálogo como documento (`pideCatalogo`, T2).
//   4. el escenario calzado tiene `cedeAlInventario = true` (T1, columna
//      `ai_playbooks.cede_al_inventario`, default `false` — hoy solo
//      "Catálogo general" se marca).
// ---------------------------------------------------------------------------

/** Por qué un escenario que SÍ calzó `consulta_disponibilidad` NO se cedió al inventario. */
export type MotivoNoCedido = "catalogo_apagado" | "cliente_pidio_catalogo" | "escenario_no_marcado";

export interface DecisionCesionInventario {
  cede: boolean;
  /** `null` cuando `cede` es `true`, o cuando ni siquiera aplica (intención distinta, clasificación fallida). */
  motivo: MotivoNoCedido | null;
}

/**
 * Decide si un escenario calzado se cede al tool loop (inventario real) en
 * vez de mandarse tal cual. Pura: no consulta la base ni al modelo, recibe
 * todo ya resuelto por el llamador (`agent.ts`).
 */
export function debeCederAlInventario(params: {
  /** `classified.ok` — si la clasificación de intención falló, no hay decisión que tomar. */
  intencionOk: boolean;
  /** `classified.result.intent` cuando `intencionOk` es `true`; cualquier valor si no. */
  intent: string;
  /** `enabledTools.has(TOOL_KEYS.catalog)`. */
  catalogoEncendido: boolean;
  /** La ráfaga del cliente (`customerBurst`), la misma que usan `soloSaludo` y la guarda de cortesía. */
  rafaga: readonly string[];
  /** `match.playbook.cedeAlInventario`. */
  cedeAlInventario: boolean;
}): DecisionCesionInventario {
  if (!(params.intencionOk && params.intent === "consulta_disponibilidad")) {
    return { cede: false, motivo: null };
  }
  if (!params.catalogoEncendido) return { cede: false, motivo: "catalogo_apagado" };
  if (pideCatalogo(params.rafaga)) return { cede: false, motivo: "cliente_pidio_catalogo" };
  if (!params.cedeAlInventario) return { cede: false, motivo: "escenario_no_marcado" };
  return { cede: true, motivo: null };
}

// ---------------------------------------------------------------------------
// T3a, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): "una sola pregunta por pedido".
//
// El estudio del VPS (25-28/9) encontró la pregunta de filtro repetida hasta
// tres veces al mismo cliente, y clientes que contestaban "no sé" o "los que
// tengas" a una pregunta que Seba les volvía a hacer. `pideVerTodo` reconoce
// esas respuestas —el cliente dice que no sabe precisar, o que le muestren
// todo— para que la herramienta del catálogo NO pregunte y entregue las tres
// opciones con existencia más relevantes.
//
// Pura, como `pideCatalogo`: mira la FORMA del texto del cliente, no llama a
// nada. Recibe la ráfaga (la línea más vieja primero) y con que UNA línea lo
// diga alcanza.
//
// Frases reconocidas, ya sin acentos ni mayúsculas ("no sé" == "no se"):
//   - "no sé" / "no sé cuál" / "no sé la marca" / "ni idea": SOLO cuando la
//     línea entera es eso (con un "pues"/"eh" delante). "no se prende" o "no
//     se abre" NO cuentan: hablan de la moto, no de la pregunta.
//   - "cualquiera", "cualquier marca".
//   - "muéstrame/muéstrame todos", "quiero ver todos", "todos los que
//     tienes", "los que tengas/tienes/tengan".
//   - "me da igual", "me da lo mismo", "lo que sea".
//   - (A2 T6, 30/9/2026, plan "Seba no cotiza lo que no es") las respuestas
//     reales del estudio del VPS que Seba seguía sin reconocer: "no tengo
//     idea", "la/el que sea", "el/la que tengas", "los/las que tengan", "no
//     tengo marca", "no tengo preferencia", "recomiéndame (uno)", "cuál/qué
//     me recomiendas", y elegir por precio ("el más económico", "la más
//     barata", "el más barato", también dentro de una pregunta como "¿cuál
//     es la más barata para sbr?": es otra forma de pedir que Seba escoja).
//     Lo barato dicho para RECHAZARLO ("la más barata no me sirve", "no me
//     gusta el más económico") NO cuenta: una negación simple en la misma
//     línea (`PATRON_RECHAZO`) lo saca. Es deliberadamente tosco —no entiende
//     lenguaje libre— y, si falla, el costo es el de siempre: Seba muestra
//     tres opciones en vez de preguntar una vez más.
// Un falso positivo aquí es barato (Seba muestra tres opciones con existencia
// en vez de preguntar), un falso negativo también (pregunta una vez más); por
// eso la lista es corta y no intenta entender lenguaje libre.
// ---------------------------------------------------------------------------

/** "no sé" como respuesta completa (la línea entera), no como parte de otra frase. */
const PATRON_NO_SE = /^(?:(?:pues|eh+|mm+|ah+|bueno|la verdad|sinceramente)\s+)*(?:no se|ni idea|no tengo idea)(?:\s+(?:cual|cuales|que|la marca|el modelo|de cual|de que marca|de la marca|nada))?$/;

const PATRONES_VER_TODO: RegExp[] = [
  /\bcualquier(?:a|as)?\b/,
  /\b(?:muestrame|mostrame|ensename|pasame|mandame|dime)\s+(?:todos?|todas?)\b/,
  /\bver\s+(?:todos?|todas?)\b/,
  /\btodos?\s+los\s+que\b/,
  /\btodas?\s+las\s+que\b/,
  /\b(?:los|las)\s+que\s+(?:tengas|tienes|tienen|tengan|hay|haya)\b/,
  /\b(?:me\s+)?da(?:\s+lo)?\s+(?:igual|mismo)\b/,
  /\b(?:lo|la|el|los|las)\s+que\s+sea\b/,
  // A2 T6: singular de "los que tengas".
  /\b(?:el|la)\s+que\s+(?:tengas|tienes|tienen|tengan|hay|haya)\b/,
  /\bno\s+tengo\s+(?:marca|preferencia|modelo)\b/,
  /\brecomiendame\b/,
  /\bme\s+recomiend(?:as|a)\b/,
  /\b(?:cual|cuales|que)\s+recomiendas\b/,
];

/** Elegir por precio ("el más económico", "la más barata"): Seba escoge. */
const PATRON_PRECIO = /\b(?:el|la|los|las|lo)\s+mas\s+(?:economic[oa]s?|barat[oa]s?)\b/;

/** Negación simple que vuelve a lo barato un rechazo, no un pedido. */
const PATRON_RECHAZO =
  /\bno\s+(?:me\s+)?(?:sirve|sirven|gusta|gustan|quiero|interesa|interesan|funciona|alcanza)\b/;

/** La línea del cliente sin acentos ni puntuación, para comparar contra los patrones. */
function textoPlano(linea: string): string {
  return normalize(linea)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// A2 T5, decisión D6 del operador (29/9/2026, noche): «ver opciones» es un
// pedido EXPLÍCITO, y es la ÚNICA excepción a "Seba cotiza una sola opción".
// «Muéstrame todas», «qué opciones hay», «cuáles tienes», «qué tienes» y sus
// equivalentes sacan hasta tres opciones con existencia; «no sé», «ni idea»,
// «la que sea», «recomiéndame», «el más económico»… NO lo son: le piden a Seba
// que escoja, y da UNA (`pideVerTodo` las reconoce para no volver a preguntar,
// pero no abren la excepción). Por eso los patrones de aquí son un subconjunto
// aparte: solo los que dicen "quiero ver varias".
//
// Falsos positivos y negativos cuestan poco (tres opciones con existencia en
// vez de una, o una en vez de tres); por eso la lista es corta y explícita, sin
// intentar entender lenguaje libre. «No tengo opciones de pago» no cuenta:
// «opciones» solo cuenta detrás de un verbo de mostrar, «qué/cuáles/otras» o
// delante de «hay/tienes/tienen».
// ---------------------------------------------------------------------------
const VERBO_MOSTRAR = String.raw`(?:muestrame|mostrame|ensename|pasame|mandame|dime|dame|quiero\s+ver|ver)`;

const PATRONES_VER_OPCIONES: RegExp[] = [
  new RegExp(String.raw`\b${VERBO_MOSTRAR}\s+(?:todos?|todas?)\b`),
  new RegExp(String.raw`\b${VERBO_MOSTRAR}\s+(?:(?:las|algunas|mas|otras)\s+)*opciones\b`),
  /\btodos?\s+los\s+que\b/,
  /\btodas?\s+las\s+que\b/,
  /\b(?:que|cuales|cuantas)\s+(?:otras\s+)?opciones\b/,
  /\bopciones\s+(?:hay|tienes|tienen|manejas|manejan|tenemos|disponibles)\b/,
  /\botras\s+opciones\b/,
  /\bcuales\s+(?:tienes|tienen|hay|manejas|manejan|tenemos|son)\b/,
  /\bque\s+(?:mas\s+)?(?:tienes|tienen|manejas|manejan)\b/,
  /\bque\s+(?:modelos|marcas|tipos|colores|tallas|medidas)\s+(?:hay|tienes|tienen|manejas|manejan)\b/,
];

/**
 * `true` si ALGUNA línea de la ráfaga pide de forma explícita ver varias
 * opciones (D6): es la única razón por la que Seba cotiza hasta tres. Las
 * frases de «no sé precisar» NO cuentan (ver `pideVerTodo`).
 */
export function pideVerOpciones(lineas: readonly string[]): boolean {
  return lineas.some((linea) => {
    const texto = textoPlano(linea);
    return texto !== "" && PATRONES_VER_OPCIONES.some((patron) => patron.test(texto));
  });
}

/**
 * `true` si ALGUNA línea de la ráfaga del cliente dice que no sabe precisar o
 * que le muestren todo (ver el comentario de cabecera para la lista exacta).
 * Incluye todo lo que `pideVerOpciones` reconoce: quien pide ver opciones
 * tampoco quiere que se le vuelva a preguntar.
 */
export function pideVerTodo(lineas: readonly string[]): boolean {
  if (pideVerOpciones(lineas)) return true;
  return lineas.some((linea) => {
    const texto = textoPlano(linea);
    if (!texto) return false;
    if (PATRON_NO_SE.test(texto) || PATRONES_VER_TODO.some((patron) => patron.test(texto))) return true;
    return PATRON_PRECIO.test(texto) && !PATRON_RECHAZO.test(texto);
  });
}
