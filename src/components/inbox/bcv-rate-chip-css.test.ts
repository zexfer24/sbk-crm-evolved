import { describe, expect, it } from "vitest";

/**
 * jsdom no calcula layout: el chip de la tasa vive en una barra estrecha y su
 * texto de alerta ("sin actualizar desde 18 nov., 6:00 p. m.") es largo, así
 * que lo que impide que rompa la barra solo se puede verificar mirando la hoja.
 */
async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const css = await readFile(join(process.cwd(), "src/components/crm.css"), "utf8");
  return css.replace(/\r\n/g, "\n");
}

function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regla = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(regla, `no se encontró la regla \`${selector}\` en crm.css`).not.toBeNull();
  return regla![1];
}

describe("la hoja de estilos del chip de la tasa BCV", () => {
  it("el chip en alerta tiene su propia regla, distinta del ámbar de data-stale", async () => {
    const css = await leerCss();
    const regla = bloque(css, '.crm-bcv[data-alerta="true"]');
    expect(regla).toMatch(/background:/);
  });

  it("la etiqueta de fecha se recorta con elipsis en vez de romper la barra", async () => {
    const css = await leerCss();
    const chip = bloque(css, ".crm-bcv");
    const fecha = bloque(css, ".crm-bcv-date");

    expect(chip, "sin min-width: 0 el chip no puede encogerse dentro de la barra").toMatch(/min-width:\s*0\s*;/);
    expect(fecha).toMatch(/min-width:\s*0\s*;/);
    expect(fecha).toMatch(/overflow:\s*hidden\s*;/);
    expect(fecha).toMatch(/text-overflow:\s*ellipsis\s*;/);
    expect(fecha).toMatch(/white-space:\s*nowrap\s*;/);
  });

  it("en alerta el aviso baja a su propia línea y no se recorta (en 316 px se perdía la fecha y la hora)", async () => {
    const css = await leerCss();
    const chip = [...css.matchAll(/\.crm-bcv\[data-alerta="true"\]\s*\{([^}]*)\}/g)].map((m) => m[1]).join("\n");
    const fecha = [...css.matchAll(/\.crm-bcv\[data-alerta="true"\] \.crm-bcv-date\s*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .join("\n");

    expect(chip).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(fecha).toMatch(/flex-basis:\s*100%\s*;/);
    expect(fecha).toMatch(/white-space:\s*normal\s*;/);
  });
});
