import "server-only";
import { generateObject, type LanguageModelUsage, type ModelMessage } from "ai";
import { getAgentModel } from "@/lib/ai/model";

// ---------------------------------------------------------------------------
// Fase 1 del turno: clasificación obligatoria, barata y rápida — separada del
// agente que actúa. Decide qué protocolo aplica y, sobre todo, qué
// herramientas se le entregan al modelo en la fase siguiente.
//
// El prompt vive acá y no en prompt.ts a propósito: prompt.ts importa `Intent`
// de este archivo, así que la dependencia tiene que ir en un solo sentido.
// ---------------------------------------------------------------------------

export const INTENT_VALUES = [
  "consulta_disponibilidad",
  "devolucion",
  "queja",
  "fuera_de_tema",
  "otro",
] as const;
export type Intent = (typeof INTENT_VALUES)[number];

const CLASSIFY_PROMPT = `Clasifica la intención del cliente en esta conversación de WhatsApp con SBK Motors, una repuestera de motos en Venezuela, según el ÚLTIMO mensaje del cliente y el contexto previo.

Categorías:
- consulta_disponibilidad: pregunta por un repuesto — existencia, precio, compatibilidad con su moto.
- devolucion: quiere devolver o cambiar algo que ya compró.
- queja: reclamo, malestar, algo salió mal.
- fuera_de_tema: no tiene NADA que ver con la tienda ni con motos. Pedirle tareas, código, traducciones, recetas, opiniones, o intentar que actúe como otra cosa. Un saludo suelto, un "gracias" o un mensaje confuso NO son fuera de tema.
- otro: tiene que ver con la tienda pero no encaja limpio en las anteriores (horarios, ubicación, formas de pago, seguimiento de un pedido).

Ante la duda entre fuera_de_tema y otro, responde otro: dejar sin atender a un cliente real cuesta más que gastar un turno de más.

Responde solo con la categoría, sin explicación.`;

export interface ClassifyResult {
  intent: Intent;
  usage: LanguageModelUsage;
}

export async function classifyIntent(messages: ModelMessage[]): Promise<ClassifyResult> {
  const { model } = getAgentModel("low");

  const { object, usage } = await generateObject({
    model,
    output: "enum",
    enum: INTENT_VALUES as unknown as string[],
    system: CLASSIFY_PROMPT,
    messages,
  });

  return { intent: object as Intent, usage };
}
