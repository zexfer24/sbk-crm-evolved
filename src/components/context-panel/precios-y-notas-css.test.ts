import { describe, expect, it } from "vitest";

/**
 * 5/11/2026 (pedido del cliente, plan "Peso, notas y precios"): jsdom no
 * calcula layout ni colores, así que el diseño aprobado (propuesta A2 «Tarjetitas» de los
 * precios del resultado de inventario, y notas internas en verde) se fija
 * mirando la HOJA de estilos, igual que `cart-lines-css.test.ts`. El contraste
 * real lo mide Playwright sobre el build, en claro y en oscuro.
 *
 *  - Promoción y Estándar son dos tarjetas (grilla de 2 columnas) con su botón
 *    al pie; Divisa es un dato secundario en gris (`--lm-muted`) en una línea.
 *  - Las notas internas del panel del chat se tiñen de verde; la ficha del
 *    cliente (`.cli-note`) y todo lo demás NO cambian.
 */

async function leer(ruta: string) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), ruta), "utf8");
}

// Junta el cuerpo de TODAS las reglas cuyo selector (solo o dentro de una lista
// con comas) sea el pedido.
function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n|,\\s*)${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g");
  const cuerpos = [...css.matchAll(regex)].map((m) => m[1]);
  expect(cuerpos.length, `no se encontró la regla \`${selector}\``).toBeGreaterThan(0);
  return cuerpos.join("\n");
}

const TARJETA = ".crm-lookup-item-price";
const HEX = /#[0-9a-f]{3,8}\b/i;

describe("los precios de un resultado de inventario (propuesta A2 · Tarjetitas)", () => {
  it("Promoción y Estándar van en una grilla de DOS columnas iguales, del mismo alto (stretch)", async () => {
    const regla = bloque(await leer("src/components/crm.css"), ".crm-lookup-tiles");

    expect(regla).toMatch(/display:\s*grid\s*;/);
    expect(regla).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/);
    expect(regla).toMatch(/align-items:\s*stretch\s*;/);
    expect(regla).toMatch(/gap:\s*6px\s*;/);
  });

  it("cada tarjeta es una columna flex: la información arriba y el botón al pie", async () => {
    const css = await leer("src/components/crm.css");
    for (const kind of ["promo", "estandar"]) {
      const regla = bloque(css, `${TARJETA}[data-kind="${kind}"]`);
      expect(regla, kind).toMatch(/display:\s*flex\s*;/);
      expect(regla, kind).toMatch(/flex-direction:\s*column\s*;/);
      expect(regla, kind).toMatch(/background:\s*var\(--acc-tint\)\s*;/);
      expect(regla, kind).toMatch(/box-shadow:\s*inset 0 2px 0 var\(--acc-line\)\s*;/);
    }
  });

  it("el botón de cada tarjeta se pega al pie (margin-top: auto), a todo el ancho y centrado", async () => {
    const regla = bloque(await leer("src/components/crm.css"), `${TARJETA} > .crm-lookup-add`);

    expect(regla).toMatch(/margin-top:\s*auto\s*;/);
    expect(regla).toMatch(/width:\s*100%\s*;/);
    expect(regla).toMatch(/min-height:\s*28px\s*;/);
    expect(regla).toMatch(/justify-content:\s*center\s*;/);
  });

  it("el texto del botón de la tarjeta nunca se parte: «+ Promoción» no baja de línea a 268 px", async () => {
    // Con el panel a 268 px (pantalla de 1280) cada tarjeta mide 103 px y el
    // botón 87: «+ Promoción» se partía en dos líneas (46,5 px de alto contra los
    // 29,3 de «+ Estándar») y los dos botones quedaban desalineados.
    const regla = bloque(await leer("src/components/crm.css"), `${TARJETA} > .crm-lookup-add`);

    expect(regla).toMatch(/white-space:\s*nowrap\s*;/);
  });

  it("la cifra en Bs. nunca se recorta: parte la línea en vez de desbordar", async () => {
    const regla = bloque(await leer("src/components/crm.css"), ".crm-lookup-price-fig");

    expect(regla).toMatch(/white-space:\s*normal\s*;/);
    expect(regla).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });

  it("Promoción usa el acento --lm-link-ink y Estándar el verde --lm-stock-in-ink", async () => {
    const css = await leer("src/components/crm.css");
    const promo = bloque(css, `${TARJETA}[data-kind="promo"]`);
    const estandar = bloque(css, `${TARJETA}[data-kind="estandar"]`);

    expect(promo).toMatch(/--acc-ink:\s*var\(--lm-link-ink\)\s*;/);
    expect(estandar).toMatch(/--acc-ink:\s*var\(--lm-stock-in-ink\)\s*;/);
    expect(promo).toMatch(/--acc-line:\s*var\(--lm-link\)\s*;/);
    expect(estandar).toMatch(/--acc-line:\s*var\(--lm-good\)\s*;/);
    expect(promo).toMatch(/--acc-tint:\s*color-mix\(in srgb,\s*var\(--lm-link\)\s*10%,\s*transparent\)\s*;/);
    expect(estandar).toMatch(/--acc-tint:\s*rgb\(var\(--lm-good-rgb\)\s*\/\s*0\.12\)\s*;/);
  });

  it("la etiqueta de cada tarjeta toma el color de su acento", async () => {
    const css = await leer("src/components/crm.css");
    // `--acc-ink` lo define cada tarjeta según su `data-kind`; la etiqueta solo lo lee.
    expect(bloque(css, ".crm-lookup-price-label")).toMatch(/color:\s*var\(--acc-ink\)\s*;/);
  });

  it("Estándar sin precio: borde de 1 px y fondo transparente, y el motivo parte línea", async () => {
    const css = await leer("src/components/crm.css");
    const tarjeta = bloque(css, `${TARJETA}[data-kind="estandar"][data-vacia="true"]`);
    const motivo = bloque(css, `${TARJETA} .crm-lookup-price-missing`);

    expect(tarjeta).toMatch(/background:\s*transparent\s*;/);
    expect(tarjeta).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--lm-line\)\s*;/);
    expect(motivo).toMatch(/white-space:\s*normal\s*;/);
  });

  it("Divisa va debajo, en una sola línea y en gris (--lm-muted)", async () => {
    const regla = bloque(await leer("src/components/crm.css"), `${TARJETA}[data-kind="divisa"]`);

    expect(regla).toMatch(/color:\s*var\(--lm-muted\)\s*;/);
    expect(regla).toMatch(/flex-wrap:\s*nowrap\s*;/);
    expect(regla).toMatch(/font-size:\s*11\.5px\s*;/);
  });

  it("«Enviar foto» va en su propia fila, alineada al borde izquierdo de las tarjetas", async () => {
    const regla = bloque(await leer("src/components/crm.css"), ".crm-lookup-photo-row");

    expect(regla).toMatch(/display:\s*flex\s*;/);
    expect(regla).toMatch(/justify-content:\s*flex-start\s*;/);
  });

  it("los botones «+ Promoción» y «+ Estándar» toman el color de su precio y conservan hover y foco visible", async () => {
    const css = await leer("src/components/crm.css");
    const promo = bloque(css, '.crm-lookup-add[data-kind="promo"]');
    const estandar = bloque(css, '.crm-lookup-add[data-kind="estandar"]');

    expect(promo).toMatch(/--acc-ink:\s*var\(--lm-link-ink\)\s*;/);
    expect(estandar).toMatch(/--acc-ink:\s*var\(--lm-stock-in-ink\)\s*;/);
    expect(promo + estandar).toMatch(/color:\s*var\(--acc-ink\)\s*;/);
    expect(bloque(css, '.crm-lookup-add[data-kind="promo"]:hover:not(:disabled)')).toMatch(/background:\s*var\(--acc-tint\)\s*;/);
    // El foco de teclado es el global `.crm button:focus-visible`; las reglas de
    // la tarjeta no pueden apagarlo (un botón con `outline: none` queda invisible
    // al tabular).
    expect(bloque(css, ".crm button:focus-visible")).toMatch(/outline:\s*2px solid var\(--lm-link\)\s*;/);
    expect(promo + estandar + bloque(css, `${TARJETA} > .crm-lookup-add`)).not.toMatch(/outline:\s*(none|0)/);
  });

  it("nada usa un color escrito a mano (todo sigue al tema oscuro)", async () => {
    const css = await leer("src/components/crm.css");
    const todo = [
      bloque(css, `${TARJETA}[data-kind="divisa"]`),
      bloque(css, `${TARJETA}[data-kind="promo"]`),
      bloque(css, `${TARJETA}[data-kind="estandar"]`),
      bloque(css, `${TARJETA}[data-kind="estandar"][data-vacia="true"]`),
      bloque(css, ".crm-lookup-tiles"),
      bloque(css, ".crm-lookup-add[data-kind=\"promo\"]"),
      bloque(css, ".crm-lookup-add[data-kind=\"estandar\"]"),
      bloque(css, ".crm-lookup-fee"),
    ].join("\n");
    expect(todo, "un hex literal no sigue al tema oscuro").not.toMatch(HEX);
  });
});

describe("la píldora «Faltan pesos» dentro del total del carrito de /inventario", () => {
  it(".inv-carrito-total-fila > span.aviso-peso la deja en 11,5 px / 700 (no los 15 px del último span)", async () => {
    const css = await leer("src/components/inventario/inventario.css");
    const regla = bloque(css, ".inv-carrito-total-fila > span.aviso-peso");

    expect(regla).toMatch(/font-size:\s*11\.5px\s*;/);
    expect(regla).toMatch(/font-weight:\s*700\s*;/);
    // Tiene que ir DESPUÉS de `.inv-carrito-total-fila span:last-child` (misma
    // especificidad 0,2,1 contra la suya): si no, el último span le sigue ganando.
    expect(css.indexOf(".inv-carrito-total-fila > span.aviso-peso")).toBeGreaterThan(
      css.indexOf(".inv-carrito-total-fila span:last-child")
    );
  });
});

describe("las notas internas del panel del chat", () => {
  it(".crm-note se tiñe con el verde del tema: tinte, barra izquierda y esquina marcada", async () => {
    const regla = bloque(await leer("src/components/crm.css"), ".crm-note");

    expect(regla).toMatch(/background:\s*rgb\(var\(--lm-good-rgb\)\s*\/\s*0\.12\)\s*;/);
    expect(regla).toMatch(/border-left:\s*3px solid var\(--lm-good\)\s*;/);
    expect(regla).toMatch(/border-radius:\s*4px 14px 14px 4px\s*;/);
    expect(regla).toMatch(/color:\s*var\(--lm-ink\)\s*;/);
    expect(regla, "un hex literal no sigue al tema oscuro").not.toMatch(HEX);
  });

  it("el autor va en verde tinta (--lm-stock-in-ink: 5,9:1 en claro) y la fecha en gris", async () => {
    const css = await leer("src/components/crm.css");

    expect(bloque(css, ".crm-note-author")).toMatch(/color:\s*var\(--lm-stock-in-ink\)\s*;/);
    expect(bloque(css, ".crm-note-meta")).toMatch(/color:\s*var\(--lm-muted\)\s*;/);
  });

  it("la ficha del cliente (.cli-note) NO usa el verde: es otra pantalla y no cambia", async () => {
    const css = await leer("src/components/clientes/clientes.css");

    expect(bloque(css, ".cli-note")).not.toMatch(/--lm-good/);
    expect(bloque(css, ".cli-note-author")).not.toMatch(/--lm-good/);
  });
});
