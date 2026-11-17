import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  PREGUNTA_QUE_BUSCA_INSTRUCTION,
  type AvisoCatalogo,
  type buildCatalogTool,
  type CatalogOutcome,
  type ConsultaCatalogo,
  type LineaCotizada,
} from "@/lib/ai/tools";
import { MOTIVOS_V2 } from "./motivos";
import { crearSesion } from "./sesion";
import { estadoInicial } from "./tipos";
import {
  NOMBRE_BUSCAR_REPUESTO,
  buildBuscarRepuestoV2,
  casoDeLaLlamada,
  fotoDelOutcome,
  instruccionV2,
  type CasoDeBusqueda,
  type DepsDeBusqueda,
  type SalidaDeBusquedaV2,
} from "./tool-buscar-repuesto";

// S8b (17/11/2026, entrega 3 de Seba v2): `buscarRepuesto` de v2 envuelve la
// búsqueda de v1 SIN cambiarla. Las pruebas inyectan una herramienta falsa de
// v1 cuyo `execute` muta el `catalogOutcome` como lo haría la real y devuelve
// una salida con la forma de la real (con precios: de ahí salen las cifras).

const AHORA = new Date("2026-11-17T15:00:00Z");
const OPCIONES = { toolCallId: "t1", messages: [], context: {} };

function outcomeVacio(): CatalogOutcome {
  return {
    ran: false,
    conExistencia: false,
    agotados: false,
    sinResultados: false,
    generico: false,
    cotizacion: [],
    preguntaFiltro: null,
    consultas: [],
    avisos: [],
    motivoForzado: null,
  };
}

function linea(productId: string, nombre: string, stock: number, extra: Partial<LineaCotizada> = {}): LineaCotizada {
  // Precio con cifras que no aparecen en ningún nombre ni id.
  return { productId, nombre, precioUsd: 37.25, precioBs: 1490, stock, productoPedido: null, ...extra };
}

function consulta(resultado: ConsultaCatalogo["resultado"]): ConsultaCatalogo {
  return {
    v: 2,
    query: "pastillas",
    productos: null,
    moto: [],
    cilindrada: [],
    grupos: [],
    opcionales: [],
    variantes: [],
    anio: [],
    motoMarca: [],
    motoIgnorada: false,
    calzaEntero: false,
    relajados: [],
    avisos: [],
    corregido: null,
    correccionDescartada: null,
    decision: "",
    cotizados: [],
    conteos: null,
    resultado,
  };
}

/** Qué hace la herramienta falsa de v1 en una llamada: muta el outcome y devuelve su salida. */
interface Guion {
  lineas?: LineaCotizada[];
  consultas?: ConsultaCatalogo[];
  avisos?: AvisoCatalogo[];
  preguntaFiltro?: "moto" | "producto";
  motivoForzado?: "confirmar_inventario";
  salida?: Record<string, unknown>;
  lanza?: boolean;
}

const SCHEMA_DE_V1 = { __esElSchemaDeV1: true };

function montar(guiones: Guion[]) {
  const sesion = crearSesion({
    estado: estadoInicial(AHORA),
    escaladaAbierta: false,
    tiendaAbierta: true,
    cuandoAbre: null,
    ahora: AHORA,
  });
  const catalogOutcome = outcomeVacio();
  let llamada = 0;
  const entradas: unknown[] = [];

  const construirFalso = ((_deps: unknown, outcome: CatalogOutcome) => ({
    description: "descripción de v1: escale con confirmar_inventario",
    inputSchema: SCHEMA_DE_V1,
    execute: async (entrada: unknown) => {
      entradas.push(entrada);
      const g = guiones[llamada++] ?? {};
      outcome.ran = true;
      if (g.lanza) throw new Error("la base se cayó");
      outcome.cotizacion.push(...(g.lineas ?? []));
      outcome.consultas.push(...(g.consultas ?? []));
      outcome.avisos.push(...(g.avisos ?? []));
      if (g.preguntaFiltro) {
        outcome.generico = true;
        outcome.preguntaFiltro = g.preguntaFiltro;
      }
      if (g.motivoForzado) outcome.motivoForzado = g.motivoForzado;
      return g.salida ?? { results: [], instruccionParaTuRespuesta: "instrucción de v1" };
    },
  })) as unknown as typeof buildCatalogTool;

  const deps: DepsDeBusqueda = {
    supabase: {} as SupabaseClient<Database>,
    conversationId: "c1",
    contactId: "k1",
    rafaga: ["pastillas de freno para mi sbr"],
    persistencia: "normal",
    sesion,
    catalogOutcome,
    construir: construirFalso,
  };
  const herramienta = buildBuscarRepuestoV2(deps);
  const correr = (entrada: unknown = { query: "pastillas" }) =>
    herramienta.execute!(entrada as never, OPCIONES as never) as Promise<SalidaDeBusquedaV2>;
  return { sesion, catalogOutcome, herramienta, correr, entradas };
}

const SALIDA_V1_CON_PRECIO = {
  results: [{ nombre: "PASTILLA FRENO BERA SBR", precio: "$37,25 BCV (Bs. 1.490,00)", stock: 8 }],
  tasaBcvUsada: 40,
  instruccionParaTuRespuesta: "Escale con confirmar_inventario con escalarAAsesor.",
};

describe("buildBuscarRepuestoV2 — un caso por cada resultado de la búsqueda", () => {
  it("con_existencia: lista los productos sin precio ni cantidad y pide una línea de cierre", async () => {
    const { correr } = montar([
      { lineas: [linea("p1", "PASTILLA FRENO BERA SBR", 8)], consultas: [consulta("con_existencia")], salida: SALIDA_V1_CON_PRECIO },
    ]);

    const salida = await correr();

    expect(salida.productos).toEqual([
      { productId: "p1", nombre: "PASTILLA FRENO BERA SBR", disponible: true, ultimaUnidad: false, esAlternativa: false },
    ]);
    expect(salida.instruccionParaTuRespuesta).toBe(
      "El sistema ya le envía al cliente la cotización con el nombre exacto y el precio: no repitas nombres ni precios ni digas cuántas unidades hay. Escribe UNA línea corta: pregúntale si lo quiere llevar y cómo prefiere pagar, con Cashea o de contado.",
    );
  });

  it("la salida al modelo NO trae precio ni cantidad, ni como clave ni como cifra", async () => {
    const { correr } = montar([
      { lineas: [linea("p1", "PASTILLA FRENO BERA SBR", 8)], consultas: [consulta("con_existencia")], salida: SALIDA_V1_CON_PRECIO },
    ]);

    const json = JSON.stringify(await correr());

    for (const prohibido of ["precioUsd", "precioBs", "stock", "37,25", "37.25", "1.490", "1490", "BCV", "Bs."]) {
      expect(json, prohibido).not.toContain(prohibido);
    }
  });

  it("última unidad y alternativa: lo marca y lo dice en la instrucción", async () => {
    const { correr } = montar([
      {
        lineas: [linea("p1", "PASTILLA FRENO BERA SBR", 1), linea("p2", "CASCO LS2 AZUL", 3, { esAlternativa: true })],
        consultas: [consulta("con_existencia")],
        salida: SALIDA_V1_CON_PRECIO,
      },
    ]);

    const salida = await correr();

    expect(salida.productos.map((p) => [p.productId, p.ultimaUnidad, p.esAlternativa, p.disponible])).toEqual([
      ["p1", true, false, true],
      ["p2", false, true, true],
    ]);
    expect(salida.instruccionParaTuRespuesta).toContain(
      "La variante que pidió está agotada y lo cotizado es otra opción: dilo.",
    );
    expect(salida.instruccionParaTuRespuesta).toContain("Es la última unidad: puedes decirlo.");
  });

  it("avisos universales o relajado: no afirmar compatibilidad, consulta_tecnica", async () => {
    for (const aviso of [
      { tipo: "universales", productoPedido: null, marca: "bera" } as AvisoCatalogo,
      { tipo: "relajado", productoPedido: null, terminos: ["pwk"] } as AvisoCatalogo,
    ]) {
      const { correr } = montar([
        { lineas: [linea("p1", "PASTILLA FRENO", 4)], avisos: [aviso], consultas: [consulta("con_existencia")], salida: SALIDA_V1_CON_PRECIO },
      ]);

      const { instruccionParaTuRespuesta } = await correr();

      expect(instruccionParaTuRespuesta).toContain(
        "No está confirmado que sea exactamente lo que pidió o que le sirva a su moto: no afirmes compatibilidad; si la necesita confirmada, pasa el caso con el motivo consulta_tecnica.",
      );
    }
  });

  it("lista con agotados o «varias opciones»: no repetir lo que el sistema ya marca", async () => {
    const conAgotado = montar([
      {
        lineas: [linea("p1", "BATERIA GEL", 5, { productoPedido: "bateria" }), linea("p2", "BUJIA NGK", 0, { productoPedido: "bujia" })],
        consultas: [consulta("con_existencia"), consulta("agotados")],
        salida: SALIDA_V1_CON_PRECIO,
      },
    ]);
    const conVarias = montar([
      {
        lineas: [linea("p1", "BATERIA GEL", 5, { productoPedido: "bateria" })],
        avisos: [{ tipo: "varias_opciones", productoPedido: "casco" }],
        consultas: [consulta("con_existencia"), consulta("generico")],
        salida: SALIDA_V1_CON_PRECIO,
      },
    ]);
    const sinNada = montar([{ lineas: [linea("p1", "BATERIA GEL", 5)], consultas: [consulta("con_existencia")], salida: SALIDA_V1_CON_PRECIO }]);

    const frase = "El sistema marca en la lista lo agotado y lo que no se encontró: no lo repitas.";
    expect((await conAgotado.correr()).instruccionParaTuRespuesta).toContain(frase);
    expect((await conVarias.correr()).instruccionParaTuRespuesta).toContain(frase);
    expect((await sinNada.correr()).instruccionParaTuRespuesta).not.toContain(frase);
  });

  it("agotado: todo en cero; ofrece buscar otra y avisos solo con apartado_o_aviso", async () => {
    const { correr } = montar([
      { lineas: [linea("p1", "PASTILLA FRENO", 0)], consultas: [consulta("agotados")], salida: SALIDA_V1_CON_PRECIO },
    ]);

    const salida = await correr();

    expect(salida.productos).toEqual([
      { productId: "p1", nombre: "PASTILLA FRENO", disponible: false, ultimaUnidad: false, esAlternativa: false },
    ]);
    expect(salida.instruccionParaTuRespuesta).toBe(
      "Está agotado y el sistema se lo dice al cliente. Escribe UNA línea: ofrécele buscar otra opción. No des fecha de reposición ni prometas avisar; si pide que le avisen, pasa el caso con el motivo apartado_o_aviso.",
    );
  });

  it("pregunta_moto y pregunta_producto: la pregunta de filtro de ESTA llamada", async () => {
    const moto = montar([{ consultas: [consulta("generico")], preguntaFiltro: "moto", salida: { results: [] } }]);
    const producto = montar([{ consultas: [consulta("generico")], preguntaFiltro: "producto", salida: { results: [] } }]);

    const m = await moto.correr();
    const p = await producto.correr();

    expect(m.productos).toEqual([]);
    expect(m.instruccionParaTuRespuesta).toBe(
      "Hay varias opciones y depende de la moto. Pregunta en UNA línea el modelo y el año de la moto. No afirmes existencia ni precio todavía.",
    );
    expect(p.instruccionParaTuRespuesta).toBe(
      "Hay varias opciones. Pregunta en UNA línea el dato que las distingue (marca, medida, talla o modelo). No afirmes existencia ni precio todavía.",
    );
  });

  it("sin_calce: aviso moto_sin_calce y motivo forzado, sin líneas", async () => {
    const { correr } = montar([
      {
        avisos: [{ tipo: "moto_sin_calce", productoPedido: null, moto: "milan" }],
        motivoForzado: "confirmar_inventario",
        consultas: [consulta("generico")],
        salida: { results: [] },
      },
    ]);

    const salida = await correr();

    expect(salida.productos).toEqual([]);
    expect(salida.instruccionParaTuRespuesta).toBe(
      "El inventario no confirma uno para su moto. No cotices ni afirmes compatibilidad: pasa el caso con el motivo consulta_tecnica y cuenta en la nota qué pidió y para qué moto.",
    );
  });

  it("no_nombro_producto: la instrucción de v1 es la de «no nombró ningún producto»", async () => {
    const { correr } = montar([
      { salida: { results: [], instruccionParaTuRespuesta: PREGUNTA_QUE_BUSCA_INSTRUCTION } },
    ]);

    const salida = await correr({ query: "", clienteNoNombroRepuesto: true });

    expect(salida.instruccionParaTuRespuesta).toBe(
      "El cliente no nombró ningún producto: pregúntale en UNA línea qué busca.",
    );
  });

  it("no_encontrado: sin líneas ni pregunta ni aviso", async () => {
    const { correr } = montar([{ consultas: [consulta("sin_resultados")], salida: { results: [], instruccionParaTuRespuesta: "x" } }]);

    expect((await correr()).instruccionParaTuRespuesta).toBe(
      "No se encontró en el inventario. Si todavía no le pediste el dato que falta (el producto exacto, la moto o la medida), pídelo en UNA línea; si ya lo pediste, pasa el caso con el motivo no_identificado.",
    );
  });

  it("error de v1 (salida con `error`): caso error, sin afirmar nada", async () => {
    const { correr } = montar([
      { consultas: [consulta("error")], salida: { results: [], error: "No se pudo consultar el catálogo en este momento.", instruccionParaTuRespuesta: "x" } },
    ]);

    const salida = await correr();

    expect(salida.productos).toEqual([]);
    expect(salida.instruccionParaTuRespuesta).toBe(
      "No se pudo consultar el inventario. No afirmes existencia ni precio: pasa el caso con el motivo no_identificado y cuenta en la nota qué pidió.",
    );
  });

  it("si el execute de v1 LANZA no relanza: devuelve el caso error", async () => {
    const { correr, sesion } = montar([{ lanza: true }]);

    const salida = await correr();

    expect(salida.productos).toEqual([]);
    expect(salida.instruccionParaTuRespuesta).toBe(instruccionV2("error", [], []));
    expect(sesion.herramientas).toEqual([NOMBRE_BUSCAR_REPUESTO]);
  });
});

describe("buildBuscarRepuestoV2 — lo que anota en la sesión del turno", () => {
  it("anota el nombre de la herramienta y la salida de v1 como fuente (ahí está el precio)", async () => {
    const { correr, sesion } = montar([
      { lineas: [linea("p1", "PASTILLA FRENO BERA SBR", 8)], consultas: [consulta("con_existencia")], salida: SALIDA_V1_CON_PRECIO },
    ]);

    await correr();

    expect(sesion.herramientas).toEqual(["buscarRepuesto"]);
    expect(sesion.fuentes).toEqual([JSON.stringify(SALIDA_V1_CON_PRECIO)]);
    expect(sesion.fuentes[0]).toContain("37,25");
  });

  it("sesion.productos gana solo los ids NUEVOS de cada llamada del mismo turno", async () => {
    const { correr, sesion } = montar([
      { lineas: [linea("p1", "PASTILLA FRENO", 8)], consultas: [consulta("con_existencia")], salida: SALIDA_V1_CON_PRECIO },
      { lineas: [linea("p2", "BUJIA NGK", 3)], consultas: [consulta("con_existencia")], salida: SALIDA_V1_CON_PRECIO },
    ]);

    const primera = await correr();
    expect([...sesion.productos]).toEqual(["p1"]);
    const segunda = await correr({ query: "bujia" });

    expect([...sesion.productos]).toEqual(["p1", "p2"]);
    expect(primera.productos.map((p) => p.productId)).toEqual(["p1"]);
    // La segunda llamada solo devuelve lo suyo, no lo que ya cotizó la primera.
    expect(segunda.productos.map((p) => p.productId)).toEqual(["p2"]);
    expect(sesion.herramientas).toEqual(["buscarRepuesto", "buscarRepuesto"]);
    expect(sesion.fuentes).toHaveLength(2);
  });

  it("una pregunta de una llamada anterior no se confunde con la de esta", async () => {
    const { correr } = montar([
      { consultas: [consulta("generico")], preguntaFiltro: "moto", salida: { results: [] } },
      { consultas: [consulta("sin_resultados")], salida: { results: [], instruccionParaTuRespuesta: "x" } },
    ]);

    await correr();
    const segunda = await correr({ query: "otra cosa" });

    expect(segunda.instruccionParaTuRespuesta).toBe(instruccionV2("no_encontrado", [], []));
  });

  it("le pasa a v1 la misma entrada que recibió", async () => {
    const { correr, entradas } = montar([{}]);
    const entrada = { query: "pastillas", motoModel: "sbr" };

    await correr(entrada);

    expect(entradas).toEqual([entrada]);
  });
});

describe("buildBuscarRepuestoV2 — la herramienta", () => {
  it("usa el inputSchema de v1 (misma referencia) y una descripción propia de v2", () => {
    const { herramienta } = montar([]);

    expect(herramienta.inputSchema).toBe(SCHEMA_DE_V1);
    const descripcion = String(herramienta.description);
    expect(descripcion).toContain("inventario real");
    for (const prohibido of ["escal", "asesor", "confirmar_inventario"]) {
      expect(descripcion.toLowerCase(), prohibido).not.toContain(prohibido);
    }
  });
});

describe("casoDeLaLlamada — precedencia", () => {
  const antes = (): ReturnType<typeof fotoDelOutcome> => fotoDelOutcome(outcomeVacio());

  it("error gana sobre todo lo demás", () => {
    const despues = outcomeVacio();
    despues.cotizacion.push(linea("p1", "X", 3));
    expect(casoDeLaLlamada(antes(), despues, { error: "falló" }).caso).toBe("error");
  });

  it("líneas con existencia ganan sobre una pregunta o un motivo forzado de la misma llamada", () => {
    const despues = outcomeVacio();
    despues.cotizacion.push(linea("p1", "X", 3));
    despues.preguntaFiltro = "moto";
    despues.consultas.push(consulta("generico"));
    despues.motivoForzado = "confirmar_inventario";
    expect(casoDeLaLlamada(antes(), despues, {}).caso).toBe("con_existencia");
  });

  it("mezcla de agotado y con existencia es con_existencia; todo en cero es agotado", () => {
    const mezcla = outcomeVacio();
    mezcla.cotizacion.push(linea("p1", "X", 0), linea("p2", "Y", 2));
    expect(casoDeLaLlamada(antes(), mezcla, {}).caso).toBe("con_existencia");

    const cero = outcomeVacio();
    cero.cotizacion.push(linea("p1", "X", 0));
    expect(casoDeLaLlamada(antes(), cero, {}).caso).toBe("agotado");
  });

  it("un motivo forzado que ya estaba antes no cuenta como sin_calce de esta llamada", () => {
    const previo = outcomeVacio();
    previo.motivoForzado = "confirmar_inventario";
    const despues = structuredClone(previo);
    despues.consultas.push(consulta("sin_resultados"));
    expect(casoDeLaLlamada(fotoDelOutcome(previo), despues, {}).caso).toBe("no_encontrado");
  });

  it("devuelve las líneas y avisos NUEVOS de la llamada", () => {
    const previo = outcomeVacio();
    previo.cotizacion.push(linea("p0", "VIEJO", 1));
    previo.avisos.push({ tipo: "relajado", productoPedido: null, terminos: ["a"] });
    const despues = structuredClone(previo);
    despues.cotizacion.push(linea("p1", "NUEVO", 2));
    despues.avisos.push({ tipo: "universales", productoPedido: null, marca: null });

    const r = casoDeLaLlamada(fotoDelOutcome(previo), despues, {});

    expect(r.lineas.map((l) => l.productId)).toEqual(["p1"]);
    expect(r.avisos.map((a) => a.tipo)).toEqual(["universales"]);
  });
});

describe("instruccionV2 — lo que lee el modelo", () => {
  const CASOS: CasoDeBusqueda[] = [
    "con_existencia",
    "agotado",
    "pregunta_moto",
    "pregunta_producto",
    "sin_calce",
    "no_encontrado",
    "no_nombro_producto",
    "error",
  ];
  const todas = (): string[] => {
    const salida = CASOS.map((c) => instruccionV2(c, [], []));
    // La variante más larga de con_existencia, con todos los añadidos.
    salida.push(
      instruccionV2(
        "con_existencia",
        [linea("p1", "X", 1, { esAlternativa: true }), linea("p2", "Y", 0)],
        [{ tipo: "universales", productoPedido: null, marca: null }, { tipo: "varias_opciones", productoPedido: "casco" }],
      ),
    );
    return salida;
  };

  it("ninguna menciona la herramienta ni los motivos de v1, a «Seba» ni trae cifras", () => {
    for (const texto of todas()) {
      expect(texto).not.toContain("escalarAAsesor");
      expect(texto).not.toContain("confirmar_inventario");
      expect(texto.toLowerCase()).not.toContain("seba");
      expect(texto).not.toMatch(/\d/);
    }
  });

  it("todos los motivos que nombra existen en MOTIVOS_V2", () => {
    const citados = new Set<string>();
    for (const texto of todas()) {
      for (const m of texto.matchAll(/motivo ([a-z_]+)/g)) citados.add(m[1]);
    }

    expect(citados.size).toBeGreaterThanOrEqual(3);
    for (const motivo of citados) {
      expect(MOTIVOS_V2 as readonly string[], motivo).toContain(motivo);
    }
  });
});
