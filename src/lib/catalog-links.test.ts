import { describe, expect, it } from "vitest";
import {
  CATALOG_LIST_MARKER,
  CATALOG_MARKER,
  catalogMarkerFor,
  formatCatalogList,
  hasRawUrl,
  resolveCatalogMarkers,
  slugifyKey,
  validateCatalogLinkDraft,
  type CatalogLinkDraft,
} from "@/lib/catalog-links";
import type { CatalogLink } from "@/lib/types";

/**
 * T2, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
 * D3/D4). Historia: los catálogos de SBK Motors son URLs de Google Drive
 * pegadas A MANO en tres escenarios y cuatro mensajes rápidos; el catálogo de
 * cascos tuvo cuatro IDs distintos en 25 días y el 18/9/2026 circulaban dos a
 * la vez. Este módulo es la mitad pura de la fuente única `catalog_links`:
 * valida lo que carga el supervisor y resuelve el marcador
 * `{{catalogo:<key>}}`/`{{catalogos}}` que consumen la IA (T3) y los
 * mensajes rápidos (T4b) — sin tocar React ni Supabase, para poder probarlo
 * sin levantar nada.
 */

function link(overrides: Partial<CatalogLink> = {}): CatalogLink {
  return {
    id: "link-1",
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/file/d/1iz77Lc",
    sortOrder: 1,
    isActive: true,
    updatedBy: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function draft(overrides: Partial<CatalogLinkDraft> = {}): CatalogLinkDraft {
  return {
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/file/d/1iz77Lc",
    ...overrides,
  };
}

describe("validateCatalogLinkDraft", () => {
  it("un borrador válido no tiene errores", () => {
    expect(validateCatalogLinkDraft(draft(), [])).toEqual({});
  });

  it("rechaza la clave vacía", () => {
    expect(validateCatalogLinkDraft(draft({ key: "" }), [])).toHaveProperty("key");
    expect(validateCatalogLinkDraft(draft({ key: "   " }), [])).toHaveProperty("key");
  });

  it.each(["Cascos", "cascos nuevos", "cascos_nuevos", "á"])(
    "rechaza una clave con mayúscula, espacio, guion bajo o tilde: «%s»",
    (key) => {
      expect(validateCatalogLinkDraft(draft({ key }), [])).toHaveProperty("key");
    }
  );

  it("rechaza una clave repetida (comparación insensible a mayúsculas)", () => {
    const existentes = [link({ id: "otro", key: "cascos" })];
    expect(validateCatalogLinkDraft(draft({ key: "cascos" }), existentes)).toHaveProperty("key");
    expect(validateCatalogLinkDraft(draft({ key: "CASCOS" }), existentes)).toHaveProperty("key");
  });

  it("no confunde la fila que se está editando con una repetida (existing ya viene sin ella)", () => {
    const existentes = [link({ id: "otro", key: "resonadores" })];
    expect(validateCatalogLinkDraft(draft({ key: "cascos" }), existentes)).toEqual({});
  });

  it("rechaza la etiqueta vacía", () => {
    expect(validateCatalogLinkDraft(draft({ label: "" }), [])).toHaveProperty("label");
    expect(validateCatalogLinkDraft(draft({ label: "   " }), [])).toHaveProperty("label");
  });

  it.each(["drive.google.com/file/d/1iz77Lc", "ftp://drive.google.com", ""])(
    "rechaza una URL sin esquema http(s): «%s»",
    (url) => {
      expect(validateCatalogLinkDraft(draft({ url }), [])).toHaveProperty("url");
    }
  );

  it("acepta http y https", () => {
    expect(validateCatalogLinkDraft(draft({ url: "http://maps.app.goo.gl/x" }), [])).toEqual({});
    expect(validateCatalogLinkDraft(draft({ url: "https://drive.google.com/x" }), [])).toEqual({});
  });
});

describe("slugifyKey — propone la clave a partir de la etiqueta", () => {
  it("pasa a minúsculas y cambia espacios por guiones", () => {
    expect(slugifyKey("Cascos")).toBe("cascos");
  });

  it("conserva la 'y' de conexión (Exploradoras y Bombillos)", () => {
    expect(slugifyKey("Exploradoras y Bombillos")).toBe("exploradoras-y-bombillos");
  });

  it("quita tildes", () => {
    expect(slugifyKey("Cámaras y Néon")).toBe("camaras-y-neon");
    expect(slugifyKey("Ubicación")).toBe("ubicacion");
  });

  it("colapsa separadores repetidos y recorta los bordes", () => {
    expect(slugifyKey("  Lubricantes  (2) ")).toBe("lubricantes-2");
  });

  it("tope de 30 caracteres, sin dejar un guion colgando al cortar", () => {
    const largo = slugifyKey("Un catálogo con una etiqueta larguísima de verdad");
    expect(largo.length).toBeLessThanOrEqual(30);
    expect(largo.endsWith("-")).toBe(false);
  });
});

describe("formatCatalogList", () => {
  it("lista solo los activos, ordenados por sort_order, uno por línea", () => {
    const links: CatalogLink[] = [
      link({ id: "1", key: "resonadores", label: "Resonadores", url: "https://drive.google.com/resonadores", sortOrder: 2 }),
      link({ id: "2", key: "cascos", label: "Cascos", url: "https://drive.google.com/cascos", sortOrder: 1 }),
      link({ id: "3", key: "defensas", label: "Defensas", url: "https://drive.google.com/defensas", sortOrder: 3, isActive: false }),
    ];

    expect(formatCatalogList(links)).toBe(
      "• Cascos: https://drive.google.com/cascos\n• Resonadores: https://drive.google.com/resonadores"
    );
  });

  it("sin ningún catálogo activo, la lista queda vacía", () => {
    expect(formatCatalogList([link({ isActive: false })])).toBe("");
  });
});

describe("resolveCatalogMarkers", () => {
  const links: CatalogLink[] = [
    link({ id: "1", key: "cascos", label: "Cascos", url: "https://drive.google.com/cascos", sortOrder: 1 }),
    link({ id: "2", key: "resonadores", label: "Resonadores", url: "https://drive.google.com/resonadores", sortOrder: 2 }),
    link({
      id: "3",
      key: "defensas",
      label: "Defensas",
      url: "https://drive.google.com/defensas",
      sortOrder: 3,
      isActive: false,
    }),
  ];

  it("reemplaza un solo marcador por su URL", () => {
    const { text, missing } = resolveCatalogMarkers("Acá va: {{catalogo:cascos}}", links);
    expect(text).toBe("Acá va: https://drive.google.com/cascos");
    expect(missing).toEqual([]);
  });

  it("reemplaza varios marcadores en el mismo texto", () => {
    const { text, missing } = resolveCatalogMarkers(
      "Cascos: {{catalogo:cascos}} y resonadores: {{catalogo:resonadores}}",
      links
    );
    expect(text).toBe("Cascos: https://drive.google.com/cascos y resonadores: https://drive.google.com/resonadores");
    expect(missing).toEqual([]);
  });

  it("tolera 'catálogo' con tilde, mayúsculas y espacios sueltos dentro de las llaves", () => {
    const { text, missing } = resolveCatalogMarkers("{{ CATÁLOGO : Cascos }}", links);
    expect(text).toBe("https://drive.google.com/cascos");
    expect(missing).toEqual([]);
  });

  it("{{catalogos}} lista solo los activos, en orden, uno por línea", () => {
    const { text, missing } = resolveCatalogMarkers("Ver también: {{catalogos}}", links);
    expect(text).toBe(
      "Ver también: • Cascos: https://drive.google.com/cascos\n• Resonadores: https://drive.google.com/resonadores"
    );
    expect(missing).toEqual([]);
  });

  it("un catálogo inactivo referenciado por clave queda como marcador SIN resolver (D6)", () => {
    const { text, missing } = resolveCatalogMarkers("{{catalogo:defensas}}", links);
    expect(text).toBe("{{catalogo:defensas}}");
    expect(missing).toEqual(["defensas"]);
  });

  it("una clave inexistente también cuenta como missing", () => {
    const { text, missing } = resolveCatalogMarkers("{{catalogo:no-existe}}", links);
    expect(text).toBe("{{catalogo:no-existe}}");
    expect(missing).toEqual(["no-existe"]);
  });

  it("un texto sin marcadores vuelve intacto", () => {
    const { text, missing } = resolveCatalogMarkers("Hola, ¿cómo estás?", links);
    expect(text).toBe("Hola, ¿cómo estás?");
    expect(missing).toEqual([]);
  });

  /**
   * Ajuste hallado implementando T3 (18/9/2026): la primera versión de esta
   * función reemplazaba `{{catalogos}}` sin catálogos activos por una lista
   * VACÍA ("Ver también: " sin nada detrás), un mensaje roto que igual
   * habría salido. D6 dice "un marcador que no resuelve nunca llega al
   * cliente" — acá se aplica el mismo criterio: sin ningún catálogo activo,
   * `{{catalogos}}` cuenta como `missing` (clave sintética `"catalogos"`) y
   * el marcador queda tal cual, para que fase 0 del turno (playbooks.ts)
   * saque el escenario de los candidatos.
   */
  it("{{catalogos}} sin NINGÚN catálogo activo cuenta como missing y el marcador queda tal cual", () => {
    const sinActivos: CatalogLink[] = [link({ isActive: false }), link({ id: "2", key: "otro", isActive: false })];
    const { text, missing } = resolveCatalogMarkers("Ver también: {{catalogos}}", sinActivos);
    expect(text).toBe("Ver también: {{catalogos}}");
    expect(missing).toEqual(["catalogos"]);
  });

  it("con al menos un catálogo activo, {{catalogos}} sigue resolviendo la lista (no es missing)", () => {
    const { text, missing } = resolveCatalogMarkers("Ver también: {{catalogos}}", links);
    expect(text).not.toContain("{{catalogos}}");
    expect(missing).toEqual([]);
  });

  /**
   * Los dos regex son constantes de MÓDULO con flag `g`: si algún consumidor
   * llamara `.test()`/`.exec()` sobre ellas directamente, `lastIndex` quedaría
   * pegado entre llamadas y la segunda invocación podría fallar en falso.
   * `resolveCatalogMarkers` usa `.replace()`, que reinicia `lastIndex` en cada
   * llamada — se prueba corriendo la función dos veces seguidas sobre el
   * MISMO objeto exportado para dejar esto en evidencia si algún día cambia.
   */
  it("llamar la función dos veces seguidas no arrastra estado entre invocaciones", () => {
    const primera = resolveCatalogMarkers("{{catalogo:cascos}}", links);
    const segunda = resolveCatalogMarkers("{{catalogo:cascos}}", links);
    expect(primera).toEqual(segunda);
  });

  /**
   * Corrección de la revisión `code-review high` del 19/9/2026, punto 1: un
   * marcador mal escrito (clave con espacio o guion bajo, sin clave, o sin
   * cerrar) NO calzaba `CATALOG_MARKER`/`CATALOG_LIST_MARKER`, así que
   * `missing` quedaba `[]` y el texto crudo se fugaba al cliente — rompía D6
   * ("un marcador que no resuelve nunca llega al cliente"). Ahora cualquier
   * resto que huela a `{{catalogo…}}` cuenta como sin resolver.
   */
  describe("un marcador mal escrito cuenta como sin resolver, no como texto normal", () => {
    it.each([
      "{{catalogo:cascos_nuevos}}",
      "{{catalogo: exploradoras y bombillos}}",
      "{{catalogo}}",
      "{{catalogo:}}",
    ])("«%s» queda en missing y el texto no cambia", (marcador) => {
      const { text, missing } = resolveCatalogMarkers(`Ver: ${marcador}`, links);
      expect(text).toBe(`Ver: ${marcador}`);
      expect(missing).toHaveLength(1);
      expect(missing[0].toLowerCase()).toContain("catalogo");
    });

    it("un marcador sin cerrar (nunca llega el '}}') también cuenta como sin resolver", () => {
      const { text, missing } = resolveCatalogMarkers("Ver: {{catalogo:cascos", links);
      expect(text).toBe("Ver: {{catalogo:cascos");
      expect(missing).toHaveLength(1);
    });

    it("un `{{catálogo:X}}` bien formado con clave inexistente sigue yendo por el camino normal (missing = la clave, no el texto crudo)", () => {
      const { missing } = resolveCatalogMarkers("{{catálogo:X}}", links);
      expect(missing).toEqual(["X"]);
    });

    it("no duplica en missing un marcador puntual ya contado (clave inactiva)", () => {
      const { missing } = resolveCatalogMarkers("{{catalogo:defensas}}", links);
      expect(missing).toEqual(["defensas"]);
    });

    it("no duplica en missing la lista vacía ya contada", () => {
      const sinActivos: CatalogLink[] = [link({ isActive: false })];
      const { missing } = resolveCatalogMarkers("{{catalogos}}", sinActivos);
      expect(missing).toEqual(["catalogos"]);
    });
  });
});

describe("catalogMarkerFor", () => {
  it("arma el marcador canónico para una clave", () => {
    expect(catalogMarkerFor("cascos")).toBe("{{catalogo:cascos}}");
  });
});

describe("hasRawUrl — un enlace escrito a mano (mismo patrón que hasHardcodedPrice)", () => {
  it.each([
    "Mira el catálogo acá: https://drive.google.com/file/d/1iz77Lc",
    "http://maps.app.goo.gl/xyz",
    "Cascos:https://drive.google.com/x, resonadores en breve",
  ])("lo encuentra en «%s»", (texto) => {
    expect(hasRawUrl(texto)).toBe(true);
  });

  it.each(["Usa {{catalogo:cascos}} para mandar el link", "Hola, ¿cómo estás?", ""])(
    "no lo confunde con un marcador ni con texto normal en «%s»",
    (texto) => {
      expect(hasRawUrl(texto)).toBe(false);
    }
  );
});

// Los dos marcadores quedan exportados para que T3 (fase 0 del turno) y T4
// (botón "Insertar catálogo") los reutilicen sin reinventar la regex.
describe("CATALOG_MARKER / CATALOG_LIST_MARKER quedan exportados", () => {
  it("CATALOG_MARKER es global e insensible a mayúsculas", () => {
    expect(CATALOG_MARKER.flags).toContain("g");
    expect(CATALOG_MARKER.flags).toContain("i");
  });

  it("CATALOG_LIST_MARKER es global e insensible a mayúsculas", () => {
    expect(CATALOG_LIST_MARKER.flags).toContain("g");
    expect(CATALOG_LIST_MARKER.flags).toContain("i");
  });
});
