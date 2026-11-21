import { describe, expect, it } from "vitest";
import {
  esRangoVacio,
  INICIO_PANELES,
  PERIODOS,
  PERIODOS_ASESORES,
  periodoDeAsesores,
  periodoDesdeParam,
  rangoDe,
  rangoPrevio,
  TEXTO_INICIO_PANELES,
  TEXTO_SIN_PREVIO,
  topeMensajes,
  type PeriodoId,
} from "./periodos";

// Caracas es UTC-4 todo el año (sin horario de verano). Fechas fijas siempre:
// ningún test de este archivo lee el reloj real (trampa de CLAUDE.md).
const iso = (d: Date) => d.toISOString();

// Los tests de calendario de abajo fijan el reloj el 13/11/2026, ANTES del piso
// de datos de los paneles (16/11/2026): pasan `null` como piso para seguir
// probando la aritmética de calendario pura. El comportamiento con piso va en
// el describe "piso de los paneles".

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
    const r = rangoDe("hoy", ahora, null);
    expect(iso(r.desde)).toBe("2026-11-13T04:00:00.000Z");
    expect(iso(r.hasta)).toBe(iso(ahora));
    expect(r.etiqueta).toBe("Hoy");
  });

  it("hoy cruzando la medianoche de Caracas: a las 22:30 de Caracas (02:30 UTC) sigue siendo el día anterior", () => {
    const ahora = new Date("2026-11-13T02:30:00Z"); // 12/11 22:30 en Caracas
    expect(iso(rangoDe("hoy", ahora, null).desde)).toBe("2026-11-12T04:00:00.000Z");
  });

  it("a las 00:00 en punto de Caracas ya es el día nuevo", () => {
    expect(iso(rangoDe("hoy", new Date("2026-11-13T03:59:59Z"), null).desde)).toBe("2026-11-12T04:00:00.000Z");
    expect(iso(rangoDe("hoy", new Date("2026-11-13T04:00:00Z"), null).desde)).toBe("2026-11-13T04:00:00.000Z");
  });

  it("7d arranca en la medianoche de hace 6 días y 30d en la de hace 29", () => {
    const ahora = new Date("2026-11-13T15:00:00Z");
    expect(iso(rangoDe("7d", ahora, null).desde)).toBe("2026-11-07T04:00:00.000Z");
    expect(iso(rangoDe("30d", ahora, null).desde)).toBe("2026-10-15T04:00:00.000Z");
    expect(rangoDe("7d", ahora, null).etiqueta).toBe("7 días");
  });

  it("mes arranca el día 1 y anio el 1 de enero, siempre en hora de Caracas", () => {
    const ahora = new Date("2026-11-13T15:00:00Z");
    expect(iso(rangoDe("mes", ahora, null).desde)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(rangoDe("anio", ahora, null).desde)).toBe("2026-01-01T04:00:00.000Z");
  });

  it("el cambio de mes se decide en hora de Caracas, no en UTC", () => {
    // 1/12 00:30 Caracas = 1/12 04:30 UTC: ya es diciembre.
    expect(iso(rangoDe("mes", new Date("2026-12-01T04:30:00Z"), null).desde)).toBe("2026-12-01T04:00:00.000Z");
    // 30/11 23:30 Caracas = 1/12 03:30 UTC: en UTC ya es diciembre, en Caracas todavía noviembre.
    expect(iso(rangoDe("mes", new Date("2026-12-01T03:30:00Z"), null).desde)).toBe("2026-11-01T04:00:00.000Z");
  });
});

/** El previo de calendario puro (sin piso): en esos tests siempre existe. */
const previoSinPiso = (id: PeriodoId, ahora: Date) => rangoPrevio(id, ahora, null)!;

describe("rangoPrevio", () => {
  const ahora = new Date("2026-11-13T15:00:00Z");

  it("hoy: el mismo día de la semana pasada hasta la misma hora", () => {
    const r = previoSinPiso("hoy", ahora);
    expect(iso(r.desde)).toBe("2026-11-06T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2026-11-06T15:00:00.000Z");
  });

  it("7d y 30d: la misma ventana corrida 7 y 30 días hacia atrás", () => {
    const s = previoSinPiso("7d", ahora);
    expect(iso(s.desde)).toBe("2026-10-31T04:00:00.000Z");
    expect(iso(s.hasta)).toBe("2026-11-06T15:00:00.000Z");
    const t = previoSinPiso("30d", ahora);
    expect(iso(t.desde)).toBe("2026-09-15T04:00:00.000Z");
    expect(iso(t.hasta)).toBe("2026-10-14T15:00:00.000Z");
  });

  it("mes: el mismo tramo del mes anterior", () => {
    const r = previoSinPiso("mes", ahora);
    expect(iso(r.desde)).toBe("2026-10-01T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2026-10-13T15:00:00.000Z");
  });

  it("mes: si el mes anterior es más corto, el tope es el inicio del mes actual", () => {
    // 31/3 11:00 Caracas: febrero (28 días) no alcanza para los 30 días y 11 h transcurridos
    const r = previoSinPiso("mes", new Date("2026-03-31T15:00:00Z"));
    expect(iso(r.desde)).toBe("2026-02-01T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2026-03-01T04:00:00.000Z");
  });

  it("anio: el mismo tramo del año anterior", () => {
    const r = previoSinPiso("anio", ahora);
    expect(iso(r.desde)).toBe("2025-01-01T04:00:00.000Z");
    expect(iso(r.hasta)).toBe("2025-11-13T15:00:00.000Z");
  });

  it("el previo nunca se traslapa con el período actual", () => {
    for (const p of ["hoy", "7d", "30d", "mes", "anio"] as const) {
      expect(previoSinPiso(p, ahora).hasta.getTime()).toBeLessThanOrEqual(rangoDe(p, ahora, null).desde.getTime());
    }
  });
});

describe("piso de los paneles (INICIO_PANELES)", () => {
  it("el piso es la medianoche de Caracas del lunes 16/11/2026 y los textos no cambian por accidente", () => {
    expect(INICIO_PANELES.toISOString()).toBe("2026-11-16T04:00:00.000Z");
    expect(TEXTO_INICIO_PANELES).toBe("Los paneles cuentan desde el lunes 16/11/2026");
    expect(TEXTO_SIN_PREVIO).toBe("Sin período anterior comparable (los datos empiezan el 16/11)");
  });

  describe("21/11/2026 09:20 en Caracas", () => {
    const ahora = new Date("2026-11-21T13:20:00Z");

    it("7 días arranca el 16/11 (no el 15) y su previo no existe", () => {
      expect(iso(rangoDe("7d", ahora).desde)).toBe("2026-11-16T04:00:00.000Z");
      expect(iso(rangoDe("7d", ahora).hasta)).toBe(iso(ahora));
      expect(rangoPrevio("7d", ahora)).toBeNull();
    });

    it("este mes, 30 días y este año arrancan el 16/11 y no tienen previo", () => {
      for (const id of ["mes", "30d", "anio"] as const) {
        expect(iso(rangoDe(id, ahora).desde)).toBe("2026-11-16T04:00:00.000Z");
        expect(rangoPrevio(id, ahora)).toBeNull();
      }
    });

    it("hoy no se recorta y su previo (14/11) no existe: empieza antes del piso", () => {
      expect(iso(rangoDe("hoy", ahora).desde)).toBe("2026-11-21T04:00:00.000Z");
      expect(rangoPrevio("hoy", ahora)).toBeNull();
    });
  });

  it("22/11/2026: «Hoy» sigue sin previo (el mismo día de la semana pasada, 15/11, es anterior al piso)", () => {
    expect(rangoPrevio("hoy", new Date("2026-11-22T03:00:00Z"))).toBeNull(); // 21/11 23:00
    expect(rangoPrevio("hoy", new Date("2026-11-22T15:00:00Z"))).toBeNull(); // 22/11 11:00
  });

  it("23/11/2026 10:00: «Hoy» ya tiene previo y empieza justo en el piso (16/11 00:00)", () => {
    const ahora = new Date("2026-11-23T14:00:00Z");
    const previo = rangoPrevio("hoy", ahora);
    expect(previo).not.toBeNull();
    expect(iso(previo!.desde)).toBe("2026-11-16T04:00:00.000Z");
    expect(iso(previo!.hasta)).toBe("2026-11-16T14:00:00.000Z");
  });

  it("30/11/2026 10:00: «7 días» (24/11) tiene previo completo, 17/11 00:00 a 23/11 10:00", () => {
    const ahora = new Date("2026-11-30T14:00:00Z");
    expect(iso(rangoDe("7d", ahora).desde)).toBe("2026-11-24T04:00:00.000Z");
    const previo = rangoPrevio("7d", ahora);
    expect(previo).not.toBeNull();
    expect(iso(previo!.desde)).toBe("2026-11-17T04:00:00.000Z");
    expect(iso(previo!.hasta)).toBe("2026-11-23T14:00:00.000Z");
  });

  it("antes del piso (13/11) el rango es vacío pero bien formado: desde = hasta", () => {
    const ahora = new Date("2026-11-13T15:00:00Z");
    const r = rangoDe("hoy", ahora);
    expect(esRangoVacio(r)).toBe(true);
    expect(iso(r.desde)).toBe(iso(ahora));
    expect(iso(r.hasta)).toBe(iso(ahora));
    expect(esRangoVacio(rangoDe("anio", ahora))).toBe(true);
  });

  it("esRangoVacio: hasta <= desde", () => {
    const a = new Date("2026-11-20T10:00:00Z");
    expect(esRangoVacio({ desde: a, hasta: a })).toBe(true);
    expect(esRangoVacio({ desde: new Date(a.getTime() + 1), hasta: a })).toBe(true);
    expect(esRangoVacio({ desde: a, hasta: new Date(a.getTime() + 1) })).toBe(false);
  });

  it("con piso null el comportamiento es el de calendario puro", () => {
    const ahora = new Date("2026-11-13T15:00:00Z");
    expect(iso(rangoDe("anio", ahora, null).desde)).toBe("2026-01-01T04:00:00.000Z");
    expect(rangoPrevio("hoy", ahora, null)).not.toBeNull();
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

describe("periodoDeAsesores", () => {
  it("ofrece exactamente hoy, 7d y 30d", () => {
    expect(PERIODOS_ASESORES).toEqual(["hoy", "7d", "30d"]);
  });

  it("acepta los tres períodos de Asesores", () => {
    for (const id of ["hoy", "7d", "30d"]) expect(periodoDeAsesores(id)).toBe(id);
  });

  it("mes y anio (válidos para los otros paneles) y cualquier otra cosa caen en hoy", () => {
    expect(periodoDeAsesores("mes")).toBe("hoy");
    expect(periodoDeAsesores("anio")).toBe("hoy");
    expect(periodoDeAsesores(undefined)).toBe("hoy");
    expect(periodoDeAsesores("")).toBe("hoy");
    expect(periodoDeAsesores("30D")).toBe("hoy");
  });
});
