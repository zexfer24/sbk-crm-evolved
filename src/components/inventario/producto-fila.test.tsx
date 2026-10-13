/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
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

  it("con tarifa: precio estándar en Bs., dólares en el pie y la línea del envío MRW", () => {
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
    expect(campo?.querySelector(".inv-fee")).toHaveTextContent("incluye envío MRW $ 1.40");
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
    render(<ProductoFila product={product({ weightKg: 1, shippingFeeUsd: 1.4 })} bcvRate={40} />);
    expect(screen.getByText("incluye envío MRW $ 1.40")).toBeInTheDocument();

    await user.clear(pesoInput());
    await user.type(pesoInput(), "9");
    await user.tab();

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText("incluye envío MRW $ 1.40")).toBeNull();
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

  it("en lugar del botón, el Precio estándar dice «Sin peso cargado» como dato", () => {
    render(<ProductoFila product={product({ weightKg: null, shippingFeeUsd: null })} bcvRate={40} soloLectura />);

    expect(screen.queryByRole("button", { name: /^Falta el peso: cargalo\s→$/ })).toBeNull();
    expect(screen.getByText("Sin peso cargado")).toHaveAttribute("data-empty", "true");
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

describe("ProductoFila — Cashea vive en el bloque de acciones, no entre las insignias", () => {
  it("«Cashea» es un botón con ícono dentro de .inv-acciones, último hijo de la fila", () => {
    const { container } = render(<ProductoFila product={product()} bcvRate={40} />);

    const boton = screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" });
    const acciones = container.querySelector(".inv-acciones");
    expect(acciones).not.toBeNull();
    expect(acciones).toContainElement(boton as HTMLElement);
    expect(boton).toHaveTextContent("Cashea");
    expect(boton).toHaveClass("crm-pill", "inv-accion-btn");
    expect(boton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".inv-status")).not.toContainElement(boton);
    expect(container.querySelector("li")?.lastElementChild).toBe(acciones);
  });
});
