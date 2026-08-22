import { describe, expect, it } from "vitest";
import { catalogFilter, normalize, rankByTerms, searchTerms } from "@/lib/ai/catalog-search";

/**
 * Estos dos casos vienen de correr el agente contra el catálogo real, no de
 * imaginarlos: "tienen bujía NGK?" recibió un "no tenemos" con toda
 * seguridad, teniendo la Bujía CR7HSA marca NGK en el estante.
 *
 * Es el error más caro de esta herramienta porque no se ve: no lanza, no
 * queda en la bitácora, y el cliente se va convencido de que no hay.
 */
describe("searchTerms", () => {
  it("parte la consulta en palabras, para que el nombre y la marca puedan calzar por separado", () => {
    expect(searchTerms("bujía NGK")).toEqual(["bujia", "ngk"]);
  });

  it("quita los acentos, porque por WhatsApp nadie los escribe", () => {
    expect(searchTerms("bujia")).toEqual(["bujia"]);
    expect(searchTerms("Bujía")).toEqual(["bujia"]);
  });

  it("descarta las palabras cortas, que calzan con casi todo", () => {
    expect(searchTerms("kit de arrastre")).toEqual(["kit", "arrastre"]);
  });

  it("no repite un término que el cliente escribió dos veces", () => {
    expect(searchTerms("freno freno delantero")).toEqual(["freno", "delantero"]);
  });

  /** Sin esto, "R6" se quedaría sin términos y la búsqueda traería el catálogo entero. */
  it("usa la consulta entera cuando ninguna palabra llega a tres letras", () => {
    expect(searchTerms("R6")).toEqual(["r6"]);
  });

  it("con una consulta vacía no devuelve términos", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("catalogFilter", () => {
  it("busca cada término por separado, unidos por OR", () => {
    expect(catalogFilter(["bujia", "ngk"])).toBe('search_text.ilike."%bujia%",search_text.ilike."%ngk%"');
  });

  /** El término lo redacta el modelo a partir del mensaje del cliente: va entrecomillado (CWE-943). */
  it("entrecomilla el término para que una coma no agregue condiciones", () => {
    expect(catalogFilter(["a,id.not.is.null"])).toBe('search_text.ilike."%a,id.not.is.null%"');
  });
});

describe("rankByTerms", () => {
  it("pone primero el producto que calza más términos", () => {
    const filas = [
      { search_text: "bujia cr9e denso" },
      { search_text: "bujia cr7hsa ngk" },
      { search_text: "filtro de aceite generico" },
    ];

    const ordenado = rankByTerms(filas, ["bujia", "ngk"]);

    expect(ordenado[0].search_text).toBe("bujia cr7hsa ngk");
  });

  it("no descarta los que calzan menos: quedan detrás", () => {
    const filas = [{ search_text: "kit de arrastre did" }, { search_text: "cadena did" }];

    expect(rankByTerms(filas, ["kit", "arrastre"])).toHaveLength(2);
  });

  it("tolera un search_text nulo sin romperse", () => {
    expect(rankByTerms([{ search_text: null }], ["bujia"])).toHaveLength(1);
  });
});

describe("normalize", () => {
  it("deja el texto en minúsculas y sin diacríticos", () => {
    expect(normalize("Bujía CR7HSA Ñ")).toBe("bujia cr7hsa n");
  });
});
