"use client";

import { fitInSquare, isWithinStickerLimit, qualityLadder, STICKER_SIDE } from "@/lib/sticker-image";

// ---------------------------------------------------------------------------
// Armado del WebP final del sticker (T3b, "Seis frentes del buzón",
// 8/9/2026). `sticker-image.ts` (T3a) trae la geometría y los límites como
// funciones puras; acá vive lo que sí toca el navegador: decodificar el
// archivo del asesor, dibujarlo centrado en un lienzo de 512×512 transparente
// y exportarlo bajando la calidad hasta que entre en el peso que exige Meta.
//
// Las dependencias de canvas van inyectadas (`StickerCanvasDeps`) con
// defaults al DOM real: jsdom no implementa un `<canvas>` de verdad, así que
// probar esto sin poder reemplazar `createImageBitmap`/el lienzo/`toBlob`
// obligaría a un navegador de mentira solo para este archivo.
// ---------------------------------------------------------------------------

/** Lo mínimo que necesita `drawImage`: un tamaño y algo dibujable. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Se libera después de dibujar, si el decodificador real lo pide (ImageBitmap.close). */
  close?: () => void;
}

/** El lienzo que recibe el dibujo: solo lo que este módulo necesita de un `<canvas>`. */
export interface StickerCanvas {
  getContext(id: "2d"): StickerCanvasContext2D | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

export interface StickerCanvasContext2D {
  clearRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: DecodedImage, dx: number, dy: number, dWidth: number, dHeight: number): void;
}

export interface StickerCanvasDeps {
  decodeImage: (file: Blob) => Promise<DecodedImage>;
  createCanvas: (side: number) => StickerCanvas;
}

function defaultCreateCanvas(side: number): StickerCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  return canvas as unknown as StickerCanvas;
}

const defaultDeps: StickerCanvasDeps = {
  decodeImage: (file) => createImageBitmap(file),
  createCanvas: defaultCreateCanvas,
};

function encodeWebp(canvas: StickerCanvas, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/webp", quality));
}

/**
 * Arma el WebP final: encaja `file` en el cuadrado de 512×512 (sin recortar
 * ni deformar, `fitInSquare`) y recorre `qualityLadder()` hasta encontrar una
 * calidad que entre en el límite de Meta (`isWithinStickerLimit`).
 *
 * `null` si ni a la calidad más baja de la escalera entra — el llamador
 * (`CreateStickerModal`) le avisa al asesor que la imagen es muy pesada, en
 * vez de subir un archivo que Meta va a rechazar igual.
 */
export async function renderStickerWebp(
  file: Blob,
  deps: StickerCanvasDeps = defaultDeps
): Promise<{ blob: Blob; quality: number } | null> {
  const image = await deps.decodeImage(file);
  try {
    const fit = fitInSquare(image.width, image.height);
    const canvas = deps.createCanvas(STICKER_SIDE);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Transparente y no blanco: un sticker con fondo blanco se ve como un
    // cuadrado sobre el chat en vez de flotar como cualquier otro sticker.
    ctx.clearRect(0, 0, STICKER_SIDE, STICKER_SIDE);
    ctx.drawImage(image, fit.x, fit.y, fit.width, fit.height);

    for (const quality of qualityLadder()) {
      const blob = await encodeWebp(canvas, quality);
      if (blob && isWithinStickerLimit(blob.size)) {
        return { blob, quality };
      }
    }
    return null;
  } finally {
    image.close?.();
  }
}
