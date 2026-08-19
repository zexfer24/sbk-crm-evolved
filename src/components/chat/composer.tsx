"use client";

import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { AlignLeft, Lock, Paperclip, Send, StickyNote, X, Zap } from "lucide-react";
import { Button, TextArea, Tooltip } from "@heroui/react";
import { toast } from "@heroui/react";
import type { Conversation, Message, MessageType, QuickReply, WhatsappTemplate } from "@/lib/types";
import { isWithin24hWindow } from "@/lib/whatsapp-window";
import { createClient } from "@/lib/supabase/client";
import { sendMediaMessage, sendMessage, sendTemplateMessage } from "@/lib/mutations";
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

export function Composer({ conversation, templates, quickReplies, replyingTo, onCancelReply }: ComposerProps) {
  const [text, setText] = useState("");
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isQuickRepliesOpen, setIsQuickRepliesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const withinWindow = isWithin24hWindow(conversation.lastCustomerMessageAt);

  async function handleSend() {
    const content = text.trim();
    if (!content || isSending) return;

    setIsSending(true);
    try {
      await sendMessage(conversation.id, content, isInternalNote, replyingTo?.id ?? null);
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

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setIsUploading(true);
    try {
      const supabase = createClient();
      const mediaType = mediaTypeFromMime(file.type);
      const path = `outbound/${conversation.id}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("whatsapp-media")
        .upload(path, file, { contentType: file.type });
      if (uploadError) throw uploadError;

      const { data: publicUrl } = supabase.storage.from("whatsapp-media").getPublicUrl(path);
      await sendMediaMessage(conversation.id, publicUrl.publicUrl, mediaType, text.trim() || undefined, replyingTo?.id ?? null);
      setText("");
      onCancelReply();
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "No se pudo enviar el archivo.");
    } finally {
      setIsUploading(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
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

      {isInternalNote && (
        <div className="flex items-center gap-2 bg-warning-soft px-4 py-1.5 text-xs text-warning">
          <StickyNote size={12} />
          Estás escribiendo una nota interna: no se enviará al cliente por WhatsApp.
        </div>
      )}

      {replyingTo && (
        <div className="mx-3 mt-2 flex items-center justify-between gap-2 rounded-field border-l-2 border-accent bg-default px-3 py-1.5 text-xs">
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

      <div className="crm-composer-row flex items-end gap-1.5 pt-2">
        <input ref={fileInputRef} type="file" hidden onChange={handleFileSelected} />

        <Tooltip>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              size="md"
              isIconOnly
              isDisabled={!withinWindow || isUploading}
              onPress={() => fileInputRef.current?.click()}
            >
              <Paperclip size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{isUploading ? "Subiendo..." : "Adjuntar imagen, video o audio"}</Tooltip.Content>
        </Tooltip>

        <Tooltip>
          <Tooltip.Trigger>
            <Button variant="ghost" size="md" isIconOnly onPress={() => setIsTemplateModalOpen(true)}>
              <AlignLeft size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Plantillas preaprobadas</Tooltip.Content>
        </Tooltip>

        <Tooltip>
          <Tooltip.Trigger>
            <Button variant="ghost" size="md" isIconOnly onPress={() => setIsQuickRepliesOpen(true)}>
              <Zap size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Mensajes rápidos</Tooltip.Content>
        </Tooltip>

        <Tooltip>
          <Tooltip.Trigger>
            <Button
              variant={isInternalNote ? "primary" : "ghost"}
              size="md"
              isIconOnly
              onPress={() => setIsInternalNote((v) => !v)}
            >
              <StickyNote size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{isInternalNote ? "Volver a respuesta normal" : "Nota interna"}</Tooltip.Content>
        </Tooltip>

        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !withinWindow
              ? "Ventana de 24h cerrada — usa una plantilla"
              : isInternalNote
                ? "Escribe una nota interna para el equipo..."
                : "Escribe un mensaje..."
          }
          disabled={!withinWindow}
          fullWidth
          rows={1}
          className="crm-composer-input max-h-32 min-h-0 resize-none py-2.5"
        />

        <Button
          variant="primary"
          size="md"
          isIconOnly
          isDisabled={!withinWindow || !text.trim() || isSending}
          onPress={handleSend}
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
