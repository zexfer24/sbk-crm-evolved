import { describe, expect, it } from "vitest";
import { INTENT_VALUES } from "@/lib/ai/classify";
import { OFF_TOPIC_REPLY, SYSTEM_PROMPT, buildInstructions } from "@/lib/ai/prompt";
import { greetingWindow } from "@/lib/ai/greeting-window";

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
   *
   * El tope subió de 120 a 150 el 5/9/2026 (Frente B3, "El reloj dice la
   * verdad"): `turnClockLine` reemplazó la única línea de fecha por hora,
   * franja, saludo, horario de atención y si la tienda está abierta —el peor
   * caso (primer mensaje + catálogo apagado) mide ~134 tokens medidos con
   * este mismo estimador. Es el precio de que el modelo ya no tenga que
   * deducir nada de eso.
   */
  it("el sufijo dinámico se mantiene corto", () => {
    for (const intent of INTENT_VALUES) {
      for (const needsGreeting of [true, false]) {
        const sufijo = buildInstructions({ intent, needsGreeting }).slice(SYSTEM_PROMPT.length);

        expect(sufijo.length / CHARS_PER_TOKEN).toBeLessThan(150);
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

    // Ojo: no se busca /saluda/i a secas — turnClockLine SIEMPRE trae la
    // palabra ("... saluda 'buenas tardes' ..."), sea o no el primer mensaje.
    // Lo que distingue el primer contacto es esta frase concreta.
    expect(conSaludo).toMatch(/es el primer mensaje que recibe de nosotros/i);
    expect(sinSaludo).not.toMatch(/es el primer mensaje que recibe de nosotros/i);
  });

  /**
   * Con el catálogo apagado desde el panel, el riesgo es que el modelo
   * cotice de memoria. El aviso viaja en el sufijo — nunca antes del bloque
   * estático, que tiene que seguir siendo prefijo exacto para el caché.
   */
  it("avisa cuando la búsqueda de catálogo está apagada, sin romper el prefijo", () => {
    const sinCatalogo = buildInstructions({ ...TURN, missingCatalog: true });
    const conCatalogo = buildInstructions({ ...TURN, missingCatalog: false });

    expect(sinCatalogo.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(sinCatalogo.slice(SYSTEM_PROMPT.length)).toMatch(/catálogo está apagada/);
    expect(conCatalogo.slice(SYSTEM_PROMPT.length)).not.toMatch(/catálogo está apagada/);
  });
});

/**
 * El dueño reportó "buenos días" a las tres de la tarde. La causa era que el
 * prompt no mencionaba la hora en ninguna parte: el modelo la adivinaba, y a
 * veces acertaba. La primera corrección (27/8/2026) le dio al modelo la hora
 * en texto y le dejó la regla de qué saludo usar en prosa; seguía fallando
 * porque tenía que DEDUCIR la franja a partir de "4:45 p. m.".
 *
 * Frente B3 (5/9/2026, "El reloj dice la verdad") cambia el reparto: la franja,
 * el saludo Y el horario de atención ya vienen calculados por `turnClockLine`
 * (business-hours.ts) — el modelo solo los copia. La regla que sigue siendo
 * fija y cacheada es "usa lo que te llega en TURNO ACTUAL, no lo deduzcas".
 */
describe("la hora del turno", () => {
  it("el sufijo trae la hora local de Venezuela, no la del proceso", () => {
    // 19:12 UTC son las 15:12 en Caracas. Sin zona explícita, el contenedor
    // —que corre en UTC— habría dicho las siete de la noche.
    const sufijo = buildInstructions({ ...TURN, now: new Date("2026-08-27T19:12:00Z") }).slice(
      SYSTEM_PROMPT.length
    );

    expect(sufijo).toContain("3:12 pm");
    expect(sufijo).toContain("27 de agosto");
    expect(sufijo).not.toContain("7:12 pm");
  });

  /**
   * La hora cambia en cada turno: si entrara en el bloque estático, el prefijo
   * dejaría de repetirse byte por byte y el caché no entraría nunca más.
   */
  it("la hora va en el sufijo y NUNCA en el bloque cacheado", () => {
    const manana = buildInstructions({ ...TURN, now: new Date("2026-08-27T13:00:00Z") });
    const noche = buildInstructions({ ...TURN, now: new Date("2026-08-28T01:00:00Z") });

    expect(manana.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(noche.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(manana).not.toEqual(noche);
  });

  /**
   * La regla sí es fija, así que vive arriba y se cachea con el resto — pero
   * ya no describe QUÉ hora es cada saludo (eso lo decide `dayBand`, una sola
   * vez, en business-hours.ts): solo manda copiar tal cual lo que llega.
   */
  it("la regla es copiar la franja y el horario de TURNO ACTUAL, no deducirlos", () => {
    expect(SYSTEM_PROMPT).toMatch(/usa la franja y el saludo que te llegan en TURNO ACTUAL/i);
    expect(SYSTEM_PROMPT).toMatch(/el horario de atención y si la tienda está abierta ahora mismo también te llegan en TURNO ACTUAL/i);
    // La prosa vieja ("buenos días antes del mediodía...") desapareció: la
    // regla de qué hora es cada franja vive en un solo lugar (DAY_BANDS).
    expect(SYSTEM_PROMPT).not.toMatch(/antes del mediodía/i);
  });

  /**
   * Hay dos caminos que saludan y tienen que decir lo mismo a la misma hora: el
   * escenario ya redactado del panel (por `greetingWindow`, que define "tarde"
   * hasta las 7:00 pm) y el flujo genérico (por `turnClockLine`, que ahora
   * comparte los mismos bordes vía `DAY_BANDS` — ver business-hours.ts). Se
   * verifica contra la salida real y no contra prosa: la regla ya no está
   * escrita en el prompt, está en el código que los dos comparten.
   */
  it("pone el borde entre tarde y noche donde lo ponen los escenarios", () => {
    expect(greetingWindow("¡Buenas tardes! ¿En qué podemos ayudarle?")?.to).toBe(19 * 60);

    const alasSiete = buildInstructions({ ...TURN, now: new Date("2026-09-05T23:00:00Z") }); // 7:00 pm Caracas
    const unMinutoDespues = buildInstructions({ ...TURN, now: new Date("2026-09-05T23:01:00Z") }); // 7:01 pm Caracas

    expect(alasSiete.slice(SYSTEM_PROMPT.length)).toContain("franja: tarde");
    expect(unMinutoDespues.slice(SYSTEM_PROMPT.length)).toContain("franja: noche");
  });

  /**
   * Antes la regla era "no digas el horario, la biblioteca está vacía": ahora
   * el horario SÍ existe (agent_settings.business_hours, B1) y llega
   * calculado. La prohibición cambia de forma: ya no es "no lo digas", es
   * "no inventes uno distinto al que te dieron".
   */
  it("manda usar el horario y el estado que llegan en TURNO ACTUAL, no inventar otro", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/Saber la hora no es saber el horario/);
    expect(SYSTEM_PROMPT).toMatch(/no inventes otro horario ni otro estado/);
  });

  /**
   * Casos concretos pedidos por el operador (plan "El reloj dice la verdad",
   * 5/9/2026): de noche entra "noche"/"buenas noches"; cerrado un domingo
   * dice "CERRADA" y nombra cuándo abre, sin romper el prefijo cacheado.
   */
  it("a las 8:30 pm de Caracas, el sufijo dice noche y buenas noches", () => {
    const instructions = buildInstructions({ ...TURN, now: new Date("2026-09-05T00:30:00Z") });

    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(instructions.slice(SYSTEM_PROMPT.length)).toContain("noche");
    expect(instructions.slice(SYSTEM_PROMPT.length)).toContain("buenas noches");
  });

  it("a las 8:10 am de un domingo, el sufijo dice CERRADA y cuándo abre", () => {
    const instructions = buildInstructions({ ...TURN, now: new Date("2026-09-06T12:10:00Z") });

    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(instructions.slice(SYSTEM_PROMPT.length)).toContain("CERRADA");
    expect(instructions.slice(SYSTEM_PROMPT.length)).toContain("abre el lunes a las 8:00 am");
  });
});

/**
 * Pedido explícito del dueño: el agente no se presenta como IA. De 58 mensajes
 * de la primera noche, 31 decían "Soy el asistente automatizado de SBK
 * Motorcycles" — la fórmula salía directo de este archivo, que se la enseñaba
 * en dos sitios y se la mandaba usar en un tercero.
 *
 * La otra mitad de la regla es igual de importante y no se negocia: tampoco
 * afirma ser una persona. Callar la tecnología es una cosa; jurar que del otro
 * lado hay alguien del mostrador es otra.
 */
describe("identidad: ni IA ni persona", () => {
  /**
   * El bloque sin la línea que prohíbe estas palabras. Que aparezcan EN la
   * prohibición es correcto; lo que no puede haber es una frase que se las
   * ponga en la boca.
   */
  const SIN_LA_PROHIBICION = SYSTEM_PROMPT.split(/\r?\n/)
    .filter((linea) => !linea.startsWith("Nunca te describas como"))
    .join("\n");

  const FORMULAS_PROHIBIDAS = [
    /asistente virtual/i,
    /asistente automatizado/i,
    /inteligencia artificial/i,
    /soy un bot/i,
    /respuesta automática/i,
  ];

  it.each(FORMULAS_PROHIBIDAS)("el prompt no le enseña la fórmula %s", (patron) => {
    expect(SIN_LA_PROHIBICION).not.toMatch(patron);
  });

  it("prohíbe nombrar la tecnología", () => {
    expect(SYSTEM_PROMPT).toMatch(/Nunca te describas como asistente/);
    expect(SYSTEM_PROMPT).toMatch(/inteligencia artificial/i);
  });

  /** Sin esto, "no digas que eres una IA" se lee como "di que eres humano". */
  it("prohíbe también hacerse pasar por una persona", () => {
    expect(SYSTEM_PROMPT).toMatch(/Tampoco afirmes ser una persona concreta/);
  });

  /**
   * Quien pide hablar con una persona no quiere una frase: quiere una persona.
   * La salida honesta es escalar, y el prompt tiene que decirlo ahí mismo.
   */
  it("manda escalar cuando el cliente insiste en hablar con alguien del equipo", () => {
    expect(SYSTEM_PROMPT).toMatch(/insiste en hablar con alguien del equipo/);
    expect(SYSTEM_PROMPT).toMatch(/pásale el caso a un asesor/);
  });

  /** El saludo de bienvenida era el otro sitio donde salía la fórmula. */
  it("el saludo dice de dónde escribe, no qué es", () => {
    const conSaludo = buildInstructions({ ...TURN, needsGreeting: true }).slice(SYSTEM_PROMPT.length);

    expect(conSaludo).toMatch(/le escribes de SBK Motorcycles/);
    expect(conSaludo).not.toMatch(/preséntate/);
  });
});

/**
 * El tool loop entrega hasta cuatro herramientas (ver tools.ts): catálogo,
 * biblioteca, historial de compras y escalar. El prompt tiene que nombrar
 * las cuatro para que el modelo sepa cuándo usar cada una — si falta una,
 * el modelo la ignora aunque el loop se la entregue.
 */
describe("sección 4 — las cuatro herramientas", () => {
  it("nombra el catálogo", () => {
    expect(SYSTEM_PROMPT).toMatch(/búsqueda de catálogo/i);
  });

  it("nombra la biblioteca de conocimiento", () => {
    expect(SYSTEM_PROMPT).toMatch(/biblioteca de conocimiento/i);
  });

  it("nombra el historial de compras", () => {
    expect(SYSTEM_PROMPT).toMatch(/historial de compras/i);
  });

  it("nombra la herramienta de escalar", () => {
    expect(SYSTEM_PROMPT).toMatch(/herramienta de escalar/i);
  });

  /** Solo lectura: nunca aprueba ni procesa la devolución o el reclamo. */
  it("el historial de compras se presenta como solo lectura, sin poder de aprobar", () => {
    expect(SYSTEM_PROMPT).toMatch(/Es solo lectura/);
    expect(SYSTEM_PROMPT).toMatch(/Nunca aprueba ni procesa nada/);
  });
});

/**
 * El catálogo puede venir con la tasa BCV o el inventario desactualizados
 * (tasaDesactualizada / inventarioDesactualizado en tools.ts). El prompt
 * anterior prometía "la tasa BCV del día", una certeza que la herramienta no
 * siempre puede sostener: sin esta regla, el modelo pasaba un dato viejo como
 * si fuera confirmado.
 */
describe("sección 4 — datos viejos no son una confirmación", () => {
  it("ya no promete la tasa del día", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/tasa BCV del día/);
  });

  it("manda dar los datos viejos como lo último registrado, no como confirmación, y ofrecer un asesor", () => {
    expect(SYSTEM_PROMPT).toMatch(/lo último registrado, no como una confirmación/);
    expect(SYSTEM_PROMPT).toMatch(/ofrece que un asesor lo confirme/);
  });
});

/**
 * El clasificador define "otro" como preguntas de tienda que no encajan
 * limpio: horarios, ubicación, formas de pago, seguimiento de un pedido
 * (ver classify.ts). Antes el prompt solo decía "trátalo como disponibilidad",
 * así que una pregunta de horario terminaba en una búsqueda de catálogo que
 * nunca iba a responderla.
 */
describe("sección 5.5 — otro consulta la biblioteca cuando es sobre la tienda", () => {
  it("manda consultar la biblioteca de conocimiento antes de responder", () => {
    const seccion55 = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("5.5 Otro"));

    expect(seccion55).toMatch(/biblioteca de conocimiento/i);
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
