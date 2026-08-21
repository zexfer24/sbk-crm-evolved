import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/components/chat/composer";
import type { Conversation } from "@/lib/types";

vi.mock("@/lib/mutations", () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendMediaMessage: vi.fn().mockResolvedValue(undefined),
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
    assignedAgent: null,
    aiEnabled: false,
    dealStatus: "none",
    dealClosedAt: null,
    dealPaymentProofUrl: null,
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    // Reciente, para que la ventana de 24h esté abierta y el textarea no esté deshabilitado.
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

function renderComposer() {
  return render(
    <Composer
      conversation={buildConversation()}
      templates={[]}
      quickReplies={[]}
      replyingTo={null}
      onCancelReply={vi.fn()}
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
