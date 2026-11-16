import { describe, expect, it } from "vitest";
import {
  PAYMENT_METHOD_CURRENCIES,
  PAYMENT_METHOD_CURRENCY_LABELS,
  PAYMENT_METHOD_KEY_PATTERN,
  RESERVED_PAYMENT_METHOD_KEYS,
  nextPaymentMethodSortOrder,
  paymentMethodKeyFromLabel,
  validatePaymentMethodDraft,
  type PaymentMethodDraft,
} from "@/lib/payment-methods";

const OK: PaymentMethodDraft = {
  key: "pago_movil",
  label: "Pago móvil",
  currency: "VES",
  instructions: "Banco X, cédula Y, teléfono Z.",
  sebaEntrega: true,
};

describe("constantes", () => {
  it("monedas, etiquetas, patrón y claves reservadas", () => {
    expect([...PAYMENT_METHOD_CURRENCIES]).toEqual(["VES", "USD"]);
    expect(PAYMENT_METHOD_CURRENCY_LABELS).toEqual({ VES: "Bolívares", USD: "Dólares" });
    expect(PAYMENT_METHOD_KEY_PATTERN.source).toBe("^[a-z_]{3,30}$");
    expect([...RESERVED_PAYMENT_METHOD_KEYS]).toEqual(["cashea"]);
  });
});

describe("validatePaymentMethodDraft", () => {
  it("un borrador correcto no da errores", () => {
    expect(validatePaymentMethodDraft(OK)).toEqual({});
  });

  it("clave: pago_movil entra; mayúsculas, muy corta, guion medio y 31 letras no", () => {
    const mensaje = "La clave usa solo minúsculas y guion bajo, entre 3 y 30 caracteres.";
    expect(validatePaymentMethodDraft({ ...OK, key: "abc" }).key).toBeUndefined();
    expect(validatePaymentMethodDraft({ ...OK, key: "a".repeat(30) }).key).toBeUndefined();
    expect(validatePaymentMethodDraft({ ...OK, key: "PagoMovil" }).key).toBe(mensaje);
    expect(validatePaymentMethodDraft({ ...OK, key: "ab" }).key).toBe(mensaje);
    expect(validatePaymentMethodDraft({ ...OK, key: "pago-movil" }).key).toBe(mensaje);
    expect(validatePaymentMethodDraft({ ...OK, key: "a".repeat(31) }).key).toBe(mensaje);
    expect(validatePaymentMethodDraft({ ...OK, key: "" }).key).toBe(mensaje);
    expect(validatePaymentMethodDraft({ ...OK, key: "pago movil" }).key).toBe(mensaje);
  });

  it("'cashea' está reservada: se configura aparte", () => {
    expect(validatePaymentMethodDraft({ ...OK, key: "cashea" }).key).toBe(
      '"cashea" no es una forma de contado: se configura aparte.'
    );
  });

  it("clave repetida solo se detecta si se pasan las existentes (al crear)", () => {
    expect(validatePaymentMethodDraft(OK).key).toBeUndefined();
    expect(validatePaymentMethodDraft(OK, { existingKeys: ["zelle", "pago_movil"] }).key).toBe(
      "Ya existe una forma de pago con esa clave."
    );
    expect(validatePaymentMethodDraft(OK, { existingKeys: ["zelle"] }).key).toBeUndefined();
  });

  it("etiqueta: vacía tras recortar, 60 entra, 61 no", () => {
    expect(validatePaymentMethodDraft({ ...OK, label: "   " }).label).toBe("Escribe el nombre de la forma de pago.");
    expect(validatePaymentMethodDraft({ ...OK, label: "a".repeat(60) }).label).toBeUndefined();
    expect(validatePaymentMethodDraft({ ...OK, label: "a".repeat(61) }).label).toBe(
      "El nombre no puede pasar de 60 caracteres."
    );
    expect(validatePaymentMethodDraft({ ...OK, label: ` ${"a".repeat(60)} ` }).label).toBeUndefined();
  });

  it("moneda fuera de VES/USD", () => {
    expect(validatePaymentMethodDraft({ ...OK, currency: "EUR" as never }).currency).toBe("Elige la moneda.");
    expect(validatePaymentMethodDraft({ ...OK, currency: "USD" }).currency).toBeUndefined();
  });

  it("instrucciones: vacías tras recortar, 1500 entra, 1501 no", () => {
    expect(validatePaymentMethodDraft({ ...OK, instructions: "  \n " }).instructions).toBe(
      "Escribe los datos que recibe el cliente."
    );
    expect(validatePaymentMethodDraft({ ...OK, instructions: "a".repeat(1500) }).instructions).toBeUndefined();
    expect(validatePaymentMethodDraft({ ...OK, instructions: "a".repeat(1501) }).instructions).toBe(
      "El texto no puede pasar de 1500 caracteres."
    );
  });

  it("junta los errores de varios campos a la vez", () => {
    const errors = validatePaymentMethodDraft({ ...OK, key: "ab", label: "", instructions: "" });
    expect(Object.keys(errors).sort()).toEqual(["instructions", "key", "label"]);
  });
});

describe("paymentMethodKeyFromLabel", () => {
  it.each([
    ["Pago móvil", "pago_movil"],
    ["Zelle (USD)", "zelle_usd"],
    ["  Binance  ", "binance"],
    ["Transferencia   bancaria", "transferencia_bancaria"],
    ["Efectivo $", "efectivo"],
    ["Pago 2 móvil", "pago_movil"],
    ["¡¡¡", ""],
    ["", ""],
  ])("%j → %j", (label, esperada) => {
    expect(paymentMethodKeyFromLabel(label)).toBe(esperada);
  });

  it("recorta a 30 caracteres sin dejar un guion bajo colgando", () => {
    const larga = paymentMethodKeyFromLabel("transferencia bancaria nacional en bolivares");
    expect(larga.length).toBeLessThanOrEqual(30);
    expect(larga.endsWith("_")).toBe(false);
    expect(larga).toBe("transferencia_bancaria_naciona");
    // Corte justo después de un separador: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaa b" (29 letras + espacio + b).
    expect(paymentMethodKeyFromLabel(`${"a".repeat(29)} bbb`)).toBe("a".repeat(29));
  });
});

describe("nextPaymentMethodSortOrder", () => {
  it("sin ninguna, empieza en 10", () => {
    expect(nextPaymentMethodSortOrder([])).toBe(10);
  });
  it("el mayor + 10, aunque vengan desordenadas", () => {
    expect(nextPaymentMethodSortOrder([{ sortOrder: 20 }, { sortOrder: 50 }, { sortOrder: 10 }])).toBe(60);
    expect(nextPaymentMethodSortOrder([{ sortOrder: 0 }])).toBe(10);
  });
});
