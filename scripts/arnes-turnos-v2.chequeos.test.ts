import { describe, expect, it } from "vitest";
import type { RegistroDeMemoria } from "@/lib/seba2/effects-memoria";
import type { EstadoSeba, MensajeDeTurno, ResumenDeTurno } from "@/lib/seba2/tipos";
import type { CasoArnes } from "./arnes-turnos-v2.caso";
import {
  CHEQUEOS,
  NOMBRES_DE_CHEQUEOS,
  type EntradaDeChequeo,
  type ResultadoDeCaso,
  chequeosDeCasoFallido,
  comprobanteConPase,
  correrChequeos,
  costoEstimado,
  datosDePagoCorrectos,
  evaluarPuertas,
  maximoTresMensajes,
  mediana,
  mismaCategoria,
  noPasoCuandoNoDebia,
  pasoCuandoDebia,
  productoValido,
  reporteMarkdown,
  resumirCorrida,
  sinCifraSinFuente,
  sinFrasesProhibidas,
  sinGuardasDisparadas,
} from "./arnes-turnos-v2.chequeos";

// ------------------------------- fixtures -----------------------------------

const COMPROBANTE = {
  tipo: "comprobante_pago" as const,
  es_comprobante_pago: true,
  texto_visible: "",
  producto_visible: null,
  marca_visible: null,
  modelo_moto_visible: null,
  medida_visible: null,
  comprobante: null,
  orden_cashea: null,
};

function caso(over: Partial<CasoArnes> = {}, esperado: CasoArnes["esperado"] = {}): CasoArnes {
  return { id: "c1", fuente: "saint", historial: [], rafaga: ["hola"], estado: null, ...over, esperado };
}

function mensaje(texto: string, origen: MensajeDeTurno["origen"] = "modelo", orden = 1): MensajeDeTurno {
  return { orden, tipo: "texto", texto, origen };
}

function estado(etapa: EstadoSeba["etapa"]): EstadoSeba {
  return {
    etapa,
    lineas: [],
    forma: null,
    entrega: null,
    ciudad: null,
    totalUsd: null,
    totalBs: null,
    priceKind: null,
    complementoSugerido: false,
    ultimaFraseApertura: null,
    actualizadoEn: "2026-11-17T15:00:00.000Z",
  };
}

function resumen(over: Partial<ResumenDeTurno> = {}): ResumenDeTurno {
  return {
    accion: "answered",
    resumen: "ok",
    rafaga: ["hola"],
    triggerMessageId: null,
    estadoAntes: null,
    estadoDespues: estado("entender"),
    herramientas: [],
    productos: [],
    guardas: [],
    contexto: { iaGlobal: true, asesorAsignado: false, asesorEscribioHaceMin: null },
    tokens: { input: 1000, output: 200, cachedInput: 0, reasoning: 0 },
    modelo: "openai/modelo-de-prueba",
    duracionMs: 2000,
    ...over,
  };
}

function registro(over: Partial<RegistroDeMemoria> = {}): RegistroDeMemoria {
  return {
    mensajes: [],
    escribiendo: 0,
    pases: [],
    silencios: [],
    notas: [],
    carrito: null,
    estado: null,
    bienvenidasReclamadas: 0,
    vistos: [],
    consultasDeMensajeNuevo: [],
    esperaPersona: false,
    cierre: null,
    secuencia: [],
    ...over,
  };
}

function entrada(over: Partial<EntradaDeChequeo> = {}): EntradaDeChequeo {
  return { caso: caso(), resumen: resumen(), registro: registro(), productos: {}, ...over };
}

const PRODUCTOS = {
  p1: { saintCode: "A-001", nombre: "ACEITE MOTUL 20W50 4T" },
  p2: { saintCode: "B-777", nombre: "ACEITE INCA 20W50" },
  p3: { saintCode: "C-123", nombre: "CASCO LS2 NEGRO" },
};

// ------------------------------- chequeos -----------------------------------

describe("producto_valido", () => {
  const e = (productos: string[], validos?: string[]) =>
    entrada({ caso: caso({}, { productosValidos: validos }), resumen: resumen({ productos }), productos: PRODUCTOS });

  it("pasa si algún producto cotizado tiene un saint_code de la lista", () => {
    const r = productoValido(e(["p3", "p1"], ["A-001", "Z-999"]));
    expect(r).toMatchObject({ nombre: "producto_valido", aplica: true, ok: true });
    expect(r.detalle).toContain("A-001");
  });

  it("falla si ninguno lo es, nombrando lo que cotizó", () => {
    const r = productoValido(e(["p3"], ["A-001"]));
    expect(r).toMatchObject({ aplica: true, ok: false });
    expect(r.detalle).toContain("C-123");
  });

  it("no aplica sin productosValidos, con la lista vacía o si el turno no cotizó nada", () => {
    expect(productoValido(e(["p1"], undefined)).aplica).toBe(false);
    expect(productoValido(e(["p1"], [])).aplica).toBe(false);
    expect(productoValido(e([], ["A-001"])).aplica).toBe(false);
  });

  it("un producto sin saint_code no cuenta como válido", () => {
    const r = productoValido(
      entrada({
        caso: caso({}, { productosValidos: ["A-001"] }),
        resumen: resumen({ productos: ["x"] }),
        productos: { x: { saintCode: null, nombre: "ASIENTO" } },
      })
    );
    expect(r.ok).toBe(false);
  });
});

describe("misma_categoria", () => {
  const e = (productos: string[], categoria?: string) =>
    entrada({ caso: caso({}, { categoria }), resumen: resumen({ productos }), productos: PRODUCTOS });

  it("pasa si TODOS los cotizados empiezan con la palabra, sin tildes ni mayúsculas", () => {
    expect(mismaCategoria(e(["p1", "p2"], "aceite"))).toMatchObject({ aplica: true, ok: true });
    expect(mismaCategoria(e(["p1"], "ÁCEITE")).ok).toBe(true);
  });

  it("falla si alguno no empieza con ella", () => {
    const r = mismaCategoria(e(["p1", "p3"], "aceite"));
    expect(r).toMatchObject({ aplica: true, ok: false });
    expect(r.detalle).toContain("CASCO LS2 NEGRO");
  });

  it("una palabra que aparece en el medio del nombre no cuenta", () => {
    expect(mismaCategoria(e(["p3"], "negro")).ok).toBe(false);
  });

  it("no aplica sin categoría o sin cotización", () => {
    expect(mismaCategoria(e(["p1"], undefined)).aplica).toBe(false);
    expect(mismaCategoria(e([], "aceite")).aplica).toBe(false);
  });

  it("un producto que no se pudo leer de la base falla (no se puede afirmar nada de él)", () => {
    const r = mismaCategoria(entrada({ caso: caso({}, { categoria: "aceite" }), resumen: resumen({ productos: ["fantasma"] }) }));
    expect(r.ok).toBe(false);
  });
});

describe("sin_cifra_sin_fuente", () => {
  it("pasa si la cifra del modelo está en un mensaje de una herramienta", () => {
    const r = sinCifraSinFuente(
      entrada({
        registro: registro({ mensajes: [mensaje("ACEITE MOTUL — $12,50 BCV", "herramienta", 1), mensaje("Son $12,50, ¿te lo aparto?", "modelo", 2)] }),
      })
    );
    expect(r).toMatchObject({ aplica: true, ok: true });
  });

  it("pasa si la cifra viene de un texto fijo o de la ráfaga del cliente", () => {
    const delFijo = sinCifraSinFuente(
      entrada({ registro: registro({ mensajes: [mensaje("envío desde $5", "fijo", 1), mensaje("El envío sale desde $5", "modelo", 2)] }) })
    );
    expect(delFijo.ok).toBe(true);
    const delCliente = sinCifraSinFuente(
      entrada({
        caso: caso({ rafaga: ["tienen el de 44$?"] }),
        resumen: resumen({ rafaga: ["tienen el de 44$?"] }),
        registro: registro({ mensajes: [mensaje("Sí, el de $44 lo tenemos", "modelo")] }),
      })
    );
    expect(delCliente.ok).toBe(true);
  });

  it("falla si el modelo escribe una cifra de dinero que ninguna fuente tiene", () => {
    const r = sinCifraSinFuente(
      entrada({ registro: registro({ mensajes: [mensaje("ACEITE — $12,50 BCV", "herramienta", 1), mensaje("Te sale en $99,90", "modelo", 2)] }) })
    );
    expect(r).toMatchObject({ aplica: true, ok: false });
    expect(r.detalle).toContain("99");
    expect(r.detalle).toContain("mensaje 2");
  });

  it("una cifra en un mensaje de origen herramienta NO se revisa (solo el modelo)", () => {
    const r = sinCifraSinFuente(entrada({ registro: registro({ mensajes: [mensaje("Total: $99,90", "herramienta"), mensaje("Listo", "modelo", 2)] }) }));
    expect(r.ok).toBe(true);
  });

  it("no aplica si ningún mensaje lo redactó el modelo", () => {
    expect(sinCifraSinFuente(entrada({ registro: registro({ mensajes: [mensaje("hola", "fijo")] }) })).aplica).toBe(false);
    expect(sinCifraSinFuente(entrada()).aplica).toBe(false);
  });
});

describe("paso_cuando_debia / no_paso_cuando_no_debia", () => {
  const paso = (area: "ventas" | "pagos" | "reclamos", motivo: "otro" | "pide_persona" | "comprobante_pago" | "garantia") => ({
    area,
    motivo,
    nota: "n",
  });

  it("paso_cuando_debia: pasa con el área (y el motivo, si se indicó)", () => {
    const base = caso({}, { debePasar: { area: "ventas", motivo: "pide_persona" } });
    expect(pasoCuandoDebia(entrada({ caso: base, registro: registro({ pases: [paso("ventas", "pide_persona")] }) }))).toMatchObject({
      aplica: true,
      ok: true,
    });
    const soloArea = caso({}, { debePasar: { area: "ventas" } });
    expect(pasoCuandoDebia(entrada({ caso: soloArea, registro: registro({ pases: [paso("ventas", "otro")] }) })).ok).toBe(true);
  });

  it("paso_cuando_debia: falla sin pase, con otra área o con otro motivo", () => {
    const base = caso({}, { debePasar: { area: "ventas", motivo: "pide_persona" } });
    expect(pasoCuandoDebia(entrada({ caso: base })).ok).toBe(false);
    expect(pasoCuandoDebia(entrada({ caso: base, registro: registro({ pases: [paso("reclamos", "garantia")] }) })).ok).toBe(false);
    const r = pasoCuandoDebia(entrada({ caso: base, registro: registro({ pases: [paso("ventas", "otro")] }) }));
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("pide_persona");
  });

  it("paso_cuando_debia: no aplica con debePasar null o ausente", () => {
    expect(pasoCuandoDebia(entrada({ caso: caso({}, { debePasar: null }) })).aplica).toBe(false);
    expect(pasoCuandoDebia(entrada()).aplica).toBe(false);
  });

  it("no_paso_cuando_no_debia: pasa sin pase, falla con él, no aplica sin la bandera", () => {
    const base = caso({}, { noDebePasar: true });
    expect(noPasoCuandoNoDebia(entrada({ caso: base }))).toMatchObject({ aplica: true, ok: true });
    const r = noPasoCuandoNoDebia(entrada({ caso: base, registro: registro({ pases: [paso("ventas", "otro")] }) }));
    expect(r).toMatchObject({ aplica: true, ok: false });
    expect(r.detalle).toContain("ventas");
    expect(noPasoCuandoNoDebia(entrada({ caso: caso({}, { noDebePasar: false }) })).aplica).toBe(false);
    expect(noPasoCuandoNoDebia(entrada()).aplica).toBe(false);
  });
});

describe("datos_de_pago_correctos", () => {
  const base = caso({}, { debeEntregarDatosDePago: true });

  it("pasa con un mensaje de herramienta que trae «Total» y el estado en datos_enviados", () => {
    const r = datosDePagoCorrectos(
      entrada({
        caso: base,
        registro: registro({ mensajes: [mensaje("Pago móvil…\nTotal: $20,00", "herramienta")] }),
        resumen: resumen({ estadoDespues: estado("datos_enviados") }),
      })
    );
    expect(r).toMatchObject({ aplica: true, ok: true });
  });

  it("falla si el «Total» lo escribió el modelo, o si el estado no quedó en datos_enviados", () => {
    const delModelo = datosDePagoCorrectos(
      entrada({
        caso: base,
        registro: registro({ mensajes: [mensaje("Total: $20,00", "modelo")] }),
        resumen: resumen({ estadoDespues: estado("datos_enviados") }),
      })
    );
    expect(delModelo.ok).toBe(false);
    const sinEtapa = datosDePagoCorrectos(
      entrada({ caso: base, registro: registro({ mensajes: [mensaje("Total: $20,00", "herramienta")] }), resumen: resumen({ estadoDespues: estado("cotizado") }) })
    );
    expect(sinEtapa.ok).toBe(false);
    expect(sinEtapa.detalle).toContain("cotizado");
    expect(datosDePagoCorrectos(entrada({ caso: base, resumen: resumen({ estadoDespues: null }) })).ok).toBe(false);
  });

  it("no aplica sin la bandera", () => {
    expect(datosDePagoCorrectos(entrada()).aplica).toBe(false);
    expect(datosDePagoCorrectos(entrada({ caso: caso({}, { debeEntregarDatosDePago: false }) })).aplica).toBe(false);
  });
});

describe("sin_frases_prohibidas", () => {
  it("pasa sin frases prohibidas, también sin mensajes", () => {
    expect(sinFrasesProhibidas(entrada({ registro: registro({ mensajes: [mensaje("¡Hola! ¿En qué te ayudo?")] }) }))).toMatchObject({ aplica: true, ok: true });
    expect(sinFrasesProhibidas(entrada()).ok).toBe(true);
  });

  it("falla con una de la lista fija, sin tildes ni mayúsculas", () => {
    const r = sinFrasesProhibidas(entrada({ registro: registro({ mensajes: [mensaje("Soy un Asistente Virtual de SBK")] }) }));
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("asistente virtual");
    expect(sinFrasesProhibidas(entrada({ registro: registro({ mensajes: [mensaje("Es una INTELIGENCIA ARTIFICIAL")] }) })).ok).toBe(false);
    expect(sinFrasesProhibidas(entrada({ registro: registro({ mensajes: [mensaje("Gracias por tu compra")] }) })).ok).toBe(false);
    expect(sinFrasesProhibidas(entrada({ registro: registro({ mensajes: [mensaje("Hola, soy Seba")] }) })).ok).toBe(false);
  });

  it("falla con una frase del caso (sin tildes ni mayúsculas), sea cual sea el origen del mensaje", () => {
    const c = caso({}, { frasesProhibidas: ["Pago Móvil"] });
    const r = sinFrasesProhibidas(entrada({ caso: c, registro: registro({ mensajes: [mensaje("Paga por pago movil", "fijo")] }) }));
    expect(r.ok).toBe(false);
  });
});

describe("maximo_tres_mensajes", () => {
  it("pasa con 0 a 3 y falla con 4", () => {
    const con = (n: number) => entrada({ registro: registro({ mensajes: Array.from({ length: n }, (_, i) => mensaje(`m${i}`, "fijo", i + 1)) }) });
    expect(maximoTresMensajes(con(0)).ok).toBe(true);
    expect(maximoTresMensajes(con(3)).ok).toBe(true);
    const r = maximoTresMensajes(con(4));
    expect(r).toMatchObject({ aplica: true, ok: false });
    expect(r.detalle).toContain("4");
  });
});

describe("sin_guardas_disparadas", () => {
  it("pasa sin guardas y falla con cualquiera, aunque la reescritura haya salido bien", () => {
    expect(sinGuardasDisparadas(entrada())).toMatchObject({ aplica: true, ok: true });
    const r = sinGuardasDisparadas(entrada({ resumen: resumen({ guardas: [{ guarda: "identidad", fragmento: "soy un bot" }] }) }));
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("identidad");
  });
});

describe("comprobante_con_pase", () => {
  const conComprobante = caso({ rafagaLecturas: [COMPROBANTE] });

  it("pasa si hubo un pase a pagos", () => {
    const r = comprobanteConPase(
      entrada({ caso: conComprobante, registro: registro({ pases: [{ area: "pagos", motivo: "comprobante_pago", nota: "n" }] }) })
    );
    expect(r).toMatchObject({ aplica: true, ok: true });
  });

  it("falla sin pase, o con un pase a otra área", () => {
    expect(comprobanteConPase(entrada({ caso: conComprobante })).ok).toBe(false);
    const r = comprobanteConPase(
      entrada({ caso: conComprobante, registro: registro({ pases: [{ area: "ventas", motivo: "otro", nota: "n" }] }) })
    );
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("ventas");
  });

  it("una orden de Cashea también cuenta como comprobante", () => {
    const orden = caso({ rafagaLecturas: [{ ...COMPROBANTE, tipo: "orden_cashea", es_comprobante_pago: false }] });
    expect(comprobanteConPase(entrada({ caso: orden })).aplica).toBe(true);
  });

  it("no aplica si la ráfaga no trae comprobante (una foto de un repuesto no lo es)", () => {
    expect(comprobanteConPase(entrada()).aplica).toBe(false);
    const repuesto = caso({ rafagaLecturas: [{ ...COMPROBANTE, tipo: "repuesto", es_comprobante_pago: false }] });
    expect(comprobanteConPase(entrada({ caso: repuesto })).aplica).toBe(false);
  });
});

describe("correrChequeos / chequeosDeCasoFallido", () => {
  it("correrChequeos corre los diez, en el orden de NOMBRES_DE_CHEQUEOS", () => {
    expect(CHEQUEOS).toHaveLength(10);
    expect(correrChequeos(entrada()).map((r) => r.nombre)).toEqual([...NOMBRES_DE_CHEQUEOS]);
  });

  it("un caso que lanzó falla en TODOS los chequeos, con el error en el detalle", () => {
    const r = chequeosDeCasoFallido("se acabó el tiempo");
    expect(r.map((x) => x.nombre)).toEqual([...NOMBRES_DE_CHEQUEOS]);
    expect(r.every((x) => x.aplica && !x.ok && x.detalle.includes("se acabó el tiempo"))).toBe(true);
  });
});

// ------------------------------- resúmenes ----------------------------------

function resultado(id: string, fuente: ResultadoDeCaso["fuente"], chequeos: [string, "ok" | "falla" | "na"][], over: Partial<ResultadoDeCaso> = {}): ResultadoDeCaso {
  return {
    id,
    fuente,
    chequeos: chequeos.map(([nombre, v]) => ({ nombre, aplica: v !== "na", ok: v !== "falla", detalle: `${nombre}:${v}` })),
    borrador: null,
    error: null,
    ...over,
  };
}

describe("resumirCorrida", () => {
  it("cuenta aplica, ok y fallos por chequeo y por fuente, ignorando lo que no aplica", () => {
    const resumenDeCorrida = resumirCorrida([
      resultado("a", "saint", [["producto_valido", "ok"], ["sin_cifra_sin_fuente", "na"]]),
      resultado("b", "saint", [["producto_valido", "falla"], ["sin_cifra_sin_fuente", "ok"]]),
      resultado("c", "borde", [["producto_valido", "na"], ["sin_cifra_sin_fuente", "ok"]]),
    ]);
    expect(resumenDeCorrida.totalCasos).toBe(3);
    expect(resumenDeCorrida.casosFallidos).toBe(1);
    expect(resumenDeCorrida.porChequeo.producto_valido).toEqual({ aplica: 2, ok: 1, fallos: 1 });
    expect(resumenDeCorrida.porChequeo.sin_cifra_sin_fuente).toEqual({ aplica: 2, ok: 2, fallos: 0 });
    expect(resumenDeCorrida.porFuente.saint.producto_valido).toEqual({ aplica: 2, ok: 1, fallos: 1 });
    expect(resumenDeCorrida.porFuente.borde.producto_valido).toBeUndefined();
    expect(resumenDeCorrida.porFuente.borde.sin_cifra_sin_fuente).toEqual({ aplica: 1, ok: 1, fallos: 0 });
  });

  it("una corrida vacía no revienta", () => {
    expect(resumirCorrida([])).toEqual({ totalCasos: 0, casosFallidos: 0, porChequeo: {}, porFuente: {} });
  });
});

describe("evaluarPuertas", () => {
  /** n casos `saint`: `buenos` con producto_valido ok y el resto fallido. */
  function saint(n: number, buenos: number): ResultadoDeCaso[] {
    return Array.from({ length: n }, (_, i) => resultado(`s${i}`, "saint", [["producto_valido", i < buenos ? "ok" : "falla"], ["misma_categoria", "ok"]]));
  }

  it("94 % de producto_valido en los casos saint falla; 95 % pasa", () => {
    const en94 = evaluarPuertas(resumirCorrida(saint(100, 94)));
    expect(en94.ok).toBe(false);
    expect(en94.fallas).toHaveLength(1);
    expect(en94.fallas[0]).toContain("94.0 %");
    expect(evaluarPuertas(resumirCorrida(saint(100, 95)))).toMatchObject({ ok: true, fallas: [] });
  });

  it("un solo fallo de misma_categoria en un caso saint cierra la puerta", () => {
    const resultados = [...saint(20, 20), resultado("x", "saint", [["misma_categoria", "falla"]])];
    const r = evaluarPuertas(resumirCorrida(resultados));
    expect(r.ok).toBe(false);
    expect(r.fallas.join(" ")).toContain("misma_categoria");
  });

  it("un fallo de misma_categoria en un caso que NO es saint no cuenta para la puerta (a)", () => {
    const r = evaluarPuertas(resumirCorrida([...saint(20, 20), resultado("x", "ejemplar", [["misma_categoria", "falla"]])]));
    expect(r.ok).toBe(true);
  });

  it("un fallo de sin_cifra_sin_fuente falla, de cualquier fuente", () => {
    const r = evaluarPuertas(resumirCorrida([resultado("x", "ejemplar", [["sin_cifra_sin_fuente", "falla"]])]));
    expect(r.ok).toBe(false);
    expect(r.fallas[0]).toContain("(b)");
  });

  it("un comprobante sin pase falla, de cualquier fuente", () => {
    const r = evaluarPuertas(resumirCorrida([resultado("x", "regresion", [["comprobante_con_pase", "falla"]])]));
    expect(r.ok).toBe(false);
    expect(r.fallas[0]).toContain("(c)");
  });

  it("una corrida limpia abre la puerta; lo que ningún caso ejercita sale como aviso, no como falla", () => {
    const sinSaint = evaluarPuertas(resumirCorrida([resultado("x", "ejemplar", [["sin_cifra_sin_fuente", "ok"], ["comprobante_con_pase", "ok"]])]));
    expect(sinSaint).toMatchObject({ ok: true, fallas: [] });
    expect(sinSaint.avisos).toHaveLength(1);
    expect(sinSaint.avisos[0]).toContain("saint");

    const vacia = evaluarPuertas(resumirCorrida([]));
    expect(vacia.ok).toBe(true);
    expect(vacia.avisos).toHaveLength(2);
  });

  it("un caso saint que lanzó cierra las puertas (falla en todos sus chequeos)", () => {
    const lanzo = { id: "l", fuente: "saint" as const, chequeos: chequeosDeCasoFallido("boom"), borrador: null, error: "boom" };
    expect(evaluarPuertas(resumirCorrida([lanzo])).ok).toBe(false);
  });
});

describe("costoEstimado y mediana", () => {
  it("costo = tokens × tarifa por millón; sin tarifa o sin tokens, null", () => {
    const tokens = { input: 1_000_000, output: 500_000, cachedInput: 0, reasoning: 0 };
    expect(costoEstimado(tokens, { inputPorMillon: 2, outputPorMillon: 10 })).toBeCloseTo(7);
    expect(costoEstimado(tokens, null)).toBeNull();
    expect(costoEstimado(null, { inputPorMillon: 2, outputPorMillon: 10 })).toBeNull();
  });

  it("mediana de impares, pares, con NaN y vacía", () => {
    expect(mediana([3, 1, 2])).toBe(2);
    expect(mediana([4, 1, 2, 3])).toBe(2.5);
    expect(mediana([1, Number.NaN, 3])).toBe(2);
    expect(mediana([])).toBeNull();
    expect(mediana([Number.NaN])).toBeNull();
  });
});

describe("reporteMarkdown", () => {
  const fallido: ResultadoDeCaso = {
    id: "caso-con-pipe|raro",
    fuente: "saint",
    chequeos: [
      { nombre: "producto_valido", aplica: true, ok: false, detalle: "cotizó C-123; se esperaba A-001" },
      { nombre: "sin_guardas_disparadas", aplica: true, ok: true, detalle: "ninguna guarda disparada" },
    ],
    borrador: {
      accion: "escalated",
      resumen: "Pasó el caso a ventas (otro).",
      mensajes: [mensaje("CASCO LS2 NEGRO — $30,00", "herramienta", 1), mensaje("¿Te lo aparto?\nSi quieres.", "modelo", 2)],
      pases: [{ area: "ventas", motivo: "otro" }],
      guardas: [{ guarda: "identidad", fragmento: "soy un bot" }],
      tokens: { input: 2_000_000, output: 100_000, cachedInput: 0, reasoning: 0 },
      modelo: "openai/modelo-de-prueba",
      duracionMs: 3000,
    },
    error: null,
  };
  const bueno = resultado("caso-ok", "ejemplar", [["sin_cifra_sin_fuente", "ok"]], {
    borrador: { ...fallido.borrador!, mensajes: [], pases: [], guardas: [], tokens: null, duracionMs: 1000 },
  });

  it("incluye tasas por chequeo y por fuente, los casos fallidos con su borrador, costo y mediana", () => {
    const md = reporteMarkdown({
      fecha: "2026-11-17",
      archivos: ["ejemplo.sintetico.jsonl"],
      resultados: [fallido, bueno],
      tarifa: { inputPorMillon: 1, outputPorMillon: 4 },
      intentosDeEscritura: 0,
    });
    expect(md).toContain("# Arnés de turnos de Seba v2 — 2026-11-17");
    expect(md).toContain("## Tasas por chequeo");
    expect(md).toContain("| producto_valido | 1 | 0 | 1 | 0.0 % |");
    expect(md).toContain("### saint (1 caso(s))");
    expect(md).toContain("### ejemplar (1 caso(s))");
    expect(md).toContain("### caso-con-pipe\\|raro (saint)");
    expect(md).toContain("✗ producto_valido: cotizó C-123; se esperaba A-001");
    expect(md).toContain("Mensaje 1 [herramienta]: CASCO LS2 NEGRO — $30,00");
    expect(md).toContain("Mensaje 2 [modelo]: ¿Te lo aparto? ⏎ Si quieres.");
    expect(md).toContain("Pase: ventas (otro)");
    expect(md).toContain("identidad «soy un bot»");
    expect(md).toContain("Costo estimado: USD 2.4000");
    expect(md).toContain("Mediana de duración por caso: 2.0 s");
    expect(md).toContain("Intentos de escritura: 0");
    expect(md).toContain("CERRADA");
    // El caso bueno no aparece entre los fallidos.
    expect(md).not.toContain("### caso-ok");
  });

  it("sin tarifa conocida dice solo tokens; sin casos ni tokens no escribe undefined ni NaN", () => {
    const sinTarifa = reporteMarkdown({ fecha: "2026-11-17", archivos: [], resultados: [fallido], tarifa: null, intentosDeEscritura: 0 });
    expect(sinTarifa).toContain("sin tarifa conocida para el modelo; solo tokens");
    expect(sinTarifa).toContain("2000000 de entrada");

    const vacio = reporteMarkdown({ fecha: "2026-11-17", archivos: [], resultados: [], tarifa: null, intentosDeEscritura: 0 });
    for (const md of [sinTarifa, vacio]) {
      expect(md).not.toContain("undefined");
      expect(md).not.toContain("NaN");
      expect(md).not.toContain("null");
    }
    expect(vacio).toContain("Ninguno.");
  });

  it("un caso que lanzó muestra su error y lo que alcanzó a enviar; los intentos de escritura se nombran", () => {
    const lanzo: ResultadoDeCaso = {
      id: "boom",
      fuente: "borde",
      chequeos: chequeosDeCasoFallido("pasó de 90 s"),
      borrador: { accion: "error", resumen: "pasó de 90 s", mensajes: [], pases: [], guardas: [], tokens: null, modelo: null, duracionMs: 0 },
      error: "pasó de 90 s",
    };
    const md = reporteMarkdown({
      fecha: "2026-11-17",
      archivos: ["x.jsonl"],
      resultados: [lanzo],
      tarifa: null,
      intentosDeEscritura: 1,
      detalleDeIntentos: ["insert en messages"],
    });
    expect(md).toContain("- Error: pasó de 90 s");
    expect(md).toContain("Intentos de escritura: 1 — insert en messages");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("NaN");
  });

  it("muestra las puertas abiertas cuando todo pasa", () => {
    const md = reporteMarkdown({ fecha: "2026-11-17", archivos: [], resultados: [bueno], tarifa: null, intentosDeEscritura: 0 });
    expect(md).toContain("ABIERTA");
  });
});
