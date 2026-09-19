/** @vitest-environment jsdom */
import type { ComponentProps } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlaybooksPanel } from "@/components/agent-control/playbooks-panel";
import type { CatalogLink, Playbook } from "@/lib/types";

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

/**
 * T4a (plan "Nada sin leer, un solo catálogo y la factura Saint",
 * 18/9/2026): `PlaybooksPanel` ahora también gobierna la sección de
 * catálogos, así que todo test que lo monta necesita sus cinco props nuevas.
 * Este helper las llena con valores neutros (sin catálogos, mutaciones que
 * no hacen nada) para que los tests que no les conciernen no tengan que
 * repetirlas.
 */
function renderPanel(props: Partial<ComponentProps<typeof PlaybooksPanel>> = {}) {
  return render(
    <PlaybooksPanel
      playbooks={[]}
      unmatchedTurns={[]}
      quickReplies={[]}
      tags={[]}
      canEdit
      catalogLinks={[]}
      onCreateCatalogLink={vi.fn(async () => {})}
      onUpdateCatalogLink={vi.fn(async () => {})}
      onDeleteCatalogLink={vi.fn(async () => {})}
      onToggleCatalogLink={vi.fn(async () => {})}
      {...props}
    />
  );
}

function catalogLink(overrides: Partial<CatalogLink> = {}): CatalogLink {
  return {
    id: "link-1",
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/file/d/abc123",
    sortOrder: 1,
    isActive: true,
    updatedBy: "agent-1",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb-1",
    name: "Catálogo general",
    triggerDescription: "el cliente pregunta por el catálogo",
    responseText: "Acá va el catálogo 👇",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    tags: [],
    ...overrides,
  };
}

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

    renderPanel();

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

    renderPanel();

    await completarYGuardar(user);

    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith("Ya existe un escenario con ese nombre."));
  });
});

describe("PlaybooksPanel — Insertar catálogo (T4a, D4)", () => {
  it('"Insertar catálogo" pega el marcador en la Respuesta', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel({ catalogLinks: [catalogLink({ key: "cascos", label: "Cascos" })] });

    await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));
    await user.type(screen.getByLabelText("Respuesta"), "Mira esto: ");
    await user.selectOptions(screen.getByLabelText("Insertar catálogo"), "cascos");

    expect(screen.getByLabelText("Respuesta")).toHaveValue("Mira esto: {{catalogo:cascos}}");
  });

  it('"Todos los catálogos" pega el marcador de la lista completa', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel({ catalogLinks: [catalogLink({ key: "cascos", label: "Cascos" })] });

    await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));
    await user.selectOptions(screen.getByLabelText("Insertar catálogo"), "Todos los catálogos");

    expect(screen.getByLabelText("Respuesta")).toHaveValue("{{catalogos}}");
  });

  it("sin catálogos cargados no muestra el selector", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel({ catalogLinks: [] });

    await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));

    expect(screen.queryByLabelText("Insertar catálogo")).not.toBeInTheDocument();
  });

  it("avisa cuando el texto lleva un enlace escrito a mano", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));
    await user.type(screen.getByLabelText("Respuesta"), "Mira acá: https://drive.google.com/file/d/xyz");

    expect(
      screen.getByText(/Este texto lleva un enlace escrito a mano; si es un catálogo, usa el marcador/)
    ).toBeInTheDocument();
  });

  it("un escenario con marcador de catálogo sin resolver lleva la marca en la lista", () => {
    renderPanel({
      playbooks: [playbook({ responseText: "Acá va: {{catalogo:cascos}}" })],
      catalogLinks: [],
    });

    expect(screen.getByText("Enlace sin resolver")).toBeInTheDocument();
  });

  it("con la clave activa, el escenario NO lleva la marca de sin resolver", () => {
    renderPanel({
      playbooks: [playbook({ responseText: "Acá va: {{catalogo:cascos}}" })],
      catalogLinks: [catalogLink({ key: "cascos" })],
    });

    expect(screen.queryByText("Enlace sin resolver")).not.toBeInTheDocument();
  });

  /**
   * Corrección de la revisión `code-review high` del 19/9/2026, punto 5: el
   * selector ofrecía CUALQUIER catálogo, activo o no — pegar la clave de uno
   * apagado deja el marcador SIN RESOLVER apenas se guarda (D6), justo lo
   * que este botón debería evitar. Mismo filtro que `quick-replies-modal.tsx`
   * (`activeCatalogLinks`).
   */
  it("no ofrece un catálogo INACTIVO entre las opciones", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel({
      catalogLinks: [
        catalogLink({ id: "1", key: "cascos", label: "Cascos", isActive: true }),
        catalogLink({ id: "2", key: "defensas", label: "Defensas", isActive: false }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));

    const selector = screen.getByLabelText("Insertar catálogo");
    const opciones = within(selector).getAllByRole("option").map((o) => o.textContent);
    expect(opciones).toContain("Cascos");
    expect(opciones).not.toContain("Defensas");
  });

  it("con TODOS los catálogos inactivos, no muestra el selector (nada que insertar)", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel({ catalogLinks: [catalogLink({ key: "defensas", isActive: false })] });

    await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));

    expect(screen.queryByLabelText("Insertar catálogo")).not.toBeInTheDocument();
  });

  it("ofrece los catálogos activos en el orden de sort_order, no el orden en que llegan", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel({
      catalogLinks: [
        catalogLink({ id: "1", key: "resonadores", label: "Resonadores", sortOrder: 2 }),
        catalogLink({ id: "2", key: "cascos", label: "Cascos", sortOrder: 1 }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Nuevo escenario" }));

    const selector = screen.getByLabelText("Insertar catálogo");
    const opciones = within(selector).getAllByRole("option").map((o) => o.textContent);
    // Las dos primeras opciones son fijas ("Insertar catálogo…", "Todos los
    // catálogos"); las claves empiezan en el índice 2.
    expect(opciones.slice(2)).toEqual(["Cascos", "Resonadores"]);
  });
});
