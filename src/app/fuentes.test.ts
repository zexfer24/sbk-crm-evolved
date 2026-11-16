import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Resguardo del 16/11/2026: el build de producción estuvo roto desde el
// 8/11/2026 porque `next/font/google` hace que Turbopack (Next 16.3.1) parta
// por `&` las URLs `https://fonts.gstatic.com/l/font?kit=…&skey=…` que Google
// sirve según el servidor y el momento ("queries have exactly one entry").
// Las tres fuentes viven ahora en `src/app/fuentes/` y se sirven con
// `next/font/local`; este archivo impide volver a depender de Google en build.

const RAIZ_SRC = path.resolve(__dirname, "..");
const CARPETA_FUENTES = path.resolve(__dirname, "fuentes");

// Se busca el especificador ENTRE COMILLAS (un import o un require), no el texto
// suelto: los comentarios que cuentan la historia lo nombran con acentos graves.
// Armado por concatenación para que este archivo no se detecte a sí mismo.
const ESPECIFICADOR_GOOGLE = new RegExp(`["']${"next/font/" + "google"}["']`);

function archivosFuente(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = path.join(dir, nombre);
    if (statSync(ruta).isDirectory()) {
      salida.push(...archivosFuente(ruta));
    } else if (/\.(ts|tsx)$/.test(nombre)) {
      salida.push(ruta);
    }
  }
  return salida;
}

// Los sha256 se fijan como literales (no se calculan de otra copia): son los
// bytes exactos que el build precargaba desde fonts.gstatic.com.
const FUENTES = [
  {
    archivo: "geist-latin.woff2",
    sha256: "9b6f5ff45b278c744b5f379a2c4ecbaf858a842b8eaf82ac8d21b699ca16c608",
    licencia: "OFL-geist.txt",
  },
  {
    archivo: "geist-mono-latin.woff2",
    sha256: "5f3d6ad60f29d6cb708414ec6887163d63bf197377ef5417d2483ff31ace6c3b",
    licencia: "OFL-geist-mono.txt",
  },
  {
    archivo: "familjen-grotesk-italic-latin.woff2",
    sha256: "c1b76bd412563fd8d2fc4f8e253a8a0818ead39ab80d17f983c8502bb571134d",
    licencia: "OFL-familjen-grotesk.txt",
  },
];

describe("fuentes locales", () => {
  it("ningún archivo de src importa next/font/google", () => {
    const culpables = archivosFuente(RAIZ_SRC)
      .filter((ruta) => ESPECIFICADOR_GOOGLE.test(readFileSync(ruta, "utf8")))
      .map((ruta) => path.relative(RAIZ_SRC, ruta));
    expect(culpables).toEqual([]);
  });

  it("layout.tsx sirve las tres fuentes con next/font/local y las mismas variables", () => {
    const layout = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");
    expect(layout).toContain('from "next/font/local"');
    expect(layout).toContain('variable: "--font-geist-sans"');
    expect(layout).toContain('variable: "--font-geist-mono"');
    expect(layout).toContain('variable: "--font-familjen-grotesk"');
    for (const { archivo } of FUENTES) {
      expect(layout).toContain(`./fuentes/${archivo}`);
    }
  });

  it("los tres woff2 son los mismos bytes que servía Google", () => {
    for (const { archivo, sha256 } of FUENTES) {
      const ruta = path.join(CARPETA_FUENTES, archivo);
      expect(existsSync(ruta), `falta ${archivo}`).toBe(true);
      const bytes = readFileSync(ruta);
      expect(bytes.subarray(0, 4).toString("latin1"), `firma de ${archivo}`).toBe("wOF2");
      expect(createHash("sha256").update(bytes).digest("hex"), `sha256 de ${archivo}`).toBe(
        sha256,
      );
    }
  });

  it("cada fuente viaja con su licencia OFL", () => {
    for (const { licencia } of FUENTES) {
      const ruta = path.join(CARPETA_FUENTES, licencia);
      expect(existsSync(ruta), `falta ${licencia}`).toBe(true);
      expect(readFileSync(ruta, "utf8").toUpperCase()).toContain("SIL OPEN FONT LICENSE");
    }
  });
});
