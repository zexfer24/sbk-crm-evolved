import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";
import { greetingWindow, playbooksAtTime } from "@/lib/ai/greeting-window";
import { crmMinuteOfDay, formatCrmDateTime } from "@/lib/time-zone";

const generateObjectMock = vi.fn();

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("@/lib/ai/model", () => ({
  getClassifierModel: () => ({ model: "modelo-falso", providerOptions: {} }),
}));

import { matchPlaybook } from "@/lib/ai/playbooks";

// ---------------------------------------------------------------------------
// Los tres saludos, con el texto EXACTO que tiene cargado el dueño en
// `ai_playbooks`. No son ejemplos inventados: el escenario se restringe por lo
// que el cliente va a recibir, así que si alguien reescribe estos textos en el
// panel, este test tiene que reflejar el texto nuevo.
//
// Fijarse en la asimetría del disparador de "Buen dia": describe la FORMA del
// mensaje ("solo con hola o cualquier saludo"), no una franja horaria. Por eso
// el modelo lo elegía a cualquier hora — calzaba siempre.
// ---------------------------------------------------------------------------

function escenario(name: string, triggerDescription: string, responseText: string): Playbook {
  return {
    id: `id-${name}`,
    name,
    triggerDescription,
    responseText,
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    tags: [],
  };
}

const BUEN_DIA = escenario(
  "Buen dia",
  "El cliente escribe por primera vez en el dia cursante solo con hola o cualquier tipo de saludo u emoji sin más contexto",
  "¡Buenos días! ¿En qué podemos ayudarle? Estamos atentos a cualquier consulta o duda."
);

const BUENAS_TARDES = escenario(
  "Buenas tardes",
  "El cliente escribe por primera vez en el dia entre las 12:00 pm hasta las 7:00pm",
  "¡Buenas tardes! ¿En qué podemos ayudarle? Estamos atentos a cualquier consulta o duda."
);

const BUENAS_NOCHES = escenario(
  "Buenas Noches",
  "El cliente escribe por primera vez en entre las 7:01 pm a las 11:59 pm",
  "¡Buenas noches! ¿En qué podemos ayudarle? Estamos atentos a cualquier consulta o duda."
);

const MALETA = escenario(
  "CAMPAÑA MALETA FEDERAL 45 LTS",
  "El cliente pregunta por la maleta de la campaña",
  "¡Claro, está disponible!, tiene un costo de 76$ a bcv, contamos con CASHEA"
);

const SALUDOS = [BUEN_DIA, BUENAS_TARDES, BUENAS_NOCHES];

/** Un instante en la hora de Venezuela, escrito como lo lee un humano en Barinas. */
function enVenezuela(hora: string): Date {
  return new Date(`2026-08-27T${hora}:00-04:00`);
}

// ---------------------------------------------------------------------------
// La tabla del incidente: 14 turnos reales del 27 de agosto de 2026, con la
// hora de Caracas en que entró cada mensaje y el escenario que el emparejador
// eligió sin saber qué hora era. Cuatro salieron mal.
//
// `eligióSinHora` está acá como registro de lo que pasó, no como algo que el
// código deba reproducir: es la columna que explica por qué existe este
// archivo. Lo que se comprueba es `debeElegir`.
// ---------------------------------------------------------------------------
const TURNOS = [
  { n: 1, hora: "22:36", mensaje: "Buenas noche", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 2, hora: "22:31", mensaje: "saludo", eligióSinHora: "Buen dia", debeElegir: "Buenas Noches" },
  { n: 3, hora: "22:27", mensaje: "Buenas noches", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 4, hora: "22:09", mensaje: "Hola Buenas noches", eligióSinHora: "Buen dia", debeElegir: "Buenas Noches" },
  { n: 5, hora: "21:04", mensaje: "Buenas noches", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 6, hora: "20:56", mensaje: "Buenas noches amigo", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 7, hora: "20:52", mensaje: "Buenas noches", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 8, hora: "20:28", mensaje: "Buenas noches", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 9, hora: "20:27", mensaje: "Hola buenas noches.", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 10, hora: "20:23", mensaje: "Buenas noches", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 11, hora: "20:23", mensaje: "Hola", eligióSinHora: "Buen dia", debeElegir: "Buenas Noches" },
  { n: 12, hora: "20:23", mensaje: "Hola buenas noche", eligióSinHora: "Buenas Noches", debeElegir: "Buenas Noches" },
  { n: 13, hora: "12:29", mensaje: "Hola buenas tardes", eligióSinHora: "Buen dia", debeElegir: "Buenas tardes" },
  { n: 14, hora: "11:45", mensaje: "Hola", eligióSinHora: "Buen dia", debeElegir: "Buen dia" },
];

describe("playbooksAtTime — el saludo lo decide el reloj, no el texto del cliente", () => {
  it.each(TURNOS)("caso $n · $hora «$mensaje» → solo se ofrece $debeElegir", ({ hora, debeElegir }) => {
    const ofrecidos = playbooksAtTime(SALUDOS, enVenezuela(hora)).map((p) => p.name);

    expect(ofrecidos).toEqual([debeElegir]);
  });

  /**
   * El caso 14 salió bien de casualidad: "Hola" a las 11:45 sí es "Buen dia",
   * y el emparejador contestaba eso a cualquier hora. Un arreglo que lo rompa
   * está mal, así que se comprueba aparte y por su nombre.
   */
  it("a las 11:45 el saludo de la mañana sigue siendo el que corresponde", () => {
    expect(playbooksAtTime(SALUDOS, enVenezuela("11:45")).map((p) => p.name)).toEqual(["Buen dia"]);
  });

  /**
   * Las tres franjas cubren el día entero y no se pisan. Los bordes salen del
   * disparador que escribió el dueño: tardes "hasta las 7:00pm", noches
   * "7:01 pm a las 11:59 pm".
   */
  it.each([
    ["00:00", "Buen dia"],
    ["11:59", "Buen dia"],
    ["12:00", "Buenas tardes"],
    ["19:00", "Buenas tardes"],
    ["19:01", "Buenas Noches"],
    ["23:59", "Buenas Noches"],
  ])("a las %s corresponde %s", (hora, esperado) => {
    expect(playbooksAtTime(SALUDOS, enVenezuela(hora)).map((p) => p.name)).toEqual([esperado]);
  });

  /**
   * La restricción es SOBRE EL TEXTO QUE SALE, no sobre el disparador ni sobre
   * el nombre del escenario. Un escenario que no empieza saludando por la hora
   * no tiene por qué depender de la hora: se ofrece siempre, como hasta ahora.
   */
  it("no le pone horario a un escenario que no saluda por la hora", () => {
    const madrugada = playbooksAtTime([MALETA, ...SALUDOS], enVenezuela("03:00"));
    const noche = playbooksAtTime([MALETA, ...SALUDOS], enVenezuela("21:00"));

    expect(madrugada.map((p) => p.name)).toContain("CAMPAÑA MALETA FEDERAL 45 LTS");
    expect(noche.map((p) => p.name)).toContain("CAMPAÑA MALETA FEDERAL 45 LTS");
  });

  it("mantiene el orden en que venían los escenarios", () => {
    const lista = playbooksAtTime([MALETA, BUENAS_NOCHES], enVenezuela("21:00"));

    expect(lista.map((p) => p.name)).toEqual(["CAMPAÑA MALETA FEDERAL 45 LTS", "Buenas Noches"]);
  });
});

describe("greetingWindow — de qué hora habla un texto ya redactado", () => {
  it.each([
    ["¡Buenos días! ¿En qué podemos ayudarle?", 0, 719],
    ["¡Buenas tardes! ¿En qué podemos ayudarle?", 720, 1140],
    ["¡Buenas noches! ¿En qué podemos ayudarle?", 1141, 1439],
  ])("«%s» rige de %i a %i", (texto, from, to) => {
    expect(greetingWindow(texto)).toEqual({ from, to });
  });

  /** Sin acentos, sin signo de apertura, en minúscula y con emoji delante: es texto que escribe una persona. */
  it.each([
    "Buenas noches",
    "buenas noches amigo",
    "🌙 Buenas noches",
    "  ¡¡Buenas Noches!!",
    "Buena noche, ¿en qué le ayudamos?",
  ])("reconoce «%s» como saludo de la noche", (texto) => {
    expect(greetingWindow(texto)).toEqual({ from: 1141, to: 1439 });
  });

  /**
   * Falla ABIERTO: si el texto no empieza saludando por la hora, no se le pone
   * horario. Equivocarse hacia acá deja el comportamiento que ya había;
   * equivocarse hacia el otro lado apaga un escenario del dueño sin avisar.
   */
  it.each([
    "¡Claro, está disponible!, tiene un costo de 76$ a bcv",
    "Trabajamos de 8:00 am a 6:00 pm, buenas tardes",
    "Bajada de inicial y modo 6 cuotas",
    "",
  ])("no le encuentra horario a «%s»", (texto) => {
    expect(greetingWindow(texto)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Los mismos 14 turnos, ahora de punta a punta por `matchPlaybook`.
//
// El modelo de este bloque es un doble deliberadamente malo: reconoce que el
// mensaje es un saludo suelto —eso lo acertó en los 14— pero no distingue cuál
// de los tres corresponde, así que se queda con el primero que le ofrezcan.
// Ese ES el emparejador de producción sin la hora: con los tres saludos sobre
// la mesa, el único cuyo disparador describe la FORMA del mensaje ("solo con
// hola o cualquier saludo") calzaba siempre, y "¡Buenos días!" salía a las
// diez de la noche.
//
// Que estos 14 pasen con un modelo así es el punto: el saludo deja de depender
// de que el modelo tenga un buen día.
// ---------------------------------------------------------------------------
describe("matchPlaybook — el saludo que sale a cada hora, de punta a punta", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    generateObjectMock.mockImplementation(async ({ enum: opciones }: { enum: string[] }) => ({
      object: opciones.find((opcion) => opcion !== "ninguno") ?? "ninguno",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }));
  });

  it.each(TURNOS)("caso $n · $hora «$mensaje» → responde $debeElegir", async ({ hora, mensaje, debeElegir }) => {
    const historial = [{ role: "user" as const, content: mensaje }];

    const { playbook } = await matchPlaybook(historial, SALUDOS, enVenezuela(hora));

    expect(playbook?.name).toBe(debeElegir);
  });

  it("no le ofrece al modelo un saludo que a esta hora no puede salir", async () => {
    await matchPlaybook([{ role: "user", content: "Hola" }], SALUDOS, enVenezuela("20:23"));

    const llamada = generateObjectMock.mock.calls[0][0] as { enum: string[] };
    expect(llamada.enum).toEqual(["Buenas Noches", "ninguno"]);
  });

  /**
   * La hora viaja igual en el prompt, aunque la lista ya venga filtrada: dos de
   * los tres disparadores que escribió el dueño están redactados como franjas
   * ("entre las 12:00 pm hasta las 7:00pm"), y sin saber qué hora es el modelo
   * no puede comprobarlos — respondería "ninguno" por prudencia.
   */
  it("le dice al modelo qué hora es en Venezuela", async () => {
    const ahora = enVenezuela("20:23");

    await matchPlaybook([{ role: "user", content: "Hola" }], SALUDOS, ahora);

    const llamada = generateObjectMock.mock.calls[0][0] as { system: string };
    expect(llamada.system).toContain(formatCrmDateTime(ahora));
  });

  /**
   * Si el dueño solo dejó activo el saludo de la mañana y entra un mensaje a
   * las nueve de la noche, no hay a quién llamar: el turno cae al flujo
   * genérico, que redacta con la hora correcta (va en TURNO ACTUAL). Mandar
   * "¡Buenos días!" a esa hora sería peor, y la llamada se ahorra.
   */
  it("no llama al modelo si a esta hora no puede salir ningún escenario", async () => {
    const { playbook, usage } = await matchPlaybook(
      [{ role: "user", content: "Hola" }],
      [BUEN_DIA],
      enVenezuela("21:00")
    );

    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(playbook).toBeNull();
    expect(usage.totalTokens).toBe(0);
  });
});

describe("crmMinuteOfDay — la hora del negocio, no la del proceso", () => {
  /**
   * El contenedor corre en UTC: a las 8:23 pm en Barinas el reloj del proceso
   * ya dice medianoche del día siguiente. Cuatro horas que cruzan los tres
   * saludos.
   */
  it("lee las 20:23 de Venezuela en un instante que en UTC es del día siguiente", () => {
    expect(crmMinuteOfDay(new Date("2026-08-28T00:23:00.000Z"))).toBe(20 * 60 + 23);
  });

  it("lee la medianoche de Venezuela como el minuto cero", () => {
    expect(crmMinuteOfDay(new Date("2026-08-28T04:00:00.000Z"))).toBe(0);
  });

  it("lee el último minuto del día", () => {
    expect(crmMinuteOfDay(new Date("2026-08-28T03:59:00.000Z"))).toBe(23 * 60 + 59);
  });
});
