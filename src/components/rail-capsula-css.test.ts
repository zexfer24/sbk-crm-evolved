import { describe, expect, it } from "vitest";

/**
 * El rail como CÁPSULA (15/11/2026, rediseño pedido por el operador con una
 * imagen de referencia): una cápsula vertical casi negra, flotante, angosta, que
 * abraza sus botones y los separa en grupos con líneas finas. Vale para las dos
 * variantes (`.dash-rail`, pantallas enmarcadas, y `.crm-rail`, la bandeja). A
 * ≤820 px el rail de la bandeja pasa a fila y la cápsula se vuelve horizontal.
 * jsdom no calcula layout, así que este test mira las HOJAS.
 */

async function leer(ruta: string) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), ruta), "utf8");
}

function escapar(texto: string) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cuerpo de una regla; si `desde` se da, busca solo a partir de esa posición del texto. */
function bloque(css: string, selector: string, desde = 0) {
  const regla = new RegExp(`(?:^|[}/;{\\s])${escapar(selector)}\\s*\\{([^}]*)\\}`).exec(css.slice(desde));
  expect(regla, `no se encontró la regla \`${selector}\``).not.toBeNull();
  return regla![1];
}

/** ¿Hay una regla cuyo selector (puede ir en lista) contiene `selector` y cuyo cuerpo calza `cuerpo`? */
function reglaCon(css: string, selector: string, cuerpo: RegExp) {
  const re = new RegExp(`${escapar(selector)}[^{]*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(re)].some((m) => cuerpo.test(m[1]));
}

const FG = String.raw`rgb\(var\(--lm-rail-fg-rgb\)\s*/\s*`;

const VARIANTES = [
  { nombre: "dash", hoja: "src/components/dashboard/dashboard.css" },
  { nombre: "crm", hoja: "src/components/crm.css" },
] as const;

describe.each(VARIANTES)("la cápsula del rail ($nombre)", ({ nombre, hoja }) => {
  it("es una cápsula redondeada, angosta, con los colores de los tokens del tema", async () => {
    const regla = bloque(await leer(hoja), `.${nombre}-rail-capsule`);

    expect(regla).toMatch(/border-radius:\s*999px\s*;/);
    expect(regla).toMatch(/background:\s*var\(--lm-rail-bg\)\s*;/);
    expect(regla).toMatch(/border:\s*1px\s+solid\s+var\(--lm-rail-border\)\s*;/);
    expect(regla).toMatch(/box-shadow:\s*var\(--lm-rail-shadow\)\s*;/);
    expect(regla).toMatch(/width:\s*56px\s*;/);
    expect(regla, "sin colores fijos: todo sale de los tokens").not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("en ventanas bajas se desplaza por dentro, con la barra oculta, sin cortar botones", async () => {
    const css = await leer(hoja);
    const regla = bloque(css, `.${nombre}-rail-capsule`);

    expect(regla).toMatch(/max-height:\s*calc\(100vh\s*-\s*\d+px\)\s*;/);
    expect(regla).toMatch(/overflow-y:\s*auto\s*;/);
    expect(regla).toMatch(/scrollbar-width:\s*none\s*;/);
    expect(bloque(css, `.${nombre}-rail-capsule::-webkit-scrollbar`)).toMatch(/display:\s*none\s*;/);
  });

  it("no hay spacer que empuje el grupo de abajo: la cápsula abraza su contenido", async () => {
    expect(await leer(hoja)).not.toContain(`.${nombre}-rail-spacer`);
  });

  it("el separador es una línea de 1 px y 24 px de largo, blanca a ~15 %", async () => {
    const regla = bloque(await leer(hoja), `.${nombre}-rail-sep`);

    expect(regla).toMatch(/width:\s*24px\s*;/);
    expect(regla).toMatch(/height:\s*1px\s*;/);
    expect(regla).toMatch(new RegExp(`background:\\s*${FG}0?\\.15\\)\\s*;`));
    expect(regla).toMatch(/flex:\s*none\s*;/);
  });

  it("los botones son círculos de 40 px: inactivo ~70 %, hover 8 %, activo 18 %, con foco visible", async () => {
    const css = await leer(hoja);
    const base = bloque(css, `.${nombre}-rail-btn`);
    expect(base).toMatch(/width:\s*40px\s*;/);
    expect(base).toMatch(/height:\s*40px\s*;/);
    expect(base).toMatch(/border-radius:\s*999px\s*;/);
    expect(base).toMatch(new RegExp(`color:\\s*${FG}0?\\.7\\)\\s*;`));

    expect(reglaCon(css, `.${nombre}-rail-btn:hover`, new RegExp(`${FG}0?\\.08\\)`))).toBe(true);
    expect(reglaCon(css, `.${nombre}-rail-btn[data-active="true"]`, new RegExp(`${FG}0?\\.18\\)`))).toBe(true);
    expect(reglaCon(css, `.${nombre}-rail-btn:focus-visible`, new RegExp(`outline:\\s*2px\\s+solid\\s+${FG}`))).toBe(true);
  });

  // 15/11/2026: la cápsula queda FIJA y centrada en vertical respecto de la
  // VENTANA: al hacer scroll se queda en su lugar y la página corre por detrás.
  // Sale del flujo, así que el <nav> sigue entregando un solo hijo al grid (la
  // marca) y la columna del rail no cambia de alto.
  it("está fija y centrada en la ventana, a 16 px del borde izquierdo, bajo los diálogos", async () => {
    const regla = bloque(await leer(hoja), `.${nombre}-rail-capsule`);

    expect(regla).toMatch(/position:\s*fixed\s*;/);
    expect(regla).toMatch(/top:\s*50%\s*;/);
    expect(regla).toMatch(/transform:\s*translateY\(-50%\)\s*;/);
    // `.crm`: el hueco ES la columna y 16 la centra. `.dash`: el centro sigue al hueco
    // entre el borde de la ventana y el contenido (`rail-hueco-css.test.ts`).
    if (nombre === "crm") expect(regla).toMatch(/left:\s*16px\s*;/);
    else expect(regla).toMatch(/left:\s*calc\(var\(--dash-hueco-centro\)\s*-\s*28px\)\s*;/);
    // HeroUI pinta overlays en z-index 50 y los visores/menús de la bandeja en 60.
    const z = /z-index:\s*(\d+)\s*;/.exec(regla);
    expect(z, "la cápsula necesita z-index propio sobre el contenido").not.toBeNull();
    expect(Number(z![1])).toBeGreaterThan(0);
    expect(Number(z![1])).toBeLessThan(50);
  });

  it("deja la marca visible: la cápsula nunca sube hasta la placa SBK (max-height descuenta 72 px arriba y abajo)", async () => {
    const regla = bloque(await leer(hoja), `.${nombre}-rail-capsule`);
    expect(regla).toMatch(/max-height:\s*calc\(100vh\s*-\s*144px\)\s*;/);
  });

  it("la columna del rail es de 88 px: la cápsula (16 + 56) deja aire hasta el contenido", async () => {
    const css = await leer(hoja);
    const grid = nombre === "dash" ? ".dash-frame" : ".crm";
    const columna = nombre === "dash" ? String.raw`var\(--dash-rail-w\)` : "88px";
    expect(bloque(css, grid)).toMatch(new RegExp(String.raw`grid-template-columns:\s*${columna}\s+minmax\(0,\s*1fr\)\s*;`));
    if (nombre === "dash") expect(bloque(css, grid)).toMatch(/--dash-rail-w:\s*88px\s*;/);
  });

  it("respeta prefers-reduced-motion en los botones del rail", async () => {
    const css = await leer(hoja);
    const bloques = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    expect(bloques.some((b) => reglaCon(b, `.${nombre}-rail-btn`, /transition:\s*none/))).toBe(true);
  });
});

describe("el rail de la bandeja a ≤820 px", () => {
  it("la cápsula se vuelve horizontal: fila, con scroll horizontal y separadores verticales", async () => {
    const css = await leer("src/components/crm.css");
    const desde = css.indexOf("@media (max-width: 820px)");
    expect(desde).toBeGreaterThan(-1);

    const capsula = bloque(css, ".crm-rail-capsule", desde);
    expect(capsula).toMatch(/flex-direction:\s*row\s*;/);
    expect(capsula).toMatch(/overflow-x:\s*auto\s*;/);
    expect(capsula).toMatch(/overflow-y:\s*hidden\s*;/);
    expect(capsula).toMatch(/max-height:\s*none\s*;/);
    expect(capsula).toMatch(/min-width:\s*0\s*;/);

    // A ≤820 px NO se fija ni se centra: vuelve al flujo, dentro de la fila del rail.
    expect(capsula).toMatch(/position:\s*static\s*;/);
    expect(capsula).toMatch(/transform:\s*none\s*;/);
    expect(capsula).not.toMatch(/position:\s*fixed/);

    const sep = bloque(css, ".crm-rail-sep", desde);
    expect(sep).toMatch(/width:\s*1px\s*;/);
    expect(sep).toMatch(/height:\s*24px\s*;/);
  });
});

describe("el rail de las pantallas enmarcadas a ≤760 px", () => {
  it("sigue oculto en el teléfono: ahí manda la barra superior, y la cápsula no se asoma", async () => {
    const css = await leer("src/components/dashboard/dashboard.css");
    const desde = css.indexOf("@media (max-width: 760px) {\n  .dash-frame") > -1
      ? css.indexOf("@media (max-width: 760px) {\n  .dash-frame")
      : css.indexOf("@media (max-width: 760px)");
    expect(desde).toBeGreaterThan(-1);
    expect(bloque(css, ".dash-rail", desde)).toMatch(/display:\s*none\s*;/);
  });
});

describe("los tokens de la cápsula en los dos temas", () => {
  it.each(["--lm-rail-bg", "--lm-rail-border", "--lm-rail-shadow", "--lm-rail-fg-rgb"])(
    "%s está definido en el tema claro (:root) y en el oscuro",
    async (token) => {
      const css = await leer("src/app/theme.css");
      const oscuro = css.indexOf(':root[data-theme="dark"],');
      expect(oscuro).toBeGreaterThan(-1);
      expect(css.slice(0, oscuro), `${token} en :root`).toContain(`${token}:`);
      expect(css.slice(oscuro), `${token} en oscuro`).toContain(`${token}:`);
    }
  );
});

describe("las pestañas internas de los paneles ya no existen", () => {
  it("paneles.css no conserva .pn-pestanas ni .pn-pestana", async () => {
    const css = await leer("src/components/paneles/paneles.css");
    expect(css).not.toMatch(/\.pn-pestana/);
  });
});
