import { describe, expect, it } from "vitest";
import { rangoDe } from "./periodos";
import { rangosDelDashboard, rangosDeAnaliticas } from "./rangos";

/**
 * Plan "Paneles" (13/11/2026): los rangos que cada página lee viven aquí, para
 * que `page.tsx` quede delgada y el cálculo de "hoy", "los 40 días anteriores"
 * y "el año" se pruebe con un reloj fijo. `ahora` = 13/11/2026 15:00 en Caracas.
 */

const AHORA = new Date("2026-11-13T19:00:00Z");
const MEDIANOCHE_HOY = new Date("2026-11-13T04:00:00Z");
const DIA_MS = 24 * 60 * 60 * 1000;

describe("rangosDelDashboard", () => {
  const r = rangosDelDashboard("7d", AHORA);

  it("período y previo vienen de periodos.ts", () => {
    expect(r.periodo.desde).toEqual(rangoDe("7d", AHORA).desde);
    expect(r.previo.hasta.getTime()).toBe(r.periodo.hasta.getTime() - 7 * DIA_MS);
  });

  it("hoy: desde la medianoche de Caracas hasta ahora (granularidad por hora)", () => {
    expect(r.hoy.desde).toEqual(MEDIANOCHE_HOY);
    expect(r.hoy.hasta).toEqual(AHORA);
  });

  it("historia: los 40 días ANTERIORES a hoy, sin incluir hoy", () => {
    expect(r.historia.hasta).toEqual(MEDIANOCHE_HOY);
    expect(r.historia.desde.getTime()).toBe(MEDIANOCHE_HOY.getTime() - 40 * DIA_MS);
  });

  it("año: del 1/1 de Caracas hasta ahora", () => {
    expect(r.anio.desde).toEqual(new Date("2026-01-01T04:00:00Z"));
    expect(r.anio.hasta).toEqual(AHORA);
  });

  it("el día de hoy como clave YYYY-MM-DD de Caracas, no la del servidor", () => {
    // 00:30 UTC del 14 es todavía el 13 en Caracas.
    expect(rangosDelDashboard("hoy", new Date("2026-11-14T00:30:00Z")).hoyClave).toBe("2026-11-13");
  });
});

describe("rangosDeAnaliticas", () => {
  const r = rangosDeAnaliticas("30d", AHORA);

  it("lleva período, previo, año y los últimos 40 días INCLUYENDO hoy (calendario de rendimiento)", () => {
    expect(r.periodo.desde).toEqual(rangoDe("30d", AHORA).desde);
    expect(r.previo.desde.getTime()).toBe(r.periodo.desde.getTime() - 30 * DIA_MS);
    expect(r.anio.desde).toEqual(new Date("2026-01-01T04:00:00Z"));
    expect(r.ultimos40.hasta).toEqual(AHORA);
    expect(r.ultimos40.desde.getTime()).toBe(MEDIANOCHE_HOY.getTime() - 39 * DIA_MS);
  });
});
