import { describe, expect, it } from "vitest";
import { nombreCanalUnico } from "@/lib/realtime-channel-name";

describe("nombreCanalUnico", () => {
  it("dos llamadas con la misma base dan nombres distintos, los dos prefijados con la base", () => {
    const a = nombreCanalUnico("saint-borradores-presupuesto-pr-1");
    const b = nombreCanalUnico("saint-borradores-presupuesto-pr-1");

    expect(a).not.toBe(b);
    expect(a.startsWith("saint-borradores-presupuesto-pr-1:")).toBe(true);
    expect(b.startsWith("saint-borradores-presupuesto-pr-1:")).toBe(true);
  });
});
