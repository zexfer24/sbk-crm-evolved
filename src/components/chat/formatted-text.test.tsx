import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormattedText } from "@/components/chat/formatted-text";

describe("FormattedText", () => {
  it("renders *negrita* (asterisco simple) como <strong>", () => {
    render(<FormattedText text="hola *mundo* como estas" />);
    const strong = screen.getByText("mundo");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders _itálica_ (guion bajo) como <em>", () => {
    render(<FormattedText text="hola _mundo_ como estas" />);
    const em = screen.getByText("mundo");
    expect(em.tagName).toBe("EM");
  });

  it("renders ~tachado~ como <s>", () => {
    render(<FormattedText text="hola ~mundo~ como estas" />);
    const s = screen.getByText("mundo");
    expect(s.tagName).toBe("S");
  });

  it("renders `monospace` (backtick simple) como <code>", () => {
    render(<FormattedText text="hola `mundo` como estas" />);
    const code = screen.getByText("mundo");
    expect(code.tagName).toBe("CODE");
  });

  it("no rompe texto plano sin marcadores", () => {
    const { container } = render(<FormattedText text="texto normal sin nada especial" />);
    expect(container.textContent).toBe("texto normal sin nada especial");
    expect(container.querySelector("strong,em,s,code")).toBeNull();
  });

  it("no formatea un asterisco suelto sin par (ej. lista '* item')", () => {
    const { container } = render(<FormattedText text="* item de lista sin cerrar" />);
    expect(container.textContent).toBe("* item de lista sin cerrar");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("no formatea '$50 * 2' como negrita (un solo asterisco sin par cercano)", () => {
    const { container } = render(<FormattedText text="cuesta $50 * 2 unidades" />);
    expect(container.textContent).toBe("cuesta $50 * 2 unidades");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("NO formatea **texto** (doble asterisco) como negrita — cambio de comportamiento intencional: WhatsApp usa un solo asterisco", () => {
    const { container } = render(<FormattedText text="hola **mundo** como estas" />);
    expect(container.textContent).toBe("hola **mundo** como estas");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("no formatea marcadores con espacio pegado adentro (ej. '* texto*')", () => {
    const { container } = render(<FormattedText text="hola * texto* como estas" />);
    expect(container.textContent).toBe("hola * texto* como estas");
    expect(container.querySelector("strong")).toBeNull();
  });
});
