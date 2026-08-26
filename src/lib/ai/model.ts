import "server-only";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { rateLimitMiddleware } from "@/lib/ai/rate-limit";

// ---------------------------------------------------------------------------
// Selección de modelo por variable de entorno: en producción, GPT-5.6 Luna
// (OpenAI, directo, sin gateway); en desarrollo, Gemini 3.1 Flash-Lite. Cambiar
// de modelo o de proveedor es cosa del .env, no del código.
//
// Todo modelo que sale de acá va envuelto en el control de ritmo
// (ver rate-limit.ts). Es el único punto donde se construye un modelo, así
// que es el único punto donde hay que imponerlo: no hay forma de conseguir un
// modelo sin freno sin escribir una línea nueva acá.
// ---------------------------------------------------------------------------

type AiProvider = "openai" | "google";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

function resolveModelId(): string {
  return process.env.AI_AGENT_MODEL?.trim() || "gpt-5.6-luna";
}

/**
 * Modelo de las dos fases de clasificación (escenario e intención).
 *
 * Vacío = el del agente, que es lo que corre hoy. Existe para que mover SOLO
 * la clasificación a otro modelo —lo previsto: un flash-lite, más barato y con
 * otro techo de ritmo— sea una línea de .env y no un cambio de código.
 */
function resolveClassifierModelId(): string | null {
  return process.env.AI_CLASSIFIER_MODEL?.trim() || null;
}

/**
 * `AI_AGENT_PROVIDER` es un override del proveedor DEL AGENTE, y por eso no se
 * aplica a un modelo de clasificación puesto aparte.
 *
 * Sin esta distinción la costura no servía para lo que existe: producción
 * tiene `AI_AGENT_PROVIDER=openai` fijo, así que poner
 * `AI_CLASSIFIER_MODEL=gemini-3.1-flash-lite` habría construido
 * `openai("gemini-3.1-flash-lite")` — el cambio de una línea habrían sido dos,
 * y la segunda se descubre en producción.
 */
function resolveProvider(modelId: string, override?: string): AiProvider {
  const configured = override?.trim().toLowerCase();
  if (configured === "openai" || configured === "google") return configured;
  return modelId.startsWith("gemini") ? "google" : "openai";
}

interface AgentModel {
  model: LanguageModel;
  providerOptions?: SharedV4ProviderOptions;
}

interface BuildOptions {
  fase: string;
  reintentos?: number;
  /** Override explícito del proveedor. Solo lo usa el agente. */
  providerOverride?: string;
}

function build(modelId: string, effort: ReasoningEffort, options: BuildOptions): AgentModel {
  const provider = resolveProvider(modelId, options.providerOverride);
  const middleware = rateLimitMiddleware({ fase: options.fase, reintentos: options.reintentos });

  if (provider === "google") {
    return { model: wrapLanguageModel({ model: google(modelId), middleware }) };
  }

  return {
    model: wrapLanguageModel({ model: openai(modelId), middleware }),
    providerOptions: { openai: { reasoningEffort: effort } },
  };
}

/**
 * Modelo que redacta y usa herramientas. `effort` solo aplica al proveedor
 * OpenAI; Google lo ignora silenciosamente.
 *
 * Sin reintentos ante rate limit: este es el camino que termina en un envío al
 * cliente, y repetirlo sin clave de idempotencia arriesga un duplicado. Un
 * turno que se queda sin cuota acá falla y lo retoma la cola.
 */
export function getAgentModel(effort: ReasoningEffort = "medium"): AgentModel {
  return build(resolveModelId(), effort, {
    fase: "redactar",
    providerOverride: process.env.AI_AGENT_PROVIDER,
  });
}

/**
 * Modelo de clasificación. Esfuerzo bajo: devuelve una palabra de un enum, y
 * razonar de más solo agrega tokens facturables y latencia.
 *
 * Este SÍ reintenta ante rate limit, con backoff en segundos: clasificar no le
 * manda nada al cliente, así que repetirlo no puede duplicar nada. Es la única
 * fase del turno donde reintentar es seguro.
 */
export function getClassifierModel(fase: string): AgentModel {
  const propio = resolveClassifierModelId();

  // Sin modelo propio de clasificación se usa el del agente TAL CUAL, override
  // de proveedor incluido: es literalmente el mismo modelo, y es lo que corre
  // hoy. Con modelo propio, el proveedor sale del prefijo de su id.
  return propio === null
    ? build(resolveModelId(), "low", { fase, reintentos: 2, providerOverride: process.env.AI_AGENT_PROVIDER })
    : build(propio, "low", { fase, reintentos: 2 });
}

export function currentAgentModelLabel(): string {
  const modelId = resolveModelId();
  return `${resolveProvider(modelId, process.env.AI_AGENT_PROVIDER)}/${modelId}`;
}
