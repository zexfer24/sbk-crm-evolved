import { beforeEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.fn();
vi.mock("@/lib/log", async () => {
  // `errorText` es la real (la trampa de `[object Object]`); solo se espía el log.
  const actual = await vi.importActual<typeof import("@/lib/log")>("@/lib/log");
  return { ...actual, log: { ...actual.log, warn: (...args: unknown[]) => logWarn(...args) } };
});

import { corregirTerminos, describirCorreccion, diagnosticarTerminos } from "@/lib/ai/catalog-correction";

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

  it("llama a corregir_terminos con términos, protegidos, marcas y excluidos, y devuelve lo corregido", async () => {
    const { cliente, llamadas } = supabaseFalso({ data: [{ original: "iphone", corregido: "ipone" }] });

    const resultado = await corregirTerminos(cliente, ["iphone", "aceite"], ["beta", "bera"], ["ipone", "motul"], ["medida", "tipo"]);

    expect(llamadas).toEqual([
      {
        nombre: "corregir_terminos",
        args: {
          p_terminos: ["iphone", "aceite"],
          p_protegidos: ["beta", "bera"],
          p_marcas: ["ipone", "motul"],
          p_excluidos: ["medida", "tipo"],
        },
      },
    ]);
    expect(resultado).toEqual([{ original: "iphone", corregido: "ipone" }]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("sin términos no llama a la base", async () => {
    const { cliente, llamadas } = supabaseFalso({ data: [] });

    expect(await corregirTerminos(cliente, [], ["beta"], ["ipone"], ["medida"])).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  it("un error de la base devuelve [] y deja correccion_terminos_fallida con el texto real del error", async () => {
    const { cliente } = supabaseFalso({
      error: { code: "42883", message: "function levenshtein(text, text) does not exist" },
    });

    expect(await corregirTerminos(cliente, ["horsen"], [], [], [], "conv-1")).toEqual([]);

    expect(logWarn).toHaveBeenCalledTimes(1);
    const [evento, campos] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(evento).toBe("correccion_terminos_fallida");
    expect(campos.conversationId).toBe("conv-1");
    // errorText, no "[object Object]".
    expect(campos.detail).toBe("42883: function levenshtein(text, text) does not exist");
  });

  it("una excepción (red caída antes de resolver {data,error}) también devuelve []", async () => {
    const { cliente } = supabaseFalso({ lanza: new Error("fetch failed") });

    expect(await corregirTerminos(cliente, ["horsen"], [], [], [])).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith("correccion_terminos_fallida", expect.objectContaining({ detail: "fetch failed" }));
  });

  it("descarta filas mal formadas en lugar de propagarlas", async () => {
    const { cliente } = supabaseFalso({
      data: [{ original: "iphone", corregido: "ipone" }, { original: "x" }, null, { original: "", corregido: "y" }],
    });

    expect(await corregirTerminos(cliente, ["iphone", "x", "y"], [], [], [])).toEqual([{ original: "iphone", corregido: "ipone" }]);
  });

  it("una respuesta que no es un arreglo devuelve []", async () => {
    const { cliente } = supabaseFalso({ data: { original: "iphone", corregido: "ipone" } });

    expect(await corregirTerminos(cliente, ["iphone"], [], [], [])).toEqual([]);
  });
});

describe("diagnosticarTerminos", () => {
  beforeEach(() => logWarn.mockClear());

  it("llama a diagnosticar_terminos con los grupos de alternativas y la cabeza, y mapea las filas", async () => {
    const { cliente, llamadas } = supabaseFalso({
      data: [
        { grupo_idx: 0, en_catalogo: true, con_cabeza: true },
        { grupo_idx: 1, en_catalogo: false, con_cabeza: false },
        { grupo_idx: 2, en_catalogo: true, con_cabeza: false },
      ],
    });

    const resultado = await diagnosticarTerminos(cliente, [["manguera"], ["bomba"], ["freno", "frenos"]], 0);

    expect(llamadas).toEqual([
      {
        nombre: "diagnosticar_terminos",
        args: { p_terminos: [["manguera"], ["bomba"], ["freno", "frenos"]], p_cabeza: 0 },
      },
    ]);
    expect(resultado).toEqual([
      { grupoIdx: 0, enCatalogo: true, conCabeza: true },
      { grupoIdx: 1, enCatalogo: false, conCabeza: false },
      { grupoIdx: 2, enCatalogo: true, conCabeza: false },
    ]);
  });

  it("con_cabeza nulo (sin cabeza) se conserva como null, no como false", async () => {
    const { cliente, llamadas } = supabaseFalso({ data: [{ grupo_idx: 0, en_catalogo: true, con_cabeza: null }] });

    const resultado = await diagnosticarTerminos(cliente, [["casco"]], null);

    expect(llamadas[0].args).toEqual({ p_terminos: [["casco"]], p_cabeza: null });
    expect(resultado).toEqual([{ grupoIdx: 0, enCatalogo: true, conCabeza: null }]);
  });

  it("sin grupos no llama a la base y devuelve []", async () => {
    const { cliente, llamadas } = supabaseFalso({ data: [] });

    expect(await diagnosticarTerminos(cliente, [], 0)).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  it("un error de la base devuelve null (sin diagnóstico, no 'nada que relajar') y deja diagnostico_terminos_fallido", async () => {
    const { cliente } = supabaseFalso({ error: { code: "42883", message: "function patron_busqueda does not exist" } });

    expect(await diagnosticarTerminos(cliente, [["casco"]], 0, "conv-1")).toBeNull();

    expect(logWarn).toHaveBeenCalledTimes(1);
    const [evento, campos] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(evento).toBe("diagnostico_terminos_fallido");
    expect(campos.conversationId).toBe("conv-1");
    expect(campos.detail).toBe("42883: function patron_busqueda does not exist");
  });

  it("una excepción (red caída) también devuelve null", async () => {
    const { cliente } = supabaseFalso({ lanza: new Error("fetch failed") });

    expect(await diagnosticarTerminos(cliente, [["casco"]], 0)).toBeNull();
    expect(logWarn).toHaveBeenCalledWith("diagnostico_terminos_fallido", expect.objectContaining({ detail: "fetch failed" }));
  });

  it("descarta filas mal formadas y una respuesta que no es arreglo devuelve null", async () => {
    const { cliente } = supabaseFalso({
      data: [{ grupo_idx: 0, en_catalogo: true, con_cabeza: true }, { grupo_idx: "1", en_catalogo: true }, null, { grupo_idx: 2 }],
    });
    expect(await diagnosticarTerminos(cliente, [["a"], ["b"], ["c"]], 0)).toEqual([
      { grupoIdx: 0, enCatalogo: true, conCabeza: true },
    ]);

    const { cliente: otro } = supabaseFalso({ data: { grupo_idx: 0 } });
    expect(await diagnosticarTerminos(otro, [["a"]], 0)).toBeNull();
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
