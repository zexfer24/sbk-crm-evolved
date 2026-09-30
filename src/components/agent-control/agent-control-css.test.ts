import { describe, expect, it } from "vitest";

/**
 * Control IA a 390 px (30/9/2026, cierre de la Entrega A2): la tira de
 * pestañas (`.lm-pills.ac-tabs`, ahora siete: se sumó «Búsquedas») es un
 * `inline-flex` de `width: fit-content` con las píldoras en `white-space:
 * nowrap`, o sea que mide lo que miden sus siete etiquetas juntas (975 px
 * medidos con `getBoundingClientRect` sobre el build de producción). Como su
 * padre `.dash-content` es una columna flex, el hijo NO se acota al ancho de la
 * pantalla y arrastra a toda la página: `document.documentElement.scrollWidth`
 * daba 989 con una ventana de 390, en TODAS las pestañas. Ningún otro elemento
 * de la página desbordaba (se recorrió el DOM buscando `right > innerWidth`).
 *
 * jsdom no calcula layout, así que este test mira la HOJA de estilos (mismo
 * patrón que `inventario-css.test.ts`, escrito para `.inv-row`). El arreglo
 * NO toca `.lm-pills` (compartido con la bandeja, donde el carril ya lo
 * resuelve `.crm-inbox-pills-scroll`): la tira va dentro de un carril
 * `.ac-tabs-scroll` que se acota al ancho disponible y scrollea; las píldoras
 * conservan su ancho natural. El scroll NO se puso en `.ac-tabs` a propósito:
 * la copia activa de las píldoras (`.lm-pills-active`) es `position: absolute;
 * inset: 0` y, dentro de un contenedor con scroll, mediría solo la parte
 * visible y el recorte del `clip-path` quedaría corrido.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/agent-control/agent-control.css"), "utf8");
}

function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regla = new RegExp(`(?:^|[}/])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(regla, `no se encontró la regla \`${selector}\` en agent-control.css`).not.toBeNull();
  return regla![1];
}

describe("la hoja de estilos de Control IA", () => {
  it(".ac-tabs-scroll acota la tira de pestañas al ancho disponible y la deja scrollear", async () => {
    const regla = bloque(await leerCss(), ".ac-tabs-scroll");

    expect(regla, "sin `overflow-x: auto` las siete pestañas ensanchan la página a 975 px").toMatch(
      /overflow-x:\s*auto\s*;/
    );
    expect(
      regla,
      "sin `min-width: 0` un hijo de la columna flex no baja del ancho de su contenido"
    ).toMatch(/min-width:\s*0\s*;/);
    expect(regla, "sin `max-width: 100%` el carril crece con la tira").toMatch(/max-width:\s*100%\s*;/);
  });

  it("la separación con el resto de la página la lleva el carril, no la tira", async () => {
    const css = await leerCss();

    expect(bloque(css, ".ac-tabs-scroll")).toMatch(/margin:\s*4px 0 18px\s*;/);
    // Un margen doble separaría de más en escritorio (cambiaría el layout).
    expect(bloque(css, ".ac-tabs")).not.toMatch(/margin/);
  });

  it("la tira no se encoge: sus píldoras conservan el ancho natural dentro del carril", async () => {
    expect(bloque(await leerCss(), ".ac-tabs")).toMatch(/flex-shrink:\s*0\s*;/);
  });
});
