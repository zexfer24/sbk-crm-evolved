import { describe, expect, it } from "vitest";

/**
 * La barra superior `.dash-nav` (15/11/2026, plan "Paneles"). Con el menú nuevo
 * (diez entradas para un supervisor, más las anclas del Recorrido) la barra ya
 * no cabe a 1024 px, y el primer enlace —«Dashboard»— no se podía alcanzar:
 * `justify-content: center` junto con `overflow-x: auto` reparte el desborde a
 * los DOS lados y la parte izquierda queda fuera del área desplazable (no hay
 * scroll negativo). Medido con Playwright: a 1024 px se cortaban «Dashboard»,
 * «Control de IA» y «Recorrido». `safe center` centra si cabe y alinea al
 * inicio si desborda. jsdom no calcula layout, así que este test mira la HOJA.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/dashboard/dashboard.css"), "utf8");
}

describe("la hoja de estilos de la barra superior .dash-nav", () => {
  it("no centra con `justify-content: center` a secas: desborda hacia la izquierda y deja enlaces inalcanzables", async () => {
    const css = await leerCss();
    const regla = /(?:^|[}/])\s*\.dash-nav\s*\{([^}]*)\}/.exec(css);
    expect(regla, "no se encontró la regla `.dash-nav`").not.toBeNull();

    expect(regla![1]).toMatch(/overflow-x:\s*auto\s*;/);
    expect(regla![1]).toMatch(/justify-content:\s*safe\s+center\s*;/);
    expect(regla![1]).not.toMatch(/justify-content:\s*center\s*;/);
  });

  it("ninguna regla de la hoja vuelve a poner `justify-content: center` sobre `.dash-nav`", async () => {
    const css = await leerCss();
    const reglas = [...css.matchAll(/(?:^|[}/])\s*(\.dash-nav)\s*\{([^}]*)\}/g)];
    expect(reglas.length).toBeGreaterThan(0);
    for (const [, , cuerpo] of reglas) {
      expect(cuerpo).not.toMatch(/justify-content:\s*center\s*;/);
    }
  });
});
