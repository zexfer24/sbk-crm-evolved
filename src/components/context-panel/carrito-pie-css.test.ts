import { describe, expect, it } from "vitest";

/**
 * 28/10/2026 (plan "Facturar en SAINT sale del fondo del panel", T3): jsdom no
 * calcula layout, así que el pie del carrito del chat se fija mirando la HOJA
 * (mismo patrón que `cart-lines-css.test.ts`). El pie con el total y «Facturar
 * en SAINT» tiene que quedar a la vista mientras se recorren los renglones de
 * una columna de 268 px; si pierde `position: sticky`, el botón vuelve a
 * quedar al fondo, que era justo el problema.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/crm.css"), "utf8");
}

// Junta el cuerpo de TODAS las reglas cuyo selector (solo o en una lista con
// comas) sea el pedido.
function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n|,\\s*)${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g");
  const cuerpos = [...css.matchAll(regex)].map((m) => m[1]);
  expect(cuerpos.length, `no se encontró la regla \`${selector}\` en crm.css`).toBeGreaterThan(0);
  return cuerpos.join("\n");
}

describe("el pie del carrito del chat", () => {
  it(".crm-pcart-foot se pega abajo del panel mientras la sección está a la vista", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-foot");
    expect(regla).toMatch(/position:\s*sticky\s*;/);
  });

  // 28/10/2026, visto en el navegador: con `bottom: 0` el pie se pegaba por
  // encima del padding inferior del panel y por esa franja se veían pasar los
  // renglones. El pie baja exactamente ese padding.
  it(".crm-pcart-foot baja hasta el borde del panel, sin franja por debajo", async () => {
    const css = await leerCss();
    const padding = bloque(css, ".crm-context-body").match(/padding:\s*([^;]+);/);
    expect(padding, "falta `padding` en .crm-context-body").not.toBeNull();
    const partes = padding![1].trim().split(/\s+/);
    const abajo = partes.length >= 3 ? partes[2] : partes[0];
    const bottom = bloque(css, ".crm-pcart-foot").match(/bottom:\s*([^;]+);/);
    expect(bottom, "falta `bottom` en .crm-pcart-foot").not.toBeNull();
    expect(bottom![1].trim()).toBe(abajo === "0" ? "0" : `-${abajo}`);
  });

  it(".crm-pcart-foot tiene fondo opaco: los renglones no se ven por debajo", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-foot");
    const fondo = regla.match(/background(?:-color)?:\s*([^;]+);/);
    expect(fondo, "falta `background` en .crm-pcart-foot").not.toBeNull();
    expect(fondo![1].trim()).not.toMatch(/^(transparent|none|inherit|initial|unset)$/i);
  });

  it(".crm-pcart-foot queda por encima de los renglones (z-index)", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-foot");
    expect(regla).toMatch(/z-index:\s*\d+\s*;/);
  });

  it("los tres atajos van en una fila de tres columnas iguales", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-atajos");
    expect(regla).toMatch(/display:\s*grid\s*;/);
    expect(regla).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*;/);
  });

  it("la vista previa respeta saltos de línea y no desborda la columna", async () => {
    const regla = bloque(await leerCss(), ".crm-pcart-preview");
    expect(regla).toMatch(/white-space:\s*pre-wrap\s*;/);
    expect(regla).toMatch(/overflow-wrap:\s*anywhere\s*;/);
    expect(regla).toMatch(/font-family:[^;]*mono/i);
  });
});
