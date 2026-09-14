import { describe, expect, it } from "vitest";
import { isCourtesyOnly, isGreetingPlaybook, isPureGreeting } from "@/lib/ai/saludo";

describe("isPureGreeting", () => {
  it.each([
    "hola",
    "Hola",
    "buenas",
    "buenos dias",
    "Buenos Días",
    "buenas tardes",
    "buenas noches",
    "buen dia",
    "hey",
    "saludos",
    "que tal",
    "hola buenas",
    "buenas tardes, ¿cómo están?",
    "buenas tardes amigo",
    "¡Hola! 👋",
  ])("reconoce %s como saludo puro", (texto) => {
    expect(isPureGreeting(texto)).toBe(true);
  });

  it.each([
    "buenas, tienen tanque de EK Xpress",
    "hola quiero un casco talla M",
    "buenos dias, cuanto cuesta el aceite",
    "",
    "   ",
    "hola hola hola hola hola hola hola",
  ])("no reconoce %s como saludo puro", (texto) => {
    expect(isPureGreeting(texto)).toBe(false);
  });
});

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
  ])("reconoce %s como texto de escenario de saludo", (texto) => {
    expect(isGreetingPlaybook(texto)).toBe(true);
  });

  it.each([
    "Tenemos tanque de EK Xpress disponible.",
    "Trabajamos de lunes a viernes de 8 am a 6 pm, buenas tardes.",
    "Claro, dame un momento para revisar el inventario.",
  ])("no reconoce %s como texto de escenario de saludo", (texto) => {
    expect(isGreetingPlaybook(texto)).toBe(false);
  });
});
