import { describe, expect, it } from "vitest";
import { isCourtesyOnly, isGreetingPlaybook } from "@/lib/ai/saludo";

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
