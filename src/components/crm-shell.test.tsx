import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { CrmShell } from "@/components/crm-shell";
import { MessageBubble } from "@/components/chat/message-bubble";
import type { Agent, Conversation, Message, QuickReply, Tag } from "@/lib/types";

type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";
type ChannelHandler = (payload: { eventType: RealtimeEvent; new: Record<string, unknown> }) => void;

interface Subscription {
  event: RealtimeEvent | "*";
  handler: ChannelHandler;
}

/**
 * Fake mínimo del cliente realtime de Supabase: registra los handlers por
 * tabla —y por tipo de evento— para poder disparar eventos "postgres_changes"
 * desde el test, igual que haría Supabase al llegar un cambio real.
 *
 * Respetar el tipo de evento no es un detalle: un canal suscrito solo a
 * INSERT no debe ver los UPDATE, y ese es justamente el fallo que estos
 * tests cuidan.
 */
function createFakeSupabase() {
  const subscriptionsByTable = new Map<string, Subscription[]>();

  const channel = {
    on(
      _type: string,
      config: { event: RealtimeEvent | "*"; table: string },
      handler: ChannelHandler
    ) {
      const list = subscriptionsByTable.get(config.table) ?? [];
      list.push({ event: config.event, handler });
      subscriptionsByTable.set(config.table, list);
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
    trigger(
      table: string,
      eventType: RealtimeEvent = "INSERT",
      row: Record<string, unknown> = {}
    ) {
      for (const { event, handler } of subscriptionsByTable.get(table) ?? []) {
        if (event === "*" || event === eventType) handler({ eventType, new: row });
      }
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
vi.mock("@/components/chat/chat-panel", () => ({
  ChatPanel: ({ messages }: { messages: Message[] }) => (
    <>
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </>
  ),
}));
vi.mock("@/components/context-panel/context-panel", () => ({ ContextPanel: () => null }));

const fetchConversationsMock = vi.fn().mockResolvedValue([]);
const fetchMessagesMock = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/data", () => ({
  CHAT_MESSAGES_WINDOW: 100,
  INBOX_CONVERSATIONS_LIMIT: 200,
  fetchConversations: (...args: unknown[]) => fetchConversationsMock(...args),
  fetchMessages: (...args: unknown[]) => fetchMessagesMock(...args),
  fetchMessagesBefore: vi.fn().mockResolvedValue([]),
  fetchNotes: vi.fn().mockResolvedValue([]),
  fetchQuickReplies: vi.fn().mockResolvedValue([]),
  fetchTags: vi.fn().mockResolvedValue([]),
  fetchTemplates: vi.fn().mockResolvedValue([]),
}));

const markConversationReadMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/mutations", () => ({
  markConversationRead: (...args: unknown[]) => markConversationReadMock(...args),
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
    dealPaymentMethod: null,
    dealClosedBy: null,
    lastCustomerMessageAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
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
  fetchMessagesMock.mockResolvedValue([]); // cada test decide qué mensajes hay
  markConversationReadMock.mockClear();
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
        bcvRate={null}
      />
    );
    fetchConversationsMock.mockClear(); // descarta cualquier llamada del render inicial

    act(() => {
      fake.trigger("conversations", "UPDATE");
      fake.trigger("conversations", "UPDATE");
      fake.trigger("conversations", "UPDATE");
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
        bcvRate={null}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {}); // deja resolver el fetch inicial de la conversación seleccionada
    fetchMessagesMock.mockClear();

    act(() => {
      fake.trigger("messages", "INSERT");
      fake.trigger("messages", "INSERT");
      fake.trigger("messages", "INSERT");
    });
    expect(fetchMessagesMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchMessagesMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Helper: monta la shell con una conversación abierta y deja resolver la
 * carga inicial, que es lo que todos los tests de mensajes necesitan antes
 * de poder disparar eventos de realtime.
 */
async function renderWithOpenConversation() {
  render(
    <CrmShell
      currentAgent={currentAgent}
      initialConversations={[buildConversation()]}
      allTags={allTags}
      initialQuickReplies={initialQuickReplies}
      bcvRate={null}
      initialConversationId="conv-1"
    />
  );
  await act(async () => {});
  fetchMessagesMock.mockClear();
  markConversationReadMock.mockClear();
}

describe("CrmShell — el chat sigue los cambios sobre mensajes ya guardados", () => {
  it("repinta el chat cuando un mensaje de la conversación abierta se actualiza", async () => {
    await renderWithOpenConversation();

    // Lo que hace el after() del webhook al terminar de bajar el archivo de
    // Meta: la fila ya existe y se le rellena media_url.
    act(() => {
      fake.trigger("messages", "UPDATE", {
        direction: "inbound",
        media_url: "/api/media/conv-1/wamid.jpg",
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("repinta el chat cuando WhatsApp confirma la entrega de un mensaje saliente", async () => {
    await renderWithOpenConversation();

    // Lo que hace el webhook con value.statuses: UPDATE de whatsapp_status
    // sobre la fila del mensaje que ya se envió.
    act(() => {
      fake.trigger("messages", "UPDATE", {
        direction: "outbound",
        whatsapp_status: "read",
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("no da por leída la conversación porque un mensaje entrante se haya actualizado", async () => {
    await renderWithOpenConversation();

    // El agente puede tener el chat abierto en otra pestaña, o haberlo dejado
    // atrás: rellenar media_url no es que alguien haya leído nada.
    act(() => {
      fake.trigger("messages", "UPDATE", { direction: "inbound", media_url: "/api/media/x.jpg" });
    });

    expect(markConversationReadMock).not.toHaveBeenCalled();
  });

  it("sí da por leída la conversación cuando entra un mensaje nuevo del cliente", async () => {
    await renderWithOpenConversation();

    act(() => {
      fake.trigger("messages", "INSERT", { direction: "inbound" });
    });

    expect(markConversationReadMock).toHaveBeenCalledTimes(1);
  });
});

function outboundMessage(whatsappStatus: Message["whatsappStatus"]): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    direction: "outbound",
    senderType: "agent",
    senderAgent: null,
    messageType: "text",
    content: "Buenas, ¿en qué te ayudo?",
    templateName: null,
    mediaUrl: null,
    isInternalNote: false,
    whatsappStatus,
    replyToMessageId: null,
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

/**
 * El circuito completo del doble check —webhook de statuses → UPDATE sobre
 * messages → realtime → burbuja— nunca se ejercitó en producción: el día que
 * se escribió esto no había ni un solo mensaje saliente. Este test lo recorre
 * entero por el lado del cliente, desde el evento de realtime hasta el icono.
 */
describe("CrmShell — el doble check avanza en vivo", () => {
  it("pasa de 'Enviado' a 'Leído' cuando WhatsApp confirma la lectura", async () => {
    fetchMessagesMock.mockResolvedValue([outboundMessage("sent")]);

    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {});

    expect(screen.getByLabelText("Enviado")).toBeInTheDocument();

    // Meta confirma la lectura: el webhook hace UPDATE de whatsapp_status
    // sobre la fila que ya existe, y la base la reemite por realtime.
    fetchMessagesMock.mockResolvedValue([outboundMessage("read")]);
    act(() => {
      fake.trigger("messages", "UPDATE", { direction: "outbound", whatsapp_status: "read" });
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(screen.queryByLabelText("Enviado")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Leído")).toBeInTheDocument();
  });
});
