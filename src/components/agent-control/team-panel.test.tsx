/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@heroui/react";
import { TeamPanel } from "@/components/agent-control/team-panel";
import type { Agent } from "@/lib/types";

/**
 * T6, "Ronda del cliente" (30/9/2026): la pestaña «Equipo» de Control IA, solo
 * para administradores. El modal valida campo por campo con
 * `validateAgentAccountDraft` y manda a `PATCH /api/agents/[id]` SOLO lo que
 * cambió: una contraseña vacía no viaja.
 */

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { ...real.toast, danger: vi.fn(), success: vi.fn(), warning: vi.fn() } };
});

const AGENTS: Agent[] = [
  { id: "a-1", displayName: "María", fullName: "María Pérez", avatarUrl: null, role: "agent", isActive: true },
  { id: "a-2", displayName: "Dueña", fullName: null, avatarUrl: null, role: "admin", isActive: true },
  { id: "a-3", displayName: "Pedro", fullName: null, avatarUrl: null, role: "supervisor", isActive: false },
];

const fetchMock = vi.fn();
const onAgentRenamed = vi.fn();

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function montar() {
  render(<TeamPanel agents={AGENTS} currentAgentId="a-2" onAgentRenamed={onAgentRenamed} />);
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

async function abrir(user: ReturnType<typeof userEvent.setup>, nombre = "María") {
  await user.click(screen.getByRole("button", { name: `Editar a ${nombre}` }));
  return screen.findByRole("dialog");
}

function saveButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Guardar" });
}

function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  fetchMock.mockReset();
  onAgentRenamed.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.danger).mockReset();
  vi.mocked(toast.warning).mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TeamPanel — lista", () => {
  it("muestra a cada cuenta con su rol, su estado y un botón Editar", () => {
    montar();
    expect(screen.getByText("María")).toBeInTheDocument();
    expect(screen.getByText("Asesor")).toBeInTheDocument();
    expect(screen.getByText("Administrador")).toBeInTheDocument();
    expect(screen.getByText("Supervisor")).toBeInTheDocument();
    expect(screen.getByText("Fuera del reparto")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Editar a / })).toHaveLength(3);
  });
});

describe("TeamPanel — modal de edición", () => {
  it("abre con el nombre precargado y, sin cambios, Guardar está deshabilitado", async () => {
    const user = montar();
    const dialog = await abrir(user);
    expect(within(dialog).getByLabelText("Nombre visible")).toHaveValue("María");
    expect(saveButton(dialog)).toBeDisabled();
  });

  it("una confirmación distinta muestra el error y no llama a la ruta", async () => {
    const user = montar();
    const dialog = await abrir(user);
    await user.type(within(dialog).getByLabelText("Contraseña nueva"), "clave-larga-1");
    await user.type(within(dialog).getByLabelText("Confirmar contraseña"), "clave-larga-2");
    await user.click(saveButton(dialog));

    expect(await within(dialog).findByText("Las contraseñas no coinciden.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("una contraseña de 7 caracteres muestra su error", async () => {
    const user = montar();
    const dialog = await abrir(user);
    await user.type(within(dialog).getByLabelText("Contraseña nueva"), "1234567");
    await user.type(within(dialog).getByLabelText("Confirmar contraseña"), "1234567");
    await user.click(saveButton(dialog));

    expect(await within(dialog).findByText("La contraseña debe tener al menos 8 caracteres.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un nombre vacío muestra su error", async () => {
    const user = montar();
    const dialog = await abrir(user);
    await user.clear(within(dialog).getByLabelText("Nombre visible"));
    await user.click(saveButton(dialog));

    expect(await within(dialog).findByText("El nombre visible no puede quedar vacío.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("solo el nombre: manda el PATCH sin contraseña y avisa al panel del nombre nuevo", async () => {
    respond(200, { ok: true, nameUpdated: true, passwordUpdated: false });
    const user = montar();
    const dialog = await abrir(user);
    const name = within(dialog).getByLabelText("Nombre visible");
    await user.clear(name);
    await user.type(name, "María José");
    await user.click(saveButton(dialog));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agents/a-1");
    expect(init.method).toBe("PATCH");
    expect(sentBody()).toEqual({ displayName: "María José" });
    await waitFor(() => expect(onAgentRenamed).toHaveBeenCalledWith("a-1", "María José"));
    expect(toast.success).toHaveBeenCalled();
  });

  it("nombre y contraseña: manda los dos", async () => {
    respond(200, { ok: true, nameUpdated: true, passwordUpdated: true });
    const user = montar();
    const dialog = await abrir(user);
    const name = within(dialog).getByLabelText("Nombre visible");
    await user.clear(name);
    await user.type(name, "Mari");
    await user.type(within(dialog).getByLabelText("Contraseña nueva"), "clave-larga-1");
    await user.type(within(dialog).getByLabelText("Confirmar contraseña"), "clave-larga-1");
    await user.click(saveButton(dialog));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ displayName: "Mari", password: "clave-larga-1" });
  });

  it("solo la contraseña: no manda el nombre ni renombra", async () => {
    respond(200, { ok: true, nameUpdated: false, passwordUpdated: true });
    const user = montar();
    const dialog = await abrir(user);
    await user.type(within(dialog).getByLabelText("Contraseña nueva"), "clave-larga-1");
    await user.type(within(dialog).getByLabelText("Confirmar contraseña"), "clave-larga-1");
    await user.click(saveButton(dialog));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ password: "clave-larga-1" });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(onAgentRenamed).not.toHaveBeenCalled();
  });

  it("un 207 avisa qué quedó y qué no, y el nombre que sí quedó se refleja", async () => {
    respond(207, {
      ok: false,
      nameUpdated: true,
      passwordUpdated: false,
      error: "No se pudo cambiar la contraseña: el servicio de acceso la considera demasiado débil.",
    });
    const user = montar();
    const dialog = await abrir(user);
    const name = within(dialog).getByLabelText("Nombre visible");
    await user.clear(name);
    await user.type(name, "Mari");
    await user.type(within(dialog).getByLabelText("Contraseña nueva"), "clave-larga-1");
    await user.type(within(dialog).getByLabelText("Confirmar contraseña"), "clave-larga-1");
    await user.click(saveButton(dialog));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [mensaje] = vi.mocked(toast.warning).mock.calls[0] as [string];
    expect(mensaje).toContain("El nombre visible se guardó");
    expect(mensaje).toContain("demasiado débil");
    expect(onAgentRenamed).toHaveBeenCalledWith("a-1", "Mari");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("un error de la ruta se muestra y no renombra", async () => {
    respond(403, { error: "Solo un administrador puede editar cuentas." });
    const user = montar();
    const dialog = await abrir(user);
    const name = within(dialog).getByLabelText("Nombre visible");
    await user.clear(name);
    await user.type(name, "Mari");
    await user.click(saveButton(dialog));

    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith("Solo un administrador puede editar cuentas."));
    expect(onAgentRenamed).not.toHaveBeenCalled();
  });

  it("el botón de mostrar cambia el tipo de los dos campos de contraseña", async () => {
    const user = montar();
    const dialog = await abrir(user);
    const nueva = within(dialog).getByLabelText("Contraseña nueva");
    const confirmar = within(dialog).getByLabelText("Confirmar contraseña");
    expect(nueva).toHaveAttribute("type", "password");
    expect(confirmar).toHaveAttribute("type", "password");

    await user.click(within(dialog).getByRole("button", { name: "Mostrar contraseñas" }));
    expect(nueva).toHaveAttribute("type", "text");
    expect(confirmar).toHaveAttribute("type", "text");
  });

  it("al cerrar el modal se borran las contraseñas escritas", async () => {
    const user = montar();
    let dialog = await abrir(user);
    await user.type(within(dialog).getByLabelText("Contraseña nueva"), "clave-larga-1");
    await user.type(within(dialog).getByLabelText("Confirmar contraseña"), "clave-larga-1");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await abrir(user);
    expect(within(dialog).getByLabelText("Contraseña nueva")).toHaveValue("");
    expect(within(dialog).getByLabelText("Confirmar contraseña")).toHaveValue("");
  });
});
