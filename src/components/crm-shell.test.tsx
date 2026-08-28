/** @vitest-environment jsdom */
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

let inboxProps: { conversations: Conversation[]; hasMore: boolean } | null = null;

vi.mock("@/components/inbox/inbox-sidebar", () => ({
  InboxSidebar: ({
    conversations,
    onSelect,
    hasMore,
    onLoadMore,
  }: {
    conversations: Conversation[];
    onSelect: (id: string) => void;
    hasMore: boolean;
    onLoadMore: () => void;
  }) => ((inboxProps = { conversations, hasMore }),
  (
    <>
      {conversations.map((c) => (
        <button key={c.id} type="button" onClick={() => onSelect(c.id)}>
          abrir {c.id}
        </button>
      ))}
      {hasMore && (
        <button type="button" onClick={onLoadMore}>
          cargar más
        </button>
      )}
    </>
  )),
}));
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
// El detalle del chat abierto se pide por id: se responde con la conversación
// construida para ese id, como haría la base.
const fetchConversationMock = vi.fn(
  (_supabase: unknown, id: string) => Promise.resolve(buildConversation({ id }))
);
const fetchInboxCountsMock = vi.fn().mockResolvedValue({ pending: 0, pendingStale: 0, mine: 0 });
// La fila suelta que se pide cuando el evento trae un cambio con relaciones.
const fetchConversationRowMock = vi.fn(
  (_supabase: unknown, id: string) => Promise.resolve(buildConversation({ id }))
);

const fetchAgentSettingsMock = vi.fn().mockResolvedValue({
  aiGloballyEnabled: true,
  dailySpendCapUsd: null,
  spentTodayUsd: 0,
});

vi.mock("@/lib/data", () => ({
  fetchAgentSettings: (...args: unknown[]) => fetchAgentSettingsMock(...args),
  CHAT_MESSAGES_WINDOW: 100,
  INBOX_PAGE_SIZE: 30,
  fetchConversation: (...args: unknown[]) =>
    fetchConversationMock(...(args as [unknown, string])),
  fetchConversationRow: (...args: unknown[]) =>
    fetchConversationRowMock(...(args as [unknown, string])),
  fetchConversations: (...args: unknown[]) => fetchConversationsMock(...args),
  fetchInboxCounts: (...args: unknown[]) => fetchInboxCountsMock(...args),
  fetchMessages: (...args: unknown[]) => fetchMessagesMock(...args),
  fetchMessagesBefore: vi.fn().mockResolvedValue([]),
  fetchNotes: vi.fn().mockResolvedValue([]),
  fetchQuickReplies: vi.fn().mockResolvedValue([]),
  fetchTags: vi.fn().mockResolvedValue([]),
  fetchTemplates: vi.fn().mockResolvedValue([]),
}));

const markConversationReadMock = vi.fn().mockResolvedValue(undefined);

const markConversationUnreadMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/mutations", () => ({
  markConversationRead: (...args: unknown[]) => markConversationReadMock(...args),
  markConversationUnread: (...args: unknown[]) => markConversationUnreadMock(...args),
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
    lastCustomerMessageAt: new Date().toISOString(),
    hasReply: false,
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
    createdAt: new Date().toISOString(),
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...overrides,
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
const agentSettings = { aiGloballyEnabled: true, dailySpendCapUsd: null, spentTodayUsd: 0 };
const initialQuickReplies: QuickReply[] = [];
const inboxCounts = { pending: 0, pendingStale: 0, mine: 0 };

beforeEach(() => {
  fake = createFakeSupabase();
  fetchConversationsMock.mockClear();
  fetchConversationMock.mockClear();
  fetchConversationRowMock.mockClear();
  fetchInboxCountsMock.mockClear();
  fetchMessagesMock.mockClear();
  fetchMessagesMock.mockResolvedValue([]); // cada test decide qué mensajes hay
  markConversationReadMock.mockClear();
  markConversationUnreadMock.mockClear();
  fetchAgentSettingsMock.mockClear();
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
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
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
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
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
      initialInboxCounts={inboxCounts}
      allTags={allTags}
      initialQuickReplies={initialQuickReplies}
      bcvRate={null}
      initialAgentSettings={agentSettings}
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
    whatsappError: null,
    reactionEmoji: null,
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
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
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

describe("CrmShell — abrir un chat apartado a mano lo da por leído", () => {
  it("limpia el apartado aunque no queden mensajes sin leer", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation({ unreadCount: 0, manuallyUnread: true })]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {});

    expect(markConversationReadMock).toHaveBeenCalledTimes(1);
  });
});

describe("CrmShell — cambiar de conversación no muestra el chat anterior", () => {
  it("suelta los mensajes del chat viejo apenas se elige otro", async () => {
    const deLaUna = { ...outboundMessage("read"), id: "m-uno", content: "Mensaje de la conversación uno" };
    const deLaDos = { ...outboundMessage("sent"), id: "m-dos", content: "Mensaje de la conversación dos" };

    fetchMessagesMock.mockResolvedValue([deLaUna]);
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[
          buildConversation(),
          buildConversation({ id: "conv-2", contact: { ...buildConversation().contact, id: "contact-2" } }),
        ]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {});
    expect(screen.getByText("Mensaje de la conversación uno")).toBeInTheDocument();

    // El fetch del chat nuevo queda en vuelo a propósito: es justo el hueco
    // en el que el asesor estaba viendo la conversación equivocada.
    let resolverElFetch: (m: Message[]) => void = () => {};
    fetchMessagesMock.mockReturnValue(new Promise<Message[]>((r) => { resolverElFetch = r; }));

    act(() => {
      screen.getByRole("button", { name: "abrir conv-2" }).click();
    });

    expect(screen.queryByText("Mensaje de la conversación uno")).not.toBeInTheDocument();

    await act(async () => {
      resolverElFetch([deLaDos]);
    });
    expect(screen.getByText("Mensaje de la conversación dos")).toBeInTheDocument();
  });
});

/**
 * Un asesor deja el CRM abierto en una pestaña todo el día. Cada evento de
 * realtime dispara un refetch de la bandeja entera —200 conversaciones, unos
 * 230 KB— y con varios agentes conectados eso es trabajo constante que nadie
 * está mirando. Mientras la pestaña está oculta se calla, y al volver se
 * pone al día de una vez.
 */
describe("CrmShell — la bandeja no se refresca contra una pestaña que nadie mira", () => {
  function ocultarPestana(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("con la pestaña oculta, un cambio en realtime no dispara el refetch", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockClear();

    act(() => ocultarPestana(true));
    act(() => {
      fake.trigger("conversations", "UPDATE");
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).not.toHaveBeenCalled();
  });

  it("al volver a la pestaña se pone al día de una sola vez", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockClear();

    act(() => ocultarPestana(true));
    act(() => {
      fake.trigger("conversations", "UPDATE");
      fake.trigger("conversations", "UPDATE");
      fake.trigger("conversations", "UPDATE");
    });

    await act(async () => {
      ocultarPestana(false);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * El interruptor general de la IA se toca desde Control de IA, que es otra
 * pantalla. Sin escucharlo, el cartel de la bandeja se queda con lo que
 * había al cargar — que es exactamente cómo llegó a decir "la IA sigue
 * respondiendo" con la IA apagada para todo el CRM.
 */
describe("CrmShell — el interruptor general de la IA se sigue en vivo", () => {
  it("al cambiar agent_settings vuelve a preguntar por el estado de la IA", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchAgentSettingsMock.mockClear();

    await act(async () => {
      fake.trigger("agent_settings", "UPDATE");
    });

    expect(fetchAgentSettingsMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cada evento de realtime pedía la bandeja entera: 200 conversaciones con
 * siete relaciones cada una, unos 230 KB medidos. Y los eventos no son pocos
 * —cada confirmación de entrega toca la conversación, así que un solo mensaje
 * saliente genera tres—, multiplicado por los agentes conectados.
 *
 * El evento ya trae la fila nueva. Cuando lo que cambió son datos propios de
 * la conversación, no hace falta volver a pedir nada: se aplica y listo. El
 * refetch queda para lo que el evento no puede traer —una conversación que no
 * estaba, o un cambio que arrastra relaciones (el agente asignado, la venta)—.
 */
describe("CrmShell — la bandeja no se rearma entera por cada cambio", () => {
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

  function montar() {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockClear();
  }

  it("un cambio propio de la conversación no vuelve a pedir la bandeja", async () => {
    montar();

    act(() => {
      fake.trigger("conversations", "UPDATE", filaDeConversacion());
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).not.toHaveBeenCalled();
  });

  it("pero sí aplica lo que cambió: el contador de no leídos queda al día", async () => {
    montar();

    act(() => {
      fake.trigger("conversations", "UPDATE", filaDeConversacion({ unread_count: 7 }));
    });

    // La bandeja está mockeada, así que se mira lo que se le pasó.
    expect(inboxProps?.conversations[0].unreadCount).toBe(7);
  });

  it("una conversación que no estaba en la lista sí obliga a pedirla", async () => {
    montar();

    act(() => {
      fake.trigger("conversations", "INSERT", filaDeConversacion({ id: "conv-nueva" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });

  it("cambiar de agente asignado pide esa fila, no la bandeja", async () => {
    montar();

    act(() => {
      fake.trigger("conversations", "UPDATE", filaDeConversacion({ assigned_agent_id: "agent-9" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    // El evento trae el id del asesor, no quién es: hay que ir a buscarlo.
    // Pero es una línea de la lista, no la lista.
    expect(fetchConversationRowMock).toHaveBeenCalledTimes(1);
    expect(fetchConversationRowMock.mock.calls[0][1]).toBe("conv-1");
    expect(fetchConversationsMock).not.toHaveBeenCalled();
  });

  it("cerrar la venta pide esa fila: el monto vive en otra tabla", async () => {
    montar();

    act(() => {
      fake.trigger("conversations", "UPDATE", filaDeConversacion({ deal_status: "won" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationRowMock).toHaveBeenCalledTimes(1);
    expect(fetchConversationsMock).not.toHaveBeenCalled();
  });

  it("la fila que vuelve reemplaza a la vieja en la bandeja", async () => {
    montar();
    fetchConversationRowMock.mockResolvedValueOnce(
      buildConversation({
        id: "conv-1",
        assignedAgent: { ...currentAgent, id: "agent-9", displayName: "Luis" },
      })
    );

    act(() => {
      fake.trigger("conversations", "UPDATE", filaDeConversacion({ assigned_agent_id: "agent-9" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(inboxProps?.conversations[0].assignedAgent?.displayName).toBe("Luis");
  });

  it("una etiqueta puesta o quitada obliga a pedirla: no viaja en la fila", async () => {
    montar();

    act(() => {
      fake.trigger("contact_tags", "INSERT", {});
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Bajar por la bandeja pedía `limit` creciente desde la fila 0 y reemplazaba
 * la lista: seis bajadas costaban 135 KB y 1,2 s medidos en producción — más
 * que las 200 filas de una sola vez que se quiso eliminar. Cada tirada tiene
 * que costar una página, sin importar cuántas se lleven bajadas.
 */
describe("CrmShell — bajar por la bandeja cuesta una página, no todo otra vez", () => {
  /** Una bandeja llena hasta el tope de la primera página: hay más detrás. */
  function paginaLlena(desde: number) {
    return Array.from({ length: 30 }, (_, i) => buildConversation({ id: `conv-${desde + i}` }));
  }

  it("pide la página siguiente por desplazamiento y la pega al final", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={paginaLlena(0)}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockClear();
    fetchConversationsMock.mockResolvedValueOnce(paginaLlena(30));

    await act(async () => {
      screen.getByRole("button", { name: "cargar más" }).click();
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
    expect(fetchConversationsMock.mock.calls[0][1]).toEqual({ offset: 30, limit: 30 });
    // Concatenadas, no reemplazadas: las primeras 30 siguen ahí.
    expect(inboxProps?.conversations).toHaveLength(60);
    expect(inboxProps?.conversations[0].id).toBe("conv-0");
    expect(inboxProps?.conversations[59].id).toBe("conv-59");
  });

  it("una página corta cierra el ofrecimiento: no hay nada más atrás", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={paginaLlena(0)}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockResolvedValueOnce([buildConversation({ id: "conv-30" })]);

    await act(async () => {
      screen.getByRole("button", { name: "cargar más" }).click();
    });

    expect(inboxProps?.conversations).toHaveLength(31);
    expect(inboxProps?.hasMore).toBe(false);
  });

  it("el refresco en vivo pide solo la cabecera y conserva lo que se bajó", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={paginaLlena(0)}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockResolvedValueOnce(paginaLlena(30));
    await act(async () => {
      screen.getByRole("button", { name: "cargar más" }).click();
    });
    fetchConversationsMock.mockClear();

    // Una conversación que no estaba: es lo que obliga a preguntar por la lista.
    fetchConversationsMock.mockResolvedValueOnce(paginaLlena(0));
    act(() => {
      fake.trigger("conversations", "INSERT", { id: "conv-nueva" });
    });
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    // Una página, no las 60 que hay en pantalla.
    expect(fetchConversationsMock.mock.calls[0][1]).toEqual({ limit: 30 });
    expect(inboxProps?.conversations).toHaveLength(60);
  });
});

/**
 * Aplicar los cambios en memoria quita la red que había: antes, cualquier
 * desincronización se corregía sola en el siguiente refetch. Si un campo se
 * queda sin mapear, ahora la bandeja mostraría el valor viejo para siempre.
 * Una pasada de fondo, espaciada, devuelve esa reparación sin volver al
 * coste de antes.
 */
describe("CrmShell — red de seguridad contra la deriva", () => {
  it("cada tanto vuelve a pedir la bandeja aunque no haya pasado nada", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
  });

  it("no la pide si nadie está mirando la pestaña", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      render(
        <CrmShell
          currentAgent={currentAgent}
          initialConversations={[buildConversation()]}
          initialInboxCounts={inboxCounts}
          allTags={allTags}
          initialQuickReplies={initialQuickReplies}
          bcvRate={null}
          initialAgentSettings={agentSettings}
        />
      );
      fetchConversationsMock.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(fetchConversationsMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    }
  });
});
