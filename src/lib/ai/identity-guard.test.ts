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
