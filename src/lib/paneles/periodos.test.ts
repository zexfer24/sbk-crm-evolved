import { describe, expect, it } from "vitest";
import { PERIODOS, periodoDesdeParam, rangoDe, rangoPrevio, topeMensajes } from "./periodos";

// Caracas es UTC-4 todo el año (sin horario de verano). Fechas fijas siempre:
// ningún test de este archivo lee el reloj real (trampa de CLAUDE.md).
const iso = (d: Date) => d.toISOString();

describe("PERIODOS", () => {
  it("lista los cinco períodos con su etiqueta", () => {
    expect(PERIODOS).toEqual([
      { id: "hoy", etiqueta: "Hoy" },
      { id: "7d", etiqueta: "7 días" },
      { id: "30d", etiqueta: "30 días" },
      { id: "mes", etiqueta: "Este mes" },
      { id: "anio", etiqueta: "Este año" },
    ]);
  });
});

describe("rangoDe", () => {
  it("hoy va de la medianoche de Caracas hasta ahora", () => {
    const ahora = new Date("2026-11-13T15:00:00Z"); // 11:00 en Caracas
    const r = rangoDe("hoy", ahora);
    expect(iso(r.desde)).toBe("2026-11-13T04:00:00.000Z");
    expect(iso(r.hasta)).toBe(iso(ahora));
    expect(r.etiqueta).toBe("Hoy");
  });

  it("hoy cruzando la medianoche de Caracas: a las 22:30 de Caracas (02:30 UTC) sigue siendo el día anterior", () => {
    const ahora = new Date("2026-11-13T02:30:00Z"); // 12/11 22:30 en Caracas
    expect(iso(rangoDe("hoy", ahora).desde)).toBe("2026-11-12T04:00:00.000Z");
  });

  it("a las 00:00 en punto de Caracas ya es el día nuevo", () => {
    expect(iso(rangoDe("hoy", new Date("2026-11-13T03:59:59Z")).desde)).toBe("2026-11-12T04:00:00.000Z");
    expect(iso(rangoDe("hoy", new Date("2026-11-13T04:00:00Z")).desde)).toBe("2026-11-13T04:00:00.000Z");
  });

  it("7d arranca en la medianoche de hace 6 días y 30d en la de hace 29", () => {
    const ahora = new Date("2026-11-13T15:00:00Z");
    expect(iso(rangoDe("7d", ahora).desde)).toBe("2026-11-07T04:00:00.000Z");
    expect(iso(rangoDe("30d", ahora).desde)).toBe("2026-10-15T04:00:00.000Z");
    expect(rangoDe("7d", ahora).etiqueta).toBe("7 días");
  });

  it("mes arranca el día 1 y anio el 1 de enero, siempre en hora de Caracas", () => {
    const ahora = new Date("2026-11-13T15:00:00Z");
    expect(iso(rangoDe("mes", ahora).desde)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(rangoDe("anio", ahora).desde)).toBe("2026-01-01T04:00:00.000Z");
  });

  it("el cambio de mes se decide en hora de Caracas, no en UTC", () => {
    // 1/12 00:30 Caracas = 1/12 04:30 UTC: ya es diciembre.
    expect(iso(rangoDe("mes", new Date("2026-12-01T04:30:00Z")).desde)).toBe("2026-12-01T04:00:00.000Z");
    // 30/11 23:30 Caracas = 1/12 03:30 UTC: en UTC ya es diciembre, en Caracas todavía noviembre.
    expect(iso(rangoDe("mes", new Date("2026-12-01T03:30:00Z")).desde)).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("rangoPrevio", () => {
  const ahora = new Date("2026-11-13T15:00:00Z");

  it("hoy: el mismo día de la semana pasada hasta la misma hora", () => {
    const r = rangoPrevio("hoy", ahora);
    expect(iso(r.desde)).toBe("2026-11-06T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2026-11-06T15:00:00.000Z");
  });

  it("7d y 30d: la misma ventana corrida 7 y 30 días hacia atrás", () => {
    const s = rangoPrevio("7d", ahora);
    expect(iso(s.desde)).toBe("2026-10-31T04:00:00.000Z");
    expect(iso(s.hasta)).toBe("2026-11-06T15:00:00.000Z");
    const t = rangoPrevio("30d", ahora);
    expect(iso(t.desde)).toBe("2026-09-15T04:00:00.000Z");
    expect(iso(t.hasta)).toBe("2026-10-14T15:00:00.000Z");
  });

  it("mes: el mismo tramo del mes anterior", () => {
    const r = rangoPrevio("mes", ahora);
    expect(iso(r.desde)).toBe("2026-10-01T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2026-10-13T15:00:00.000Z");
  });

  it("mes: si el mes anterior es más corto, el tope es el inicio del mes actual", () => {
    // 31/3 11:00 Caracas: febrero (28 días) no alcanza para los 30 días y 11 h transcurridos
    const r = rangoPrevio("mes", new Date("2026-03-31T15:00:00Z"));
    expect(iso(r.desde)).toBe("2026-02-01T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2026-03-01T04:00:00.000Z");
  });

  it("anio: el mismo tramo del año anterior", () => {
    const r = rangoPrevio("anio", ahora);
    expect(iso(r.desde)).toBe("2025-01-01T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2025-11-13T15:00:00.000Z");
  });

  it("el previo nunca se traslapa con el período actual", () => {
    for (const p of ["hoy", "7d", "30d", "mes", "anio"] as const) {
      expect(rangoPrevio(p, ahora).hasta.getTime()).toBeLessThanOrEqual(rangoDe(p, ahora).desde.getTime());
    }
  });
});

describe("topeMensajes", () => {
  it("deja intacto un rango dentro del tope", () => {
    const rango = { desde: new Date("2026-11-01T04:00:00Z"), hasta: new Date("2026-11-13T15:00:00Z") };
    const r = topeMensajes(rango);
    expect(iso(r.desde)).toBe(iso(rango.desde));
    expect(iso(r.hasta)).toBe(iso(rango.hasta));
    expect(r.recortado).toBe(false);
  });

  it("recorta el inicio a 92 días antes del fin y avisa que recortó", () => {
    const hasta = new Date("2026-11-13T15:00:00Z");
    const r = topeMensajes({ desde: new Date("2026-01-01T04:00:00Z"), hasta });
    expect(iso(r.desde)).toBe("2026-08-13T15:00:00.000Z");
    expect(iso(r.hasta)).toBe(iso(hasta));
    expect(r.recortado).toBe(true);
  });

  it("exactamente 92 días no recorta; respeta un maxDias distinto", () => {
    const hasta = new Date("2026-11-13T15:00:00Z");
    expect(topeMensajes({ desde: new Date("2026-08-13T15:00:00Z"), hasta }).recortado).toBe(false);
    const r = topeMensajes({ desde: new Date("2026-11-01T15:00:00Z"), hasta }, 7);
    expect(iso(r.desde)).toBe("2026-11-06T15:00:00.000Z");
    expect(r.recortado).toBe(true);
  });
});

describe("periodoDesdeParam", () => {
  it("acepta los cinco ids", () => {
    for (const id of ["hoy", "7d", "30d", "mes", "anio"]) expect(periodoDesdeParam(id)).toBe(id);
  });

  it("cualquier otra cosa cae en hoy", () => {
    expect(periodoDesdeParam(undefined)).toBe("hoy");
    expect(periodoDesdeParam("")).toBe("hoy");
    expect(periodoDesdeParam("semana")).toBe("hoy");
    expect(periodoDesdeParam("7D")).toBe("hoy");
  });
});
