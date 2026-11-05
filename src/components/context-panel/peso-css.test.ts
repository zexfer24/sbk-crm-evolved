import { describe, expect, it } from "vitest";

/**
 * 5/11/2026 (pedido del cliente, «Peso total» del carrito): jsdom no calcula
 * layout ni colores, así que las clases nuevas del peso se fijan mirando la
 * HOJA, como `cart-lines-css.test.ts`. Tienen que usar las variables
 * `--lm-wait*` del tema (que cambian en oscuro) y nunca un hex fijo.
 */

async function leer(ruta: string) {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(process.cwd(), ruta), "utf8");
}

function bloque(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n|,\\s*)${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g");
  const cuerpos = [...css.matchAll(regex)].map((m) => m[1]);
  expect(cuerpos.length, `no se encontró la regla \`${selector}\``).toBeGreaterThan(0);
  return cuerpos.join("\n");
}

const SIN_HEX = /#[0-9a-fA-F]{3,8}\b/;

describe("la hoja de estilos del peso total", () => {
  it(".aviso-peso (la píldora «Faltan pesos») usa --lm-wait y --lm-wait-ink, sin hex", async () => {
    const regla = bloque(await leer("src/components/presupuestos/presupuestos.css"), ".aviso-peso");
    expect(regla).toMatch(/var\(--lm-wait\)/);
    expect(regla).toMatch(/color:\s*var\(--lm-wait-ink\)/);
    expect(regla).not.toMatch(SIN_HEX);
  });

  it(".aviso-nota (el aviso bajo la vista previa) usa --lm-wait-ink, sin hex", async () => {
    const regla = bloque(await leer("src/components/presupuestos/presupuestos.css"), ".aviso-nota");
    expect(regla).toMatch(/color:\s*var\(--lm-wait-ink\)/);
    expect(regla).not.toMatch(SIN_HEX);
  });

  it(".crm-pcart-sinpeso (la marca del renglón) usa --lm-wait-ink, sin hex", async () => {
    const regla = bloque(await leer("src/components/crm.css"), ".crm-pcart-sinpeso");
    expect(regla).toMatch(/color:\s*var\(--lm-wait-ink\)/);
    expect(regla).not.toMatch(SIN_HEX);
  });

  it("el valor del peso del pie es MÁS CHICO que el total en dólares (15 px contra 20 px)", async () => {
    const css = await leer("src/components/crm.css");
    const peso = bloque(css, ".crm-pcart-foot-peso-valor");
    const total = bloque(css, ".crm-pcart-foot-usd");
    const px = (r: string) => Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(r)?.[1]);
    expect(px(peso)).toBe(15);
    expect(px(peso)).toBeLessThan(px(total));
    expect(peso).toMatch(/font-weight:\s*700/);
    expect(peso).not.toMatch(SIN_HEX);
  });
});
