import { describe, expect, it } from "vitest";
import { hasHardcodedPrice } from "@/lib/playbook-price";

/**
 * El texto de un escenario sale tal cual, sin pasar por el modelo ni por el
 * catálogo: si adentro hay un precio escrito a mano, ese precio no envejece
 * solo. La IA cotizó "76$ a bcv" desde uno de estos, y el número llevaba
 * semanas ahí.
 *
 * Esto no corrige nada ni bloquea nada: marca el escenario en el panel para
 * que el dueño lo revise antes de que se lo cuente un cliente.
 */
describe("hasHardcodedPrice — un precio escrito dentro del texto", () => {
  it.each([
    "¡Claro, está disponible!, tiene un costo de 76$ a bcv, contamos con CASHEA",
    "El precio es $76",
    "Sale en 25 USD",
    "Cuesta Bs. 970,00",
    "Son 2.500 bolívares",
    "Te queda en 76 $ a la tasa del día",
  ])("lo encuentra en «%s»", (texto) => {
    expect(hasHardcodedPrice(texto)).toBe(true);
  });

  /**
   * Un número no es un precio. Estos son los que más importan: si el aviso
   * salta en escenarios que están bien, el dueño deja de mirarlo.
   */
  it.each([
    "¡Buenos días! ¿En qué podemos ayudarle? Estamos atentos a cualquier consulta o duda.",
    "Bajada de inicial y modo 6 cuotas",
    "CAMPAÑA MALETA FEDERAL 45 LTS",
    "Trabajamos de 8:00 am a 6:00 pm",
    "Tenemos la SBS 100 disponible",
    "",
  ])("no lo confunde con un número cualquiera en «%s»", (texto) => {
    expect(hasHardcodedPrice(texto)).toBe(false);
  });
});
