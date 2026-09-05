import { describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";

const sendWhatsappTextMock = vi.fn(async () => ({ whatsappMessageId: "wamid.texto" }));
const sendWhatsappMediaMock = vi.fn(async () => ({ whatsappMessageId: "wamid.media" }));

vi.mock("@/lib/whatsapp/meta-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp/meta-client")>()),
  sendWhatsappText: (...args: unknown[]) => sendWhatsappTextMock(...(args as [])),
  sendWhatsappMedia: (...args: unknown[]) => sendWhatsappMediaMock(...(args as [])),
}));

import { sendAgentText, sendPlaybookReply } from "@/lib/ai/send";
import { MetaApiError } from "@/lib/whatsapp/meta-client";
import type { TurnTarget } from "@/lib/ai/turn-target";

interface InsertedMessage {
  message_type: string;
  content: string | null;
  media_url?: string | null;
  is_auto_reply?: boolean;
}

function createFakeSupabase() {
  const inserted: InsertedMessage[] = [];
  const client = {
    from(table: string) {
      if (table !== "messages") throw new Error(`tabla inesperada: ${table}`);
      return {
        insert(row: InsertedMessage) {
          inserted.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return { client, inserted };
}

function conversation(connected: boolean): TurnTarget {
  return {
    conversationId: "conv-1",
    contactId: "contact-1",
    phoneNumber: "+584121112233",
    phoneNumberId: connected ? "pnid-1" : null,
    channelStatus: connected ? "connected" : "demo",
  };
}

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb-1",
    name: "Catálogo general",
    triggerDescription: "el cliente pide ver el catálogo",
    responseText: "Claro, por acá te dejo el catálogo:",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    tags: [],
    ...overrides,
  };
}

describe("sendPlaybookReply", () => {
  it("envía el texto del escenario tal cual, sin adjunto", async () => {
    const { client, inserted } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo suficiente para este test
    await sendPlaybookReply(client, conversation(false), playbook());

    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe("Claro, por acá te dejo el catálogo:");
    expect(inserted[0].message_type).toBe("text");
  });

  it("anexa la URL al mismo mensaje cuando el adjunto es un link", async () => {
    const { client, inserted } = createFakeSupabase();

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook({ attachmentUrl: "https://sbk.example/catalogo", attachmentType: "link" })
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe("Claro, por acá te dejo el catálogo:\n\nhttps://sbk.example/catalogo");
  });

  it("envía el archivo como mensaje aparte cuando el adjunto es un documento", async () => {
    const { client, inserted } = createFakeSupabase();

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" })
    );

    expect(inserted).toHaveLength(2);
    expect(inserted[0].message_type).toBe("text");
    expect(inserted[0].content).toBe("Claro, por acá te dejo el catálogo:");
    expect(inserted[1].message_type).toBe("document");
    expect(inserted[1].media_url).toBe("https://sbk.example/catalogo.pdf");
  });

  it("en un canal simulado guarda el mensaje sin llamar a la Cloud API", async () => {
    const { client, inserted } = createFakeSupabase();
    sendWhatsappTextMock.mockClear();
    sendWhatsappMediaMock.mockClear();

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" })
    );

    expect(sendWhatsappTextMock).not.toHaveBeenCalled();
    expect(sendWhatsappMediaMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(2);
  });

  it("en un canal conectado manda texto y archivo por WhatsApp", async () => {
    const { client } = createFakeSupabase();
    sendWhatsappTextMock.mockClear();
    sendWhatsappMediaMock.mockClear();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(true),
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" })
    );

    expect(sendWhatsappTextMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsappMediaMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * T0.3: `sendAgentText`/`sendAgentMedia` (y `sendPlaybookReply`, que lo usa
 * por dentro) dejaron de ser `Promise<void>`: el turno (agent.ts) necesita el
 * `DeliveryOutcome` para saber si Meta rechazó el envío y registrar el
 * traspaso `rechazado_por_meta`. Antes de este cambio ese rechazo quedaba
 * escrito en `messages` pero era invisible para quien llamó a la función.
 */
describe("sendAgentText — el outcome vuelve", () => {
  it("en un canal simulado, devuelve el outcome 'no enviado' (whatsapp_status null)", async () => {
    const { client } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentText(client, conversation(false), "hola");

    expect(outcome).toEqual({
      whatsapp_message_id: null,
      whatsapp_status: null,
      whatsapp_error_code: null,
      whatsapp_error_detail: null,
    });
  });

  it("en un canal conectado que Meta acepta, devuelve whatsapp_status 'sent'", async () => {
    const { client } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappTextMock.mockClear();
    sendWhatsappTextMock.mockResolvedValueOnce({ whatsappMessageId: "wamid.ok" });

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentText(client, conversation(true), "hola");

    expect(outcome).toMatchObject({ whatsapp_status: "sent", whatsapp_message_id: "wamid.ok" });
  });

  it("cuando Meta rechaza el envío, devuelve whatsapp_status 'failed' con el código de error", async () => {
    const { client } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappTextMock.mockClear();
    sendWhatsappTextMock.mockRejectedValueOnce(
      new MetaApiError("Message failed to send", 400, { error: { code: 131047 } })
    );

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentText(client, conversation(true), "hola");

    expect(outcome.whatsapp_status).toBe("failed");
    expect(outcome.whatsapp_error_code).toBe(131047);
  });
});

/**
 * Anexo A1 (5/9/2026): `sendAgentText` gana `opciones?.isAutoReply`, la
 * misma marca que ya lleva la bienvenida automática (T0.1). La usa la
 * despedida de la IA al escalar sin asesores, para que el trigger
 * `handle_new_message` no la cuente como respuesta real.
 */
describe("sendAgentText — is_auto_reply", () => {
  it("sin opciones, inserta is_auto_reply: false", async () => {
    const { client, inserted } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    await sendAgentText(client, conversation(false), "hola");

    expect(inserted[0].is_auto_reply).toBe(false);
  });

  it("con { isAutoReply: true }, inserta is_auto_reply: true", async () => {
    const { client, inserted } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    await sendAgentText(client, conversation(false), "Ya dejé tu caso registrado…", { isAutoReply: true });

    expect(inserted[0].is_auto_reply).toBe(true);
  });
});

describe("sendPlaybookReply — el outcome que vuelve es el del texto, no el del adjunto", () => {
  it("devuelve el outcome del texto aunque el envío del adjunto falle", async () => {
    const { client } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappTextMock.mockClear();
    sendWhatsappMediaMock.mockClear();
    sendWhatsappTextMock.mockResolvedValueOnce({ whatsappMessageId: "wamid.texto-ok" });
    sendWhatsappMediaMock.mockRejectedValueOnce(new Error("Meta no pudo descargar el adjunto"));

    const outcome = await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(true),
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" })
    );

    expect(outcome).toMatchObject({ whatsapp_status: "sent", whatsapp_message_id: "wamid.texto-ok" });
  });
});
