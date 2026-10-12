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

  /*
   * T1, "El precio se lee en bolívares" (19/9/2026), corrección tras la
   * verificación visual: el `<span className="inv-readonly">` que reemplazó
   * al `<input>` de Precio quedaba con el `font-size` ambiente (más grande)
   * en vez del `13px` que `.inv-input-wrap input` le da al input — la caja
   * de Precio medía 36px de alto contra 32px de Stock/Peso (mismos
   * `top`/`left`, medido con `getBoundingClientRect` en Brave). El arreglo
   * es que `.inv-readonly` entre al MISMO selector que `input`, no una regla
   * aparte con los mismos valores copiados a mano (eso se desalinearía de
   * nuevo en cuanto alguien tocara un solo lado).
   */
  it(".inv-readonly comparte selector con el input: mismo font-size, para que la caja de Precio no quede más alta que Stock/Peso", async () => {
    const css = await leerCss();
    const inicio = css.indexOf(".inv-input-wrap input");
    expect(inicio, "no se encontró la regla `.inv-input-wrap input` en inventario.css").toBeGreaterThanOrEqual(0);

    const cierre = css.indexOf("}", inicio);
    const regla = css.slice(inicio, cierre);
    const selectorList = regla.slice(0, regla.indexOf("{"));
    const cuerpo = regla.slice(regla.indexOf("{") + 1);

    expect(
      selectorList,
      "`.inv-readonly` (el span de solo lectura de Precio) tiene que estar en el MISMO selector que `.inv-input-wrap input`: separado, hereda el font-size del contexto en vez del 13px del input y la caja de Precio vuelve a quedar 4px más alta"
    ).toMatch(/\.inv-input-wrap\s+\.inv-readonly/);
    expect(cuerpo, "el selector compartido tiene que fijar el mismo tamaño de letra que ya usa el input").toMatch(
      /font-size:\s*13px\s*;/
    );
  });

  it(".inv-readonly no se ve como un campo editable: sin cursor de texto", async () => {
    const css = await leerCss();
    // `.inv-input-wrap .inv-readonly` aparece DOS veces: como selector
    // compartido con `input` (el test de arriba) y como regla propia con
    // `cursor: default`. `bloque()` toma la primera coincidencia —acá hace
    // falta la última—, así que se busca con un regex global.
    const coincidencias = [
      ...css.matchAll(/\.inv-input-wrap\s+\.inv-readonly\s*\{([^}]*)\}/g),
    ];
    expect(
      coincidencias.length,
      "se esperaban dos reglas para `.inv-input-wrap .inv-readonly`: el selector compartido con el input y la regla propia del cursor"
    ).toBe(2);

    const reglaPropia = coincidencias[coincidencias.length - 1][1];
    expect(
      reglaPropia,
      "sin `cursor: default` el span de solo lectura puede sugerir con el mouse que se puede escribir ahí, como Stock/Peso"
    ).toMatch(/cursor:\s*default\s*;/);
  });

  /*
   * T5, plan "El mostrador busca sin salir del chat" (27/9/2026): el código
   * Saint se agrega como una LÍNEA debajo del nombre, dentro de
   * `.inv-identity` (columna 1 de `.inv-row`, `minmax(0, 1fr)`) — decisión
   * explícita para no tocar la plantilla de columnas fijas (trampa del
   * 10/9/2026: una columna nueva de ancho variable vuelve a desalinear
   * Stock/Precio/Peso entre filas). Como `.inv-row` ya ancla sus columnas
   * arriba con `align-items: start` (ver el bloque de arriba), que la
   * columna 1 crezca de alto no mueve ni centra a las demás — por eso este
   * test NO exige que `grid-template-columns` cambie, exige que NO cambie.
   */
  it(".inv-row tiene seis columnas fijas (Precio estándar es la única agregada): el código Saint no agrega otra", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-row");
    const plantilla = /grid-template-columns:\s*([^;]+);/.exec(regla);

    expect(plantilla, "no se encontró `grid-template-columns` en `.inv-row`").not.toBeNull();
    expect(
      plantilla![1].trim(),
      "el código Saint va DENTRO de la columna 1 (`.inv-identity`), como una línea nueva, no como columna: agregar una columna aquí reabre la trampa del 10/9/2026"
    ).toBe("minmax(0, 1fr) 100px 150px 150px 110px 300px");
  });

  it(".inv-saint-code existe, en fuente numérica y seleccionable para copiar", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-saint-code");

    expect(
      regla,
      "sin `user-select: text` un padre con selección apagada podría impedir copiar el código con el mouse"
    ).toMatch(/user-select:\s*text\s*;/);
  });

  /*
   * Plan "Precio promoción y precio estándar (envío MRW)" (12/10/2026): el
   * campo Precio estándar suma UNA columna fija de 150px (la misma que
   * Precio promoción, que lleva el mismo pie `.inv-bs`). En teléfono los
   * cuatro campos quedan en pares (Stock/Promoción, Estándar/Peso) con dos
   * columnas; identidad y estado siguen ocupando la fila entera.
   */
  it("en teléfono los cuatro campos caben en pares: dos columnas, identidad y estado a fila entera", async () => {
    const css = await leerCss();
    const inicio = css.indexOf("@media (max-width: 760px)");
    expect(inicio, "no se encontró el breakpoint de teléfono en inventario.css").toBeGreaterThanOrEqual(0);
    const movil = css.slice(inicio);
    const fila = /\.inv-row\s*\{([^}]*)\}/.exec(movil);

    expect(fila, "no se encontró `.inv-row` dentro del breakpoint de teléfono").not.toBeNull();
    expect(fila![1], "con cuatro campos, tres columnas dejaban uno huérfano").toMatch(
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/
    );
    expect(movil).toMatch(/\.inv-identity,\s*\.inv-status\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/);
  });

  it("entre 761 y 1180px el estado baja a su propia línea y le deja el ancho al nombre", async () => {
    const css = await leerCss();
    const inicio = css.indexOf("@media (min-width: 761px) and (max-width: 1180px)");
    expect(inicio, "sin este breakpoint, a 1024px el nombre queda en ~20px").toBeGreaterThanOrEqual(0);
    const medio = css.slice(inicio, css.indexOf("@media (max-width: 760px)"));
    expect(medio).toMatch(/\.inv-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 100px 150px 150px 110px\s*;/);
    expect(medio).toMatch(/\.inv-status\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/);
  });

  it(".inv-fee es una línea chica y atenuada que sí puede envolver, y el texto vacío va atenuado en cursiva", async () => {
    const css = await leerCss();
    const fee = bloque(css, ".inv-fee");
    expect(fee).toMatch(/font-size:\s*11px\s*;/);
    expect(fee).toMatch(/color:\s*var\(--lm-muted\)\s*;/);
    expect(fee).toMatch(/white-space:\s*normal\s*;/);

    const vacio = bloque(css, '.inv-readonly[data-empty="true"]');
    expect(vacio).toMatch(/font-style:\s*italic\s*;/);
  });
});
