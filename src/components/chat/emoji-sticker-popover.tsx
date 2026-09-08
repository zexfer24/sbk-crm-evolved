"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Lock, MoreHorizontal, Plus, Smile } from "lucide-react";
import { Button, Tooltip, toast } from "@heroui/react";
import type { EmojiClickData, Categories as EmojiCategories, Theme as EmojiTheme } from "emoji-picker-react";
import type { Agent, Conversation, Sticker } from "@/lib/types";
import { useTheme } from "@/lib/use-theme";
import { createClient } from "@/lib/supabase/client";
import { fetchStickers } from "@/lib/stickers-data";
import { deleteSticker, sendStickerMessage } from "@/lib/mutations";
import { CreateStickerModal } from "@/components/chat/create-sticker-modal";

// ---------------------------------------------------------------------------
// Emojis y stickers del compositor (T3b, "Seis frentes del buzón", 8/9/2026).
//
// `emoji-picker-react` no se carga hasta que se abre la pestaña de emojis por
// primera vez: es una librería con su propio set de datos, y cargarla con el
// resto del bundle del chat pesaría en cada carga de la bandeja aunque nadie
// use un emoji en la sesión. `next/dynamic(..., {ssr:false})` la deja fuera
// del bundle inicial y del render en el servidor —no tiene sentido pintarla
// ahí, esto solo existe en el navegador.
//
// Import de tipo, no de valor: `Categories`/`EmojiClickData` se usan solo
// para tipar, así que TypeScript los borra en la compilación y no arrastran
// el paquete real. Si se importara el enum `Categories` como valor acá
// arriba, el paquete se cargaría igual con el resto del compositor y el
// `dynamic` de abajo dejaría de tener sentido.
// ---------------------------------------------------------------------------

const EmojiPicker = dynamic(() => import("emoji-picker-react"), {
  ssr: false,
  loading: () => <p className="crm-emoji-loading">Cargando…</p>,
});

/**
 * Las nueve categorías de la librería, en el mismo orden de fábrica, con el
 * rótulo en español. Se escriben como texto y no como el enum `Categories`
 * (ver el comentario de arriba) — los valores coinciden uno a uno con los del
 * enum real (`suggested`, `smileys_people`…), así que la librería los
 * reconoce igual.
 */
const EMOJI_CATEGORIES: Array<{ category: EmojiCategories; name: string }> = [
  { category: "suggested" as EmojiCategories, name: "Usados frecuentemente" },
  { category: "smileys_people" as EmojiCategories, name: "Caritas y personas" },
  { category: "animals_nature" as EmojiCategories, name: "Animales y naturaleza" },
  { category: "food_drink" as EmojiCategories, name: "Comida y bebida" },
  { category: "travel_places" as EmojiCategories, name: "Viajes y lugares" },
  { category: "activities" as EmojiCategories, name: "Actividades" },
  { category: "objects" as EmojiCategories, name: "Objetos" },
  { category: "symbols" as EmojiCategories, name: "Símbolos" },
  { category: "flags" as EmojiCategories, name: "Banderas" },
];

type PopoverTab = "emojis" | "stickers";

interface EmojiStickerPopoverProps {
  conversation: Conversation;
  /** Ventana de 24h (la misma que ya deshabilita el resto del compositor). */
  withinWindow: boolean;
  agent: Agent;
  /** El compositor decide dónde cae el emoji en lo que ya se escribió. */
  onInsertEmoji: (emoji: string) => void;
}

export function EmojiStickerPopover({ conversation, withinWindow, agent, onInsertEmoji }: EmojiStickerPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<PopoverTab>("emojis");
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [loadingStickers, setLoadingStickers] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();

  // Mismo criterio que TagFilterMenu (bandeja): un menú anclado, no un
  // diálogo modal — cierra con Escape o al tocar afuera, sin atrapar el foco.
  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const loadStickers = useCallback(async () => {
    setLoadingStickers(true);
    try {
      const supabase = createClient();
      setStickers(await fetchStickers(supabase));
    } catch {
      toast.danger("No se pudo cargar la biblioteca de stickers.");
    } finally {
      setLoadingStickers(false);
    }
  }, []);

  // Se pide al abrir la pestaña, no al abrir el popover: si el asesor solo
  // usa emojis en toda la sesión, la biblioteca de stickers no se consulta
  // ni una vez. `loadStickers` marca `loadingStickers` de entrada -- un
  // setState síncrono al arrancar la carga, mismo caso que
  // inbox-sidebar.tsx:309 y use-inbox-pager.ts:167.
  useEffect(() => {
    if (isOpen && tab === "stickers") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadStickers();
    }
  }, [isOpen, tab, loadStickers]);

  function handleEmojiClick(data: EmojiClickData) {
    onInsertEmoji(data.emoji);
    setIsOpen(false);
  }

  async function handleSendSticker(sticker: Sticker) {
    if (!withinWindow) return;
    try {
      await sendStickerMessage(conversation.id, sticker.url);
      setIsOpen(false);
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "No se pudo enviar el sticker.");
    }
  }

  async function handleDeleteSticker(sticker: Sticker) {
    try {
      await deleteSticker(createClient(), sticker);
      setStickers((prev) => prev.filter((s) => s.id !== sticker.id));
    } catch {
      // La RLS de `stickers` es la que decide (dueño o supervisor/admin): el
      // rechazo de la base no trae un texto para mostrar tal cual, así que
      // se traduce a lo que de verdad puede estar pasando.
      toast.danger("Solo quien lo guardó o un supervisor puede quitarlo");
    } finally {
      setConfirmingId(null);
    }
  }

  function handleCreated(sticker: Sticker) {
    setStickers((prev) => [sticker, ...prev]);
    setIsCreateOpen(false);
    setTab("stickers");
  }

  function openConfirm(event: { preventDefault: () => void }, id: string) {
    event.preventDefault();
    setConfirmingId(id);
  }

  return (
    <div className="crm-emoji-sticker" ref={rootRef}>
      <Tooltip>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            size="md"
            isIconOnly
            onPress={() => setIsOpen((open) => !open)}
            aria-label="Emojis y stickers"
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            className="shrink-0"
          >
            <Smile size={18} />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>Emojis y stickers</Tooltip.Content>
      </Tooltip>

      {isOpen && (
        <div className="crm-emoji-sticker-panel" role="dialog" aria-label="Emojis y stickers">
          <div className="crm-emoji-sticker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "emojis"}
              className="crm-emoji-sticker-tab"
              onClick={() => setTab("emojis")}
            >
              Emojis
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "stickers"}
              className="crm-emoji-sticker-tab"
              onClick={() => setTab("stickers")}
            >
              Stickers
            </button>
          </div>

          {tab === "emojis" && (
            <div className="crm-emoji-sticker-emojis">
              <EmojiPicker
                onEmojiClick={handleEmojiClick}
                categories={EMOJI_CATEGORIES}
                searchPlaceholder="Buscar emoji"
                previewConfig={{ showPreview: false }}
                theme={resolved as EmojiTheme}
                lazyLoadEmojis
              />
            </div>
          )}

          {tab === "stickers" && (
            <div className="crm-emoji-sticker-stickers">
              {!withinWindow && (
                <p className="crm-emoji-sticker-warning text-warning">
                  <Lock size={13} className="shrink-0" />
                  Han pasado más de 24 h desde el último mensaje del cliente.
                </p>
              )}

              <Button
                variant="secondary"
                size="sm"
                onPress={() => setIsCreateOpen(true)}
                className="crm-emoji-sticker-create"
              >
                <Plus size={14} />
                Crear sticker
              </Button>

              {loadingStickers && <p className="crm-emoji-sticker-empty">Cargando…</p>}

              {!loadingStickers && stickers.length === 0 && (
                <p className="crm-emoji-sticker-empty">
                  Todavía no hay stickers guardados. Guarda uno con clic derecho sobre un sticker del chat, o
                  crea uno.
                </p>
              )}

              {!loadingStickers && stickers.length > 0 && (
                <div className="crm-sticker-grid">
                  {stickers.map((sticker) => (
                    <div
                      key={sticker.id}
                      className="crm-sticker-grid-item"
                      onContextMenu={(event) => openConfirm(event, sticker.id)}
                    >
                      <button
                        type="button"
                        className="crm-sticker-grid-send"
                        onClick={() => handleSendSticker(sticker)}
                        disabled={!withinWindow}
                        aria-label={sticker.name ? `Enviar sticker "${sticker.name}"` : "Enviar sticker"}
                      >
                        {/* Sticker propio del CRM (ruta con sesión, `mediaUrlFor`), no una
                            imagen de un dominio ajeno: `next/image` no aporta nada acá. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={sticker.url} alt={sticker.name ?? ""} loading="lazy" />
                      </button>
                      <button
                        type="button"
                        className="crm-sticker-grid-remove"
                        onClick={(event) => openConfirm(event, sticker.id)}
                        aria-label={
                          sticker.name ? `Quitar sticker "${sticker.name}" de la biblioteca` : "Quitar sticker de la biblioteca"
                        }
                      >
                        <MoreHorizontal size={13} />
                      </button>

                      {confirmingId === sticker.id && (
                        <div className="crm-sticker-grid-confirm">
                          <p>¿Quitar de la biblioteca?</p>
                          <div className="crm-sticker-grid-confirm-actions">
                            <button type="button" onClick={() => handleDeleteSticker(sticker)}>
                              Quitar
                            </button>
                            <button type="button" onClick={() => setConfirmingId(null)}>
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <CreateStickerModal isOpen={isCreateOpen} onOpenChange={setIsCreateOpen} agent={agent} onCreated={handleCreated} />
    </div>
  );
}
