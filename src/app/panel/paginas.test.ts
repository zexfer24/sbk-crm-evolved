import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { rangosDeAnaliticas, rangosDelDashboard } from "@/lib/paneles/rangos";
import { rangoDe, rangoPrevio } from "@/lib/paneles/periodos";

/**
 * Plan "Paneles" (13/11/2026), C2/C3: las tres páginas de `/panel` son server
 * components que leen TODO lo que su panel va a necesitar y se lo pasan a la
 * vista por props. Así las vistas finales (C4–C6) no tienen que tocar
 * `page.tsx`. Lo que se prueba acá es el cableado: qué rango lee cada bloque,
 * cómo se interpretan `?periodo=` y `?vista=` y que NINGUNA página repite la
 * consulta del agente (la hace el layout).
 *
 * Cada lectura se mockea devolviendo una marca con el rango pedido: si una
 * página cruzara dos bloques (p. ej. pasar el período previo como el de hoy)
 * la marca no calzaría con la esperada.
 */

const AHORA = new Date("2026-11-13T18:30:00-04:00");

const fetchPanelVentas = vi.fn();
const fetchPanelConversaciones = vi.fn();
const fetchPanelAsesores = vi.fn();
const fetchPanelCola = vi.fn();
const fetchPanelVentasActivas = vi.fn();
const fetchMetasVenta = vi.fn();
vi.mock("@/lib/paneles-data", () => ({
  fetchPanelVentas: (...a: unknown[]) => fetchPanelVentas(...a),
  fetchPanelConversaciones: (...a: unknown[]) => fetchPanelConversaciones(...a),
  fetchPanelAsesores: (...a: unknown[]) => fetchPanelAsesores(...a),
  fetchPanelCola: (...a: unknown[]) => fetchPanelCola(...a),
  fetchPanelVentasActivas: (...a: unknown[]) => fetchPanelVentasActivas(...a),
  fetchMetasVenta: (...a: unknown[]) => fetchMetasVenta(...a),
}));

const fetchCurrentAgent = vi.fn();
const fetchBusinessHours = vi.fn();
const fetchLatestBcvRate = vi.fn();
vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: (...a: unknown[]) => fetchCurrentAgent(...a),
  fetchBusinessHours: (...a: unknown[]) => fetchBusinessHours(...a),
  fetchLatestBcvRate: (...a: unknown[]) => fetchLatestBcvRate(...a),
}));

const SUPABASE = { __cliente: "supabase" };
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => SUPABASE),
}));

vi.mock("@/components/paneles/dashboard-view", () => ({ DashboardView: () => null }));
vi.mock("@/components/paneles/analiticas-view", () => ({ AnaliticasView: () => null }));
vi.mock("@/components/paneles/asesores-view", () => ({ AsesoresView: () => null }));

const HORARIO = { __horario: true };

/** La marca que devuelve cada lectura con rango: dice QUÉ rango se pidió. */
function marca(desde: Date, hasta: Date): string {
  return `${desde.toISOString()}|${hasta.toISOString()}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AHORA);
  fetchPanelVentas.mockImplementation(async (_sb: unknown, desde: Date, hasta: Date) => ({
    ok: true,
    dato: { marca: marca(desde, hasta) },
  }));
  fetchPanelConversaciones.mockImplementation(async (_sb: unknown, desde: Date, hasta: Date) => ({
    ok: true,
    dato: { marca: marca(desde, hasta) },
    recortado: false,
  }));
  fetchPanelAsesores.mockImplementation(async (_sb: unknown, desde: Date, hasta: Date) => ({
    ok: true,
    dato: { marca: marca(desde, hasta) },
    recortado: false,
  }));
  fetchPanelCola.mockResolvedValue({ ok: true, dato: { marca: "cola" } });
  fetchPanelVentasActivas.mockResolvedValue({ ok: true, dato: { marca: "activas" } });
  fetchMetasVenta.mockResolvedValue({ ok: true, dato: [{ marca: "metas" }] });
  fetchBusinessHours.mockResolvedValue(HORARIO);
  fetchLatestBcvRate.mockResolvedValue(48.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

type Propiedades = Record<string, unknown>;

async function propsDe(ruta: "dashboard" | "analiticas" | "asesores", searchParams: Record<string, string | string[] | undefined>) {
  const modulo =
    ruta === "dashboard"
      ? await import("./page")
      : ruta === "analiticas"
        ? await import("./analiticas/page")
        : await import("./asesores/page");
  const elemento = (await modulo.default({ searchParams: Promise.resolve(searchParams) })) as ReactElement<Propiedades>;
  return elemento.props;
}

const marcaDe = (bloque: unknown) => (bloque as { dato: { marca: string } }).dato.marca;

describe("panel/page.tsx (Dashboard)", () => {
  it("lee cada bloque con SU rango y pasa todo a la vista", async () => {
    const p = await propsDe("dashboard", { periodo: "7d", vista: "online" });
    const r = rangosDelDashboard("7d", AHORA);

    expect(p.periodo).toBe("7d");
    expect(p.vista).toBe("online");
    expect(marcaDe(p.ventas)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(marcaDe(p.ventasPrevio)).toBe(marca(r.previo.desde, r.previo.hasta));
    expect(marcaDe(p.ventasHoy)).toBe(marca(r.hoy.desde, r.hoy.hasta));
    expect(marcaDe(p.ventasHistoria)).toBe(marca(r.historia.desde, r.historia.hasta));
    expect(marcaDe(p.ventasAnio)).toBe(marca(r.anio.desde, r.anio.hasta));
    expect(marcaDe(p.conversaciones)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(marcaDe(p.ventasActivas)).toBe("activas");
    expect(p.horario).toBe(HORARIO);
    expect(p.tasaBcv).toBe(48.5);
    expect((p.ahora as Date).getTime()).toBe(AHORA.getTime());
    expect(p.rangos).toEqual(r);

    // Cinco lecturas de ventas (período, previo, hoy, historia, año), una de conversaciones.
    expect(fetchPanelVentas).toHaveBeenCalledTimes(5);
    expect(fetchPanelConversaciones).toHaveBeenCalledTimes(1);
  });

  it("la historia de 40 días termina donde empieza hoy, y el año arranca el 1/1 de Caracas", async () => {
    const p = await propsDe("dashboard", {});
    const r = p.rangos as ReturnType<typeof rangosDelDashboard>;
    expect(r.historia.hasta.getTime()).toBe(r.hoy.desde.getTime());
    expect(r.hoy.desde.getTime() - r.historia.desde.getTime()).toBe(40 * 24 * 3600 * 1000);
    expect(r.anio.desde.toISOString()).toBe("2026-01-01T04:00:00.000Z");
    expect(r.hoyClave).toBe("2026-11-13");
  });

  it("un periodo o una vista desconocidos caen en hoy y resumen; un parámetro repetido usa el primero", async () => {
    const desconocidos = await propsDe("dashboard", { periodo: "siglo", vista: "otra" });
    expect(desconocidos.periodo).toBe("hoy");
    expect(desconocidos.vista).toBe("resumen");

    const repetido = await propsDe("dashboard", { periodo: ["30d", "7d"], vista: ["tienda", "online"] });
    expect(repetido.periodo).toBe("30d");
    expect(repetido.vista).toBe("tienda");
  });

  it("no vuelve a consultar al agente: eso es del layout", async () => {
    await propsDe("dashboard", {});
    expect(fetchCurrentAgent).not.toHaveBeenCalled();
  });

  it("un bloque degradado llega tal cual a la vista, sin tumbar a los demás", async () => {
    fetchPanelCola.mockResolvedValue({ ok: false, motivo: "error", detalle: "x" });
    fetchPanelVentasActivas.mockResolvedValue({ ok: false, motivo: "no_disponible", detalle: "y" });
    const p = await propsDe("dashboard", {});
    expect(p.ventasActivas).toEqual({ ok: false, motivo: "no_disponible", detalle: "y" });
    expect(marcaDe(p.ventas)).toContain("|");
  });
});

describe("panel/analiticas/page.tsx", () => {
  it("lee período y previo de ventas y conversaciones, el año y los últimos 40 días", async () => {
    const p = await propsDe("analiticas", { periodo: "30d", vista: "tienda" });
    const r = rangosDeAnaliticas("30d", AHORA);

    expect(p.periodo).toBe("30d");
    expect(p.vista).toBe("tienda");
    expect(marcaDe(p.ventas)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(marcaDe(p.ventasPrevio)).toBe(marca(r.previo.desde, r.previo.hasta));
    expect(marcaDe(p.conversaciones)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(marcaDe(p.conversacionesPrevio)).toBe(marca(r.previo.desde, r.previo.hasta));
    expect(marcaDe(p.ventasAnio)).toBe(marca(r.anio.desde, r.anio.hasta));
    expect(marcaDe(p.ventasUltimos40)).toBe(marca(r.ultimos40.desde, r.ultimos40.hasta));
    expect(marcaDe(p.ventasActivas)).toBe("activas");
    expect(p.horario).toBe(HORARIO);
    expect(p.tasaBcv).toBe(48.5);
    expect(p.rangos).toEqual(r);
    expect(fetchPanelVentas).toHaveBeenCalledTimes(4);
    expect(fetchPanelConversaciones).toHaveBeenCalledTimes(2);
  });

  it("los últimos 40 días incluyen hoy y cubren exactamente 40 días de Caracas", async () => {
    const p = await propsDe("analiticas", {});
    const r = p.rangos as ReturnType<typeof rangosDeAnaliticas>;
    expect(r.ultimos40.hasta.getTime()).toBe(AHORA.getTime());
    expect(r.ultimos40.desde.toISOString()).toBe("2026-10-05T04:00:00.000Z");
  });

  it("el periodo previo usa la misma regla que el resto de los paneles", async () => {
    const p = await propsDe("analiticas", { periodo: "mes" });
    const previo = rangoPrevio("mes", AHORA);
    expect(marcaDe(p.ventasPrevio)).toBe(marca(previo.desde, previo.hasta));
    expect(rangoDe("mes", AHORA).desde.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("panel/asesores/page.tsx", () => {
  it("lee asesores, conversaciones y ventas del período, la cola y el horario", async () => {
    const p = await propsDe("asesores", { periodo: "7d" });
    const periodo = rangoDe("7d", AHORA);

    expect(p.periodo).toBe("7d");
    expect(marcaDe(p.asesores)).toBe(marca(periodo.desde, periodo.hasta));
    expect(marcaDe(p.conversaciones)).toBe(marca(periodo.desde, periodo.hasta));
    expect(marcaDe(p.ventas)).toBe(marca(periodo.desde, periodo.hasta));
    expect(marcaDe(p.cola)).toBe("cola");
    expect(p.horario).toBe(HORARIO);
    expect(p.rango).toEqual(periodo);
    expect((p.ahora as Date).getTime()).toBe(AHORA.getTime());
    expect(fetchPanelVentas).toHaveBeenCalledTimes(1);
    expect(fetchPanelConversaciones).toHaveBeenCalledTimes(1);
    expect(fetchPanelAsesores).toHaveBeenCalledTimes(1);
  });

  it("no pide metas, ventas en curso ni la tasa BCV: no las usa", async () => {
    await propsDe("asesores", {});
    expect(fetchMetasVenta).not.toHaveBeenCalled();
    expect(fetchPanelVentasActivas).not.toHaveBeenCalled();
    expect(fetchLatestBcvRate).not.toHaveBeenCalled();
  });

  it("un periodo desconocido es hoy", async () => {
    const p = await propsDe("asesores", { periodo: "xyz" });
    expect(p.periodo).toBe("hoy");
  });
});
