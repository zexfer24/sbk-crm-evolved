// ---------------------------------------------------------------------------
// Escenarios con un precio escrito a mano.
//
// El texto de un escenario se le manda al cliente TAL CUAL: no pasa por el
// modelo ni por el catálogo. Eso es lo que lo hace confiable —el dueño escribe
// exactamente lo que sale— y también lo que hace que un precio metido ahí
// adentro no envejezca nunca. La IA cotizó "76$ a bcv" desde uno de estos.
//
// Existen porque la herramienta de catálogo está apagada y no había otra forma
// de dar un precio. No se corrige acá ni se bloquea nada: se marca en el panel
// para que el dueño lo revise cuando quiera, y no se entere por un cliente.
// ---------------------------------------------------------------------------

/**
 * Monedas como las escribe el equipo. Las que empiezan por letra llevan
 * frontera de palabra para que "SBS 100" no se lea como bolívares.
 */
const MONEDA = String.raw`(?:\bus\$|\$|\busd\b|\bbs\.?|\bbss\b|\bbol[ií]var(?:es)?\b|\bd[oó]lar(?:es)?\b)`;

/** 76, 2.500, 970,00. */
const MONTO = String.raw`\d+(?:[.,]\d+)*`;

/**
 * Un número pegado a una moneda, en cualquiera de los dos órdenes: "76$" y
 * "$76" se escriben las dos. Un número suelto NO cuenta — "6 cuotas" y
 * "45 LTS" no son precios, y un aviso que salta donde no hay nada deja de
 * mirarse.
 */
const PRECIO = new RegExp(`(?:${MONTO}\\s*${MONEDA}|${MONEDA}\\s*${MONTO})`, "i");

export function hasHardcodedPrice(text: string): boolean {
  return PRECIO.test(text);
}
