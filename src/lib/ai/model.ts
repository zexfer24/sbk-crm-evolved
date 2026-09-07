import "server-only";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { rateLimitMiddleware } from "@/lib/ai/rate-limit";

// ---------------------------------------------------------------------------
// Selección de modelo por variable de entorno: en producción, GPT-5.6 Luna
// por un proveedor OpenAI-COMPATIBLE vía `OPENAI_BASE_URL` (hoy OpenRouter,
// no OpenAI directo — el comentario que decía "directo, sin gateway" mentía:
// el corte del 7/9/2026 a las 11:57 UTC fue `getaddrinfo EAI_AGAIN
// openrouter.ai`, no un problema de OpenAI); en desarrollo, Gemini 3.1
// Flash-Lite. Cambiar de modelo o de proveedor es cosa del .env, no del
// código.
//
// Todo modelo que sale de acá va envuelto en el control de ritmo
// (ver rate-limit.ts). Es el único punto donde se construye un modelo, así
// que es el único punto donde hay que imponerlo: no hay forma de conseguir un
// modelo sin freno sin escribir una línea nueva acá.
//
// `AI_AGENT_REASONING` (S6, corrida "La IA ve lo que llega", 8/9/2026):
// `gpt-5.6-luna`, el modelo real de producción, NO razona -- es un alias de
// OpenRouter sin soporte para `reasoningEffort`, y `build()` se lo mandaba
// de todas formas a TODO modelo del proveedor OpenAI. El AI SDK avisaba
// `The feature "reasoningEffort" is not supported` 3-4 veces por turno (una
// por llamada: reconocimiento de escenario, clasificación de intención,
// redacción) y el esfuerzo configurado nunca se aplicaba -- el warning era
// ruido, pero el silencio de fondo era que la perilla no hacía nada. La
// variable gobierna el proceso completo, no el nombre del modelo: un
// `gpt-5.6-luna` no razona hoy, pero un `gpt-5.6` a secas sí podría, así que
// decidir por heurística sobre el id habría sido adivinar.
// ---------------------------------------------------------------------------

type AiProvider = "openai" | "google";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/**
 * `on` por default: falta la variable, o trae cualquier cosa que no sea
 * exactamente `"off"`, y el esfuerzo se manda igual que siempre. Solo un
 * `"off"` explícito lo apaga -- así un typo en el .env ("Off", "0", vacío)
 * no apaga silenciosamente algo que sí se quería mandar.
 */
function reasoningEnabled(): boolean {
  return process.env.AI_AGENT_REASONING?.trim().toLowerCase() !== "off";
}

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

  const model = wrapLanguageModel({ model: openai(modelId), middleware });

  // Sin `providerOptions` con `AI_AGENT_REASONING=off`: hoy el modelo de
  // producción (Luna, vía OpenRouter) no soporta `reasoningEffort`, y
  // mandarlo igual solo producía el warning del AI SDK sin aplicar nada.
  if (!reasoningEnabled()) return { model };

  return { model, providerOptions: { openai: { reasoningEffort: effort } } };
}

/**
 * Modelo que redacta y usa herramientas. `effort` solo aplica al proveedor
 * OpenAI, y solo con `AI_AGENT_REASONING` en `on` (default); con `off` -- o
 * con Google, que lo ignora silenciosamente -- no viaja ningún
 * `providerOptions`.
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
