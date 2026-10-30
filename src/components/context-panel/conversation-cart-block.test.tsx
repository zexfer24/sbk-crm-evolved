/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@heroui/react";
import { ConversationCartBlock } from "@/components/context-panel/conversation-cart-block";
import type { CartActions } from "@/components/context-panel/use-cart-actions";
import type { ConversationCartItem, Product } from "@/lib/types";
import type { BorradorSaint } from "@/lib/saint-borradores";

// El toast real de HeroUI no aporta nada acá: se espía `success`/`danger` de
// «Copiar» (T4, "Ronda del cliente", 30/9/2026) y el resto del módulo queda
// intacto.
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() } };
});

// 21/10/2026 (plan "Presupuestos y mensajes rápidos", T6): el bloque guarda el
// carrito como presupuesto y lista los del cliente. Supabase y las lecturas/
// escrituras de presupuestos se mockean; `PresupuestosCliente` se prueba aparte.
const guardarPresupuesto = vi.fn();
const fetchPresupuestos = vi.fn();
vi.mock("@/lib/presupuestos-data", () => ({
  guardarPresupuesto: (...args: unknown[]) => guardarPresupuesto(...args),
  fetchPresupuestos: (...args: unknown[]) => fetchPresupuestos(...args),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({ marca: "cliente" })) }));
vi.mock("@/lib/mutations", () => ({ addToCart: vi.fn() }));

// 28/10/2026: el bloque NO debe suscribirse a los envíos del CARRITO (lo hace
// `ContextPanel`): si algún día vuelve a llamar al hook con ese origen, estos
// tests revientan. Los presupuestos del cliente (`PresupuestosCliente`, que
// vive dentro del bloque) sí tienen su propia suscripción, de origen
// `presupuesto`.
vi.mock("@/components/saint/use-borradores-saint", () => ({
  useBorradoresSaint: (origen: string) => {
    if (origen === "carrito") {
      throw new Error("ConversationCartBlock no debe llamar a useBorradoresSaint(\"carrito\"): lo recibe por props");
    }
    return { porOrigen: new Map(), ahora: new Date("2026-10-25T14:00:30.000Z"), recargar: vi.fn() };
  },
}));

beforeEach(() => {
  guardarPresupuesto.mockReset();
  guardarPresupuesto.mockResolvedValue("pres-nuevo");
  fetchPresupuestos.mockReset();
  fetchPresupuestos.mockResolvedValue([]);
  window.localStorage.clear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.danger).mockClear();
});

// ---------------------------------------------------------------------------
// T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): el bloque «Lo que lleva el cliente» del panel
// derecho. Es presentacional: pinta el carrito con precios VIGENTES y delega
// cada acción en `CartActions` (probadas aparte en `use-cart-actions.test.tsx`).
// Jsdom no calcula layout: este archivo prueba contenido y comportamiento, no
// que la columna de 300 px se vea bien.
// ---------------------------------------------------------------------------

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
    updatedAt: "2026-09-29T10:00:00.000Z",
    compatibility: [],
    weightKg: null,
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

function item(over: Partial<ConversationCartItem> = {}): ConversationCartItem {
  const p = over.product ?? product();
  return {
    id: "cart-1",
    conversationId: "conv-1",
    productId: p.id,
    quantity: 2,
    origin: "inventory",
    quoteId: null,
    quotedPriceUsd: null,
    priceKind: "promocion",
    addedBy: "agent-1",
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    product: p,
    ...over,
  };
}

function makeActions(over: Partial<CartActions> = {}): CartActions {
  return {
    busy: false,
    addProduct: vi.fn().mockResolvedValue(undefined),
    addQuote: vi.fn().mockResolvedValue(undefined),
    addAllQuotes: vi.fn().mockResolvedValue(undefined),
    setQuantity: vi.fn().mockResolvedValue(undefined),
    setPriceKind: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// 28/10/2026 (plan "Facturar en SAINT sale del fondo del panel", T3): el bloque
// ya no llama a `useBorradoresSaint` (lo hace `ContextPanel`, para que haya una
// sola suscripción Realtime y «Cerrar venta» pueda mirar el mismo envío): el
// último envío, el reloj y la recarga llegan por props.
const AHORA = new Date("2026-10-25T14:00:30.000Z");

function envio(estado: BorradorSaint["estado"], over: Partial<BorradorSaint> = {}): BorradorSaint {
  return {
    id: "b-1",
    origen: "carrito",
    origenId: "conv-1",
    creadoPor: "agent-1",
    cedulaTipo: "V",
    cedulaNumero: "12345678",
    nombre: "María",
    apellido: "Pérez",
    telefono: "04141234567",
    estado,
    numeroSaint: estado === "creado" ? "FAC-77" : null,
    codclie: null,
    clienteCreado: null,
    error: estado === "error" ? "SAINT rechazó el artículo" : null,
    createdAt: "2026-10-25T14:00:00.000Z",
    procesadoAt: estado === "creado" || estado === "error" ? "2026-10-25T14:00:10.000Z" : null,
    ...over,
  };
}

interface SetupOpciones {
  ultimoEnvio?: BorradorSaint | null;
  isDealWon?: boolean;
  sinComposer?: boolean;
}

function setup(
  cart: ConversationCartItem[],
  actions = makeActions(),
  bcvRate = 40,
  { ultimoEnvio = null, isDealWon = false, sinComposer = false }: SetupOpciones = {},
) {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  const onSendToComposer = vi.fn();
  const onEnviosRecargar = vi.fn();
  render(
    <ConversationCartBlock
      cart={cart}
      bcvRate={bcvRate}
      actions={actions}
      onSendToComposer={sinComposer ? undefined : onSendToComposer}
      agentId="agent-1"
      conversationId="conv-1"
      contactId="contact-1"
      contactDisplayName="María José Pérez"
      contactPhone="04141234567"
      contactCedulaType="V"
      contactCedulaNumber="12345678"
      onCartChanged={vi.fn()}
      ultimoEnvio={ultimoEnvio}
      ahora={AHORA}
      onEnviosRecargar={onEnviosRecargar}
      isDealWon={isDealWon}
    />
  );
  return { user, actions, onSendToComposer, onEnviosRecargar };
}

describe("ConversationCartBlock — carrito vacío", () => {
  it("dice qué es y cómo llenarlo, con el texto exacto", () => {
    setup([]);

    expect(screen.getByText("Lo que lleva el cliente")).toBeInTheDocument();
    expect(
      screen.getByText("Todavía no hay nada. Agrega repuestos desde el inventario de arriba."),
    ).toBeInTheDocument();
  });

  // 26/10/2026: el botón se retiró de la UI (la acción queda en el hook).
  it("ya no ofrece «Agregar cotizaciones de Seba»", () => {
    setup([]);

    expect(screen.queryByRole("button", { name: /agregar cotizaciones de seba/i })).not.toBeInTheDocument();
  });
});

describe("ConversationCartBlock — con renglones", () => {
  it("muestra nombre, precio vigente por unidad, subtotal y el total en dólares y bolívares", () => {
    setup([
      item({ quantity: 2 }),
      item({ id: "cart-2", productId: "prod-2", product: product({ id: "prod-2", name: "Kit de arrastre", price: 5 }), quantity: 1 }),
    ]);

    expect(screen.getByText("Carburador PZ27")).toBeInTheDocument();
    expect(screen.getByText("Kit de arrastre")).toBeInTheDocument();
    // Carburador: 2 x $20 = $40 (Bs. 1600.00); Kit: 1 x $5 = $5.
    expect(screen.getByText("$40.00")).toBeInTheDocument();
    // Total = $45 y Bs. 1800.00 (2 x 800 + 1 x 200).
    expect(screen.getByTestId("cart-total")).toHaveTextContent("$45.00");
    expect(screen.getByTestId("cart-total")).toHaveTextContent("Bs. 1800.00");
  });

  it("un renglón que vino de una cotización con otro precio muestra «cotizado $X · hoy $Y» y cobra el de hoy", () => {
    setup([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 18, quantity: 1 })]);

    expect(screen.getByText("cotizado $18.00 · hoy $20.00")).toBeInTheDocument();
    expect(screen.getByTestId("cart-total")).toHaveTextContent("$20.00");
  });

  it("si el precio cotizado coincide con el de hoy no muestra la comparación", () => {
    setup([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 20 })]);

    expect(screen.queryByText(/cotizado \$/i)).not.toBeInTheDocument();
  });

  it("un repuesto en bolívares sin tasa queda marcado «Sin tasa» y avisa que no entra al total", () => {
    setup([item({ product: product({ currency: "VES", price: 101 }) })], makeActions(), 0);

    expect(screen.getAllByText(/sin tasa/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/sin precio/i)).toBeInTheDocument();
  });

  it("«+» sube una unidad, escribiendo la cantidad nueva", async () => {
    const { user, actions } = setup([item({ quantity: 2 })]);

    await user.click(screen.getByRole("button", { name: "Agregar una unidad de Carburador PZ27" }));

    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 3);
  });

  it("«−» baja una unidad, pero con una sola no baja de ahí", async () => {
    const { user, actions } = setup([item({ quantity: 3 })]);
    await user.click(screen.getByRole("button", { name: "Restar una unidad de Carburador PZ27" }));
    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 2);
  });

  it("con una sola unidad el «−» está deshabilitado (quitar es otro botón)", () => {
    setup([item({ quantity: 1 })]);

    expect(screen.getByRole("button", { name: "Restar una unidad de Carburador PZ27" })).toBeDisabled();
  });

  it("escribir una cantidad se guarda al salir del campo, no en cada tecla", () => {
    const { actions } = setup([item({ quantity: 2 })]);
    const input = screen.getByLabelText("Cantidad de Carburador PZ27");

    fireEvent.change(input, { target: { value: "7" } });
    expect(actions.setQuantity).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 7);
  });

  it("una cantidad inválida (vacía o cero) vuelve a la que había y no escribe nada", () => {
    const { actions } = setup([item({ quantity: 2 })]);
    const input = screen.getByLabelText("Cantidad de Carburador PZ27");

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    expect(actions.setQuantity).not.toHaveBeenCalled();
    expect(input).toHaveValue("2");
  });

  it("la misma cantidad no vuelve a escribirse", () => {
    const { actions } = setup([item({ quantity: 2 })]);
    const input = screen.getByLabelText("Cantidad de Carburador PZ27");

    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.blur(input);

    expect(actions.setQuantity).not.toHaveBeenCalled();
  });

  it("quitar pide borrar SOLO ese renglón", async () => {
    const { user, actions } = setup([
      item({ quantity: 1 }),
      item({ id: "cart-2", productId: "prod-2", product: product({ id: "prod-2", name: "Kit de arrastre" }) }),
    ]);

    await user.click(screen.getByRole("button", { name: "Quitar Kit de arrastre del carrito" }));

    expect(actions.remove).toHaveBeenCalledWith("cart-2");
    expect(actions.remove).toHaveBeenCalledTimes(1);
  });

  // T9 (29/9/2026, 3.5): la existencia también se ve en el carrito, y un
  // renglón cuyo producto quedó en 0 se marca — se puede vender igual (puede
  // haber existencia física sin cargar), pero el asesor tiene que enterarse.
  it("cada renglón lleva la pastilla de existencia de su producto", () => {
    setup([item({ product: product({ stockQuantity: 5 }) })]);

    expect(screen.getByText("5 en stock")).toHaveAttribute("data-stock", "in");
  });

  it("un renglón cuyo producto quedó en 0 se marca «Agotado» y el renglón queda señalado", () => {
    setup([
      item({ product: product({ stockQuantity: 5 }) }),
      item({
        id: "cart-2",
        productId: "prod-2",
        product: product({ id: "prod-2", name: "Kit de arrastre", stockQuantity: 0 }),
      }),
    ]);

    expect(screen.getByText("Agotado")).toHaveAttribute("data-stock", "out");
    const renglonAgotado = screen.getByText("Kit de arrastre").closest("li");
    expect(renglonAgotado).toHaveAttribute("data-agotado", "true");
    const renglonConStock = screen.getByText("Carburador PZ27").closest("li");
    expect(renglonConStock).not.toHaveAttribute("data-agotado");
  });

  it("mientras hay una escritura en curso los controles se deshabilitan", () => {
    setup([item({ quantity: 2 })], makeActions({ busy: true }));

    expect(screen.getByRole("button", { name: "Agregar una unidad de Carburador PZ27" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quitar Carburador PZ27 del carrito" })).toBeDisabled();
  });
});

// T4 del plan "Ronda del cliente" (30/9/2026): «Copiar» y «Enviar al chat» bajo
// el total. El texto exacto lo cubre `cartSummaryText` en su propio test; acá
// se prueba que los botones lo usan tal cual y cuándo existen.
describe("ConversationCartBlock — copiar y enviar al chat", () => {
  // 21/10/2026 (T3): el resumen trae por defecto el total en bolívares ($20 x 40 = Bs. 800,00).
  const TEXTO = [
    "Carburador PZ27",
    "SKU: A-100",
    "Precio: $20.00",
    "",
    "Total: $20.00",
    "Total en bolívares: Bs. 800,00",
  ].join("\n");
  const renglon = () => item({ quantity: 1, product: product({ saintCode: "A-100" }) });

  it("con el carrito vacío no existen ni «Copiar» ni «Enviar al chat»", () => {
    setup([]);

    expect(screen.queryByRole("button", { name: /^copiar$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enviar al chat/i })).not.toBeInTheDocument();
  });

  it("«Copiar» pone el resumen exacto en el portapapeles y avisa con un toast", async () => {
    const { user } = setup([renglon()]);
    // `userEvent.setup()` instala su propio stub de `navigator.clipboard`: se
    // espía DESPUÉS del setup (mismo criterio que catalog-links-panel.test.tsx).
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const { toast } = await import("@heroui/react");

    await user.click(screen.getByRole("button", { name: /^copiar$/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEXTO));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Carrito copiado"));
  });

  it("si el portapapeles falla, avisa «No se pudo copiar»", async () => {
    const { user } = setup([renglon()]);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denegado"));
    const { toast } = await import("@heroui/react");

    await user.click(screen.getByRole("button", { name: /^copiar$/i }));

    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith("No se pudo copiar"));
  });

  it("«Enviar al chat» entrega el mismo texto a onSendToComposer, sin copiar nada", async () => {
    const { user, onSendToComposer } = setup([renglon()]);
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: /enviar al chat/i }));

    expect(onSendToComposer).toHaveBeenCalledTimes(1);
    expect(onSendToComposer).toHaveBeenCalledWith(TEXTO);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("con un renglón sin precio (falta la tasa BCV) los dos botones quedan deshabilitados y dicen por qué", async () => {
    const { user, onSendToComposer } = setup([item({ product: product({ currency: "VES", price: 101 }) })], makeActions(), 0);
    const copiar = screen.getByRole("button", { name: /^copiar$/i });
    const enviar = screen.getByRole("button", { name: /enviar al chat/i });

    expect(copiar).toBeDisabled();
    expect(enviar).toBeDisabled();
    // El `title` vive en el envoltorio del botón (el Button de HeroUI no lo pasa al DOM).
    expect(copiar.closest("[title]")).toHaveAttribute("title", "Hay productos sin precio (falta la tasa BCV)");
    expect(enviar.closest("[title]")).toHaveAttribute("title", "Hay productos sin precio (falta la tasa BCV)");

    await user.click(enviar);
    expect(onSendToComposer).not.toHaveBeenCalled();
  });
});

// 14/10/2026: cada renglón se cobra a precio de promoción o estándar (promoción
// + envío MRW), a elección del asesor, con un control segmentado.
describe("ConversationCartBlock — precio de promoción o estándar por renglón", () => {
  const conTarifa = () => product({ price: 25, weightKg: 2, shippingFeeUsd: 2.5 });

  it("cada renglón trae un grupo «Precio de <repuesto>» con Promoción y Estándar, y marca el elegido", () => {
    setup([item({ product: conTarifa(), priceKind: "estandar" })]);

    const grupo = screen.getByRole("radiogroup", { name: "Precio de Carburador PZ27" });
    const promocion = within(grupo).getByRole("radio", { name: "Promoción" });
    const estandar = within(grupo).getByRole("radio", { name: "Estándar" });
    expect(promocion).toHaveAttribute("aria-checked", "false");
    expect(estandar).toHaveAttribute("aria-checked", "true");
  });

  it("un renglón estándar se cobra promoción + envío en el subtotal y en el total", () => {
    setup([item({ product: conTarifa(), priceKind: "estandar", quantity: 2 })]);

    expect(screen.getByText("$27.50 c/u")).toBeInTheDocument();
    expect(screen.getByTestId("cart-total")).toHaveTextContent("$55.00");
  });

  it("elegir «Estándar» en un renglón de promoción llama a setPriceKind con «estandar»", async () => {
    const { user, actions } = setup([item({ product: conTarifa(), priceKind: "promocion" })]);

    await user.click(screen.getByRole("radio", { name: "Estándar" }));

    expect(actions.setPriceKind).toHaveBeenCalledWith("cart-1", "estandar");
  });

  it("elegir «Promoción» en un renglón estándar llama a setPriceKind con «promocion»", async () => {
    const { user, actions } = setup([item({ product: conTarifa(), priceKind: "estandar" })]);

    await user.click(screen.getByRole("radio", { name: "Promoción" }));

    expect(actions.setPriceKind).toHaveBeenCalledWith("cart-1", "promocion");
  });

  it("tocar el precio que ya está elegido no escribe nada", async () => {
    const { user, actions } = setup([item({ product: conTarifa(), priceKind: "promocion" })]);

    await user.click(screen.getByRole("radio", { name: "Promoción" }));

    expect(actions.setPriceKind).not.toHaveBeenCalled();
  });

  it("sin tarifa MRW «Estándar» está deshabilitado y dice el motivo", async () => {
    const { user, actions } = setup([item({ product: product({ weightKg: null, shippingFeeUsd: null }) })]);

    const estandar = screen.getByRole("radio", { name: "Estándar" });
    expect(estandar).toBeDisabled();
    expect(estandar).toHaveAttribute("title", "Sin peso cargado");
    await user.click(estandar);
    expect(actions.setPriceKind).not.toHaveBeenCalled();
  });

  it("el motivo de «Estándar» deshabilitado distingue fuera de la tabla y sin rango", () => {
    setup([
      item({ id: "a", product: product({ id: "p1", name: "Pesado", weightKg: 95, shippingFeeUsd: null }) }),
      item({ id: "b", product: product({ id: "p2", name: "Raro", weightKg: 10, shippingFeeUsd: null }) }),
    ]);

    const grupoPesado = screen.getByRole("radiogroup", { name: "Precio de Pesado" });
    expect(within(grupoPesado).getByRole("radio", { name: "Estándar" })).toHaveAttribute(
      "title",
      "Más de 80 kg: fuera de la tabla MRW"
    );
    const grupoRaro = screen.getByRole("radiogroup", { name: "Precio de Raro" });
    expect(within(grupoRaro).getByRole("radio", { name: "Estándar" })).toHaveAttribute(
      "title",
      "Sin tarifa MRW para este peso"
    );
  });

  it("un renglón estándar que perdió su tarifa avisa que no se puede cerrar y deja volver a promoción", async () => {
    const { user, actions } = setup([item({ priceKind: "estandar" })]);

    expect(screen.getByText("Sin tarifa MRW: cámbialo a promoción para poder cerrar")).toBeInTheDocument();
    expect(screen.getByTestId("cart-total")).toHaveTextContent("$0.00");

    await user.click(screen.getByRole("radio", { name: "Promoción" }));
    expect(actions.setPriceKind).toHaveBeenCalledWith("cart-1", "promocion");
  });

  // 21/10/2026: INVERTIDO. Antes el resumen decía «Precio (incluye envío)»; el
  // cliente pidió que el texto que se manda NO diga «incluye envío» (el precio
  // estándar ya lo lleva sumado) y el rótulo es siempre «Precio».
  it("el resumen para el cliente NO dice «incluye envío» aunque el renglón sea estándar", async () => {
    const { user, onSendToComposer } = setup([
      item({ quantity: 1, priceKind: "estandar", product: product({ price: 25, saintCode: "A-1", shippingFeeUsd: 2.5 }) }),
    ]);

    await user.click(screen.getByRole("button", { name: /enviar al chat/i }));

    const texto = onSendToComposer.mock.calls[0][0] as string;
    expect(texto).toContain("Precio: $27.50");
    expect(texto).not.toMatch(/incluye env[ií]o/i);
  });

  it("mientras hay una escritura en curso el selector se deshabilita", () => {
    setup([item({ product: conTarifa() })], makeActions({ busy: true }));

    expect(screen.getByRole("radio", { name: "Promoción" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Estándar" })).toBeDisabled();
  });
});

// 21/10/2026 (plan "Presupuestos y mensajes rápidos", T6): qué se copia.
describe("ConversationCartBlock — qué copiar", () => {
  const renglon = () => item({ quantity: 1, product: product({ saintCode: "A-100" }) });

  it("las casillas empiezan plegadas detrás de «Qué copiar» (aria-expanded)", async () => {
    const { user } = setup([renglon()]);
    const boton = screen.getByRole("button", { name: /qué copiar/i });

    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();

    await user.click(boton);

    expect(boton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Código")).toBeChecked();
    // El chat no calcula Cashea: la casilla no se ofrece.
    expect(screen.queryByLabelText("Plan Cashea")).not.toBeInTheDocument();
  });

  it("desmarcar «Código» y copiar: el portapapeles no trae SKU", async () => {
    const { user } = setup([renglon()]);
    await user.click(screen.getByRole("button", { name: /qué copiar/i }));
    await user.click(screen.getByLabelText("Código"));
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: /^copiar$/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const texto = writeText.mock.calls[0][0];
    expect(texto).not.toContain("SKU:");
    expect(texto).toContain("Carburador PZ27");
  });

  it("desmarcar «Código» y enviar al chat: el texto entregado tampoco trae SKU", async () => {
    const { user, onSendToComposer } = setup([renglon()]);
    await user.click(screen.getByRole("button", { name: /qué copiar/i }));
    await user.click(screen.getByLabelText("Código"));

    await user.click(screen.getByRole("button", { name: /enviar al chat/i }));

    expect(onSendToComposer.mock.calls[0][0]).not.toContain("SKU:");
  });

  it("la elección se recuerda por asesor: se guarda en localStorage con su id", async () => {
    const { user } = setup([renglon()]);
    await user.click(screen.getByRole("button", { name: /qué copiar/i }));
    await user.click(screen.getByLabelText("Subtotal"));

    const guardado = Object.entries(window.localStorage).find(([clave]) => clave.endsWith("agent-1"));
    expect(guardado).toBeDefined();
    expect(JSON.parse(guardado![1]).subtotal).toBe(false);
  });

  it("desmarcar el total en bolívares quita esa línea del texto", async () => {
    const { user, onSendToComposer } = setup([renglon()]);
    await user.click(screen.getByRole("button", { name: /qué copiar/i }));
    await user.click(screen.getByLabelText("Total Bs"));

    await user.click(screen.getByRole("button", { name: /enviar al chat/i }));

    expect(onSendToComposer.mock.calls[0][0]).not.toContain("Total en bolívares");
  });

  it("con el carrito vacío no hay «Qué copiar»", () => {
    setup([]);

    expect(screen.queryByRole("button", { name: /qué copiar/i })).not.toBeInTheDocument();
  });
});

// 21/10/2026: guardar el carrito del chat como presupuesto del cliente.
describe("ConversationCartBlock — guardar presupuesto", () => {
  it("sin renglones no hay botón «Guardar presupuesto»", () => {
    setup([]);

    expect(screen.queryByRole("button", { name: /guardar presupuesto/i })).not.toBeInTheDocument();
  });

  it("abre el modal con el nombre del contacto separado en nombre y apellido", async () => {
    const { user } = setup([item()]);

    await user.click(screen.getByRole("button", { name: /guardar presupuesto/i }));

    expect(await screen.findByLabelText(/^Nombre/)).toHaveValue("María");
    expect(screen.getByLabelText(/^Apellido/)).toHaveValue("José Pérez");
    // Desde el chat siempre se crea uno nuevo: sin «Guardar cambios».
    expect(screen.queryByRole("button", { name: /guardar cambios/i })).not.toBeInTheDocument();
  });

  it("guarda con origen «chat», contacto, conversación, id null y el tipo de precio de cada renglón", async () => {
    const { user } = setup([
      item({ quantity: 2, priceKind: "promocion" }),
      item({
        id: "cart-2",
        productId: "prod-2",
        product: product({ id: "prod-2", name: "Kit de arrastre", price: 25, weightKg: 2, shippingFeeUsd: 2.5 }),
        quantity: 1,
        priceKind: "estandar",
      }),
    ]);
    await user.click(screen.getByRole("button", { name: /guardar presupuesto/i }));
    await screen.findByLabelText(/^Nombre/);
    fireEvent.change(screen.getByLabelText(/Nota/), { target: { value: "Paga el viernes" } });

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(guardarPresupuesto).toHaveBeenCalledTimes(1));
    expect(guardarPresupuesto).toHaveBeenCalledWith(
      { marca: "cliente" },
      {
        id: null,
        clienteNombre: "María",
        clienteApellido: "José Pérez",
        contactId: "contact-1",
        conversationId: "conv-1",
        origen: "chat",
        nota: "Paga el viernes",
        items: [
          { product_id: "prod-1", quantity: 2, price_kind: "promocion", precio_cotizado_usd: 20 },
          { product_id: "prod-2", quantity: 1, price_kind: "estandar", precio_cotizado_usd: 27.5 },
        ],
      }
    );
    const { toast } = await import("@heroui/react");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Presupuesto de María José Pérez guardado"));
  });

  it("sin nota manda nota null", async () => {
    const { user } = setup([item()]);
    await user.click(screen.getByRole("button", { name: /guardar presupuesto/i }));
    await screen.findByLabelText(/^Nombre/);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(guardarPresupuesto).toHaveBeenCalled());
    expect(guardarPresupuesto.mock.calls[0][1].nota).toBeNull();
  });

  it("tras guardar vuelve a leer los presupuestos del cliente", async () => {
    const { user } = setup([item()]);
    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /guardar presupuesto/i }));
    await screen.findByLabelText(/^Nombre/);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledTimes(2));
  });

  it("si guardar falla el modal sigue abierto con el motivo y no hay toast de éxito", async () => {
    guardarPresupuesto.mockRejectedValueOnce(new Error("No se pudo guardar por la red."));
    const { user } = setup([item()]);
    await user.click(screen.getByRole("button", { name: /guardar presupuesto/i }));
    await screen.findByLabelText(/^Nombre/);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("No se pudo guardar por la red.")).toBeInTheDocument();
    const { toast } = await import("@heroui/react");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("con un renglón sin precio (falta la tasa) guarda igual con precio cotizado null", async () => {
    const { user } = setup([item({ product: product({ currency: "VES", price: 101 }) })], makeActions(), 0);
    await user.click(screen.getByRole("button", { name: /guardar presupuesto/i }));
    await screen.findByLabelText(/^Nombre/);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(guardarPresupuesto).toHaveBeenCalled());
    expect(guardarPresupuesto.mock.calls[0][1].items[0].precio_cotizado_usd).toBeNull();
  });
});

describe("ConversationCartBlock — presupuestos del cliente", () => {
  it("monta los presupuestos del contacto aunque el carrito esté vacío", async () => {
    setup([]);

    await waitFor(() => expect(fetchPresupuestos).toHaveBeenCalledWith({ marca: "cliente" }, { contactId: "contact-1" }));
  });
});

describe("ConversationCartBlock — facturar en SAINT", () => {
  it("con renglones ofrece «Facturar en SAINT», el botón principal (primary)", () => {
    setup([item({ product: product({ saintCode: "A-100" }) })]);

    const boton = screen.getByRole("button", { name: /facturar en saint/i });
    expect(boton).toBeEnabled();
    expect(boton).toHaveClass("button--primary");
  });

  it("el último envío llega por props (el bloque ya no abre su propia suscripción)", () => {
    setup([item({ product: product({ saintCode: "A-100" }) })], makeActions(), 40, {
      ultimoEnvio: envio("creado"),
    });

    expect(screen.getByRole("status")).toHaveTextContent("En SAINT como FAC-77");
  });

  it("un producto sin código SAINT en el carrito bloquea el botón y lo dice", () => {
    setup([item({ product: product({ saintCode: null }) })]);

    expect(screen.getByRole("button", { name: /facturar en saint/i })).toBeDisabled();
    expect(screen.getByText("Sin código SAINT: Carburador PZ27.")).toBeInTheDocument();
  });

  it("precarga el modal con el contacto: cédula, nombre, apellido y teléfono", async () => {
    const { user } = setup([item({ product: product({ saintCode: "A-100" }) })]);

    await user.click(screen.getByRole("button", { name: /facturar en saint/i }));

    expect(await screen.findByLabelText("Cédula")).toHaveValue("12345678");
    expect(screen.getByLabelText("Tipo de cédula")).toHaveValue("V");
    expect(screen.getByLabelText("Nombre")).toHaveValue("María");
    expect(screen.getByLabelText("Apellido")).toHaveValue("José Pérez");
    expect(screen.getByLabelText("Teléfono (opcional)")).toHaveValue("04141234567");
  });

  it("con el carrito vacío no hay botón, pero un envío anterior sigue mostrando su estado", () => {
    setup([], makeActions(), 40, { ultimoEnvio: envio("creado") });

    expect(screen.queryByRole("button", { name: /facturar en saint/i })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("En SAINT como FAC-77");
    // Sin renglones tampoco hay indicador de pasos ni pie.
    expect(screen.queryByRole("list", { name: "Pasos de la venta" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("cart-total")).not.toBeInTheDocument();
  });

  it("con el carrito vacío y sin envíos no pinta nada de SAINT", () => {
    setup([]);

    expect(screen.queryByRole("button", { name: /facturar en saint/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

// 28/10/2026 (plan "Facturar en SAINT sale del fondo del panel", T3): el
// indicador de tres pasos. El estado va en TEXTO (oculto a la vista), no solo
// en color.
describe("ConversationCartBlock — pasos de la venta", () => {
  const renglonConCodigo = () => item({ product: product({ saintCode: "A-100" }) });

  function pasos() {
    const lista = screen.getByRole("list", { name: "Pasos de la venta" });
    return within(lista).getAllByRole("listitem");
  }

  it("son tres, en orden: Armar, En espera en SAINT, Cerrar", () => {
    setup([renglonConCodigo()]);

    const items = pasos();
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Armar");
    expect(items[1]).toHaveTextContent("En espera en SAINT");
    expect(items[2]).toHaveTextContent("Cerrar");
  });

  it("el indicador va arriba de los renglones", () => {
    setup([renglonConCodigo()]);

    const lista = screen.getByRole("list", { name: "Pasos de la venta" });
    const nombre = screen.getByText("Carburador PZ27");
    expect(lista.compareDocumentPosition(nombre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("con renglones y sin envío: Armar hecho, los otros dos pendientes", () => {
    setup([renglonConCodigo()]);

    const [armar, saint, cerrar] = pasos();
    expect(armar).toHaveTextContent(/Armar.*hecho/);
    expect(saint).toHaveTextContent(/En espera en SAINT.*pendiente/);
    expect(cerrar).toHaveTextContent(/Cerrar.*pendiente/);
  });

  it.each(["pendiente", "procesando"] as const)("con un envío %s el paso 2 está en curso, no hecho", (estado) => {
    setup([renglonConCodigo()], makeActions(), 40, { ultimoEnvio: envio(estado) });

    const [, saint] = pasos();
    expect(saint).toHaveTextContent(/En espera en SAINT.*en curso/);
    expect(saint).not.toHaveTextContent(/hecho/);
    expect(saint).toHaveAttribute("data-estado", "en_curso");
  });

  it("con el envío creado el paso 2 está hecho", () => {
    setup([renglonConCodigo()], makeActions(), 40, { ultimoEnvio: envio("creado") });

    const [, saint, cerrar] = pasos();
    expect(saint).toHaveTextContent(/En espera en SAINT.*hecho/);
    expect(cerrar).toHaveTextContent(/Cerrar.*pendiente/);
  });

  it("con el envío en error el paso 2 dice «con error»", () => {
    setup([renglonConCodigo()], makeActions(), 40, { ultimoEnvio: envio("error") });

    const [, saint] = pasos();
    expect(saint).toHaveTextContent(/En espera en SAINT.*con error/);
    expect(saint).toHaveAttribute("data-estado", "error");
  });

  it("con la venta cerrada el paso 3 está hecho", () => {
    setup([renglonConCodigo()], makeActions(), 40, { ultimoEnvio: envio("creado"), isDealWon: true });

    const [armar, saint, cerrar] = pasos();
    expect(armar).toHaveTextContent(/hecho/);
    expect(saint).toHaveTextContent(/hecho/);
    expect(cerrar).toHaveTextContent(/Cerrar.*hecho/);
  });
});

// 28/10/2026 (T3): el pie con el total, «Facturar en SAINT» y los tres atajos.
describe("ConversationCartBlock — el pie y los atajos", () => {
  const renglon = () => item({ quantity: 1, product: product({ saintCode: "A-100" }) });
  const TEXTO = [
    "Carburador PZ27",
    "SKU: A-100",
    "Precio: $20.00",
    "",
    "Total: $20.00",
    "Total en bolívares: Bs. 800,00",
  ].join("\n");

  it("el total vive en el pie, no en la lista de renglones, y no se repite", () => {
    setup([
      item({ quantity: 2 }),
      item({ id: "cart-2", productId: "prod-2", product: product({ id: "prod-2", name: "Kit", price: 5 }), quantity: 1 }),
    ]);

    const totales = screen.getAllByTestId("cart-total");
    expect(totales).toHaveLength(1);
    expect(totales[0].closest(".crm-pcart-foot")).not.toBeNull();
    expect(totales[0]).toHaveTextContent("$45.00");
    expect(totales[0]).toHaveTextContent("Bs. 1800.00");
  });

  it("el pie reúne el total, «Facturar en SAINT» y los atajos", () => {
    setup([renglon()]);

    const pie = screen.getByTestId("cart-total").closest(".crm-pcart-foot") as HTMLElement;
    expect(within(pie).getByRole("button", { name: /facturar en saint/i })).toBeInTheDocument();
    expect(within(pie).getByRole("button", { name: "Copiar" })).toBeInTheDocument();
    expect(within(pie).getByRole("button", { name: "Enviar al chat" })).toBeInTheDocument();
    expect(within(pie).getByRole("button", { name: "Guardar presupuesto" })).toBeInTheDocument();
  });

  it("los atajos muestran texto corto pero tienen nombre accesible completo", () => {
    setup([renglon()]);

    expect(screen.getByRole("button", { name: "Copiar" })).toHaveTextContent("Copiar");
    expect(screen.getByRole("button", { name: "Enviar al chat" })).toHaveTextContent("Al chat");
    expect(screen.getByRole("button", { name: "Guardar presupuesto" })).toHaveTextContent("Guardar");
  });

  it("«Copiar» copia el resumen exacto", async () => {
    const { user } = setup([renglon()]);
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: "Copiar" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEXTO));
  });

  it("«Al chat» entrega el resumen a onSendToComposer", async () => {
    const { user, onSendToComposer } = setup([renglon()]);

    await user.click(screen.getByRole("button", { name: "Enviar al chat" }));

    expect(onSendToComposer).toHaveBeenCalledWith(TEXTO);
  });

  it("«Guardar» abre el modal de guardar presupuesto", async () => {
    const { user } = setup([renglon()]);

    await user.click(screen.getByRole("button", { name: "Guardar presupuesto" }));

    expect(await screen.findByLabelText(/^Nombre/)).toHaveValue("María");
  });

  it("sin handler de composer «Al chat» queda deshabilitado", () => {
    setup([renglon()], makeActions(), 40, { sinComposer: true });

    expect(screen.getByRole("button", { name: "Enviar al chat" })).toBeDisabled();
  });
});

// 28/10/2026 (T3): «Qué copiar» como módulo desplegable con contador y vista previa.
describe("ConversationCartBlock — «Qué copiar» con vista previa", () => {
  const renglon = () => item({ quantity: 1, product: product({ saintCode: "A-100" }) });

  it("el contador «N de 7» sale de los datos y baja al desmarcar una casilla", async () => {
    const { user } = setup([renglon()]);
    const toggle = screen.getByRole("button", { name: /qué copiar/i });

    expect(toggle).toHaveTextContent("7 de 7");

    await user.click(toggle);
    await user.click(screen.getByLabelText("Código"));

    expect(toggle).toHaveTextContent("6 de 7");
  });

  it("está FUERA y DESPUÉS del pie, no pegado a él", () => {
    setup([renglon()]);

    const pie = screen.getByTestId("cart-total").closest(".crm-pcart-foot") as HTMLElement;
    const toggle = screen.getByRole("button", { name: /qué copiar/i });
    expect(pie.contains(toggle)).toBe(false);
    expect(pie.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("plegado no muestra la vista previa; abierto la muestra", async () => {
    const { user } = setup([renglon()]);

    expect(screen.queryByLabelText("Vista previa del texto")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /qué copiar/i }));

    expect(screen.getByLabelText("Vista previa del texto")).toBeInTheDocument();
  });

  it("la vista previa es EXACTAMENTE el texto que copia «Copiar»", async () => {
    const { user } = setup([renglon()]);
    await user.click(screen.getByRole("button", { name: /qué copiar/i }));
    await user.click(screen.getByLabelText("Código"));
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: "Copiar" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const vista = screen.getByLabelText("Vista previa del texto");
    expect(vista.textContent).toBe(writeText.mock.calls[0][0]);
    expect(vista.textContent).not.toContain("SKU:");
  });

  it("la vista previa cambia al marcar o desmarcar una casilla", async () => {
    const { user } = setup([renglon()]);
    await user.click(screen.getByRole("button", { name: /qué copiar/i }));
    expect(screen.getByLabelText("Vista previa del texto").textContent).toContain("Total en bolívares");

    await user.click(screen.getByLabelText("Total Bs"));

    expect(screen.getByLabelText("Vista previa del texto").textContent).not.toContain("Total en bolívares");
  });

  it("con un renglón sin precio la vista previa dice por qué no hay texto", async () => {
    const { user } = setup([item({ product: product({ currency: "VES", price: 101 }) })], makeActions(), 0);
    await user.click(screen.getByRole("button", { name: /qué copiar/i }));

    expect(screen.queryByLabelText("Vista previa del texto")).not.toBeInTheDocument();
    expect(screen.getByText(/no hay vista previa/i)).toHaveTextContent(/sin precio/i);
  });
});
