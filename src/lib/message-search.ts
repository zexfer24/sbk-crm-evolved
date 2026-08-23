import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Buscar conversaciones por lo que se dijo adentro.
 *
 * El buscador de la bandeja solo miraba el nombre del contacto y su número, así
 * que la única forma de volver a un chat era acordarse de quién era. Escribir
 * "bujía" no encontraba nada aunque la palabra estuviera en veinte hilos.
 *
 * El trabajo pesado lo hace Postgres (`search_conversations_by_message`), que
 * consulta una columna generada sin acentos y en minúsculas con un índice
 * trigram: filtrar en el cliente obligaría a traerse el historial completo de
 * todas las conversaciones a la memoria del navegador.
 */

/** El mensaje coincidente más reciente de una conversación. */
export interface MessageHit {
  messageId: string;
  content: string;
  createdAt: string;
}

/**
 * A partir de cuántas letras se consulta el servidor.
 *
 * Con una sola letra la respuesta es "medio CRM": ni acota ni ayuda, y cuesta
 * una consulta por tecla. Dos ya dice algo.
 */
export const MESSAGE_SEARCH_MIN_LENGTH = 2;

/** Tope de conversaciones que devuelve la búsqueda. */
export const MESSAGE_SEARCH_LIMIT = 40;

/**
 * Normaliza como lo hace `immutable_unaccent(lower(...))` en la base.
 *
 * Tiene que dar el mismo resultado que el SQL: si el servidor busca "bujia" y
 * el cliente resalta "bujía", el resaltado cae en el lugar equivocado. Por
 * WhatsApp nadie escribe con tildes ni respeta mayúsculas.
 */
export function normalizeForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Las palabras sueltas de la búsqueda, ya normalizadas y sin vacías. */
export function searchTerms(query: string): string[] {
  return normalizeForSearch(query).trim().split(/\s+/).filter(Boolean);
}

/** Un tramo de texto listo para pintar: `match` decide si va resaltado. */
export interface TextSegment {
  text: string;
  match: boolean;
}

/**
 * Parte un texto en tramos resaltados y no resaltados.
 *
 * Se busca sobre la versión normalizada pero se cortan los índices del texto
 * original, así el resaltado conserva las tildes y las mayúsculas que escribió
 * la persona. Para la escritura normal las dos versiones miden lo mismo —NFD
 * separa el diacrítico en un carácter aparte y ese se elimina, la letra base
 * queda en su lugar—, pero hay excepciones (un texto que ya venía descompuesto,
 * o la 'İ' turca, que en minúscula ocupa dos caracteres). Ahí los índices dejan
 * de corresponderse y se devuelve el texto sin resaltar: mejor sin marca que
 * con la marca corrida.
 */
export function highlightSegments(text: string, terms: string[]): TextSegment[] {
  if (terms.length === 0) return [{ text, match: false }];

  const haystack = normalizeForSearch(text);
  if (haystack.length !== text.length) return [{ text, match: false }];

  // Se marcan las posiciones y recién después se cortan los tramos: dos
  // términos que se solapan ("buji" y "bujia") producirían tramos cruzados si
  // cada uno cortara por su cuenta.
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at === -1) break;
      for (let i = at; i < at + term.length && i < marked.length; i++) marked[i] = true;
      from = at + term.length;
    }
  }

  const segments: TextSegment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marked[i] !== marked[start]) {
      segments.push({ text: text.slice(start, i), match: marked[start] });
      start = i;
    }
  }
  return segments;
}

/**
 * Recorta el fragmento alrededor de la primera coincidencia.
 *
 * Un mensaje puede ser un párrafo entero y la lista de la bandeja da para una
 * línea. Mostrar el principio del mensaje serviría de poco: lo que se busca
 * suele estar en el medio.
 */
export function snippetAround(text: string, terms: string[], radius = 34): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (terms.length === 0) return flat;

  const haystack = normalizeForSearch(flat);
  if (haystack.length !== flat.length) return flat;

  let at = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1 || at <= radius) return flat;

  // Se corta en el espacio anterior para no partir una palabra al medio.
  const cut = flat.lastIndexOf(" ", at - radius);
  return `…${flat.slice(cut === -1 ? at - radius : cut + 1)}`;
}

interface RawHit {
  conversation_id: string;
  message_id: string;
  content: string;
  created_at: string;
}

/**
 * Conversaciones cuyo historial contiene todas las palabras buscadas.
 *
 * Devuelve un mapa y no una lista porque quien lo usa pregunta siempre por una
 * conversación concreta ("¿esta coincide?"), no recorre el resultado.
 */
export async function searchConversationsByMessage(
  supabase: SupabaseClient,
  query: string,
  limit = MESSAGE_SEARCH_LIMIT
): Promise<Map<string, MessageHit>> {
  const terms = searchTerms(query);
  if (terms.length === 0 || normalizeForSearch(query).trim().length < MESSAGE_SEARCH_MIN_LENGTH) {
    return new Map();
  }

  const { data, error } = await supabase.rpc("search_conversations_by_message", {
    p_query: query,
    p_limit: limit,
  });
  if (error) throw error;

  const hits = new Map<string, MessageHit>();
  for (const row of (data ?? []) as RawHit[]) {
    hits.set(row.conversation_id, {
      messageId: row.message_id,
      content: row.content,
      createdAt: row.created_at,
    });
  }
  return hits;
}
