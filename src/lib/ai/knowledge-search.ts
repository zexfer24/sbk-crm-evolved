import { normalize } from "@/lib/ai/catalog-search";

// ---------------------------------------------------------------------------
// Cómo se busca en la biblioteca de conocimiento.
//
// Mismo problema que el catálogo (ver catalog-search.ts): si la búsqueda no
// calza, el agente no falla — le dice al cliente que esa información no
// existe, con toda seguridad y en silencio. Por eso también acá se parte la
// pregunta en palabras sin acentos y se ordena por cuántas calzan.
//
// A diferencia del catálogo, el ranking corre completo en TypeScript: la
// biblioteca la escribe el equipo a mano, así que son decenas de entradas,
// no miles — traerlas y ordenarlas acá es más simple que armar un filtro
// PostgREST, y permite pesar el título por encima del cuerpo.
// ---------------------------------------------------------------------------

export interface KnowledgeSearchRow {
  title: string;
  category: string;
  content: string;
}

/**
 * Ordena por relevancia y descarta lo que no calza con ningún término.
 *
 * El título pesa el triple y la categoría el doble que el cuerpo: una
 * entrada titulada «Envíos a todo el país» tiene que quedar por encima de
 * otra que solo menciona la palabra «envío» de pasada en el texto.
 */
export function rankKnowledge<T extends KnowledgeSearchRow>(rows: T[], terms: string[]): T[] {
  if (terms.length === 0) return [];

  const scored = rows.map((row) => {
    const title = normalize(row.title);
    const category = normalize(row.category);
    const content = normalize(row.content);

    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 3;
      if (category.includes(term)) score += 2;
      if (content.includes(term)) score += 1;
    }
    return { row, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.row);
}

/**
 * Recorta el cuerpo de una entrada a lo que cabe razonablemente en el
 * contexto del turno, avisando en el propio texto que hay más.
 */
export function clipContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n[…texto recortado: la entrada completa es más larga]`;
}
