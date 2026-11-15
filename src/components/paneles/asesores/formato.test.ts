import { describe, expect, it } from "vitest";
import { formatoMinutos, formatoPorcentaje, formatoReloj, iniciales } from "./formato";

/** Plan "Paneles" (13/11/2026), C6: formato de duraciones y porcentajes de Asesores. */
describe("formatoMinutos", () => {
  it("null es «—», nunca 0", () => {
    expect(formatoMinutos(null)).toBe("—");
  });
  it("menos de un minuto", () => {
    expect(formatoMinutos(0.4)).toBe("< 1 min");
  });
  it("hasta 10 minutos con un decimal y coma", () => {
    expect(formatoMinutos(2.4)).toBe("2,4 min");
    expect(formatoMinutos(6)).toBe("6 min");
  });
  it("de 10 a 60 minutos, redondeado", () => {
    expect(formatoMinutos(12.6)).toBe("13 min");
  });
  it("una hora o más usa horas y minutos", () => {
    expect(formatoMinutos(60)).toBe("1 h");
    expect(formatoMinutos(125)).toBe("2 h 05 min");
    expect(formatoMinutos(24 * 60 + 90)).toBe("1 d 1 h");
  });
});

describe("formatoPorcentaje", () => {
  it("null es «—»; 0 sí es 0 %", () => {
    expect(formatoPorcentaje(null)).toBe("—");
    expect(formatoPorcentaje(0)).toBe("0 %");
  });
  it("la fracción 0–1 sale redondeada con espacio antes del %", () => {
    expect(formatoPorcentaje(0.724)).toBe("72 %");
    expect(formatoPorcentaje(1)).toBe("100 %");
  });
});

describe("formatoReloj", () => {
  it("horas:minutos:segundos sin cero a la izquierda en las horas", () => {
    expect(formatoReloj(2 * 3600_000)).toBe("2:00:00");
    expect(formatoReloj(5_000)).toBe("0:00:05");
    expect(formatoReloj(3600_000 + 61_000)).toBe("1:01:01");
  });
  it("con más de un día antepone los días", () => {
    expect(formatoReloj((26 * 3600 + 3) * 1000)).toBe("1 d 2:00:03");
  });
  it("un valor negativo (reloj adelantado) no se pinta negativo", () => {
    expect(formatoReloj(-4000)).toBe("0:00:00");
  });
});

describe("iniciales", () => {
  it("toma la primera letra de las dos primeras palabras", () => {
    expect(iniciales("Ana Gómez Pérez")).toBe("AG");
    expect(iniciales("carla")).toBe("C");
    expect(iniciales("")).toBe("?");
  });
});
