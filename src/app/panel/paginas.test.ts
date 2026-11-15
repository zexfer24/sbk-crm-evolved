import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { rangosDeAnaliticas, rangosDelDashboard } from "@/lib/paneles/rangos";
import { rangoDe, rangoPrevio } from "@/lib/paneles/periodos";

/**
 * Plan "Paneles" (13/11/2026), C2/C3: las tres páginas de `/panel` son server
 * components que leen TODO lo que su panel va a necesitar y se lo pasan a la
 * vista por props. Así las vistas finales (C4–C6) no tienen que tocar
 * `page.tsx`. Lo que se prueba acá es el cableado: qué rango lee cada bloque,
 * cómo se interpretan `?periodo=` y `?vista=` y, desde el 15/11/2026, que CADA
 * página verifica el rol ANTES de leer nada (ver el último `describe`): el
 * layout y la página se renderizan en paralelo, así que un asesor que abría
 * `/panel` igual disparaba las ~10 RPC `panel_*` y el servidor registraba un
 * `no autorizado` por intento.
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

class Redireccion extends Error {
  constructor(public destino: string) {
    super(`redirect:${destino}`);
  }
}
// `redirect` de Next LANZA para cortar el render; el mock hace lo mismo.
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redireccion(destino);
  },
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
  // Las páginas verifican el rol ellas mismas; salvo que un test diga otra cosa, quien mira es supervisor.
  fetchCurrentAgent.mockResolvedValue({ id: "a-1", role: "supervisor" });
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

  // 15/11/2026 (code-review): con «Hoy» el período y «hoy» son el mismo rango, y
  // con «Este año» el período y el año; pedirlos dos veces duplica una RPC pesada.
  it.each(["hoy", "anio"])("?periodo=%s: período y su rango gemelo comparten UNA lectura (4 RPC, no 5)", async (valor) => {
    const p = await propsDe("dashboard", { periodo: valor });
    const r = p.rangos as ReturnType<typeof rangosDelDashboard>;
    expect(fetchPanelVentas).toHaveBeenCalledTimes(4);
    const gemelo = valor === "hoy" ? p.ventasHoy : p.ventasAnio;
    expect(p.ventas).toBe(gemelo);
    expect(marcaDe(p.ventas)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(marcaDe(p.ventasPrevio)).toBe(marca(r.previo.desde, r.previo.hasta));
    expect(marcaDe(p.ventasHistoria)).toBe(marca(r.historia.desde, r.historia.hasta));
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

  // 15/11/2026: las RPC de Asesores recortan a 92 días y el control solo ofrece
  // hoy/7d/30d; "mes" y "anio" valen en los otros paneles pero acá caen en hoy.
  it.each(["anio", "mes"])("?periodo=%s lee el rango de hoy, no un mes ni un año", async (valor) => {
    const p = await propsDe("asesores", { periodo: valor });
    const hoy = rangoDe("hoy", AHORA);
    expect(p.periodo).toBe("hoy");
    expect(p.rango).toEqual(hoy);
    expect(marcaDe(p.asesores)).toBe(marca(hoy.desde, hoy.hasta));
    expect(marcaDe(p.conversaciones)).toBe(marca(hoy.desde, hoy.hasta));
    expect(marcaDe(p.ventas)).toBe(marca(hoy.desde, hoy.hasta));
  });
});

/**
 * 15/11/2026: el candado de rol ya no es solo del layout. En el App Router el
 * layout y la página se renderizan EN PARALELO, y un layout no se vuelve a
 * ejecutar al navegar entre páginas hermanas desde el cliente (la doc de Next:
 * "Layouts and auth checks"). Antes un asesor que abría `/panel` redirigía por
 * el layout, pero la página igual lanzaba sus RPC `panel_*`, respondían 42501 y
 * quedaba un `no autorizado` en el log por cada intento. Ahora la página llama
 * a `exigirAccesoPaneles` ANTES del `Promise.all`.
 */
describe("el rol se verifica en cada página, antes de leer nada", () => {
  const PAGINAS = ["dashboard", "analiticas", "asesores"] as const;

  /** Ninguna lectura de datos puede haber salido: ni las RPC `panel_*` ni las auxiliares. */
  function ningunaLectura() {
    for (const lectura of [
      fetchPanelVentas,
      fetchPanelConversaciones,
      fetchPanelAsesores,
      fetchPanelCola,
      fetchPanelVentasActivas,
      fetchMetasVenta,
      fetchBusinessHours,
      fetchLatestBcvRate,
    ]) {
      expect(lectura).not.toHaveBeenCalled();
    }
  }

  it.each(PAGINAS)("%s: un agent es redirigido a /recorrido y no se llama ninguna lectura", async (ruta) => {
    fetchCurrentAgent.mockResolvedValue({ id: "a-2", role: "agent" });

    await expect(propsDe(ruta, {})).rejects.toMatchObject({ destino: "/recorrido" });
    ningunaLectura();
  });

  it.each(PAGINAS)("%s: la caja tampoco lee (fallar cerrado)", async (ruta) => {
    fetchCurrentAgent.mockResolvedValue({ id: "a-3", role: "caja" });

    await expect(propsDe(ruta, {})).rejects.toMatchObject({ destino: "/recorrido" });
    ningunaLectura();
  });

  it.each(PAGINAS)("%s: sin sesión va a /login y no lee nada", async (ruta) => {
    fetchCurrentAgent.mockResolvedValue(null);

    await expect(propsDe(ruta, {})).rejects.toMatchObject({ destino: "/login" });
    ningunaLectura();
  });

  it.each(PAGINAS)("%s: un admin lee igual que un supervisor", async (ruta) => {
    fetchCurrentAgent.mockResolvedValue({ id: "a-4", role: "admin" });

    const p = await propsDe(ruta, {});
    expect(p.periodo).toBe("hoy");
    expect(fetchPanelVentas).toHaveBeenCalled();
  });

  it.each(PAGINAS)("%s: las lecturas usan el cliente que devolvió el candado", async (ruta) => {
    await propsDe(ruta, {});
    expect(fetchPanelVentas.mock.calls[0][0]).toBe(SUPABASE);
  });
});
