import type { QuickReply } from "@/lib/types";

// ---------------------------------------------------------------------------
// Búsqueda y filtro del modal de mensajes rápidos (21/10/2026, "Presupuestos y
// mensajes rápidos", T7). Con decenas de mensajes compartidos, el asesor ya no
// puede recorrer la lista con la vista a mitad de una conversación: busca por
// palabra clave. Todo puro, para probarlo sin levantar el modal.
//
// Decisión D7: primero los que calzan en el TÍTULO; los que calzan solo en el
// TEXTO van aparte, debajo, para que un "catálogo" que aparece en el cuerpo de
// diez mensajes no tape al mensaje que se llama "Catálogo".
// ---------------------------------------------------------------------------

export type FiltroMedia = "todos" | "texto" | "fotos";

/** Un carácter sin diacríticos y en minúsculas. Puede devolver 0, 1 o más caracteres. */
function normalizarCaracter(caracter: string): string {
  return caracter
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Forma comparable de un texto: sin acentos, en minúsculas, con los espacios
 * colapsados y sin los de los extremos. "  CATÁLOGO  general " → "catalogo general".
 */
export function normalizarBusqueda(texto: string): string {
  return Array.from(texto, normalizarCaracter).join("").replace(/\s+/g, " ").trim();
}

/** Las palabras de una consulta, ya normalizadas. Consulta vacía → []. */
function palabrasDe(consulta: string): string[] {
  const normalizada = normalizarBusqueda(consulta);
  return normalizada === "" ? [] : normalizada.split(" ");
}

/** "Con fotos" es `mediaPaths.length > 0`, también para una respuesta de solo fotos. */
export function coincideMedia(reply: QuickReply, filtro: FiltroMedia): boolean {
  if (filtro === "fotos") return reply.mediaPaths.length > 0;
  if (filtro === "texto") return reply.mediaPaths.length === 0;
  return true;
}

export interface ResultadoBusqueda {
  porTitulo: QuickReply[];
  porTexto: QuickReply[];
}

/**
 * Consulta vacía → `porTitulo` son todos los que pasan el filtro de media (en
 * el orden recibido) y `porTexto` queda vacío. Con consulta se parte en
 * palabras: `porTitulo` = TODAS aparecen en el título; `porTexto` = no entró a
 * `porTitulo` y TODAS aparecen en el texto. Las palabras de una misma consulta
 * no se reparten entre título y texto: un mensaje calza por un campo o por el
 * otro, no por la suma de los dos.
 */
export function buscarMensajesRapidos(
  replies: QuickReply[],
  consulta: string,
  filtro: FiltroMedia
): ResultadoBusqueda {
  const pasanMedia = replies.filter((reply) => coincideMedia(reply, filtro));
  const palabras = palabrasDe(consulta);
  if (palabras.length === 0) return { porTitulo: pasanMedia, porTexto: [] };

  const porTitulo: QuickReply[] = [];
  const porTexto: QuickReply[] = [];
  for (const reply of pasanMedia) {
    const titulo = normalizarBusqueda(reply.label);
    if (palabras.every((palabra) => titulo.includes(palabra))) {
      porTitulo.push(reply);
      continue;
    }
    const texto = normalizarBusqueda(reply.content);
    if (palabras.every((palabra) => texto.includes(palabra))) porTexto.push(reply);
  }
  return { porTitulo, porTexto };
}

/**
 * Trozos del texto ORIGINAL (con sus acentos) marcando dónde calza cada palabra
 * de la consulta, sin distinguir acentos ni mayúsculas. Se normaliza carácter
 * por carácter y no la cadena entera, para saber a qué carácter original
 * pertenece cada carácter normalizado: normalizar de una vez puede cambiar el
 * largo (un "é" escrito como "e" + tilde combinante, una "İ") y desalinearía
 * los índices del resaltado respecto del texto que se pinta.
 */
export function resaltar(texto: string, consulta: string): { texto: string; marcado: boolean }[] {
  if (texto === "") return [];
  const palabras = palabrasDe(consulta);
  if (palabras.length === 0) return [{ texto, marcado: false }];

  const originales = Array.from(texto);
  let normalizado = "";
  // `origenDe[i]` = índice (en `originales`) del carácter que produjo el
  // carácter normalizado `i`.
  const origenDe: number[] = [];
  originales.forEach((caracter, indice) => {
    const forma = normalizarCaracter(caracter);
    normalizado += forma;
    for (let k = 0; k < forma.length; k += 1) origenDe.push(indice);
  });

  const marcados = new Array<boolean>(originales.length).fill(false);
  for (const palabra of palabras) {
    let desde = normalizado.indexOf(palabra);
    while (desde !== -1) {
      for (let k = desde; k < desde + palabra.length; k += 1) marcados[origenDe[k]] = true;
      desde = normalizado.indexOf(palabra, desde + 1);
    }
  }

  const trozos: { texto: string; marcado: boolean }[] = [];
  originales.forEach((caracter, indice) => {
    const ultimo = trozos[trozos.length - 1];
    if (ultimo && ultimo.marcado === marcados[indice]) ultimo.texto += caracter;
    else trozos.push({ texto: caracter, marcado: marcados[indice] });
  });
  return trozos;
}
