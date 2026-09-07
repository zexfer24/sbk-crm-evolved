/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlaybooksPanel } from "@/components/agent-control/playbooks-panel";

// ---------------------------------------------------------------------------
// El toast real de HeroUI no aporta nada a estos tests y complica el DOM; se
// deja pasar el resto del módulo intacto (Modal, Button, Input reales) para
// poder abrir el formulario y guardar como lo haría alguien de verdad.
// ---------------------------------------------------------------------------
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn() } };
});

const createPlaybook = vi.fn();

// Se conserva la clase REAL PlaybookIdentityError (importOriginal): el panel
// usa `instanceof` para decidir la rama del catch, así que un mock falso de
// la clase rompería justo lo que este test verifica.
vi.mock("@/lib/mutations", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mutations")>();
  return { ...real, createPlaybook: (...args: unknown[]) => createPlaybook(...args) };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

async function completarYGuardar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));

  await user.type(screen.getByLabelText("Nombre"), "Postventa Cashea");
  await user.type(screen.getByLabelText("¿Cuándo aplica?"), "el cliente pregunta por su pedido");
  await user.type(screen.getByLabelText("Respuesta"), "Un texto de prueba cualquiera.");

  await user.click(screen.getByRole("button", { name: "Crear escenario" }));
}

describe("PlaybooksPanel — guardar un escenario", () => {
  beforeEach(() => {
    createPlaybook.mockReset();
  });

  it("cuando la guarda de identidad rechaza el texto, el toast muestra su mensaje y no el genérico", async () => {
    const { PlaybookIdentityError } = await import("@/lib/mutations");
    createPlaybook.mockRejectedValueOnce(
      new PlaybookIdentityError({ categoria: "automatizacion", fragmento: "asistente automatizado" })
    );
    const { toast } = await import("@heroui/react");
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });

    render(<PlaybooksPanel playbooks={[]} unmatchedTurns={[]} quickReplies={[]} tags={[]} canEdit />);

    await completarYGuardar(user);

    await waitFor(() => expect(toast.danger).toHaveBeenCalled());
    const mensaje = vi.mocked(toast.danger).mock.calls.at(-1)?.[0];
    expect(mensaje).toContain("automatizada");
    expect(mensaje).toContain("«asistente automatizado»");
    expect(toast.danger).not.toHaveBeenCalledWith("No se pudo guardar el escenario.");
  });

  it("un nombre duplicado sigue mostrando el mensaje de duplicado, no el de la guarda de identidad", async () => {
    createPlaybook.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "ai_playbooks_name_key"')
    );
    const { toast } = await import("@heroui/react");
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });

    render(<PlaybooksPanel playbooks={[]} unmatchedTurns={[]} quickReplies={[]} tags={[]} canEdit />);

    await completarYGuardar(user);

    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith("Ya existe un escenario con ese nombre."));
  });
});
