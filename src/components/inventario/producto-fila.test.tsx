/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@/lib/types";
import { ProductoFila } from "@/components/inventario/producto-fila";

/**
 * T4 del plan "Seis frentes del buzón" (8/9/2026): el campo "Peso (kg)"
 * replica exactamente el patrón de stock/precio que ya probaba esta fila
 * antes de que existiera este archivo — guarda al salir del campo, revierte
 * con un error, y muestra "Sin peso" cuando `weightKg` es null (el estado en
 * el que nace todo producto, hasta que alguien lo completa).
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const toastDanger = vi.fn();
vi.mock("@heroui/react", () => ({ toast: { danger: (...args: unknown[]) => toastDanger(...args) } }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

const fetchProduct = vi.fn();
vi.mock("@/lib/inventory-data", () => ({
  fetchProduct: (...args: unknown[]) => fetchProduct(...args),
}));

const updateProductWeight = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/mutations", () => ({
  updateProductWeight: (...args: unknown[]) => updateProductWeight(...args),
}));

// Calculadora Cashea (12/10/2026): el Modal real de HeroUI no existe en este
// archivo (`@heroui/react` está mockeado arriba), así que el test solo verifica
// que la fila abre el modal con el producto correcto, no lo que pinta adentro.
vi.mock("@/components/inventario/cashea-calculadora", () => ({
  CasheaCalculadora: ({ isOpen, product }: { isOpen: boolean; product: { name: string } }) =>
    isOpen ? <div role="dialog" aria-label={`Cashea ${product.name}`} /> : null,
}));

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Carburador PZ27",
    brand: "Bera",
    price: 25,
    currency: "USD",
    stockQuantity: 10,
    description: null,
    isActive: true,
    updatedAt: "2026-09-08T10:00:00Z",
    compatibility: [],
    weightKg: null,
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    ...over,
  };
}

function pesoInput() {
  return screen.getByLabelText("Peso de Carburador PZ27");
}

/** El botón del Precio estándar que manda a cargar el peso (T4, 13/10/2026). */
function faltaPeso() {
  return screen.getByRole("button", { name: /^Falta el peso: cargalo\s→$/ });
}

describe("ProductoFila — el campo Peso", () => {
  beforeEach(() => {
    refresh.mockClear();
    toastDanger.mockClear();
    updateProductWeight.mockClear();
    updateProductWeight.mockResolvedValue(undefined);
    fetchProduct.mockReset();
    fetchProduct.mockResolvedValue(null);
  });

  it("arranca vacío cuando el producto todavía no tiene peso cargado", () => {
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);
    expect(pesoInput()).toHaveValue("");
  });

  it("arranca con tres decimales cuando ya hay un peso guardado", () => {
    render(<ProductoFila product={product({ weightKg: 0.5 })} bcvRate={40} />);
    expect(pesoInput()).toHaveValue("0.500");
  });

  it("escribir con coma y salir del campo guarda el kilo tal cual", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);

    await user.clear(pesoInput());
    await user.type(pesoInput(), "0,250");
    await user.tab();

    await waitFor(() => expect(updateProductWeight).toHaveBeenCalledWith(expect.anything(), "prod-1", 0.25));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("un valor inválido no llama a la mutación: revierte el borrador y avisa", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: 1 })} bcvRate={40} />);

    await user.clear(pesoInput());
    await user.type(pesoInput(), "pesado");
    await user.tab();

    expect(updateProductWeight).not.toHaveBeenCalled();
    expect(toastDanger).toHaveBeenCalled();
    await waitFor(() => expect(pesoInput()).toHaveValue("1.000"));
  });

  it("si la mutación falla, revierte al valor anterior y avisa", async () => {
    updateProductWeight.mockRejectedValueOnce(new Error("caído"));
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: 1 })} bcvRate={40} />);

    await user.clear(pesoInput());
    await user.type(pesoInput(), "2");
    await user.tab();

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("No se pudo guardar el cambio."));
    await waitFor(() => expect(pesoInput()).toHaveValue("1.000"));
  });

  it("sin peso muestra el badge que explica por qué importa", () => {
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);
    expect(screen.getByText("Sin peso")).toBeInTheDocument();
  });

  it("un peso guardado en 0 cuenta como sin peso: badge y precio estándar dicen lo mismo", () => {
    render(<ProductoFila product={product({ weightKg: 0, shippingFeeUsd: null })} bcvRate={40} />);
    expect(screen.getByText("Sin peso")).toBeInTheDocument();
    expect(faltaPeso()).toBeInTheDocument();
  });

  it("con peso cargado no muestra el badge", () => {
    render(<ProductoFila product={product({ weightKg: 3 })} bcvRate={40} />);
    expect(screen.queryByText("Sin peso")).not.toBeInTheDocument();
  });
});

/**
 * T1 del plan "El precio se lee en bolívares" (19/9/2026): el precio deja de
 * editarse desde el CRM — llega de `products`, que se carga por fuera. Ya no
 * hay un textbox "Precio de …", solo texto: bolívares arriba (la cifra
 * principal, `priceDisplay`), dólares en el pie. Reemplaza al escenario
 * anterior (10/9/2026, T7) donde era al revés — USD arriba, "Bs. …" chico
 * SOLO en productos en dólares — y donde el campo todavía se guardaba con
 * `updateProductPrice` (borrada en esta misma corrida). El pie `.inv-bs`
 * sigue reservándose SIEMPRE (con o sin texto), mismo motivo de T7: si solo
 * aparece a veces, ese campo queda más alto y descuadra Stock/Peso (ver
 * `inventario-css.test.ts`, que mira la hoja de estilos porque jsdom no
 * calcula ese layout).
 */
describe("ProductoFila — el precio, de solo lectura", () => {
  it("ya no existe un textbox de Precio: es texto, no un input", () => {
    render(<ProductoFila product={product()} bcvRate={40} />);
    expect(screen.queryByRole("textbox", { name: /Precio (promoción )?de/ })).toBeNull();
  });

  it("USD con tasa: bolívares como cifra principal, dólares en el pie", () => {
    render(<ProductoFila product={product({ currency: "USD", price: 25 })} bcvRate={40} />);
    const precio = screen.getByLabelText("Precio promoción de Carburador PZ27");
    const pie = precio.closest(".inv-field")?.querySelector(".inv-bs");

    expect(precio).toHaveTextContent("Bs. 1000.00");
    expect(pie).toHaveTextContent("$ 25.00");
  });

  it("VES con tasa: bolívares como cifra principal, el equivalente en dólares en el pie", () => {
    render(<ProductoFila product={product({ currency: "VES", price: 1000 })} bcvRate={40} />);
    const precio = screen.getByLabelText("Precio promoción de Carburador PZ27");
    const pie = precio.closest(".inv-field")?.querySelector(".inv-bs");

    expect(precio).toHaveTextContent("Bs. 1000.00");
    expect(pie).toHaveTextContent("$ 25.00");
  });

  it("sin tasa no inventa el pie: la cifra principal queda en la moneda propia del producto", () => {
    render(<ProductoFila product={product({ currency: "USD", price: 25 })} bcvRate={0} />);
    const precio = screen.getByLabelText("Precio promoción de Carburador PZ27");
    const pie = precio.closest(".inv-field")?.querySelector(".inv-bs");

    expect(precio).toHaveTextContent("$ 25.00");
    expect(pie).not.toBeNull();
    expect(pie).toHaveTextContent("");
  });

  it("los campos Stock y Peso también llevan su pie, vacío", () => {
    render(<ProductoFila product={product()} bcvRate={40} />);
    const stockField = screen.getByLabelText("Stock de Carburador PZ27").closest(".inv-field");
    const pesoField = screen.getByLabelText("Peso de Carburador PZ27").closest(".inv-field");

    expect(stockField?.querySelector(".inv-bs")).not.toBeNull();
    expect(pesoField?.querySelector(".inv-bs")).not.toBeNull();
  });
});

/**
 * T3 del plan "El inventario llega de Saint y no se toca a mano" (25/9/2026):
 * Stock deja de editarse desde acá, mismo motivo y mismo patrón que el
 * precio el 19/9/2026 — `saint.sync_products()` es el único que escribe
 * `stock_quantity`. Reemplaza al escenario anterior ("Stock sigue
 * guardando", sumado el 19/9/2026 para dejar constancia de que el refactor
 * del precio no le tocaba el guardado a Stock/Peso): ahora es Stock el que
 * deja de guardarse.
 */
describe("ProductoFila — el stock, de solo lectura", () => {
  it("no hay un textbox de Stock: es texto, con el número tal cual llega de Saint", () => {
    render(<ProductoFila product={product({ stockQuantity: 14 })} bcvRate={40} />);

    expect(screen.queryByRole("textbox", { name: /Stock de/ })).toBeNull();
    expect(screen.getByLabelText("Stock de Carburador PZ27")).toHaveTextContent("14");
  });
});

/**
 * El botón Activar/Desactivar salió de la fila el 25/9/2026: `is_active` ya
 * no es una decisión que se tome desde el CRM, la escribe Saint. Que el
 * repuesto esté oculto a la IA se sigue viendo (badge "Oculto a la IA",
 * `aiVisibility`), pero ya no hay ninguna acción para cambiarlo acá.
 */
describe("ProductoFila — sin botón Activar/Desactivar", () => {
  it("no hay ningún botón para cambiar la visibilidad a mano", () => {
    render(<ProductoFila product={product({ isActive: true })} bcvRate={40} />);
    expect(screen.queryByRole("button", { name: /activar|desactivar/i })).toBeNull();
  });

  it("tampoco lo hay en un producto ya inactivo", () => {
    render(<ProductoFila product={product({ isActive: false })} bcvRate={40} />);
    expect(screen.queryByRole("button", { name: /activar|desactivar/i })).toBeNull();
  });
});

/**
 * Badge "Nuevo desde Saint" (T2/T3 del mismo plan, decisión del operador del
 * 24/9/2026: 7 días desde `saintAddedAt`). Se prueba con el reloj fijo —
 * `isNewFromSaint` usa `new Date()` por default, y un test que dependiera del
 * reloj real sería frágil (CLAUDE.md, "nunca un test que dependa del reloj
 * real").
 */
/**
 * T5 del plan "El mostrador busca sin salir del chat" (27/9/2026): el código
 * Saint ya viaja en `Product.saintCode` (`saint_code`, columna del 25/9/2026)
 * pero la fila no lo pintaba — los asesores y el dueño lo usan a diario para
 * ubicar el mismo repuesto en Saint. Va como una línea DEBAJO del nombre
 * (columna 1 de `.inv-row`, no una columna nueva) en fuente numérica
 * (`lm-num`), seleccionable para copiar. Sin código: texto "Sin código"
 * (decisión: más claro para un lector de pantalla que un "—" atenuado, que
 * puede leerse como "guion" o quedar mudo).
 */
/**
 * 30/10/2026: el operador pidió quitar la insignia «La IA lo ofrece». Un
 * producto visible con stock queda sin insignia de visibilidad; «Sin stock» y
 * «Oculto a la IA» siguen, porque avisan de algo.
 */
describe("ProductoFila — sin insignia «La IA lo ofrece»", () => {
  it("un producto activo con stock no la muestra", () => {
    render(<ProductoFila product={product({ stockQuantity: 10 })} bcvRate={40} />);
    expect(screen.queryByText("La IA lo ofrece")).toBeNull();
    expect(document.querySelector('.inv-status .ac-badge[data-tone="good"]')).toBeNull();
  });

  it("sin stock sigue mostrando «Sin stock»", () => {
    render(<ProductoFila product={product({ stockQuantity: 0 })} bcvRate={40} />);
    expect(screen.getByText("Sin stock")).toBeInTheDocument();
  });

  it("fuera de Saint sigue mostrando «Oculto a la IA»", () => {
    render(<ProductoFila product={product({ isActive: false })} bcvRate={40} />);
    expect(screen.getByText("Oculto a la IA")).toBeInTheDocument();
  });
});

describe("ProductoFila — código Saint", () => {
  it("pinta el código Saint en fuente numérica, con un aria-label que lo nombra", () => {
    render(<ProductoFila product={product({ saintCode: "8842" })} bcvRate={40} />);

    const codigo = screen.getByLabelText("Código 8842");
    expect(codigo).toHaveTextContent("8842");
    expect(codigo.className).toMatch(/\blm-num\b/);
  });

  it("es seleccionable para copiar: no vive dentro de un elemento que bloquee la selección", () => {
    render(<ProductoFila product={product({ saintCode: "8842" })} bcvRate={40} />);
    const codigo = screen.getByLabelText("Código 8842");
    expect(codigo.tagName).not.toBe("BUTTON");
  });

  it("sin código Saint muestra el marcador vacío 'Sin código'", () => {
    render(<ProductoFila product={product({ saintCode: null })} bcvRate={40} />);
    expect(screen.getByText("Sin código")).toBeInTheDocument();
  });
});

describe("ProductoFila — badge Nuevo desde Saint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("se muestra cuando el producto llegó de Saint hace 1 día", () => {
    render(<ProductoFila product={product({ saintAddedAt: "2026-09-24T12:00:00Z" })} bcvRate={40} />);
    expect(screen.getByText("Nuevo desde Saint")).toBeInTheDocument();
  });

  it("no se muestra sin fecha de ingreso a Saint", () => {
    render(<ProductoFila product={product({ saintAddedAt: null })} bcvRate={40} />);
    expect(screen.queryByText("Nuevo desde Saint")).not.toBeInTheDocument();
  });

  it("no se muestra pasados los 7 días", () => {
    render(<ProductoFila product={product({ saintAddedAt: "2026-09-17T12:00:00Z" })} bcvRate={40} />);
    expect(screen.queryByText("Nuevo desde Saint")).not.toBeInTheDocument();
  });
});

/**
 * Plan "Precio promoción y precio estándar (envío MRW)" (12/10/2026): la fila
 * muestra el precio de hoy como "Precio promoción" y, al lado, el "Precio
 * estándar" (promoción + envío MRW por peso). La tarifa la calcula la base
 * (`shippingFeeUsd`); acá solo se pinta, y nunca un número incompleto: sin
 * tarifa, un texto que dice por qué.
 */
describe("ProductoFila — precio promoción y precio estándar", () => {
  beforeEach(() => {
    refresh.mockClear();
    toastDanger.mockClear();
    updateProductWeight.mockReset();
    updateProductWeight.mockResolvedValue(undefined);
    fetchProduct.mockReset();
  });

  it("muestra los dos campos, Precio promoción y Precio estándar", () => {
    render(<ProductoFila product={product()} bcvRate={40} />);
    expect(screen.getByText("Precio promoción")).toBeInTheDocument();
    expect(screen.getByText("Precio estándar")).toBeInTheDocument();
  });

  it("con tarifa: precio estándar en Bs., dólares en el pie y la línea «incluye envío» (sin «MRW»)", () => {
    render(
      <ProductoFila
        product={product({ currency: "VES", price: 100, weightKg: 1, shippingFeeUsd: 1.4 })}
        bcvRate={100}
      />
    );
    const estandar = screen.getByLabelText("Precio estándar de Carburador PZ27");
    const campo = estandar.closest(".inv-field");

    expect(estandar).toHaveTextContent("Bs. 240.00");
    expect(campo?.querySelector(".inv-bs")).toHaveTextContent("$ 2.40");
    expect(campo?.querySelector(".inv-fee")).toHaveTextContent("incluye envío $ 1.40");
    // 30/10/2026: el pedido del cliente es que el pie nunca diga «MRW»; el monto va en su propio `lm-num`.
    expect(campo?.querySelector(".inv-fee")).not.toHaveTextContent(/MRW/);
    expect(campo?.querySelector(".inv-fee .lm-num")).toHaveTextContent("$ 1.40");
  });

  it("el campo nuevo no es un label: no hay input al que atarlo", () => {
    render(<ProductoFila product={product({ weightKg: 1, shippingFeeUsd: 1.4 })} bcvRate={40} />);
    const campo = screen.getByLabelText("Precio estándar de Carburador PZ27").closest(".inv-field");
    expect(campo?.tagName).toBe("DIV");
  });

  it("sin peso: pide cargar el peso y no inventa una cifra", () => {
    render(<ProductoFila product={product({ weightKg: null, shippingFeeUsd: null })} bcvRate={40} />);
    const campo = faltaPeso().closest(".inv-field");

    expect(faltaPeso()).toHaveClass("inv-falta-peso");
    expect(campo?.querySelector(".inv-bs")).not.toBeNull();
    expect(campo?.querySelector(".inv-fee")).toBeNull();
    expect(screen.queryByLabelText("Precio estándar de Carburador PZ27")).toBeNull();
  });

  it("95 kg sin tarifa: dice que está fuera de la tabla MRW", () => {
    render(<ProductoFila product={product({ weightKg: 95, shippingFeeUsd: null })} bcvRate={40} />);
    expect(screen.getByText("Más de 80 kg: fuera de la tabla MRW")).toHaveAttribute("data-empty", "true");
  });

  it("peso dentro de la tabla pero sin tarifa: dice que no hay tarifa para ese peso", () => {
    render(<ProductoFila product={product({ weightKg: 5, shippingFeeUsd: null })} bcvRate={40} />);
    expect(screen.getByText("Sin tarifa MRW para este peso")).toHaveAttribute("data-empty", "true");
  });

  it("el badge Sin peso explica que sin peso no hay precio estándar", () => {
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);
    expect(screen.getByText("Sin peso").closest(".ac-badge")).toHaveAttribute(
      "title",
      "Cashea exige el peso para el envío gratis, y sin peso no hay precio estándar"
    );
  });

  it("al guardar un peso, el precio estándar aparece sin que cambie el prop", async () => {
    fetchProduct.mockResolvedValue(product({ weightKg: 1, shippingFeeUsd: 1.4 }));
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: null, shippingFeeUsd: null })} bcvRate={40} />);

    expect(faltaPeso()).toBeInTheDocument();
    await user.type(pesoInput(), "1");
    await user.tab();

    await waitFor(() => expect(fetchProduct).toHaveBeenCalledWith(expect.anything(), "prod-1"));
    // 25 USD + 1.40 de envío = 26.40 USD = Bs. 1056.00 a tasa 40.
    expect(await screen.findByLabelText("Precio estándar de Carburador PZ27")).toHaveTextContent("Bs. 1056.00");
    expect(screen.queryByRole("button", { name: /^Falta el peso: cargalo\s→$/ })).toBeNull();
    // El badge sale del estado vivo, no del prop viejo.
    expect(screen.queryByText("Sin peso")).toBeNull();
  });

  it("si releer el producto falla, el peso SÍ se guardó: sin toast de error", async () => {
    fetchProduct.mockRejectedValue(new Error("caído"));
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: null, shippingFeeUsd: null })} bcvRate={40} />);

    await user.type(pesoInput(), "1");
    await user.tab();

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(updateProductWeight).toHaveBeenCalledWith(expect.anything(), "prod-1", 1);
    expect(toastDanger).not.toHaveBeenCalled();
    // No se revierte el borrador: el peso quedó guardado.
    expect(pesoInput()).toHaveValue("1");
  });

  it("si releer el producto falla, no pinta la tarifa del peso anterior", async () => {
    fetchProduct.mockRejectedValue(new Error("caído"));
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    // Peso 1 kg con su tarifa (1.40); se cambia a 9 kg y la relectura falla.
    const { container } = render(<ProductoFila product={product({ weightKg: 1, shippingFeeUsd: 1.4 })} bcvRate={40} />);
    expect(container.querySelector(".inv-fee")).toHaveTextContent("incluye envío $ 1.40");

    await user.clear(pesoInput());
    await user.type(pesoInput(), "9");
    await user.tab();

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(container.querySelector(".inv-fee")).toBeNull();
    expect(screen.queryByLabelText("Precio estándar de Carburador PZ27")).toBeNull();
  });

  it("cuando el prop cambia (router.refresh), la fila toma el producto nuevo", () => {
    const { rerender } = render(<ProductoFila product={product({ weightKg: null, shippingFeeUsd: null })} bcvRate={40} />);
    expect(faltaPeso()).toBeInTheDocument();

    rerender(<ProductoFila product={product({ weightKg: 1, shippingFeeUsd: 1.4 })} bcvRate={40} />);
    expect(screen.getByLabelText("Precio estándar de Carburador PZ27")).toHaveTextContent("Bs. 1056.00");
  });
});

/**
 * Botón "Cashea" (12/10/2026, plan "Calculadora Cashea en el Inventario", T3):
 * abre la calculadora de una cuenta, no de una venta, así que sale también
 * para un producto sin stock o inactivo.
 */
describe("ProductoFila — botón Cashea", () => {
  it("abre el modal de Cashea del producto al pulsarlo, y no hay diálogo antes", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product()} bcvRate={40} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" }));
    expect(screen.getByRole("dialog", { name: "Cashea Carburador PZ27" })).toBeInTheDocument();
  });

  it("el botón también existe en un producto inactivo y sin stock", () => {
    render(<ProductoFila product={product({ isActive: false, stockQuantity: 0 })} bcvRate={40} />);
    expect(screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" })).toBeInTheDocument();
  });
});

/**
 * T5, plan "Carrito de cotización en el Inventario, con Cashea" (12/10/2026):
 * fuera del provider la fila se renderiza igual que antes (tests y pantallas
 * viejas) — sin «Agregar». El botón «Cashea» no necesita el carrito.
 */
describe("ProductoFila — sin carrito", () => {
  it("sin provider no se muestra «Agregar», pero «Cashea» sigue ahí", () => {
    render(<ProductoFila product={product()} bcvRate={40} />);
    expect(screen.queryByRole("button", { name: /al carrito/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" })).toBeInTheDocument();
  });
});

/**
 * T4 del plan "Inventario y caja" (13/10/2026): el Precio estándar vacío por
 * falta de peso era un texto atenuado en cursiva que nadie leía como una tarea
 * pendiente. Ahora, para quien puede editar, es un botón que lleva el foco al
 * campo de peso de ESA fila; para quien no puede (caja) es un dato: «Sin peso
 * cargado».
 */
describe("ProductoFila — «Falta el peso» lleva al campo de peso", () => {
  it("al pulsarlo enfoca (y selecciona) el input de peso de ESA fila, no el de otra", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <ul>
        <ProductoFila product={product({ id: "a", name: "Carburador PZ27", weightKg: null })} bcvRate={40} />
        <ProductoFila product={product({ id: "b", name: "Bujía NGK", weightKg: null })} bcvRate={40} />
      </ul>
    );

    const botones = screen.getAllByRole("button", { name: /^Falta el peso: cargalo\s→$/ });
    expect(botones).toHaveLength(2);

    await user.click(botones[1]);
    expect(screen.getByLabelText("Peso de Bujía NGK")).toHaveFocus();
    expect(screen.getByLabelText("Peso de Carburador PZ27")).not.toHaveFocus();
  });

  it("los otros motivos (fuera de la tabla, sin tarifa) siguen siendo texto, no botón", () => {
    render(<ProductoFila product={product({ weightKg: 95, shippingFeeUsd: null })} bcvRate={40} />);
    expect(screen.queryByRole("button", { name: /^Falta el peso: cargalo\s→$/ })).toBeNull();
    expect(screen.getByText("Más de 80 kg: fuera de la tabla MRW")).toBeInTheDocument();
  });
});

describe("ProductoFila — solo lectura (rol caja)", () => {
  it("el peso es texto: sin input, con el valor formateado", () => {
    render(<ProductoFila product={product({ weightKg: 0.5 })} bcvRate={40} soloLectura />);

    expect(screen.queryByRole("textbox")).toBeNull();
    const campo = screen.getByText("Peso (kg)").closest(".inv-field");
    expect(campo).toHaveTextContent("0.500");
    expect(campo?.querySelector(".inv-readonly")).not.toBeNull();
    // Mismo pie vacío que los demás campos: la fila no cambia de alto (trampa del 10/9/2026).
    expect(campo?.querySelector(".inv-bs")).not.toBeNull();
  });

  it("sin peso cargado muestra «—» en el campo", () => {
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} soloLectura />);
    expect(screen.getByText("Peso (kg)").closest(".inv-field")).toHaveTextContent("—");
  });

  it("sin peso, la caja no ve ni el botón de peso ni el hueco del precio estándar", () => {
    render(<ProductoFila product={product({ weightKg: null, shippingFeeUsd: null })} bcvRate={40} soloLectura />);

    expect(screen.queryByRole("button", { name: /^Falta el peso: cargalo\s→$/ })).toBeNull();
    expect(screen.queryByText("Sin peso cargado")).toBeNull();
    expect(screen.queryByText(/Precio estándar/)).toBeNull();
  });

  it("con tarifa MRW cargada, la caja ve solo el precio promoción: ni columna estándar ni «incluye envío»", () => {
    const { container } = render(
      <ProductoFila product={product({ weightKg: 1, shippingFeeUsd: 1.4 })} bcvRate={40} soloLectura />
    );

    expect(screen.getByText("Precio promoción")).toBeInTheDocument();
    expect(screen.queryByText("Precio estándar")).toBeNull();
    expect(screen.queryByText(/incluye envío/)).toBeNull();
    expect(screen.queryByLabelText(/Precio estándar de/)).toBeNull();
    expect(container.innerHTML).not.toMatch(/est[aá]ndar/i);
    // Quedan los cuatro campos de la fila de caja: Stock, Precio promoción,
    // Precio divisa (30/10/2026, la caja sí lo ve) y Peso.
    expect(container.querySelectorAll(".inv-field")).toHaveLength(4);
    expect(container.querySelector(".inv-row")).toHaveAttribute("data-solo-lectura", "true");
  });

  it("el título del badge «Sin peso» no nombra el precio estándar para la caja, pero sí para los demás roles", () => {
    const { rerender } = render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} soloLectura />);
    const titleCaja = screen.getByText("Sin peso").closest(".ac-badge")?.getAttribute("title") ?? "";
    expect(titleCaja).toBe("Cashea exige el peso para el envío gratis");
    expect(titleCaja).not.toMatch(/est[aá]ndar/i);

    rerender(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);
    expect(screen.getByText("Sin peso").closest(".ac-badge")).toHaveAttribute(
      "title",
      "Cashea exige el peso para el envío gratis, y sin peso no hay precio estándar"
    );
  });

  it("nunca guarda: ni tabulando por la fila", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    updateProductWeight.mockClear();
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} soloLectura />);

    await user.tab();
    await user.tab();
    expect(updateProductWeight).not.toHaveBeenCalled();
  });

  it("«Nuevo desde Saint» deja de pedir que se cargue el peso", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    try {
      render(
        <ProductoFila product={product({ saintAddedAt: "2026-09-24T12:00:00Z" })} bcvRate={40} soloLectura />
      );
      const title = screen.getByText("Nuevo desde Saint").closest(".ac-badge")?.getAttribute("title") ?? "";
      expect(title).toMatch(/Entró desde Saint/);
      expect(title).not.toMatch(/peso/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cashea sigue disponible", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product()} bcvRate={40} soloLectura />);

    await user.click(screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" }));
    expect(screen.getByRole("dialog", { name: "Cashea Carburador PZ27" })).toBeInTheDocument();
  });

  it("la insignia informativa «Sin peso» se queda", () => {
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} soloLectura />);
    expect(screen.getByText("Sin peso")).toBeInTheDocument();
  });
});

describe("ProductoFila — los dos botones de ícono viven en el bloque de acciones", () => {
  it("«Cashea» es un botón de ícono con el logo, dentro de .inv-acciones, último hijo de la fila", () => {
    const { container } = render(<ProductoFila product={product()} bcvRate={40} />);

    const boton = screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" });
    const acciones = container.querySelector(".inv-acciones");
    expect(acciones).not.toBeNull();
    expect(acciones).toContainElement(boton as HTMLElement);
    // 30/10/2026: ya no es una píldora con texto sino un botón de ícono (el logo amarillo de Cashea).
    expect(boton).toHaveClass("inv-icon-btn");
    expect(boton).toHaveAttribute("data-tipo", "cashea");
    expect(boton).toHaveAttribute("title", "Calcular Cashea");
    expect(boton).not.toHaveTextContent("Cashea");
    expect(boton.querySelector("svg rect")).toHaveAttribute("fill", "#FFF83D");
    // La columna `.inv-status` desapareció: las insignias bajaron bajo el nombre.
    expect(container.querySelector(".inv-status")).toBeNull();
    expect(container.querySelector("li")?.lastElementChild).toBe(acciones);
  });
});

/**
 * 30/10/2026 (plan «Cada repuesto con su foto», T5a): la fila pierde la columna
 * de estado y el texto de compatibilidad, gana la foto de 72 px y el nombre
 * como botones que abren la ficha, y las insignias bajan bajo el nombre.
 */
describe("ProductoFila — identidad: foto, nombre e insignias", () => {
  function conFoto(over: Partial<Product> = {}) {
    return product({
      fotos: [
        { id: "f1", storagePath: "prod-1/f1.jpg", url: "https://cdn.test/prod-1/f1.jpg", isPrimary: true, position: 0 },
        { id: "f2", storagePath: "prod-1/f2.jpg", url: "https://cdn.test/prod-1/f2.jpg", isPrimary: false, position: 1 },
      ],
      ...over,
    });
  }

  it("ya no pinta el texto de compatibilidad ni la insignia «La IA lo ofrece»", () => {
    const { container } = render(
      <ProductoFila product={product({ compatibility: [{ id: "c1", motoBrand: "Bera", motoModel: "SBR" }] })} bcvRate={40} />
    );

    expect(screen.queryByText("Sin compatibilidad declarada")).toBeNull();
    expect(screen.queryByText(/Bera SBR/)).toBeNull();
    expect(screen.queryByText("La IA lo ofrece")).toBeNull();
    expect(container.querySelector(".inv-compat")).toBeNull();
  });

  it("sin compatibilidad declarada tampoco dice nada", () => {
    render(<ProductoFila product={product({ compatibility: [] })} bcvRate={40} />);
    expect(screen.queryByText("Sin compatibilidad declarada")).toBeNull();
  });

  it("las insignias salen BAJO el nombre, dentro de .inv-identity, con las mismas condiciones y title de siempre", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    try {
      const { container } = render(
        <ProductoFila
          product={product({ stockQuantity: 0, weightKg: null, saintAddedAt: "2026-09-24T12:00:00Z" })}
          bcvRate={40}
        />
      );
      const identidad = container.querySelector(".inv-identity") as HTMLElement;

      const sinStock = within(identidad).getByText("Sin stock").closest(".ac-badge");
      expect(sinStock).toHaveAttribute("data-tone", "wait");
      expect(sinStock).toHaveAttribute("title", "Sin stock: la IA lo sigue cotizando e informa 0 disponibles.");
      expect(within(identidad).getByText("Sin peso").closest(".ac-badge")).toHaveAttribute("data-tone", "wait");
      expect(within(identidad).getByText("Nuevo desde Saint").closest(".ac-badge")).toHaveAttribute("data-tone", "link");
      expect(identidad.querySelector(".inv-badges")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("un repuesto fuera de Saint dice «Oculto a la IA» (muted) y no «Sin stock»", () => {
    const { container } = render(<ProductoFila product={product({ isActive: false, stockQuantity: 0 })} bcvRate={40} />);
    const identidad = container.querySelector(".inv-identity") as HTMLElement;

    const oculto = within(identidad).getByText("Oculto a la IA").closest(".ac-badge");
    expect(oculto).toHaveAttribute("data-tone", "muted");
    expect(oculto).toHaveAttribute("title", "Ya no está en Saint: la IA no lo ofrece ni lo cotiza.");
    expect(screen.queryByText("Sin stock")).toBeNull();
  });

  it("con stock y peso no hay ninguna insignia", () => {
    const { container } = render(<ProductoFila product={product({ weightKg: 2 })} bcvRate={40} />);
    expect(container.querySelector(".inv-badges")).toBeNull();
    expect(container.querySelector(".ac-badge")).toBeNull();
  });

  it("con foto, el botón de la miniatura dice «Ver fotos de …», muestra la principal y cuenta las fotos", () => {
    const { container } = render(<ProductoFila product={conFoto()} bcvRate={40} puedeEditarFotos />);

    const foto = screen.getByRole("button", { name: "Ver fotos de Carburador PZ27" });
    expect(foto).toHaveClass("foto-thumb");
    expect(foto.querySelector("img")).toHaveAttribute("src", "https://cdn.test/prod-1/f1.jpg");
    expect(foto).toHaveTextContent("2");
    expect(container.querySelector(".foto-thumb[data-vacia]")).toBeNull();
  });

  it("sin foto: con permiso dice «Agregar foto a …»; sin permiso, «Ver ficha de …»", () => {
    const { unmount } = render(<ProductoFila product={product()} bcvRate={40} puedeEditarFotos />);
    expect(screen.getByRole("button", { name: "Agregar foto a Carburador PZ27" })).toHaveAttribute("data-vacia", "true");
    unmount();

    render(<ProductoFila product={product()} bcvRate={40} />);
    expect(screen.queryByRole("button", { name: "Agregar foto a Carburador PZ27" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ver ficha de Carburador PZ27" })).toHaveAttribute("data-vacia", "true");
  });

  it("tocar la foto y tocar el nombre abren la ficha de ESE repuesto", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onAbrirFicha = vi.fn();
    render(<ProductoFila product={conFoto()} bcvRate={40} onAbrirFicha={onAbrirFicha} />);

    await user.click(screen.getByRole("button", { name: "Ver fotos de Carburador PZ27" }));
    expect(onAbrirFicha).toHaveBeenLastCalledWith("prod-1");

    onAbrirFicha.mockClear();
    await user.click(screen.getByRole("button", { name: "Carburador PZ27" }));
    expect(onAbrirFicha).toHaveBeenCalledTimes(1);
    expect(onAbrirFicha).toHaveBeenCalledWith("prod-1");
  });
});

/** El semáforo del stock (umbral de bajo stock en 5, 30/10/2026), con literales y no con el símbolo (trampa del 20/9). */
describe("ProductoFila — el color del stock", () => {
  it.each([
    [0, "agotado"],
    [1, "bajo"],
    [3, "bajo"],
    [5, "bajo"],
    [6, "disponible"],
    [40, "disponible"],
  ])("con %i unidades la caja del stock es «%s»", (stockQuantity, nivel) => {
    render(<ProductoFila product={product({ stockQuantity })} bcvRate={40} />);

    const caja = screen.getByLabelText("Stock de Carburador PZ27").closest(".inv-input-wrap");
    expect(caja).toHaveAttribute("data-level", nivel);
  });

  it("solo la caja del stock lleva data-level", () => {
    const { container } = render(<ProductoFila product={product()} bcvRate={40} />);
    expect(container.querySelectorAll("[data-level]")).toHaveLength(1);
  });
});

// 30/10/2026 (plan "Precio divisa desde SAINT"): el Precio1 de SAINT (USD) va entre
// promoción y estándar, solo informativo.
describe("ProductoFila — el Precio divisa", () => {
  it("las etiquetas salen en el orden Precio promoción, Precio divisa, Precio estándar", () => {
    render(<ProductoFila product={product({ precioDivisaUsd: 12.35 })} bcvRate={40} />);
    const textos = Array.from(document.querySelectorAll(".lm-eyebrow")).map((e) => e.textContent);
    const promo = textos.indexOf("Precio promoción");
    const divisa = textos.indexOf("Precio divisa");
    const estandar = textos.indexOf("Precio estándar");
    expect(promo).toBeGreaterThanOrEqual(0);
    expect(divisa).toBe(promo + 1);
    expect(estandar).toBe(divisa + 1);
  });

  it("con precio muestra '$ 12.35' con su aria-label", () => {
    render(<ProductoFila product={product({ precioDivisaUsd: 12.35 })} bcvRate={40} />);
    expect(screen.getByLabelText("Precio divisa de Carburador PZ27")).toHaveTextContent("$ 12.35");
  });

  it("sin dato (null) dice 'Sin precio en SAINT'", () => {
    render(<ProductoFila product={product({ precioDivisaUsd: null })} bcvRate={40} />);
    expect(screen.getByText("Sin precio en SAINT")).toBeInTheDocument();
    expect(screen.queryByLabelText("Precio divisa de Carburador PZ27")).not.toBeInTheDocument();
  });

  it("un 0 no es un precio: dice 'Sin precio en SAINT' y nunca '$ 0.00'", () => {
    render(<ProductoFila product={product({ precioDivisaUsd: 0 })} bcvRate={40} />);
    expect(screen.getByText("Sin precio en SAINT")).toBeInTheDocument();
    expect(screen.queryByText("$ 0.00")).not.toBeInTheDocument();
  });

  it("la caja (soloLectura) ve el Precio divisa pero NO el Precio estándar", () => {
    render(<ProductoFila product={product({ precioDivisaUsd: 12.35 })} bcvRate={40} soloLectura />);
    expect(screen.getByText("Precio divisa")).toBeInTheDocument();
    expect(screen.getByLabelText("Precio divisa de Carburador PZ27")).toHaveTextContent("$ 12.35");
    expect(screen.queryByText("Precio estándar")).not.toBeInTheDocument();
  });
});
