import { describe, expect, it } from "vitest";

/**
 * La hoja de estilos del mostrador (21/10/2026, plan "Presupuestos y mensajes
 * rápidos", T5). jsdom no calcula layout, así que ningún test de componente
 * puede atrapar que la calculadora deje de ser fija o que la grilla no se
 * apile en pantallas angostas: se mira la HOJA, igual que `inventario-css.test.ts`
 * y por el mismo motivo (trampa del grid de `.dash-frame`, 9/9/2026).
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/inventario/mostrador.css"), "utf8");
}

/** Lo que queda de la hoja sin los bloques `@media`, para leer solo las reglas de nivel raíz. */
function sinMedia(css: string): string {
  let salida = "";
  let i = 0;
  while (i < css.length) {
    const inicio = css.indexOf("@media", i);
    if (inicio === -1) {
      salida += css.slice(i);
      break;
    }
    salida += css.slice(i, inicio);
    let nivel = 0;
    let j = css.indexOf("{", inicio);
    for (; j < css.length; j++) {
      if (css[j] === "{") nivel++;
      if (css[j] === "}") {
        nivel--;
        if (nivel === 0) break;
      }
    }
    i = j + 1;
  }
  return salida;
}

/** Cuerpo de la regla de nivel raíz con ese selector exacto (viene tras un `}` o tras un comentario). */
function bloque(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regla = new RegExp(`(?:^|[}/])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(sinMedia(css));
  expect(regla, `no se encontró la regla \`${selector}\` en mostrador.css`).not.toBeNull();
  return regla![1];
}

/** Contenido del bloque `@media (consulta)`. */
function media(css: string, consulta: string): string {
  const inicio = css.indexOf(`@media (${consulta})`);
  expect(inicio, `no existe \`@media (${consulta})\` en mostrador.css`).toBeGreaterThanOrEqual(0);
  const abre = css.indexOf("{", inicio);
  let nivel = 0;
  for (let i = abre; i < css.length; i++) {
    if (css[i] === "{") nivel++;
    if (css[i] === "}") {
      nivel--;
      if (nivel === 0) return css.slice(abre + 1, i);
    }
  }
  throw new Error("`@media` sin cerrar");
}

describe("la hoja de estilos del mostrador", () => {
  it("por defecto (761 a 1719px) .inv-mostrador es UNA columna: la lista conserva su ancho completo", async () => {
    const regla = bloque(await leerCss(), ".inv-mostrador");

    expect(regla).toMatch(/display:\s*grid\s*;/);
    expect(
      regla,
      "con 320px de calculadora al lado, la lista queda en ~920px y el nombre del producto en ~60px (medido el 21/10/2026)",
    ).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(regla).not.toMatch(/320px/);
  });

  it("desde 1720px la grilla vuelve a dos columnas: la lista y 320px para la calculadora sticky a la derecha", async () => {
    const ancho = media(await leerCss(), "min-width: 1720px");

    const grilla = /\.inv-mostrador\s*\{([^}]*)\}/.exec(ancho);
    expect(grilla, "falta `.inv-mostrador` dentro de @media (min-width: 1720px)").not.toBeNull();
    expect(
      grilla![1],
      "sin `minmax(0, 1fr)` la tabla ancha de la lista desborda la columna",
    ).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+320px\s*;/);
    expect(
      grilla![1],
      "sin `align-items: start` la calculadora se estira a lo alto de la lista y deja de poder ser sticky",
    ).toMatch(/align-items:\s*start\s*;/);
    expect(ancho).toMatch(/\.inv-calc\s*\{[^}]*position:\s*sticky\s*;[^}]*top:\s*16px\s*;/);
  });

  it(".inv-calc es sticky también en la barra horizontal, por debajo del carrito flotante (z-index 30)", async () => {
    const regla = bloque(await leerCss(), ".inv-calc");

    expect(regla).toMatch(/position:\s*sticky\s*;/);
    expect(regla).toMatch(/top:\s*8px\s*;/);
    const z = /z-index:\s*(\d+)\s*;/.exec(regla);
    expect(z, "la barra sticky necesita z-index para quedar sobre las filas").not.toBeNull();
    expect(Number(z![1]), "el botón flotante del carrito usa z-index 30 y el Drawer z-50").toBeLessThan(30);
  });

  it("en la barra (761 a 1719px) los tres grupos van en fila, sin título y sin botón de plegar", async () => {
    const css = await leerCss();
    const cuerpo = bloque(css, ".inv-calc-cuerpo");

    expect(cuerpo, "el cuerpo de la barra es una grilla de tres grupos").toMatch(/display:\s*grid\s*;/);
    expect(cuerpo).toMatch(/grid-template-columns:[^;]*(?:repeat\(3|minmax[^;]*minmax[^;]*minmax)/);
    expect(bloque(css, ".inv-calc-toggle")).toMatch(/display:\s*none\s*;/);
    expect(bloque(css, ".inv-calc-titulo")).toMatch(/display:\s*none\s*;/);
  });

  it("desde 1720px el cuerpo vuelve a ser una columna y reaparece el título", async () => {
    const ancho = media(await leerCss(), "min-width: 1720px");

    expect(ancho).toMatch(/\.inv-calc-cuerpo\s*\{[^}]*display:\s*flex\s*;[^}]*flex-direction:\s*column\s*;/);
    expect(
      ancho,
      "la barra usa `align-items: start`; en columna los grupos tienen que estirarse o el campo queda más angosto que el panel",
    ).toMatch(/\.inv-calc-cuerpo\s*\{[^}]*align-items:\s*stretch\s*;/);
    expect(ancho).toMatch(/\.inv-calc-titulo\s*\{[^}]*display:\s*block\s*;/);
  });

  it("hasta 760px la calculadora es plegable: el botón aparece y el cuerpo depende de data-abierta", async () => {
    const angosto = media(await leerCss(), "max-width: 760px");

    expect(angosto).toMatch(/\.inv-calc-toggle\s*\{[^}]*display:\s*(?:flex|inline-flex)\s*;/);
    expect(angosto).toMatch(/\.inv-calc-cuerpo\[data-abierta="false"\]\s*\{[^}]*display:\s*none\s*;/);
    expect(angosto, "plegada arriba de una lista de una columna taparía las filas si fuera sticky").toMatch(
      /\.inv-calc\s*\{[^}]*position:\s*static\s*;/,
    );
    expect(angosto).toMatch(/\.inv-calc-cuerpo\s*\{[^}]*display:\s*flex\s*;/);
    expect(angosto).toMatch(/\.inv-calc-cuerpo\s*\{[^}]*align-items:\s*stretch\s*;/);
  });

  it("los niveles Cashea de la calculadora nunca desbordan: 3x2 en la columna, y cada botón con min-width 0 y sin saltos de línea", async () => {
    const css = await leerCss();

    // Reglas acotadas a `.inv-calc`: `cashea.css` es compartido con el carrito y no se toca.
    expect(css).toMatch(/\.inv-calc\s+\.cashea-niveles\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*;/);
    expect(css).toMatch(/\.inv-calc\s+\.cashea-opcion\s*\{[^}]*min-width:\s*0\s*;[^}]*white-space:\s*nowrap\s*;/);
  });

  it("en la barra los niveles caben en una sola fila de seis", async () => {
    const barra = media(await leerCss(), "min-width: 761px) and (max-width: 1719px");

    expect(barra).toMatch(/\.inv-calc\s+\.cashea-niveles\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)\s*;/);
  });
});
