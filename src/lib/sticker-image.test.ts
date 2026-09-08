import { describe, expect, it } from "vitest";
import {
  fitInSquare,
  isWithinStickerLimit,
  qualityLadder,
  STICKER_ANIMATED_MAX_BYTES,
  STICKER_SIDE,
  STICKER_STATIC_MAX_BYTES,
} from "@/lib/sticker-image";

describe("fitInSquare — encajar sin deformar ni recortar", () => {
  it("una imagen horizontal (ancha) queda con barras arriba y abajo", () => {
    const fit = fitInSquare(1000, 500);
    expect(fit.width).toBe(STICKER_SIDE);
    expect(fit.height).toBe(256);
    // Centrada en el eje vertical: la mitad del espacio sobrante a cada lado.
    expect(fit.y).toBe((STICKER_SIDE - 256) / 2);
    expect(fit.x).toBe(0);
  });

  it("una imagen vertical (alta) queda con barras a los lados", () => {
    const fit = fitInSquare(500, 1000);
    expect(fit.height).toBe(STICKER_SIDE);
    expect(fit.width).toBe(256);
    expect(fit.x).toBe((STICKER_SIDE - 256) / 2);
    expect(fit.y).toBe(0);
  });

  it("una imagen cuadrada llena el lado entero, sin barras", () => {
    const fit = fitInSquare(800, 800);
    expect(fit).toEqual({ x: 0, y: 0, width: STICKER_SIDE, height: STICKER_SIDE });
  });

  it("una imagen más chica que 512 no se agranda: se centra tal cual", () => {
    const fit = fitInSquare(200, 100);
    expect(fit.width).toBe(200);
    expect(fit.height).toBe(100);
    expect(fit.x).toBe((STICKER_SIDE - 200) / 2);
    expect(fit.y).toBe((STICKER_SIDE - 100) / 2);
  });
});

describe("qualityLadder — la escalera de calidad para reintentar la codificación", () => {
  it("es descendente y termina en 0.5", () => {
    const steps = qualityLadder();
    expect(steps[0]).toBe(0.92);
    expect(steps[steps.length - 1]).toBe(0.5);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeLessThan(steps[i - 1]);
    }
  });

  it("baja de a ~0.07 por paso", () => {
    const steps = qualityLadder();
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i - 1] - steps[i]).toBeCloseTo(0.07, 2);
    }
  });
});

describe("isWithinStickerLimit — el peso que acepta Meta", () => {
  it("estático: entra justo en el límite de 100 KB", () => {
    expect(isWithinStickerLimit(STICKER_STATIC_MAX_BYTES)).toBe(true);
    expect(isWithinStickerLimit(STICKER_STATIC_MAX_BYTES + 1)).toBe(false);
  });

  it("animado: entra justo en el límite de 500 KB, no en el estático", () => {
    expect(isWithinStickerLimit(STICKER_ANIMATED_MAX_BYTES, true)).toBe(true);
    expect(isWithinStickerLimit(STICKER_ANIMATED_MAX_BYTES + 1, true)).toBe(false);
    expect(isWithinStickerLimit(STICKER_STATIC_MAX_BYTES + 1, true)).toBe(true);
  });
});
