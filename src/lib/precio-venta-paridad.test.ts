import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Product } from "@/lib/types";
import { bsConRecargo, RECARGO_PRECIO, usdConRecargo } from "@/lib/recargo-precio";
import { standardPriceAmounts } from "@/lib/inventory";
import { productPriceUsd } from "@/lib/sale-cart";

/**
 * Paridad TypeScript <-> SQL del precio de venta (plan "Paneles", M1,
 * 13/11/2026).
 *
 * La foto de cada envío a SAINT (`public.ventas_saint`) calcula el monto EN LA
 * BASE con `public.precio_venta_usd`, que replica a mano lo que el CRM muestra:
 * recargo del 16 % (`recargo-precio.ts`), conversión de bolívares con techo a
 * $0,10 (`usd-price.ts`) y precio estándar = promoción + tarifa MRW
 * (`standardPriceAmounts`). Son DOS implementaciones de la misma regla, y si
 * divergen el panel de ventas le cuenta al cliente un número que el mostrador
 * nunca vio. Este archivo ata las dos con casos dorados escritos A MANO (no
 * calculados con ninguna de las dos funciones): acá se comprueba que TypeScript
 * da el valor dorado, y `supabase/tests/ventas_saint.sql` comprueba que SQL da
 * el MISMO valor literal (los tags `[dorado:X]` de abajo aparecen, con su valor,
 * en ese archivo; un tercer test lo verifica para que nadie cambie un lado sin
 * el otro).
 *
 * Tasa de todos los casos: 40.
 */

const TASA = 40;

interface Dorado {
  tag: string;
  descripcion: string;
  currency: "VES" | "USD";
  /** Precio CRUDO de `products.price`, antes del recargo. */
  precioCrudo: number;
  tarifaUsd: number | null;
  tipo: "promocion" | "estandar";
  /** El valor escrito a mano; el mismo aparece en el test SQL. */
  esperadoUsd: string;
}

const DORADOS: Dorado[] = [
  { tag: "A", descripcion: "Bs 1000 promoción: 1160/40 = 29 exacto, no sube", currency: "VES", precioCrudo: 1000, tarifaUsd: null, tipo: "promocion", esperadoUsd: "29.00" },
  { tag: "B", descripcion: "Bs 100,50 promoción: 116,58/40 = 2,9145 sube a 3,00", currency: "VES", precioCrudo: 100.5, tarifaUsd: null, tipo: "promocion", esperadoUsd: "3.00" },
  { tag: "C", descripcion: "Bs 10,35 promoción: 12,01/40 = 0,30025 sube a 0,40", currency: "VES", precioCrudo: 10.35, tarifaUsd: null, tipo: "promocion", esperadoUsd: "0.40" },
  { tag: "D", descripcion: "USD 5,00 promoción: 5,80 exacto, no sube", currency: "USD", precioCrudo: 5, tarifaUsd: null, tipo: "promocion", esperadoUsd: "5.80" },
  { tag: "E", descripcion: "USD 12,34 promoción: 14,3144 sube a 14,40", currency: "USD", precioCrudo: 12.34, tarifaUsd: null, tipo: "promocion", esperadoUsd: "14.40" },
  { tag: "F", descripcion: "Bs 1000 estándar con tarifa 2,10: 29,00 + 2,10", currency: "VES", precioCrudo: 1000, tarifaUsd: 2.1, tipo: "estandar", esperadoUsd: "31.10" },
  { tag: "G", descripcion: "USD 5,00 estándar con tarifa 2,10: 5,80 + 2,10", currency: "USD", precioCrudo: 5, tarifaUsd: 2.1, tipo: "estandar", esperadoUsd: "7.90" },
];

/**
 * El producto tal como lo deja `mapProduct`: el precio YA lleva el recargo.
 * (Solo los campos que leen las funciones de precio.)
 */
function productoMapeado(d: Dorado): Product {
  const price = d.currency === "USD" ? usdConRecargo(d.precioCrudo) : bsConRecargo(d.precioCrudo);
  return { currency: d.currency, price, shippingFeeUsd: d.tarifaUsd } as unknown as Product;
}

/** El precio que ve el mostrador (la misma rama que `priceCartLines`). */
function precioDeTypeScript(d: Dorado): number | null {
  const producto = productoMapeado(d);
  return d.tipo === "estandar"
    ? (standardPriceAmounts(producto, TASA)?.usd ?? null)
    : productPriceUsd(producto, TASA);
}

describe("precio de venta: casos dorados (TypeScript)", () => {
  for (const d of DORADOS) {
    it(`[dorado:${d.tag}] ${d.descripcion} -> ${d.esperadoUsd}`, () => {
      expect(precioDeTypeScript(d)?.toFixed(2)).toBe(d.esperadoUsd);
    });
  }

  it("sin tasa, un producto en Bs no tiene precio y uno en USD sí (los null que SQL también da)", () => {
    const enBs = { currency: "VES", price: bsConRecargo(1000), shippingFeeUsd: null } as unknown as Product;
    const enUsd = { currency: "USD", price: usdConRecargo(5), shippingFeeUsd: null } as unknown as Product;
    expect(productPriceUsd(enBs, 0)).toBeNull();
    expect(productPriceUsd(enUsd, 0)).toBe(5.8);
    // Estándar sin tarifa: no hay precio.
    expect(standardPriceAmounts(enBs, TASA)).toBeNull();
  });
});

describe("precio de venta: los dorados están escritos también en el test SQL", () => {
  const sql = readFileSync(path.resolve(__dirname, "../../supabase/tests/ventas_saint.sql"), "utf8");

  for (const d of DORADOS) {
    it(`[dorado:${d.tag}] aparece con ${d.esperadoUsd} en supabase/tests/ventas_saint.sql`, () => {
      // La línea de la cabecera: `[dorado:A] VES 1000,00 promoción -> 29.00 ...`.
      const linea = sql.split("\n").find((l) => l.includes(`[dorado:${d.tag}]`) && l.includes("->"));
      expect(linea, `falta la línea del caso dorado ${d.tag} en el test SQL`).toBeDefined();
      expect(linea).toContain(d.esperadoUsd);
      // Y el assert real del test SQL usa el mismo valor numérico.
      const assert = sql.split("\n").find((l) => l.includes("esperar_num('[dorado:" + d.tag + "]"));
      expect(assert, `falta el assert del caso dorado ${d.tag}`).toBeDefined();
      expect(assert).toContain(`, ${d.esperadoUsd});`);
    });
  }
});

describe("precio de venta: guardián del recargo en la migración", () => {
  const migracion = readFileSync(
    path.resolve(__dirname, "../../supabase/migrations/20261113010000_ventas_saint.sql"),
    "utf8"
  );

  it("el factor de recargo de la migración es igual a RECARGO_PRECIO", () => {
    // La constante vive en UN solo sitio de la migración: `v_recargo constant numeric := 0.16;`.
    const coincidencias = [...migracion.matchAll(/v_recargo\s+constant\s+numeric\s*:=\s*([0-9]+(?:\.[0-9]+)?)\s*;/gi)];
    expect(coincidencias.length, "la migración debe declarar v_recargo una vez").toBe(1);
    expect(Number(coincidencias[0][1])).toBe(RECARGO_PRECIO);
  });

  it("no hay otro 1.16 ni 0.16 suelto en el cuerpo de las funciones (todo pasa por v_recargo)", () => {
    // Quita los comentarios de línea antes de buscar números mágicos.
    const sinComentarios = migracion
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    const sueltos = sinComentarios.match(/(?<![0-9.])(?:1\.16|0\.16)(?![0-9])/g) ?? [];
    // La única aparición es la declaración de la constante.
    expect(sueltos).toEqual(["0.16"]);
  });
});
