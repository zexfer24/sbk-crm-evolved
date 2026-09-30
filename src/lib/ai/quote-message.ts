import { describirCorreccion, type CorreccionTermino } from "@/lib/ai/catalog-correction";
import { formatQuote } from "@/lib/ai/precio";
import { moneyFigures } from "@/lib/ai/price-guard";
import {
  OTRA_OPCION_CON_EXISTENCIA,
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  TEXTO_ASESOR_CONFIRMA,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_SIN_STOCK,
  textoMotoSinCalce,
  textoRelajado,
  textoRelajadoAgotado,
  textoUniversales,
  textoVarianteAgotada,
  textoVariasOpciones,
} from "@/lib/ai/seba";
import type { AvisoCatalogo, ConsultaCatalogo, LineaCotizada } from "@/lib/ai/tools";

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
// A2 T5 (30/9/2026, con D6): el bloque también pinta los AVISOS de la búsqueda
// (universales, moto sin calce, «varias opciones», variante agotada con su UNA
// alternativa, relajo) con los textos literales de `seba.ts`, y arma la nota de
// la escalada (`notaDeBusquedas`). Nunca hay «Hay N más»: se cotiza UNA opción
// (la línea `lineaMasOpciones` de la corrección del 29/9/2026 se borró en T5b,
// 30/9/2026: desde el hotfix de esa misma tarde nadie la producía).
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
   * A2 T5 (30/9/2026): los avisos de la búsqueda (`CatalogOutcome.avisos`): D1
   * (universales, moto sin calce), D1b (varias opciones), D2 (variante agotada
   * y su UNA alternativa) y D3 (relajo). Cada uno se pinta en el grupo de su
   * producto, con el texto literal de `seba.ts`.
   */
  avisos?: readonly AvisoCatalogo[];
  /**
   * Los productos de una lista en el orden en que se pidieron
   * (`ConsultaCatalogo.productos`): un ítem que solo tiene aviso (sin
   * renglones) no aparece en `lineas`, y sin este orden iría al final.
   */
  ordenProductos?: readonly string[];
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
 * La línea de un aviso que va ARRIBA de los renglones de su producto.
 * `variante_agotada` sin alternativa no dice nada aparte: el renglón "Agotado"
 * ya nombra el producto exacto (A2 T5). `nCotizadas` es cuántos renglones
 * normales (no alternativa) lleva el producto: `textoUniversales` concuerda en
 * singular/plural con él.
 */
function lineaDeAviso(aviso: AvisoCatalogo, nCotizadas: number): string | null {
  switch (aviso.tipo) {
    case "universales":
      return textoUniversales(aviso.marca, nCotizadas);
    case "moto_sin_calce":
      return textoMotoSinCalce(aviso.moto);
    case "relajado":
      return textoRelajado(aviso.terminos);
    case "relajado_agotado":
      return textoRelajadoAgotado(aviso.terminos);
    case "variante_agotada":
      return aviso.conAlternativa ? textoVarianteAgotada(aviso.variante) : null;
    case "varias_opciones":
      return textoVariasOpciones(aviso.productoPedido);
  }
}

/**
 * El bloque de UN producto pedido: encabezado (solo en una lista), sus avisos,
 * sus renglones y, si la variante pedida estaba agotada (D2), "Otra opción con
 * existencia:" con la UNA alternativa. Un agotado nunca va junto a algo con
 * existencia: quien arma las líneas ya lo garantiza (T5, hotfix del
 * 29/9/2026).
 */
function bloqueDeProducto(
  producto: string | null,
  lineas: readonly LineaCotizada[],
  avisos: readonly AvisoCatalogo[]
): string {
  const normales = lineas.filter((l) => !l.esAlternativa);
  const alternativas = lineas.filter((l) => l.esAlternativa === true);
  const lineasDeAvisos = avisos
    .map((a) => lineaDeAviso(a, normales.length))
    .filter((linea): linea is string => linea !== null);

  return [
    producto ? encabezado(producto) : null,
    ...lineasDeAvisos,
    ...normales.map(renglon),
    ...(alternativas.length > 0 ? [OTRA_OPCION_CON_EXISTENCIA, ...alternativas.map(renglon)] : []),
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/**
 * El bloque de cotización: un renglón por producto con el nombre exacto, el
 * precio "$X BCV (Bs. Y)" y la existencia. En una lista (alguna línea o aviso
 * trae `productoPedido`) se agrupa por el producto que se pidió, en el orden en
 * que se pidió (`ordenProductos`; sin él, primero los que tienen renglones).
 * Los avisos de la búsqueda (A2 T5) se pintan en el grupo de su producto.
 * Cadena vacía si no hay nada que decir.
 */
export function armarCotizacion(lineas: readonly LineaCotizada[], opciones: OpcionesCotizacion = {}): string {
  let bloques: string[] = [];
  const avisos = opciones.avisos ?? [];

  const esLista = lineas.some((l) => l.productoPedido !== null) || avisos.some((a) => a.productoPedido !== null);
  if (!esLista) {
    if (lineas.length > 0 || avisos.length > 0) {
      bloques.push(bloqueDeProducto(null, lineas, avisos));
    }
  } else {
    const grupos = new Map<string, LineaCotizada[]>();
    for (const linea of lineas) {
      const clave = linea.productoPedido ?? "";
      const grupo = grupos.get(clave) ?? [];
      grupo.push(linea);
      grupos.set(clave, grupo);
    }
    // Los productos que solo tienen aviso también son un grupo.
    for (const aviso of avisos) {
      const clave = aviso.productoPedido ?? "";
      if (!grupos.has(clave)) grupos.set(clave, []);
    }

    let claves = [...grupos.keys()];
    if (opciones.ordenProductos && opciones.ordenProductos.length > 0) {
      const posicion = (clave: string): number => {
        const i = opciones.ordenProductos?.indexOf(clave) ?? -1;
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      // `sort` es estable: los que no están en el orden conservan el suyo.
      claves = [...claves].sort((a, b) => posicion(a) - posicion(b));
    }

    bloques = claves.map((clave) =>
      bloqueDeProducto(
        clave || null,
        grupos.get(clave) ?? [],
        avisos.filter((a) => (a.productoPedido ?? "") === clave)
      )
    );
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
 * El texto fijo con el que cierra el mensaje, según lo que de verdad se dijo:
 * con AL MENOS un renglón con existencia, el de confirmar inventario; con todo
 * agotado (sin ningún ítem que se quede sin nombrar), el de sin stock; y si
 * hay ítems que NO se cotizaron (moto sin calce, "varias opciones") o no hay
 * ningún renglón, el del asesor: decir "quedan unidades" o "no quedan" de lo
 * que no se nombró sería mentir (A2 T5).
 */
function textoFijoDeCierre(lineas: readonly LineaCotizada[], avisos: readonly AvisoCatalogo[]): string {
  if (lineas.some((l) => l.stock > 0)) return TEXTO_CONFIRMAR_INVENTARIO;
  const hayItemSinCotizar = avisos.some((a) => a.tipo === "moto_sin_calce" || a.tipo === "varias_opciones");
  if (lineas.length > 0 && !hayItemSinCotizar) return TEXTO_SIN_STOCK;
  return TEXTO_ASESOR_CONFIRMA;
}

/**
 * El mensaje completo de una cotización: preámbulo opcional + bloque + texto
 * fijo LITERAL (`textoFijoDeCierre`). `texto` es cadena vacía si no hay ninguna
 * línea cotizada NI aviso que decir: sin nada no hay qué armar por código.
 */
export function armarMensajeDeCotizacion(params: {
  textoModelo: string;
  lineas: readonly LineaCotizada[];
  noEncontrados?: readonly string[];
  correcciones?: readonly CorreccionTermino[];
  avisos?: readonly AvisoCatalogo[];
  ordenProductos?: readonly string[];
}): { texto: string; preambulo: string | null } {
  const avisos = params.avisos ?? [];
  if (params.lineas.length === 0 && avisos.length === 0) return { texto: "", preambulo: null };

  // Todo agotado: una frase amable ("¡claro, tenemos ese casco!") contradiría
  // al renglón "Agotado", así que ahí no se conserva ninguna.
  const preambulo = params.lineas.some((l) => l.stock > 0)
    ? preambuloDelModelo(params.textoModelo, params.lineas)
    : null;
  const bloque = armarCotizacion(params.lineas, {
    noEncontrados: params.noEncontrados,
    correcciones: params.correcciones,
    avisos,
    ordenProductos: params.ordenProductos,
  });
  const textoFijo = textoFijoDeCierre(params.lineas, avisos);

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

/** Tope de la nota: el mismo `.max(600)` del `resumen` de `escalarAAsesor` (T1, 21/9/2026). */
const MAX_NOTA_CARACTERES = 600;

/**
 * A2 T5 (30/9/2026): la nota que la red de seguridad de `agent.ts` le deja al
 * asesor cuando escala en código tras consultar el catálogo: UN renglón por
 * pedido con lo que decidió la búsqueda (`ConsultaCatalogo.decision`, texto
 * fijo armado por el código) y lo que se cotizó. Producción del 29/9: la lista
 * de cinco pedidos llegaba al asesor con «se quedó sin pasos antes de
 * escalar» y ni un renglón de qué se había pedido ni qué pasó con cada cosa.
 * Nunca pasa de `MAX_NOTA_CARACTERES`; si no cabe todo, corta en un renglón
 * entero. Cadena vacía sin consultas.
 */
export function notaDeBusquedas(consultas: readonly ConsultaCatalogo[]): string {
  if (consultas.length === 0) return "";

  const renglones = consultas.map((c) => {
    const decidio = c.decision !== "" ? c.decision : c.resultado;
    const cotizados = c.cotizados.map((q) => q.nombre).join(", ");
    return `- ${c.query}: ${decidio}${cotizados !== "" ? ` — ${cotizados}` : ""}`;
  });

  let nota = "Pedidos del cliente y qué pasó con cada uno:";
  for (const renglon of renglones) {
    if (`${nota}
${renglon}`.length > MAX_NOTA_CARACTERES) break;
    nota = `${nota}
${renglon}`;
  }
  return nota;
}
