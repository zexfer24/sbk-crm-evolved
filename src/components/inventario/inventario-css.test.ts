import { describe, expect, it } from "vitest";

/**
 * T7 (10/9/2026): jsdom no calcula layout, así que ningún test que renderiza
 * `ProductoFila` puede detectar que las cajas de Stock/Precio/Peso quedan
 * desalineadas — hay que mirar la HOJA de estilos directamente (mismo
 * patrón que "la hoja de estilos del aviso" en assignment-notifier.test.tsx,
 * escrito el 9/9/2026 para el fragmento que le comió una columna al grid del
 * CRM). El fallo real: `.inv-row` era `flex` + `align-items: center`, y el
 * campo Precio en USD lleva debajo del input una línea extra `.inv-bs`
 * ("Bs. 1234.00") que en VES no existe — esa columna quedaba más alta y
 * Stock/Peso se centraban contra ella, bajando unos píxeles. `flex-wrap`
 * además mandaba las cajas a una segunda línea en algunas filas sí y otras
 * no. Un grid con columnas fijas y `align-items: start` saca los dos
 * problemas de raíz.
 *
 * Segunda vuelta, mismo día: la última columna nació `auto` y eso reabrió
 * el síntoma de otra forma — cada `<li>` es su propio grid, así que una
 * columna `auto` toma el ancho de SU `.inv-status` (el badge cambia de "La
 * IA lo ofrece" a "Sin stock" según la fila) y esa diferencia se la resta o
 * se la suma a la columna `1fr` de al lado, corriendo Stock/Precio/Peso
 * hasta ~38px entre una fila y otra (medido con `getBoundingClientRect`
 * sobre un HTML de prueba con la hoja real). `300px` fijo le da a las tres
 * filas la MISMA columna pase lo que pase adentro.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/inventario/inventario.css"), "utf8");
}

function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regla = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(regla, `no se encontró la regla \`${selector}\` en inventario.css`).not.toBeNull();
  return regla![1];
}

describe("la hoja de estilos del inventario", () => {
  it(".inv-row es grid con las cajas ancladas arriba, no flex centrado", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-row");

    expect(regla, "sin `display: grid` las columnas vuelven a repartirse con flex").toMatch(/display:\s*grid\s*;/);
    expect(
      regla,
      "sin `align-items: start` una columna más alta (el pie `.inv-bs` en USD) corre a las demás hacia abajo"
    ).toMatch(/align-items:\s*start\s*;/);
    expect(
      regla,
      "`flex-wrap` no debería seguir en un contenedor grid: mandaba las cajas a una segunda línea en algunas filas sí y otras no"
    ).not.toMatch(/flex-wrap/);
  });

  it(".inv-row NO termina la plantilla de columnas en `auto`", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-row");
    const plantilla = /grid-template-columns:\s*([^;]+);/.exec(regla);

    expect(plantilla, "no se encontró `grid-template-columns` en `.inv-row`").not.toBeNull();
    expect(
      plantilla![1].trim(),
      "una última columna `auto` toma el ancho de SU `.inv-status` —variable según el badge de cada fila— y ese sobrante corre a Stock/Precio/Peso hasta ~38px entre una fila y otra: la última columna tiene que ser un ancho fijo"
    ).not.toMatch(/auto\s*$/);
  });

  it(".inv-bs reserva su alto aunque esté vacío, para que las columnas midan igual", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-bs");

    expect(
      regla,
      "sin `min-height` el pie de Stock/Peso (vacío) mide menos que el de Precio en USD y desalinea la fila"
    ).toMatch(/min-height:\s*14px\s*;/);
  });
});
