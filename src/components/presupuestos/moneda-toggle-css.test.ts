import { describe, expect, it } from "vitest";

/**
 * 6/11/2026 (pedido del cliente: precio divisa en el carrito): jsdom no calcula
 * layout, así que la hoja del interruptor «BCV | Divisa» se fija leyéndola
 * (mismo patrón que `carrito-pie-css.test.ts`).
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/presupuestos/moneda-toggle.css"), "utf8");
}

function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n|,\\s*)${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g");
  const cuerpos = [...css.matchAll(regex)].map((m) => m[1]);
  expect(cuerpos.length, `no se encontró la regla \`${selector}\` en moneda-toggle.css`).toBeGreaterThan(0);
  return cuerpos.join("\n");
}

describe("la hoja del interruptor de moneda", () => {
  it(".moneda-toggle ocupa todo el ancho del contenedor", async () => {
    const regla = bloque(await leerCss(), ".moneda-toggle");
    expect(regla).toMatch(/display:\s*flex\s*;/);
    expect(regla).toMatch(/width:\s*100%\s*;/);
  });

  it("la opción marcada va en oscuro", async () => {
    const regla = bloque(await leerCss(), '.moneda-toggle button[aria-checked="true"]');
    expect(regla).toMatch(/background:\s*var\(--lm-ink\)\s*;/);
  });

  it(".aviso-divisa es una píldora como .aviso-peso", async () => {
    const regla = bloque(await leerCss(), ".aviso-divisa");
    expect(regla).toMatch(/border-radius:\s*999px\s*;/);
    expect(regla).toMatch(/white-space:\s*nowrap\s*;/);
  });
});
