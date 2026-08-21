import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { CrmShell } from "@/components/crm-shell";
import type { Agent, Conversation, QuickReply, Tag } from "@/lib/types";

type ChannelHandler = (payload: unknown) => void;

/**
 * Fake mínimo del cliente realtime de Supabase: registra los handlers por
 * tabla para poder disparar eventos "postgres_changes" desde el test, igual
 * que haría Supabase al llegar un cambio real.
 */
function createFakeSupabase() {
  const handlersByTable = new Map<string, ChannelHandler[]>();

  const channel = {
    on(_event: string, filter: { table: string }, handler: ChannelHandler) {
      const list = handlersByTable.get(filter.table) ?? [];
      list.push(handler);
      handlersByTable.set(filter.table, list);
      return channel;
    },
    subscribe() {
      return channel;
    },
  };

  return {
    supabase: {
      channel: () => channel,
      removeChannel: () => {},
      auth: { signOut: vi.fn() },
    },
    trigger(table: string) {
      for (const handler of handlersByTable.get(table) ?? []) handler({ new: {} });
    },
  };
}

let fake: ReturnType<typeof createFakeSupabase>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => fake.supabase,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/inbox/inbox-sidebar", () => ({ InboxSidebar: () => null }));
vi.mock("@/components/chat/chat-panel", () => ({ ChatPanel: () => null }));
vi.mock("@/components/context-panel/context-panel", () => ({ ContextPanel: () => null }));

const fetchConversationsMock = vi.fn().mockResolvedValue([]);
const fetchMessagesMock = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/data", () => ({
  fetchConversations: (...args: unknown[]) => fetchConversationsMock(...args),
  fetchMessages: (...args: unknown[]) => fetchMessagesMock(...args),
  fetchNotes: vi.fn().mockResolvedValue([]),
  fetchQuickReplies: vi.fn().mockResolvedValue([]),
  fetchTags: vi.fn().mockResolvedValue([]),
  fetchTemplates: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/mutations", () => ({
  markConversationRead: vi.fn().mockResolvedValue(undefined),
}));

function buildConversation(): Conversation {
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
    lastCustomerMessageAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: null,
    createdAt: new Date().toISOString(),
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
  };
}

const currentAgent: Agent = {
  id: "agent-1",
  displayName: "Agente",
  fullName: "Agente de Prueba",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

const allTags: Tag[] = [];
const initialQuickReplies: QuickReply[] = [];

beforeEach(() => {
  fake = createFakeSupabase();
  fetchConversationsMock.mockClear();
  fetchMessagesMock.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CrmShell — debounce del refresh disparado por realtime", () => {
  it("agrupa varios cambios seguidos en 'conversations' en un solo refetch", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
      />
    );
    fetchConversationsMock.mockClear(); // descarta cualquier llamada del render inicial

    act(() => {
      fake.trigger("conversations");
      fake.trigger("conversations");
      fake.trigger("conversations");
    });
    expect(fetchConversationsMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });

  it("agrupa varios INSERT seguidos en 'messages' de la conversación abierta en un solo refetch", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {}); // deja resolver el fetch inicial de la conversación seleccionada
    fetchMessagesMock.mockClear();

    act(() => {
      fake.trigger("messages");
      fake.trigger("messages");
      fake.trigger("messages");
    });
    expect(fetchMessagesMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchMessagesMock).toHaveBeenCalledTimes(1);
  });
});
