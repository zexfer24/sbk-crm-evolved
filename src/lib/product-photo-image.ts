"use client";

// ---------------------------------------------------------------------------
// Armado del JPEG de la foto de un repuesto (T3, plan «Cada repuesto con su
// foto», 30/10/2026). Meta solo acepta JPEG o PNG para imágenes; el celular del
// asesor entrega fotos de 4-12 MB (a veces WebP o HEIC convertido), así que
// toda foto se decodifica, se reduce y se guarda SIEMPRE como JPEG de a lo más
// 1 MB: la caja la ve rápido y Meta la descarga sin problema.
//
// Mismo patrón que `sticker-canvas.ts`: las dependencias de canvas van
// inyectadas con defaults al DOM real, porque jsdom no implementa un
// `<canvas>` de verdad.
// ---------------------------------------------------------------------------

/** Lado máximo de la foto guardada; lo que ya cabe no se agranda. */
export const PRODUCT_PHOTO_MAX_SIDE = 1600;
/** Peso máximo del JPEG final (1 MB decimal). */
export const PRODUCT_PHOTO_MAX_BYTES = 1_000_000;
/** Peso máximo del archivo que elige el asesor, antes de reducirlo. */
export const PRODUCT_PHOTO_INPUT_MAX_BYTES = 15 * 1024 * 1024;
export const PRODUCT_PHOTO_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Reduce `w`×`h` para que el lado largo no pase de `max`, sin agrandar, redondeando y manteniendo la proporción. */
export function fitInside(w: number, h: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** Calidades JPEG que se prueban, de la mejor a la peor, hasta que el archivo entre en el peso. */
export function jpegQualityLadder(): number[] {
  return [0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
}

export interface PhotoDecodedImage {
  width: number;
  height: number;
  /** Se libera después de dibujar, si el decodificador real lo pide (ImageBitmap.close). */
  close?: () => void;
}

export interface PhotoCanvasContext2D {
  fillStyle: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: PhotoDecodedImage, dx: number, dy: number, dWidth: number, dHeight: number): void;
}

export interface PhotoCanvas {
  getContext(id: "2d"): PhotoCanvasContext2D | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

export interface ProductPhotoImageDeps {
  loadImage: (file: Blob) => Promise<PhotoDecodedImage>;
  createCanvas: (width: number, height: number) => PhotoCanvas;
}

const defaultDeps: ProductPhotoImageDeps = {
  loadImage: (file) => createImageBitmap(file),
  createCanvas: (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as PhotoCanvas;
  },
};

function encodeJpeg(canvas: PhotoCanvas, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}

/**
 * Decodifica `file`, lo dibuja reducido a `PRODUCT_PHOTO_MAX_SIDE` y lo exporta
 * como JPEG, bajando la calidad por `jpegQualityLadder()` hasta que pese
 * `PRODUCT_PHOTO_MAX_BYTES` o menos.
 *
 * Lanza (mensaje listo para el toast) si el tipo o el peso de ENTRADA no se
 * admiten. `null` si ni a la calidad más baja entra: el llamador avisa en vez
 * de subir un archivo que no cumple.
 */
export async function renderProductPhotoJpeg(
  file: Blob,
  deps: Partial<ProductPhotoImageDeps> = {}
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const { loadImage, createCanvas } = { ...defaultDeps, ...deps };

  if (!(PRODUCT_PHOTO_INPUT_TYPES as readonly string[]).includes(file.type)) {
    throw new Error("Formato no admitido: usa JPG, PNG o WebP.");
  }
  if (file.size > PRODUCT_PHOTO_INPUT_MAX_BYTES) {
    throw new Error("La imagen pesa más de 15 MB.");
  }

  const image = await loadImage(file);
  try {
    const { width, height } = fitInside(image.width, image.height, PRODUCT_PHOTO_MAX_SIDE);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Blanco primero: JPEG no tiene transparencia y un PNG/WebP con fondo
    // transparente saldría con el fondo NEGRO por defecto del lienzo.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    for (const quality of jpegQualityLadder()) {
      const blob = await encodeJpeg(canvas, quality);
      if (blob && blob.size <= PRODUCT_PHOTO_MAX_BYTES) {
        return { blob, width, height };
      }
    }
    return null;
  } finally {
    image.close?.();
  }
}
