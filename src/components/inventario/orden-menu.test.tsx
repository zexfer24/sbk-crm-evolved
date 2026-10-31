/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InventoryParams } from "@/lib/inventory";
import { OrdenMenu } from "@/components/inventario/orden-menu";

/**
 * Caja «Ordenar por» (30/10/2026, plan «Cada repuesto con su foto», T5a). Reemplaza
 * a las dos tiras de píldoras de la barra: un botón que despliega «Mostrar» (los
 * filtros) y «Ordenar». Cada opción sigue siendo un ENLACE: la URL manda, igual que
 * con las píldoras, así que el menú no guarda estado de filtro ni de orden.
 */

const base: InventoryParams = { query: "", filter: "todos", sort: "nombre", page: 1 };

function ui() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function pintar(params: Partial<InventoryParams> = {}) {
  return render(<OrdenMenu params={{ ...base, ...params }} />);
}

function boton() {
  return screen.getByRole("button", { name: "Ordenar por" });
}

describe("OrdenMenu — abrir y cerrar", () => {
  it("arranca cerrado: el botón dice «Ordenar por» y no hay ninguna opción a la vista", () => {
    pintar();

    expect(boton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Agotados" })).toBeNull();
    expect(screen.queryByText("Mostrar")).toBeNull();
  });

  it("el botón apunta con aria-controls al panel que despliega", async () => {
    pintar();
    await ui().click(boton());

    const panel = document.getElementById(boton().getAttribute("aria-controls") as string);
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(screen.getByRole("link", { name: "Agotados" }));
  });

  it("abre con un clic y muestra «Mostrar» y «Ordenar»", async () => {
    pintar();
    await ui().click(boton());

    expect(boton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Mostrar")).toBeInTheDocument();
    expect(screen.getByText("Ordenar")).toBeInTheDocument();
  });

  it("un segundo clic en el botón lo vuelve a cerrar", async () => {
    pintar();
    const user = ui();
    await user.click(boton());
    await user.click(boton());

    expect(boton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Mostrar")).toBeNull();
  });

  it("Esc lo cierra y el foco vuelve al botón", async () => {
    pintar();
    const user = ui();
    await user.click(boton());
    // Un asesor que navega con el teclado está parado en una opción, no en el botón.
    screen.getByRole("link", { name: "Agotados" }).focus();

    await user.keyboard("{Escape}");

    expect(boton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Mostrar")).toBeNull();
    expect(boton()).toHaveFocus();
  });

  it("un clic fuera lo cierra", async () => {
    pintar();
    const user = ui();
    await user.click(boton());
    expect(screen.getByText("Mostrar")).toBeInTheDocument();

    await user.click(document.body);

    expect(boton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Mostrar")).toBeNull();
  });

  it("un clic DENTRO del panel (en un título) no lo cierra", async () => {
    pintar();
    const user = ui();
    await user.click(boton());
    await user.click(screen.getByText("Mostrar"));

    expect(boton()).toHaveAttribute("aria-expanded", "true");
  });

  it("elegir una opción lo cierra (la navegación no desmonta el componente)", async () => {
    pintar();
    const user = ui();
    await user.click(boton());

    // jsdom no navega: alcanza con que el clic dispare el cierre.
    await user.click(screen.getByRole("link", { name: "Agotados" }));

    expect(boton()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("OrdenMenu — las opciones", () => {
  it("«Mostrar» trae los seis filtros, «Sin foto» incluido, con su marca «nuevo»", async () => {
    pintar();
    await user_abrir();

    const mostrar = screen.getByRole("group", { name: "Mostrar" });
    for (const nombre of ["Todos", "Agotados", "Bajo stock", "Fuera de Saint", "Sin peso", "Sin foto"]) {
      expect(within(mostrar).getByRole("link", { name: nombre })).toBeInTheDocument();
    }
    expect(within(mostrar).getAllByRole("link")).toHaveLength(6);
    expect(within(mostrar).getByText("nuevo")).toBeInTheDocument();
  });

  it("«Ordenar» trae los tres órdenes con los nombres reales de la app", async () => {
    pintar();
    await user_abrir();

    const ordenar = screen.getByRole("group", { name: "Ordenar" });
    expect(within(ordenar).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Por nombre",
      "Menos stock primero",
      "Más caros primero",
    ]);
  });

  it("la opción activa lleva aria-current, una por sección, y solo ella", async () => {
    pintar({ filter: "agotados", sort: "precio" });
    await user_abrir();

    const activas = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "true");
    expect(activas.map((a) => a.textContent)).toEqual(["Agotados", "Más caros primero"]);
  });

  it("los enlaces de filtro conservan la búsqueda, reinician la página y no arrastran el orden por defecto", async () => {
    pintar({ query: "tubo cg", filter: "sin-peso", sort: "existencia", page: 4 });
    await user_abrir();

    // Desde «Sin peso» (orden implícito: existencia) a «Todos» no escribe orden.
    expect(screen.getByRole("link", { name: "Todos" })).toHaveAttribute("href", "/inventario?q=tubo+cg");
    expect(screen.getByRole("link", { name: "Agotados" })).toHaveAttribute(
      "href",
      "/inventario?q=tubo+cg&filtro=agotados"
    );
  });

  it("los enlaces de orden conservan q y filtro y llevan a la página 1", async () => {
    pintar({ query: "tubo cg", filter: "agotados", sort: "nombre", page: 7 });
    await user_abrir();

    const href = screen.getByRole("link", { name: "Más caros primero" }).getAttribute("href") as string;
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/inventario");
    expect(url.searchParams.get("q")).toBe("tubo cg");
    expect(url.searchParams.get("filtro")).toBe("agotados");
    expect(url.searchParams.get("orden")).toBe("precio");
    // Página 1 = sin `page` en la URL.
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("bajo «Sin peso», «Por nombre» escribe orden=nombre (si no, volvería al orden implícito y no haría nada)", async () => {
    pintar({ filter: "sin-peso", sort: "existencia" });
    await user_abrir();

    expect(screen.getByRole("link", { name: "Por nombre" })).toHaveAttribute(
      "href",
      "/inventario?filtro=sin-peso&orden=nombre"
    );
  });
});

describe("OrdenMenu — el punto azul", () => {
  it("sin nada fuera de lo normal no hay punto", () => {
    const { container } = pintar();
    expect(container.querySelector(".inv-orden-punto")).toBeNull();
  });

  it("un filtro distinto de «Todos» lo enciende", () => {
    const { container } = pintar({ filter: "agotados" });
    expect(container.querySelector(".inv-orden-punto")).not.toBeNull();
  });

  it("un orden distinto del que rige por defecto lo enciende", () => {
    const { container } = pintar({ sort: "stock" });
    expect(container.querySelector(".inv-orden-punto")).not.toBeNull();
  });

  it("«Sin peso» ordenado por existencia (su orden por defecto) enciende el punto solo por el filtro, no por el orden", () => {
    // El filtro ya lo enciende: lo que se comprueba es que `existencia` no cuente además como "orden raro".
    const { container, rerender } = pintar({ filter: "sin-peso", sort: "existencia" });
    expect(container.querySelectorAll(".inv-orden-punto")).toHaveLength(1);
    rerender(<OrdenMenu params={{ ...base, filter: "todos", sort: "nombre" }} />);
    expect(container.querySelector(".inv-orden-punto")).toBeNull();
  });
});

async function user_abrir() {
  await ui().click(boton());
}
