import { describe, expect, it } from "vitest";
import { formatCrmDateTime } from "@/lib/time-zone";

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
