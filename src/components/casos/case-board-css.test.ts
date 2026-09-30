import { describe, expect, it } from "vitest";

/**
 * El tablero de «Casos» a 390 px (T7, plan "La ronda del cliente",
 * 30/9/2026). Las columnas son de ancho fijo y se deslizan en horizontal: si
 * el carril no se acota, su ancho (≈ 300 px por etiqueta) arrastra a toda la
 * página — el mismo desborde que Control IA tuvo con sus pestañas el
 * 30/9/2026 (`agent-control-css.test.ts`). jsdom no calcula layout, así que
 * este test mira la HOJA.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/casos/case-board.css"), "utf8");
}

function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regla = new RegExp(`(?:^|[}/])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(regla, `no se encontró la regla \`${selector}\` en case-board.css`).not.toBeNull();
  return regla![1];
}

describe("la hoja de estilos del tablero de Casos", () => {
  it(".cb-board es un carril horizontal acotado: el scroll es del carril, no de la página", async () => {
    const regla = bloque(await leerCss(), ".cb-board");

    expect(regla).toMatch(/display:\s*flex\s*;/);
    expect(regla, "sin `overflow-x: auto` las columnas ensanchan la página").toMatch(/overflow-x:\s*auto\s*;/);
    expect(regla, "sin `min-width: 0` un hijo de la columna flex no baja del ancho de su contenido").toMatch(
      /min-width:\s*0\s*;/
    );
    expect(regla, "sin `max-width: 100%` el carril crece con sus columnas").toMatch(/max-width:\s*100%\s*;/);
    expect(regla).toMatch(/scroll-snap-type:\s*x\s+mandatory\s*;/);
  });

  it("cada columna tiene ancho fijo y se engancha al deslizar", async () => {
    const regla = bloque(await leerCss(), ".cb-column");

    expect(regla).toMatch(/flex:\s*0\s+0\s+/);
    expect(regla).toMatch(/scroll-snap-align:\s*start\s*;/);
  });

  it("respeta prefers-reduced-motion: sin animaciones ni desplazamientos", async () => {
    const css = await leerCss();
    const media = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);

    expect(media, "falta la regla @media (prefers-reduced-motion: reduce)").not.toBeNull();
    expect(media![1]).toMatch(/animation:\s*none/);
    expect(media![1]).toMatch(/transform:\s*none/);
  });

  it("los colores salen de los tokens de la casa, no de valores fijos", async () => {
    const css = await leerCss();
    const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");

    expect(sinComentarios, "un #hex fijo no cambia con el tema oscuro").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(sinComentarios, "un rgb()/rgba() fijo no cambia con el tema oscuro").not.toMatch(/rgba?\(\s*\d/);
  });
});
