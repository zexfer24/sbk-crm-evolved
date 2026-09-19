/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeachSebaModal } from "@/components/chat/teach-seba-modal";
import type { Agent, Message } from "@/lib/types";

/**
 * T6, plan "Seba atiende el mostrador" (18/9/2026, requisito 7 del cliente):
 * el formulario de "Enseñar a Seba…". El backend (T5, ya commiteado) se
 * mockea tal cual sus firmas reales — `createLesson(supabase, agent, draft)`
 * y `LessonIdentityError` — este archivo solo prueba el flujo del modal.
 */

const createLessonMock = vi.fn();

// Se conserva la clase REAL LessonIdentityError (importOriginal), igual que
// playbooks-panel.test.tsx con PlaybookIdentityError: el modal usa
// `instanceof` para decidir la rama del catch.
vi.mock("@/lib/mutations", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mutations")>();
  return { ...real, createLesson: (...args: unknown[]) => createLessonMock(...args) };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ fakeClient: true }) }));

const successToast = vi.fn();
const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: (...a: unknown[]) => successToast(...a), danger: (...a: unknown[]) => dangerToast(...a) } };
});

const AGENT: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function customerMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "text",
    content: "¿Tienen pastilla para una Bera SBR 2020?",
    templateName: null,
    mediaUrl: null,
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
    createdAt: "2026-09-18T11:00:00.000Z",
    ...overrides,
  };
}

function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function renderModal(overrides: Partial<Parameters<typeof TeachSebaModal>[0]> = {}) {
  const onOpenChange = vi.fn();
  const props = {
    isOpen: true,
    message: customerMessage(),
    agent: AGENT,
    conversationId: "conv-1",
    contactId: "contact-1",
    onOpenChange,
    ...overrides,
  };
  return { onOpenChange, ...render(<TeachSebaModal {...props} />) };
}

describe("TeachSebaModal", () => {
  beforeEach(() => {
    createLessonMock.mockReset();
    successToast.mockReset();
    dangerToast.mockReset();
  });

  it("cita el mensaje sobre el que se enseña", () => {
    renderModal({ message: customerMessage({ content: "¿Tienen pastilla para una Bera SBR 2020?" }) });
    expect(screen.getByText("¿Tienen pastilla para una Bera SBR 2020?")).toBeInTheDocument();
  });

  it("el alcance por defecto es 'Todos los chats' (decisión P2 del plan)", () => {
    renderModal();
    expect(screen.getByRole("button", { name: "Todos los chats" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Solo este chat" })).toHaveAttribute("aria-pressed", "false");
  });

  it("el contador de la nota arranca en 0/200 y sube con lo que se escribe", async () => {
    const user = crearUsuario();
    renderModal();

    expect(screen.getByText("0/200")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Corrección o nota para Seba"), "hola");

    expect(screen.getByText("4/200")).toBeInTheDocument();
  });

  it("sin nada escrito, Guardar está deshabilitado", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /guardar/i })).toBeDisabled();
  });

  it("Guardar llama a createLesson con scope global (default), el messageId, el conversationId null y el contactId", async () => {
    createLessonMock.mockResolvedValue(undefined);
    const user = crearUsuario();
    const { onOpenChange } = renderModal({
      message: customerMessage({ id: "msg-42" }),
      conversationId: "conv-7",
      contactId: "contact-9",
    });

    await user.type(screen.getByLabelText("Corrección o nota para Seba"), 'La Bera SBR también se llama "Sport".');
    await user.click(screen.getByRole("button", { name: /guardar/i }));

    await waitFor(() => expect(createLessonMock).toHaveBeenCalled());
    expect(createLessonMock).toHaveBeenCalledWith(
      expect.objectContaining({ fakeClient: true }),
      AGENT,
      expect.objectContaining({
        scope: "global",
        kind: "nota",
        content: 'La Bera SBR también se llama "Sport".',
        messageId: "msg-42",
        conversationId: null,
        contactId: "contact-9",
      })
    );
    expect(successToast).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("con el alcance 'Solo este chat', manda el conversationId en vez de null", async () => {
    createLessonMock.mockResolvedValue(undefined);
    const user = crearUsuario();
    renderModal({ conversationId: "conv-7" });

    await user.click(screen.getByRole("button", { name: "Solo este chat" }));
    await user.type(screen.getByLabelText("Corrección o nota para Seba"), "Nota de prueba");
    await user.click(screen.getByRole("button", { name: /guardar/i }));

    await waitFor(() => expect(createLessonMock).toHaveBeenCalled());
    expect(createLessonMock.mock.calls[0][2]).toMatchObject({ scope: "conversacion", conversationId: "conv-7" });
  });

  it("con el tipo 'Sinónimo de búsqueda', arma content a partir de los dos campos y los manda como synonymFrom/synonymTo", async () => {
    createLessonMock.mockResolvedValue(undefined);
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByRole("button", { name: "Sinónimo de búsqueda" }));
    await user.type(screen.getByLabelText("Cómo lo dice el cliente"), "pastilla");
    await user.type(screen.getByLabelText("Cómo se llama en el catálogo"), "pastillas de freno");
    await user.click(screen.getByRole("button", { name: /guardar/i }));

    await waitFor(() => expect(createLessonMock).toHaveBeenCalled());
    expect(createLessonMock.mock.calls[0][2]).toMatchObject({
      kind: "sinonimo",
      content: "pastilla → pastillas de freno",
      synonymFrom: "pastilla",
      synonymTo: "pastillas de freno",
    });
  });

  it("cuando la guarda de identidad rechaza el texto, se muestra su mensaje y no se cierra el modal", async () => {
    const { LessonIdentityError } = await import("@/lib/mutations");
    createLessonMock.mockRejectedValueOnce(
      new LessonIdentityError({ categoria: "automatizacion", fragmento: "soy un bot" })
    );
    const user = crearUsuario();
    const { onOpenChange } = renderModal();

    await user.type(screen.getByLabelText("Corrección o nota para Seba"), "texto cualquiera");
    await user.click(screen.getByRole("button", { name: /guardar/i }));

    await waitFor(() => expect(screen.getByText(/«soy un bot»/)).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(dangerToast).not.toHaveBeenCalled();
  });

  it("si createLesson falla con otra cosa, avisa con el toast genérico", async () => {
    createLessonMock.mockRejectedValueOnce(new Error("sin conexión"));
    const user = crearUsuario();
    renderModal();

    await user.type(screen.getByLabelText("Corrección o nota para Seba"), "texto cualquiera");
    await user.click(screen.getByRole("button", { name: /guardar/i }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("No se pudo guardar la lección. Intenta de nuevo."));
  });
});
