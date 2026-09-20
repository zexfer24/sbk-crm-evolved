import { describe, expect, it } from "vitest";
import {
  isValidCedulaNumber,
  normalizeSaint,
  SALE_FIELD_LABELS,
  validateSaleCart,
  validateSaleDraft,
  type SaleDraft,
} from "@/lib/sale-draft";

/**
 * Borrador válido de referencia: los nueve campos obligatorios de D11 (plan
 * "Nada sin leer, un solo catálogo y la factura Saint", 18/9/2026). El
 * carrito NO es uno de los nueve —esa regla ("al menos un repuesto") es
 * previa a este plan y se valida aparte, con `validateSaleCart`— así que
 * `SaleDraft` ya no lo lleva (retirado en la corrección R2 del 19/9/2026,
 * ver el docblock de `SaleDraft` en `sale-draft.ts`).
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

// Corrección R2 (revisión `code-review high` del 19/9/2026, plan "Nada sin
// leer, un solo catálogo y la factura Saint"): `closeSaleWithContactInfo`
// pasaba `itemCount` a `validateSaleDraft`, que nunca lo miraba —la regla
// "al menos un repuesto" vivía solo en el toast del modal, sin una función
// compartida que la mutación pudiera correr como segunda barrera de verdad.
// `validateSaleCart` es esa función: pura, sin meter el carrito entre los
// nueve campos de `validateSaleDraft` (no tiene un único `<input>` al que
// atarle un error de formulario, D11 sigue siendo solo esos nueve).
describe("validateSaleCart — el carrito no es uno de los nueve campos, pero sigue siendo obligatorio", () => {
  it("un carrito vacío devuelve un mensaje", () => {
    expect(validateSaleCart(0)).toBeTruthy();
  });

  it("un carrito con al menos un renglón no devuelve error", () => {
    expect(validateSaleCart(1)).toBeNull();
    expect(validateSaleCart(3)).toBeNull();
  });
});

describe("normalizeSaint — recorta y colapsa espacios", () => {
  it("recorta espacios al inicio y al final", () => {
    expect(normalizeSaint("  00123  ")).toBe("00123");
  });

  it("colapsa espacios internos repetidos a uno solo", () => {
    expect(normalizeSaint("00123   ABC")).toBe("00123 ABC");
  });

  // T3-b (plan "El resguardo antes del push", 20/9/2026): un solo grupo de
  // espacios de más no distingue la regex con flag `g` de una sin ella —las
  // dos colapsan igual cuando hay UN solo grupo. Con DOS grupos separados de
  // espacios repetidos, la regex SIN `g` solo reemplaza el primero (el
  // comportamiento de `String.prototype.replace` con una regex no global) y
  // deja el segundo intacto.
  it("colapsa CADA grupo de espacios repetidos, no solo el primero", () => {
    expect(normalizeSaint("00123   ABC    DEF")).toBe("00123 ABC DEF");
  });

  it("una cadena de solo espacios normaliza a vacío", () => {
    expect(normalizeSaint("    ")).toBe("");
  });
});
