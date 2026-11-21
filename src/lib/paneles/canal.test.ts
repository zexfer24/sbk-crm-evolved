import { describe, expect, it, vi } from "vitest";
import { VISTAS, vistaDesdeParam } from "./canal";

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
