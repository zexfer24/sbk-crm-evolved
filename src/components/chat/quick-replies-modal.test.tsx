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

/**
 * T7, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026). Causa confirmada en producción: "CATALOGO CASCOS"
 * llevaba la URL de Drive escrita a mano (`1wWJ1PvF…`) y `catalog_links.cascos`
 * otra (`1oDrYm…`): los asesores y Seba mandaban links distintos. `quick_replies`
 * lo escribe cualquier asesor, así que el aviso tiene que aparecer al escribir.
 */
describe("QuickRepliesModal — aviso de URL de Drive escrita a mano (T7)", () => {
  const aviso = /Usá el marcador para que Seba y los asesores manden el mismo link/;
  const cascos = catalogo({ key: "cascos", label: "Cascos", url: "https://drive.google.com/file/d/1oDrYmAAA/view" });

  it("una URL que coincide con un catálogo configurado avisa y ofrece el marcador exacto", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [cascos] });

    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Título"), "CATALOGO CASCOS");
    await user.click(screen.getByLabelText("Mensaje"));
    await user.paste("Catálogo: https://drive.google.com/file/d/1oDrYmAAA/view");

    expect(screen.getByText(aviso)).toBeInTheDocument();
    expect(screen.getByText(/el marcador es \{\{catalogo:cascos\}\}/)).toBeInTheDocument();
  });

  it('"Reemplazar por el marcador" cambia la URL por {{catalogo:cascos}} en el texto', async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [cascos] });

    await abrirFormulario(user);
    await user.click(screen.getByLabelText("Mensaje"));
    await user.paste("Catálogo: https://drive.google.com/file/d/1oDrYmAAA/view gracias");
    await user.click(screen.getByRole("button", { name: "Reemplazar por {{catalogo:cascos}}" }));

    expect((screen.getByLabelText("Mensaje") as HTMLTextAreaElement).value).toBe("Catálogo: {{catalogo:cascos}} gracias");
    expect(screen.queryByText(aviso)).not.toBeInTheDocument();
  });

  it("el caso real: título 'CATALOGO CASCOS' con otro ID de Drive avisa SIN marcador sugerido", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [cascos] });

    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Título"), "CATALOGO CASCOS");
    await user.click(screen.getByLabelText("Mensaje"));
    await user.paste("Catálogo de cascos: https://drive.google.com/file/d/1wWJ1PvFBBB/view");

    expect(screen.getByText(aviso)).toBeInTheDocument();
    expect(screen.getByText(/no coincide con ningún catálogo configurado/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reemplazar por/ })).not.toBeInTheDocument();
  });

  it("una URL de Drive que no parece catálogo (foto suelta) cae en el aviso genérico, no en este", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [cascos] });

    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Título"), "Foto del local");
    await user.click(screen.getByLabelText("Mensaje"));
    await user.paste("Mira: https://drive.google.com/file/d/1foto/view");

    expect(screen.queryByText(aviso)).not.toBeInTheDocument();
    expect(screen.getByText(/enlace escrito a mano/)).toBeInTheDocument();
  });

  it("sin URL de Drive no hay aviso", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [cascos] });

    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Mensaje"), "Acá va {{catalogo:cascos}}");

    expect(screen.queryByText(aviso)).not.toBeInTheDocument();
  });

  it("la lista marca los mensajes rápidos guardados con un enlace de Drive a mano", () => {
    renderModal({
      quickReplies: [
        mensajeRapido({ label: "CATALOGO CASCOS", content: "Catálogo: https://drive.google.com/file/d/1wWJ1PvFBBB/view" }),
        mensajeRapido({ label: "Gracias", content: "Gracias por tu compra." }),
      ],
      catalogLinks: [cascos],
    });

    expect(screen.getAllByText("Enlace de Drive escrito a mano")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// "La píldora del modal de mensajes rápidos" (T2, plan "La ronda del cliente",
// 30/9/2026). El cliente veía una píldora en el modal, sobre todo al EDITAR un
// mensaje. Diagnosticado en el navegador: no era el tooltip del botón ⚡
// (cerrado), ni las píldoras de la bandeja a través del backdrop, ni un
// z-index suelto -- era el propio panel del formulario. `rounded-field` es
// `--field-radius: 999px` en `theme.css` (los INPUTS son píldora a propósito),
// y el panel `div.rounded-field` que envuelve Título + Mensaje medía 464x246:
// con 999px de radio un rectángulo de esa altura se dibuja como un óvalo
// gigante que corta el textarea. Lo mismo, en menor grado, en cada fila de la
// lista y en el menú de "Insertar catálogo". Los contenedores usan el radio
// de tarjeta (`--radius`, 0,875 rem); `rounded-field` queda solo para campos.
// jsdom no calcula layout, así que el test fija la CLASE de cada contenedor.
// ---------------------------------------------------------------------------
describe("QuickRepliesModal — los contenedores no son píldoras (T2, 30/9/2026)", () => {
  it("el panel del formulario de edición usa el radio de tarjeta, no el de campo (999px)", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [mensajeRapido({ label: "Horario de atención" })] });

    await user.click(screen.getByRole("button", { name: "Editar" }));

    const panel = screen.getByLabelText("Título").closest("div.border") as HTMLElement;
    expect(panel, "no se encontró el panel del formulario").not.toBeNull();
    expect(panel.className).not.toContain("rounded-field");
    expect(panel.className).toContain("rounded-[var(--radius)]");
  });

  it("las filas de la lista usan el radio de tarjeta", () => {
    renderModal({ quickReplies: [mensajeRapido({ label: "Horario de atención" })] });

    const fila = screen.getByText("Horario de atención").closest("div.border") as HTMLElement;
    expect(fila, "no se encontró la fila").not.toBeNull();
    expect(fila.className).not.toContain("rounded-field");
    expect(fila.className).toContain("rounded-[var(--radius)]");
  });

  it("el menú de «Insertar catálogo» usa el radio de tarjeta", async () => {
    const user = crearUsuario();
    renderModal({ catalogLinks: [catalogo()] });

    await abrirFormulario(user);
    await user.click(screen.getByRole("button", { name: /Insertar catálogo/ }));

    const menu = screen.getByRole("menu", { name: "Catálogos" });
    expect(menu.className).not.toContain("rounded-field");
    expect(menu.className).toContain("rounded-[var(--radius)]");
  });
});
