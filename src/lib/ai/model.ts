import "server-only";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Selección de modelo por variable de entorno: en producción, GPT-5.6 Luna
// (OpenAI, directo, sin gateway); en desarrollo, Gemini 3.1 Flash-Lite. Cambiar
// de modelo o de proveedor es cosa del .env, no del código.
// ---------------------------------------------------------------------------

type AiProvider = "openai" | "google";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

function resolveModelId(): string {
  return process.env.AI_AGENT_MODEL?.trim() || "gpt-5.6-luna";
}

function resolveProvider(modelId: string): AiProvider {
  const configured = process.env.AI_AGENT_PROVIDER?.trim().toLowerCase();
  if (configured === "openai" || configured === "google") return configured;
  return modelId.startsWith("gemini") ? "google" : "openai";
}

interface AgentModel {
  model: LanguageModel;
  providerOptions?: SharedV4ProviderOptions;
}

/** `effort` solo aplica al proveedor OpenAI; Google lo ignora silenciosamente. */
export function getAgentModel(effort: ReasoningEffort = "medium"): AgentModel {
  const modelId = resolveModelId();
  const provider = resolveProvider(modelId);

  if (provider === "google") {
    return { model: google(modelId) };
  }

  return {
    model: openai(modelId),
    providerOptions: { openai: { reasoningEffort: effort } },
  };
}

export function currentAgentModelLabel(): string {
  const modelId = resolveModelId();
  return `${resolveProvider(modelId)}/${modelId}`;
}
