import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  highlightSegments,
  normalizeForSearch,
  searchConversationsByMessage,
  searchTerms,
  snippetAround,
} from "@/lib/message-search";

describe("normalizeForSearch — la base y el navegador tienen que coincidir", () => {
  it("quita acentos y baja a minúsculas, como immutable_unaccent(lower(...))", () => {
    expect(normalizeForSearch("Bujía")).toBe("bujia");
    expect(normalizeForSearch("BUJÍA NGK")).toBe("bujia ngk");
  });

  it("deja igual lo que ya venía sin acentos", () => {
    expect(normalizeForSearch("bujia")).toBe("bujia");
  });

  // La ñ también se aplana. No es un descuido: el diccionario `unaccent` de
  // Postgres —el que alimenta messages.search_text— mapea ñ→n, y estas dos
  // funciones tienen que dar lo mismo o el resaltado del cliente cae en un
  // lugar distinto del que encontró el servidor. De paso, quien escribe
  // "muneca" desde el teclado del teléfono igual encuentra "muñeca".
  it("aplana la ñ igual que el diccionario unaccent de Postgres", () => {
    expect(normalizeForSearch("Muñeca")).toBe("muneca");
  });
});

describe("searchTerms", () => {
  it("parte la frase en palabras normalizadas", () => {
    expect(searchTerms("  Bujía   NGK ")).toEqual(["bujia", "ngk"]);
  });

  it("una búsqueda vacía no tiene términos", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("highlightSegments — marcar sin romper lo que escribió la persona", () => {
  it("resalta la coincidencia conservando la tilde original", () => {
    expect(highlightSegments("Traigo una bujía nueva", ["bujia"])).toEqual([
      { text: "Traigo una ", match: false },
      { text: "bujía", match: true },
      { text: " nueva", match: false },
    ]);
  });

  it("resalta todas las apariciones, no solo la primera", () => {
    const marcados = highlightSegments("bujia y otra bujia", ["bujia"])
      .filter((s) => s.match)
      .map((s) => s.text);
    expect(marcados).toEqual(["bujia", "bujia"]);
  });

  // Dos términos que se pisan producirían tramos cruzados si cada uno cortara
  // por su cuenta: se marcan posiciones y recién después se corta.
  it("funde dos términos que se solapan en un solo tramo", () => {
    expect(highlightSegments("bujias", ["buji", "bujia"])).toEqual([
      { text: "bujia", match: true },
      { text: "s", match: false },
    ]);
  });

  it("sin términos devuelve el texto entero sin marcar", () => {
    expect(highlightSegments("cualquier cosa", [])).toEqual([
      { text: "cualquier cosa", match: false },
    ]);
  });

  // Un texto que ya viene descompuesto (la tilde como carácter aparte) mide
  // más que su versión normalizada, y los índices dejan de corresponderse.
  // Ahí se prefiere el texto sin marca antes que la marca corrida.
  it("se abstiene de marcar cuando normalizar cambia el largo del texto", () => {
    const descompuesto = "bujía"; // "bujía" con la tilde como carácter suelto
    expect(normalizeForSearch(descompuesto).length).not.toBe(descompuesto.length);
    expect(highlightSegments(descompuesto, ["bujia"])).toEqual([
      { text: descompuesto, match: false },
    ]);
  });
});

describe("snippetAround — la bandeja da para una línea", () => {
  it("recorta lo anterior cuando la coincidencia está lejos del principio", () => {
    const largo = "Buenas tardes, quería consultar por unos repuestos que necesito para el fin de semana y también una bujía";
    const recorte = snippetAround(largo, ["bujia"]);

    expect(recorte.startsWith("…")).toBe(true);
    expect(recorte).toContain("bujía");
    expect(recorte.length).toBeLessThan(largo.length);
  });

  it("deja el mensaje entero si la coincidencia ya está al principio", () => {
    expect(snippetAround("bujía nueva por favor", ["bujia"])).toBe("bujía nueva por favor");
  });

  it("aplasta los saltos de línea: la preview es una sola línea", () => {
    expect(snippetAround("hola\n\n  mundo", ["hola"])).toBe("hola mundo");
  });
});

describe("searchConversationsByMessage", () => {
  function fakeSupabase(rows: unknown[]) {
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
    return { client: { rpc } as unknown as SupabaseClient, rpc };
  }

  it("indexa las coincidencias por conversación", async () => {
    const { client } = fakeSupabase([
      {
        conversation_id: "conv-1",
        message_id: "msg-9",
        content: "¿tienen bujía CR7HSA?",
        created_at: "2026-08-22T10:00:00Z",
      },
    ]);

    const hits = await searchConversationsByMessage(client, "bujia");

    expect(hits.get("conv-1")).toEqual({
      messageId: "msg-9",
      content: "¿tienen bujía CR7HSA?",
      createdAt: "2026-08-22T10:00:00Z",
    });
  });

  // Con una sola letra la respuesta es "medio CRM": ni acota ni ayuda, y
  // cuesta una consulta por tecla.
  it("no consulta la base con menos letras que el mínimo", async () => {
    const { client, rpc } = fakeSupabase([]);

    expect((await searchConversationsByMessage(client, "b")).size).toBe(0);
    expect((await searchConversationsByMessage(client, "   ")).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propaga el error para que la bandeja decida qué hacer", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error("sin conexión") });
    const client = { rpc } as unknown as SupabaseClient;

    await expect(searchConversationsByMessage(client, "bujia")).rejects.toThrow(/sin conexión/);
  });
});
