"use client";

import { useState } from "react";
import { Copy, ImageDown, Reply, Sticker as StickerIcon } from "lucide-react";
import { toast } from "@heroui/react";
import type { Agent, Message } from "@/lib/types";
import { ContextMenu } from "@/components/context-menu";
import { createClient } from "@/lib/supabase/client";
import { saveStickerFromMessage } from "@/lib/mutations";

/**
 * Deja la foto en el portapapeles, lista para pegar en otro chat o en
 * cualquier otro programa.
 *
 * Pasa por un canvas a propósito: los navegadores solo aceptan PNG en el
 * portapapeles, y lo que manda el cliente por WhatsApp casi siempre es JPEG.
 * Sin la conversión, `write` falla con un tipo no soportado.
 */
async function copiarImagenAlPortapapeles(url: string) {
  const respuesta = await fetch(url);
  const original = await respuesta.blob();

  const bitmap = await createImageBitmap(original);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);

  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("No se pudo preparar la imagen.");

  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

interface MessageContextMenuProps {
  position: { x: number; y: number };
  message: Message;
  onReply?: (message: Message) => void;
  onClose: () => void;
  /**
   * Quién está guardando el sticker (T3a, "Seis frentes del buzón",
   * 8/9/2026). Opcional: sin `agent` la opción "Guardar sticker" no se
   * ofrece, en vez de intentar guardarlo con un dueño desconocido — cubre
   * a cualquier lugar donde este menú se use sin conocer al agente.
   */
  agent?: Agent;
}

export function MessageContextMenu({ position, message, onReply, onClose, agent }: MessageContextMenuProps) {
  const [copiando, setCopiando] = useState(false);
  const [guardandoSticker, setGuardandoSticker] = useState(false);

  const esImagen = message.messageType === "image" && !!message.mediaUrl;
  const esSticker = message.messageType === "sticker" && !!message.mediaUrl;
  const tieneTexto = !!message.content?.trim();

  async function copiarImagen() {
    setCopiando(true);
    try {
      await copiarImagenAlPortapapeles(message.mediaUrl!);
      toast.success("Foto copiada");
      onClose();
    } catch {
      // Sin permiso de portapapeles, o un navegador que no lo soporta: se
      // dice, en vez de cerrar el menú como si hubiera funcionado.
      toast.danger("No se pudo copiar la foto.");
      setCopiando(false);
    }
  }

  async function copiarTexto() {
    try {
      await navigator.clipboard.writeText(message.content ?? "");
      toast.success("Texto copiado");
    } catch {
      toast.danger("No se pudo copiar el texto.");
    }
    onClose();
  }

  async function guardarSticker() {
    if (!agent) return;
    setGuardandoSticker(true);
    try {
      await saveStickerFromMessage(createClient(), message, agent);
      toast.success("Sticker guardado");
      onClose();
    } catch (err) {
      // Mismo criterio que copiarImagen: se dice el fallo, no se cierra el
      // menú como si el sticker ya estuviera en la biblioteca. El mensaje de
      // `saveStickerFromMessage` cuando el sticker no entra en el límite de
      // Meta (T2, 8/9/2026) ya trae el tipo, el peso y el límite en KB —
      // reemplazarlo por un genérico dejaría al asesor sin saber por qué.
      toast.danger(err instanceof Error ? err.message : "No se pudo guardar el sticker.");
      setGuardandoSticker(false);
    }
  }

  return (
    <ContextMenu position={position} onClose={onClose} label="Acciones del mensaje">
      {onReply && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onReply(message);
            onClose();
          }}
        >
          <Reply size={15} aria-hidden="true" />
          Responder
        </button>
      )}

      {esImagen && (
        <button type="button" role="menuitem" onClick={copiarImagen} disabled={copiando}>
          <ImageDown size={15} aria-hidden="true" />
          {copiando ? "Copiando…" : "Copiar imagen"}
        </button>
      )}

      {esSticker && agent && (
        <button type="button" role="menuitem" onClick={guardarSticker} disabled={guardandoSticker}>
          <StickerIcon size={15} aria-hidden="true" />
          {guardandoSticker ? "Guardando…" : "Guardar sticker"}
        </button>
      )}

      {tieneTexto && (
        <button type="button" role="menuitem" onClick={copiarTexto}>
          <Copy size={15} aria-hidden="true" />
          Copiar texto
        </button>
      )}
    </ContextMenu>
  );
}
