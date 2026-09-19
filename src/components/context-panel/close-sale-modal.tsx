"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Handshake, Upload, X } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { Agent, CedulaType, Contact, Message, PaymentMethod, SaleCartItem } from "@/lib/types";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/types";
import { VENEZUELA_STATES } from "@/lib/venezuela";
import { createClient } from "@/lib/supabase/client";
import { fetchLatestBcvRate } from "@/lib/data";
import { MEDIA_BUCKET, mediaUrlFor } from "@/lib/storage";
import { closeSaleWithContactInfo } from "@/lib/mutations";
import { cartToLineItems } from "@/lib/sale-cart";
import {
  normalizeSaint,
  SALE_FIELD_LABELS,
  validateSaleDraft,
  type SaleDraft,
  type SaleField,
} from "@/lib/sale-draft";
import { SaleItemsEditor } from "@/components/context-panel/sale-items-editor";

interface CloseSaleModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contact: Contact;
  agent: Agent;
  messages: Message[];
}

export function CloseSaleModal({
  isOpen,
  onOpenChange,
  conversationId,
  contact,
  agent,
  messages,
}: CloseSaleModalProps) {
  const [displayName, setDisplayName] = useState(contact.displayName ?? contact.profileName ?? "");
  const [cedulaType, setCedulaType] = useState<CedulaType | "">(contact.cedulaType ?? "V");
  const [cedulaNumber, setCedulaNumber] = useState(contact.cedulaNumber ?? "");
  const [state, setState] = useState(contact.state ?? "");
  const [city, setCity] = useState(contact.city ?? "");
  const [address, setAddress] = useState(contact.address ?? "");
  const [paymentProofUrl, setPaymentProofUrl] = useState<string | null>(null);
  // Sin valor inicial a propósito: si arrancara en "Pago Móvil", la mitad de
  // las ventas quedarían registradas con el método que nadie eligió.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">("");
  // T5, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
  // D9): el número de la factura del sistema administrativo del negocio —NO
  // el correlativo interno `invoices.number` ("SBK-000123")—. Sin valor
  // inicial, igual que el método de pago: nadie lo eligió todavía.
  const [saintInvoiceNumber, setSaintInvoiceNumber] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingProof, setIsUploadingProof] = useState(false);
  const proofInputRef = useRef<HTMLInputElement>(null);

  // D10: un mensaje por campo inválido, pintado debajo de cada uno al
  // intentar guardar — reemplaza el toast mudo que solo avisaba el primer
  // problema que encontrara y nunca decía cuáles de los otros ocho también
  // faltaban.
  const [errors, setErrors] = useState<Partial<Record<SaleField, string>>>({});

  // Un ref por campo para poder enfocar "el primero inválido" (D10) sin
  // depender de que HeroUI reenvíe el ref con un tipo exacto compatible con
  // un mapa genérico — un switch en `focusFirstInvalidField` evita el lío de
  // varianza de tipos de intentar guardarlos todos en un solo objeto.
  const nameRef = useRef<HTMLInputElement>(null);
  const whatsappRef = useRef<HTMLInputElement>(null);
  const cedulaNumberRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<HTMLSelectElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLTextAreaElement>(null);
  const paymentMethodRef = useRef<HTMLSelectElement>(null);
  const saintRef = useRef<HTMLInputElement>(null);
  const proofFieldsetRef = useRef<HTMLFieldSetElement>(null);

  // Lo que lleva el cliente. El asesor lo arma: toma lo que la IA cotizó en
  // el chat y agrega del inventario lo que haga falta. El precio siempre
  // sale del catálogo — nunca se escribe a mano.
  const [cart, setCart] = useState<SaleCartItem[]>([]);

  // La tasa queda registrada en la orden para que el monto sea trazable
  // aunque la tasa cambie después. Antes se tomaba de la primera cotización,
  // así que una venta sin cotizaciones se guardaba con tasa 0.
  const [bcvRate, setBcvRate] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    fetchLatestBcvRate(createClient())
      .then((rate) => {
        if (!cancelled) setBcvRate(rate);
      })
      .catch(() => {
        // Sin tasa se puede cerrar igual: solo impide agregar repuestos con
        // el precio en bolívares, que son la excepción.
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Fotos que el cliente mandó por el chat — normalmente ahí está el comprobante.
  const customerImages = messages.filter(
    (m) => m.direction === "inbound" && m.messageType === "image" && m.mediaUrl
  );

  async function handleUploadProof(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setIsUploadingProof(true);
    try {
      const supabase = createClient();
      // Un comprobante de pago lleva datos bancarios del cliente: ruta
      // aleatoria y bucket privado, nunca el nombre del archivo.
      const extension = file.name.includes(".") ? `.${file.name.split(".").pop()}` : "";
      const path = `payment-proofs/${conversationId}/${crypto.randomUUID()}${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(path, file, { contentType: file.type });
      if (uploadError) throw uploadError;

      setPaymentProofUrl(mediaUrlFor(path));
    } catch {
      toast.danger("No se pudo subir el comprobante.");
    } finally {
      setIsUploadingProof(false);
    }
  }

  /** D10: enfoca el input del PRIMER campo inválido, en el orden visual del formulario (el mismo de `SALE_FIELD_LABELS`). */
  function focusFirstInvalidField(fieldErrors: Partial<Record<SaleField, string>>) {
    const firstInvalid = (Object.keys(SALE_FIELD_LABELS) as SaleField[]).find((field) => fieldErrors[field]);
    switch (firstInvalid) {
      case "displayName":
        nameRef.current?.focus();
        break;
      case "whatsappNumber":
        whatsappRef.current?.focus();
        break;
      case "cedula":
        cedulaNumberRef.current?.focus();
        break;
      case "state":
        stateRef.current?.focus();
        break;
      case "city":
        cityRef.current?.focus();
        break;
      case "address":
        addressRef.current?.focus();
        break;
      case "paymentMethod":
        paymentMethodRef.current?.focus();
        break;
      case "saintInvoiceNumber":
        saintRef.current?.focus();
        break;
      case "paymentProofUrl":
        proofFieldsetRef.current?.focus();
        break;
      default:
        break;
    }
  }

  async function handleSubmit() {
    // El carrito no es uno de los nueve campos obligatorios de D11 —no tiene
    // un único input al que atarle un mensaje bajo un campo— así que sigue
    // avisando con el mismo toast de siempre, antes de tocar el resto.
    if (cart.length === 0) {
      toast.danger("Agrega al menos un repuesto para cerrar la venta.");
      return;
    }

    const draft: SaleDraft = {
      displayName,
      whatsappNumber: contact.phoneNumber,
      cedulaType,
      cedulaNumber,
      state,
      city,
      address,
      paymentMethod,
      saintInvoiceNumber,
      paymentProofUrl,
      itemCount: cart.length,
    };

    const fieldErrors = validateSaleDraft(draft);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      focusFirstInvalidField(fieldErrors);
      return;
    }

    setIsSaving(true);
    try {
      const supabase = createClient();
      await closeSaleWithContactInfo(
        supabase,
        conversationId,
        contact.id,
        agent,
        {
          displayName: displayName.trim(),
          // `fieldErrors` ya vino vacío: los dos siguen tipados `X | ""`
          // porque así nace su estado, pero a esta altura no pueden estarlo.
          cedulaType: (cedulaType || null) as CedulaType | null,
          cedulaNumber: cedulaNumber.trim() || null,
          state: state || null,
          city: city.trim() || null,
          address: address.trim() || null,
          paymentProofUrl,
          paymentMethod: paymentMethod as PaymentMethod,
          saintInvoiceNumber: normalizeSaint(saintInvoiceNumber),
        },
        cartToLineItems(cart),
        bcvRate
      );
      toast.success("¡Venta cerrada!");
      onOpenChange(false);
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "No se pudo cerrar la venta. Intenta de nuevo.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <Handshake size={18} />
              </Modal.Icon>
              <Modal.Heading>Cerrar venta</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <p className="text-sm text-muted">
                Completa los datos del cliente para dejar la venta registrada.
              </p>

              <SaleItemsEditor
                conversationId={conversationId}
                cart={cart}
                onChange={setCart}
                bcvRate={bcvRate}
              />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-name" className="lm-required">
                  Nombre
                </Label>
                <Input
                  id="sale-name"
                  ref={nameRef}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  fullWidth
                />
                {errors.displayName && (
                  <p role="alert" className="lm-field-error">
                    {errors.displayName}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-whatsapp" className="lm-required">
                  Número de WhatsApp
                </Label>
                <Input id="sale-whatsapp" ref={whatsappRef} value={contact.phoneNumber} disabled fullWidth />
                {errors.whatsappNumber && (
                  <p role="alert" className="lm-field-error">
                    {errors.whatsappNumber}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-cedula-number" className="lm-required">
                  Cédula
                </Label>
                <div className="flex gap-2">
                  <select
                    id="sale-cedula-type"
                    value={cedulaType}
                    onChange={(e) => setCedulaType(e.target.value as CedulaType)}
                    className="w-20 lm-select"
                  >
                    <option value="V">V</option>
                    <option value="E">E</option>
                  </select>
                  <Input
                    id="sale-cedula-number"
                    ref={cedulaNumberRef}
                    value={cedulaNumber}
                    onChange={(e) => setCedulaNumber(e.target.value)}
                    placeholder="12345678"
                    fullWidth
                  />
                </div>
                {errors.cedula && (
                  <p role="alert" className="lm-field-error">
                    {errors.cedula}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-state" className="lm-required">
                  Estado
                </Label>
                <select
                  id="sale-state"
                  ref={stateRef}
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className="w-full lm-select"
                >
                  <option value="">Selecciona un estado...</option>
                  {VENEZUELA_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {errors.state && (
                  <p role="alert" className="lm-field-error">
                    {errors.state}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-city" className="lm-required">
                  Ciudad
                </Label>
                <Input id="sale-city" ref={cityRef} value={city} onChange={(e) => setCity(e.target.value)} fullWidth />
                {errors.city && (
                  <p role="alert" className="lm-field-error">
                    {errors.city}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-address" className="lm-required">
                  Dirección
                </Label>
                <TextArea
                  id="sale-address"
                  ref={addressRef}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  rows={2}
                  fullWidth
                />
                {errors.address && (
                  <p role="alert" className="lm-field-error">
                    {errors.address}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-payment-method" className="lm-required">
                  Método de pago
                </Label>
                <select
                  id="sale-payment-method"
                  ref={paymentMethodRef}
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  className="w-full lm-select"
                >
                  <option value="">Selecciona un método...</option>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {PAYMENT_METHOD_LABELS[method]}
                    </option>
                  ))}
                </select>
                {errors.paymentMethod && (
                  <p role="alert" className="lm-field-error">
                    {errors.paymentMethod}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-saint-invoice" className="lm-required">
                  Número de factura Saint
                </Label>
                <Input
                  id="sale-saint-invoice"
                  ref={saintRef}
                  value={saintInvoiceNumber}
                  onChange={(e) => setSaintInvoiceNumber(e.target.value)}
                  maxLength={40}
                  placeholder="00123"
                  fullWidth
                />
                {errors.saintInvoiceNumber && (
                  <p role="alert" className="lm-field-error">
                    {errors.saintInvoiceNumber}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-closed-by">Cierra la venta</Label>
                {/* Deshabilitado y no oculto: quien cierra tiene que ver a
                    nombre de quién queda antes de confirmar. Sale de la sesión
                    —no de la asignación de la conversación— y no se elige.
                    No lleva asterisco: no es uno de los nueve campos
                    obligatorios de D11, lo pone el sistema solo. */}
                <Input id="sale-closed-by" value={agent.displayName} disabled fullWidth />
                <p className="lm-hint">Queda registrado a tu nombre y después no se puede cambiar.</p>
              </div>

              {/* `<fieldset>` en vez de un <div> más: D10 pide que los tests
                  puedan alcanzar todo este bloque por su nombre accesible
                  (`aria-labelledby`), igual que un grupo de radios. */}
              <fieldset
                ref={proofFieldsetRef}
                tabIndex={-1}
                aria-labelledby="sale-proof-label"
                className="flex flex-col gap-1.5 lm-fieldset-reset"
              >
                <Label id="sale-proof-label" className="lm-required">
                  Comprobante de pago
                </Label>

                {paymentProofUrl ? (
                  <div className="crm-proof-selected">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={paymentProofUrl} alt="Comprobante de pago" />
                    <button
                      type="button"
                      className="crm-proof-remove"
                      onClick={() => setPaymentProofUrl(null)}
                      aria-label="Quitar comprobante"
                    >
                      <X size={12} />
                      Quitar
                    </button>
                  </div>
                ) : (
                  <>
                    {customerImages.length > 0 && (
                      <>
                        <p className="lm-hint">Fotos que envió el cliente por el chat:</p>
                        <div className="crm-proof-picker">
                          {customerImages.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className="crm-proof-option"
                              onClick={() => setPaymentProofUrl(m.mediaUrl)}
                              aria-label="Usar esta foto como comprobante"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={m.mediaUrl!} alt="" />
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    <input ref={proofInputRef} type="file" accept="image/*" hidden onChange={handleUploadProof} />
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => proofInputRef.current?.click()}
                      isDisabled={isUploadingProof}
                      className="self-start"
                    >
                      <Upload size={14} />
                      {isUploadingProof ? "Subiendo..." : "Subir comprobante"}
                    </Button>
                  </>
                )}
                {errors.paymentProofUrl && (
                  <p role="alert" className="lm-field-error">
                    {errors.paymentProofUrl}
                  </p>
                )}
              </fieldset>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => onOpenChange(false)} isDisabled={isSaving}>
                Cancelar
              </Button>
              <Button variant="primary" onPress={handleSubmit} isDisabled={isSaving}>
                {isSaving ? "Guardando..." : "Guardar y cerrar venta"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
