import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelMiddleware } from "ai";

// ---------------------------------------------------------------------------
// T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026).
//
// Hasta esta tarea lo único que decía cuánto costó cada llamada al proveedor
// dentro de un turno era `log.info("turno_tiempos")` (agent.ts) -- un log que
// un deploy de Dokploy destruye (T8 del mismo plan) y que nunca separó una
// llamada de otra: `agent_turns` guarda un ÚNICO total sumado entre 3-7
// llamadas (escenario, clasificar, 1-2 pasos de redacción, la reescritura de
// identidad). El hallazgo 3 del plan y la promesa 7.4 del informe del VPS del
// 21/9/2026 ("maxOutputTokens/toolChoice sin prueba directa") piden lo mismo:
// una fila por LLAMADA, no por turno.
//
// El punto de menor superficie para verlo es el middleware que ya envuelve
// todo modelo (rateLimitMiddleware, rate-limit.ts): `wrapGenerate` recibe los
// `params` que el SDK YA RESOLVIÓ (maxOutputTokens, toolChoice) y devuelve
// `usage`/`finishReason` reales -- nada de esto se infiere, se LEE del mismo
// punto por el que pasa cada llamada real.
//
// `AsyncLocalStorage` (Node, `node:async_hooks`) es el mecanismo: un turno
// abre un registro con `conTelemetriaDeTurno`, y cualquier llamada al
// proveedor que corra DENTRO de esa función -- por más async/paralela que
// sea, `Promise.all` incluido -- puede anotarse en el mismo registro sin que
// nadie tenga que pasarlo a mano por cada capa (matchPlaybook, classifyIntent,
// el tool loop, la reescritura de identidad). Dos turnos concurrentes tienen
// cada uno su propio registro: `AsyncLocalStorage` los aísla por diseño, es
// justo el caso de uso para el que existe.
//
// Orden de los middlewares (ver model.ts, `build()`): `wrapLanguageModel`
// (`node_modules/ai/dist/index.js`, función `wrapLanguageModel`) arma la
// cadena con `[...asArray(middleware)].reverse().reduce(...)` -- con
// `middleware: [rateLimit, telemetry]`, `reverse()` la deja `[telemetry,
// rateLimit]` y el `reduce` envuelve el modelo base primero con `telemetry`
// y DESPUÉS con `rateLimit`: el resultado final es rateLimit POR FUERA,
// telemetry POR DENTRO, pegada al modelo base. Es el orden que hace falta:
// `duration_ms` tiene que medir la llamada real al proveedor, no la espera
// del control de ritmo (que puede dormir hasta 60 s dentro de `conRitmo`,
// rate-limit.ts) -- si telemetry envolviera por fuera, cada fila de
// `agent_turn_calls` incluiría ese sueño y "cuánto tardó el proveedor" dejaría
// de significar eso.
//
// Nunca lanza por su cuenta: esto es observabilidad, y ninguna medición puede
// tumbar la respuesta que está midiendo (mismo criterio que `medir`/
// `toolNamesUsed` en agent.ts). Sin registro activo -- un test viejo que
// llama a `getAgentModel` sin pasar por `conTelemetriaDeTurno`, o
// `api/dev/simulate-message` si algún día invocara el modelo fuera del
// turno -- el middleware no hace nada más que dejar pasar la llamada tal
// cual: `almacen.getStore()` da `undefined` y no hay dónde anotar.
// ---------------------------------------------------------------------------

/**
 * En qué momento del turno se hizo la llamada. Calza EXACTO con el CHECK de
 * `agent_turn_calls.phase` (migración 20260921040000): un valor nuevo acá
 * exige migración antes (ver la trampa de `INTENT_VALUES`/CLAUDE.md,
 * 14/9/2026, mismo mecanismo).
 */
export type AgentTurnCallPhase = "escenario" | "clasificar" | "redactar" | "identidad";

/** Una fila de `agent_turn_calls`, en memoria, antes de que `logTurn` (agent.ts) la escriba. */
export interface AgentTurnCallRecord {
  phase: AgentTurnCallPhase;
  /** Orden de esta llamada dentro del turno completo (1, 2, 3...), no dentro de su fase. */
  sequence: number;
  /** El `params.maxOutputTokens` que de verdad viajó al proveedor en ESTA llamada. `null` sin techo explícito. */
  maxOutputTokens: number | null;
  /** `params.toolChoice` normalizado a texto: `auto`/`none`/`required`/`tool:<nombre>`. `null` sin herramientas ofrecidas. */
  toolChoice: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** `null` cuando el proveedor no separa razonamiento de texto en esta respuesta puntual. */
  reasoningTokens: number | null;
  /** `"error"` es un valor propio del CRM (no del proveedor): `doGenerate` lanzó antes de terminar. */
  finishReason: string | null;
  durationMs: number;
}

interface RegistroDeLlamadas {
  calls: AgentTurnCallRecord[];
}

const almacen = new AsyncLocalStorage<RegistroDeLlamadas>();

/**
 * Abre el registro de llamadas de UN turno y corre `fn` dentro de su
 * contexto. `runAgentTurn` (agent.ts) envuelve su cuerpo entero acá: todo lo
 * que ese turno haga -- fase 0/1 en paralelo, el tool loop, la reescritura de
 * identidad -- queda anotado en el MISMO registro, sin tener que pasarlo a
 * mano por cada función intermedia.
 */
export function conTelemetriaDeTurno<T>(fn: () => Promise<T>): Promise<T> {
  return almacen.run({ calls: [] }, fn);
}

/**
 * Las llamadas anotadas hasta este instante en el turno actual. `logTurn`
 * (agent.ts) la lee UNA vez, justo después de insertar la fila de
 * `agent_turns`, para volcarlas a `agent_turn_calls` con el `turn_id` que
 * acaba de recibir.
 *
 * Fuera de un turno con telemetría activa (tests que no pasan por
 * `conTelemetriaDeTurno`) devuelve `[]`, nunca lanza ni devuelve `undefined`.
 */
export function turnCallsSnapshot(): AgentTurnCallRecord[] {
  return almacen.getStore()?.calls ?? [];
}

/**
 * `params.toolChoice` (`LanguageModelV4ToolChoice`, `@ai-sdk/provider`) es
 * `{type: "auto"|"none"|"required"} | {type: "tool", toolName}`. Se normaliza
 * a texto porque `agent_turn_calls.tool_choice` es una columna de texto, no
 * JSON -- nadie filtra por herramienta individual, solo por "¿fue none?"
 * (7.4 del informe del VPS).
 */
function normalizeToolChoice(toolChoice: unknown): string | null {
  if (typeof toolChoice !== "object" || toolChoice === null) return null;
  const tc = toolChoice as { type?: unknown; toolName?: unknown };
  if (tc.type === "auto" || tc.type === "none" || tc.type === "required") return tc.type;
  if (tc.type === "tool" && typeof tc.toolName === "string") return `tool:${tc.toolName}`;
  return null;
}

/**
 * Construye la fila a partir de los `params` que el SDK resolvió y del
 * resultado (o del error) de `doGenerate`. Función pura, sin acceso al
 * registro -- así se puede probar sin `AsyncLocalStorage` de por medio (ver
 * turn-telemetry.test.ts).
 */
function buildRecord(
  phase: AgentTurnCallPhase,
  sequence: number,
  params: { maxOutputTokens?: number; toolChoice?: unknown },
  resultado:
    | { ok: true; usage: { inputTokens?: { total?: number; cacheRead?: number }; outputTokens?: { total?: number; reasoning?: number } }; finishReason?: { unified?: string; raw?: string } }
    | { ok: false },
  durationMs: number
): AgentTurnCallRecord {
  const base = {
    phase,
    sequence,
    maxOutputTokens: params.maxOutputTokens ?? null,
    toolChoice: normalizeToolChoice(params.toolChoice),
    durationMs,
  };

  if (!resultado.ok) {
    // input_tokens/output_tokens/cached_input_tokens nacen NOT NULL DEFAULT 0
    // en la base (migración 20260921040000): una llamada que nunca terminó no
    // tiene tokens que contar, y `0` es más honesto que forzar a cada `sum()`
    // de las RPC a manejar un `null` que acá no distingue nada útil.
    return {
      ...base,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: null,
      finishReason: "error",
    };
  }

  const { usage, finishReason } = resultado;
  return {
    ...base,
    inputTokens: usage.inputTokens?.total ?? 0,
    outputTokens: usage.outputTokens?.total ?? 0,
    cachedInputTokens: usage.inputTokens?.cacheRead ?? 0,
    reasoningTokens: usage.outputTokens?.reasoning ?? null,
    finishReason: finishReason?.unified ?? finishReason?.raw ?? null,
  };
}

/**
 * Anota una llamada en el registro del turno ACTIVO, si hay uno. Nunca
 * lanza: un fallo armando la fila de telemetría no puede tumbar la respuesta
 * real que ya salió (o que ya falló) del lado del proveedor.
 */
function registrar(record: AgentTurnCallRecord): void {
  try {
    const registro = almacen.getStore();
    if (!registro) return;
    registro.calls.push(record);
  } catch {
    // Defensivo a propósito, igual que `toolNamesUsed` (agent.ts): esto es
    // telemetría, no puede llevarse por delante nada más.
  }
}

/**
 * El middleware en sí. Se compone en `build()` (model.ts) para CADA modelo
 * que sale de ahí, con la `phase` que corresponde a ese punto de llamada
 * (`getAgentModel`/`getClassifierModel`, ver model.ts).
 */
export function telemetryMiddleware(phase: AgentTurnCallPhase): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const registro = almacen.getStore();
      // Sin turno activo, ni vale la pena cronometrar: se deja pasar tal
      // cual, como si el middleware no existiera.
      if (!registro) return doGenerate();

      const t0 = Date.now();
      try {
        const result = await doGenerate();
        registrar(
          buildRecord(
            phase,
            registro.calls.length + 1,
            params,
            { ok: true, usage: result.usage, finishReason: result.finishReason },
            Date.now() - t0
          )
        );
        return result;
      } catch (err) {
        registrar(buildRecord(phase, registro.calls.length + 1, params, { ok: false }, Date.now() - t0));
        throw err;
      }
    },
  };
}
