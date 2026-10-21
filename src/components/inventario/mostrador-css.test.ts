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
  it(".inv-mostrador es una grilla de la lista y una columna fija de 320px para la calculadora", async () => {
    const regla = bloque(await leerCss(), ".inv-mostrador");

    expect(regla).toMatch(/display:\s*grid\s*;/);
    expect(regla, "sin `minmax(0, 1fr)` la tabla ancha de la lista desborda la columna").toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+320px\s*;/,
    );
    expect(
      regla,
      "sin `align-items: start` la calculadora se estira a lo alto de la lista y deja de poder ser sticky",
    ).toMatch(/align-items:\s*start\s*;/);
  });

  it(".inv-calc es sticky, pegada arriba", async () => {
    const regla = bloque(await leerCss(), ".inv-calc");

    expect(regla).toMatch(/position:\s*sticky\s*;/);
    expect(regla).toMatch(/top:\s*16px\s*;/);
  });

  it("hasta 1180px la grilla pasa a una columna y la calculadora va antes de la lista", async () => {
    const angosto = media(await leerCss(), "max-width: 1180px");

    expect(angosto).toMatch(/\.inv-mostrador\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(angosto).toMatch(/\.inv-calc\s*\{[^}]*order:\s*-1\s*;/);
    expect(angosto, "en angosto la calculadora deja de ser sticky").toMatch(/position:\s*static\s*;/);
  });

  it("en ancho el botón de plegar se oculta y el cuerpo se ve siempre; en angosto el cuerpo depende de data-abierta", async () => {
    const css = await leerCss();

    expect(bloque(css, ".inv-calc-toggle")).toMatch(/display:\s*none\s*;/);
    const angosto = media(css, "max-width: 1180px");
    expect(angosto).toMatch(/\.inv-calc-toggle\s*\{[^}]*display:\s*(?:flex|inline-flex)\s*;/);
    expect(angosto).toMatch(/\.inv-calc-cuerpo\[data-abierta="false"\]\s*\{[^}]*display:\s*none\s*;/);
  });
});
