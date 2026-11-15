import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import {
  acumuladoPorHora,
  antiguedadTexto,
  desgloseActivas,
  hayItemsViejos,
  ingresosPorMes,
  itemsDeVista,
  metaAcumuladaPorHora,
  periodoTocaAntesDeEnvios,
  serieDeVista,
  variacion,
  ventanaDeHoy,
} from "@/components/paneles/dashboard/calculos";
import { AHORA, AHORA_DOMINGO, activas, ventas, ventasHoy } from "@/components/paneles/dashboard/dashboard-fixtures";

describe("variacion", () => {
  it("da el cambio porcentual con un decimal", () => {
    expect(variacion(1234.5, 1100)).toBe(12.2);
    expect(variacion(50, 100)).toBe(-50);
  });
  it("no se puede calcular sin período previo o con previo en cero: null, nunca 0", () => {
    expect(variacion(100, null)).toBeNull();
    expect(variacion(100, 0)).toBeNull();
    expect(variacion(null, 100)).toBeNull();
  });
});

describe("serieDeVista", () => {
  it("suma los canales en el resumen y toma uno solo en su vista", () => {
    const v = ventas();
    expect(serieDeVista(v, "resumen", "ingresos")).toEqual([300, 450, 484.5]);
    expect(serieDeVista(v, "online", "ingresos")).toEqual([200, 300, 300]);
    expect(serieDeVista(v, "tienda", "envios")).toEqual([1, 2, 2]);
  });
});

describe("desgloseActivas", () => {
  it("en el resumen usa el total y el reparto presupuestos/carritos", () => {
    const d = desgloseActivas(activas(), "resumen");
    expect(d.monto).toBe(600);
    expect(d.cantidad).toBe(5);
    expect(d.presupuestos).toEqual({ monto: 400, cantidad: 3 });
    expect(d.carritos).toEqual({ monto: 200, cantidad: 2 });
  });
  it("en tienda todo es presupuesto (los carritos son del chat)", () => {
    const d = desgloseActivas(activas(), "tienda");
    expect(d.monto).toBe(250);
    expect(d.cantidad).toBe(2);
    expect(d.carritos).toEqual({ monto: 0, cantidad: 0 });
    expect(d.presupuestos).toEqual({ monto: 250, cantidad: 2 });
  });
  it("en online los carritos son todos los carritos y los presupuestos, lo que sobra", () => {
    const d = desgloseActivas(activas(), "online");
    expect(d.monto).toBe(350);
    expect(d.carritos).toEqual({ monto: 200, cantidad: 2 });
    expect(d.presupuestos).toEqual({ monto: 150, cantidad: 1 });
  });
  it("un monto null sigue null: no se inventa un parcial", () => {
    const d = desgloseActivas(activas({ total: null, carritos: { monto: null, cantidad: 2, sin_precio: 1 } }), "online");
    expect(d.carritos.monto).toBeNull();
    expect(d.presupuestos.monto).toBeNull();
  });
});

describe("itemsDeVista y hayItemsViejos", () => {
  it("filtra por canal y ordena del más viejo al más nuevo", () => {
    const desordenados = activas().items.slice().reverse();
    const lista = itemsDeVista(activas({ items: desordenados }), "tienda");
    expect(lista.map((i) => i.id)).toEqual(["p-viejo", "p-medio"]);
    expect(itemsDeVista(activas({ items: desordenados }), "resumen").map((i) => i.id)[0]).toBe("p-viejo");
  });
  it("marca viejos los de más de 7 días: en el resumen por el tramo, en un canal por los ítems", () => {
    expect(hayItemsViejos(activas(), "resumen", AHORA)).toBe(true);
    expect(hayItemsViejos(activas(), "tienda", AHORA)).toBe(true);
    expect(hayItemsViejos(activas(), "online", AHORA)).toBe(false);
    const sinViejos = activas({ antiguedad: activas().antiguedad.map((t) => (t.tramo === "30d" ? { ...t, cantidad: 0, monto: null } : t)) });
    expect(hayItemsViejos(sinViejos, "resumen", AHORA)).toBe(false);
  });
});

describe("antiguedadTexto", () => {
  it("usa la unidad más grande que cabe", () => {
    expect(antiguedadTexto("2026-11-13T18:10:00-04:00", AHORA)).toBe("20 min");
    expect(antiguedadTexto("2026-11-13T13:30:00-04:00", AHORA)).toBe("5 h");
    expect(antiguedadTexto("2026-11-10T18:30:00-04:00", AHORA)).toBe("3 d");
    expect(antiguedadTexto("2026-11-13T18:29:50-04:00", AHORA)).toBe("menos de 1 min");
  });
});

describe("ventanaDeHoy", () => {
  it("es el rango de atención del día en horas fraccionales; null si no abre", () => {
    expect(ventanaDeHoy(DEFAULT_BUSINESS_HOURS, AHORA)).toEqual({ desde: 8, hasta: 18 });
    expect(ventanaDeHoy(DEFAULT_BUSINESS_HOURS, AHORA_DOMINGO)).toBeNull();
  });
  it("une varias franjas del mismo día", () => {
    const partido = { ...DEFAULT_BUSINESS_HOURS, fri: [["08:00", "12:00"], ["14:30", "18:00"]] as [string, string][] };
    expect(ventanaDeHoy(partido, AHORA)).toEqual({ desde: 8, hasta: 18 });
  });
});

describe("acumuladoPorHora", () => {
  it("acumula las ventas de hoy hora a hora hasta la hora actual", () => {
    const acumulado = acumuladoPorHora(ventasHoy(), "resumen", 12);
    expect(acumulado).toHaveLength(13);
    expect(acumulado[8]).toBe(0);
    expect(acumulado[9]).toBe(100);
    expect(acumulado[11]).toBe(350);
    expect(acumulado[12]).toBe(350);
    expect(acumuladoPorHora(ventasHoy(), "tienda", 12)[11]).toBe(50);
  });
});

describe("metaAcumuladaPorHora", () => {
  it("con curva, sigue la forma habitual del día", () => {
    const curva = Array.from({ length: 24 }, (_, h) => (h < 10 ? 0 : h < 15 ? 0.5 : 1));
    const meta = metaAcumuladaPorHora(1000, curva, { desde: 8, hasta: 18 });
    expect(meta[9]).toBe(0);
    expect(meta[12]).toBe(500);
    expect(meta[20]).toBe(1000);
  });
  it("sin curva, avanza en línea recta durante el horario de atención", () => {
    const meta = metaAcumuladaPorHora(1000, null, { desde: 8, hasta: 18 });
    expect(meta[7]).toBe(0);
    expect(meta[12]).toBe(500);
    expect(meta[17]).toBe(1000);
    expect(meta[22]).toBe(1000);
  });
});

describe("ingresosPorMes", () => {
  it("agrupa por mes de Caracas aunque la serie venga por día", () => {
    const v = ventas({
      serie: [
        { t: "2026-10-31T23:00:00-04:00", online: 10, tienda: 1, envios_online: 1, envios_tienda: 1 },
        { t: "2026-11-01T00:00:00-04:00", online: 20, tienda: 2, envios_online: 1, envios_tienda: 1 },
        { t: "2026-11-02T00:00:00-04:00", online: 30, tienda: 3, envios_online: 1, envios_tienda: 1 },
      ],
    });
    const meses = ingresosPorMes(v, 2026);
    expect(meses).toHaveLength(12);
    expect(meses[9]).toEqual({ mes: 10, online: 10, tienda: 1 });
    expect(meses[10]).toEqual({ mes: 11, online: 50, tienda: 5 });
    expect(meses[0]).toEqual({ mes: 1, online: 0, tienda: 0 });
  });
});

describe("periodoTocaAntesDeEnvios", () => {
  it("es verdadero si el período empieza antes del 26/10/2026", () => {
    expect(periodoTocaAntesDeEnvios(new Date("2026-10-17T04:00:00Z"))).toBe(true);
    expect(periodoTocaAntesDeEnvios(new Date("2026-11-01T04:00:00Z"))).toBe(false);
  });
});
