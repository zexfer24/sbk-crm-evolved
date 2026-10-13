import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * `read/route.ts` es el doble check azul hacia Meta (T3.1, 4/9/2026): con
 * sesión, resuelve el canal y el wamid del último mensaje entrante, y llama a
 * `markWhatsappRead` solo si el canal está `connected`. Nunca debe romper la
 * bandeja: un canal simulado o sin token es un no-op con 200 igual.
 */

interface FakeAgent {
  id: string;
  displayName: string;
  fullName: string;
  avatarUrl: string | null;
  role: string;
  isActive: boolean;
}

let currentAgent: FakeAgent | null;
let channelRow: { phone_number_id: string | null; status: string };
// Hotfix 2 (9/10/2026): la ruta pide también el teléfono del contacto; con
// 360dialog `markWhatsappRead` lo necesita para saber de qué fila es el número.
let contactRow: { phone_number: string | null } | null;
let lastInboundWamid: string | null;

vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: vi.fn(async () => currentAgent),
}));

function createFakeSessionClient() {
  return {
    from(table: string) {
      if (table === "conversations") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: { channel: channelRow, contact: contactRow }, error: null }),
                };
              },
            };
          },
        };
      }
      if (table === "messages") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      order() {
                        return {
                          limit() {
                            return {
                              maybeSingle: async () => ({
                                data: lastInboundWamid ? { whatsapp_message_id: lastInboundWamid } : null,
                                error: null,
                              }),
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Tabla inesperada en el test: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => createFakeSessionClient()),
}));

const markWhatsappReadMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/whatsapp/meta-client", () => ({
  markWhatsappRead: (...args: unknown[]) => markWhatsappReadMock(...args),
}));

import { POST } from "./route";

function fakeRequest(): Request {
  return new Request("http://crm.example/api/conversations/conv-1/read", { method: "POST" });
}

function ctx(id = "conv-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  currentAgent = {
    id: "agent-1",
    displayName: "María",
    fullName: "María Pérez",
    avatarUrl: null,
    role: "agent",
    isActive: true,
  };
  channelRow = { phone_number_id: "1234567890", status: "connected" };
  contactRow = { phone_number: "+58 412-123-4567" };
  lastInboundWamid = "wamid.ENTRANTE";
  markWhatsappReadMock.mockClear();
  process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.D360_API_KEY;
  delete process.env.D360_BASE_URL;
});

afterEach(() => {
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.D360_API_KEY;
  delete process.env.D360_BASE_URL;
});

describe("POST /api/conversations/[id]/read", () => {
  it("sin sesión responde 401 y no llama a Meta", async () => {
    currentAgent = null;

    const res = await POST(fakeRequest(), ctx());

    expect(res.status).toBe(401);
    expect(markWhatsappReadMock).not.toHaveBeenCalled();
  });

  it("con canal simulado no llama a Meta, pero responde 200", async () => {
    channelRow = { phone_number_id: null, status: "demo" };

    const res = await POST(fakeRequest(), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(markWhatsappReadMock).not.toHaveBeenCalled();
  });

  it("sin WHATSAPP_ACCESS_TOKEN no llama a Meta, pero responde 200", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    const res = await POST(fakeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(markWhatsappReadMock).not.toHaveBeenCalled();
  });

  it("sin ningún mensaje entrante (wamid) no llama a Meta", async () => {
    lastInboundWamid = null;

    const res = await POST(fakeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(markWhatsappReadMock).not.toHaveBeenCalled();
  });

  it("con canal conectado, llama a Meta con el phone_number_id, el token y el wamid entrante", async () => {
    const res = await POST(fakeRequest(), ctx("conv-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(markWhatsappReadMock).toHaveBeenCalledWith(
      "1234567890",
      { provider: "meta", accessToken: "token-de-prueba", graphVersion: "v21.0" },
      "wamid.ENTRANTE",
      "+58 412-123-4567"
    );
  });

  it("con 360dialog y su llave (sin WHATSAPP_ACCESS_TOKEN) llama con credenciales 360", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_PROVIDER = "360dialog";
    process.env.D360_API_KEY = "llave-360";

    const res = await POST(fakeRequest(), ctx("conv-1"));

    expect(res.status).toBe(200);
    expect(markWhatsappReadMock).toHaveBeenCalledWith(
      "1234567890",
      { provider: "360dialog", apiKey: "llave-360", baseUrl: "https://waba-v2.360dialog.io" },
      "wamid.ENTRANTE",
      "+58 412-123-4567"
    );
  });

  it("si el contacto no trae teléfono, pasa null como cuarto argumento", async () => {
    contactRow = null;

    const res = await POST(fakeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(markWhatsappReadMock).toHaveBeenCalledWith(
      "1234567890",
      { provider: "meta", accessToken: "token-de-prueba", graphVersion: "v21.0" },
      "wamid.ENTRANTE",
      null
    );
  });

  it("con 360dialog sin D360_API_KEY no llama, pero responde 200", async () => {
    process.env.WHATSAPP_PROVIDER = "360dialog";

    const res = await POST(fakeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(markWhatsappReadMock).not.toHaveBeenCalled();
  });
});
