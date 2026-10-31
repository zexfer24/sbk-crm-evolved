import { describe, expect, it, vi } from "vitest";
import {
  PRODUCT_PHOTO_INPUT_MAX_BYTES,
  PRODUCT_PHOTO_INPUT_TYPES,
  PRODUCT_PHOTO_MAX_BYTES,
  PRODUCT_PHOTO_MAX_SIDE,
  fitInside,
  jpegQualityLadder,
  renderProductPhotoJpeg,
  type ProductPhotoImageDeps,
} from "@/lib/product-photo-image";

/**
 * T3, plan «Cada repuesto con su foto» (30/10/2026). Los límites se fijan con
 * su literal (trampa del 20/9/2026): un tope probado contra su propio símbolo
 * importado no prueba el número. Las dependencias de canvas van falsas, como en
 * `sticker-canvas.test.ts`: jsdom no implementa un `<canvas>` real.
 */

function fakeFile(type: string, size = 1000): Blob {
  return { type, size } as unknown as Blob;
}

/** Un lienzo falso: registra el orden de las llamadas del contexto y las calidades pedidas a `toBlob`. */
function fakeDeps(sizes: number[], image = { width: 4000, height: 3000 }) {
  const calls: string[] = [];
  const qualities: number[] = [];
  const types: string[] = [];
  const close = vi.fn();
  let canvasSize: { width: number; height: number } | null = null;
  let index = 0;
  const ctx = {
    set fillStyle(value: string) {
      calls.push(`fillStyle=${value}`);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push(`fillRect(${x},${y},${w},${h})`);
    },
    drawImage(_image: unknown, x: number, y: number, w: number, h: number) {
      calls.push(`drawImage(${x},${y},${w},${h})`);
    },
  };
  const deps: ProductPhotoImageDeps = {
    loadImage: async () => ({ ...image, close }),
    createCanvas: (width, height) => {
      canvasSize = { width, height };
      return {
        getContext: () => ctx,
        toBlob: (callback, type, quality) => {
          types.push(type);
          qualities.push(quality);
          const size = sizes[Math.min(index, sizes.length - 1)];
          index += 1;
          callback({ size, type } as unknown as Blob);
        },
      };
    },
  };
  return { deps, calls, qualities, types, close, canvasSize: () => canvasSize };
}

describe("límites", () => {
  it("fijan los números del plan", () => {
    expect(PRODUCT_PHOTO_MAX_SIDE).toBe(1600);
    expect(PRODUCT_PHOTO_MAX_BYTES).toBe(1_000_000);
    expect(PRODUCT_PHOTO_INPUT_MAX_BYTES).toBe(15 * 1024 * 1024);
    expect([...PRODUCT_PHOTO_INPUT_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});

describe("fitInside", () => {
  it("reduce una foto apaisada al lado máximo", () => {
    expect(fitInside(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it("no agranda lo que ya cabe", () => {
    expect(fitInside(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it("reduce una foto vertical por el lado largo y redondea", () => {
    expect(fitInside(1000, 3000, 1600)).toEqual({ width: 533, height: 1600 });
  });
});

describe("jpegQualityLadder", () => {
  it("es la escalera literal del plan", () => {
    expect(jpegQualityLadder()).toEqual([0.9, 0.82, 0.74, 0.66, 0.58, 0.5]);
  });
});

describe("renderProductPhotoJpeg", () => {
  it("rechaza un formato fuera de la lista con el mensaje exacto", async () => {
    await expect(renderProductPhotoJpeg(fakeFile("image/gif"))).rejects.toThrow(
      "Formato no admitido: usa JPG, PNG o WebP."
    );
  });

  it("rechaza una entrada de más de 15 MB", async () => {
    await expect(renderProductPhotoJpeg(fakeFile("image/jpeg", 16 * 1024 * 1024))).rejects.toThrow(
      "La imagen pesa más de 15 MB."
    );
  });

  it("acepta una entrada de exactamente 15 MB", async () => {
    const { deps } = fakeDeps([500_000]);
    const result = await renderProductPhotoJpeg(fakeFile("image/png", 15 * 1024 * 1024), deps);
    expect(result).not.toBeNull();
  });

  it("dibuja en un lienzo del tamaño reducido y devuelve ese tamaño", async () => {
    const f = fakeDeps([500_000]);
    const result = await renderProductPhotoJpeg(fakeFile("image/jpeg"), f.deps);
    expect(f.canvasSize()).toEqual({ width: 1600, height: 1200 });
    expect(result?.width).toBe(1600);
    expect(result?.height).toBe(1200);
    expect(f.types).toEqual(["image/jpeg"]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("pinta el fondo blanco ANTES de dibujar la imagen", async () => {
    const f = fakeDeps([500_000]);
    await renderProductPhotoJpeg(fakeFile("image/png"), f.deps);
    expect(f.calls).toEqual(["fillStyle=#fff", "fillRect(0,0,1600,1200)", "drawImage(0,0,1600,1200)"]);
  });

  it("usa la primera calidad que entra en 1.000.000 bytes, probando en orden", async () => {
    const f = fakeDeps([1_400_000, 1_200_000, 999_999]);
    const result = await renderProductPhotoJpeg(fakeFile("image/jpeg"), f.deps);
    expect(f.qualities).toEqual([0.9, 0.82, 0.74]);
    expect(result?.blob.size).toBe(999_999);
  });

  it("acepta un blob de exactamente 1.000.000 bytes", async () => {
    const f = fakeDeps([1_000_000]);
    const result = await renderProductPhotoJpeg(fakeFile("image/jpeg"), f.deps);
    expect(result?.blob.size).toBe(1_000_000);
    expect(f.qualities).toEqual([0.9]);
  });

  it("devuelve null si ninguna calidad de la escalera entra", async () => {
    const f = fakeDeps([2_000_000]);
    const result = await renderProductPhotoJpeg(fakeFile("image/jpeg"), f.deps);
    expect(result).toBeNull();
    expect(f.qualities).toEqual([0.9, 0.82, 0.74, 0.66, 0.58, 0.5]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
