import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as textos from "./textos";
import {
  ENCABEZADO_PEDIDO,
  ETIQUETA_TOTAL,
  ETIQUETA_TOTAL_CON_ENVIO,
  LINEA_ASESOR_BINANCE,
  LINEA_ENVIO_GRATIS_CASHEA,
  LINEA_PEDIR_COMPROBANTE,
  TEXTO_COMPROBANTE_RECIBIDO,
  TEXTO_NO_PUDE_LEER,
  TEXTO_PASE,
  TEXTO_UN_ASESOR_TE_CONFIRMA,
  lineaCedulaCashea,
  lineaTiendaCerrada,
} from "./textos";

const DOCUMENTO = readFileSync(path.join(process.cwd(), "docs/seba-v2/system-prompt-seba-v2.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** El contenido del primer bloque ```text que sigue a `ancla` en el documento. */
function bloqueTrasAncla(ancla: string): string {
  const desde = DOCUMENTO.indexOf(ancla);
  expect(desde, `no encontré «${ancla}» en el documento`).toBeGreaterThanOrEqual(0);
  const apertura = DOCUMENTO.indexOf("```text\n", desde);
  expect(apertura).toBeGreaterThan(desde);
  const inicio = apertura + "```text\n".length;
  const cierre = DOCUMENTO.indexOf("\n```", inicio);
  return DOCUMENTO.slice(inicio, cierre);
}

/** Todos los textos (cadenas) que exporta el módulo, con las funciones ya evaluadas. */
function todosLosTextos(): string[] {
  const salida: string[] = [];
  for (const valor of Object.values(textos)) {
    if (typeof valor === "string") salida.push(valor);
    else if (typeof valor === "function") {
      salida.push((valor as (x: never) => string)(true as never));
      salida.push((valor as (x: never) => string)(false as never));
      salida.push((valor as (x: never) => string)("el lunes a las 8:00 am" as never));
    } else if (valor && typeof valor === "object") {
      salida.push(...Object.values(valor as Record<string, string>));
    }
  }
  return salida;
}

describe("textos de pase por área", () => {
  it("cada área tiene su texto, sin nombre propio ni promesas de pago", () => {
    expect(TEXTO_PASE).toEqual({
      ventas: "Ya pasé tu caso a un asesor de ventas, te escribe por este mismo chat.",
      pagos: "Ya pasé tu caso al área de pagos, te escriben por este mismo chat.",
      envios: "Ya pasé tu caso al área de envíos, te escriben por este mismo chat.",
      reclamos: "Lamentamos lo ocurrido. Ya pasé tu caso al área de reclamos y te escriben por este mismo chat.",
    });
  });
});

describe("textos fijos del documento de diseño", () => {
  it("el comprobante recibido es el bloque de §3, byte por byte", () => {
    expect(TEXTO_COMPROBANTE_RECIBIDO).toBe(bloqueTrasAncla("**Comprobante recibido**"));
    expect(TEXTO_COMPROBANTE_RECIBIDO).toBe(
      "¡Gracias! Recibimos tu comprobante ✅\nUn asesor lo verifica y te confirma por este mismo chat.",
    );
  });

  it("la línea de pedir comprobante, el encabezado y las etiquetas salen del documento", () => {
    const datos = bloqueTrasAncla("**Datos de pago**");
    expect(datos).toContain(ENCABEZADO_PEDIDO);
    expect(datos).toContain(LINEA_PEDIR_COMPROBANTE);
    expect(datos).toContain(`${ETIQUETA_TOTAL}:`);
    expect(ENCABEZADO_PEDIDO).toBe("Tu pedido:");
    expect(LINEA_PEDIR_COMPROBANTE).toBe("Cuando pagues, envíame el capture del comprobante 🙌");
    expect(ETIQUETA_TOTAL).toBe("Total");
    expect(ETIQUETA_TOTAL_CON_ENVIO).toBe("Total con envío MRW incluido");
  });

  it("las líneas de Cashea y Binance salen del documento", () => {
    expect(bloqueTrasAncla("Con Cashea (el enlace lo manda el asesor")).toContain(LINEA_ENVIO_GRATIS_CASHEA);
    expect(bloqueTrasAncla("Con Binance (el monto en divisa")).toContain(LINEA_ASESOR_BINANCE);
    expect(LINEA_ENVIO_GRATIS_CASHEA).toBe("envío gratis con Cashea");
    expect(LINEA_ASESOR_BINANCE).toBe(
      "Un asesor te confirma el monto en divisa y los datos de Binance por este mismo chat.",
    );
  });

  it("la cédula de Cashea, con y sin talla", () => {
    expect(lineaCedulaCashea(false)).toBe("Mientras tanto, pásame la cédula del titular de Cashea.");
    expect(lineaCedulaCashea(true)).toBe("Mientras tanto, pásame la cédula del titular de Cashea y la talla.");
  });

  it("la línea de tienda cerrada nombra cuándo abre", () => {
    expect(lineaTiendaCerrada("el lunes a las 8:00 am")).toBe(
      "La tienda abre el lunes a las 8:00 am; apenas abramos lo revisan.",
    );
  });
});

describe("textos de respaldo", () => {
  it("no explican el motivo interno", () => {
    expect(TEXTO_UN_ASESOR_TE_CONFIRMA).toBe("Un asesor te lo confirma por este mismo chat.");
    expect(TEXTO_NO_PUDE_LEER).toBe("No pude ver bien lo que enviaste. ¿Me lo escribes, por favor?");
  });
});

describe("lo que ningún texto fijo puede decir", () => {
  const textosFijos = todosLosTextos();

  it("se evaluaron los textos (la prueba no es vacua)", () => {
    expect(textosFijos.length).toBeGreaterThanOrEqual(18);
  });

  it.each(["seba", "gracias por tu compra", "verificado", "aprobado", "confirmado"])(
    "ninguno contiene «%s»",
    (prohibido) => {
      for (const texto of textosFijos) {
        expect(texto.toLowerCase(), texto).not.toContain(prohibido);
      }
    },
  );

  it("ninguno trae una arroba ni 7 o más dígitos seguidos (el repo es público)", () => {
    for (const texto of textosFijos) {
      expect(texto, texto).not.toContain("@");
      expect(texto, texto).not.toMatch(/\d{7,}/);
    }
  });
});
