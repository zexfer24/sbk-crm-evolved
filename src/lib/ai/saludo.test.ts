import { describe, expect, it } from "vitest";
import { isCourtesyOnly, isGreetingOnly, isGreetingPlaybook } from "@/lib/ai/saludo";

describe("isCourtesyOnly", () => {
  it.each([
    "gracias",
    "Muchas gracias",
    "ok",
    "okey",
    "vale",
    "listo",
    "perfecto",
    "dale",
    "de acuerdo",
    "esta bien",
    "gracias amigo",
    "👍",
    "🙏",
    "👍🙏",
    "gracias! 🙏",
  ])("reconoce %s como cortesía pura", (texto) => {
    expect(isCourtesyOnly(texto)).toBe(true);
  });

  it.each([
    "gracias, y ¿tienen rines 17?",
    "ok, paso mañana a buscarlo",
    "",
    "   ",
    "gracias gracias gracias gracias gracias gracias gracias",
  ])("no reconoce %s como cortesía pura", (texto) => {
    expect(isCourtesyOnly(texto)).toBe(false);
  });
});

// 18/9/2026 (T2a, "Seba atiende el mostrador"): vuelve con un llamador real
// en el turno (ver el comentario de cabecera del módulo).
describe("isGreetingOnly", () => {
  it.each(["hola", "Buenas tardes!", "hola que tal"])(
    "reconoce %s como saludo puro del cliente",
    (texto) => {
      expect(isGreetingOnly(texto)).toBe(true);
    }
  );

  it.each(["hola tienen pastillas", ""])("no reconoce %s como saludo puro", (texto) => {
    expect(isGreetingOnly(texto)).toBe(false);
  });

  /**
   * F (20/9/2026, "El resguardo antes del push"): ninguno de los casos de
   * arriba ejercitaba "buenos" ni "dias" sueltos — "Buenas tardes!" ya
   * calzaba solo con "buenas"/"tardes". Sin "buenos"/"dias" en
   * PALABRAS_SALUDO, "buenos días" pelado (sin nada más que atender) se
   * clasificaría como un mensaje normal en vez de solo-saludo, y Seba
   * seguiría redactando fase 0/1/tool loop sobre un cliente que solo saludó.
   */
  it.each(["buenos días", "Buenos Dias", "buenas noches", "saludos"])(
    "reconoce %s pelado como saludo puro del cliente",
    (texto) => {
      expect(isGreetingOnly(texto)).toBe(true);
    }
  );
});

describe("isGreetingPlaybook", () => {
  it.each([
    "¡Buenas tardes! ¿En qué podemos ayudarte?",
    "Hola, bienvenido a SBK Motorcycles.",
    "Buenos días, ¿en qué te ayudamos hoy?",
    "Bienvenida a SBK, ¿qué necesitas?",
    // Fixtures heredadas del test del módulo de franjas horarias retirado el
    // 15/9/2026: esas tres franjas y el saludo con "Bienvenido a…" ya eran
    // subconjunto estricto de este patrón, así que quedan acá como los
    // mismos casos reales que probaban el reloj de los escenarios.
    "¡Buenos días! ¿En qué podemos ayudarle? Estamos atentos a cualquier consulta o duda.",
    "Buenas tardes, ¿en qué podemos ayudarle?",
    "🌙 Buenas noches, ¿en qué podemos ayudarle?",
    "Buen día, ¿en qué le ayudamos?",
    "Bienvenido a SBK Motors, ¿en qué te ayudamos?",
  ])("reconoce %s como texto de escenario de saludo", (texto) => {
    expect(isGreetingPlaybook(texto)).toBe(true);
  });

  it.each([
    "Tenemos tanque de EK Xpress disponible.",
    "Trabajamos de lunes a viernes de 8 am a 6 pm, buenas tardes.",
    "Claro, dame un momento para revisar el inventario.",
    "¡Gracias por tu compra!",
  ])("no reconoce %s como texto de escenario de saludo", (texto) => {
    expect(isGreetingPlaybook(texto)).toBe(false);
  });
});
