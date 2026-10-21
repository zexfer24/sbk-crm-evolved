/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ELECCION_CASHEA_INICIAL,
  calcularCashea,
  formatBs,
  mensajeWhatsApp,
} from "@/lib/cashea";
import { CalculadoraMostrador, CLAVE_MONEDA_PREFIX } from "@/components/inventario/calculadora-mostrador";

/**
 * Calculadora fija del mostrador (21/10/2026, plan "Presupuestos y mensajes
 * rápidos", T5, D6): monto en Bs ÷ tasa BCV (o en $) más el plan Cashea. Las
 * cifras de Bs a $ salen de `usdFromBs` (hacia arriba al décimo); aquí se
 * fijan con valores exactos, no recalculando con la misma función.
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

const AGENTE = "agente-1";

function usuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function pintar(props: Partial<{ bcvRate: number; totalCarritoUsd: number | null }> = {}) {
  return render(
    <CalculadoraMostrador
      bcvRate={props.bcvRate ?? 215.4}
      totalCarritoUsd={props.totalCarritoUsd ?? null}
      agentId={AGENTE}
    />,
  );
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastDanger.mockClear();
});

describe("CalculadoraMostrador — de bolívares a dólares", () => {
  it("abre en Bs: 18524,40 Bs con tasa 215,40 son $86,00", async () => {
    const user = usuario();
    pintar();

    expect(screen.getByRole("button", { name: "Bs" })).toHaveAttribute("aria-pressed", "true");
    await user.type(screen.getByRole("textbox", { name: "Monto en bolívares" }), "18524,40");

    expect(screen.getByTestId("calc-resultado")).toHaveTextContent("$86,00");
    expect(screen.getByText(/÷ tasa BCV de hoy \(215\.40\)/)).toBeInTheDocument();
  });

  it("acepta el monto como se escribe en Venezuela: 18.524,40 con tasa 215,40 son $86,00", async () => {
    const user = usuario();
    pintar();

    const campo = screen.getByRole("textbox", { name: "Monto en bolívares" });
    expect(campo).toHaveAttribute("placeholder", "Ej. 18.524,40");
    await user.type(campo, "18.524,40");

    expect(screen.queryByText(/Escribe un monto/)).toBeNull();
    expect(screen.getByTestId("calc-resultado")).toHaveTextContent("$86,00");
  });

  it("redondea hacia arriba al décimo (usdFromBs): 100 Bs con tasa 40,3 son $2,50, no $2,48", async () => {
    const user = usuario();
    pintar({ bcvRate: 40.3 });

    await user.type(screen.getByRole("textbox", { name: "Monto en bolívares" }), "100");

    expect(screen.getByTestId("calc-resultado")).toHaveTextContent("$2,50");
  });

  it("el redondeo nunca se menciona en la pantalla", () => {
    const { container } = pintar();
    expect(container.textContent ?? "").not.toMatch(/redonde/i);
  });

  it("un monto mal escrito muestra el error bajo el campo, hablando de bolívares", async () => {
    const user = usuario();
    pintar();

    await user.type(screen.getByRole("textbox", { name: "Monto en bolívares" }), "abc");

    expect(
      screen.getByText("Escribe un monto en bolívares, por ejemplo 18.524,40."),
    ).toBeInTheDocument();
  });
});

describe("CalculadoraMostrador — de dólares a bolívares", () => {
  it("el interruptor pasa a $: el campo cambia de nombre y el resultado sale en Bs", async () => {
    const user = usuario();
    pintar();

    await user.click(screen.getByRole("button", { name: "$" }));
    expect(screen.getByRole("button", { name: "$" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bs" })).toHaveAttribute("aria-pressed", "false");

    await user.type(screen.getByRole("textbox", { name: "Monto en dólares" }), "86");

    expect(screen.getByTestId("calc-resultado")).toHaveTextContent(formatBs(18524.4));
    expect(screen.getByText(/× tasa BCV de hoy \(215\.40\)/)).toBeInTheDocument();
  });

  it("recuerda la moneda elegida por asesor", async () => {
    const user = usuario();
    const primera = pintar();

    await user.click(screen.getByRole("button", { name: "$" }));
    expect(window.localStorage.getItem(`${CLAVE_MONEDA_PREFIX}${AGENTE}`)).toBe("usd");
    primera.unmount();

    pintar();
    expect(screen.getByRole("button", { name: "$" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("CalculadoraMostrador — sin tasa BCV", () => {
  it("Bs queda deshabilitado, arranca en $ y avisa", async () => {
    const user = usuario();
    pintar({ bcvRate: 0 });

    expect(screen.getByRole("button", { name: "Bs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "$" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Sin tasa BCV de hoy: escribe el monto en dólares")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Monto en dólares" }), "50");
    // Sin tasa no hay bolívares que mostrar, pero el plan Cashea sí.
    expect(screen.getByTestId("calc-resultado")).not.toHaveTextContent("Bs.");
    expect(screen.getByTestId("cashea-inicial")).toBeInTheDocument();
  });

  it("una moneda «Bs» recordada no se respeta si hoy no hay tasa", () => {
    window.localStorage.setItem(`${CLAVE_MONEDA_PREFIX}${AGENTE}`, "bs");
    pintar({ bcvRate: 0 });

    expect(screen.getByRole("button", { name: "$" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("CalculadoraMostrador — «Usar total del carrito»", () => {
  it("con total, pasa a $ y escribe el monto", async () => {
    const user = usuario();
    pintar({ totalCarritoUsd: 120.5 });

    await user.click(screen.getByRole("button", { name: "Usar total del carrito" }));

    expect(screen.getByRole("button", { name: "$" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Monto en dólares" })).toHaveValue("120.50");
  });

  it("sin total (null o 0) el botón no existe", () => {
    const { unmount } = pintar({ totalCarritoUsd: null });
    expect(screen.queryByRole("button", { name: "Usar total del carrito" })).toBeNull();
    unmount();

    pintar({ totalCarritoUsd: 0 });
    expect(screen.queryByRole("button", { name: "Usar total del carrito" })).toBeNull();
  });
});

describe("CalculadoraMostrador — Cashea", () => {
  it("sin monto no hay controles de Cashea", () => {
    pintar();
    expect(screen.queryByRole("radiogroup", { name: "Nivel Cashea" })).toBeNull();
  });

  it("con un monto, el nivel N3 muestra la inicial del 30 %", async () => {
    const user = usuario();
    pintar();

    await user.click(screen.getByRole("button", { name: "$" }));
    await user.type(screen.getByRole("textbox", { name: "Monto en dólares" }), "100");
    await user.click(screen.getByRole("radio", { name: /^N3/ }));

    const inicial = screen.getByTestId("cashea-inicial");
    expect(inicial).toHaveTextContent("30 %");
    expect(inicial).toHaveTextContent("$30,00");
    // Los bolívares van debajo del dólar (mostrarBs).
    expect(inicial).toHaveTextContent(formatBs(6462));
  });

  it("si el monto baja a $100 o menos con 6 cuotas, pasa a 3 y subir el monto no revive el 6", async () => {
    const user = usuario();
    pintar();

    await user.click(screen.getByRole("button", { name: "$" }));
    const campo = screen.getByRole("textbox", { name: "Monto en dólares" });
    await user.type(campo, "200");
    await user.click(screen.getByRole("button", { name: "6 cuotas" }));
    expect(screen.getByRole("button", { name: "6 cuotas" })).toHaveAttribute("aria-pressed", "true");

    await user.clear(campo);
    await user.type(campo, "50");
    expect(screen.getByRole("button", { name: "3 cuotas" })).toHaveAttribute("aria-pressed", "true");

    await user.clear(campo);
    await user.type(campo, "200");
    expect(screen.getByRole("button", { name: "3 cuotas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "6 cuotas" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("CalculadoraMostrador — «Copiar plan»", () => {
  const plan = calcularCashea({ montoCents: 8600, ...ELECCION_CASHEA_INICIAL });

  it("copia el mensaje de WhatsApp del plan y avisa", async () => {
    const user = usuario();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // `userEvent.setup()` instala su propio portapapeles: se reemplaza DESPUÉS.
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    pintar();

    await user.type(screen.getByRole("textbox", { name: "Monto en bolívares" }), "18524,40");
    await user.click(screen.getByRole("button", { name: "Copiar plan" }));

    expect(writeText).toHaveBeenCalledWith(mensajeWhatsApp(plan));
    // 21/10/2026: sin producto, el saludo no dice «para Monto».
    expect(writeText.mock.calls[0][0]).toMatch(/^¡Hola! Te comparto el plan con Cashea:\n/);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("si el portapapeles falla, avisa con un toast de error", async () => {
    const user = usuario();
    const writeText = vi.fn().mockRejectedValue(new Error("denegado"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    pintar();

    await user.type(screen.getByRole("textbox", { name: "Monto en bolívares" }), "18524,40");
    await user.click(screen.getByRole("button", { name: "Copiar plan" }));

    expect(toastDanger).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("CalculadoraMostrador — plegable en pantallas angostas", () => {
  it("el botón «Calculadora» expone aria-expanded y alterna el cuerpo", async () => {
    const user = usuario();
    pintar();

    const boton = screen.getByRole("button", { name: "Calculadora" });
    const cuerpo = document.querySelector(".inv-calc-cuerpo");
    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(cuerpo).toHaveAttribute("data-abierta", "false");

    await user.click(boton);
    expect(boton).toHaveAttribute("aria-expanded", "true");
    expect(cuerpo).toHaveAttribute("data-abierta", "true");
    expect(within(cuerpo as HTMLElement).getByRole("textbox", { name: "Monto en bolívares" })).toBeInTheDocument();
  });

  it("es un <aside> con las clases del panel", () => {
    const { container } = pintar();
    const aside = container.querySelector("aside");
    expect(aside).toHaveClass("dash-panel", "inv-calc");
  });
});
