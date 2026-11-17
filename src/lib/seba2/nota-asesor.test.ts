import { describe, expect, it } from "vitest";
import type { ImageFields } from "@/lib/media-reading-fields";
import { estadoInicial, type EstadoSeba } from "./tipos";
import { notaDeComprobante, type RenglonDeNota } from "./nota-asesor";

const AHORA = new Date("2026-11-17T15:00:00Z");

function lectura(parcial: Partial<ImageFields>): ImageFields {
  return {
    tipo: "otro",
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

function comprobante(monto: number | null, moneda: "VES" | "USD" | null): ImageFields {
  return lectura({
    tipo: "comprobante_pago",
    es_comprobante_pago: true,
    comprobante: { monto, moneda, referencia: "456789", banco: "Banesco", fecha: "16/11/2026" },
  });
}

function ordenCashea(modalidad: "envio" | "retiro" | null): ImageFields {
  return lectura({ tipo: "orden_cashea", orden_cashea: { modalidad, total_usd: 45 } });
}

function estado(parcial: Partial<EstadoSeba> = {}): EstadoSeba {
  return { ...estadoInicial(AHORA), ...parcial };
}

const PEDIDO: RenglonDeNota[] = [
  { cantidad: 2, nombre: "PASTILLAS FRENO BERA SBR", saintCode: "0123", stock: 8 },
  { cantidad: 1, nombre: "CADENA 428H", saintCode: null, stock: 4 },
];

describe("notaDeComprobante", () => {
  it("arma las líneas en orden: pedido, total, forma, entrega y la captura", () => {
    const nota = notaDeComprobante({
      estado: estado({ totalUsd: 45, totalBs: 1234.5, entrega: "envio", ciudad: "Barinas" }),
      pedido: PEDIDO,
      formaLabel: "Pago móvil",
      lecturas: [comprobante(1234.5, "VES")],
    });
    const lineas = nota.split("\n");

    expect(lineas[0]).toBe("Pedido: 2 × PASTILLAS FRENO BERA SBR (SAINT 0123); 1 × CADENA 428H");
    expect(lineas[1]).toBe("Total esperado: $45,00 BCV (Bs. 1.234,50)");
    expect(lineas[2]).toBe("Forma: Pago móvil");
    expect(lineas[3]).toBe("Entrega: envío a Barinas");
    expect(lineas[4]).toContain("El cliente envió un comprobante de pago.");
    expect(lineas[4]).toContain("Bs 1.234,50");
    expect(lineas[4]).toContain("Verificar antes de confirmar: Seba no validó el pago.");
  });

  it("sin pedido armado lo dice y no inventa total, forma ni entrega", () => {
    const nota = notaDeComprobante({ estado: null, pedido: [], formaLabel: null, lecturas: [comprobante(10, "USD")] });

    expect(nota.split("\n")[0]).toBe("Pedido: sin pedido armado por Seba");
    expect(nota).not.toContain("Total esperado");
    expect(nota).not.toContain("Forma:");
    expect(nota).not.toContain("Entrega:");
  });

  it("sin lecturas dice «Sin captura legible»", () => {
    const nota = notaDeComprobante({ estado: estado(), pedido: PEDIDO, formaLabel: null, lecturas: [] });

    expect(nota).toContain("Sin captura legible");
    expect(nota).not.toContain("El cliente envió");
  });

  it("ignora las lecturas que no son comprobante ni orden de Cashea", () => {
    const nota = notaDeComprobante({
      estado: estado(),
      pedido: PEDIDO,
      formaLabel: null,
      lecturas: [lectura({ tipo: "repuesto", producto_visible: "pastillas" })],
    });

    expect(nota).toContain("Sin captura legible");
  });

  it("entrega: retiro y delivery", () => {
    const retiro = notaDeComprobante({ estado: estado({ entrega: "retiro" }), pedido: [], formaLabel: null, lecturas: [] });
    const delivery = notaDeComprobante({ estado: estado({ entrega: "delivery" }), pedido: [], formaLabel: null, lecturas: [] });

    expect(retiro).toContain("Entrega: retiro");
    expect(delivery).toContain("Entrega: delivery");
  });

  describe("DIFERENCIA", () => {
    it("en bolívares: la captura difiere de lo esperado", () => {
      const nota = notaDeComprobante({
        estado: estado({ totalBs: 1234.5, totalUsd: 45 }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [comprobante(1000, "VES")],
      });

      expect(nota).toContain("DIFERENCIA: esperado Bs. 1.234,50, leído Bs. 1.000,00");
    });

    it("en dólares: contra totalUsd", () => {
      const nota = notaDeComprobante({
        estado: estado({ totalBs: 1234.5, totalUsd: 45 }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [comprobante(40, "USD")],
      });

      expect(nota).toContain("DIFERENCIA: esperado $45,00, leído $40,00");
      expect(nota).not.toContain("esperado Bs.");
    });

    it("no la pone si coinciden al céntimo (diferencia ≤ 0,01)", () => {
      const nota = notaDeComprobante({
        estado: estado({ totalBs: 1234.5 }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [comprobante(1234.51, "VES")],
      });

      expect(nota).not.toContain("DIFERENCIA");
    });

    it("la pone si la diferencia pasa de un céntimo", () => {
      const nota = notaDeComprobante({
        estado: estado({ totalBs: 1234.5 }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [comprobante(1234.53, "VES")],
      });

      expect(nota).toContain("DIFERENCIA");
    });

    it("sin total esperado en esa moneda, o sin moneda leída, no compara", () => {
      const sinTotal = notaDeComprobante({ estado: estado(), pedido: PEDIDO, formaLabel: null, lecturas: [comprobante(1000, "VES")] });
      const sinMoneda = notaDeComprobante({
        estado: estado({ totalBs: 1234.5, totalUsd: 45 }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [comprobante(1000, null)],
      });
      const sinMonto = notaDeComprobante({
        estado: estado({ totalBs: 1234.5 }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [comprobante(null, "VES")],
      });

      expect(sinTotal).not.toContain("DIFERENCIA");
      expect(sinMoneda).not.toContain("DIFERENCIA");
      expect(sinMonto).not.toContain("DIFERENCIA");
    });

    it("dos capturas del mismo pago se suman antes de comparar (pago en dos partes)", () => {
      const nota = notaDeComprobante({
        estado: estado({ totalBs: 1000 }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [comprobante(600, "VES"), comprobante(400, "VES")],
      });

      expect(nota).not.toContain("DIFERENCIA");
    });
  });

  describe("orden de Cashea con retiro", () => {
    it("avisa cuando la orden es de retiro y el cliente pidió envío", () => {
      const nota = notaDeComprobante({
        estado: estado({ entrega: "envio", ciudad: "Barinas" }),
        pedido: PEDIDO,
        formaLabel: "Cashea",
        lecturas: [ordenCashea("retiro")],
      });

      expect(nota).toContain("ORDEN CON RETIRO EN TIENDA y el cliente pidió envío");
    });

    it("no avisa si el cliente también pidió retiro, o si la orden es de envío", () => {
      const retiroConRetiro = notaDeComprobante({
        estado: estado({ entrega: "retiro" }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [ordenCashea("retiro")],
      });
      const envioConEnvio = notaDeComprobante({
        estado: estado({ entrega: "envio" }),
        pedido: PEDIDO,
        formaLabel: null,
        lecturas: [ordenCashea("envio")],
      });

      expect(retiroConRetiro).not.toContain("ORDEN CON RETIRO EN TIENDA");
      expect(envioConEnvio).not.toContain("ORDEN CON RETIRO EN TIENDA");
    });
  });

  describe("ÚLTIMA UNIDAD", () => {
    it("avisa si algún renglón tiene existencia 1", () => {
      const nota = notaDeComprobante({
        estado: estado(),
        pedido: [{ cantidad: 1, nombre: "CASCO LS2", saintCode: null, stock: 1 }, ...PEDIDO],
        formaLabel: null,
        lecturas: [comprobante(10, "USD")],
      });

      expect(nota).toContain("ÚLTIMA UNIDAD: verificar existencia antes de confirmar");
    });

    it("no avisa con existencia 0 ni con 2 o más", () => {
      const nota = notaDeComprobante({
        estado: estado(),
        pedido: [
          { cantidad: 1, nombre: "A", saintCode: null, stock: 0 },
          { cantidad: 1, nombre: "B", saintCode: null, stock: 2 },
        ],
        formaLabel: null,
        lecturas: [comprobante(10, "USD")],
      });

      expect(nota).not.toContain("ÚLTIMA UNIDAD");
    });
  });

  describe("tope de 900 caracteres", () => {
    const pedidoLargo: RenglonDeNota[] = Array.from({ length: 30 }, (_, i) => ({
      cantidad: 2,
      nombre: `PRODUCTO DE NOMBRE MUY LARGO NUMERO ${i}`,
      saintCode: `${1000 + i}`,
      stock: 1,
    }));

    it("nunca pasa de 900 y conserva las advertencias aunque el pedido sea enorme", () => {
      const nota = notaDeComprobante({
        estado: estado({ totalBs: 1234.5, totalUsd: 45, entrega: "envio", ciudad: "Barinas" }),
        pedido: pedidoLargo,
        formaLabel: "Cashea",
        lecturas: [comprobante(1000, "VES"), comprobante(20, "USD"), ordenCashea("retiro")],
      });

      expect(nota.length).toBeLessThanOrEqual(900);
      expect(nota).toContain("DIFERENCIA");
      expect(nota).toContain("ORDEN CON RETIRO EN TIENDA y el cliente pidió envío");
      expect(nota).toContain("ÚLTIMA UNIDAD: verificar existencia antes de confirmar");
      expect(nota).toContain("Verificar antes de confirmar: Seba no validó el pago.");
    });

    it("una nota normal no se recorta", () => {
      const nota = notaDeComprobante({ estado: estado(), pedido: PEDIDO, formaLabel: null, lecturas: [comprobante(10, "USD")] });

      // (el «…» de «ref. …456789» es de la captura, no un recorte)
      expect(nota).toContain("1 × CADENA 428H");
      expect(nota).toContain("ref. …456789");
    });
  });
});
