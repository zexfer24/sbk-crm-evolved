import { describe, expect, it } from "vitest";

/**
 * La cápsula del rail centrada en el HUECO (15/11/2026, pedido del operador).
 * En pantallas anchas `.dash-content` (max-width 1560 px, `margin: 0 auto`) deja
 * a su izquierda un hueco mucho mayor que la columna de 88 px del rail: con la
 * cápsula pegada al borde (x = 16–72) y el contenido empezando cerca de x = 212,
 * se veía desconectada. Ahora su centro queda a la mitad de ese hueco:
 *
 *   bordeContenido = rail + padding + max(0, (ancho − rail − 2·padding − máx) / 2)
 *   centro         = bordeContenido / 2
 *   left (cápsula) = centro − 28 px (la mitad de sus 56 px)
 *
 * `ancho` es el ancho ÚTIL de la ventana (sin la barra de scroll vertical): por
 * eso la fórmula usa `100%` —que en `left` de un elemento `fixed` se resuelve
 * contra el viewport sin barra— y NO `100vw`, que la incluye y descentra ~7 px
 * en Windows. jsdom no calcula layout: este test mira la HOJA y evalúa la
 * fórmula de la hoja con anchos de ejemplo.
 */

async function leer(ruta: string) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), ruta), "utf8");
}

function escapar(texto: string) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bloque(css: string, selector: string) {
  const regla = new RegExp(`(?:^|[}/;{\\s])${escapar(selector)}\\s*\\{([^}]*)\\}`).exec(css);
  expect(regla, `no se encontró la regla \`${selector}\``).not.toBeNull();
  return regla![1];
}

/** El valor (sin `;`) de una propiedad dentro del cuerpo de una regla. */
function valor(cuerpo: string, propiedad: string) {
  const m = new RegExp(`${escapar(propiedad)}:\\s*([^;]+);`).exec(cuerpo);
  expect(m, `falta \`${propiedad}\``).not.toBeNull();
  return m![1].trim();
}

/**
 * Evalúa una expresión `calc()`/`max()` de la hoja con `ancho` útil: sustituye
 * las variables por sus valores de `.dash-frame`, `100%` por el ancho y quita
 * las unidades `px`. Solo entiende lo que la hoja usa (números, + - * /, max,
 * paréntesis); cualquier otra cosa lanza.
 */
function evaluar(expresion: string, variables: Record<string, string>, ancho: number): number {
  let texto = expresion;
  for (let i = 0; i < 6 && /var\(/.test(texto); i++) {
    texto = texto.replace(/var\((--[\w-]+)\)/g, (_, nombre: string) => {
      expect(variables[nombre], `variable ${nombre} sin declarar en .dash-frame`).toBeDefined();
      return `(${variables[nombre]})`;
    });
  }
  texto = texto.replace(/calc/g, "").replace(/max\(/g, "Math.max(").replace(/100%/g, `${ancho}`).replace(/px/g, "");
  expect(texto, "la fórmula usa algo que este test no sabe evaluar").toMatch(/^[\d\s.+\-*/(),Math.max]+$/);
  return Function(`"use strict"; return (${texto});`)() as number;
}

const MITAD_CAPSULA = 28;

describe("la cápsula centrada en el hueco del rail (.dash)", () => {
  it("las medidas viven en custom properties de .dash-frame y las reglas originales las usan", async () => {
    const css = await leer("src/components/dashboard/dashboard.css");
    const marco = bloque(css, ".dash-frame");

    expect(marco).toMatch(/--dash-rail-w:\s*88px\s*;/);
    expect(marco).toMatch(/--dash-pad-x:\s*26px\s*;/);
    expect(marco).toMatch(/--dash-content-max:\s*1560px\s*;/);
    expect(marco).toMatch(/grid-template-columns:\s*var\(--dash-rail-w\)\s+minmax\(0,\s*1fr\)\s*;/);
    expect(bloque(css, ".dash-main")).toMatch(/padding:\s*18px\s+var\(--dash-pad-x\)\s+40px\s*;/);
    expect(bloque(css, ".dash-content")).toMatch(/max-width:\s*var\(--dash-content-max\)\s*;/);
  });

  it("la fórmula del centro usa max() y 100% (el viewport sin barra), nunca 100vw", async () => {
    const css = await leer("src/components/dashboard/dashboard.css");
    const centro = valor(bloque(css, ".dash-frame"), "--dash-hueco-centro");

    expect(centro).toMatch(/max\(/);
    expect(centro).toContain("100%");
    expect(centro).not.toMatch(/\d\s*vw\b/);
    expect(centro).toContain("/ 2");
  });

  it("la cápsula usa ese centro menos la mitad de su ancho; la marca, el mismo centro menos la suya", async () => {
    const css = await leer("src/components/dashboard/dashboard.css");

    expect(valor(bloque(css, ".dash-rail-capsule"), "left")).toBe(`calc(var(--dash-hueco-centro) - ${MITAD_CAPSULA}px)`);

    const marca = bloque(css, ".dash-rail-brand");
    // `absolute` dentro de `.dash-frame` (relative): ahí `left: N%` se resuelve contra el ancho
    // útil de la ventana; en el flujo del <nav> (88 px) un porcentaje no sirve para centrar.
    expect(marca).toMatch(/position:\s*absolute\s*;/);
    expect(marca).toMatch(/top:\s*22px\s*;/);
    expect(valor(marca, "left")).toBe("calc(var(--dash-hueco-centro) - 16px)");
    expect(bloque(css, ".dash-frame")).toMatch(/position:\s*relative\s*;/);
  });

  it("la marca absoluta no es el contenedor de la cápsula fija: el <nav> no se posiciona", async () => {
    const css = await leer("src/components/dashboard/dashboard.css");
    expect(bloque(css, ".dash-rail")).not.toMatch(/position:/);
  });

  // La hoja se evalúa de verdad: documentación ejecutable de la fórmula.
  it.each([
    // [ancho de la ventana con barra, ancho útil, borde del contenido, centro]
    [1920, 1905, 216.5, 108.25],
    [1440, 1425, 114, 57],
    [1280, 1265, 114, 57],
    [1024, 1009, 114, 57],
  ])("con una ventana de %i px (útiles %i) el contenido empieza en x=%f y el centro del hueco es %f", async (_ventana, util, borde, centro) => {
    const css = await leer("src/components/dashboard/dashboard.css");
    const marco = bloque(css, ".dash-frame");
    const variables = Object.fromEntries(
      [...marco.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
    );

    // El borde real del contenido, calculado a mano: columna + padding + margen automático.
    const margenAuto = Math.max(0, (util - 88 - 2 * 26 - 1560) / 2);
    expect(88 + 26 + margenAuto).toBeCloseTo(borde, 5);

    const deLaHoja = evaluar("var(--dash-hueco-centro)", variables, util);
    expect(deLaHoja).toBeCloseTo(centro, 5);
    expect(deLaHoja).toBeCloseTo(borde / 2, 5);

    const left = evaluar(valor(bloque(css, ".dash-rail-capsule"), "left"), variables, util);
    expect(left).toBeCloseTo(centro - MITAD_CAPSULA, 5);
  });

  it("a ≤760 px el rail no existe (display: none, una sola columna): no hay hueco que centrar", async () => {
    const css = await leer("src/components/dashboard/dashboard.css");
    const desde = css.indexOf("@media (max-width: 760px) {\n  .dash-frame");
    const movil = css.slice(desde > -1 ? desde : css.indexOf("@media (max-width: 760px)"));
    expect(bloque(movil, ".dash-rail")).toMatch(/display:\s*none\s*;/);
    expect(bloque(movil, ".dash-frame")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  });
});

describe("la cápsula de la bandeja (.crm): el hueco ES la columna", () => {
  it("la columna de 88 px y left 16 px la dejan centrada: (88 − 56) / 2", async () => {
    const css = await leer("src/components/crm.css");

    expect(bloque(css, ".crm")).toMatch(/grid-template-columns:\s*88px\s+minmax\(0,\s*1fr\)\s*;/);
    expect(valor(bloque(css, ".crm-rail-capsule"), "left")).toBe("16px");
    expect(16 * 2 + 56).toBe(88);
  });
});
