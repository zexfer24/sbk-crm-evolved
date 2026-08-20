import "server-only";
import { generateObject, type LanguageModelUsage, type ModelMessage } from "ai";
import { getAgentModel } from "@/lib/ai/model";
import { CLASSIFY_PROMPT } from "@/lib/ai/prompt";

export const INTENT_VALUES = ["consulta_disponibilidad", "devolucion", "queja", "otro"] as const;
export type Intent = (typeof INTENT_VALUES)[number];

export interface ClassifyResult {
  intent: Intent;
  usage: LanguageModelUsage;
}

/** Fase A del turno: clasificación obligatoria, barata y rápida — separada del agente que actúa. */
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
