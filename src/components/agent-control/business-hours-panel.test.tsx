/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BusinessHoursPanel } from "@/components/agent-control/business-hours-panel";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import type { AgentSettings } from "@/lib/types";

// El toast real de HeroUI no aporta nada a estos tests y complica el DOM;
// se deja pasar el resto del módulo intacto (Button real, para poder hacer
// clic en "Guardar" como lo haría alguien de verdad).
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn() } };
});

function settings(patch: Partial<AgentSettings> = {}): AgentSettings {
  return { aiGloballyEnabled: true, dailySpendCapUsd: null, spentTodayUsd: 0, ...patch };
}

describe("BusinessHoursPanel", () => {
  beforeEach(() => {
    // Lunes 7/9/2026, 10:00 am hora de Barinas (UTC-4 todo el año, sin
    // horario de verano) — dentro del horario por defecto, para que la
    // vista previa tenga algo determinístico que afirmar. Solo se mockea
    // `Date` (sin `useFakeTimers` completo): userEvent y HeroUI dependen de
    // `setTimeout` real, y falsearlo también los dejaba colgados (timeout de
    // 15s en las tres pruebas que hacían clic).
    vi.setSystemTime(new Date("2026-09-07T14:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("guardar con el horario por defecto llama a onSave con el objeto exacto", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onSave = vi.fn(async () => {});
    render(<BusinessHoursPanel settings={settings()} canEdit onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(DEFAULT_BUSINESS_HOURS);
  });

  it("la vista previa dice que está abierta y a qué hora cierra hoy", () => {
    render(<BusinessHoursPanel settings={settings()} canEdit onSave={vi.fn()} />);

    expect(screen.getByText("Ahora: abierta, cierra a las 6:00 pm")).toBeInTheDocument();
    expect(screen.getByText("lunes a viernes de 8:00 am a 6:00 pm")).toBeInTheDocument();
  });

  it("un cierre antes de la apertura muestra el error y no deja guardar", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onSave = vi.fn(async () => {});
    render(<BusinessHoursPanel settings={settings()} canEdit onSave={onSave} />);

    fireEvent.change(screen.getByLabelText("Lunes, cierre de la franja 1"), { target: { value: "07:00" } });

    expect(screen.getByText("El cierre tiene que ser después de la apertura.")).toBeInTheDocument();
    const boton = screen.getByRole("button", { name: "Guardar" });
    expect(boton).toBeDisabled();

    await user.click(boton);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("marcar el sábado abierto de 9:00 a 1:00 pm y guardar manda esa franja tal cual", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onSave = vi.fn(async () => {});
    render(<BusinessHoursPanel settings={settings()} canEdit onSave={onSave} />);

    // Sábado nace cerrado: la casilla "Sábado cerrado" viene marcada.
    await user.click(screen.getByLabelText("Sábado cerrado"));
    fireEvent.change(screen.getByLabelText("Sábado, apertura de la franja 1"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Sábado, cierre de la franja 1"), { target: { value: "13:00" } });

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(onSave).toHaveBeenCalledWith({
      ...DEFAULT_BUSINESS_HOURS,
      sat: [["09:00", "13:00"]],
    });
  });

  it("con canEdit=false no hay botón Guardar", () => {
    render(<BusinessHoursPanel settings={settings()} canEdit={false} onSave={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Guardar" })).not.toBeInTheDocument();
  });
});
