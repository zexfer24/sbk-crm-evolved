/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateStickerModal } from "@/components/chat/create-sticker-modal";
import type { Agent, Sticker } from "@/lib/types";

/**
 * T3b, "Seis frentes del buzón" (8/9/2026): crear un sticker desde una foto.
 * `renderStickerWebp` (sticker-canvas.ts) va mockeado -- lo que prueba este
 * archivo es el flujo del modal (elegir imagen, validar, llamar a
 * `createSticker`), no el canvas, que ya tiene su propio test con fakes.
 */

const createStickerMock = vi.fn();
vi.mock("@/lib/mutations", () => ({
  createSticker: (...args: unknown[]) => createStickerMock(...args),
}));

const renderStickerWebpMock = vi.fn();
vi.mock("@/lib/sticker-canvas", () => ({
  renderStickerWebp: (...args: unknown[]) => renderStickerWebpMock(...args),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ fakeClient: true }) }));

const successToast = vi.fn();
const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: (...a: unknown[]) => successToast(...a), danger: (...a: unknown[]) => dangerToast(...a) } };
});

// jsdom no arma object URLs de verdad; alcanza con un valor estable para
// comprobar que la vista previa se pinta.
beforeEach(() => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});

const AGENT: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

const STICKER: Sticker = {
  id: "sticker-9",
  url: "/api/media/stickers/sticker-9.webp",
  name: "Nuevo",
  animated: false,
  createdBy: AGENT.id,
  createdAt: new Date().toISOString(),
};

function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function renderModal(onCreated = vi.fn()) {
  const onOpenChange = vi.fn();
  return {
    onCreated,
    onOpenChange,
    ...render(<CreateStickerModal isOpen agent={AGENT} onOpenChange={onOpenChange} onCreated={onCreated} />),
  };
}

function elegirArchivo(nombre = "foto.png") {
  return new File([new Uint8Array([1, 2, 3])], nombre, { type: "image/png" });
}

describe("CreateStickerModal", () => {
  beforeEach(() => {
    createStickerMock.mockReset();
    renderStickerWebpMock.mockReset();
    successToast.mockReset();
    dangerToast.mockReset();
  });

  it("sin imagen elegida, Guardar está deshabilitado", () => {
    renderModal();
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
  });

  it("elegir un archivo muestra la vista previa y habilita Guardar", async () => {
    renderModal();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [elegirArchivo()] } });

    expect(await screen.findByAltText("Vista previa del sticker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar" })).not.toBeDisabled();
  });

  it("pegar una imagen del portapapeles también la deja lista para guardar", async () => {
    renderModal();

    // El evento nativo burbujea hasta Modal.Body, donde vive `onPaste`: no
    // hace falta que el foco esté en ningún campo en particular.
    fireEvent.paste(screen.getByText(/elige una imagen o pégala/i), {
      clipboardData: { files: [elegirArchivo("captura.png")], items: [], getData: () => "" },
    });

    expect(await screen.findByAltText("Vista previa del sticker")).toBeInTheDocument();
  });

  it("Guardar arma el WebP y llama a createSticker con el blob, el nombre y el agente", async () => {
    const blob = { size: 40_000 } as unknown as Blob;
    renderStickerWebpMock.mockResolvedValue({ blob, quality: 0.85 });
    createStickerMock.mockResolvedValue(STICKER);
    const onCreated = vi.fn();
    const user = crearUsuario();
    renderModal(onCreated);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [elegirArchivo()] } });
    await screen.findByAltText("Vista previa del sticker");

    await user.type(screen.getByLabelText("Nombre (opcional)"), "Choro contento");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(createStickerMock).toHaveBeenCalledWith(
        expect.objectContaining({ fakeClient: true }),
        blob,
        "Choro contento",
        AGENT
      )
    );
    expect(onCreated).toHaveBeenCalledWith(STICKER);
  });

  it("un nombre en blanco se guarda como null, no como cadena vacía", async () => {
    renderStickerWebpMock.mockResolvedValue({ blob: { size: 1000 } as unknown as Blob, quality: 0.9 });
    createStickerMock.mockResolvedValue(STICKER);
    const user = crearUsuario();
    renderModal();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [elegirArchivo()] } });
    await screen.findByAltText("Vista previa del sticker");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(createStickerMock).toHaveBeenCalled());
    expect(createStickerMock.mock.calls[0][2]).toBeNull();
  });

  it("si la imagen no entra en el límite de peso, avisa y no llama a createSticker", async () => {
    renderStickerWebpMock.mockResolvedValue(null);
    const user = crearUsuario();
    renderModal();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [elegirArchivo()] } });
    await screen.findByAltText("Vista previa del sticker");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("La imagen es muy pesada, prueba una más simple"));
    expect(createStickerMock).not.toHaveBeenCalled();
  });

  it("si createSticker falla, avisa con el motivo", async () => {
    renderStickerWebpMock.mockResolvedValue({ blob: { size: 1000 } as unknown as Blob, quality: 0.9 });
    createStickerMock.mockRejectedValue(new Error("sin permiso"));
    const user = crearUsuario();
    renderModal();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [elegirArchivo()] } });
    await screen.findByAltText("Vista previa del sticker");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("sin permiso"));
  });
});
