import { describe, expect, it } from "vitest";
import { groupMessagesForRender } from "@/lib/message-grouping";
import type { Message, MessageType } from "@/lib/types";

let reloj = 0;

function media(over: Partial<Message> & { messageType?: MessageType } = {}): Message {
  reloj += 1000; // cada mensaje un segundo después: todos dentro de la ventana
  return {
    id: `m-${reloj}`,
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "image",
    content: null,
    templateName: null,
    mediaUrl: `/api/media/foto-${reloj}.jpg`,
    isInternalNote: false,
    whatsappStatus: null,
    replyToMessageId: null,
    createdAt: new Date(Date.UTC(2026, 7, 24, 12, 0, 0) + reloj).toISOString(),
    ...over,
  };
}

function grupos(items: ReturnType<typeof groupMessagesForRender>) {
  return items.filter((i) => i.kind === "media-group");
}

describe("agrupación de multimedia recibido", () => {
  it("junta las fotos seguidas del cliente en una sola galería", () => {
    const items = groupMessagesForRender([media(), media(), media()]);

    const [grupo] = grupos(items);
    expect(grupo).toBeDefined();
    expect(grupo!.kind === "media-group" && grupo!.messages).toHaveLength(3);
  });

  /**
   * El webhook guarda la foto con `media_url` en null para poder contestarle a
   * Meta dentro de sus 20s, y baja el archivo después. Durante esos segundos
   * la foto existe pero todavía no tiene archivo — y aun así es una de las
   * fotos que el cliente mandó. Dejarla fuera del grupo parte la galería en
   * pedazos y hace que el total mienta justo cuando más se mira.
   */
  it("cuenta también las fotos cuyo archivo todavía está bajando", () => {
    const items = groupMessagesForRender([
      media(),
      media({ mediaUrl: null }),
      media(),
      media({ mediaUrl: null }),
      media(),
    ]);

    const encontrados = grupos(items);
    expect(encontrados).toHaveLength(1);
    expect(encontrados[0]!.kind === "media-group" && encontrados[0]!.messages).toHaveLength(5);
  });

  it("un texto en medio corta el grupo, como siempre", () => {
    const items = groupMessagesForRender([
      media(),
      media(),
      media({ messageType: "text", mediaUrl: null, content: "¿Cuánto sale?" }),
      media(),
      media(),
    ]);

    expect(grupos(items)).toHaveLength(2);
  });

  it("una sola foto no se convierte en galería", () => {
    const items = groupMessagesForRender([media()]);
    expect(grupos(items)).toHaveLength(0);
  });
});
