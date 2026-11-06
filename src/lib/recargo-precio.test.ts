import { describe, expect, it } from "vitest";
import { RECARGO_PRECIO, bsConRecargo, usdConRecargo } from "@/lib/recargo-precio";

// Los números van escritos con literales a propósito (6/11/2026): un test que
// compara contra el símbolo importado no fija el 16 % -- si alguien cambia la
// constante, el test cambiaría con ella y nada se pondría en rojo.

describe("RECARGO_PRECIO", () => {
  it("vale 0,16", () => {
    expect(RECARGO_PRECIO).toBe(0.16);
  });
});

describe("bsConRecargo (bolívares x 1,16, al céntimo)", () => {
  it("100 Bs -> 116 Bs", () => {
    expect(bsConRecargo(100)).toBe(116);
  });

  it("redondea al céntimo más cercano", () => {
    // 12,35 x 1,16 = 14,326 -> 14,33
    expect(bsConRecargo(12.35)).toBe(14.33);
    // 87 x 1,16 = 100,92 exacto
    expect(bsConRecargo(87)).toBe(100.92);
    // 0,05 x 1,16 = 0,058 -> 0,06
    expect(bsConRecargo(0.05)).toBe(0.06);
  });

  it("no se deja engañar por el ruido de coma flotante", () => {
    // 1,005 x 1,16 = 1,1658 -> 1,17; 2,5 x 1,16 = 2,9 exacto
    expect(bsConRecargo(1.005)).toBe(1.17);
    expect(bsConRecargo(2.5)).toBe(2.9);
    expect(bsConRecargo(0.25)).toBe(0.29);
  });

  it("0 se queda en 0", () => {
    expect(bsConRecargo(0)).toBe(0);
  });

  it("un valor no finito se devuelve tal cual (no se inventa un precio)", () => {
    expect(bsConRecargo(Number.NaN)).toBeNaN();
    expect(bsConRecargo(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("usdConRecargo (dólares x 1,16, hacia arriba al siguiente $0,10)", () => {
  it("10,00 -> 11,60", () => {
    expect(usdConRecargo(10)).toBe(11.6);
  });

  it("9,95 -> 11,60 (11,542 sube al siguiente múltiplo de 0,10)", () => {
    expect(usdConRecargo(9.95)).toBe(11.6);
  });

  it("5,00 -> 5,80 exacto: un múltiplo exacto no sube", () => {
    expect(usdConRecargo(5)).toBe(5.8);
  });

  it("una diferencia real sí sube (12,35 x 1,16 = 14,326 -> 14,40)", () => {
    expect(usdConRecargo(12.35)).toBe(14.4);
    expect(usdConRecargo(7)).toBe(8.2);
  });

  it("no sube por ruido de coma flotante (25 x 1,16 = 29 exacto)", () => {
    expect(usdConRecargo(25)).toBe(29);
    expect(usdConRecargo(2.5)).toBe(2.9);
  });

  it("0, negativos y no finitos se devuelven tal cual (la UI lee <= 0 como «Sin precio en SAINT»)", () => {
    expect(usdConRecargo(0)).toBe(0);
    expect(usdConRecargo(-3)).toBe(-3);
    expect(usdConRecargo(Number.NaN)).toBeNaN();
    expect(usdConRecargo(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});
