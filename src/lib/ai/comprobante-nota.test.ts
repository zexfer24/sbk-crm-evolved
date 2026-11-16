import { describe, expect, it } from "vitest";
import { resumenDeComprobante } from "@/lib/ai/comprobante-nota";
import type { ImageFields } from "@/lib/media-reading-fields";

function campos(parcial: Partial<ImageFields>): ImageFields {
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

const CIERRE = "Verificar antes de confirmar: Seba no validó el pago.";

describe("resumenDeComprobante", () => {
  it("comprobante completo: dice qué leyó, con formato es-VE, y cierra pidiendo verificar", () => {
    const resumen = resumenDeComprobante([
      campos({
        tipo: "comprobante_pago",
        es_comprobante_pago: true,
        comprobante: { monto: 1234.5, moneda: "VES", referencia: "456789", banco: "Banesco", fecha: "16/11/2026" },
      }),
    ]);

    expect(resumen).toBe(
      `El cliente envió un comprobante de pago. Leído de la captura: Bs 1.234,50 · ref. …456789 · Banesco · 16/11/2026. ${CIERRE}`
    );
  });

  it("moneda USD usa el signo de dólar", () => {
    const resumen = resumenDeComprobante([
      campos({
        es_comprobante_pago: true,
        comprobante: { monto: 45, moneda: "USD", referencia: null, banco: null, fecha: null },
      }),
    ]);

    expect(resumen).toContain("Leído de la captura: $45,00.");
  });

  it("monto sin moneda: solo el número", () => {
    const resumen = resumenDeComprobante([
      campos({
        es_comprobante_pago: true,
        comprobante: { monto: 1000000, moneda: null, referencia: null, banco: null, fecha: null },
      }),
    ]);

    expect(resumen).toContain("Leído de la captura: 1.000.000,00.");
  });

  it("comprobante con todo en null: sin la frase de lo leído", () => {
    const resumen = resumenDeComprobante([
      campos({
        es_comprobante_pago: true,
        comprobante: { monto: null, moneda: null, referencia: null, banco: null, fecha: null },
      }),
    ]);

    expect(resumen).toBe(`El cliente envió un comprobante de pago. ${CIERRE}`);
  });

  it("comprobante sin objeto `comprobante` (solo la bandera): igual", () => {
    expect(resumenDeComprobante([campos({ tipo: "comprobante_pago", es_comprobante_pago: true })])).toBe(
      `El cliente envió un comprobante de pago. ${CIERRE}`
    );
  });

  it("orden de Cashea con retiro en tienda: trae el OJO", () => {
    const resumen = resumenDeComprobante([
      campos({ tipo: "orden_cashea", orden_cashea: { modalidad: "retiro", total_usd: 45 } }),
    ]);

    expect(resumen).toBe(
      `El cliente envió una orden de Cashea. Orden de Cashea: retiro en tienda · total $45,00. OJO: la orden quedó con RETIRO EN TIENDA; confirmar con el cliente si quería envío. ${CIERRE}`
    );
  });

  it("orden de Cashea con envío: sin OJO", () => {
    const resumen = resumenDeComprobante([
      campos({ tipo: "orden_cashea", orden_cashea: { modalidad: "envio", total_usd: 120.5 } }),
    ]);

    expect(resumen).toBe(`El cliente envió una orden de Cashea. Orden de Cashea: envío · total $120,50. ${CIERRE}`);
    expect(resumen).not.toContain("OJO");
  });

  it("orden de Cashea sin datos: solo la primera frase y el cierre", () => {
    expect(resumenDeComprobante([campos({ tipo: "orden_cashea" })])).toBe(
      `El cliente envió una orden de Cashea. ${CIERRE}`
    );
  });

  it("las dos cosas juntas: la primera frase nombra las dos y salen los dos bloques", () => {
    const resumen = resumenDeComprobante([
      campos({
        es_comprobante_pago: true,
        comprobante: { monto: 10, moneda: "USD", referencia: "000123", banco: null, fecha: null },
      }),
      campos({ tipo: "orden_cashea", orden_cashea: { modalidad: "retiro", total_usd: null } }),
    ]);

    expect(resumen).toBe(
      `El cliente envió un comprobante de pago y una orden de Cashea. Leído de la captura: $10,00 · ref. …000123. Orden de Cashea: retiro en tienda. OJO: la orden quedó con RETIRO EN TIENDA; confirmar con el cliente si quería envío. ${CIERRE}`
    );
  });

  it("dos comprobantes: una frase de lo leído por cada captura", () => {
    const resumen = resumenDeComprobante([
      campos({
        es_comprobante_pago: true,
        comprobante: { monto: 10, moneda: "USD", referencia: null, banco: null, fecha: null },
      }),
      campos({
        es_comprobante_pago: true,
        comprobante: { monto: 20, moneda: "USD", referencia: null, banco: null, fecha: null },
      }),
    ]);

    expect(resumen).toContain("Leído de la captura: $10,00. Leído de la captura: $20,00.");
  });

  it("jamás pasa de 600 caracteres, y el cierre siempre se conserva", () => {
    const muchos = Array.from({ length: 30 }, (_, i) =>
      campos({
        es_comprobante_pago: true,
        comprobante: {
          monto: 1000 + i,
          moneda: "VES",
          referencia: "123456",
          banco: "Banco Nacional de Crédito de Venezuela",
          fecha: "16/11/2026",
        },
      })
    );
    muchos.push(campos({ tipo: "orden_cashea", orden_cashea: { modalidad: "retiro", total_usd: 45 } }));

    const resumen = resumenDeComprobante(muchos);

    expect(resumen.length).toBeLessThanOrEqual(600);
    expect(resumen.endsWith(CIERRE)).toBe(true);
    expect(resumen).toContain("OJO: la orden quedó con RETIRO EN TIENDA");
  });

  it("un banco larguísimo no revienta el tope", () => {
    const resumen = resumenDeComprobante([
      campos({
        es_comprobante_pago: true,
        comprobante: { monto: 1, moneda: "USD", referencia: null, banco: "B".repeat(2000), fecha: null },
      }),
    ]);

    expect(resumen.length).toBeLessThanOrEqual(600);
    expect(resumen.endsWith(CIERRE)).toBe(true);
  });
});
