import { describe, expect, it } from "vitest";
import { normalizeProductQuery, productSearchFilter, productSearchWords } from "@/lib/inventory-search";

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

/**
 * Hallazgo 2, `code-review high` sobre d38a7e1..HEAD (27/9/2026): la versión
 * anterior devolvía UN `.or()` por palabra y el llamador los encadenaba —
 * `ai/pgrst.ts` ya documenta que dos `.or()` en la misma consulta "no son
 * fiables" (PostgREST junta los parámetros repetidos con AND de forma poco
 * predecible; medido que en local sí se combinan, pero detrás de un proxy en
 * producción no hay garantía). `productSearchFilter` arma una ÚNICA
 * expresión —`and(or(...),or(...))` para dos o más palabras, o el `or(...)`
 * de la única palabra tal cual cuando es una sola— para pasarle a `.or()`
 * en UNA sola llamada.
 */
describe("productSearchFilter — una sola expresión para pasarle a .or() de PostgREST", () => {
  it("una palabra sola es el or(...) directo, sin envolver en and()", () => {
    const filtro = productSearchFilter("cg");
    expect(filtro).toBe('search_text.ilike."%cg%",saint_code.ilike."%cg%",description.ilike."%cg%"');
  });

  it("normaliza acentos y mayúsculas antes de armar el filtro", () => {
    const filtro = productSearchFilter("BUJÍA");
    expect(filtro).toBe('search_text.ilike."%bujia%",saint_code.ilike."%bujia%",description.ilike."%bujia%"');
  });

  it("'tubo cg' arma UNA sola expresión and(or(...),or(...)) para las dos palabras", () => {
    const filtro = productSearchFilter("tubo cg");
    expect(filtro).toBe(
      'and(or(search_text.ilike."%tubo%",saint_code.ilike."%tubo%",description.ilike."%tubo%"),' +
        'or(search_text.ilike."%cg%",saint_code.ilike."%cg%",description.ilike."%cg%"))'
    );
  });

  it("un código con guion viaja como una sola palabra, sin partirse ni envolverse en and()", () => {
    const filtro = productSearchFilter("test-cg150");
    expect(filtro).not.toBeNull();
    expect(filtro).not.toContain("and(");
    expect(filtro).toContain("%test-cg150%");
  });

  // Trampa CWE-943 (pgrst.ts): el filtro `.or()` es un mini-lenguaje donde
  // coma y paréntesis son sintaxis. Una búsqueda con esos caracteres no debe
  // producir una expresión que PostgREST interprete como condiciones extra.
  it("coma, paréntesis y comillas dentro de una palabra no rompen el filtro", () => {
    const filtro = productSearchFilter('tubo(cg),"raro"');
    // La palabra completa queda escapada dentro de un literal con comillas
    // dobles, con la comilla interna escapada — no hay una coma o un
    // paréntesis sueltos que PostgREST pudiera leer como otra condición.
    expect(filtro).toBe(
      'search_text.ilike."%tubo(cg),\\"raro\\"%",saint_code.ilike."%tubo(cg),\\"raro\\"%",description.ilike."%tubo(cg),\\"raro\\"%"'
    );
  });

  it("query vacía no arma ningún filtro", () => {
    expect(productSearchFilter("   ")).toBeNull();
    expect(productSearchFilter("")).toBeNull();
  });
});
