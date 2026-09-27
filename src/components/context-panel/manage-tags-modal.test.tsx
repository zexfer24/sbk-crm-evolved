/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManageTagsModal } from "@/components/context-panel/manage-tags-modal";
import type { Tag } from "@/lib/types";
import { toast } from "@heroui/react";

/**
 * T6, plan "El mostrador busca sin salir del chat" (27/9/2026, D4).
 *
 * Hasta esta corrida este modal solo creaba/editaba/borraba etiquetas
 * globales; aplicar o quitar una etiqueta de ESTE contacto vivía en
 * `ContextPanel` (la lista de botones "+" que D4 le quita). La sección nueva
 * "En este chat" hace ese trabajo desde acá — mismo manejo de error con
 * `toast.danger` que tenía `ContextPanel`.
 */

const addTagToContact = vi.fn().mockResolvedValue(undefined);
const removeTagFromContact = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/mutations", () => ({
  addTagToContact: (...args: unknown[]) => addTagToContact(...args),
  removeTagFromContact: (...args: unknown[]) => removeTagFromContact(...args),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { ...real.toast, danger: vi.fn(), success: vi.fn() } };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));

const ALL_TAGS: Tag[] = [
  { id: "tag-1", label: "VIP", color: "accent" },
  { id: "tag-2", label: "Mayorista", color: "success" },
  { id: "tag-3", label: "Premium", color: "warning" },
];

beforeEach(() => {
  addTagToContact.mockClear();
  removeTagFromContact.mockClear();
  vi.mocked(toast.danger).mockClear();
});

function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function renderModal(contactTags: Tag[] = [ALL_TAGS[0]], onContactTagsChanged?: () => void) {
  return render(
    <ManageTagsModal
      isOpen
      onOpenChange={() => {}}
      tags={ALL_TAGS}
      contactId="contact-1"
      contactTags={contactTags}
      onContactTagsChanged={onContactTagsChanged}
    />
  );
}

describe("ManageTagsModal — sección 'En este chat' (D4)", () => {
  it("lista las etiquetas ya aplicadas al contacto, con botón para quitar", () => {
    renderModal();
    expect(screen.getByLabelText("Quitar etiqueta VIP de este contacto")).toBeInTheDocument();
  });

  it("lista las disponibles para aplicar", () => {
    renderModal();
    expect(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto")).toBeInTheDocument();
  });

  it("aplicar llama a addTagToContact con el contacto y la etiqueta correctos", async () => {
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));

    await waitFor(() => expect(addTagToContact).toHaveBeenCalledTimes(1));
    expect(addTagToContact).toHaveBeenCalledWith(expect.anything(), "contact-1", "tag-2");
  });

  it("aplicar con éxito avisa con onContactTagsChanged (hallazgo 1)", async () => {
    const onContactTagsChanged = vi.fn();
    const user = crearUsuario();
    renderModal([ALL_TAGS[0]], onContactTagsChanged);

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));

    await waitFor(() => expect(addTagToContact).toHaveBeenCalledTimes(1));
    expect(onContactTagsChanged).toHaveBeenCalledTimes(1);
  });

  it("un fallo al aplicar NO llama a onContactTagsChanged", async () => {
    addTagToContact.mockRejectedValueOnce(new Error("fail"));
    const onContactTagsChanged = vi.fn();
    const user = crearUsuario();
    renderModal([ALL_TAGS[0]], onContactTagsChanged);

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));

    await waitFor(() => expect(toast.danger).toHaveBeenCalledTimes(1));
    expect(onContactTagsChanged).not.toHaveBeenCalled();
  });

  it("quitar llama a removeTagFromContact con el contacto y la etiqueta correctos", async () => {
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Quitar etiqueta VIP de este contacto"));

    await waitFor(() => expect(removeTagFromContact).toHaveBeenCalledTimes(1));
    expect(removeTagFromContact).toHaveBeenCalledWith(expect.anything(), "contact-1", "tag-1");
  });

  it("un fallo al aplicar avisa con toast, sin tumbar el modal", async () => {
    addTagToContact.mockRejectedValueOnce(new Error("fail"));
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));

    await waitFor(() => expect(toast.danger).toHaveBeenCalledTimes(1));
  });

  it("sin etiquetas disponibles para aplicar lo dice en vez de mostrar la lista vacía", () => {
    renderModal(ALL_TAGS);
    expect(screen.getByText(/ya tiene todas las etiquetas/i)).toBeInTheDocument();
  });

  it("sigue permitiendo crear una etiqueta nueva desde abajo", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /nueva etiqueta/i })).toBeInTheDocument();
  });

  it("separa 'En este chat' de la lista global con su propio encabezado", () => {
    renderModal();
    expect(screen.getByText("En este chat")).toBeInTheDocument();
    expect(screen.getByText("Todas las etiquetas")).toBeInTheDocument();
  });
});

/**
 * Revisión del orquestador de T6 (28/9/2026): sin refresco optimista, un
 * asesor que aplicaba "Moroso" seguía viendo el botón "+" (la mutación tarda
 * un viaje a la base y el prop `contactTags` recién se actualiza cuando
 * `crm-shell.tsx` vuelve a pedir la conversación) — pulsaba de nuevo, y la
 * segunda inserción chocaba con la clave única de `contact_tags`. Ahora el
 * modal mueve la etiqueta al instante, sin esperar la respuesta del
 * servidor, y la reconcilia con la prop nueva cuando llega (o revierte si la
 * mutación falla).
 */
function promesaControlada<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ManageTagsModal — aplicar/quitar es optimista y evita el doble clic", () => {
  it("aplicar mueve la etiqueta a 'aplicadas' al instante, antes de que la mutación resuelva", async () => {
    const { promise } = promesaControlada<void>();
    addTagToContact.mockReturnValueOnce(promise);
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));

    // Sin esperar nada más: el clic ya la movió, con la mutación todavía en
    // vuelo (la promesa de arriba no se resolvió).
    expect(screen.getByLabelText("Quitar etiqueta Mayorista de este contacto")).toBeInTheDocument();
    expect(screen.queryByLabelText("Aplicar etiqueta Mayorista a este contacto")).not.toBeInTheDocument();
  });

  it("mientras la aplicación está en vuelo, el botón queda deshabilitado (no se puede volver a pulsar)", async () => {
    const { promise } = promesaControlada<void>();
    addTagToContact.mockReturnValueOnce(promise);
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));

    // La etiqueta ya se movió a "aplicadas": el botón que queda deshabilitado
    // es el de QUITAR (el que vive del lado donde ahora está la etiqueta),
    // porque un segundo clic ahí dispararía una quita sobre una aplicación
    // que ni siquiera terminó de confirmarse.
    expect(screen.getByLabelText("Quitar etiqueta Mayorista de este contacto")).toBeDisabled();
  });

  it("si la mutación de aplicar falla, revierte el movimiento optimista", async () => {
    const { promise, reject } = promesaControlada<void>();
    addTagToContact.mockReturnValueOnce(promise);
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));
    expect(screen.getByLabelText("Quitar etiqueta Mayorista de este contacto")).toBeInTheDocument();

    reject(new Error("fail"));
    await waitFor(() =>
      expect(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto")).toBeInTheDocument()
    );
    expect(screen.queryByLabelText("Quitar etiqueta Mayorista de este contacto")).not.toBeInTheDocument();
    expect(toast.danger).toHaveBeenCalledTimes(1);
  });

  it("quitar mueve la etiqueta a 'disponibles' al instante, y revierte si la mutación falla", async () => {
    const { promise, reject } = promesaControlada<void>();
    removeTagFromContact.mockReturnValueOnce(promise);
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Quitar etiqueta VIP de este contacto"));
    expect(screen.getByLabelText("Aplicar etiqueta VIP a este contacto")).toBeInTheDocument();
    expect(screen.getByLabelText("Aplicar etiqueta VIP a este contacto")).toBeDisabled();

    reject(new Error("fail"));
    await waitFor(() =>
      expect(screen.getByLabelText("Quitar etiqueta VIP de este contacto")).toBeInTheDocument()
    );
    expect(screen.queryByLabelText("Aplicar etiqueta VIP a este contacto")).not.toBeInTheDocument();
    expect(toast.danger).toHaveBeenCalledTimes(1);
  });

  it("una etiqueta aplicada con éxito se reconcilia cuando la prop trae la confirmación", async () => {
    addTagToContact.mockResolvedValueOnce(undefined);
    const user = crearUsuario();
    const { rerender } = renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));
    await waitFor(() => expect(addTagToContact).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Quitar etiqueta Mayorista de este contacto")).toBeInTheDocument();

    // Lo que haría `crm-shell.tsx` al refrescar tras el evento de realtime:
    // la prop llega con la etiqueta ya confirmada por la base.
    rerender(
      <ManageTagsModal
        isOpen
        onOpenChange={() => {}}
        tags={ALL_TAGS}
        contactId="contact-1"
        contactTags={[ALL_TAGS[0], ALL_TAGS[1]]}
      />
    );

    expect(screen.getByLabelText("Quitar etiqueta Mayorista de este contacto")).toBeInTheDocument();
    expect(screen.getByLabelText("Quitar etiqueta Mayorista de este contacto")).not.toBeDisabled();
  });
});

/**
 * Hallazgo 5, `code-review high` sobre d38a7e1..HEAD (27/9/2026): un solo
 * `busyTagId` para TODAS las etiquetas — clic en A y enseguida en B mientras
 * A sigue en vuelo pisaba el id de A en `busyTagId`, y el `finally` de A (que
 * resuelve primero) volvía a habilitar el botón de B aunque B siguiera
 * viajando. Además, la reconciliación con la prop DURANTE el render
 * descartaba cualquier optimismo pendiente: si la prop nueva solo traía la
 * confirmación de A, `optimisticTags` se reemplazaba entero por esa prop y B
 * "parpadeaba" de vuelta a disponibles hasta que su propia respuesta llegara.
 */
describe("ManageTagsModal — dos etiquetas en vuelo a la vez no se pisan", () => {
  it("A y B en vuelo a la vez: el finally de A no habilita el botón de B", async () => {
    const a = promesaControlada<void>();
    const b = promesaControlada<void>();
    addTagToContact.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const user = crearUsuario();
    renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));
    await user.click(screen.getByLabelText("Aplicar etiqueta Premium a este contacto"));

    // Se resuelve A (la primera) mientras B sigue en vuelo.
    a.resolve();
    await waitFor(() => expect(addTagToContact).toHaveBeenCalledTimes(2));

    // El botón de B (todavía sin confirmar) tiene que seguir deshabilitado:
    // con un solo `busyTagId`, el `finally` de A lo habilitaba igual.
    expect(screen.getByLabelText("Quitar etiqueta Premium de este contacto")).toBeDisabled();
    // El de A, ya resuelto, queda habilitado.
    expect(screen.getByLabelText("Quitar etiqueta Mayorista de este contacto")).not.toBeDisabled();

    b.resolve();
    await waitFor(() =>
      expect(screen.getByLabelText("Quitar etiqueta Premium de este contacto")).not.toBeDisabled()
    );
  });

  it("llega prop nueva con solo A confirmada: B sigue aplicada y deshabilitada (no parpadea)", async () => {
    const a = promesaControlada<void>();
    const b = promesaControlada<void>();
    addTagToContact.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const user = crearUsuario();
    const { rerender } = renderModal();

    await user.click(screen.getByLabelText("Aplicar etiqueta Mayorista a este contacto"));
    await user.click(screen.getByLabelText("Aplicar etiqueta Premium a este contacto"));

    a.resolve();
    await waitFor(() => expect(addTagToContact).toHaveBeenCalledTimes(2));

    // Lo que haría `crm-shell.tsx` al refrescar: la prop trae SOLO la
    // confirmación de A (Mayorista) — B (Premium) sigue en vuelo del lado
    // del servidor.
    rerender(
      <ManageTagsModal
        isOpen
        onOpenChange={() => {}}
        tags={ALL_TAGS}
        contactId="contact-1"
        contactTags={[ALL_TAGS[0], ALL_TAGS[1]]}
      />
    );

    // B no puede parpadear de vuelta a "disponible": la reconciliación tiene
    // que reaplicar la operación pendiente sobre la lista fresca del server.
    expect(screen.getByLabelText("Quitar etiqueta Premium de este contacto")).toBeInTheDocument();
    expect(screen.getByLabelText("Quitar etiqueta Premium de este contacto")).toBeDisabled();
    expect(screen.queryByLabelText("Aplicar etiqueta Premium a este contacto")).not.toBeInTheDocument();

    b.resolve();
    await waitFor(() =>
      expect(screen.getByLabelText("Quitar etiqueta Premium de este contacto")).not.toBeDisabled()
    );
  });
});
