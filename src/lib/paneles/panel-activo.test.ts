import { describe, expect, it } from "vitest";
import { panelActivoDeRuta } from "@/lib/paneles/panel-activo";

describe("panelActivoDeRuta", () => {
  it.each([
    ["/panel", "dashboard"],
    ["/panel/", "dashboard"],
    ["/panel/analiticas", "analiticas"],
    ["/panel/analiticas/", "analiticas"],
    ["/panel/analiticas?periodo=hoy", "analiticas"],
    ["/panel/asesores", "asesores"],
    ["/panel/asesores/x", "asesores"],
  ] as const)("%s → %s", (ruta, esperado) => {
    expect(panelActivoDeRuta(ruta)).toBe(esperado);
  });

  it("un prefijo parecido NO cuenta (/panel/asesoresX es el Dashboard)", () => {
    expect(panelActivoDeRuta("/panel/asesoresX")).toBe("dashboard");
  });

  it("sin ruta (null/undefined/vacía) cae en el Dashboard", () => {
    expect(panelActivoDeRuta(null)).toBe("dashboard");
    expect(panelActivoDeRuta(undefined)).toBe("dashboard");
    expect(panelActivoDeRuta("")).toBe("dashboard");
  });
});
