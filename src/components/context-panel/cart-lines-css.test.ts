import { describe, expect, it } from "vitest";

/**
 * 28/10/2026 (plan "Facturar en SAINT sale del fondo del panel", T2): jsdom no
 * calcula layout, así que la tarjeta del carrito se fija mirando la HOJA
 * (mismo patrón que `inventario-css.test.ts`). Se fija que el selector
 * Promoción/Estándar ocupa TODO el ancho de la tarjeta, que sus dos botones
 * se reparten el ancho por igual y que la columna del total va alineada a la
 * derecha.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/crm.css"), "utf8");
}

// Junta el cuerpo de TODAS las reglas cuyo selector (solo o en una lista con
// comas) sea el pedido: `.crm-pcart-col-qty, .crm-pcart-col-total { … }` y
// `.crm-pcart-col-total { … }` aportan las dos.
function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n|,\\s*)${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g");
  const cuerpos = [...css.matchAll(regex)].map((m) => m[1]);
  expect(cuerpos.length, `no se encontró la regla \`${selector}\` en crm.css`).toBeGreaterThan(0);
  return cuerpos.join("\n");
}

describe("la hoja de estilos del carrito del panel", () => {
  it(".crm-pcart-kind ocupa todo el ancho de la tarjeta", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-kind");
    expect(regla).toMatch(/display:\s*flex\s*;/);
    expect(regla).toMatch(/width:\s*100%\s*;/);
  });

  it("los dos botones del selector reparten el ancho por igual", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-kind-btn");
    expect(regla).toMatch(/flex:\s*1\s+1\s+0(?:%|px)?\s*;/);
  });

  it("la columna del total se alinea a la derecha", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-col-total");
    expect(regla).toMatch(/align-items:\s*flex-end\s*;/);
  });
});
