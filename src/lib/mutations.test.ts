import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, Contact, Message, Sale, Sticker } from "@/lib/types";
import {
  closeSaleWithContactInfo,
  createContactConversation,
  createInvoiceForSale,
  createSticker,
  deleteSticker,
  issueInvoice,
  markConversationRead,
  markConversationUnread,
  pinConversation,
  saveStickerFromMessage,
  sendStickerMessage,
  setAiEnabled,
  unassign,
  unpinConversation,
  updateProductWeight,
  voidInvoice,
  type SaleLineItem,
} from "@/lib/mutations";

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José Riera",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function createFakeSupabase() {
  const calls: { table: string; op: "insert" | "update"; payload: unknown }[] = [];
  let nextOrderId = 1;

  const client = {
    from(table: string) {
      if (table === "contacts") {
        return { update: (payload: unknown) => ({ eq: async () => { calls.push({ table, op: "update", payload }); return { error: null }; } }) };
      }
      if (table === "orders") {
        return {
          insert: (payload: unknown) => {
            calls.push({ table, op: "insert", payload });
            return {
              select: () => ({
                single: async () => ({ data: { id: `order-${nextOrderId++}` }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "order_items") {
        return {
          insert: async (payload: unknown) => {
            calls.push({ table, op: "insert", payload });
            return { error: null };
          },
        };
      }
      if (table === "conversations") {
        return { update: (payload: unknown) => ({ eq: async () => { calls.push({ table, op: "update", payload }); return { error: null }; } }) };
      }
      if (table === "messages") {
        return { insert: async (payload: unknown) => { calls.push({ table, op: "insert", payload }); return { error: null }; } };
      }
      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

const CONTACT_DETAILS = {
  displayName: "Cliente Demo",
  cedulaType: "V" as const,
  cedulaNumber: "12345678",
  state: "Barinas",
  city: "Barinas",
  address: "Calle Falsa 123",
  paymentProofUrl: "https://example.com/proof.jpg",
  paymentMethod: "pago_movil" as const,
};

describe("closeSaleWithContactInfo — el monto sale del catálogo, nunca de un número a mano", () => {
  it("rechaza cerrar la venta sin un solo renglón", async () => {
    const { client } = createFakeSupabase();
    await expect(
      closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, CONTACT_DETAILS, [], 40)
    ).rejects.toThrow(/al menos un repuesto/i);
  });

  it("crea la orden con el total exacto de los renglones y enlaza la conversación", async () => {
    const { client, calls } = createFakeSupabase();
    const items: SaleLineItem[] = [
      { id: "q-1", origin: "quote", productId: "prod-1", description: "Carburador PZ27", unitPrice: 18, quantity: 1 },
      { id: "prod-2", origin: "inventory", productId: "prod-2", description: "Kit de arrastre", unitPrice: 32.5, quantity: 2 },
    ];

    await closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, CONTACT_DETAILS, items, 40);

    const orderInsert = calls.find((c) => c.table === "orders" && c.op === "insert");
    expect(orderInsert?.payload).toMatchObject({
      contact_id: "contact-1",
      currency: "USD",
      total_amount: 83, // 18*1 + 32.5*2
      bcv_rate: 40,
    });

    const itemsInsert = calls.find((c) => c.table === "order_items" && c.op === "insert");
    expect(itemsInsert?.payload).toEqual([
      { order_id: "order-1", product_id: "prod-1", description: "Carburador PZ27", quantity: 1, unit_price: 18 },
      { order_id: "order-1", product_id: "prod-2", description: "Kit de arrastre", quantity: 2, unit_price: 32.5 },
    ]);

    const conversationUpdate = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(conversationUpdate?.payload).toMatchObject({
      deal_status: "won",
      order_id: "order-1",
    });
  });
});

/**
 * Apartar un chat y volver a darlo por leído son la misma acción invertida.
 * Lo que estos tests fijan es que ninguna de las dos toque `unread_count`
 * para mentir: apartar no inventa un mensaje, y dar por leído sí tiene que
 * limpiar las dos señales a la vez —si no, un chat apartado seguiría en
 * "Sin leer" para siempre después de abrirlo.
 */
describe("marcar una conversación como no leída", () => {
  it("aparta el chat sin tocar el contador de mensajes sin leer", async () => {
    const { client, calls } = createFakeSupabase();

    await markConversationUnread(client, "conv-1");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ manually_unread: true });
  });

  it("darla por leída limpia el contador y el apartado a la vez", async () => {
    const { client, calls } = createFakeSupabase();

    await markConversationRead(client, "conv-1");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ unread_count: 0, manually_unread: false });
  });
});

/**
 * T2.2 del plan "La bandeja que no pierde" (5/9/2026): hasta tres chats
 * fijados por asesor. `pinConversation`/`unpinConversation` no arman la
 * regla del tope de tres —eso vive en el trigger
 * `conversation_pins_limit_before_insert` de la migración
 * 20260905040000_conversation_pins.sql, y lo verifica `supabase/tests/pins.sql`
 * contra la base real—; lo único que estos tests fijan es que el par
 * agente/conversación viaja tal cual a la tabla, y que un error de la base
 * (el del cuarto pin, u otro cualquiera) sube sin que la función lo trague.
 */
/**
 * T7, corrida "La IA ve lo que llega" (8/9/2026): human-handled.ts dejó de
 * preguntar "¿alguna vez escribió un asesor?" y pasó a comparar fechas, así
 * que estas dos mutaciones ya no dependen de nada más que de sus columnas
 * propias para devolver un chat a la IA — no tocan `messages`, no tocan
 * fechas. Lo único que fijan estos tests es que el UPDATE de `conversations`
 * lleva EXACTAMENTE esa columna y ninguna otra: si algún día empezara a
 * escribir también, por ejemplo, `last_customer_message_at` a mano, rompería
 * los dos candados documentados en CLAUDE.md sobre esa columna.
 */
describe("setAiEnabled / unassign — devuelven el chat a la IA sin tocar messages", () => {
  it("setAiEnabled(true) actualiza SOLO ai_enabled", async () => {
    const { client, calls } = createFakeSupabase();

    await setAiEnabled(client, "conv-1", AGENT, true);

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ ai_enabled: true });
  });

  it("unassign actualiza SOLO assigned_agent_id", async () => {
    const { client, calls } = createFakeSupabase();

    await unassign(client, "conv-1", AGENT, "María");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ assigned_agent_id: null });
  });
});

describe("pinConversation / unpinConversation", () => {
  function createFakePinsSupabase() {
    const calls: { op: "insert" | "delete"; agentId: string; conversationId: string }[] = [];

    const client = {
      from(table: string) {
        if (table !== "conversation_pins") {
          throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
        }
        return {
          insert: async (payload: { agent_id: string; conversation_id: string }) => {
            calls.push({ op: "insert", agentId: payload.agent_id, conversationId: payload.conversation_id });
            return { error: null };
          },
          delete: () => ({
            eq: (_col1: string, agentId: string) => ({
              eq: async (_col2: string, conversationId: string) => {
                calls.push({ op: "delete", agentId, conversationId });
                return { error: null };
              },
            }),
          }),
        };
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("fija: inserta el par agente/conversación", async () => {
    const { client, calls } = createFakePinsSupabase();

    await pinConversation(client, "agent-1", "conv-9");

    expect(calls).toEqual([{ op: "insert", agentId: "agent-1", conversationId: "conv-9" }]);
  });

  it("propaga el error del cuarto pin en vez de tragárselo", async () => {
    const client = {
      from: () => ({
        insert: async () => ({
          error: new Error("Ya tenés tres conversaciones fijadas. Desfijá una para poder fijar esta."),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(pinConversation(client, "agent-1", "conv-9")).rejects.toThrow(/tres conversaciones fijadas/);
  });

  it("desfija: borra por agente Y conversación, no solo por conversación", async () => {
    const { client, calls } = createFakePinsSupabase();

    await unpinConversation(client, "agent-1", "conv-9");

    expect(calls).toEqual([{ op: "delete", agentId: "agent-1", conversationId: "conv-9" }]);
  });
});

/**
 * T4 del plan "Seis frentes del buzón" (8/9/2026): peso en kilos para
 * Cashea. Igual que `updateProductPrice`, el UPDATE lleva la columna y
 * `updated_at` — nada más — y `null` es un guardado legítimo (vuelve a dejar
 * el repuesto "sin cargar").
 */
describe("updateProductWeight", () => {
  function createFakeProductsSupabase() {
    const calls: { table: string; payload: unknown; productId: string }[] = [];
    const client = {
      from(table: string) {
        if (table !== "products") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
        return {
          update: (payload: unknown) => ({
            eq: async (_col: string, productId: string) => {
              calls.push({ table, payload, productId });
              return { error: null };
            },
          }),
        };
      },
    };
    return { client: client as unknown as SupabaseClient, calls };
  }

  it("manda weight_kg y updated_at", async () => {
    const { client, calls } = createFakeProductsSupabase();

    await updateProductWeight(client, "prod-1", 0.25);

    expect(calls).toHaveLength(1);
    expect(calls[0].productId).toBe("prod-1");
    expect(calls[0].payload).toMatchObject({ weight_kg: 0.25 });
    expect(calls[0].payload).toHaveProperty("updated_at");
  });

  it("guardar null vuelve a dejar el repuesto sin peso cargado", async () => {
    const { client, calls } = createFakeProductsSupabase();

    await updateProductWeight(client, "prod-1", null);

    expect(calls[0].payload).toMatchObject({ weight_kg: null });
  });

  it("propaga el error de la base en vez de tragárselo", async () => {
    const client = {
      from: () => ({ update: () => ({ eq: async () => ({ error: new Error("no se pudo guardar") }) }) }),
    } as unknown as SupabaseClient;

    await expect(updateProductWeight(client, "prod-1", 1)).rejects.toThrow(/no se pudo guardar/);
  });
});

/**
 * Biblioteca de stickers (T3a, "Seis frentes del buzón", 8/9/2026). El fake
 * de storage reproduce solo `.copy`/`.upload`/`.remove` del bucket —lo que
 * estas mutaciones usan— y el fake de `stickers` reproduce
 * insert().select().single() y delete().eq(id).
 */
function createStickerFakeSupabase() {
  const storageCalls: { op: "upload" | "remove"; args: unknown[] }[] = [];
  const tableCalls: { op: "insert" | "delete"; payload?: unknown; id?: string }[] = [];
  let insertedRow: Record<string, unknown> | null = null;

  const client = {
    from(table: string) {
      if (table !== "stickers") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      return {
        insert: (payload: Record<string, unknown>) => {
          insertedRow = {
            id: "sticker-nuevo",
            storage_path: payload.storage_path,
            name: (payload.name as string | null | undefined) ?? null,
            animated: (payload.animated as boolean | undefined) ?? false,
            created_by: payload.created_by,
            created_at: "2026-09-09T12:00:00.000Z",
          };
          tableCalls.push({ op: "insert", payload });
          return {
            select: () => ({
              single: async () => ({ data: insertedRow, error: null }),
            }),
          };
        },
        delete: () => ({
          eq: async (_col: string, id: string) => {
            tableCalls.push({ op: "delete", id });
            return { error: null };
          },
        }),
      };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, file: unknown, opts: unknown) => {
          storageCalls.push({ op: "upload", args: [bucket, path, file, opts] });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          storageCalls.push({ op: "remove", args: [bucket, paths] });
          return { error: null };
        },
      }),
    },
  };

  return { client: client as unknown as SupabaseClient, storageCalls, tableCalls };
}

/**
 * Arma bytes de un WebP mínimo (T2, "Ponele balanza a la biblioteca",
 * 8/9/2026): cabecera `RIFF`/tamaño/`WEBP` + chunk `VP8X` con el bit ANIM
 * (`0x02`) prendido o apagado en el byte de flags (offset 20), rellenado
 * hasta `totalBytes` — lo mínimo que `isAnimatedWebp` necesita para decidir,
 * más relleno para simular el peso real del caso que el test necesita.
 */
function buildWebpBytes(totalBytes: number, animated: boolean): Uint8Array {
  const bytes = new Uint8Array(Math.max(totalBytes, 21));
  const escribirFourCC = (offset: number, cc: string) => {
    for (let i = 0; i < 4; i++) bytes[offset + i] = cc.charCodeAt(i);
  };
  escribirFourCC(0, "RIFF");
  escribirFourCC(8, "WEBP");
  escribirFourCC(12, "VP8X");
  bytes[20] = animated ? 0x02 : 0x00;
  return bytes;
}

function stubFetchConArchivo(bytes: Uint8Array) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    }))
  );
}

const STICKER_AGENT: Agent = {
  id: "agent-42",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function stickerSourceMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-sticker-1",
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "sticker",
    content: null,
    templateName: null,
    mediaUrl: "/api/media/inbound/conv-1/original.webp",
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
    createdAt: "2026-09-09T11:00:00.000Z",
    ...overrides,
  };
}

describe("saveStickerFromMessage — guardar el sticker de un mensaje recibido", () => {
  it("descarga el sticker por la ruta propia, lo sube a stickers/<uuid>.webp e inserta la fila con source_message_id", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(60 * 1024, false);
    stubFetchConArchivo(bytes);

    try {
      const sticker = await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);

      // No hay .copy: ahora el único camino es bajar los bytes (para
      // pesarlos y detectar animación) y subirlos.
      const uploadCall = storageCalls.find((c) => c.op === "upload");
      expect(uploadCall).toBeDefined();
      expect(String(uploadCall?.args[1])).toMatch(/^stickers\/.+\.webp$/);
      expect(uploadCall?.args[3]).toMatchObject({ contentType: "image/webp" });

      expect(tableCalls[0]).toMatchObject({
        op: "insert",
        payload: {
          created_by: "agent-42",
          source_message_id: "msg-sticker-1",
          animated: false,
        },
      });
      expect(sticker.id).toBe("sticker-nuevo");
      expect(sticker.url).toMatch(/^\/api\/media\/stickers\//);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un sticker animado de 973.668 bytes (el caso real del 131053 de Meta) se rechaza sin escribir nada", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(973668, true);
    stubFetchConArchivo(bytes);

    try {
      let error: unknown;
      try {
        await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      const mensaje = (error as Error).message;
      expect(mensaje).toMatch(/animado/i);
      expect(mensaje).toMatch(/951 KB/);
      expect(mensaje).toMatch(/500 KB/);

      expect(storageCalls).toHaveLength(0);
      expect(tableCalls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un sticker animado de 400 KB entra en el límite y se guarda con animated: true", async () => {
    const { client, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(400 * 1024, true);
    stubFetchConArchivo(bytes);

    try {
      const sticker = await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);

      expect(tableCalls[0]).toMatchObject({ op: "insert", payload: { animated: true } });
      expect(sticker.animated).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un sticker estático de 60 KB se guarda con animated: false", async () => {
    const { client, tableCalls } = createStickerFakeSupabase();
    const bytes = buildWebpBytes(60 * 1024, false);
    stubFetchConArchivo(bytes);

    try {
      const sticker = await saveStickerFromMessage(client, stickerSourceMessage(), STICKER_AGENT);

      expect(tableCalls[0]).toMatchObject({ op: "insert", payload: { animated: false } });
      expect(sticker.animated).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sin mediaUrl no hay nada que guardar", async () => {
    const { client } = createStickerFakeSupabase();
    await expect(
      saveStickerFromMessage(client, stickerSourceMessage({ mediaUrl: null }), STICKER_AGENT)
    ).rejects.toThrow(/no tiene un sticker/i);
  });
});

describe("createSticker — armado desde cero", () => {
  it("sube el WebP e inserta la fila con el nombre", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();
    const blob = new Blob(["webp"]);

    const sticker = await createSticker(client, blob, "Moto contenta", STICKER_AGENT);

    const uploadCall = storageCalls.find((c) => c.op === "upload");
    expect(uploadCall?.args[2]).toBe(blob);
    expect(uploadCall?.args[3]).toMatchObject({ contentType: "image/webp" });
    expect(tableCalls[0]).toMatchObject({
      op: "insert",
      payload: { name: "Moto contenta", created_by: "agent-42" },
    });
    expect(sticker.name).toBe("Moto contenta");
  });
});

describe("deleteSticker — borra la fila y el archivo, en ese orden", () => {
  const STICKER: Sticker = {
    id: "sticker-1",
    url: "/api/media/stickers/sticker-1.webp",
    name: null,
    animated: false,
    createdBy: "agent-42",
    createdAt: "2026-09-09T12:00:00.000Z",
  };

  it("borra la fila y después el objeto del bucket", async () => {
    const { client, storageCalls, tableCalls } = createStickerFakeSupabase();

    await deleteSticker(client, STICKER);

    expect(tableCalls).toEqual([{ op: "delete", id: "sticker-1" }]);
    const removeCall = storageCalls.find((c) => c.op === "remove");
    expect(removeCall?.args[1]).toEqual(["stickers/sticker-1.webp"]);
  });

  it("un error de RLS al borrar la fila se propaga tal cual, sin tocar el archivo", async () => {
    const client = {
      from: () => ({
        delete: () => ({
          eq: async () => ({ error: new Error("new row violates row-level security policy") }),
        }),
      }),
      storage: { from: () => ({ remove: vi.fn() }) },
    } as unknown as SupabaseClient;

    await expect(deleteSticker(client, STICKER)).rejects.toThrow(/row-level security/);
  });
});

describe("sendStickerMessage — el mismo camino que un adjunto, sin content", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, id: "msg-99" }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("manda kind: media, mediaType: sticker y sin content", async () => {
    await sendStickerMessage("conv-1", "/api/media/stickers/sticker-1.webp");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/messages/send");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      conversationId: "conv-1",
      kind: "media",
      mediaUrl: "/api/media/stickers/sticker-1.webp",
      mediaType: "sticker",
    });
  });
});

/**
 * T5, plan "Seis frentes del buzón" (8/9/2026): las bases de la factura.
 * `createInvoiceForSale` no arma el snapshot ella misma —eso lo prueba
 * invoices.test.ts (`buildInvoiceDraft`)— acá se fija que lea `order_id` de
 * la conversación, falle claro sin orden, y que emitir/anular actualicen
 * exactamente las columnas que les tocan.
 */
describe("createInvoiceForSale / issueInvoice / voidInvoice", () => {
  const CONTACT: Contact = {
    id: "contact-1",
    phoneNumber: "+584121234567",
    displayName: "Cliente Demo",
    profileName: "Demo WA",
    avatarUrl: null,
    tags: [],
    cedulaType: "V",
    cedulaNumber: "12345678",
    state: "Barinas",
    city: "Barinas",
    address: "Calle Falsa 123",
  };

  const SALE: Sale = {
    id: "conv-1",
    contact: CONTACT,
    dealStatus: "won",
    dealClosedAt: "2026-09-08T12:00:00.000Z",
    dealPaymentProofUrl: null,
    dealAmount: 83,
    dealCurrency: "USD",
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: "pago_movil",
    dealClosedBy: null,
    createdAt: "2026-09-08T11:00:00.000Z",
  };

  const RAW_INVOICE_ROW = {
    id: "inv-1",
    number: 1,
    conversation_id: "conv-1",
    order_id: "order-1",
    contact_id: "contact-1",
    customer: { displayName: "Cliente Demo", phoneNumber: "+584121234567", cedulaType: "V", cedulaNumber: "12345678", state: "Barinas", city: "Barinas", address: "Calle Falsa 123" },
    items: [{ description: "Carburador PZ27", quantity: 1, unitPrice: 18, amount: 18 }],
    subtotal: 18,
    tax_rate: 0,
    tax_amount: 0,
    total: 18,
    currency: "USD",
    bcv_rate: 40,
    status: "draft",
    issued_at: null,
    voided_at: null,
    notes: null,
    created_at: "2026-09-08T12:00:00.000Z",
    updated_at: "2026-09-08T12:00:00.000Z",
    issued_by: null,
  };

  function createFakeInvoiceSupabase(options: { orderId?: string | null } = {}) {
    const calls: { table: string; op: string; payload?: unknown; eq?: [string, unknown][] }[] = [];
    const orderId = options.orderId === undefined ? "order-1" : options.orderId;

    const client = {
      from(table: string) {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: (col: string, value: unknown) => ({
                maybeSingle: async () => {
                  calls.push({ table, op: "select", eq: [[col, value]] });
                  return { data: { order_id: orderId }, error: null };
                },
              }),
            }),
          };
        }
        if (table === "order_items") {
          return {
            select: () => ({
              eq: (col: string, value: unknown) => {
                calls.push({ table, op: "select", eq: [[col, value]] });
                return Promise.resolve({
                  data: [{ description: "Carburador PZ27", quantity: 1, unit_price: "18.00" }],
                  error: null,
                });
              },
            }),
          };
        }
        if (table === "invoices") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () => ({ data: RAW_INVOICE_ROW, error: null }),
                }),
              };
            },
            update: (payload: unknown) => {
              calls.push({ table, op: "update", payload });
              return {
                eq: () => ({
                  select: () => ({
                    single: async () => ({
                      data: { ...RAW_INVOICE_ROW, ...(payload as Record<string, unknown>) },
                      error: null,
                    }),
                  }),
                }),
              };
            },
          };
        }
        if (table === "messages") {
          return { insert: async (payload: unknown) => { calls.push({ table, op: "insert", payload }); return { error: null }; } };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("crea la factura con el snapshot del cliente y de los renglones de la orden", async () => {
    const { client, calls } = createFakeInvoiceSupabase();

    const invoice = await createInvoiceForSale(client, SALE, AGENT, 40);

    const invoiceInsert = calls.find((c) => c.table === "invoices" && c.op === "insert");
    expect(invoiceInsert?.payload).toMatchObject({
      conversation_id: "conv-1",
      order_id: "order-1",
      contact_id: "contact-1",
      subtotal: 18,
      total: 18,
      bcv_rate: 40,
    });
    expect(invoice.number).toBe(1);
    expect(invoice.status).toBe("draft");

    // Deja rastro en la conversación, como el resto de mutaciones de venta.
    const systemEvent = calls.find((c) => c.table === "messages" && c.op === "insert");
    expect((systemEvent?.payload as { content: string }).content).toContain("generó la factura SBK-000001");
  });

  it("sin orden registrada, falla con el mensaje claro y no llega a insertar nada", async () => {
    const { client, calls } = createFakeInvoiceSupabase({ orderId: null });

    await expect(createInvoiceForSale(client, SALE, AGENT, 40)).rejects.toThrow(
      "Esta venta no tiene orden registrada"
    );
    expect(calls.some((c) => c.table === "invoices")).toBe(false);
  });

  it("issueInvoice pasa a issued con quién y cuándo, y deja rastro en la conversación", async () => {
    const { client, calls } = createFakeInvoiceSupabase();

    const invoice = await issueInvoice(client, "inv-1", AGENT);

    const update = calls.find((c) => c.table === "invoices" && c.op === "update");
    expect(update?.payload).toMatchObject({ status: "issued", issued_by: "agent-1" });
    expect((update?.payload as { issued_at: string }).issued_at).toEqual(expect.any(String));
    expect(invoice.status).toBe("issued");

    const systemEvent = calls.find((c) => c.table === "messages" && c.op === "insert");
    expect((systemEvent?.payload as { content: string }).content).toContain("emitió la factura SBK-000001");
  });

  it("voidInvoice pasa a void sin pedir agente", async () => {
    const { client, calls } = createFakeInvoiceSupabase();

    const invoice = await voidInvoice(client, "inv-1");

    const update = calls.find((c) => c.table === "invoices" && c.op === "update");
    expect(update?.payload).toMatchObject({ status: "void" });
    expect((update?.payload as { voided_at: string }).voided_at).toEqual(expect.any(String));
    expect(invoice.status).toBe("void");
  });
});

/**
 * T6 (8/9/2026): "Agregar contacto" desde la bandeja. El fake reproduce las
 * tres tablas que toca la mutación -- `whatsapp_channels` (vía
 * `fetchDefaultChannel`, ya probado aparte en `data.test.ts`), `contacts` y
 * `conversations` -- y deja simular el código `23505` (unique_violation) de
 * Postgres en cualquiera de los dos inserts, que es el camino real: repetir
 * el mismo teléfono es el caso de uso más probable, no un error.
 */
describe("createContactConversation — un contacto nace desde la bandeja", () => {
  interface ContactConversationFakeOptions {
    channelRow?: { id: string; status: string } | null;
    contactInsertError?: { code: string } | null;
    existingContactId?: string;
    conversationInsertError?: { code: string } | null;
    existingConversationId?: string;
  }

  function createContactFlowSupabase(options: ContactConversationFakeOptions = {}) {
    const calls: { table: string; op: "insert"; payload: unknown }[] = [];
    const channelRow = options.channelRow === undefined ? { id: "chan-1", status: "connected" } : options.channelRow;

    const client = {
      from(table: string) {
        if (table === "whatsapp_channels") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () =>
                    channelRow && channelRow.status === "connected"
                      ? { data: [channelRow], error: null }
                      : { data: [], error: null },
                }),
              }),
              order: () => ({
                limit: async () => (channelRow ? { data: [channelRow], error: null } : { data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () =>
                    options.contactInsertError
                      ? { data: null, error: options.contactInsertError }
                      : { data: { id: "contact-new" }, error: null },
                }),
              };
            },
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { id: options.existingContactId ?? "contact-existing" }, error: null }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () =>
                    options.conversationInsertError
                      ? { data: null, error: options.conversationInsertError }
                      : { data: { id: "conv-new" }, error: null },
                }),
              };
            },
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: { id: options.existingConversationId ?? "conv-existing" }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "messages") {
          return {
            insert: async (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return { error: null };
            },
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("crea contacto y conversación nuevos, y deja la nota interna de auditoría", async () => {
    const { client, calls } = createContactFlowSupabase();

    const result = await createContactConversation(client, {
      displayName: "Pedro Pérez",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-new", existed: false });

    const contactInsert = calls.find((c) => c.table === "contacts");
    expect(contactInsert?.payload).toEqual({ display_name: "Pedro Pérez", phone_number: "+584141234567" });

    const conversationInsert = calls.find((c) => c.table === "conversations");
    expect(conversationInsert?.payload).toEqual({
      contact_id: "contact-new",
      whatsapp_channel_id: "chan-1",
      status: "open",
    });

    const noteInsert = calls.find((c) => c.table === "messages");
    expect(noteInsert?.payload).toMatchObject({
      conversation_id: "conv-new",
      direction: "outbound",
      sender_type: "system",
      sender_agent_id: AGENT.id,
      message_type: "system_event",
      is_internal_note: true,
      content: "Contacto agregado desde la bandeja por José Riera",
    });
  });

  it("sin ningún canal de WhatsApp configurado, no crea nada y lanza", async () => {
    const { client, calls } = createContactFlowSupabase({ channelRow: null });

    await expect(
      createContactConversation(client, { displayName: "Pedro", phoneNumber: "+584141234567", agent: AGENT })
    ).rejects.toThrow(/ningún canal/i);

    expect(calls).toEqual([]);
  });

  it("un teléfono repetido (23505 en contacts) reutiliza el contacto y marca existed sin dejar nota", async () => {
    const { client, calls } = createContactFlowSupabase({
      contactInsertError: { code: "23505" },
      existingContactId: "contact-existing",
    });

    const result = await createContactConversation(client, {
      displayName: "Pedro",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-new", existed: true });

    const conversationInsert = calls.find((c) => c.table === "conversations");
    expect(conversationInsert?.payload).toMatchObject({ contact_id: "contact-existing" });

    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("una conversación repetida (23505 en conversations) reutiliza esa conversación y marca existed", async () => {
    const { client, calls } = createContactFlowSupabase({
      conversationInsertError: { code: "23505" },
      existingConversationId: "conv-repetida",
    });

    const result = await createContactConversation(client, {
      displayName: "Pedro",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-repetida", existed: true });
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("un error de la base que no es 23505 sube tal cual, no se traga", async () => {
    const { client } = createContactFlowSupabase({
      contactInsertError: { code: "42501" },
    });

    await expect(
      createContactConversation(client, { displayName: "Pedro", phoneNumber: "+584141234567", agent: AGENT })
    ).rejects.toEqual({ code: "42501" });
  });
});
