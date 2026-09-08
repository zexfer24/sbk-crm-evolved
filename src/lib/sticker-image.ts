// ---------------------------------------------------------------------------
// Geometría y límites de los stickers de WhatsApp (T3a, "Seis frentes del
// buzón", 9/9/2026).
//
// Módulo PURO a propósito, igual que identity-guard.ts y history-line.ts:
// sin DOM, sin imports, sin `server-only`. Quien arma el archivo final (T3b,
// con un <canvas> en el compositor) necesita saber cómo encajar la imagen
// del cliente en el cuadrado de 512×512 sin deformarla ni recortarla, y
// hasta dónde bajar la calidad si el archivo no entra en el límite de peso
// de Meta — esta lógica no toca el DOM, así que vive aparte y se prueba sin
// levantar un navegador.
//
// Requisitos de Meta para un sticker por Cloud API (payload
// `{type:"sticker", sticker:{link}}`, sin `caption` — lo rechaza si lo
// lleva): WebP, 512×512 px, estático ≤100 KB, animado ≤500 KB.
// ---------------------------------------------------------------------------

/** El lado del cuadrado que exige Meta para un sticker. */
export const STICKER_SIDE = 512;

/** Peso máximo de un sticker estático (WebP sin animación). */
export const STICKER_STATIC_MAX_BYTES = 100 * 1024;

/** Peso máximo de un sticker animado (WebP con animación). */
export const STICKER_ANIMATED_MAX_BYTES = 500 * 1024;

export interface StickerFit {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Encaja un rectángulo de `width`×`height` dentro de un cuadrado de `side`
 * con "contain" (nunca recorta, nunca deforma) y centrado en los dos ejes.
 *
 * Una imagen ya más chica que el lado NO se agranda: WhatsApp acepta un
 * sticker menor a 512 px, y agrandarla solo la vuelve borrosa sin ganar
 * nada — por eso el factor de escala nunca pasa de 1.
 */
export function fitInSquare(width: number, height: number, side: number = STICKER_SIDE): StickerFit {
  const scale = Math.min(side / width, side / height, 1);
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  return {
    x: (side - fittedWidth) / 2,
    y: (side - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  };
}

/**
 * Pasos de calidad para reintentar la codificación WebP hasta que el
 * archivo entre en el límite de peso: de 0.92 a 0.5, bajando de a ~0.07.
 * T3b decide cuántos probar antes de rendirse y avisarle al asesor que la
 * imagen no entra.
 */
export function qualityLadder(): number[] {
  const steps: number[] = [];
  for (let q = 0.92; q >= 0.5 - 1e-9; q -= 0.07) {
    steps.push(Math.round(q * 100) / 100);
  }
  return steps;
}

/** true si `bytes` entra en el límite de Meta para un sticker (estático o animado). */
export function isWithinStickerLimit(bytes: number, animated = false): boolean {
  return bytes <= (animated ? STICKER_ANIMATED_MAX_BYTES : STICKER_STATIC_MAX_BYTES);
}
