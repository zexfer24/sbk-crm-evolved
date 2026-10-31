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
  const css = await readFile(join(process.cwd(), "src/components/inventario/inventario.css"), "utf8");
  // Windows: git puede entregar CRLF; los cortes por "\n}\n" de abajo dependen de LF.
  return css.replace(/\r\n/g, "\n");
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

  it("NINGUNA plantilla de `.inv-row` ni de `.inv-head` termina en `auto` (ni en la lista ancha ni en los container queries)", async () => {
    const css = await leerCss();
    const plantillas = [...css.matchAll(/\.inv-(?:row|head)[^{}]*\{([^}]*)\}/g)]
      .map((m) => /grid-template-columns:\s*([^;]+);/.exec(m[1])?.[1].trim())
      .filter((p): p is string => Boolean(p));

    // 2 anchas (fila y encabezado) x 2 (general y caja) + los container queries.
    expect(plantillas.length, "no se encontraron las plantillas de columnas").toBeGreaterThanOrEqual(8);
    for (const plantilla of plantillas) {
      expect(
        plantilla,
        "una última columna `auto` toma el ancho de SU contenido —variable según la fila— y ese sobrante corre a Stock/Precio/Peso entre una fila y otra: la última columna tiene que ser un ancho fijo o `minmax(0, 1fr)`"
      ).not.toMatch(/auto\s*$/);
    }
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
  it(".inv-row y .inv-head tienen siete columnas (identidad + seis fijas): el código Saint no agrega otra", async () => {
    const css = await leerCss();
    const esperada = "minmax(0, 1fr) 64px 116px 88px 140px 76px 84px";

    for (const selector of [".inv-row", ".inv-head"]) {
      const plantilla = /grid-template-columns:\s*([^;]+);/.exec(bloque(css, selector));
      expect(plantilla, `no se encontró \`grid-template-columns\` en \`${selector}\``).not.toBeNull();
      expect(
        plantilla![1].trim(),
        "el código Saint va DENTRO de la columna 1 (`.inv-identity`), como una línea, no como columna: agregar una columna aquí reabre la trampa del 10/9/2026. 30/10/2026: 64 stock, 116 promoción, 88 divisa, 140 estándar, 76 peso, 84 los dos botones de ícono"
      ).toBe(esperada);
    }
  });

  it(".inv-row y .inv-head son GRID con las cajas ancladas arriba y el padding de 26px de la tarjeta", async () => {
    const css = await leerCss();
    const fila = bloque(css, ".inv-row");
    const cabecera = bloque(css, ".inv-head");

    expect(fila).toMatch(/column-gap:\s*14px\s*;/);
    expect(fila).toMatch(/padding:\s*10px 26px\s*;/);
    expect(cabecera).toMatch(/display:\s*grid\s*;/);
    expect(cabecera).toMatch(/column-gap:\s*14px\s*;/);
    // Mismo padding lateral que la fila, o las etiquetas se corren de sus cajas.
    expect(cabecera).toMatch(/padding:\s*0 26px 8px\s*;/);
  });

  it("el encabezado único: etiquetas chicas en mayúsculas, centradas salvo «Repuesto»", async () => {
    const css = await leerCss();
    const etiqueta = bloque(css, ".inv-head span");
    expect(etiqueta).toMatch(/font-size:\s*10\.5px\s*;/);
    expect(etiqueta).toMatch(/text-transform:\s*uppercase\s*;/);
    expect(etiqueta).toMatch(/color:\s*var\(--lm-muted\)\s*;/);
    expect(bloque(css, ".inv-head span:not(:first-child)")).toMatch(/text-align:\s*center\s*;/);
  });

  it(".inv-panel-lista declara el container `invpanel`: sin él las tres container queries de la lista no hacen nada", async () => {
    const css = await leerCss();
    expect(bloque(css, ".inv-panel-lista")).toMatch(/container:\s*invpanel\s*\/\s*inline-size\s*;/);
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
   * 30/10/2026 (plan «Cada repuesto con su foto», T5a): la lista se acomoda al
   * ancho del PANEL (container query `invpanel`, que declara `.inv-panel-lista`),
   * no al de la ventana: a ≥ 1720 px la calculadora pasa al costado y el panel se
   * angosta sin que la ventana cambie, y los `@media` de antes no lo veían.
   * Reemplaza a los tres bloques de `@media` que fijaban las plantillas de ocho
   * columnas (general, 761–1180 px y teléfono). Tres escalones de panel:
   * ≥ 1080 (una sola fila con encabezado), < 1080 (datos en 5 columnas, botones a
   * la derecha del nombre), < 760 (3 columnas) y < 600 (2 columnas, botones abajo).
   * Cada uno redefine TAMBIÉN la plantilla de caja: la regla base de caja, más
   * específica, pisaría a la del breakpoint si no la tuviera.
   */
  function consulta(css: string, ancho: number): string {
    const inicio = css.indexOf(`@container invpanel (max-width: ${ancho}px)`);
    expect(inicio, `falta \`@container invpanel (max-width: ${ancho}px)\` en inventario.css`).toBeGreaterThanOrEqual(0);
    // Los container queries de la lista no anidan reglas con llaves dobles: la primera "\n}\n" las cierra.
    return css.slice(inicio, css.indexOf("\n}\n", inicio));
  }

  it("existen las tres container queries del panel (1079 / 759 / 599) y NO queda ningún @media que redefina `.inv-row`", async () => {
    const css = await leerCss();
    consulta(css, 1079);
    consulta(css, 759);
    consulta(css, 599);

    expect(css, "las plantillas por ancho de ventana quedaron reemplazadas por las del panel").not.toContain(
      "@media (min-width: 761px) and (max-width: 1180px)"
    );
    for (const m of css.matchAll(/^@media[^{]*\{/gm)) {
      const resto = css.slice(m.index, css.indexOf("\n}\n", m.index));
      expect(resto, `el ${m[0].trim()} redefine \`.inv-row\`: tiene que ir en un container query del panel`).not.toMatch(
        /\.inv-row[^{]*\{[^}]*grid-template-columns/
      );
    }
  });

  it("panel < 1080: sin encabezado, datos en 5 columnas (caja 4), identidad a la izquierda y botones a la derecha del nombre", async () => {
    const css = await leerCss();
    const q = consulta(css, 1079);

    expect(q).toMatch(/\.inv-head\s*\{[^}]*display:\s*none\s*;/);
    // Sin encabezado, cada caja lleva su propia etiqueta.
    expect(q).toMatch(/\.inv-row \.inv-field > \.lm-eyebrow\s*\{[^}]*display:\s*block\s*;/);
    expect(q).toMatch(/\.inv-row\s*\{[^}]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)\s*;/);
    expect(q).toMatch(/\.inv-row\[data-solo-lectura="true"\]\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)\s*;/);
    expect(q).toMatch(/\.inv-row \.inv-identity\s*\{[^}]*grid-row:\s*1\s*;[^}]*grid-column:\s*1 \/ -2\s*;/);
    expect(q).toMatch(/\.inv-row \.inv-acciones\s*\{[^}]*grid-row:\s*1\s*;[^}]*grid-column:\s*-2 \/ -1\s*;/);
  });

  it("panel < 760: los datos pasan a 3 columnas, también en caja", async () => {
    const css = await leerCss();
    const q = consulta(css, 759);

    expect(q).toMatch(/\.inv-row,\s*\.inv-row\[data-solo-lectura="true"\]\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)\s*;/);
  });

  it("panel < 600: 2 columnas, identidad y botones a todo el ancho (botones abajo, repartidos), foto de 64px", async () => {
    const css = await leerCss();
    const q = consulta(css, 599);

    expect(q).toMatch(/\.inv-row,\s*\.inv-row\[data-solo-lectura="true"\]\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)\s*;[^}]*padding:\s*12px 16px\s*;/);
    expect(q).toMatch(/\.inv-row \.inv-identity\s*\{[^}]*grid-column:\s*1 \/ -1\s*;/);
    expect(q).toMatch(/\.inv-row \.inv-acciones\s*\{[^}]*grid-row:\s*auto\s*;[^}]*grid-column:\s*1 \/ -1\s*;/);
    expect(q).toMatch(/\.inv-row \.inv-acciones \.inv-icon-btn\s*\{[^}]*flex:\s*1 1 0\s*;/);
    expect(q).toMatch(/\.inv-row \.foto-thumb\s*\{[^}]*width:\s*64px\s*;[^}]*height:\s*64px\s*;/);
    // La caja «Ordenar por» se ancla a la izquierda: a la derecha se saldría del panel.
    expect(q).toMatch(/\.inv-orden-menu\s*\{[^}]*right:\s*auto\s*;[^}]*left:\s*0\s*;/);
  });

  /*
   * Rol caja (14/10/2026, plan "La caja no ve el precio estándar"): la fila de
   * caja no pinta el campo Precio estándar, así que su grilla es OTRA — sacar un
   * hijo de la fila con la plantilla completa correría Peso y los botones una
   * columna a la izquierda de la suya (trampa del 10/9/2026). `display: none`
   * sobre el campo tampoco sirve: la plantilla completa seguiría repartiendo
   * columnas. El atributo cuelga de la fila (`data-solo-lectura`) y del
   * encabezado, que tiene que coincidir columna a columna con ella.
   */
  it("la fila y el encabezado de caja tienen su propia plantilla de seis columnas, sin la del Precio estándar", async () => {
    const css = await leerCss();

    for (const selector of ['.inv-row[data-solo-lectura="true"]', '.inv-head[data-solo-lectura="true"]']) {
      const plantilla = /grid-template-columns:\s*([^;]+);/.exec(bloque(css, selector));
      expect(plantilla, `${selector} necesita su propio \`grid-template-columns\``).not.toBeNull();
      expect(plantilla![1].trim()).toBe("minmax(0, 1fr) 64px 116px 88px 76px 84px");
    }
  });

  it(".inv-fee y .inv-bs van alineados a la derecha, 11px, sin partir línea el envío", async () => {
    const css = await leerCss();
    const fee = bloque(css, ".inv-fee");
    expect(fee).toMatch(/font-size:\s*11px\s*;/);
    expect(fee).toMatch(/line-height:\s*14px\s*;/);
    expect(fee).toMatch(/color:\s*var\(--lm-muted\)\s*;/);
    expect(fee).toMatch(/text-align:\s*right\s*;/);
    expect(fee, "«incluye envío $X» no puede partir línea: se leería como dos notas").toMatch(/white-space:\s*nowrap\s*;/);
    expect(fee).toMatch(/padding-right:\s*9px\s*;/);

    const pie = bloque(css, ".inv-bs");
    expect(pie).toMatch(/text-align:\s*right\s*;/);
    expect(pie).toMatch(/font-size:\s*11px\s*;/);
    expect(pie).toMatch(/line-height:\s*14px\s*;/);
    expect(pie).toMatch(/padding-right:\s*9px\s*;/);
    expect(bloque(css, ".inv-fee .lm-num"), "el monto del envío va un tono más oscuro").toMatch(/color:\s*var\(--lm-ink-soft\)\s*;/);

    const vacio = bloque(css, '.inv-readonly[data-empty="true"]');
    expect(vacio).toMatch(/font-style:\s*italic\s*;/);
  });

  it("la columna `.inv-status` ya no existe: las insignias bajaron bajo el nombre", async () => {
    const css = await leerCss();
    // Solo reglas: los comentarios históricos sí nombran la columna que se fue.
    expect(css).not.toMatch(/^\.inv-status\s*[{,]/m);
    expect(css).not.toMatch(/^\s*\.inv-status[^{]*\{/m);
    expect(css).not.toMatch(/^\s*\.inv-compat[\w-]*\s*[{,]/m);
  });

  it("la etiqueta de cada caja se oculta en el layout ancho (la da el encabezado) y va centrada", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".inv-row .inv-field > .lm-eyebrow");
    expect(regla).toMatch(/display:\s*none\s*;/);
    expect(regla).toMatch(/text-align:\s*center\s*;/);
  });

  it("el stock se pinta con su semáforo: verde disponible, naranja bajo, rojo agotado (mismos tonos que la tarjeta)", async () => {
    const css = await leerCss();

    expect(bloque(css, '.inv-input-wrap[data-level="disponible"]')).toMatch(
      /border-color:\s*rgba\(34, 160, 107, 0\.45\)\s*;[^}]*background:\s*rgba\(34, 160, 107, 0\.08\)\s*;/
    );
    expect(bloque(css, '.inv-input-wrap[data-level="bajo"]')).toMatch(
      /border-color:\s*rgba\(231, 154, 36, 0\.55\)\s*;[^}]*background:\s*rgba\(231, 154, 36, 0\.1\)\s*;/
    );
    expect(bloque(css, '.inv-input-wrap[data-level="agotado"]')).toMatch(
      /border-color:\s*rgb\(var\(--lm-hot-rgb\) \/ 0\.45\)\s*;[^}]*background:\s*rgb\(var\(--lm-hot-rgb\) \/ 0\.08\)\s*;/
    );
    expect(bloque(css, '.inv-input-wrap[data-level="disponible"] .inv-readonly')).toMatch(
      /color:\s*var\(--lm-good-ink\)\s*;[^}]*font-weight:\s*600\s*;/
    );
  });

  /*
   * T2/T3 del plan "Inventario y caja" (13/10/2026): los botones salen de
   * `.inv-status` a su propio bloque, en una columna de ancho FIJO (si fuera
   * `auto` cada fila repartiría distinto y correría Stock/Precio/Peso, trampa del
   * 10/9/2026). 30/10/2026: ahora son dos botones de ÍCONO (38x38, radio 11) lado
   * a lado y alineados a la derecha — antes dos píldoras con texto apiladas.
   */
  it(".inv-acciones pone los dos botones de ícono en fila, a la derecha, en una columna de ancho fijo", async () => {
    const css = await leerCss();
    const acciones = bloque(css, ".inv-acciones");
    expect(acciones).toMatch(/display:\s*flex\s*;/);
    expect(acciones).toMatch(/flex-direction:\s*row\s*;/);
    expect(acciones).toMatch(/justify-content:\s*flex-end\s*;/);
    expect(acciones, "hijo de grid con `min-width: 0` (regla de la casa)").toMatch(/min-width:\s*0\s*;/);

    const plantilla = /grid-template-columns:\s*([^;]+);/.exec(bloque(css, ".inv-row"))![1].trim();
    const columnas = plantilla.split(/\s+(?![^()]*\))/);
    expect(columnas).toHaveLength(7);
    for (const columna of columnas.slice(1)) {
      expect(columna, `la columna \`${columna}\` no es de ancho fijo`).toMatch(/^\d+px$/);
    }
  });

  it("los botones de ícono: 38x38 con radio 11, carrito azul, Cashea sobre fondo hundido, foco visible y deshabilitado apagado", async () => {
    const css = await leerCss();
    const base = bloque(css, ".inv-icon-btn");
    expect(base).toMatch(/width:\s*38px\s*;/);
    expect(base).toMatch(/height:\s*38px\s*;/);
    expect(base).toMatch(/border-radius:\s*11px\s*;/);
    expect(bloque(css, '.inv-icon-btn[data-tipo="carrito"]')).toMatch(/background:\s*var\(--lm-link\)\s*;/);
    expect(bloque(css, '.inv-icon-btn[data-tipo="cashea"]')).toMatch(/background:\s*var\(--lm-sunken\)\s*;/);
    expect(bloque(css, ".inv-icon-btn:focus-visible")).toMatch(/outline:/);
    expect(bloque(css, ".inv-icon-btn:disabled")).toMatch(/cursor:\s*not-allowed\s*;/);
  });

  it("la foto de la fila mide 72px y el nombre es un botón que no se ve como botón", async () => {
    const css = await leerCss();
    expect(bloque(css, ".inv-row .foto-thumb")).toMatch(/width:\s*72px\s*;[^}]*height:\s*72px\s*;/);
    const nombre = bloque(css, ".inv-name");
    expect(nombre).toMatch(/cursor:\s*pointer\s*;/);
    expect(nombre).toMatch(/background:\s*none\s*;/);
  });

  /*
   * La caja «Ordenar por» vive DENTRO de la barra sticky (`.cli-toolbar`, z-index
   * 19 en mostrador.css): su menú tiene que quedar por encima de las filas, y a la
   * izquierda en teléfono (ver el container query de 599px, arriba).
   */
  it("el menú «Ordenar por» se ancla a la derecha de su botón y flota por encima de las filas", async () => {
    const css = await leerCss();
    expect(bloque(css, ".inv-orden")).toMatch(/position:\s*relative\s*;/);
    const menu = bloque(css, ".inv-orden-menu");
    expect(menu).toMatch(/position:\s*absolute\s*;/);
    expect(menu).toMatch(/right:\s*0\s*;/);
    expect(Number(/z-index:\s*(\d+)\s*;/.exec(menu)?.[1]), "sin z-index propio las filas lo tapan").toBeGreaterThan(0);
    expect(bloque(css, ".inv-orden-punto")).toMatch(/background:\s*var\(--lm-link\)\s*;/);
  });

  it("el grid de tarjetas KPI deja entrar las 7 en una fila a 1280px: 150px mínimos, sobreescrito aquí y no en clientes.css", async () => {
    const css = await leerCss();
    const regla = bloque(css, ".cli-stats.inv-stats");
    expect(regla).toMatch(/grid-template-columns:\s*repeat\(auto-fit, minmax\(150px, 1fr\)\)\s*;/);
    // «Con foto» se distingue con un tinte azul y lleva una barra de avance.
    expect(bloque(css, '.cli-stat[data-nuevo="true"]')).toMatch(/border-color:/);
    expect(bloque(css, ".cli-stat-bar span")).toMatch(/background:\s*var\(--lm-link\)\s*;/);
  });

  it("el interruptor Lista / Cuadrícula y el paginador numerado tienen sus reglas", async () => {
    const css = await leerCss();
    expect(bloque(css, '.inv-vista button[aria-pressed="true"]')).toMatch(/font-weight:\s*600\s*;/);
    expect(bloque(css, '.inv-pag-pages a[aria-current="page"]')).toMatch(/background:\s*var\(--lm-ink\)\s*;/);
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
