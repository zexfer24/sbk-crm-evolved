import { moneyFigures } from "@/lib/ai/price-guard";
import { armarCotizacion } from "@/lib/ai/quote-message";
import { PREGUNTA_FILTRO, PREGUNTA_FILTRO_PRODUCTO } from "@/lib/ai/seba";
import type { CatalogOutcome, LineaCotizada } from "@/lib/ai/tools";
import { PREGUNTA_QUE_BUSCA } from "./textos";
import type { OrigenTexto } from "./tipos";

// ---------------------------------------------------------------------------
// Lo PURO del armado de la salida de Seba v2 (S8c, 17/11/2026).
//
// El turno (`turno.ts`) le pide a `planearSalida` qué hay que decirle al cliente a
// partir de lo que el modelo escribió y de lo que la búsqueda del catálogo dejó en
// `catalogOutcome`; el plan dice QUÉ, y el turno se ocupa de las guardas, del tope
// de mensajes, de la cesión y de enviar. Sin Supabase, sin modelo y sin reloj: se
// prueba entero con datos armados a mano.
//
// Regla de fondo: la cotización la arma el CÓDIGO (nombre exacto, precio ya
// calculado, existencia sin cantidad), y del modelo solo se acepta, como mucho, UNA
// línea de cierre sin cifras. Es la misma regla que v1 (`quote-message.ts`), con dos
// diferencias de v2: la existencia no se dice con números ("Nunca digas cuántas
// unidades hay") y el cierre pregunta si lo lleva, no promete un asesor.
// ---------------------------------------------------------------------------

/** Tope de mensajes de texto por turno (bienvenida y lo que envían las herramientas incluidos). */
export const SEBA2_MAX_MENSAJES = 3;

/** Una línea de WhatsApp, no un párrafo: mismo tope que el preámbulo de v1. */
const MAX_LINEA_DEL_MODELO = 240;
/** Una pregunta de filtro del modelo no necesita más. */
const MAX_PREGUNTA_DEL_MODELO = 400;

/** En la nota para el asesor: cuántas líneas del cliente se citan y cuánto de cada una. */
const NOTA_MAX_LINEAS = 5;
const NOTA_MAX_CHARS = 300;

export type PlanDeSalida =
  | {
      tipo: "cotizacion";
      /** El bloque con nombre exacto, precio y existencia. Lo arma el código: origen `"herramienta"`. */
      bloque: string;
      /** La foto principal, solo si se cotizó UN producto con existencia que la tiene. */
      foto: { url: string } | null;
      /** La línea de cierre que el modelo escribió, si cumple las reglas; el turno la pasa por las guardas. */
      lineaDelModelo: string | null;
      /** Algún renglón tiene existencia: el cierre es «¿lo quieres llevar?»; sin ella, no se ofrece nada. */
      hayExistencia: boolean;
      /** Los renglones cotizados (con y sin existencia), en el orden de la búsqueda. */
      productos: LineaCotizada[];
    }
  | {
      tipo: "pregunta";
      /** La pregunta que sale: la del modelo (`"modelo"`, pasa por las guardas) o la fija (`"fijo"`). */
      texto: string;
      origen: "modelo" | "fijo";
      /** La pregunta fija de este caso: lo que sale si la del modelo no pasa las guardas. */
      respaldo: string;
    }
  | { tipo: "texto"; textos: string[] }
  | { tipo: "vacio"; huboBusqueda: boolean };

export interface EntradaDePlan {
  textoModelo: string;
  catalogOutcome: CatalogOutcome;
  /** URL de la foto principal de un producto, o `null` si no tiene (o no se cargó). */
  fotoDe: (productId: string) => string | null;
  /** Mensajes de texto que quedan por enviar; por defecto `SEBA2_MAX_MENSAJES`. */
  maxMensajes?: number;
}

// ----------------------------- Texto del modelo -----------------------------

/** Minúsculas y sin acentos, para comparar. */
function plano(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Las palabras que identifican a un producto: 3 letras o más, o cualquier token con un dígito (20w50, ls2, 4t). */
function palabrasDistintivas(texto: string): string[] {
  return (plano(texto).match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 || /\d/.test(w));
}

/**
 * La línea de cierre que se le deja al modelo, o `null` si no cumple. Se
 * DESCARTA (no se recorta ni se corrige) si: ocupa más de una línea o pasa de
 * `MAX_LINEA_DEL_MODELO`; trae una cifra de dinero (los montos los pone el
 * bloque); habla de un asesor (el cierre de v2 pregunta si lo lleva, no
 * promete a nadie); o nombra —o describe con dos palabras distintivas— un
 * producto cotizado: sería una segunda descripción que puede contradecir la
 * primera (el caso real de v1 fue «Inca 20W50 semi sintético» por «ACEITE INCA
 * 20W50 4T»). A diferencia del preámbulo de v1 SÍ puede ser una pregunta: es
 * justo lo que pide el guion («¿lo quieres llevar? ¿cómo prefieres pagar?»).
 */
function lineaDeCierreDelModelo(textoModelo: string, lineas: readonly LineaCotizada[]): string | null {
  const texto = textoModelo.trim();
  if (texto === "" || texto.includes("\n") || texto.length > MAX_LINEA_DEL_MODELO) return null;
  if (moneyFigures(texto).length > 0) return null;

  const normal = plano(texto);
  if (/asesor/.test(normal)) return null;
  if (lineas.some((l) => normal.includes(plano(l.nombre)))) return null;

  const palabrasDelTexto = new Set(palabrasDistintivas(texto));
  const seParece = lineas.some((l) => {
    const palabras = palabrasDistintivas(l.nombre);
    const enComun = palabras.filter((w) => palabrasDelTexto.has(w)).length;
    return palabras.length > 0 && enComun >= Math.min(2, palabras.length);
  });
  return seParece ? null : texto;
}

/**
 * Parte un texto del modelo en mensajes por líneas en blanco. Como mucho `max`
 * (mínimo 1): lo que sobre se une al último con una línea en blanco, en vez de
 * perderse. Un salto simple no parte: un mensaje puede traer varias líneas.
 */
export function partirEnMensajes(texto: string, max: number): string[] {
  const parrafos = texto
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const tope = Math.max(1, Math.floor(max));
  if (parrafos.length <= tope) return parrafos;
  return [...parrafos.slice(0, tope - 1), parrafos.slice(tope - 1).join("\n\n")];
}

/** De los tres orígenes, el que menos controla el código gana: lo que mezcla algo del modelo es «modelo». */
const PESO_DE_ORIGEN: Record<OrigenTexto, number> = { fijo: 0, herramienta: 1, modelo: 2 };

/**
 * Si hay más mensajes de texto que cupo, une los sobrantes al último con una
 * línea en blanco (nada se pierde). El origen del mensaje unido es el menos
 * controlado de los que lo forman, para que una revisión (sombra, bitácora) no
 * tome por texto de código algo que redactó el modelo.
 */
export function unirMensajesDeTexto(
  mensajes: readonly { texto: string; origen: OrigenTexto }[],
  max: number
): { texto: string; origen: OrigenTexto }[] {
  const tope = Math.max(1, Math.floor(max));
  if (mensajes.length <= tope) return [...mensajes];

  const conservados = mensajes.slice(0, tope - 1);
  const sobrantes = mensajes.slice(tope - 1);
  const origen = sobrantes.reduce<OrigenTexto>(
    (mayor, m) => (PESO_DE_ORIGEN[m.origen] > PESO_DE_ORIGEN[mayor] ? m.origen : mayor),
    sobrantes[0].origen
  );
  return [...conservados, { texto: sobrantes.map((m) => m.texto).join("\n\n"), origen }];
}

// -------------------------------- El plan -----------------------------------

function noEncontradosDe(consultas: CatalogOutcome["consultas"]): string[] {
  return consultas
    .filter(
      (c) =>
        c.productos !== null &&
        c.resultado !== "con_existencia" &&
        c.resultado !== "agotados" &&
        c.resultado !== "generico"
    )
    .map((c) => c.query);
}

function correccionesDe(consultas: CatalogOutcome["consultas"]) {
  return consultas
    .filter((c) => c.resultado === "con_existencia" || c.resultado === "agotados")
    .flatMap((c) => c.corregido ?? []);
}

function preguntaDelPlan(
  texto: string,
  respaldo: string
): { tipo: "pregunta"; texto: string; origen: "modelo" | "fijo"; respaldo: string } {
  const delModelo = texto !== "" && /[?¿]/.test(texto) && texto.length <= MAX_PREGUNTA_DEL_MODELO;
  return delModelo
    ? { tipo: "pregunta", texto, origen: "modelo", respaldo }
    : { tipo: "pregunta", texto: respaldo, origen: "fijo", respaldo };
}

/**
 * Qué se le dice al cliente, por orden de prioridad: la cotización (lo que la
 * búsqueda encontró o el aviso que hay que dar), la pregunta de filtro, el texto
 * del modelo partido en mensajes, o nada (el turno entonces pasa el caso por
 * código: el cliente nunca queda sin respuesta ni sin dueño).
 */
export function planearSalida(i: EntradaDePlan): PlanDeSalida {
  const { catalogOutcome } = i;
  const texto = i.textoModelo.trim();
  const lineas = catalogOutcome.cotizacion;

  if (lineas.length > 0 || catalogOutcome.avisos.length > 0) {
    const bloque = armarCotizacion(lineas, {
      noEncontrados: noEncontradosDe(catalogOutcome.consultas),
      correcciones: correccionesDe(catalogOutcome.consultas),
      avisos: catalogOutcome.avisos,
      // El orden en que el cliente pidió los productos de una lista: un ítem que solo
      // tiene aviso (sin renglones) no aparece en las líneas.
      ordenProductos: catalogOutcome.consultas.find((c) => c.productos !== null)?.productos ?? undefined,
      existencia: "sin_cantidad",
    });

    if (bloque.trim() !== "") {
      const unicoConExistencia = lineas.length === 1 && lineas[0].stock > 0 ? lineas[0] : null;
      const url = unicoConExistencia ? i.fotoDe(unicoConExistencia.productId) : null;
      return {
        tipo: "cotizacion",
        bloque,
        foto: url ? { url } : null,
        lineaDelModelo: lineaDeCierreDelModelo(texto, lineas),
        hayExistencia: lineas.some((l) => l.stock > 0),
        productos: [...lineas],
      };
    }
  }

  if (catalogOutcome.preguntaFiltro) {
    return preguntaDelPlan(
      texto,
      catalogOutcome.preguntaFiltro === "moto" ? PREGUNTA_FILTRO : PREGUNTA_FILTRO_PRODUCTO
    );
  }

  // El cliente todavía no nombró ningún repuesto: la búsqueda corrió, marcó la consulta
  // genérica y no llegó a buscar nada. Preguntar qué busca es mejor que pasar el caso.
  if (catalogOutcome.ran && catalogOutcome.generico && catalogOutcome.consultas.length === 0) {
    return preguntaDelPlan(texto, PREGUNTA_QUE_BUSCA);
  }

  if (texto === "") return { tipo: "vacio", huboBusqueda: catalogOutcome.ran };

  return { tipo: "texto", textos: partirEnMensajes(texto, i.maxMensajes ?? SEBA2_MAX_MENSAJES) };
}

// ------------------------------- Aceptación ---------------------------------

/** Un rechazo explícito: «no gracias», «no lo quiero», «mejor no», «no» a secas. */
const RECHAZOS: readonly RegExp[] = [
  /^\W*no\W*$/,
  /\bno[,.!]?\s+gracias\b/,
  /\bno\s+(?:lo|la|los|las)?\s*(?:quiero|llevo|voy a llevar|compro|me interesa)\b/,
  /\bmejor\s+no\b/,
  /\bpor ahora no\b/,
];

/** Hablar de pago o decir que lo quiere: vale aunque la línea sea una pregunta («¿cómo pago?»). */
const ACEPTACIONES_FUERTES: readonly RegExp[] = [
  /\b(?:lo|la)s?\s+quiero\b/,
  /\b(?:me\s+)?(?:lo|la)s?\s+llevo\b/,
  /\bquiero\s+(?:comprar|llevar|pagar)/,
  /\b(?:lo|la)s?\s+compro\b/,
  /\bcomo\s+(?:puedo\s+|se\s+|hago\s+para\s+)?pag(?:o|ar)\b/,
  /\bformas?\s+de\s+pago\b/,
  /\bcashea\b/,
  /\bpago\s+movil\b/,
  /\btransferencia\b/,
  /\bbinance\b/,
  /\bzelle\b/,
];

/**
 * Un «sí» o un «dale» al empezar la línea. Solo cuenta si no es una pregunta:
 * «si me sirve para mi SBR?» empieza con «si» y no acepta nada.
 */
const ACEPTACIONES_DEBILES: readonly RegExp[] = [
  /^\W*(?:si+|sip)\s*(?:[,.!]|$)/,
  /^\W*(?:claro|dale|ok|okey|vale|perfecto|listo|de una|de acuerdo|esta bien)\b/,
];

/**
 * ¿La ráfaga suena a que el cliente acepta lo cotizado o habla de cómo pagar?
 * («sí», «dale», «lo quiero», «me lo llevo», «cómo pago», «cashea», «pago
 * móvil», «transferencia»…). Un rechazo en cualquier línea la tumba: «no
 * gracias» NO es aceptación. Es una heurística que solo mueve la ETAPA del
 * pedido; lo que se le dice al cliente lo decide el modelo con las herramientas.
 */
export function pareceAceptacion(rafaga: readonly string[]): boolean {
  const lineas = rafaga.map(plano).filter((l) => l.trim() !== "");
  if (lineas.some((l) => RECHAZOS.some((r) => r.test(l)))) return false;
  return lineas.some(
    (l) =>
      ACEPTACIONES_FUERTES.some((a) => a.test(l)) ||
      (!/[?¿]/.test(l) && ACEPTACIONES_DEBILES.some((a) => a.test(l)))
  );
}

// ----------------------------- Nota para el asesor --------------------------

/**
 * Las líneas del cliente citadas para una nota interna: «a» «b» (+N más). Cada
 * línea se recorta a 300 caracteres y se citan como mucho cinco, las primeras.
 * Mismo formato que la nota de v1 con la escalada abierta.
 */
export function citarRafaga(lineas: readonly string[]): string {
  const citadas = lineas.slice(0, NOTA_MAX_LINEAS).map((linea) => {
    const una = linea.replace(/\s*[\r\n]+\s*/g, " ").trim();
    return `«${una.length > NOTA_MAX_CHARS ? `${una.slice(0, NOTA_MAX_CHARS)}…` : una}»`;
  });
  const restantes = lineas.length - citadas.length;
  if (restantes > 0) citadas.push(`(+${restantes} más)`);
  return citadas.join(" ");
}
