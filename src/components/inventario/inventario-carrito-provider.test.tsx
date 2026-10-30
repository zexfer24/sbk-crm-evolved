/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRole, Product } from "@/lib/types";
import type { Presupuesto } from "@/lib/presupuestos";
import {
  CARRITO_STORAGE_PREFIX,
  ESTANDAR_STORAGE_PREFIX,
  InventarioCarritoProvider,
  PRESUPUESTO_STORAGE_PREFIX,
  useInventarioCarrito,
} from "@/components/inventario/inventario-carrito-provider";

/**
 * Precio estándar, casillas de copia y presupuestos del carrito del
 * Inventario (21/10/2026, plan "Presupuestos y mensajes rápidos", T4). El
 * Drawer y el Modal de HeroUI son los reales —corren en jsdom—; solo se
 * sustituyen `toast`, el cliente de Supabase y las lecturas/escrituras de
 * datos.
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

const CLIENTE_FALSO = { cliente: "falso" };
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => CLIENTE_FALSO),
}));

const fetchProductsByIds = vi.fn();
vi.mock("@/lib/inventory-data", () => ({
  fetchProductsByIds: (...args: unknown[]) => fetchProductsByIds(...args),
}));

const guardarPresupuesto = vi.fn();
vi.mock("@/lib/presupuestos-data", () => ({
  guardarPresupuesto: (...args: unknown[]) => guardarPresupuesto(...args),
}));

// Sin el hook real no hay canal Realtime ni lectura de borradores: el cliente de este test es un objeto de mentira.
vi.mock("@/components/saint/use-borradores-saint", () => ({
  useBorradoresSaint: () => ({ porOrigen: new Map(), ahora: new Date("2026-10-28T14:00:00.000Z"), recargar: vi.fn() }),
}));

const TASA = 100;
const AGENTE = "agente-1";

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
    updatedAt: "2026-10-21T10:00:00Z",
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

/** $20 de promoción; con envío MRW de $5 el estándar es $25. */
const PE = product({
  id: "e",
  name: "Pastilla de freno",
  price: 20,
  currency: "USD",
  weightKg: 1,
  shippingFeeUsd: 5,
  saintCode: "SE-001",
});
/** Sin peso: no tiene estándar. */
const PS = product({
  id: "s",
  name: "Cable sin peso",
  price: 10,
  currency: "USD",
  weightKg: null,
  shippingFeeUsd: null,
  precioDivisaUsd: null,
  saintCode: "SS-001",
});

function presupuesto(over: Partial<Presupuesto> = {}): Presupuesto {
  return {
    id: "pres-1",
    clienteNombre: "Ana",
    clienteApellido: "Pérez",
    contactId: null,
    conversationId: null,
    origen: "inventario",
    nota: "Retira el sábado",
    totalCotizadoUsd: 25,
    createdBy: AGENTE,
    creadoPorNombre: "Asesor Uno",
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-20T10:00:00Z",
    items: [
      {
        id: "i1",
        productId: "e",
        product: PE,
        quantity: 1,
        priceKind: "estandar",
        precioCotizadoUsd: 25,
      },
    ],
    ...over,
  };
}

function Arnes({ presupuestoParaCargar }: { presupuestoParaCargar?: Presupuesto }) {
  const carrito = useInventarioCarrito();
  if (!carrito) return null;
  return (
    <div>
      <button onClick={() => carrito.agregar(PE)}>agregar E</button>
      <button onClick={() => carrito.agregar(PS)}>agregar S</button>
      <button onClick={carrito.abrir}>abrir carrito</button>
      <button onClick={() => presupuestoParaCargar && carrito.cargarPresupuesto(presupuestoParaCargar)}>
        cargar presupuesto
      </button>
      <button onClick={() => carrito.olvidarPresupuestoActivo()}>olvidar activo</button>
      <span data-testid="unidades">{carrito.unidades}</span>
      <span data-testid="cobrar-estandar">{String(carrito.cobrarEstandar)}</span>
      <span data-testid="precio-del-carrito">{String(carrito.priceKind)}</span>
      <span data-testid="activo">{carrito.presupuestoActivo?.id ?? "ninguno"}</span>
    </div>
  );
}

function montar(
  opciones: { soloLectura?: boolean; role?: AgentRole; presupuestoParaCargar?: Presupuesto } = {},
) {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  const role = opciones.role ?? "agent";
  render(
    <InventarioCarritoProvider
      agentId={AGENTE}
      bcvRate={TASA}
      soloLectura={opciones.soloLectura ?? false}
      role={role}
    >
      <Arnes presupuestoParaCargar={opciones.presupuestoParaCargar} />
    </InventarioCarritoProvider>,
  );
  return user;
}

const INTERRUPTOR = "Cobrar precio estándar (envío por peso)";

/** Abre «Opciones de cotización» si está cerrado (el estado sobrevive a cerrar y reabrir el panel). */
async function abrirOpciones(user: ReturnType<typeof userEvent.setup>) {
  const disparador = await screen.findByRole("button", { name: /Opciones de cotización/ });
  if (disparador.getAttribute("aria-expanded") !== "true") await user.click(disparador);
  return disparador;
}

function previa() {
  return screen.getByLabelText("Vista previa del texto");
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastDanger.mockClear();
  toastWarning.mockClear();
  fetchProductsByIds.mockReset();
  fetchProductsByIds.mockResolvedValue([]);
  guardarPresupuesto.mockReset();
  guardarPresupuesto.mockResolvedValue("pres-nuevo");
});

describe("el interruptor de precio estándar", () => {
  it("un asesor lo ve cuando hay renglones", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));

    await abrirOpciones(user);
    const interruptor = await screen.findByRole("switch", { name: INTERRUPTOR });
    expect(interruptor).toHaveAttribute("aria-checked", "false");
  });

  it("la caja (soloLectura) NO lo ve y su carrito queda en promoción", async () => {
    const user = montar({ soloLectura: true, role: "caja" });
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));

    await abrirOpciones(user);
    await screen.findByRole("switch", { name: "Financiar con Cashea" });
    expect(screen.queryByRole("switch", { name: INTERRUPTOR })).toBeNull();
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("promocion");
  });

  it("encenderlo pasa los precios del panel a estándar y la vista previa no dice «incluye envío»", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));

    const items = within(await screen.findByRole("list", { name: "Productos del carrito" })).getAllByRole("listitem");
    expect(within(items[0]).getByText(/c\/u .*\$20,00/)).toBeInTheDocument();
    await abrirOpciones(user);
    expect(previa()).toHaveTextContent("Precio: $20.00");

    await user.click(screen.getByRole("switch", { name: INTERRUPTOR }));

    expect(screen.getByRole("switch", { name: INTERRUPTOR })).toHaveAttribute("aria-checked", "true");
    expect(within(items[0]).getByText(/c\/u .*\$25,00/)).toBeInTheDocument();
    expect(within(items[0]).getByText("Estándar")).toBeInTheDocument();
    expect(previa()).toHaveTextContent("Precio: $25.00");
    expect(previa().textContent ?? "").not.toMatch(/incluye envío/i);
    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("true");
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("estandar");
  });

  it("con el estándar encendido, lo que se agrega después entra a estándar", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));
    await abrirOpciones(user);
    await user.click(await screen.findByRole("switch", { name: INTERRUPTOR }));

    await user.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByText("Carrito de cotización")).toBeNull());
    await user.click(screen.getByText("agregar S"));

    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("estandar");
  });

  // 28/10/2026 ("El carrito de cotización se ordena", T1): el estándar ya no se recuerda.
  it("encender el estándar no escribe nada en localStorage", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));
    await abrirOpciones(user);
    await user.click(await screen.findByRole("switch", { name: INTERRUPTOR }));

    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("true");
    expect(localStorage.getItem(`${ESTANDAR_STORAGE_PREFIX}${AGENTE}`)).toBeNull();
  });

  it("tras encender el estándar, desmontar y volver a montar sin carrito guardado arranca en promoción", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));
    await abrirOpciones(user);
    await user.click(await screen.findByRole("switch", { name: INTERRUPTOR }));
    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("true");

    cleanup();
    localStorage.removeItem(`${CARRITO_STORAGE_PREFIX}${AGENTE}`);
    const otra = montar();

    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("false");
    await otra.click(screen.getByText("agregar E"));
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("promocion");
  });

  it("vaciar apaga el estándar: lo que se agrega después entra a promoción", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));
    await abrirOpciones(user);
    await user.click(await screen.findByRole("switch", { name: INTERRUPTOR }));
    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("true");

    await user.click(screen.getByRole("button", { name: "Vaciar" }));
    await user.click(screen.getByRole("button", { name: "Sí, vaciar" }));

    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("false");
    // El panel (modal) sigue abierto: se cierra antes de tocar el arnés, que vive afuera.
    await user.click(await screen.findByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByText("Carrito de cotización")).toBeNull());
    await user.click(screen.getByText("agregar E"));
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("promocion");
  });

  it("un renglón sin peso con el estándar encendido dice por qué no tiene precio y deshabilita Copiar", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("agregar S"));
    await user.click(screen.getByText("abrir carrito"));

    expect(await screen.findByRole("button", { name: "Copiar" })).toBeEnabled();

    await abrirOpciones(user);
    await user.click(screen.getByRole("switch", { name: INTERRUPTOR }));

    expect(screen.getByText(/Sin precio estándar: Sin peso cargado/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copiar" })).toBeDisabled();
    expect(screen.getByText("Completa el precio de los renglones marcados para copiar.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Vista previa del texto")).toBeNull();
  });

  it("con renglones de los dos precios aparece apagado y avisa que son mixtos", async () => {
    localStorage.setItem(
      `${CARRITO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify([
        { productId: "e", quantity: 1, priceKind: "estandar" },
        { productId: "s", quantity: 1, priceKind: "promocion" },
      ]),
    );
    fetchProductsByIds.mockResolvedValue([PE, PS]);
    const user = montar();
    await waitFor(() => expect(screen.getByTestId("unidades")).toHaveTextContent("2"));
    await user.click(screen.getByText("abrir carrito"));

    await abrirOpciones(user);
    const interruptor = await screen.findByRole("switch", { name: INTERRUPTOR });
    expect(interruptor).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Algunos renglones van con estándar")).toBeInTheDocument();
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("mixto");
  });
});

describe("las casillas de copia", () => {
  it("desmarcar «Código» quita el SKU de la vista previa y de lo que se copia", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = montar();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));

    await abrirOpciones(user);
    await screen.findByLabelText("Vista previa del texto");
    expect(previa()).toHaveTextContent("SKU: SE-001");

    await user.click(screen.getByRole("checkbox", { name: "Código" }));

    expect(previa().textContent ?? "").not.toContain("SKU:");
    await user.click(screen.getByRole("button", { name: "Copiar" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0])).not.toContain("SKU:");
  });

  it("la casilla «Plan Cashea» existe en el carrito del Inventario", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));

    await abrirOpciones(user);
    expect(await screen.findByRole("checkbox", { name: "Plan Cashea" })).toBeChecked();
  });
});

describe("guardar presupuesto", () => {
  async function llenarYGuardar(user: ReturnType<typeof userEvent.setup>, boton: string) {
    await user.type(await screen.findByRole("textbox", { name: /Nombre/ }), "Ana");
    await user.type(screen.getByRole("textbox", { name: /Apellido/ }), "Pérez");
    await user.click(screen.getByRole("button", { name: boton }));
  }

  it("está deshabilitado con el carrito vacío", async () => {
    const user = montar();
    await user.click(screen.getByText("abrir carrito"));
    await screen.findByText("Carrito de cotización");
    // Con el carrito vacío no hay pie: tampoco se ofrece guardar.
    expect(screen.queryByRole("button", { name: "Guardar presupuesto" })).toBeNull();
  });

  it("guarda como nuevo, con origen inventario, id nulo y los renglones con su price_kind", async () => {
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));
    await abrirOpciones(user);
    await user.click(await screen.findByRole("switch", { name: INTERRUPTOR }));

    await user.click(screen.getByRole("button", { name: "Guardar presupuesto" }));
    await llenarYGuardar(user, "Guardar");

    await waitFor(() => expect(guardarPresupuesto).toHaveBeenCalledTimes(1));
    expect(guardarPresupuesto).toHaveBeenCalledWith(CLIENTE_FALSO, {
      id: null,
      clienteNombre: "Ana",
      clienteApellido: "Pérez",
      contactId: null,
      conversationId: null,
      origen: "inventario",
      nota: null,
      items: [{ product_id: "e", quantity: 1, price_kind: "estandar", precio_cotizado_usd: 25 }],
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Presupuesto de Ana Pérez guardado"));
    // Queda como presupuesto activo: el chip y la ayuda aparecen en la cabecera.
    expect(screen.getByTestId("activo")).toHaveTextContent("pres-nuevo");
  });

  it("si falla, el modal muestra el motivo y el presupuesto NO queda activo", async () => {
    guardarPresupuesto.mockRejectedValue(new Error("Sin conexión con la base"));
    const user = montar();
    await user.click(screen.getByText("agregar E"));
    await user.click(screen.getByText("abrir carrito"));
    await user.click(await screen.findByRole("button", { name: "Guardar presupuesto" }));
    await llenarYGuardar(user, "Guardar");

    expect(await screen.findByText("Sin conexión con la base")).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId("activo")).toHaveTextContent("ninguno");
  });

  it("con un presupuesto propio abierto ofrece «Guardar cambios» y manda su id", async () => {
    const user = montar({ presupuestoParaCargar: presupuesto({ createdBy: AGENTE }) });
    await user.click(screen.getByText("cargar presupuesto"));

    // La cabecera muestra de qué cliente es y avisa que no se guarda solo.
    expect(await screen.findByText("Ana Pérez")).toBeInTheDocument();
    expect(screen.getByText("Presupuesto guardado · los cambios no se guardan solos")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Guardar presupuesto" }));
    // El modal precarga los datos del presupuesto.
    expect(await screen.findByRole("textbox", { name: /Nombre/ })).toHaveValue("Ana");
    expect(screen.getByRole("textbox", { name: /Apellido/ })).toHaveValue("Pérez");
    expect(screen.getByRole("button", { name: "Guardar como nuevo" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(guardarPresupuesto).toHaveBeenCalledTimes(1));
    expect(guardarPresupuesto.mock.calls[0][1]).toMatchObject({
      id: "pres-1",
      clienteNombre: "Ana",
      clienteApellido: "Pérez",
      nota: "Retira el sábado",
      origen: "inventario",
    });
  });

  it("con un presupuesto ajeno solo ofrece «Guardar»", async () => {
    const user = montar({ presupuestoParaCargar: presupuesto({ createdBy: "otro-asesor" }) });
    await user.click(screen.getByText("cargar presupuesto"));
    await user.click(await screen.findByRole("button", { name: "Guardar presupuesto" }));

    await screen.findByRole("textbox", { name: /Nombre/ });
    expect(screen.getByRole("button", { name: "Guardar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar como nuevo" })).toBeNull();
  });

  it("un supervisor sí puede guardar cambios sobre un presupuesto ajeno", async () => {
    const user = montar({ role: "supervisor", presupuestoParaCargar: presupuesto({ createdBy: "otro-asesor" }) });
    await user.click(screen.getByText("cargar presupuesto"));
    await user.click(await screen.findByRole("button", { name: "Guardar presupuesto" }));

    expect(await screen.findByRole("button", { name: "Guardar cambios" })).toBeInTheDocument();
  });
});

describe("el presupuesto activo", () => {
  it("cargarPresupuesto reemplaza el carrito, lo deja a su precio y abre el panel", async () => {
    const user = montar({ presupuestoParaCargar: presupuesto() });
    await user.click(screen.getByText("agregar S"));
    await user.click(screen.getByText("cargar presupuesto"));

    expect(await screen.findByText("Carrito de cotización")).toBeInTheDocument();
    expect(screen.getByTestId("unidades")).toHaveTextContent("1");
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("estandar");
    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("true");
    await abrirOpciones(user);
    expect(screen.getByRole("switch", { name: INTERRUPTOR })).toHaveAttribute("aria-checked", "true");
  });

  it("olvidarPresupuestoActivo quita el chip sin tocar los renglones", async () => {
    const user = montar({ presupuestoParaCargar: presupuesto() });
    await user.click(screen.getByText("cargar presupuesto"));
    expect(screen.getByTestId("activo")).toHaveTextContent("pres-1");

    // El panel (modal) quedó abierto: se cierra antes de tocar el arnés, que vive afuera.
    await user.click(await screen.findByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByText("Carrito de cotización")).toBeNull());
    await user.click(screen.getByText("olvidar activo"));

    expect(screen.getByTestId("activo")).toHaveTextContent("ninguno");
    expect(screen.getByTestId("unidades")).toHaveTextContent("1");
    expect(localStorage.getItem(`${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`)).toBeNull();
  });

  it("vaciar el carrito limpia el chip y lo guardado", async () => {
    const user = montar({ presupuestoParaCargar: presupuesto() });
    await user.click(screen.getByText("cargar presupuesto"));
    expect(await screen.findByText("Ana Pérez")).toBeInTheDocument();
    expect(localStorage.getItem(`${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Vaciar" }));
    await user.click(screen.getByRole("button", { name: "Sí, vaciar" }));

    expect(screen.getByTestId("activo")).toHaveTextContent("ninguno");
    expect(screen.queryByText("Ana Pérez")).toBeNull();
    expect(localStorage.getItem(`${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`)).toBeNull();
  });
});

describe("lo que el provider restaura al montar", () => {
  it("el presupuesto activo y el carrito guardados, con el precio que cada renglón tenía", async () => {
    localStorage.setItem(
      `${CARRITO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify([{ productId: "e", quantity: 2, priceKind: "estandar" }]),
    );
    localStorage.setItem(
      `${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify({
        id: "pres-9",
        clienteNombre: "Luis",
        clienteApellido: "Gómez",
        nota: null,
        createdBy: AGENTE,
      }),
    );
    fetchProductsByIds.mockResolvedValue([PE]);

    const user = montar();
    await waitFor(() => expect(screen.getByTestId("activo")).toHaveTextContent("pres-9"));
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("estandar");

    await user.click(screen.getByText("abrir carrito"));
    expect(await screen.findByText("Luis Gómez")).toBeInTheDocument();
  });

  it("descarta el presupuesto activo si el carrito restaurado queda vacío", async () => {
    localStorage.setItem(`${CARRITO_STORAGE_PREFIX}${AGENTE}`, JSON.stringify([]));
    localStorage.setItem(
      `${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify({ id: "pres-9", clienteNombre: "Luis", clienteApellido: "Gómez", nota: null, createdBy: AGENTE }),
    );

    montar();

    await waitFor(() => expect(localStorage.getItem(`${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`)).toBeNull());
    expect(screen.getByTestId("activo")).toHaveTextContent("ninguno");
  });

  it("descarta el presupuesto activo si los productos del carrito ya no existen", async () => {
    localStorage.setItem(
      `${CARRITO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify([{ productId: "borrado", quantity: 1, priceKind: "promocion" }]),
    );
    localStorage.setItem(
      `${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify({ id: "pres-9", clienteNombre: "Luis", clienteApellido: "Gómez", nota: null, createdBy: AGENTE }),
    );
    fetchProductsByIds.mockResolvedValue([]);

    montar();

    await waitFor(() => expect(fetchProductsByIds).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem(`${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`)).toBeNull());
    expect(screen.getByTestId("activo")).toHaveTextContent("ninguno");
  });

  it("un JSON de presupuesto activo roto no lo restaura ni rompe nada", async () => {
    localStorage.setItem(
      `${CARRITO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify([{ productId: "e", quantity: 1, priceKind: "promocion" }]),
    );
    localStorage.setItem(`${PRESUPUESTO_STORAGE_PREFIX}${AGENTE}`, "{no es json");
    fetchProductsByIds.mockResolvedValue([PE]);

    montar();

    await waitFor(() => expect(screen.getByTestId("unidades")).toHaveTextContent("1"));
    expect(screen.getByTestId("activo")).toHaveTextContent("ninguno");
  });

  it("con la clave vieja de estándar en '1', el carrito arranca en promoción y la clave se borra", async () => {
    localStorage.setItem(`${ESTANDAR_STORAGE_PREFIX}${AGENTE}`, "1");
    const user = montar();

    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("false");
    await user.click(screen.getByText("agregar E"));
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("promocion");
    await waitFor(() => expect(localStorage.getItem(`${ESTANDAR_STORAGE_PREFIX}${AGENTE}`)).toBeNull());
  });

  it("un carrito guardado con todos sus renglones en estándar se restaura con el interruptor encendido; uno mixto, apagado", async () => {
    localStorage.setItem(
      `${CARRITO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify([
        { productId: "e", quantity: 1, priceKind: "estandar" },
        { productId: "s", quantity: 1, priceKind: "estandar" },
      ]),
    );
    fetchProductsByIds.mockResolvedValue([PE, PS]);
    montar();
    await waitFor(() => expect(screen.getByTestId("unidades")).toHaveTextContent("2"));
    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("true");

    cleanup();
    localStorage.setItem(
      `${CARRITO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify([
        { productId: "e", quantity: 1, priceKind: "estandar" },
        { productId: "s", quantity: 1, priceKind: "promocion" },
      ]),
    );
    montar();
    await waitFor(() => expect(screen.getByTestId("unidades")).toHaveTextContent("2"));
    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("false");
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("mixto");
  });

  it("con soloLectura, un carrito guardado en estándar se restaura en promoción y el interruptor queda apagado", async () => {
    localStorage.setItem(
      `${CARRITO_STORAGE_PREFIX}${AGENTE}`,
      JSON.stringify([{ productId: "e", quantity: 1, priceKind: "estandar" }]),
    );
    fetchProductsByIds.mockResolvedValue([PE]);

    const user = montar({ soloLectura: true, role: "caja" });
    await waitFor(() => expect(screen.getByTestId("unidades")).toHaveTextContent("1"));
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("promocion");
    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("false");

    await user.click(screen.getByText("abrir carrito"));
    const items = within(await screen.findByRole("list", { name: "Productos del carrito" })).getAllByRole("listitem");
    expect(within(items[0]).getByText(/c\/u .*\$20,00/)).toBeInTheDocument();
    expect(within(items[0]).queryByText("Estándar")).toBeNull();
  });

  it("con soloLectura, la preferencia de estándar guardada no cuenta", async () => {
    localStorage.setItem(`${ESTANDAR_STORAGE_PREFIX}${AGENTE}`, "1");
    const user = montar({ soloLectura: true, role: "caja" });

    expect(screen.getByTestId("cobrar-estandar")).toHaveTextContent("false");
    await user.click(screen.getByText("agregar E"));
    expect(screen.getByTestId("precio-del-carrito")).toHaveTextContent("promocion");
  });
});
