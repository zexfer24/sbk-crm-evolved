import { AI_NAME, BUSINESS_NAME } from "@/lib/brand";
import { greetingFor, type DayBand } from "@/lib/business-hours";

// ---------------------------------------------------------------------------
// 18/9/2026, plan "Seba atiende el mostrador" (requisitos 1, 2, 3 y 4 del
// cliente, aprobado el mismo día). El dueño pidió que la IA tuviera nombre
// propio — "Seba" — y que el primer mensaje de cada conversación (nueva o
// reabierta tras cierre) fuera ESTRICTAMENTE el texto que dictó, sin que el
// modelo lo redactara ni lo parafraseara: "Hola, buen [día/tarde/noche], mi
// nombre es Seba. Soy tu asistente el día de hoy en SBK MOTORS, ¿cómo puedo
// ayudarte?". Por eso el saludo vive acá como una función pura que el TURNO
// llama directo (`agent.ts`, tarea T2b) — nunca el modelo — y por eso el
// texto no pasa por `identity-guard.ts` en caliente: hay que probarlo una
// vez, a mano, con `revealsIdentity` (ver `seba.test.ts`), para confirmar
// que la excepción que se abrió en la guarda ("mi nombre es (?!seba\b)")
// deja pasar justo esta frase y ninguna otra.
//
// Los tres textos fijos de los requisitos 2/3/4 (confirmar inventario, stock
// en cero, información que Seba no maneja) y la pregunta de filtro del
// requisito 5 viven en el mismo módulo por la misma razón que el saludo:
// son literales que el cliente dictó (o que el operador fijó para que no
// dependan del modelo), y tanto `prompt.ts` como `tools.ts` los interpolan
// desde acá para no duplicarlos.
//
// Módulo PURO a propósito, mismo patrón que `identity-guard.ts` y
// `saludo.ts`: sin `import "server-only"`. Hasta T6 (23/9/2026, plan "Seba
// no habla de más mientras el cliente espera al asesor") el único import de
// valor era `brand.ts` (también puro) y `DayBand` se traía solo como TIPO
// —se borra en la compilación— para no arrastrar en runtime nada de
// `business-hours.ts` hacia el lado que toque este módulo primero. T6 suma
// `greetingFor` COMO VALOR a propósito: `sebaGreetingFollowUp` (más abajo)
// lo necesita, y `business-hours.ts` es puro por diseño —su propio
// encabezado dice "lo llama tanto el turno de IA (server) como el panel de
// control (cliente)"— así que arrastrarlo acá no rompe nada que este módulo
// no pudiera costar ya por otra vía.
// ---------------------------------------------------------------------------

/**
 * El saludo de apertura según la franja del día, calculado por
 * `dayBand` (`business-hours.ts`) con la hora de Barinas. Distinto de
 * `greetingFor` (que dice "buenos días"): el cliente dictó el saludo de
 * Seba palabra por palabra, "buen día" y no "buenos días", así que esta
 * función no reutiliza `greetingFor` — son dos textos que se parecen pero
 * no son el mismo, y unificarlos rompería el literal exigido.
 */
export function presentationGreetingFor(band: DayBand): string {
  switch (band) {
    case "mañana":
      return "buen día";
    case "tarde":
      return "buenas tardes";
    case "noche":
      return "buenas noches";
  }
}

/**
 * El primer mensaje de Seba, literal, byte a byte con lo que dictó el
 * cliente (18/9/2026). Lo manda el TURNO como mensaje propio, antes de
 * cualquier redacción del modelo (`agent.ts`, tarea T2b) — nunca el modelo,
 * para garantizar el "estrictamente" del requisito 1.
 */
export function sebaGreeting(band: DayBand): string {
  return `Hola, ${presentationGreetingFor(band)}, mi nombre es ${AI_NAME}. Soy tu asistente el día de hoy en ${BUSINESS_NAME.toUpperCase()}, ¿cómo puedo ayudarte?`;
}

/** Las tres franjas, en el mismo orden que `DayBand` las declara (business-hours.ts). */
const ALL_DAY_BANDS: readonly DayBand[] = ["mañana", "tarde", "noche"];

/**
 * ¿Es `text` EXACTAMENTE la presentación de Seba, en cualquier franja?
 *
 * T12, plan "Seba sale sin pisar a nadie" (19/9/2026, decisión abierta #1
 * del plan original): el turno la usa para reconocer, en un REINTENTO tras
 * `ProviderFailedAfterGreetingError` (agent.ts), que la última línea del
 * historial ya es la presentación que salió en el intento anterior — no
 * algo que el modelo tenga que volver a redactar ni contestar. Construida a
 * partir de `sebaGreeting` (no se repiten los tres literales a mano): si el
 * texto del saludo cambia algún día, este reconocimiento cambia solo con él.
 */
export function isSebaGreeting(text: string): boolean {
  return ALL_DAY_BANDS.some((band) => sebaGreeting(band) === text);
}

/**
 * T6, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026, decisión del operador "esperar la pregunta"): el saludo
 * FIJO que Seba manda cuando un cliente que YA la conocía (`welcome_sent_at`
 * sellado ANTES de este turno) vuelve a saludar solo, y ya se esperó una vez
 * por si la pregunta real venía detrás (caso RK200, 22/9/2026: "Buenas
 * tardes" solo, la pregunta llegó 10 s después y el modelo escaló sobre un
 * historial viejo). Nunca lo redacta el modelo -- mismo criterio que
 * `sebaGreeting` -- pero es un texto DISTINTO: reusar `sebaGreeting` habría
 * hecho que Seba "se presentara" una segunda vez ("mi nombre es Seba...") en
 * la misma conversación. Usa `greetingFor` (business-hours.ts), NO
 * `presentationGreetingFor` de acá arriba -- esa es la frase de la
 * PRESENTACIÓN ("buen día"), literal por dictado del cliente; esta es un
 * saludo de VUELTA que el operador decidió sobre la marcha, y las dos se
 * parecen pero no son el mismo texto.
 */
export function sebaGreetingFollowUp(band: DayBand): string {
  const saludo = greetingFor(band);
  return `¡${saludo.charAt(0).toUpperCase()}${saludo.slice(1)}! ¿En qué te puedo ayudar?`;
}

/**
 * Requisito 3: repuesto encontrado en catálogo (con existencia). El cliente
 * dictó este texto literal — un asesor confirma el inventario físico antes
 * de darlo por seguro. `tools.ts` lo interpola en la instrucción que recibe
 * el modelo y `prompt.ts` en la sección 5.1 del guion.
 */
export const TEXTO_CONFIRMAR_INVENTARIO =
  "En inventario parece que quedan unidades disponibles en este precio. Sin embargo, para confirmar, te pasaré con un asesor para que verifique el inventario físico y te dé respuesta lo antes posible.";

/**
 * Requisito 4: el catálogo marca cero unidades. Texto literal del cliente.
 * "sistema" va suelto a propósito: no está anclado en `identity-guard.ts`
 * (ver la trampa de CLAUDE.md sobre `automátic*`/`digital`/`sistema`
 * sueltos), así que pasa la guarda sin reescritura.
 */
export const TEXTO_SIN_STOCK =
  "Actualmente el sistema marca que no nos quedan unidades, pero te paso con un asesor para que confirme si nos llega pronto o si hay alguna alternativa compatible.";

/**
 * Requisito 2: la base no trae nada claro, o no queda claro cuál repuesto
 * es. El cliente no dictó texto para este caso — pidió "decirle que no
 * maneja esa información y pasarlo inmediatamente" — así que este texto es
 * decisión del operador (18/9/2026), no una cita literal.
 */
export const TEXTO_NO_IDENTIFICADO =
  "Esa información no la manejo por acá, pero te paso de una vez con un asesor que te la confirma lo antes posible.";

/**
 * Requisito 5 (única pregunta): la ÚNICA pregunta de filtro que la IA puede
 * hacer antes de buscar, cuando la consulta es genérica y no trae marca ni
 * modelo de moto. `prompt.ts` (sección 3) y `tools.ts` (instrucción del
 * catálogo cuando el resultado es genérico) la interpolan desde acá.
 */
export const PREGUNTA_FILTRO = "Claro, ¿para qué modelo y año de moto las buscas?";
