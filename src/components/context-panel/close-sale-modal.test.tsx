/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloseSaleModal } from "@/components/context-panel/close-sale-modal";
import type { Agent, Contact, ConversationQuote, Message, Product } from "@/lib/types";

const closeSaleWithContactInfo = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/mutations", () => ({
  closeSaleWithContactInfo: (...args: unknown[]) => closeSaleWithContactInfo(...args),
}));

const QUOTES: ConversationQuote[] = [
  {
    id: "q-1",
    productId: "prod-1",
    productName: "Carburador PZ27",
    priceUsd: 18,
    priceBs: 720,
    bcvRate: 40,
    quotedAt: "2026-08-21T12:00:00.000Z",
  },
  {
    id: "q-2",
    productId: "prod-2",
    productName: "Kit de arrastre",
    priceUsd: 32.5,
    priceBs: 1300,
    bcvRate: 40,
    quotedAt: "2026-08-21T11:00:00.000Z",
  },
];

const BUJIA: Product = {
  id: "prod-9",
  name: "Bujía CR7HSA",
  brand: "NGK",
  price: 3.25,
  currency: "USD",
  stockQuantity: 40,
  description: null,
  isActive: true,
  updatedAt: "2026-08-22T10:00:00.000Z",
  compatibility: [],
  weightKg: null,
};

const fetchConversationQuotes = vi.fn().mockResolvedValue(QUOTES);
const fetchLatestBcvRate = vi.fn().mockResolvedValue(40);
vi.mock("@/lib/data", () => ({
  fetchConversationQuotes: (...args: unknown[]) => fetchConversationQuotes(...args),
  fetchLatestBcvRate: (...args: unknown[]) => fetchLatestBcvRate(...args),
}));

const searchActiveProducts = vi.fn().mockResolvedValue([BUJIA]);
vi.mock("@/lib/inventory-data", () => ({
  searchActiveProducts: (...args: unknown[]) => searchActiveProducts(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({
    storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) },
  })),
}));

const CONTACT: Contact = {
  id: "contact-1",
  phoneNumber: "+58123456789",
  displayName: "Cliente Demo",
  profileName: "Cliente",
  avatarUrl: null,
  cedulaType: null,
  cedulaNumber: null,
  state: null,
  city: null,
  address: null,
  tags: [],
};

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José Riera",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

// T5, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
// D9-D11): desde esta corrida el comprobante también es obligatorio, y el
// modal solo ofrece elegir una foto del chat o subir un archivo —el camino
// más simple para un test es dar una foto entrante y elegirla.
const FOTO_COMPROBANTE: Message = {
  id: "msg-photo-1",
  conversationId: "conv-1",
  direction: "inbound",
  senderType: "customer",
  senderAgent: null,
  messageType: "image",
  content: null,
  templateName: null,
  mediaUrl: "https://example.com/comprobante.jpg",
  isInternalNote: false,
  whatsappStatus: null,
  whatsappError: null,
  whatsappErrorCode: null,
  reactionEmoji: null,
  replyToMessageId: null,
  payload: null,
  createdAt: "2026-09-19T12:00:00.000Z",
};

beforeEach(() => {
  closeSaleWithContactInfo.mockClear();
  fetchConversationQuotes.mockClear();
  fetchLatestBcvRate.mockClear();
  searchActiveProducts.mockClear();
});

function renderModal(messages: Message[] = [FOTO_COMPROBANTE], contact: Contact = CONTACT) {
  return render(
    <CloseSaleModal
      isOpen
      onOpenChange={() => {}}
      conversationId="conv-1"
      contact={contact}
      agent={AGENT}
      messages={messages}
    />
  );
}

/** Espera a que las cotizaciones del chat estén ofrecidas. */
async function waitForQuotes() {
  await waitFor(() => expect(screen.getByText("Carburador PZ27")).toBeInTheDocument());
}

function submitButton() {
  return screen.getByRole("button", { name: /guardar y cerrar venta/i });
}

/**
 * `userEvent.setup()` por defecto mete un `setTimeout(0)` (salto de
 * macrotarea) entre cada pulsación y hace `pointerEventsCheck` (que sube el
 * árbol con `getComputedStyle`) en cada click. Con la CPU contendida — varios
 * agentes corriendo en paralelo en esta máquina el 28/8/2026 — esos costos
 * multiplicados por decenas de interacciones revientan el timeout de la
 * prueba. Sin usuarios reales de por medio no hace falta simular el delay
 * entre teclas ni repetir el chequeo de puntero en cada click.
 */
function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

/** Con qué pagó el cliente: sin esto la venta no se puede cerrar. */
async function elegirMétodoDePago(user: ReturnType<typeof userEvent.setup>, valor = "pago_movil") {
  await user.selectOptions(screen.getByLabelText("Método de pago"), valor);
}

function itemsSentToClose() {
  return closeSaleWithContactInfo.mock.calls[0][5];
}

/**
 * Llena los OCHO campos obligatorios de D11 que este helper puede completar
 * de un tirón (todos salvo el carrito, que cada test arma con lo que
 * necesita probar): nombre, cédula, estado, ciudad, dirección, método de
 * pago, factura Saint y comprobante (elige la foto entrante que
 * `renderModal` ya deja disponible). El número de WhatsApp no se completa
 * porque es de solo lectura —sale de `contact.phoneNumber`, siempre
 * presente.
 */
async function completarDatosObligatorios(
  user: ReturnType<typeof userEvent.setup>,
  overrides: { displayName?: string; paymentMethod?: string; saintInvoiceNumber?: string } = {}
) {
  await user.type(screen.getByLabelText("Nombre"), overrides.displayName ?? "Cliente Demo");
  await user.type(screen.getByLabelText("Cédula"), "12345678");
  await user.selectOptions(screen.getByLabelText("Estado"), "Barinas");
  await user.type(screen.getByLabelText("Ciudad"), "Barinas");
  await user.type(screen.getByLabelText("Dirección"), "Calle Falsa 123");
  await elegirMétodoDePago(user, overrides.paymentMethod ?? "pago_movil");
  await user.type(screen.getByLabelText("Número de factura Saint"), overrides.saintInvoiceNumber ?? "00123");
  await user.click(screen.getByLabelText("Usar esta foto como comprobante"));
}

describe("CloseSaleModal — el asesor arma la venta, pero el precio lo pone el catálogo", () => {
  // D10 ("La voz cercana..."; en realidad D10 de este plan): el botón ya NO
  // se deshabilita por el estado del carrito o de los campos —solo mientras
  // se está guardando—, así que la regla se prueba clicando e
  // inspeccionando el resultado, no el atributo `disabled`.
  it("no llama a la mutación ni cierra el carrito vacío, y avisa del problema", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await completarDatosObligatorios(user);
    await user.click(submitButton());

    expect(closeSaleWithContactInfo).not.toHaveBeenCalled();
  });

  // La regla que sostiene todo el módulo: el monto de una venta nunca se
  // teclea, sale de un precio real del catálogo.
  it("no ofrece ningún campo para escribir el monto a mano", async () => {
    renderModal();
    await waitForQuotes();

    expect(screen.queryByLabelText(/monto/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/precio/i)).not.toBeInTheDocument();
  });

  it("cierra la venta con la cotización que el asesor tomó del chat", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await completarDatosObligatorios(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()).toEqual([
      {
        id: "q-1",
        origin: "quote",
        productId: "prod-1",
        description: "Carburador PZ27",
        unitPrice: 18,
        quantity: 1,
      },
    ]);
  });

  // Lo que faltaba: el cliente agrega algo al final que nunca pasó por el
  // chat, y antes eso obligaba a no cerrar la venta.
  it("deja agregar un repuesto del inventario que la IA nunca cotizó", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.type(screen.getByLabelText("Buscar repuesto en el inventario"), "bujía");
    await waitFor(() => expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument());
    await user.click(screen.getByText("Bujía CR7HSA"));

    await completarDatosObligatorios(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()).toEqual([
      {
        id: "prod-9",
        origin: "inventory",
        productId: "prod-9",
        description: "Bujía CR7HSA",
        unitPrice: 3.25,
        quantity: 1,
      },
    ]);
  });

  it("deja quitar un renglón que ya no lleva el cliente", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(screen.getByText("Kit de arrastre"));

    await user.click(screen.getByLabelText("Quitar Carburador PZ27 de la venta"));

    await completarDatosObligatorios(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    const items = itemsSentToClose();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "Kit de arrastre" });
  });

  it("deja subir la cantidad y el monto la sigue", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(screen.getByLabelText("Agregar una unidad de Carburador PZ27"));
    await user.click(screen.getByLabelText("Agregar una unidad de Carburador PZ27"));

    await completarDatosObligatorios(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()[0]).toMatchObject({ quantity: 3, unitPrice: 18 });
  });

  it("nunca baja de una unidad por más que se reste", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(screen.getByLabelText("Restar una unidad de Carburador PZ27"));
    await user.click(screen.getByLabelText("Restar una unidad de Carburador PZ27"));

    await completarDatosObligatorios(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()[0]).toMatchObject({ quantity: 1 });
  });

  // Antes la tasa salía de la primera cotización, así que una venta armada
  // solo con repuestos del inventario se guardaba con tasa 0 y el monto
  // dejaba de ser trazable.
  it("guarda la venta con la tasa del BCV vigente, aunque no haya cotizaciones", async () => {
    fetchConversationQuotes.mockResolvedValueOnce([]);
    const user = crearUsuario();
    renderModal();

    await user.type(screen.getByLabelText("Buscar repuesto en el inventario"), "bujía");
    await waitFor(() => expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument());
    await user.click(screen.getByText("Bujía CR7HSA"));

    await completarDatosObligatorios(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(closeSaleWithContactInfo.mock.calls[0][6]).toBe(40);
  });

  // El método de pago quedaba en el comprobante, es decir, en una imagen que
  // hay que abrir una por una para saber con qué pagó cada cliente.
  it("no llama a la mutación sin decir con qué se pagó, y muestra el error bajo el campo", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await user.type(screen.getByLabelText("Cédula"), "12345678");
    await user.selectOptions(screen.getByLabelText("Estado"), "Barinas");
    await user.type(screen.getByLabelText("Ciudad"), "Barinas");
    await user.type(screen.getByLabelText("Dirección"), "Calle Falsa 123");
    await user.type(screen.getByLabelText("Número de factura Saint"), "00123");
    await user.click(screen.getByLabelText("Usar esta foto como comprobante"));
    // Sin elegir método de pago.
    await user.click(submitButton());

    expect(closeSaleWithContactInfo).not.toHaveBeenCalled();
    // `role="alert"` no aporta nombre accesible por sí mismo (el rol no
    // deriva el nombre de su contenido, solo de `aria-label`/
    // `aria-labelledby`): se busca por el TEXTO y se confirma el rol aparte.
    const error = await screen.findByText(/elige con qué pagó/i);
    expect(error).toHaveAttribute("role", "alert");
  });

  it("sin factura Saint muestra el error bajo el campo y no llama a la mutación", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await user.type(screen.getByLabelText("Cédula"), "12345678");
    await user.selectOptions(screen.getByLabelText("Estado"), "Barinas");
    await user.type(screen.getByLabelText("Ciudad"), "Barinas");
    await user.type(screen.getByLabelText("Dirección"), "Calle Falsa 123");
    await elegirMétodoDePago(user);
    await user.click(screen.getByLabelText("Usar esta foto como comprobante"));
    // Sin escribir la factura Saint.
    await user.click(submitButton());

    expect(closeSaleWithContactInfo).not.toHaveBeenCalled();
    // "factura Saint" también aparece en la ETIQUETA del campo (que no
    // desaparece), así que se busca entre los `role="alert"` en vez de por
    // texto suelto, que sería ambiguo.
    const alertas = await screen.findAllByRole("alert");
    expect(alertas.some((el) => /factura saint/i.test(el.textContent ?? ""))).toBe(true);
  });

  it("sin comprobante muestra el error bajo el campo y no llama a la mutación", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await completarDatosObligatorios(user);
    // Vuelve a quitar el comprobante que el helper ya había elegido.
    await user.click(screen.getByLabelText("Quitar comprobante"));
    await user.click(submitButton());

    expect(closeSaleWithContactInfo).not.toHaveBeenCalled();
    // Mismo motivo que arriba: "comprobante" también está en la etiqueta del
    // campo, así que se busca entre los `role="alert"`.
    const alertas = await screen.findAllByRole("alert");
    expect(alertas.some((el) => /comprobante/i.test(el.textContent ?? ""))).toBe(true);
  });

  it("manda saintInvoiceNumber recortado, sin espacios de sobra", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await completarDatosObligatorios(user, { saintInvoiceNumber: "  00123  " });
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(closeSaleWithContactInfo.mock.calls[0][4]).toMatchObject({ saintInvoiceNumber: "00123" });
  });

  it("no elige un método por defecto: la mitad de las ventas quedarían mal registradas", async () => {
    renderModal();
    await waitForQuotes();

    expect(screen.getByLabelText("Método de pago")).toHaveValue("");
  });

  it("manda el método elegido junto con el resto de los datos del cliente", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await completarDatosObligatorios(user, { paymentMethod: "zelle" });
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(closeSaleWithContactInfo.mock.calls[0][4]).toMatchObject({ paymentMethod: "zelle" });
  });

  // Quien cierra tiene que ver a nombre de quién queda antes de confirmar,
  // pero no puede cambiarlo: sale de la sesión, no de un campo.
  it("muestra quién cierra la venta y no deja editarlo", async () => {
    renderModal();
    await waitForQuotes();

    const campo = screen.getByLabelText("Cierra la venta");
    expect(campo).toHaveValue(AGENT.displayName);
    expect(campo).toBeDisabled();
  });

  it("enfoca el primer campo inválido al intentar guardar sin llenar nada", async () => {
    // El nombre del contacto de fábrica (`CONTACT.displayName`) ya precarga
    // el campo "Nombre" con un valor válido, así que con ese contacto el
    // primer campo REALMENTE inválido es la cédula (nace vacía). Un
    // contacto sin nombre deja "Nombre" como el primero de verdad —el caso
    // más simple de leer para esta prueba.
    const contactoSinNombre: Contact = { ...CONTACT, displayName: null, profileName: null };
    const user = crearUsuario();
    renderModal([FOTO_COMPROBANTE], contactoSinNombre);
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByLabelText("Nombre")).toHaveFocus());
  });

  // Corrección R2 (revisión `code-review high`, 19/9/2026): hasta esta
  // corrección `errors` solo se recalculaba entero al intentar guardar, así
  // que un campo ya corregido conservaba su mensaje rojo hasta el próximo
  // intento — el asesor corregía el nombre y el error seguía ahí debajo
  // hasta volver a tocar "Guardar".
  it("corregir un campo borra su error sin tocar los demás", async () => {
    const contactoSinNombre: Contact = { ...CONTACT, displayName: null, profileName: null };
    const user = crearUsuario();
    renderModal([FOTO_COMPROBANTE], contactoSinNombre);
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    // Deja Nombre y Método de pago sin completar; llena el resto.
    await user.type(screen.getByLabelText("Cédula"), "12345678");
    await user.selectOptions(screen.getByLabelText("Estado"), "Barinas");
    await user.type(screen.getByLabelText("Ciudad"), "Barinas");
    await user.type(screen.getByLabelText("Dirección"), "Calle Falsa 123");
    await user.type(screen.getByLabelText("Número de factura Saint"), "00123");
    await user.click(screen.getByLabelText("Usar esta foto como comprobante"));
    await user.click(submitButton());

    // Dos errores a la vez: nombre y método de pago.
    await screen.findByText(/el nombre del cliente es obligatorio/i);
    await screen.findByText(/elige con qué pagó/i);

    // Corrige solo el nombre.
    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");

    await waitFor(() =>
      expect(screen.queryByText(/el nombre del cliente es obligatorio/i)).not.toBeInTheDocument()
    );
    // El error del campo que NO se tocó sigue ahí: no se revalidó todo.
    expect(screen.getByText(/elige con qué pagó/i)).toBeInTheDocument();
  });

  // Corrección R2, mismo motivo: el modal no se desmonta al cerrarse (sigue
  // vivo con `isOpen=false`), así que sin un reseteo explícito los errores
  // de un intento anterior le esperaban al asesor la próxima vez que abría
  // el mismo modal.
  it("reabrir el modal no arrastra errores de un intento anterior", async () => {
    const contactoSinNombre: Contact = { ...CONTACT, displayName: null, profileName: null };
    const user = crearUsuario();
    const { rerender } = renderModal([FOTO_COMPROBANTE], contactoSinNombre);
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(submitButton());
    await screen.findByText(/el nombre del cliente es obligatorio/i);

    const props = {
      onOpenChange: () => {},
      conversationId: "conv-1",
      contact: contactoSinNombre,
      agent: AGENT,
      messages: [FOTO_COMPROBANTE],
    };
    rerender(<CloseSaleModal isOpen={false} {...props} />);
    rerender(<CloseSaleModal isOpen {...props} />);

    expect(screen.queryByText(/el nombre del cliente es obligatorio/i)).not.toBeInTheDocument();
  });
});
