import { describe, expect, it } from "vitest";
import { conTelemetriaDeTurno, telemetryMiddleware, turnCallsSnapshot } from "@/lib/ai/turn-telemetry";

// ---------------------------------------------------------------------------
// T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026).
//
// Lo que hay que probar acá NO es que el SDK de IA funcione: es que el
// middleware lee los `params` que el SDK YA resolvió (no los infiere) y los
// vuelca al registro del turno activo, sin romper nunca la llamada real que
// está midiendo -- ni cuando no hay ningún turno escuchando, ni cuando la
// llamada al proveedor falla.
// ---------------------------------------------------------------------------

/**
 * Forma real de `LanguageModelV4GenerateResult` (@ai-sdk/provider), recortada
 * a lo que el middleware lee. `as never`: la forma completa exige un
 * `finishReason.unified` de un enum cerrado y un puñado de campos más que
 * ningún test de acá necesita fijar — el middleware solo lee `usage` y
 * `finishReason`, así que fingir el resto con precisión no prueba nada de
 * más.
 */
function fakeResult(overrides: {
  inputTotal?: number;
  inputCacheRead?: number;
  outputTotal?: number;
  outputReasoning?: number;
  finishUnified?: string;
  finishRaw?: string;
}) {
  return {
    content: [],
    warnings: [],
    finishReason: { unified: overrides.finishUnified, raw: overrides.finishRaw },
    usage: {
      inputTokens: { total: overrides.inputTotal, noCache: undefined, cacheRead: overrides.inputCacheRead, cacheWrite: undefined },
      outputTokens: { total: overrides.outputTotal, text: undefined, reasoning: overrides.outputReasoning },
    },
  } as never;
}

describe("telemetryMiddleware — con un turno activo", () => {
  it("registra maxOutputTokens, toolChoice, usage y finishReason de una llamada exitosa", async () => {
    const registradas = await conTelemetriaDeTurno(async () => {
      const middleware = telemetryMiddleware("redactar");
      await middleware.wrapGenerate!({
        doGenerate: async () =>
          fakeResult({ inputTotal: 500, inputCacheRead: 120, outputTotal: 80, outputReasoning: 30, finishUnified: "stop", finishRaw: "stop" }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { maxOutputTokens: 1500, toolChoice: { type: "none" }, prompt: [] } as never,
        model: {} as never,
      });
      return turnCallsSnapshot();
    });

    expect(registradas).toHaveLength(1);
    const [fila] = registradas;
    expect(fila.phase).toBe("redactar");
    expect(fila.sequence).toBe(1);
    expect(fila.maxOutputTokens).toBe(1500);
    expect(fila.toolChoice).toBe("none");
    expect(fila.inputTokens).toBe(500);
    expect(fila.cachedInputTokens).toBe(120);
    expect(fila.outputTokens).toBe(80);
    expect(fila.reasoningTokens).toBe(30);
    expect(fila.finishReason).toBe("stop");
    expect(fila.durationMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * `params.toolChoice` (`LanguageModelV4ToolChoice`, @ai-sdk/provider) trae
   * cuatro formas más "sin herramientas ofrecidas" (undefined). La columna
   * `agent_turn_calls.tool_choice` es texto, no JSON -- de ahí la
   * normalización.
   */
  it.each([
    [{ type: "auto" }, "auto"],
    [{ type: "none" }, "none"],
    [{ type: "required" }, "required"],
    [{ type: "tool", toolName: "buscarRepuesto" }, "tool:buscarRepuesto"],
    [undefined, null],
  ] as const)("normaliza toolChoice %o a %s", async (toolChoice, esperado) => {
    const registradas = await conTelemetriaDeTurno(async () => {
      const middleware = telemetryMiddleware("redactar");
      await middleware.wrapGenerate!({
        doGenerate: async () => fakeResult({ inputTotal: 10, outputTotal: 5, finishUnified: "stop" }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { toolChoice, prompt: [] } as never,
        model: {} as never,
      });
      return turnCallsSnapshot();
    });

    expect(registradas[0].toolChoice).toBe(esperado);
  });

  /** Sin `maxOutputTokens` en los params (escenario/clasificar/identidad no siempre lo traen). */
  it("maxOutputTokens queda null cuando el params no lo trae", async () => {
    const registradas = await conTelemetriaDeTurno(async () => {
      const middleware = telemetryMiddleware("clasificar");
      await middleware.wrapGenerate!({
        doGenerate: async () => fakeResult({ inputTotal: 10, outputTotal: 5, finishUnified: "stop" }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });
      return turnCallsSnapshot();
    });

    expect(registradas[0].maxOutputTokens).toBeNull();
  });

  /**
   * El proveedor no siempre separa razonamiento del texto: `reasoningTokens`
   * queda `null` (no `0`) para distinguir "no se sabe" de "se midió y dio
   * cero" -- mismo criterio que documenta la migración 20260921040000.
   */
  it("reasoningTokens queda null cuando el proveedor no lo reporta separado", async () => {
    const registradas = await conTelemetriaDeTurno(async () => {
      const middleware = telemetryMiddleware("redactar");
      await middleware.wrapGenerate!({
        doGenerate: async () => fakeResult({ inputTotal: 10, outputTotal: 5, finishUnified: "stop" }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });
      return turnCallsSnapshot();
    });

    expect(registradas[0].reasoningTokens).toBeNull();
  });

  it("cae al finishReason.raw si .unified viene vacío, y a null si tampoco hay raw", async () => {
    const registradas = await conTelemetriaDeTurno(async () => {
      const middleware = telemetryMiddleware("redactar");
      await middleware.wrapGenerate!({
        doGenerate: async () => fakeResult({ inputTotal: 1, outputTotal: 1, finishRaw: "content_filter_bruto" }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });
      return turnCallsSnapshot();
    });

    expect(registradas[0].finishReason).toBe("content_filter_bruto");
  });

  /**
   * `doGenerate` lanza (proveedor caído, rate limit agotado, lo que sea): el
   * middleware anota la fila con `finish_reason: "error"` y tokens en 0
   * (nunca null -- input/output/cached nacen NOT NULL DEFAULT 0 en la base),
   * y SIEMPRE relanza -- una llamada que falló no puede parecer exitosa para
   * quien llama (el tool loop, `classifyIntent`, `applyIdentityGuard`).
   */
  it("si doGenerate lanza, anota finish_reason: 'error' con tokens en 0 y relanza el error original", async () => {
    const boom = new Error("el proveedor está caído");
    let capturado: unknown;

    const registradas = await conTelemetriaDeTurno(async () => {
      const middleware = telemetryMiddleware("redactar");
      try {
        await middleware.wrapGenerate!({
          doGenerate: async () => {
            throw boom;
          },
          doStream: async () => {
            throw new Error("no se usa en este test");
          },
          params: { maxOutputTokens: 1500, toolChoice: { type: "auto" }, prompt: [] } as never,
          model: {} as never,
        });
      } catch (err) {
        capturado = err;
      }
      return turnCallsSnapshot();
    });

    expect(capturado).toBe(boom);
    expect(registradas).toHaveLength(1);
    expect(registradas[0]).toMatchObject({
      phase: "redactar",
      finishReason: "error",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: null,
      maxOutputTokens: 1500,
      toolChoice: "auto",
    });
  });

  it("la sequence crece con cada llamada del mismo turno, en el orden en que terminan", async () => {
    const registradas = await conTelemetriaDeTurno(async () => {
      const escenario = telemetryMiddleware("escenario");
      const clasificar = telemetryMiddleware("clasificar");
      const redactar = telemetryMiddleware("redactar");

      await escenario.wrapGenerate!({
        doGenerate: async () => fakeResult({ inputTotal: 1, outputTotal: 1, finishUnified: "stop" }),
        doStream: async () => {
          throw new Error("no se usa");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });
      await clasificar.wrapGenerate!({
        doGenerate: async () => fakeResult({ inputTotal: 1, outputTotal: 1, finishUnified: "stop" }),
        doStream: async () => {
          throw new Error("no se usa");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });
      await redactar.wrapGenerate!({
        doGenerate: async () => fakeResult({ inputTotal: 1, outputTotal: 1, finishUnified: "stop" }),
        doStream: async () => {
          throw new Error("no se usa");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });

      return turnCallsSnapshot();
    });

    expect(registradas.map((f) => [f.phase, f.sequence])).toEqual([
      ["escenario", 1],
      ["clasificar", 2],
      ["redactar", 3],
    ]);
  });
});

describe("telemetryMiddleware — sin turno activo", () => {
  /**
   * Tests viejos que llaman al modelo sin pasar por `runAgentTurn`
   * (`conTelemetriaDeTurno`), o cualquier llamada futura fuera de un turno
   * real (`api/dev/simulate-message` si algún día invocara el modelo
   * directo): el middleware no puede exigir un registro que no existe.
   */
  it("deja pasar la llamada igual y no lanza ni anota nada", async () => {
    const middleware = telemetryMiddleware("redactar");
    const resultado = await middleware.wrapGenerate!({
      doGenerate: async () => fakeResult({ inputTotal: 10, outputTotal: 5, finishUnified: "stop" }),
      doStream: async () => {
        throw new Error("no se usa en este test");
      },
      params: { prompt: [] } as never,
      model: {} as never,
    });

    expect(resultado.usage.inputTokens.total).toBe(10);
    expect(turnCallsSnapshot()).toEqual([]);
  });

  it("un doGenerate que lanza sin turno activo relanza igual, sin nada que anotar", async () => {
    const boom = new Error("proveedor caído");
    const middleware = telemetryMiddleware("redactar");

    await expect(
      middleware.wrapGenerate!({
        doGenerate: async () => {
          throw boom;
        },
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      })
    ).rejects.toBe(boom);

    expect(turnCallsSnapshot()).toEqual([]);
  });
});

describe("conTelemetriaDeTurno — dos turnos concurrentes no se mezclan", () => {
  it("cada `run` en paralelo ve solo sus propias llamadas", async () => {
    async function turno(fase: "escenario" | "redactar", cantidad: number) {
      return conTelemetriaDeTurno(async () => {
        const middleware = telemetryMiddleware(fase);
        for (let i = 0; i < cantidad; i++) {
          await middleware.wrapGenerate!({
            doGenerate: async () => {
              // Un `setTimeout(0)` real para forzar que las dos ejecuciones
              // se entrelacen de verdad en el event loop, no que una termine
              // antes de que la otra arranque.
              await new Promise((resolve) => setTimeout(resolve, 0));
              return fakeResult({ inputTotal: 1, outputTotal: 1, finishUnified: "stop" });
            },
            doStream: async () => {
              throw new Error("no se usa");
            },
            params: { prompt: [] } as never,
            model: {} as never,
          });
        }
        return turnCallsSnapshot();
      });
    }

    const [resultadoA, resultadoB] = await Promise.all([turno("escenario", 2), turno("redactar", 3)]);

    expect(resultadoA).toHaveLength(2);
    expect(resultadoA.every((f) => f.phase === "escenario")).toBe(true);
    // sequence es por TURNO, no global: cada uno arranca en 1 sin importar
    // cuántas llamadas haya hecho el otro turno mientras tanto.
    expect(resultadoA.map((f) => f.sequence)).toEqual([1, 2]);

    expect(resultadoB).toHaveLength(3);
    expect(resultadoB.every((f) => f.phase === "redactar")).toBe(true);
    expect(resultadoB.map((f) => f.sequence)).toEqual([1, 2, 3]);
  });
});

describe("turnCallsSnapshot — fuera de cualquier turno", () => {
  it("devuelve un arreglo vacío, nunca undefined ni lanza", () => {
    expect(turnCallsSnapshot()).toEqual([]);
  });
});
