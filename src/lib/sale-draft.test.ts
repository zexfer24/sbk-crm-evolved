import { describe, expect, it } from "vitest";
import {
  isValidCedulaNumber,
  normalizeSaint,
  SALE_FIELD_LABELS,
  validateSaleDraft,
  type SaleDraft,
} from "@/lib/sale-draft";

/**
 * Borrador válido de referencia: los nueve campos obligatorios de D11 (plan
 * "Nada sin leer, un solo catálogo y la factura Saint", 18/9/2026) más
 * `itemCount`, que no es uno de los nueve —esa regla ("al menos un
 * repuesto") es previa a este plan y sigue viviendo aparte, en
 * `close-sale-modal.tsx`, con su propio aviso— pero viaja en el borrador
 * porque representa TODO lo que hace falta para cerrar la venta.
 */
function draftCompleto(overrides: Partial<SaleDraft> = {}): SaleDraft {
  return {
    displayName: "Cliente Demo",
    whatsappNumber: "+58123456789",
    cedulaType: "V",
    cedulaNumber: "12345678",
    state: "Barinas",
    city: "Barinas",
    address: "Calle Falsa 123",
    paymentMethod: "pago_movil",
    saintInvoiceNumber: "00123",
    paymentProofUrl: "https://example.com/proof.jpg",
    itemCount: 1,
    ...overrides,
  };
}

describe("validateSaleDraft — los nueve campos obligatorios de D11", () => {
  it("un borrador completo no deja ningún error", () => {
    expect(validateSaleDraft(draftCompleto())).toEqual({});
  });

  it("nombre vacío (o solo espacios) es obligatorio", () => {
    expect(validateSaleDraft(draftCompleto({ displayName: "" })).displayName).toBeTruthy();
    expect(validateSaleDraft(draftCompleto({ displayName: "   " })).displayName).toBeTruthy();
  });

  it("el número de WhatsApp es obligatorio", () => {
    expect(validateSaleDraft(draftCompleto({ whatsappNumber: "" })).whatsappNumber).toBeTruthy();
  });

  it("sin tipo de cédula (V/E) elegido, marca el error en «cedula»", () => {
    expect(validateSaleDraft(draftCompleto({ cedulaType: "" })).cedula).toBeTruthy();
  });

  it("cédula de 4 dígitos se rechaza (debajo del mínimo de 5)", () => {
    expect(validateSaleDraft(draftCompleto({ cedulaNumber: "1234" })).cedula).toBeTruthy();
  });

  it("cédula de 11 dígitos se rechaza (encima del máximo de 10)", () => {
    expect(validateSaleDraft(draftCompleto({ cedulaNumber: "12345678901" })).cedula).toBeTruthy();
  });

  it("cédula de 5 dígitos (el mínimo) se acepta", () => {
    expect(validateSaleDraft(draftCompleto({ cedulaNumber: "12345" })).cedula).toBeUndefined();
  });

  it("cédula de 10 dígitos (el máximo) se acepta", () => {
    expect(validateSaleDraft(draftCompleto({ cedulaNumber: "1234567890" })).cedula).toBeUndefined();
  });

  it("cédula con letras o guiones se rechaza", () => {
    expect(validateSaleDraft(draftCompleto({ cedulaNumber: "12-345" })).cedula).toBeTruthy();
  });

  it("estado sin elegir es obligatorio", () => {
    expect(validateSaleDraft(draftCompleto({ state: "" })).state).toBeTruthy();
  });

  it("ciudad vacía (o solo espacios) es obligatoria", () => {
    expect(validateSaleDraft(draftCompleto({ city: "" })).city).toBeTruthy();
    expect(validateSaleDraft(draftCompleto({ city: "  " })).city).toBeTruthy();
  });

  it("dirección vacía (o solo espacios) es obligatoria", () => {
    expect(validateSaleDraft(draftCompleto({ address: "" })).address).toBeTruthy();
    expect(validateSaleDraft(draftCompleto({ address: "   " })).address).toBeTruthy();
  });

  it("método de pago sin elegir es obligatorio", () => {
    expect(validateSaleDraft(draftCompleto({ paymentMethod: "" })).paymentMethod).toBeTruthy();
  });

  it("factura Saint vacía (o solo espacios) es obligatoria", () => {
    expect(validateSaleDraft(draftCompleto({ saintInvoiceNumber: "" })).saintInvoiceNumber).toBeTruthy();
    expect(validateSaleDraft(draftCompleto({ saintInvoiceNumber: "   " })).saintInvoiceNumber).toBeTruthy();
  });

  it("factura Saint de 41 caracteres (encima del tope) se rechaza", () => {
    const larga = "1".repeat(41);
    expect(validateSaleDraft(draftCompleto({ saintInvoiceNumber: larga })).saintInvoiceNumber).toBeTruthy();
  });

  it("factura Saint de 40 caracteres (el tope exacto) se acepta", () => {
    const justoEnElTope = "1".repeat(40);
    expect(validateSaleDraft(draftCompleto({ saintInvoiceNumber: justoEnElTope })).saintInvoiceNumber).toBeUndefined();
  });

  it("comprobante sin elegir ni subir es obligatorio", () => {
    expect(validateSaleDraft(draftCompleto({ paymentProofUrl: null })).paymentProofUrl).toBeTruthy();
  });

  it("un borrador con TODOS los campos inválidos marca los nueve", () => {
    const errors = validateSaleDraft(
      draftCompleto({
        displayName: "",
        whatsappNumber: "",
        cedulaType: "",
        cedulaNumber: "",
        state: "",
        city: "",
        address: "",
        paymentMethod: "",
        saintInvoiceNumber: "",
        paymentProofUrl: null,
      })
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        "address",
        "cedula",
        "city",
        "displayName",
        "paymentMethod",
        "paymentProofUrl",
        "saintInvoiceNumber",
        "state",
        "whatsappNumber",
      ].sort()
    );
  });
});

describe("SALE_FIELD_LABELS — una etiqueta por cada uno de los nueve campos", () => {
  it("trae exactamente los nueve campos de D11, con su etiqueta en español", () => {
    expect(SALE_FIELD_LABELS).toEqual({
      displayName: "Nombre",
      whatsappNumber: "Número de WhatsApp",
      cedula: "Cédula",
      state: "Estado",
      city: "Ciudad",
      address: "Dirección",
      paymentMethod: "Método de pago",
      saintInvoiceNumber: "Número de factura Saint",
      paymentProofUrl: "Comprobante de pago",
    });
  });
});

describe("isValidCedulaNumber", () => {
  it("acepta de 5 a 10 dígitos", () => {
    expect(isValidCedulaNumber("12345")).toBe(true);
    expect(isValidCedulaNumber("1234567890")).toBe(true);
  });

  it("rechaza menos de 5 o más de 10 dígitos", () => {
    expect(isValidCedulaNumber("1234")).toBe(false);
    expect(isValidCedulaNumber("12345678901")).toBe(false);
  });

  it("rechaza cualquier cosa que no sean solo dígitos", () => {
    expect(isValidCedulaNumber("123abc")).toBe(false);
    expect(isValidCedulaNumber("")).toBe(false);
  });
});

describe("normalizeSaint — recorta y colapsa espacios", () => {
  it("recorta espacios al inicio y al final", () => {
    expect(normalizeSaint("  00123  ")).toBe("00123");
  });

  it("colapsa espacios internos repetidos a uno solo", () => {
    expect(normalizeSaint("00123   ABC")).toBe("00123 ABC");
  });

  it("una cadena de solo espacios normaliza a vacío", () => {
    expect(normalizeSaint("    ")).toBe("");
  });
});
