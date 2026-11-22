import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import {
  acumuladoPorHora,
  antiguedadTexto,
  cantidadPorVencer,
  desgloseActivas,
  ETIQUETA_EQUIPO,
  ETIQUETA_ORIGEN,
  ETIQUETA_VENTANA,
  ingresosPorMes,
  itemsDeVista,
  metaAcumuladaPorHora,
  origenesConFila,
  origenesDeVista,
  ORIGENES_DE_CANAL,
  proximaApertura,
  serieDeVista,
  textoVentana,
  variacion,
  ventanaDeHoy,
  ventanaEscribible,
} from "@/components/paneles/dashboard/calculos";
import {
  AHORA,
  AHORA_ACTIVAS,
  AHORA_DOMINGO,
  activas,
  activasComoHoy,
  activasConDesglose,
  ventas,
  ventasHoy,
} from "@/components/paneles/dashboard/dashboard-fixtures";
import { EQUIPOS_ACTIVA, ORIGENES_ACTIVA, VENTANAS_ACTIVA, type PanelVentasActivas } from "@/lib/paneles/parse";

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

describe("itemsDeVista", () => {
  it("filtra por canal y ordena del más viejo al más nuevo", () => {
    const desordenados = activas().items.slice().reverse();
    const lista = itemsDeVista(activas({ items: desordenados }), "tienda");
    expect(lista.map((i) => i.id)).toEqual(["p-viejo", "p-medio"]);
    expect(itemsDeVista(activas({ items: desordenados }), "resumen").map((i) => i.id)[0]).toBe("p-viejo");
  });
});

describe("origenesConFila", () => {
  it("en el resumen: carritos e Inventario siempre, presupuestos del chat solo si hay", () => {
    expect(origenesConFila(desgloseActivas(activasConDesglose(), "resumen"), "resumen")).toEqual([
      "carrito_chat",
      "presupuesto_chat",
      "presupuesto_inventario",
    ]);
    expect(origenesConFila(desgloseActivas(activasComoHoy(), "resumen"), "resumen")).toEqual([
      "carrito_chat",
      "presupuesto_inventario",
    ]);
  });
  it("en Online no entra el presupuesto de Inventario, y en Tienda solo ese", () => {
    expect(origenesConFila(desgloseActivas(activasConDesglose(), "online"), "online")).toEqual(["carrito_chat", "presupuesto_chat"]);
    expect(origenesConFila(desgloseActivas(activasConDesglose(), "tienda"), "tienda")).toEqual(["presupuesto_inventario"]);
  });
  it("sin desglose no hay filas", () => {
    expect(origenesConFila(desgloseActivas(activas(), "resumen"), "resumen")).toEqual([]);
  });
});

describe("ventanaEscribible", () => {
  it("suma abierta y por cerrar", () => {
    const pv = desgloseActivas(activasConDesglose(), "resumen").porVentana!;
    expect(ventanaEscribible(pv)).toEqual({ monto: 400, cantidad: 4 });
  });
  it("el monto es null solo si los dos lo son; si uno falta suma el otro", () => {
    const vacia = { monto: null, cantidad: 0 };
    expect(ventanaEscribible({ abierta: vacia, por_cerrar: vacia, cerrada: vacia, no_aplica: vacia })).toEqual({ monto: null, cantidad: 0 });
    expect(
      ventanaEscribible({ abierta: { monto: null, cantidad: 2 }, por_cerrar: { monto: 80.1, cantidad: 1 }, cerrada: vacia, no_aplica: vacia })
    ).toEqual({ monto: 80.1, cantidad: 3 });
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

describe("proximaApertura", () => {
  it("un domingo cerrado apunta al lunes con su fecha y su hora de apertura", () => {
    expect(proximaApertura(DEFAULT_BUSINESS_HOURS, AHORA_DOMINGO)).toEqual({
      dia: "2026-11-16",
      etiqueta: "el lunes",
      hora: "8:00 am",
    });
  });
  it("un viernes ya cerrado salta el fin de semana", () => {
    expect(proximaApertura(DEFAULT_BUSINESS_HOURS, AHORA)).toEqual({ dia: "2026-11-16", etiqueta: "el lunes", hora: "8:00 am" });
  });
  it("antes de abrir el mismo día, la próxima apertura es hoy", () => {
    const madrugada = new Date("2026-11-13T06:00:00-04:00");
    expect(proximaApertura(DEFAULT_BUSINESS_HOURS, madrugada)).toEqual({ dia: "2026-11-13", etiqueta: "hoy", hora: "8:00 am" });
  });
  it("con la tienda abierta ahora, o sin ningún día abierto, no hay próxima apertura: null", () => {
    expect(proximaApertura(DEFAULT_BUSINESS_HOURS, new Date("2026-11-13T10:00:00-04:00"))).toBeNull();
    const cerrada = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(proximaApertura(cerrada, AHORA_DOMINGO)).toBeNull();
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


// ---------------------------------------------------------------------------
// Ventas activas con desglose (22/11/2026)
// ---------------------------------------------------------------------------

describe("origenesDeVista", () => {
  it("el resumen usa los tres orígenes; un canal, solo los suyos", () => {
    expect(origenesDeVista("resumen")).toEqual(["carrito_chat", "presupuesto_chat", "presupuesto_inventario"]);
    expect(origenesDeVista("online")).toEqual(["carrito_chat", "presupuesto_chat"]);
    expect(origenesDeVista("tienda")).toEqual(["presupuesto_inventario"]);
    expect(ORIGENES_DE_CANAL.tienda).toEqual(["presupuesto_inventario"]);
  });
});

describe("etiquetas de ventas activas", () => {
  it("son los textos exactos que usa la interfaz", () => {
    expect(ETIQUETA_ORIGEN).toEqual({
      carrito_chat: "Carritos del chat",
      presupuesto_chat: "Presupuestos del chat",
      presupuesto_inventario: "Presupuestos de Inventario",
    });
    expect(ETIQUETA_EQUIPO).toEqual({ online: "Asesores online", tienda: "Tienda (caja)", sin_dato: "Sin dato" });
    expect(ETIQUETA_VENTANA).toEqual({ abierta: "Abierta", por_cerrar: "Por cerrar", cerrada: "Cerrada", no_aplica: "Sin chat" });
  });
});

describe("desgloseActivas con desglose", () => {
  it("resumen: total, orígenes, equipos y ventanas tal cual los trae la base, y lo que quedó fuera", () => {
    const d = desgloseActivas(activasConDesglose(), "resumen");
    expect(d.monto).toBe(700);
    expect(d.cantidad).toBe(7);
    expect(d.presupuestos).toEqual({ monto: 440, cantidad: 3 });
    expect(d.carritos).toEqual({ monto: 260, cantidad: 4 });
    expect(d.porOrigen).toEqual({
      carrito_chat: { monto: 260, cantidad: 4 },
      presupuesto_chat: { monto: 200, cantidad: 1 },
      presupuesto_inventario: { monto: 240, cantidad: 2 },
    });
    // El presupuesto de Inventario hecho por un asesor SÍ suma al equipo online del resumen.
    expect(d.porEquipo).toEqual({ online: { monto: 490, cantidad: 5 }, tienda: { monto: 150, cantidad: 1 }, sin_dato: { monto: 60, cantidad: 1 } });
    expect(d.porVentana?.por_cerrar).toEqual({ monto: 80, cantidad: 1 });
    expect(d.fuera).toBe(6);
  });

  it("Vista Online: canal ≠ equipo — el presupuesto de Inventario hecho por un asesor NO aparece (su canal es tienda)", () => {
    const d = desgloseActivas(activasConDesglose(), "online");
    expect(d.monto).toBe(460);
    expect(d.cantidad).toBe(5);
    expect(d.porOrigen?.presupuesto_inventario).toEqual({ monto: null, cantidad: 0 });
    expect(d.porOrigen?.carrito_chat).toEqual({ monto: 260, cantidad: 4 });
    expect(d.porOrigen?.presupuesto_chat).toEqual({ monto: 200, cantidad: 1 });
    // 200 (carritos) + 200 (presupuesto del chat); los 90 del presupuesto de Inventario quedan fuera.
    expect(d.porEquipo?.online).toEqual({ monto: 400, cantidad: 4 });
    expect(d.porEquipo?.tienda).toEqual({ monto: null, cantidad: 0 });
    expect(d.porEquipo?.sin_dato).toEqual({ monto: 60, cantidad: 1 });
    expect(d.porVentana?.abierta).toEqual({ monto: 320, cantidad: 3 });
    expect(d.porVentana?.no_aplica).toEqual({ monto: null, cantidad: 0 });
    expect(d.fuera).toBe(3);
    expect(d.presupuestos).toEqual({ monto: 200, cantidad: 1 });
    expect(d.carritos).toEqual({ monto: 260, cantidad: 4 });
  });

  it("Vista Tienda: solo presupuestos de Inventario, con su equipo y sin carritos", () => {
    const d = desgloseActivas(activasConDesglose(), "tienda");
    expect(d.monto).toBe(240);
    expect(d.cantidad).toBe(2);
    expect(d.porOrigen?.carrito_chat).toEqual({ monto: null, cantidad: 0 });
    expect(d.porOrigen?.presupuesto_inventario).toEqual({ monto: 240, cantidad: 2 });
    expect(d.porEquipo).toEqual({ online: { monto: 90, cantidad: 1 }, tienda: { monto: 150, cantidad: 1 }, sin_dato: { monto: null, cantidad: 0 } });
    expect(d.porVentana?.no_aplica).toEqual({ monto: 240, cantidad: 2 });
    expect(d.fuera).toBe(3);
    expect(d.presupuestos).toEqual({ monto: 240, cantidad: 2 });
    expect(d.carritos).toEqual({ monto: 0, cantidad: 0 });
  });

  it("al sumar celdas de equipo, null solo si TODAS son null; si no, suma las que tienen monto", () => {
    const dg = activasConDesglose().desglose!;
    const todasNull = activasConDesglose({
      desglose: {
        ...dg,
        por_origen_equipo: {
          ...dg.por_origen_equipo,
          carrito_chat: { ...dg.por_origen_equipo.carrito_chat, online: { monto: null, cantidad: 2 } },
          presupuesto_chat: { ...dg.por_origen_equipo.presupuesto_chat, online: { monto: null, cantidad: 1 } },
        },
      },
    });
    expect(desgloseActivas(todasNull, "online").porEquipo?.online).toEqual({ monto: null, cantidad: 3 });
    const mezcla = activasConDesglose({
      desglose: {
        ...dg,
        por_origen_equipo: {
          ...dg.por_origen_equipo,
          carrito_chat: { ...dg.por_origen_equipo.carrito_chat, online: { monto: null, cantidad: 2 } },
        },
      },
    });
    expect(desgloseActivas(mezcla, "online").porEquipo?.online).toEqual({ monto: 200, cantidad: 3 });
  });

  it("producción de hoy: todo en carritos del chat, tienda y sin dato en cero", () => {
    const d = desgloseActivas(activasComoHoy(), "resumen");
    expect(d.monto).toBe(260);
    expect(d.presupuestos).toEqual({ monto: null, cantidad: 0 });
    expect(d.porOrigen?.carrito_chat.cantidad).toBe(4);
    expect(d.porEquipo?.tienda).toEqual({ monto: null, cantidad: 0 });
    expect(d.porEquipo?.sin_dato).toEqual({ monto: null, cantidad: 0 });
    expect(d.fuera).toBe(5);
  });

  it("sin desglose (base vieja): el comportamiento de siempre y los campos nuevos en null", () => {
    for (const vista of ["resumen", "online", "tienda"] as const) {
      const d = desgloseActivas(activas(), vista);
      expect(d.porOrigen).toBeNull();
      expect(d.porEquipo).toBeNull();
      expect(d.porVentana).toBeNull();
      expect(d.fuera).toBeNull();
    }
    expect(desgloseActivas(activas(), "online").presupuestos).toEqual({ monto: 150, cantidad: 1 });
  });
});

describe("cantidadPorVencer", () => {
  it("resumen con desglose: lo del tramo de 24 a 48 h", () => {
    expect(cantidadPorVencer(activasConDesglose(), "resumen", AHORA_ACTIVAS)).toBe(2);
    expect(cantidadPorVencer(activasComoHoy(), "resumen", AHORA_ACTIVAS)).toBe(1);
  });
  it("en un canal, cuenta los ítems de la vista con más de 24 h", () => {
    expect(cantidadPorVencer(activasConDesglose(), "online", AHORA_ACTIVAS)).toBe(1);
    expect(cantidadPorVencer(activasConDesglose(), "tienda", AHORA_ACTIVAS)).toBe(1);
  });
  it("sin desglose, cuenta ítems con más de 24 h también en el resumen", () => {
    expect(cantidadPorVencer(activas(), "resumen", AHORA)).toBe(3);
    expect(cantidadPorVencer(activas(), "online", AHORA)).toBe(1);
  });
  it("un resumen con desglose pero sin el tramo 48h cuenta 0", () => {
    const a = activasConDesglose();
    const sin = activasConDesglose({ desglose: { ...a.desglose!, tramos_48h: a.desglose!.tramos_48h.filter((t) => t.tramo !== "48h") } });
    expect(cantidadPorVencer(sin, "resumen", AHORA_ACTIVAS)).toBe(0);
  });
});

describe("textoVentana", () => {
  const base = activasConDesglose().items[0];
  const item = (ventana: PanelVentasActivas["items"][number]["ventana"], horasRestantes: number | null) => ({
    ...base,
    ventana,
    ventana_hasta: horasRestantes === null ? null : new Date(AHORA_ACTIVAS.getTime() + horasRestantes * 3600_000).toISOString(),
  });
  it("abierta y por cerrar dicen las horas que quedan, hacia abajo", () => {
    expect(textoVentana(item("abierta", 10), AHORA_ACTIVAS)).toBe("quedan 10 h");
    expect(textoVentana(item("por_cerrar", 3 + 59 / 60), AHORA_ACTIVAS)).toBe("quedan 3 h");
    expect(textoVentana(item("por_cerrar", 1), AHORA_ACTIVAS)).toBe("quedan 1 h");
  });
  it("menos de una hora: «queda menos de 1 h»", () => {
    expect(textoVentana(item("por_cerrar", 59 / 60), AHORA_ACTIVAS)).toBe("queda menos de 1 h");
  });
  it("una ventana ya vencida que aún figura abierta (desfase de segundos) se lee igual", () => {
    expect(textoVentana(item("abierta", -0.01), AHORA_ACTIVAS)).toBe("queda menos de 1 h");
  });
  it("cerrada, sin chat y sin dato", () => {
    expect(textoVentana(item("cerrada", -6), AHORA_ACTIVAS)).toBe("Cerrada");
    expect(textoVentana(item("no_aplica", null), AHORA_ACTIVAS)).toBe("Sin chat");
    expect(textoVentana(item(null, null), AHORA_ACTIVAS)).toBe("—");
  });
  it("abierta sin `ventana_hasta` no inventa horas", () => {
    expect(textoVentana(item("abierta", null), AHORA_ACTIVAS)).toBe("—");
  });
});

/** Suma montos de celdas: null solo si todas lo son. */
function sumaCeldas(celdas: { monto: number | null; cantidad: number }[]) {
  const conMonto = celdas.filter((c) => c.monto !== null);
  return {
    monto: conMonto.length === 0 ? null : Math.round(conMonto.reduce((t, c) => t + (c.monto as number), 0) * 100) / 100,
    cantidad: celdas.reduce((t, c) => t + c.cantidad, 0),
  };
}

describe("coherencia de los fixtures con desglose", () => {
  for (const [nombre, fabrica] of [
    ["activasConDesglose", activasConDesglose],
    ["activasComoHoy", activasComoHoy],
  ] as const) {
    describe(nombre, () => {
      const a = fabrica();
      const d = a.desglose!;
      const celda = (filtro: (i: PanelVentasActivas["items"][number]) => boolean) => sumaCeldas(a.items.filter(filtro).map((i) => ({ monto: i.monto, cantidad: 1 })));

      it("los totales y el reparto presupuestos/carritos cuadran con los ítems", () => {
        expect(celda(() => true)).toEqual({ monto: a.total, cantidad: a.presupuestos.cantidad + a.carritos.cantidad });
        expect(celda((i) => i.tipo === "presupuesto")).toEqual({ monto: a.presupuestos.monto, cantidad: a.presupuestos.cantidad });
        expect(celda((i) => i.tipo === "carrito")).toEqual({ monto: a.carritos.monto, cantidad: a.carritos.cantidad });
        expect(a.items.filter((i) => i.tipo === "carrito" && i.monto === null).length).toBe(a.carritos.sin_precio);
      });

      it("por canal, origen, equipo y ventana cuadran con los ítems", () => {
        expect(celda((i) => i.canal === "online")).toEqual(a.por_canal.online);
        expect(celda((i) => i.canal === "tienda")).toEqual(a.por_canal.tienda);
        for (const o of ORIGENES_ACTIVA) {
          const { monto, cantidad } = d.por_origen[o];
          expect(celda((i) => i.origen === o), o).toEqual({ monto, cantidad });
          for (const e of EQUIPOS_ACTIVA) {
            expect(celda((i) => i.origen === o && i.equipo === e), `${o}/${e}`).toEqual(d.por_origen_equipo[o][e]);
          }
        }
        for (const e of EQUIPOS_ACTIVA) {
          expect(celda((i) => i.equipo === e), e).toEqual(d.por_equipo[e]);
          expect(sumaCeldas(ORIGENES_ACTIVA.map((o) => d.por_origen_equipo[o][e])), `matriz ${e}`).toEqual(d.por_equipo[e]);
        }
        for (const v of VENTANAS_ACTIVA) {
          expect(celda((i) => i.ventana === v), v).toEqual(d.por_ventana[v]);
          for (const canal of ["online", "tienda"] as const) {
            expect(celda((i) => i.ventana === v && i.canal === canal), `${canal}/${v}`).toEqual(d.por_canal_ventana[canal][v]);
          }
        }
        expect(ORIGENES_ACTIVA.reduce((t, o) => t + d.por_origen[o].sin_precio, 0)).toBe(a.carritos.sin_precio + a.presupuestos.sin_precio);
      });

      it("los tramos de 48 h cuadran con la edad de cada ítem y suman el total", () => {
        const horas = (i: PanelVentasActivas["items"][number]) => (AHORA_ACTIVAS.getTime() - new Date(i.desde).getTime()) / 3600_000;
        const tramo = (t: "12h" | "24h" | "48h") => d.tramos_48h.find((x) => x.tramo === t)!;
        expect(celda((i) => horas(i) <= 12)).toEqual({ monto: tramo("12h").monto, cantidad: tramo("12h").cantidad });
        expect(celda((i) => horas(i) > 12 && horas(i) <= 24)).toEqual({ monto: tramo("24h").monto, cantidad: tramo("24h").cantidad });
        expect(celda((i) => horas(i) > 24 && horas(i) <= 48)).toEqual({ monto: tramo("48h").monto, cantidad: tramo("48h").cantidad });
        expect(sumaCeldas(d.tramos_48h)).toEqual({ monto: a.total, cantidad: a.items.length });
      });

      it("lo que quedó fuera de la ventana cuadra consigo mismo", () => {
        const f = d.fuera_de_ventana;
        expect(f.carritos).toBe(f.por_origen.carrito_chat);
        expect(f.presupuestos).toBe(f.por_origen.presupuesto_chat + f.por_origen.presupuesto_inventario);
      });

      it("los ítems traen todos los campos nuevos y vienen del más viejo al más nuevo", () => {
        for (const i of a.items) {
          expect(i.origen && i.equipo && i.ventana).toBeTruthy();
          expect(i.canal).toBe(i.origen === "presupuesto_inventario" ? "tienda" : "online");
        }
        const desde = a.items.map((i) => new Date(i.desde).getTime());
        expect(desde).toEqual([...desde].sort((x, y) => x - y));
      });
    });
  }

  it("activasConDesglose trae el caso que distingue canal de equipo, un ítem sin monto y uno de más de 24 h", () => {
    const a = activasConDesglose();
    expect(a.items.some((i) => i.origen === "presupuesto_inventario" && i.equipo === "online")).toBe(true);
    expect(a.items.some((i) => i.origen === "presupuesto_inventario" && i.equipo === "tienda")).toBe(true);
    expect(a.items.some((i) => i.monto === null)).toBe(true);
    expect(a.items.some((i) => i.tipo === "presupuesto" && i.ventana === "no_aplica")).toBe(true);
    expect(a.items.some((i) => AHORA_ACTIVAS.getTime() - new Date(i.desde).getTime() > 24 * 3600_000)).toBe(true);
    expect(a.desglose!.fuera_de_ventana.carritos + a.desglose!.fuera_de_ventana.presupuestos).toBeGreaterThan(0);
  });
});
