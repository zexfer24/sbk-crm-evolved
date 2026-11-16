import { describe, expect, it } from "vitest";
import {
  IMAGE_TIPOS,
  esComprobante,
  esOrdenCashea,
  formatoMontoVE,
  parseImageFields,
  partesDeComprobante,
  partesDeOrdenCashea,
  ultimosSeisDigitos,
  type ImageFields,
} from "@/lib/media-reading-fields";

function campos(parcial: Partial<ImageFields> = {}): ImageFields {
  return {
    tipo: "repuesto",
    es_comprobante_pago: false,
    texto_visible: "",
    producto_visible: null,
    marca_visible: null,
    modelo_moto_visible: null,
    medida_visible: null,
    comprobante: null,
    orden_cashea: null,
    ...parcial,
  };
}

describe("parseImageFields", () => {
  it("lee un objeto completo tal cual", () => {
    const completo = {
      tipo: "comprobante_pago",
      es_comprobante_pago: true,
      texto_visible: "Pago móvil",
      producto_visible: null,
      marca_visible: null,
      modelo_moto_visible: null,
      medida_visible: null,
      comprobante: { monto: 1234.5, moneda: "VES", referencia: "456789", banco: "Banesco", fecha: "16/11/2026" },
      orden_cashea: null,
    };

    expect(parseImageFields(completo)).toEqual(completo);
  });

  it("devuelve null con null, undefined, un string o un arreglo", () => {
    expect(parseImageFields(null)).toBeNull();
    expect(parseImageFields(undefined)).toBeNull();
    expect(parseImageFields("repuesto")).toBeNull();
    expect(parseImageFields([])).toBeNull();
  });

  it("devuelve null si el tipo no es válido o falta", () => {
    expect(parseImageFields({ tipo: "gato" })).toBeNull();
    expect(parseImageFields({})).toBeNull();
  });

  it("acepta todos los tipos de la lista cerrada", () => {
    for (const tipo of IMAGE_TIPOS) {
      expect(parseImageFields({ tipo })?.tipo).toBe(tipo);
    }
  });

  it("un campo ausente o de tipo equivocado cae a su vacío, sin lanzar", () => {
    const leido = parseImageFields({
      tipo: "moto",
      es_comprobante_pago: "sí",
      texto_visible: 42,
      producto_visible: 7,
      marca_visible: "  ",
      comprobante: "no",
      orden_cashea: { modalidad: "mensajero", total_usd: "caro" },
    });

    expect(leido).toEqual(
      campos({
        tipo: "moto",
        orden_cashea: { modalidad: null, total_usd: null },
      }),
    );
  });

  it("un comprobante con moneda inválida conserva el resto y deja la moneda en null", () => {
    const leido = parseImageFields({
      tipo: "comprobante_pago",
      comprobante: { monto: 10, moneda: "EUR", referencia: "123", banco: null, fecha: null },
    });

    expect(leido?.comprobante).toEqual({ monto: 10, moneda: null, referencia: "123", banco: null, fecha: null });
  });

  it("un monto que no es un número finito queda en null", () => {
    const leido = parseImageFields({
      tipo: "comprobante_pago",
      comprobante: { monto: Number.NaN, moneda: "USD" },
    });

    expect(leido?.comprobante?.monto).toBeNull();
    expect(leido?.comprobante?.moneda).toBe("USD");
  });
});

describe("ultimosSeisDigitos", () => {
  it("deja solo los últimos seis dígitos", () => {
    expect(ultimosSeisDigitos("ref 0001-234567")).toBe("234567");
    expect(ultimosSeisDigitos("000123456789")).toBe("456789");
  });

  it("con menos de seis dígitos devuelve los que haya", () => {
    expect(ultimosSeisDigitos("ab123")).toBe("123");
  });

  it("devuelve null si no queda ningún dígito", () => {
    expect(ultimosSeisDigitos("abc")).toBeNull();
    expect(ultimosSeisDigitos("")).toBeNull();
    expect(ultimosSeisDigitos(null)).toBeNull();
    expect(ultimosSeisDigitos(undefined)).toBeNull();
  });
});

describe("esComprobante / esOrdenCashea", () => {
  it("es comprobante por la bandera o por el tipo", () => {
    expect(esComprobante(campos({ es_comprobante_pago: true }))).toBe(true);
    expect(esComprobante(campos({ tipo: "comprobante_pago" }))).toBe(true);
    expect(esComprobante(campos())).toBe(false);
    expect(esComprobante(null)).toBe(false);
    expect(esComprobante(undefined)).toBe(false);
  });

  it("es orden de Cashea solo por el tipo", () => {
    expect(esOrdenCashea(campos({ tipo: "orden_cashea" }))).toBe(true);
    expect(esOrdenCashea(campos({ tipo: "captura_de_chat_o_publicacion" }))).toBe(false);
    expect(esOrdenCashea(null)).toBe(false);
  });
});

// C5, corrección de la revisión de código (16/11/2026): el formato de lo leído
// de un comprobante vivía copiado en la vista del asesor y en la nota que lee
// el asesor al recibir el traspaso, y las dos copias ya habían divergido
// (`$ 1.234,50` contra `$1.234,50`). Ahora hay una sola.
describe("formatoMontoVE", () => {
  it("agrupa miles con punto y decimales con coma, siempre con dos decimales", () => {
    expect(formatoMontoVE(1234.5)).toBe("1.234,50");
    expect(formatoMontoVE(0)).toBe("0,00");
    expect(formatoMontoVE(20)).toBe("20,00");
    expect(formatoMontoVE(1234567.891)).toBe("1.234.567,89");
  });

  it("un negativo lleva el signo delante", () => {
    expect(formatoMontoVE(-1234.5)).toBe("-1.234,50");
  });
});

describe("partesDeComprobante", () => {
  it("un comprobante completo en bolívares: monto con 'Bs ', referencia, banco y fecha", () => {
    expect(
      partesDeComprobante({ monto: 1234.5, moneda: "VES", referencia: "456789", banco: "Banesco", fecha: "16/11/2026" }),
    ).toEqual(["Bs 1.234,50", "ref. …456789", "Banesco", "16/11/2026"]);
  });

  it("en dólares el símbolo va pegado al monto, sin espacio", () => {
    expect(partesDeComprobante({ monto: 1234.5, moneda: "USD", referencia: null, banco: null, fecha: null })).toEqual([
      "$1.234,50",
    ]);
  });

  it("sin moneda el monto va sin símbolo", () => {
    expect(partesDeComprobante({ monto: 20, moneda: null, referencia: null, banco: null, fecha: null })).toEqual(["20,00"]);
  });

  it("omite lo que es null, y un comprobante vacío da una lista vacía", () => {
    expect(partesDeComprobante({ monto: null, moneda: "VES", referencia: "123456", banco: null, fecha: null })).toEqual([
      "ref. …123456",
    ]);
    expect(partesDeComprobante({ monto: null, moneda: null, referencia: null, banco: null, fecha: null })).toEqual([]);
  });
});

describe("partesDeOrdenCashea", () => {
  it("modalidad capitalizada y total pegado al signo $", () => {
    expect(partesDeOrdenCashea({ modalidad: "envio", total_usd: 45 })).toEqual(["Envío", "total $45,00"]);
    expect(partesDeOrdenCashea({ modalidad: "retiro", total_usd: 1234.5 })).toEqual([
      "Retiro en tienda",
      "total $1.234,50",
    ]);
  });

  it("omite lo que es null, y una orden vacía da una lista vacía", () => {
    expect(partesDeOrdenCashea({ modalidad: "retiro", total_usd: null })).toEqual(["Retiro en tienda"]);
    expect(partesDeOrdenCashea({ modalidad: null, total_usd: 45 })).toEqual(["total $45,00"]);
    expect(partesDeOrdenCashea({ modalidad: null, total_usd: null })).toEqual([]);
  });
});
