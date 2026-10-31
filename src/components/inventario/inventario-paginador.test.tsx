/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InventoryParams } from "@/lib/inventory";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { InventarioPaginador, paginaDestino, paginasVisibles } from "@/components/inventario/inventario-paginador";

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
    // Con los números de página, "155" también es un enlace: el total se busca DENTRO del formulario.
    expect(within(input.closest("form") as HTMLElement).getByText("155")).toBeInTheDocument();
  });

  it("marca la página actual con aria-current, UNA sola vez, y es el número, no el formulario", () => {
    const { container } = renderPaginador();
    const actuales = container.querySelectorAll('[aria-current="page"]');

    expect(actuales).toHaveLength(1);
    expect(actuales[0].tagName).toBe("A");
    expect(actuales[0]).toHaveTextContent("3");
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

/**
 * Números de página (30/10/2026, plan «Cada repuesto con su foto», T5a). Con ~160
 * páginas no caben todos: la primera, la última, la actual y sus vecinas, con «…»
 * en los huecos. Son ENLACES (funcionan sin JavaScript y se abren en otra
 * pestaña); el campo «Ir a la página» queda para saltos largos.
 */
describe("paginasVisibles", () => {
  it("página 1 de 161: 1, 2, …, 161", () => {
    expect(paginasVisibles(1, 161)).toEqual([1, 2, "…", 161]);
  });

  it("página 87 de 161: 1, …, 86, 87, 88, …, 161", () => {
    expect(paginasVisibles(87, 161)).toEqual([1, "…", 86, 87, 88, "…", 161]);
  });

  it("página 161 de 161: 1, …, 160, 161", () => {
    expect(paginasVisibles(161, 161)).toEqual([1, "…", 160, 161]);
  });

  it("sin huecos no pone «…»: página 2 de 4 son todas", () => {
    expect(paginasVisibles(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("cada hueco se marca con «…», aunque falte una sola página (como el mockup: 4 de 6 → 1, …, 3, 4, 5, 6)", () => {
    expect(paginasVisibles(3, 7)).toEqual([1, 2, 3, 4, "…", 7]);
    expect(paginasVisibles(4, 6)).toEqual([1, "…", 3, 4, 5, 6]);
    expect(paginasVisibles(5, 9)).toEqual([1, "…", 4, 5, 6, "…", 9]);
  });

  it("una sola página: solo la 1", () => {
    expect(paginasVisibles(1, 1)).toEqual([1]);
  });
});

describe("InventarioPaginador — números de página", () => {
  function numeros() {
    return within(screen.getByRole("navigation", { name: "Paginación del inventario" }))
      .getAllByRole("link", { name: /^Página \d+$/ })
      .map((a) => a.textContent);
  }

  it("página 1 de 161: 1 2 … 161", () => {
    const { container } = renderPaginador({ page: 1 }, 161);
    expect(numeros()).toEqual(["1", "2", "161"]);
    expect(container.querySelectorAll(".inv-pag-pages .salto")).toHaveLength(1);
  });

  it("página 87 de 161: 1 … 86 87 88 … 161", () => {
    const { container } = renderPaginador({ page: 87 }, 161);
    expect(numeros()).toEqual(["1", "86", "87", "88", "161"]);
    expect(container.querySelectorAll(".inv-pag-pages .salto")).toHaveLength(2);
  });

  it("página 161 de 161: 1 … 160 161", () => {
    renderPaginador({ page: 161 }, 161);
    expect(numeros()).toEqual(["1", "160", "161"]);
  });

  it("el «…» es decorativo: no se anuncia ni se puede pulsar", () => {
    const { container } = renderPaginador({ page: 87 }, 161);
    for (const salto of container.querySelectorAll(".inv-pag-pages .salto")) {
      expect(salto).toHaveAttribute("aria-hidden", "true");
      expect(salto.tagName).not.toBe("A");
    }
  });

  it("aria-current=page solo en la actual", () => {
    renderPaginador({ page: 87 }, 161);
    expect(screen.getByRole("link", { name: "Página 87" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Página 86" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Página 161" })).not.toHaveAttribute("aria-current");
  });

  it("cada número es un enlace que conserva búsqueda, filtro y orden; la página 1 no deja ?page=", () => {
    renderPaginador({ query: "tubo cg", filter: "agotados", sort: "precio", page: 87 }, 161);

    const url = new URL(screen.getByRole("link", { name: "Página 88" }).getAttribute("href") as string, "http://localhost");
    expect(url.pathname).toBe("/inventario");
    expect(url.searchParams.get("q")).toBe("tubo cg");
    expect(url.searchParams.get("filtro")).toBe("agotados");
    expect(url.searchParams.get("orden")).toBe("precio");
    expect(url.searchParams.get("page")).toBe("88");

    const primera = new URL(screen.getByRole("link", { name: "Página 1" }).getAttribute("href") as string, "http://localhost");
    expect(primera.searchParams.has("page")).toBe(false);
  });

  it("las flechas son íconos con aria-label (Anterior / Siguiente), sin texto visible", () => {
    renderPaginador({ page: 5 }, 161);

    const anterior = screen.getByRole("link", { name: "Anterior" });
    const siguiente = screen.getByRole("link", { name: "Siguiente" });
    expect(anterior).toHaveTextContent("");
    expect(siguiente).toHaveTextContent("");
    expect(anterior.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(siguiente.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("el formulario «Ir a la página» sigue ahí, a la par de los números", () => {
    renderPaginador({ page: 87 }, 161);
    const nav = screen.getByRole("navigation", { name: "Paginación del inventario" });
    expect(within(nav).getByLabelText("Ir a la página")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Ir" })).toBeInTheDocument();
  });
});
