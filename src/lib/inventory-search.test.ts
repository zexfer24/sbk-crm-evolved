import { describe, expect, it } from "vitest";
import { normalizeProductQuery, productSearchFilters, productSearchWords } from "@/lib/inventory-search";

describe("normalizeProductQuery", () => {
  it("baja a minúsculas y quita acentos", () => {
    expect(normalizeProductQuery("Bujía NGK")).toBe("bujia ngk");
  });

  it("colapsa espacios repetidos y recorta los de los extremos", () => {
    expect(normalizeProductQuery("  tubo   cg  ")).toBe("tubo cg");
  });

  it("una búsqueda vacía o solo espacios da vacío", () => {
    expect(normalizeProductQuery("   ")).toBe("");
    expect(normalizeProductQuery("")).toBe("");
  });
});

describe("productSearchWords", () => {
  it("parte la frase en palabras normalizadas", () => {
    expect(productSearchWords("Tubo CG")).toEqual(["tubo", "cg"]);
  });

  it("descarta espacios de sobra sin dejar palabras vacías", () => {
    expect(productSearchWords("  tubo    cg  ")).toEqual(["tubo", "cg"]);
  });

  it("recorta al tope de 6 palabras", () => {
    expect(productSearchWords("uno dos tres cuatro cinco seis siete ocho")).toEqual([
      "uno",
      "dos",
      "tres",
      "cuatro",
      "cinco",
      "seis",
    ]);
  });

  it("una búsqueda vacía no tiene palabras", () => {
    expect(productSearchWords("   ")).toEqual([]);
  });
});

describe("productSearchFilters — el filtro que se le pasa a .or() de PostgREST", () => {
  it("'tubo cg' arma DOS filtros, uno por palabra", () => {
    const filtros = productSearchFilters("tubo cg");
    expect(filtros).toHaveLength(2);
  });

  it("cada filtro exige la palabra en search_text, saint_code o description", () => {
    const [filtro] = productSearchFilters("cg");
    expect(filtro).toBe('search_text.ilike."%cg%",saint_code.ilike."%cg%",description.ilike."%cg%"');
  });

  it("normaliza acentos y mayúsculas antes de armar el filtro", () => {
    const [filtro] = productSearchFilters("BUJÍA");
    expect(filtro).toBe('search_text.ilike."%bujia%",saint_code.ilike."%bujia%",description.ilike."%bujia%"');
  });

  it("un código con guion viaja como una sola palabra, sin partirse", () => {
    const filtros = productSearchFilters("test-cg150");
    expect(filtros).toHaveLength(1);
    expect(filtros[0]).toContain("%test-cg150%");
  });

  // Trampa CWE-943 (pgrst.ts): el filtro `.or()` es un mini-lenguaje donde
  // coma y paréntesis son sintaxis. Una búsqueda con esos caracteres no debe
  // producir una expresión que PostgREST interprete como condiciones extra.
  it("coma, paréntesis y comillas dentro de una palabra no rompen el filtro", () => {
    const filtros = productSearchFilters('tubo(cg),"raro"');
    expect(filtros).toHaveLength(1);
    // La palabra completa queda escapada dentro de un literal con comillas
    // dobles, con la comilla interna escapada — no hay una coma o un
    // paréntesis sueltos que PostgREST pudiera leer como otra condición.
    expect(filtros[0]).toBe(
      'search_text.ilike."%tubo(cg),\\"raro\\"%",saint_code.ilike."%tubo(cg),\\"raro\\"%",description.ilike."%tubo(cg),\\"raro\\"%"'
    );
  });

  it("query vacía no arma ningún filtro", () => {
    expect(productSearchFilters("   ")).toEqual([]);
    expect(productSearchFilters("")).toEqual([]);
  });
});
