import { describe, expect, it } from "vitest";
import { puedeVerPaneles } from "./acceso";

describe("puedeVerPaneles", () => {
  it("solo supervisor y admin ven los paneles", () => {
    expect(puedeVerPaneles("supervisor")).toBe(true);
    expect(puedeVerPaneles("admin")).toBe(true);
  });

  it("un asesor, la caja o un rol desconocido no los ven", () => {
    expect(puedeVerPaneles("agent")).toBe(false);
    expect(puedeVerPaneles("caja")).toBe(false);
    expect(puedeVerPaneles(undefined)).toBe(false);
    expect(puedeVerPaneles(null)).toBe(false);
  });
});
