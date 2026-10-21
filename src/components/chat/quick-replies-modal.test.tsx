/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@heroui/react";
import type { ComponentProps } from "react";
import { QuickRepliesModal, __reiniciarCacheMasUsados } from "@/components/chat/quick-replies-modal";
import type { CatalogLink, QuickReply } from "@/lib/types";
import { createQuickReply, deleteQuickReply, updateQuickReply, uploadQuickReplyPhoto } from "@/lib/mutations";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import { fetchMensajesRapidosMasUsados } from "@/lib/data";

// ---------------------------------------------------------------------------
// T4b, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
// D4/D6). Estos tests cubren lo que se agregó a `QuickRepliesModal`: el
// botón "Insertar catálogo" (pega el marcador en el cursor, nunca al final)
// y la marca de "marcador sin resolver" sobre la lista -- el comportamiento
// de guardar/editar/borrar un mensaje rápido ya no cambió con esta tarea y
// no se repite acá.
// ---------------------------------------------------------------------------

// El toast real de HeroUI no aporta nada acá (mismo patrón que
// catalog-links-panel.test.tsx); el resto del módulo queda intacto.
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() } };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

// T8 (21/10/2026): el modal pide el ranking «Más usados» a la RPC; los tests no
// necesitan el resto de `data.ts` (que arrastra medio CRM).
vi.mock("@/lib/data", () => ({
  fetchMensajesRapidosMasUsados: vi.fn(),
}));

vi.mock("@/lib/mutations", () => ({
  createQuickReply: vi.fn(),
  updateQuickReply: vi.fn(),
  deleteQuickReply: vi.fn(),
  uploadQuickReplyPhoto: vi.fn(),
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
    ownerId: null,
    mediaPaths: [],
    ...overrides,
  };
}

const ASESOR_ID = "agente-ana";

function renderModal(props: Partial<ComponentProps<typeof QuickRepliesModal>> = {}) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <QuickRepliesModal
      isOpen
      onOpenChange={onOpenChange}
      quickReplies={[]}
      catalogLinks={[]}
      currentAgentId={ASESOR_ID}
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

// ---------------------------------------------------------------------------
// T5b, plan "La ronda del cliente" (30/9/2026): mensajes rápidos PERSONALES.
// La RLS (migración 20261001010000) ya entrega solo los compartidos y los del
// propio asesor; el modal los separa en dos pestañas por `ownerId`.
// ---------------------------------------------------------------------------
describe("QuickRepliesModal — pestañas «Compartidos» y «Mis mensajes» (T5b)", () => {
  const compartidos = [
    mensajeRapido({ id: "c1", label: "Horario", content: "Atendemos de 8 a 18." }),
    mensajeRapido({ id: "c2", label: "Ubicación", content: "Estamos en Barinas." }),
    mensajeRapido({ id: "c3", label: "Garantía", content: "Tiene 30 días." }),
  ];
  const propios = [
    mensajeRapido({ id: "p1", label: "Buenos días", content: "Buen día, soy Ana.", ownerId: ASESOR_ID }),
    mensajeRapido({ id: "p2", label: "Buenas tardes", content: "Buenas tardes, soy Ana.", ownerId: ASESOR_ID }),
  ];

  it("muestra las dos pestañas, cada una con su conteo", () => {
    renderModal({ quickReplies: [...compartidos, ...propios] });

    expect(screen.getByRole("tab", { name: /^Compartidos\s*3$/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Mis mensajes\s*2$/ })).toBeInTheDocument();
  });

  it("abre en «Mis mensajes» cuando el asesor tiene al menos uno propio", () => {
    renderModal({ quickReplies: [...compartidos, ...propios] });

    expect(screen.getByRole("tab", { name: /^Mis mensajes/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Buenos días")).toBeInTheDocument();
    expect(screen.queryByText("Horario")).not.toBeInTheDocument();
  });

  it("abre en «Compartidos» cuando el asesor no tiene ninguno propio", () => {
    renderModal({ quickReplies: compartidos });

    expect(screen.getByRole("tab", { name: /^Compartidos/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Horario")).toBeInTheDocument();
  });

  it("cada pestaña lista solo lo suyo, ordenado por título", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [...compartidos, ...propios] });

    await user.click(screen.getByRole("tab", { name: /^Compartidos/ }));

    expect(screen.queryByText("Buenos días")).not.toBeInTheDocument();
    const titulos = screen.getAllByText(/^(Horario|Ubicación|Garantía)$/).map((el) => el.textContent);
    expect(titulos).toEqual(["Garantía", "Horario", "Ubicación"]);
  });

  it("un mensaje de OTRO asesor que llegara a la lista no se muestra en ninguna pestaña", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [...compartidos, mensajeRapido({ label: "Ajeno", ownerId: "otro-asesor" })] });

    expect(screen.queryByText("Ajeno")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^Mis mensajes/ }));
    expect(screen.queryByText("Ajeno")).not.toBeInTheDocument();
  });

  it("«Mis mensajes» vacío explica para qué sirve", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: compartidos });

    await user.click(screen.getByRole("tab", { name: /^Mis mensajes/ }));

    expect(
      screen.getByText("Todavía no tienes mensajes propios. Crea tus saludos con tu nombre: solo tú los verás.")
    ).toBeInTheDocument();
  });

  it("«Usar» funciona igual en las dos pestañas", async () => {
    const user = crearUsuario();
    const { onSelect } = renderModal({ quickReplies: [...compartidos, ...propios] });

    // Ordenado por título: «Buenas tardes» va antes que «Buenos días».
    await user.click(screen.getAllByRole("button", { name: "Usar" })[0]);
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ content: "Buenas tardes, soy Ana." }));

    await user.click(screen.getByRole("tab", { name: /^Compartidos/ }));
    // Ordenado por título: «Garantía» es la primera.
    await user.click(screen.getAllByRole("button", { name: "Usar" })[0]);
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ content: "Tiene 30 días." }));
  });
});

describe("QuickRepliesModal — crear un mensaje personal o compartido (T5b)", () => {
  const propio = mensajeRapido({ id: "p1", label: "Buenos días", ownerId: ASESOR_ID });
  const compartido = mensajeRapido({ id: "c1", label: "Horario", content: "Atendemos de 8 a 18." });

  async function llenarYGuardar(user: ReturnType<typeof crearUsuario>) {
    await user.type(screen.getByLabelText("Título"), "Buenas noches");
    await user.type(screen.getByLabelText("Mensaje"), "Buenas noches, soy Ana.");
    await user.click(screen.getByRole("button", { name: "Agregar" }));
  }

  it("desde «Mis mensajes», «Solo para mí» viene marcado y crea con el id del asesor", async () => {
    const user = crearUsuario();
    vi.mocked(createQuickReply).mockClear();
    renderModal({ quickReplies: [propio, compartido] });

    await abrirFormulario(user);
    expect(screen.getByRole("checkbox", { name: "Solo para mí" })).toBeChecked();
    await llenarYGuardar(user);

    expect(createQuickReply).toHaveBeenCalledWith(
      expect.anything(),
      "Buenas noches",
      "Buenas noches, soy Ana.",
      ASESOR_ID,
      []
    );
  });

  it("desde «Compartidos», «Solo para mí» viene desmarcado y crea con null", async () => {
    const user = crearUsuario();
    vi.mocked(createQuickReply).mockClear();
    renderModal({ quickReplies: [compartido] });

    await abrirFormulario(user);
    expect(screen.getByRole("checkbox", { name: "Solo para mí" })).not.toBeChecked();
    await llenarYGuardar(user);

    expect(createQuickReply).toHaveBeenCalledWith(expect.anything(), "Buenas noches", "Buenas noches, soy Ana.", null, []);
  });

  it("desmarcar «Solo para mí» en «Mis mensajes» crea un compartido (null)", async () => {
    const user = crearUsuario();
    vi.mocked(createQuickReply).mockClear();
    renderModal({ quickReplies: [propio] });

    await abrirFormulario(user);
    await user.click(screen.getByRole("checkbox", { name: "Solo para mí" }));
    await llenarYGuardar(user);

    expect(createQuickReply).toHaveBeenCalledWith(expect.anything(), "Buenas noches", "Buenas noches, soy Ana.", null, []);
  });

  it("marcar «Solo para mí» en «Compartidos» crea un personal", async () => {
    const user = crearUsuario();
    vi.mocked(createQuickReply).mockClear();
    renderModal({ quickReplies: [compartido] });

    await abrirFormulario(user);
    await user.click(screen.getByRole("checkbox", { name: "Solo para mí" }));
    await llenarYGuardar(user);

    expect(createQuickReply).toHaveBeenCalledWith(
      expect.anything(),
      "Buenas noches",
      "Buenas noches, soy Ana.",
      ASESOR_ID,
      []
    );
  });

  it("al EDITAR no aparece «Solo para mí»: un mensaje no cambia de tipo", async () => {
    const user = crearUsuario();
    vi.mocked(updateQuickReply).mockClear();
    renderModal({ quickReplies: [propio, compartido] });

    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(screen.queryByRole("checkbox", { name: "Solo para mí" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(updateQuickReply).toHaveBeenCalledWith(expect.anything(), "p1", "Buenos días", expect.any(String), []);
  });

  it("un rechazo por permiso muestra el mensaje propio en el toast, no el genérico", async () => {
    const user = crearUsuario();
    const { toast } = await import("@heroui/react");
    vi.mocked(deleteQuickReply).mockRejectedValueOnce(
      new ConfigWriteDeniedError("Este mensaje rápido ya no existe o no es tuyo.")
    );
    renderModal({ quickReplies: [propio] });

    // 21/10/2026 (T7): borrar pide confirmación dentro del renglón.
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    expect(toast.danger).toHaveBeenCalledWith("Este mensaje rápido ya no existe o no es tuyo.");
  });

  it("un error de red al borrar conserva el texto genérico", async () => {
    const user = crearUsuario();
    const { toast } = await import("@heroui/react");
    vi.mocked(deleteQuickReply).mockRejectedValueOnce(new Error("fetch failed"));
    renderModal({ quickReplies: [propio] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    expect(toast.danger).toHaveBeenCalledWith("No se pudo borrar el mensaje rápido.");
  });
});

// ---------------------------------------------------------------------------
// 14/10/2026, "Respuestas rápidas con fotos": hasta 10 fotos JPG/PNG (≤ 5 MB)
// por respuesta. El modal las sube al elegirlas (Guardar espera a que
// terminen), muestra miniaturas con su ✕ y permite guardar una respuesta de
// SOLO fotos. El input es `hidden` y tiene `accept`, y `user.upload` respeta
// `accept` (filtraría justo los tipos inválidos que se quieren probar), así
// que los archivos se entregan con `fireEvent.change`.
// ---------------------------------------------------------------------------
describe("QuickRepliesModal — fotos (14/10/2026)", () => {
  const foto = (name = "casco.jpg", type = "image/jpeg", size = 1000) => {
    const file = new File([new Uint8Array(1)], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
  };

  function inputDeFotos(container: HTMLElement) {
    return container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement;
  }

  function elegir(container: HTMLElement, files: File[]) {
    fireEvent.change(inputDeFotos(container), { target: { files } });
  }

  const conFotos = (n: number) =>
    mensajeRapido({
      id: "f1",
      label: "Cascos",
      content: "Mira estos",
      mediaPaths: Array.from({ length: n }, (_, i) => `quick-replies/${i}.jpg`),
    });

  async function toastDanger() {
    const { toast } = await import("@heroui/react");
    return vi.mocked(toast.danger);
  }

  beforeEach(async () => {
    vi.mocked(uploadQuickReplyPhoto).mockReset();
    vi.mocked(createQuickReply).mockClear();
    vi.mocked(updateQuickReply).mockClear();
    (await toastDanger()).mockClear();
  });

  it("el input solo ofrece JPG y PNG, admite varios y el botón «Agregar fotos» lo abre", async () => {
    const user = crearUsuario();
    const { container } = renderModal();
    await abrirFormulario(user);

    const input = inputDeFotos(container);
    expect(input.accept).toBe("image/jpeg,image/png");
    expect(input.multiple).toBe(true);
    const clic = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Agregar fotos" }));
    expect(clic).toHaveBeenCalled();
  });

  it("al elegir fotos las sube y muestra su miniatura con la URL propia del CRM", async () => {
    const user = crearUsuario();
    vi.mocked(uploadQuickReplyPhoto)
      .mockResolvedValueOnce("quick-replies/a.jpg")
      .mockResolvedValueOnce("quick-replies/b.png");
    const { container } = renderModal();
    await abrirFormulario(user);

    const a = foto("a.jpg");
    const b = foto("b.png", "image/png");
    elegir(container, [a, b]);

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(uploadQuickReplyPhoto).toHaveBeenCalledWith(expect.anything(), a);
    expect(uploadQuickReplyPhoto).toHaveBeenCalledWith(expect.anything(), b);
    expect(screen.getByAltText("Foto 1 de la respuesta rápida")).toHaveAttribute(
      "src",
      "/api/media/quick-replies/a.jpg"
    );
    expect(screen.getByAltText("Foto 2 de la respuesta rápida")).toHaveAttribute(
      "src",
      "/api/media/quick-replies/b.png"
    );
    expect(screen.getByText("2 de 10")).toBeInTheDocument();
  });

  it("mientras sube dice «Subiendo…» y deshabilita Guardar", async () => {
    const user = crearUsuario();
    let terminar!: (ruta: string) => void;
    vi.mocked(uploadQuickReplyPhoto).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        terminar = resolve;
      })
    );
    const { container } = renderModal();
    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Título"), "Cascos");

    elegir(container, [foto()]);

    expect(await screen.findByText("Subiendo…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agregar" })).toBeDisabled();

    terminar("quick-replies/a.jpg");
    await waitFor(() => expect(screen.queryByText("Subiendo…")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Agregar" })).toBeEnabled();
  });

  it("un tipo no admitido muestra el error y no sube nada", async () => {
    const user = crearUsuario();
    const { container } = renderModal();
    await abrirFormulario(user);

    elegir(container, [foto("a.webp", "image/webp")]);

    expect(await toastDanger()).toHaveBeenCalledWith("Solo fotos JPG o PNG.");
    expect(uploadQuickReplyPhoto).not.toHaveBeenCalled();
  });

  it("una foto de más de 5 MB muestra el error con su nombre y no sube nada", async () => {
    const user = crearUsuario();
    const { container } = renderModal();
    await abrirFormulario(user);

    elegir(container, [foto("enorme.jpg", "image/jpeg", 5 * 1024 * 1024 + 1)]);

    expect(await toastDanger()).toHaveBeenCalledWith("La foto «enorme.jpg» pesa más de 5 MB.");
    expect(uploadQuickReplyPhoto).not.toHaveBeenCalled();
  });

  it("pasarse de 10 (contando las que ya tiene) muestra el error y no sube nada", async () => {
    const user = crearUsuario();
    const { container } = renderModal({ quickReplies: [conFotos(9)] });
    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getByText("9 de 10")).toBeInTheDocument();

    elegir(container, [foto("a.jpg"), foto("b.jpg")]);

    expect(await toastDanger()).toHaveBeenCalledWith("Máximo 10 fotos por respuesta rápida.");
    expect(uploadQuickReplyPhoto).not.toHaveBeenCalled();
  });

  it("quitar una foto la saca de la grilla y se guarda sin ella", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [conFotos(2)] });
    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getAllByRole("img")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Quitar foto 1" }));

    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("1 de 10")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(updateQuickReply).toHaveBeenCalledWith(expect.anything(), "f1", "Cascos", "Mira estos", [
      "quick-replies/1.jpg",
    ]);
  });

  it("guardar con SOLO fotos (sin texto) crea con content vacío y sus mediaPaths", async () => {
    const user = crearUsuario();
    vi.mocked(uploadQuickReplyPhoto).mockResolvedValueOnce("quick-replies/a.jpg");
    const { container } = renderModal();
    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Título"), "Cascos");
    elegir(container, [foto()]);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Agregar" }));

    expect(createQuickReply).toHaveBeenCalledWith(expect.anything(), "Cascos", "", null, ["quick-replies/a.jpg"]);
    expect(await toastDanger()).not.toHaveBeenCalled();
  });

  it("sin texto ni fotos no guarda y avisa", async () => {
    const user = crearUsuario();
    renderModal();
    await abrirFormulario(user);
    await user.type(screen.getByLabelText("Título"), "Vacío");

    await user.click(screen.getByRole("button", { name: "Agregar" }));

    expect(createQuickReply).not.toHaveBeenCalled();
    expect(await toastDanger()).toHaveBeenCalledWith("Escribe el mensaje o agrega al menos una foto.");
  });

  it("si una subida falla, avisa y conserva las que sí subieron", async () => {
    const user = crearUsuario();
    vi.mocked(uploadQuickReplyPhoto)
      .mockResolvedValueOnce("quick-replies/a.jpg")
      .mockRejectedValueOnce(new Error("bucket caído"));
    const { container } = renderModal();
    await abrirFormulario(user);

    elegir(container, [foto("a.jpg"), foto("b.jpg")]);

    const danger = await toastDanger();
    await waitFor(() => expect(danger).toHaveBeenCalledWith("bucket caído"));
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("la lista marca con «📷 N» las respuestas que llevan fotos, y solo esas", () => {
    renderModal({ quickReplies: [conFotos(3), mensajeRapido({ id: "s1", label: "Sin fotos" })] });

    expect(screen.getByLabelText("3 fotos")).toHaveTextContent("📷 3");
    expect(screen.getAllByText(/📷/)).toHaveLength(1);
  });

  it("con una sola foto el nombre accesible va en singular", () => {
    renderModal({ quickReplies: [conFotos(1)] });

    expect(screen.getByLabelText("1 foto")).toHaveTextContent("📷 1");
  });

  it("«Usar» entrega la respuesta ENTERA (con sus fotos), no solo el texto", async () => {
    const user = crearUsuario();
    const respuesta = conFotos(2);
    const { onSelect } = renderModal({ quickReplies: [respuesta] });

    await user.click(screen.getByRole("button", { name: "Usar" }));

    expect(onSelect).toHaveBeenCalledWith(respuesta);
  });
});

// ---------------------------------------------------------------------------
// 21/10/2026, "Presupuestos y mensajes rápidos" (T7): buscador por palabra
// clave (título primero, texto debajo), filtro Todos / Solo texto / Con fotos
// y confirmación de borrado DENTRO del renglón. La confirmación no es otro
// modal: este panel ya es un Modal y apilar dos en el teléfono deja
// inalcanzable el de atrás.
// ---------------------------------------------------------------------------
describe("QuickRepliesModal — buscador y filtro (T7, 21/10/2026)", () => {
  const catalogoGeneral = mensajeRapido({ id: "a", label: "Catálogo general", content: "Acá va nuestro catálogo 👇" });
  const horario = mensajeRapido({ id: "b", label: "Horario", content: "Atendemos de lunes a viernes." });
  const cascos = mensajeRapido({
    id: "c",
    label: "Cascos",
    content: "Mira el catálogo de cascos",
    mediaPaths: ["quick-replies/1.jpg", "quick-replies/2.jpg"],
  });
  const soloFotos = mensajeRapido({ id: "d", label: "Local", content: "", mediaPaths: ["quick-replies/3.jpg"] });
  const todos = [catalogoGeneral, horario, cascos, soloFotos];

  const buscador = () => screen.getByRole("searchbox", { name: "Buscar mensajes rápidos" });

  it("el campo de búsqueda existe, con su placeholder, y la lista arranca completa", () => {
    renderModal({ quickReplies: todos });

    expect(buscador()).toHaveAttribute("placeholder", "Buscar por título…");
    expect(screen.queryByText("También en el texto")).not.toBeInTheDocument();
    for (const titulo of ["Catálogo general", "Horario", "Cascos", "Local"]) {
      expect(screen.getByText(titulo)).toBeInTheDocument();
    }
  });

  it("escribir filtra: primero el título, y debajo «También en el texto» los que calzan solo en el cuerpo", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: todos });

    await user.type(buscador(), "CATALOGO");

    expect(screen.getByText("También en el texto")).toBeInTheDocument();
    expect(screen.queryByText("Horario")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Usar" })).toHaveLength(2);
    // Orden en el DOM: la fila del título, el encabezado, la fila del texto.
    const encabezado = screen.getByText("También en el texto");
    const filaTitulo = document.querySelector("mark")?.closest("div.border") as HTMLElement;
    const filaTexto = screen.getByText("Cascos").closest("div.border") as HTMLElement;
    expect(filaTitulo).not.toBeNull();
    expect(filaTitulo.compareDocumentPosition(encabezado) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(encabezado.compareDocumentPosition(filaTexto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("resalta con <mark> el trozo del título que calza, con su acento original", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [catalogoGeneral] });

    await user.type(buscador(), "cata");

    const marcas = Array.from(document.querySelectorAll("mark")).map((m) => m.textContent);
    expect(marcas).toEqual(["Catá"]);
  });

  it("sin encabezado «También en el texto» cuando nada calza solo en el cuerpo", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: todos });

    await user.type(buscador(), "horario");

    expect(screen.queryByText("También en el texto")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Usar" })).toHaveLength(1);
  });

  it("sin coincidencias dice «Ningún mensaje coincide con «{consulta}».»", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: todos });

    await user.type(buscador(), "zzz");

    expect(screen.getByText("Ningún mensaje coincide con «zzz».")).toBeInTheDocument();
  });

  it("«Con fotos» oculta los de solo texto, y «Solo texto» los que llevan fotos", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: todos });

    await user.click(screen.getByRole("button", { name: /^Con fotos/ }));
    expect(screen.queryByText("Horario")).not.toBeInTheDocument();
    expect(screen.queryByText("Catálogo general")).not.toBeInTheDocument();
    expect(screen.getByText("Cascos")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Solo texto/ }));
    expect(screen.queryByText("Cascos")).not.toBeInTheDocument();
    expect(screen.getByText("Horario")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Todos/ }));
    expect(screen.getAllByRole("button", { name: "Usar" })).toHaveLength(4);
  });

  it("el filtro de media se combina con la búsqueda", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: todos });

    await user.click(screen.getByRole("button", { name: /^Con fotos/ }));
    await user.type(buscador(), "catalogo");

    // «Catálogo general» no lleva fotos; «Cascos» sí y lo nombra en el texto.
    expect(screen.queryByText("Catálogo general")).not.toBeInTheDocument();
    expect(screen.getByText("También en el texto")).toBeInTheDocument();
    expect(screen.getByText("Cascos")).toBeInTheDocument();
  });

  it("cada filtro lleva el conteo de la pestaña activa", async () => {
    const user = crearUsuario();
    renderModal({
      quickReplies: [...todos, mensajeRapido({ id: "p", label: "Mío", ownerId: ASESOR_ID })],
    });

    // Abre en «Mis mensajes» (hay uno propio): 1 en total, 1 solo texto, 0 con fotos.
    expect(screen.getByRole("button", { name: /^Todos\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Solo texto\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Con fotos\s*0$/ })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^Compartidos/ }));
    expect(screen.getByRole("button", { name: /^Todos\s*4$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Solo texto\s*2$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Con fotos\s*2$/ })).toBeInTheDocument();
  });

  it("al cerrar y volver a abrir el modal, la búsqueda queda vacía y el filtro en «Todos»", async () => {
    const user = crearUsuario();
    const props = {
      onOpenChange: vi.fn(),
      quickReplies: todos,
      catalogLinks: [],
      currentAgentId: ASESOR_ID,
      onSelect: vi.fn(),
    };
    const { rerender } = render(<QuickRepliesModal isOpen {...props} />);
    await user.type(buscador(), "horario");
    await user.click(screen.getByRole("button", { name: /^Con fotos/ }));

    rerender(<QuickRepliesModal isOpen={false} {...props} />);
    rerender(<QuickRepliesModal isOpen {...props} />);

    expect((buscador() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: /^Todos/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { name: "Usar" })).toHaveLength(4);
  });

  it("editar un mensaje no depende de la búsqueda: el formulario sigue mostrándose", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: todos });

    await user.type(buscador(), "horario");
    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect((screen.getByLabelText("Título") as HTMLInputElement).value).toBe("Horario");
  });
});

describe("QuickRepliesModal — confirmar el borrado dentro del renglón (T7, 21/10/2026)", () => {
  const compartido = mensajeRapido({ id: "c1", label: "Horario", content: "Atendemos de 8 a 18." });
  const propio = mensajeRapido({ id: "p1", label: "Buenos días", ownerId: ASESOR_ID });

  beforeEach(() => {
    vi.mocked(deleteQuickReply).mockReset();
  });

  it("el primer clic en Borrar NO borra: muestra la franja de confirmación con el título", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [compartido] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));

    expect(deleteQuickReply).not.toHaveBeenCalled();
    const franja = screen.getByRole("group", { name: "Confirmar borrado" });
    expect(franja).toHaveTextContent("¿Borrar «Horario»?");
    expect(franja).toHaveTextContent("No se puede deshacer.");
  });

  it("un mensaje compartido avisa que lo dejan de ver todos los asesores", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [compartido] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));

    expect(screen.getByRole("group", { name: "Confirmar borrado" })).toHaveTextContent(
      "¿Borrar «Horario»? Lo dejan de ver todos los asesores. No se puede deshacer."
    );
  });

  it("un mensaje propio avisa que solo lo ve el asesor", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [propio] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));

    expect(screen.getByRole("group", { name: "Confirmar borrado" })).toHaveTextContent(
      "¿Borrar «Buenos días»? Solo lo ves tú. No se puede deshacer."
    );
  });

  it("«Cancelar» cierra la franja sin borrar", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [compartido] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));
    const franja = screen.getByRole("group", { name: "Confirmar borrado" });
    await user.click(within(franja).getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("group", { name: "Confirmar borrado" })).not.toBeInTheDocument();
    expect(deleteQuickReply).not.toHaveBeenCalled();
  });

  it("«Sí, borrar» borra UNA vez, con el id del renglón, y cierra la franja", async () => {
    const user = crearUsuario();
    vi.mocked(deleteQuickReply).mockResolvedValue(undefined);
    renderModal({ quickReplies: [compartido] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    expect(deleteQuickReply).toHaveBeenCalledTimes(1);
    expect(deleteQuickReply).toHaveBeenCalledWith(expect.anything(), "c1");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Confirmar borrado" })).not.toBeInTheDocument());
  });

  it("armar otro renglón cancela la confirmación del anterior", async () => {
    const user = crearUsuario();
    renderModal({ quickReplies: [compartido, mensajeRapido({ id: "c2", label: "Garantía" })] });

    // Orden por título: «Garantía» primero, «Horario» después.
    await user.click(screen.getAllByRole("button", { name: "Borrar" })[0]);
    await user.click(screen.getAllByRole("button", { name: "Borrar" })[1]);

    const franjas = screen.getAllByRole("group", { name: "Confirmar borrado" });
    expect(franjas).toHaveLength(1);
    expect(franjas[0]).toHaveTextContent("¿Borrar «Horario»?");
  });

  it("si el borrado falla, avisa con el toast de siempre y la franja se cierra", async () => {
    const user = crearUsuario();
    const { toast } = await import("@heroui/react");
    vi.mocked(toast.danger).mockClear();
    vi.mocked(deleteQuickReply).mockRejectedValueOnce(new Error("fetch failed"));
    renderModal({ quickReplies: [compartido] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    expect(toast.danger).toHaveBeenCalledWith("No se pudo borrar el mensaje rápido.");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Confirmar borrado" })).not.toBeInTheDocument());
  });

  it("mientras borra, «Sí, borrar» queda ocupado y no se puede pulsar dos veces", async () => {
    const user = crearUsuario();
    let terminar!: () => void;
    vi.mocked(deleteQuickReply).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        terminar = resolve;
      })
    );
    renderModal({ quickReplies: [compartido] });

    await user.click(screen.getByRole("button", { name: "Borrar" }));
    await user.click(screen.getByRole("button", { name: "Sí, borrar" }));

    const ocupado = screen.getByRole("button", { name: "Borrando…" });
    expect(ocupado).toBeDisabled();
    // HeroUI filtra `aria-busy` del botón: el estado ocupado va en la franja.
    expect(screen.getByRole("group", { name: "Confirmar borrado" })).toHaveAttribute("aria-busy", "true");
    await user.click(ocupado);
    expect(deleteQuickReply).toHaveBeenCalledTimes(1);

    terminar();
    await waitFor(() => expect(screen.queryByRole("group", { name: "Confirmar borrado" })).not.toBeInTheDocument());
  });

  it("cerrar el modal resetea la confirmación", async () => {
    const user = crearUsuario();
    const props = {
      onOpenChange: vi.fn(),
      quickReplies: [compartido],
      catalogLinks: [],
      currentAgentId: ASESOR_ID,
      onSelect: vi.fn(),
    };
    const { rerender } = render(<QuickRepliesModal isOpen {...props} />);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    expect(screen.getByRole("group", { name: "Confirmar borrado" })).toBeInTheDocument();

    rerender(<QuickRepliesModal isOpen={false} {...props} />);
    rerender(<QuickRepliesModal isOpen {...props} />);

    expect(screen.queryByRole("group", { name: "Confirmar borrado" })).not.toBeInTheDocument();
    expect(deleteQuickReply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T8, plan "Presupuestos y mensajes rápidos" (21/10/2026, decisión D8): la
// franja «Más usados» arriba del modal. `masUsadosHasta` es la medianoche de
// Caracas que baja de `useInboxDay`: cambia una vez al día, y por eso el
// ranking se pide UNA vez por día y por pestaña (caché de módulo).
// ---------------------------------------------------------------------------
describe("QuickRepliesModal — Más usados (T8)", () => {
  const HASTA = "2026-10-21T04:00:00.000Z";
  const fetchMasUsados = vi.mocked(fetchMensajesRapidosMasUsados);

  const horario = mensajeRapido({ id: "qr-horario", label: "Horario", content: "De 8 a 18" });
  const cascos = mensajeRapido({ id: "qr-cascos", label: "Cascos", content: "Mira", mediaPaths: ["quick-replies/a.jpg"] });
  const saludo = mensajeRapido({ id: "qr-saludo", label: "Saludo", content: "Buen día" });

  function propsBase(extra: Partial<ComponentProps<typeof QuickRepliesModal>> = {}) {
    return {
      quickReplies: [horario],
      catalogLinks: [],
      currentAgentId: ASESOR_ID,
      onSelect: vi.fn(),
      onOpenChange: vi.fn(),
      masUsadosHasta: HASTA,
      ...extra,
    };
  }

  beforeEach(() => {
    __reiniciarCacheMasUsados();
    fetchMasUsados.mockReset();
    // El mock de `toast` es compartido por todo el archivo: sin limpiarlo, el
    // `danger` de un test anterior contaminaría el «no hay toast» de abajo.
    vi.mocked(toast.danger).mockClear();
  });

  it("pinta las tarjetas en el orden del ranking, con sus envíos y el conteo de fotos", async () => {
    fetchMasUsados.mockResolvedValue([
      { quickReplyId: "qr-cascos", usos: 12 },
      { quickReplyId: "qr-horario", usos: 1 },
    ]);
    renderModal({ quickReplies: [horario, cascos, saludo], masUsadosHasta: HASTA });

    const franja = await screen.findByRole("region", { name: "Más usados" });

    expect(fetchMasUsados).toHaveBeenCalledWith(expect.anything(), HASTA);
    expect(within(franja).getByText("Actualizado hoy a las 00:00 · últimos 30 días")).toBeInTheDocument();
    const tarjetas = within(franja).getAllByRole("button");
    expect(tarjetas).toHaveLength(2);
    expect(tarjetas[0]).toHaveTextContent("Cascos");
    expect(tarjetas[0]).toHaveTextContent("12 envíos");
    expect(tarjetas[0]).toHaveTextContent("📷 1");
    expect(tarjetas[1]).toHaveTextContent("Horario");
    expect(tarjetas[1]).toHaveTextContent("1 envío");
    expect(tarjetas[1]).not.toHaveTextContent("1 envíos");
    expect(tarjetas[1]).not.toHaveTextContent("📷");
  });

  it("un id que el asesor no ve (no está en quickReplies) no aparece", async () => {
    fetchMasUsados.mockResolvedValue([
      { quickReplyId: "qr-ajeno", usos: 40 },
      { quickReplyId: "qr-horario", usos: 3 },
    ]);
    renderModal({ quickReplies: [horario], masUsadosHasta: HASTA });

    const franja = await screen.findByRole("region", { name: "Más usados" });

    expect(within(franja).getAllByRole("button")).toHaveLength(1);
    expect(within(franja).getByRole("button")).toHaveTextContent("Horario");
  });

  it("si ningún id del ranking es visible, no se pinta la franja", async () => {
    fetchMasUsados.mockResolvedValue([{ quickReplyId: "qr-ajeno", usos: 40 }]);
    renderModal({ quickReplies: [horario], masUsadosHasta: HASTA });

    await waitFor(() => expect(fetchMasUsados).toHaveBeenCalled());
    await Promise.resolve();

    expect(screen.queryByRole("region", { name: "Más usados" })).not.toBeInTheDocument();
  });

  it("un clic en una tarjeta equivale a «Usar»: entrega el mensaje entero", async () => {
    const user = crearUsuario();
    fetchMasUsados.mockResolvedValue([{ quickReplyId: "qr-cascos", usos: 5 }]);
    const { onSelect } = renderModal({ quickReplies: [horario, cascos], masUsadosHasta: HASTA });

    const franja = await screen.findByRole("region", { name: "Más usados" });
    await user.click(within(franja).getByRole("button"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(cascos);
  });

  it("sin masUsadosHasta no consulta la RPC ni pinta la franja", async () => {
    renderModal({ quickReplies: [horario] });

    await Promise.resolve();

    expect(fetchMasUsados).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Más usados" })).not.toBeInTheDocument();
  });

  it("con el modal cerrado no consulta nada", async () => {
    renderModal({ isOpen: false, quickReplies: [horario], masUsadosHasta: HASTA });

    await Promise.resolve();

    expect(fetchMasUsados).not.toHaveBeenCalled();
  });

  it("abrirlo dos veces con el mismo masUsadosHasta pide el ranking UNA sola vez", async () => {
    fetchMasUsados.mockResolvedValue([{ quickReplyId: "qr-horario", usos: 2 }]);
    const props = propsBase();
    const { rerender } = render(<QuickRepliesModal isOpen {...props} />);
    await screen.findByRole("region", { name: "Más usados" });

    rerender(<QuickRepliesModal isOpen={false} {...props} />);
    rerender(<QuickRepliesModal isOpen {...props} />);
    await screen.findByRole("region", { name: "Más usados" });

    expect(fetchMasUsados).toHaveBeenCalledTimes(1);
  });

  it("al cambiar el día (otro masUsadosHasta) vuelve a pedirlo", async () => {
    fetchMasUsados.mockResolvedValue([{ quickReplyId: "qr-horario", usos: 2 }]);
    const { rerender } = render(<QuickRepliesModal isOpen {...propsBase()} />);
    await screen.findByRole("region", { name: "Más usados" });

    rerender(<QuickRepliesModal isOpen {...propsBase({ masUsadosHasta: "2026-10-22T04:00:00.000Z" })} />);

    await waitFor(() => expect(fetchMasUsados).toHaveBeenCalledTimes(2));
  });

  it("si la RPC falla no hay franja ni toast, queda un console.error y la próxima apertura reintenta", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMasUsados.mockRejectedValueOnce(new Error("timeout"));
    const props = propsBase();
    const { rerender } = render(<QuickRepliesModal isOpen {...props} />);

    await waitFor(() => expect(consola).toHaveBeenCalledWith("mensajes_rapidos_mas_usados", expect.any(Error)));
    expect(screen.queryByRole("region", { name: "Más usados" })).not.toBeInTheDocument();
    expect(toast.danger).not.toHaveBeenCalled();

    // Una promesa fallida no se queda en la caché: reabrir vuelve a pedirla.
    fetchMasUsados.mockResolvedValueOnce([{ quickReplyId: "qr-horario", usos: 2 }]);
    rerender(<QuickRepliesModal isOpen={false} {...props} />);
    rerender(<QuickRepliesModal isOpen {...props} />);
    await screen.findByRole("region", { name: "Más usados" });
    expect(fetchMasUsados).toHaveBeenCalledTimes(2);
    consola.mockRestore();
  });

  it("la franja no se filtra con la búsqueda", async () => {
    const user = crearUsuario();
    fetchMasUsados.mockResolvedValue([{ quickReplyId: "qr-horario", usos: 2 }]);
    renderModal({ quickReplies: [horario, saludo], masUsadosHasta: HASTA });
    const franja = await screen.findByRole("region", { name: "Más usados" });

    await user.type(screen.getByRole("searchbox", { name: "Buscar mensajes rápidos" }), "saludo");

    expect(within(franja).getByRole("button")).toHaveTextContent("Horario");
  });

  it("se oculta mientras se crea o edita un mensaje", async () => {
    const user = crearUsuario();
    fetchMasUsados.mockResolvedValue([{ quickReplyId: "qr-horario", usos: 2 }]);
    renderModal({ quickReplies: [horario], masUsadosHasta: HASTA });
    await screen.findByRole("region", { name: "Más usados" });

    await abrirFormulario(user);

    expect(screen.queryByRole("region", { name: "Más usados" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByRole("region", { name: "Más usados" })).toBeInTheDocument();
  });
});
