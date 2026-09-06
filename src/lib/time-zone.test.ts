import { describe, expect, it } from "vitest";
import { crmWeekday, formatCrmDateTime } from "@/lib/time-zone";

/**
 * El contenedor de producción corre con `TZ` vacía, o sea en UTC, y Venezuela
 * está cuatro horas por detrás. Todo lo que se prueba acá es la misma cosa
 * vista desde distintos bordes: que la hora que sale de esta función sea la
 * del reloj de Barinas y no la del reloj del proceso.
 */
describe("formatCrmDateTime", () => {
  it("da la hora de Venezuela, no la del proceso", () => {
    // 19:12 UTC son las 15:12 en Caracas.
    const texto = formatCrmDateTime(new Date("2026-08-27T19:12:00Z"));

    expect(texto).toContain("3:12 p. m.");
    expect(texto).toContain("27 de agosto de 2026");
  });

  /**
   * El caso que el dueño reportó: "buenos días" a las tres de la tarde. A esta
   * hora UTC el proceso ya cambió de día y de saludo; en Barinas todavía es
   * de noche del día anterior.
   */
  it("no adelanta el día cuando en UTC ya cambió", () => {
    // 02:30 UTC del día 28 son las 22:30 del 27 en Caracas.
    const texto = formatCrmDateTime(new Date("2026-08-28T02:30:00Z"));

    expect(texto).toContain("27 de agosto de 2026");
    expect(texto).toContain("10:30 p. m.");
    expect(texto).toContain("jueves");
  });

  it("distingue mañana, tarde y noche en la zona correcta", () => {
    expect(formatCrmDateTime(new Date("2026-08-27T13:00:00Z"))).toContain("9:00 a. m.");
    expect(formatCrmDateTime(new Date("2026-08-27T20:00:00Z"))).toContain("4:00 p. m.");
    expect(formatCrmDateTime(new Date("2026-08-28T01:00:00Z"))).toContain("9:00 p. m.");
  });

  it("acepta otra zona sin tocar la configuración global", () => {
    const caracas = formatCrmDateTime(new Date("2026-08-27T19:12:00Z"), "America/Caracas");
    const utc = formatCrmDateTime(new Date("2026-08-27T19:12:00Z"), "UTC");

    expect(caracas).not.toEqual(utc);
    expect(utc).toContain("7:12 p. m.");
  });
});

/**
 * `business-hours.ts` (5/9/2026) necesita el día de la semana en la zona del
 * equipo para saber contra qué franja del horario comparar un instante.
 * `Date#getDay()` no sirve por la misma razón de siempre: lee el reloj del
 * proceso (UTC), y cerca de la medianoche de Caracas el día ya cambió para
 * el servidor sin haber cambiado para el cliente.
 */
describe("crmWeekday", () => {
  it("da domingo (0) cuando en UTC ya es lunes de madrugada", () => {
    // 2026-08-31 es lunes. 03:59 UTC del lunes son las 23:59 del domingo en Caracas.
    expect(crmWeekday(new Date("2026-08-31T03:59:00Z"))).toBe(0);
  });

  it("da lunes (1) apenas empieza el lunes en Caracas", () => {
    // 04:00 UTC del lunes son las 00:00 del lunes en Caracas.
    expect(crmWeekday(new Date("2026-08-31T04:00:00Z"))).toBe(1);
  });

  it.each([
    ["2026-08-30T16:00:00Z", 0], // domingo mediodía en Caracas
    ["2026-08-31T16:00:00Z", 1], // lunes
    ["2026-09-01T16:00:00Z", 2], // martes
    ["2026-09-02T16:00:00Z", 3], // miércoles
    ["2026-09-03T16:00:00Z", 4], // jueves
    ["2026-09-04T16:00:00Z", 5], // viernes
    ["2026-09-05T16:00:00Z", 6], // sábado
  ])("%s en Caracas cae en el día %i", (iso, esperado) => {
    expect(crmWeekday(new Date(iso))).toBe(esperado);
  });

  it("acepta otra zona sin tocar la configuración global", () => {
    // 2026-08-31T02:00:00Z: en Caracas (UTC-4) es domingo 22:00; en UTC es lunes.
    expect(crmWeekday(new Date("2026-08-31T02:00:00Z"), "America/Caracas")).toBe(0);
    expect(crmWeekday(new Date("2026-08-31T02:00:00Z"), "UTC")).toBe(1);
  });
});
