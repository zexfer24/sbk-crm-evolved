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
    expect(searchProductsForLookup).toHaveBeenCalledWith(expect.anything(), "bujia", 8);

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
});
