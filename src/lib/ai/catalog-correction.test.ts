import { beforeEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.fn();
vi.mock("@/lib/log", async () => {
  // `errorText` es la real (la trampa de `[object Object]`); solo se espía el log.
  const actual = await vi.importActual<typeof import("@/lib/log")>("@/lib/log");
  return { ...actual, log: { ...actual.log, warn: (...args: unknown[]) => logWarn(...args) } };
});

import { corregirTerminos, describirCorreccion } from "@/lib/ai/catalog-correction";

/**
 * T2 del plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026). El corrector vive en SQL (`corregir_terminos`,
 * migración 20260928020000, su test es `supabase/tests/corregir_terminos.sql`);
 * acá se prueba el envoltorio: llama a la RPC con los nombres de parámetro
 * correctos, NUNCA lanza (un corrector caído no puede tumbar el turno) y
 * `describirCorreccion` arma la frase que Seba le dice al cliente.
 */

interface LlamadaRpc {
  nombre: string;
  args: unknown;
}

function supabaseFalso(respuesta: { data?: unknown; error?: unknown; lanza?: unknown }) {
  const llamadas: LlamadaRpc[] = [];
  const cliente = {
    rpc(nombre: string, args: unknown) {
      llamadas.push({ nombre, args });
      if (respuesta.lanza !== undefined) return Promise.reject(respuesta.lanza);
      return Promise.resolve({ data: respuesta.data ?? null, error: respuesta.error ?? null });
    },
  };
  return { cliente: cliente as unknown as Parameters<typeof corregirTerminos>[0], llamadas };
}

describe("corregirTerminos", () => {
  beforeEach(() => logWarn.mockClear());

  it("llama a corregir_terminos con los términos y los protegidos, y devuelve lo corregido", async () => {
    const { cliente, llamadas } = supabaseFalso({ data: [{ original: "iphone", corregido: "ipone" }] });

    const resultado = await corregirTerminos(cliente, ["iphone", "aceite"], ["beta", "bera"]);

    expect(llamadas).toEqual([
      { nombre: "corregir_terminos", args: { p_terminos: ["iphone", "aceite"], p_protegidos: ["beta", "bera"] } },
    ]);
    expect(resultado).toEqual([{ original: "iphone", corregido: "ipone" }]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("sin términos no llama a la base", async () => {
    const { cliente, llamadas } = supabaseFalso({ data: [] });

    expect(await corregirTerminos(cliente, [], ["beta"])).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  it("un error de la base devuelve [] y deja correccion_terminos_fallida con el texto real del error", async () => {
    const { cliente } = supabaseFalso({
      error: { code: "42883", message: "function levenshtein(text, text) does not exist" },
    });

    expect(await corregirTerminos(cliente, ["horsen"], [], "conv-1")).toEqual([]);

    expect(logWarn).toHaveBeenCalledTimes(1);
    const [evento, campos] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(evento).toBe("correccion_terminos_fallida");
    expect(campos.conversationId).toBe("conv-1");
    // errorText, no "[object Object]".
    expect(campos.detail).toBe("42883: function levenshtein(text, text) does not exist");
  });

  it("una excepción (red caída antes de resolver {data,error}) también devuelve []", async () => {
    const { cliente } = supabaseFalso({ lanza: new Error("fetch failed") });

    expect(await corregirTerminos(cliente, ["horsen"], [])).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith("correccion_terminos_fallida", expect.objectContaining({ detail: "fetch failed" }));
  });

  it("descarta filas mal formadas en lugar de propagarlas", async () => {
    const { cliente } = supabaseFalso({
      data: [{ original: "iphone", corregido: "ipone" }, { original: "x" }, null, { original: "", corregido: "y" }],
    });

    expect(await corregirTerminos(cliente, ["iphone", "x", "y"], [])).toEqual([{ original: "iphone", corregido: "ipone" }]);
  });

  it("una respuesta que no es un arreglo devuelve []", async () => {
    const { cliente } = supabaseFalso({ data: { original: "iphone", corregido: "ipone" } });

    expect(await corregirTerminos(cliente, ["iphone"], [])).toEqual([]);
  });
});

describe("describirCorreccion", () => {
  it("una corrección: busqué IPONE en lugar de iphone", () => {
    expect(describirCorreccion([{ original: "iphone", corregido: "ipone" }])).toBe("busqué IPONE en lugar de iphone");
  });

  it("dos correcciones se unen con 'y'", () => {
    expect(
      describirCorreccion([
        { original: "iphone", corregido: "ipone" },
        { original: "horsen", corregido: "horse" },
      ])
    ).toBe("busqué IPONE en lugar de iphone y HORSE en lugar de horsen");
  });

  it("tres o más: comas y 'y' antes de la última", () => {
    expect(
      describirCorreccion([
        { original: "iphone", corregido: "ipone" },
        { original: "horsen", corregido: "horse" },
        { original: "tisum", corregido: "timsun" },
      ])
    ).toBe("busqué IPONE en lugar de iphone, HORSE en lugar de horsen y TIMSUN en lugar de tisum");
  });

  it("sin correcciones devuelve cadena vacía", () => {
    expect(describirCorreccion([])).toBe("");
  });
});
