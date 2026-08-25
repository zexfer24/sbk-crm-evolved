import "server-only";
import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { searchTerms } from "@/lib/ai/catalog-search";
import { clipContent, rankKnowledge } from "@/lib/ai/knowledge-search";

// ---------------------------------------------------------------------------
// Consultar la biblioteca — disponible en todos los casos. Solo lectura.
//
// La biblioteca es información con la que el modelo REDACTA (políticas de
// envío, pagos, garantías, horarios…), no una respuesta que se envía tal
// cual: eso último es un playbook. Ver la migración knowledge_base.sql.
// ---------------------------------------------------------------------------

/**
 * Tope de entradas que se le pasan al modelo por consulta.
 *
 * Tres alcanzan: una pregunta de WhatsApp cae en un tema, dos si mezcla
 * («¿hacen envíos y aceptan Cashea?»). Más entradas es contexto que se paga
 * en cada paso del tool loop sin que nadie lo use.
 */
const MAX_KNOWLEDGE_RESULTS = 3;

/**
 * Tope de caracteres por entrada. Un .md subido puede ser un documento
 * entero; al modelo le llega el comienzo y un aviso de que hay más, en vez
 * de reventar el contexto del turno.
 */
const MAX_CONTENT_CHARS = 4000;

/**
 * Cuántas entradas se traen para rankear. La biblioteca la escribe el
 * equipo a mano — decenas, no miles — así que esto es una red de seguridad,
 * no una paginación.
 */
const FETCH_LIMIT = 200;

export function buildKnowledgeTool({ supabase }: { supabase: SupabaseClient<Database> }) {
  return tool({
    description:
      "Busca en la biblioteca de conocimiento de SBK Motorcycles: la información oficial que cargó el equipo sobre envíos, formas de pago, garantías, horarios y cualquier otro tema de la tienda que no sea el catálogo de repuestos. Si no devuelve nada, esa información no está cargada — no te la inventes.",
    inputSchema: z.object({
      tema: z
        .string()
        .describe("Qué necesitas saber, ej. 'envíos a Maracaibo', 'formas de pago', 'garantía de repuestos'"),
    }),
    execute: async ({ tema }) => {
      const terms = searchTerms(tema);
      if (terms.length === 0) return { resultados: [] };

      const { data, error } = await supabase
        .from("knowledge_entries")
        .select("title, content, category:knowledge_categories(name)")
        .eq("is_active", true)
        .limit(FETCH_LIMIT);

      if (error) return { resultados: [], error: "No se pudo consultar la biblioteca en este momento." };

      const rows = (data ?? []).map((row) => ({
        title: row.title,
        category: row.category?.name ?? "",
        content: row.content,
      }));

      const top = rankKnowledge(rows, terms).slice(0, MAX_KNOWLEDGE_RESULTS);

      return {
        resultados: top.map((row) => ({
          titulo: row.title,
          categoria: row.category,
          contenido: clipContent(row.content, MAX_CONTENT_CHARS),
        })),
        // Se le dice en palabras qué hacer con el vacío: sin esto, el modelo
        // rellena el hueco con una política que suena razonable y es falsa.
        ...(top.length === 0
          ? {
              instruccionParaTuRespuesta:
                "No hay información cargada sobre ese tema. Dile al cliente que eso te lo confirma un asesor y ofrece pasarle el caso. No inventes políticas, montos ni plazos.",
            }
          : {}),
      };
    },
  });
}
