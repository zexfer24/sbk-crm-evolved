// ---------------------------------------------------------------------------
// Geometría y límites de los stickers de WhatsApp (T3a, "Seis frentes del
// buzón", 8/9/2026).
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

/** Peso máximo que aplica según si el sticker es animado o estático. */
export function stickerLimitFor(animated: boolean): number {
  return animated ? STICKER_ANIMATED_MAX_BYTES : STICKER_STATIC_MAX_BYTES;
}

function toBytesView(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
}

function leeFourCC(view: Uint8Array, offset: number): string {
  return String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);
}

/**
 * Detecta si un WebP es animado LEYENDO LOS BYTES, no la extensión ni el
 * MIME que mandó el cliente por WhatsApp — el 8/9/2026 un sticker entrante
 * de 973.668 bytes, animado, se guardó tal cual en la biblioteca y Meta lo
 * rechazó al reenviarlo con el error 131053 ("Sticker file has size 973668
 * bytes but must be atmost 512000 bytes"). Los límites de Meta son de
 * SALIDA: todo lo que un cliente nos manda es, por definición, más pesado
 * de lo que la Cloud API deja reenviar, así que hay que medirlo, no confiar
 * en cómo llegó.
 *
 * Estructura de un WebP: `RIFF`(4) + tamaño(4) + `WEBP`(4) y ahí arranca el
 * primer chunk (FourCC en el byte 12). Si ese chunk es `VP8X` (el
 * contenedor "extendido" que usa WebP para animación, ICC, EXIF, etc.), su
 * primer byte de payload —offset 20 del archivo— es el byte de flags, y el
 * bit `0x02` es el flag ANIM. Sin `VP8X` (chunk `VP8 ` o `VP8L` directo) el
 * archivo es un solo cuadro: estático por construcción.
 *
 * Nunca tira: un buffer corto, vacío o que no arranque con `RIFF`/`WEBP`
 * devuelve `false` — el llamador (T2, al guardar en la biblioteca) ya tiene
 * su propio manejo de errores, y una detección que explota convertiría un
 * sticker raro en un 500 en vez de en un simple "no se puede enviar".
 */
export function isAnimatedWebp(bytes: Uint8Array | ArrayBuffer): boolean {
  try {
    const view = toBytesView(bytes);
    if (view.length < 21) return false;
    if (leeFourCC(view, 0) !== "RIFF") return false;
    if (leeFourCC(view, 8) !== "WEBP") return false;
    if (leeFourCC(view, 12) !== "VP8X") return false;
    const flags = view[20];
    return (flags & 0x02) !== 0;
  } catch {
    return false;
  }
}

/**
 * Texto para el asesor cuando un sticker no entra por peso. No alcanza con
 * "es muy pesado": el asesor no tiene forma de adivinar que el problema es
 * que el sticker del cliente viene animado (un límite cinco veces más
 * chico que el de uno estático), así que el mensaje nombra las dos cosas —
 * animado o estático, y cuánto pesa contra cuánto entra, en KB— igual que
 * el caso real del 8/9/2026 (973.668 bytes animado contra el tope de 500 KB).
 */
export function stickerRejectionMessage(bytes: number, animated: boolean): string {
  const limite = stickerLimitFor(animated);
  const tipo = animated ? "animado" : "estático (sin movimiento)";
  const pesoKB = Math.round(bytes / 1024);
  const limiteKB = Math.round(limite / 1024);
  return (
    `Este sticker es ${tipo} y pesa ${pesoKB} KB, pero WhatsApp solo deja enviar ` +
    `stickers ${animated ? "animados" : "estáticos"} de hasta ${limiteKB} KB. ` +
    `Hay que achicarlo o usar uno más liviano antes de guardarlo en la biblioteca.`
  );
}
