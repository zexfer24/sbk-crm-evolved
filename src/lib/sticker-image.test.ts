import { describe, expect, it } from "vitest";
import {
  fitInSquare,
  isAnimatedWebp,
  isWithinStickerLimit,
  qualityLadder,
  STICKER_ANIMATED_MAX_BYTES,
  STICKER_SIDE,
  STICKER_STATIC_MAX_BYTES,
  stickerLimitFor,
  stickerRejectionMessage,
} from "@/lib/sticker-image";

// Arma un WebP mínimo a mano: RIFF + tamaño + WEBP + un chunk.
// `chunkFourCC` es "VP8X", "VP8 " o "VP8L"; `vp8xFlags` solo aplica cuando
// el chunk es VP8X (es el byte de flags en el offset 20 del archivo, donde
// el bit 0x02 es el flag ANIM que marca animación).
function armarWebp(chunkFourCC: "VP8X" | "VP8 " | "VP8L", vp8xFlags = 0): Uint8Array {
  const bytes: number[] = [];
  const pushFourCC = (s: string) => {
    for (const ch of s) bytes.push(ch.charCodeAt(0));
  };
  pushFourCC("RIFF");
  bytes.push(0, 0, 0, 0); // tamaño del archivo, no importa para la detección
  pushFourCC("WEBP");
  pushFourCC(chunkFourCC);
  bytes.push(0, 0, 0, 0); // tamaño del chunk
  if (chunkFourCC === "VP8X") {
    bytes.push(vp8xFlags); // byte 20: flags, bit 0x02 = ANIM
    while (bytes.length < 30) bytes.push(0); // resto del payload VP8X, relleno
  } else {
    // VP8 / VP8L: unos bytes cualquiera de payload, no se leen para detectar animación.
    bytes.push(0, 0, 0, 0, 0);
  }
  return new Uint8Array(bytes);
}

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

describe("stickerLimitFor — qué límite aplica según el tipo", () => {
  it("animado usa el tope de 500 KB, estático el de 100 KB", () => {
    expect(stickerLimitFor(true)).toBe(512000);
    expect(stickerLimitFor(false)).toBe(102400);
  });
});

describe("isAnimatedWebp — leer bytes, no confiar en la extensión ni el MIME", () => {
  it("VP8X con el bit ANIM (0x02) encendido es animado", () => {
    expect(isAnimatedWebp(armarWebp("VP8X", 0x02))).toBe(true);
  });

  it("VP8X con el bit ANIM apagado no es animado", () => {
    expect(isAnimatedWebp(armarWebp("VP8X", 0x00))).toBe(false);
  });

  it("VP8X con otros flags encendidos pero sin 0x02 no es animado", () => {
    // 0x20 = flag ICC, por ejemplo — no debe confundirse con ANIM.
    expect(isAnimatedWebp(armarWebp("VP8X", 0x20))).toBe(false);
  });

  it("VP8 directo (sin VP8X) es estático", () => {
    expect(isAnimatedWebp(armarWebp("VP8 "))).toBe(false);
  });

  it("VP8L directo (sin VP8X) es estático", () => {
    expect(isAnimatedWebp(armarWebp("VP8L"))).toBe(false);
  });

  it("acepta un ArrayBuffer además de un Uint8Array", () => {
    const view = armarWebp("VP8X", 0x02);
    const buffer = new Uint8Array(view).buffer as ArrayBuffer;
    expect(isAnimatedWebp(buffer)).toBe(true);
  });

  it("un buffer más corto que 21 bytes no es animado, y no tira", () => {
    expect(() => isAnimatedWebp(new Uint8Array(10))).not.toThrow();
    expect(isAnimatedWebp(new Uint8Array(10))).toBe(false);
  });

  it("un buffer vacío no es animado, y no tira", () => {
    expect(() => isAnimatedWebp(new Uint8Array(0))).not.toThrow();
    expect(isAnimatedWebp(new Uint8Array(0))).toBe(false);
  });

  it("un buffer que no empieza con RIFF/WEBP no es animado, y no tira", () => {
    const basura = new Uint8Array(30).fill(0x41); // puro "AAAA...", ni RIFF ni WEBP
    expect(() => isAnimatedWebp(basura)).not.toThrow();
    expect(isAnimatedWebp(basura)).toBe(false);
  });
});

describe("stickerRejectionMessage — el asesor tiene que entender por qué no entra", () => {
  it("nombra el peso real y el límite del caso real del 8/9/2026 (animado)", () => {
    // El sticker que Meta rechazó con el error 131053: 973.668 bytes, animado.
    const mensaje = stickerRejectionMessage(973668, true);
    expect(mensaje).toContain("animado");
    expect(mensaje).toContain("951"); // 973668 / 1024 redondeado
    expect(mensaje).toContain("500"); // límite animado en KB
  });

  it("nombra el peso real y el límite para un estático", () => {
    const mensaje = stickerRejectionMessage(150000, false);
    expect(mensaje).toContain("estático");
    expect(mensaje).toContain("146"); // 150000 / 1024 redondeado
    expect(mensaje).toContain("100"); // límite estático en KB
  });
});
