import { describe, expect, it } from "vitest";
import {
  armarCotizacion,
  armarMensajeDeCotizacion,
  armarMensajeDePregunta,
  notaDeBusquedas,
  preambuloDelModelo,
} from "@/lib/ai/quote-message";
import { moneyFigures } from "@/lib/ai/price-guard";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import { formatQuote } from "@/lib/ai/precio";
import {
  OTRA_OPCION_CON_EXISTENCIA,
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  TEXTO_ASESOR_CONFIRMA,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_SIN_STOCK,
  textoMotoSinCalce,
  textoRelajado,
  textoRelajadoAgotado,
  textoUniversales,
  textoVarianteAgotada,
  textoVariasOpciones,
} from "@/lib/ai/seba";
import type { AvisoCatalogo, ConsultaCatalogo } from "@/lib/ai/tools";

// T3b, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026). El bloque de cotización lo arma el CÓDIGO con lo que
// devolvió la herramienta del catálogo: el modelo no puede cambiar un nombre
// ni un precio (caso de la cinta: buscó bien, escaló en el mismo turno y la
// despedida se tragó la cotización; y antes cambió "Inca 20W50 4T" por "Inca
// 20W50 semi sintético").

const inca = { productId: "p1", nombre: "ACEITE INCA 20W50 4T", precioUsd: 2.2, precioBs: 87, stock: 6, productoPedido: null };
const casco = { productId: "p2", nombre: "CASCO LS2 FF353 NEGRO M", precioUsd: 95, precioBs: 3800, stock: 0, productoPedido: null };

describe("armarCotizacion — el bloque que ve el cliente", () => {
  it("una línea: nombre EXACTO, precio '$X BCV (Bs. Y)' y cuántas unidades hay", () => {
    expect(armarCotizacion([inca])).toBe("• ACEITE INCA 20W50 4T: $2,20 BCV (Bs. 87,00) — 6 disponibles");
  });

  it("una sola unidad va en singular; en cero dice 'Agotado' y no repite unidades", () => {
    expect(armarCotizacion([{ ...inca, stock: 1 }])).toContain("— 1 disponible");
    expect(armarCotizacion([{ ...inca, stock: 1 }])).not.toContain("disponibles");
    const agotado = armarCotizacion([casco]);
    expect(agotado).toBe(`• CASCO LS2 FF353 NEGRO M: ${formatQuote(95, 3800)} — Agotado`);
  });

  it("usa el precio ya calculado de la línea: no recalcula ni redondea nada", () => {
    const bloque = armarCotizacion([{ ...inca, precioUsd: 12.3, precioBs: 1234.5 }]);
    expect(bloque).toContain(formatQuote(12.3, 1234.5));
  });

  it("una lista se agrupa por el producto que se pidió, en el orden en que se pidió", () => {
    const bateria = { ...inca, productId: "b1", nombre: "BATERIA BERA SOCIALISTA 12V", productoPedido: "bateria" };
    const arranque = { ...inca, productId: "a1", nombre: "MOTOR DE ARRANQUE BERA SOCIALISTA", productoPedido: "motor de arranque" };
    const bateria2 = { ...inca, productId: "b2", nombre: "BATERIA GEL 12V", productoPedido: "bateria" };

    const bloque = armarCotizacion([bateria, arranque, bateria2]);

    expect(bloque.split("\n\n")).toEqual([
      `*bateria*\n• BATERIA BERA SOCIALISTA 12V: ${formatQuote(2.2, 87)} — 6 disponibles\n• BATERIA GEL 12V: ${formatQuote(2.2, 87)} — 6 disponibles`,
      `*motor de arranque*\n• MOTOR DE ARRANQUE BERA SOCIALISTA: ${formatQuote(2.2, 87)} — 6 disponibles`,
    ]);
  });

  it("el encabezado de un producto pedido no puede meter formato ni cifras del modelo: se limpia y se recorta", () => {
    const bloque = armarCotizacion([{ ...inca, productoPedido: "*bateria* " + "x".repeat(100) }]);
    const encabezado = bloque.split("\n")[0];
    expect(encabezado.startsWith("*bateria xxx")).toBe(true);
    expect(encabezado.length).toBeLessThanOrEqual(62);
  });

  it("los productos de una lista que no aparecieron se dicen tal cual, sin inventar nada", () => {
    const bloque = armarCotizacion([{ ...inca, productoPedido: "aceite" }], { noEncontrados: ["motor de arranque"] });
    expect(bloque).toContain("• motor de arranque: no lo encontré en el catálogo");
  });

  it("con una corrección, el bloque abre diciendo qué palabra se buscó en lugar de la escrita", () => {
    const bloque = armarCotizacion([inca], { correcciones: [{ original: "iphone", corregido: "ipone" }] });
    expect(bloque.startsWith("Como no encontré exactamente lo que escribiste, busqué IPONE en lugar de iphone:\n")).toBe(true);
  });

  it("sin líneas ni faltantes devuelve cadena vacía", () => {
    expect(armarCotizacion([])).toBe("");
  });
});

describe("preambuloDelModelo — lo único que el modelo puede sumar", () => {
  const lineas = [inca];

  it("una línea corta y sin cifras de dinero se conserva", () => {
    expect(preambuloDelModelo("¡Claro! Mira lo que encontré.", lineas)).toBe("¡Claro! Mira lo que encontré.");
  });

  it("varias líneas se descartan: el modelo no puede redactar el mensaje entero", () => {
    expect(preambuloDelModelo("Claro.\nTe cuento:\nEl aceite sale barato.", lineas)).toBeNull();
  });

  it("más de 240 caracteres se descarta", () => {
    expect(preambuloDelModelo("a".repeat(241), lineas)).toBeNull();
    expect(preambuloDelModelo("a".repeat(240), lineas)).toBe("a".repeat(240));
  });

  it("con una cifra de dinero (aunque sea correcta) se descarta: los precios los pone el bloque", () => {
    expect(moneyFigures("Sale en $2,20")).not.toEqual([]);
    expect(preambuloDelModelo("Sale en $2,20", lineas)).toBeNull();
    expect(preambuloDelModelo("Cuesta 87 Bs", lineas)).toBeNull();
  });

  it("si trae el texto fijo o el nombre de un producto cotizado (en cualquier mayúscula), se descarta", () => {
    expect(preambuloDelModelo(TEXTO_CONFIRMAR_INVENTARIO, lineas)).toBeNull();
    expect(preambuloDelModelo(TEXTO_SIN_STOCK, lineas)).toBeNull();
    expect(preambuloDelModelo("Encontré el aceite inca 20w50 4t para ti", lineas)).toBeNull();
  });

  it("un nombre 'parecido' (dos palabras distintivas del producto) también se descarta; una sola palabra suelta no", () => {
    // El caso real: el modelo escribió "Inca 20W50 semi sintético" por "ACEITE INCA 20W50 4T".
    expect(preambuloDelModelo("Inca 20W50 semi sintético", lineas)).toBeNull();
    expect(preambuloDelModelo("Mira el aceite Inca", lineas)).toBeNull();
    expect(preambuloDelModelo("¡Claro! Mira el aceite que encontré.", lineas)).toBe("¡Claro! Mira el aceite que encontré.");
  });

  it("si habla del asesor se descarta: el texto fijo ya lo nombra y no se duplica la promesa", () => {
    expect(preambuloDelModelo("Ya te paso con un asesor.", lineas)).toBeNull();
  });

  it("si pregunta algo se descarta: el mensaje ya cierra con su propio texto fijo o con la única pregunta", () => {
    expect(preambuloDelModelo("¿Buscabas este?", lineas)).toBeNull();
  });

  it("vacío o solo espacios da null", () => {
    expect(preambuloDelModelo("   ", lineas)).toBeNull();
  });
});

describe("armarMensajeDeCotizacion — preámbulo + bloque + texto fijo LITERAL", () => {
  it("con existencia: cierra con el texto de confirmar inventario, byte a byte", () => {
    const { texto, preambulo } = armarMensajeDeCotizacion({ textoModelo: "¡Claro! Mira lo que encontré.", lineas: [inca] });

    expect(preambulo).toBe("¡Claro! Mira lo que encontré.");
    expect(texto).toBe(
      `¡Claro! Mira lo que encontré.\n\n• ACEITE INCA 20W50 4T: $2,20 BCV (Bs. 87,00) — 6 disponibles\n\n${TEXTO_CONFIRMAR_INVENTARIO}`
    );
  });

  it("todo agotado: cierra con el texto de sin stock, no con el de confirmar", () => {
    const { texto } = armarMensajeDeCotizacion({ textoModelo: "", lineas: [casco] });

    expect(texto.endsWith(TEXTO_SIN_STOCK)).toBe(true);
    expect(texto).not.toContain(TEXTO_CONFIRMAR_INVENTARIO);
  });

  it("con al menos una línea con stock en una mezcla, el texto fijo es el de confirmar (el agotado se ve en su línea)", () => {
    const { texto } = armarMensajeDeCotizacion({ textoModelo: "", lineas: [casco, inca] });

    expect(texto.endsWith(TEXTO_CONFIRMAR_INVENTARIO)).toBe(true);
    expect(texto).toContain("— Agotado");
  });

  it("sin preámbulo válido, el mensaje es el bloque y el texto fijo, sin líneas en blanco de más", () => {
    const { texto, preambulo } = armarMensajeDeCotizacion({
      textoModelo: "Sale en $99 mira.\nY además otra cosa.",
      lineas: [inca],
    });

    expect(preambulo).toBeNull();
    expect(texto.startsWith("• ACEITE INCA")).toBe(true);
    expect(texto.split("\n\n")).toHaveLength(2);
  });

  it("el nombre lo pone el código: el que invente el modelo no aparece", () => {
    const { texto } = armarMensajeDeCotizacion({ textoModelo: "Inca 20W50 semi sintético", lineas: [inca] });
    expect(texto).toContain("ACEITE INCA 20W50 4T");
    expect(texto).not.toContain("semi sintético");
  });

  it("si todo está agotado el preámbulo no se conserva: no puede dar a entender que hay", () => {
    const { texto, preambulo } = armarMensajeDeCotizacion({ textoModelo: "¡Claro que sí, tenemos ese casco!", lineas: [casco] });

    expect(preambulo).toBeNull();
    expect(texto).not.toContain("tenemos ese casco");
  });

  it("con un faltante de lista y sin ninguna línea cotizada no arma nada (no hay cotización)", () => {
    const { texto } = armarMensajeDeCotizacion({ textoModelo: "hola", lineas: [], noEncontrados: ["x"] });
    expect(texto).toBe("");
  });

  it("el mensaje armado no delata identidad (los nombres del catálogo y los textos fijos pasan la guarda)", () => {
    const { texto } = armarMensajeDeCotizacion({
      textoModelo: "",
      lineas: [{ ...inca, nombre: "AUTOMATICO HORSE" }, { ...casco, nombre: "TACOMETRO DIGITAL BERA SBR" }],
    });
    expect(revealsIdentity(texto)).toBeNull();
  });
});

describe("armarMensajeDePregunta — la única pregunta de filtro sale LITERAL", () => {
  it("sin preámbulo válido, el mensaje es la pregunta tal cual", () => {
    expect(armarMensajeDePregunta({ textoModelo: "", pregunta: PREGUNTA_FILTRO }).texto).toBe(PREGUNTA_FILTRO);
    expect(armarMensajeDePregunta({ textoModelo: "", pregunta: PREGUNTA_FILTRO_PRODUCTO }).texto).toBe(
      PREGUNTA_FILTRO_PRODUCTO
    );
  });

  it("una línea previa corta y sin cifras se conserva, y la pregunta va debajo", () => {
    const { texto, preambulo } = armarMensajeDePregunta({
      textoModelo: "¡Buenas! Con gusto te ayudo.",
      pregunta: PREGUNTA_FILTRO_PRODUCTO,
    });

    expect(preambulo).toBe("¡Buenas! Con gusto te ayudo.");
    expect(texto).toBe(`¡Buenas! Con gusto te ayudo.\n\n${PREGUNTA_FILTRO_PRODUCTO}`);
  });

  it("descarta el preámbulo si repite la pregunta, pregunta otra cosa, trae cifras o afirma que hay existencia", () => {
    for (const textoModelo of [
      PREGUNTA_FILTRO,
      "¿Y qué marca prefieres?",
      "Tenemos cascos desde $30.",
      "¡Claro, tenemos cascos!",
      "Sí hay varios modelos disponibles.",
      "Claro.\nDime más.",
      "Ya te paso con un asesor.",
    ]) {
      expect(armarMensajeDePregunta({ textoModelo, pregunta: PREGUNTA_FILTRO_PRODUCTO }).texto).toBe(
        PREGUNTA_FILTRO_PRODUCTO
      );
    }
  });
});

// ---------------------------------------------------------------------------
// A2 T5 (30/9/2026, plan "Seba no cotiza lo que no es"): el bloque pinta los
// AVISOS de la búsqueda (D1, D1b, D2, D3) con los textos literales de seba.ts,
// y la UNA alternativa con existencia de D2 (D6: singular). Ninguno puede
// mezclar un agotado con algo que tiene stock.
// ---------------------------------------------------------------------------
describe("avisos de la búsqueda en el bloque (A2)", () => {
  const renglonInca = `• ACEITE INCA 20W50 4T: ${formatQuote(2.2, 87)} — 6 disponibles`;
  const sinPedido = null;

  it("D3 relajado: la línea 'No encontré \"X\" en el nombre; esto es lo más parecido' va ARRIBA de lo cotizado", () => {
    const aviso: AvisoCatalogo = { tipo: "relajado", productoPedido: sinPedido, terminos: ["pwk"] };
    expect(armarCotizacion([inca], { avisos: [aviso] })).toBe(`${textoRelajado(["pwk"])}\n${renglonInca}`);
  });

  it("D3 relajado_agotado: la línea dice que lo más parecido está agotado y va sobre el renglón 'Agotado' (nunca un agotado a secas)", () => {
    const aviso: AvisoCatalogo = { tipo: "relajado_agotado", productoPedido: sinPedido, terminos: ["bomba"] };
    const bloque = armarCotizacion([casco], { avisos: [aviso] });
    expect(bloque).toBe(`${textoRelajadoAgotado(["bomba"])}\n• CASCO LS2 FF353 NEGRO M: ${formatQuote(95, 3800)} — Agotado`);
  });

  it("D1 universales: 'estos son universales' con la marca del cliente si los hay de su marca; singular con una sola línea", () => {
    const uno: AvisoCatalogo = { tipo: "universales", productoPedido: sinPedido, marca: null };
    expect(armarCotizacion([inca], { avisos: [uno] })).toBe(`${textoUniversales(null, 1)}\n${renglonInca}`);

    const dos = armarCotizacion([inca, { ...inca, productId: "p9", nombre: "ACEITE X" }], {
      avisos: [{ tipo: "universales", productoPedido: sinPedido, marca: "bera" }],
    });
    expect(dos.startsWith(`${textoUniversales("bera", 2)}\n`)).toBe(true);
  });

  it("D2 variante agotada con alternativa: '<variante> agotado', 'Otra opción con existencia:' y la UNA alternativa; el agotado no se nombra", () => {
    const aviso: AvisoCatalogo = { tipo: "variante_agotada", productoPedido: sinPedido, variante: "azul", conAlternativa: true };
    const alternativa = { ...inca, nombre: "TANQUE SBR ROJO", esAlternativa: true };
    const bloque = armarCotizacion([alternativa], { avisos: [aviso] });

    expect(bloque).toBe(
      `${textoVarianteAgotada("azul")}\n${OTRA_OPCION_CON_EXISTENCIA}\n• TANQUE SBR ROJO: ${formatQuote(2.2, 87)} — 6 disponibles`
    );
  });

  it("D2 variante agotada SIN alternativa: solo el renglón del agotado (no se repite el aviso)", () => {
    const aviso: AvisoCatalogo = { tipo: "variante_agotada", productoPedido: sinPedido, variante: "rojo", conAlternativa: false };
    expect(armarCotizacion([casco], { avisos: [aviso] })).toBe(
      `• CASCO LS2 FF353 NEGRO M: ${formatQuote(95, 3800)} — Agotado`
    );
  });

  it("D1 moto sin calce y D1b varias opciones no llevan renglones: la línea sola", () => {
    expect(
      armarCotizacion([], { avisos: [{ tipo: "moto_sin_calce", productoPedido: sinPedido, moto: "DT 250" }] })
    ).toBe(textoMotoSinCalce("DT 250"));
    expect(
      armarCotizacion([], { avisos: [{ tipo: "varias_opciones", productoPedido: "caucho n° trasero" }] })
    ).toBe(`*caucho n° trasero*\n${textoVariasOpciones("caucho n° trasero")}`);
  });

  it("en una lista, cada producto lleva sus avisos en su grupo, en el ORDEN PEDIDO aunque un ítem no tenga renglones", () => {
    const asiento = { ...inca, productId: "a1", nombre: "ASIENTO SBR A", productoPedido: "asiento" };
    const avisos: AvisoCatalogo[] = [
      { tipo: "varias_opciones", productoPedido: "caucho" },
      { tipo: "moto_sin_calce", productoPedido: "parrilla", moto: "DT 250" },
    ];
    const bloque = armarCotizacion([asiento], { avisos, ordenProductos: ["caucho", "asiento", "parrilla"] });

    expect(bloque.split("\n\n")).toEqual([
      `*caucho*\n${textoVariasOpciones("caucho")}`,
      `*asiento*\n• ASIENTO SBR A: ${formatQuote(2.2, 87)} — 6 disponibles`,
      `*parrilla*\n${textoMotoSinCalce("DT 250")}`,
    ]);
  });

  it("sin `ordenProductos`, los ítems con renglones van primero y los que solo tienen aviso después", () => {
    const asiento = { ...inca, productId: "a1", nombre: "ASIENTO SBR A", productoPedido: "asiento" };
    const bloque = armarCotizacion([asiento], { avisos: [{ tipo: "varias_opciones", productoPedido: "caucho" }] });
    expect(bloque.split("\n\n").map((b) => b.split("\n")[0])).toEqual(["*asiento*", "*caucho*"]);
  });

  it("un aviso de una consulta simple (productoPedido null) no lleva encabezado", () => {
    const bloque = armarCotizacion([inca], { avisos: [{ tipo: "relajado", productoPedido: null, terminos: ["x"] }] });
    expect(bloque.startsWith("*")).toBe(false);
  });
});

describe("armarMensajeDeCotizacion con avisos (A2): el cierre depende de lo que de verdad se cotizó", () => {
  it("con algo con existencia, el cierre es el de confirmar inventario", () => {
    const { texto } = armarMensajeDeCotizacion({
      textoModelo: "",
      lineas: [inca],
      avisos: [{ tipo: "universales", productoPedido: null, marca: null }],
    });
    expect(texto.endsWith(TEXTO_CONFIRMAR_INVENTARIO)).toBe(true);
    expect(texto).toContain(textoUniversales(null, 1));
  });

  it("sin ninguna línea pero con avisos (moto sin calce / varias opciones) arma el mensaje y cierra con TEXTO_ASESOR_CONFIRMA, nunca con el de 'quedan unidades'", () => {
    const { texto } = armarMensajeDeCotizacion({
      textoModelo: "",
      lineas: [],
      avisos: [{ tipo: "moto_sin_calce", productoPedido: null, moto: "DT 250" }],
    });
    expect(texto).toBe(`${textoMotoSinCalce("DT 250")}\n\n${TEXTO_ASESOR_CONFIRMA}`);
    expect(texto).not.toContain(TEXTO_CONFIRMAR_INVENTARIO);
  });

  it("todo agotado con su aviso de relajo: cierra con el texto de sin stock", () => {
    const { texto } = armarMensajeDeCotizacion({
      textoModelo: "",
      lineas: [casco],
      avisos: [{ tipo: "relajado_agotado", productoPedido: null, terminos: ["bomba"] }],
    });
    expect(texto.endsWith(TEXTO_SIN_STOCK)).toBe(true);
  });

  it("agotados mezclados con un ítem 'varias opciones': el cierre es el del asesor, no el de 'no quedan unidades'", () => {
    const { texto } = armarMensajeDeCotizacion({
      textoModelo: "",
      lineas: [{ ...casco, productoPedido: "casco" }],
      avisos: [{ tipo: "varias_opciones", productoPedido: "caucho" }],
    });
    expect(texto.endsWith(TEXTO_ASESOR_CONFIRMA)).toBe(true);
  });

  it("los avisos no delatan identidad y el mensaje con avisos no deja líneas en blanco de más", () => {
    const { texto } = armarMensajeDeCotizacion({
      textoModelo: "",
      lineas: [inca],
      avisos: [{ tipo: "relajado", productoPedido: null, terminos: ["pwk", "bomba"] }],
    });
    expect(revealsIdentity(texto)).toBeNull();
    expect(texto).not.toMatch(/\n\n\n/);
  });
});

// ---------------------------------------------------------------------------
// A2 T5: la nota de la escalada de la red de seguridad lleva UN renglón por
// cada pedido (producción del 29/9: los cinco pedidos de la lista), con lo
// que decidió la búsqueda y lo que se cotizó. Tope de 600 caracteres, el mismo
// del `resumen` de `escalarAAsesor`.
// ---------------------------------------------------------------------------
describe("notaDeBusquedas — los renglones para el asesor", () => {
  const consulta = (parcial: Partial<ConsultaCatalogo>): ConsultaCatalogo => ({
    v: 2,
    query: "asiento",
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
    ...parcial,
  });

  it("un renglón por pedido: el texto pedido, lo que decidió la búsqueda y lo cotizado", () => {
    const nota = notaDeBusquedas([
      consulta({ query: "caucho n° trasero", decision: "ítem genérico dentro de una lista (5 con existencia de 5): no se cotiza", resultado: "generico" }),
      consulta({
        query: "asiento",
        decision: "moto SBR calza: cotizó 1 (6 con existencia de 6)",
        cotizados: [{ productId: "a1", nombre: "ASIENTO SBR NEGRO ALDRICH", stock: 15, precioUsd: 2.2 }],
      }),
    ]);

    expect(nota.split("\n")).toEqual([
      "Pedidos del cliente y qué pasó con cada uno:",
      "- caucho n° trasero: ítem genérico dentro de una lista (5 con existencia de 5): no se cotiza",
      "- asiento: moto SBR calza: cotizó 1 (6 con existencia de 6) — ASIENTO SBR NEGRO ALDRICH",
    ]);
  });

  it("un pedido sin decisión escrita cae al resultado (sin_resultados, error…)", () => {
    const nota = notaDeBusquedas([consulta({ query: "llanta", decision: "", resultado: "sin_resultados" })]);
    expect(nota).toContain("- llanta: sin_resultados");
  });

  it("nunca pasa de 600 caracteres y corta en un renglón entero cuando puede", () => {
    const muchas = Array.from({ length: 30 }, (_, i) =>
      consulta({ query: `pedido ${i}`, decision: "moto DT 250 sin calce y sin universales con existencia: se escala sin cotizar" })
    );
    const nota = notaDeBusquedas(muchas);
    expect(nota.length).toBeLessThanOrEqual(600);
    expect(nota.split("\n").every((l) => l.length > 0)).toBe(true);
  });

  it("sin consultas devuelve cadena vacía", () => {
    expect(notaDeBusquedas([])).toBe("");
  });
});
