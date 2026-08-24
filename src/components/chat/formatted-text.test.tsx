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

/**
 * Los enlaces llegan todo el día: el que manda el cliente con una referencia,
 * y ahora también el del mapa cuando comparte su ubicación. Como texto plano
 * hay que seleccionarlo y copiarlo a mano, que con un mapa es directamente
 * inservible.
 */
describe("FormattedText — enlaces", () => {
  it("convierte una dirección web en un enlace que se puede tocar", () => {
    render(<FormattedText text="Mirá esto https://sbk.motorcycles/catalogo" />);

    const enlace = screen.getByRole("link", { name: "https://sbk.motorcycles/catalogo" });
    expect(enlace).toHaveAttribute("href", "https://sbk.motorcycles/catalogo");
  });

  it("abre en otra pestaña sin dejar que la página destino toque la nuestra", () => {
    render(<FormattedText text="https://ejemplo.com" />);

    const enlace = screen.getByRole("link");
    expect(enlace).toHaveAttribute("target", "_blank");
    expect(enlace).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("respeta el texto de alrededor", () => {
    const { container } = render(<FormattedText text="antes https://ejemplo.com después" />);
    expect(container.textContent).toBe("antes https://ejemplo.com después");
  });

  it("no convierte en enlace algo que no es una dirección web", () => {
    render(<FormattedText text="escribime a javascript:alert(1) o a ftp://viejo" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("el enlace convive con el formato de WhatsApp", () => {
    render(<FormattedText text="*Mirá* https://ejemplo.com" />);
    expect(screen.getByRole("link")).toBeInTheDocument();
    expect(screen.getByText("Mirá").tagName).toBe("STRONG");
  });
});
