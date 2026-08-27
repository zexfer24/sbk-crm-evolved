import { describe, expect, it } from "vitest";
import { DEBOUNCE_SECONDS, DEBOUNCE_SHORT_SECONDS, debounceSecondsFor } from "@/lib/ai/queue";

// ---------------------------------------------------------------------------
// La ventana de silencio era de seis segundos para todo el mundo. Con un
// objetivo de cuatro segundos de respuesta, esos seis fijos se comen el
// presupuesto entero antes de que el modelo lea nada — pero quitarlos devuelve
// la respuesta por frase que el debounce vino a evitar.
//
// Lo que se prueba acá es el criterio que separa los dos casos: quién está a
// mitad de una ráfaga y quién ya dijo lo que tenía que decir.
// ---------------------------------------------------------------------------

describe("debounceSecondsFor", () => {
  describe("espera la ventana completa", () => {
    it.each([
      ["buenas"],
      ["hola"],
      ["epa"],
      ["buenas tardes"],
      ["tengo una moto"],
    ])("con el arranque suelto de una ráfaga: %s", (texto) => {
      expect(debounceSecondsFor(texto)).toBe(DEBOUNCE_SECONDS);
    });

    /**
     * Nadie termina un mensaje en preposición. Esto manda incluso sobre la
     * longitud: "necesito una cadena de transmisión para" tiene cuarenta
     * caracteres y está clarísimamente a medias.
     */
    it.each([
      ["necesito una cadena para"],
      ["quiero saber si tienen el kit de arrastre de la"],
      ["me sirve para una Bera pero"],
      ["ando buscando unas pastillas de freno que"],
    ])("cuando el texto corta en un conector: %s", (texto) => {
      expect(debounceSecondsFor(texto)).toBe(DEBOUNCE_SECONDS);
    });

    /**
     * Una foto sin pie casi siempre viene seguida del "¿cuánto cuesta?".
     * Responderle a la foto sola es responder sin la pregunta.
     */
    it.each([[null], [undefined], [""], ["   "]])("sin texto propio del cliente: %s", (texto) => {
      expect(debounceSecondsFor(texto)).toBe(DEBOUNCE_SECONDS);
    });
  });

  describe("responde con la ventana corta", () => {
    it.each([
      ["¿Tienen bujía para una Empire Owen?"],
      ["Cuánto cuesta el kit de arrastre?"],
      ["Gracias, quedo pendiente."],
      ["Dale, me lo llevo!"],
    ])("cuando la idea cierra con puntuación: %s", (texto) => {
      expect(debounceSecondsFor(texto)).toBe(DEBOUNCE_SHORT_SECONDS);
    });

    /** En WhatsApp el emoji al final es la norma, no la excepción. */
    it.each([
      ["¿Cuánto cuesta? 🏍️"],
      ["Perfecto, gracias!! 🙏🙏"],
    ])("aunque después de la puntuación venga un emoji: %s", (texto) => {
      expect(debounceSecondsFor(texto)).toBe(DEBOUNCE_SHORT_SECONDS);
    });

    /**
     * Casi nadie puntúa en WhatsApp, así que sin puntuación la longitud es la
     * única señal que queda. Un mensaje largo que no termina en conector es
     * una idea entera.
     */
    it("cuando el mensaje es largo aunque no lleve puntuación", () => {
      const largo = "necesito una cadena de arrastre para una bera br 200 modelo 2019";

      expect(largo.length).toBeGreaterThanOrEqual(40);
      expect(debounceSecondsFor(largo)).toBe(DEBOUNCE_SHORT_SECONDS);
    });
  });

  /**
   * Dos segundos y no cero: la ráfaga también existe DESPUÉS de una pregunta
   * completa —el cliente agrega la marca de la moto en otro mensaje— y sin
   * ninguna ventana volveríamos a contestar dos veces.
   */
  it("la ventana corta sigue siendo una ventana", () => {
    expect(DEBOUNCE_SHORT_SECONDS).toBeGreaterThan(0);
    expect(DEBOUNCE_SHORT_SECONDS).toBeLessThan(DEBOUNCE_SECONDS);
  });
});
