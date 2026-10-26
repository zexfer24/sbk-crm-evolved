/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { InventoryLookup } from "@/components/context-panel/inventory-lookup";
import type { Product } from "@/lib/types";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import { toast } from "@heroui/react";

/**
 * T6, plan "El mostrador busca sin salir del chat" (27/9/2026, D5).
 *
 * El panel derecho gana una búsqueda de inventario de SOLO LECTURA. El
 * riesgo de siempre con una búsqueda con debounce (mismo que resolvió
 * `url-search-box.tsx`, T4, esta misma corrida): una respuesta de red
 * atrasada no puede pisar lo que el asesor ya está viendo.
 */

const searchProductsForLookup = vi.fn();
const fetchProduct = vi.fn();
vi.mock("@/lib/inventory-data", () => ({
  searchProductsForLookup: (...args: unknown[]) => searchProductsForLookup(...args),
  fetchProduct: (...args: unknown[]) => fetchProduct(...args),
}));

// 21/10/2026 (plan "Presupuestos y mensajes rápidos", T6): el peso se edita
// desde la búsqueda. `config-write` NO se mockea: el mensaje de un permiso
// denegado tiene que salir del módulo real.
const updateProductWeight = vi.fn();
vi.mock("@/lib/mutations", () => ({
  updateProductWeight: (...args: unknown[]) => updateProductWeight(...args),
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() } };
});

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
    shippingFeeUsd: null,
    saintCode: "1234",
    saintAddedAt: null,
    saintRemovedAt: null,
    ...overrides,
  };
}

const RATE: BcvRateSummary = { rate: 40, rateDate: "2026-09-27", isStale: false };

beforeEach(() => {
  searchProductsForLookup.mockReset();
  fetchProduct.mockReset();
  updateProductWeight.mockReset();
  updateProductWeight.mockResolvedValue(undefined);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.danger).mockClear();
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
  it("arranca vacío, sin texto de ayuda y sin buscar nada", () => {
    // 26/10/2026: el párrafo de ayuda del estado inicial se eliminó.
    render(<InventoryLookup bcvRate={RATE} />);
    expect(screen.queryByText(/escribe un nombre, una marca o un código/i)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/escribe un nombre, una marca o un código/i)).not.toBeInTheDocument();
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
      expect(screen.queryByText(/escribe un nombre, una marca o un código/i)).not.toBeInTheDocument(); // 26/10/2026: sin texto de ayuda
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
      expect(screen.queryByText(/ningún repuesto|Resultado tardío/)).not.toBeInTheDocument(); // 26/10/2026: ya no hay texto de ayuda en idle
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
  describe("botones Agregar al carrito (T8 y precio elegido, 14/10/2026)", () => {
    it("cada resultado activo ofrece «+ Promoción» y le entrega su producto a onAdd con «promocion»", async () => {
      searchProductsForLookup.mockResolvedValue([product()]);
      const onAdd = vi.fn();
      render(<InventoryLookup bcvRate={RATE} onAdd={onAdd} />);

      type("bujia");
      flush();
      await flushPromises();

      fireEvent.click(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio de promoción" }));

      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "prod-1", name: "Bujía CR7HSA" }), "promocion");
    });

    it("«+ Estándar» entrega el producto con «estandar» cuando hay tarifa MRW", async () => {
      searchProductsForLookup.mockResolvedValue([product({ weightKg: 1, shippingFeeUsd: 1.4 })]);
      const onAdd = vi.fn();
      render(<InventoryLookup bcvRate={RATE} onAdd={onAdd} />);

      type("bujia");
      flush();
      await flushPromises();

      fireEvent.click(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio estándar" }));

      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: "prod-1" }), "estandar");
    });

    it("sin tarifa MRW «+ Estándar» está deshabilitado y dice el motivo; «+ Promoción» sigue disponible", async () => {
      searchProductsForLookup.mockResolvedValue([product({ weightKg: 95, shippingFeeUsd: null })]);
      const onAdd = vi.fn();
      render(<InventoryLookup bcvRate={RATE} onAdd={onAdd} />);

      type("bujia");
      flush();
      await flushPromises();

      const estandar = screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio estándar" });
      expect(estandar).toBeDisabled();
      expect(estandar).toHaveAttribute("title", "Más de 80 kg: fuera de la tabla MRW");
      fireEvent.click(estandar);
      expect(onAdd).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio de promoción" })).toBeEnabled();
    });

    it("sin peso cargado el motivo del botón «+ Estándar» es «Sin peso cargado»", async () => {
      searchProductsForLookup.mockResolvedValue([product({ weightKg: null, shippingFeeUsd: null })]);
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} />);

      type("bujia");
      flush();
      await flushPromises();

      expect(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio estándar" })).toHaveAttribute(
        "title",
        "Sin peso cargado"
      );
    });

    it("un repuesto retirado NO se puede agregar a ningún precio", async () => {
      searchProductsForLookup.mockResolvedValue([product({ isActive: false, weightKg: 1, shippingFeeUsd: 1.4 })]);
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} />);

      type("bujia");
      flush();
      await flushPromises();

      expect(screen.getByText("Retirado")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^agregar/i })).not.toBeInTheDocument();
    });

    it("sin onAdd no pinta ningún botón: sigue siendo una búsqueda de solo lectura", async () => {
      searchProductsForLookup.mockResolvedValue([product()]);
      render(<InventoryLookup bcvRate={RATE} />);

      type("bujia");
      flush();
      await flushPromises();

      expect(screen.queryByRole("button", { name: /^agregar/i })).not.toBeInTheDocument();
    });

    it("mientras el carrito escribe (addDisabled) los dos botones se deshabilitan", async () => {
      searchProductsForLookup.mockResolvedValue([product({ weightKg: 1, shippingFeeUsd: 1.4 })]);
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} addDisabled />);

      type("bujia");
      flush();
      await flushPromises();

      expect(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio de promoción" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio estándar" })).toBeDisabled();
    });
  });

  /**
   * 14/10/2026: cada resultado muestra además del precio de promoción el
   * precio ESTÁNDAR (promoción + envío MRW), con etiquetas, igual que la fila
   * de Inventario. Nunca un número incompleto: sin tarifa, el motivo en texto.
   */
  describe("InventoryLookup — precio estándar", () => {
    async function buscarUno(p: Product, rate: BcvRateSummary | null = RATE) {
      searchProductsForLookup.mockResolvedValue([p]);
      render(<InventoryLookup bcvRate={rate} />);
      type("bujia");
      flush();
      await flushPromises();
    }

    it("con tarifa y tasa pinta Promoción y Estándar etiquetados, con su pie y el envío MRW", async () => {
      await buscarUno(product({ weightKg: 1, shippingFeeUsd: 1.4 }));

      expect(screen.getByText("Promoción")).toBeInTheDocument();
      expect(screen.getByText("Estándar")).toBeInTheDocument();
      expect(screen.getByLabelText("Precio promoción de Bujía CR7HSA")).toHaveTextContent("Bs. 87.00");
      // 87 + round2(1,4 * 40) = 143 Bs; pie: usdFromBs(87, 40) = 2,20 + 1,40 = 3,60.
      expect(screen.getByLabelText("Precio estándar de Bujía CR7HSA")).toHaveTextContent("Bs. 143.00");
      expect(screen.getByText("$ 3.60")).toBeInTheDocument();
      expect(screen.getByText("incluye envío MRW $ 1.40")).toBeInTheDocument();
    });

    it("sin peso cargado dice «Sin peso cargado» y no inventa un estándar", async () => {
      await buscarUno(product({ weightKg: null, shippingFeeUsd: null }));

      const motivo = screen.getByText("Sin peso cargado");
      expect(motivo).toHaveAttribute("data-empty", "true");
      expect(screen.queryByLabelText("Precio estándar de Bujía CR7HSA")).toBeNull();
      expect(screen.queryByText(/incluye envío MRW/)).toBeNull();
    });

    it("de 80 kg en adelante dice que está fuera de la tabla MRW", async () => {
      await buscarUno(product({ weightKg: 95, shippingFeeUsd: null }));

      expect(screen.getByText("Más de 80 kg: fuera de la tabla MRW")).toBeInTheDocument();
      expect(screen.queryByLabelText("Precio estándar de Bujía CR7HSA")).toBeNull();
    });

    it("con peso pero sin rango en la tabla dice que no hay tarifa para ese peso", async () => {
      await buscarUno(product({ weightKg: 10, shippingFeeUsd: null }));

      expect(screen.getByText("Sin tarifa MRW para este peso")).toBeInTheDocument();
      expect(screen.queryByLabelText("Precio estándar de Bujía CR7HSA")).toBeNull();
    });

    it("sin tasa BCV el estándar en bolívares lleva el envío aparte en dólares", async () => {
      await buscarUno(product({ weightKg: 1, shippingFeeUsd: 1.4 }), null);

      expect(screen.getByLabelText("Precio promoción de Bujía CR7HSA")).toHaveTextContent("Bs. 87.00");
      expect(screen.getByLabelText("Precio estándar de Bujía CR7HSA")).toHaveTextContent("Bs. 87.00");
      expect(screen.getByText("+ $ 1.40 envío")).toBeInTheDocument();
    });
  });

  /**
   * 21/10/2026 (plan "Presupuestos y mensajes rápidos", T6): el peso se ve y se
   * carga desde el chat. Sin peso no hay precio estándar, y el asesor que lo
   * ve faltar tiene que poder arreglarlo sin salir a Inventario. Al guardar se
   * relee el producto: la tarifa MRW la calcula la base.
   */
  describe("peso editable", () => {
    async function buscarUno(p: Product, props: Partial<React.ComponentProps<typeof InventoryLookup>> = {}) {
      searchProductsForLookup.mockResolvedValue([p]);
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} {...props} />);
      type("bujia");
      flush();
      await flushPromises();
    }

    async function guardarConEnter(valor: string) {
      const campo = screen.getByLabelText("Peso en kg de Bujía CR7HSA");
      fireEvent.change(campo, { target: { value: valor } });
      fireEvent.keyDown(campo, { key: "Enter" });
      await flushPromises();
      await flushPromises();
    }

    it("con peso muestra «Peso 3,2 kg» y el botón «Editar»", async () => {
      await buscarUno(product({ weightKg: 3.2 }));

      expect(screen.getByText("Peso 3,2 kg")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Editar peso de Bujía CR7HSA" })).toHaveTextContent("Editar");
    });

    it("sin peso muestra «Sin peso» y el botón «Cargar peso»", async () => {
      await buscarUno(product({ weightKg: null }));

      expect(screen.getByText("Sin peso")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" })).toHaveTextContent("Cargar peso");
    });

    it("un peso en 0 también cuenta como sin cargar", async () => {
      await buscarUno(product({ weightKg: 0 }));

      expect(screen.getByText("Sin peso")).toBeInTheDocument();
    });

    it("«Cargar peso» abre el campo con sufijo kg y el botón «Guardar»", async () => {
      await buscarUno(product({ weightKg: null }));

      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));

      const campo = screen.getByLabelText("Peso en kg de Bujía CR7HSA");
      expect(campo).toHaveAttribute("inputmode", "decimal");
      expect(campo).toHaveValue("");
      expect(screen.getByText("kg")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Guardar peso de Bujía CR7HSA" })).toHaveTextContent("Guardar");
    });

    it("«Editar» abre el campo con el peso actual", async () => {
      await buscarUno(product({ weightKg: 3.2 }));

      fireEvent.click(screen.getByRole("button", { name: "Editar peso de Bujía CR7HSA" }));

      expect(screen.getByLabelText("Peso en kg de Bujía CR7HSA")).toHaveValue("3.200");
    });

    it("«1,8» + Enter guarda, relee el producto y habilita «+ Estándar» con el precio nuevo", async () => {
      await buscarUno(product({ weightKg: null, shippingFeeUsd: null }));
      expect(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio estándar" })).toBeDisabled();
      fetchProduct.mockResolvedValue(product({ weightKg: 1.8, shippingFeeUsd: 1.4 }));

      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));
      await guardarConEnter("1,8");

      expect(updateProductWeight).toHaveBeenCalledTimes(1);
      expect(updateProductWeight).toHaveBeenCalledWith(expect.anything(), "prod-1", 1.8);
      expect(fetchProduct).toHaveBeenCalledWith(expect.anything(), "prod-1");
      // La escritura va antes que la relectura.
      expect(updateProductWeight.mock.invocationCallOrder[0]).toBeLessThan(fetchProduct.mock.invocationCallOrder[0]);
      expect(toast.success).toHaveBeenCalledWith("Peso guardado");
      // El producto releído reemplazó al de la lista: peso, estándar y botón.
      expect(screen.getByText("Peso 1,8 kg")).toBeInTheDocument();
      expect(screen.getByLabelText("Precio estándar de Bujía CR7HSA")).toHaveTextContent("Bs. 143.00");
      expect(screen.getByRole("button", { name: "Agregar Bujía CR7HSA a precio estándar" })).toBeEnabled();
      // El campo se cierra.
      expect(screen.queryByLabelText("Peso en kg de Bujía CR7HSA")).not.toBeInTheDocument();
    });

    it("el botón «Guardar» hace lo mismo que Enter", async () => {
      await buscarUno(product({ weightKg: null }));
      fetchProduct.mockResolvedValue(product({ weightKg: 2, shippingFeeUsd: 2 }));
      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));
      fireEvent.change(screen.getByLabelText("Peso en kg de Bujía CR7HSA"), { target: { value: "2" } });

      fireEvent.click(screen.getByRole("button", { name: "Guardar peso de Bujía CR7HSA" }));
      await flushPromises();
      await flushPromises();

      expect(updateProductWeight).toHaveBeenCalledWith(expect.anything(), "prod-1", 2);
    });

    it("un campo vacío es válido: quita el peso (null)", async () => {
      await buscarUno(product({ weightKg: 3.2 }));
      fetchProduct.mockResolvedValue(product({ weightKg: null, shippingFeeUsd: null }));
      fireEvent.click(screen.getByRole("button", { name: "Editar peso de Bujía CR7HSA" }));

      await guardarConEnter("");

      expect(updateProductWeight).toHaveBeenCalledWith(expect.anything(), "prod-1", null);
      expect(screen.getByText("Sin peso")).toBeInTheDocument();
    });

    it("un valor inválido muestra el error bajo el campo y no llama a la base", async () => {
      await buscarUno(product({ weightKg: null }));
      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));

      await guardarConEnter("abc");

      expect(updateProductWeight).not.toHaveBeenCalled();
      expect(fetchProduct).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("Usa un peso positivo en kilos, con hasta tres decimales.");
      // El campo sigue abierto para corregir.
      expect(screen.getByLabelText("Peso en kg de Bujía CR7HSA")).toBeInTheDocument();
    });

    it("escribir de nuevo borra el error", async () => {
      await buscarUno(product({ weightKg: null }));
      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));
      await guardarConEnter("abc");

      fireEvent.change(screen.getByLabelText("Peso en kg de Bujía CR7HSA"), { target: { value: "1" } });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("Escape cancela: cierra el campo sin guardar ni cambiar el peso", async () => {
      await buscarUno(product({ weightKg: 3.2 }));
      fireEvent.click(screen.getByRole("button", { name: "Editar peso de Bujía CR7HSA" }));
      const campo = screen.getByLabelText("Peso en kg de Bujía CR7HSA");
      fireEvent.change(campo, { target: { value: "9" } });

      fireEvent.keyDown(campo, { key: "Escape" });

      expect(screen.queryByLabelText("Peso en kg de Bujía CR7HSA")).not.toBeInTheDocument();
      expect(updateProductWeight).not.toHaveBeenCalled();
      expect(screen.getByText("Peso 3,2 kg")).toBeInTheDocument();
    });

    it("si la base falla el campo sigue abierto con lo escrito y sale el toast genérico", async () => {
      await buscarUno(product({ weightKg: null }));
      updateProductWeight.mockRejectedValue(new Error("red"));
      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));

      await guardarConEnter("1,8");

      expect(toast.danger).toHaveBeenCalledWith("No se pudo guardar el peso.");
      expect(toast.success).not.toHaveBeenCalled();
      expect(fetchProduct).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Peso en kg de Bujía CR7HSA")).toHaveValue("1,8");
      expect(screen.queryByText("Peso 1,8 kg")).not.toBeInTheDocument();
    });

    it("si la RLS ignoró la escritura el toast dice quién puede hacerlo", async () => {
      await buscarUno(product({ weightKg: null }));
      updateProductWeight.mockRejectedValue(
        new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto.")
      );
      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));

      await guardarConEnter("1");

      expect(toast.danger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.");
    });

    it("si el peso se guardó pero la relectura falla, el peso nuevo se ve sin inventar un estándar viejo", async () => {
      await buscarUno(product({ weightKg: 5, shippingFeeUsd: 3 }));
      fetchProduct.mockRejectedValue(new Error("red"));
      fireEvent.click(screen.getByRole("button", { name: "Editar peso de Bujía CR7HSA" }));

      await guardarConEnter("1,8");

      expect(toast.success).toHaveBeenCalledWith("Peso guardado");
      expect(screen.getByText("Peso 1,8 kg")).toBeInTheDocument();
      // La tarifa vieja era la del peso anterior: no se pinta como estándar.
      expect(screen.queryByLabelText("Precio estándar de Bujía CR7HSA")).not.toBeInTheDocument();
    });

    it("mientras guarda, el botón queda deshabilitado y no se guarda dos veces", async () => {
      await buscarUno(product({ weightKg: null }));
      let terminar: () => void = () => {};
      updateProductWeight.mockImplementation(() => new Promise<void>((resolve) => (terminar = resolve)));
      fetchProduct.mockResolvedValue(product({ weightKg: 1.8, shippingFeeUsd: 1.4 }));
      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía CR7HSA" }));
      fireEvent.change(screen.getByLabelText("Peso en kg de Bujía CR7HSA"), { target: { value: "1,8" } });

      fireEvent.click(screen.getByRole("button", { name: "Guardar peso de Bujía CR7HSA" }));
      await flushPromises();
      expect(screen.getByRole("button", { name: "Guardar peso de Bujía CR7HSA" })).toBeDisabled();
      fireEvent.keyDown(screen.getByLabelText("Peso en kg de Bujía CR7HSA"), { key: "Enter" });
      expect(updateProductWeight).toHaveBeenCalledTimes(1);

      await act(async () => {
        terminar();
      });
      await flushPromises();
      await flushPromises();
      expect(screen.getByText("Peso 1,8 kg")).toBeInTheDocument();
    });

    it("con puedeEditarPeso={false} no hay botón para cargar ni editar, pero el peso se sigue viendo", async () => {
      await buscarUno(product({ weightKg: 3.2 }), { puedeEditarPeso: false });

      expect(screen.getByText("Peso 3,2 kg")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /peso de/i })).not.toBeInTheDocument();
    });

    it("con puedeEditarPeso={false} y sin peso solo dice «Sin peso»", async () => {
      await buscarUno(product({ weightKg: null }), { puedeEditarPeso: false });

      expect(screen.getByText("Sin peso")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /cargar peso/i })).not.toBeInTheDocument();
    });

    it("cada resultado edita su propio peso: guardar uno no toca a los demás", async () => {
      searchProductsForLookup.mockResolvedValue([
        product({ id: "a", name: "Bujía A", weightKg: null }),
        product({ id: "b", name: "Bujía B", weightKg: 4 }),
      ]);
      render(<InventoryLookup bcvRate={RATE} onAdd={vi.fn()} />);
      type("bujia");
      flush();
      await flushPromises();
      fetchProduct.mockResolvedValue(product({ id: "a", name: "Bujía A", weightKg: 1, shippingFeeUsd: 1 }));

      fireEvent.click(screen.getByRole("button", { name: "Cargar peso de Bujía A" }));
      const campo = screen.getByLabelText("Peso en kg de Bujía A");
      fireEvent.change(campo, { target: { value: "1" } });
      fireEvent.keyDown(campo, { key: "Enter" });
      await flushPromises();
      await flushPromises();

      expect(updateProductWeight).toHaveBeenCalledWith(expect.anything(), "a", 1);
      expect(screen.getByText("Peso 1 kg")).toBeInTheDocument();
      expect(screen.getByText("Peso 4 kg")).toBeInTheDocument();
    });
  });
});

/**
 * 26/10/2026: el buscador se puede plegar (`desplegable`). Arranca cerrado,
 * recuerda la preferencia por visor y, cerrado, conserva lo escrito.
 */
describe("InventoryLookup desplegable", () => {
  const CLAVE = "sbk.panel.inventario.abierto";

  it("sin `desplegable` el input está visible y no hay botón de título", () => {
    render(<InventoryLookup bcvRate={RATE} />);
    expect(screen.getByLabelText("Buscar en el inventario")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Inventario" })).not.toBeInTheDocument();
  });

  it("con `desplegable` y sin preferencia arranca cerrado", () => {
    render(<InventoryLookup bcvRate={RATE} desplegable />);
    expect(screen.getByRole("button", { name: "Inventario" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Buscar en el inventario")).not.toBeVisible();
  });

  it("pulsar el botón abre el cuerpo y lleva el foco al input", () => {
    render(<InventoryLookup bcvRate={RATE} desplegable />);
    fireEvent.click(screen.getByRole("button", { name: "Inventario" }));
    expect(screen.getByRole("button", { name: "Inventario" })).toHaveAttribute("aria-expanded", "true");
    const input = screen.getByLabelText("Buscar en el inventario");
    expect(input).toBeVisible();
    expect(input).toHaveFocus();
  });

  it("guarda la preferencia y un render nuevo con «1» arranca abierto", () => {
    const { unmount } = render(<InventoryLookup bcvRate={RATE} desplegable />);
    fireEvent.click(screen.getByRole("button", { name: "Inventario" }));
    expect(localStorage.getItem(CLAVE)).toBe("1");
    unmount();
    render(<InventoryLookup bcvRate={RATE} desplegable />);
    expect(screen.getByRole("button", { name: "Inventario" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Buscar en el inventario")).toBeVisible();
  });

  it("si localStorage lanza, arranca cerrado y alternar no rompe", () => {
    const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    try {
      render(<InventoryLookup bcvRate={RATE} desplegable />);
      expect(screen.getByRole("button", { name: "Inventario" })).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(screen.getByRole("button", { name: "Inventario" }));
      expect(screen.getByRole("button", { name: "Inventario" })).toHaveAttribute("aria-expanded", "true");
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it("cerrar y reabrir conserva el texto escrito", () => {
    render(<InventoryLookup bcvRate={RATE} desplegable />);
    const boton = screen.getByRole("button", { name: "Inventario" });
    fireEvent.click(boton);
    type("bujia");
    fireEvent.click(boton);
    expect(screen.getByLabelText("Buscar en el inventario")).not.toBeVisible();
    fireEvent.click(boton);
    expect(screen.getByLabelText("Buscar en el inventario")).toHaveValue("bujia");
  });

  it("no pinta el texto de ayuda en el estado inicial", () => {
    render(<InventoryLookup bcvRate={RATE} desplegable />);
    expect(screen.queryByText(/Escribe un nombre, una marca o un código Saint/)).not.toBeInTheDocument();
  });
});
