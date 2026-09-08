import { describe, expect, it, vi } from "vitest";
import { renderStickerWebp, type StickerCanvasDeps } from "@/lib/sticker-canvas";
import { qualityLadder, STICKER_STATIC_MAX_BYTES } from "@/lib/sticker-image";

/**
 * `sticker-canvas.ts` toca canvas/`createImageBitmap`, que jsdom no
 * implementa de verdad — las dependencias van inyectadas para probar la
 * lógica (encajar, recorrer la escalera, exportar) con fakes, sin levantar
 * un navegador.
 */

function blobOfSize(bytes: number): Blob {
  return { size: bytes } as unknown as Blob;
}

function buildDeps(over: Partial<StickerCanvasDeps> = {}): StickerCanvasDeps {
  const drawImage = vi.fn();
  const clearRect = vi.fn();
  return {
    decodeImage: vi.fn().mockResolvedValue({ width: 1000, height: 500 }),
    createCanvas: vi.fn(() => ({
      getContext: () => ({ clearRect, drawImage }),
      // Por defecto entra a la primera calidad probada (la más alta): un
      // archivo chico no necesita ninguna vuelta de la escalera.
      toBlob: (callback: (blob: Blob | null) => void) => callback(blobOfSize(1000)),
    })),
    ...over,
  };
}

describe("renderStickerWebp", () => {
  it("encaja la imagen con fitInSquare antes de dibujarla", async () => {
    const drawImage = vi.fn();
    const deps = buildDeps({
      createCanvas: vi.fn(() => ({
        getContext: () => ({ clearRect: vi.fn(), drawImage }),
        toBlob: (callback: (blob: Blob | null) => void) => callback(blobOfSize(500)),
      })),
    });

    await renderStickerWebp(blobOfSize(2000), deps);

    // 1000×500 encaja en 512×512 con "contain": ancho 512, alto 256, centrado
    // verticalmente (y = 128).
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 128, 512, 256);
  });

  it("recorre la escalera de calidad hasta que el archivo entra en el límite", async () => {
    const pesos = [200_000, 150_000, 120_000, 90_000, 80_000, 70_000, 60_000];
    let intento = 0;
    const toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(blobOfSize(pesos[intento] ?? pesos[pesos.length - 1]));
      intento += 1;
    });
    const deps = buildDeps({
      createCanvas: vi.fn(() => ({ getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }), toBlob })),
    });

    const result = await renderStickerWebp(blobOfSize(2000), deps);

    expect(result).not.toBeNull();
    expect(result!.blob.size).toBeLessThanOrEqual(STICKER_STATIC_MAX_BYTES);
    // Tuvo que probar más de una calidad: los tres primeros pesos exceden el límite.
    expect(toBlob.mock.calls.length).toBeGreaterThan(1);
  });

  it("devuelve null si ni la calidad más baja entra en el límite", async () => {
    const toBlob = vi.fn((callback: (blob: Blob | null) => void) => callback(blobOfSize(200_000)));
    const deps = buildDeps({
      createCanvas: vi.fn(() => ({ getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }), toBlob })),
    });

    const result = await renderStickerWebp(blobOfSize(2000), deps);

    expect(result).toBeNull();
    // Probó las siete calidades de la escalera, no se rindió antes de tiempo.
    expect(toBlob).toHaveBeenCalledTimes(qualityLadder().length);
  });

  it("libera la imagen decodificada al terminar, si el decodificador lo pide", async () => {
    const close = vi.fn();
    const deps = buildDeps({ decodeImage: vi.fn().mockResolvedValue({ width: 800, height: 800, close }) });

    await renderStickerWebp(blobOfSize(2000), deps);

    expect(close).toHaveBeenCalled();
  });

  it("sin contexto 2d disponible, no rompe: devuelve null", async () => {
    const deps = buildDeps({
      createCanvas: vi.fn(() => ({ getContext: () => null, toBlob: vi.fn() })),
    });

    const result = await renderStickerWebp(blobOfSize(2000), deps);

    expect(result).toBeNull();
  });
});
