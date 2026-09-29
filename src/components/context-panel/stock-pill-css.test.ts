import { describe, expect, it } from "vitest";

/**
 * T9 (29/9/2026): jsdom no calcula layout ni colores, así que lo que NO se
 * puede probar renderizando se fija mirando la HOJA de estilos (mismo patrón
 * que `inventario-css.test.ts`). Dos cosas:
 *  1. La lista de resultados de la búsqueda scrollea dentro de sí misma
 *     (`max-height` + `overflow-y: auto`): con páginas de 20 y "Ver más", sin
 *     tope de alto empujaría "Lo que lleva el cliente" y Notas fuera de la
 *     pantalla.
 *  2. La pastilla de existencia pinta con tokens de `theme.css`, que existen
 *     en los DOS temas — un color escrito a mano se lee bien en uno y mal en
 *     el otro (el contraste real lo mide Playwright sobre el build).
 */

async function leer(ruta: string) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), ruta), "utf8");
}

function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\"=]/g, "\\$&");
  const regla = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(regla, `no se encontró la regla \`${selector}\``).not.toBeNull();
  return regla![1];
}

describe("la lista de resultados de la búsqueda de inventario", () => {
  it("tiene un alto máximo y scrollea por dentro, para no empujar el resto del panel", async () => {
    const css = await leer("src/components/crm.css");
    const regla = bloque(css, ".crm-lookup-results");

    expect(regla, "sin `max-height` 20 resultados empujan Notas fuera de la pantalla").toMatch(/max-height:/);
    expect(regla, "sin `overflow-y: auto` el alto máximo recortaría los resultados sin poder verlos").toMatch(
      /overflow-y:\s*auto\s*;/
    );
  });
});

describe("los precios y el «Retirado» de un resultado en la columna angosta", () => {
  it("los importes no se parten en dos líneas ('Bs.' / '34744.45') y la fila puede bajar el botón", async () => {
    const css = await leer("src/components/crm.css");

    // Medido con Playwright a 1100 px (columna de 268): «Bs. 34744.45» y
    // «$ 40.50» se partían después del símbolo al lado del botón «Agregar».
    expect(bloque(css, ".crm-lookup-item-price")).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(bloque(css, ".crm-lookup-item-price > span")).toMatch(/white-space:\s*nowrap\s*;/);
    expect(bloque(css, ".crm-lookup-item-actions")).toMatch(/flex-wrap:\s*wrap\s*;/);
  });

  it("«Retirado» tiene su regla en la hoja del panel (no depende de la de Control IA)", async () => {
    const css = await leer("src/components/crm.css");

    expect(css).toMatch(/\.crm-lookup-retired\s*\{/);
  });
});

describe("la pastilla de existencia (StockPill)", () => {
  it("pinta con tokens del tema, no con colores escritos a mano", async () => {
    const css = await leer("src/components/crm.css");

    const enStock = bloque(css, '.crm-stock-pill[data-stock="in"]');
    const agotado = bloque(css, '.crm-stock-pill[data-stock="out"]');

    expect(enStock).toMatch(/var\(--lm-stock-in-ink\)/);
    expect(enStock).toMatch(/var\(--lm-good-rgb\)/);
    expect(agotado).toMatch(/var\(--lm-stock-out-ink\)/);
    expect(agotado).toMatch(/var\(--lm-hot-rgb\)/);
    expect(enStock + agotado, "un hex o rgb() literal no sigue al tema oscuro").not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("theme.css declara los componentes rgb del verde en el tema claro Y en el oscuro", async () => {
    const theme = await leer("src/app/theme.css");
    // La regla real arranca en columna 0; el mismo texto aparece antes dentro
    // de un comentario, y `indexOf` a secas cortaría el archivo en el sitio
    // equivocado.
    const oscuro = theme.search(/^:root\[data-theme="dark"\],/m);
    expect(oscuro).toBeGreaterThan(0);

    const claro = theme.slice(0, oscuro);
    const enOscuro = theme.slice(oscuro);
    expect(claro).toMatch(/--lm-good-rgb:\s*\d+\s+\d+\s+\d+\s*;/);
    expect(enOscuro).toMatch(/--lm-good-rgb:\s*\d+\s+\d+\s+\d+\s*;/);
    // El texto de «en stock» tiene su propio verde en cada tema: el
    // `--lm-good-ink` general (#1a7a53) llega a 4,06:1 sobre el tinte de la
    // pastilla en claro (medido 29/9/2026), por debajo de AA.
    expect(claro).toMatch(/--lm-stock-in-ink:\s*#[0-9a-f]{6}\s*;/i);
    expect(enOscuro).toMatch(/--lm-stock-in-ink:\s*#[0-9a-f]{6}\s*;/i);
  });
});
