import { describe, expect, it } from "vitest";
import {
  EMPTY_SEARCH_FILTERS,
  filterSearchTurns,
  periodStart,
  synonymSeed,
  turnMatchesFilters,
  type SearchFilters,
} from "@/lib/catalog-searches";
import type { CatalogSearchQuery, CatalogSearchTurn } from "@/lib/types";

/**
 * Pestaña «Búsquedas» de Control IA (T9, plan "Seba no cotiza lo que no es",
 * 30/9/2026): las reglas puras de filtrado y de qué palabra se le ofrece a
 * «Enseñar sinónimo». Una fila v1 (sin `v`) trae `null` en todo lo de A2:
 * ninguna regla puede tratar ese `null` como «lista vacía» y contarla como
 * dato.
 */

function consulta(overrides: Partial<CatalogSearchQuery> = {}): CatalogSearchQuery {
  return {
    version: 2,
    query: "pastilla freno",
    productos: null,
    terminos: ["pastilla", "freno"],
    moto: [],
    variantes: [],
    relajados: [],
    avisos: [],
    corregido: [],
    correccionDescartada: [],
    decision: "x",
    cotizados: [],
    conteos: null,
    motoIgnorada: false,
    calzaEntero: false,
    resultado: "con_existencia",
    ...overrides,
  };
}

/** Una fila v1: todo lo de A2 en null. */
function consultaV1(overrides: Partial<CatalogSearchQuery> = {}): CatalogSearchQuery {
  return consulta({
    version: 1,
    variantes: null,
    relajados: null,
    avisos: null,
    correccionDescartada: null,
    decision: null,
    cotizados: null,
    conteos: null,
    motoIgnorada: null,
    calzaEntero: null,
    ...overrides,
  });
}

function turno(consultas: CatalogSearchQuery[], overrides: Partial<CatalogSearchTurn> = {}): CatalogSearchTurn {
  return {
    id: "t1",
    conversationId: "c1",
    contactName: "Ana Pérez",
    createdAt: "2026-09-30T15:00:00.000Z",
    customerMessage: "Buenas, ¿tienen pastillas de freno?",
    action: "answered",
    escalationReason: null,
    consultas,
    ...overrides,
  };
}

const con = (over: Partial<SearchFilters>): SearchFilters => ({ ...EMPTY_SEARCH_FILTERS, ...over });

describe("turnMatchesFilters", () => {
  it("sin filtros deja pasar todo, también una fila v1", () => {
    expect(turnMatchesFilters(turno([consultaV1()]), EMPTY_SEARCH_FILTERS)).toBe(true);
    expect(turnMatchesFilters(turno([consulta()]), EMPTY_SEARCH_FILTERS)).toBe(true);
  });

  it("filtra por resultado: pasa el turno si ALGUNA búsqueda tiene ese resultado", () => {
    const t = turno([consulta({ resultado: "con_existencia" }), consulta({ resultado: "agotados" })]);
    expect(turnMatchesFilters(t, con({ resultado: "agotados" }))).toBe(true);
    expect(turnMatchesFilters(t, con({ resultado: "sin_resultados" }))).toBe(false);
  });

  it("filtra por aviso; una fila v1 (avisos null) no tiene ninguno", () => {
    const t = turno([consulta({ avisos: [{ tipo: "universales", productoPedido: null, detalle: "bera" }] })]);
    expect(turnMatchesFilters(t, con({ aviso: "universales" }))).toBe(true);
    expect(turnMatchesFilters(t, con({ aviso: "relajado" }))).toBe(false);
    expect(turnMatchesFilters(turno([consultaV1()]), con({ aviso: "universales" }))).toBe(false);
  });

  it("«con corrección» mira lo corregido; «relajadas», los relajos (v1 no cuenta); «listas», productos", () => {
    const corregida = turno([consulta({ corregido: [{ original: "iphone", corregido: "ipone" }] })]);
    expect(turnMatchesFilters(corregida, con({ conCorreccion: true }))).toBe(true);
    expect(turnMatchesFilters(turno([consulta()]), con({ conCorreccion: true }))).toBe(false);

    const relajada = turno([consulta({ relajados: ["semi"] })]);
    expect(turnMatchesFilters(relajada, con({ relajadas: true }))).toBe(true);
    expect(turnMatchesFilters(turno([consulta()]), con({ relajadas: true }))).toBe(false);
    expect(turnMatchesFilters(turno([consultaV1()]), con({ relajadas: true }))).toBe(false);

    const lista = turno([consulta({ productos: ["visera", "guantes"] })]);
    expect(turnMatchesFilters(lista, con({ listas: true }))).toBe(true);
    expect(turnMatchesFilters(turno([consulta()]), con({ listas: true }))).toBe(false);
  });

  it("los filtros se combinan sobre la MISMA búsqueda, no repartidos entre las de un turno", () => {
    const t = turno([
      consulta({ resultado: "agotados" }),
      consulta({ resultado: "con_existencia", relajados: ["semi"] }),
    ]);
    // Hay una agotada y hay una relajada, pero ninguna es las dos cosas.
    expect(turnMatchesFilters(t, con({ resultado: "agotados", relajadas: true }))).toBe(false);
    expect(turnMatchesFilters(t, con({ resultado: "con_existencia", relajadas: true }))).toBe(true);
  });

  it("el texto libre ignora mayúsculas y acentos y mira lo que dijo el cliente, lo buscado, los productos y lo cotizado", () => {
    const t = turno(
      [
        consulta({
          query: "visera casco",
          productos: ["visera", "guantes"],
          cotizados: [{ productId: "p1", nombre: "VISERA LS2 FUMÉ", stock: 2, precioUsd: 8 }],
        }),
      ],
      { customerMessage: "Necesito una visera para el casco", contactName: "José" }
    );
    for (const texto of ["VISERA", "casco", "guantes", "fume", "jose", "necesito una"]) {
      expect(turnMatchesFilters(t, con({ texto })), texto).toBe(true);
    }
    expect(turnMatchesFilters(t, con({ texto: "bujia" }))).toBe(false);
    expect(turnMatchesFilters(t, con({ texto: "   " }))).toBe(true);
  });
});

describe("filterSearchTurns", () => {
  it("conserva el orden y devuelve solo los turnos que pasan", () => {
    const a = turno([consulta({ resultado: "agotados" })], { id: "a" });
    const b = turno([consulta({ resultado: "con_existencia" })], { id: "b" });
    const c = turno([consulta({ resultado: "agotados" })], { id: "c" });
    expect(filterSearchTurns([a, b, c], con({ resultado: "agotados" })).map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("synonymSeed", () => {
  it("prefiere el primer término que D3 relajó (el que no estaba en ningún nombre)", () => {
    expect(synonymSeed(consulta({ relajados: ["semi", "sintetico"], terminos: ["aceite"] }))).toBe("semi");
  });

  it("sin relajos, en una búsqueda sin resultados ofrece el primer término obligatorio", () => {
    expect(synonymSeed(consulta({ resultado: "sin_resultados", terminos: ["pastilla", "freno"] }))).toBe("pastilla");
  });

  it("una fila v1 (relajados null) cae en el primer obligatorio si no encontró nada", () => {
    expect(synonymSeed(consultaV1({ resultado: "sin_resultados", terminos: ["pastilla", "freno"] }))).toBe("pastilla");
  });

  it("si la búsqueda encontró algo y nada se relajó, no hay término que ofrecer (campo vacío)", () => {
    expect(synonymSeed(consulta({ resultado: "con_existencia", relajados: [] }))).toBe("");
    expect(synonymSeed(consultaV1({ resultado: "con_existencia" }))).toBe("");
  });
});

describe("periodStart", () => {
  const ahora = new Date("2026-09-30T15:00:00.000Z"); // 11:00 en Caracas (UTC-4)

  it("«hoy» es la medianoche de Caracas, no la del navegador ni la UTC", () => {
    expect(periodStart("hoy", ahora)).toBe("2026-09-30T04:00:00.000Z");
  });

  it("7 y 30 días son exactamente esos días hacia atrás desde ahora", () => {
    expect(periodStart("7", ahora)).toBe("2026-09-23T15:00:00.000Z");
    expect(periodStart("30", ahora)).toBe("2026-08-31T15:00:00.000Z");
  });
});
