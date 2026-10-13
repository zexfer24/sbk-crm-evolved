/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Agent } from "@/lib/types";
import { InventarioView } from "@/components/inventario/inventario-view";

/**
 * El inventario se cargó el 24 de agosto de 2026 y no se volvió a tocar. La
 * sincronización vive en una aplicación aparte del dueño y todavía no corre —
 * pero esta pantalla mostraba 5.438 repuestos igual que si se hubieran cargado
 * esa mañana. El dueño se enteró consultando la base de datos.
 *
 * Es lo mismo que ya pasó con la tasa del BCV, y por eso la tarjeta nueva se
 * parece a aquella: el número grande y, pegada, la antigüedad.
 */

// Lo que se prueba acá es la tarjeta de antigüedad; los vecinos no pintan nada.
vi.mock("@/components/app-rail", () => ({ AppRail: () => null, AppTopNav: () => null }));
vi.mock("@/components/url-search-box", () => ({ UrlSearchBox: () => null }));
vi.mock("@/components/inventario/producto-fila", () => ({ ProductoFila: () => null }));

const ASESOR: Agent = {
  id: "agent-1",
  displayName: "Rosa",
  fullName: "Rosa Pérez",
  avatarUrl: null,
  role: "supervisor",
  isActive: true,
};

const CATALOGO = {
  engineFamilies: 12,
  commercialModels: 40,
  modelEngineLinks: 60,
  compatibilityRules: 900,
  searchSynonyms: 30,
};

function haceDias(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

function pintar(updatedAt: string | null, withoutWeight = 0) {
  render(
    <InventarioView
      currentAgent={ASESOR}
      products={[]}
      total={0}
      totals={{ productos: 5438, activos: 5435, agotados: 2474, bajos: 300, withoutWeight, updatedAt }}
      catalog={CATALOGO}
      params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
      bcvRate={{ rate: 791.3248, rateDate: "2026-08-27", isStale: false }}
    />
  );

  return screen.getByText("Actualizado").closest(".cli-stat");
}

describe("InventarioView — la antigüedad del inventario se ve", () => {
  it("muestra cuántos días lleva el catálogo sin cambios", () => {
    const tarjeta = pintar(haceDias(4));

    expect(tarjeta).toHaveTextContent("4 días");
    expect(tarjeta).toHaveTextContent(/La IA sigue cotizando con esto/i);
  });

  /** El mismo tratamiento visual que la tasa vieja: si no se distingue, no sirve de nada. */
  it("marca la tarjeta como vieja para que se vea distinta", () => {
    expect(pintar(haceDias(4))).toHaveAttribute("data-stale", "true");
  });

  it("con el inventario de hoy no alarma", () => {
    const tarjeta = pintar(haceDias(0));

    expect(tarjeta).toHaveTextContent("Hoy");
    expect(tarjeta).not.toHaveAttribute("data-stale");
  });

  it("sin fecha lo dice, en vez de mostrar un cero", () => {
    const tarjeta = pintar(null);

    expect(tarjeta).toHaveTextContent("—");
    expect(tarjeta).toHaveTextContent(/no se sabe/i);
  });
});

/** T4, "Seis frentes del buzón" (8/9/2026): el hueco de peso que Cashea exige para el envío gratis. */
describe("InventarioView — Sin peso", () => {
  it("la tarjeta de resumen muestra el conteo y por qué importa", () => {
    pintar(haceDias(0), 37);

    // "Sin peso" aparece dos veces: la etiqueta de la tarjeta y la píldora
    // de filtro. La tarjeta es la que tiene el conteo grande al lado.
    const tarjeta = screen.getAllByText("Sin peso").map((el) => el.closest(".cli-stat")).find(Boolean);
    expect(tarjeta).toHaveTextContent("37");
    expect(tarjeta).toHaveTextContent(/Cashea/i);
  });

  it("la píldora de filtro «Sin peso» está entre las de disponibilidad", () => {
    pintar(haceDias(0));

    expect(screen.getByRole("link", { name: "Sin peso" })).toBeInTheDocument();
  });
});

/**
 * T3 del plan "El inventario llega de Saint y no se toca a mano" (25/9/2026):
 * la pantalla deja de hablar de "copia ni sincronización en el medio" (era
 * falso desde que `saint.sync_products()` corre cada minuto) y el filtro que
 * antes se llamaba "Desactivados" pasa a nombrar la razón real —Saint dio de
 * baja el repuesto, no un asesor desde acá.
 */
describe("InventarioView — textos de Saint", () => {
  it("el subtítulo explica que Saint sincroniza nombre, precio y existencia cada minuto", () => {
    pintar(haceDias(0));

    expect(screen.getByText(/llegan de Saint cada minuto/i)).toBeInTheDocument();
  });

  it("la píldora del filtro se llama «Fuera de Saint», no «Desactivados»", () => {
    pintar(haceDias(0));

    expect(screen.getByRole("link", { name: "Fuera de Saint" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Desactivados" })).not.toBeInTheDocument();
  });
});

/**
 * T5, plan "Carrito de cotización en el Inventario, con Cashea" (12/10/2026) y
 * T3 del plan "Inventario y caja" (13/10/2026): la vista queda envuelta en el
 * provider del carrito y el botón que abre el panel es FLOTANTE (abajo a la
 * derecha), ya no una píldora de la cabecera. `ProductoFila` está mockeada
 * arriba, así que acá no se puede agregar nada: se prueba que el botón existe,
 * arranca en cero, vive fuera de `.dash-header` y de `.dash-frame` y que la
 * vista sigue pintando lo de siempre. Agregar desde una fila se prueba en
 * `producto-fila-carrito.test.tsx`; el globo de unidades, en
 * `carrito-boton.test.tsx`.
 */
describe("InventarioView — botón flotante del carrito", () => {
  it("hay UN solo botón «Abrir carrito», flotante y sin unidades al arrancar", () => {
    pintar(haceDias(0));

    const botones = screen.getAllByRole("button", { name: "Abrir carrito" });
    expect(botones).toHaveLength(1);
    expect(botones[0]).toHaveClass("inv-carrito-flotante");
    expect(botones[0].querySelector(".inv-carrito-globo")).toBeNull();
  });

  it("ya no está en la cabecera: se monta dentro de <main>, fuera del flujo de .dash-content", () => {
    pintar(haceDias(0));

    const boton = screen.getByRole("button", { name: "Abrir carrito" });
    expect(boton.closest(".dash-header")).toBeNull();
    expect(boton.closest("main")).not.toBeNull();
  });

  it("el provider y el botón no agregan hijos directos a .dash ni a .dash-frame (trampa del grid, 9/9/2026)", () => {
    pintar(haceDias(0));

    const frame = document.querySelector(".dash-frame");
    expect(frame).not.toBeNull();
    // `.dash-frame` es un grid de dos columnas: el rail (mockeado a null) y `main`.
    expect(frame!.childElementCount).toBe(1);
    expect(document.querySelector(".dash")?.childElementCount).toBe(1);
    expect(document.querySelector(".dash")?.parentElement?.childElementCount).toBe(1);
  });
});

/**
 * T4 del plan "Inventario y caja" (13/10/2026): bajo «Sin peso» la lista abre
 * por existencia y la nota del panel lo dice, discreta. Ninguna píldora de
 * orden queda activa (ninguna es ese orden); un orden explícito apaga la nota.
 */
describe("InventarioView — orden por defecto de «Sin peso»", () => {
  function pintarOrden(filter: "todos" | "sin-peso", sort: "nombre" | "existencia" | "stock") {
    render(
      <InventarioView
        currentAgent={ASESOR}
        products={[]}
        total={0}
        totals={{ productos: 10, activos: 10, agotados: 0, bajos: 0, withoutWeight: 3, updatedAt: haceDias(0) }}
        catalog={CATALOGO}
        params={{ query: "", filter, sort, page: 1 }}
        bcvRate={{ rate: 791.3248, rateDate: "2026-08-27", isStale: false }}
      />
    );
  }

  it("sin-peso por existencia: la nota lo dice y ninguna píldora de orden está activa", () => {
    pintarOrden("sin-peso", "existencia");

    expect(screen.getByText(/Ordenado por existencia, de mayor a menor/)).toBeInTheDocument();
    const grupo = screen.getByRole("group", { name: "Ordenar repuestos" });
    expect(grupo.querySelector('[data-active="true"]')).toBeNull();
  });

  it("sin-peso con «Por nombre» explícito: la nota se va y la píldora de nombre queda activa", () => {
    pintarOrden("sin-peso", "nombre");

    expect(screen.queryByText(/Ordenado por existencia/)).toBeNull();
    expect(screen.getByRole("link", { name: "Por nombre" })).toHaveAttribute("data-active", "true");
    // Escribe orden=nombre: sin él el clic no cambiaría nada bajo este filtro.
    expect(screen.getByRole("link", { name: "Por nombre" })).toHaveAttribute(
      "href",
      "/inventario?filtro=sin-peso&orden=nombre"
    );
  });

  it("los filtros no arrastran el orden por defecto: «Todos» desde sin-peso va limpio y «Sin peso» desde todos no escribe orden", () => {
    pintarOrden("sin-peso", "existencia");
    expect(screen.getByRole("link", { name: "Todos" })).toHaveAttribute("href", "/inventario");
    cleanup();

    pintarOrden("todos", "nombre");
    expect(screen.getByRole("link", { name: "Sin peso" })).toHaveAttribute("href", "/inventario?filtro=sin-peso");
    expect(screen.queryByText(/Ordenado por existencia/)).toBeNull();
  });
});
