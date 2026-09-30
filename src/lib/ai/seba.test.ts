import { describe, expect, it } from "vitest";
import {
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  OTRA_OPCION_CON_EXISTENCIA,
  TEXTO_ASESOR_CONFIRMA,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_NO_IDENTIFICADO,
  TEXTO_PRECIO_A_CONFIRMAR,
  TEXTO_SIN_STOCK,
  isSebaGreeting,
  presentationGreetingFor,
  sebaGreeting,
  textoMotoSinCalce,
  textoRelajado,
  textoRelajadoAgotado,
  textoUniversales,
  textoVarianteAgotada,
  textoVariasOpciones,
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

// ---------------------------------------------------------------------------
// A2 T5 (30/9/2026, plan "Seba no cotiza lo que no es"): los textos fijos de
// los AVISOS de la búsqueda (D1, D1b, D2, D3). Literales byte a byte: el
// cliente y el operador los dictaron en las decisiones del plan (sección 2), y
// `quote-message.ts` los pinta tal cual. Mismo control de sanidad que las demás
// frases fijas: ninguna puede revelar identidad.
// ---------------------------------------------------------------------------
describe("textos fijos de los avisos de la búsqueda (A2)", () => {
  it("D1, universales: 'estos son universales' y, si son de la marca del cliente, 'de <MARCA> o universales'; en singular con una sola opción", () => {
    expect(textoUniversales(null, 2)).toBe("No encontré uno con el nombre de tu moto; estos son universales:");
    expect(textoUniversales("bera", 2)).toBe("No encontré uno con el nombre de tu moto; estos son de BERA o universales:");
    expect(textoUniversales(null, 1)).toBe("No encontré uno con el nombre de tu moto; este es universal:");
    expect(textoUniversales("bera", 1)).toBe("No encontré uno con el nombre de tu moto; este es de BERA o universal:");
  });

  it("D1, moto sin calce: el asesor confirma cuál le sirve a SU moto", () => {
    expect(textoMotoSinCalce("DT 250")).toBe("El asesor te confirma cuál le sirve a tu DT 250.");
  });

  it("D1b, ítem genérico dentro de una lista: 'hay varias opciones; el asesor te ayuda a elegir'", () => {
    expect(textoVariasOpciones("caucho n° trasero")).toBe(
      "caucho n° trasero: hay varias opciones; el asesor te ayuda a elegir."
    );
  });

  it("D3, palabra relajada: 'No encontré \"X\" en el nombre; esto es lo más parecido'", () => {
    expect(textoRelajado(["pwk"])).toBe('No encontré "pwk" en el nombre; esto es lo más parecido:');
    expect(textoRelajado(["porta", "alforja"])).toBe(
      'No encontré "porta" ni "alforja" en el nombre; esto es lo más parecido:'
    );
  });

  it("D3, lo más parecido está agotado: nunca un agotado a secas", () => {
    expect(textoRelajadoAgotado(["bomba"])).toBe(
      'No encontré "bomba" en el nombre y lo más parecido que encontré está agotado.'
    );
    expect(textoRelajadoAgotado(["a", "b"])).toBe(
      'No encontré "a" ni "b" en el nombre y lo más parecido que encontré está agotado.'
    );
  });

  it("D2, variante agotada: '<variante> agotado' y la UNA alternativa con existencia", () => {
    expect(textoVarianteAgotada("azul")).toBe("Azul agotado.");
    expect(textoVarianteAgotada("39")).toBe("Talla 39 agotada.");
    expect(textoVarianteAgotada("edge")).toBe("Edge agotado.");
    // Concuerda en género: colores y nombres en -a van en femenino; las tallas de letras también.
    expect(textoVarianteAgotada("roja")).toBe("Roja agotada.");
    expect(textoVarianteAgotada("paleta")).toBe("Paleta agotada.");
    expect(textoVarianteAgotada("xl")).toBe("Talla XL agotada.");
    expect(textoVarianteAgotada("2xl")).toBe("Talla 2XL agotada.");
    expect(OTRA_OPCION_CON_EXISTENCIA).toBe("Otra opción con existencia:");
  });

  it("el cierre cuando no se cotizó nada y aun así se escala", () => {
    expect(TEXTO_ASESOR_CONFIRMA).toBe(
      "Te paso con un asesor para que te confirme cuál le sirve y te dé respuesta lo antes posible."
    );
  });

  it("ninguno revela identidad (guarda de identidad)", () => {
    for (const texto of [
      textoUniversales(null, 2),
      textoUniversales("bera", 1),
      textoMotoSinCalce("DT 250"),
      textoVariasOpciones("caucho 18"),
      textoRelajado(["pwk"]),
      textoRelajadoAgotado(["pwk", "bomba"]),
      textoVarianteAgotada("azul"),
      OTRA_OPCION_CON_EXISTENCIA,
      TEXTO_ASESOR_CONFIRMA,
    ]) {
      expect(revealsIdentity(texto), texto).toBeNull();
    }
  });
});
