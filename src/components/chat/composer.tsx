"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { AlignLeft, FileText, Lock, Paperclip, Send, X, Zap } from "lucide-react";
import { Button, TextArea, Tooltip } from "@heroui/react";
import { toast } from "@heroui/react";
import type { Conversation, Message, MessageType, QuickReply, WhatsappTemplate } from "@/lib/types";
import { isWithin24hWindow } from "@/lib/whatsapp-window";
import { createClient } from "@/lib/supabase/client";
import { sendMediaMessage, sendMessage, sendTemplateMessage } from "@/lib/mutations";
import { MEDIA_BUCKET, mediaUrlFor } from "@/lib/storage";
import { TemplatePickerModal } from "@/components/chat/template-picker-modal";
import { QuickRepliesModal } from "@/components/chat/quick-replies-modal";
import { WindowCountdown } from "@/components/chat/window-countdown";

interface ComposerProps {
  conversation: Conversation;
  templates: WhatsappTemplate[];
  quickReplies: QuickReply[];
  replyingTo: Message | null;
  onCancelReply: () => void;
}

function mediaTypeFromMime(mime: string): MessageType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

interface PendingFile {
  id: string;
  file: File;
  mediaType: MessageType;
  previewUrl: string | null;
}

export function Composer({ conversation, templates, quickReplies, replyingTo, onCancelReply }: ComposerProps) {
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isQuickRepliesOpen, setIsQuickRepliesOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const withinWindow = isWithin24hWindow(conversation.lastCustomerMessageAt);

  // Libera los object URLs de preview al desmontar o al reemplazar la lista.
  useEffect(() => {
    return () => {
      pendingFiles.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend() {
    const content = text.trim();
    if (!content || isSending) return;

    setIsSending(true);
    try {
      await sendMessage(conversation.id, content, false, replyingTo?.id ?? null);
      setText("");
      onCancelReply();
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "No se pudo enviar el mensaje.");
    } finally {
      setIsSending(false);
    }
  }

  async function handleSelectTemplate(template: WhatsappTemplate) {
    try {
      await sendTemplateMessage(conversation.id, template);
      setIsTemplateModalOpen(false);
      toast.success(`Plantilla "${template.name}" enviada`);
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "No se pudo enviar la plantilla.");
    }
  }

  function handleSelectQuickReply(content: string) {
    setText((prev) => (prev ? `${prev}\n${content}` : content));
    setIsQuickRepliesOpen(false);
  }

  function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    const next: PendingFile[] = files.map((file) => {
      const mediaType = mediaTypeFromMime(file.type);
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        mediaType,
        previewUrl: mediaType === "image" || mediaType === "video" ? URL.createObjectURL(file) : null,
      };
    });
    setPendingFiles((prev) => [...prev, ...next]);
  }

  function removePendingFile(id: string) {
    setPendingFiles((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function clearPendingFiles() {
    pendingFiles.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    setPendingFiles([]);
  }

  async function handleSendFiles() {
    if (pendingFiles.length === 0 || isUploading) return;
    setIsUploading(true);
    try {
      const supabase = createClient();
      for (let i = 0; i < pendingFiles.length; i++) {
        const { file, mediaType } = pendingFiles[i];
        // Id aleatorio y no el nombre del archivo: el bucket es privado,
        // pero una ruta adivinable seguiría siendo una pista de más.
        const extension = file.name.includes(".") ? `.${file.name.split(".").pop()}` : "";
        const path = `outbound/${conversation.id}/${crypto.randomUUID()}${extension}`;
        const { error: uploadError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .upload(path, file, { contentType: file.type });
        if (uploadError) throw uploadError;

        await sendMediaMessage(
          conversation.id,
          mediaUrlFor(path),
          mediaType,
          i === 0 ? text.trim() || undefined : undefined,
          i === 0 ? (replyingTo?.id ?? null) : null
        );
      }
      clearPendingFiles();
      setText("");
      onCancelReply();
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "No se pudo enviar el archivo.");
    } finally {
      setIsUploading(false);
    }
  }

  // Marcadores reales de WhatsApp (no Markdown): *negrita*, _itálica_, ~tachado~.
  // Ctrl/Cmd+B, Ctrl/Cmd+I y Ctrl/Cmd+Shift+X son análogos a los atajos estándar
  // de negrita/itálica de cualquier editor; el tachado no tiene un atajo
  // convencional entre navegadores así que elegimos Shift+X (mnemónico: "X" de
  // "tachar/strikethrough" en teclados sin atajo nativo reservado).
  function wrapSelection(event: KeyboardEvent<HTMLTextAreaElement>, marker: string) {
    event.preventDefault();
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = text.slice(start, end);
    const newText = `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}`;
    setText(newText);

    const newStart = start + marker.length;
    const newEnd = newStart + selected.length;
    requestAnimationFrame(() => {
      textarea.setSelectionRange(newStart, newEnd);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
      return;
    }

    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;

    if (event.shiftKey && event.key.toLowerCase() === "x") {
      wrapSelection(event, "~");
    } else if (!event.shiftKey && event.key.toLowerCase() === "b") {
      wrapSelection(event, "*");
    } else if (!event.shiftKey && event.key.toLowerCase() === "i") {
      wrapSelection(event, "_");
    }
  }

  return (
    <div className="crm-composer">
      {!withinWindow && (
        <div className="flex items-center gap-2 bg-warning-soft px-4 py-2 text-sm text-warning">
          <Lock size={14} className="shrink-0" />
          <span>
            Han pasado más de 24 h desde el último mensaje del cliente. Usa una{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => setIsTemplateModalOpen(true)}
            >
              plantilla para reabrir el chat
            </button>
            .
          </span>
        </div>
      )}

      {withinWindow && (
        <div className="flex items-center justify-between px-4 pt-2">
          <WindowCountdown lastCustomerMessageAt={conversation.lastCustomerMessageAt} />
        </div>
      )}

      {replyingTo && (
        <div className="crm-reply-strip mx-3 mt-2 flex items-center justify-between gap-2 border-l-2 border-accent bg-default px-3 py-1.5 text-xs">
          <div className="min-w-0">
            <p className="font-medium text-accent">
              Respondiendo a {replyingTo.direction === "inbound" ? "cliente" : replyingTo.senderAgent?.displayName ?? "agente"}
            </p>
            <p className="truncate text-muted">{replyingTo.content || `[${replyingTo.messageType}]`}</p>
          </div>
          <button type="button" onClick={onCancelReply} className="shrink-0 text-muted hover:text-foreground">
            <X size={14} />
          </button>
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="crm-attach-preview">
          {pendingFiles.map((p) => (
            <div className="crm-attach-item" key={p.id}>
              {p.previewUrl && p.mediaType === "image" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.previewUrl} alt={p.file.name} />
              )}
              {p.previewUrl && p.mediaType === "video" && (
                <video src={p.previewUrl} muted playsInline preload="metadata" />
              )}
              {!p.previewUrl && (
                <div className="crm-attach-doc">
                  <FileText size={16} />
                  <span>{p.file.name}</span>
                </div>
              )}
              <button
                type="button"
                className="crm-attach-remove"
                onClick={() => removePendingFile(p.id)}
                aria-label={`Quitar ${p.file.name}`}
                disabled={isUploading}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="crm-composer-row flex items-end gap-1.5 pt-2">
        <input ref={fileInputRef} type="file" hidden multiple onChange={handleFileSelected} />

        <Tooltip>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              size="md"
              isIconOnly
              isDisabled={!withinWindow || isUploading}
              onPress={() => fileInputRef.current?.click()}
              aria-label={isUploading ? "Subiendo..." : "Adjuntar imágenes, videos o archivos"}
              className="shrink-0"
            >
              <Paperclip size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{isUploading ? "Subiendo..." : "Adjuntar imágenes, videos o archivos"}</Tooltip.Content>
        </Tooltip>

        <Tooltip>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              size="md"
              isIconOnly
              onPress={() => setIsTemplateModalOpen(true)}
              aria-label="Plantillas preaprobadas"
              className="shrink-0"
            >
              <AlignLeft size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Plantillas preaprobadas</Tooltip.Content>
        </Tooltip>

        <Tooltip>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              size="md"
              isIconOnly
              onPress={() => setIsQuickRepliesOpen(true)}
              aria-label="Mensajes rápidos"
              className="shrink-0"
            >
              <Zap size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Mensajes rápidos</Tooltip.Content>
        </Tooltip>

        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Mensaje"
          placeholder={
            !withinWindow
              ? "Ventana de 24h cerrada — usa una plantilla"
              : pendingFiles.length > 0
                ? "Agrega un mensaje (opcional)..."
                : "Escribe un mensaje..."
          }
          disabled={!withinWindow}
          fullWidth
          rows={1}
          className="crm-composer-input max-h-32 min-h-0 flex-1 min-w-0 resize-none py-2.5"
        />

        <Button
          variant="primary"
          size="md"
          isIconOnly
          isDisabled={
            !withinWindow || isSending || isUploading || (pendingFiles.length === 0 && !text.trim())
          }
          onPress={pendingFiles.length > 0 ? handleSendFiles : handleSend}
          aria-label={isSending || isUploading ? "Enviando..." : "Enviar mensaje"}
          className="shrink-0"
        >
          <Send size={18} />
        </Button>
      </div>

      <TemplatePickerModal
        isOpen={isTemplateModalOpen}
        onOpenChange={setIsTemplateModalOpen}
        templates={templates}
        onSelect={handleSelectTemplate}
      />
      <QuickRepliesModal
        isOpen={isQuickRepliesOpen}
        onOpenChange={setIsQuickRepliesOpen}
        quickReplies={quickReplies}
        onSelect={handleSelectQuickReply}
      />
    </div>
  );
}
