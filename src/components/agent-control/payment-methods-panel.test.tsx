/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PaymentMethodsPanel,
  type CasheaSettings,
} from "@/components/agent-control/payment-methods-panel";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import type { PaymentMethodConfig } from "@/lib/payment-methods";

// Mismo patrón que demora-panel.test.tsx: el toast real no aporta y complica
// el DOM; el resto de HeroUI (Button, Input, Label, TextArea, Modal) queda
// intacto para escribir y confirmar como lo haría una persona.
const toastDanger = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: {
      success: (...a: unknown[]) => toastSuccess(...a),
      danger: (...a: unknown[]) => toastDanger(...a),
    },
  };
});

function method(overrides: Partial<PaymentMethodConfig> = {}): PaymentMethodConfig {
  return {
    key: "pago_movil",
    label: "Pago móvil",
    currency: "VES",
    instructions: "Banco: *Banesco*\nTeléfono: 0414-0000000",
    sebaEntrega: true,
    isActive: true,
    sortOrder: 10,
    updatedAt: "2026-11-16T10:00:00.000Z",
    ...overrides,
  };
}

const CASHEA: CasheaSettings = {
  datosText: "Para Cashea necesito tu cédula y tu teléfono.",
  minimoUsd: 25,
  seisCuotasDesdeUsd: 100,
};

const onCreate = vi.fn(async () => {});
const onUpdate = vi.fn(async () => {});
const onDelete = vi.fn(async () => {});
const onToggleActive = vi.fn(async () => {});
const onSaveCashea = vi.fn(async () => {});

function renderPanel(props: Partial<React.ComponentProps<typeof PaymentMethodsPanel>> = {}) {
  return render(
    <PaymentMethodsPanel
      methods={[]}
      cashea={CASHEA}
      canEdit
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onToggleActive={onToggleActive}
      onSaveCashea={onSaveCashea}
      {...props}
    />
  );
}

const setup = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

beforeEach(() => {
  for (const fn of [toastDanger, toastSuccess, onCreate, onUpdate, onDelete, onToggleActive, onSaveCashea]) {
    fn.mockClear();
  }
});

describe("PaymentMethodsPanel — carga", () => {
  it("pinta cada forma con su etiqueta, moneda, quién entrega y el texto en la vista previa; la inactiva lo dice", () => {
    renderPanel({
      methods: [
        method(),
        method({
          key: "binance",
          label: "Binance",
          currency: "USD",
          instructions: "Pay ID 12345",
          sebaEntrega: false,
          isActive: false,
          sortOrder: 20,
        }),
      ],
    });

    const movil = screen.getByRole("article", { name: "Pago móvil" });
    expect(within(movil).getByText("Bolívares")).toBeInTheDocument();
    expect(within(movil).getByText("Seba entrega los datos")).toBeInTheDocument();
    expect(within(movil).getByText("pago_movil")).toBeInTheDocument();
    const vista = within(movil).getByLabelText("Vista previa de Pago móvil");
    expect(vista).toHaveTextContent("Teléfono: 0414-0000000");
    expect(vista.querySelector("strong")).toHaveTextContent("Banesco");
    expect(within(movil).queryByText("Inactiva")).not.toBeInTheDocument();

    const binance = screen.getByRole("article", { name: "Binance" });
    expect(within(binance).getByText("Dólares")).toBeInTheDocument();
    expect(within(binance).getByText("Seba pasa a ventas")).toBeInTheDocument();
    expect(within(binance).getByText("Inactiva")).toBeInTheDocument();
    expect(binance).toHaveAttribute("data-active", "false");
  });

  it("con la lista vacía dice que no hay formas y deja el botón de alta", () => {
    renderPanel();
    expect(screen.getByText("Todavía no hay formas de pago cargadas.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nueva forma de pago" })).toBeInTheDocument();
  });
});

describe("PaymentMethodsPanel — alta", () => {
  it("escribir el nombre propone la clave y guardar llama onCreate con el borrador y el sortOrder siguiente", async () => {
    const user = setup();
    renderPanel({
      methods: [
        method({ key: "zelle", label: "Zelle", sortOrder: 10 }),
        method({ key: "efectivo", label: "Efectivo", sortOrder: 20 }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Nueva forma de pago" }));
    await user.type(screen.getByLabelText("Nombre"), "Pago móvil");
    expect(screen.getByLabelText("Clave")).toHaveValue("pago_movil");

    await user.type(screen.getByLabelText("Datos que recibe el cliente"), "Banco: *Banesco*");
    // La vista previa en vivo del borrador.
    expect(screen.getByLabelText("Vista previa de lo que recibe el cliente").querySelector("strong")).toHaveTextContent(
      "Banesco"
    );
    expect(screen.getByText("16/1500")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        {
          key: "pago_movil",
          label: "Pago móvil",
          currency: "VES",
          instructions: "Banco: *Banesco*",
          sebaEntrega: true,
        },
        30
      )
    );
    expect(toastSuccess).toHaveBeenCalledWith("Forma de pago guardada.");
    // El formulario se cierra al guardar.
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
  });

  it("si la clave se tocó a mano, ya no la pisa el nombre; moneda y casilla de entrega viajan tal cual", async () => {
    const user = setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Nueva forma de pago" }));
    await user.type(screen.getByLabelText("Clave"), "mi_clave");
    await user.type(screen.getByLabelText("Nombre"), "Binance Pay");
    expect(screen.getByLabelText("Clave")).toHaveValue("mi_clave");

    await user.selectOptions(screen.getByLabelText("Moneda"), "USD");
    await user.click(screen.getByLabelText("Seba entrega estos datos junto con el total"));
    await user.type(screen.getByLabelText("Datos que recibe el cliente"), "Pay ID 1");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        { key: "mi_clave", label: "Binance Pay", currency: "USD", instructions: "Pay ID 1", sebaEntrega: false },
        10
      )
    );
  });

  it("Cancelar cierra sin guardar", async () => {
    const user = setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Nueva forma de pago" }));
    await user.type(screen.getByLabelText("Nombre"), "Algo");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("PaymentMethodsPanel — validación", () => {
  it("con el nombre vacío no llama a onCreate y avisa bajo el campo; al escribir, solo ese error desaparece", async () => {
    const user = setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Nueva forma de pago" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("Escribe el nombre de la forma de pago.")).toBeInTheDocument();
    expect(screen.getByText("Escribe los datos que recibe el cliente.")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Nombre"), "Zelle");

    expect(screen.queryByText("Escribe el nombre de la forma de pago.")).not.toBeInTheDocument();
    // El otro campo sigue con su error: solo se limpia el que cambió.
    expect(screen.getByText("Escribe los datos que recibe el cliente.")).toBeInTheDocument();
  });

  it("una clave repetida avisa; al corregir la clave el error desaparece", async () => {
    const user = setup();
    renderPanel({ methods: [method({ key: "pago_movil" })] });

    await user.click(screen.getByRole("button", { name: "Nueva forma de pago" }));
    await user.type(screen.getByLabelText("Nombre"), "Pago móvil");
    await user.type(screen.getByLabelText("Datos que recibe el cliente"), "Datos");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("Ya existe una forma de pago con esa clave.")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Clave"), "_dos");
    expect(screen.queryByText("Ya existe una forma de pago con esa clave.")).not.toBeInTheDocument();
  });
});

describe("PaymentMethodsPanel — edición", () => {
  it("abre con los valores cargados y la clave deshabilitada; guardar llama onUpdate sin la clave en el borrador", async () => {
    const user = setup();
    renderPanel({ methods: [method()] });

    await user.click(screen.getByRole("button", { name: "Editar Pago móvil" }));

    expect(screen.getByLabelText("Nombre")).toHaveValue("Pago móvil");
    expect(screen.getByLabelText("Clave")).toBeDisabled();
    expect(screen.getByLabelText("Clave")).toHaveValue("pago_movil");
    expect(screen.getByText("La clave no se puede cambiar.")).toBeInTheDocument();
    expect(screen.getByLabelText("Moneda")).toHaveValue("VES");
    expect(screen.getByLabelText("Datos que recibe el cliente")).toHaveValue(method().instructions);

    await user.type(screen.getByLabelText("Nombre"), " BDV");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("pago_movil", {
        label: "Pago móvil BDV",
        currency: "VES",
        instructions: method().instructions,
        sebaEntrega: true,
      })
    );
    // Editar el nombre no le cambia la clave.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("un fallo de permiso muestra ESE texto, un fallo de red el genérico, y el formulario sigue abierto con lo escrito", async () => {
    const user = setup();
    onUpdate.mockRejectedValueOnce(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    renderPanel({ methods: [method()] });

    await user.click(screen.getByRole("button", { name: "Editar Pago móvil" }));
    await user.type(screen.getByLabelText("Nombre"), " X");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(toastDanger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.")
    );
    expect(screen.getByLabelText("Nombre")).toHaveValue("Pago móvil X");
    expect(toastSuccess).not.toHaveBeenCalled();

    onUpdate.mockRejectedValueOnce(new Error("fetch failed"));
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(toastDanger).toHaveBeenLastCalledWith("No se pudo guardar la forma de pago."));
    expect(screen.getByLabelText("Nombre")).toBeInTheDocument();
  });
});

describe("PaymentMethodsPanel — activar y borrar", () => {
  it("el interruptor de una forma activa llama onToggleActive(key, false)", async () => {
    const user = setup();
    renderPanel({ methods: [method()] });

    const interruptor = screen.getByRole("switch", { name: "Activa: Pago móvil" });
    expect(interruptor).toHaveAttribute("aria-checked", "true");
    await user.click(interruptor);

    expect(onToggleActive).toHaveBeenCalledWith("pago_movil", false);
  });

  it("un fallo al cambiar el estado avisa con el texto del permiso", async () => {
    const user = setup();
    onToggleActive.mockRejectedValueOnce(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    renderPanel({ methods: [method({ isActive: false })] });

    await user.click(screen.getByRole("switch", { name: "Activa: Pago móvil" }));

    await waitFor(() =>
      expect(toastDanger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.")
    );
  });

  it("Borrar no llama nada hasta confirmar en el diálogo; al confirmar llama onDelete(key)", async () => {
    const user = setup();
    renderPanel({ methods: [method()] });

    await user.click(screen.getByRole("button", { name: "Borrar Pago móvil" }));

    expect(await screen.findByText("¿Borrar «Pago móvil»?")).toBeInTheDocument();
    expect(screen.getByText(/Seba deja de ofrecer esta forma de pago/)).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("pago_movil"));
    expect(toastSuccess).toHaveBeenCalledWith("Forma de pago borrada.");
  });

  it("si borrar falla, avisa y el diálogo queda abierto", async () => {
    const user = setup();
    onDelete.mockRejectedValueOnce(new Error("fetch failed"));
    renderPanel({ methods: [method()] });

    await user.click(screen.getByRole("button", { name: "Borrar Pago móvil" }));
    await user.click(await screen.findByRole("button", { name: "Sí, borrar" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("No se pudo borrar la forma de pago."));
    expect(screen.getByText("¿Borrar «Pago móvil»?")).toBeInTheDocument();
  });
});

describe("PaymentMethodsPanel — solo lectura", () => {
  it("sin canEdit no hay alta, edición, borrado, interruptores ni Guardar Cashea; aparece la nota y Cashea queda deshabilitada", () => {
    renderPanel({ methods: [method()], canEdit: false });

    expect(screen.queryByRole("button", { name: "Nueva forma de pago" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Editar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Borrar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar Cashea" })).not.toBeInTheDocument();
    expect(screen.getByText("Solo un supervisor o admin puede cambiar las formas de pago.")).toBeInTheDocument();

    expect(screen.getByLabelText("Texto que pide los datos del titular")).toBeDisabled();
    expect(screen.getByLabelText("Compra mínima (USD)")).toBeDisabled();
    expect(screen.getByLabelText("Seis cuotas desde (USD)")).toBeDisabled();
    // Todo se sigue viendo.
    expect(screen.getByLabelText("Vista previa de Pago móvil")).toBeInTheDocument();
  });
});

describe("PaymentMethodsPanel — Cashea", () => {
  it("guarda con los montos como número ('25,5' → 25.5) y avisa", async () => {
    const user = setup();
    renderPanel();

    expect(screen.getByLabelText("Compra mínima (USD)")).toHaveValue("25");
    expect(screen.getByLabelText("Seis cuotas desde (USD)")).toHaveValue("100");

    const minimo = screen.getByLabelText("Compra mínima (USD)");
    await user.clear(minimo);
    await user.type(minimo, "25,5");
    await user.click(screen.getByRole("button", { name: "Guardar Cashea" }));

    await waitFor(() =>
      expect(onSaveCashea).toHaveBeenCalledWith({
        datosText: CASHEA.datosText,
        minimoUsd: 25.5,
        seisCuotasDesdeUsd: 100,
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith("Datos de Cashea guardados.");
  });

  it("un monto vacío muestra su error bajo el campo y no llama a onSaveCashea", async () => {
    const user = setup();
    renderPanel();

    await user.clear(screen.getByLabelText("Compra mínima (USD)"));
    await user.click(screen.getByRole("button", { name: "Guardar Cashea" }));

    expect(await screen.findByText("Escribe un monto en dólares.")).toBeInTheDocument();
    expect(onSaveCashea).not.toHaveBeenCalled();

    // Al escribir en el campo, su error desaparece.
    await user.type(screen.getByLabelText("Compra mínima (USD)"), "30");
    expect(screen.queryByText("Escribe un monto en dólares.")).not.toBeInTheDocument();
  });

  it("un fallo de permiso al guardar Cashea muestra ese texto", async () => {
    const user = setup();
    onSaveCashea.mockRejectedValueOnce(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Guardar Cashea" }));

    await waitFor(() =>
      expect(toastDanger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.")
    );
  });

  it("con cashea=null dice «No disponible» y no pinta ningún campo", () => {
    renderPanel({ cashea: null });

    expect(screen.getByText(/No disponible/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Compra mínima (USD)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Texto que pide los datos del titular")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar Cashea" })).not.toBeInTheDocument();
  });

  it("si el padre refresca los datos y no hay cambios sin guardar, el borrador se actualiza; con cambios, se respeta lo escrito", async () => {
    const user = setup();
    const { rerender } = renderPanel();
    const props = {
      methods: [],
      canEdit: true,
      onCreate,
      onUpdate,
      onDelete,
      onToggleActive,
      onSaveCashea,
    };

    rerender(<PaymentMethodsPanel {...props} cashea={{ ...CASHEA, minimoUsd: 40 }} />);
    expect(screen.getByLabelText("Compra mínima (USD)")).toHaveValue("40");

    await user.type(screen.getByLabelText("Compra mínima (USD)"), "5");
    rerender(<PaymentMethodsPanel {...props} cashea={{ ...CASHEA, minimoUsd: 99 }} />);
    expect(screen.getByLabelText("Compra mínima (USD)")).toHaveValue("405");
  });
});
