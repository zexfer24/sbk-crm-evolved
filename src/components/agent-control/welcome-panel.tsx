"use client";

import { useId, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button, Input, Label, TextArea, toast } from "@heroui/react";
import { WhatsappPreview } from "@/components/agent-control/whatsapp-preview";
import { configErrorMessage } from "@/lib/config-write";
import {
  FOLLOWUPS_MAX,
  FOLLOWUPS_MIN,
  FOLLOWUP_MAX_CHARS,
  WELCOME_TEXT_MAX,
  hasWelcomeErrors,
  normalizeWelcomeDraft,
  validateWelcomeDraft,
  type SebaV2Config,
  type WelcomeDraft,
  type WelcomeErrors,
} from "@/lib/seba-v2-config";
import "@/components/agent-control/seba-v2.css";

// ---------------------------------------------------------------------------
// «Bienvenida» (T5, Entrega 2 de Seba v2: "Los datos del negocio", 16/11/2026).
// La bienvenida sale en DOS mensajes por ventana de 24 horas: el 1 es
// informativo y fijo (este panel lo edita con vista previa de WhatsApp); el 2 es
// UNA de las frases de la lista, que el código elige sin repetir la última usada
// en ese chat (por eso mínimo 2) y solo cuando el cliente nada más saludó. Un
// supervisor edita; un asesor lo ve en solo lectura.
//
// El panel solo recibe props y callbacks; quien lo monta decide de dónde salen
// los datos. `onSave` LANZA si el guardado falla (RLS, red): acá se atrapa y se
// muestra con `toast`.
// ---------------------------------------------------------------------------

interface WelcomePanelProps {
  /** null = la base todavía no tiene las columnas (falta la migración): se pinta «No disponible», nunca campos vacíos. */
  config: Pick<SebaV2Config, "welcomeText" | "welcomeFollowups"> | null;
  canEdit: boolean;
  onSave: (draft: WelcomeDraft) => Promise<void>;
}

function draftFrom(config: WelcomePanelProps["config"]): WelcomeDraft {
  return {
    welcomeText: config?.welcomeText ?? "",
    followups: config ? [...config.welcomeFollowups] : [],
  };
}

function sameDraft(a: WelcomeDraft, b: WelcomeDraft): boolean {
  return (
    a.welcomeText === b.welcomeText &&
    a.followups.length === b.followups.length &&
    a.followups.every((frase, i) => frase === b.followups[i])
  );
}

function FieldError({ message }: { message: string | undefined }): ReactNode {
  if (!message) return null;
  return (
    <p role="alert" className="lm-field-error">
      {message}
    </p>
  );
}

export function WelcomePanel({ config, canEdit, onSave }: WelcomePanelProps) {
  const uid = useId();
  const [draft, setDraft] = useState<WelcomeDraft>(() => draftFrom(config));
  const [errors, setErrors] = useState<WelcomeErrors>({});
  const [isSaving, setIsSaving] = useState(false);

  // "Ajustar estado cuando cambia una prop" (React): se compara DURANTE el
  // render contra una copia en estado, no con un setState dentro de un
  // useEffect (que dispara `react-hooks/set-state-in-effect`). Si el padre
  // refresca los datos y la persona no tiene cambios sin guardar, el borrador
  // se pone al día; si los tiene, se respeta lo que escribió.
  const [prevConfig, setPrevConfig] = useState(config);
  if (config !== prevConfig) {
    const hasUnsavedChanges = !sameDraft(draft, draftFrom(prevConfig));
    setPrevConfig(config);
    if (!hasUnsavedChanges) {
      setDraft(draftFrom(config));
      setErrors({});
    }
  }

  const id = (name: string) => `${uid}-${name}`;
  const hasChanges = !sameDraft(draft, draftFrom(config));

  function handleTextChange(value: string) {
    setDraft((current) => ({ ...current, welcomeText: value }));
    setErrors((current) => {
      if (!current.welcomeText) return current;
      const next = { ...current };
      delete next.welcomeText;
      return next;
    });
  }

  function handleFollowupChange(index: number, value: string) {
    setDraft((current) => ({
      ...current,
      followups: current.followups.map((frase, i) => (i === index ? value : frase)),
    }));
    // Solo se limpia el error de ESA frase.
    setErrors((current) => {
      if (!current.followupItems?.[index]) return current;
      const items = { ...current.followupItems };
      delete items[index];
      const next: WelcomeErrors = { ...current, followupItems: items };
      if (Object.keys(items).length === 0) delete next.followupItems;
      return next;
    });
  }

  function addFollowup() {
    if (draft.followups.length >= FOLLOWUPS_MAX) return;
    setDraft((current) => ({ ...current, followups: [...current.followups, ""] }));
    // Los errores por posición y el de cantidad dejan de aplicar a la lista nueva.
    setErrors((current) => ({ welcomeText: current.welcomeText }));
  }

  function removeFollowup(index: number) {
    if (draft.followups.length <= FOLLOWUPS_MIN) return;
    setDraft((current) => ({ ...current, followups: current.followups.filter((_, i) => i !== index) }));
    setErrors((current) => ({ welcomeText: current.welcomeText }));
  }

  async function handleSave() {
    const found = validateWelcomeDraft(draft);
    if (hasWelcomeErrors(found)) {
      setErrors(found);
      return;
    }
    setErrors({});
    setIsSaving(true);
    try {
      await onSave(normalizeWelcomeDraft(draft));
      toast.success("Bienvenida guardada.");
    } catch (error) {
      // El borrador queda tal cual: nada se pierde.
      toast.danger(configErrorMessage(error, "No se pudo guardar la bienvenida."));
    } finally {
      setIsSaving(false);
    }
  }

  const textLength = draft.welcomeText.length;
  const canRemove = canEdit && draft.followups.length > FOLLOWUPS_MIN;

  return (
    <section className="dash-panel ac-sv-welcome">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Bienvenida</h2>
      </div>

      <div className="ac-sv-body">
        <p className="ac-sv-note">
          Lo primero que recibe un cliente al escribir: sale una vez por ventana de 24 horas.
        </p>

        {config === null ? (
          <p className="ac-sv-unavailable">No disponible: falta aplicar la migración de Seba v2.</p>
        ) : (
          <>
            <div className="ac-sv-section ac-sv-section-first">
              <h3 className="ac-sv-section-title">Mensaje 1 · informativo</h3>
              <div className="ac-sv-compose">
                <div className="ac-sv-field">
                  <Label htmlFor={id("texto")} className="lm-required">
                    Texto de bienvenida
                  </Label>
                  <TextArea
                    id={id("texto")}
                    value={draft.welcomeText}
                    onChange={(e) => handleTextChange(e.target.value)}
                    rows={6}
                    disabled={!canEdit}
                    fullWidth
                  />
                  <span className="lm-hint ac-sv-count" data-over={textLength > WELCOME_TEXT_MAX}>
                    {textLength}/{WELCOME_TEXT_MAX}
                  </span>
                  <span className="lm-hint">Formato de WhatsApp: *negrita*, _cursiva_.</span>
                  <FieldError message={errors.welcomeText} />
                </div>

                <WhatsappPreview
                  text={draft.welcomeText}
                  label="Vista previa de la bienvenida"
                  emptyHint="Aquí verás cómo le llega la bienvenida al cliente."
                />
              </div>
            </div>

            <div className="ac-sv-section">
              <h3 className="ac-sv-section-title">Mensaje 2 · cuando el cliente solo saludó</h3>
              <p className="ac-sv-note">
                Seba envía una de estas frases, sin repetir la última que usó en ese chat.
              </p>

              <ul className="ac-sv-followups">
                {draft.followups.map((frase, i) => (
                  <li className="ac-sv-followup" key={i}>
                    <div className="ac-sv-followup-row">
                      <Input
                        value={frase}
                        onChange={(e) => handleFollowupChange(i, e.target.value)}
                        aria-label={`Frase ${i + 1}`}
                        disabled={!canEdit}
                        fullWidth
                      />
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => removeFollowup(i)}
                          isDisabled={!canRemove}
                          aria-label={`Quitar frase ${i + 1}`}
                        >
                          <X size={13} />
                          Quitar
                        </Button>
                      )}
                    </div>
                    <span className="lm-hint ac-sv-count" data-over={frase.length > FOLLOWUP_MAX_CHARS}>
                      {frase.length}/{FOLLOWUP_MAX_CHARS}
                    </span>
                    <FieldError message={errors.followupItems?.[i]} />
                  </li>
                ))}
              </ul>
              <FieldError message={errors.followups} />

              {canEdit && (
                <div className="ac-sv-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={addFollowup}
                    isDisabled={draft.followups.length >= FOLLOWUPS_MAX}
                  >
                    <Plus size={14} />
                    Agregar frase
                  </Button>
                </div>
              )}
            </div>

            {canEdit ? (
              <div className="ac-sv-actions">
                <Button variant="primary" size="sm" onPress={handleSave} isDisabled={isSaving || !hasChanges}>
                  Guardar bienvenida
                </Button>
              </div>
            ) : (
              <p className="ac-sv-note">Solo un supervisor o admin puede cambiar la bienvenida.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
