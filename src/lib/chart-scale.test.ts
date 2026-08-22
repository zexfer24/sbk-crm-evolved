import { describe, expect, it } from "vitest";
import { gridValuesFor } from "@/lib/chart-scale";

describe("gridValuesFor", () => {
  /**
   * El caso que rompía los dos gráficos del CRM: sin datos, el pico cae a 1
   * y la línea intermedia queda en 0,5. Al redondearla para pintar la
   * etiqueta daba "1", igual que el tope, así que el eje mostraba "1" dos
   * veces.
   */
  it("no repite la etiqueta del tope cuando el pico es 1", () => {
    expect(gridValuesFor(1)).toEqual([0, 1]);
  });

  it("con picos chicos tampoco repite valores", () => {
    expect(gridValuesFor(2)).toEqual([0, 1, 2]);
    expect(gridValuesFor(3)).toEqual([0, 2, 3]);
  });

  it("con picos grandes marca base, mitad y tope", () => {
    expect(gridValuesFor(1000)).toEqual([0, 500, 1000]);
    expect(gridValuesFor(37)).toEqual([0, 19, 37]);
  });

  it("siempre empieza en cero y termina en el pico", () => {
    for (const peak of [1, 2, 5, 9, 100, 12345]) {
      const values = gridValuesFor(peak);
      expect(values[0]).toBe(0);
      expect(values[values.length - 1]).toBe(peak);
    }
  });

  it("devuelve enteros: las etiquetas del eje no muestran decimales", () => {
    for (const peak of [1, 3, 7, 15, 999]) {
      for (const value of gridValuesFor(peak)) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});
