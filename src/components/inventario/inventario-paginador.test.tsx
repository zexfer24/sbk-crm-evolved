/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InventoryParams } from "@/lib/inventory";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { InventarioPaginador, paginaDestino } from "@/components/inventario/inventario-paginador";

const base: InventoryParams = { query: "", filter: "todos", sort: "nombre", page: 3 };

function renderPaginador(params: Partial<InventoryParams> = {}, pages = 155) {
  return render(<InventarioPaginador params={{ ...base, ...params }} pages={pages} />);
}

function ui() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

beforeEach(() => {
  push.mockClear();
});

describe("paginaDestino", () => {
  it("vacío o no numérico no tiene destino", () => {
    expect(paginaDestino("", 155)).toBeNull();
    expect(paginaDestino("   ", 155)).toBeNull();
    expect(paginaDestino("abc", 155)).toBeNull();
    expect(paginaDestino("12abc", 155)).toBeNull();
  });

  it("0 y negativos van a la primera página", () => {
    expect(paginaDestino("0", 155)).toBe(1);
    expect(paginaDestino("-3", 155)).toBe(1);
  });

  it("pasarse del total va a la última página", () => {
    expect(paginaDestino("999", 155)).toBe(155);
    expect(paginaDestino("156", 155)).toBe(155);
  });

  it("un decimal se redondea hacia abajo", () => {
    expect(paginaDestino("3.7", 155)).toBe(3);
    expect(paginaDestino("0.5", 155)).toBe(1);
  });

  it("un entero dentro del rango se respeta", () => {
    expect(paginaDestino("42", 155)).toBe(42);
    expect(paginaDestino(" 7 ", 155)).toBe(7);
  });
});

describe("InventarioPaginador", () => {
  it("muestra la página actual en el input y el total", () => {
    renderPaginador();

    const input = screen.getByLabelText("Ir a la página") as HTMLInputElement;
    expect(input.value).toBe("3");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "155");
    expect(screen.getByText("155")).toBeInTheDocument();
  });

  it("marca la página actual con aria-current", () => {
    const { container } = renderPaginador();
    expect(container.querySelector('[aria-current="page"]')).not.toBeNull();
  });

  it("Enter en el input navega a esa página", async () => {
    renderPaginador();
    const input = screen.getByLabelText("Ir a la página");

    await ui().clear(input);
    await ui().type(input, "42{Enter}");

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/inventario?page=42");
  });

  it("el botón Ir navega a esa página", async () => {
    renderPaginador();
    const input = screen.getByLabelText("Ir a la página");
    const user = ui();

    await user.clear(input);
    await user.type(input, "10");
    await user.click(screen.getByRole("button", { name: "Ir" }));

    expect(push).toHaveBeenCalledWith("/inventario?page=10");
  });

  it("conserva búsqueda, filtro y orden en la URL", async () => {
    renderPaginador({ query: "tubo cg", filter: "agotados", sort: "precio" });
    const input = screen.getByLabelText("Ir a la página");
    const user = ui();

    await user.clear(input);
    await user.type(input, "9{Enter}");

    const href = push.mock.calls[0][0] as string;
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/inventario");
    expect(url.searchParams.get("q")).toBe("tubo cg");
    expect(url.searchParams.get("filtro")).toBe("agotados");
    expect(url.searchParams.get("orden")).toBe("precio");
    expect(url.searchParams.get("page")).toBe("9");
  });

  it("un número fuera de rango se acota a la última página", async () => {
    renderPaginador();
    const input = screen.getByLabelText("Ir a la página");
    const user = ui();

    await user.clear(input);
    await user.type(input, "999{Enter}");

    expect(push).toHaveBeenCalledWith("/inventario?page=155");
  });

  it("vacío no navega y el input vuelve a mostrar la página actual", async () => {
    renderPaginador();
    const input = screen.getByLabelText("Ir a la página") as HTMLInputElement;
    const user = ui();

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Ir" }));

    expect(push).not.toHaveBeenCalled();
    expect(input.value).toBe("3");
  });

  it("la misma página no navega", async () => {
    renderPaginador();
    const input = screen.getByLabelText("Ir a la página");
    const user = ui();

    await user.clear(input);
    await user.type(input, "3{Enter}");

    expect(push).not.toHaveBeenCalled();
  });

  it("ir a la página 1 no deja ?page= en la URL", async () => {
    renderPaginador();
    const input = screen.getByLabelText("Ir a la página");
    const user = ui();

    await user.clear(input);
    await user.type(input, "1{Enter}");

    expect(push).toHaveBeenCalledWith("/inventario");
  });

  it("se resincroniza cuando cambia la página de la URL", () => {
    const { rerender } = renderPaginador({ page: 3 });
    rerender(<InventarioPaginador params={{ ...base, page: 8 }} pages={155} />);

    expect((screen.getByLabelText("Ir a la página") as HTMLInputElement).value).toBe("8");
  });

  it("Anterior y Siguiente siguen siendo enlaces con su href", () => {
    renderPaginador({ query: "cg", page: 5 });

    expect(screen.getByRole("link", { name: "Anterior" })).toHaveAttribute("href", "/inventario?q=cg&page=4");
    expect(screen.getByRole("link", { name: "Siguiente" })).toHaveAttribute("href", "/inventario?q=cg&page=6");
  });

  it("Anterior queda deshabilitado en la primera página y Siguiente en la última", () => {
    const { unmount } = renderPaginador({ page: 1 });
    expect(screen.getByRole("link", { name: "Anterior" })).toHaveAttribute("data-disabled", "true");
    expect(screen.getByRole("link", { name: "Anterior" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Siguiente" })).not.toHaveAttribute("data-disabled");
    unmount();

    renderPaginador({ page: 155 });
    expect(screen.getByRole("link", { name: "Siguiente" })).toHaveAttribute("data-disabled", "true");
    expect(screen.getByRole("link", { name: "Anterior" })).not.toHaveAttribute("data-disabled");
  });
});
