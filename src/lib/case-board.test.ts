import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationSummary, Tag } from "@/lib/types";
import {
  CASE_BOARD_LIMIT,
  UNTAGGED_COLUMN_ID,
  buildCaseBoard,
  planTagMove,
} from "@/lib/case-board";
import { fetchCaseBoard } from "@/lib/data";

/**
 * El tablero de Casos (T7, plan "La ronda del cliente", 30/9/2026): una
 * columna por etiqueta del CONTACTO, «Sin etiqueta» al final, y arrastrar
 * una tarjeta cambia la etiqueta. Las reglas viven acá, puras, para poder
 * probarlas sin levantar React ni Supabase.
 */

const NOW = new Date("2026-09-30T15:00:00Z");

const TAGS: Tag[] = [
  { id: "t-reclamo", label: "Reclamo", color: "danger" },
  { id: "t-cashea", label: "Cashea", color: "success" },
  { id: "t-envio", label: "Envío", color: "accent" },
  { id: "t-vacia", label: "Garantía", color: "warning" },
];

function conv(
  id: string,
  opts: {
    tags?: string[];
    lastMessageAt?: string | null;
    name?: string | null;
    phone?: string;
    agentId?: string | null;
    waitingSince?: string | null;
  } = {}
): ConversationSummary {
  const tags = (opts.tags ?? []).map((tagId) => TAGS.find((t) => t.id === tagId)!);
  return {
    id,
    contact: {
      id: `c-${id}`,
      phoneNumber: opts.phone ?? "+584141234567",
      displayName: opts.name === undefined ? `Cliente ${id}` : opts.name,
      profileName: null,
      avatarUrl: null,
      tags,
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: opts.agentId ? { id: opts.agentId, displayName: `Asesor ${opts.agentId}` } : null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: opts.waitingSince ?? null,
    lastMessageAt: opts.lastMessageAt === undefined ? "2026-09-30T14:00:00Z" : opts.lastMessageAt,
    lastReplyAt: opts.waitingSince ? null : "2026-09-30T14:00:00Z",
    lastReplySender: opts.waitingSince ? null : "ai",
    hasReply: !opts.waitingSince,
    createdAt: "2026-09-29T10:00:00Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    lastMessagePreview: "hola",
    lastMessageDirection: "inbound",
    lastMessageStatus: null,
  };
}

function ids(columns: ReturnType<typeof buildCaseBoard>, columnId: string): string[] {
  return columns.find((c) => c.id === columnId)!.cards.map((c) => c.id);
}

describe("buildCaseBoard", () => {
  it("arma una columna por etiqueta, por orden alfabético en español, y «Sin etiqueta» al final", () => {
    const columns = buildCaseBoard([], TAGS, { now: NOW });

    expect(columns.map((c) => c.label)).toEqual(["Cashea", "Envío", "Garantía", "Reclamo", "Sin etiqueta"]);
    expect(columns[columns.length - 1].id).toBe(UNTAGGED_COLUMN_ID);
    expect(columns[columns.length - 1].color).toBeNull();
  });

  it("deja presentes las etiquetas vacías, con conteo cero", () => {
    const columns = buildCaseBoard([conv("a", { tags: ["t-reclamo"] })], TAGS, { now: NOW });
    const vacia = columns.find((c) => c.id === "t-vacia")!;
    expect(vacia.cards).toEqual([]);
    expect(vacia.count).toBe(0);
    expect(vacia.color).toBe("warning");
  });

  it("agrupa cada chat bajo las etiquetas de su contacto, y el que no tiene ninguna va a «Sin etiqueta»", () => {
    const columns = buildCaseBoard(
      [conv("a", { tags: ["t-reclamo"] }), conv("b"), conv("c", { tags: ["t-cashea"] })],
      TAGS,
      { now: NOW }
    );

    expect(ids(columns, "t-reclamo")).toEqual(["a"]);
    expect(ids(columns, "t-cashea")).toEqual(["c"]);
    expect(ids(columns, UNTAGGED_COLUMN_ID)).toEqual(["b"]);
    expect(columns.find((c) => c.id === "t-reclamo")!.count).toBe(1);
  });

  it("un contacto con dos etiquetas sale en las DOS columnas (las etiquetas son del contacto)", () => {
    const columns = buildCaseBoard([conv("a", { tags: ["t-reclamo", "t-envio"] })], TAGS, { now: NOW });

    expect(ids(columns, "t-reclamo")).toEqual(["a"]);
    expect(ids(columns, "t-envio")).toEqual(["a"]);
    expect(ids(columns, UNTAGGED_COLUMN_ID)).toEqual([]);
  });

  it("una etiqueta del contacto que todavía no está en la lista de etiquetas no hace desaparecer el chat", () => {
    const huerfana = conv("a");
    huerfana.contact.tags = [{ id: "t-nueva", label: "Nueva", color: "default" }];
    const columns = buildCaseBoard([huerfana], TAGS, { now: NOW });

    expect(ids(columns, "t-nueva")).toEqual(["a"]);
  });

  it("dentro de cada columna pone arriba el chat más reciente, y los que no tienen mensajes al fondo", () => {
    const columns = buildCaseBoard(
      [
        conv("viejo", { tags: ["t-reclamo"], lastMessageAt: "2026-09-29T09:00:00Z" }),
        conv("sin", { tags: ["t-reclamo"], lastMessageAt: null }),
        conv("nuevo", { tags: ["t-reclamo"], lastMessageAt: "2026-09-30T14:59:00Z" }),
      ],
      TAGS,
      { now: NOW }
    );

    expect(ids(columns, "t-reclamo")).toEqual(["nuevo", "viejo", "sin"]);
  });

  it("cuenta los atascados de cada columna con la definición única de siempre (isStalled)", () => {
    const columns = buildCaseBoard(
      [
        conv("espera", { tags: ["t-reclamo"], waitingSince: "2026-09-30T12:00:00Z" }),
        conv("recien", { tags: ["t-reclamo"], waitingSince: "2026-09-30T14:58:00Z" }),
        conv("atendido", { tags: ["t-reclamo"] }),
      ],
      TAGS,
      { now: NOW }
    );

    expect(columns.find((c) => c.id === "t-reclamo")!.stalled).toBe(1);
    expect(columns.find((c) => c.id === "t-cashea")!.stalled).toBe(0);
  });

  it("la búsqueda ignora acentos y mayúsculas y encuentra por teléfono", () => {
    const chats = [
      conv("a", { name: "José Pérez", phone: "+584141112233" }),
      conv("b", { name: "Maria", phone: "+584249998877" }),
    ];

    expect(ids(buildCaseBoard(chats, TAGS, { now: NOW, query: "jose PEREZ" }), UNTAGGED_COLUMN_ID)).toEqual(["a"]);
    expect(ids(buildCaseBoard(chats, TAGS, { now: NOW, query: "maría" }), UNTAGGED_COLUMN_ID)).toEqual(["b"]);
    expect(ids(buildCaseBoard(chats, TAGS, { now: NOW, query: "0424 999" }), UNTAGGED_COLUMN_ID)).toEqual(["b"]);
    expect(ids(buildCaseBoard(chats, TAGS, { now: NOW, query: "  " }), UNTAGGED_COLUMN_ID)).toEqual(["a", "b"]);
  });

  it("la búsqueda encuentra por el nombre de perfil aunque el contacto tenga otro nombre guardado", () => {
    const chat = conv("a", { name: "Cliente frecuente" });
    chat.contact.profileName = "Ñoño Gómez";
    expect(ids(buildCaseBoard([chat], TAGS, { now: NOW, query: "nono" }), UNTAGGED_COLUMN_ID)).toEqual(["a"]);
  });

  it("filtra por asesor asignado, y «none» deja solo los chats sin asesor", () => {
    const chats = [conv("a", { agentId: "ana" }), conv("b", { agentId: "luis" }), conv("c")];

    expect(ids(buildCaseBoard(chats, TAGS, { now: NOW, agentId: "ana" }), UNTAGGED_COLUMN_ID)).toEqual(["a"]);
    expect(ids(buildCaseBoard(chats, TAGS, { now: NOW, agentId: "none" }), UNTAGGED_COLUMN_ID)).toEqual(["c"]);
    expect(ids(buildCaseBoard(chats, TAGS, { now: NOW, agentId: null }), UNTAGGED_COLUMN_ID)).toHaveLength(3);
  });
});

describe("planTagMove", () => {
  it("a la misma columna no hace nada", () => {
    expect(planTagMove("t-reclamo", "t-reclamo", ["t-reclamo"])).toBeNull();
    expect(planTagMove(UNTAGGED_COLUMN_ID, UNTAGGED_COLUMN_ID, [])).toBeNull();
  });

  it("desde «Sin etiqueta» solo pone la de destino", () => {
    expect(planTagMove(UNTAGGED_COLUMN_ID, "t-cashea", [])).toEqual({ add: "t-cashea" });
  });

  it("hacia «Sin etiqueta» solo quita la de origen", () => {
    expect(planTagMove("t-reclamo", UNTAGGED_COLUMN_ID, ["t-reclamo"])).toEqual({ remove: "t-reclamo" });
  });

  it("si el contacto ya tiene la de destino, solo quita la de origen", () => {
    expect(planTagMove("t-reclamo", "t-envio", ["t-reclamo", "t-envio"])).toEqual({ remove: "t-reclamo" });
  });

  it("de una etiqueta a otra, quita la de origen y pone la de destino", () => {
    expect(planTagMove("t-reclamo", "t-cashea", ["t-reclamo"])).toEqual({ remove: "t-reclamo", add: "t-cashea" });
  });
});

describe("fetchCaseBoard", () => {
  function fakeSupabase(rows: unknown[]) {
    const calls: { neq: unknown[][]; order: unknown[][]; limit: number[] } = { neq: [], order: [], limit: [] };
    const builder = {
      select: vi.fn(() => builder),
      neq: vi.fn((...args: unknown[]) => {
        calls.neq.push(args);
        return builder;
      }),
      order: vi.fn((...args: unknown[]) => {
        calls.order.push(args);
        return builder;
      }),
      limit: vi.fn((n: number) => {
        calls.limit.push(n);
        return Promise.resolve({ data: rows.slice(0, n), error: null });
      }),
    };
    const supabase = { from: vi.fn(() => builder) } as unknown as SupabaseClient;
    return { supabase, calls };
  }

  function rawRow(i: number) {
    return {
      id: `conv-${i}`,
      status: "open",
      unread_count: 0,
      manually_unread: false,
      ai_enabled: true,
      deal_status: "none",
      deal_verified: false,
      last_customer_message_at: null,
      last_message_at: null,
      last_reply_at: null,
      last_reply_sender: null,
      has_reply: false,
      created_at: "2026-09-30T10:00:00Z",
      journey_stage: null,
      intent: null,
      active_tool: null,
      welcome_sent_at: null,
      last_message_preview: null,
      last_message_direction: null,
      last_message_status: null,
      contact: {
        id: `c-${i}`,
        phone_number: "+58414",
        display_name: null,
        profile_name: null,
        avatar_url: null,
        contact_tags: [],
      },
      assigned_agent: null,
    };
  }

  // «Abiertos» = todo lo que no está cerrado (incluye `pending`), igual que
  // `activeOnly` de la bandeja: decisión del orquestador, 30/9/2026.
  it("pide todo lo que no está cerrado, del más reciente al más viejo, con uno de más para saber si hay corte", async () => {
    const { supabase, calls } = fakeSupabase([rawRow(1)]);
    const result = await fetchCaseBoard(supabase);

    expect(calls.neq).toEqual([["status", "closed"]]);
    expect(calls.order[0]).toEqual(["last_message_at", { ascending: false, nullsFirst: false }]);
    expect(calls.limit).toEqual([CASE_BOARD_LIMIT + 1]);
    expect(result.truncated).toBe(false);
    expect(result.conversations.map((c) => c.id)).toEqual(["conv-1"]);
  });

  it("con más de 500 abiertos devuelve 500 y avisa que hubo corte", async () => {
    const rows = Array.from({ length: CASE_BOARD_LIMIT + 1 }, (_, i) => rawRow(i));
    const { supabase } = fakeSupabase(rows);
    const result = await fetchCaseBoard(supabase);

    expect(CASE_BOARD_LIMIT).toBe(500);
    expect(result.conversations).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it("lanza si la base responde con error", async () => {
    const builder = {
      select: () => builder,
      neq: () => builder,
      order: () => builder,
      limit: () => Promise.resolve({ data: null, error: { message: "caída" } }),
    };
    const supabase = { from: () => builder } as unknown as SupabaseClient;
    await expect(fetchCaseBoard(supabase)).rejects.toEqual({ message: "caída" });
  });
});
