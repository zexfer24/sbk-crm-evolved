/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CasheaCalculadora } from "@/components/inventario/cashea-calculadora";
import { calcularCashea, mensajeWhatsApp, parseMontoInput } from "@/lib/cashea";
import type { Product } from "@/lib/types";

/**
 * Calculadora Cashea (12/10/2026, plan "Calculadora Cashea en el Inventario",
 * T2). La aritmética ya está probada en `cashea.test.ts`; acá se prueba lo que
 * el modal agrega: de dónde sale el monto, qué se ve al cambiar nivel/cuotas/
 * bajada, y que "Copiar" mande EXACTAMENTE el mensaje que arma `cashea.ts`.
 * HeroUI va real; solo `toast` se mockea.
 */

const successToast = vi.fn();
const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: { success: (...a: unknown[]) => successToast(...a), danger: (...a: unknown[]) => dangerToast(...a) },
  };
});

function producto(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Casco LS2 FF353",
    brand: null,
    price: 11800,
    currency: "VES",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-10-12T00:00:00.000Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    ...overrides,
  };
}

const writeText = vi.fn();

// `userEvent.setup()` instala su propio stub de `navigator.clipboard`; el
// del test se define DESPUÉS para que sea el que lee el componente.
function preparar(overrides: { product?: Product; bcvRate?: number } = {}) {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: (...a: unknown[]) => writeText(...a) },
    configurable: true,
  });
  const onOpenChange = vi.fn();
  const product = overrides.product ?? producto();
  render(
    <CasheaCalculadora
      product={product}
      bcvRate={overrides.bcvRate ?? 100}
      isOpen
      onOpenChange={onOpenChange}
    />,
  );
  return { user, onOpenChange, product };
}

const monto = () => screen.getByTestId("cashea-monto");
const inicial = () => screen.getByTestId("cashea-inicial");
const botonCuotas = (n: 3 | 6) => screen.getByRole("button", { name: `${n} cuotas` });
const copiar = () => screen.getByRole("button", { name: "Copiar" });
const campoManual = () => screen.getByLabelText("Monto manual ($)");
const AVISO_6 = "Con montos de $100 o menos solo está disponible el plan de 3 cuotas";

beforeEach(() => {
  successToast.mockReset();
  dangerToast.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
});

describe("CasheaCalculadora", () => {
  it("toma el monto del precio del producto: VES 11.800 a tasa 100 son $118,00", () => {
    preparar();

    expect(screen.getByText("Monto a financiar")).toBeTruthy();
    expect(monto().textContent).toBe("$118,00");
    expect(screen.getByText(/Precio unitario \$118,00 × 1/)).toBeTruthy();
  });

  it("con cantidad 2 el monto es precio × cantidad", async () => {
    const { user } = preparar();

    const cantidad = screen.getByLabelText("Cantidad");
    await user.clear(cantidad);
    await user.type(cantidad, "2");

    expect(monto().textContent).toBe("$236,00");
  });

  it("una cantidad que no es entero ≥ 1 calcula con 1", async () => {
    const { user } = preparar();

    const cantidad = screen.getByLabelText("Cantidad");
    await user.clear(cantidad);
    await user.type(cantidad, "0");

    expect(monto().textContent).toBe("$118,00");
  });

  it("con monto de $100 o menos, 6 cuotas queda deshabilitado y se explica", async () => {
    const { user } = preparar();
    expect(screen.queryByText(AVISO_6)).toBeNull();
    expect((botonCuotas(6) as HTMLButtonElement).disabled).toBe(false);

    await user.type(campoManual(), "85");

    expect(monto().textContent).toBe("$85,00");
    expect((botonCuotas(6) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(AVISO_6)).toBeTruthy();
  });

  it("si el asesor tenía 6 cuotas y el monto baja a $100, pasa a 3 y subir el monto NO vuelve a 6", async () => {
    const { user } = preparar();

    await user.click(botonCuotas(6));
    expect(botonCuotas(6).getAttribute("aria-pressed")).toBe("true");

    await user.type(campoManual(), "85");
    expect(botonCuotas(3).getAttribute("aria-pressed")).toBe("true");
    expect(botonCuotas(6).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(AVISO_6)).toBeTruthy();

    await user.clear(campoManual());
    expect(monto().textContent).toBe("$118,00");
    expect(botonCuotas(3).getAttribute("aria-pressed")).toBe("true");
    expect(botonCuotas(6).getAttribute("aria-pressed")).toBe("false");
  });

  it("la bajada de inicial cambia los porcentajes y deja la inicial del N6 en $0,00", async () => {
    const { user } = preparar();
    expect(screen.getByRole("radio", { name: "N6 · 20 %" })).toBeTruthy();
    expect(inicial().textContent).toContain("$23,60");

    await user.click(screen.getByRole("switch", { name: "Bajada de inicial" }));

    expect(screen.getByRole("radio", { name: "N6 · 0 %" })).toBeTruthy();
    expect(inicial().textContent).toContain("$0,00");
  });

  it("elegir un nivel marca su fila de la comparativa con aria-current", async () => {
    const { user } = preparar();
    const filaDe = (nivel: string) => screen.getByRole("cell", { name: nivel }).closest("tr")!;
    expect(filaDe("N6").getAttribute("aria-current")).toBe("true");

    await user.click(screen.getByRole("radio", { name: "N4 · 25 %" }));

    expect(filaDe("N4").getAttribute("aria-current")).toBe("true");
    expect(filaDe("N6").getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("radio", { name: "N4 · 25 %" }).getAttribute("aria-checked")).toBe("true");
  });

  it("el cronograma lista la inicial de hoy y una línea por cuota", async () => {
    const { user } = preparar();
    await user.click(botonCuotas(6));

    const items = within(screen.getByRole("list", { name: "Cronograma de pagos" })).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    expect(items[0].textContent).toBe("Hoy · Inicial · $23,60");
    expect(items[1].textContent).toMatch(/· Cuota 1 · \$15,73$/);
    // 94,40 / 6 = 15,7333…: la cuota base se trunca y la última absorbe el resto.
    expect(items[6].textContent).toMatch(/· Cuota 6 · \$15,75$/);
    expect(screen.getByText("Fechas de referencia; las fija Cashea.")).toBeTruthy();
  });

  it("Copiar manda exactamente el mensaje de cashea.ts y avisa", async () => {
    const { user, product } = preparar();
    const esperado = mensajeWhatsApp(
      calcularCashea({ montoCents: 11800, nivel: 6, cuotas: 3, bajada: false }),
      product.name,
    );
    expect((screen.getByLabelText("Mensaje para WhatsApp") as HTMLTextAreaElement).value).toBe(esperado);

    await user.click(copiar());

    await waitFor(() => expect(successToast).toHaveBeenCalledWith("Plan copiado"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(esperado);
  });

  it("si el portapapeles rechaza, avisa que no se pudo copiar", async () => {
    writeText.mockRejectedValue(new Error("denegado"));
    const { user } = preparar();

    await user.click(copiar());

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("No se pudo copiar"));
    expect(successToast).not.toHaveBeenCalled();
  });

  it("sin tasa BCV un producto en bolívares avisa, muestra $0,00 y no deja copiar; el monto manual lo destraba", async () => {
    const { user } = preparar({ bcvRate: 0 });

    expect(screen.getByText(/Sin tasa BCV/).getAttribute("role")).toBe("status");
    expect(monto().textContent).toBe("$0,00");
    expect((copiar() as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain("NaN");

    await user.type(campoManual(), "50");

    expect(monto().textContent).toBe("$50,00");
    expect((copiar() as HTMLButtonElement).disabled).toBe(false);
  });

  it("un producto en USD usa su precio tal cual, aunque no haya tasa", () => {
    preparar({ product: producto({ currency: "USD", price: 42.5 }), bcvRate: 0 });

    expect(monto().textContent).toBe("$42,50");
    expect(screen.queryByText(/Sin tasa BCV/)).toBeNull();
  });

  it("un monto manual mal escrito muestra el error y calcula con el precio del producto", async () => {
    const { user } = preparar();

    await user.type(campoManual(), "1.234");

    const esperado = parseMontoInput("1.234");
    expect(esperado.ok).toBe(false);
    expect(screen.getByText(esperado.ok ? "" : esperado.error)).toBeTruthy();
    expect(monto().textContent).toBe("$118,00");
  });

  it("'Usar precio del producto' solo aparece con monto manual y lo vacía", async () => {
    const { user } = preparar();
    expect(screen.queryByRole("button", { name: "Usar precio del producto" })).toBeNull();

    await user.type(campoManual(), "50");
    expect(monto().textContent).toBe("$50,00");
    await user.click(screen.getByRole("button", { name: "Usar precio del producto" }));

    expect((campoManual() as HTMLInputElement).value).toBe("");
    expect(monto().textContent).toBe("$118,00");
    expect(screen.queryByRole("button", { name: "Usar precio del producto" })).toBeNull();
  });

  it("al cerrar se reinicia todo: monto manual, cantidad, nivel y bajada", async () => {
    const { user, onOpenChange } = preparar();
    await user.type(campoManual(), "50");
    await user.click(screen.getByRole("radio", { name: "N2 · 50 %" }));
    await user.click(screen.getByRole("switch", { name: "Bajada de inicial" }));

    await user.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((campoManual() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("radio", { name: "N6 · 20 %" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Bajada de inicial" }).getAttribute("aria-checked")).toBe("false");
  });
});
