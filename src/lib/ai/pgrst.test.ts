import { describe, expect, it } from "vitest";
import { pgrstLiteral } from "@/lib/ai/pgrst";

/**
 * El filtro `.or()` de PostgREST es un mini-lenguaje, no una cadena inerte:
 * la coma separa condiciones y el punto separa columna/operador/valor.
 * Interpolar ahí texto que el cliente puede influir deja que el mensaje de
 * un cliente altere la CONSULTA, no solo lo que se busca (CWE-943).
 */
describe("pgrstLiteral", () => {
  it("entrecomilla el valor para que la coma no separe condiciones", () => {
    expect(pgrstLiteral("%carburador%")).toBe('"%carburador%"');
  });

  it("neutraliza una coma inyectada, que sin comillas agregaría una condición al OR", () => {
    const payload = "%a%,id.not.is.null";
    expect(pgrstLiteral(payload)).toBe('"%a%,id.not.is.null"');
  });

  it("escapa las comillas dobles para que no cierren el literal antes de tiempo", () => {
    expect(pgrstLiteral('a"b')).toBe('"a\\"b"');
  });

  it("escapa la barra invertida, que si no podría escapar la comilla de cierre", () => {
    expect(pgrstLiteral("a\\b")).toBe('"a\\\\b"');
  });

  it("un intento de cerrar el literal y encadenar otra condición queda contenido", () => {
    const payload = '%x%",stock_quantity.gte.0,"';
    const literal = pgrstLiteral(payload);
    // Todas las comillas internas van escapadas: el literal abre y cierra
    // una sola vez, así que la coma queda como texto de búsqueda.
    expect(literal.startsWith('"')).toBe(true);
    expect(literal.endsWith('"')).toBe(true);
    expect(literal.slice(1, -1)).not.toMatch(/(?<!\\)"/);
  });
});
