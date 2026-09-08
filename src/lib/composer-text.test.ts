import { describe, expect, it } from "vitest";
import { insertAtCaret } from "@/lib/composer-text";

describe("insertAtCaret", () => {
  it("inserta al inicio del texto", () => {
    const result = insertAtCaret("mundo", 0, 0, "hola ");
    expect(result).toEqual({ text: "hola mundo", caret: 5 });
  });

  it("inserta en medio del texto", () => {
    const result = insertAtCaret("hola mundo", 5, 5, "lindo ");
    expect(result).toEqual({ text: "hola lindo mundo", caret: 11 });
  });

  it("inserta al final del texto", () => {
    const result = insertAtCaret("hola", 4, 4, " 👍");
    expect(result).toEqual({ text: "hola 👍", caret: 7 });
  });

  it("reemplaza una selección en vez de insertar sobre ella", () => {
    // "hola mundo" con "mundo" seleccionado (posiciones 5 a 10)
    const result = insertAtCaret("hola mundo", 5, 10, "tierra");
    expect(result).toEqual({ text: "hola tierra", caret: 11 });
  });

  it("inserta un emoji compuesto con ZWJ sin partirlo", () => {
    const familia = "👨‍👩‍👧"; // hombre + ZWJ + mujer + ZWJ + niña
    const result = insertAtCaret("hola ", 5, 5, familia);
    expect(result.text).toBe(`hola ${familia}`);
    expect(result.caret).toBe(5 + familia.length);
    // El emoji no se corta: el sufijo desde el caret es exactamente el emoji.
    expect(result.text.slice(5)).toBe(familia);
  });

  it("con el texto vacío, inserta como único contenido", () => {
    const result = insertAtCaret("", 0, 0, "😀");
    expect(result).toEqual({ text: "😀", caret: 2 });
  });

  it("acota índices fuera de rango en vez de romperse", () => {
    // selectionEnd más allá del largo real del texto (caso de un caret viejo
    // que sobrevivió a un cambio de contenido).
    const result = insertAtCaret("hola", 2, 50, "X");
    expect(result).toEqual({ text: "hoX", caret: 3 });
  });
});
