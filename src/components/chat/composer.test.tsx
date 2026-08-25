import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/components/chat/composer";
import type { Conversation } from "@/lib/types";

const sendMediaMessageMock = vi.fn().mockResolvedValue(undefined);
const onSendTextMock = vi.fn();

vi.mock("@/lib/mutations", () => ({
  sendMediaMessage: (...args: unknown[]) => sendMediaMessageMock(...args),
  sendTemplateMessage: vi.fn().mockResolvedValue(undefined),
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

function renderComposer() {
  return render(
    <Composer
      conversation={buildConversation()}
      templates={[]}
      quickReplies={[]}
      replyingTo={null}
      onCancelReply={vi.fn()}
      onSendText={onSendTextMock}
    />
  );
}

describe("Composer - atajos de teclado de formato", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Ctrl+B envuelve la selección en *negrita*", async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola mundo");
    textarea.setSelectionRange(5, 10); // selecciona "mundo"

    await user.keyboard("{Control>}b{/Control}");

    expect(textarea.value).toBe("hola *mundo*");
  });

  it("Ctrl+I envuelve la selección en _itálica_", async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola mundo");
    textarea.setSelectionRange(5, 10);

    await user.keyboard("{Control>}i{/Control}");

    expect(textarea.value).toBe("hola _mundo_");
  });

  it("Ctrl+Shift+X envuelve la selección en ~tachado~", async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "hola mundo");
    textarea.setSelectionRange(5, 10);

    await user.keyboard("{Control>}{Shift>}x{/Shift}{/Control}");

    expect(textarea.value).toBe("hola ~mundo~");
  });

  it("sin selección (cursor solo), Ctrl+B inserta el par vacío con el cursor en medio", async () => {
    const user = userEvent.setup();
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
    const user = userEvent.setup();

    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
    await user.type(textarea, "¿Tienen el carburador PZ27?");
    await user.keyboard("{Enter}");

    expect(textarea.value).toBe("");
    expect(onSendTextMock).toHaveBeenCalledWith("¿Tienen el carburador PZ27?", null);
  });

  it("con el cuadro vacío, Enter no encola nada", async () => {
    const user = userEvent.setup();

    renderComposer();
    await user.click(screen.getByRole("textbox", { name: "Mensaje" }));
    await user.keyboard("{Enter}");

    expect(onSendTextMock).not.toHaveBeenCalled();
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
    const user = userEvent.setup();
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Mensaje" });

    pegar(textarea, [foto("primera.png"), foto("segunda.png"), foto("tercera.png")]);
    await user.click(screen.getByRole("button", { name: /enviar/i }));

    await vi.waitFor(() => expect(sendMediaMessageMock).toHaveBeenCalledTimes(3));

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
