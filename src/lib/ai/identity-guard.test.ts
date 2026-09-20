import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { revealsIdentity, rewriteSuffix } from "./identity-guard";

// Quita diacríticos para generar la variante "sin acentos" de cada frase de
// prueba (misma técnica que usa el módulo bajo prueba, reimplementada acá
// para no depender de un detalle interno de identity-guard.ts).
function quitarAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Frases reales (26-27/8/2026) y variantes mínimas que deben calzar como
// autorreferencia a la automatización.
const FRASES_AUTOMATIZACION = [
  "Soy el asistente automatizado de SBK Motorcycles.",
  "¡Buenos días! Soy el asistente automatizado de SBK Motorcycles.",
  "Buenas noches, tranquilo por la hora. Soy el asistente automatizado de SBK Motorcycles.",
  "soy un bot",
  "soy una inteligencia artificial",
  "esta es una respuesta automática",
  "como IA no puedo",
  "soy un asistente virtual",
  "no soy una persona",
  "Soy ChatGPT",
  // 15/9/2026 (Tarea 2, "La voz de mostrador con nombre propio"): "agente
  // virtual/automatizado/de IA/conversacional" describe al programa, igual
  // que "asistente automatizado" — ver identity-guard.ts.
  "soy un agente virtual",
  "somos un agente automatizado que te escribe",
  "como agente de IA",
];

// Frases que deben calzar como afirmación de ser una persona.
const FRASES_PERSONA = [
  "soy una persona",
  "me llamo Carlos",
  "mi nombre es Ana",
  "estoy en el mostrador",
];

// Negativos obligatorios: repuestos del catálogo ("automático"/"digital"
// sueltos), uso normal de "sistema" fuera de autorreferencia, y frases que
// se parecen a un patrón sin serlo (guía, botón, María, el plural legítimo).
const NEGATIVOS = [
  "El automático de la Horse está en 12$ a tasa BCV",
  "AUTOMATICO BERA R1 AUTOASIA",
  "CDI RACING AUTOMATICO HORSE",
  "PRENSA CADENA AUTOMATICO GP",
  "tacómetro digital",
  "TACOMETRO DIGITAL BERA SBR",
  "el sistema lo hace automáticamente",
  "sistema de pagos",
  "guía de envío",
  "GUIA DE ENVIO",
  "botas",
  "botón",
  "te lo confirma un asesor",
  "la app de Cashea",
  "María te atiende",
  "¿Tienes la guía?",
  "Acá en SBK lo tenemos, te lo confirmamos con un asesor.",
  "Escribimos desde SBK Motorcycles.",
  // 15/9/2026 (Tarea 2): "agente" SUELTO no se bloquea — los asesores
  // humanos son `agents` en el resto del sistema.
  "un agente de ventas te escribe por acá",
  "tu agente asignado",
];

describe("revealsIdentity — positivos de automatizacion", () => {
  it.each(FRASES_AUTOMATIZACION)("detecta \"%s\" tal cual", (frase) => {
    const resultado = revealsIdentity(frase);
    expect(resultado?.categoria).toBe("automatizacion");
  });

  it.each(FRASES_AUTOMATIZACION)("detecta \"%s\" en MAYÚSCULAS", (frase) => {
    const resultado = revealsIdentity(frase.toUpperCase());
    expect(resultado?.categoria).toBe("automatizacion");
  });

  it.each(FRASES_AUTOMATIZACION)("detecta \"%s\" en minúsculas", (frase) => {
    const resultado = revealsIdentity(frase.toLowerCase());
    expect(resultado?.categoria).toBe("automatizacion");
  });

  it.each(FRASES_AUTOMATIZACION)("detecta \"%s\" sin acentos", (frase) => {
    const resultado = revealsIdentity(quitarAcentos(frase));
    expect(resultado?.categoria).toBe("automatizacion");
  });
});

describe("revealsIdentity — positivos de persona", () => {
  it.each(FRASES_PERSONA)("detecta \"%s\" tal cual", (frase) => {
    const resultado = revealsIdentity(frase);
    expect(resultado?.categoria).toBe("persona");
  });

  it.each(FRASES_PERSONA)("detecta \"%s\" en MAYÚSCULAS", (frase) => {
    const resultado = revealsIdentity(frase.toUpperCase());
    expect(resultado?.categoria).toBe("persona");
  });
});

describe("revealsIdentity — negativos obligatorios (repuestos y falsos amigos)", () => {
  it.each(NEGATIVOS)("no marca \"%s\"", (frase) => {
    expect(revealsIdentity(frase)).toBeNull();
  });

  // Los repuestos del catálogo tienen que sobrevivir también en mayúsculas,
  // que es como suelen venir cargados en la tabla products.
  it.each(NEGATIVOS)("no marca \"%s\" en MAYÚSCULAS", (frase) => {
    expect(revealsIdentity(frase.toUpperCase())).toBeNull();
  });
});

describe("revealsIdentity — forma del resultado", () => {
  it("el fragmento es el trozo que calzó, no el mensaje entero", () => {
    const resultado = revealsIdentity(
      "Soy el asistente automatizado de SBK Motorcycles.",
    );
    expect(resultado).not.toBeNull();
    expect(resultado?.fragmento).toContain("asistente automatizado");
    expect(resultado?.fragmento).not.toContain("SBK");
  });

  it("\\bIA\\b sensible a mayúsculas: 'como IA no puedo' calza, 'como ia no puedo' también (por otro patrón), pero 'guía' y 'MARIA' no calzan por IA suelta", () => {
    expect(revealsIdentity("como IA no puedo")?.categoria).toBe("automatizacion");
    expect(revealsIdentity("guía de envío")).toBeNull();
    expect(revealsIdentity("María te atiende")).toBeNull();
  });

  it("una frase sin ninguna autorreferencia devuelve null", () => {
    expect(revealsIdentity("El repuesto está disponible en el catálogo.")).toBeNull();
  });
});

describe("rewriteSuffix", () => {
  it("incluye el fragmento entre comillas angulares", () => {
    const texto = rewriteSuffix("asistente automatizado");
    expect(texto).toContain("«asistente automatizado»");
  });

  it("pide reescribir sin mencionar asistente, bot, IA, sistema ni respuesta automática", () => {
    const texto = rewriteSuffix("soy un bot");
    expect(texto).toMatch(/asistente/);
    expect(texto).toMatch(/bot/);
    expect(texto).toMatch(/IA/);
    expect(texto).toMatch(/sistema/);
    expect(texto).toMatch(/respuesta automática/);
  });
});

// 18/9/2026 (T2a, plan "Seba atiende el mostrador", requisito 1 del
// cliente): la IA se llama Seba y puede presentarse como "tu asistente" —
// "asistente" a secas deja de estar bloqueado, y el nombre "Seba" queda
// excepcionado del patrón que bloquea afirmar un nombre propio. Cualquier
// otro nombre, o "asistente" en combinación con "virtual"/"automatizado",
// sigue bloqueado igual que antes.
describe("la excepción de Seba (18/9/2026)", () => {
  it("'Soy el asistente de SBK Motors' pasa (asistente solo, sin más compañía)", () => {
    expect(revealsIdentity("Soy el asistente de SBK Motors")).toBeNull();
  });

  it("'soy un asistente virtual' sigue bloqueado", () => {
    expect(revealsIdentity("soy un asistente virtual")?.categoria).toBe("automatizacion");
  });

  it("'mi nombre es Seba' pasa", () => {
    expect(revealsIdentity("mi nombre es Seba")).toBeNull();
  });

  it("'mi nombre es Carlos' sigue bloqueado como persona", () => {
    expect(revealsIdentity("mi nombre es Carlos")?.categoria).toBe("persona");
  });

  it("'me llamo Juan' sigue bloqueado como persona", () => {
    expect(revealsIdentity("me llamo Juan")?.categoria).toBe("persona");
  });

  /**
   * Mutación de verificación (resguardo antes del push, 20/9/2026, tarea
   * M1/T3-a: "`(?!seba\\b)` sin `\\b`" de la lista de sospechosas). "Seba" es
   * la ÚNICA excepción -- "Sebastián" es un nombre DISTINTO y tiene que
   * seguir bloqueado como persona. Sin la frontera de palabra en el
   * lookahead, `(?!seba)` "encuentra" el prefijo "seba" dentro de
   * "sebastián" igual que dentro de "seba", así que el lookahead negativo
   * falla en los dos casos y el patrón entero deja de calzar: "mi nombre es
   * Sebastián" pasaría sin bloquear, dejando a la IA presentarse con un
   * nombre que nunca dijo el guion. Ninguno de los dos tests de arriba ("Seba
   * pasa", "Carlos bloqueado") distingue esto: "Sebastián" comparte el
   * prefijo con la excepción pero no es la excepción.
   */
  it("'mi nombre es Sebastián' sigue bloqueado como persona (comparte el prefijo con la excepción, pero no ES la excepción)", () => {
    expect(revealsIdentity("mi nombre es Sebastián")?.categoria).toBe("persona");
  });

  it("'me llamo Sebastián' sigue bloqueado como persona", () => {
    expect(revealsIdentity("me llamo Sebastián")?.categoria).toBe("persona");
  });
});

describe("pureza del módulo", () => {
  // Nota de la trampa: este test lee el archivo fuente con fs en vez de
  // inspeccionar el grafo de módulos en runtime, así que no detecta un
  // import de puros TIPOS que TypeScript borre en la compilación. Para lo
  // que importa acá —que ni agent.ts (servidor) ni mutations.ts (navegador)
  // arrastren nada al reusar este módulo— alcanza con que no haya ninguna
  // línea `import` en el archivo.
  it("identity-guard.ts no tiene ninguna línea import", () => {
    const ruta = path.join(__dirname, "identity-guard.ts");
    const fuente = readFileSync(ruta, "utf8");
    const lineasImport = fuente
      .split("\n")
      .filter((linea) => /^\s*import\s/.test(linea));
    expect(lineasImport).toHaveLength(0);
  });
});
