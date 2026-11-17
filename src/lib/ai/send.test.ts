import { describe, expect, it, vi } from "vitest";
import type { CatalogLink, Playbook } from "@/lib/types";

const sendWhatsappTextMock = vi.fn(async () => ({ whatsappMessageId: "wamid.texto" }));
const sendWhatsappMediaMock = vi.fn(async () => ({ whatsappMessageId: "wamid.media" }));

vi.mock("@/lib/whatsapp/meta-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp/meta-client")>()),
  sendWhatsappText: (...args: unknown[]) => sendWhatsappTextMock(...(args as [])),
  sendWhatsappMedia: (...args: unknown[]) => sendWhatsappMediaMock(...(args as [])),
}));

import { sendAgentImage, sendAgentText, sendPlaybookReply } from "@/lib/ai/send";
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
          const n = inserted.length;
          // Sigue siendo una promesa a secas para los llamadores de siempre; solo quien
          // pide el id de la fila (`alGuardar`, 17/11/2026) encadena `.select().single()`.
          return Object.assign(Promise.resolve({ data: null, error: null }), {
            select: () => ({ single: async () => ({ data: { id: `msg-${n}` }, error: null }) }),
          });
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
    cedeAlInventario: false,
    disponibleEnEspera: false,
    tags: [],
    ...overrides,
  };
}

/** T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026). */
function catalogLink(overrides: Partial<CatalogLink> = {}): CatalogLink {
  return {
    id: "link-1",
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/cascos",
    sortOrder: 1,
    isActive: true,
    updatedBy: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

/** Ningún test de este describe usa marcadores: `[]` reproduce el comportamiento de antes de T3 byte a byte. */
const SIN_CATALOGOS: CatalogLink[] = [];

describe("sendPlaybookReply", () => {
  it("envía el texto del escenario tal cual, sin adjunto", async () => {
    const { client, inserted } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo suficiente para este test
    await sendPlaybookReply(client, conversation(false), playbook(), SIN_CATALOGOS);

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
      playbook({ attachmentUrl: "https://sbk.example/catalogo", attachmentType: "link" }),
      SIN_CATALOGOS
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
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" }),
      SIN_CATALOGOS
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
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" }),
      SIN_CATALOGOS
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
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" }),
      SIN_CATALOGOS
    );

    expect(sendWhatsappTextMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsappMediaMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
 * D3/D4): `sendPlaybookReply`/`playbookMessageText` resuelven el marcador de
 * catálogo contra la fuente única `catalog_links` en vez de depender de una
 * URL pegada a mano en `response_text`/`attachment_url`.
 */
describe("sendPlaybookReply / playbookMessageText — resuelven el marcador de catálogo", () => {
  it("resuelve {{catalogo:<key>}} en el texto redactado", async () => {
    const { client, inserted } = createFakeSupabase();

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook({ responseText: "Acá tienes: {{catalogo:cascos}}" }),
      [catalogLink()]
    );

    expect(inserted[0].content).toBe("Acá tienes: https://drive.google.com/cascos");
  });

  it("resuelve {{catalogos}} expandiendo la lista completa de catálogos activos", async () => {
    const { client, inserted } = createFakeSupabase();
    const links = [
      catalogLink(),
      catalogLink({ id: "link-2", key: "resonadores", label: "Resonadores", url: "https://drive.google.com/resonadores", sortOrder: 2 }),
    ];

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook({ responseText: "Nuestros catálogos:\n{{catalogos}}" }),
      links
    );

    expect(inserted[0].content).toBe(
      "Nuestros catálogos:\n• Cascos: https://drive.google.com/cascos\n• Resonadores: https://drive.google.com/resonadores"
    );
  });

  it("resuelve el marcador también dentro del adjunto tipo link", async () => {
    const { client, inserted } = createFakeSupabase();

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook({ responseText: "Acá va", attachmentUrl: "{{catalogo:cascos}}", attachmentType: "link" }),
      [catalogLink()]
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0].content).toBe("Acá va\n\nhttps://drive.google.com/cascos");
  });

  it("sin ningún marcador, el texto sale BYTE A BYTE igual que antes de esta corrida", async () => {
    const { client, inserted } = createFakeSupabase();

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook(),
      [catalogLink()] // aunque haya catálogos cargados, sin marcador no cambia nada
    );

    expect(inserted[0].content).toBe("Claro, por acá te dejo el catálogo:");
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
      origenDelFallo: null,
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

  it("con 360dialog y su llave (sin WHATSAPP_ACCESS_TOKEN) el envío sale con credenciales 360", async () => {
    const { client } = createFakeSupabase();
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    vi.stubEnv("D360_API_KEY", "llave-360");
    sendWhatsappTextMock.mockClear();
    sendWhatsappTextMock.mockResolvedValueOnce({ whatsappMessageId: "wamid.d360" });

    try {
      // @ts-expect-error -- fake mínimo
      const outcome = await sendAgentText(client, conversation(true), "hola");

      expect(outcome).toMatchObject({ whatsapp_status: "sent", whatsapp_message_id: "wamid.d360" });
      expect(sendWhatsappTextMock).toHaveBeenCalledWith(
        "pnid-1",
        { provider: "360dialog", apiKey: "llave-360", baseUrl: "https://waba-v2.360dialog.io" },
        "+584121112233",
        "hola"
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("con 360dialog sin D360_API_KEY no envía y el aviso nombra la variable que falta", async () => {
    const { client } = createFakeSupabase();
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    sendWhatsappTextMock.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // @ts-expect-error -- fake mínimo
      const outcome = await sendAgentText(client, conversation(true), "hola");

      expect(sendWhatsappTextMock).not.toHaveBeenCalled();
      expect(outcome.whatsapp_message_id).toBeNull();
      expect(warn.mock.calls.flat().join(" ")).toContain("D360_API_KEY");
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
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
 * S6 (corrida "La IA ve lo que llega", hallazgo 4, 8/9/2026): el corte de red
 * de OpenRouter del 7/9 dejó dos `ia_envio_fallido` con `detalle: "fetch
 * failed"` que `agent.ts` trató como rechazo de Meta. `entregar()` distingue
 * por el TIPO de excepción: `MetaApiError` (Meta respondió por HTTP) vs
 * cualquier otra cosa (nunca llegó a la Graph API).
 */
describe("sendAgentText — origenDelFallo distingue un rechazo de Meta de un corte de red", () => {
  it("MetaApiError con código → origenDelFallo 'meta'", async () => {
    const { client, inserted } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappTextMock.mockClear();
    sendWhatsappTextMock.mockRejectedValueOnce(
      new MetaApiError("Message failed to send", 400, { error: { code: 131047 } })
    );

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentText(client, conversation(true), "hola");

    expect(outcome).toMatchObject({
      whatsapp_status: "failed",
      whatsapp_error_code: 131047,
      origenDelFallo: "meta",
    });
    // El row insertado en `messages` lleva EXACTAMENTE las claves de
    // siempre: `origenDelFallo` no es columna y no puede colarse en el insert.
    expect(Object.keys(inserted[0]).sort()).toEqual(
      [
        "conversation_id",
        "content",
        "direction",
        "is_auto_reply",
        "message_type",
        "sender_type",
        "whatsapp_error_code",
        "whatsapp_error_detail",
        "whatsapp_message_id",
        "whatsapp_status",
      ].sort()
    );
  });

  it("TypeError('fetch failed') (corte de red) → origenDelFallo 'red', código null", async () => {
    const { client, inserted } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappTextMock.mockClear();
    sendWhatsappTextMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentText(client, conversation(true), "hola");

    expect(outcome).toMatchObject({
      whatsapp_status: "failed",
      whatsapp_error_code: null,
      whatsapp_error_detail: "fetch failed",
      origenDelFallo: "red",
    });
    expect(Object.keys(inserted[0]).sort()).toEqual(
      [
        "conversation_id",
        "content",
        "direction",
        "is_auto_reply",
        "message_type",
        "sender_type",
        "whatsapp_error_code",
        "whatsapp_error_detail",
        "whatsapp_message_id",
        "whatsapp_status",
      ].sort()
    );
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

/**
 * T4, "Seba atiende el mostrador" (18/9/2026, D2/D3): `sendPlaybookReply`
 * reenvía sus opciones a `sendAgentText` — así un escenario que sale en un
 * chat ya asignado a un asesor (`esperandoAsesor`, agent.ts) puede marcarse
 * `is_auto_reply: true` desde el mismo envío, sin esperar al UPDATE posterior
 * que solo existe para el camino `afterSend: "escalate"`.
 */
describe("sendPlaybookReply — opciones (is_auto_reply)", () => {
  it("sin opciones, inserta is_auto_reply: false (el default de sendAgentText)", async () => {
    const { client, inserted } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    await sendPlaybookReply(client, conversation(false), playbook(), SIN_CATALOGOS);

    expect(inserted[0].is_auto_reply).toBe(false);
  });

  it("con { isAutoReply: true }, inserta is_auto_reply: true en el texto del escenario", async () => {
    const { client, inserted } = createFakeSupabase();

    await sendPlaybookReply(
      // @ts-expect-error -- fake mínimo
      client,
      conversation(false),
      playbook(),
      SIN_CATALOGOS,
      { isAutoReply: true }
    );

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
      playbook({ attachmentUrl: "https://sbk.example/catalogo.pdf", attachmentType: "document" }),
      SIN_CATALOGOS
    );

    expect(outcome).toMatchObject({ whatsapp_status: "sent", whatsapp_message_id: "wamid.texto-ok" });
  });
});

/**
 * Seba v2 (S2b, 17/11/2026): `sendAgentImage` manda una imagen (la foto de un
 * producto) con su pie, y `alGuardar` le entrega a quien llama el id de la fila de
 * `messages` — lo necesita el efecto real para marcar `is_auto_reply` después de un
 * pase a asesor, y `DeliveryOutcome` solo trae el id de WhatsApp (null en un canal
 * simulado).
 */
describe("sendAgentImage", () => {
  it("en un canal simulado guarda una fila de imagen con el pie en content y sin llamar a Meta", async () => {
    const { client, inserted } = createFakeSupabase();
    sendWhatsappMediaMock.mockClear();

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentImage(client, conversation(false), "https://sbk.example/foto.jpg", "Casco LS2 negro");

    expect(sendWhatsappMediaMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      conversation_id: "conv-1",
      direction: "outbound",
      sender_type: "ai",
      message_type: "image",
      content: "Casco LS2 negro",
      media_url: "https://sbk.example/foto.jpg",
      is_auto_reply: false,
    });
    expect(outcome.whatsapp_status).toBeNull();
  });

  it("en un canal conectado la manda a WhatsApp como imagen por link, con su pie como caption", async () => {
    const { client } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappMediaMock.mockClear();
    sendWhatsappMediaMock.mockResolvedValueOnce({ whatsappMessageId: "wamid.img" });

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentImage(client, conversation(true), "https://sbk.example/foto.jpg", "Casco LS2 negro");

    expect(sendWhatsappMediaMock).toHaveBeenCalledTimes(1);
    const args = sendWhatsappMediaMock.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe("pnid-1");
    expect(args[2]).toBe("+584121112233");
    expect(args[3]).toBe("image");
    expect(args[4]).toBe("https://sbk.example/foto.jpg");
    expect(args[5]).toBe("Casco LS2 negro");
    expect(outcome).toMatchObject({ whatsapp_status: "sent", whatsapp_message_id: "wamid.img" });
  });

  it("sin pie guarda content null y no manda caption", async () => {
    const { client, inserted } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappMediaMock.mockClear();

    // @ts-expect-error -- fake mínimo
    await sendAgentImage(client, conversation(true), "https://sbk.example/foto.jpg", null);

    expect(inserted[0].content).toBeNull();
    const args = sendWhatsappMediaMock.mock.calls[0] as unknown as unknown[];
    expect(args[5]).toBeUndefined();
  });

  it("isAutoReply viaja a la fila", async () => {
    const { client, inserted } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    await sendAgentImage(client, conversation(false), "https://sbk.example/foto.jpg", null, { isAutoReply: true });

    expect(inserted[0].is_auto_reply).toBe(true);
  });

  it("si Meta la rechaza, deja la fila 'failed' con su origen y la devuelve", async () => {
    const { client, inserted } = createFakeSupabase();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
    sendWhatsappMediaMock.mockClear();
    sendWhatsappMediaMock.mockRejectedValueOnce(
      new MetaApiError("Media upload error", 400, { error: { code: 131053 } })
    );

    // @ts-expect-error -- fake mínimo
    const outcome = await sendAgentImage(client, conversation(true), "https://sbk.example/foto.jpg", "pie");

    expect(outcome).toMatchObject({ whatsapp_status: "failed", whatsapp_error_code: 131053, origenDelFallo: "meta" });
    expect(inserted[0]).toMatchObject({ message_type: "image", whatsapp_status: "failed" });
  });

  it("alGuardar recibe el id de la fila insertada", async () => {
    const { client } = createFakeSupabase();
    const ids: (string | null)[] = [];

    // @ts-expect-error -- fake mínimo
    await sendAgentImage(client, conversation(false), "https://sbk.example/foto.jpg", null, {
      alGuardar: (id: string | null) => ids.push(id),
    });

    expect(ids).toEqual(["msg-1"]);
  });
});

describe("sendAgentText — alGuardar", () => {
  it("entrega el id de la fila insertada", async () => {
    const { client } = createFakeSupabase();
    const ids: (string | null)[] = [];

    // @ts-expect-error -- fake mínimo
    await sendAgentText(client, conversation(false), "hola", { alGuardar: (id: string | null) => ids.push(id) });

    expect(ids).toEqual(["msg-1"]);
  });

  it("sin alGuardar el insert no pide ningún select (comportamiento de siempre)", async () => {
    const { client } = createFakeSupabase();
    const insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const sinSelect = { from: () => ({ insert }) };

    // @ts-expect-error -- fake mínimo
    await sendAgentText(sinSelect, conversation(false), "hola");
    void client;

    expect(insert).toHaveBeenCalledTimes(1);
  });
});
