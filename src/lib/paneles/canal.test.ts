import { describe, expect, it } from "vitest";
import { VISTAS } from "./canal";

describe("VISTAS", () => {
  it("tiene Resumen, Online y En tienda con las líneas de contexto del mockup A", () => {
    expect(VISTAS).toEqual([
      { id: "resumen", etiqueta: "Resumen", contexto: "Online y tienda juntos" },
      { id: "online", etiqueta: "Online", contexto: "Ventas armadas desde el chat por los asesores" },
      { id: "tienda", etiqueta: "En tienda", contexto: "Ventas del flujo de Inventario (caja)" },
    ]);
  });
});
