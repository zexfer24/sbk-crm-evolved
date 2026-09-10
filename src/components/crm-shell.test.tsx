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
let hasFocusSpy: ReturnType<typeof vi.spyOn>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => fake.supabase,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

let inboxProps: {
  conversations: Conversation[];
  hasMore: boolean;
  /** Capturado para el test de "marcar leído vuelve a pedir los contadores". */
  onMarkRead?: (id: string) => void;
  counts?: unknown;
  /** Capturado para el test de que la semilla de "Pendientes" llega hasta acá. */
  initialPendingRows?: Conversation[];
  /** El pulso de tiempo real: lo mueve, entre otros, el canal de traspasos. */
  livePulse?: number;
  /** T6 (8/9/2026): capturado para el test de "Agregar contacto". */
  onContactCreated?: (conversationId: string) => void;
} | null = null;

vi.mock("@/components/inbox/inbox-sidebar", () => ({
  InboxSidebar: ({
    conversations,
    onSelect,
    hasMore,
    onLoadMore,
    onMarkRead,
    counts,
    initialPendingRows,
    livePulse,
    onContactCreated,
  }: {
    conversations: Conversation[];
    onSelect: (id: string) => void;
    hasMore: boolean;
    onLoadMore: () => void;
    onMarkRead?: (id: string) => void;
    counts?: unknown;
    initialPendingRows?: Conversation[];
    livePulse?: number;
    onContactCreated?: (conversationId: string) => void;
  }) => ((inboxProps = {
    conversations,
    hasMore,
    onMarkRead,
    counts,
    initialPendingRows,
    livePulse,
    onContactCreated,
  }),
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
      {onContactCreated && (
        <button type="button" onClick={() => onContactCreated("conv-agregada")}>
          simular contacto agregado
        </button>
      )}
    </>
  )),
}));
vi.mock("@/components/chat/chat-panel", () => ({
  // El teléfono del contacto y el callback del botón "Abrir el chat de
  // {newPhone}" (D2, 6/9/2026; botón del 8/9/2026) se reenvían tal cual los
  // reenvía el `ChatPanel` real, para que el test del aviso de cambio de
  // número ejercite la burbuja de verdad, no una réplica del test.
  ChatPanel: ({
    messages,
    conversation,
    onOpenConversationByPhone,
  }: {
    messages: Message[];
    conversation: Conversation;
    onOpenConversationByPhone?: (phone: string) => Promise<boolean>;
  }) => (
    <>
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          contactPhone={conversation.contact.phoneNumber}
          onOpenConversationByPhone={onOpenConversationByPhone}
        />
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
const fetchInboxCountsMock = vi.fn().mockResolvedValue({ pending: 0, pendingStale: 0, mine: 0, unread: 0, unassigned: 0, escalated: 0 });
// La fila suelta que se pide cuando el evento trae un cambio con relaciones.
const fetchConversationRowMock = vi.fn(
  (_supabase: unknown, id: string) => Promise.resolve(buildConversation({ id }))
);
// "Sin dueño" (T1.6): el canal de `conversation_handoffs` la vuelve a pedir entera.
const fetchUnassignedConversationsMock = vi.fn().mockResolvedValue([]);
// El botón "Abrir el chat de {newPhone}" (D2, 6/9/2026; botón del 8/9/2026).
const fetchConversationIdByPhoneMock = vi.fn().mockResolvedValue(null);

const fetchAgentSettingsMock = vi.fn().mockResolvedValue({
  aiGloballyEnabled: true,
  dailySpendCapUsd: null,
  spentTodayUsd: 0,
});

vi.mock("@/lib/data", () => ({
  fetchAgentSettings: (...args: unknown[]) => fetchAgentSettingsMock(...args),
  // `AppRail` (que `CrmShell` monta de verdad, sin mock) trae desde T6 el
  // aviso de asignación (`AssignmentNotifier`), que pide `fetchCurrentAgent`
  // al montarse. Sin este mock, cualquier test de este archivo revienta en
  // el efecto de montaje con "No fetchCurrentAgent export is defined" — no
  // hace falta un agente real para estos tests, así que `null` alcanza.
  fetchCurrentAgent: vi.fn().mockResolvedValue(null),
  CHAT_MESSAGES_WINDOW: 100,
  INBOX_PAGE_SIZE: 30,
  fetchConversation: (...args: unknown[]) =>
    fetchConversationMock(...(args as [unknown, string])),
  fetchConversationRow: (...args: unknown[]) =>
    fetchConversationRowMock(...(args as [unknown, string])),
  fetchConversationIdByPhone: (...args: unknown[]) => fetchConversationIdByPhoneMock(...args),
  fetchConversations: (...args: unknown[]) => fetchConversationsMock(...args),
  fetchInboxCounts: (...args: unknown[]) => fetchInboxCountsMock(...args),
  fetchUnassignedConversations: (...args: unknown[]) => fetchUnassignedConversationsMock(...args),
  fetchMessages: (...args: unknown[]) => fetchMessagesMock(...args),
  fetchMessagesBefore: vi.fn().mockResolvedValue([]),
  fetchNotes: vi.fn().mockResolvedValue([]),
  fetchQuickReplies: vi.fn().mockResolvedValue([]),
  fetchTags: vi.fn().mockResolvedValue([]),
  fetchTemplates: vi.fn().mockResolvedValue([]),
}));

const markConversationReadMock = vi.fn().mockResolvedValue(undefined);

const markConversationUnreadMock = vi.fn().mockResolvedValue(undefined);

/** El doble check azul hacia Meta (T3.1, 4/9/2026): nunca lanza, así que el mock tampoco. */
const sendReadReceiptMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/mutations", () => ({
  markConversationRead: (...args: unknown[]) => markConversationReadMock(...args),
  markConversationUnread: (...args: unknown[]) => markConversationUnreadMock(...args),
  sendReadReceipt: (...args: unknown[]) => sendReadReceiptMock(...args),
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
    lastReplyAt: null,
    lastReplySender: null,
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
    referral: null,
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
const inboxCounts = {
  pending: 0,
  pendingStale: 0,
  mine: 0,
  unread: 0,
  mineUnread: 0,
  unassigned: 0,
  escalated: 0,
};

beforeEach(() => {
  fake = createFakeSupabase();
  fetchConversationsMock.mockClear();
  fetchConversationMock.mockClear();
  fetchConversationRowMock.mockClear();
  fetchInboxCountsMock.mockClear();
  fetchUnassignedConversationsMock.mockClear();
  fetchConversationIdByPhoneMock.mockClear();
  fetchConversationIdByPhoneMock.mockResolvedValue(null);
  fetchMessagesMock.mockClear();
  fetchMessagesMock.mockResolvedValue([]); // cada test decide qué mensajes hay
  markConversationReadMock.mockClear();
  markConversationUnreadMock.mockClear();
  sendReadReceiptMock.mockClear();
  fetchAgentSettingsMock.mockClear();
  // Foco de la ventana por defecto: jsdom, a diferencia de un navegador real,
  // arranca sin foco (`document.hasFocus()` en `false` mientras nada haya
  // llamado `.focus()`), y los tests de T1.1 más abajo son los únicos que
  // necesitan mover esta señal — todo lo demás asume una pestaña normal, al
  // frente y con el foco.
  hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  hasFocusSpy.mockRestore();
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

  // T1.6: el canal de "Sin dueño" es propio y angosto (conversation_handoffs,
  // no conversations) — este test cubre que agrupa igual que los otros dos,
  // no que el filtro `to_kind=eq.unassigned` se aplique de verdad (ese filtro
  // lo resuelve Supabase del lado del servidor; el fake de este archivo no lo
  // reproduce, ver createFakeSupabase arriba).
  it("agrupa varios traspasos a 'unassigned' seguidos en un solo refetch de 'Sin dueño'", async () => {
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
    const pulsoInicial = inboxProps?.livePulse ?? 0;

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT");
      fake.trigger("conversation_handoffs", "INSERT");
      fake.trigger("conversation_handoffs", "INSERT");
    });
    // Antes del debounce no se movió nada: tres traspasos seguidos (los que
    // deja el reconciliador o un lote del webhook con la IA apagada) no son
    // tres refrescos.
    expect(inboxProps?.livePulse ?? 0).toBe(pulsoInicial);

    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    // Y después, UN solo pulso. El shell no se queda con la lista: sube el
    // pulso y quien tenga abierta la píldora "Sin dueño" (InboxSidebar)
    // rehace su consulta. Guardarla acá además sería guardarla dos veces.
    expect(inboxProps?.livePulse ?? 0).toBe(pulsoInicial + 1);
  });
});

describe("CrmShell — semilla de la píldora que abre por defecto", () => {
  it("pasa initialPendingConversations a InboxSidebar como initialPendingRows", () => {
    const filaSembrada = buildConversation({ id: "conv-pendiente" });

    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation()]}
        initialInboxCounts={inboxCounts}
        initialPendingConversations={[filaSembrada]}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );

    // La reforma del 30/8/2026 devolvió el filtro por defecto de "No leídas"
    // a "Pendientes" (231 chats leídos y sin responder no aparecían en
    // ninguna píldora); esta semilla es lo que evita que esa píldora abra
    // con el cartel "Buscando…" mientras el efecto de red del sidebar hace
    // el mismo viaje desde el navegador.
    expect(inboxProps?.initialPendingRows).toEqual([filaSembrada]);
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
    expect(sendReadReceiptMock).not.toHaveBeenCalled();
  });

  it("sí da por leída la conversación cuando entra un mensaje nuevo del cliente", async () => {
    await renderWithOpenConversation();

    act(() => {
      fake.trigger("messages", "INSERT", { direction: "inbound" });
    });

    expect(markConversationReadMock).toHaveBeenCalledTimes(1);
    // El doble check azul (T3.1, 4/9/2026) viaja junto con el marcado del
    // CRM: el chat sigue abierto delante del asesor, así que de verdad se leyó.
    expect(sendReadReceiptMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * T1.1 ("La bandeja que no pierde", 4/9/2026): un chat abierto en una
 * pestaña oculta no puede dar por leído lo que entra. Antes, el INSERT
 * marcaba leído sin preguntar nada — con dos pestañas abiertas (una al
 * frente, esta de fondo con el mismo chat) un mensaje nuevo apagaba "No
 * leídas" en la de atrás sin que nadie lo hubiera visto; F5 en la de
 * adelante lo delataba porque ahí la píldora seguía encendida.
 */
describe("CrmShell — un chat abierto en una pestaña oculta no marca leído lo que entra", () => {
  function ocultarPestana(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("con la pestaña oculta, un mensaje nuevo del cliente no marca leído", async () => {
    await renderWithOpenConversation();
    ocultarPestana(true);

    act(() => {
      fake.trigger("messages", "INSERT", { direction: "inbound" });
    });

    expect(markConversationReadMock).not.toHaveBeenCalled();
    // Con la pestaña oculta tampoco se avisó a Meta: nadie miró el mensaje todavía.
    expect(sendReadReceiptMock).not.toHaveBeenCalled();
  });

  it("al volver la pestaña, el chat que sigue abierto se marca leído exactamente una vez", async () => {
    await renderWithOpenConversation();
    ocultarPestana(true);

    act(() => {
      fake.trigger("messages", "INSERT", { direction: "inbound" });
    });
    expect(markConversationReadMock).not.toHaveBeenCalled();

    act(() => ocultarPestana(false));
    expect(markConversationReadMock).toHaveBeenCalledTimes(1);
    expect(sendReadReceiptMock).toHaveBeenCalledTimes(1);

    // Un segundo regreso (otro "visibilitychange" o "focus") no repite el
    // marcado: ya no queda nada pendiente.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(markConversationReadMock).toHaveBeenCalledTimes(1);
    expect(sendReadReceiptMock).toHaveBeenCalledTimes(1);
  });

  it("si cambió de chat mientras estaba oculta, volver a la pestaña no marca el chat viejo", async () => {
    fetchMessagesMock.mockResolvedValue([]);
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation(), buildConversation({ id: "conv-2" })]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {});
    markConversationReadMock.mockClear();

    ocultarPestana(true);
    act(() => {
      fake.trigger("messages", "INSERT", { direction: "inbound" });
    });
    expect(markConversationReadMock).not.toHaveBeenCalled();

    // Cambia de chat mientras seguía oculta: el efecto de "conv-1" se limpia
    // (sus oyentes de visibilitychange/focus se sueltan) y el de "conv-2"
    // arranca sin nada pendiente.
    await act(async () => {
      screen.getByRole("button", { name: "abrir conv-2" }).click();
    });

    act(() => ocultarPestana(false));

    // Ni el chat viejo (conv-1, el que quedó pendiente) ni ningún otro:
    // los oyentes de conv-1 se soltaron al cambiar de chat.
    expect(markConversationReadMock).not.toHaveBeenCalled();
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
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
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
    // Abrir un chat apartado a mano SÍ es "de verdad se leyó": el asesor lo
    // acaba de abrir y lo tiene delante. El doble check azul viaja igual.
    expect(sendReadReceiptMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * El botón "Abrir el chat de {newPhone}" del aviso de cambio de número (D2,
 * "El cliente que cambió de número", 6/9/2026; botón del 8/9/2026): cuando
 * el número nuevo YA tenía conversación propia, el webhook deja el aviso sin
 * fusionar y el asesor necesita saltar hasta esa otra conversación desde acá.
 */
describe("CrmShell — el botón del aviso de cambio de número abre la otra conversación", () => {
  it("resuelve el id por el teléfono y selecciona esa conversación", async () => {
    const aviso: Message = {
      id: "msg-aviso",
      conversationId: "conv-1",
      direction: "outbound",
      senderType: "system",
      senderAgent: null,
      messageType: "system_event",
      content: "El cliente cambió su número de WhatsApp a +584129999999, que ya tiene conversación en el CRM",
      templateName: null,
      mediaUrl: null,
      isInternalNote: false,
      whatsappStatus: null,
      whatsappError: null,
      whatsappErrorCode: null,
      reactionEmoji: null,
      replyToMessageId: null,
      payload: {
        systemType: "user_changed_number",
        previousPhone: "+58123456789",
        newPhone: "+584129999999",
      },
      createdAt: "2026-09-08T12:00:00.000Z",
    };
    fetchMessagesMock.mockResolvedValue([aviso]);
    // conv-1 (buildConversation()) tiene phoneNumber "+58123456789", distinto
    // del newPhone del aviso: el botón se ofrece.
    fetchConversationIdByPhoneMock.mockResolvedValue("conv-2");

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
    fetchConversationMock.mockClear();

    await act(async () => {
      screen.getByRole("button", { name: /abrir el chat de \+584129999999/i }).click();
    });

    expect(fetchConversationIdByPhoneMock).toHaveBeenCalledWith(expect.anything(), "+584129999999");
    // El salto llega hasta `openConversation`, que pide el detalle por id: la
    // conversación seleccionada pasa a ser la del número nuevo.
    expect(fetchConversationMock).toHaveBeenCalledWith(expect.anything(), "conv-2");
  });

  it("cuando no hay conversación para ese teléfono, avisa en línea y no cambia de chat", async () => {
    const aviso: Message = {
      id: "msg-aviso",
      conversationId: "conv-1",
      direction: "outbound",
      senderType: "system",
      senderAgent: null,
      messageType: "system_event",
      content: "El cliente cambió su número de WhatsApp a +584129999999, que ya tiene conversación en el CRM",
      templateName: null,
      mediaUrl: null,
      isInternalNote: false,
      whatsappStatus: null,
      whatsappError: null,
      whatsappErrorCode: null,
      reactionEmoji: null,
      replyToMessageId: null,
      payload: {
        systemType: "user_changed_number",
        previousPhone: "+58123456789",
        newPhone: "+584129999999",
      },
      createdAt: "2026-09-08T12:00:00.000Z",
    };
    fetchMessagesMock.mockResolvedValue([aviso]);
    fetchConversationIdByPhoneMock.mockResolvedValue(null);

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
    fetchConversationMock.mockClear();

    await act(async () => {
      screen.getByRole("button", { name: /abrir el chat de \+584129999999/i }).click();
    });

    // No `findByText`: el archivo corre con `vi.useFakeTimers()` (beforeEach)
    // y `findByText`/`waitFor` sondean con temporizadores reales por dentro,
    // así que se cuelgan hasta el timeout de Vitest en vez de ver el estado
    // que el `await act(...)` de arriba ya asentó.
    expect(screen.getByText(/no hay conversación con ese número/i)).toBeInTheDocument();
    expect(fetchConversationMock).not.toHaveBeenCalled();
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
 * `markRead`/`markUnread` aplican el cambio en memoria por el camino corto
 * de `useLiveConversations` (no pasan por `fetchInboxHead`), así que el
 * contador de la píldora "No leídas" se quedaría con el valor viejo hasta la
 * pasada de fondo de 5 minutos si nadie lo pidiera de nuevo a mano. Por eso
 * `markRead` llama a `refreshInboxCounts` tras la escritura (crm-shell.tsx).
 */
describe("CrmShell — marcar leído vuelve a pedir los contadores", () => {
  it("tras marcar leída una conversación, fetchInboxCounts se llama de nuevo y el estado se actualiza", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation({ id: "conv-1", unreadCount: 3 })]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchInboxCountsMock.mockClear();
    const contadoresActualizados = { pending: 1, pendingStale: 0, mine: 2, unread: 5, unassigned: 0, escalated: 0 };
    fetchInboxCountsMock.mockResolvedValueOnce(contadoresActualizados);

    await act(async () => {
      await inboxProps?.onMarkRead?.("conv-1");
    });
    // `refreshInboxCounts` no se espera dentro de `markRead` (es
    // deliberadamente "fire and forget"): una vuelta más de microtareas deja
    // que su propio fetch y el `setInboxCounts` que sigue terminen de correr.
    await act(async () => {});

    expect(fetchInboxCountsMock).toHaveBeenCalledTimes(1);
    expect(inboxProps?.counts).toEqual(contadoresActualizados);
  });
});

/**
 * T6 (8/9/2026): "Agregar contacto" desde la bandeja. `NewContactModal` (con
 * sus propias pruebas) vive dentro de `InboxSidebar`, mockeado acá — lo que
 * este test fija es lo que hace `crm-shell.tsx` cuando `onContactCreated`
 * llega desde abajo: abrir el chat de la conversación recién creada Y pedir
 * la cabecera de la bandeja de nuevo (esa fila todavía no está en
 * `conversations`, nadie la bajó).
 */
describe("CrmShell — Agregar contacto abre el chat y refresca la bandeja", () => {
  it("onContactCreated selecciona la conversación y dispara un refetch de la cabecera", async () => {
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={[buildConversation({ id: "conv-1" })]}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    await act(async () => {});
    fetchConversationsMock.mockClear();
    fetchConversationMock.mockClear();

    await act(async () => {
      screen.getByRole("button", { name: "simular contacto agregado" }).click();
    });
    await act(async () => {});

    // El chat se abre pidiendo el detalle de la conversación que acaba de nacer.
    expect(fetchConversationMock).toHaveBeenCalledWith(expect.anything(), "conv-agregada");
    // `refreshConversations` (dentro de `handleContactCreated`) llama a
    // `fetchInboxHead`, que pide `fetchConversations` sin filtro: la fila
    // nueva llega por ahí, no por la lista con la que arrancó el shell.
    expect(fetchConversationsMock).toHaveBeenCalled();
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

  it("pide la página siguiente por cursor (última fila cargada) y la pega al final", async () => {
    const primeraPagina = paginaLlena(0);
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={primeraPagina}
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
    // No un desplazamiento: la última fila que se cargó, en valor. Un
    // desplazamiento se rompe apenas una fila cruza el borde de página
    // mientras el asesor sigue bajando (ver `inbox-paging.ts`).
    const ultimaFilaCargada = primeraPagina[primeraPagina.length - 1];
    // `since` (T1, 8/9/2026): la bandeja abre en "hoy" por defecto, así que
    // toda consulta de "Todos" lo lleva — `expect.any(String)` porque es la
    // medianoche de Caracas calculada contra el reloj del momento en que
    // corre el test, no un valor fijo.
    expect(fetchConversationsMock.mock.calls[0][1]).toEqual({
      cursor: { lastMessageAt: ultimaFilaCargada.lastMessageAt, id: ultimaFilaCargada.id },
      limit: 30,
      since: expect.any(String),
    });
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

    // Una página, no las 60 que hay en pantalla. `since` (T1, 8/9/2026): ver
    // el comentario del test de arriba.
    expect(fetchConversationsMock.mock.calls[0][1]).toEqual({
      limit: 30,
      since: expect.any(String),
    });
    expect(inboxProps?.conversations).toHaveLength(60);
  });
});

/**
 * `loadMoreConversations` guardaba su candado en `useState`: dos eventos de
 * scroll que llegan en el mismo frame ven el mismo estado (React no repinta
 * entre ellos), los dos pasan la guarda y disparan dos consultas con el
 * mismo cursor. Migrado a `useInboxPager` el 29/8/2026 (ver el comentario
 * grande del hook, invariante "un solo ref manda"): el candado ahora es un
 * ref síncrono, así que una ráfaga entera solo pide una página.
 */
describe("CrmShell — una ráfaga de scroll en 'Todos' pide una sola página", () => {
  function paginaLlena(desde: number) {
    return Array.from({ length: 30 }, (_, i) => buildConversation({ id: `conv-${desde + i}` }));
  }

  it("dos 'cargar más' antes del repintado disparan UNA sola llamada, y el siguiente pide el cursor de la página 2", async () => {
    const primeraPagina = paginaLlena(0);
    render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={primeraPagina}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
      />
    );
    fetchConversationsMock.mockClear();

    let resolverSegunda: (rows: ReturnType<typeof buildConversation>[]) => void = () => {};
    fetchConversationsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolverSegunda = resolve;
      })
    );

    // Ráfaga de scroll: dos disparos antes de que la primera petición resuelva.
    await act(async () => {
      screen.getByRole("button", { name: "cargar más" }).click();
      screen.getByRole("button", { name: "cargar más" }).click();
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);

    const segundaPagina = paginaLlena(30);
    await act(async () => {
      resolverSegunda(segundaPagina);
    });

    fetchConversationsMock.mockResolvedValueOnce([]);
    await act(async () => {
      screen.getByRole("button", { name: "cargar más" }).click();
    });

    const ultimaFilaPrimera = primeraPagina[primeraPagina.length - 1];
    const ultimaFilaSegunda = segundaPagina[segundaPagina.length - 1];
    expect(fetchConversationsMock).toHaveBeenCalledTimes(2);
    // `since` (T1, 8/9/2026): ver el comentario del primer test de este
    // `describe`.
    expect(fetchConversationsMock.mock.calls[1][1]).toEqual({
      cursor: { lastMessageAt: ultimaFilaSegunda.lastMessageAt, id: ultimaFilaSegunda.id },
      limit: 30,
      since: expect.any(String),
    });
    // Nunca vuelve al cursor de la página 1: sería releer lo mismo dos veces.
    expect(fetchConversationsMock.mock.calls[1][1]).not.toEqual({
      cursor: { lastMessageAt: ultimaFilaPrimera.lastMessageAt, id: ultimaFilaPrimera.id },
      limit: 30,
    });
  });

  it("hasMore sigue verdadero tras la ráfaga si la única página que llegó vino llena", async () => {
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
    fetchConversationsMock.mockResolvedValueOnce(paginaLlena(30)); // llena: pageSize completo

    await act(async () => {
      screen.getByRole("button", { name: "cargar más" }).click();
      screen.getByRole("button", { name: "cargar más" }).click();
    });

    expect(fetchConversationsMock).toHaveBeenCalledTimes(1);
    expect(inboxProps?.hasMore).toBe(true);
  });
});

/**
 * Aplicar los cambios en memoria quita la red que había: antes, cualquier
 * desincronización se corregía sola en el siguiente refetch. Si un campo se
 * queda sin mapear, ahora la bandeja mostraría el valor viejo para siempre.
 * Una pasada de fondo, espaciada, devuelve esa reparación sin volver al
 * coste de antes.
 */
/**
 * T7 (8/9/2026): el aviso de asignación navega con
 * `router.push("/inbox?conversation=<id>")` mientras el asesor ya está
 * parado en `/inbox`. Eso cambia el searchParam y por lo tanto el prop
 * `initialConversationId`, pero sin montaje nuevo — antes `selectedId`
 * (fijado con `useState(initialConversationId ?? null)`, que solo lee el
 * prop una vez) no se movía y el clic del aviso no abría nada.
 */
describe("CrmShell — sincroniza el chat abierto cuando cambia initialConversationId sin remontar", () => {
  function dosConversaciones() {
    return [
      buildConversation({ id: "conv-1" }),
      buildConversation({
        id: "conv-2",
        contact: { ...buildConversation().contact, id: "contact-2" },
      }),
    ];
  }

  it("un rerender con OTRO initialConversationId abre ese hilo nuevo", async () => {
    const { rerender } = render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={dosConversaciones()}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {});
    fetchConversationMock.mockClear();

    // Mismo componente montado, prop nuevo: así llega el aviso de asignación
    // cuando el asesor ya está en /inbox — no hay un montaje nuevo de por medio.
    rerender(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={dosConversaciones()}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
        initialConversationId="conv-2"
      />
    );
    await act(async () => {});

    expect(fetchConversationMock).toHaveBeenCalledWith(expect.anything(), "conv-2");
  });

  it("un rerender con el MISMO initialConversationId no pisa la selección que el asesor hizo a mano", async () => {
    const { rerender } = render(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={dosConversaciones()}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {});

    // El asesor elige otro hilo a mano, con el prop todavía en "conv-1".
    await act(async () => {
      screen.getByRole("button", { name: "abrir conv-2" }).click();
    });
    expect(fetchConversationMock).toHaveBeenCalledWith(expect.anything(), "conv-2");
    fetchConversationMock.mockClear();

    // Rerender con el prop SIN cambiar: un useEffect ingenuo con
    // [initialConversationId] en las dependencias no distingue esto de un
    // prop nuevo y reabriría "conv-1", pisando el clic manual.
    rerender(
      <CrmShell
        currentAgent={currentAgent}
        initialConversations={dosConversaciones()}
        initialInboxCounts={inboxCounts}
        allTags={allTags}
        initialQuickReplies={initialQuickReplies}
        bcvRate={null}
        initialAgentSettings={agentSettings}
        initialConversationId="conv-1"
      />
    );
    await act(async () => {});

    // No se volvió a pedir el detalle de "conv-1": la selección manual de
    // "conv-2" sigue en pie.
    expect(fetchConversationMock).not.toHaveBeenCalled();
  });
});

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
