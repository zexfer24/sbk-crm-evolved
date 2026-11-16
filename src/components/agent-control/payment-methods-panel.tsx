"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Input, Label, TextArea, toast } from "@heroui/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { WhatsappPreview } from "@/components/agent-control/whatsapp-preview";
import { configErrorMessage } from "@/lib/config-write";
import {
  PAYMENT_METHOD_CURRENCIES,
  PAYMENT_METHOD_CURRENCY_LABELS,
  PAYMENT_METHOD_INSTRUCTIONS_MAX,
  nextPaymentMethodSortOrder,
  paymentMethodKeyFromLabel,
  validatePaymentMethodDraft,
  type PaymentMethodConfig,
  type PaymentMethodCurrency,
  type PaymentMethodDraft,
  type PaymentMethodErrors,
} from "@/lib/payment-methods";
import { CASHEA_TEXT_MAX, parseCasheaSettings } from "@/lib/seba-v2-config";
import "@/components/agent-control/seba-v2.css";

// ---------------------------------------------------------------------------
// «Formas de pago» (T4, Entrega 2 de Seba v2: "Los datos del negocio",
// 16/11/2026). Un supervisor da de alta, edita, activa/desactiva y borra las
// formas de pago de contado viendo el texto tal como le llega al cliente; un
// asesor lo ve todo en solo lectura. Cashea va en un bloque aparte del mismo
// panel porque NO es una forma de contado (su clave está reservada): se
// financia y Seba no manda ningún enlace, pide los datos del titular y pasa el
// caso a ventas.
//
// El panel solo recibe props y callbacks; quien lo monta (la vista de Control
// IA) decide de dónde salen los datos. Los callbacks del padre LANZAN si el
// guardado falla (RLS, red): acá se atrapan y se muestran con `toast`.
// ---------------------------------------------------------------------------

export interface CasheaSettings {
  datosText: string;
  minimoUsd: number;
  seisCuotasDesdeUsd: number;
}

interface PaymentMethodsPanelProps {
  methods: PaymentMethodConfig[];
  /** null = la base todavía no tiene las columnas (falta la migración): se pinta «No disponible», nunca campos vacíos. */
  cashea: CasheaSettings | null;
  canEdit: boolean;
  onCreate: (draft: PaymentMethodDraft, sortOrder: number) => Promise<void>;
  onUpdate: (key: string, draft: Omit<PaymentMethodDraft, "key">) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
  onToggleActive: (key: string, isActive: boolean) => Promise<void>;
  onSaveCashea: (settings: CasheaSettings) => Promise<void>;
}

interface FormState {
  /** `null` = alta; si no, la clave de la forma que se edita. */
  editingKey: string | null;
  key: string;
  label: string;
  currency: PaymentMethodCurrency;
  instructions: string;
  sebaEntrega: boolean;
}

const EMPTY_FORM: FormState = {
  editingKey: null,
  key: "",
  label: "",
  currency: "VES",
  instructions: "",
  sebaEntrega: true,
};

interface CasheaDraft {
  datosText: string;
  minimoUsd: string;
  seisCuotasDesdeUsd: string;
}

type CasheaField = keyof CasheaDraft;

/** Los montos viajan como TEXTO de input: `25` → "25", sin forzar decimales. */
function casheaDraftFrom(cashea: CasheaSettings | null): CasheaDraft {
  return {
    datosText: cashea?.datosText ?? "",
    minimoUsd: cashea ? String(cashea.minimoUsd) : "",
    seisCuotasDesdeUsd: cashea ? String(cashea.seisCuotasDesdeUsd) : "",
  };
}

function sameCasheaDraft(a: CasheaDraft, b: CasheaDraft): boolean {
  return a.datosText === b.datosText && a.minimoUsd === b.minimoUsd && a.seisCuotasDesdeUsd === b.seisCuotasDesdeUsd;
}

function FieldError({ message }: { message: string | undefined }): ReactNode {
  if (!message) return null;
  return (
    <p role="alert" className="lm-field-error">
      {message}
    </p>
  );
}

export function PaymentMethodsPanel({
  methods,
  cashea,
  canEdit,
  onCreate,
  onUpdate,
  onDelete,
  onToggleActive,
  onSaveCashea,
}: PaymentMethodsPanelProps) {
  const uid = useId();
  const [form, setForm] = useState<FormState | null>(null);
  const [keyTouched, setKeyTouched] = useState(false);
  const [errors, setErrors] = useState<PaymentMethodErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PaymentMethodConfig | null>(null);

  const [casheaDraft, setCasheaDraft] = useState<CasheaDraft>(() => casheaDraftFrom(cashea));
  const [casheaErrors, setCasheaErrors] = useState<Partial<Record<CasheaField, string>>>({});
  const [isSavingCashea, setIsSavingCashea] = useState(false);
  // "Ajustar estado cuando cambia una prop" (React): se compara DURANTE el
  // render contra una copia en estado, no con un setState dentro de un
  // useEffect (que dispara `react-hooks/set-state-in-effect`). Si el padre
  // refresca los datos y la persona no tiene cambios sin guardar, el borrador
  // se pone al día; si los tiene, se respeta lo que escribió.
  const [prevCashea, setPrevCashea] = useState(cashea);
  if (cashea !== prevCashea) {
    const hasUnsavedChanges = !sameCasheaDraft(casheaDraft, casheaDraftFrom(prevCashea));
    setPrevCashea(cashea);
    if (!hasUnsavedChanges) {
      setCasheaDraft(casheaDraftFrom(cashea));
      setCasheaErrors({});
    }
  }

  // Y para que, si esa misma clave reaparece más tarde, el formulario viejo no
  // resucite, el estado huérfano se descarta durante el render (mismo patrón
  // «ajustar estado» de arriba; sin useEffect).
  if (form !== null && form.editingKey !== null && !methods.some((m) => m.key === form.editingKey)) {
    setForm(null);
    setErrors({});
  }

  const id = (name: string) => `${uid}-${name}`;

  // ----------------------------- formas de contado -----------------------------

  function startCreate() {
    setForm({ ...EMPTY_FORM });
    setKeyTouched(false);
    setErrors({});
  }

  function startEdit(method: PaymentMethodConfig) {
    setForm({
      editingKey: method.key,
      key: method.key,
      label: method.label,
      currency: method.currency,
      instructions: method.instructions,
      sebaEntrega: method.sebaEntrega,
    });
    setKeyTouched(true);
    setErrors({});
  }

  function cancelForm() {
    setForm(null);
    setErrors({});
  }

  function clearError(...fields: (keyof PaymentMethodErrors)[]) {
    setErrors((current) => {
      if (!fields.some((field) => current[field])) return current;
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });
  }

  function handleLabelChange(value: string) {
    if (!form) return;
    // Mientras la clave no se haya tocado a mano, sigue al nombre; si cambia
    // sola, su error (de la clave anterior) ya no aplica.
    const followsLabel = form.editingKey === null && !keyTouched;
    setForm({ ...form, label: value, key: followsLabel ? paymentMethodKeyFromLabel(value) : form.key });
    clearError("label", ...(followsLabel ? (["key"] as const) : []));
  }

  function handleKeyChange(value: string) {
    if (!form) return;
    setKeyTouched(true);
    setForm({ ...form, key: value });
    clearError("key");
  }

  async function handleSave() {
    if (!form) return;
    const candidate: PaymentMethodDraft = {
      key: form.key.trim(),
      label: form.label.trim(),
      currency: form.currency,
      instructions: form.instructions.trim(),
      sebaEntrega: form.sebaEntrega,
    };
    const found = validatePaymentMethodDraft(
      candidate,
      form.editingKey === null ? { existingKeys: methods.map((m) => m.key) } : undefined
    );
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }

    setIsSaving(true);
    try {
      if (form.editingKey === null) {
        await onCreate(candidate, nextPaymentMethodSortOrder(methods));
      } else {
        await onUpdate(form.editingKey, {
          label: candidate.label,
          currency: candidate.currency,
          instructions: candidate.instructions,
          sebaEntrega: candidate.sebaEntrega,
        });
      }
      toast.success("Forma de pago guardada.");
      setForm(null);
      setErrors({});
    } catch (error) {
      // El formulario queda abierto con lo escrito: nada se pierde.
      toast.danger(configErrorMessage(error, "No se pudo guardar la forma de pago."));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggle(method: PaymentMethodConfig) {
    setTogglingKey(method.key);
    try {
      await onToggleActive(method.key, !method.isActive);
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudo cambiar el estado de la forma de pago."));
    } finally {
      setTogglingKey(null);
    }
  }

  async function confirmDelete(method: PaymentMethodConfig) {
    try {
      await onDelete(method.key);
      toast.success("Forma de pago borrada.");
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudo borrar la forma de pago."));
      // Se relanza para que el diálogo quede abierto (ver ConfirmDialog).
      throw error;
    }
  }

  function renderForm() {
    if (!form) return null;
    const isEditing = form.editingKey !== null;
    const instructionsLength = form.instructions.length;
    return (
      <div className="ac-pb-card ac-sv-form">
        <div className="ac-sv-row">
          <div className="ac-sv-field">
            <Label htmlFor={id("label")} className="lm-required">
              Nombre
            </Label>
            <Input
              id={id("label")}
              value={form.label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="Pago móvil"
              fullWidth
            />
            <FieldError message={errors.label} />
          </div>

          <div className="ac-sv-field">
            <Label htmlFor={id("key")} className="lm-required">
              Clave
            </Label>
            <Input
              id={id("key")}
              value={form.key}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="pago_movil"
              disabled={isEditing}
              fullWidth
            />
            {isEditing && <span className="lm-hint">La clave no se puede cambiar.</span>}
            <FieldError message={errors.key} />
          </div>

          <div className="ac-sv-field">
            <Label htmlFor={id("currency")}>Moneda</Label>
            <select
              id={id("currency")}
              className="lm-select"
              value={form.currency}
              onChange={(e) => {
                setForm({ ...form, currency: e.target.value as PaymentMethodCurrency });
                clearError("currency");
              }}
            >
              {PAYMENT_METHOD_CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {PAYMENT_METHOD_CURRENCY_LABELS[currency]}
                </option>
              ))}
            </select>
            <FieldError message={errors.currency} />
          </div>
        </div>

        <div className="ac-sv-compose">
          <div className="ac-sv-field">
            <Label htmlFor={id("instructions")} className="lm-required">
              Datos que recibe el cliente
            </Label>
            <TextArea
              id={id("instructions")}
              value={form.instructions}
              onChange={(e) => {
                setForm({ ...form, instructions: e.target.value });
                clearError("instructions");
              }}
              placeholder={"Banco: *Banesco*\nTeléfono: 0414-0000000"}
              rows={6}
              fullWidth
            />
            <span className="lm-hint ac-sv-count" data-over={instructionsLength > PAYMENT_METHOD_INSTRUCTIONS_MAX}>
              {instructionsLength}/{PAYMENT_METHOD_INSTRUCTIONS_MAX}
            </span>
            <FieldError message={errors.instructions} />
          </div>

          <WhatsappPreview
            text={form.instructions}
            label="Vista previa de lo que recibe el cliente"
            emptyHint="Aquí verás cómo le llega el texto al cliente."
          />
        </div>

        <div className="ac-sv-field">
          <label className="ac-sv-check">
            <input
              type="checkbox"
              checked={form.sebaEntrega}
              onChange={(e) => setForm({ ...form, sebaEntrega: e.target.checked })}
              aria-describedby={id("entrega-hint")}
            />
            <span>Seba entrega estos datos junto con el total</span>
          </label>
          <span id={id("entrega-hint")} className="lm-hint">
            Apagada, Seba ofrece esta forma y le pasa el caso a un asesor, como con Binance.
          </span>
        </div>

        <div className="ac-sv-actions">
          <Button variant="ghost" size="sm" onPress={cancelForm} isDisabled={isSaving}>
            Cancelar
          </Button>
          <Button variant="primary" size="sm" onPress={handleSave} isDisabled={isSaving}>
            Guardar
          </Button>
        </div>
      </div>
    );
  }

  // --------------------------------- Cashea ---------------------------------

  function handleCasheaChange(field: CasheaField, value: string) {
    setCasheaDraft((current) => ({ ...current, [field]: value }));
    // Solo se limpia el error del campo que cambió.
    setCasheaErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSaveCashea() {
    const parsed = parseCasheaSettings(casheaDraft);
    if (!parsed.ok) {
      setCasheaErrors(parsed.errors);
      return;
    }
    setCasheaErrors({});
    setIsSavingCashea(true);
    try {
      await onSaveCashea({
        datosText: parsed.datosText,
        minimoUsd: parsed.minimoUsd,
        seisCuotasDesdeUsd: parsed.seisCuotasDesdeUsd,
      });
      // 16/11/2026 (revisión de código): el borrador pasa a la forma canónica de
      // lo guardado ("25,5" → "25.5"); si no, queda como "cambios sin guardar"
      // para siempre y los refrescos del servidor ya no lo actualizan.
      setCasheaDraft({
        datosText: parsed.datosText,
        minimoUsd: String(parsed.minimoUsd),
        seisCuotasDesdeUsd: String(parsed.seisCuotasDesdeUsd),
      });
      toast.success("Datos de Cashea guardados.");
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudieron guardar los datos de Cashea."));
    } finally {
      setIsSavingCashea(false);
    }
  }

  // --------------------------------- vista ----------------------------------

  // 16/11/2026 (revisión de código): si el formulario edita una forma que ya no
  // está en la lista (otro supervisor la borró y llegó el refresco), se trata
  // como cerrado: antes el formulario desaparecía de la lista pero `form`
  // seguía no nulo y «Nueva forma de pago» quedaba oculto sin forma de volver.
  const formVisible = form !== null && (form.editingKey === null || methods.some((m) => m.key === form.editingKey));
  const editingKey = formVisible ? form.editingKey : null;

  return (
    <section className="dash-panel ac-sv-pay">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Formas de pago</h2>
      </div>

      <div className="ac-sv-body">
        <p className="ac-sv-note">Lo que Seba le entrega al cliente cuando elige cómo pagar de contado.</p>

        {canEdit && !formVisible && (
          <div className="ac-sv-actions">
            <Button variant="secondary" size="sm" onPress={startCreate}>
              <Plus size={14} />
              Nueva forma de pago
            </Button>
          </div>
        )}

        {canEdit && formVisible && editingKey === null && renderForm()}

        {methods.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">Todavía no hay formas de pago cargadas.</p>
          </div>
        ) : (
          <div className="ac-sv-list">
            {methods.map((method) =>
              canEdit && editingKey === method.key ? (
                // El formulario de edición ocupa el lugar de su tarjeta (hijo directo
                // de la grilla: `.ac-sv-list > .ac-sv-form` lo estira a lo ancho).
                <Fragment key={method.key}>{renderForm()}</Fragment>
              ) : (
                <article
                  className="ac-pb-card ac-sv-method"
                  key={method.key}
                  aria-label={method.label}
                  data-active={method.isActive}
                >
                  <div className="ac-pb-card-head">
                    <div className="ac-pb-card-who">
                      <span className="ac-pb-card-name">{method.label}</span>
                      <code className="ac-sv-key">{method.key}</code>
                    </div>

                    {canEdit && (
                      <div className="ac-agent-card-toggle">
                        <span className="ac-agent-card-toggle-label">Activa</span>
                        <button
                          className="ac-switch"
                          type="button"
                          role="switch"
                          aria-checked={method.isActive}
                          aria-label={`Activa: ${method.label}`}
                          data-on={method.isActive}
                          onClick={() => handleToggle(method)}
                          disabled={togglingKey === method.key}
                        />
                      </div>
                    )}
                  </div>

                  <div className="ac-sv-badges">
                    <span className="ac-badge" data-tone="link">
                      {PAYMENT_METHOD_CURRENCY_LABELS[method.currency]}
                    </span>
                    <span className="ac-badge" data-tone={method.sebaEntrega ? "good" : "wait"}>
                      {method.sebaEntrega ? "Seba entrega los datos" : "Seba pasa a ventas"}
                    </span>
                    {!method.isActive && (
                      <span className="ac-badge" data-tone="muted">
                        Inactiva
                      </span>
                    )}
                  </div>

                  <WhatsappPreview text={method.instructions} label={`Vista previa de ${method.label}`} />

                  {canEdit && (
                    <div className="ac-pb-card-foot">
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => startEdit(method)}
                        aria-label={`Editar ${method.label}`}
                      >
                        <Pencil size={13} />
                        Editar
                      </Button>
                      <span className="dash-panel-spacer" />
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => setDeleting(method)}
                        aria-label={`Borrar ${method.label}`}
                      >
                        <Trash2 size={13} />
                        Borrar
                      </Button>
                    </div>
                  )}
                </article>
              )
            )}
          </div>
        )}

        {!canEdit && <p className="ac-sv-note">Solo un supervisor o admin puede cambiar las formas de pago.</p>}

        <div className="ac-sv-section">
          <h3 className="ac-sv-section-title">Cashea</h3>
          <p className="ac-sv-note">
            Seba no envía el enlace: pide estos datos y le pasa el caso a un asesor de ventas.
          </p>

          {cashea === null ? (
            <p className="ac-sv-unavailable">No disponible: falta aplicar la migración de Seba v2.</p>
          ) : (
            <>
              <div className="ac-sv-compose">
                <div className="ac-sv-field">
                  <Label htmlFor={id("cashea-texto")} className="lm-required">
                    Texto que pide los datos del titular
                  </Label>
                  <TextArea
                    id={id("cashea-texto")}
                    value={casheaDraft.datosText}
                    onChange={(e) => handleCasheaChange("datosText", e.target.value)}
                    rows={8}
                    disabled={!canEdit}
                    fullWidth
                  />
                  <span className="lm-hint ac-sv-count" data-over={casheaDraft.datosText.length > CASHEA_TEXT_MAX}>
                    {casheaDraft.datosText.length}/{CASHEA_TEXT_MAX}
                  </span>
                  <FieldError message={casheaErrors.datosText} />
                </div>

                <WhatsappPreview
                  text={casheaDraft.datosText}
                  label="Vista previa del texto de Cashea"
                  emptyHint="Aquí verás cómo le llega el texto al cliente."
                />
              </div>

              <div className="ac-sv-row">
                <div className="ac-sv-field">
                  <Label htmlFor={id("cashea-minimo")} className="lm-required">
                    Compra mínima (USD)
                  </Label>
                  <Input
                    id={id("cashea-minimo")}
                    value={casheaDraft.minimoUsd}
                    onChange={(e) => handleCasheaChange("minimoUsd", e.target.value)}
                    inputMode="decimal"
                    disabled={!canEdit}
                    fullWidth
                  />
                  <FieldError message={casheaErrors.minimoUsd} />
                </div>

                <div className="ac-sv-field">
                  <Label htmlFor={id("cashea-seis")} className="lm-required">
                    Seis cuotas desde (USD)
                  </Label>
                  <Input
                    id={id("cashea-seis")}
                    value={casheaDraft.seisCuotasDesdeUsd}
                    onChange={(e) => handleCasheaChange("seisCuotasDesdeUsd", e.target.value)}
                    inputMode="decimal"
                    disabled={!canEdit}
                    fullWidth
                  />
                  <FieldError message={casheaErrors.seisCuotasDesdeUsd} />
                </div>
              </div>

              {canEdit && (
                <div className="ac-sv-actions">
                  <Button variant="primary" size="sm" onPress={handleSaveCashea} isDisabled={isSavingCashea}>
                    Guardar Cashea
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {deleting && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          titulo={`¿Borrar «${deleting.label}»?`}
          descripcion="Seba deja de ofrecer esta forma de pago. No se puede deshacer."
          confirmarEtiqueta="Sí, borrar"
          peligro
          onConfirmar={() => confirmDelete(deleting)}
        />
      )}
    </section>
  );
}
