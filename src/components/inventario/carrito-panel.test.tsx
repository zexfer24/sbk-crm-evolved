/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@/lib/types";
import { textoCarritoParaCliente, totalesCarrito } from "@/lib/inventario-carrito";
import { AVISO_SEIS_CUOTAS, ELECCION_CASHEA_INICIAL } from "@/lib/cashea";
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

// 28/10/2026 (plan "El carrito de cotización se ordena", T3): «Enviar a SAINT»
// guarda el carrito como presupuesto y luego envía ESE presupuesto.
const guardarPresupuesto = vi.fn();
vi.mock("@/lib/presupuestos-data", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/presupuestos-data")>();
  return { ...original, guardarPresupuesto: (...args: unknown[]) => guardarPresupuesto(...args) };
});

const enviarBorradorSaint = vi.fn();
vi.mock("@/lib/saint-borradores-data", () => ({
  enviarBorradorSaint: (...args: unknown[]) => enviarBorradorSaint(...args),
  fetchUltimosBorradores: vi.fn().mockResolvedValue(new Map()),
}));

// Sin el hook real no hay canal Realtime ni lectura de borradores: el cliente de este test es un objeto de mentira.
vi.mock("@/components/saint/use-borradores-saint", () => ({
  useBorradoresSaint: () => ({ porOrigen: new Map(), ahora: new Date("2026-10-28T14:00:00.000Z"), recargar: vi.fn() }),
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
    fotos: [],
    shippingFeeUsd: null,
    precioDivisaUsd: null,
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
      <button
        onClick={() =>
          carrito.marcarPresupuestoGuardado({
            id: "pr-activo",
            clienteNombre: "Ana",
            clienteApellido: "Gómez",
            nota: "nota vieja",
            createdBy: AGENTE,
          })
        }
      >
        marcar presupuesto propio
      </button>
      <button
        onClick={() =>
          carrito.marcarPresupuestoGuardado({
            id: "pr-ajeno",
            clienteNombre: "Luis",
            clienteApellido: "Rojas",
            nota: null,
            createdBy: "otro-agente",
          })
        }
      >
        marcar presupuesto ajeno
      </button>
      <span data-testid="unidades">{carrito.unidades}</span>
      <span data-testid="cantidad-b">{carrito.cantidadDe("b")}</span>
    </div>
  );
}

function montar() {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  render(
    <InventarioCarritoProvider agentId={AGENTE} bcvRate={TASA} soloLectura={false} role="agent">
      <Arnes />
    </InventarioCarritoProvider>,
  );
  return user;
}

function totales() {
  return screen.getByLabelText("Totales");
}

/** Abre «Opciones de cotización» si está cerrado (el estado sobrevive a cerrar y reabrir el panel). */
async function abrirOpciones(user: ReturnType<typeof userEvent.setup>) {
  const disparador = await screen.findByRole("button", { name: /Opciones de cotización/ });
  if (disparador.getAttribute("aria-expanded") !== "true") await user.click(disparador);
  return disparador;
}

function montarCaja() {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  render(
    <InventarioCarritoProvider agentId={AGENTE} bcvRate={TASA} soloLectura={true} role="caja">
      <Arnes />
    </InventarioCarritoProvider>,
  );
  return user;
}

/** Llena el modal de SAINT; con `nombre`/`apellido` los escribe (si no, quedan los que ya traía). */
async function llenarSaint(
  user: ReturnType<typeof userEvent.setup>,
  datos: { nombre?: string; apellido?: string } = {},
) {
  const nombre = await screen.findByLabelText("Nombre");
  await user.selectOptions(screen.getByLabelText("Tipo de cédula"), "V");
  await user.type(screen.getByLabelText("Cédula"), "12345678");
  await user.type(screen.getByLabelText("Teléfono (opcional)"), "04141234567");
  if (datos.nombre !== undefined) {
    await user.clear(nombre);
    await user.type(nombre, datos.nombre);
  }
  if (datos.apellido !== undefined) {
    const apellido = screen.getByLabelText("Apellido");
    await user.clear(apellido);
    await user.type(apellido, datos.apellido);
  }
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
  guardarPresupuesto.mockReset();
  guardarPresupuesto.mockResolvedValue("pr-nuevo");
  enviarBorradorSaint.mockReset();
  enviarBorradorSaint.mockResolvedValue("b-nuevo");
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
    expect(screen.queryByRole("button", { name: "Copiar" })).toBeNull();
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
      <InventarioCarritoProvider agentId={AGENTE} bcvRate={TASA} soloLectura={false} role="agent">
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

      await abrirOpciones(user);
      const interruptor = await screen.findByRole("switch", { name: "Financiar con Cashea" });
      expect(interruptor).toHaveAttribute("aria-checked", "false");
      expect(screen.queryByRole("radiogroup", { name: "Nivel Cashea" })).toBeNull();

      await user.click(interruptor);

      expect(interruptor).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radiogroup", { name: "Nivel Cashea" })).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Cuotas" })).toBeInTheDocument();

      const t = totales();
      expect(within(t).getByText("Total en bolívares")).toBeInTheDocument();
      expect(within(t).getByText("Total en dólares")).toBeInTheDocument();
      expect(within(t).getByText("Inicial")).toBeInTheDocument();
      expect(within(t).getByText("Cada cuota")).toBeInTheDocument();
      expect(within(t).getByText("Monto financiado")).toBeInTheDocument();
      // Con tasa, el resumen del carrito suma los bolívares de la inicial y la
      // cuota (y el total en bolívares de arriba): tres en total, el financiado no.
      expect(within(t).getAllByText(/^Bs\. /)).toHaveLength(3);
    });

    it("con 6 cuotas pedidas, al bajar el total a $100 o menos queda marcado 3 cuotas y se ve el aviso", async () => {
      const user = montar();
      await abrirConAyB(user); // $118 + $50 = $168
      await abrirOpciones(user);
      await user.click(await screen.findByRole("switch", { name: "Financiar con Cashea" }));

      await user.click(screen.getByRole("button", { name: "6 cuotas" }));
      expect(screen.getByRole("button", { name: "6 cuotas" })).toHaveAttribute("aria-pressed", "true");

      await user.click(screen.getByRole("button", { name: "Quitar Carburador PZ27" })); // queda $50

      expect(screen.getByRole("button", { name: "3 cuotas" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(AVISO_SEIS_CUOTAS)).toBeInTheDocument();
    });

    it("con 6 elegidas, al bajar a $100 o menos pasa a 3 y subir el total NO revive el 6", async () => {
      const user = montar();
      await abrirConAyB(user); // $118 + $50 = $168
      await abrirOpciones(user);
      await user.click(await screen.findByRole("switch", { name: "Financiar con Cashea" }));
      await user.click(screen.getByRole("button", { name: "6 cuotas" }));

      await user.click(screen.getByRole("button", { name: "Quitar Carburador PZ27" })); // queda $50
      expect(screen.getByRole("button", { name: "3 cuotas" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "6 cuotas" })).toBeDisabled();
      expect(screen.getByText(AVISO_SEIS_CUOTAS)).toBeInTheDocument();

      // Vuelve a pasar de $100: el 6 se habilita, pero la elección ya es 3.
      await user.click(screen.getByRole("button", { name: "Cerrar" }));
      await waitFor(() => expect(screen.queryByText("Carrito de cotización")).toBeNull());
      await user.click(screen.getByText("agregar A")); // $50 + $118 = $168
      await user.click(screen.getByText("abrir carrito"));

      const seis = await screen.findByRole("button", { name: "6 cuotas" });
      expect(seis).toBeEnabled();
      expect(seis).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: "3 cuotas" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText(AVISO_SEIS_CUOTAS)).toBeNull();
    });

    it("la elección de Cashea sobrevive a cerrar y reabrir el panel", async () => {
      const user = montar();
      await abrirConAyB(user);
      await abrirOpciones(user);
      await user.click(await screen.findByRole("switch", { name: "Financiar con Cashea" }));
      await user.click(screen.getByRole("button", { name: "Cerrar" }));
      await waitFor(() => expect(screen.queryByText("Carrito de cotización")).toBeNull());

      await user.click(screen.getByText("abrir carrito"));
      await abrirOpciones(user);
      expect(await screen.findByRole("switch", { name: "Financiar con Cashea" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("con un renglón sin precio avisa que falta la tasa y no muestra plan", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      render(
        <InventarioCarritoProvider agentId={AGENTE} bcvRate={0} soloLectura={false} role="agent">
          <Arnes />
        </InventarioCarritoProvider>,
      );
      await user.click(screen.getByText("agregar A"));
      await user.click(screen.getByText("abrir carrito"));
      await abrirOpciones(user);
      await user.click(await screen.findByRole("switch", { name: "Financiar con Cashea" }));

      expect(
        screen.getByText("Falta la tasa BCV para un producto: no se puede financiar un total incompleto."),
      ).toBeInTheDocument();
      expect(within(totales()).queryByText("Inicial")).toBeNull();
      expect(within(totales()).getByText("Sin tasa")).toBeInTheDocument();
    });
  });

  describe("acciones", () => {
    it("Copiar escribe el texto del carrito y avisa", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const user = montar();
      // userEvent.setup instala su propio portapapeles: se pisa DESPUÉS.
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await abrirConAyB(user);

      await user.click(await screen.findByRole("button", { name: "Copiar" }));

      const esperado = textoCarritoParaCliente(
        totalesCarrito(
          [
            { product: PA, quantity: 1, quotedPriceUsd: null, priceKind: "promocion" },
            { product: PB, quantity: 1, quotedPriceUsd: null, priceKind: "promocion" },
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

      await user.click(await screen.findByRole("button", { name: "Copiar" }));

      await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("No se pudo copiar"));
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("Copiar queda deshabilitado si un renglón no tiene precio", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      render(
        <InventarioCarritoProvider agentId={AGENTE} bcvRate={0} soloLectura={false} role="agent">
          <Arnes />
        </InventarioCarritoProvider>,
      );
      await user.click(screen.getByText("agregar A"));
      await user.click(screen.getByText("abrir carrito"));
      expect(await screen.findByRole("button", { name: "Copiar" })).toBeDisabled();
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

/**
 * 28/10/2026, plan "El carrito de cotización se ordena", T3: el cuerpo lleva
 * SOLO los artículos; el pie lleva, en orden, el desplegable «Opciones de
 * cotización», los totales y los botones.
 */
describe("el orden del panel", () => {
  it("el cuerpo del panel solo lleva la lista: los interruptores y las casillas no están dentro del cuerpo", async () => {
    const user = montar();
    await abrirConAyB(user);
    await abrirOpciones(user);

    const cuerpo = document.querySelector<HTMLElement>(".inv-carrito-cuerpo");
    expect(cuerpo).not.toBeNull();
    expect(within(cuerpo!).getByRole("list", { name: "Productos del carrito" })).toBeInTheDocument();
    expect(within(cuerpo!).queryAllByRole("switch")).toHaveLength(0);
    expect(within(cuerpo!).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(cuerpo!).queryByText("Qué incluir al copiar")).toBeNull();
  });

  it("«Opciones de cotización» arranca cerrado y al abrirlo muestra precio estándar, Cashea y qué incluir al copiar, en ese orden", async () => {
    const user = montar();
    await abrirConAyB(user);

    const disparador = await screen.findByRole("button", { name: /Opciones de cotización/ });
    expect(disparador).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch", { name: "Financiar con Cashea" })).toBeNull();
    expect(screen.queryByText("Qué incluir al copiar")).toBeNull();

    await user.click(disparador);

    expect(disparador).toHaveAttribute("aria-expanded", "true");
    const estandar = screen.getByRole("switch", { name: "Cobrar precio estándar (envío por peso)" });
    const cashea = screen.getByRole("switch", { name: "Financiar con Cashea" });
    const copia = screen.getByText("Qué incluir al copiar");
    const despues = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(estandar.compareDocumentPosition(cashea) & despues).toBeTruthy();
    expect(cashea.compareDocumentPosition(copia) & despues).toBeTruthy();
  });

  it("cerrado, el desplegable marca «Cashea» cuando Cashea está encendido y «Estándar» cuando el carrito va en estándar", async () => {
    const user = montar();
    await abrirConAyB(user);
    const disparador = await abrirOpciones(user);
    expect(within(disparador).queryByText("Cashea")).toBeNull();
    expect(within(disparador).queryByText("Estándar")).toBeNull();

    await user.click(screen.getByRole("switch", { name: "Financiar con Cashea" }));
    await user.click(screen.getByRole("switch", { name: "Cobrar precio estándar (envío por peso)" }));
    // Abierto, las marcas sobran: ahí están los interruptores.
    expect(within(disparador).queryByText("Cashea")).toBeNull();

    await user.click(disparador);

    expect(disparador).toHaveAttribute("aria-expanded", "false");
    expect(within(disparador).getByText("Cashea")).toBeInTheDocument();
    expect(within(disparador).getByText("Estándar")).toBeInTheDocument();
  });

  it("los botones salen en orden: Facturar en SAINT, Guardar presupuesto, Copiar, Vaciar", async () => {
    const user = montar();
    await abrirConAyB(user);

    const acciones = document.querySelector<HTMLElement>(".inv-carrito-acciones");
    expect(acciones).not.toBeNull();
    const nombres = within(acciones!)
      .getAllByRole("button")
      .map((boton) => boton.textContent?.trim());
    expect(nombres).toEqual(["Facturar en SAINT", "Guardar presupuesto", "Copiar", "Vaciar"]);
  });

  it("el desplegable va antes que «Total en bolívares» en el pie, y el pie después de la lista", async () => {
    const user = montar();
    await abrirConAyB(user);

    const pie = document.querySelector<HTMLElement>(".inv-carrito-pie");
    expect(pie).not.toBeNull();
    const disparador = within(pie!).getByRole("button", { name: /Opciones de cotización/ });
    const total = within(pie!).getByText("Total en bolívares");
    expect(disparador.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const lista = screen.getByRole("list", { name: "Productos del carrito" });
    expect(lista.compareDocumentPosition(disparador) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("el desplegable y los totales van dentro de la zona desplazable; las acciones quedan fuera de ella", async () => {
    const user = montar();
    await abrirConAyB(user);

    const zona = document.querySelector<HTMLElement>(".inv-carrito-pie-ajustes");
    expect(zona, "falta la zona desplazable del pie").not.toBeNull();
    expect(within(zona!).getByRole("button", { name: /Opciones de cotización/ })).toBeTruthy();
    expect(within(zona!).getByText("Total en bolívares")).toBeTruthy();
    expect(within(zona!).queryByRole("button", { name: /Facturar en SAINT/ })).toBeNull();
    expect(within(zona!).queryByRole("button", { name: /Guardar presupuesto/ })).toBeNull();
  });

  it("con el carrito en estándar aparece la nota de SAINT; en promoción no", async () => {
    const NOTA = "SAINT pone su propio precio: el envío por peso no viaja.";
    const user = montar();
    await abrirConAyB(user);
    expect(screen.queryByText(NOTA)).toBeNull();

    await abrirOpciones(user);
    await user.click(screen.getByRole("switch", { name: "Cobrar precio estándar (envío por peso)" }));
    expect(screen.getByText(NOTA)).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Cobrar precio estándar (envío por peso)" }));
    expect(screen.queryByText(NOTA)).toBeNull();
  });
});

describe("Facturar en SAINT desde el carrito", () => {
  it("sin presupuesto abierto, enviar guarda un presupuesto NUEVO con nombre y apellido del formulario y envía su id con origen presupuesto", async () => {
    const orden: string[] = [];
    guardarPresupuesto.mockImplementation(async () => {
      orden.push("guardar");
      return "pr-nuevo";
    });
    enviarBorradorSaint.mockImplementation(async () => {
      orden.push("enviar");
      return "b-nuevo";
    });
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("agregar C"));
    await user.click(screen.getByText("abrir carrito"));

    await user.click(await screen.findByRole("button", { name: /Facturar en SAINT/ }));
    await llenarSaint(user, { nombre: "Carla", apellido: "Pérez" });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Facturar en SAINT" }));

    await waitFor(() => expect(enviarBorradorSaint).toHaveBeenCalledTimes(1));
    expect(orden).toEqual(["guardar", "enviar"]);
    expect(guardarPresupuesto).toHaveBeenCalledTimes(1);
    expect(guardarPresupuesto.mock.calls[0][1]).toMatchObject({
      id: null,
      clienteNombre: "Carla",
      clienteApellido: "Pérez",
      contactId: null,
      conversationId: null,
      origen: "inventario",
      nota: null,
    });
    expect(guardarPresupuesto.mock.calls[0][1].items).toEqual([
      expect.objectContaining({ product_id: "a", quantity: 1, price_kind: "promocion" }),
      expect.objectContaining({ product_id: "c", quantity: 1, price_kind: "promocion" }),
    ]);
    expect(enviarBorradorSaint.mock.calls[0][1]).toMatchObject({ origen: "presupuesto", origenId: "pr-nuevo" });
    // El carrito queda marcado como ese presupuesto: el chip del encabezado lo dice.
    await waitFor(() => expect(screen.getByText("Carla Pérez")).toBeInTheDocument());
  });

  it("con un presupuesto abierto editable, enviar actualiza ESE presupuesto y envía su id", async () => {
    guardarPresupuesto.mockResolvedValue("pr-activo");
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("marcar presupuesto propio"));
    await user.click(screen.getByText("abrir carrito"));

    await user.click(await screen.findByRole("button", { name: /Facturar en SAINT/ }));
    await llenarSaint(user);
    expect(screen.getByLabelText("Nombre")).toHaveValue("Ana");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Facturar en SAINT" }));

    await waitFor(() => expect(enviarBorradorSaint).toHaveBeenCalledTimes(1));
    expect(guardarPresupuesto.mock.calls[0][1]).toMatchObject({
      id: "pr-activo",
      clienteNombre: "Ana",
      clienteApellido: "Gómez",
      nota: "nota vieja",
    });
    expect(enviarBorradorSaint.mock.calls[0][1]).toMatchObject({ origen: "presupuesto", origenId: "pr-activo" });
  });

  it("con un presupuesto abierto que el asesor no puede editar, enviar crea uno nuevo", async () => {
    guardarPresupuesto.mockResolvedValue("pr-copia");
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("marcar presupuesto ajeno"));
    await user.click(screen.getByText("abrir carrito"));

    await user.click(await screen.findByRole("button", { name: /Facturar en SAINT/ }));
    await llenarSaint(user);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Facturar en SAINT" }));

    await waitFor(() => expect(enviarBorradorSaint).toHaveBeenCalledTimes(1));
    expect(guardarPresupuesto.mock.calls[0][1]).toMatchObject({ id: null, nota: null });
    expect(enviarBorradorSaint.mock.calls[0][1]).toMatchObject({ origenId: "pr-copia" });
  });

  it("si guardar falla, no se envía", async () => {
    guardarPresupuesto.mockRejectedValue(new Error("sin permiso"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("abrir carrito"));

    await user.click(await screen.findByRole("button", { name: /Facturar en SAINT/ }));
    await llenarSaint(user, { nombre: "Carla", apellido: "Pérez" });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Facturar en SAINT" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalled());
    expect(enviarBorradorSaint).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("un producto sin código SAINT deshabilita Facturar en SAINT", async () => {
    const user = montar();
    await abrirConAyB(user); // B no tiene código SAINT

    expect(await screen.findByRole("button", { name: /Facturar en SAINT/ })).toBeDisabled();
    expect(screen.getByText("Sin código SAINT: Bujía NGK.")).toBeInTheDocument();
  });
});

describe("el panel para la caja", () => {
  it("la caja ve en el desplegable solo «Financiar con Cashea»: ni estándar ni qué incluir al copiar", async () => {
    const user = montarCaja();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("abrir carrito"));
    await abrirOpciones(user);

    expect(screen.getByRole("switch", { name: "Financiar con Cashea" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.queryByText("Qué incluir al copiar")).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByLabelText("Vista previa del texto")).toBeNull();
  });

  it("la caja no tiene botón Copiar y sí Facturar en SAINT, Guardar presupuesto y Vaciar", async () => {
    const user = montarCaja();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("abrir carrito"));

    const acciones = await waitFor(() => {
      const nodo = document.querySelector<HTMLElement>(".inv-carrito-acciones");
      expect(nodo).not.toBeNull();
      return nodo!;
    });
    const nombres = within(acciones)
      .getAllByRole("button")
      .map((boton) => boton.textContent?.trim());
    expect(nombres).toEqual(["Facturar en SAINT", "Guardar presupuesto", "Vaciar"]);
    expect(screen.queryByRole("button", { name: "Copiar" })).toBeNull();
  });

  it("para la caja ningún texto, title ni aria-label del panel menciona 'estándar' (cerrado y abierto el desplegable)", async () => {
    const user = montarCaja();
    await user.click(screen.getByText("agregar A"));
    await user.click(screen.getByText("abrir carrito"));
    await screen.findByRole("button", { name: /Opciones de cotización/ });
    expect(document.body.innerHTML).not.toMatch(/est[aá]ndar/i);

    await abrirOpciones(user);
    expect(document.body.innerHTML).not.toMatch(/est[aá]ndar/i);
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
      { productId: "b", quantity: 3, priceKind: "promocion" },
      { productId: "a", quantity: 2, priceKind: "promocion" },
      { productId: "c", quantity: 1, priceKind: "promocion" },
    ]);
  });

  it("agregar guarda en la clave del asesor y vaciar deja una lista vacía", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar A"));
    expect(JSON.parse(localStorage.getItem(CLAVE)!)).toEqual([
      { productId: "a", quantity: 1, priceKind: "promocion" },
    ]);
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
