import { describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";

const sendWhatsappTextMock = vi.fn(async () => ({ whatsappMessageId: "wamid.texto" }));
const sendWhatsappMediaMock = vi.fn(async () => ({ whatsappMessageId: "wamid.media" }));

vi.mock("@/lib/whatsapp/meta-client", () => ({
  sendWhatsappText: (...args: unknown[]) => sendWhatsappTextMock(...(args as [])),
  sendWhatsappMedia: (...args: unknown[]) => sendWhatsappMediaMock(...(args as [])),
}));

import { sendPlaybookReply, type AgentConversation } from "@/lib/ai/send";

interface InsertedMessage {
  message_type: string;
  content: string | null;
  media_url?: string | null;
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

function conversation(connected: boolean): AgentConversation {
  return {
    id: "conv-1",
    contact_id: "contact-1",
    ai_enabled: true,
    assigned_agent_id: null,
    welcome_sent_at: "2026-08-22T10:00:00Z",
    contact: { phone_number: "+584121112233" },
    channel: { phone_number_id: connected ? "pnid-1" : null, status: connected ? "connected" : "demo" },
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
