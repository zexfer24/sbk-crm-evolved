import { describe, expect, it } from "vitest";
import { extensionForMime } from "./media-extension";

// Caso real (15/9/2026): Meta reporta las notas de voz como
// `audio/ogg; codecs=opus`, con parámetro. Un lookup exacto contra la tabla
// nunca calzaba y todas quedaban como `.bin` en Storage — ver
// `docs/diagnosticos/2026-09-14-notas-de-voz.md`.
describe("extensionForMime", () => {
  it("corta el parámetro de codec de una nota de voz", () => {
    expect(extensionForMime("audio/ogg; codecs=opus")).toBe("ogg");
  });

  it("corta el parámetro también sin espacio después del punto y coma", () => {
    expect(extensionForMime("audio/ogg;codecs=opus")).toBe("ogg");
  });

  it("normaliza mayúsculas", () => {
    expect(extensionForMime("AUDIO/OGG")).toBe("ogg");
  });

  it("resuelve un MIME común sin parámetros", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
  });

  it("cae a bin con un MIME genérico sin match en la tabla", () => {
    expect(extensionForMime("application/octet-stream")).toBe("bin");
  });

  it("cae a bin sin MIME", () => {
    expect(extensionForMime(undefined)).toBe("bin");
  });
});
