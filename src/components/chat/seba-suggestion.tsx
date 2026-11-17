"use client";

import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "@heroui/react";
import type { Agent } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { resolveSuggestion } from "@/lib/mutations";
import { AREA_LABELS } from "@/lib/seba-v2-config";
import { suggestionSendable, suggestionTexts, type ShadowDraft } from "@/lib/shadow";
import { FormattedText } from "@/components/chat/formatted-text";
import "@/components/chat/seba-suggestion.css";

// ---------------------------------------------------------------------------
// Tarjeta de la sugerencia de copiloto (entrega 3 de Seba v2, 17/11/2026). Va
// sobre el composer y le ofrece al asesor lo que Seba v2 habría respondido:
//
//   Enviar    resuelve la sugerencia PRIMERO ("enviada") y solo si ganó la
//             carrera manda los textos, en orden, por la cola de envío del CRM.
//             Si otro asesor llegó antes (`resolveSuggestion` devuelve false) no
//             se manda nada: dos asesores no le escriben lo mismo al cliente.
//   Editar    deja los textos en el cuadro de mensaje y la tarjeta en estado
//             "editando"; la sugerencia se marca "editada" cuando el asesor
//             envía (lo avisa `use-seba-suggestion`, no esta tarjeta).
//   Descartar la marca "descartada".
//
// Un pase a un asesor no se "envía": solo se informa y se puede descartar. Las
// fotos del borrador no se reenvían en esta versión: solo cuentan los textos y
// los pies (`suggestionTexts`).
// ---------------------------------------------------------------------------

interface SebaSuggestionProps {
  draft: ShadowDraft;
  agent: Agent;
  /** El asesor pulsó «Editar» y todavía no envió. */
  editing: boolean;
  /** Entrega los textos a la cola de envío del chat (uno por mensaje, en orden). */
  onSend: (texts: string[]) => void;
  /** Deja este texto en el cuadro de mensaje. */
  onEdit: (text: string) => void;
  /** La sugerencia quedó resuelta: quita la tarjeta. */
  onResolved: () => void;
}

export function SebaSuggestion({ draft, agent, editing, onSend, onEdit, onResolved }: SebaSuggestionProps) {
  const [busy, setBusy] = useState(false);
  // Un ref y no solo `busy`: dos clics en el mismo tick leerían el mismo `false`.
  const inFlight = useRef(false);

  const texts = suggestionTexts(draft);
  const sendable = suggestionSendable(draft);
  const mensajes = [...draft.mensajes].sort((a, b) => a.orden - b.orden);
  const areaLabel = draft.area ? AREA_LABELS[draft.area] : "un asesor";

  async function handleSend() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const won = await resolveSuggestion(createClient(), agent, draft.id, "enviada");
      if (!won) {
        toast.warning("Otro asesor ya usó esta sugerencia");
        onResolved();
        return;
      }
      onResolved();
      onSend(texts);
    } catch (error) {
      console.error("No se pudo enviar la sugerencia de Seba:", error);
      toast.danger("No se pudo enviar la sugerencia. Vuelve a intentarlo.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function handleDiscard() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      // `false` = otro asesor ya la había resuelto: igual se quita de esta vista.
      await resolveSuggestion(createClient(), agent, draft.id, "descartada");
      onResolved();
    } catch (error) {
      console.error("No se pudo descartar la sugerencia de Seba:", error);
      toast.danger("No se pudo descartar la sugerencia. Vuelve a intentarlo.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="sbk-sug" aria-label="Sugerencia de Seba">
      <header className="sbk-sug-head">
        <Sparkles size={14} aria-hidden="true" />
        <h3 className="sbk-sug-title">Sugerencia de Seba</h3>
      </header>

      <div className="sbk-sug-body">
        {draft.escalaria ? (
          <p className="sbk-sug-pase">
            {`Seba pasaría este caso a ${areaLabel}${draft.nota ? `: ${draft.nota}` : "."}`}
          </p>
        ) : (
          <>
            {mensajes.map((m) => (
              <p className="sbk-sug-bubble" key={m.orden}>
                {m.tipo === "imagen" && !m.texto ? "Foto (no se reenvía en esta versión)" : <FormattedText text={m.texto ?? ""} />}
              </p>
            ))}
            {!sendable && <p className="sbk-sug-note">Esta sugerencia no trae texto para enviar.</p>}
            {editing && (
              <p className="sbk-sug-note">
                Editando en el cuadro de mensaje. Al enviarlo, la sugerencia queda como editada.
              </p>
            )}
          </>
        )}
      </div>

      <div className="sbk-sug-actions">
        {sendable && !editing && (
          <>
            <button type="button" className="crm-pill" data-variant="solid" onClick={handleSend} disabled={busy}>
              Enviar
            </button>
            <button type="button" className="crm-pill" onClick={() => onEdit(texts.join("\n\n"))} disabled={busy}>
              Editar
            </button>
          </>
        )}
        <button type="button" className="crm-pill" onClick={handleDiscard} disabled={busy}>
          Descartar
        </button>
      </div>
    </section>
  );
}
