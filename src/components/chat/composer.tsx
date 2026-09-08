"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { AlignLeft, FileText, Lock, Paperclip, Send, X, Zap } from "lucide-react";
import { Button, TextArea, Tooltip } from "@heroui/react";
import { toast } from "@heroui/react";
import type { Agent, Conversation, Message, MessageType, QuickReply, WhatsappTemplate } from "@/lib/types";
import { isComposerWindowOpen } from "@/lib/whatsapp-window";
import { contactName } from "@/lib/dashboard";
import { createClient } from "@/lib/supabase/client";
import { sendMediaMessage, sendTemplateMessage, sendTypingSignal } from "@/lib/mutations";
import { MEDIA_BUCKET, mediaUrlFor } from "@/lib/storage";
import { insertAtCaret } from "@/lib/composer-text";
import { MediaThumb, type MediaItem } from "@/components/chat/media-lightbox";
import { QuotedThumb, quotedTypeLabel } from "@/components/chat/quoted-content";
import { TemplatePickerModal } from "@/components/chat/template-picker-modal";
import { QuickRepliesModal } from "@/components/chat/quick-replies-modal";
import { EmojiStickerPopover } from "@/components/chat/emoji-sticker-popover";
import { WindowCountdown } from "@/components/chat/window-countdown";

interface ComposerProps {
  conversation: Conversation;
  /**
   * El hilo completo cargado del chat (T2, "La ventana de 24h dice la
   * verdad", 7/9/2026): `withinWindow` ya no basta con mirar
   * `lastCustomerMessageAt` -- necesita ver si Meta rechazó el último
   * saliente con 131047 (`windowClosedByMeta`, `whatsapp-window.ts`), y para
   * eso hace falta el historial, no solo la fecha. Antes de esto el composer
   * no recibía `messages`.
   */
  messages: Message[];
  templates: WhatsappTemplate[];
  quickReplies: QuickReply[];
  /**
   * Quién compone (T3b, "Seis frentes del buzón", 8/9/2026): lo necesita el
   * popover de emojis y stickers para atribuir un sticker creado desde cero
   * (`createSticker`). `chat-panel.tsx` ya lo tenía disponible como
   * `currentAgent` para el menú contextual de mensajes; acá era el único
   * hueco que faltaba.
   */
  currentAgent: Agent;
  replyingTo: Message | null;
  onCancelReply: () => void;
  /**
   * Entrega el texto a la cola de envío del CRM y vuelve enseguida. El cuadro
   * no espera al servidor ni se entera de si falló: la burbuja provisional en
   * el hilo es la que cuenta esa historia, y la cola sigue entregando aunque
   * el asesor se vaya a otro chat.
   */
  onSendText: (content: string, replyToMessageId: string | null) => void;
  /**
   * Un pedido de abrir el selector de plantillas que viene de AFUERA del
   * composer (T3.3, 5/9/2026): la burbuja de un mensaje rechazado por Meta
   * con código 131047 (ventana de 24 h vencida) ofrece un botón para abrirlo
   * directo, sin que el asesor tenga que ir a buscarlo. Es una señal por
   * CONTADOR y no un booleano: cada incremento (venga o no el modal ya
   * abierto) es un pedido nuevo de abrirlo, así que dos clics seguidos desde
   * dos burbujas distintas no se pisan entre sí. Opcional y en 0 por
   * defecto: no cambia nada para quien no lo use.
   */
  openTemplateModalSignal?: number;
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

/**
 * Cómo nombrar el botón de quitar un adjunto.
 *
 * Windows y macOS le ponen el mismo nombre a toda captura que va al
 * portapapeles, así que pegar tres seguidas deja tres "image.png". Con solo
 * el nombre no hay manera de saber cuál se está quitando —ni mirando, ni con
 * un lector de pantalla—, así que en ese caso se añade la posición. Cuando
 * los nombres ya distinguen, se deja el nombre limpio.
 */
function etiquetaQuitar(pending: PendingFile, index: number, todos: PendingFile[]): string {
  const repetido = todos.some((otro) => otro.id !== pending.id && otro.file.name === pending.file.name);
  return repetido
    ? `Quitar ${pending.file.name} (${index + 1} de ${todos.length})`
    : `Quitar ${pending.file.name}`;
}

export function Composer({
  conversation,
  messages,
  templates,
  quickReplies,
  currentAgent,
  replyingTo,
  onCancelReply,
  onSendText,
  openTemplateModalSignal,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isQuickRepliesOpen, setIsQuickRepliesOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  /** Cuántos archivos del lote ya subieron, para que la espera no sea muda. */
  const [uploadedCount, setUploadedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Ya no alcanza con `isWithin24hWindow(lastCustomerMessageAt)` a secas
   * (caso real del 6/9/2026: la conversación `aa75ef33-…` mostraba "quedan
   * 11 h" con la caja habilitada mientras Meta rechazaba todo con 131047).
   * `isComposerWindowOpen` suma la segunda pata -- si el saliente más
   * reciente falló con 131047 y nada real lo reabrió después, la ventana se
   * da por cerrada aunque `lastCustomerMessageAt` diga lo contrario.
   */
  const withinWindow = useMemo(
    () => isComposerWindowOpen(conversation.lastCustomerMessageAt, messages),
    [conversation.lastCustomerMessageAt, messages]
  );

  /**
   * El cuadro se estira con lo que se escribe.
   *
   * Estaba fijo en `rows={1}`: Shift+Enter sí metía el salto de línea, pero
   * el cuadro seguía mostrando un renglón, así que escribir un mensaje de
   * tres líneas era escribir a ciegas. Se mide el contenido y se ajusta el
   * alto, con el tope que ya ponía el CSS para que no se coma el chat.
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // A cero primero: si no, el alto anterior es el suelo y el cuadro solo
    // sabría crecer, nunca volver a encogerse al borrar.
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [text]);

  /**
   * "Escribiendo…" hacia el cliente (T3.1, 4/9/2026): arranca en el primer
   * carácter y se renueva cada 20 s mientras quede texto — Meta apaga el
   * indicador solo, a los 25 s o al llegar la respuesta, lo que pase primero,
   * así que una redacción que se alarga más que eso necesita que se le avise
   * de nuevo antes de que expire.
   *
   * Un debounce clásico (trailing edge, como `use-debounced-callback.ts`) no
   * sirve para esto: mientras el asesor sigue tecleando sin pausa el debounce
   * nunca dispara, que es justo lo contrario de lo que hace falta acá. Por
   * eso el aviso es un intervalo fijo y no un debounce, y la dependencia es
   * la PRESENCIA de texto (`hasText`), no `text` en sí: si dependiera del
   * texto, cada tecla reiniciaría el intervalo y el aviso nunca llegaría a
   * los 20 s.
   */
  const hasText = text.trim().length > 0;
  useEffect(() => {
    if (!withinWindow || !hasText) return;

    sendTypingSignal(conversation.id);
    const interval = setInterval(() => {
      sendTypingSignal(conversation.id);
    }, 20_000);

    // Se detiene al enviar o al vaciar el cuadro: los dos casos apagan
    // `hasText`, que es lo único que dispara este cleanup.
    return () => clearInterval(interval);
  }, [conversation.id, withinWindow, hasText]);

  /**
   * Abre el selector cuando llega un pedido desde afuera (T3.3, 5/9/2026):
   * ver `openTemplateModalSignal` en `ComposerProps`. Se ignora el primer
   * render (la señal nace en 0 y no debe abrir nada al montar) comparando
   * contra la referencia del valor anterior.
   */
  const previousSignalRef = useRef(openTemplateModalSignal);
  useEffect(() => {
    if (
      openTemplateModalSignal !== undefined &&
      openTemplateModalSignal !== previousSignalRef.current
    ) {
      setIsTemplateModalOpen(true);
    }
    previousSignalRef.current = openTemplateModalSignal;
  }, [openTemplateModalSignal]);

  // Libera los object URLs de preview al desmontar o al reemplazar la lista.
  useEffect(() => {
    return () => {
      pendingFiles.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSend() {
    const content = text.trim();
    if (!content) return;

    // El cuadro se vacía en el acto y el mensaje pasa a la cola del CRM.
    // Enviar es el gesto que más se repite acá, y el acuse tiene que ser
    // inmediato: la burbuja provisional aparece en el hilo al instante, y si
    // el envío falla, el aviso y el reintento viven en esa burbuja — no en
    // este cuadro, que para entonces puede estar mostrando otro chat.
    const replyTo = replyingTo?.id ?? null;
    setText("");
    onCancelReply();
    onSendText(content, replyTo);
  }

  async function handleSelectTemplate(template: WhatsappTemplate, variables: string[]) {
    try {
      await sendTemplateMessage(conversation.id, template, variables);
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

  function addFiles(files: File[]) {
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

  function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    addFiles(files);
  }

  /**
   * Ctrl+V con una captura en el portapapeles.
   *
   * Es como llega la mayoría de las imágenes en una conversación de ventas:
   * el asesor recorta la pantalla y pega. Obligarlo a guardar el archivo
   * primero para después buscarlo con el clip es un rodeo que nadie hace.
   *
   * Solo se intercepta cuando el portapapeles trae archivos. Pegar texto —lo
   * que más se pega— sigue siendo asunto del navegador, con su deshacer y su
   * posición del cursor intactos.
   */
  /**
   * Ctrl+V con una captura en el portapapeles.
   *
   * Se escucha en el documento y no en el cuadro de texto. Nadie hace clic
   * dentro del cuadro antes de pegar: recorta la pantalla y pulsa Ctrl+V. Si
   * el foco quedó en el botón del clip, en la lista de conversaciones o en
   * ningún lado, el evento nunca llega al textarea — que es exactamente el
   * "no se pega" que se ve al usarlo.
   *
   * Uno solo y no dos: el evento del textarea burbujea hasta acá, así que
   * tener las dos escuchas adjuntaba cada captura por duplicado.
   *
   * Solo se actúa cuando el portapapeles trae archivos, así que copiar y
   * pegar texto en cualquier otro campo de la pantalla sigue igual, con su
   * deshacer y la posición del cursor intactos.
   */
  useEffect(() => {
    if (!withinWindow) return;

    function onDocumentPaste(event: globalThis.ClipboardEvent) {
      // Con un modal encima, el pegado es de quien esté trabajando ahí.
      if (isTemplateModalOpen || isQuickRepliesOpen) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;

      event.preventDefault();
      addFiles(files);
    }

    document.addEventListener("paste", onDocumentPaste);
    return () => document.removeEventListener("paste", onDocumentPaste);
  }, [withinWindow, isTemplateModalOpen, isQuickRepliesOpen]);

  // Lo que puede abrirse en grande: los adjuntos con vista previa. Se guarda
  // qué posición ocupa cada uno para que abrir el tercero abra el tercero.
  const previewItems: MediaItem[] = [];
  const previewIndexById = new Map<string, number>();
  for (const pending of pendingFiles) {
    if (!pending.previewUrl) continue;
    previewIndexById.set(pending.id, previewItems.length);
    previewItems.push({
      url: pending.previewUrl,
      type: pending.mediaType === "video" ? "video" : "image",
      caption: pending.file.name,
    });
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
    setUploadedCount(0);
    try {
      const supabase = createClient();

      // Las subidas no dependen unas de otras: encadenarlas hacía que cinco
      // fotos fueran cinco esperas seguidas. En paralelo es una sola espera,
      // la de la más lenta.
      const uploaded = await Promise.all(
        pendingFiles.map(async ({ file, mediaType }) => {
          // Id aleatorio y no el nombre del archivo: el bucket es privado,
          // pero una ruta adivinable seguiría siendo una pista de más.
          const extension = file.name.includes(".") ? `.${file.name.split(".").pop()}` : "";
          const path = `outbound/${conversation.id}/${crypto.randomUUID()}${extension}`;
          const { error: uploadError } = await supabase.storage
            .from(MEDIA_BUCKET)
            .upload(path, file, { contentType: file.type });
          if (uploadError) throw uploadError;
          setUploadedCount((done) => done + 1);
          return { url: mediaUrlFor(path), mediaType };
        })
      );

      // Los envíos sí van uno detrás de otro: el cliente tiene que verlas en
      // el mismo orden en que se adjuntaron, y en paralelo llegarían barajadas.
      for (let i = 0; i < uploaded.length; i++) {
        await sendMediaMessage(
          conversation.id,
          uploaded[i].url,
          uploaded[i].mediaType,
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

    // flushSync y no requestAnimationFrame: el rAF corría en carrera contra
    // el commit de React, y si llegaba primero, el navegador reponía el
    // cursor al final al asentar el valor nuevo del textarea controlado. En
    // las máquinas de 8 núcleos el commit casi siempre ganaba; el runner de
    // CI perdió la carrera en cada corrida (29/8/2026) y el cursor quedaba
    // después del par de marcadores en vez de en medio. Con el commit
    // forzado síncrono, posicionar el cursor justo después es determinista.
    flushSync(() => setText(newText));

    const newStart = start + marker.length;
    const newEnd = newStart + selected.length;
    textarea.setSelectionRange(newStart, newEnd);
  }

  /**
   * Inserta un emoji en el caret (T3b, "Seis frentes del buzón", 8/9/2026).
   *
   * `insertAtCaret` (composer-text.ts) hace la aritmética pura; acá lo único
   * que hace falta es leer dónde está el cursor AHORA (el popover del emoji
   * no lo sabe: nunca tuvo el foco) y devolvérselo al cuadro después de
   * insertar. `flushSync` por el mismo motivo que `wrapSelection`: sin el
   * commit forzado, `setSelectionRange` puede correr contra el commit de
   * React y perder la carrera bajo CPU contendida.
   */
  function insertEmoji(emoji: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? text.length;
    const { text: nextText, caret } = insertAtCaret(text, start, end, emoji);

    flushSync(() => setText(nextText));

    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
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
          {/* Con la miniatura se ve cuál foto se está citando: cuando el
              cliente mandó cinco, "Foto" a secas no distingue ninguna. */}
          <div className="flex min-w-0 items-center gap-2">
            <QuotedThumb message={replyingTo} />
            <div className="min-w-0">
              <p className="font-medium text-accent">
                Respondiendo a {replyingTo.direction === "inbound" ? "cliente" : replyingTo.senderAgent?.displayName ?? "agente"}
              </p>
              <p className="truncate text-muted">{replyingTo.content || quotedTypeLabel(replyingTo)}</p>
            </div>
          </div>
          <button type="button" onClick={onCancelReply} className="shrink-0 text-muted hover:text-foreground" aria-label="Cancelar la cita">
            <X size={14} />
          </button>
        </div>
      )}

      {pendingFiles.length > 0 && isUploading && (
        <p className="crm-attach-progress lm-num" role="status">
          Subiendo {Math.min(uploadedCount + 1, pendingFiles.length)} de {pendingFiles.length}…
        </p>
      )}

      {pendingFiles.length > 0 && (
        <div className="crm-attach-preview">
          {pendingFiles.map((p, index) => (
            <div className="crm-attach-item" key={p.id}>
              {/* Se abre en grande con el mismo visor del chat: antes de
                  soltar una foto uno quiere comprobar que es la correcta y
                  que se lee lo que muestra, y la miniatura no da para eso. */}
              {p.previewUrl && (
                <MediaThumb items={previewItems} index={previewIndexById.get(p.id) ?? 0} />
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
                aria-label={etiquetaQuitar(p, index, pendingFiles)}
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

        <EmojiStickerPopover
          conversation={conversation}
          withinWindow={withinWindow}
          agent={currentAgent}
          onInsertEmoji={insertEmoji}
        />

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
          ref={textareaRef}
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
          isDisabled={!withinWindow || isUploading || (pendingFiles.length === 0 && !text.trim())}
          onPress={pendingFiles.length > 0 ? handleSendFiles : handleSend}
          aria-label={isUploading ? "Enviando..." : "Enviar mensaje"}
          className="shrink-0"
        >
          <Send size={18} />
        </Button>
      </div>

      <TemplatePickerModal
        isOpen={isTemplateModalOpen}
        onOpenChange={setIsTemplateModalOpen}
        templates={templates}
        contactName={contactName(conversation)}
        conversationId={conversation.id}
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
