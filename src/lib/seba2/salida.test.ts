import { describe, expect, it } from "vitest";
import {
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
} from "@/lib/ai/seba";
import type { AvisoCatalogo, CatalogOutcome, ConsultaCatalogo, LineaCotizada } from "@/lib/ai/tools";
import {
  citarRafaga,
  pareceAceptacion,
  partirEnMensajes,
  planearSalida,
  unirMensajesDeTexto,
} from "./salida";
import { PREGUNTA_QUE_BUSCA } from "./textos";

// S8c (17/11/2026): lo PURO del armado de la salida de Seba v2. Sin Supabase ni modelo:
// el turno decide qué se envía a partir de este plan, y aquí se prueba cada rama.

function outcome(extra: Partial<CatalogOutcome> = {}): CatalogOutcome {
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
    ...extra,
  };
}

function linea(productId: string, nombre: string, stock: number, extra: Partial<LineaCotizada> = {}): LineaCotizada {
  return { productId, nombre, precioUsd: 37.25, precioBs: 1490, stock, productoPedido: null, ...extra };
}

function consulta(extra: Partial<ConsultaCatalogo> = {}): ConsultaCatalogo {
  return {
    v: 2,
    query: "impermeable",
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
    resultado: "con_existencia",
    ...extra,
  };
}

const SIN_FOTO = () => null;
const CON_FOTO = (id: string) => `https://fotos.example/${id}.jpg`;

describe("planearSalida: cotización", () => {
  it("un solo producto con existencia y foto: bloque en «sin cantidad», foto y existencia", () => {
    const plan = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({
        ran: true,
        conExistencia: true,
        cotizacion: [linea("p1", "IMPERMEABLE GIVI TALLA L", 6)],
        consultas: [consulta()],
      }),
      fotoDe: CON_FOTO,
    });

    expect(plan.tipo).toBe("cotizacion");
    if (plan.tipo !== "cotizacion") return;
    expect(plan.bloque).toContain("IMPERMEABLE GIVI TALLA L");
    expect(plan.bloque).toContain("$37,25");
    // Con existencia el guion de v2 no dice cuántas unidades hay.
    expect(plan.bloque).not.toMatch(/6 disponibles|disponibles/);
    expect(plan.foto).toEqual({ url: "https://fotos.example/p1.jpg" });
    expect(plan.hayExistencia).toBe(true);
    expect(plan.productos.map((p) => p.productId)).toEqual(["p1"]);
    expect(plan.lineaDelModelo).toBeNull();
  });

  it("la última unidad se dice «Última unidad» y un agotado, «Agotado»", () => {
    const ultima = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({ ran: true, cotizacion: [linea("p1", "BUJIA NGK", 1)] }),
      fotoDe: SIN_FOTO,
    });
    expect(ultima.tipo === "cotizacion" && ultima.bloque).toContain("Última unidad");

    const agotado = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({ ran: true, cotizacion: [linea("p1", "BUJIA NGK", 0)] }),
      fotoDe: SIN_FOTO,
    });
    expect(agotado.tipo === "cotizacion" && agotado.bloque).toContain("Agotado");
  });

  it("sin foto principal no hay foto", () => {
    const plan = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({ ran: true, cotizacion: [linea("p1", "BUJIA NGK", 3)] }),
      fotoDe: SIN_FOTO,
    });
    expect(plan.tipo === "cotizacion" && plan.foto).toBeNull();
  });

  it("con más de un producto cotizado NO hay foto, aunque todos tengan", () => {
    const plan = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({
        ran: true,
        cotizacion: [linea("p1", "BUJIA NGK", 3), linea("p2", "CABLE DE CLUTCH", 4)],
      }),
      fotoDe: CON_FOTO,
    });
    expect(plan.tipo === "cotizacion" && plan.foto).toBeNull();
  });

  it("un único producto AGOTADO no lleva foto ni existencia", () => {
    const plan = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({ ran: true, agotados: true, cotizacion: [linea("p1", "BUJIA NGK", 0)] }),
      fotoDe: CON_FOTO,
    });
    expect(plan.tipo).toBe("cotizacion");
    if (plan.tipo !== "cotizacion") return;
    expect(plan.foto).toBeNull();
    expect(plan.hayExistencia).toBe(false);
  });

  it("la línea del modelo se conserva si es una sola línea corta, sin cifras ni asesor ni el nombre del producto", () => {
    const base = {
      catalogOutcome: outcome({ ran: true, cotizacion: [linea("p1", "IMPERMEABLE GIVI TALLA L", 6)] }),
      fotoDe: SIN_FOTO,
    };
    const buena = planearSalida({ ...base, textoModelo: "  ¿Lo quieres llevar? ¿Cashea o de contado?  " });
    expect(buena.tipo === "cotizacion" && buena.lineaDelModelo).toBe("¿Lo quieres llevar? ¿Cashea o de contado?");

    const descartes = [
      "Primera línea\nsegunda línea",
      "Cuesta $37,25 y sale hoy.",
      "Un asesor te confirma si lo llevas.",
      "El IMPERMEABLE GIVI TALLA L es el que te conviene.",
      "x".repeat(241),
      "   ",
    ];
    for (const texto of descartes) {
      const plan = planearSalida({ ...base, textoModelo: texto });
      expect(plan.tipo === "cotizacion" && plan.lineaDelModelo, texto).toBeNull();
    }
  });

  it("repite los avisos, lo no encontrado y las correcciones de las consultas, como v1", () => {
    const aviso: AvisoCatalogo = { tipo: "moto_sin_calce", moto: "SBR", productoPedido: null };
    const plan = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({
        ran: true,
        cotizacion: [linea("p1", "BUJIA NGK", 3, { productoPedido: "bujía" })],
        avisos: [aviso],
        consultas: [
          consulta({ query: "bujía", productos: ["bujía", "casco rojo"], resultado: "con_existencia" }),
          consulta({ query: "casco rojo", productos: ["bujía", "casco rojo"], resultado: "sin_resultados" }),
        ],
      }),
      fotoDe: SIN_FOTO,
    });
    expect(plan.tipo).toBe("cotizacion");
    if (plan.tipo !== "cotizacion") return;
    expect(plan.bloque).toContain("casco rojo: no lo encontré en el catálogo");
    expect(plan.bloque).toContain("El asesor te confirma cuál le sirve a tu SBR.");
  });

  it("solo avisos (sin renglones) también es una cotización: hay algo que decir", () => {
    const plan = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({
        ran: true,
        avisos: [{ tipo: "moto_sin_calce", moto: "Milan", productoPedido: null }],
      }),
      fotoDe: CON_FOTO,
    });
    expect(plan.tipo).toBe("cotizacion");
    if (plan.tipo !== "cotizacion") return;
    expect(plan.hayExistencia).toBe(false);
    expect(plan.productos).toEqual([]);
    expect(plan.foto).toBeNull();
  });
});

describe("planearSalida: pregunta de filtro", () => {
  it("usa el texto del modelo si es una pregunta", () => {
    const plan = planearSalida({
      textoModelo: "¿Para qué moto lo necesitas?",
      catalogOutcome: outcome({ ran: true, generico: true, preguntaFiltro: "moto" }),
      fotoDe: SIN_FOTO,
    });
    expect(plan).toEqual({
      tipo: "pregunta",
      texto: "¿Para qué moto lo necesitas?",
      origen: "modelo",
      respaldo: PREGUNTA_FILTRO,
    });
  });

  it("si el modelo no preguntó, sale la pregunta fija de la moto o la del producto", () => {
    const moto = planearSalida({
      textoModelo: "Tenemos varios modelos.",
      catalogOutcome: outcome({ ran: true, generico: true, preguntaFiltro: "moto" }),
      fotoDe: SIN_FOTO,
    });
    expect(moto).toEqual({ tipo: "pregunta", texto: PREGUNTA_FILTRO, origen: "fijo", respaldo: PREGUNTA_FILTRO });

    const producto = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({ ran: true, generico: true, preguntaFiltro: "producto" }),
      fotoDe: SIN_FOTO,
    });
    expect(producto).toEqual({
      tipo: "pregunta",
      texto: PREGUNTA_FILTRO_PRODUCTO,
      origen: "fijo",
      respaldo: PREGUNTA_FILTRO_PRODUCTO,
    });
  });

  it("con cotización, la cotización manda aunque haya quedado una pregunta de filtro de otra consulta", () => {
    const plan = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({
        ran: true,
        preguntaFiltro: "moto",
        cotizacion: [linea("p1", "BUJIA NGK", 3)],
      }),
      fotoDe: SIN_FOTO,
    });
    expect(plan.tipo).toBe("cotizacion");
  });

  it("el cliente aún no nombró un repuesto (búsqueda genérica sin consultas): «¿Qué buscas?»", () => {
    const sinTexto = planearSalida({
      textoModelo: "",
      catalogOutcome: outcome({ ran: true, generico: true }),
      fotoDe: SIN_FOTO,
    });
    expect(sinTexto).toEqual({
      tipo: "pregunta",
      texto: PREGUNTA_QUE_BUSCA,
      origen: "fijo",
      respaldo: PREGUNTA_QUE_BUSCA,
    });

    const conTexto = planearSalida({
      textoModelo: "Claro, ¿qué repuesto necesitas?",
      catalogOutcome: outcome({ ran: true, generico: true }),
      fotoDe: SIN_FOTO,
    });
    expect(conTexto).toMatchObject({ tipo: "pregunta", origen: "modelo", respaldo: PREGUNTA_QUE_BUSCA });
  });
});

describe("planearSalida: texto y vacío", () => {
  it("sin búsqueda ni cotización, el texto del modelo se parte por párrafos", () => {
    const plan = planearSalida({
      textoModelo: "Atendemos de lunes a viernes.\n\nEl sábado hasta la 1.",
      catalogOutcome: outcome(),
      fotoDe: SIN_FOTO,
    });
    expect(plan).toEqual({
      tipo: "texto",
      textos: ["Atendemos de lunes a viernes.", "El sábado hasta la 1."],
    });
  });

  it("respeta el máximo de mensajes que se le pase (por defecto, tres)", () => {
    const parrafos = ["a", "b", "c", "d", "e"].join("\n\n");
    const porDefecto = planearSalida({ textoModelo: parrafos, catalogOutcome: outcome(), fotoDe: SIN_FOTO });
    expect(porDefecto.tipo === "texto" && porDefecto.textos).toHaveLength(3);

    const uno = planearSalida({
      textoModelo: parrafos,
      catalogOutcome: outcome(),
      fotoDe: SIN_FOTO,
      maxMensajes: 1,
    });
    expect(uno.tipo === "texto" && uno.textos).toEqual([parrafos]);
  });

  it("texto vacío: «vacío», y dice si hubo búsqueda", () => {
    expect(planearSalida({ textoModelo: "  \n ", catalogOutcome: outcome(), fotoDe: SIN_FOTO })).toEqual({
      tipo: "vacio",
      huboBusqueda: false,
    });
    expect(
      planearSalida({
        textoModelo: "",
        catalogOutcome: outcome({ ran: true, sinResultados: true, consultas: [consulta({ resultado: "sin_resultados" })] }),
        fotoDe: SIN_FOTO,
      })
    ).toEqual({ tipo: "vacio", huboBusqueda: true });
  });
});

describe("partirEnMensajes", () => {
  it("un párrafo es un mensaje", () => {
    expect(partirEnMensajes("Hola, cómo estás", 3)).toEqual(["Hola, cómo estás"]);
  });

  it("dos párrafos con max 2 son dos mensajes", () => {
    expect(partirEnMensajes("Uno\n\nDos", 2)).toEqual(["Uno", "Dos"]);
  });

  it("cinco párrafos con max 2: el resto se une al último en vez de perderse", () => {
    expect(partirEnMensajes("A\n\nB\n\nC\n\nD\n\nE", 2)).toEqual(["A", "B\n\nC\n\nD\n\nE"]);
  });

  it("tolera líneas en blanco con espacios, recorta y descarta los párrafos vacíos", () => {
    expect(partirEnMensajes("  A  \n \n\n  \nB\n\n\n", 5)).toEqual(["A", "B"]);
  });

  it("los saltos simples no parten: un mensaje puede traer varias líneas", () => {
    expect(partirEnMensajes("línea 1\nlínea 2", 3)).toEqual(["línea 1\nlínea 2"]);
  });

  it("texto vacío: ningún mensaje; un máximo menor que 1 se trata como 1", () => {
    expect(partirEnMensajes("   ", 3)).toEqual([]);
    expect(partirEnMensajes("A\n\nB", 0)).toEqual(["A\n\nB"]);
  });
});

describe("unirMensajesDeTexto", () => {
  it("une los sobrantes al último con una línea en blanco y conserva el origen más 'libre'", () => {
    const unidos = unirMensajesDeTexto(
      [
        { texto: "bloque", origen: "herramienta" },
        { texto: "¿Lo quieres llevar?", origen: "modelo" },
      ],
      1
    );
    expect(unidos).toEqual([{ texto: "bloque\n\n¿Lo quieres llevar?", origen: "modelo" }]);
  });

  it("no toca nada si ya cabe", () => {
    const mensajes = [
      { texto: "a", origen: "fijo" as const },
      { texto: "b", origen: "fijo" as const },
    ];
    expect(unirMensajesDeTexto(mensajes, 2)).toEqual(mensajes);
  });

  it("dos mensajes fijos o de herramienta mantienen el origen de herramienta antes que el fijo", () => {
    expect(
      unirMensajesDeTexto(
        [
          { texto: "bloque", origen: "herramienta" },
          { texto: "cierre", origen: "fijo" },
        ],
        1
      )
    ).toEqual([{ texto: "bloque\n\ncierre", origen: "herramienta" }]);
  });
});

describe("pareceAceptacion", () => {
  it.each([
    ["sí"],
    ["Si"],
    ["dale"],
    ["Dale, lo quiero"],
    ["lo quiero"],
    ["me lo llevo"],
    ["quiero comprarlo"],
    ["cómo pago?"],
    ["¿Cómo puedo pagar?"],
    ["no sé cómo pago"],
    ["con cashea"],
    ["pago móvil"],
    ["por transferencia"],
    ["de una"],
    ["perfecto"],
    ["sí, dale"],
    ["dale mándame los datos"],
  ])("«%s» sí es aceptación o habla de pago", (texto) => {
    expect(pareceAceptacion([texto])).toBe(true);
  });

  it.each([
    ["no gracias"],
    ["No, gracias"],
    ["no"],
    ["no lo quiero"],
    ["mejor no"],
    ["gracias"],
    ["cuánto cuesta el de rojo?"],
    ["si lo tienen en rojo?"],
    ["si me sirve para mi sbr?"],
    ["ok?"],
    ["hola"],
    ["tienen bujías?"],
    [""],
  ])("«%s» NO es aceptación", (texto) => {
    expect(pareceAceptacion([texto])).toBe(false);
  });

  it("mira toda la ráfaga: basta una línea que acepte, salvo que otra rechace", () => {
    expect(pareceAceptacion(["gracias", "dale"])).toBe(true);
    expect(pareceAceptacion(["dale", "no, mejor no"])).toBe(false);
    expect(pareceAceptacion([])).toBe(false);
  });
});

describe("citarRafaga", () => {
  it("cita cada línea entre comillas latinas", () => {
    expect(citarRafaga(["hola", "precio del casco"])).toBe("«hola» «precio del casco»");
  });

  it("recorta cada línea a 300 caracteres y deja como mucho cinco, contando las que sobran", () => {
    const larga = "x".repeat(400);
    const citada = citarRafaga([larga, "2", "3", "4", "5", "6", "7"]);
    expect(citada.startsWith(`«${"x".repeat(300)}…»`)).toBe(true);
    expect(citada).toContain("«5»");
    expect(citada).not.toContain("«6»");
    expect(citada.endsWith("(+2 más)")).toBe(true);
  });
});
