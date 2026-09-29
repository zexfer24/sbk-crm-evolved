/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoraPanel } from "@/components/agent-control/demora-panel";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import type { AgentSettings } from "@/lib/types";

// Mismo patrón que business-hours-panel.test.tsx: el toast real no aporta y
// complica el DOM; el resto de HeroUI queda intacto.
const toastDanger = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: (...a: unknown[]) => toastDanger(...a) } };
});

function settings(patch: Partial<AgentSettings> = {}): AgentSettings {
  return { aiGloballyEnabled: true, dailySpendCapUsd: null, spentTodayUsd: 0, ...patch };
}

const NOMBRE_INTERRUPTOR = "Reasignar si el asesor tarda";

beforeEach(() => {
  toastDanger.mockClear();
});

describe("DemoraPanel (T10b-5, 29/9/2026)", () => {
  it("explica la regla: a los 10 min responde Seba, a los 15 min de horario se reasigna, tope 2 y aviso al supervisor", () => {
    render(<DemoraPanel settings={settings()} canEdit onToggle={vi.fn()} />);

    const ayuda = screen.getByTestId("demora-ayuda").textContent ?? "";
    expect(ayuda).toMatch(/10 min/);
    expect(ayuda).toMatch(/15 min/);
    expect(ayuda).toMatch(/horario/i);
    expect(ayuda).toMatch(/2 reasignaciones|dos reasignaciones/i);
    expect(ayuda).toMatch(/supervisor/i);
  });

  it("un supervisor/admin ve el interruptor habilitado y apagado por defecto", () => {
    render(<DemoraPanel settings={settings()} canEdit onToggle={vi.fn()} />);

    const interruptor = screen.getByRole("switch", { name: NOMBRE_INTERRUPTOR });
    expect(interruptor).toBeEnabled();
    expect(interruptor).toHaveAttribute("aria-checked", "false");
  });

  it("un asesor común lo ve deshabilitado y con la nota de quién puede cambiarlo; clicarlo no llama a nada", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onToggle = vi.fn(async () => {});
    render(<DemoraPanel settings={settings({ demoraActiva: true })} canEdit={false} onToggle={onToggle} />);

    const interruptor = screen.getByRole("switch", { name: NOMBRE_INTERRUPTOR });
    expect(interruptor).toBeDisabled();
    expect(interruptor).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Solo un supervisor o admin puede cambiar la reasignación/)).toBeInTheDocument();

    await user.click(interruptor);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("encender llama a onToggle(true) y el interruptor queda encendido", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onToggle = vi.fn(async () => {});
    render(<DemoraPanel settings={settings()} canEdit onToggle={onToggle} />);

    await user.click(screen.getByRole("switch", { name: NOMBRE_INTERRUPTOR }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("apagar llama a onToggle(false)", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onToggle = vi.fn(async () => {});
    render(<DemoraPanel settings={settings({ demoraActiva: true })} canEdit onToggle={onToggle} />);

    await user.click(screen.getByRole("switch", { name: NOMBRE_INTERRUPTOR }));

    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("si el guardado falla: toast de error con el motivo y el interruptor vuelve a donde estaba", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onToggle = vi.fn(async () => {
      throw new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto.");
    });
    render(<DemoraPanel settings={settings()} canEdit onToggle={onToggle} />);

    await user.click(screen.getByRole("switch", { name: NOMBRE_INTERRUPTOR }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(toastDanger).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.");
    expect(screen.getByRole("switch", { name: NOMBRE_INTERRUPTOR })).toHaveAttribute("aria-checked", "false");
  });

  it("un error de red usa el texto genérico del panel", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onToggle = vi.fn(async () => {
      throw new Error("connection reset");
    });
    render(<DemoraPanel settings={settings()} canEdit onToggle={onToggle} />);

    await user.click(screen.getByRole("switch", { name: NOMBRE_INTERRUPTOR }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(toastDanger.mock.calls[0][0]).toMatch(/No se pudo/);
  });

  it("encendida muestra desde cuándo corre (el corte del backlog); apagada no", () => {
    const { rerender } = render(
      <DemoraPanel
        settings={settings({ demoraActiva: true, demoraActivaDesde: "2026-09-29T15:30:00.000Z" })}
        canEdit
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByText(/Encendida desde/)).toBeInTheDocument();

    rerender(
      <DemoraPanel
        settings={settings({ demoraActiva: false, demoraActivaDesde: "2026-09-29T15:30:00.000Z" })}
        canEdit
        onToggle={vi.fn()}
      />
    );
    expect(screen.queryByText(/Encendida desde/)).not.toBeInTheDocument();
  });
});
