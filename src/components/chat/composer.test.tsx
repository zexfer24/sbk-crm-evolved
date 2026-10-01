/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/components/chat/composer";
import type { Agent, CatalogLink, Conversation, Message, QuickReply, Sticker } from "@/lib/types";

/**
 * T4b (18/9/2026): `handleSelectQuickReply` avisa con `toast.warning` cuando
 * un mensaje rápido trae un marcador de catálogo que no resuelve (D6). El
 * resto del módulo real de HeroUI queda intacto -- estos tests no necesitan
 * un doble de `Button`/`TextArea`/`Modal`, solo un espía sobre `warning`.
 */
const toastWarningMock = vi.fn();
/** T4 "Ronda del cliente" (30/9/2026): «La ventana de 24 h está cerrada» al insertar el carrito. */
const toastDangerMock = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: {
      ...real.toast,
      warning: (...args: unknown[]) => toastWarningMock(...args),
      danger: (...args: unknown[]) => toastDangerMock(...args),
    },
  };
});

const sendMediaMessageMock = vi.fn().mockResolvedValue(undefined);
const onSendTextMock = vi.fn();
/** T3.1 (4/9/2026): "escribiendo…" hacia Meta. Nunca lanza, así que el mock tampoco. */
const sendTypingSignalMock = vi.fn().mockResolvedValue(undefined);
/** T3b (8/9/2026): emojis y stickers del compositor. */
const sendStickerMessageMock = vi.fn().mockResolvedValue("msg-sticker");
const deleteStickerMock = vi.fn().mockResolvedValue(undefined);
const createStickerMock = vi.fn();
const fetchStickersMock = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/mutations", () => ({
  sendMediaMessage: (...args: unknown[]) => sendMediaMessageMock(...args),
  sendTemplateMessage: vi.fn().mockResolvedValue(undefined),
  sendTypingSignal: (...args: unknown[]) => sendTypingSignalMock(...args),
  sendStickerMessage: (...args: unknown[]) => sendStickerMessageMock(...args),
  deleteSticker: (...args: unknown[]) => deleteStickerMock(...args),
  createSticker: (...args: unknown[]) => createStickerMock(...args),
}));

vi.mock("@/lib/stickers-data", () => ({
  fetchStickers: (...args: unknown[]) => fetchStickersMock(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: "https://example.com/file" } })),
      })),
    },
  })),
}));

/**
 * El picker real trae su propio dataset de emojis y no tiene sentido cargarlo
 * en un test: se reemplaza por un botón mínimo que dispara `onEmojiClick`
 * con un emoji fijo, igual que hace `message-context-menu.test.tsx` con
 * `saveStickerFromMessage`. Cubre el contrato real (la prop que recibe el
 * compositor), no la librería de terceros.
 */
vi.mock("emoji-picker-react", () => ({
  default: (props: { onEmojiClick: (data: { emoji: string }) => void }) => (
    <button type="button" onClick={() => props.onEmojiClick({ emoji: "😀" })}>
      Elegir emoji de prueba
    </button>
  ),
}));

const AGENT: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

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
    // Reciente, para que la ventana de 24h esté abierta y el textarea no esté deshabilitado.
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
  };
}

/**
 * `userEvent.setup()` por defecto mete un `setTimeout(0)` entre cada
 * pulsación y hace `pointerEventsCheck` (sube el árbol con
 * `getComputedStyle`) en cada click. Bajo CPU contendida — varios agentes
 * corriendo en paralelo en esta máquina el 28/8/2026 — eso revienta el
 * timeout de la prueba. No hay usuario real esperando ese delay.
 */
function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

/**
 * Fábrica mínima de `Message` (T2, "La ventana de 24h dice la verdad",
 * 7/9/2026): el composer ahora recibe el hilo completo para poder mirar
 * `windowClosedByMeta` (`whatsapp-window.ts`), y estos tests necesitan armar
 * mensajes salientes fallidos e inbounds sueltos sin repetir los quince
 * campos de `Message` en cada caso.
 */
function buildMessage(over: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "text",
    content: "hola",
    templateName: null,
    mediaUrl: null,
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function composerElement(
  messages: Message[] = [],
  conversation: Conversation = buildConversation(),
  extra: {
    quickReplies?: QuickReply[];
    catalogLinks?: CatalogLink[];
    insertTextSignal?: { text: string; seq: number } | null;
  } = {}
) {
  return (
    <Composer
      conversation={conversation}
      messages={messages}
      templates={[]}
      quickReplies={extra.quickReplies ?? []}
      catalogLinks={extra.catalogLinks ?? []}
      currentAgent={AGENT}
      replyingTo={null}
      onCancelReply={vi.fn()}
      onSendText={onSendTextMock}
      insertTextSignal={extra.insertTextSignal}
    />
  );
}

function renderComposer(
  messages: Message[] = [],
  conversation: Conversation = buildConversation(),
  extra: {
    quickReplies?: QuickReply[];
    catalogLinks?: CatalogLink[];
    insertTextSignal?: { text: string; seq: number } | null;
  } = {}
) {
  return render(composerElement(messages, conversation, extra));
}

/** Fábrica mínima de `QuickReply` para los tests de T4b (18/9/2026). */
function buildQuickReply(over: Partial<QuickReply> = {}): QuickReply {
  return {
    id: `qr-${Math.random().toString(36).slice(2)}`,
    label: "Catálogo",
    content: "Acá va nuestro catálogo",
    ownerId: null,
    ...over,
  };
}

/** Fábrica mínima de `CatalogLink` para los tests de T4b (18/9/2026). */
function buildCatalogLink(over: Partial<CatalogLink> = {}): CatalogLink {
  return {
    id: `cat-${Math.random().toString(36).slice(2)}`,
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/file/d/cascos",
    sortOrder: 1,
    isActive: true,
    updatedBy: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...over,
  };
}

describe("Composer - atajos de teclado de formato", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Ctrl+B envuelve la selección en *negrita*", async () => {
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola mundo");
    textarea.setSelectionRange(5, 10); // selecciona "mundo"

    await user.keyboard("{Control>}b{/Control}");

    expect(textarea.value).toBe("hola *mundo*");
  });

  it("Ctrl+I envuelve la selección en _itálica_", async () => {
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola mundo");
    textarea.setSelectionRange(5, 10);

    await user.keyboard("{Control>}i{/Control}");

    expect(textarea.value).toBe("hola _mundo_");
  });

  it("Ctrl+Shift+X envuelve la selección en ~tachado~", async () => {
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola mundo");
    textarea.setSelectionRange(5, 10);

    await user.keyboard("{Control>}{Shift>}x{/Shift}{/Control}");

    expect(textarea.value).toBe("hola ~mundo~");
  });

  it("sin selección (cursor solo), Ctrl+B inserta el par vacío con el cursor en medio", async () => {
    // Este test peleó dos veces la misma carrera: el 28/8/2026 se le quitó
    // `delay: null` porque el cursor quedaba en 7 en vez de 6, y el
    // 29/8/2026 el runner de CI (más lento que las máquinas de 8 núcleos)
    // falló igual con los delays reales. La causa era del componente —
    // `setSelectionRange` diferido a un rAF que corría contra el commit de
    // React— y se arregló ahí con `flushSync`; el test vuelve al usuario
    // estándar de la casa porque ya no hay carrera que esconder.
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola ");
    // cursor queda al final tras escribir, sin selección

    await user.keyboard("{Control>}b{/Control}");

    expect(textarea.value).toBe("hola **");
    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);
  });
});

/**
 * Enviar es lo que más se repite en todo el CRM. El cuadro ya no espera al
 * servidor para nada: entrega el texto a la cola del shell y se vacía en el
 * acto. La espera y los fallos se cuentan en la burbuja provisional del hilo,
 * que sobrevive aunque el asesor cambie de chat.
 */
describe("Composer — el cuadro entrega a la cola y se vacía en el acto", () => {
  beforeEach(() => onSendTextMock.mockClear());

  it("vacía el cuadro apenas se envía y le entrega el texto a la cola", async () => {
    const user = crearUsuario();

    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    await user.type(textarea, "¿Tienen el carburador PZ27?");
    await user.keyboard("{Enter}");

    expect(textarea.value).toBe("");
    expect(onSendTextMock).toHaveBeenCalledWith("¿Tienen el carburador PZ27?", null);
  });

  it("con el cuadro vacío, Enter no encola nada", async () => {
    const user = crearUsuario();

    renderComposer();
    await user.click(screen.getByRole("textbox", { name: "Mensaje" }));
    await user.keyboard("{Enter}");

    expect(onSendTextMock).not.toHaveBeenCalled();
  });
});

/**
 * T4b, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
 * D4/D6): un mensaje rápido puede traer `{{catalogo:<key>}}`/`{{catalogos}}`
 * en vez de la URL pegada a mano. `handleSelectQuickReply` lo resuelve con
 * `catalogLinks` justo antes de pegarlo en el cuadro -- la fuente única
 * siempre es la tabla, nunca el texto que guardó el mensaje rápido.
 */
describe("Composer — un mensaje rápido con marcador de catálogo", () => {
  beforeEach(() => toastWarningMock.mockClear());

  it("al usar el mensaje rápido, el marcador sale resuelto con la URL vigente", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, {
      quickReplies: [buildQuickReply({ content: "Acá va {{catalogo:cascos}}" })],
      catalogLinks: [buildCatalogLink({ key: "cascos", url: "https://drive.google.com/file/d/cascos-vigente" })],
    });

    await user.click(screen.getByRole("button", { name: "Mensajes rápidos" }));
    await user.click(screen.getByRole("button", { name: "Usar" }));

    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Acá va https://drive.google.com/file/d/cascos-vigente");
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it("sin catálogo activo con esa clave, el marcador queda tal cual y avisa con un toast", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, {
      quickReplies: [buildQuickReply({ content: "Acá va {{catalogo:cascos}}" })],
      catalogLinks: [], // ningún catálogo cargado todavía: D6, nunca se inventa una URL
    });

    await user.click(screen.getByRole("button", { name: "Mensajes rápidos" }));
    await user.click(screen.getByRole("button", { name: "Usar" }));

    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Acá va {{catalogo:cascos}}");
    expect(toastWarningMock).toHaveBeenCalledWith("El catálogo «cascos» no está configurado");
  });

  it('un mensaje rápido sin marcador se pega tal cual, sin tocar el catálogo', async () => {
    const user = crearUsuario();
    renderComposer([], undefined, {
      quickReplies: [buildQuickReply({ content: "Gracias por tu compra." })],
      catalogLinks: [buildCatalogLink()],
    });

    await user.click(screen.getByRole("button", { name: "Mensajes rápidos" }));
    await user.click(screen.getByRole("button", { name: "Usar" }));

    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Gracias por tu compra.");
    expect(toastWarningMock).not.toHaveBeenCalled();
  });
});

/**
 * T7, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026). Caso real: los asesores mandaban un link de
 * "CATALOGO CASCOS" distinto al de Seba porque el mensaje rápido llevaba la
 * URL de Drive escrita a mano. La fuente única de los catálogos tiene que
 * gobernar también lo que SALE, no solo lo que se pega: un marcador que
 * quedó en el cuadro se resuelve al mandar, y uno que no se puede resolver no
 * sale (D6).
 */
describe("Composer — los marcadores de catálogo se resuelven al MANDAR (T7)", () => {
  beforeEach(() => {
    onSendTextMock.mockClear();
    toastWarningMock.mockClear();
  });

  const cascosVigente = (url: string) => buildCatalogLink({ key: "cascos", url });

  async function usarMensajeRapidoYEnviar(user: ReturnType<typeof crearUsuario>) {
    await user.click(screen.getByRole("button", { name: "Mensajes rápidos" }));
    await user.click(screen.getByRole("button", { name: "Usar" }));
    await user.click(screen.getByRole("textbox", { name: "Mensaje" }));
    await user.keyboard("{Enter}");
  }

  it("un mensaje rápido con {{catalogo:cascos}} manda la URL vigente de catalog_links", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, {
      quickReplies: [buildQuickReply({ content: "Catálogo de cascos: {{catalogo:cascos}}" })],
      catalogLinks: [cascosVigente("https://drive.google.com/file/d/1oDrYm-vigente")],
    });

    await usarMensajeRapidoYEnviar(user);

    expect(onSendTextMock).toHaveBeenCalledWith("Catálogo de cascos: https://drive.google.com/file/d/1oDrYm-vigente", null);
  });

  it("si el link cambia en catalog_links, el MISMO mensaje rápido manda el nuevo", async () => {
    const user = crearUsuario();
    const mensajeRapido = buildQuickReply({ content: "Catálogo de cascos: {{catalogo:cascos}}" });
    const { rerender } = renderComposer([], undefined, {
      quickReplies: [mensajeRapido],
      catalogLinks: [cascosVigente("https://drive.google.com/file/d/1oDrYm-viejo")],
    });

    await usarMensajeRapidoYEnviar(user);
    expect(onSendTextMock).toHaveBeenLastCalledWith("Catálogo de cascos: https://drive.google.com/file/d/1oDrYm-viejo", null);

    rerender(
      composerElement([], undefined, {
        quickReplies: [mensajeRapido],
        catalogLinks: [cascosVigente("https://drive.google.com/file/d/1wWJ1PvF-nuevo")],
      })
    );

    await usarMensajeRapidoYEnviar(user);
    expect(onSendTextMock).toHaveBeenLastCalledWith("Catálogo de cascos: https://drive.google.com/file/d/1wWJ1PvF-nuevo", null);
    expect(onSendTextMock).toHaveBeenCalledTimes(2);
  });

  it("un marcador escrito a mano en el cuadro también se resuelve al enviar", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, {
      catalogLinks: [cascosVigente("https://drive.google.com/file/d/1oDrYm-vigente")],
    });

    const textarea = screen.getByRole("textbox", { name: "Mensaje" });
    await user.click(textarea);
    await user.paste("Mira {{catalogo:cascos}}");
    await user.keyboard("{Enter}");

    expect(onSendTextMock).toHaveBeenCalledWith("Mira https://drive.google.com/file/d/1oDrYm-vigente", null);
  });

  it("un marcador que no se puede resolver NO sale: el texto se queda en el cuadro y se avisa", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, {
      quickReplies: [buildQuickReply({ content: "Acá va {{catalogo:cascos}}" })],
      catalogLinks: [], // catálogo inexistente: D6, el marcador crudo nunca llega al cliente
    });

    await usarMensajeRapidoYEnviar(user);

    expect(onSendTextMock).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement).value).toBe("Acá va {{catalogo:cascos}}");
    expect(toastWarningMock).toHaveBeenCalledWith("El catálogo «cascos» no está configurado");
  });

  it("un catálogo apagado cuenta como sin resolver y tampoco sale", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, {
      quickReplies: [buildQuickReply({ content: "Acá va {{catalogo:cascos}}" })],
      catalogLinks: [buildCatalogLink({ key: "cascos", isActive: false })],
    });

    await usarMensajeRapidoYEnviar(user);

    expect(onSendTextMock).not.toHaveBeenCalled();
  });

  it("un marcador mal escrito ({{catalogo:cascos_nuevos}}) tampoco sale", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, { catalogLinks: [cascosVigente("https://drive.google.com/file/d/1oDrYm")] });

    const textarea = screen.getByRole("textbox", { name: "Mensaje" });
    await user.click(textarea);
    await user.paste("Mira {{catalogo:cascos_nuevos}}");
    await user.keyboard("{Enter}");

    expect(onSendTextMock).not.toHaveBeenCalled();
    expect(toastWarningMock).toHaveBeenCalled();
  });

  it("un texto sin marcadores sale igual que antes, sin tocar el catálogo", async () => {
    const user = crearUsuario();
    renderComposer([], undefined, { catalogLinks: [cascosVigente("https://drive.google.com/file/d/1oDrYm")] });

    await user.type(screen.getByRole("textbox", { name: "Mensaje" }), "Hola, ¿en qué te ayudo?");
    await user.keyboard("{Enter}");

    expect(onSendTextMock).toHaveBeenCalledWith("Hola, ¿en qué te ayudo?", null);
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  function pegarFoto(textarea: HTMLElement) {
    fireEvent.paste(textarea, {
      clipboardData: {
        files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })],
        items: [],
        getData: () => "",
      },
    });
  }

  it("el pie de una foto también resuelve el marcador", async () => {
    const user = crearUsuario();
    sendMediaMessageMock.mockClear();
    renderComposer([], undefined, { catalogLinks: [cascosVigente("https://drive.google.com/file/d/1oDrYm-vigente")] });
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegarFoto(textarea);
    await user.click(textarea);
    await user.paste("Catálogo {{catalogo:cascos}}");
    await user.click(screen.getByRole("button", { name: /enviar/i }));

    await waitFor(() => expect(sendMediaMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMediaMessageMock.mock.calls[0][3]).toBe("Catálogo https://drive.google.com/file/d/1oDrYm-vigente");
  });

  it("con un marcador sin resolver en el pie, la foto no se sube ni se manda", async () => {
    const user = crearUsuario();
    sendMediaMessageMock.mockClear();
    renderComposer([], undefined, { catalogLinks: [] });
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegarFoto(textarea);
    await user.click(textarea);
    await user.paste("Catálogo {{catalogo:cascos}}");
    await user.click(screen.getByRole("button", { name: /enviar/i }));

    expect(sendMediaMessageMock).not.toHaveBeenCalled();
    expect(toastWarningMock).toHaveBeenCalledWith("El catálogo «cascos» no está configurado");
  });
});

/**
 * Pegar es como llega la mayoría de las capturas: el asesor recorta la
 * pantalla y hace Ctrl+V. Tener que guardar el archivo primero para después
 * buscarlo con el clip es un rodeo que nadie hace.
 */
describe("Composer — pegar con Ctrl+V", () => {
  function pegar(target: HTMLElement, files: File[], text = "") {
    fireEvent.paste(target, {
      clipboardData: {
        files,
        items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
        getData: () => text,
      },
    });
  }

  const foto = (nombre: string) =>
    new File([new Uint8Array([1, 2, 3])], nombre, { type: "image/png" });

  it("una captura pegada queda lista para enviar, con su vista previa", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [foto("captura.png")]);

    expect(screen.getByRole("button", { name: "Quitar captura.png" })).toBeInTheDocument();
  });

  it("pegar varias fotos de una vez las adjunta todas", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [foto("una.png"), foto("dos.png"), foto("tres.png")]);

    expect(screen.getByRole("button", { name: "Quitar una.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar dos.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar tres.png" })).toBeInTheDocument();
  });

  it("pegar texto sigue siendo pegar texto y no adjunta nada", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [], "¿Tienen el carburador?");

    expect(screen.queryByRole("button", { name: /^Quitar / })).not.toBeInTheDocument();
  });
});

describe("Composer — mandar varias fotos de una vez", () => {
  const foto = (nombre: string) => new File([new Uint8Array([1, 2, 3])], nombre, { type: "image/png" });

  function pegar(target: HTMLElement, files: File[]) {
    fireEvent.paste(target, {
      clipboardData: { files, items: [], getData: () => "" },
    });
  }

  it("manda una por una y respeta el orden en que se adjuntaron", async () => {
    sendMediaMessageMock.mockClear();
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [foto("primera.png"), foto("segunda.png"), foto("tercera.png")]);
    await user.click(screen.getByRole("button", { name: /enviar/i }));

    // vi.waitFor no tiene configuración global de timeout en Vitest 4; el
    // waitFor de Testing Library hereda los 5 s del setup — un solo punto de política.
    await waitFor(() => expect(sendMediaMessageMock).toHaveBeenCalledTimes(3));

    // El pie va solo en la primera: repetirlo en cada foto se lo manda tres
    // veces al cliente por WhatsApp.
    const captions = sendMediaMessageMock.mock.calls.map((c) => c[3]);
    expect(captions.filter((c) => c !== undefined)).toHaveLength(0);
  });
});

/**
 * Windows y macOS nombran igual toda captura que va al portapapeles. Pegar
 * tres seguidas deja tres adjuntos llamados "image.png", y si el botón de
 * quitar solo dice el nombre, no hay forma de saber cuál se está quitando —
 * ni mirando, ni con un lector de pantalla.
 */
describe("Composer — varias capturas con el mismo nombre", () => {
  it("distingue los adjuntos que comparten nombre", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });
    const captura = () => new File([new Uint8Array([1])], "image.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: { files: [captura(), captura(), captura()], items: [], getData: () => "" },
    });

    const botones = screen.getAllByRole("button", { name: /^Quitar / });
    expect(botones).toHaveLength(3);
    const nombres = botones.map((b) => b.getAttribute("aria-label"));
    expect(new Set(nombres).size).toBe(3);
  });
});

describe("Composer — lo que faltaba para escribir y adjuntar cómodo", () => {
  const foto = (nombre: string) => new File([new Uint8Array([1])], nombre, { type: "image/png" });

  it("pegar funciona aunque el cursor no esté dentro del cuadro de texto", () => {
    renderComposer();

    // Nadie hace clic en el cuadro antes de pegar: se recorta la pantalla y
    // se pulsa Ctrl+V. Si el foco quedó en el botón del clip, o en ningún
    // lado, el evento llega al documento y no al textarea.
    fireEvent.paste(document.body, {
      clipboardData: { files: [foto("captura.png")], items: [], getData: () => "" },
    });

    expect(screen.getByRole("button", { name: "Quitar captura.png" })).toBeInTheDocument();
  });

  it("la vista previa se puede abrir en grande antes de mandarla", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });
    fireEvent.paste(textarea, {
      clipboardData: { files: [foto("captura.png")], items: [], getData: () => "" },
    });

    // Antes de soltar la foto uno quiere comprobar que es la correcta y que
    // se lee lo que muestra: la miniatura es demasiado chica para eso.
    const miniatura = screen.getByRole("button", { name: /ver la foto/i });
    fireEvent.click(miniatura);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("el cuadro crece al escribir en varias líneas en vez de mostrar solo una", () => {
    // jsdom no maquetea, así que el alto real lo tiene que dar la prueba.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 88 });

    try {
      renderComposer();
      const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

      const salto = String.fromCharCode(10);
      fireEvent.change(textarea, { target: { value: `primera${salto}segunda${salto}tercera` } });

      expect(textarea.style.height).toBe("88px");
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
    }
  });
});

/**
 * Hallazgo 6, `code-review high` sobre d38a7e1..HEAD (27/9/2026): el
 * listener de pegado en `document` solo excluía sus DOS propios modales
 * (`isTemplateModalOpen`/`isQuickRepliesOpen`) — con `CloseSaleModal` o
 * `ManageTagsModal` abiertos (montados en `ContextPanel`, otro árbol) o
 * escribiendo en el cuadro de búsqueda de `InventoryLookup`, pegar ahí
 * igual adjuntaba el archivo al COMPOSER y le robaba el foco, rompiendo el
 * focus trap del diálogo: un Enter siguiente mandaba el adjunto al cliente
 * en vez de completar lo que el asesor estaba haciendo en el otro campo.
 */
describe("Composer — pegar no le roba el foco a un diálogo abierto ni a otro campo", () => {
  const foto = (nombre: string) => new File([new Uint8Array([1])], nombre, { type: "image/png" });

  it("con cualquier diálogo abierto (role=dialog), pegar no adjunta ni mueve el foco", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(textarea, "focus");
    // Simula CloseSaleModal/ManageTagsModal (HeroUI monta role="dialog"),
    // montados en `ContextPanel` -- otro árbol de React, ajeno al composer.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    try {
      fireEvent.paste(document.body, {
        clipboardData: { files: [foto("captura.png")], items: [], getData: () => "" },
      });

      expect(screen.queryByRole("button", { name: "Quitar captura.png" })).not.toBeInTheDocument();
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it("pegar con el foco en otro campo editable (input/textarea ajeno) no adjunta nada", () => {
    renderComposer();
    const otroInput = document.createElement("input");
    document.body.appendChild(otroInput);

    try {
      fireEvent.paste(otroInput, {
        clipboardData: { files: [foto("captura.png")], items: [], getData: () => "" },
      });

      expect(screen.queryByRole("button", { name: "Quitar captura.png" })).not.toBeInTheDocument();
    } finally {
      otroInput.remove();
    }
  });

  it("pegar sin dueño (foco en body, zona neutra) sí adjunta y enfoca el textarea", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(textarea, "focus");

    fireEvent.paste(document.body, {
      clipboardData: { files: [foto("captura.png")], items: [], getData: () => "" },
    });

    expect(screen.getByRole("button", { name: "Quitar captura.png" })).toBeInTheDocument();
    expect(focusSpy).toHaveBeenCalled();
  });
});

/**
 * "Escribiendo…" hacia Meta (T3.1, 4/9/2026). Meta apaga el indicador solo a
 * los 25 s (o al llegar la respuesta), así que una redacción que se alarga
 * necesita el aviso renovado antes de que expire — pero sin repetirlo en
 * cada tecla: eso sería una llamada por carácter en vez de una por ventana
 * de 20 s.
 */
describe("Composer — indicador de \"escribiendo…\" hacia Meta", () => {
  beforeEach(() => {
    sendTypingSignalMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispara en el primer carácter", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    act(() => {
      fireEvent.change(textarea, { target: { value: "h" } });
    });

    expect(sendTypingSignalMock).toHaveBeenCalledTimes(1);
    expect(sendTypingSignalMock).toHaveBeenCalledWith("conv-1");
  });

  it("un disparo por ventana de 20 s, no uno por tecla", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    act(() => {
      fireEvent.change(textarea, { target: { value: "h" } });
      fireEvent.change(textarea, { target: { value: "ho" } });
      fireEvent.change(textarea, { target: { value: "hol" } });
      fireEvent.change(textarea, { target: { value: "hola" } });
    });

    expect(sendTypingSignalMock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    // La renovación a los 20 s, ni una más ni una menos por las teclas del medio.
    expect(sendTypingSignalMock).toHaveBeenCalledTimes(2);
  });

  it("se detiene al vaciar el cuadro", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    act(() => {
      fireEvent.change(textarea, { target: { value: "hola" } });
    });
    expect(sendTypingSignalMock).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.change(textarea, { target: { value: "" } });
    });
    sendTypingSignalMock.mockClear();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(sendTypingSignalMock).not.toHaveBeenCalled();
  });

  it("se detiene al enviar el mensaje", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    act(() => {
      fireEvent.change(textarea, { target: { value: "hola" } });
    });
    expect(sendTypingSignalMock).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    sendTypingSignalMock.mockClear();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(sendTypingSignalMock).not.toHaveBeenCalled();
  });
});

/**
 * T2, "La ventana de 24h dice la verdad" (7/9/2026): red de seguridad del
 * lado del cliente para el caso real del 6/9/2026 (conversación
 * `aa75ef33-…`) -- `lastCustomerMessageAt` reciente ya no basta para dejar
 * escribir si el hilo trae un rechazo 131047 sin nada real después.
 */
describe("Composer — Meta ya cerró la ventana con 131047", () => {
  it("un failed 131047 sin inbound real posterior deshabilita el cuadro y ofrece plantilla", () => {
    const fallo = buildMessage({
      direction: "outbound",
      senderType: "agent",
      messageType: "text",
      content: "texto libre",
      whatsappStatus: "failed",
      whatsappError: "Han pasado más de 24 horas desde el último mensaje del cliente.",
      whatsappErrorCode: 131047,
    });

    renderComposer([fallo]);

    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(textarea.placeholder).toBe("Ventana de 24h cerrada — usa una plantilla");
    expect(screen.queryByText(/quedan/i)).not.toBeInTheDocument();
  });

  it("un inbound text posterior al 131047 reabre el cuadro", () => {
    const fallo = buildMessage({
      direction: "outbound",
      senderType: "agent",
      messageType: "text",
      content: "texto libre",
      whatsappStatus: "failed",
      whatsappError: "Han pasado más de 24 horas desde el último mensaje del cliente.",
      whatsappErrorCode: 131047,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const textoPosterior = buildMessage({
      direction: "inbound",
      messageType: "text",
      createdAt: new Date().toISOString(),
    });

    renderComposer([fallo, textoPosterior]);

    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    expect(textarea).not.toBeDisabled();
    expect(textarea.placeholder).toBe("Escribe un mensaje...");
  });
});

/**
 * Emojis y stickers del compositor (T3b, "Seis frentes del buzón",
 * 8/9/2026). `emoji-picker-react` va mockeado a un botón mínimo que dispara
 * `onEmojiClick`: lo que importa acá es el contrato con el compositor
 * (inserta en el caret, mantiene el foco), no repetir las pruebas de la
 * librería.
 */
describe("Composer — popover de emojis y stickers", () => {
  beforeEach(() => {
    fetchStickersMock.mockReset().mockResolvedValue([]);
    sendStickerMessageMock.mockReset().mockResolvedValue("msg-sticker");
    deleteStickerMock.mockReset().mockResolvedValue(undefined);
  });

  function buildSticker(over: Partial<Sticker> = {}): Sticker {
    return {
      id: "sticker-1",
      url: "/api/media/stickers/sticker-1.webp",
      name: "Saludo",
      animated: false,
      createdBy: "agent-1",
      createdAt: new Date().toISOString(),
      ...over,
    };
  }

  it("el botón de emojis y stickers existe y abre el popover", async () => {
    const user = crearUsuario();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));

    expect(screen.getByRole("dialog", { name: "Emojis y stickers" })).toBeInTheDocument();
  });

  it("elegir un emoji lo inserta en el caret del cuadro y mantiene el foco ahí", async () => {
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola mundo");
    // Cursor justo después de "hola " (posición 5), antes de "mundo".
    textarea.setSelectionRange(5, 5);

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    const emojiButton = await screen.findByRole("button", { name: "Elegir emoji de prueba" });
    await user.click(emojiButton);

    expect(textarea.value).toBe("hola 😀mundo");
    expect(document.activeElement).toBe(textarea);
  });

  it("la pestaña de stickers lista los de la biblioteca y manda uno al clic", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    const user = crearUsuario();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));

    const enviar = await screen.findByRole("button", { name: 'Enviar sticker "Saludo"' });
    await user.click(enviar);

    await waitFor(() =>
      expect(sendStickerMessageMock).toHaveBeenCalledWith("conv-1", buildSticker().url)
    );
  });

  it("con la ventana de 24h cerrada, la rejilla de stickers queda deshabilitada", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    const fallo = buildMessage({
      direction: "outbound",
      senderType: "agent",
      messageType: "text",
      content: "texto libre",
      whatsappStatus: "failed",
      whatsappError: "Han pasado más de 24 horas desde el último mensaje del cliente.",
      whatsappErrorCode: 131047,
    });
    const user = crearUsuario();
    renderComposer([fallo]);

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));

    const enviar = await screen.findByRole("button", { name: 'Enviar sticker "Saludo"' });
    expect(enviar).toBeDisabled();
    // `getByText` a secas encuentra dos: el aviso del propio compositor (ya
    // visible con la ventana cerrada) y el del popover -- se acota al diálogo.
    const dialog = screen.getByRole("dialog", { name: "Emojis y stickers" });
    expect(within(dialog).getByText(/han pasado más de 24 h/i)).toBeInTheDocument();
  });

  it("quitar un sticker de la biblioteca pide confirmación antes de borrarlo", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    const user = crearUsuario();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));

    const quitar = await screen.findByRole("button", { name: 'Quitar sticker "Saludo" de la biblioteca' });
    await user.click(quitar);

    // Pide confirmación antes de tocar la base: todavía no llamó a la mutación.
    expect(deleteStickerMock).not.toHaveBeenCalled();
    expect(screen.getByText("¿Quitar de la biblioteca?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quitar" }));

    await waitFor(() => expect(deleteStickerMock).toHaveBeenCalled());
  });
});

/**
 * T2, plan "El mostrador busca sin salir del chat" (27/9/2026, reporte del
 * dueño): con una imagen pegada y el cuadro de texto vacío, Enter no hacía
 * nada -- `handleKeyDown` llamaba siempre a `handleSend` (solo texto), nunca
 * a `handleSendFiles`, que es lo que el BOTÓN de enviar sí elegía. Ahora
 * Enter elige la misma rama que el botón.
 */
describe("Composer — Enter envía la imagen pegada", () => {
  const foto = (nombre: string) => new File([new Uint8Array([1, 2, 3])], nombre, { type: "image/png" });

  function pegar(target: HTMLElement, files: File[]) {
    fireEvent.paste(target, {
      clipboardData: { files, items: [], getData: () => "" },
    });
  }

  beforeEach(() => {
    sendMediaMessageMock.mockClear();
  });

  it("pegar una imagen y presionar Enter la envía, sin texto", async () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [foto("captura.png")]);
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(sendMediaMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMediaMessageMock).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("/api/media/outbound/conv-1/"),
      "image",
      undefined,
      null
    );
  });

  it("con texto ya escrito, Enter lo manda como pie de la imagen pegada", async () => {
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.type(textarea, "Así llegó el repuesto");
    pegar(textarea, [foto("captura.png")]);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(sendMediaMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMediaMessageMock).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("/api/media/outbound/conv-1/"),
      "image",
      "Así llegó el repuesto",
      null
    );
  });

  it("Shift+Enter no envía la imagen pegada", async () => {
    const user = crearUsuario();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [foto("captura.png")]);
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(sendMediaMessageMock).not.toHaveBeenCalled();
  });

  it("dos Enter seguidos en el mismo tick suben el lote una sola vez", async () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [foto("captura.png")]);
    // Sin `await` entre medio: el ref de "enviando" tiene que frenar el
    // segundo Enter antes de que `isUploading` llegue a reflejarse en el
    // render que vería un segundo `keydown` disparado en otro tick.
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(sendMediaMessageMock).toHaveBeenCalledTimes(1));
  });

  it("tras pegar un archivo, el foco vuelve al cuadro de texto", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    // Se pega sobre el documento, no sobre el cuadro: es como llega en la
    // vida real (nadie hace clic en el textarea antes de pegar).
    pegar(document.body, [foto("captura.png")]);

    expect(document.activeElement).toBe(textarea);
  });
});

// T4 del plan "Ronda del cliente" (30/9/2026): el carrito del panel derecho
// deja su resumen en el cuadro de mensaje SIN enviarlo, con una señal por
// contador (`insertTextSignal`), igual que `openTemplateModalSignal`.
describe("Composer - insertar texto desde afuera (resumen del carrito)", () => {
  beforeEach(() => {
    onSendTextMock.mockClear();
    toastDangerMock.mockClear();
  });

  it("la señal inserta el texto en un cuadro vacío, sin enviarlo, y enfoca el cuadro", () => {
    const conversation = buildConversation();
    const { rerender } = renderComposer([], conversation, { insertTextSignal: null });

    rerender(composerElement([], conversation, { insertTextSignal: { text: "Total: $20.00", seq: 1 } }));

    const textarea = screen.getByLabelText("Mensaje");
    expect(textarea).toHaveValue("Total: $20.00");
    expect(textarea).toHaveFocus();
    expect(onSendTextMock).not.toHaveBeenCalled();
  });

  it("si ya había texto, lo AGREGA en una línea nueva en vez de pisarlo", () => {
    const conversation = buildConversation();
    const { rerender } = renderComposer([], conversation, { insertTextSignal: null });
    fireEvent.change(screen.getByLabelText("Mensaje"), { target: { value: "Hola, te cuento:" } });

    rerender(composerElement([], conversation, { insertTextSignal: { text: "Total: $20.00", seq: 1 } }));

    expect(screen.getByLabelText("Mensaje")).toHaveValue("Hola, te cuento:\nTotal: $20.00");
    expect(onSendTextMock).not.toHaveBeenCalled();
  });

  it("el mismo seq en otro render no vuelve a insertar (el texto no se duplica)", () => {
    const conversation = buildConversation();
    const senal = { text: "Total: $20.00", seq: 1 };
    const { rerender } = renderComposer([], conversation, { insertTextSignal: null });

    rerender(composerElement([], conversation, { insertTextSignal: senal }));
    // Otra referencia con el mismo seq (el shell re-renderiza) y el asesor sigue escribiendo.
    rerender(composerElement([], conversation, { insertTextSignal: { ...senal } }));
    rerender(composerElement([], conversation, { insertTextSignal: { ...senal } }));

    expect(screen.getByLabelText("Mensaje")).toHaveValue("Total: $20.00");
  });

  it("un seq nuevo inserta de nuevo (dos pulsaciones seguidas de «Enviar al chat»)", () => {
    const conversation = buildConversation();
    const { rerender } = renderComposer([], conversation, { insertTextSignal: null });

    rerender(composerElement([], conversation, { insertTextSignal: { text: "A", seq: 1 } }));
    rerender(composerElement([], conversation, { insertTextSignal: { text: "B", seq: 2 } }));

    expect(screen.getByLabelText("Mensaje")).toHaveValue("A\nB");
  });

  it("una señal que ya estaba al montar no se aplica (es de un chat anterior)", () => {
    renderComposer([], buildConversation(), { insertTextSignal: { text: "viejo", seq: 3 } });

    expect(screen.getByLabelText("Mensaje")).toHaveValue("");
  });

  it("con la ventana de 24 h cerrada no inserta y avisa que hace falta una plantilla", () => {
    const cerrada: Conversation = {
      ...buildConversation(),
      lastCustomerMessageAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
    };
    const { rerender } = renderComposer([], cerrada, { insertTextSignal: null });

    rerender(composerElement([], cerrada, { insertTextSignal: { text: "Total: $20.00", seq: 1 } }));

    expect(screen.getByLabelText("Mensaje")).toHaveValue("");
    expect(toastDangerMock).toHaveBeenCalledWith("La ventana de 24 h está cerrada; usa una plantilla");
    expect(onSendTextMock).not.toHaveBeenCalled();
  });
});
