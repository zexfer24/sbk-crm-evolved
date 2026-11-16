import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Los textos por defecto de Seba v2 viven en DOS sitios: el documento de diseño
 * (`docs/seba-v2/system-prompt-seba-v2.md`, sección «3. Textos fijos», donde el
 * operador los aprobó el 16/11/2026) y los `default` de las columnas nuevas de
 * `agent_settings` (migración 20261116030000). Si divergen, el panel arranca con
 * un texto que nadie aprobó. Este archivo extrae los tres textos del documento y
 * los tres defaults de la migración y exige igualdad EXACTA, byte por byte
 * (emojis incluidos: el 🏍️ lleva selector de variación U+FE0F).
 *
 * También fija que el repo es público: ningún default trae teléfonos, cuentas
 * ni correos.
 */

const RAIZ = process.cwd();

function leer(ruta: string): string {
  // Normaliza CRLF: en Windows un checkout puede traer saltos de línea \r\n.
  return readFileSync(path.join(RAIZ, ruta), "utf8").replace(/\r\n/g, "\n");
}

const MIGRACION = leer("supabase/migrations/20261116030000_seba_v2_configuracion.sql");
const DOCUMENTO = leer("docs/seba-v2/system-prompt-seba-v2.md");

/** El contenido del primer bloque ```text que sigue a `ancla` en el documento. */
function bloqueTrasAncla(ancla: string): string {
  const desde = DOCUMENTO.indexOf(ancla);
  expect(desde, `no encontré «${ancla}» en el documento`).toBeGreaterThanOrEqual(0);
  const apertura = DOCUMENTO.indexOf("```text\n", desde);
  expect(apertura).toBeGreaterThan(desde);
  const inicio = apertura + "```text\n".length;
  const cierre = DOCUMENTO.indexOf("\n```", inicio);
  expect(cierre).toBeGreaterThan(inicio);
  return DOCUMENTO.slice(inicio, cierre);
}

/** Documento: bienvenida, mensaje 1. */
const DOC_BIENVENIDA = bloqueTrasAncla("**Bienvenida, mensaje 1 (informativo).**");

/** Documento: bienvenida, mensaje 2 (cuatro frases, una por línea). */
const DOC_FRASES = bloqueTrasAncla("**Bienvenida, mensaje 2 (humano)").split("\n");

/** Documento: datos de Cashea, del «Para generar…» al «Con eso un asesor…». */
const DOC_CASHEA = (() => {
  const bloque = bloqueTrasAncla("Con Cashea (el enlace lo manda el asesor");
  const inicio = bloque.indexOf("Para generar tu link de compra necesito estos datos:");
  const finTexto = "Con eso un asesor te envía el link por este mismo chat 🙌";
  const fin = bloque.indexOf(finTexto);
  expect(inicio).toBeGreaterThanOrEqual(0);
  expect(fin).toBeGreaterThan(inicio);
  return bloque.slice(inicio, fin + finTexto.length);
})();

/** Migración: el literal `E'…'` de una columna de texto, con los `\n` desescapados. */
function defaultDeTexto(columna: string): string {
  const re = new RegExp(`add column if not exists ${columna} text not null default E'([^'\\n]*)'`);
  const m = MIGRACION.match(re);
  expect(m, `no encontré el default de ${columna} en la migración`).not.toBeNull();
  return (m as RegExpMatchArray)[1].replace(/\\n/g, "\n");
}

/** Migración: las frases del arreglo `welcome_followups`, en orden. */
function defaultDeFrases(): string[] {
  const m = MIGRACION.match(
    /add column if not exists welcome_followups text\[\] not null default array\[([^\]\n]*)\]::text\[\]/,
  );
  expect(m, "no encontré el default de welcome_followups en la migración").not.toBeNull();
  return [...(m as RegExpMatchArray)[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

const SQL_BIENVENIDA = defaultDeTexto("welcome_text");
const SQL_CASHEA = defaultDeTexto("cashea_datos_text");
const SQL_FRASES = defaultDeFrases();

describe("defaults de Seba v2: documento de diseño y migración dicen lo mismo", () => {
  it("welcome_text es idéntico al mensaje 1 de la bienvenida", () => {
    expect(SQL_BIENVENIDA).toBe(DOC_BIENVENIDA);
  });

  it("welcome_followups son las cuatro frases del mensaje 2, en orden", () => {
    expect(SQL_FRASES).toEqual(DOC_FRASES);
  });

  it("cashea_datos_text es idéntico al bloque de datos de Cashea", () => {
    expect(SQL_CASHEA).toBe(DOC_CASHEA);
  });
});

describe("defaults de Seba v2: forma fijada con literales", () => {
  it("la bienvenida empieza como la aprobó el operador (con el selector de variación del emoji)", () => {
    expect(SQL_BIENVENIDA.startsWith("¡Hola! Bienvenido a *SBK Motors* 🏍️")).toBe(true);
  });

  it("son exactamente cuatro frases y cada una mide 160 caracteres o menos", () => {
    expect(SQL_FRASES).toHaveLength(4);
    for (const frase of SQL_FRASES) {
      expect(frase.length).toBeGreaterThan(0);
      expect(frase.length).toBeLessThanOrEqual(160);
    }
  });

  it("la bienvenida y los datos de Cashea caben en el tope de 1000 de la base", () => {
    expect(SQL_BIENVENIDA.length).toBeLessThanOrEqual(1000);
    expect(SQL_CASHEA.length).toBeLessThanOrEqual(1000);
  });

  it("los datos de Cashea piden los cuatro datos y cierran con el asesor", () => {
    expect(SQL_CASHEA.startsWith("Para generar tu link de compra necesito estos datos:")).toBe(true);
    expect(SQL_CASHEA.endsWith("Con eso un asesor te envía el link por este mismo chat 🙌")).toBe(true);
    expect(SQL_CASHEA.match(/✅/g)).toHaveLength(4);
  });

  it("ningún default trae una secuencia de 7 o más dígitos ni una arroba (el repo es público)", () => {
    for (const texto of [SQL_BIENVENIDA, SQL_CASHEA, ...SQL_FRASES]) {
      expect(texto).not.toMatch(/\d{7,}/);
      expect(texto).not.toContain("@");
    }
  });
});
