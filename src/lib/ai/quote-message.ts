import { describirCorreccion, type CorreccionTermino } from "@/lib/ai/catalog-correction";
import { formatQuote } from "@/lib/ai/precio";
import { moneyFigures } from "@/lib/ai/price-guard";
import { PREGUNTA_FILTRO, PREGUNTA_FILTRO_PRODUCTO, TEXTO_CONFIRMAR_INVENTARIO, TEXTO_SIN_STOCK } from "@/lib/ai/seba";
import type { LineaCotizada, MasOpciones } from "@/lib/ai/tools";

// ---------------------------------------------------------------------------
// La cotización la arma el CÓDIGO, no el modelo (T3b, plan "Seba encuentra, no
// insiste, y el mostrador no deja a nadie esperando", 28/9/2026).
//
// El estudio del VPS (1.027 turnos, 25/9 → 28/9/2026) encontró dos fallas
// que el prompt no logró cerrar:
//   - "Inca 20W50 semi sintético": el modelo cambió el nombre del producto
//     ("ACEITE INCA 20W50 4T") por uno más "natural", y el cliente pidió algo
//     que la tienda no vende con ese nombre.
//   - El caso de la cinta: la búsqueda encontró el repuesto CON existencia,
//     el modelo llamó a `escalarAAsesor` en el mismo turno y su redacción
//     final fue solo una despedida — el cliente se quedó sin ver qué había
//     ni a qué precio, y el asesor recibió un caso sin cotización.
//
// Por eso, si el turno terminó con `catalogOutcome.cotizacion` no vacía, el
// mensaje que sale es: (1) a lo sumo UNA línea previa del modelo, sin cifras;
// (2) este bloque, con el nombre EXACTO del catálogo y el precio ya calculado
// por `usdFromBs`/`formatQuote` (nada se recalcula acá); (3) el texto fijo que
// dictó el cliente, LITERAL. El texto armado igual pasa por `price-guard`
// (las cifras salen del `toolResult` del mismo turno, así que tienen fuente) y
// por la guarda de identidad, como cualquier otra salida.
//
// Módulo PURO: sin `server-only` y sin acceso a la base. El único import de
// `tools.ts` es de TIPO (se borra al compilar).
// ---------------------------------------------------------------------------

/** Tope de la línea previa del modelo (una línea de WhatsApp, no un párrafo). */
export const MAX_PREAMBULO_CARACTERES = 240;

/** Tope del encabezado con el producto que el cliente pidió en una lista. */
const MAX_ENCABEZADO_CARACTERES = 60;

export interface OpcionesCotizacion {
  /** Productos de una lista que la búsqueda no encontró: se dicen tal cual, uno por uno. */
  noEncontrados?: readonly string[];
  /** Lo que el corrector de tipeos cambió: el bloque abre nombrándolo. */
  correcciones?: readonly CorreccionTermino[];
  /**
   * 29/9/2026: con la moto calzando y más de tres con existencia, cuántas
   * otras quedaron sin mostrar (`CatalogOutcome.masOpciones`). Cierra el grupo
   * del producto con `lineaMasOpciones`, después de sus renglones.
   */
  masOpciones?: readonly MasOpciones[];
}

/**
 * La línea que cierra un grupo cuando se cotizaron tres y hay más con
 * existencia para la moto del cliente. Literal dictado por el operador
 * (29/9/2026). Sin cifras de dinero, así que no toca `price-guard`.
 */
export function lineaMasOpciones(cantidad: number): string {
  const resto = cantidad === 1 ? "1 opción más" : `${cantidad} opciones más`;
  return `Hay ${resto} para tu moto; el asesor te muestra el resto.`;
}

/** Suma lo que quedó sin mostrar de un producto (varias búsquedas del turno pueden apuntar al mismo). */
function masOpcionesDe(opciones: OpcionesCotizacion, productoPedido: string | null): number {
  return (opciones.masOpciones ?? [])
    .filter((m) => m.productoPedido === productoPedido)
    .reduce((suma, m) => suma + m.cantidad, 0);
}

/** "6 disponibles" / "1 disponible" / "Agotado". */
function existencia(stock: number): string {
  if (stock <= 0) return "Agotado";
  return stock === 1 ? "1 disponible" : `${stock} disponibles`;
}

/**
 * El encabezado de un producto pedido viene del MODELO (el elemento de
 * `productos`): se le quita el formato de WhatsApp y se recorta, para que no
 * pueda colar negritas ni un párrafo dentro del bloque.
 */
function encabezado(producto: string): string {
  const limpio = producto.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
  return `*${limpio.slice(0, MAX_ENCABEZADO_CARACTERES).trim()}*`;
}

function renglon(linea: LineaCotizada): string {
  return `• ${linea.nombre}: ${formatQuote(linea.precioUsd, linea.precioBs)} — ${existencia(linea.stock)}`;
}

/**
 * El bloque de cotización: un renglón por producto con el nombre exacto, el
 * precio "$X BCV (Bs. Y)" y la existencia. En una lista (alguna línea trae
 * `productoPedido`) se agrupa por el producto que se pidió, en el orden en que
 * se pidió. Cadena vacía si no hay nada que decir.
 */
export function armarCotizacion(lineas: readonly LineaCotizada[], opciones: OpcionesCotizacion = {}): string {
  let bloques: string[] = [];

  const esLista = lineas.some((l) => l.productoPedido !== null);
  if (!esLista) {
    if (lineas.length > 0) {
      const mas = masOpcionesDe(opciones, null);
      bloques.push([...lineas.map(renglon), ...(mas > 0 ? [lineaMasOpciones(mas)] : [])].join("\n"));
    }
  } else {
    const grupos = new Map<string, LineaCotizada[]>();
    for (const linea of lineas) {
      const clave = linea.productoPedido ?? "";
      const grupo = grupos.get(clave) ?? [];
      grupo.push(linea);
      grupos.set(clave, grupo);
    }
    bloques = [...grupos.entries()].map(([producto, delGrupo]) => {
      const mas = masOpcionesDe(opciones, producto || null);
      return [producto ? encabezado(producto) : null, ...delGrupo.map(renglon), mas > 0 ? lineaMasOpciones(mas) : null]
        .filter((x): x is string => x !== null)
        .join("\n");
    });
  }

  const faltantes = (opciones.noEncontrados ?? []).map((p) => `• ${p}: no lo encontré en el catálogo`);
  if (faltantes.length > 0) bloques.push(faltantes.join("\n"));

  // La corrección (si existe) abre el PRIMER bloque, no es un párrafo aparte.
  if (opciones.correcciones && opciones.correcciones.length > 0) {
    const aviso = `Como no encontré exactamente lo que escribiste, ${describirCorreccion(opciones.correcciones)}:`;
    if (bloques.length === 0) bloques.push(aviso);
    else bloques[0] = `${aviso}\n${bloques[0]}`;
  }

  return bloques.join("\n\n");
}

/** Lo normal para comparar: minúsculas y sin acentos. */
function plano(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Las palabras que identifican a un producto: 3 letras o más, o cualquier token con un dígito (20w50, ls2, 4t). */
function palabrasDistintivas(texto: string): string[] {
  return (plano(texto).match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 || /\d/.test(w));
}

/**
 * La línea previa que se le deja al modelo, o `null` si no cumple. El modelo
 * ya no redacta la cotización, pero una frase corta de cortesía sí puede
 * acompañarla. Se descarta (no se recorta ni se corrige) si:
 *   - está vacía, ocupa más de una línea o pasa de `MAX_PREAMBULO_CARACTERES`;
 *   - trae una cifra de dinero (`moneyFigures`): los precios los pone el bloque;
 *   - contiene alguno de los textos fijos o el nombre de un producto cotizado
 *     (duplicaría lo que el bloque ya dice, o lo diría distinto);
 *   - habla del asesor: el texto fijo del cierre ya lo nombra, y repetir la
 *     promesa dos veces en el mismo mensaje confunde;
 *   - pregunta algo: el mensaje ya cierra con su texto fijo o con LA única
 *     pregunta de filtro, y una segunda pregunta la pisaría.
 * `extraProhibidos` suma textos que tampoco puede repetir (la pregunta de
 * filtro cuando el mensaje es una pregunta).
 */
export function preambuloDelModelo(
  textoModelo: string,
  lineas: readonly LineaCotizada[],
  extraProhibidos: readonly string[] = []
): string | null {
  const texto = textoModelo.trim();
  if (!texto) return null;
  if (texto.includes("\n")) return null;
  if (texto.length > MAX_PREAMBULO_CARACTERES) return null;
  if (/[?¿]/.test(texto)) return null;
  if (moneyFigures(texto).length > 0) return null;

  const normal = plano(texto);
  if (/asesor/.test(normal)) return null;
  const prohibidos = [TEXTO_CONFIRMAR_INVENTARIO, TEXTO_SIN_STOCK, ...extraProhibidos, ...lineas.map((l) => l.nombre)];
  if (prohibidos.some((p) => normal.includes(plano(p)))) return null;
  // Un nombre "parecido" también se descarta: el caso real fue "Inca 20W50
  // semi sintético" por "ACEITE INCA 20W50 4T". Dos palabras distintivas del
  // mismo producto en la línea previa ya la vuelven una segunda descripción.
  const palabrasDelPreambulo = new Set(palabrasDistintivas(texto));
  const seParece = lineas.some((l) => {
    const palabras = palabrasDistintivas(l.nombre);
    const enComun = palabras.filter((w) => palabrasDelPreambulo.has(w)).length;
    return palabras.length > 0 && enComun >= Math.min(2, palabras.length);
  });
  if (seParece) return null;

  return texto;
}

/**
 * El mensaje completo de una cotización: preámbulo opcional + bloque + texto
 * fijo LITERAL (`TEXTO_CONFIRMAR_INVENTARIO` si algún renglón tiene stock,
 * `TEXTO_SIN_STOCK` si todo está agotado). `texto` es cadena vacía si no hay
 * ninguna línea cotizada: sin cotización no hay nada que armar por código.
 */
export function armarMensajeDeCotizacion(params: {
  textoModelo: string;
  lineas: readonly LineaCotizada[];
  noEncontrados?: readonly string[];
  correcciones?: readonly CorreccionTermino[];
  masOpciones?: readonly MasOpciones[];
}): { texto: string; preambulo: string | null } {
  if (params.lineas.length === 0) return { texto: "", preambulo: null };

  // Todo agotado: una frase amable ("¡claro, tenemos ese casco!") contradiría
  // al renglón "Agotado", así que ahí no se conserva ninguna.
  const preambulo = params.lineas.some((l) => l.stock > 0)
    ? preambuloDelModelo(params.textoModelo, params.lineas)
    : null;
  const bloque = armarCotizacion(params.lineas, {
    noEncontrados: params.noEncontrados,
    correcciones: params.correcciones,
    masOpciones: params.masOpciones,
  });
  const textoFijo = params.lineas.some((l) => l.stock > 0) ? TEXTO_CONFIRMAR_INVENTARIO : TEXTO_SIN_STOCK;

  return {
    texto: [preambulo, bloque, textoFijo].filter((parte): parte is string => Boolean(parte)).join("\n\n"),
    preambulo,
  };
}

/** Frases con las que el modelo afirmaría existencia: con la pregunta pendiente todavía no se sabe qué producto quiere. */
const AFIRMA_EXISTENCIA = /\b(?:tenemos|tengo|hay|disponibles?|quedan|en stock|en existencia)\b/;

/**
 * El mensaje cuando la consulta es genérica: LA única pregunta de filtro
 * (`PREGUNTA_FILTRO` o `PREGUNTA_FILTRO_PRODUCTO`, literal) y, si el modelo
 * dejó una línea previa válida, esa línea arriba. La línea previa tampoco
 * puede afirmar existencia ni dar precios: todavía no se sabe cuál producto
 * quiere el cliente ("no afirmes que hay existencia", `instruccionGenerica`).
 */
export function armarMensajeDePregunta(params: {
  textoModelo: string;
  pregunta: string;
}): { texto: string; preambulo: string | null } {
  const candidato = preambuloDelModelo(params.textoModelo, [], [PREGUNTA_FILTRO, PREGUNTA_FILTRO_PRODUCTO, params.pregunta]);
  const preambulo = candidato !== null && !AFIRMA_EXISTENCIA.test(plano(candidato)) ? candidato : null;

  return {
    texto: [preambulo, params.pregunta].filter((parte): parte is string => Boolean(parte)).join("\n\n"),
    preambulo,
  };
}
