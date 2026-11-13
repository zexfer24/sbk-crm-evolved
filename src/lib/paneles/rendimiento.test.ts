import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import type { MetaVenta } from "./parse";
import { curvaHoraria, faltante, metaDelDia, porcentaje, proyeccion, racha } from "./rendimiento";

// 2026-11-13 es viernes; 2026-11-15 es domingo (cerrado en el horario por defecto).
const metas: MetaVenta[] = [
  { canal: "online", vigente_desde: "2026-01-01", monto_usd: 500 },
  { canal: "online", vigente_desde: "2026-11-10", monto_usd: 800 },
  { canal: "tienda", vigente_desde: "2026-01-01", monto_usd: 1000 },
];

describe("metaDelDia", () => {
  it("usa la fila con el vigente_desde más alto que no pase del día", () => {
    expect(metaDelDia(metas, "online", "2026-11-13", DEFAULT_BUSINESS_HOURS)).toBe(800);
    expect(metaDelDia(metas, "online", "2026-11-09", DEFAULT_BUSINESS_HOURS)).toBe(500);
  });

  it("el día vigente_desde cuenta (es inclusivo)", () => {
    expect(metaDelDia(metas, "online", "2026-11-10", DEFAULT_BUSINESS_HOURS)).toBe(800);
  });

  it("domingo cerrado → null", () => {
    expect(metaDelDia(metas, "online", "2026-11-15", DEFAULT_BUSINESS_HOURS)).toBeNull();
    expect(metaDelDia(metas, "resumen", "2026-11-15", DEFAULT_BUSINESS_HOURS)).toBeNull();
  });

  it("resumen = online + tienda", () => {
    expect(metaDelDia(metas, "resumen", "2026-11-13", DEFAULT_BUSINESS_HOURS)).toBe(1800);
  });

  it("resumen con un solo canal con meta suma lo que haya", () => {
    expect(
      metaDelDia(
        metas.filter((m) => m.canal === "tienda"),
        "resumen",
        "2026-11-13",
        DEFAULT_BUSINESS_HOURS
      )
    ).toBe(1000);
  });

  it("sin meta vigente → null", () => {
    expect(metaDelDia(metas, "online", "2025-12-31", DEFAULT_BUSINESS_HOURS)).toBeNull();
    expect(metaDelDia([], "resumen", "2026-11-13", DEFAULT_BUSINESS_HOURS)).toBeNull();
  });

  it("un sábado abierto sí tiene meta", () => {
    const horario = { ...DEFAULT_BUSINESS_HOURS, sat: [["08:00", "13:00"]] as [string, string][] };
    expect(metaDelDia(metas, "tienda", "2026-11-14", horario)).toBe(1000);
  });
});

const diaTipico = (n: number) => {
  // Un día en que todo se vende de 10:00 a 11:59: 50 % en la hora 10 y 50 % en la 11.
  const porHora = new Array<number>(24).fill(0);
  porHora[10] = 100;
  porHora[11] = 100;
  return { dia: `2026-11-${String(n).padStart(2, "0")}`, porHora };
};

describe("curvaHoraria", () => {
  it("con menos de 10 días con ventas → null", () => {
    const historia = Array.from({ length: 9 }, (_, i) => diaTipico(i + 1));
    expect(curvaHoraria(historia)).toBeNull();
  });

  it("un día sin ventas no cuenta para los 10", () => {
    const historia = Array.from({ length: 9 }, (_, i) => diaTipico(i + 1));
    historia.push({ dia: "2026-11-10", porHora: new Array<number>(24).fill(0) });
    expect(curvaHoraria(historia)).toBeNull();
  });

  it("con 10 días da la proporción acumulada al cierre de cada hora", () => {
    const historia = Array.from({ length: 10 }, (_, i) => diaTipico(i + 1));
    const curva = curvaHoraria(historia);
    expect(curva).not.toBeNull();
    expect(curva).toHaveLength(24);
    expect(curva![9]).toBeCloseTo(0, 6);
    expect(curva![10]).toBeCloseTo(0.5, 6);
    expect(curva![11]).toBeCloseTo(1, 6);
    expect(curva![23]).toBeCloseTo(1, 6);
  });

  it("promedia la forma de cada día: un día enorme no aplasta a los demás", () => {
    const historia = Array.from({ length: 10 }, (_, i) => diaTipico(i + 1));
    const raro = new Array<number>(24).fill(0);
    raro[20] = 1_000_000;
    historia[0] = { dia: "2026-11-01", porHora: raro };
    const curva = curvaHoraria(historia)!;
    // 9 días con 0,5 acumulado a las 10 y 1 día con 0 → 0,45
    expect(curva[10]).toBeCloseTo(0.45, 6);
  });

  it("ignora un día con una forma que no es de 24 horas", () => {
    const historia = Array.from({ length: 10 }, (_, i) => diaTipico(i + 1));
    historia[3] = { dia: "2026-11-04", porHora: [1, 2, 3] };
    expect(curvaHoraria(historia)).toBeNull(); // quedan 9 válidos
  });
});

describe("proyeccion", () => {
  // Acumulado al CIERRE de cada hora: 0 hasta la 9, 0,5 al cerrar la 10, 1 al cerrar la 11.
  const curva = Array.from({ length: 24 }, (_, h) => (h < 10 ? 0 : h === 10 ? 0.5 : 1));

  it("logrado dividido entre la fracción que normalmente ya se vendió", () => {
    // a las 11:00 en punto ya se acumuló el 50 % (cierre de la hora 10)
    expect(proyeccion(250, 11, curva)).toBe(500);
  });

  it("interpola dentro de la hora", () => {
    // a las 10:30 → 25 % acumulado
    expect(proyeccion(100, 10.5, curva)).toBe(400);
  });

  it("sin curva → null", () => {
    expect(proyeccion(100, 12, null)).toBeNull();
  });

  it("antes de que normalmente se venda algo no proyecta (null, no infinito)", () => {
    expect(proyeccion(0, 8, curva)).toBeNull();
  });

  it("al final del día la proyección es lo logrado", () => {
    expect(proyeccion(777.5, 24, curva)).toBe(777.5);
  });
});

describe("racha", () => {
  it("cuenta días seguidos cumplidos hasta ayer, sin importar el orden de entrada", () => {
    const dias = [
      { dia: "2026-11-10", logrado: 900, meta: 800 },
      { dia: "2026-11-12", logrado: 850, meta: 800 },
      { dia: "2026-11-11", logrado: 800, meta: 800 },
      { dia: "2026-11-09", logrado: 100, meta: 800 },
    ];
    expect(racha(dias)).toBe(3);
  });

  it("un día sin meta (domingo cerrado) no corta ni suma", () => {
    const dias = [
      { dia: "2026-11-16", logrado: 900, meta: 800 }, // lunes
      { dia: "2026-11-15", logrado: 0, meta: null }, // domingo cerrado
      { dia: "2026-11-14", logrado: 0, meta: null }, // sábado cerrado
      { dia: "2026-11-13", logrado: 900, meta: 800 }, // viernes
      { dia: "2026-11-12", logrado: 10, meta: 800 }, // jueves: falló
    ];
    expect(racha(dias)).toBe(2);
  });

  it("un día incumplido corta la racha; sin historial es 0", () => {
    expect(racha([{ dia: "2026-11-12", logrado: 10, meta: 800 }])).toBe(0);
    expect(racha([])).toBe(0);
  });
});

describe("faltante y porcentaje", () => {
  it("faltante es lo que resta para la meta, nunca negativo", () => {
    expect(faltante(300, 800)).toBe(500);
    expect(faltante(900, 800)).toBe(0);
  });

  it("porcentaje del logrado sobre la meta, con un decimal", () => {
    expect(porcentaje(300, 800)).toBe(37.5);
    expect(porcentaje(1000, 800)).toBe(125);
    expect(porcentaje(1, 3)).toBe(33.3);
  });

  it("sin meta o sin logrado → null; meta 0 → null (no divide)", () => {
    expect(faltante(300, null)).toBeNull();
    expect(faltante(null, 800)).toBeNull();
    expect(porcentaje(300, null)).toBeNull();
    expect(porcentaje(null, 800)).toBeNull();
    expect(porcentaje(300, 0)).toBeNull();
  });
});
