import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useLiveConversations } from "@/lib/use-live-conversations";
import type { Conversation } from "@/lib/types";

/**
 * El hook es el carril compartido por las cuatro vistas que siguen la lista
 * de conversaciones en vivo (bandeja, tablero, ventas, control de IA). Los
 * tests de CrmShell ya lo ejercitan a través de la bandeja; estos lo clavan
 * directo, porque un fallo acá se multiplica por cada vista y cada pestaña.
 */

type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";
type ChannelHandler = (payload: { eventType: RealtimeEvent; new: Record<string, unknown> }) => void;

function createFakeSupabase() {
  const subscriptionsByTable = new Map<string, ChannelHandler[]>();

  const channel = {
    on(_type: string, config: { table: string }, handler: ChannelHandler) {
      const list = subscriptionsByTable.get(config.table) ?? [];
      list.push(handler);
      subscriptionsByTable.set(config.table, list);
      return channel;
    },
    subscribe() {
      return channel;
    },
  };

  return {
    supabase: { channel: () => channel, removeChannel: () => {} } as unknown as SupabaseClient,
    trigger(table: string, eventType: RealtimeEvent, row: Record<string, unknown> = {}) {
      for (const handler of subscriptionsByTable.get(table) ?? []) {
        handler({ eventType, new: row });
      }
    },
  };
}

const fetchConversationsMock = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/data", () => ({
  fetchConversations: (...args: unknown[]) => fetchConversationsMock(...args),
}));

function buildConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    contact: {
      id: "contact-1",
      phoneNumber: "+58123456789",
      displayName: "Cliente de Prueba",
      profileName: "Cliente",
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: [],
    },
    channel: {
      id: "channel-1",
      label: "Principal",
      phoneNumber: "+58000000000",
      phoneNumberId: "phone-id-1",
      status: "connected",
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: false,
    dealStatus: "none",
    dealClosedAt: null,
    dealPaymentProofUrl: null,
    dealAmount: null,
    dealCurrency: null,
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: null,
    dealClosedBy: null,
    lastCustomerMessageAt: "2026-08-24T15:00:00.000Z",
    lastMessageAt: "2026-08-24T15:00:00.000Z",
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
    createdAt: "2026-08-24T15:00:00.000Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...overrides,
  };
}

function filaDeConversacion(over: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    unread_count: 3,
    manually_unread: false,
    ai_enabled: false,
    status: "open",
    assigned_agent_id: null,
    deal_status: "none",
    deal_verified: false,
    last_message_at: "2026-08-24T15:00:00.000Z",
    last_message_preview: "¿Tienen el carburador?",
    last_message_direction: "inbound",
    last_message_status: null,
    last_customer_message_at: "2026-08-24T15:00:00.000Z",
    journey_stage: null,
    intent: null,
    active_tool: null,
    welcome_sent_at: null,
    ...over,
  };
}

let fake: ReturnType<typeof createFakeSupabase>;

beforeEach(() => {
  fake = createFakeSupabase();
  fetchConversationsMock.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

function montar() {
  return renderHook(() => useLiveConversations(fake.supabase, [buildConversation()]));
}

describe("useLiveConversations — el evento se aplica en memoria cuando alcanza", () => {
  it("un cambio propio de la conversación no vuelve a pedir la lista, pero sí se aplica", async () => {
    const { result } = montar();

    act(() => {
      fake.trigger("conversations", "UPDATE", filaDeConversacion({ unread_count: 7 }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).not.toHaveBeenCalled();
    expect(result.current.conversations[0].unreadCount).toBe(7);
  });

  it("cambiar de agente asignado obliga a pedirla: el evento no trae quién es", async () => {
    montar();

    act(() => {
      fake.trigger("conversations", "UPDATE", filaDeConversacion({ assigned_agent_id: "agent-9" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });

  it("una conversación nueva obliga a pedirla, y varios eventos son un solo refetch", async () => {
    montar();

    act(() => {
      fake.trigger("conversations", "INSERT", filaDeConversacion({ id: "conv-nueva" }));
      fake.trigger("conversations", "INSERT", filaDeConversacion({ id: "conv-nueva-2" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });
});

describe("useLiveConversations — no trabaja contra una pestaña que nadie mira", () => {
  function ocultarPestana(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("oculta, los cambios se anotan; al volver, una sola puesta al día", async () => {
    montar();

    act(() => ocultarPestana(true));
    act(() => {
      fake.trigger("conversations", "INSERT", filaDeConversacion({ id: "conv-nueva" }));
      fake.trigger("conversations", "INSERT", filaDeConversacion({ id: "conv-nueva-2" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(fetchConversationsMock).not.toHaveBeenCalled();

    await act(async () => {
      ocultarPestana(false);
    });
    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });
});

describe("useLiveConversations — contact_tags es opcional", () => {
  it("sin watchContactTags, un cambio de etiquetas no refetchea (la vista no las pinta)", async () => {
    montar();

    act(() => {
      fake.trigger("contact_tags", "INSERT", {});
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).not.toHaveBeenCalled();
  });

  it("con watchContactTags, sí: las etiquetas no viajan en la fila", async () => {
    renderHook(() =>
      useLiveConversations(fake.supabase, [buildConversation()], { watchContactTags: true })
    );

    act(() => {
      fake.trigger("contact_tags", "INSERT", {});
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });
});
