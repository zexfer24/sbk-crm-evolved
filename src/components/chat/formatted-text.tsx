import { Fragment, type ReactNode } from "react";

/**
 * Estilos de texto reales de WhatsApp Business:
 *   *negrita*, _itálica_, ~tachado~, `monospace` (backtick simple).
 *
 * WhatsApp NO usa doble asterisco para negrita — eso solo produce
 * asteriscos literales en el chat del cliente. `**negrita**` quedó
 * deprecado intencionalmente: ya no se reconoce como formato.
 *
 * Reglas de un marcador válido (igual que WhatsApp real):
 *   - El caracter de apertura y cierre no puede tener espacio pegado
 *     adentro (`* texto*` o `*texto *` NO cuentan).
 *   - El contenido no puede estar vacío ni contener el propio marcador
 *     ni saltos de línea.
 *   - No hay anidación entre estilos: cada marcador se parsea de forma
 *     independiente, no soportamos negrita+itálica combinadas.
 *
 * Nota: WhatsApp también soporta triple backtick para bloques de código,
 * pero solo implementamos el backtick simple (caso base) — no hay
 * distinción visual relevante de bloque en la burbuja del chat.
 */
interface StyleSpec {
  marker: string;
  Tag: "strong" | "em" | "s" | "code";
}

/**
 * Direcciones web dentro del mensaje.
 *
 * Solo http y https a propósito: es lo único que tiene sentido abrir desde el
 * chat, y limitar el esquema acá es lo que impide que un `javascript:` escrito
 * por un cliente llegue a convertirse en un enlace ejecutable.
 *
 * El corte final descarta la puntuación que suele quedar pegada al final de
 * una frase —"mirá https://ejemplo.com."— sin comerse la que forma parte de
 * la dirección.
 */
const URL_REGEX = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;

const STYLES: StyleSpec[] = [
  { marker: "*", Tag: "strong" },
  { marker: "_", Tag: "em" },
  { marker: "~", Tag: "s" },
  { marker: "`", Tag: "code" },
];

// Para cada marcador: no vacío, sin espacio pegado a los bordes, sin el
// propio marcador ni salto de línea adentro, y sin marcadores dobles
// pegados (para no reinterpretar "**negrita**" como "*" + bold("*negrita")).
const PATTERNS = STYLES.map(({ marker, Tag }) => {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    Tag,
    regex: new RegExp(`(?<!${m})${m}(?!${m})(?!\\s)([^${m}\\n]+?)(?<!\\s)${m}(?!${m})`, "g"),
  };
});

interface Token {
  index: number;
  length: number;
  content: string;
  Tag: StyleSpec["Tag"] | "link";
}

/** Texto de un mensaje con soporte para los estilos reales de WhatsApp. */
export function FormattedText({ text }: { text: string }) {
  const hasAnyMarker = STYLES.some(({ marker }) => text.includes(marker));
  const hasAnyLink = text.includes("http");
  if (!hasAnyMarker && !hasAnyLink) return <>{text}</>;

  // Recolectamos matches de los 4 patrones y nos quedamos, en caso de
  // solapamiento, con el que empieza primero (y si empatan, el más largo).
  const tokens: Token[] = [];
  for (const { Tag, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const index = match.index ?? 0;
      tokens.push({ index, length: match[0].length, content: match[1], Tag });
    }
  }
  // Los enlaces entran en la misma lista: así el desempate por solapamiento
  // vale también entre un enlace y un marcador, y un guion bajo dentro de una
  // dirección no la parte en itálica.
  for (const match of text.matchAll(URL_REGEX)) {
    tokens.push({
      index: match.index ?? 0,
      length: match[0].length,
      content: match[0],
      Tag: "link",
    });
  }
  tokens.sort((a, b) => a.index - b.index || b.length - a.length);

  const selected: Token[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.index < cursor) continue; // se solapa con uno ya elegido
    selected.push(token);
    cursor = token.index + token.length;
  }

  if (selected.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const token of selected) {
    if (token.index > lastIndex) {
      parts.push(<Fragment key={key++}>{text.slice(lastIndex, token.index)}</Fragment>);
    }
    if (token.Tag === "link") {
      parts.push(
        <a
          key={key++}
          href={token.content}
          target="_blank"
          rel="noopener noreferrer"
          className="crm-msg-link"
        >
          {token.content}
        </a>
      );
    } else {
      const Tag = token.Tag;
      parts.push(<Tag key={key++}>{token.content}</Tag>);
    }
    lastIndex = token.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  }

  return <>{parts}</>;
}
