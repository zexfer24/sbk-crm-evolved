import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Guarda de servidor sobre un sticker saliente (T3, 8/9/2026): mide el
 * archivo real del bucket contra el límite de Meta antes de dejar pasar el
 * envío. Estos tests mockean solo el cliente admin de Storage — todo lo
 * demás (`storagePathFromUrl`, `isAnimatedWebp`, límites) es código real de
 * `storage.ts` y `sticker-image.ts`.
 */

// Arma un WebP mínimo con un peso total exacto: header real (para que
// `isAnimatedWebp` lo lea bien) + relleno hasta `totalBytes`.
function armarWebpDePeso(
  chunkFourCC: "VP8X" | "VP8 " | "VP8L",
  vp8xFlags: number,
  totalBytes: number
): Uint8Array {
  const bytes: number[] = [];
  const pushFourCC = (s: string) => {
    for (const ch of s) bytes.push(ch.charCodeAt(0));
  };
  pushFourCC("RIFF");
  bytes.push(0, 0, 0, 0);
  pushFourCC("WEBP");
  pushFourCC(chunkFourCC);
  bytes.push(0, 0, 0, 0);
  if (chunkFourCC === "VP8X") {
    bytes.push(vp8xFlags);
  }
  while (bytes.length < totalBytes) bytes.push(0);
  return new Uint8Array(bytes.slice(0, Math.max(totalBytes, bytes.length)));
}

type DownloadResult = { data: { arrayBuffer: () => Promise<ArrayBuffer> } | null; error: unknown };
let downloadResult: DownloadResult;
let downloadMock: ReturnType<typeof vi.fn<(path: string) => Promise<DownloadResult>>>;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        download: (path: string) => downloadMock(path),
      }),
    },
  }),
}));

import { checkStickerBeforeSend } from "./sticker-guard";

function blobFromBytes(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { arrayBuffer: async () => buffer };
}

beforeEach(() => {
  downloadMock = vi.fn(async () => downloadResult);
});

describe("checkStickerBeforeSend — mide el archivo real, no la columna `animated`", () => {
  it("un estático que entra en el límite (100 KB) pasa", async () => {
    const bytes = armarWebpDePeso("VP8 ", 0, 50 * 1024);
    downloadResult = { data: blobFromBytes(bytes), error: null };

    const result = await checkStickerBeforeSend("/api/media/stickers/ok.webp");

    expect(result).toEqual({ ok: true });
    expect(downloadMock).toHaveBeenCalledWith("stickers/ok.webp");
  });

  it("un estático que se pasa del límite de 100 KB se rechaza con explicación", async () => {
    const bytes = armarWebpDePeso("VP8 ", 0, 150 * 1024);
    downloadResult = { data: blobFromBytes(bytes), error: null };

    const result = await checkStickerBeforeSend("/api/media/stickers/pesado.webp");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("estático");
    expect(result.reason).toContain("100");
  });

  /**
   * El caso real de producción: un WebP animado (VP8X con el bit ANIM
   * encendido) marcado `animated = false` en la biblioteca. La guarda no
   * mira esa columna — la lee de los bytes.
   */
  it("un animado de 973.668 bytes (el caso real del 8/9/2026) se rechaza aunque la fila diga `animated: false`", async () => {
    const bytes = armarWebpDePeso("VP8X", 0x02, 973668);
    downloadResult = { data: blobFromBytes(bytes), error: null };

    const result = await checkStickerBeforeSend("/api/media/stickers/roto.webp");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("animado");
    expect(result.reason).toContain("500");
  });

  it("un animado que entra en su límite propio (500 KB) pasa aunque supere el límite estático", async () => {
    const bytes = armarWebpDePeso("VP8X", 0x02, 200 * 1024);
    downloadResult = { data: blobFromBytes(bytes), error: null };

    const result = await checkStickerBeforeSend("/api/media/stickers/animado-ok.webp");

    expect(result).toEqual({ ok: true });
  });

  it("una URL que no resuelve a un path del bucket deja pasar sin descargar nada", async () => {
    const result = await checkStickerBeforeSend("https://otro-lado.example/no-es-nuestro.webp");

    expect(result).toEqual({ ok: true });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("si Storage devuelve error, deja pasar (no bloquea todos los envíos por un hipo de lectura)", async () => {
    downloadResult = { data: null, error: { message: "bucket caído" } };

    const result = await checkStickerBeforeSend("/api/media/stickers/inaccesible.webp");

    expect(result).toEqual({ ok: true });
  });

  it("si la descarga tira una excepción, deja pasar en vez de romper el envío", async () => {
    downloadMock = vi.fn(async () => {
      throw new Error("red caída");
    });

    const result = await checkStickerBeforeSend("/api/media/stickers/excepcion.webp");

    expect(result).toEqual({ ok: true });
  });
});
