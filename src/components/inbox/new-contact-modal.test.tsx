/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { NewContactModal } from "@/components/inbox/new-contact-modal";
import type { Agent } from "@/lib/types";

const createContactConversationMock = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/mutations", () => ({
  createContactConversation: (...args: unknown[]) => createContactConversationMock(...args),
}));

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José Riera",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function renderModal(props: Partial<ComponentProps<typeof NewContactModal>> = {}) {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  const utils = render(
    <NewContactModal
      isOpen
      onOpenChange={onOpenChange}
      currentAgent={AGENT}
      onCreated={onCreated}
      {...props}
    />
  );
  return { ...utils, onOpenChange, onCreated };
}

beforeEach(() => {
  createContactConversationMock.mockReset();
});

describe("NewContactModal — validación en línea", () => {
  it("sin nombre no llama a la mutación", () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "+584141234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));

    expect(createContactConversationMock).not.toHaveBeenCalled();
  });

  it("un teléfono que no se puede entregar marca el error sin llamar a la mutación", () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Pedro" } });
    fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));

    expect(screen.getByText(/no se puede entregar/i)).toBeInTheDocument();
    expect(createContactConversationMock).not.toHaveBeenCalled();
  });
});

describe("NewContactModal — creación", () => {
  it("normaliza el teléfono, llama a la mutación con el agente actual y cierra avisando a onCreated", async () => {
    createContactConversationMock.mockResolvedValue({ conversationId: "conv-1", existed: false });
    const { onCreated, onOpenChange } = renderModal();

    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Pedro" } });
    fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "0414-1234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));

    await waitFor(() =>
      expect(createContactConversationMock).toHaveBeenCalledWith(expect.anything(), {
        displayName: "Pedro",
        phoneNumber: "+584141234567",
        agent: AGENT,
      })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreated).toHaveBeenCalledWith("conv-1", false);
  });

  it("con un número que ya tiene conversación, igual llama a onCreated con existed=true", async () => {
    createContactConversationMock.mockResolvedValue({ conversationId: "conv-existente", existed: true });
    const { onCreated } = renderModal();

    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Pedro" } });
    fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "+584141234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("conv-existente", true));
  });

  it("un error de red no cierra el modal ni llama a onCreated", async () => {
    createContactConversationMock.mockRejectedValue(new Error("network"));
    const { onOpenChange, onCreated } = renderModal();

    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Pedro" } });
    fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "+584141234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));

    await waitFor(() => expect(createContactConversationMock).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
