import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `signedUrlForSending`: la URL que se le manda a Meta para que descargue un
 * adjunto saliente del bucket privado `whatsapp-media`. T7, plan "Nada se
 * pierde en un corte ni en un deploy" (22/9/2026): antes un fallo de Storage
 * acá se perdía en un `console.error` sin conversación ni evento — pasa a
 * `lib/log.ts` con los ids que traiga el llamador.
 */

type SignedUrlResult = { data: { signedUrl: string } | null; error: { message: string } | null };

let signedUrlResult: SignedUrlResult;
/** `[bucket]` de cada llamada a `storage.from(...)`. */
const storageFromCalls: string[] = [];
/** `[objectPath, ttlSeconds]` de cada llamada a `createSignedUrl(...)`. */
const createSignedUrlCalls: Array<[string, number]> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from(bucket: string) {
        storageFromCalls.push(bucket);
        return {
          createSignedUrl: async (objectPath: string, ttlSeconds: number) => {
            createSignedUrlCalls.push([objectPath, ttlSeconds]);
            return signedUrlResult;
          },
        };
      },
    },
  }),
}));

/** Eventos registrados por cada llamada a `log.error` en el test. */
const logCalls: Array<{ level: "warn" | "error"; event: string; context?: Record<string, unknown> }> = [];

vi.mock("@/lib/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log")>();
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: (event: string, context?: Record<string, unknown>) => {
        logCalls.push({ level: "warn", event, context });
      },
      error: (event: string, context?: Record<string, unknown>) => {
        logCalls.push({ level: "error", event, context });
      },
    },
  };
});

import { signedUrlForSending } from "./media-link";

beforeEach(() => {
  signedUrlResult = {
    data: { signedUrl: "https://supabase.example/storage/v1/object/sign/whatsapp-media/conv-1/wamid.abc.jpg?token=firmado" },
    error: null,
  };
  storageFromCalls.length = 0;
  createSignedUrlCalls.length = 0;
  logCalls.length = 0;
});

describe("signedUrlForSending", () => {
  it("camino feliz: firma el path del bucket propio con TTL 600", async () => {
    const link = await signedUrlForSending("/api/media/conv-1/wamid.abc.jpg");

    expect(link).toBe(signedUrlResult.data!.signedUrl);
    expect(storageFromCalls).toContain("whatsapp-media");
    expect(createSignedUrlCalls).toContainEqual(["conv-1/wamid.abc.jpg", 600]);
  });

  it("con una URL http ajena al bucket la devuelve tal cual, sin firmar nada", async () => {
    const ajena = "https://otro-lado.example/no-es-nuestro.jpg";

    const link = await signedUrlForSending(ajena);

    expect(link).toBe(ajena);
    expect(createSignedUrlCalls).toHaveLength(0);
  });

  it("con una ruta que no resuelve a un path del bucket ni es http, devuelve null sin firmar", async () => {
    const link = await signedUrlForSending("ruta-rara-sin-esquema");

    expect(link).toBeNull();
    expect(createSignedUrlCalls).toHaveLength(0);
  });

  it("si Storage falla al firmar, devuelve null y registra send.enlace_no_firmado con los ids del llamador", async () => {
    signedUrlResult = { data: null, error: { message: "bucket caído" } };

    const link = await signedUrlForSending("/api/media/conv-1/wamid.abc.jpg", {
      messageId: "msg-1",
      conversationId: "conv-1",
    });

    expect(link).toBeNull();
    expect(logCalls).toContainEqual({
      level: "error",
      event: "send.enlace_no_firmado",
      context: { detail: "bucket caído", messageId: "msg-1", conversationId: "conv-1" },
    });
  });

  it("un fallo de Storage sin contexto registra el evento con ids undefined, sin lanzar", async () => {
    signedUrlResult = { data: null, error: { message: "bucket caído" } };

    const link = await signedUrlForSending("/api/media/conv-1/wamid.abc.jpg");

    expect(link).toBeNull();
    expect(logCalls).toContainEqual({
      level: "error",
      event: "send.enlace_no_firmado",
      context: { detail: "bucket caído", messageId: undefined, conversationId: undefined },
    });
  });
});
