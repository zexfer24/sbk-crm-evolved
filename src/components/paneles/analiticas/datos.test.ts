import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import type { MetaVenta, PanelVentas } from "@/lib/paneles/parse";
import {
  diasDeRendimiento,
  etapasDelEmbudo,
  etiquetaDeTramo,
  filtrarActivas,
  fraseDelEmbudo,
  horasDeAtencion,
  mesesDelAnio,
  resumenDeRendimiento,
  serieDeMedida,
  tasaDeConversion,
  tasaDeRegreso,
  valoresPrevios,
  variacionPct,
  formatoEdad,
} from "./datos";

/**
 * Plan "Paneles" (13/11/2026), C5: la aritmética de Analíticas, pura. Nada de
 * esto lee el reloj: cada función recibe `ahora` o el día.
 */

function ventas(parcial: Partial<PanelVentas> = {}): PanelVentas {
  const canal = { ingresos: 0, envios: 0, unidades: 0, ticket: null, estimados: 0, sin_monto: 0 };
  return {
    granularidad: "dia",
    canales: { online: { ...canal }, tienda: { ...canal } },
    serie: [],
    perfil_horario: [],
    personas: [],
    top_repuestos: [],
    tipo_precio: { online: { promocion: 0, estandar: 0 }, tienda: { promocion: 0, estandar: 0 } },
    estado: { transito: { envios: 0, monto: null }, error: { envios: 0 }, sin_foto: 0, duplicados: 0 },
    recurrentes: { online: { compradores: 0, regresan: 0 }, tienda: { compradores: 0, regresan: 0 }, genericos_excluidos: 0 },
    ...parcial,
  };
}

const SERIE = [
  { t: "2026-11-12T00:00:00-04:00", online: 100, tienda: 40, envios_online: 2, envios_tienda: 1 },
  { t: "2026-11-13T00:00:00-04:00", online: 60, tienda: 10, envios_online: 1, envios_tienda: 1 },
];

describe("variacionPct", () => {
  it("calcula el cambio relativo contra el previo", () => {
    expect(variacionPct(150, 100)).toBe(50);
    expect(variacionPct(50, 100)).toBe(-50);
  });
  it("devuelve null si no hay con qué comparar (previo 0 o null, actual null)", () => {
    expect(variacionPct(10, 0)).toBeNull();
    expect(variacionPct(10, null)).toBeNull();
    expect(variacionPct(null, 10)).toBeNull();
  });
});

describe("etiquetaDeTramo", () => {
  it("rotula por granularidad en hora de Caracas, sin punto final", () => {
    expect(etiquetaDeTramo("2026-11-13T08:00:00-04:00", "hora")).toBe("08:00");
    expect(etiquetaDeTramo("2026-11-13T00:00:00-04:00", "dia")).toBe("13 nov");
    expect(etiquetaDeTramo("2026-11-01T00:00:00-04:00", "mes")).toBe("nov");
  });
});

describe("formatoEdad", () => {
  it("escoge la unidad legible", () => {
    expect(formatoEdad(0.5)).toBe("30 min");
    expect(formatoEdad(5)).toBe("5 h");
    expect(formatoEdad(72)).toBe("3 d");
  });
});

describe("serieDeMedida", () => {
  it("resumen sin comparar: una serie por canal", () => {
    const { series, valores } = serieDeMedida(ventas({ serie: SERIE }), "resumen", "ingresos", false);
    expect(series.map((s) => s.id)).toEqual(["online", "tienda"]);
    expect(valores).toEqual([
      [100, 40],
      [60, 10],
    ]);
  });
  it("resumen comparando: una sola serie Total, para que la previa sea comparable", () => {
    const { series, valores } = serieDeMedida(ventas({ serie: SERIE }), "resumen", "ingresos", true);
    expect(series.map((s) => s.id)).toEqual(["total"]);
    expect(valores).toEqual([[140], [70]]);
  });
  it("un canal: su serie; la medida Envíos usa los envíos del canal", () => {
    const { series, valores } = serieDeMedida(ventas({ serie: SERIE }), "tienda", "envios", false);
    expect(series.map((s) => s.id)).toEqual(["tienda"]);
    expect(valores).toEqual([[1], [1]]);
  });
  it("valoresPrevios es el total de la vista por tramo", () => {
    expect(valoresPrevios(ventas({ serie: SERIE }), "resumen", "ingresos")).toEqual([140, 70]);
    expect(valoresPrevios(ventas({ serie: SERIE }), "online", "envios")).toEqual([2, 1]);
  });
});

describe("tasaDeConversion y tasaDeRegreso", () => {
  it("la conversión es compraron entre atendidas del equipo; null sin atendidas", () => {
    expect(tasaDeConversion({ atendidas: 40, compraron: 10 })).toEqual({ fraccion: 0.25, compraron: 10, atendidas: 40 });
    expect(tasaDeConversion({ atendidas: 0, compraron: 0 }).fraccion).toBeNull();
  });
  it("clientes que regresan: suma canales en resumen, null sin compradores", () => {
    const rec = { online: { compradores: 10, regresan: 4 }, tienda: { compradores: 30, regresan: 6 }, genericos_excluidos: 0 };
    expect(tasaDeRegreso(rec, "resumen")).toEqual({ fraccion: 0.25, regresan: 10, compradores: 40 });
    expect(tasaDeRegreso(rec, "online")).toEqual({ fraccion: 0.4, regresan: 4, compradores: 10 });
    expect(tasaDeRegreso({ ...rec, tienda: { compradores: 0, regresan: 0 } }, "tienda").fraccion).toBeNull();
  });
});

describe("embudo", () => {
  const embudo = { escribieron: 200, respondidas: 150, con_carrito: 60, compraron: 30 };
  it("cada etapa trae su porcentaje del inicio y la caída contra la anterior", () => {
    const etapas = etapasDelEmbudo(embudo);
    expect(etapas.map((e) => e.valor)).toEqual([200, 150, 60, 30]);
    expect(etapas[0].caida).toBeNull();
    expect(etapas[1]).toMatchObject({ pctDelInicio: 75, caida: { n: 50, pct: 25 } });
    expect(etapas[3]).toMatchObject({ pctDelInicio: 15, caida: { n: 30, pct: 50 } });
  });
  it("una etapa que supera a la anterior no inventa una caída negativa", () => {
    const etapas = etapasDelEmbudo({ escribieron: 10, respondidas: 4, con_carrito: 5, compraron: 1 });
    expect(etapas[2].caida).toEqual({ n: 0, pct: 0 });
  });
  it("la frase se calcula por cada 100 que escribieron", () => {
    const frase = fraseDelEmbudo(embudo, { compraron: 30, reclamo: 2, carrito_sin_compra: 28, solo_preguntaron: 90, sin_respuesta: 50 });
    expect(frase).toBe("De cada 100 que escribieron, 45 solo preguntaron y 15 compraron.");
    expect(fraseDelEmbudo({ ...embudo, escribieron: 0 }, { compraron: 0, reclamo: 0, carrito_sin_compra: 0, solo_preguntaron: 0, sin_respuesta: 0 })).toBeNull();
  });
});

describe("horasDeAtencion", () => {
  it("cubre desde la apertura más temprana hasta la última hora abierta", () => {
    expect(horasDeAtencion(DEFAULT_BUSINESS_HOURS)).toEqual({ desde: 8, hasta: 17 });
    expect(horasDeAtencion({ ...DEFAULT_BUSINESS_HOURS, sat: [["09:00", "18:30"]] })).toEqual({ desde: 8, hasta: 18 });
  });
  it("sin ningún horario abierto muestra el día entero", () => {
    expect(horasDeAtencion({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] })).toEqual({ desde: 0, hasta: 23 });
  });
});

describe("filtrarActivas", () => {
  const ahora = new Date("2026-11-15T12:00:00-04:00");
  const item = (id: string, tipo: "presupuesto" | "carrito", canal: "online" | "tienda", desde: string) => ({
    tipo,
    id,
    canal,
    responsable: null,
    cliente: null,
    monto: null,
    unidades: 1,
    desde,
  });
  const items = [
    item("a", "presupuesto", "tienda", "2026-11-01T12:00:00-04:00"),
    item("b", "carrito", "online", "2026-11-10T12:00:00-04:00"),
    item("c", "carrito", "online", "2026-11-15T10:00:00-04:00"),
  ];
  it("filtra por tipo, canal y antigüedad", () => {
    const ids = (f: Parameters<typeof filtrarActivas>[1]) => filtrarActivas(items, f, ahora).map((i) => i.id);
    expect(ids({ tipo: "carrito", canal: "resumen", antiguedad: "todas" })).toEqual(["b", "c"]);
    expect(ids({ tipo: "todos", canal: "tienda", antiguedad: "todas" })).toEqual(["a"]);
    expect(ids({ tipo: "todos", canal: "resumen", antiguedad: "7d" })).toEqual(["a"]);
    expect(ids({ tipo: "todos", canal: "resumen", antiguedad: "24h" })).toEqual(["a", "b"]);
  });
});

describe("mesesDelAnio", () => {
  it("agrupa la serie por mes de Caracas hasta el mes en curso, sea cual sea la granularidad", () => {
    const serie = [
      { t: "2026-09-01T00:00:00-04:00", online: 10, tienda: 5, envios_online: 1, envios_tienda: 1 },
      { t: "2026-09-02T00:00:00-04:00", online: 20, tienda: 0, envios_online: 2, envios_tienda: 0 },
      { t: "2026-11-01T00:00:00-04:00", online: 7, tienda: 3, envios_online: 1, envios_tienda: 1 },
    ];
    const meses = mesesDelAnio(serie, new Date("2026-11-15T12:00:00-04:00"));
    expect(meses).toHaveLength(11);
    expect(meses[8]).toMatchObject({ clave: "2026-09", online: 30, tienda: 5, envios: 4, enCurso: false });
    expect(meses[9]).toMatchObject({ clave: "2026-10", online: 0, tienda: 0, envios: 0 });
    expect(meses[10]).toMatchObject({ clave: "2026-11", enCurso: true, online: 7 });
  });
});

describe("rendimiento", () => {
  const metas: MetaVenta[] = [{ canal: "online", vigente_desde: "2026-11-01", monto_usd: 100 }];
  const serie = [
    { t: "2026-11-09T00:00:00-04:00", online: 150, tienda: 0, envios_online: 3, envios_tienda: 0 }, // lunes
    { t: "2026-11-10T00:00:00-04:00", online: 50, tienda: 0, envios_online: 1, envios_tienda: 0 },
    { t: "2026-11-11T00:00:00-04:00", online: 120, tienda: 0, envios_online: 2, envios_tienda: 0 },
    { t: "2026-11-12T00:00:00-04:00", online: 130, tienda: 0, envios_online: 2, envios_tienda: 0 },
    { t: "2026-11-13T00:00:00-04:00", online: 80, tienda: 0, envios_online: 1, envios_tienda: 0 }, // viernes
    { t: "2026-11-14T00:00:00-04:00", online: 999, tienda: 0, envios_online: 9, envios_tienda: 0 }, // sábado: cerrado, sin meta
    { t: "2026-11-15T00:00:00-04:00", online: 0, tienda: 0, envios_online: 0, envios_tienda: 0 }, // domingo: cerrado
  ];

  it("solo cuenta días hábiles con meta vigente y marca el de hoy como en curso", () => {
    const dias = diasDeRendimiento({ serie, metas, vista: "online", horario: DEFAULT_BUSINESS_HOURS, hoy: "2026-11-13" });
    expect(dias.map((d) => d.dia)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(dias.map((d) => d.cumplida)).toEqual([true, false, true, true, null]);
    expect(dias[4].enCurso).toBe(true);
    expect(dias[0].meta).toBe(100);
  });
  it("respeta el tope de días y se queda con los más recientes", () => {
    const dias = diasDeRendimiento({ serie, metas, vista: "online", horario: DEFAULT_BUSINESS_HOURS, hoy: "2026-11-13", max: 3 });
    expect(dias.map((d) => d.dia)).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
  });
  it("resume racha (sin contar hoy), mejor día y cumplidas", () => {
    const dias = diasDeRendimiento({ serie, metas, vista: "online", horario: DEFAULT_BUSINESS_HOURS, hoy: "2026-11-13" });
    expect(resumenDeRendimiento(dias)).toEqual({
      racha: 2,
      mejor: { dia: "2026-11-09", logrado: 150 },
      cumplidas: 3,
      evaluadas: 4,
    });
  });
  it("sin ninguna meta no hay días que evaluar", () => {
    expect(diasDeRendimiento({ serie, metas: [], vista: "online", horario: DEFAULT_BUSINESS_HOURS, hoy: "2026-11-13" })).toEqual([]);
  });
});
