import { describe, expect, it } from "vitest";

/**
 * Asesores a 1440 px (15/11/2026, arreglo del plan "Paneles"): medido con
 * Playwright sobre `/panel/asesores?periodo=30d`, la tabla «Rendimiento por
 * persona» medía 1204 px dentro de un contenedor de 964 px (la columna lateral
 * de Seba y Mostrador se llevaba 300 px más el hueco): quedaba con scroll propio,
 * «Reasignadas» cortada y «Último mensaje» fuera de vista. A 1440 —el ancho de
 * escritorio más común del equipo— la tabla tiene que verse entera.
 *
 * Arreglo: la tabla ocupa TODO el ancho del cuerpo y Seba + Mostrador pasan a
 * una fila propia debajo (dos tarjetas lado a lado, una columna en móvil). La
 * primera columna queda fija si la tabla scrollea (1024 px) y la fecha del
 * último mensaje parte en dos líneas para no ensanchar la tabla.
 *
 * jsdom no calcula layout, así que este test mira la HOJA de estilos (mismo
 * patrón que `agent-control-css.test.ts`); el número real se mide en el navegador.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/paneles/asesores/asesores.css"), "utf8");
}

/** Cuerpos de todas las reglas con ese selector EXACTO (en cualquier nivel de @media). */
function reglas(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const re = new RegExp(`(?:^|[}{/])\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(re)].map((m) => m[1]);
}

describe("la hoja de estilos de Asesores", () => {
  it("el cuerpo es de UNA columna: la tabla no comparte ancho con la columna lateral", async () => {
    const cuerpo = reglas(await leerCss(), ".as-cuerpo").join("\n");
    expect(cuerpo, "una columna fija de 300 px para el lateral le quita ancho a la tabla").not.toMatch(/\b300px\b/);
    expect(cuerpo).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  });

  it("Seba y Mostrador van en una fila propia de dos columnas (una sola en móvil)", async () => {
    const lado = reglas(await leerCss(), ".as-lado");
    expect(lado.some((r) => /display:\s*grid\s*;/.test(r) && /repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(r))).toBe(true);
    expect(
      lado.some((r) => /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(r)),
      "sin la regla de una columna en móvil"
    ).toBe(true);
  });

  it("la primera columna queda fija cuando la tabla scrollea", async () => {
    const css = await leerCss();
    for (const sel of [".as-tabla th:first-child", ".as-tabla td:first-child"]) {
      const regla = reglas(css, sel).join("\n");
      expect(regla, `${sel} sin sticky`).toMatch(/position:\s*sticky\s*;/);
      expect(regla, `${sel} sin left: 0`).toMatch(/left:\s*0\s*;/);
    }
  });

  it("el último mensaje puede partirse en dos líneas (fecha / hora) para no ensanchar la tabla", async () => {
    const fecha = reglas(await leerCss(), ".as-v--fecha").join("\n");
    expect(fecha).not.toMatch(/white-space:\s*nowrap\s*;/);
  });
});
