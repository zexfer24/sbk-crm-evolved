/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { QuickRepliesModal } from "@/components/chat/quick-replies-modal";
import type { CatalogLink, QuickReply } from "@/lib/types";

// ---------------------------------------------------------------------------
// T4b, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
// D4/D6). Estos tests cubren lo que se agregó a `QuickRepliesModal`: el
// botón "Insertar catálogo" (pega el marcador en el cursor, nunca al final)
// y la marca de "marcador sin resolver" sobre la lista -- el comportamiento
// de guardar/editar/borrar un mensaje rápido ya no cambió con esta tarea y
// no se repite acá.
// ---------------------------------------------------------------------------

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/mutations", () => ({
  createQuickReply: vi.fn(),
  updateQuickReply: vi.fn(),
  deleteQuickReply: vi.fn(),
}));

function crearUsuario() {
  // Mismo criterio que el resto de la suite (CLAUDE.md, trampa de
  // contención de la suite en Windows): sin delay real ni el chequeo de
  // pointer-events que sube todo el árbol en cada clic.
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function catalogo(overrides: Partial<CatalogLink> = {}): CatalogLink {
  return {
    id: `cat-${Math.random().toString(36).slice(2)}`,
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/file/d/cascos",
    sortOrder: 1,
    isActive: true,
    updatedBy: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function mensajeRapido(overrides: Partial<QuickReply> = {}): QuickReply {
  return {
    id: `qr-${Math.random().toString(36).slice(2)}`,
    label: "Catálogo general",
    content: "Acá va nuestro catálogo 👇",
    ...overrides,
  };
}

function renderModal(props: Partial<ComponentProps<typeof QuickRepliesModal>> = {}) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <QuickRepliesModal
      isOpen
      onOpenChange={onOpenChange}
      quickReplies={[]}
      catalogLinks={[]}
      onSelect={onSelect}
      {...props}
    />
  );
  return { ...utils, onSelect, onOpenChange };
}

async function abrirFormulario(user: ReturnType<typeof crearUsuario>) {
  await user.click(screen.getByRole("button", { name: "Nuevo mensaje rápido" }));
}

describe("QuickRepliesModal — Insertar catálogo", () => {
  it("pega el marcador de un catálogo elegido del menú", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [catalogo({ key: "cascos", label: "Cascos" })] });

    await abrirFormulario(user);
    await user.click(screen.getByRole("button", { name: "Insertar catálogo" }));
    await user.click(screen.getByRole("menuitem", { name: "Cascos" }));

    const textarea = screen.getByLabelText("Mensaje") as HTMLTextAreaElement;
    expect(textarea.value).toBe("{{catalogo:cascos}}");
  });

  it('"Todos los catálogos" pega el marcador de la lista completa', async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [catalogo()] });

    await abrirFormulario(user);
    await user.click(screen.getByRole("button", { name: "Insertar catálogo" }));
    await user.click(screen.getByRole("menuitem", { name: "Todos los catálogos" }));

    const textarea = screen.getByLabelText("Mensaje") as HTMLTextAreaElement;
    expect(textarea.value).toBe("{{catalogos}}");
  });

  it("inserta en la posición del cursor, no al final de lo ya escrito", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [catalogo({ key: "cascos", label: "Cascos" })] });

    await abrirFormulario(user);
    const textarea = screen.getByLabelText("Mensaje") as HTMLTextAreaElement;
    await user.type(textarea, "Acá va: ¡gracias!");
    // Justo después de "Acá va: " (8 caracteres), antes de "¡gracias!".
    textarea.setSelectionRange(8, 8);

    await user.click(screen.getByRole("button", { name: "Insertar catálogo" }));
    await user.click(screen.getByRole("menuitem", { name: "Cascos" }));

    expect(textarea.value).toBe("Acá va: {{catalogo:cascos}}¡gracias!");
  });

  it("un catálogo inactivo no aparece como opción del menú", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [catalogo({ key: "viejo", label: "Viejo", isActive: false })] });

    await abrirFormulario(user);
    await user.click(screen.getByRole("button", { name: "Insertar catálogo" }));

    expect(screen.queryByRole("menuitem", { name: "Viejo" })).not.toBeInTheDocument();
  });

  it("un enlace pegado a mano en el mensaje muestra el aviso", async () => {
    const user = crearUsuario();
    renderModal();

    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Mensaje"), "Mira este link https://drive.google.com/x");

    expect(screen.getByText(/enlace escrito a mano/)).toBeInTheDocument();
  });

  it("sin ningún enlace escrito a mano, no muestra el aviso", async () => {
    const user = crearUsuario();
    renderModal();

    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Mensaje"), "Un mensaje cualquiera, sin links.");

    expect(screen.queryByText(/enlace escrito a mano/)).not.toBeInTheDocument();
  });
});

describe("QuickRepliesModal — la lista marca los mensajes con marcador sin resolver", () => {
  it("un {{catalogo:<key>}} que no calza con ningún catálogo activo lleva la marca", () => {
    renderModal({
      quickReplies: [mensajeRapido({ content: "Acá va {{catalogo:cascos}}" })],
      catalogLinks: [],
    });

    expect(screen.getByText("Marcador sin resolver")).toBeInTheDocument();
  });

  it("un catálogo INACTIVO en la tabla también deja el marcador sin resolver (D6)", () => {
    renderModal({
      quickReplies: [mensajeRapido({ content: "Acá va {{catalogo:cascos}}" })],
      catalogLinks: [catalogo({ key: "cascos", isActive: false })],
    });

    expect(screen.getByText("Marcador sin resolver")).toBeInTheDocument();
  });

  it("un mensaje rápido con su catálogo activo no lleva la marca", () => {
    renderModal({
      quickReplies: [mensajeRapido({ content: "Acá va {{catalogo:cascos}}" })],
      catalogLinks: [catalogo({ key: "cascos" })],
    });

    expect(screen.queryByText("Marcador sin resolver")).not.toBeInTheDocument();
  });

  it("un mensaje rápido sin marcador nunca lleva la marca", () => {
    renderModal({
      quickReplies: [mensajeRapido({ content: "Un mensaje cualquiera, sin catálogo." })],
      catalogLinks: [],
    });

    expect(screen.queryByText("Marcador sin resolver")).not.toBeInTheDocument();
  });
});
