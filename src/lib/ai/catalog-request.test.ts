import { describe, expect, it } from "vitest";
import { pideCatalogo } from "@/lib/ai/catalog-request";

// Frases reales del reporte de solo lectura de producción (VPS, 21/9/2026,
// plan "El catálogo configurado sale siempre") que SÍ piden el catálogo como
// documento.
describe("pideCatalogo — casos verdaderos", () => {
  it.each([
    ["Catálogo"],
    ["Buenas noches catálogo"],
    ["Me puedes enviar el catálogo de los cascos"],
    ["Disculpe será que me puede mandar el catalogo de los casco"],
    ["Tendrán lista de precios por favor"],
    ["Buenos días reciban un cordial saludo. Me podrían enviar su lista de precios al mayor"],
    ["tienen pdf?"],
    ["Gola me envia catálogo de cascos. Disponibles?"],
    // Decisión del plan (21/9/2026): una frase NEGATIVA sobre el catálogo
    // también cuenta como "pide el catálogo" — esta función solo decide si
    // un escenario YA CALZADO se cede al inventario, y para esta frase fase
    // 0 calza "Error de comentario" (que escala); ceder ESE escenario sería
    // peor que repetir el catálogo.
    ["No están en el catálogo"],
  ])("%s -> true", (linea) => {
    expect(pideCatalogo([linea])).toBe(true);
  });

  it("una ráfaga de dos líneas donde solo la primera nombra el catálogo también es true", () => {
    expect(pideCatalogo(["Me pasas el catálogo", "Buenas tardes"])).toBe(true);
  });
});

describe("pideCatalogo — casos falsos", () => {
  it.each([
    ["Hola precios de los cascos"],
    ["Buenas precios de las Maletas Laterales"],
    ["¿tienen pastillas de freno?"],
    ["buenas, tienen disponible?"],
    ["hola, otra consulta"],
  ])("%s -> false", (linea) => {
    expect(pideCatalogo([linea])).toBe(false);
  });

  it("una ráfaga vacía es false", () => {
    expect(pideCatalogo([])).toBe(false);
  });

  it("un marcador de media entre corchetes no cuenta como pedir el catálogo", () => {
    expect(
      pideCatalogo(["[El cliente envió una foto sin texto; no puedes verla]"])
    ).toBe(false);
  });
});
