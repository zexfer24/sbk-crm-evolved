/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VentasError from "./error";

// Mismo espejo de mocks que `agent-control/error.test.tsx` (ver el
// comentario ahí): `error.tsx` monta `AppRail`, que a su vez monta
// `AssignmentNotifier`.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

function fakeChannel() {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return channel;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn(), getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    channel: () => fakeChannel(),
    removeChannel: vi.fn(),
  }),
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: vi.fn() };
});

describe("VentasError", () => {
  it("muestra el mensaje en español y el rail de secciones", () => {
    render(<VentasError error={new Error("boom")} retry={vi.fn()} />);

    expect(screen.getByText("Ventas no pudo cargar")).toBeInTheDocument();
    expect(screen.getByLabelText("Ventas").getAttribute("data-active")).toBe("true");
  });

  it("el botón Reintentar llama a retry()", () => {
    const retry = vi.fn();
    render(<VentasError error={new Error("boom")} retry={retry} />);

    fireEvent.click(screen.getByRole("button", { name: /reintentar/i }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("avisa el error por consola", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("column saint_invoice_number does not exist");

    render(<VentasError error={error} retry={vi.fn()} />);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Ventas"), error);
    spy.mockRestore();
  });

  // Trampa del 9/9/2026 (ver el comentario en agent-control/error.test.tsx).
  it("deja exactamente dos hijos directos en .dash-frame (AppRail + el contenido)", () => {
    const { container } = render(<VentasError error={new Error("boom")} retry={vi.fn()} />);

    const frame = container.querySelector(".dash-frame");
    expect(frame?.childElementCount).toBe(2);
  });
});
