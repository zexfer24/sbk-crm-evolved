import { describe, expect, it } from "vitest";
import {
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_NO_IDENTIFICADO,
  TEXTO_PRECIO_A_CONFIRMAR,
  TEXTO_SIN_STOCK,
  isSebaGreeting,
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

  // D1, plan "La búsqueda encuentra lo que el cliente pide" (25/9/2026,
  // aprobada por el operador): PREGUNTA_FILTRO le pregunta al cliente por
  // "modelo y año de moto", y esa pregunta no tiene sentido para un repuesto
  // que no depende de la moto (un aceite, un casco, un intercomunicador, una
  // maleta). PREGUNTA_FILTRO_PRODUCTO es el segundo texto fijo para ese caso.
  it("PREGUNTA_FILTRO_PRODUCTO", () => {
    expect(revealsIdentity(PREGUNTA_FILTRO_PRODUCTO)).toBeNull();
  });

  // T3, plan "La búsqueda encuentra lo que el cliente pide" (25/9/2026):
  // texto fijo de la guarda de cifras sin fuente (price-guard.ts) — casos
  // 20/9 (precio del historial) y 13/9 (cuotas de Cashea calculadas de
  // memoria). Mismo control de sanidad que las demás despedidas fijas.
  it("TEXTO_PRECIO_A_CONFIRMAR", () => {
    expect(revealsIdentity(TEXTO_PRECIO_A_CONFIRMAR)).toBeNull();
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

// T12, plan "Seba sale sin pisar a nadie" (19/9/2026, decisión abierta #1):
// el turno usa esto para reconocer, en un reintento, que la última línea del
// historial ya es la presentación que salió antes — nunca algo que haya que
// volver a redactar. Construido a partir de `sebaGreeting`, no de literales
// repetidos a mano: estos tests confirman que reconoce las TRES franjas y
// que no se confunde con otro texto que también empiece con "Hola".
describe("isSebaGreeting", () => {
  it.each<DayBand>(["mañana", "tarde", "noche"])("reconoce la presentación de la franja %s", (band) => {
    expect(isSebaGreeting(sebaGreeting(band))).toBe(true);
  });

  it("no confunde otro texto que empieza con 'Hola'", () => {
    expect(isSebaGreeting("Hola, ¿en qué te puedo ayudar?")).toBe(false);
    expect(isSebaGreeting("Hola, buen día, mi nombre es Carlos.")).toBe(false);
  });

  it("no confunde la presentación con un pie de más o de menos (comparación exacta)", () => {
    expect(isSebaGreeting(`${sebaGreeting("tarde")} `)).toBe(false);
    expect(isSebaGreeting(sebaGreeting("tarde").slice(0, -1))).toBe(false);
  });

  it("una cadena vacía no calza ninguna franja", () => {
    expect(isSebaGreeting("")).toBe(false);
  });
});
