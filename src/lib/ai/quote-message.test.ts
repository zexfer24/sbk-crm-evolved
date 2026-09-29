import { describe, expect, it } from "vitest";
import {
  armarCotizacion,
  armarMensajeDeCotizacion,
  armarMensajeDePregunta,
  preambuloDelModelo,
} from "@/lib/ai/quote-message";
import { moneyFigures } from "@/lib/ai/price-guard";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import { formatQuote } from "@/lib/ai/precio";
import {
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_SIN_STOCK,
} from "@/lib/ai/seba";

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
