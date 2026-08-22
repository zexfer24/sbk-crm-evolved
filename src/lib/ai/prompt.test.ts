import { describe, expect, it } from "vitest";
import { INTENT_VALUES } from "@/lib/ai/classify";
import { OFF_TOPIC_REPLY, SYSTEM_PROMPT, buildInstructions } from "@/lib/ai/prompt";

/**
 * Estimación conservadora de caracteres por token para español.
 *
 * Los tokenizadores de OpenAI parten el español en algo cercano a 3,5
 * caracteres por token; contar 4 supone MENOS tokens de los que hay, así
 * que si el test pasa con este número, pasa de verdad.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Mínimo de tokens que exige el caché de prompts de OpenAI. Por debajo de
 * esto no cachea nada — ni avisa.
 */
const CACHE_MIN_TOKENS = 1024;

const TURN = { intent: "consulta_disponibilidad", needsGreeting: false } as const;

describe("SYSTEM_PROMPT — el bloque que se cachea", () => {
  /**
   * El caché de OpenAI solo entra a partir de 1024 tokens de prefijo. El
   * prompt anterior eran cuatro variantes que compartían unos 400 tokens de
   * identidad: nunca llegaba al umbral, así que se pagaba entrada completa
   * en cada llamada sin que nada lo delatara.
   */
  it("es lo bastante largo para cruzar el umbral del caché", () => {
    const tokensEstimados = SYSTEM_PROMPT.length / CHARS_PER_TOKEN;

    expect(tokensEstimados).toBeGreaterThan(CACHE_MIN_TOKENS);
  });

  it.each(INTENT_VALUES)(
    "para la intención %s, el bloque estático es prefijo EXACTO de las instrucciones",
    (intent) => {
      const instructions = buildInstructions({ intent, needsGreeting: false });

      // startsWith y no `includes`: si algo se cuela ANTES del bloque, el
      // prefijo deja de coincidir entre turnos y el caché no entra.
      expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
    }
  );

  it("el bloque estático es idéntico se salude o no", () => {
    const conSaludo = buildInstructions({ ...TURN, needsGreeting: true });
    const sinSaludo = buildInstructions({ ...TURN, needsGreeting: false });

    expect(conSaludo.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(sinSaludo.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  /**
   * Lo que va después del bloque estático se paga a precio completo en cada
   * turno. Si el sufijo crece, el ahorro se diluye sin que se note.
   */
  it("el sufijo dinámico se mantiene corto", () => {
    for (const intent of INTENT_VALUES) {
      for (const needsGreeting of [true, false]) {
        const sufijo = buildInstructions({ intent, needsGreeting }).slice(SYSTEM_PROMPT.length);

        expect(sufijo.length / CHARS_PER_TOKEN).toBeLessThan(120);
      }
    }
  });
});

describe("sufijo dinámico del turno", () => {
  it("le dice al modelo cuál de los casos está atendiendo", () => {
    const devolucion = buildInstructions({ intent: "devolucion", needsGreeting: false });
    const queja = buildInstructions({ intent: "queja", needsGreeting: false });

    expect(devolucion.slice(SYSTEM_PROMPT.length)).toContain("devolucion");
    expect(queja.slice(SYSTEM_PROMPT.length)).toContain("queja");
    expect(devolucion).not.toEqual(queja);
  });

  /**
   * La plantilla de bienvenida solo sale si WHATSAPP_WELCOME_TEMPLATE está
   * configurada (ver route.ts). Sin ella nadie saluda, así que el agente
   * tiene que hacerlo o el cliente recibe una respuesta en seco.
   */
  it("manda saludar solo cuando la conversación no recibió bienvenida", () => {
    const conSaludo = buildInstructions({ ...TURN, needsGreeting: true }).slice(SYSTEM_PROMPT.length);
    const sinSaludo = buildInstructions({ ...TURN, needsGreeting: false }).slice(SYSTEM_PROMPT.length);

    expect(conSaludo).toMatch(/saluda/i);
    expect(sinSaludo).not.toMatch(/saluda/i);
  });
});

describe("formato de WhatsApp", () => {
  it("instruye explícitamente a no usar doble asterisco (Markdown)", () => {
    expect(SYSTEM_PROMPT).toMatch(/un solo asterisco/);
  });

  /** Si el propio prompt trae `**`, el modelo copia el formato equivocado. */
  it("el prompt no contiene Markdown literal", () => {
    expect(SYSTEM_PROMPT).not.toContain("**");
    expect(OFF_TOPIC_REPLY).not.toContain("**");
  });
});
