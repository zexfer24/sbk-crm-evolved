import "server-only";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { rateLimitMiddleware } from "@/lib/ai/rate-limit";
import { telemetryMiddleware, type AgentTurnCallPhase } from "@/lib/ai/turn-telemetry";

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
// `AI_AGENT_REASONING` (S6, corrida "La IA ve lo que llega", 8/9/2026;
// CORREGIDO T5, plan "Nada se pierde en un corte ni en un deploy",
// 21-22/9/2026, hallazgo 6): el comentario de acá decía que `gpt-5.6-luna`
// NO razona. Es FALSO -- se midió lo contrario el 21/9/2026 contra
// `agent_turns.reasoning_tokens`: 58,5 % de la salida del modelo es
// razonamiento. `@ai-sdk/openai@4.0.43` (el SDK instalado, no el que avisaba
// el warning del 8/9 -- esa era otra versión) decide `isReasoningModel` con
// una regex sobre el id (`getOpenAILanguageModelCapabilities`,
// `node_modules/@ai-sdk/openai/dist/index.js:53`: `gptVersion != null &&
// gptVersion.major >= 5 && !isGptChatModel` -- "gpt-5.6-luna" tiene major 5,
// así que da `true`) y habla por la Responses API. Con `AI_AGENT_REASONING
// = off` (producción) no viaja NADA de `providerOptions`, y el proveedor
// razona con SU propio default (medium, según la documentación de OpenAI) --
// "off" apaga el PARÁMETRO que este código manda, no el razonamiento del
// modelo. Para apagarlo de verdad hace falta mandar `reasoningEffort: "none"`
// expresamente: el SDK lo traduce a `reasoning: { effort: "none" }` en el
// cuerpo de la Responses API (`dist/index.js:6408-6423`, el bloque
// `...isReasoningModel && (resolvedReasoningEffort != null || …) && {
// reasoning: { ...resolvedReasoningEffort != null && { effort:
// resolvedReasoningEffort } … } }`). De ahí el valor nuevo `none` de esta
// variable: `off` sigue sin mandar nada (el proveedor decide), `none` manda
// el "none" explícito, y todo lo demás (ausente/`on`/basura) sigue mandando
// el `effort` de siempre (`medium`/`low`) -- el operador decide cuál usar en
// Dokploy después de leer `agent_turn_calls.reasoning_tokens` por fase (T4
// del mismo plan). La variable sigue gobernando el PROCESO, no el nombre del
// modelo: la decisión es de `.env`, no una heurística sobre el id acá.
// ---------------------------------------------------------------------------

type AiProvider = "openai" | "google";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/**
 * Tres estados, no dos (T5, plan "Nada se pierde en un corte ni en un
 * deploy", 21-22/9/2026): `off` sigue sin mandar `providerOptions` --el
 * proveedor razona con su propio default, ver el comentario de cabecera--,
 * `none` manda el apagado EXPLÍCITO (`reasoningEffort: "none"`, que el SDK
 * traduce a `reasoning: { effort: "none" }`), y cualquier otra cosa (falta
 * la variable, `on`, o basura tipo "Off"/"0"/vacío con espacios) sigue
 * mandando el `effort` de siempre -- un typo no puede apagar silenciosamente
 * algo que sí se quería mandar.
 */
function reasoningMode(): "off" | "none" | "on" {
  const valor = process.env.AI_AGENT_REASONING?.trim().toLowerCase();
  if (valor === "off") return "off";
  if (valor === "none") return "none";
  return "on";
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
  /**
   * Qué fase del turno pide este modelo. Va, sin cambios, al control de ritmo
   * (`RitmoOptions.fase`, rate-limit.ts, solo para sus registros) Y al
   * middleware de telemetría (T4, plan "Nada se pierde en un corte ni en un
   * deploy", 21-22/9/2026) como el `phase` de cada fila de
   * `agent_turn_calls` -- por eso el tipo pasa de `string` a
   * `AgentTurnCallPhase`: las cuatro fases que reconoce el CHECK de la base
   * son EXACTAMENTE las cuatro que hoy pasan por acá (escenario, clasificar,
   * redactar, identidad).
   */
  fase: AgentTurnCallPhase;
  reintentos?: number;
  /** Override explícito del proveedor. Solo lo usa el agente. */
  providerOverride?: string;
}

function build(modelId: string, effort: ReasoningEffort, options: BuildOptions): AgentModel {
  const provider = resolveProvider(modelId, options.providerOverride);
  // Orden del arreglo: ver la cabecera de turn-telemetry.ts para por qué
  // `rateLimit` va PRIMERO (queda por FUERA tras `wrapLanguageModel`) y
  // `telemetry` va SEGUNDO (queda por DENTRO, pegada al modelo base) --
  // `duration_ms` tiene que medir la llamada real al proveedor, no la espera
  // del control de ritmo.
  const middleware = [
    rateLimitMiddleware({ fase: options.fase, reintentos: options.reintentos }),
    telemetryMiddleware(options.fase),
  ];

  if (provider === "google") {
    return { model: wrapLanguageModel({ model: google(modelId), middleware }) };
  }

  const model = wrapLanguageModel({ model: openai(modelId), middleware });

  const modo = reasoningMode();

  // `off`: sin `providerOptions` -- el proveedor razona con su propio
  // default, este código no manda ningún parámetro (ver cabecera).
  if (modo === "off") return { model };

  // `none`: apagado EXPLÍCITO, pisa el `effort` que haya pedido el
  // llamador (medium/low) -- es la única forma real de apagar el
  // razonamiento de Luna, ver cabecera y hallazgo 6 del plan del 21/9/2026.
  const effortFinal = modo === "none" ? "none" : effort;

  return { model, providerOptions: { openai: { reasoningEffort: effortFinal } } };
}

/**
 * Modelo que redacta y usa herramientas. `effort` solo aplica al proveedor
 * OpenAI, y solo con `AI_AGENT_REASONING` ausente/`on`/basura (default); con
 * `off` no viaja ningún `providerOptions` (el proveedor decide su propio
 * default), con `none` viaja el apagado explícito pisando `effort`, y con
 * Google —que ignora `providerOptions` silenciosamente— tampoco viaja nada.
 *
 * Sin reintentos ante rate limit: este es el camino que termina en un envío al
 * cliente, y repetirlo sin clave de idempotencia arriesga un duplicado. Un
 * turno que se queda sin cuota acá falla y lo retoma la cola.
 *
 * `fase` (T4, plan "Nada se pierde en un corte ni en un deploy", 21-22/9/2026):
 * `"redactar"` de fábrica -- el tool loop, que es quien llama esto sin
 * segundo argumento -- pero `applyIdentityGuard` (agent.ts) también pasa por
 * acá con `effort: "low"` para su ÚNICA reescritura, y esa llamada no es
 * "redactar" para la telemetría: es su propia fase (`"identidad"`). Sin este
 * parámetro, esa fila se habría anotado como una llamada más del tool loop,
 * mezclando dos cosas que `agent_turn_calls.phase` (el CHECK de la base)
 * distingue a propósito.
 */
export function getAgentModel(effort: ReasoningEffort = "medium", fase: AgentTurnCallPhase = "redactar"): AgentModel {
  return build(resolveModelId(), effort, {
    fase,
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
export function getClassifierModel(fase: AgentTurnCallPhase): AgentModel {
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
