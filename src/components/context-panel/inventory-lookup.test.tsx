/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { InventoryLookup } from "@/components/context-panel/inventory-lookup";
import type { Product } from "@/lib/types";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";

/**
 * T6, plan "El mostrador busca sin salir del chat" (27/9/2026, D5).
 *
 * El panel derecho gana una búsqueda de inventario de SOLO LECTURA. El
 * riesgo de siempre con una búsqueda con debounce (mismo que resolvió
 * `url-search-box.tsx`, T4, esta misma corrida): una respuesta de red
 * atrasada no puede pisar lo que el asesor ya está viendo.
 */

const searchProductsForLookup = vi.fn();
vi.mock("@/lib/inventory-data", () => ({
  searchProductsForLookup: (...args: unknown[]) => searchProductsForLookup(...args),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Bujía CR7HSA",
    brand: "NGK",
    price: 87,
    currency: "VES",
    stockQuantity: 12,
    description: null,
    isActive: true,
    updatedAt: "2026-09-27T00:00:00.000Z",
    compatibility: [],
    weightKg: null,
    saintCode: "1234",
    saintAddedAt: null,
    saintRemovedAt: null,
    ...overrides,
  };
}

const RATE: BcvRateSummary = { rate: 40, rateDate: "2026-09-27", isStale: false };

beforeEach(() => {
  searchProductsForLookup.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Buscar en el inventario"), { target: { value } });
}

function flush() {
  act(() => {
    vi.runAllTimers();
  });
}

/**
 * Deja correr los microtasks pendientes (el `.then()`/`.catch()` de la
 * promesa que `flush()` ya disparó). Con `vi.useFakeTimers()` activo, el
 * `waitFor` de Testing Library NO sirve acá: internamente sondea con sus
 * propios timers, que quedan tan congelados como los del componente y el
 * test cuelga hasta el timeout real de Vitest (medido: 15 s por caso, sin
 * ninguna aserción fallida de verdad). Una promesa ya resuelta no necesita
 * sondeo, solo ceder el turno al microtask queue — que las fake timers de
 * Vitest NUNCA tocan.
 */
async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("InventoryLookup", () => {
  it("arranca vacío con una sugerencia de qué escribir, sin buscar nada", () => {
    render(<InventoryLookup bcvRate={RATE} />);
    expect(screen.getByText(/escribe un nombre, una marca o un código/i)).toBeInTheDocument();
    expect(searchProductsForLookup).not.toHaveBeenCalled();
  });

  it("busca tras el debounce y pinta código, existencia, Bs y $ redondeado", async () => {
    searchProductsForLookup.mockResolvedValue([product()]);
    render(<InventoryLookup bcvRate={RATE} />);

    type("bujia");
    expect(searchProductsForLookup).not.toHaveBeenCalled();
    flush();

    await flushPromises();
    expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument();
    expect(searchProductsForLookup).toHaveBeenCalledTimes(1);
    // T9 (29/9/2026): páginas de 20, primera página desde el renglón 0.
    expect(searchProductsForLookup).toHaveBeenCalledWith(expect.anything(), "bujia", 20, 0);

    expect(screen.getByText("1234")).toBeInTheDocument();
    expect(screen.getByText("12 en stock")).toBeInTheDocument();
    expect(screen.getByText("Bs. 87.00")).toBeInTheDocument();
    // 87 / 40 = 2,175 -> redondeado hacia arriba a 2,20 (usdFromBs, D1).
    expect(screen.getByText("$ 2.20")).toBeInTheDocument();
  });

  it("sin tasa BCV muestra solo la moneda real, sin inventar un dólar", async () => {
    searchProductsForLookup.mockResolvedValue([product()]);
    render(<InventoryLookup bcvRate={null} />);

    type("bujia");
    flush();

    await flushPromises();
    expect(screen.getByText("Bs. 87.00")).toBeInTheDocument();
    expect(screen.queryByText(/^\$ /)).not.toBeInTheDocument();
  });

  it("marca un producto inactivo como Retirado", async () => {
    searchProductsForLookup.mockResolvedValue([product({ isActive: false })]);
    render(<InventoryLookup bcvRate={RATE} />);

    type("bujia");
    flush();

    await flushPromises();
    expect(screen.getByText("Retirado")).toBeInTheDocument();
    // T9 (29/9/2026): antes llevaba `ac-badge`, una clase de la hoja de Control
    // IA que NO se carga en /inbox — se veía como texto suelto y grande (lo
    // destapó Playwright). Ahora es una clase de la hoja del propio panel.
    expect(screen.getByText("Retirado")).toHaveClass("crm-lookup-retired");
    expect(screen.getByText("Retirado")).not.toHaveClass("ac-badge");
  });

  it("sin código Saint dice 'Sin código'", async () => {
    searchProductsForLookup.mockResolvedValue([product({ saintCode: null })]);
    render(<InventoryLookup bcvRate={RATE} />);

    type("bujia");
    flush();

    await flushPromises();
    expect(screen.getByText("Sin código")).toBeInTheDocument();
  });

  it("sin resultados lo dice en vez de dejar la sección vacía", async () => {
    searchProductsForLookup.mockResolvedValue([]);
    render(<InventoryLookup bcvRate={RATE} />);

    type("zzz");
    flush();

    await flushPromises();
    expect(screen.getByText(/ningún repuesto coincide/i)).toBeInTheDocument();
  });

  it("un error de red no rompe el panel", async () => {
    searchProductsForLookup.mockRejectedValue(new Error("fail"));
    render(<InventoryLookup bcvRate={RATE} />);

    type("bujia");
    flush();

    await flushPromises();
    expect(screen.getByText(/no se pudo buscar en el inventario/i)).toBeInTheDocument();
  });

  it("una respuesta atrasada no pisa la búsqueda más nueva", async () => {
    let resolveFirst: (value: Product[]) => void = () => {};
    let resolveSecond: (value: Product[]) => void = () => {};
    searchProductsForLookup
      .mockImplementationOnce(
        () =>
          new Promise<Product[]>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<Product[]>((resolve) => {
            resolveSecond = resolve;
          })
      );

    render(<InventoryLookup bcvRate={RATE} />);
    type("tubo esc");
    flush();
    type("tub");
    flush();

    expect(searchProductsForLookup).toHaveBeenCalledTimes(2);

    // Llega tarde la respuesta VIEJA ("tubo esc"), después de que ya se
    // lanzó la búsqueda nueva ("tub").
    await act(async () => {
      resolveFirst([product({ id: "viejo", name: "Tubo escape viejo" })]);
    });
    expect(screen.queryByText("Tubo escape viejo")).not.toBeInTheDocument();

    await act(async () => {
      resolveSecond([product({ id: "nuevo", name: "Tubo nuevo" })]);
    });
    expect(screen.getByText("Tubo nuevo")).toBeInTheDocument();
  });

  it("borrar el texto limpia los resultados sin esperar al debounce", async () => {
    searchProductsForLookup.mockResolvedValue([product()]);
    render(<InventoryLookup bcvRate={RATE} />);

    type("bujia");
    flush();
    await flushPromises();
    expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument();

    type("");
    expect(screen.queryByText("Bujía CR7HSA")).not.toBeInTheDocument();
    expect(screen.getByText(/escribe un nombre, una marca o un código/i)).toBeInTheDocument();
  });

  /**
   * T3, plan "Ronda del cliente" (30/9/2026): botón ✕ que borra solo el texto
   * de la búsqueda. Comparte el camino de «vaciar el cuadro» (idle inmediato e
   * invalidación de la búsqueda en vuelo) y no toca el carrito.
   */
  describe("botón «Borrar búsqueda» (T3)", () => {
    it("sin texto no hay botón", () => {
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Borrar búsqueda" })).not.toBeInTheDocument();

      type("bujia");
      expect(screen.getByRole("button", { name: "Borrar búsqueda" })).toBeInTheDocument();
    });

    it("vacía el campo, quita los resultados, devuelve el foco al input y no agrega nada al carrito", async () => {
      searchProductsForLookup.mockResolvedValue([product()]);
      const onAdd = vi.fn();
      render(<InventoryLookup bcvRate={RATE} onAdd={onAdd} />);

      type("bujia");
      flush();
      await flushPromises();
      expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Borrar búsqueda" }));

      const input = screen.getByLabelText("Buscar en el inventario") as HTMLInputElement;
      expect(input.value).toBe("");
      expect(screen.queryByText("Bujía CR7HSA")).not.toBeInTheDocument();
      expect(screen.getByText(/escribe un nombre, una marca o un código/i)).toBeInTheDocument();
      expect(document.activeElement).toBe(input);
      expect(onAdd).not.toHaveBeenCalled();
      // Con el cuadro vacío el botón se va.
      expect(screen.queryByRole("button", { name: "Borrar búsqueda" })).not.toBeInTheDocument();
    });

    it("una respuesta que llega después de borrar se descarta", async () => {
      let resolveBusqueda: (value: Product[]) => void = () => {};
      searchProductsForLookup.mockImplementationOnce(
        () =>
          new Promise<Product[]>((resolve) => {
            resolveBusqueda = resolve;
          })
      );
      render(<InventoryLookup bcvRate={RATE} />);

      type("bujia");
      flush();
      expect(searchProductsForLookup).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Borrar búsqueda" }));

      await act(async () => {
        resolveBusqueda([product({ id: "tarde", name: "Resultado tardío" })]);
      });
      expect(screen.queryByText("Resultado tardío")).not.toBeInTheDocument();
      expect(screen.getByText(/escribe un nombre, una marca o un código/i)).toBeInTheDocument();
    });
  });

  /**
   * T9, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
   * esperando" (29/9/2026, 3.3 + 3.5): la lista deja de cortarse en 8 sin
   * avisar. Páginas de 20 con «Ver más», y la existencia es una pastilla.
   * Que la lista scrollee sin empujar Notas es CSS (jsdom no calcula layout):
   * lo fija `stock-pill-css.test.ts` y lo mide Playwright.
   */
  describe("«Ver más» y pastilla de existencia (T9)", () => {
    function pagina(desde: number, cuantos: number): Product[] {
      return Array.from({ length: cuantos }, (_, i) =>
        product({ id: `p-${desde + i}`, name: `Bujía ${String(desde + i).padStart(2, "0")}` })
      );
    }

    async function buscar(term = "bujia") {
      type(term);
      flush();
      await flushPromises();
    }

    it("una página completa (20) ofrece «Ver más»", async () => {
      searchProductsForLookup.mockResolvedValue(pagina(0, 20));
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      expect(screen.getAllByRole("listitem")).toHaveLength(20);
      expect(screen.getByRole("button", { name: /ver más/i })).toBeInTheDocument();
    });

    it("una página corta (menos de 20) NO ofrece «Ver más»: no hay nada detrás", async () => {
      searchProductsForLookup.mockResolvedValue(pagina(0, 19));
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      expect(screen.queryByRole("button", { name: /ver más/i })).not.toBeInTheDocument();
    });

    it("«Ver más» pide la página siguiente (desplazamiento 20) y la agrega debajo, sin reemplazar", async () => {
      searchProductsForLookup.mockResolvedValueOnce(pagina(0, 20)).mockResolvedValueOnce(pagina(20, 10));
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      await flushPromises();

      expect(searchProductsForLookup).toHaveBeenLastCalledWith(expect.anything(), "bujia", 20, 20);
      expect(screen.getAllByRole("listitem")).toHaveLength(30);
      expect(screen.getByText("Bujía 00")).toBeInTheDocument();
      expect(screen.getByText("Bujía 29")).toBeInTheDocument();
      // La segunda página vino corta: ya no queda nada por pedir.
      expect(screen.queryByRole("button", { name: /ver más/i })).not.toBeInTheDocument();
    });

    it("si la segunda página también viene completa, «Ver más» sigue ahí y el desplazamiento avanza", async () => {
      searchProductsForLookup
        .mockResolvedValueOnce(pagina(0, 20))
        .mockResolvedValueOnce(pagina(20, 20))
        .mockResolvedValueOnce(pagina(40, 5));
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      await flushPromises();
      expect(screen.getByRole("button", { name: /ver más/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      await flushPromises();

      expect(searchProductsForLookup).toHaveBeenLastCalledWith(expect.anything(), "bujia", 20, 40);
      expect(screen.getAllByRole("listitem")).toHaveLength(45);
    });

    it("una página vacía tras «Ver más» (el total era justo 20) esconde el botón", async () => {
      searchProductsForLookup.mockResolvedValueOnce(pagina(0, 20)).mockResolvedValueOnce([]);
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      await flushPromises();

      expect(screen.getAllByRole("listitem")).toHaveLength(20);
      expect(screen.queryByRole("button", { name: /ver más/i })).not.toBeInTheDocument();
    });

    it("no duplica un repuesto que ya estaba (la base cambió entre páginas)", async () => {
      searchProductsForLookup
        .mockResolvedValueOnce(pagina(0, 20))
        .mockResolvedValueOnce([product({ id: "p-19", name: "Bujía 19" }), ...pagina(20, 2)]);
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      await flushPromises();

      expect(screen.getAllByText("Bujía 19")).toHaveLength(1);
      expect(screen.getAllByRole("listitem")).toHaveLength(22);
    });

    it("si «Ver más» falla conserva lo que ya se veía y lo avisa", async () => {
      searchProductsForLookup.mockResolvedValueOnce(pagina(0, 20)).mockRejectedValueOnce(new Error("fail"));
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      await flushPromises();

      expect(screen.getAllByRole("listitem")).toHaveLength(20);
      expect(screen.getByRole("alert")).toHaveTextContent(/no se pudo cargar más/i);
      // Se puede reintentar.
      expect(screen.getByRole("button", { name: /ver más/i })).toBeEnabled();
    });

    it("mientras carga la página siguiente el botón se deshabilita (no se pide dos veces)", async () => {
      let resolver: (value: Product[]) => void = () => {};
      searchProductsForLookup.mockResolvedValueOnce(pagina(0, 20)).mockImplementationOnce(
        () =>
          new Promise<Product[]>((resolve) => {
            resolver = resolve;
          })
      );
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      await flushPromises();

      const boton = screen.getByRole("button", { name: /cargando|ver más/i });
      expect(boton).toBeDisabled();
      fireEvent.click(boton);
      expect(searchProductsForLookup).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolver(pagina(20, 3));
      });
      expect(screen.getAllByRole("listitem")).toHaveLength(23);
    });

    it("la página siguiente de una búsqueda vieja no se pega a la búsqueda nueva", async () => {
      let resolverPagina2: (value: Product[]) => void = () => {};
      searchProductsForLookup
        .mockResolvedValueOnce(pagina(0, 20))
        .mockImplementationOnce(
          () =>
            new Promise<Product[]>((resolve) => {
              resolverPagina2 = resolve;
            })
        )
        .mockResolvedValueOnce([product({ id: "nuevo", name: "Cadena nueva" })]);
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      fireEvent.click(screen.getByRole("button", { name: /ver más/i }));
      // El asesor cambia de búsqueda mientras la página 2 sigue en vuelo.
      type("cadena");
      flush();
      await flushPromises();
      expect(screen.getByText("Cadena nueva")).toBeInTheDocument();

      await act(async () => {
        resolverPagina2(pagina(20, 5));
      });
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      expect(screen.queryByText("Bujía 20")).not.toBeInTheDocument();
    });

    it("con existencia la pastilla dice cuántas hay; sin ninguna dice «Agotado»", async () => {
      searchProductsForLookup.mockResolvedValue([
        product({ id: "a", name: "Con stock", stockQuantity: 12 }),
        product({ id: "b", name: "Sin nada", stockQuantity: 0 }),
      ]);
      render(<InventoryLookup bcvRate={RATE} />);
      await buscar();

      expect(screen.getByText("12 en stock")).toHaveAttribute("data-stock", "in");
      expect(screen.getByText("Agotado")).toHaveAttribute("data-stock", "out");
      expect(screen.queryByText("Sin stock")).not.toBeInTheDocument();
    });
  });

  /**
   * T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
   * esperando" (28/9/2026): el resultado gana un botón «Agregar» al carrito
   * de la conversación. Sigue siendo solo una búsqueda si el llamador no le
   * pasa `onAdd`.
   */
  describe("botón Agregar al carrito (T8)", () => {
    it("cada resultado activo ofrece «Agregar» y le entrega su producto a onAdd", async () => {
      searchProductsForLookup.mockResolvedValue([product()]);
      const onAdd = vi.fn();
      render(<InventoryLookup bcvRate={RATE} onAdd={onAdd} />);

      type("bujia");
      flush();
      await flushPromises();

      fireEvent.click(screen.getByRole("button", { name: "Agregar Bujía CR7HSA al carrito" }));

      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "prod-1", name: "Bujía CR7HSA" }));
    });

    it("un repuesto retirado NO se puede agregar", async () => {
      searchProductsForLookup.mockResolvedValue([product({ isActive: false })]);
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} />);

      type("bujia");
      flush();
      await flushPromises();

      expect(screen.getByText("Retirado")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /al carrito/i })).not.toBeInTheDocument();
    });

    it("sin onAdd no pinta ningún botón: sigue siendo una búsqueda de solo lectura", async () => {
      searchProductsForLookup.mockResolvedValue([product()]);
      render(<InventoryLookup bcvRate={RATE} />);

      type("bujia");
      flush();
      await flushPromises();

      expect(screen.queryByRole("button", { name: /al carrito/i })).not.toBeInTheDocument();
    });

    it("mientras el carrito escribe (addDisabled) el botón se deshabilita", async () => {
      searchProductsForLookup.mockResolvedValue([product()]);
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} addDisabled />);

      type("bujia");
      flush();
      await flushPromises();

      expect(screen.getByRole("button", { name: "Agregar Bujía CR7HSA al carrito" })).toBeDisabled();
    });
  });
});
