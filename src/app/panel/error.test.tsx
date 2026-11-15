/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PanelError from "./error";

// T7, plan "Seba sale sin pisar a nadie" (19/9/2026). `error.tsx` monta
// `AppRail`, que a su vez monta `AssignmentNotifier` — mismo espejo de
// mocks que `app-rail.test.tsx` (useRouter, `@/lib/supabase/client`), pero
// acá `@heroui/react` necesita quedarse con el `Button` REAL (el botón
// "Reintentar" de esta pantalla lo usa) y solo pisar `toast`, así que se
// mockea con `importOriginal` en vez del mock casero de `app-rail.test.tsx`.
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

describe("PanelError", () => {
  it("muestra el mensaje en español y el rail de secciones", () => {
    render(<PanelError error={new Error("boom")} retry={vi.fn()} />);

    expect(screen.getByText("Los paneles no pudieron cargar")).toBeInTheDocument();
    expect(screen.getByLabelText("Paneles").getAttribute("data-active")).toBe("true");
  });

  it("el botón Reintentar llama a retry()", () => {
    const retry = vi.fn();
    render(<PanelError error={new Error("boom")} retry={retry} />);

    fireEvent.click(screen.getByRole("button", { name: /reintentar/i }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("avisa el error por consola (no hay lib/log.ts en un boundary de cliente)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("fetchLessons: relation does not exist");

    render(<PanelError error={error} retry={vi.fn()} />);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("paneles"), error);
    spy.mockRestore();
  });

  // 15/11/2026 (code-review): en el teléfono el rail no se ve; sin la barra
  // superior, un fallo dejaba al supervisor sin forma de salir de /panel.
  it("monta la navegación superior con Paneles activo, dentro del main", () => {
    const { container } = render(<PanelError error={new Error("boom")} retry={vi.fn()} />);

    const barra = container.querySelector("main header.dash-topbar");
    expect(barra).not.toBeNull();
    const nav = barra!.querySelector("nav.dash-nav");
    expect(nav).not.toBeNull();
    const activo = nav!.querySelector('[aria-current="page"]');
    expect(activo).toHaveTextContent("Paneles");
  });

  // Trampa del 9/9/2026: `.dash-frame` es un grid de dos columnas fijas
  // (`72px minmax(0, 1fr)`); un tercer hijo directo le roba la columna al
  // contenido y desarma la pantalla entera. `AppRail` ya se prueba solo en
  // `app-rail.test.tsx` (un solo hijo directo, el `<nav>`); acá lo que
  // importa es que `.dash-frame` reciba EXACTAMENTE dos hijos.
  it("deja exactamente dos hijos directos en .dash-frame (AppRail + el contenido)", () => {
    const { container } = render(<PanelError error={new Error("boom")} retry={vi.fn()} />);

    const frame = container.querySelector(".dash-frame");
    expect(frame?.childElementCount).toBe(2);
  });
});
