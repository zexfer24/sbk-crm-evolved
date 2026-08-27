import { describe, expect, it } from "vitest";
import { isDeliverablePhoneNumber, phoneNumberFromWaId } from "@/lib/whatsapp/phone";

describe("phoneNumberFromWaId", () => {
  it("arma el número del CRM a partir del wa_id", () => {
    expect(phoneNumberFromWaId("584120000000")).toBe("+584120000000");
  });

  /**
   * El caso real: el webhook hacía `+${message.from}` sin mirar si `from`
   * existía, y guardó la cadena '+undefined' como número de contacto.
   */
  it.each([[undefined], [null], [""], ["   "]])("rechaza un remitente ausente: %s", (from) => {
    expect(phoneNumberFromWaId(from)).toBeNull();
  });

  /**
   * El remitente que destapó todo esto. Decodificado de los identificadores de
   * sus mensajes entrantes, el emisor era 'CO.1550555583222997': un
   * identificador de la Cloud API que no es un teléfono.
   */
  it.each([["CO.1550555583222997"], ["undefined"], ["+584120000000"], ["58412 000 0000"], ["abc"]])(
    "rechaza un remitente que no es sólo dígitos: %s",
    (from) => {
      expect(phoneNumberFromWaId(from)).toBeNull();
    }
  );

  it("rechaza longitudes imposibles para un teléfono", () => {
    expect(phoneNumberFromWaId("12345")).toBeNull();
    expect(phoneNumberFromWaId("1234567890123456")).toBeNull();
  });
});

describe("isDeliverablePhoneNumber", () => {
  it("acepta un E.164 normal", () => {
    expect(isDeliverablePhoneNumber("+584120000000")).toBe(true);
  });

  /**
   * El valor que hay guardado hoy en la ficha del contacto roto. Es la
   * comprobación que impide que el asesor escriba en un chat sin salida.
   */
  it("rechaza la cadena que dejó el webhook", () => {
    expect(isDeliverablePhoneNumber("+undefined")).toBe(false);
  });

  it.each([[null], [undefined], [""], ["584120000000"], ["+58 412 0000000"], ["+CO.155055"]])(
    "rechaza lo que no es E.164: %s",
    (valor) => {
      expect(isDeliverablePhoneNumber(valor)).toBe(false);
    }
  );
});
