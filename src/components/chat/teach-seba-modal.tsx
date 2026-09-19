"use client";

import { useState } from "react";
import { GraduationCap } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { Agent, LessonKind, LessonScope, Message } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createLesson, LessonIdentityError, type LessonDraft } from "@/lib/mutations";
import { QuotedText, QuotedThumb, quotedTypeLabel } from "@/components/chat/quoted-content";

// ---------------------------------------------------------------------------
// "Enseñar a Seba…" (T6, plan "Seba atiende el mostrador", 18/9/2026,
// requisito 7 del cliente): clic derecho sobre un mensaje entrante o una
// respuesta de la IA para dejarle una corrección o un sinónimo de búsqueda.
// El backend (T5) ya existe — `createLesson`/`LessonIdentityError` en
// mutations.ts — esta pieza es solo el formulario.
//
// Igual que `create-sticker-modal.tsx`: el `Modal` de HeroUI se monta por
// portal (react-aria-components), nunca como hermano dentro del grid del
// chat — la trampa del fragmento de `AppRail` (9/9/2026) no aplica acá.
// ---------------------------------------------------------------------------

/** Espeja el CHECK de `ai_lessons.content` (migración 20260917020000): 1-200 caracteres. */
const MAX_LESSON_CHARS = 200;

interface TeachSebaModalProps {
  isOpen: boolean;
  /** El mensaje sobre el que se está enseñando: siempre uno concreto, nunca "ninguno todavía". */
  message: Message;
  agent: Agent;
  conversationId: string;
  contactId: string;
  onOpenChange: (open: boolean) => void;
}

export function TeachSebaModal({ isOpen, message, agent, conversationId, contactId, onOpenChange }: TeachSebaModalProps) {
  const [scope, setScope] = useState<LessonScope>("global");
  const [kind, setKind] = useState<LessonKind>("nota");
  const [content, setContent] = useState("");
  const [synonymFrom, setSynonymFrom] = useState("");
  const [synonymTo, setSynonymTo] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  function reset() {
    setScope("global");
    setKind("nota");
    setContent("");
    setSynonymFrom("");
    setSynonymTo("");
    setIdentityError(null);
  }

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  // Un sinónimo no tiene su propio textarea: el CHECK de la base exige
  // `content` siempre (1-200 caracteres, para los dos `kind`), así que acá se
  // arma a partir del par jerga → catálogo en vez de pedirle al asesor que
  // escriba el mismo par dos veces.
  const trimmedContent = kind === "sinonimo" ? `${synonymFrom.trim()} → ${synonymTo.trim()}` : content.trim();

  const canSave =
    !isSaving &&
    trimmedContent.length > 0 &&
    trimmedContent.length <= MAX_LESSON_CHARS &&
    (kind === "nota" || (synonymFrom.trim().length > 0 && synonymTo.trim().length > 0));

  async function handleSave() {
    if (!canSave) return;
    setIdentityError(null);
    setIsSaving(true);
    try {
      const excerptSource = message.content?.trim() || quotedTypeLabel(message);
      const draft: LessonDraft = {
        scope,
        kind,
        content: trimmedContent,
        synonymFrom: kind === "sinonimo" ? synonymFrom.trim() : null,
        synonymTo: kind === "sinonimo" ? synonymTo.trim() : null,
        messageId: message.id,
        messageExcerpt: excerptSource.slice(0, MAX_LESSON_CHARS),
        conversationId: scope === "conversacion" ? conversationId : null,
        contactId,
      };
      await createLesson(createClient(), agent, draft);
      toast.success("Seba va a tener en cuenta esta lección.");
      handleOpenChange(false);
    } catch (err) {
      if (err instanceof LessonIdentityError) {
        setIdentityError(err.message);
      } else {
        toast.danger("No se pudo guardar la lección. Intenta de nuevo.");
      }
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
                <GraduationCap size={18} />
              </Modal.Icon>
              <Modal.Heading>Enseñar a Seba</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-3">
              <div className="crm-bubble-quote">
                <QuotedThumb message={message} />
                <div className="crm-quote-col">
                  <QuotedText message={message} />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Tipo de lección</Label>
                <div className="flex gap-2" role="group" aria-label="Tipo de lección">
                  <button
                    type="button"
                    className="crm-pill"
                    data-variant={kind === "nota" ? "solid" : undefined}
                    aria-pressed={kind === "nota"}
                    onClick={() => setKind("nota")}
                  >
                    Nota
                  </button>
                  <button
                    type="button"
                    className="crm-pill"
                    data-variant={kind === "sinonimo" ? "solid" : undefined}
                    aria-pressed={kind === "sinonimo"}
                    onClick={() => setKind("sinonimo")}
                  >
                    Sinónimo de búsqueda
                  </button>
                </div>
              </div>

              {kind === "nota" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="teach-seba-content">Corrección o nota para Seba</Label>
                  <TextArea
                    id="teach-seba-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value.slice(0, MAX_LESSON_CHARS))}
                    placeholder='Ej: la Bera SBR también se llama "Sport" entre los clientes.'
                    rows={4}
                    fullWidth
                  />
                  <span className="lm-hint">
                    {content.length}/{MAX_LESSON_CHARS}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="teach-seba-synonym-from">Cómo lo dice el cliente</Label>
                    <Input
                      id="teach-seba-synonym-from"
                      value={synonymFrom}
                      onChange={(e) => setSynonymFrom(e.target.value)}
                      placeholder="pastilla"
                      fullWidth
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="teach-seba-synonym-to">Cómo se llama en el catálogo</Label>
                    <Input
                      id="teach-seba-synonym-to"
                      value={synonymTo}
                      onChange={(e) => setSynonymTo(e.target.value)}
                      placeholder="pastillas de freno"
                      fullWidth
                    />
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label>Alcance</Label>
                <div className="flex gap-2" role="group" aria-label="Alcance de la lección">
                  <button
                    type="button"
                    className="crm-pill"
                    data-variant={scope === "global" ? "solid" : undefined}
                    aria-pressed={scope === "global"}
                    onClick={() => setScope("global")}
                  >
                    Todos los chats
                  </button>
                  <button
                    type="button"
                    className="crm-pill"
                    data-variant={scope === "conversacion" ? "solid" : undefined}
                    aria-pressed={scope === "conversacion"}
                    onClick={() => setScope("conversacion")}
                  >
                    Solo este chat
                  </button>
                </div>
              </div>

              {identityError && <p className="text-xs text-danger">{identityError}</p>}
            </Modal.Body>

            <Modal.Footer>
              <Button variant="secondary" onPress={() => handleOpenChange(false)}>
                Cancelar
              </Button>
              <Button variant="primary" onPress={handleSave} isDisabled={!canSave}>
                {isSaving ? "Guardando…" : "Guardar"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
