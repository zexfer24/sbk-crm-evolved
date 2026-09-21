import { describe, expect, it } from "vitest";
import { debeCederAlInventario, pideCatalogo } from "@/lib/ai/catalog-request";

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

// ---------------------------------------------------------------------------
// Tarea 3, plan "El catálogo configurado sale siempre" (21/9/2026).
//
// `debeCederAlInventario` junta las CUATRO condiciones de "el repuesto
// manda" (H1, 18/9/2026, ampliada por este plan): antes de esta tarea
// `agent.ts` solo miraba la intención clasificada, y en producción eso cedía
// al inventario aunque `buscar_repuesto` estuviera apagado (desde el
// 25/8/2026) o el cliente hubiera pedido el catálogo COMO DOCUMENTO — los
// dos casos que el reporte de solo lectura del 21/9 mostró como el 30 % de
// las respuestas de escenario en 15 días.
//
// Tabla de verdad: cada condición en falso por separado apaga la cesión con
// SU motivo (en el orden que pide el plan: catálogo apagado, cliente pidió
// el catálogo, escenario no marcado); las cuatro en verdadero ceden.
// ---------------------------------------------------------------------------
describe("debeCederAlInventario", () => {
  const BASE = {
    intencionOk: true,
    intent: "consulta_disponibilidad",
    catalogoEncendido: true,
    rafaga: ["¿tienen pastillas de freno?"],
    cedeAlInventario: true,
  };

  it("las cuatro condiciones en verdadero: cede, sin motivo", () => {
    expect(debeCederAlInventario(BASE)).toEqual({ cede: true, motivo: null });
  });

  it("clasificación fallida (intencionOk = false): no cede, sin motivo (no es 'el repuesto manda')", () => {
    expect(debeCederAlInventario({ ...BASE, intencionOk: false })).toEqual({ cede: false, motivo: null });
  });

  it("intención distinta de consulta_disponibilidad: no cede, sin motivo", () => {
    expect(debeCederAlInventario({ ...BASE, intent: "otro" })).toEqual({ cede: false, motivo: null });
  });

  it("catálogo (buscar_repuesto) apagado: no cede, motivo catalogo_apagado", () => {
    expect(debeCederAlInventario({ ...BASE, catalogoEncendido: false })).toEqual({
      cede: false,
      motivo: "catalogo_apagado",
    });
  });

  it("el cliente pidió el catálogo como documento: no cede, motivo cliente_pidio_catalogo", () => {
    expect(
      debeCederAlInventario({ ...BASE, rafaga: ["Me puedes enviar el catálogo de los cascos"] })
    ).toEqual({ cede: false, motivo: "cliente_pidio_catalogo" });
  });

  it("el escenario no está marcado (cedeAlInventario = false): no cede, motivo escenario_no_marcado", () => {
    expect(debeCederAlInventario({ ...BASE, cedeAlInventario: false })).toEqual({
      cede: false,
      motivo: "escenario_no_marcado",
    });
  });

  it("precedencia: catálogo apagado gana aunque el cliente también haya pedido el catálogo", () => {
    expect(
      debeCederAlInventario({
        ...BASE,
        catalogoEncendido: false,
        rafaga: ["Me puedes enviar el catálogo de los cascos"],
      })
    ).toEqual({ cede: false, motivo: "catalogo_apagado" });
  });

  it("precedencia: cliente pidió el catálogo gana sobre el escenario no marcado", () => {
    expect(
      debeCederAlInventario({
        ...BASE,
        rafaga: ["Me puedes enviar el catálogo de los cascos"],
        cedeAlInventario: false,
      })
    ).toEqual({ cede: false, motivo: "cliente_pidio_catalogo" });
  });
});
