/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhatsappPreview } from "@/components/agent-control/whatsapp-preview";

describe("WhatsappPreview (T4, Entrega 2 de Seba v2, 16/11/2026)", () => {
  it("pinta la negrita de WhatsApp (*texto*) como <strong> dentro de la burbuja con su etiqueta", () => {
    render(<WhatsappPreview text={"Banco: *Banesco*\nTitular: SBK"} label="Vista previa de Pago móvil" />);

    const burbuja = screen.getByLabelText("Vista previa de Pago móvil");
    const negrita = burbuja.querySelector("strong");
    expect(negrita).not.toBeNull();
    expect(negrita).toHaveTextContent("Banesco");
  });

  it("con el texto vacío o en blanco muestra la pista en vez de una burbuja vacía", () => {
    const { rerender } = render(<WhatsappPreview text="   " label="Vista previa" emptyHint="Escribe los datos" />);
    expect(screen.getByText("Escribe los datos")).toBeInTheDocument();

    rerender(<WhatsappPreview text="" label="Vista previa" />);
    expect(screen.getByText("Sin texto todavía")).toBeInTheDocument();
  });

  it("el aria-label es exactamente el recibido", () => {
    render(<WhatsappPreview text="hola" label="Vista previa de la bienvenida" />);
    expect(screen.getByLabelText("Vista previa de la bienvenida")).toBeInTheDocument();
  });
});
