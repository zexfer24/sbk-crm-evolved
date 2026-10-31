/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "@heroui/react";
import { PresupuestosCliente } from "@/components/context-panel/presupuestos-cliente";
import type { Presupuesto, PresupuestoItem } from "@/lib/presupuestos";
import type { Product } from "@/lib/types";
import type { BorradorSaint } from "@/lib/saint-borradores";

/**
 * 21/10/2026, plan "Presupuestos y mensajes rápidos", T6: los presupuestos
 * guardados del contacto del chat, debajo de «Lo que lleva el cliente». El
 * asesor los despliega y pasa uno al carrito de la conversación (D1: se cobra
 * el precio de HOY, el cotizado es solo referencia). Todo con Supabase
 * mockeado; lo que solo se prueba contra la base (RLS, la RPC) vive en
 * `supabase/tests/presupuestos.sql`.
 */

const fetchPresupuestos = vi.fn();
vi.mock("@/lib/presupuestos-data", () => ({
  fetchPresupuestos: (...args: unknown[]) => fetchPresupuestos(...args),
}));

const addToCart = vi.fn();
vi.mock("@/lib/mutations", () => ({ addToCart: (...args: unknown[]) => addToCart(...args) }));

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({ marca: "cliente" })) }));

// 25/10/2026 (plan "Enviar a SAINT", T3): el estado de los envíos a SAINT viene
// de un hook con Realtime; acá se controla a mano. El botón y el modal se
// prueban en `saint/enviar-a-saint.test.tsx`.
const borradoresPorOrigen = new Map<string, BorradorSaint>();
const usoBorradores = vi.fn();
vi.mock("@/components/saint/use-borradores-saint", () => ({
  useBorradoresSaint: (...args: unknown[]) => {
    usoBorradores(...args);
    return { porOrigen: borradoresPorOrigen, ahora: new Date("2026-10-25T14:00:30.000Z"), recargar: vi.fn() };
  },
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn(), info: vi.fn() } };
});

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Carburador PZ27",
    brand: null,
    price: 20,
    currency: "USD",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-10-20T10:00:00.000Z",
    compatibility: [],
    weightKg: 2,
    shippingFeeUsd: 2.5,
    precioDivisaUsd: null,
    saintCode: "A-100",
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    ...over,
  };
}

function renglon(over: Partial<PresupuestoItem> = {}): PresupuestoItem {
  const p = over.product ?? product();
  return {
    id: "pi-1",
    productId: p.id,
    product: p,
    quantity: 2,
    priceKind: "promocion",
    precioCotizadoUsd: 20,
    ...over,
  };
}

function presupuesto(over: Partial<Presupuesto> = {}): Presupuesto {
  return {
    id: "pres-1",
    clienteNombre: "María",
    clienteApellido: "Pérez",
    contactId: "contact-1",
    conversationId: "conv-1",
    origen: "chat",
    nota: null,
    totalCotizadoUsd: 40,
    createdBy: "agent-1",
    creadoPorNombre: "Ana",
    // 21/10/2026 02:30 UTC = 20/10 22:30 en Caracas (UTC-4): la fecha corta tiene que ser la de Caracas.
    createdAt: "2026-10-21T02:30:00.000Z",
    updatedAt: "2026-10-21T02:30:00.000Z",
    items: [renglon()],
    ...over,
  };
}

function setup(over: Partial<React.ComponentProps<typeof PresupuestosCliente>> = {}) {
  const onCartChanged = vi.fn();
  const props = {
    contactId: "contact-1",
    conversationId: "conv-1",
    bcvRate: 40,
    contactDisplayName: "María Pérez",
    contactPhone: "04141234567",
    contactCedulaType: "V" as const,
    contactCedulaNumber: "12345678",
    onCartChanged,
    recargarClave: 0,
    ...over,
  };
  const view = render(<PresupuestosCliente {...props} />);
  return { onCartChanged, props, ...view };
}

beforeEach(() => {
  fetchPresupuestos.mockReset();
  addToCart.mockReset();
  addToCart.mockResolvedValue({ priceKindChanged: false });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.danger).mockClear();
  borradoresPorOrigen.clear();
  usoBorradores.mockClear();
});

describe("PresupuestosCliente — carga", () => {
  it("sin presupuestos no pinta nada, ni el título", async () => {
    fetchPresupuestos.mockResolvedValue([]);
    const { container } = setup();

    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalled());
    expect(fetchPresupuestos).toHaveBeenCalledWith({ marca: "cliente" }, { contactId: "contact-1" });
    expect(container).toBeEmptyDOMElement();
  });

  it("si la carga falla lo dice en texto pequeño", async () => {
    fetchPresupuestos.mockRejectedValue(new Error("red"));
    setup();

    expect(await screen.findByText("No se pudieron cargar los presupuestos de este cliente.")).toBeInTheDocument();
  });

  it("con dos presupuestos ofrece «2 guardados de María» y la lista empieza plegada", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto(), presupuesto({ id: "pres-2" })]);
    setup();

    const boton = await screen.findByRole("button", { name: "2 guardados de María" });
    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /pasar al carrito/i })).not.toBeInTheDocument();
  });

  it("con uno solo lo dice en singular", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto()]);
    setup();

    expect(await screen.findByRole("button", { name: "1 guardado de María" })).toBeInTheDocument();
  });

  it("recarga cuando cambia recargarClave", async () => {
    fetchPresupuestos.mockResolvedValue([]);
    const { rerender, props } = setup();
    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledTimes(1));

    rerender(<PresupuestosCliente {...props} recargarClave={1} />);

    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledTimes(2));
  });

  it("recarga cuando cambia el contacto", async () => {
    fetchPresupuestos.mockResolvedValue([]);
    const { rerender, props } = setup();
    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledTimes(1));

    rerender(<PresupuestosCliente {...props} contactId="contact-2" />);

    await waitFor(() => expect(fetchPresupuestos).toHaveBeenLastCalledWith({ marca: "cliente" }, { contactId: "contact-2" }));
  });
});

describe("PresupuestosCliente — lista desplegada", () => {
  it("cada presupuesto muestra nombre, artículos y total de HOY, comparación y fecha de Caracas", async () => {
    // Cotizado a $40 pero hoy el producto vale $25 x 2 = $50.
    fetchPresupuestos.mockResolvedValue([
      presupuesto({ items: [renglon({ product: product({ price: 25 }) })] }),
    ]);
    setup();

    fireEvent.click(await screen.findByRole("button", { name: "1 guardado de María" }));

    expect(screen.getByRole("button", { name: "1 guardado de María" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("María Pérez")).toBeInTheDocument();
    expect(screen.getByText("1 art. · $50.00 de hoy")).toBeInTheDocument();
    expect(screen.getByText("cotizado $40.00")).toBeInTheDocument();
    // 02:30 UTC del 21 es el 20 en Caracas.
    expect(screen.getByText(/^20 oct/i)).toBeInTheDocument();
    expect(screen.queryByText(/^21 oct/i)).not.toBeInTheDocument();
  });

  it("si el total de hoy coincide con el cotizado no muestra la comparación", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto()]);
    setup();

    fireEvent.click(await screen.findByRole("button", { name: "1 guardado de María" }));

    expect(screen.getByText("1 art. · $40.00 de hoy")).toBeInTheDocument();
    expect(screen.queryByText(/cotizado/i)).not.toBeInTheDocument();
  });

  it("cuenta artículos distintos (renglones), no unidades", async () => {
    fetchPresupuestos.mockResolvedValue([
      presupuesto({
        items: [
          renglon({ quantity: 2 }),
          renglon({ id: "pi-2", productId: "prod-2", product: product({ id: "prod-2", name: "Kit", price: 5 }), quantity: 3 }),
        ],
      }),
    ]);
    setup();

    fireEvent.click(await screen.findByRole("button", { name: "1 guardado de María" }));

    expect(screen.getByText(/^2 art\./)).toBeInTheDocument();
  });

  it("el botón vuelve a plegar la lista", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto()]);
    setup();
    const boton = await screen.findByRole("button", { name: "1 guardado de María" });

    fireEvent.click(boton);
    fireEvent.click(boton);

    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /pasar al carrito/i })).not.toBeInTheDocument();
  });
});

describe("PresupuestosCliente — pasar al carrito", () => {
  async function desplegar() {
    fireEvent.click(await screen.findByRole("button", { name: /guardados? de María/ }));
  }

  it("llama a addToCart por renglón con su cantidad y su precio, en orden, y refresca el carrito", async () => {
    fetchPresupuestos.mockResolvedValue([
      presupuesto({
        items: [
          renglon({ quantity: 2, priceKind: "promocion" }),
          renglon({
            id: "pi-2",
            productId: "prod-2",
            product: product({ id: "prod-2", name: "Kit de arrastre" }),
            quantity: 3,
            priceKind: "estandar",
          }),
        ],
      }),
    ]);
    const { onCartChanged } = setup();
    await desplegar();

    fireEvent.click(screen.getByRole("button", { name: /pasar al carrito/i }));

    await waitFor(() => expect(onCartChanged).toHaveBeenCalledTimes(1));
    expect(addToCart).toHaveBeenCalledTimes(2);
    expect(addToCart).toHaveBeenNthCalledWith(1, { marca: "cliente" }, {
      conversationId: "conv-1",
      productId: "prod-1",
      quantity: 2,
      priceKind: "promocion",
      origin: "inventory",
    });
    expect(addToCart).toHaveBeenNthCalledWith(2, { marca: "cliente" }, {
      conversationId: "conv-1",
      productId: "prod-2",
      quantity: 3,
      priceKind: "estandar",
      origin: "inventory",
    });
    expect(toast.success).toHaveBeenCalledWith("Se pasaron 2 artículos al carrito");
  });

  it("con un solo renglón el aviso va en singular", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto()]);
    setup();
    await desplegar();

    fireEvent.click(screen.getByRole("button", { name: /pasar al carrito/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Se pasó 1 artículo al carrito"));
  });

  it("si falla a mitad avisa cuántos alcanzó a pasar, refresca igual y no sigue con los demás", async () => {
    fetchPresupuestos.mockResolvedValue([
      presupuesto({
        items: [
          renglon(),
          renglon({ id: "pi-2", productId: "prod-2", product: product({ id: "prod-2" }) }),
          renglon({ id: "pi-3", productId: "prod-3", product: product({ id: "prod-3" }) }),
        ],
      }),
    ]);
    addToCart.mockResolvedValueOnce({ priceKindChanged: false }).mockRejectedValueOnce(new Error("otro asesor lo estaba cambiando"));
    const { onCartChanged } = setup();
    await desplegar();

    fireEvent.click(screen.getByRole("button", { name: /pasar al carrito/i }));

    await waitFor(() => expect(onCartChanged).toHaveBeenCalledTimes(1));
    expect(addToCart).toHaveBeenCalledTimes(2);
    expect(toast.danger).toHaveBeenCalledWith(expect.stringContaining("1 de 3"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("mientras pasa un presupuesto el botón queda deshabilitado", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto()]);
    let terminar: (valor: unknown) => void = () => {};
    addToCart.mockImplementation(() => new Promise((resolve) => (terminar = resolve)));
    setup();
    await desplegar();

    fireEvent.click(screen.getByRole("button", { name: /pasar al carrito/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /pasar al carrito/i })).toBeDisabled());
    terminar({ priceKindChanged: false });
    await waitFor(() => expect(screen.getByRole("button", { name: /pasar al carrito/i })).not.toBeDisabled());
  });
});

describe("PresupuestosCliente — facturar en SAINT", () => {
  it("cada presupuesto desplegado lleva su «Facturar en SAINT», y el hook sigue los ids de la lista", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto(), presupuesto({ id: "pres-2" })]);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "2 guardados de María" }));

    expect(screen.getAllByRole("button", { name: /facturar en saint/i })).toHaveLength(2);
    expect(usoBorradores).toHaveBeenLastCalledWith("presupuesto", ["pres-1", "pres-2"]);
  });

  it("precarga el modal con el nombre del presupuesto y la cédula y el teléfono del contacto", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto({ clienteNombre: "Luis", clienteApellido: "Gómez" })]);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "1 guardado de María" }));

    fireEvent.click(screen.getByRole("button", { name: /facturar en saint/i }));

    expect(await screen.findByLabelText("Nombre")).toHaveValue("Luis");
    expect(screen.getByLabelText("Apellido")).toHaveValue("Gómez");
    expect(screen.getByLabelText("Cédula")).toHaveValue("12345678");
    expect(screen.getByLabelText("Teléfono (opcional)")).toHaveValue("04141234567");
  });

  it("muestra el estado del último envío de ese presupuesto, no el de otro", async () => {
    borradoresPorOrigen.set("pres-2", {
      id: "b-1",
      origen: "presupuesto",
      origenId: "pres-2",
      creadoPor: "agent-1",
      cedulaTipo: "V",
      cedulaNumero: "12345678",
      nombre: "María",
      apellido: "Pérez",
      telefono: "04141234567",
      estado: "creado",
      numeroSaint: "FAC-77",
      codclie: null,
      clienteCreado: null,
      error: null,
      createdAt: "2026-10-25T14:00:00.000Z",
      procesadoAt: "2026-10-25T14:00:10.000Z",
    });
    fetchPresupuestos.mockResolvedValue([presupuesto(), presupuesto({ id: "pres-2" })]);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "2 guardados de María" }));

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("En SAINT como FAC-77");
  });
});
