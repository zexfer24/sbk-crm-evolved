"use client";

import { useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { ImagePlus, Sticker as StickerIcon } from "lucide-react";
import { Button, Input, Label, Modal, toast } from "@heroui/react";
import type { Agent, Sticker } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createSticker } from "@/lib/mutations";
import { renderStickerWebp } from "@/lib/sticker-canvas";

// ---------------------------------------------------------------------------
// Crear un sticker desde cero (T3b, "Seis frentes del buzón", 8/9/2026):
// elegir una imagen (archivo o pegada del portapapeles, igual que el
// composer con las fotos), armar el WebP de 512×512 con `renderStickerWebp`
// y subirlo con `createSticker` (T3a). El nombre es opcional -- la biblioteca
// se navega mirando las miniaturas, no una lista de títulos.
// ---------------------------------------------------------------------------

interface CreateStickerModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  onCreated: (sticker: Sticker) => void;
}

export function CreateStickerModal({ isOpen, onOpenChange, agent, onCreated }: CreateStickerModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setName("");
  }

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  function pickFile(selected: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  }

  function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (selected) pickFile(selected);
  }

  // Igual que el composer con las fotos del chat: recortar la pantalla y
  // Ctrl+V es como llega la mayoría de las imágenes que un asesor arma acá.
  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const pasted = Array.from(event.clipboardData?.files ?? [])[0];
    if (pasted) {
      event.preventDefault();
      pickFile(pasted);
    }
  }

  async function handleSave() {
    if (!file) {
      toast.danger("Elige una imagen primero.");
      return;
    }
    setIsSaving(true);
    try {
      const rendered = await renderStickerWebp(file);
      if (!rendered) {
        toast.danger("La imagen es muy pesada, prueba una más simple");
        return;
      }
      const supabase = createClient();
      const sticker = await createSticker(supabase, rendered.blob, name.trim() || null, agent);
      onCreated(sticker);
      reset();
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "No se pudo crear el sticker.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <StickerIcon size={18} />
              </Modal.Icon>
              <Modal.Heading>Crear sticker</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3" onPaste={handlePaste}>
              <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFileSelected} />

              {!previewUrl && (
                <button type="button" className="crm-sticker-drop" onClick={() => fileInputRef.current?.click()}>
                  <ImagePlus size={22} />
                  <span>Elige una imagen o pégala con Ctrl+V</span>
                </button>
              )}

              {previewUrl && (
                <div className="crm-sticker-modal-preview">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt="Vista previa del sticker" />
                  <Button variant="ghost" size="sm" onPress={() => fileInputRef.current?.click()}>
                    Elegir otra imagen
                  </Button>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <Label htmlFor="sticker-name">Nombre (opcional)</Label>
                <Input id="sticker-name" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => handleOpenChange(false)}>
                Cancelar
              </Button>
              <Button variant="primary" onPress={handleSave} isDisabled={!file || isSaving}>
                {isSaving ? "Guardando…" : "Guardar"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
