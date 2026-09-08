import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MetaApiError } from "@/lib/whatsapp/meta-client";

/**
 * El envío guarda primero y habla con Meta después de responder: el asesor
 * no debe esperar la Graph API (4 s de media, 14 de pico medidos) para ver
 * su mensaje en el hilo. Estos tests fijan ese reparto: qué se responde,
 * con qué estado nace la fila, y cómo termina según lo que diga Meta.
 */

// `after()` de Next.js exige contexto de request real; en el test lo
// ejecutamos inline para poder esperar sus efectos.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      void cb();
    },
  };
});

const sendWhatsappTextMock = vi.fn();
const sendWhatsappTemplateMock = vi.fn();
const sendWhatsappMediaMock = vi.fn();

vi.mock("@/lib/whatsapp/meta-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/meta-client")>();
  return {
    ...actual,
    sendWhatsappText: (...args: unknown[]) => sendWhatsappTextMock(...args),
    sendWhatsappTemplate: (...args: unknown[]) => sendWhatsappTemplateMock(...args),
    sendWhatsappMedia: (...args: unknown[]) => sendWhatsappMediaMock(...args),
  };
});

vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: vi.fn(async () => ({
    id: "agent-1",
    displayName: "Agente",
    fullName: "Agente de Prueba",
    avatarUrl: null,
    role: "agent",
    isActive: true,
  })),
}));

vi.mock("@/lib/media-link", () => ({
  signedUrlForSending: vi.fn(async () => "https://firmado.example/archivo"),
}));

/** Filas que llegaron a `messages.insert`, y los UPDATE que les cayeron después. */
const insertedRows: Record<string, unknown>[] = [];
const messageUpdates: Record<string, unknown>[] = [];

let channelRow: { phone_number_id: string | null; status: string };
/** El teléfono del contacto de la conversación. Se ensucia en un test a propósito. */
let contactPhone: string;

function createFakeClient() {
  return {
    from(table: string) {
      if (table === "conversations") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      id: "conv-1",
                      contact: { phone_number: contactPhone },
                      channel: channelRow,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }

      if (table === "messages") {
        return {
          insert(row: Record<string, unknown>) {
            insertedRows.push(row);
            return {
              select() {
                return { single: async () => ({ data: { id: `msg-${insertedRows.length}` }, error: null }) };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            return {
              eq: async (_col: string, id: string) => {
                messageUpdates.push({ id, ...patch });
                return { error: null };
              },
            };
          },
          select() {
            // La búsqueda del wamid citado: acá no se cita nada.
            return {
              eq() {
                return { maybeSingle: async () => ({ data: null, error: null }) };
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
  createClient: vi.fn(async () => createFakeClient()),
}));

import { POST } from "./route";

function sendRequest(body: Record<string, unknown> = {}) {
  return new Request("http://crm.example/api/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "conv-1", kind: "text", content: "Hola", ...body }),
  });
}

/**
 * Deja terminar la cadena async del after() inline. Solo para aserciones
 * NEGATIVAS (nada debió pasar): para hechos positivos se espera con
 * vi.waitFor, no con un tick que bajo carga se queda corto (29/8/2026).
 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  insertedRows.length = 0;
  messageUpdates.length = 0;
  channelRow = { phone_number_id: "1234567890", status: "connected" };
  contactPhone = "+58123456789";
  sendWhatsappTextMock.mockReset();
  sendWhatsappTextMock.mockResolvedValue({ whatsappMessageId: "wamid.OK" });
  sendWhatsappTemplateMock.mockReset();
  sendWhatsappTemplateMock.mockResolvedValue({ whatsappMessageId: "wamid.PLANTILLA" });
  sendWhatsappMediaMock.mockReset();
  sendWhatsappMediaMock.mockResolvedValue({ whatsappMessageId: "wamid.MEDIA" });
  process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
});

afterEach(() => {
  delete process.env.WHATSAPP_ACCESS_TOKEN;
});

describe("POST /api/messages/send — el asesor no espera a Meta", () => {
  it("guarda primero, responde con el id, y el estado nace null (en camino)", async () => {
    const res = await POST(sendRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, id: "msg-1" });
    expect(insertedRows[0]).toMatchObject({
      conversation_id: "conv-1",
      direction: "outbound",
      whatsapp_message_id: null,
      whatsapp_status: null,
    });
  });

  it("cuando Meta confirma, la fila pasa a 'sent' con su wamid", async () => {
    await POST(sendRequest());

    await vi.waitFor(
      () =>
        expect(messageUpdates).toContainEqual({
          id: "msg-1",
          whatsapp_message_id: "wamid.OK",
          whatsapp_status: "sent",
        }),
      { timeout: 5000 }
    );
    expect(sendWhatsappTextMock).toHaveBeenCalledTimes(1);
  });

  it("un rechazo de Meta (4xx) marca 'failed' sin reintentar: repetirlo daría lo mismo", async () => {
    sendWhatsappTextMock.mockRejectedValue(new MetaApiError("Fuera de la ventana de 24 horas.", 400, null));

    await POST(sendRequest());

    await vi.waitFor(
      () =>
        expect(messageUpdates).toContainEqual({
          id: "msg-1",
          whatsapp_status: "failed",
          // Sin `details` de Meta no hay código, pero el motivo se guarda igual:
          // es lo que el asesor lee debajo del triángulo rojo.
          whatsapp_error_code: null,
          whatsapp_error_detail: "Fuera de la ventana de 24 horas.",
        }),
      { timeout: 5000 }
    );
    expect(sendWhatsappTextMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El código no es el status HTTP. 131026 ("ese número no recibe mensajes") y
   * 131047 ("pasaron 24 h") llegan los dos como un 400: sin el código de Meta,
   * los dos fallos son indistinguibles.
   */
  it("guarda el código de Meta cuando viene en el cuerpo del rechazo", async () => {
    sendWhatsappTextMock.mockRejectedValue(
      new MetaApiError("Message Undeliverable.", 400, {
        error: { code: 131026, message: "Message Undeliverable." },
      })
    );

    await POST(sendRequest());

    await vi.waitFor(
      () =>
        expect(messageUpdates).toContainEqual({
          id: "msg-1",
          whatsapp_status: "failed",
          whatsapp_error_code: 131026,
          whatsapp_error_detail: "Message Undeliverable.",
        }),
      { timeout: 5000 }
    );
  });

  it("un fallo de red reintenta una vez y, si sale, queda 'sent'", async () => {
    vi.useFakeTimers();
    try {
      sendWhatsappTextMock
        .mockRejectedValueOnce(new TypeError("fetch failed: ETIMEDOUT"))
        .mockResolvedValueOnce({ whatsappMessageId: "wamid.REINTENTO" });

      await POST(sendRequest());
      await vi.advanceTimersByTimeAsync(2000);

      expect(sendWhatsappTextMock).toHaveBeenCalledTimes(2);
      expect(messageUpdates).toContainEqual({
        id: "msg-1",
        whatsapp_message_id: "wamid.REINTENTO",
        whatsapp_status: "sent",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("en un canal de demo no se habla con Meta: la fila queda como siempre", async () => {
    channelRow = { phone_number_id: null, status: "demo" };

    await POST(sendRequest());
    await flush();

    expect(sendWhatsappTextMock).not.toHaveBeenCalled();
    expect(messageUpdates).toHaveLength(0);
    expect(insertedRows[0]).toMatchObject({ whatsapp_status: null });
  });

  it("canal real sin WHATSAPP_ACCESS_TOKEN: error inmediato, sin fila que muera en silencio", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    const res = await POST(sendRequest());

    expect(res.status).toBe(500);
    expect(insertedRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// El chat sin número
//
// Un contacto de los 1.197 tiene la cadena '+undefined' donde debería ir su
// teléfono: el webhook hacía `+${message.from}` sin comprobar que `from`
// existiera. Todo envío a ese chat falla, y el asesor sólo veía el triángulo
// rojo — así que reintentaba.
// ---------------------------------------------------------------------------
describe("POST /api/messages/send — un chat al que es imposible entregar", () => {
  it("no acepta el envío cuando el contacto no tiene un teléfono de verdad", async () => {
    contactPhone = "+undefined";

    const response = await POST(sendRequest());

    expect(response.status).toBe(422);
    // Nada guardado y nada intentado: la fila y el triángulo rojo son
    // precisamente lo que hay que dejar de producir.
    expect(insertedRows).toHaveLength(0);
    expect(sendWhatsappTextMock).not.toHaveBeenCalled();
  });

  /** El único arreglo posible está fuera del CRM, así que hay que decirlo. */
  it("le dice al asesor qué hacer, no sólo que no se pudo", async () => {
    contactPhone = "+undefined";

    const body = (await (await POST(sendRequest())).json()) as { error: string };

    expect(body.error).toContain("+undefined");
    expect(body.error).toMatch(/pídele el número al cliente/i);
  });

  /**
   * La nota interna nunca sale por WhatsApp: es del CRM. Bloquearla sería
   * quitarle al equipo el único sitio donde puede dejar constancia de un chat
   * que justamente no se puede contestar.
   */
  it("la nota interna sigue funcionando en ese mismo chat", async () => {
    contactPhone = "+undefined";

    const response = await POST(sendRequest({ isInternalNote: true, content: "Sin número bueno." }));

    expect(response.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ is_internal_note: true });
  });

  /** En un canal simulado no hay Meta a quien enviarle, así que no hay nada que cortar. */
  it("en un canal de demo no bloquea nada", async () => {
    contactPhone = "+undefined";
    channelRow = { phone_number_id: null, status: "demo" };

    const response = await POST(sendRequest());

    expect(response.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Plantillas con variables (T3.3, 5/9/2026)
//
// El cuerpo que llega en `content` trae sus `{{n}}` sin sustituir (así lo
// manda `sendTemplateMessage` en mutations.ts, con el `body_preview` tal
// cual). La ruta sustituye ANTES de guardar —la burbuja tiene que mostrar el
// mensaje real que le llegó al cliente, no el molde— y arma los
// `components` posicionales que la Graph API exige para que Meta rellene lo
// mismo del otro lado.
// ---------------------------------------------------------------------------
describe("POST /api/messages/send — plantillas con variables", () => {
  function templateRequest(body: Record<string, unknown> = {}) {
    return new Request("http://crm.example/api/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-1",
        kind: "template",
        templateName: "pedido_listo",
        templateLanguage: "es",
        content: "Hola {{1}}, tu repuesto {{2}} ya está listo.",
        variables: ["Pedro", "el carburador PZ27"],
        ...body,
      }),
    });
  }

  it("guarda en content el cuerpo con las variables ya sustituidas, no el molde con {{n}}", async () => {
    await POST(templateRequest());

    expect(insertedRows[0]).toMatchObject({
      message_type: "template",
      content: "Hola Pedro, tu repuesto el carburador PZ27 ya está listo.",
    });
  });

  it("arma el component body posicional y se lo pasa a sendWhatsappTemplate", async () => {
    await POST(templateRequest());

    await vi.waitFor(() => expect(sendWhatsappTemplateMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const args = sendWhatsappTemplateMock.mock.calls[0];
    // (phoneNumberId, accessToken, to, templateName, languageCode, components)
    expect(args[3]).toBe("pedido_listo");
    expect(args[4]).toBe("es");
    expect(args[5]).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Pedro" },
          { type: "text", text: "el carburador PZ27" },
        ],
      },
    ]);
  });

  it("una plantilla sin variables no manda components y guarda el cuerpo tal cual", async () => {
    await POST(
      templateRequest({
        content: "Gracias por tu compra.",
        variables: [],
      })
    );

    expect(insertedRows[0]).toMatchObject({ content: "Gracias por tu compra." });
    await vi.waitFor(() => expect(sendWhatsappTemplateMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(sendWhatsappTemplateMock.mock.calls[0][5]).toBeUndefined();
  });
});

/**
 * T3a ("Seis frentes del buzón", 9/9/2026): el camino de salida de un
 * sticker. Igual que cualquier `kind: "media"`, salvo que `content` se
 * fuerza a null aunque el llamador mande algo — Meta rechaza el envío con
 * caption.
 */
function stickerRequest(overrides: Record<string, unknown> = {}) {
  return sendRequest({
    kind: "media",
    mediaType: "sticker",
    mediaUrl: "/api/media/stickers/abc-123.webp",
    content: undefined,
    ...overrides,
  });
}

describe("POST /api/messages/send — sticker", () => {
  it("guarda message_type: 'sticker' con content null", async () => {
    await POST(stickerRequest());

    expect(insertedRows[0]).toMatchObject({
      message_type: "sticker",
      media_url: "/api/media/stickers/abc-123.webp",
      content: null,
    });
  });

  it("content null aunque el llamador mande uno por error", async () => {
    await POST(stickerRequest({ content: "un pie que no debería llegar" }));

    expect(insertedRows[0]).toMatchObject({ content: null });
  });

  it("en canal real llama a sendWhatsappMedia con mediaType 'sticker'", async () => {
    await POST(stickerRequest());

    await vi.waitFor(() => expect(sendWhatsappMediaMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const args = sendWhatsappMediaMock.mock.calls[0];
    // (phoneNumberId, accessToken, to, mediaType, link, caption, replyToWamid)
    expect(args[3]).toBe("sticker");
  });
});
