/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SebaV2Panel } from "@/components/agent-control/seba-v2-panel";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import { SEBA_V2_MODE_DESCRIPTIONS, SEBA_V2_MODE_LABELS, SEBA_V2_MODES } from "@/lib/seba-v2-config";

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

const CONFIG = { modo: "apagado" as const, shadowDailyCapUsd: 5, shadowSamplePct: 100 };

const onModeChange = vi.fn(async () => {});
const onSaveLimits = vi.fn(async () => {});

function renderPanel(props: Partial<React.ComponentProps<typeof SebaV2Panel>> = {}) {
  return render(<SebaV2Panel config={CONFIG} canEdit onModeChange={onModeChange} onSaveLimits={onSaveLimits} {...props} />);
}

const setup = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

beforeEach(() => {
  for (const fn of [toastDanger, toastSuccess, onModeChange, onSaveLimits]) fn.mockClear();
});

describe("SebaV2Panel — carga", () => {
  it("pinta los cinco modos con su descripción, el guardado marcado y el aviso de que todavía no está instalada", () => {
    renderPanel({ config: { ...CONFIG, modo: "copiloto" } });

    expect(screen.getAllByRole("radio")).toHaveLength(5);
    for (const modo of SEBA_V2_MODES) {
      expect(screen.getByRole("radio", { name: SEBA_V2_MODE_LABELS[modo] })).toBeInTheDocument();
      expect(screen.getByText(SEBA_V2_MODE_DESCRIPTIONS[modo])).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: "Copiloto" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Apagado" })).not.toBeChecked();

    expect(screen.getByRole("note")).toHaveTextContent("Seba v2 todavía no está instalada.");
  });
});

describe("SebaV2Panel — cambio de modo", () => {
  it("elegir «Sombra» llama onModeChange('sombra') sin diálogo y avisa", async () => {
    const user = setup();
    renderPanel();

    await user.click(screen.getByRole("radio", { name: "Sombra" }));

    await waitFor(() => expect(onModeChange).toHaveBeenCalledWith("sombra"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("Modo de Seba v2: Sombra.");
  });

  it.each([
    ["Siempre", "siempre"],
    ["Fuera de horario", "fuera_de_horario"],
  ] as const)("elegir «%s» NO llama hasta confirmar; Cancelar deja el modo anterior", async (etiqueta, modo) => {
    const user = setup();
    renderPanel();

    await user.click(screen.getByRole("radio", { name: etiqueta }));

    expect(await screen.findByText(`¿Pasar Seba v2 a «${etiqueta}»?`)).toBeInTheDocument();
    expect(screen.getByText(/sin que un asesor revise cada mensaje/)).toBeInTheDocument();
    expect(onModeChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onModeChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Apagado" })).toBeChecked());
    expect(screen.getByRole("radio", { name: etiqueta })).not.toBeChecked();

    // Y de nuevo, ahora confirmando.
    await user.click(screen.getByRole("radio", { name: etiqueta }));
    await user.click(await screen.findByRole("button", { name: "Sí, cambiar el modo" }));

    await waitFor(() => expect(onModeChange).toHaveBeenCalledWith(modo));
    expect(toastSuccess).toHaveBeenCalledWith(`Modo de Seba v2: ${etiqueta}.`);
  });

  it("elegir el modo que ya está activo no llama", async () => {
    const user = setup();
    renderPanel();

    await user.click(screen.getByRole("radio", { name: "Apagado" }));

    expect(onModeChange).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("si onModeChange falla avisa con el texto del permiso y el radio vuelve al modo anterior", async () => {
    const user = setup();
    onModeChange.mockRejectedValueOnce(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    renderPanel();

    await user.click(screen.getByRole("radio", { name: "Copiloto" }));

    await waitFor(() =>
      expect(toastDanger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.")
    );
    await waitFor(() => expect(screen.getByRole("radio", { name: "Apagado" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Copiloto" })).not.toBeChecked();
  });

  it("si falla desde el diálogo de confirmación, el diálogo queda abierto", async () => {
    const user = setup();
    onModeChange.mockRejectedValueOnce(new Error("fetch failed"));
    renderPanel();

    await user.click(screen.getByRole("radio", { name: "Siempre" }));
    await user.click(await screen.findByRole("button", { name: "Sí, cambiar el modo" }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("No se pudo cambiar el modo de Seba v2."));
    expect(screen.getByText("¿Pasar Seba v2 a «Siempre»?")).toBeInTheDocument();
  });
});

describe("SebaV2Panel — límites de la sombra", () => {
  it("«7,5» y «50» llegan como números y se avisa", async () => {
    const user = setup();
    renderPanel();

    expect(screen.getByLabelText("Tope diario de la sombra (USD)")).toHaveValue("5");
    expect(screen.getByLabelText("Muestreo (%)")).toHaveValue("100");

    const tope = screen.getByLabelText("Tope diario de la sombra (USD)");
    await user.clear(tope);
    await user.type(tope, "7,5");
    const muestreo = screen.getByLabelText("Muestreo (%)");
    await user.clear(muestreo);
    await user.type(muestreo, "50");
    await user.click(screen.getByRole("button", { name: "Guardar límites" }));

    await waitFor(() => expect(onSaveLimits).toHaveBeenCalledWith({ capUsd: 7.5, samplePct: 50 }));
    expect(toastSuccess).toHaveBeenCalledWith("Límites de la sombra guardados.");
  });

  it("un porcentaje de 101 muestra su error y no llama; al escribir, desaparece", async () => {
    const user = setup();
    renderPanel();

    const muestreo = screen.getByLabelText("Muestreo (%)");
    await user.clear(muestreo);
    await user.type(muestreo, "101");
    await user.click(screen.getByRole("button", { name: "Guardar límites" }));

    const error = await screen.findByText("Escribe un porcentaje entero entre 0 y 100.");
    expect(error).toHaveAttribute("role", "alert");
    expect(onSaveLimits).not.toHaveBeenCalled();

    await user.type(muestreo, "0");
    expect(screen.queryByText("Escribe un porcentaje entero entre 0 y 100.")).not.toBeInTheDocument();
  });

  it("un tope vacío pide un monto en dólares", async () => {
    const user = setup();
    renderPanel();

    await user.clear(screen.getByLabelText("Tope diario de la sombra (USD)"));
    await user.click(screen.getByRole("button", { name: "Guardar límites" }));

    expect(await screen.findByText("Escribe un monto en dólares.")).toBeInTheDocument();
    expect(onSaveLimits).not.toHaveBeenCalled();
  });

  it("un fallo al guardar los límites avisa con el genérico", async () => {
    const user = setup();
    onSaveLimits.mockRejectedValueOnce(new Error("fetch failed"));
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Guardar límites" }));

    await waitFor(() =>
      expect(toastDanger).toHaveBeenCalledWith("No se pudieron guardar los límites de la sombra.")
    );
  });
});

describe("SebaV2Panel — solo lectura, no disponible y datos nuevos", () => {
  it("sin canEdit: radios e inputs deshabilitados, sin Guardar límites y con la nota", () => {
    renderPanel({ canEdit: false });

    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByLabelText("Tope diario de la sombra (USD)")).toBeDisabled();
    expect(screen.getByLabelText("Muestreo (%)")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Guardar límites" })).not.toBeInTheDocument();
    expect(screen.getByText("Solo un supervisor o admin puede cambiar el modo.")).toBeInTheDocument();
  });

  it("con config=null dice «No disponible», conserva el aviso y no pinta modos ni campos", () => {
    renderPanel({ config: null });

    expect(screen.getByText(/No disponible/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Muestreo (%)")).not.toBeInTheDocument();
  });

  it("si el padre refresca el modo y los límites sin cambios locales, se actualizan; con cambios se respeta lo escrito", async () => {
    const user = setup();
    const { rerender } = renderPanel();
    const props = { canEdit: true, onModeChange, onSaveLimits };

    rerender(<SebaV2Panel {...props} config={{ modo: "sombra", shadowDailyCapUsd: 8, shadowSamplePct: 20 }} />);
    expect(screen.getByRole("radio", { name: "Sombra" })).toBeChecked();
    expect(screen.getByLabelText("Tope diario de la sombra (USD)")).toHaveValue("8");
    expect(screen.getByLabelText("Muestreo (%)")).toHaveValue("20");

    await user.type(screen.getByLabelText("Muestreo (%)"), "5");
    rerender(<SebaV2Panel {...props} config={{ modo: "sombra", shadowDailyCapUsd: 8, shadowSamplePct: 30 }} />);
    expect(screen.getByLabelText("Muestreo (%)")).toHaveValue("205");
  });
});
