import { describe, expect, it } from "vitest";
import { INTENT_VALUES } from "@/lib/ai/classify";
import {
  MEDIA_RULES,
  OFF_TOPIC_REPLY,
  SALES_ACCEPTANCE_RULES,
  SYSTEM_PROMPT,
  TONE_RULES,
  buildInstructions,
} from "@/lib/ai/prompt";
import { greetingWindow } from "@/lib/ai/greeting-window";
import { revealsIdentity } from "@/lib/ai/identity-guard";

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
   * Reescrito el 14/9/2026 (Tarea 2, "La voz cercana y la espera visible"):
   * hasta entonces la regla era "copia la franja y el saludo que te llegan
   * en TURNO ACTUAL", y `turnClockLine` los traía calculados ("franja: tarde
   * (saluda 'buenas tardes')"). El cliente reportó que la IA saludaba por
   * franja en mitad de una conversación ya empezada — la regla no distinguía
   * el primer mensaje de cualquier otro. Ahora el saludo es neutro y depende
   * de `needsGreeting`, no de la hora: la sección 6 ya no menciona ninguna
   * franja ni ningún "buenos días/tardes/noches".
   */
  it("la regla es saludar una sola vez, sin depender de la hora", () => {
    expect(SYSTEM_PROMPT).toMatch(/Saludas UNA sola vez por conversación/i);
    expect(SYSTEM_PROMPT).toMatch(/Nunca saludes por la hora/i);
    expect(SYSTEM_PROMPT).toMatch(/el horario de atención y si la tienda está abierta ahora mismo también te llegan en TURNO ACTUAL/i);
    // La prosa vieja (franja/saludo por hora) desapareció por completo.
    expect(SYSTEM_PROMPT).not.toMatch(/usa la franja y el saludo/i);
    expect(SYSTEM_PROMPT).not.toMatch(/antes del mediodía/i);
  });

  /**
   * `greetingWindow` (los escenarios del panel) conserva sus propios bordes
   * horarios — eso no cambió el 14/9/2026, y sigue siendo la red para un
   * escenario del dueño que empiece con un saludo de franja escrito a mano.
   * Lo que sí cambió es que `turnClockLine` (el flujo genérico) YA NO trae
   * ninguna franja para comparar: por eso este test dejó de verificar que
   * `buildInstructions` diga "franja: tarde"/"franja: noche" a las 7:00 pm.
   */
  it("greetingWindow sigue poniendo el borde entre tarde y noche a las 7:00 pm", () => {
    expect(greetingWindow("¡Buenas tardes! ¿En qué podemos ayudarle?")?.to).toBe(19 * 60);
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
   * Reescrito el 14/9/2026 (Tarea 2): hasta entonces se pedía "de noche
   * entra 'noche'/'buenas noches'" — ahora es justo lo contrario, a
   * propósito. `turnClockLine` ya no calcula ninguna franja ni saludo, y la
   * sección 6 prohíbe saludar por hora: a las 8:30 pm el sufijo tiene que
   * seguir sin decir "noche" ni "buenas noches", igual que a las 8:10 am no
   * puede decir "franja" ni "buenos días" — el saludo neutro vive solo en
   * `needsGreeting`, nunca en la hora.
   */
  it("a las 8:30 pm de Caracas, el sufijo no saluda por franja ni dice 'noche'", () => {
    const instructions = buildInstructions({ ...TURN, now: new Date("2026-09-05T00:30:00Z") }); // 8:30 pm Caracas

    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
    const sufijo = instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).not.toMatch(/saluda|buenos días|buenas tardes|buenas noches|franja/i);
  });

  it("a las 8:10 am de un domingo, el sufijo dice CERRADA y cuándo abre, sin saludo de franja", () => {
    const instructions = buildInstructions({ ...TURN, now: new Date("2026-09-06T12:10:00Z") });

    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
    const sufijo = instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("CERRADA");
    expect(sufijo).toContain("abre el lunes a las 8:00 am");
    expect(sufijo).not.toMatch(/saluda|buenos días|buenas tardes|buenas noches|franja/i);
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

  /**
   * Tarea 2 (14/9/2026): el sufijo `needsGreeting` es el texto nuevo del
   * primer saludo — nombra SBK Motorcycles y tiene que pasar la misma guarda
   * que MEDIA_RULES y SALES_ACCEPTANCE_RULES, aunque no esté exportado
   * aparte (es corto, y vive en el sufijo, no en el prefijo cacheado).
   */
  it("el sufijo del primer saludo nombra SBK Motorcycles y pasa la guarda de identidad", () => {
    const conSaludo = buildInstructions({ ...TURN, needsGreeting: true }).slice(SYSTEM_PROMPT.length);
    const sinSaludo = buildInstructions({ ...TURN, needsGreeting: false }).slice(SYSTEM_PROMPT.length);

    expect(conSaludo).toMatch(/SBK Motorcycles/);
    expect(revealsIdentity(conSaludo)).toBeNull();
    expect(revealsIdentity(sinSaludo)).toBeNull();
  });
});

/**
 * 9/9/2026: T2 del plan "Seis frentes del buzón" (8/9/2026) había hecho que
 * la IA pidiera una SEGUNDA confirmación antes de pasar el caso a ventas. En
 * producción hizo bucle — el cliente contestaba "ok", "está bien" o "dale" en
 * vez de un "sí" literal, el modelo no lo contaba como la segunda
 * confirmación, y la conversación quedaba dando vueltas sin escalar nunca. El
 * operador aprobó volver al primer "sí": `handoff-confirmation.ts` (la
 * máquina de estados que hacía de red de seguridad en código) se borró, y
 * `SALES_ACCEPTANCE_RULES` reemplaza a `SALES_HANDOFF_RULES` con la misma
 * forma que ya usa `MEDIA_RULES`.
 */
describe("sección 3 — aceptar es pasar de una vez, sin reconfirmar (9/9/2026)", () => {
  it("SALES_ACCEPTANCE_RULES es parte del bloque estático que se cachea", () => {
    expect(SYSTEM_PROMPT).toContain(SALES_ACCEPTANCE_RULES);
  });

  it("buildInstructions también trae SALES_ACCEPTANCE_RULES, dentro del prefijo cacheado", () => {
    const instructions = buildInstructions(TURN);

    expect(instructions).toContain(SALES_ACCEPTANCE_RULES);
    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  it("ya no pide confirmar dos veces, ni deja rastro de la reconfirmación de T2", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/confirma dos veces/i);
    expect(SYSTEM_PROMPT).not.toMatch(/segunda vez/i);
    expect(SYSTEM_PROMPT).not.toMatch(/reconfirmaci[oó]n/i);
  });

  it("nombra formas de aceptar más allá del 'sí' literal", () => {
    expect(SALES_ACCEPTANCE_RULES).toMatch(/"ok"/i);
    expect(SALES_ACCEPTANCE_RULES).toMatch(/"está bien"/i);
    expect(SALES_ACCEPTANCE_RULES).toMatch(/"dale"/i);
  });

  it("manda pasar el caso de una vez, sin pedir que lo confirme otra vez", () => {
    expect(SALES_ACCEPTANCE_RULES).toMatch(/pásalo de una vez/i);
    expect(SALES_ACCEPTANCE_RULES).toMatch(/no le pidas que te lo confirme otra vez/i);
  });

  /** Nada de lo que le dice al modelo sobre aceptar la venta puede describirlo como automatizado o como una persona. */
  it("pasa la guarda de identidad limpio", () => {
    expect(revealsIdentity(SALES_ACCEPTANCE_RULES)).toBeNull();
  });

  /**
   * Mismo control de sanidad que ya tiene MEDIA_RULES: prueba de que el test
   * anterior de verdad mira lo que dice mirar.
   */
  it("la guarda sí atrapa una fórmula prohibida pegada al final", () => {
    const conFormulaProhibida = `${SALES_ACCEPTANCE_RULES} Soy un asistente automatizado.`;

    const match = revealsIdentity(conFormulaProhibida);

    expect(match).not.toBeNull();
    expect(match?.categoria).toBe("automatizacion");
  });

  it("la sección 5.1 vuelve a escalar directo con intencion_compra, sin remitir a ninguna reconfirmación", () => {
    const seccion51 = SYSTEM_PROMPT.slice(
      SYSTEM_PROMPT.indexOf("5.1 Consulta de disponibilidad"),
      SYSTEM_PROMPT.indexOf("5.2 Devolución")
    );

    expect(seccion51).toMatch(/escala con motivo intencion_compra/i);
    expect(seccion51).not.toMatch(/reconfirmaci[oó]n/i);
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

/**
 * Sección 7 ("LO QUE TE LLEGA SIN TEXTO"): desde T2, el historial describe
 * fotos, videos, notas de voz, stickers y documentos entre corchetes en vez
 * de omitirlos. Este bloque le dice al modelo qué hacer con esas líneas, y
 * tiene que seguir siendo parte del prefijo estático (cacheable) — nunca del
 * sufijo, que se paga entero en cada turno.
 */
describe("sección 7 — lo que llega sin texto", () => {
  it("MEDIA_RULES es parte del bloque estático que se cachea", () => {
    expect(SYSTEM_PROMPT).toContain(MEDIA_RULES);
  });

  it("buildInstructions también trae MEDIA_RULES, dentro del prefijo cacheado", () => {
    const instructions = buildInstructions(TURN);

    expect(instructions).toContain(MEDIA_RULES);
    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  /** Nada de lo que le dice al modelo qué hacer con media puede describirlo como automatizado o como una persona. */
  it("pasa la guarda de identidad limpio", () => {
    expect(revealsIdentity(MEDIA_RULES)).toBeNull();
  });

  /**
   * Prueba de que el test anterior de verdad mira lo que dice mirar: si
   * MEDIA_RULES calzara con una fórmula prohibida, la guarda tiene que
   * atraparlo. Sin este test, un `revealsIdentity(MEDIA_RULES) === null`
   * que pasara "por casualidad" (por ejemplo, si alguien rompiera el import)
   * no se notaría.
   */
  it("la guarda sí atrapa una fórmula prohibida pegada al final", () => {
    const conFormulaProhibida = `${MEDIA_RULES} Soy un asistente automatizado.`;

    const match = revealsIdentity(conFormulaProhibida);

    expect(match).not.toBeNull();
    expect(match?.categoria).toBe("automatizacion");
  });

  it("cubre las cinco conductas: foto, video, nota de voz, sticker y documento", () => {
    const texto = MEDIA_RULES.toLowerCase();

    expect(texto).toContain("foto");
    expect(texto).toContain("video");
    expect(texto).toContain("nota de voz");
    expect(texto).toContain("sticker");
    expect(texto).toContain("documento");
    expect(texto).toContain("corchetes");
  });
});

/**
 * Sección "6 BIS. CÓMO SUENAS" (Tarea 3, "La voz cercana y la espera
 * visible", 14/9/2026): hasta acá el guion solo pedía "cercano, directo,
 * sencillo" (sección 1) sin ninguna regla concreta de tono, y los textos
 * fijos de la IA (OFF_TOPIC_REPLY, las despedidas de agent.ts, la
 * instrucción de escalar de tools.ts) eran secos por la misma razón.
 */
describe("sección 6 bis — cómo suenas", () => {
  it("TONE_RULES es parte del bloque estático que se cachea", () => {
    expect(SYSTEM_PROMPT).toContain(TONE_RULES);
  });

  it("buildInstructions también trae TONE_RULES, dentro del prefijo cacheado", () => {
    const instructions = buildInstructions(TURN);

    expect(instructions).toContain(TONE_RULES);
    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  it("pasa la guarda de identidad limpio", () => {
    expect(revealsIdentity(TONE_RULES)).toBeNull();
  });

  it("la guarda sí atrapa una fórmula prohibida pegada al final", () => {
    const conFormulaProhibida = `${TONE_RULES} Soy un asistente automatizado.`;

    const match = revealsIdentity(conFormulaProhibida);

    expect(match).not.toBeNull();
    expect(match?.categoria).toBe("automatizacion");
  });

  it("manda tutear, nunca 'usted'", () => {
    expect(TONE_RULES).toMatch(/Tutéate siempre/i);
  });

  it("manda reconocer lo que pidió el cliente antes de dar el dato", () => {
    expect(TONE_RULES).toMatch(/reconoce en media frase lo que te preguntó/i);
  });

  /**
   * Mutación de esta tarea: quitar esta regla debe poner en rojo un test que
   * busque exactamente "por qué" y "qué va a pasar" — es la regla (3) del
   * checklist, la que evita despedidas secas como "te paso con un asesor".
   */
  it("manda decir por qué se pasa el caso y qué va a pasar, nunca solo 'te paso con un asesor'", () => {
    expect(TONE_RULES).toMatch(/por qué lo haces y qué va a pasar/i);
    expect(TONE_RULES).toMatch(/nunca sueltes solo "te paso con un asesor"/i);
  });

  it("una pregunta nunca se contesta con una sola línea seca ni con un 'no' a secas", () => {
    expect(TONE_RULES).toMatch(/nunca se contesta con una sola línea seca/i);
  });

  it("manda agradecer cuando el cliente da un dato o espera", () => {
    expect(TONE_RULES).toMatch(/Agradece cuando el cliente/i);
  });

  it("limita a un emoji por mensaje, solo de tres posibles", () => {
    expect(TONE_RULES).toMatch(/Como mucho un emoji por mensaje/i);
    expect(TONE_RULES).toContain("🏍️");
    expect(TONE_RULES).toContain("👍");
    expect(TONE_RULES).toContain("🙌");
  });

  it("manda disculparse antes de resolver cuando el cliente está molesto", () => {
    expect(TONE_RULES).toMatch(/primero la disculpa, después la solución/i);
  });

  it("prohíbe las fórmulas de correo", () => {
    expect(TONE_RULES).toMatch(/estimado/i);
    expect(TONE_RULES).toMatch(/le informamos/i);
    expect(TONE_RULES).toMatch(/procedemos/i);
    expect(TONE_RULES).toMatch(/en breve estaremos/i);
  });

  it("el bloque estático no usa 'estimado' fuera de la prohibición de esta sección y de la sección 1", () => {
    // Las dos únicas líneas que pueden nombrar "estimado" son las que lo
    // prohíben (sección 1 y TONE_RULES); ninguna otra línea del guion puede
    // usarlo para dirigirse al cliente.
    const lineasConEstimado = SYSTEM_PROMPT.split(/\r?\n/).filter((linea) => /estimado/i.test(linea));

    for (const linea of lineasConEstimado) {
      expect(linea).toMatch(/estimado cliente"|"estimado"/i);
    }
  });
});

/**
 * Decisión 2 del plan (14/9/2026): la IA usa el nombre del cliente cuando lo
 * conoce. `customerFirstName` (customer-name.ts) ya decidió si lo que hay
 * guardado parece un nombre de persona; acá solo se prueba que el sufijo lo
 * incluya o no según lo que llega.
 */
describe("sufijo dinámico — nombre del cliente (Tarea 3, 14/9/2026)", () => {
  it("con un nombre, el sufijo lo nombra y pide usarlo con naturalidad", () => {
    const sufijo = buildInstructions({ ...TURN, customerName: "Ana" }).slice(SYSTEM_PROMPT.length);

    expect(sufijo).toContain("El cliente se llama Ana");
    expect(sufijo).toMatch(/úsalo con naturalidad/i);
  });

  it("sin nombre (null o undefined), el sufijo no menciona ningún nombre", () => {
    const sinNombreNull = buildInstructions({ ...TURN, customerName: null }).slice(SYSTEM_PROMPT.length);
    const sinNombreUndefined = buildInstructions(TURN).slice(SYSTEM_PROMPT.length);

    expect(sinNombreNull).not.toMatch(/El cliente se llama/);
    expect(sinNombreUndefined).not.toMatch(/El cliente se llama/);
  });

  it("no rompe el prefijo cacheado", () => {
    const instructions = buildInstructions({ ...TURN, customerName: "Ana" });

    expect(instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
  });
});

/**
 * Tarea 7 ("El guion atiende a quien no es cliente, el horario, el agotado y
 * las listas largas", 14/9/2026, Decisión 8): tres huecos de la auditoría.
 */
describe("Tarea 7 — horario, agotado con aviso y listas largas (14/9/2026)", () => {
  it("5.5 responde el horario con lo que dice TURNO ACTUAL, sin escalar ni consultar nada", () => {
    const seccion55 = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("5.5 Otro"), SYSTEM_PROMPT.indexOf("6. CÓMO ESCRIBES"));

    expect(seccion55).toMatch(/horario/i);
    expect(seccion55).toMatch(/TURNO ACTUAL/);
    expect(seccion55).toMatch(/sin escalar/i);
  });

  it("5.1 un agotado con aviso escala con motivo seguimiento, no como intencion_compra", () => {
    const seccion51 = SYSTEM_PROMPT.slice(
      SYSTEM_PROMPT.indexOf("5.1 Consulta de disponibilidad"),
      SYSTEM_PROMPT.indexOf("5.2 Devolución")
    );

    expect(seccion51).toMatch(/agotado/i);
    expect(seccion51).toMatch(/avisen cuando llegue/i);
    expect(seccion51).toMatch(/motivo seguimiento/i);
    expect(seccion51).toMatch(/qué repuesto y para qué moto/i);
  });

  it("sección 3 pide la lista completa de una vez, sin interrogar repuesto por repuesto", () => {
    const seccion3 = SYSTEM_PROMPT.slice(
      SYSTEM_PROMPT.indexOf("3. CÓMO LLEVAS"),
      SYSTEM_PROMPT.indexOf("4. HERRAMIENTAS")
    );

    expect(seccion3).toMatch(/lista de varios repuestos/i);
    expect(seccion3).toMatch(/mayor/i);
    expect(seccion3).toMatch(/UNA vez marca y modelo/i);
    expect(seccion3).toMatch(/un renglón por repuesto/i);
  });

  /** Los tres textos nuevos pasan la misma guarda que ya cubre el resto del prompt. */
  it("los tres textos nuevos pasan la guarda de identidad", () => {
    const seccion51 = SYSTEM_PROMPT.slice(
      SYSTEM_PROMPT.indexOf("5.1 Consulta de disponibilidad"),
      SYSTEM_PROMPT.indexOf("5.2 Devolución")
    );
    const seccion55 = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("5.5 Otro"), SYSTEM_PROMPT.indexOf("6. CÓMO ESCRIBES"));
    const seccion3 = SYSTEM_PROMPT.slice(
      SYSTEM_PROMPT.indexOf("3. CÓMO LLEVAS"),
      SYSTEM_PROMPT.indexOf("4. HERRAMIENTAS")
    );

    expect(revealsIdentity(seccion51)).toBeNull();
    expect(revealsIdentity(seccion55)).toBeNull();
    expect(revealsIdentity(seccion3)).toBeNull();
  });
});

/**
 * Los cinco textos fijos que el plan exige pasar por la guarda de identidad
 * (Tarea 3, 14/9/2026). Los otros tres —DESPEDIDA_SIN_ASESOR,
 * despedidaConAsesor y la instrucción de buildEscalateTool— viven en
 * agent.ts y tools.ts, y ya los cubren agent.test.ts y tools.test.ts: acá
 * solo los dos que son de este módulo.
 */
describe("los textos fijos de prompt.ts pasan la guarda de identidad (Tarea 3, 14/9/2026)", () => {
  it("OFF_TOPIC_REPLY", () => {
    expect(revealsIdentity(OFF_TOPIC_REPLY)).toBeNull();
  });

  it("el sufijo de catálogo apagado", () => {
    const sufijo = buildInstructions({ ...TURN, missingCatalog: true }).slice(SYSTEM_PROMPT.length);

    expect(revealsIdentity(sufijo)).toBeNull();
  });
});
