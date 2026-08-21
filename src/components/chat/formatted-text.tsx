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
  Tag: StyleSpec["Tag"];
}

/** Texto de un mensaje con soporte para los estilos reales de WhatsApp. */
export function FormattedText({ text }: { text: string }) {
  const hasAnyMarker = STYLES.some(({ marker }) => text.includes(marker));
  if (!hasAnyMarker) return <>{text}</>;

  // Recolectamos matches de los 4 patrones y nos quedamos, en caso de
  // solapamiento, con el que empieza primero (y si empatan, el más largo).
  const tokens: Token[] = [];
  for (const { Tag, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const index = match.index ?? 0;
      tokens.push({ index, length: match[0].length, content: match[1], Tag });
    }
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
    const Tag = token.Tag;
    parts.push(<Tag key={key++}>{token.content}</Tag>);
    lastIndex = token.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  }

  return <>{parts}</>;
}
