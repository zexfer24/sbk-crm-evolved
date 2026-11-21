import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { rangosDeAnaliticas, rangosDelDashboard } from "@/lib/paneles/rangos";
import { INICIO_PANELES, rangoDe, rangoPrevio, TEXTO_INICIO_PANELES } from "@/lib/paneles/periodos";

// Estos tests describen el canal «tienda» visible (D1, 21/11/2026: hoy está oculto); `tienda-oculta.test.tsx` cubre el caso oculto.
vi.mock("@/lib/paneles/canal-config", () => ({ CANAL_TIENDA_VISIBLE: true }));

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
 *
 * 21/11/2026 (plan "Los paneles cuentan desde el lunes 16/11/2026"): el reloj
 * de estos tests pasó al 21/11 09:20 de Caracas, DESPUÉS del piso de datos
 * (16/11), para ejercitar el comportamiento real: ningún rango arranca antes
 * del piso, el período previo desaparece (`null`, sin llamar a su RPC) y un
 * rango vacío no llama a su RPC. Otros tests fijan el reloj el 13/11 (antes
 * del piso) y el 30/11 (con un previo comparable).
 */

const AHORA = new Date("2026-11-21T09:20:00-04:00");
// Después del piso con un previo comparable completo: 7 días anteriores = 17/11 -> 23/11 10:00.
const AHORA_CON_PREVIO = new Date("2026-11-30T10:00:00-04:00");
// Antes del piso: todo rango queda vacío.
const AHORA_ANTES_DEL_PISO = new Date("2026-11-13T18:30:00-04:00");

const fetchPanelVentas = vi.fn();
const fetchPanelConversaciones = vi.fn();
const fetchPanelAsesores = vi.fn();
const fetchPanelCola = vi.fn();
const fetchPanelVentasActivas = vi.fn();
const fetchMetasVenta = vi.fn();
// Los dos helpers de bloque vacío son puros: se usan los de verdad para que el
// test compruebe el objeto que de verdad le llega a la vista.
vi.mock("@/lib/paneles-data", async () => {
  const real = await vi.importActual<typeof import("@/lib/paneles-data")>("@/lib/paneles-data");
  return {
    bloqueAntesDelInicio: real.bloqueAntesDelInicio,
    bloqueConTopeAntesDelInicio: real.bloqueConTopeAntesDelInicio,
    fetchPanelVentas: (...a: unknown[]) => fetchPanelVentas(...a),
    fetchPanelConversaciones: (...a: unknown[]) => fetchPanelConversaciones(...a),
    fetchPanelAsesores: (...a: unknown[]) => fetchPanelAsesores(...a),
    fetchPanelCola: (...a: unknown[]) => fetchPanelCola(...a),
    fetchPanelVentasActivas: (...a: unknown[]) => fetchPanelVentasActivas(...a),
    fetchMetasVenta: (...a: unknown[]) => fetchMetasVenta(...a),
  };
});

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
    expect(p.ventasPrevio).toBeNull();
    expect(marcaDe(p.ventasHoy)).toBe(marca(r.hoy.desde, r.hoy.hasta));
    expect(marcaDe(p.ventasHistoria)).toBe(marca(r.historia.desde, r.historia.hasta));
    expect(marcaDe(p.ventasAnio)).toBe(marca(r.anio.desde, r.anio.hasta));
    expect(marcaDe(p.conversaciones)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(marcaDe(p.ventasActivas)).toBe("activas");
    expect(p.horario).toBe(HORARIO);
    expect(p.tasaBcv).toBe(48.5);
    expect((p.ahora as Date).getTime()).toBe(AHORA.getTime());
    expect(p.rangos).toEqual(r);

    // Tres lecturas de ventas (período, hoy, historia): el previo no existe y el
    // año (16/11 -> ahora) es el mismo rango que «7 días», así que comparte su promesa.
    expect(p.ventasAnio).toBe(p.ventas);
    expect(fetchPanelVentas).toHaveBeenCalledTimes(3);
    expect(fetchPanelConversaciones).toHaveBeenCalledTimes(1);
  });

  it("con un previo comparable (30/11, «7 días») lo lee con SU rango: 5 RPC de ventas", async () => {
    vi.setSystemTime(AHORA_CON_PREVIO);
    const p = await propsDe("dashboard", { periodo: "7d" });
    const r = rangosDelDashboard("7d", AHORA_CON_PREVIO);
    expect(r.previo).not.toBeNull();
    expect(r.previo!.desde.toISOString()).toBe("2026-11-17T04:00:00.000Z");
    expect(marcaDe(p.ventasPrevio)).toBe(marca(r.previo!.desde, r.previo!.hasta));
    expect(marcaDe(p.ventas)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(fetchPanelVentas).toHaveBeenCalledTimes(5);
  });

  it("con el previo anterior al piso NO se llama a la RPC del previo y la vista recibe null", async () => {
    const p = await propsDe("dashboard", { periodo: "hoy" });
    expect(p.ventasPrevio).toBeNull();
    expect((p.rangos as ReturnType<typeof rangosDelDashboard>).previo).toBeNull();
    const rangosPedidos = fetchPanelVentas.mock.calls.map(([, desde, hasta]) => marca(desde as Date, hasta as Date));
    const previoDeCalendario = rangoPrevio("hoy", AHORA, null)!;
    expect(rangosPedidos).not.toContain(marca(previoDeCalendario.desde, previoDeCalendario.hasta));
  });

  it("con un reloj anterior al piso los rangos quedan vacíos: ninguna RPC con rango y la vista recibe bloqueAntesDelInicio()", async () => {
    vi.setSystemTime(AHORA_ANTES_DEL_PISO);
    const p = await propsDe("dashboard", { periodo: "7d" });
    const sinDatos = { ok: false, motivo: "no_disponible", detalle: TEXTO_INICIO_PANELES };
    expect(fetchPanelVentas).not.toHaveBeenCalled();
    expect(fetchPanelConversaciones).not.toHaveBeenCalled();
    for (const bloque of [p.ventas, p.ventasHoy, p.ventasHistoria, p.ventasAnio]) {
      expect(bloque).toEqual(sinDatos);
    }
    expect(p.ventasPrevio).toBeNull();
    expect(p.conversaciones).toEqual({ ...sinDatos, recortado: false });
    // Lo que no depende del piso se lee igual.
    expect(marcaDe(p.ventasActivas)).toBe("activas");
    expect(p.tasaBcv).toBe(48.5);
  });

  // 15/11/2026 (code-review): con «Hoy» el período y «hoy» son el mismo rango, y
  // con «Este año» el período y el año; pedirlos dos veces duplica una RPC pesada.
  // Desde el 21/11/2026 el piso hace que «7 días», «30 días», «Este mes» y «Este año»
  // arranquen todos el 16/11: son el mismo rango que el año y comparten su lectura.
  it.each(["hoy", "7d", "30d", "mes", "anio"])(
    "?periodo=%s: el período y su rango gemelo comparten UNA lectura (3 RPC de ventas, sin previo)",
    async (valor) => {
      const p = await propsDe("dashboard", { periodo: valor });
      const r = p.rangos as ReturnType<typeof rangosDelDashboard>;
      expect(fetchPanelVentas).toHaveBeenCalledTimes(3);
      const gemelo = valor === "hoy" ? p.ventasHoy : p.ventasAnio;
      expect(p.ventas).toBe(gemelo);
      expect(marcaDe(p.ventas)).toBe(marca(r.periodo.desde, r.periodo.hasta));
      expect(p.ventasPrevio).toBeNull();
      expect(marcaDe(p.ventasHistoria)).toBe(marca(r.historia.desde, r.historia.hasta));
    }
  );

  it("la historia va del piso a la medianoche de hoy, y el año arranca el 16/11 de Caracas", async () => {
    const p = await propsDe("dashboard", {});
    const r = p.rangos as ReturnType<typeof rangosDelDashboard>;
    expect(r.historia.hasta.getTime()).toBe(r.hoy.desde.getTime());
    expect(r.historia.desde.toISOString()).toBe(INICIO_PANELES.toISOString());
    expect(r.anio.desde.toISOString()).toBe("2026-11-16T04:00:00.000Z");
    expect(r.piso).toEqual(INICIO_PANELES);
    expect(r.hoyClave).toBe("2026-11-21");
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
    expect(p.ventasPrevio).toBeNull();
    expect(marcaDe(p.conversaciones)).toBe(marca(r.periodo.desde, r.periodo.hasta));
    expect(p.conversacionesPrevio).toBeNull();
    expect(marcaDe(p.ventasAnio)).toBe(marca(r.anio.desde, r.anio.hasta));
    expect(marcaDe(p.ventasUltimos40)).toBe(marca(r.ultimos40.desde, r.ultimos40.hasta));
    expect(marcaDe(p.ventasActivas)).toBe("activas");
    expect(p.horario).toBe(HORARIO);
    expect(p.tasaBcv).toBe(48.5);
    expect(p.rangos).toEqual(r);
    // Ventas: período, año y últimos 40 días (el previo no existe). Conversaciones: solo el período.
    expect(fetchPanelVentas).toHaveBeenCalledTimes(3);
    expect(fetchPanelConversaciones).toHaveBeenCalledTimes(1);
  });

  it("con un previo comparable (30/11, «7 días») lee ventas y conversaciones del previo: 4 y 2 RPC", async () => {
    vi.setSystemTime(AHORA_CON_PREVIO);
    const p = await propsDe("analiticas", { periodo: "7d" });
    const previo = rangoPrevio("7d", AHORA_CON_PREVIO)!;
    expect(marcaDe(p.ventasPrevio)).toBe(marca(previo.desde, previo.hasta));
    expect(marcaDe(p.conversacionesPrevio)).toBe(marca(previo.desde, previo.hasta));
    expect(fetchPanelVentas).toHaveBeenCalledTimes(4);
    expect(fetchPanelConversaciones).toHaveBeenCalledTimes(2);
  });

  it("con el previo anterior al piso NO se llama a la RPC del previo y la vista recibe null en los dos", async () => {
    const p = await propsDe("analiticas", { periodo: "hoy" });
    expect(p.ventasPrevio).toBeNull();
    expect(p.conversacionesPrevio).toBeNull();
    expect((p.rangos as ReturnType<typeof rangosDeAnaliticas>).previo).toBeNull();
    const previoDeCalendario = rangoPrevio("hoy", AHORA, null)!;
    for (const llamada of [...fetchPanelVentas.mock.calls, ...fetchPanelConversaciones.mock.calls]) {
      expect(marca(llamada[1] as Date, llamada[2] as Date)).not.toBe(
        marca(previoDeCalendario.desde, previoDeCalendario.hasta)
      );
    }
  });

  it("con un reloj anterior al piso los rangos quedan vacíos: ninguna RPC con rango y llega bloqueAntesDelInicio()", async () => {
    vi.setSystemTime(AHORA_ANTES_DEL_PISO);
    const p = await propsDe("analiticas", { periodo: "30d" });
    const sinDatos = { ok: false, motivo: "no_disponible", detalle: TEXTO_INICIO_PANELES };
    expect(fetchPanelVentas).not.toHaveBeenCalled();
    expect(fetchPanelConversaciones).not.toHaveBeenCalled();
    for (const bloque of [p.ventas, p.ventasAnio, p.ventasUltimos40]) expect(bloque).toEqual(sinDatos);
    expect(p.conversaciones).toEqual({ ...sinDatos, recortado: false });
    expect(p.ventasPrevio).toBeNull();
    expect(p.conversacionesPrevio).toBeNull();
  });

  it("los últimos 40 días incluyen hoy y no arrancan antes del piso", async () => {
    const p = await propsDe("analiticas", {});
    const r = p.rangos as ReturnType<typeof rangosDeAnaliticas>;
    expect(r.ultimos40.hasta.getTime()).toBe(AHORA.getTime());
    expect(r.ultimos40.desde.toISOString()).toBe("2026-11-16T04:00:00.000Z");
    expect(r.piso).toEqual(INICIO_PANELES);
  });

  it("el periodo «Este mes» arranca en el piso (16/11), no el 1/11", async () => {
    const p = await propsDe("analiticas", { periodo: "mes" });
    expect(rangoDe("mes", AHORA).desde.toISOString()).toBe("2026-11-16T04:00:00.000Z");
    expect((p.rangos as ReturnType<typeof rangosDeAnaliticas>).periodo.desde.toISOString()).toBe(
      "2026-11-16T04:00:00.000Z"
    );
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

  it("con un reloj anterior al piso el rango queda vacío: ninguna RPC con rango y llega bloqueAntesDelInicio(); la cola se lee igual", async () => {
    vi.setSystemTime(AHORA_ANTES_DEL_PISO);
    const p = await propsDe("asesores", { periodo: "30d" });
    const sinDatos = { ok: false, motivo: "no_disponible", detalle: TEXTO_INICIO_PANELES };
    expect(fetchPanelVentas).not.toHaveBeenCalled();
    expect(fetchPanelConversaciones).not.toHaveBeenCalled();
    expect(fetchPanelAsesores).not.toHaveBeenCalled();
    expect(p.ventas).toEqual(sinDatos);
    expect(p.asesores).toEqual({ ...sinDatos, recortado: false });
    expect(p.conversaciones).toEqual({ ...sinDatos, recortado: false });
    expect(marcaDe(p.cola)).toBe("cola");
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
