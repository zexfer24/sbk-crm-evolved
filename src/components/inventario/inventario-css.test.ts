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
  it(".inv-row tiene ocho columnas fijas (Precio divisa es la última agregada): el código Saint no agrega otra", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-row");
    const plantilla = /grid-template-columns:\s*([^;]+);/.exec(regla);

    expect(plantilla, "no se encontró `grid-template-columns` en `.inv-row`").not.toBeNull();
    expect(
      plantilla![1].trim(),
      "el código Saint va DENTRO de la columna 1 (`.inv-identity`), como una línea nueva, no como columna: agregar una columna aquí reabre la trampa del 10/9/2026"
    ).toBe("minmax(0, 1fr) 100px 150px 110px 150px 110px 160px 140px");
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
   *
   * 30/10/2026 (plan "Precio divisa desde SAINT"): suma OTRA columna fija de
   * 150px, Precio divisa, entre promoción y estándar. La plantilla general
   * pasa a ocho columnas, la de caja a siete; en teléfono los cinco campos
   * siguen en dos columnas (Stock/Promoción, Divisa/Estándar, Peso solo).
   */
  it("en teléfono los cinco campos caben en dos columnas, identidad y estado a fila entera", async () => {
    const css = await leerCss();
    const inicio = css.indexOf("@media (max-width: 760px)");
    expect(inicio, "no se encontró el breakpoint de teléfono en inventario.css").toBeGreaterThanOrEqual(0);
    const movil = css.slice(inicio);
    const fila = /\.inv-row\s*\{([^}]*)\}/.exec(movil);

    expect(fila, "no se encontró `.inv-row` dentro del breakpoint de teléfono").not.toBeNull();
    expect(fila![1], "con cinco campos, tres columnas dejaban huérfanos").toMatch(
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/
    );
    expect(movil).toMatch(/\.inv-identity,\s*\.inv-status,\s*\.inv-acciones\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/);
  });

  it("entre 761 y 1180px el estado baja a su propia línea y le deja el ancho al nombre", async () => {
    const css = await leerCss();
    const inicio = css.indexOf("@media (min-width: 761px) and (max-width: 1180px)");
    expect(inicio, "sin este breakpoint, a 1024px el nombre queda en ~20px").toBeGreaterThanOrEqual(0);
    const medio = css.slice(inicio, css.indexOf("@media (max-width: 760px)"));
    expect(medio).toMatch(/\.inv-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 100px 150px 110px 150px 110px\s*;/);
    expect(medio).toMatch(/\.inv-status\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/);
    // Los botones suben a la misma línea completa, ahora en fila.
    expect(medio).toMatch(/\.inv-acciones\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/);
    expect(medio).toMatch(/\.inv-acciones\s*\{[^}]*flex-direction:\s*row\s*;/);
  });

  /*
   * Rol caja (14/10/2026, plan "La caja no ve el precio estándar"): la fila de
   * caja no pinta el campo Precio estándar, así que su grilla es OTRA, con
   * seis columnas fijas — sacar un hijo de la fila con la plantilla de siete
   * correría Peso, estado y acciones una columna a la izquierda de la suya
   * (trampa del 10/9/2026). `display: none` sobre el campo tampoco sirve: la
   * plantilla de siete seguiría repartiendo columnas. El atributo cuelga de
   * la fila (`data-solo-lectura`), y cada breakpoint que redefine `.inv-row`
   * trae su variante de caja (la regla base de caja, más específica, pisaría
   * a la del breakpoint si no la tuviera).
   */
  it("la fila de caja tiene su propia plantilla de siete columnas fijas, sin la del Precio estándar", async () => {
    const css = await leerCss();
    const regla = bloque(css, '.inv-row[data-solo-lectura="true"]');
    const plantilla = /grid-template-columns:\s*([^;]+);/.exec(regla);

    expect(plantilla, "la fila de caja necesita su propio `grid-template-columns`").not.toBeNull();
    expect(plantilla![1].trim()).toBe("minmax(0, 1fr) 100px 150px 110px 110px 160px 140px");
  });

  it("cada breakpoint que redefine `.inv-row` redefine también la de caja, sin la columna del estándar", async () => {
    const css = await leerCss();
    const medioInicio = css.indexOf("@media (min-width: 761px) and (max-width: 1180px)");
    const movilInicio = css.indexOf("@media (max-width: 760px)");
    expect(medioInicio).toBeGreaterThanOrEqual(0);
    expect(movilInicio).toBeGreaterThan(medioInicio);
    const medio = css.slice(medioInicio, movilInicio);
    const movil = css.slice(movilInicio, css.indexOf("/* --- Calculadora Cashea"));

    expect(medio, "entre 761 y 1180px la caja necesita sus 5 columnas de campos").toMatch(
      /\.inv-row\[data-solo-lectura="true"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 100px 150px 110px 110px\s*;/
    );
    expect(movil, "en teléfono la caja repite las dos columnas (Stock/Promoción, Peso)").toMatch(
      /\.inv-row\[data-solo-lectura="true"\]\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/
    );

    // Toda redefinición de `.inv-row` en una media query tiene su gemela de caja.
    const hojaConMedia = css.slice(medioInicio, css.indexOf("/* --- Calculadora Cashea"));
    const normales = hojaConMedia.match(/\.inv-row\s*\{[^}]*grid-template-columns/g) ?? [];
    const decaja = hojaConMedia.match(/\.inv-row\[data-solo-lectura="true"\]\s*\{[^}]*grid-template-columns/g) ?? [];
    expect(decaja.length, "una media query redefine `.inv-row` sin variante de caja").toBe(normales.length);
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

  /*
   * T2/T3 del plan "Inventario y caja" (13/10/2026): «Agregar al carrito» y
   * «Cashea» salen de `.inv-status` a su propio bloque, columna de ancho FIJO
   * (si fuera `auto` cada fila repartiría distinto según "En carrito ×99" vs
   * "Agregar al carrito" y correría Stock/Precio/Peso, trampa del 10/9/2026).
   */
  it(".inv-acciones apila los botones y vive en una columna de ancho fijo, como la de estado", async () => {
    const css = await leerCss();
    const acciones = bloque(css, ".inv-acciones");
    expect(acciones).toMatch(/display:\s*flex\s*;/);
    expect(acciones).toMatch(/flex-direction:\s*column\s*;/);

    const plantilla = /grid-template-columns:\s*([^;]+);/.exec(bloque(css, ".inv-row"))![1].trim();
    const columnas = plantilla.split(/\s+(?![^()]*\))/);
    expect(columnas).toHaveLength(8);
    for (const columna of columnas.slice(1)) {
      expect(columna, `la columna \`${columna}\` no es de ancho fijo`).toMatch(/^\d+px$/);
    }
  });

  it("los botones de acción son píldoras de verdad: con mano, foco visible y deshabilitado apagado", async () => {
    const css = await leerCss();
    expect(bloque(css, ".crm-pill.inv-accion-btn")).toMatch(/justify-content:\s*center\s*;/);
    expect(bloque(css, ".inv-accion-btn:focus-visible")).toMatch(/outline:/);
    expect(bloque(css, ".inv-accion-btn:disabled")).toMatch(/cursor:\s*not-allowed\s*;/);
  });

  it("el carrito flotante va FIJO abajo a la derecha, redondo y por debajo del Drawer/Modal/Toast de HeroUI (z-50)", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-carrito-flotante");

    expect(regla, "sin `position: fixed` el botón queda en el flujo y desarma la grilla de .dash-frame").toMatch(
      /position:\s*fixed\s*;/
    );
    expect(regla).toMatch(/right:\s*24px\s*;/);
    expect(regla).toMatch(/bottom:\s*24px\s*;/);
    expect(regla).toMatch(/width:\s*56px\s*;/);
    expect(regla).toMatch(/height:\s*56px\s*;/);
    expect(regla).toMatch(/border-radius:\s*50%\s*;/);

    // El Drawer, el Modal y el Toast de HeroUI usan `z-50` (node_modules/@heroui/styles): el botón tiene que quedar debajo.
    const z = /z-index:\s*(\d+)\s*;/.exec(regla);
    expect(z, "el botón flotante necesita un z-index propio").not.toBeNull();
    expect(Number(z![1])).toBeLessThan(50);
    expect(Number(z![1])).toBeGreaterThan(0);
  });

  it("en teléfono el carrito flotante se acerca al borde (16px)", async () => {
    const css = await leerCss();
    // Va DESPUÉS de la regla base (misma especificidad: gana la última), así que se busca en el último bloque de 760px.
    const movil = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
    const regla = /\.inv-carrito-flotante\s*\{([^}]*)\}/.exec(movil);
    expect(regla, "falta la regla móvil de `.inv-carrito-flotante`").not.toBeNull();
    expect(regla![1]).toMatch(/right:\s*16px\s*;/);
    expect(regla![1]).toMatch(/bottom:\s*16px\s*;/);
  });

  it("el globo de unidades está pegado a la esquina del botón y la sección de la lista deja aire para no taparle el paginador", async () => {
    const css = await leerCss();
    expect(bloque(css, ".inv-carrito-globo")).toMatch(/position:\s*absolute\s*;/);
    // El paginador cierra la sección de la lista: sin este margen el botón flotante lo tapa al llegar al final de la lista.
    const margen = /margin-bottom:\s*(\d+)px/.exec(bloque(css, ".inv-panel-lista"));
    expect(margen, "`.inv-panel-lista` necesita `margin-bottom`").not.toBeNull();
    expect(Number(margen![1])).toBeGreaterThanOrEqual(80);
  });

  /*
   * 28/10/2026, plan "El carrito de cotización se ordena", T3: el cuerpo del
   * panel lleva solo los artículos y es lo único que se desplaza; el pie es
   * fijo (sin scroll propio) y el desplegable de opciones desplaza por dentro
   * al abrirse, para que los totales y los botones nunca queden tapados.
   */
  it("el cuerpo del carrito desplaza con barra visible, sin saltos, y la lista nunca se aplasta", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-carrito-cuerpo");

    expect(regla, "sin `overflow-y: auto` el último artículo no se alcanza").toMatch(/overflow-y:\s*auto\s*;/);
    expect(regla, "sin `min-height` la lista se aplasta cuando el pie crece").toMatch(/min-height:\s*\d+px\s*;/);
    expect(regla, "sin `scrollbar-gutter: stable` el contenido salta al aparecer la barra").toMatch(
      /scrollbar-gutter:\s*stable\s*;/
    );
  });

  it("el pie del carrito no desplaza por su cuenta (el desplegable lo hace por dentro)", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".drawer__footer.inv-carrito-pie");

    expect(regla, "con scroll en el pie, abrir las opciones taparía los botones").not.toMatch(/overflow-y/);
    expect(regla).toMatch(/max-height:\s*60%\s*;/);
  });

  // 28/10/2026, T3c: el desplegable abierto y los totales comparten UNA zona que
  // desplaza; las acciones quedan fuera, fijas. Un solo scroll, nunca anidado.
  it("el desplegable y los totales comparten una zona que desplaza; el cuerpo del desplegable no tiene scroll propio", async () => {
    const css = await leerCss();
    const zona = bloque(css, ".inv-carrito-pie-ajustes");

    expect(zona, "sin `overflow-y: auto` abrir las opciones con Cashea dejaría el cuerpo en unos pocos px").toMatch(
      /overflow-y:\s*auto\s*;/
    );
    expect(zona, "sin `min-height: 0` un hijo flex no se encoge por debajo de su contenido").toMatch(
      /min-height:\s*0\s*;/
    );
    expect(
      bloque(css, ".inv-carrito-opciones-cuerpo"),
      "un scroll dentro de otro scroll es inusable"
    ).not.toMatch(/overflow-y/);
  });

  it("las acciones nunca se encogen: quedan fijas debajo de la zona desplazable", async () => {
    const css = await leerCss();

    expect(bloque(css, ".inv-carrito-acciones")).toMatch(/flex-shrink:\s*0\s*;/);
    expect(bloque(css, ".inv-carrito-totales")).toMatch(/flex-shrink:\s*0\s*;/);
  });

  it("«Falta el peso» se lee como una acción pendiente, no atenuada", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-falta-peso");
    expect(regla).toMatch(/color:\s*var\(--lm-wait-ink/);
    expect(regla).not.toMatch(/opacity/);
    expect(regla).not.toMatch(/font-style:\s*italic/);
  });
});
