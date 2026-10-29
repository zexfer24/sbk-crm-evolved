import { describe, expect, it } from "vitest";

/**
 * 29/10/2026, "La píldora de velocidad baja a su línea": jsdom no calcula
 * layout, así que ningún test que renderiza `MessageBubble` puede detectar que
 * la píldora de velocidad se sale de la burbuja en pantallas angostas. Medido
 * con Chromium real el 29/10/2026: `.crm-bubble` ofrece 275 px de contenido a
 * 900 px de viewport y 237 px a 390 px, y el `<audio>` exige 300 px (los
 * controles nativos se deforman por debajo).
 *
 * Historia de este contrato, en tres pasos medidos:
 *  1. Con el `<audio>` en `flex: 1 1 auto`, su base era el 100 % del
 *     contenedor por `w-full`, así que la píldora nunca cabía al lado y bajaba
 *     de línea aunque cupiera (1440 px).
 *  2. Con `justify-content: flex-end` el audio de 300 px desbordaba una burbuja
 *     más angosta y el desborde salía por la IZQUIERDA (`left: -23`, cortado).
 *     Antes desbordaba hacia la derecha, que es lo tolerable.
 *  3. Por eso ahora el `<audio>` tiene base fija `flex: 1 1 300px` (vence al
 *     `w-full`), la píldora va con `margin-left: auto` para quedar a la derecha
 *     cuando baja sola a la segunda línea, y NO hay `justify-content: flex-end`.
 *
 * Por eso se mira la HOJA de estilos directamente, igual que
 * `inventario-css.test.ts`.
 */

async function leerCss() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), "src/components/crm.css"), "utf8");
}

function bloque(css: string, regex: RegExp, nombre: string) {
  const regla = regex.exec(css);
  expect(regla, `no se encontró la regla \`${nombre}\` en crm.css`).not.toBeNull();
  return regla![1];
}

describe("la hoja de estilos de la nota de voz", () => {
  it(".crm-audio envuelve la píldora a otra línea, sin alinear el contenido a la derecha", async () => {
    const css = await leerCss();
    const regla = bloque(css, /\.crm-audio\s*\{([^}]*)\}/, ".crm-audio");

    expect(
      regla,
      "sin `flex-wrap: wrap` la píldora se queda en la misma fila que el audio de 300px y se sale de la burbuja a 390px"
    ).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(
      regla,
      "con `justify-content: flex-end` el audio de 300px desborda una burbuja angosta hacia la IZQUIERDA y lo corta (medido el 29/10/2026)"
    ).not.toMatch(/justify-content:\s*flex-end\s*;/);
  });

  it(".crm-audio audio tiene base fija de 300px: el audio no se encoge por debajo del mínimo de sus controles", async () => {
    const css = await leerCss();
    const regla = bloque(css, /\.crm-audio audio\s*\{([^}]*)\}/, ".crm-audio audio");

    expect(
      regla,
      "con `flex: 1 1 auto` la base es el 100 % del contenedor por `w-full` y la píldora nunca cabe al lado del audio, aunque quepa"
    ).toMatch(/flex:\s*1\s+1\s+300px\s*;/);
  });

  it(".crm-audio-speed no encoge y, cuando baja a la segunda línea, queda a la derecha", async () => {
    const css = await leerCss();
    const regla = bloque(css, /\.crm-audio-speed\s*\{([^}]*)\}/, ".crm-audio-speed");

    expect(
      regla,
      "sin `flex-shrink: 0` el flex encoge la píldora y su texto «1.5×» se corta"
    ).toMatch(/flex-shrink:\s*0\s*;/);
    expect(
      regla,
      "sin `margin-left: auto` la píldora que baja de línea queda pegada a la izquierda, no a la derecha de la burbuja"
    ).toMatch(/margin-left:\s*auto\s*;/);
  });
});
