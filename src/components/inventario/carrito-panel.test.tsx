/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@/lib/types";
import { textoCarritoParaCliente, totalesCarrito } from "@/lib/inventario-carrito";
import { ELECCION_CASHEA_INICIAL } from "@/lib/cashea";
import {
  CARRITO_STORAGE_PREFIX,
  InventarioCarritoProvider,
  useInventarioCarrito,
} from "@/components/inventario/inventario-carrito-provider";

/**
 * Carrito de cotización del Inventario (12/10/2026, plan "Carrito de
 * cotización en el Inventario, con Cashea", T4): el provider (estado +
 * localStorage) y el panel lateral. El Drawer de HeroUI es el real —corre en
 * jsdom—; solo se sustituye `toast` para poder afirmar sobre los avisos.
 */

const toastSuccess = vi.fn();
const toastDanger = vi.fn();
const toastWarning = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...original,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      danger: (...args: unknown[]) => toastDanger(...args),
      warning: (...args: unknown[]) => toastWarning(...args),
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({ cliente: "falso" })),
}));

const fetchProductsByIds = vi.fn();
vi.mock("@/lib/inventory-data", () => ({
  fetchProductsByIds: (...args: unknown[]) => fetchProductsByIds(...args),
}));

const TASA = 100;
const AGENTE = "agente-1";
const CLAVE = `${CARRITO_STORAGE_PREFIX}${AGENTE}`;

function product(over: Partial<Product> = {}): Product {
  return {
    id: "a",
    name: "Carburador PZ27",
    brand: null,
    price: 11800,
    currency: "VES",
    stockQuantity: 10,
    description: null,
    isActive: true,
    updatedAt: "2026-10-12T10:00:00Z",
    compatibility: [],
    weightKg: null,
    saintCode: "SA-001",
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

const PA = product({ id: "a", name: "Carburador PZ27", price: 11800, saintCode: "SA-001" });
const PB = product({ id: "b", name: "Bujía NGK", price: 5000, saintCode: null });
const PC = product({ id: "c", name: "Cadena 428", price: 2000, saintCode: "SA-003" });

/** Botones mínimos para manejar el contexto desde el test. */
function Arnes() {
  const carrito = useInventarioCarrito();
  if (!carrito) return null;
  return (
    <div>
      <button onClick={() => carrito.agregar(PA)}>agregar A</button>
      <button onClick={() => carrito.agregar(PB)}>agregar B</button>
      <button onClick={() => carrito.agregar(PC)}>agregar C</button>
      <button onClick={() => carrito.agregar(product({ id: "x", name: "Inactivo", isActive: false }))}>
        agregar inactivo
      </button>
      <button onClick={carrito.abrir}>abrir carrito</button>
      <span data-testid="unidades">{carrito.unidades}</span>
      <span data-testid="cantidad-b">{carrito.cantidadDe("b")}</span>
    </div>
  );
}

function montar() {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  render(
    <InventarioCarritoProvider agentId={AGENTE} bcvRate={TASA}>
      <Arnes />
    </InventarioCarritoProvider>,
  );
  return user;
}

function totales() {
  return screen.getByLabelText("Totales");
}

async function abrirConAyB(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("agregar A"));
  await user.click(screen.getByText("agregar B"));
  await user.click(screen.getByText("abrir carrito"));
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastDanger.mockClear();
  toastWarning.mockClear();
  fetchProductsByIds.mockReset();
  fetchProductsByIds.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("el panel del carrito", () => {
  it("sin renglones muestra la guía y ni totales, ni Cashea, ni acciones", async () => {
    const user = montar();
    await user.click(screen.getByText("abrir carrito"));

    expect(await screen.findByText("Carrito de cotización")).toBeInTheDocument();
    expect(screen.getByText(/Agregá repuestos desde la lista con «Agregar»/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Totales")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Financiar con Cashea" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copiar para WhatsApp" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Vaciar" })).toBeNull();
  });

  it("agregar dos productos arma dos renglones y los totales exactos en Bs. y $", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("agregar B"));
    await user.click(screen.getByText("agregar B"));
    await user.click(screen.getByText("abrir carrito"));

    const lista = await screen.findByRole("list", { name: "Productos del carrito" });
    const items = within(lista).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Carburador PZ27")).toBeInTheDocument();
    expect(within(items[0]).getByText("SA-001")).toBeInTheDocument();
    expect(within(items[1]).getByText("Sin código")).toBeInTheDocument();
    expect(within(items[1]).getByLabelText("Cantidad de Bujía NGK")).toHaveValue("2");

    const t = within(totales());
    expect(t.getByText("Total en bolívares")).toBeInTheDocument();
    expect(t.getByText("Bs. 21.800,00")).toBeInTheDocument();
    expect(t.getByText("Total en dólares")).toBeInTheDocument();
    expect(t.getByText("$218,00")).toBeInTheDocument();
    expect(screen.getByTestId("unidades")).toHaveTextContent("3");
  });

  it("editar la cantidad al salir del campo recalcula el subtotal y el total", async () => {
    const user = montar();
    await abrirConAyB(user);

    const campo = await screen.findByLabelText("Cantidad de Bujía NGK");
    await user.clear(campo);
    await user.type(campo, "3");
    await user.tab();

    const items = within(screen.getByRole("list", { name: "Productos del carrito" })).getAllByRole("listitem");
    expect(within(items[1]).getByText("Bs. 15.000,00")).toBeInTheDocument();
    expect(within(totales()).getByText("Bs. 26.800,00")).toBeInTheDocument();
    expect(within(totales()).getByText("$268,00")).toBeInTheDocument();
    expect(screen.getByTestId("cantidad-b")).toHaveTextContent("3");
  });

  it("una cantidad inválida revierte al valor anterior", async () => {
    const user = montar();
    await abrirConAyB(user);

    const campo = await screen.findByLabelText("Cantidad de Bujía NGK");
    await user.clear(campo);
    await user.type(campo, "0");
    await user.keyboard("{Enter}");

    expect(campo).toHaveValue("1");
    expect(screen.getByTestId("cantidad-b")).toHaveTextContent("1");
  });

  it("quitar un renglón lo saca y recalcula", async () => {
    const user = montar();
    await abrirConAyB(user);

    await user.click(await screen.findByRole("button", { name: "Quitar Carburador PZ27" }));

    const items = within(screen.getByRole("list", { name: "Productos del carrito" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(totales()).getByText("$50,00")).toBeInTheDocument();
  });

  it("ignora un producto inactivo", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar inactivo"));
    expect(screen.getByTestId("unidades")).toHaveTextContent("0");
  });

  it("avisa en el renglón cuando el stock no alcanza", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    function Poco() {
      const c = useInventarioCarrito()!;
      return (
        <>
          <button onClick={() => c.agregar(product({ id: "p", name: "Pocas", stockQuantity: 0 }))}>agregar poco</button>
          <button onClick={c.abrir}>abrir carrito</button>
        </>
      );
    }
    render(
      <InventarioCarritoProvider agentId={AGENTE} bcvRate={TASA}>
        <Poco />
      </InventarioCarritoProvider>,
    );
    await user.click(screen.getByText("agregar poco"));
    await user.click(screen.getByText("abrir carrito"));
    expect(await screen.findByText("Sin stock")).toBeInTheDocument();
  });

  describe("con Cashea", () => {
    it("encenderlo muestra niveles y cuotas, y el bloque Totales trae todo junto", async () => {
      const user = montar();
      await abrirConAyB(user);

      const interruptor = await screen.findByRole("switch", { name: "Financiar con Cashea" });
      expect(interruptor).toHaveAttribute("aria-checked", "false");
      expect(screen.queryByRole("group", { name: "Nivel Cashea" })).toBeNull();

      await user.click(interruptor);

      expect(interruptor).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("group", { name: "Nivel Cashea" })).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Cuotas" })).toBeInTheDocument();

      const t = totales();
      expect(within(t).getByText("Total en bolívares")).toBeInTheDocument();
      expect(within(t).getByText("Total en dólares")).toBeInTheDocument();
      expect(within(t).getByText(/Inicial \(/)).toBeInTheDocument();
      expect(within(t).getByText("Cuotas")).toBeInTheDocument();
      expect(within(t).getByText("Financiado")).toBeInTheDocument();
    });

    it("con 6 cuotas pedidas, al bajar el total a $100 o menos queda marcado 3 cuotas y se ve el aviso", async () => {
      const user = montar();
      await abrirConAyB(user); // $118 + $50 = $168
      await user.click(await screen.findByRole("switch", { name: "Financiar con Cashea" }));

      await user.click(screen.getByRole("button", { name: "6 cuotas" }));
      expect(screen.getByRole("button", { name: "6 cuotas" })).toHaveAttribute("aria-pressed", "true");

      await user.click(screen.getByRole("button", { name: "Quitar Carburador PZ27" })); // queda $50

      expect(screen.getByRole("button", { name: "3 cuotas" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(/Las 6 cuotas se habilitan con compras de más de/)).toBeInTheDocument();
    });

    it("la elección de Cashea sobrevive a cerrar y reabrir el panel", async () => {
      const user = montar();
      await abrirConAyB(user);
      await user.click(await screen.findByRole("switch", { name: "Financiar con Cashea" }));
      await user.click(screen.getByRole("button", { name: "Cerrar" }));
      await waitFor(() => expect(screen.queryByText("Carrito de cotización")).toBeNull());

      await user.click(screen.getByText("abrir carrito"));
      expect(await screen.findByRole("switch", { name: "Financiar con Cashea" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("con un renglón sin precio avisa que falta la tasa y no muestra plan", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      render(
        <InventarioCarritoProvider agentId={AGENTE} bcvRate={0}>
          <Arnes />
        </InventarioCarritoProvider>,
      );
      await user.click(screen.getByText("agregar A"));
      await user.click(screen.getByText("abrir carrito"));
      await user.click(await screen.findByRole("switch", { name: "Financiar con Cashea" }));

      expect(
        screen.getByText("Falta la tasa BCV para un producto: no se puede financiar un total incompleto."),
      ).toBeInTheDocument();
      expect(within(totales()).queryByText(/Inicial \(/)).toBeNull();
      expect(within(totales()).getByText("Sin tasa")).toBeInTheDocument();
    });
  });

  describe("acciones", () => {
    it("Copiar para WhatsApp escribe el texto del carrito y avisa", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const user = montar();
      // userEvent.setup instala su propio portapapeles: se pisa DESPUÉS.
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await abrirConAyB(user);

      await user.click(await screen.findByRole("button", { name: "Copiar para WhatsApp" }));

      const esperado = textoCarritoParaCliente(
        totalesCarrito(
          [
            { product: PA, quantity: 1, quotedPriceUsd: null },
            { product: PB, quantity: 1, quotedPriceUsd: null },
          ],
          TASA,
          { activo: false, ...ELECCION_CASHEA_INICIAL },
        ),
      );
      expect(esperado).not.toBeNull();
      expect(writeText).toHaveBeenCalledWith(esperado);
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Carrito copiado"));
    });

    it("si el portapapeles falla avisa con un error", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denegado"));
      const user = montar();
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await abrirConAyB(user);

      await user.click(await screen.findByRole("button", { name: "Copiar para WhatsApp" }));

      await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("No se pudo copiar"));
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("Copiar queda deshabilitado si un renglón no tiene precio", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      render(
        <InventarioCarritoProvider agentId={AGENTE} bcvRate={0}>
          <Arnes />
        </InventarioCarritoProvider>,
      );
      await user.click(screen.getByText("agregar A"));
      await user.click(screen.getByText("abrir carrito"));
      expect(await screen.findByRole("button", { name: "Copiar para WhatsApp" })).toBeDisabled();
    });

    it("Vaciar pide confirmación; «No» la cancela y «Sí, vaciar» deja el estado vacío", async () => {
      const user = montar();
      await abrirConAyB(user);

      await user.click(await screen.findByRole("button", { name: "Vaciar" }));
      expect(screen.getByText("¿Vaciar el carrito?")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "No" }));
      expect(screen.queryByText("¿Vaciar el carrito?")).toBeNull();
      expect(screen.getByTestId("unidades")).toHaveTextContent("2");

      await user.click(screen.getByRole("button", { name: "Vaciar" }));
      await user.click(screen.getByRole("button", { name: "Sí, vaciar" }));

      expect(screen.getByTestId("unidades")).toHaveTextContent("0");
      expect(screen.getByText(/Agregá repuestos desde la lista/)).toBeInTheDocument();
      expect(screen.queryByLabelText("Totales")).toBeNull();
    });
  });
});

describe("la persistencia del carrito", () => {
  it("restaura los renglones en el orden guardado y con su cantidad, aunque la base responda en otro orden y sin un id", async () => {
    localStorage.setItem(
      CLAVE,
      JSON.stringify([
        { productId: "b", quantity: 3 },
        { productId: "a", quantity: 2 },
        { productId: "zz", quantity: 1 },
      ]),
    );
    fetchProductsByIds.mockResolvedValue([PA, PB]); // OTRO orden y sin "zz"

    const user = montar();
    await waitFor(() => expect(screen.getByTestId("unidades")).toHaveTextContent("5"));
    expect(fetchProductsByIds).toHaveBeenCalledWith({ cliente: "falso" }, ["b", "a", "zz"]);

    await user.click(screen.getByText("abrir carrito"));
    const items = within(await screen.findByRole("list", { name: "Productos del carrito" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Bujía NGK")).toBeInTheDocument();
    expect(within(items[0]).getByLabelText("Cantidad de Bujía NGK")).toHaveValue("3");
    expect(within(items[1]).getByText("Carburador PZ27")).toBeInTheDocument();
    expect(within(items[1]).getByLabelText("Cantidad de Carburador PZ27")).toHaveValue("2");

    // Tras agregar algo, lo guardado es el estado completo (sin precios). El
    // Drawer es modal: se cierra antes, un clic afuera solo lo descartaría.
    await user.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByText("Carrito de cotización")).toBeNull());
    await user.click(screen.getByText("agregar C"));
    expect(JSON.parse(localStorage.getItem(CLAVE)!)).toEqual([
      { productId: "b", quantity: 3 },
      { productId: "a", quantity: 2 },
      { productId: "c", quantity: 1 },
    ]);
  });

  it("agregar guarda en la clave del asesor y vaciar deja una lista vacía", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    expect(JSON.parse(localStorage.getItem(CLAVE)!)).toEqual([{ productId: "a", quantity: 1 }]);
    expect(fetchProductsByIds).not.toHaveBeenCalled();

    await user.click(screen.getByText("abrir carrito"));
    await user.click(await screen.findByRole("button", { name: "Vaciar" }));
    await user.click(screen.getByRole("button", { name: "Sí, vaciar" }));
    expect(JSON.parse(localStorage.getItem(CLAVE)!)).toEqual([]);
  });

  it("si getItem lanza, abre vacío y sigue funcionando en memoria", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("almacenamiento bloqueado");
    });
    const user = montar();

    expect(screen.getByTestId("unidades")).toHaveTextContent("0");
    await user.click(screen.getByText("agregar A"));
    expect(screen.getByTestId("unidades")).toHaveTextContent("1");
    expect(fetchProductsByIds).not.toHaveBeenCalled();
  });

  it("si setItem lanza no rompe nada", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota llena");
    });
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    expect(screen.getByTestId("unidades")).toHaveTextContent("1");
  });

  it("si la lectura de la base falla avisa y NO escribe, para no pisar lo guardado", async () => {
    const guardado = JSON.stringify([{ productId: "a", quantity: 2 }]);
    localStorage.setItem(CLAVE, guardado);
    fetchProductsByIds.mockRejectedValue(new Error("sin red"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const user = montar();
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith("No se pudo recuperar el carrito guardado."));

    await user.click(screen.getByText("agregar B"));
    expect(screen.getByTestId("unidades")).toHaveTextContent("1");
    expect(localStorage.getItem(CLAVE)).toBe(guardado);
  });

  it("fuera del provider useInventarioCarrito devuelve null", () => {
    function Sonda() {
      return <span data-testid="sonda">{String(useInventarioCarrito())}</span>;
    }
    render(<Sonda />);
    expect(screen.getByTestId("sonda")).toHaveTextContent("null");
  });
});
