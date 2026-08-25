import { describe, expect, it } from "vitest";
import { clipContent, rankKnowledge } from "@/lib/ai/knowledge-search";
import { searchTerms } from "@/lib/ai/catalog-search";

// ---------------------------------------------------------------------------
// El fallo silencioso que se busca evitar: si la búsqueda no calza, la IA le
// dice al cliente que esa información no existe — con seguridad y sin que
// nadie se entere. Mismo problema que el catálogo (ver catalog-search.ts).
// ---------------------------------------------------------------------------

function entry(title: string, category: string, content: string) {
  return { title, category, content };
}

describe("rankKnowledge", () => {
  it("encuentra la entrada aunque el cliente escriba sin acentos", () => {
    const rows = [entry("Envíos a todo el país", "Envíos", "Trabajamos con MRW y Zoom.")];

    const result = rankKnowledge(rows, searchTerms("hacen envios?"));

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Envíos a todo el país");
  });

  it("descarta las entradas que no calzan con ningún término", () => {
    const rows = [
      entry("Formas de pago", "Pagos", "Aceptamos bolívares y divisas."),
      entry("Horario de la tienda", "La tienda", "Lunes a sábado de 8 a 5."),
    ];

    const result = rankKnowledge(rows, searchTerms("garantía del carburador"));

    expect(result).toHaveLength(0);
  });

  /**
   * El título pesa más que el cuerpo: la entrada DEDICADA al tema tiene que
   * quedar por encima de la que solo lo menciona de pasada, porque al modelo
   * le llegan las primeras tres y nada más.
   */
  it("la entrada dedicada al tema queda por encima de la que solo lo menciona", () => {
    const rows = [
      entry("Formas de pago", "Pagos", "Al retirar puedes pagar como prefieras. Envíos no incluidos."),
      entry("Envíos a todo el país", "Envíos", "Trabajamos con MRW. El envío lo paga el cliente."),
    ];

    const result = rankKnowledge(rows, searchTerms("envíos"));

    expect(result[0].title).toBe("Envíos a todo el país");
  });

  it("calza más términos, queda más arriba", () => {
    const rows = [
      entry("Garantía de repuestos", "Garantías y devoluciones", "Treinta días contra defectos de fábrica."),
      entry("Cambios y devoluciones", "Garantías y devoluciones", "Se aceptan cambios con factura."),
    ];

    const result = rankKnowledge(rows, searchTerms("garantia de los repuestos"));

    expect(result[0].title).toBe("Garantía de repuestos");
  });

  it("sin términos no devuelve nada, en vez de devolver la biblioteca entera", () => {
    const rows = [entry("Formas de pago", "Pagos", "Aceptamos bolívares.")];

    expect(rankKnowledge(rows, [])).toHaveLength(0);
  });
});

describe("clipContent", () => {
  it("deja pasar intacto lo que cabe", () => {
    expect(clipContent("texto corto", 100)).toBe("texto corto");
  });

  /** Un .md subido puede ser un documento entero: al modelo le llega el comienzo y un aviso, no el archivo completo. */
  it("recorta lo largo y lo dice en el propio texto", () => {
    const largo = "a".repeat(500);

    const clipped = clipContent(largo, 100);

    expect(clipped.startsWith("a".repeat(100))).toBe(true);
    expect(clipped).toContain("recortado");
    expect(clipped.length).toBeLessThan(200);
  });
});
