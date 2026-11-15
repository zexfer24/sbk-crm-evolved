/* eslint-disable @typescript-eslint/no-explicit-any -- los tests mutan copias de fixtures JSON para armar formas rotas a propósito */
import { describe, expect, it } from "vitest";
import {
  parseMetasVenta,
  parsePanelAsesores,
  parsePanelCola,
  parsePanelConversaciones,
  parsePanelVentas,
  parsePanelVentasActivas,
  sumaCanales,
} from "./parse";

const canalVacio = { ingresos: 0, envios: 0, unidades: 0, ticket: null, estimados: 0, sin_monto: 0 };

const ventasValidas = () => ({
  granularidad: "dia",
  canales: {
    online: { ingresos: 300, envios: 3, unidades: 6, ticket: 100, estimados: 0, sin_monto: 0 },
    tienda: { ingresos: 700, envios: 7, unidades: 9, ticket: 100, estimados: 1, sin_monto: 0 },
  },
  serie: [
    { t: "2026-11-13T00:00:00-04:00", online: 100, tienda: 200, envios_online: 1, envios_tienda: 2 },
  ],
  perfil_horario: [
    {
      dia: "2026-11-13",
      online: Array.from({ length: 24 }, (_, h) => (h === 9 ? 100 : 0)),
      tienda: Array.from({ length: 24 }, (_, h) => (h === 10 ? 200 : 0)),
    },
  ],
  personas: [
    { agent_id: "11111111-1111-1111-1111-111111111111", nombre: "Asesor 4", rol: "agent", canal: "tienda", ingresos: 700, envios: 7, unidades: 9 },
  ],
  top_repuestos: [
    { codprod: "LF09", nombre: "Filtro", unidades: 4, ingresos: 40, unidades_online: 1, unidades_tienda: 3 },
  ],
  tipo_precio: { online: { promocion: 1, estandar: 2 }, tienda: { promocion: 3, estandar: 4 } },
  estado: { transito: { envios: 2, monto: null }, error: { envios: 1 }, sin_foto: 0, duplicados: 0 },
  recurrentes: {
    online: { compradores: 3, regresan: 1 },
    tienda: { compradores: 7, regresan: 2 },
    genericos_excluidos: 1,
  },
});

describe("parsePanelVentas", () => {
  it("acepta la forma del contrato", () => {
    const v = parsePanelVentas(ventasValidas());
    expect(v.granularidad).toBe("dia");
    expect(v.canales.online.ingresos).toBe(300);
    expect(v.serie[0].t).toBe("2026-11-13T00:00:00-04:00");
    expect(v.personas[0].nombre).toBe("Asesor 4");
    expect(v.estado.transito.monto).toBeNull();
  });

  it("convierte los numeric que PostgREST entrega como string", () => {
    const j = ventasValidas() as Record<string, any>;
    j.canales.online.ingresos = "1234.50";
    j.canales.online.ticket = "411.5";
    j.canales.tienda.envios = "7";
    j.serie[0].online = "99.90";
    j.top_repuestos[0].ingresos = "40.00";
    j.estado.transito.monto = "55.25";
    const v = parsePanelVentas(j);
    expect(v.canales.online.ingresos).toBe(1234.5);
    expect(v.canales.online.ticket).toBe(411.5);
    expect(v.canales.tienda.envios).toBe(7);
    expect(v.serie[0].online).toBe(99.9);
    expect(v.top_repuestos[0].ingresos).toBe(40);
    expect(v.estado.transito.monto).toBe(55.25);
  });

  it("respeta null: un ingreso sin calcular sigue siendo null, nunca 0", () => {
    const j = ventasValidas() as Record<string, any>;
    j.canales.online.ingresos = null;
    j.canales.online.ticket = null;
    const v = parsePanelVentas(j);
    expect(v.canales.online.ingresos).toBeNull();
    expect(v.canales.online.ticket).toBeNull();
  });

  it("lanza un error en español si la forma no calza", () => {
    expect(() => parsePanelVentas(null)).toThrow(/panel de ventas/i);
    expect(() => parsePanelVentas("hola")).toThrow(/panel de ventas/i);
    const sinCanales = ventasValidas() as Record<string, any>;
    delete sinCanales.canales;
    expect(() => parsePanelVentas(sinCanales)).toThrow(/canales/);
    const granularidadRara = { ...ventasValidas(), granularidad: "semana" };
    expect(() => parsePanelVentas(granularidadRara)).toThrow(/granularidad/);
  });

  // 13/11/2026: el contrato ganó `perfil_horario` (24 montos por hora de Caracas,
  // por canal y día). Alimenta la curva horaria de la proyección del Dashboard.
  it("lee el perfil horario: un elemento por día con 24 montos por canal", () => {
    const v = parsePanelVentas(ventasValidas());
    expect(v.perfil_horario).toHaveLength(1);
    expect(v.perfil_horario[0].dia).toBe("2026-11-13");
    expect(v.perfil_horario[0].online).toHaveLength(24);
    expect(v.perfil_horario[0].online[9]).toBe(100);
    expect(v.perfil_horario[0].tienda[10]).toBe(200);
  });

  it("perfil_horario vacío es válido (granularidad hora o mes)", () => {
    const j = { ...ventasValidas(), granularidad: "hora", perfil_horario: [] };
    expect(parsePanelVentas(j).perfil_horario).toEqual([]);
  });

  it("perfil_horario convierte los numeric en string y exige 24 valores", () => {
    const j = ventasValidas() as Record<string, any>;
    j.perfil_horario[0].online[9] = "100.50";
    expect(parsePanelVentas(j).perfil_horario[0].online[9]).toBe(100.5);

    const corto = ventasValidas() as Record<string, any>;
    corto.perfil_horario[0].tienda = [1, 2, 3];
    expect(() => parsePanelVentas(corto)).toThrow(/perfil_horario.*24/);

    const sinClave = ventasValidas() as Record<string, any>;
    delete sinClave.perfil_horario;
    expect(() => parsePanelVentas(sinClave)).toThrow(/perfil_horario/);
  });

  it("lanza si un número obligatorio no es número", () => {
    const j = ventasValidas() as Record<string, any>;
    j.canales.tienda.envios = "muchos";
    expect(() => parsePanelVentas(j)).toThrow(/envios/);
    const k = ventasValidas() as Record<string, any>;
    k.canales.tienda.envios = null;
    expect(() => parsePanelVentas(k)).toThrow(/envios/);
  });
});

describe("sumaCanales", () => {
  const base = parsePanelVentas(ventasValidas());

  it("el resumen suma online + tienda", () => {
    const r = sumaCanales(base);
    expect(r.ingresos).toBe(1000);
    expect(r.envios).toBe(10);
    expect(r.unidades).toBe(15);
    expect(r.estimados).toBe(1);
    expect(r.ticket).toBe(100);
  });

  it("si un canal tiene ingresos null, el resumen toma los del otro", () => {
    const v = parsePanelVentas({
      ...ventasValidas(),
      canales: { online: { ...canalVacio, ingresos: null, envios: 2, sin_monto: 2 }, tienda: { ...canalVacio, ingresos: 500, envios: 5, unidades: 5 } },
    });
    const r = sumaCanales(v);
    expect(r.ingresos).toBe(500);
    expect(r.envios).toBe(7);
    // envíos con monto = 7 − 2 sin monto = 5 → ticket 100
    expect(r.ticket).toBe(100);
    expect(r.sin_monto).toBe(2);
  });

  it("si los dos ingresos son null, el resumen es null (no 0) y sin ticket", () => {
    const v = parsePanelVentas({
      ...ventasValidas(),
      canales: { online: { ...canalVacio, ingresos: null, envios: 1, sin_monto: 1 }, tienda: { ...canalVacio, ingresos: null, envios: 1, sin_monto: 1 } },
    });
    const r = sumaCanales(v);
    expect(r.ingresos).toBeNull();
    expect(r.ticket).toBeNull();
  });

  it("el ticket del resumen NO promedia los tickets de cada canal", () => {
    const v = parsePanelVentas({
      ...ventasValidas(),
      canales: {
        online: { ...canalVacio, ingresos: 100, envios: 1, unidades: 1, ticket: 100 },
        tienda: { ...canalVacio, ingresos: 900, envios: 9, unidades: 9, ticket: 100 },
      },
    });
    expect(sumaCanales(v).ticket).toBe(100);
    const v2 = parsePanelVentas({
      ...ventasValidas(),
      canales: {
        online: { ...canalVacio, ingresos: 1000, envios: 1, unidades: 1, ticket: 1000 },
        tienda: { ...canalVacio, ingresos: 90, envios: 9, unidades: 9, ticket: 10 },
      },
    });
    // promedio de tickets sería 505; el correcto es 1090 / 10
    expect(sumaCanales(v2).ticket).toBe(109);
  });
});

const conversacionesValidas = () => ({
  embudo: { escribieron: 10, respondidas: 8, con_carrito: 4, compraron: 2 },
  resultados: { compraron: 2, reclamo: 1, carrito_sin_compra: 2, solo_preguntaron: 3, sin_respuesta: 2 },
  conversion: {
    equipo: { atendidas: 8, compraron: 2 },
    personas: [
      { agent_id: null, nombre: "Seba", rol: "ia", atendidas: 5, compraron: 1 },
      { agent_id: "11111111-1111-1111-1111-111111111111", nombre: "Asesor 1", rol: "agent", atendidas: 3, compraron: 1 },
    ],
  },
  calor: { valores: Array.from({ length: 7 }, () => new Array(24).fill(0)) },
});

describe("parsePanelConversaciones", () => {
  it("acepta la forma del contrato, con agent_id null para Seba", () => {
    const c = parsePanelConversaciones(conversacionesValidas());
    expect(c.embudo.escribieron).toBe(10);
    expect(c.conversion.personas[0].agent_id).toBeNull();
    expect(c.calor.valores).toHaveLength(7);
    expect(c.calor.valores[0]).toHaveLength(24);
  });

  it("convierte strings numéricos del calor y del embudo", () => {
    const j = conversacionesValidas() as Record<string, any>;
    j.embudo.escribieron = "10";
    j.calor.valores[2][5] = "3";
    const c = parsePanelConversaciones(j);
    expect(c.embudo.escribieron).toBe(10);
    expect(c.calor.valores[2][5]).toBe(3);
  });

  it("lanza si el calor no es de 7 × 24", () => {
    const j = conversacionesValidas() as Record<string, any>;
    j.calor.valores = [[1, 2, 3]];
    expect(() => parsePanelConversaciones(j)).toThrow(/calor/);
  });

  it("lanza si falta el embudo", () => {
    const j = conversacionesValidas() as Record<string, any>;
    delete j.embudo;
    expect(() => parsePanelConversaciones(j)).toThrow(/embudo/);
  });
});

const asesoresValidos = () => ({
  personas: [
    {
      agent_id: "11111111-1111-1111-1111-111111111111",
      nombre: "Asesor 4",
      rol: "agent",
      en_reparto: true,
      conversaciones: 12,
      mensajes: 80,
      contactos: 10,
      episodios: 9,
      primera_resp_mediana_min: 3.5,
      primera_resp_p90_min: 20,
      en_5min: 0.66,
      envios: 3,
      monto: 410.5,
      unidades: 7,
      envios_online: 2,
      envios_tienda: 1,
      reasignadas_desde: 0,
      ultimo_mensaje: "2026-11-13T15:00:00-04:00",
      actividad_hora: new Array(24).fill(0),
    },
  ],
  seba: { mensajes: 100, conversaciones: 30, ultimo: null },
  equipo: { episodios: 40, primera_resp_mediana_min: 4, en_5min: 0.7 },
});

describe("parsePanelAsesores", () => {
  it("acepta la forma del contrato", () => {
    const a = parsePanelAsesores(asesoresValidos());
    expect(a.personas[0].en_reparto).toBe(true);
    expect(a.personas[0].actividad_hora).toHaveLength(24);
    expect(a.seba.ultimo).toBeNull();
    expect(a.equipo.en_5min).toBe(0.7);
  });

  it("respeta los null de tiempos y monto, y convierte strings", () => {
    const j = asesoresValidos() as Record<string, any>;
    j.personas[0].primera_resp_mediana_min = null;
    j.personas[0].en_5min = null;
    j.personas[0].monto = "99.10";
    j.personas[0].mensajes = "81";
    const a = parsePanelAsesores(j);
    expect(a.personas[0].primera_resp_mediana_min).toBeNull();
    expect(a.personas[0].en_5min).toBeNull();
    expect(a.personas[0].monto).toBe(99.1);
    expect(a.personas[0].mensajes).toBe(81);
  });

  it("lanza si la actividad por hora no tiene 24 valores", () => {
    const j = asesoresValidos() as Record<string, any>;
    j.personas[0].actividad_hora = [1, 2];
    expect(() => parsePanelAsesores(j)).toThrow(/actividad_hora/);
  });

  it("lanza si no viene el bloque de Seba", () => {
    const j = asesoresValidos() as Record<string, any>;
    delete j.seba;
    expect(() => parsePanelAsesores(j)).toThrow(/seba/);
  });
});

const colaValida = () => ({
  corte_dias: 7,
  pendientes: 3,
  sin_dueno: 1,
  con_dueno: 2,
  abandonadas: 5,
  por_antiguedad: { menos_1h: 1, de_1_a_4h: 1, de_4_a_24h: 1, de_1_a_7d: 0 },
  mas_viejo: { conversation_id: "c1", desde: "2026-11-13T08:00:00-04:00", contacto: "Pedro", asesor: null },
  lista: [{ conversation_id: "c1", desde: "2026-11-13T08:00:00-04:00", contacto: "Pedro", asesor_id: null, asesor: null }],
});

describe("parsePanelCola", () => {
  it("acepta la forma del contrato", () => {
    const c = parsePanelCola(colaValida());
    expect(c.pendientes).toBe(3);
    expect(c.mas_viejo?.contacto).toBe("Pedro");
    expect(c.lista[0].asesor).toBeNull();
  });

  it("mas_viejo null cuando no hay pendientes", () => {
    const c = parsePanelCola({ ...colaValida(), pendientes: 0, mas_viejo: null, lista: [] });
    expect(c.mas_viejo).toBeNull();
    expect(c.lista).toEqual([]);
  });

  it("lanza si falta por_antiguedad", () => {
    const j = colaValida() as Record<string, any>;
    delete j.por_antiguedad;
    expect(() => parsePanelCola(j)).toThrow(/por_antiguedad/);
  });
});

const activasValidas = () => ({
  total: 1500.75,
  presupuestos: { monto: 1000, cantidad: 4, sin_precio: 1 },
  carritos: { monto: 500.75, cantidad: 2, sin_precio: 0 },
  por_canal: { online: { monto: 500.75, cantidad: 2 }, tienda: { monto: 1000, cantidad: 4 } },
  antiguedad: [
    { tramo: "24h", monto: 200, cantidad: 2 },
    { tramo: "3d", monto: null, cantidad: 1 },
  ],
  items: [
    { tipo: "presupuesto", id: "p1", canal: "tienda", responsable: "Asesor 4", cliente: "Pedro", monto: null, unidades: 3, desde: "2026-11-13T08:00:00-04:00" },
  ],
});

describe("parsePanelVentasActivas", () => {
  it("acepta la forma del contrato y respeta los null de monto", () => {
    const a = parsePanelVentasActivas(activasValidas());
    expect(a.total).toBe(1500.75);
    expect(a.antiguedad[1].monto).toBeNull();
    expect(a.items[0].monto).toBeNull();
    expect(a.items[0].tipo).toBe("presupuesto");
  });

  it("total null (todo sin precio) sigue siendo null", () => {
    const a = parsePanelVentasActivas({ ...activasValidas(), total: null });
    expect(a.total).toBeNull();
  });

  it("convierte numeric como string", () => {
    const j = activasValidas() as Record<string, any>;
    j.total = "1500.75";
    j.carritos.monto = "500.75";
    expect(parsePanelVentasActivas(j).total).toBe(1500.75);
  });

  it("lanza con un tipo de ítem desconocido", () => {
    const j = activasValidas() as Record<string, any>;
    j.items[0].tipo = "otra-cosa";
    expect(() => parsePanelVentasActivas(j)).toThrow(/tipo/);
  });
});

describe("parseMetasVenta", () => {
  it("lee las filas de metas y convierte el monto que llegue como string", () => {
    const metas = parseMetasVenta([
      { canal: "online", vigente_desde: "2026-01-01", monto_usd: "800.00" },
      { canal: "tienda", vigente_desde: "2026-01-01", monto_usd: 1000 },
    ]);
    expect(metas).toEqual([
      { canal: "online", vigente_desde: "2026-01-01", monto_usd: 800 },
      { canal: "tienda", vigente_desde: "2026-01-01", monto_usd: 1000 },
    ]);
  });

  it("lanza con un canal inválido o si no es una lista", () => {
    expect(() => parseMetasVenta([{ canal: "otro", vigente_desde: "2026-01-01", monto_usd: 1 }])).toThrow(/canal/);
    expect(() => parseMetasVenta({})).toThrow(/metas/i);
  });
});
