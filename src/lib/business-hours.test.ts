import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUSINESS_HOURS,
  businessMinutesBetween,
  businessStatus,
  dayBand,
  describeSchedule,
  greetingFor,
  parseBusinessHours,
  turnClockLine,
  type BusinessHours,
} from "@/lib/business-hours";

const TZ = "America/Caracas";

/**
 * Caracas es UTC-4 todo el año (sin horario de verano), así que un instante
 * en UTC con 4 horas sumadas siempre cae en la misma hora local. Estos tests
 * nombran los instantes en UTC a propósito, para no depender de la `TZ` del
 * proceso que corre la suite.
 */
function enCaracas(fechaLocalIso: string): Date {
  // "2026-08-27T15:59" (hora de Caracas) -> "2026-08-27T19:59:00Z". Caracas
  // es UTC-4 todo el año, así que sumar 4 horas basta — salvo que el borde
  // cruce medianoche, caso que se resuelve construyendo el instante en UTC y
  // dejando que `Date` reparta el acarreo entre hora y día.
  const [fecha, hora] = fechaLocalIso.split("T");
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const [h, m] = hora.split(":").map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia, h + 4, m, 0));
}

describe("dayBand — franja del día, con los bordes de DAY_BANDS como datos", () => {
  it.each([
    ["2026-08-27T11:59", "mañana"],
    ["2026-08-27T12:00", "tarde"],
    ["2026-08-27T19:00", "tarde"],
    ["2026-08-27T19:01", "noche"],
    ["2026-08-27T00:00", "mañana"],
    ["2026-08-27T23:59", "noche"],
  ] as const)("%s hora de Caracas → %s", (horaLocal, esperado) => {
    expect(dayBand(enCaracas(horaLocal), TZ)).toBe(esperado);
  });

  it("greetingFor da el saludo que corresponde a cada franja", () => {
    expect(greetingFor("mañana")).toBe("buenos días");
    expect(greetingFor("tarde")).toBe("buenas tardes");
    expect(greetingFor("noche")).toBe("buenas noches");
  });
});

describe("parseBusinessHours — ante cualquier cosa rota, el default completo", () => {
  it("acepta el jsonb tal como lo escribe la migración B1", () => {
    expect(parseBusinessHours(DEFAULT_BUSINESS_HOURS)).toEqual(DEFAULT_BUSINESS_HOURS);
  });

  it.each([
    ["un string en vez de un objeto", "no soy un horario"],
    ["null", null],
    ["un arreglo en vez de un objeto", []],
    ["un día faltante", { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] }],
    [
      "una hora fuera de rango",
      { mon: [["25:00", "18:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    ],
    [
      "el fin antes que el inicio",
      { mon: [["18:00", "08:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    ],
    [
      "una franja que no es un par",
      { mon: [["08:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    ],
    [
      "una franja con horas que no son string",
      { mon: [[8, 18]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    ],
    [
      "un día que no es un arreglo",
      { mon: "cerrado", tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    ],
  ])("%s → DEFAULT_BUSINESS_HOURS", (_nombre, raw) => {
    expect(parseBusinessHours(raw)).toEqual(DEFAULT_BUSINESS_HOURS);
  });

  it("nunca lanza, ni con undefined", () => {
    expect(() => parseBusinessHours(undefined)).not.toThrow();
    expect(parseBusinessHours(undefined)).toEqual(DEFAULT_BUSINESS_HOURS);
  });

  it("acepta horario partido válido tal cual", () => {
    const partido: BusinessHours = {
      mon: [
        ["08:00", "12:00"],
        ["13:00", "18:00"],
      ],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };

    expect(parseBusinessHours(partido)).toEqual(partido);
  });
});

describe("businessStatus — abierta/cerrada en los bordes de la franja laboral", () => {
  // 2026-08-27 es jueves: día laboral en DEFAULT_BUSINESS_HOURS (8am-6pm).
  it.each([
    ["2026-08-27T07:59", false],
    ["2026-08-27T08:00", true],
    ["2026-08-27T17:59", true],
    ["2026-08-27T18:00", true],
    ["2026-08-27T18:01", false],
  ] as const)("jueves %s hora de Caracas → abierta: %s", (horaLocal, abierta) => {
    const estado = businessStatus(enCaracas(horaLocal), DEFAULT_BUSINESS_HOURS, TZ);
    expect(estado.open).toBe(abierta);
  });

  it("cierra a las 6:00 pm cuando está abierta", () => {
    const estado = businessStatus(enCaracas("2026-08-27T08:00"), DEFAULT_BUSINESS_HOURS, TZ);
    expect(estado.closesAt).toBe("6:00 pm");
    expect(estado.nextOpening).toBeNull();
  });

  /**
   * Sin etiqueta "mañana" para el día siguiente (decisión del orquestador,
   * 5/9/2026): la línea del prompt ya usa "mañana" para nombrar la FRANJA
   * horaria ("franja: mañana"), y repetir la palabra con otro significado
   * ("abre mañana a las 8:00 am") confundía al modelo. El nombre del día es
   * inequívoco sea el día siguiente o cualquier otro.
   */
  it("después de cerrar hoy, la próxima apertura se nombra por el día (jueves → viernes, día laboral)", () => {
    const estado = businessStatus(enCaracas("2026-08-27T18:01"), DEFAULT_BUSINESS_HOURS, TZ);
    expect(estado.open).toBe(false);
    expect(estado.nextOpening).toEqual({ dayLabel: "el viernes", time: "8:00 am" });
  });

  it("antes de abrir hoy, la próxima apertura es hoy a las 8:00 am", () => {
    const estado = businessStatus(enCaracas("2026-08-27T07:59"), DEFAULT_BUSINESS_HOURS, TZ);
    expect(estado.nextOpening).toEqual({ dayLabel: "hoy", time: "8:00 am" });
  });

  it("cruzando el fin de semana: viernes cerrado ya, sábado y domingo cerrados, abre el lunes", () => {
    // 2026-08-28 es viernes.
    const estado = businessStatus(enCaracas("2026-08-28T18:01"), DEFAULT_BUSINESS_HOURS, TZ);
    expect(estado.open).toBe(false);
    expect(estado.nextOpening).toEqual({ dayLabel: "el lunes", time: "8:00 am" });
  });

  it("todo cerrado los siete días: nextOpening es null", () => {
    const cerradoSiempre: BusinessHours = {
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };

    const estado = businessStatus(enCaracas("2026-08-27T12:00"), cerradoSiempre, TZ);
    expect(estado).toEqual({ open: false, closesAt: null, nextOpening: null });
  });

  describe("horario partido: el descanso de mediodía no es horario de atención", () => {
    const partido: BusinessHours = {
      mon: [
        ["08:00", "12:00"],
        ["13:00", "18:00"],
      ],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };

    it("durante el descanso está cerrada y abre hoy mismo a la 1:00 pm", () => {
      // 2026-08-31 es lunes.
      const estado = businessStatus(enCaracas("2026-08-31T12:30"), partido, TZ);
      expect(estado.open).toBe(false);
      expect(estado.nextOpening).toEqual({ dayLabel: "hoy", time: "1:00 pm" });
    });

    it("en el turno de la tarde vuelve a estar abierta", () => {
      const estado = businessStatus(enCaracas("2026-08-31T14:00"), partido, TZ);
      expect(estado.open).toBe(true);
      expect(estado.closesAt).toBe("6:00 pm");
    });
  });
});

describe("describeSchedule — el horario en prosa", () => {
  it("agrupa lunes a viernes con la misma franja, sin mencionar el fin de semana", () => {
    expect(describeSchedule(DEFAULT_BUSINESS_HOURS)).toBe("lunes a viernes de 8:00 am a 6:00 pm");
  });

  it("cerrado todos los días cuando no hay ninguna franja", () => {
    const cerradoSiempre: BusinessHours = {
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };
    expect(describeSchedule(cerradoSiempre)).toBe("cerrado todos los días");
  });

  it("describe un horario partido con 'y' entre las dos franjas", () => {
    const partido: BusinessHours = {
      mon: [
        ["08:00", "12:00"],
        ["13:00", "18:00"],
      ],
      tue: [
        ["08:00", "12:00"],
        ["13:00", "18:00"],
      ],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };

    expect(describeSchedule(partido)).toBe("lunes a martes de 8:00 am a 12:00 pm y 1:00 pm a 6:00 pm");
  });

  it("no une dos grupos con franjas distintas aunque sean días contiguos", () => {
    const mixto: BusinessHours = {
      mon: [["08:00", "18:00"]],
      tue: [["09:00", "17:00"]],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };

    expect(describeSchedule(mixto)).toBe("lunes de 8:00 am a 6:00 pm, martes de 9:00 am a 5:00 pm");
  });
});

describe("businessMinutesBetween — minutos de horario laboral entre dos instantes", () => {
  it("devuelve 0 si 'to' no es posterior a 'from'", () => {
    const instante = enCaracas("2026-08-27T10:00");
    expect(businessMinutesBetween(instante, instante, DEFAULT_BUSINESS_HOURS, TZ)).toBe(0);
    expect(
      businessMinutesBetween(enCaracas("2026-08-27T10:00"), enCaracas("2026-08-27T09:00"), DEFAULT_BUSINESS_HOURS, TZ)
    ).toBe(0);
  });

  it("devuelve 0 cuando toda la ventana cae fuera de horario", () => {
    // 2026-08-29 es sábado: cerrado todo el día en DEFAULT_BUSINESS_HOURS.
    expect(
      businessMinutesBetween(enCaracas("2026-08-29T10:00"), enCaracas("2026-08-29T12:00"), DEFAULT_BUSINESS_HOURS, TZ)
    ).toBe(0);
  });

  it("salta la noche: cuenta la hora que queda hoy y la que ya abrió mañana, no las horas cerradas de por medio", () => {
    // Lunes 31/8 17:00 a martes 1/9 09:00: 17-18h del lunes (60 min) + 8-9h del martes (60 min).
    const minutos = businessMinutesBetween(
      enCaracas("2026-08-31T17:00"),
      enCaracas("2026-09-01T09:00"),
      DEFAULT_BUSINESS_HOURS,
      TZ
    );
    expect(minutos).toBe(120);
  });

  it("salta el sábado y el domingo enteros", () => {
    // Sábado 29/8 17:00 (ya cerrado) a lunes 31/8 09:00: solo cuenta 8-9am del lunes.
    const minutos = businessMinutesBetween(
      enCaracas("2026-08-29T17:00"),
      enCaracas("2026-08-31T09:00"),
      DEFAULT_BUSINESS_HOURS,
      TZ
    );
    expect(minutos).toBe(60);
  });

  it("una jornada completa de lunes a viernes suma 5 × 10 horas", () => {
    const minutos = businessMinutesBetween(
      enCaracas("2026-08-24T00:00"), // lunes
      enCaracas("2026-08-29T00:00"), // sábado (fin de la ventana)
      DEFAULT_BUSINESS_HOURS,
      TZ
    );
    expect(minutos).toBe(5 * 10 * 60);
  });
});

describe("turnClockLine — la línea completa para TURNO ACTUAL", () => {
  it("tienda abierta: hora, franja, saludo, horario y cierre", () => {
    // 2026-08-27 es jueves, 4:00 pm en Caracas.
    const linea = turnClockLine(enCaracas("2026-08-27T16:00"), DEFAULT_BUSINESS_HOURS, TZ);

    expect(linea).toBe(
      'Hora local: jueves 27 de agosto, 4:00 pm — franja: tarde (saluda "buenas tardes"). ' +
        "Horario de atención: lunes a viernes de 8:00 am a 6:00 pm. " +
        "Ahora mismo: ABIERTA, cierra a las 6:00 pm."
    );
  });

  /**
   * "el lunes", no "mañana": aunque el lunes es el día siguiente al domingo,
   * la línea ya dice "franja: mañana" para la franja horaria de la mañana —
   * repetir la palabra con el otro sentido ("abre mañana a las 8:00 am")
   * confundía al modelo (decisión del orquestador, 5/9/2026).
   */
  it("tienda cerrada: dice cuándo abre, nombrando el día y no 'mañana'", () => {
    // 2026-08-30 es domingo, 8:10 am en Caracas.
    const linea = turnClockLine(enCaracas("2026-08-30T08:10"), DEFAULT_BUSINESS_HOURS, TZ);

    expect(linea).toContain("CERRADA, abre el lunes a las 8:00 am");
    expect(linea).toContain('franja: mañana (saluda "buenos días")');
  });
});
