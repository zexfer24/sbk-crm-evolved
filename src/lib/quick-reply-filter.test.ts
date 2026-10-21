import { describe, expect, it } from "vitest";
import type { QuickReply } from "@/lib/types";
import { buscarMensajesRapidos, coincideMedia, normalizarBusqueda, resaltar } from "@/lib/quick-reply-filter";

// 21/10/2026, "Presupuestos y mensajes rápidos" (T7): la búsqueda del modal de
// mensajes rápidos es una función pura para probarla sin levantar el modal.

function respuesta(overrides: Partial<QuickReply> & { id: string }): QuickReply {
  return { label: "Sin título", content: "", ownerId: null, mediaPaths: [], ...overrides };
}

const catalogo = respuesta({ id: "1", label: "Catálogo general", content: "Acá va nuestro catálogo 👇" });
const horario = respuesta({ id: "2", label: "Horario", content: "Atendemos de lunes a viernes de 8 a 18." });
const cascos = respuesta({
  id: "3",
  label: "Cascos",
  content: "Mira el catálogo de cascos",
  mediaPaths: ["quick-replies/a.jpg"],
});
const solofotos = respuesta({ id: "4", label: "Fotos del local", content: "", mediaPaths: ["a.jpg", "b.jpg"] });
const todos = [catalogo, horario, cascos, solofotos];

describe("normalizarBusqueda", () => {
  it("quita acentos, pasa a minúsculas, colapsa espacios y recorta", () => {
    expect(normalizarBusqueda("  CATÁLOGO   Géneral \n")).toBe("catalogo general");
  });

  it("conserva la ñ como n (sin diacrítico) y no rompe con vacío", () => {
    expect(normalizarBusqueda("Niño")).toBe("nino");
    expect(normalizarBusqueda("   ")).toBe("");
  });
});

describe("coincideMedia", () => {
  it("«todos» deja pasar todo", () => {
    expect(todos.every((r) => coincideMedia(r, "todos"))).toBe(true);
  });

  it("«texto» deja solo los que no llevan fotos", () => {
    expect(todos.filter((r) => coincideMedia(r, "texto")).map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("«fotos» deja solo los que llevan al menos una foto, también los de solo fotos", () => {
    expect(todos.filter((r) => coincideMedia(r, "fotos")).map((r) => r.id)).toEqual(["3", "4"]);
  });
});

describe("buscarMensajesRapidos", () => {
  it("consulta vacía: todos los que pasan el filtro de media, en el orden recibido, sin «por texto»", () => {
    const { porTitulo, porTexto } = buscarMensajesRapidos(todos, "  ", "todos");
    expect(porTitulo.map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
    expect(porTexto).toEqual([]);
  });

  it("consulta vacía respeta el filtro de media", () => {
    expect(buscarMensajesRapidos(todos, "", "fotos").porTitulo.map((r) => r.id)).toEqual(["3", "4"]);
    expect(buscarMensajesRapidos(todos, "", "texto").porTitulo.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("«CATA» encuentra «Catálogo»: sin distinguir acentos ni mayúsculas", () => {
    const { porTitulo } = buscarMensajesRapidos(todos, "CATA", "todos");
    expect(porTitulo.map((r) => r.id)).toEqual(["1"]);
  });

  it("separa título y texto: lo que calza solo en el texto va aparte, y nada se repite", () => {
    const { porTitulo, porTexto } = buscarMensajesRapidos(todos, "catalogo", "todos");
    expect(porTitulo.map((r) => r.id)).toEqual(["1"]);
    expect(porTexto.map((r) => r.id)).toEqual(["3"]);
  });

  it("varias palabras: TODAS tienen que aparecer (AND), en cualquier orden", () => {
    expect(buscarMensajesRapidos(todos, "general catalogo", "todos").porTitulo.map((r) => r.id)).toEqual(["1"]);
    expect(buscarMensajesRapidos(todos, "catalogo zzz", "todos")).toEqual({ porTitulo: [], porTexto: [] });
  });

  it("las palabras no tienen que estar todas en el mismo campo: título y texto no se mezclan", () => {
    // «horario» solo está en el título y «lunes» solo en el texto del mismo mensaje.
    const { porTitulo, porTexto } = buscarMensajesRapidos(todos, "horario lunes", "todos");
    expect(porTitulo).toEqual([]);
    expect(porTexto).toEqual([]);
  });

  it("combina la consulta con el filtro de media", () => {
    expect(buscarMensajesRapidos(todos, "catalogo", "texto").porTexto).toEqual([]);
    expect(buscarMensajesRapidos(todos, "catalogo", "fotos")).toEqual({ porTitulo: [], porTexto: [cascos] });
  });

  it("conserva el orden recibido dentro de cada grupo", () => {
    const a = respuesta({ id: "a", label: "Zeta pago" });
    const b = respuesta({ id: "b", label: "Alfa pago" });
    expect(buscarMensajesRapidos([a, b], "pago", "todos").porTitulo.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("resaltar", () => {
  it("marca el trozo ORIGINAL (con su acento) aunque se busque sin acento", () => {
    expect(resaltar("Catálogo general", "cata")).toEqual([
      { texto: "Catá", marcado: true },
      { texto: "logo general", marcado: false },
    ]);
  });

  it("marca por encima de los acentos: «catalogo» cubre «Catálogo» entero", () => {
    expect(resaltar("Catálogo general", "CATALOGO")).toEqual([
      { texto: "Catálogo", marcado: true },
      { texto: " general", marcado: false },
    ]);
  });

  it("varias palabras: marca cada una, en cualquier lugar", () => {
    expect(resaltar("Catálogo general de cascos", "general cat")).toEqual([
      { texto: "Cat", marcado: true },
      { texto: "álogo ", marcado: false },
      { texto: "general", marcado: true },
      { texto: " de cascos", marcado: false },
    ]);
  });

  it("une las coincidencias que se tocan o se solapan en un solo trozo", () => {
    expect(resaltar("Catálogo", "cata atal")).toEqual([
      { texto: "Catál", marcado: true },
      { texto: "ogo", marcado: false },
    ]);
  });

  it("marca todas las apariciones de una palabra", () => {
    expect(resaltar("pago y pago", "pago")).toEqual([
      { texto: "pago", marcado: true },
      { texto: " y ", marcado: false },
      { texto: "pago", marcado: true },
    ]);
  });

  it("sin coincidencia o con consulta vacía devuelve un solo trozo sin marcar", () => {
    expect(resaltar("Horario", "zzz")).toEqual([{ texto: "Horario", marcado: false }]);
    expect(resaltar("Horario", "  ")).toEqual([{ texto: "Horario", marcado: false }]);
  });

  it("texto vacío devuelve una lista vacía", () => {
    expect(resaltar("", "cata")).toEqual([]);
  });
});
