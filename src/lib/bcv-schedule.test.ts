import { describe, expect, it } from "vitest";
import { daysBetween, lastScheduledRead, shouldRefetchBcv, venezuelaDate } from "@/lib/bcv-schedule";

// Semana de referencia, para no contar días a mano en cada caso:
const VIERNES = "2026-08-21";
const SABADO = "2026-08-22";
const MARTES = "2026-08-25";
const LUNES = "2026-08-24";

/**
 * Es el número que hace que el aviso del log sirva: distingue "el BCV tardó de
 * más una vez" de "llevamos tres días cotizando con una tasa muerta".
 */
describe("daysBetween", () => {
  it("cuenta los días entre dos fechas", () => {
    expect(daysBetween(SABADO, MARTES)).toBe(3);
    expect(daysBetween(VIERNES, SABADO)).toBe(1);
  });

  it("el mismo día son cero", () => {
    expect(daysBetween(LUNES, LUNES)).toBe(0);
  });

  /**
   * El sábado el BCV publica la tasa del lunes, así que la fecha de vigencia
   * puede estar en el futuro. Ahí la cuenta da negativo, y eso es correcto: no
   * es una tasa vieja, es una que todavía no empezó a regir.
   */
  it("da negativo cuando la tasa rige a futuro", () => {
    expect(daysBetween(LUNES, SABADO)).toBe(-2);
  });

  /** Cruza el fin de mes sin contar a mano. */
  it("cruza el cambio de mes", () => {
    expect(daysBetween("2026-08-30", "2026-09-02")).toBe(3);
  });
});

describe("venezuelaDate", () => {
  it("usa la fecha de Venezuela, no la UTC", () => {
    // 2026-08-23T01:00:00Z es todavía sábado 22 a las 21:00 en Caracas.
    expect(venezuelaDate(new Date("2026-08-23T01:00:00Z"))).toBe(SABADO);
  });

  it("cambia de día a la medianoche de Caracas, no a la de Londres", () => {
    expect(venezuelaDate(new Date("2026-08-23T03:59:00Z"))).toBe(SABADO);
    expect(venezuelaDate(new Date("2026-08-23T04:01:00Z"))).toBe("2026-08-23");
  });
});

describe("lastScheduledRead", () => {
  it("retrocede al horario del mismo día cuando ya pasó", () => {
    // 03:00 VE del 24/9 (07:00Z) → el horario vigente es las 00:00 VE del mismo día.
    expect(lastScheduledRead(new Date("2026-09-24T07:00:00Z"))).toEqual(
      new Date("2026-09-24T04:00:00Z"),
    );
  });

  it("en el instante exacto de un horario, ese horario es el vigente", () => {
    // 12:00:00 VE del 24/9 (16:00Z) → el horario vigente es las 12:00 VE de ESE día.
    expect(lastScheduledRead(new Date("2026-09-24T16:00:00Z"))).toEqual(
      new Date("2026-09-24T16:00:00Z"),
    );
  });

  it("retrocede al día anterior cuando ninguno de los horarios de hoy llegó todavía", () => {
    // 2026-09-25T01:00:00Z = 21:00 VE del 24/9 (aún no llegan las 00:00 VE del 25).
    // El horario vigente es 18:00 VE del 24/9 = 22:00Z del 24/9.
    expect(lastScheduledRead(new Date("2026-09-25T01:00:00Z"))).toEqual(
      new Date("2026-09-24T22:00:00Z"),
    );
  });
});

describe("shouldRefetchBcv", () => {
  it("sin lectura previa, hay que buscarla", () => {
    // Es el caso de la fila que siembra el seed: si se diera por buena,
    // taparía la tasa real para siempre.
    expect(shouldRefetchBcv(new Date("2026-09-24T12:00:00Z"), null)).toBe(true);
  });

  it("leída 07:08 del 24: a las 11:59 del mismo día todavía no toca (el horario vigente sigue siendo el de las 07h VE)", () => {
    const leida = new Date("2026-09-24T11:08:00Z"); // 07:08 VE
    expect(shouldRefetchBcv(new Date("2026-09-24T15:59:00Z"), leida)).toBe(false); // 11:59 VE
  });

  it("leída 07:08 del 24: al llegar el horario de las 12:00 VE, toca releer", () => {
    const leida = new Date("2026-09-24T11:08:00Z"); // 07:08 VE
    expect(shouldRefetchBcv(new Date("2026-09-24T16:00:00Z"), leida)).toBe(true); // 12:00 VE
  });

  it("leída 12:30 del 24: a las 18:05 del mismo día ya toca (caso del operador, el BCV publicó la de mañana)", () => {
    const leida = new Date("2026-09-24T16:30:00Z"); // 12:30 VE
    expect(shouldRefetchBcv(new Date("2026-09-24T22:05:00Z"), leida)).toBe(true); // 18:05 VE
  });

  it("leída 18:05 del 24: a las 23:53 del mismo día no toca todavía", () => {
    const leida = new Date("2026-09-24T22:05:00Z"); // 18:05 VE
    expect(shouldRefetchBcv(new Date("2026-09-25T03:53:00Z"), leida)).toBe(false); // 23:53 VE del 24
  });

  it("leída 18:05 del 24: al llegar 00:01 VE del 25 toca releer", () => {
    const leida = new Date("2026-09-24T22:05:00Z"); // 18:05 VE
    expect(shouldRefetchBcv(new Date("2026-09-25T04:01:00Z"), leida)).toBe(true); // 00:01 VE del 25
  });

  /**
   * Guardián de zona horaria: a las 21:00 VE del 24 (01:00Z del 25) el horario
   * vigente sigue siendo el de las 18:00 VE del 24, NO el de las 00:00 VE del
   * 25 — un cálculo que confundiera la zona horaria adelantaría el día.
   */
  it("guardián de zona horaria: 21:00 VE del 24 no adelanta al horario de las 00:00 VE del 25", () => {
    const leida = new Date("2026-09-24T22:10:00Z"); // 18:10 VE del 24, después del horario vigente
    expect(shouldRefetchBcv(new Date("2026-09-25T01:00:00Z"), leida)).toBe(false);
  });

  it("domingo: la regla del domingo se fue a propósito, un GET más no cambia nada", () => {
    // Domingo 27/9, 06:00 VE, leída el sábado 26/9 a las 18:05 VE.
    const leida = new Date("2026-09-26T22:05:00Z"); // 18:05 VE del 26
    expect(shouldRefetchBcv(new Date("2026-09-27T10:00:00Z"), leida)).toBe(true); // 06:00 VE del 27
  });
});
