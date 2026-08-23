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
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingProof, setIsUploadingProof] = useState(false);
  const proofInputRef = useRef<HTMLInputElement>(null);

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

  async function handleSubmit() {
    if (!displayName.trim()) {
      toast.danger("El nombre del cliente es obligatorio.");
      return;
    }
    if (cart.length === 0) {
      toast.danger("Agrega al menos un repuesto para cerrar la venta.");
      return;
    }
    if (!paymentMethod) {
      toast.danger("Elige con qué pagó el cliente.");
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
          cedulaType: cedulaType || null,
          cedulaNumber: cedulaNumber.trim() || null,
          state: state || null,
          city: city.trim() || null,
          address: address.trim() || null,
          paymentProofUrl,
          paymentMethod,
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
                <Label htmlFor="sale-name">Nombre</Label>
                <Input id="sale-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} fullWidth />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-whatsapp">Número de WhatsApp</Label>
                <Input id="sale-whatsapp" value={contact.phoneNumber} disabled fullWidth />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-cedula-number">Cédula</Label>
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
                    value={cedulaNumber}
                    onChange={(e) => setCedulaNumber(e.target.value)}
                    placeholder="12345678"
                    fullWidth
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-state">Estado</Label>
                <select
                  id="sale-state"
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
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-city">Ciudad</Label>
                <Input id="sale-city" value={city} onChange={(e) => setCity(e.target.value)} fullWidth />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-address">Dirección</Label>
                <TextArea id="sale-address" value={address} onChange={(e) => setAddress(e.target.value)} rows={2} fullWidth />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-payment-method">Método de pago</Label>
                <select
                  id="sale-payment-method"
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
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sale-closed-by">Cierra la venta</Label>
                {/* Deshabilitado y no oculto: quien cierra tiene que ver a
                    nombre de quién queda antes de confirmar. Sale de la sesión
                    —no de la asignación de la conversación— y no se elige. */}
                <Input id="sale-closed-by" value={agent.displayName} disabled fullWidth />
                <p className="lm-hint">Queda registrado a tu nombre y después no se puede cambiar.</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Comprobante de pago</Label>

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
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => onOpenChange(false)} isDisabled={isSaving}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                onPress={handleSubmit}
                isDisabled={isSaving || cart.length === 0 || !paymentMethod}
              >
                {isSaving ? "Guardando..." : "Guardar y cerrar venta"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
