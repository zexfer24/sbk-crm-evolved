/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TemplatePickerModal } from "@/components/chat/template-picker-modal";
import type { WhatsappTemplate } from "@/lib/types";

/**
 * T3.3 (5/9/2026): el selector deja de ser una lista con un botón "Usar" que
 * manda tal cual — una plantilla con variables abre un paso intermedio que
 * pide llenarlas, con sugerencias y una vista previa, antes de poder enviar.
 */

const fetchConversationQuotesMock = vi.fn();

vi.mock("@/lib/data", () => ({
  fetchConversationQuotes: (...args: unknown[]) => fetchConversationQuotesMock(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

function template(overrides: Partial<WhatsappTemplate> = {}): WhatsappTemplate {
  return {
    id: "tpl-1",
    name: "pedido_listo",
    language: "es",
    category: "utility",
    bodyPreview: "Hola {{1}}, tu repuesto {{2}} ya está listo para retirar.",
    status: "approved",
    ...overrides,
  };
}

function renderModal(props: Partial<React.ComponentProps<typeof TemplatePickerModal>> = {}) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <TemplatePickerModal
      isOpen
      onOpenChange={onOpenChange}
      templates={[template()]}
      contactName="Pedro"
      conversationId="conv-1"
      onSelect={onSelect}
      {...props}
    />
  );
  return { ...utils, onSelect, onOpenChange };
}

beforeEach(() => {
  fetchConversationQuotesMock.mockReset();
  fetchConversationQuotesMock.mockResolvedValue([]);
});

describe("TemplatePickerModal — detecta variables en body_preview", () => {
  it("una plantilla sin {{n}} se envía directo, sin pedir nada", () => {
    const { onSelect } = renderModal({
      templates: [template({ bodyPreview: "Gracias por tu compra." })],
    });

    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "pedido_listo" }), []);
  });

  it("una plantilla con dos variables abre un campo por cada una, no la manda todavía", () => {
    const { onSelect } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    expect(screen.getByLabelText("Variable {{1}}")).toBeInTheDocument();
    expect(screen.getByLabelText("Variable {{2}}")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("cuenta la variable más alta, no cuántas veces aparece {{1}}", () => {
    renderModal({
      templates: [template({ bodyPreview: "Hola {{1}}, {{1}} tu pedido {{3}} está listo." })],
    });

    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    expect(screen.getByLabelText("Variable {{1}}")).toBeInTheDocument();
    expect(screen.getByLabelText("Variable {{2}}")).toBeInTheDocument();
    expect(screen.getByLabelText("Variable {{3}}")).toBeInTheDocument();
  });
});

describe("TemplatePickerModal — sugerencias y vista previa", () => {
  it("sugiere el nombre del contacto y lo pone en el campo al hacer clic", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    // La plantilla de prueba tiene dos variables: cada campo ofrece su propia
    // sugerencia de "Pedro", así que hay dos botones con ese nombre.
    const [sugerenciaCampo1] = screen.getAllByRole("button", { name: "Pedro" });
    fireEvent.click(sugerenciaCampo1);

    expect(screen.getByLabelText("Variable {{1}}")).toHaveValue("Pedro");
    expect(screen.getByLabelText("Variable {{2}}")).toHaveValue("");
  });

  it("con una cotización reciente en el chat, la ofrece como sugerencia en cada campo", async () => {
    fetchConversationQuotesMock.mockResolvedValue([
      { id: "q-1", productId: "p-1", productName: "el carburador PZ27", priceUsd: 30, priceBs: 1000, bcvRate: 33, quotedAt: "2026-09-04T12:00:00.000Z" },
    ]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "el carburador PZ27" })).toHaveLength(2)
    );
  });

  it("sin cotizaciones en el chat, no ofrece esa sugerencia (solo el nombre del contacto)", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    await waitFor(() => expect(fetchConversationQuotesMock).toHaveBeenCalled());
    expect(screen.queryByText(/carburador/i)).not.toBeInTheDocument();
  });

  it("la vista previa muestra el cuerpo con las variables ya sustituidas", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    fireEvent.change(screen.getByLabelText("Variable {{1}}"), { target: { value: "Pedro" } });
    fireEvent.change(screen.getByLabelText("Variable {{2}}"), { target: { value: "el carburador PZ27" } });

    expect(screen.getByText("Hola Pedro, tu repuesto el carburador PZ27 ya está listo para retirar.")).toBeInTheDocument();
  });

  it("con huecos sin llenar, la vista previa deja el {{n}} a la vista", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    fireEvent.change(screen.getByLabelText("Variable {{1}}"), { target: { value: "Pedro" } });

    expect(screen.getByText("Hola Pedro, tu repuesto {{2}} ya está listo para retirar.")).toBeInTheDocument();
  });
});

describe("TemplatePickerModal — enviar solo con todo lleno", () => {
  it("el botón de enviar está deshabilitado mientras falte una variable", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    expect(screen.getByRole("button", { name: /enviar/i })).toBeDisabled();
  });

  it("con todo lleno, confirmar llama a onSelect con la plantilla y los valores en orden", () => {
    const { onSelect } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    fireEvent.change(screen.getByLabelText("Variable {{1}}"), { target: { value: "Pedro" } });
    fireEvent.change(screen.getByLabelText("Variable {{2}}"), { target: { value: "el carburador PZ27" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pedido_listo" }),
      ["Pedro", "el carburador PZ27"]
    );
  });

  it("volver regresa a la lista sin enviar nada", () => {
    const { onSelect } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /usar/i }));

    fireEvent.click(screen.getByRole("button", { name: /volver/i }));

    expect(screen.getByText("pedido_listo")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("TemplatePickerModal — plantillas no aprobadas", () => {
  // El tooltip de heroui envuelve el botón deshabilitado en un contenedor que
  // TAMBIÉN expone role="button" (para poder mostrar el tooltip aunque el
  // hijo esté deshabilitado): getByRole encontraría los dos. Se filtra al
  // <button> real, que es el único al que aplica `toBeDisabled()`.
  function botonesUsar() {
    return screen.getAllByRole("button", { name: /usar/i }).filter((el) => el.tagName === "BUTTON");
  }

  it("una plantilla pendiente/rechazada está deshabilitada con un tooltip que explica por qué", () => {
    renderModal({
      templates: [template({ id: "tpl-2", name: "promo_nueva", status: "pending" })],
    });

    const [boton] = botonesUsar();
    expect(boton).toBeDisabled();
  });

  it("una aprobada y una pendiente conviven, solo la aprobada manda", () => {
    renderModal({
      templates: [
        template({ id: "tpl-1", name: "pedido_listo", bodyPreview: "Gracias por tu compra." }),
        template({ id: "tpl-2", name: "promo_nueva", status: "pending" }),
      ],
    });

    const botones = botonesUsar();
    expect(botones).toHaveLength(2);
    expect(botones[0]).not.toBeDisabled();
    expect(botones[1]).toBeDisabled();
  });
});
