import { describe, expect, it } from "vitest";
import { INICIO_PANELES, rangoDe } from "./periodos";
import { rangosDelDashboard, rangosDeAnaliticas } from "./rangos";

/**
 * Plan "Paneles" (13/11/2026): los rangos que cada página lee viven aquí, para
 * que `page.tsx` quede delgada y el cálculo de "hoy", "los 40 días anteriores"
 * y "el año" se pruebe con un reloj fijo. `ahora` = 13/11/2026 15:00 en Caracas.
 *
 * 21/11/2026 (plan "Los paneles cuentan desde el lunes 16/11/2026"): ese reloj
 * cae ANTES del piso de datos, así que los tests de calendario pasan `null`
 * como piso para seguir probando la aritmética pura; el comportamiento con el
 * piso por defecto va en los `describe` "con el piso" de abajo.
 */

const AHORA = new Date("2026-11-13T19:00:00Z");
const MEDIANOCHE_HOY = new Date("2026-11-13T04:00:00Z");
const DIA_MS = 24 * 60 * 60 * 1000;

describe("rangosDelDashboard", () => {
  const r = rangosDelDashboard("7d", AHORA, null);

  it("período y previo vienen de periodos.ts", () => {
    expect(r.periodo.desde).toEqual(rangoDe("7d", AHORA, null).desde);
    expect(r.previo!.hasta.getTime()).toBe(r.periodo.hasta.getTime() - 7 * DIA_MS);
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
    expect(rangosDelDashboard("hoy", new Date("2026-11-14T00:30:00Z"), null).hoyClave).toBe("2026-11-13");
  });

  it("sin piso, `piso` viaja como null", () => {
    expect(r.piso).toBeNull();
  });
});

describe("rangosDeAnaliticas", () => {
  const r = rangosDeAnaliticas("30d", AHORA, null);

  it("lleva período, previo, año y los últimos 40 días INCLUYENDO hoy (calendario de rendimiento)", () => {
    expect(r.periodo.desde).toEqual(rangoDe("30d", AHORA, null).desde);
    expect(r.previo!.desde.getTime()).toBe(r.periodo.desde.getTime() - 30 * DIA_MS);
    expect(r.anio.desde).toEqual(new Date("2026-01-01T04:00:00Z"));
    expect(r.ultimos40.hasta).toEqual(AHORA);
    expect(r.ultimos40.desde.getTime()).toBe(MEDIANOCHE_HOY.getTime() - 39 * DIA_MS);
  });
});

describe("con el piso de los paneles (21/11/2026 09:20 en Caracas)", () => {
  const AHORA_21 = new Date("2026-11-21T13:20:00Z");
  const MEDIANOCHE_21 = new Date("2026-11-21T04:00:00Z");
  const PISO = new Date("2026-11-16T04:00:00Z");

  it("Dashboard: la historia empieza el 16/11 y termina en la medianoche del 21/11", () => {
    const r = rangosDelDashboard("7d", AHORA_21);
    expect(r.historia.desde).toEqual(PISO);
    expect(r.historia.hasta).toEqual(MEDIANOCHE_21);
  });

  it("Dashboard: el año arranca el 16/11, hoy no se recorta, el previo no existe y el piso viaja", () => {
    const r = rangosDelDashboard("7d", AHORA_21);
    expect(r.anio.desde).toEqual(PISO);
    expect(r.anio.hasta).toEqual(AHORA_21);
    expect(r.periodo.desde).toEqual(PISO);
    expect(r.hoy.desde).toEqual(MEDIANOCHE_21);
    expect(r.previo).toBeNull();
    expect(r.piso).toEqual(INICIO_PANELES);
    expect(r.hoyClave).toBe("2026-11-21");
  });

  it("Analíticas: el año y los últimos 40 días arrancan el 16/11; el previo no existe y el piso viaja", () => {
    const r = rangosDeAnaliticas("30d", AHORA_21);
    expect(r.anio.desde).toEqual(PISO);
    expect(r.ultimos40.desde).toEqual(PISO);
    expect(r.ultimos40.hasta).toEqual(AHORA_21);
    expect(r.periodo.desde).toEqual(PISO);
    expect(r.previo).toBeNull();
    expect(r.piso).toEqual(INICIO_PANELES);
  });

  it("el día del piso (16/11 a mediodía) la historia queda vacía pero bien formada", () => {
    const r = rangosDelDashboard("hoy", new Date("2026-11-16T16:00:00Z"));
    expect(r.historia.desde).toEqual(r.historia.hasta);
    expect(r.hoy.desde).toEqual(PISO);
  });

  it("un reloj anterior al piso deja todos los rangos vacíos", () => {
    const r = rangosDelDashboard("7d", AHORA);
    for (const rango of [r.periodo, r.hoy, r.historia, r.anio]) {
      expect(rango.desde.getTime()).toBe(rango.hasta.getTime());
    }
    expect(r.previo).toBeNull();
  });
});

describe("periodoRecortado (21/11/2026)", () => {
  const AHORA_21 = new Date("2026-11-21T13:20:00Z");

  it("«7 días» el 21/11 arranca el 15/11, antes del piso: está recortado", () => {
    expect(rangosDelDashboard("7d", AHORA_21).periodoRecortado).toBe(true);
    expect(rangosDeAnaliticas("7d", AHORA_21).periodoRecortado).toBe(true);
  });

  it("«Hoy» el 21/11 no toca el piso: no está recortado", () => {
    expect(rangosDelDashboard("hoy", AHORA_21).periodoRecortado).toBe(false);
    expect(rangosDeAnaliticas("hoy", AHORA_21).periodoRecortado).toBe(false);
  });

  it("el día del piso, «7 días» sí lo recorta y «Hoy» no", () => {
    const ahora = new Date("2026-11-16T16:00:00Z");
    expect(rangosDelDashboard("7d", ahora).periodoRecortado).toBe(true);
    expect(rangosDelDashboard("hoy", ahora).periodoRecortado).toBe(false);
  });

  it("sin piso nunca está recortado", () => {
    expect(rangosDelDashboard("anio", AHORA, null).periodoRecortado).toBe(false);
    expect(rangosDeAnaliticas("30d", AHORA, null).periodoRecortado).toBe(false);
  });

  it("cuando el período ya cabe entero desde el piso, deja de estar recortado (30/11, «7 días»)", () => {
    const ahora = new Date("2026-11-30T16:00:00Z");
    expect(rangosDelDashboard("7d", ahora).periodoRecortado).toBe(false);
  });
});
