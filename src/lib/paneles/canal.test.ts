import { afterEach, describe, expect, it, vi } from "vitest";
import { VISTAS, mostrarEquipoTienda, textoEquipoTiendaOculto, vistaDesdeParam } from "./canal";

// Estos tests describen el canal «tienda» visible (D1, 21/11/2026: hoy está oculto); `tienda-oculta.test.tsx` cubre el caso oculto.
vi.mock("@/lib/paneles/canal-config", () => ({ CANAL_TIENDA_VISIBLE: true }));

describe("VISTAS", () => {
  it("tiene Resumen, Online y En tienda con las líneas de contexto del mockup A", () => {
    expect(VISTAS).toEqual([
      { id: "resumen", etiqueta: "Resumen", contexto: "Online y tienda juntos" },
      { id: "online", etiqueta: "Online", contexto: "Ventas armadas desde el chat por los asesores" },
      { id: "tienda", etiqueta: "En tienda", contexto: "Ventas del flujo de Inventario (caja)" },
    ]);
  });
});

describe("vistaDesdeParam", () => {
  it("acepta las tres vistas y cualquier otro valor es «resumen»", () => {
    expect(vistaDesdeParam("online")).toBe("online");
    expect(vistaDesdeParam("tienda")).toBe("tienda");
    expect(vistaDesdeParam("resumen")).toBe("resumen");
    expect(vistaDesdeParam("otra")).toBe("resumen");
    expect(vistaDesdeParam(undefined)).toBe("resumen");
  });
});

describe("mostrarEquipoTienda con la tienda visible", () => {
  it("siempre se muestra, aunque no haya nada (un 0 es información)", () => {
    expect(mostrarEquipoTienda(0)).toBe(true);
    expect(mostrarEquipoTienda(3)).toBe(true);
  });
});

describe("mostrarEquipoTienda con la tienda oculta (D1, 21/11/2026)", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/paneles/canal-config");
    vi.resetModules();
  });

  it("solo aparece si hay algo que mostrar", async () => {
    vi.resetModules();
    vi.doMock("@/lib/paneles/canal-config", () => ({ CANAL_TIENDA_VISIBLE: false }));
    const oculta = await import("./canal");
    expect(oculta.mostrarEquipoTienda(0)).toBe(false);
    expect(oculta.mostrarEquipoTienda(1)).toBe(true);
    expect(oculta.mostrarEquipoTienda(12)).toBe(true);
  });
});

describe("textoEquipoTiendaOculto", () => {
  it("va en singular con uno y en plural con varios", () => {
    expect(textoEquipoTiendaOculto(1)).toBe("1 armado por la caja (la tienda está oculta)");
    expect(textoEquipoTiendaOculto(3)).toBe("3 armados por la caja (la tienda está oculta)");
  });
});
