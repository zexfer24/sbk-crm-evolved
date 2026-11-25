import { describe, expect, it } from "vitest";
import { alertaDeTasa, BCV_ALERTA_HORAS, formatearDesde, type BcvEstadoLectura } from "@/lib/bcv-alerta";

const AHORA = new Date("2026-11-21T18:00:00Z");

function estado(parcial: Partial<BcvEstadoLectura> = {}): BcvEstadoLectura {
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    ...parcial,
  };
}

/** ISO de un instante `minutos` antes de AHORA. */
function haceMinutos(minutos: number): string {
  return new Date(AHORA.getTime() - minutos * 60_000).toISOString();
}

describe("alertaDeTasa — cuándo la tasa del BCV está 'en alerta'", () => {
  it("fija el umbral en 8 horas", () => {
    expect(BCV_ALERTA_HORAS).toBe(8);
  });

  it("sin estado (la tabla no existe todavía) no hay alerta: se comporta como antes", () => {
    expect(alertaDeTasa(null, AHORA)).toBeNull();
  });

  it("7 h 59 min desde el último éxito: sin alerta", () => {
    expect(alertaDeTasa(estado({ lastSuccessAt: haceMinutos(7 * 60 + 59) }), AHORA)).toBeNull();
  });

  it("exactamente 8 h: sin alerta (el umbral es estricto)", () => {
    expect(alertaDeTasa(estado({ lastSuccessAt: haceMinutos(8 * 60) }), AHORA)).toBeNull();
  });

  it("8 h 01 min: alerta con la fecha del último éxito y el último error", () => {
    const exito = haceMinutos(8 * 60 + 1);
    const alerta = alertaDeTasa(
      estado({ lastSuccessAt: exito, lastError: "certificado vencido", consecutiveFailures: 9 }),
      AHORA
    );
    expect(alerta).toEqual({ desde: exito, ultimoError: "certificado vencido" });
  });

  it("sin éxito registrado y con fallos: alerta con desde null", () => {
    const alerta = alertaDeTasa(estado({ consecutiveFailures: 3, lastError: "boom" }), AHORA);
    expect(alerta).toEqual({ desde: null, ultimoError: "boom" });
  });

  it("sin éxito registrado y sin fallos (nada ha corrido aún): sin alerta", () => {
    expect(alertaDeTasa(estado(), AHORA)).toBeNull();
  });

  it("con un éxito reciente no hay alerta aunque haya fallos sueltos", () => {
    expect(
      alertaDeTasa(estado({ lastSuccessAt: haceMinutos(30), consecutiveFailures: 2, lastError: "x" }), AHORA)
    ).toBeNull();
  });
});

describe("formatearDesde", () => {
  it("muestra el instante en hora de Caracas: 22:00Z es las 6:00 p. m. del 18 nov.", () => {
    // Los espacios (a veces NNBSP según el ICU de Node) se normalizan para
    // que el test no dependa de la versión: la función ya los normaliza.
    expect(formatearDesde("2026-11-18T22:00:00Z")).toBe("18 nov., 6:00 p. m.");
  });

  it("cruza la medianoche de Caracas, no la de UTC", () => {
    // 02:30Z del 19 son las 10:30 p. m. del 18 en Caracas.
    expect(formatearDesde("2026-11-19T02:30:00Z")).toBe("18 nov., 10:30 p. m.");
  });
});
