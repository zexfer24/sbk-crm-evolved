import { describe, expect, it } from "vitest";
import {
  PREGUNTA_FILTRO,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_NO_IDENTIFICADO,
  TEXTO_SIN_STOCK,
  presentationGreetingFor,
  sebaGreeting,
} from "@/lib/ai/seba";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import type { DayBand } from "@/lib/business-hours";

// 18/9/2026, plan "Seba atiende el mostrador": el cliente dictó el saludo de
// apertura palabra por palabra. Estos tests fijan `band` a mano — NUNCA el
// reloj real (trampa del 14/9/2026: un test que depende de la hora de
// ejecución falla en silencio según cuándo corra la suite) — y comparan
// byte a byte contra el literal exacto.
describe("sebaGreeting — las tres franjas, byte a byte", () => {
  it("mañana: 'Hola, buen día, mi nombre es Seba...'", () => {
    expect(sebaGreeting("mañana")).toBe(
      "Hola, buen día, mi nombre es Seba. Soy tu asistente el día de hoy en SBK MOTORS, ¿cómo puedo ayudarte?"
    );
  });

  it("tarde: 'Hola, buenas tardes, mi nombre es Seba...'", () => {
    expect(sebaGreeting("tarde")).toBe(
      "Hola, buenas tardes, mi nombre es Seba. Soy tu asistente el día de hoy en SBK MOTORS, ¿cómo puedo ayudarte?"
    );
  });

  it("noche: 'Hola, buenas noches, mi nombre es Seba...'", () => {
    expect(sebaGreeting("noche")).toBe(
      "Hola, buenas noches, mi nombre es Seba. Soy tu asistente el día de hoy en SBK MOTORS, ¿cómo puedo ayudarte?"
    );
  });
});

describe("presentationGreetingFor", () => {
  it.each<[DayBand, string]>([
    ["mañana", "buen día"],
    ["tarde", "buenas tardes"],
    ["noche", "buenas noches"],
  ])("%s → %s", (band, esperado) => {
    expect(presentationGreetingFor(band)).toBe(esperado);
  });
});

describe("sebaGreeting pasa la guarda de identidad en las tres franjas", () => {
  it.each<DayBand>(["mañana", "tarde", "noche"])("franja %s", (band) => {
    expect(revealsIdentity(sebaGreeting(band))).toBeNull();
  });
});

describe("los textos fijos de R2/R3/R4 y la pregunta de filtro pasan la guarda", () => {
  it("TEXTO_CONFIRMAR_INVENTARIO", () => {
    expect(revealsIdentity(TEXTO_CONFIRMAR_INVENTARIO)).toBeNull();
  });

  it("TEXTO_SIN_STOCK", () => {
    expect(revealsIdentity(TEXTO_SIN_STOCK)).toBeNull();
  });

  it("TEXTO_NO_IDENTIFICADO", () => {
    expect(revealsIdentity(TEXTO_NO_IDENTIFICADO)).toBeNull();
  });

  it("PREGUNTA_FILTRO", () => {
    expect(revealsIdentity(PREGUNTA_FILTRO)).toBeNull();
  });
});

// Control de sanidad de la excepción que se abrió en identity-guard.ts: solo
// "Seba" pasa como nombre propio, cualquier otro nombre sigue bloqueado como
// afirmación de persona.
describe("la excepción de nombre solo deja pasar a Seba", () => {
  it("'mi nombre es Carlos' sigue dando persona", () => {
    expect(revealsIdentity("mi nombre es Carlos")?.categoria).toBe("persona");
  });
});
