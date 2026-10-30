/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@/lib/types";
import type { Presupuesto } from "@/lib/presupuestos";
import type { BorradorSaint } from "@/lib/saint-borradores";
import { lineasDePresupuesto } from "@/lib/presupuestos";
import { textoCarritoParaCliente, totalesCarrito } from "@/lib/inventario-carrito";
import { ELECCION_CASHEA_INICIAL } from "@/lib/cashea";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import { OPCIONES_COPIA_INICIALES } from "@/lib/copia-carrito";
import { CarritoContext, type InventarioCarritoValue } from "@/components/inventario/inventario-carrito-context";
import { PresupuestosPanel } from "@/components/inventario/presupuestos-panel";

/**
 * Panel «Presupuestos guardados» de /inventario (21/10/2026, plan
 * "Presupuestos y mensajes rápidos", T5). La lectura y los borrados están
 * mockeados (`presupuestos-data`); el contexto del carrito es uno falso, con
 * los espías que importan: `cargarPresupuesto` y `olvidarPresupuestoActivo`.
 */

const toastSuccess = vi.fn();
const toastDanger = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...original,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      danger: (...args: unknown[]) => toastDanger(...args),
      warning: vi.fn(),
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({ cliente: "falso" })),
}));

const fetchPresupuestos = vi.fn();
const borrarPresupuesto = vi.fn();
const borrarMisPresupuestos = vi.fn();
vi.mock("@/lib/presupuestos-data", () => ({
  fetchPresupuestos: (...args: unknown[]) => fetchPresupuestos(...args),
  borrarPresupuesto: (...args: unknown[]) => borrarPresupuesto(...args),
  borrarMisPresupuestos: (...args: unknown[]) => borrarMisPresupuestos(...args),
}));

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

const YO = "agente-1";
const OTRO = "agente-2";
const TASA = 100;

function producto(over: Partial<Product> = {}): Product {
  return {
    id: "p1",
    name: "Carburador PZ27",
    brand: null,
    price: 25,
    currency: "USD",
    stockQuantity: 10,
    description: null,
    isActive: true,
    updatedAt: "2026-10-20T10:00:00Z",
    compatibility: [],
    weightKg: null,
    saintCode: "SA-001",
    saintAddedAt: null,
    saintRemovedAt: null,
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    ...over,
  };
}

function presupuesto(over: Partial<Presupuesto> = {}): Presupuesto {
  return {
    id: "pr-1",
    clienteNombre: "María",
    clienteApellido: "Pérez",
    contactId: null,
    conversationId: null,
    origen: "inventario",
    nota: null,
    totalCotizadoUsd: 50,
    createdBy: YO,
    creadoPorNombre: "Rosa",
    createdAt: "2026-10-20T15:00:00Z",
    updatedAt: "2026-10-20T15:00:00Z",
    items: [
      {
        id: "it-1",
        productId: "p1",
        product: producto(),
        quantity: 2,
        priceKind: "promocion",
        precioCotizadoUsd: 25,
      },
    ],
    ...over,
  };
}

const MIO_1 = presupuesto({ id: "pr-1", clienteNombre: "María", clienteApellido: "Pérez" });
const MIO_2 = presupuesto({ id: "pr-2", clienteNombre: "José", clienteApellido: "Núñez", totalCotizadoUsd: 50 });
const AJENO = presupuesto({
  id: "pr-3",
  clienteNombre: "Ana",
  clienteApellido: "López",
  createdBy: OTRO,
  creadoPorNombre: "Luis",
});

function carritoFalso(over: Partial<InventarioCarritoValue> = {}): InventarioCarritoValue {
  return {
    lineas: [],
    unidades: 0,
    cantidadDe: () => 0,
    agregar: vi.fn(),
    cambiarCantidad: vi.fn(),
    quitar: vi.fn(),
    vaciar: vi.fn(),
    abierto: false,
    abrir: vi.fn(),
    cerrar: vi.fn(),
    cashea: { activo: false, ...ELECCION_CASHEA_INICIAL },
    setCashea: vi.fn(),
    priceKind: null,
    cobrarEstandar: false,
    setCobrarEstandar: vi.fn(),
    puedeCobrarEstandar: true,
    presupuestoActivo: null,
    cargarPresupuesto: vi.fn(),
    marcarPresupuestoGuardado: vi.fn(),
    olvidarPresupuestoActivo: vi.fn(),
    ...over,
  };
}

function usuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function pintar(opciones: { carrito?: InventarioCarritoValue; role?: "agent" | "supervisor" | "caja" } = {}) {
  const carrito = opciones.carrito ?? carritoFalso();
  const vista = render(
    <CarritoContext.Provider value={carrito}>
      <PresupuestosPanel agentId={YO} role={opciones.role ?? "agent"} bcvRate={TASA} />
    </CarritoContext.Provider>,
  );
  return { carrito, ...vista };
}

beforeEach(() => {
  fetchPresupuestos.mockReset();
  borrarPresupuesto.mockReset();
  borrarMisPresupuestos.mockReset();
  toastSuccess.mockClear();
  toastDanger.mockClear();
  borradoresPorOrigen.clear();
  usoBorradores.mockClear();
  fetchPresupuestos.mockResolvedValue([MIO_1, MIO_2, AJENO]);
});

describe("PresupuestosPanel — la lista", () => {
  it("muestra «Cargando…» y luego los presupuestos, abriendo en «Míos»", async () => {
    pintar();
    expect(screen.getByText("Cargando presupuestos…")).toBeInTheDocument();

    expect(await screen.findByText("María Pérez")).toBeInTheDocument();
    expect(screen.getByText("José Núñez")).toBeInTheDocument();
    expect(screen.queryByText("Ana López")).toBeNull();
    expect(screen.getByRole("button", { name: "Míos" })).toHaveAttribute("aria-pressed", "true");
  });

  it("«De todo el equipo» muestra también los ajenos, con quién los guardó", async () => {
    const user = usuario();
    pintar();
    await screen.findByText("María Pérez");

    await user.click(screen.getByRole("button", { name: "De todo el equipo" }));

    expect(screen.getByText("Ana López")).toBeInTheDocument();
    expect(screen.getByText(/por Luis/)).toBeInTheDocument();
  });

  it("busca por cliente sin acentos ni mayúsculas", async () => {
    const user = usuario();
    pintar();
    await screen.findByText("María Pérez");

    await user.type(screen.getByRole("searchbox", { name: "Buscar por cliente" }), "NUNEZ");

    expect(screen.getByText("José Núñez")).toBeInTheDocument();
    expect(screen.queryByText("María Pérez")).toBeNull();
  });

  it("una búsqueda sin resultados lo dice con el texto escrito", async () => {
    const user = usuario();
    pintar();
    await screen.findByText("María Pérez");

    await user.type(screen.getByRole("searchbox", { name: "Buscar por cliente" }), "zzz");

    expect(screen.getByText("Ningún presupuesto coincide con «zzz».")).toBeInTheDocument();
  });

  it("sin presupuestos guardados explica cómo crear uno", async () => {
    fetchPresupuestos.mockResolvedValue([]);
    pintar();

    expect(
      await screen.findByText("Todavía no hay presupuestos guardados. Arma un carrito y pulsa «Guardar presupuesto»."),
    ).toBeInTheDocument();
  });

  it("la tarjeta muestra el total de HOY, los artículos, el tipo de precio, la fecha y quién lo guardó", async () => {
    pintar({ carrito: carritoFalso() });
    const tarjeta = (await screen.findByText("María Pérez")).closest("li") as HTMLElement;

    // 2 × $25 hoy.
    expect(tarjeta).toHaveTextContent("$50.00");
    expect(tarjeta).toHaveTextContent("2 artículos");
    expect(tarjeta).toHaveTextContent("promoción");
    expect(tarjeta).toHaveTextContent("por Rosa");
    expect(tarjeta).toHaveTextContent(/20 oct/);
    expect(tarjeta).not.toHaveTextContent("desde el chat");
  });

  it("«desde el chat» y la nota aparecen cuando existen", async () => {
    fetchPresupuestos.mockResolvedValue([presupuesto({ origen: "chat", nota: "Pasa el jueves por el casco" })]);
    pintar();

    const tarjeta = (await screen.findByText("María Pérez")).closest("li") as HTMLElement;
    expect(tarjeta).toHaveTextContent("desde el chat");
    expect(tarjeta).toHaveTextContent("Pasa el jueves por el casco");
  });

  it("si el precio cambió desde que se guardó, avisa «cotizado $X»; si no, no dice nada", async () => {
    fetchPresupuestos.mockResolvedValue([
      presupuesto({ id: "pr-1", clienteNombre: "María", totalCotizadoUsd: 40 }),
      presupuesto({ id: "pr-2", clienteNombre: "José", totalCotizadoUsd: 50 }),
    ]);
    pintar();

    const cambiada = (await screen.findByText("María Pérez")).closest("li") as HTMLElement;
    const igual = screen.getByText("José Pérez").closest("li") as HTMLElement;
    expect(cambiada).toHaveTextContent("cotizado $40.00");
    expect(igual).not.toHaveTextContent("cotizado");
  });

  it("un renglón sin precio hoy muestra «Sin precio» en lugar de un total falso", async () => {
    fetchPresupuestos.mockResolvedValue([
      presupuesto({
        items: [
          {
            id: "it-1",
            productId: "p1",
            product: producto({ currency: "VES", price: 5000 }),
            quantity: 1,
            priceKind: "promocion",
            precioCotizadoUsd: null,
          },
        ],
        totalCotizadoUsd: null,
      }),
    ]);
    // Sin tasa, un producto en bolívares no tiene precio en dólares.
    render(
      <CarritoContext.Provider value={carritoFalso()}>
        <PresupuestosPanel agentId={YO} role="agent" bcvRate={0} />
      </CarritoContext.Provider>,
    );

    const tarjeta = (await screen.findByText("María Pérez")).closest("li") as HTMLElement;
    expect(tarjeta).toHaveTextContent("Sin precio");
  });
});

describe("PresupuestosPanel — errores de carga", () => {
  it("muestra el error con «Reintentar», que vuelve a pedir la lista", async () => {
    const user = usuario();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchPresupuestos.mockRejectedValueOnce(new Error("sin red"));
    pintar();

    expect(await screen.findByText("No se pudieron cargar los presupuestos.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByText("María Pérez")).toBeInTheDocument();
    expect(fetchPresupuestos).toHaveBeenCalledTimes(2);
  });
});

describe("PresupuestosPanel — «Borrar mis presupuestos»", () => {
  it("cuenta solo los propios en el botón y abre la ventana con el número", async () => {
    const user = usuario();
    pintar();
    await screen.findByText("María Pérez");

    await user.click(screen.getByRole("button", { name: "Borrar mis presupuestos (2)" }));

    expect(screen.getByText("¿Borrar tus 2 presupuestos?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Se borran los 2 que guardaste tú. Los de otros asesores no se tocan. No se puede deshacer.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sí, borrar 2" })).toBeInTheDocument();
  });

  it("Cancelar no borra nada", async () => {
    const user = usuario();
    pintar();
    await screen.findByText("María Pérez");

    await user.click(screen.getByRole("button", { name: "Borrar mis presupuestos (2)" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(borrarMisPresupuestos).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("¿Borrar tus 2 presupuestos?")).toBeNull());
  });

  it("confirmar llama a borrarMisPresupuestos con el asesor, avisa y recarga", async () => {
    const user = usuario();
    borrarMisPresupuestos.mockResolvedValue(2);
    pintar();
    await screen.findByText("María Pérez");

    await user.click(screen.getByRole("button", { name: "Borrar mis presupuestos (2)" }));
    fetchPresupuestos.mockResolvedValue([AJENO]);
    await user.click(screen.getByRole("button", { name: "Sí, borrar 2" }));

    await waitFor(() => expect(borrarMisPresupuestos).toHaveBeenCalledWith({ cliente: "falso" }, YO));
    expect(toastSuccess).toHaveBeenCalledWith("Se borraron 2 presupuestos");
    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledTimes(2));
  });

  it("si el presupuesto abierto en el carrito era propio, lo olvida sin vaciar el carrito", async () => {
    const user = usuario();
    borrarMisPresupuestos.mockResolvedValue(2);
    const carrito = carritoFalso({
      presupuestoActivo: { id: "pr-1", clienteNombre: "María", clienteApellido: "Pérez", nota: null, createdBy: YO },
    });
    pintar({ carrito });
    await screen.findByText("María Pérez");

    await user.click(screen.getByRole("button", { name: "Borrar mis presupuestos (2)" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar 2" }));

    await waitFor(() => expect(carrito.olvidarPresupuestoActivo).toHaveBeenCalled());
    expect(carrito.vaciar).not.toHaveBeenCalled();
  });

  it("si el abierto era de otro asesor, no lo toca", async () => {
    const user = usuario();
    borrarMisPresupuestos.mockResolvedValue(2);
    const carrito = carritoFalso({
      presupuestoActivo: { id: "pr-3", clienteNombre: "Ana", clienteApellido: "López", nota: null, createdBy: OTRO },
    });
    pintar({ carrito });
    await screen.findByText("María Pérez");

    await user.click(screen.getByRole("button", { name: "Borrar mis presupuestos (2)" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar 2" }));

    await waitFor(() => expect(borrarMisPresupuestos).toHaveBeenCalled());
    expect(carrito.olvidarPresupuestoActivo).not.toHaveBeenCalled();
  });

  it("si el borrado falla, muestra el motivo en un toast y deja abierta la ventana", async () => {
    const user = usuario();
    borrarMisPresupuestos.mockRejectedValue(new Error("sin permiso"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    pintar();
    await screen.findByText("María Pérez");

    await user.click(screen.getByRole("button", { name: "Borrar mis presupuestos (2)" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar 2" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalled());
    expect(screen.getByText("¿Borrar tus 2 presupuestos?")).toBeInTheDocument();
  });

  it("sin presupuestos propios el botón queda deshabilitado", async () => {
    fetchPresupuestos.mockResolvedValue([AJENO]);
    pintar();

    expect(await screen.findByRole("button", { name: "Borrar mis presupuestos (0)" })).toBeDisabled();
  });
});

describe("PresupuestosPanel — «Abrir en el carrito»", () => {
  it("con el carrito vacío carga directo", async () => {
    const user = usuario();
    const { carrito } = pintar();
    await screen.findByText("María Pérez");

    const tarjeta = screen.getByText("María Pérez").closest("li") as HTMLElement;
    await user.click(within(tarjeta).getByRole("button", { name: "Abrir en el carrito" }));

    expect(carrito.cargarPresupuesto).toHaveBeenCalledWith(MIO_1);
  });

  it("con el carrito lleno pide confirmar y recién después carga", async () => {
    const user = usuario();
    const carrito = carritoFalso({
      lineas: [{ product: producto({ id: "x" }), quantity: 1, quotedPriceUsd: null, priceKind: "promocion" }],
    });
    pintar({ carrito });
    await screen.findByText("María Pérez");

    const tarjeta = screen.getByText("María Pérez").closest("li") as HTMLElement;
    await user.click(within(tarjeta).getByRole("button", { name: "Abrir en el carrito" }));

    expect(screen.getByText("¿Reemplazar el carrito actual?")).toBeInTheDocument();
    expect(carrito.cargarPresupuesto).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Sí, reemplazar" }));

    await waitFor(() => expect(carrito.cargarPresupuesto).toHaveBeenCalledWith(MIO_1));
  });

  it("Cancelar en la confirmación deja el carrito intacto", async () => {
    const user = usuario();
    const carrito = carritoFalso({
      lineas: [{ product: producto({ id: "x" }), quantity: 1, quotedPriceUsd: null, priceKind: "promocion" }],
    });
    pintar({ carrito });
    await screen.findByText("María Pérez");

    const tarjeta = screen.getByText("María Pérez").closest("li") as HTMLElement;
    await user.click(within(tarjeta).getByRole("button", { name: "Abrir en el carrito" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(carrito.cargarPresupuesto).not.toHaveBeenCalled();
  });
});

describe("PresupuestosPanel — borrar uno", () => {
  it("un presupuesto ajeno no tiene «Borrar» para un asesor, y sí para un supervisor", async () => {
    const user = usuario();
    const { unmount } = pintar();
    await screen.findByText("María Pérez");
    await user.click(screen.getByRole("button", { name: "De todo el equipo" }));

    const ajeno = screen.getByText("Ana López").closest("li") as HTMLElement;
    expect(within(ajeno).queryByRole("button", { name: "Borrar" })).toBeNull();
    const propio = screen.getByText("María Pérez").closest("li") as HTMLElement;
    expect(within(propio).getByRole("button", { name: "Borrar" })).toBeInTheDocument();
    unmount();

    pintar({ role: "supervisor" });
    await screen.findByText("María Pérez");
    await user.click(screen.getByRole("button", { name: "De todo el equipo" }));
    const ajenoSup = screen.getByText("Ana López").closest("li") as HTMLElement;
    expect(within(ajenoSup).getByRole("button", { name: "Borrar" })).toBeInTheDocument();
  });

  it("pide confirmar con el nombre del cliente, borra y recarga", async () => {
    const user = usuario();
    borrarPresupuesto.mockResolvedValue(undefined);
    pintar();
    await screen.findByText("María Pérez");

    const tarjeta = screen.getByText("María Pérez").closest("li") as HTMLElement;
    await user.click(within(tarjeta).getByRole("button", { name: "Borrar" }));
    expect(screen.getByText("¿Borrar el presupuesto de María Pérez?")).toBeInTheDocument();
    expect(borrarPresupuesto).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    await waitFor(() => expect(borrarPresupuesto).toHaveBeenCalledWith({ cliente: "falso" }, "pr-1"));
    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledTimes(2));
  });

  it("si era el presupuesto abierto en el carrito, lo olvida", async () => {
    const user = usuario();
    borrarPresupuesto.mockResolvedValue(undefined);
    const carrito = carritoFalso({
      presupuestoActivo: { id: "pr-1", clienteNombre: "María", clienteApellido: "Pérez", nota: null, createdBy: YO },
    });
    pintar({ carrito });
    await screen.findByText("María Pérez");

    const tarjeta = screen.getByText("María Pérez").closest("li") as HTMLElement;
    await user.click(within(tarjeta).getByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    await waitFor(() => expect(carrito.olvidarPresupuestoActivo).toHaveBeenCalled());
  });

  it("si la RLS lo rechaza, el texto del error va a un toast", async () => {
    const user = usuario();
    vi.spyOn(console, "error").mockImplementation(() => {});
    borrarPresupuesto.mockRejectedValue(new ConfigWriteDeniedError("Este presupuesto ya no existe o no es tuyo."));
    pintar();
    await screen.findByText("María Pérez");

    const tarjeta = screen.getByText("María Pérez").closest("li") as HTMLElement;
    await user.click(within(tarjeta).getByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("Este presupuesto ya no existe o no es tuyo."));
  });
});

describe("PresupuestosPanel — «Copiar»", () => {
  it("copia el texto del cliente con los precios de hoy y las casillas del asesor", async () => {
    const user = usuario();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    pintar();
    await screen.findByText("María Pérez");

    const tarjeta = screen.getByText("María Pérez").closest("li") as HTMLElement;
    await user.click(within(tarjeta).getByRole("button", { name: "Copiar" }));

    const esperado = textoCarritoParaCliente(
      totalesCarrito(lineasDePresupuesto(MIO_1), TASA, { activo: false, ...ELECCION_CASHEA_INICIAL }),
      OPCIONES_COPIA_INICIALES,
    );
    expect(esperado).toContain("Carburador PZ27");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(esperado));
    expect(toastSuccess).toHaveBeenCalled();
  });
});

describe("PresupuestosPanel — facturar en SAINT", () => {
  it("cada tarjeta lleva su «Facturar en SAINT» y el hook sigue las tarjetas visibles", async () => {
    pintar();
    await screen.findByText("María Pérez");

    expect(screen.getAllByRole("button", { name: /facturar en saint/i })).toHaveLength(2);
    expect(usoBorradores).toHaveBeenLastCalledWith("presupuesto", ["pr-1", "pr-2"]);
  });

  it("también lo ve la caja", async () => {
    pintar({ role: "caja" });
    await screen.findByText("María Pérez");

    expect(screen.getAllByRole("button", { name: /facturar en saint/i })).toHaveLength(2);
  });

  it("el modal precarga el nombre y deja la cédula y el teléfono vacíos (no hay contacto)", async () => {
    const user = usuario();
    pintar();
    await screen.findByText("María Pérez");

    await user.click(screen.getAllByRole("button", { name: /facturar en saint/i })[0]);

    expect(await screen.findByLabelText("Nombre")).toHaveValue("María");
    expect(screen.getByLabelText("Apellido")).toHaveValue("Pérez");
    expect(screen.getByLabelText("Cédula")).toHaveValue("");
    expect(screen.getByLabelText("Teléfono (opcional)")).toHaveValue("");
  });

  it("completa cédula y teléfono con los del último envío de ese presupuesto", async () => {
    borradoresPorOrigen.set("pr-1", {
      id: "b-1",
      origen: "presupuesto",
      origenId: "pr-1",
      creadoPor: YO,
      cedulaTipo: "E",
      cedulaNumero: "87654321",
      nombre: "María",
      apellido: "Pérez",
      telefono: "04125550000",
      estado: "error",
      numeroSaint: null,
      codclie: null,
      clienteCreado: null,
      error: "SAINT rechazó la cédula.",
      createdAt: "2026-10-25T14:00:00.000Z",
      procesadoAt: null,
    });
    const user = usuario();
    pintar();
    await screen.findByText("María Pérez");

    expect(screen.getByRole("status")).toHaveTextContent("SAINT rechazó la cédula.");
    await user.click(screen.getAllByRole("button", { name: /facturar en saint/i })[0]);

    expect(await screen.findByLabelText("Cédula")).toHaveValue("87654321");
    expect(screen.getByLabelText("Teléfono (opcional)")).toHaveValue("04125550000");
  });
});
