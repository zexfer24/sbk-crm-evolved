"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Handshake, Minus, Plus, Upload, X } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { Agent, CedulaType, Contact, ConversationQuote, Message } from "@/lib/types";
import { VENEZUELA_STATES } from "@/lib/venezuela";
import { createClient } from "@/lib/supabase/client";
import { fetchConversationQuotes } from "@/lib/data";
import { closeSaleWithContactInfo, type SaleLineItem } from "@/lib/mutations";

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
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingProof, setIsUploadingProof] = useState(false);
  const proofInputRef = useRef<HTMLInputElement>(null);

  // El monto de la venta sale de lo que la IA realmente cotizó en este chat
  // (conversation_quotes) — nunca se escribe a mano.
  const [quotes, setQuotes] = useState<ConversationQuote[]>([]);
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    async function loadQuotes() {
      setIsLoadingQuotes(true);
      try {
        const data = await fetchConversationQuotes(createClient(), conversationId);
        if (!cancelled) setQuotes(data);
      } catch {
        if (!cancelled) toast.danger("No se pudieron cargar las cotizaciones de este chat.");
      } finally {
        if (!cancelled) setIsLoadingQuotes(false);
      }
    }
    void loadQuotes();

    return () => {
      cancelled = true;
    };
  }, [isOpen, conversationId]);

  const selectedQuoteIds = Object.keys(quantities).filter((id) => quantities[id] > 0);
  const selectedItems: SaleLineItem[] = selectedQuoteIds
    .map((id) => quotes.find((q) => q.id === id))
    .filter((q): q is ConversationQuote => q !== undefined)
    .map((q) => ({
      quoteId: q.id,
      productId: q.productId,
      description: q.productName,
      unitPrice: q.priceUsd,
      quantity: quantities[q.id],
    }));
  const totalUsd = selectedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const bcvRateForClose = quotes[0]?.bcvRate ?? 0;

  function toggleQuote(quoteId: string) {
    setQuantities((prev) => {
      const next = { ...prev };
      if (next[quoteId] > 0) delete next[quoteId];
      else next[quoteId] = 1;
      return next;
    });
  }

  function changeQuantity(quoteId: string, delta: number) {
    setQuantities((prev) => ({ ...prev, [quoteId]: Math.max(1, (prev[quoteId] ?? 1) + delta) }));
  }

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
      const path = `payment-proofs/${conversationId}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("whatsapp-media")
        .upload(path, file, { contentType: file.type });
      if (uploadError) throw uploadError;

      const { data: publicUrl } = supabase.storage.from("whatsapp-media").getPublicUrl(path);
      setPaymentProofUrl(publicUrl.publicUrl);
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
    if (selectedItems.length === 0) {
      toast.danger("Selecciona al menos un producto cotizado para cerrar la venta.");
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
        },
        selectedItems,
        bcvRateForClose
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

              <div className="flex flex-col gap-1.5">
                <Label>¿Qué se vendió?</Label>
                <p className="text-xs text-muted">
                  El monto sale de lo que la IA cotizó en este chat — elige qué se vendió, no lo escribas a mano.
                </p>

                {isLoadingQuotes && <p className="text-xs text-muted">Cargando cotizaciones...</p>}

                {!isLoadingQuotes && quotes.length === 0 && (
                  <p className="crm-quote-empty text-xs text-muted">
                    La IA todavía no le cotizó ningún repuesto al cliente en este chat, así que no hay nada que
                    seleccionar. Si la venta es de algo que no pasó por el catálogo, pídele a un supervisor que la
                    registre.
                  </p>
                )}

                {quotes.length > 0 && (
                  <div className="crm-quote-list">
                    {quotes.map((q) => {
                      const isSelected = (quantities[q.id] ?? 0) > 0;
                      return (
                        <div key={q.id} className={`crm-quote-row${isSelected ? " is-selected" : ""}`}>
                          <label className="crm-quote-checkbox">
                            <input type="checkbox" checked={isSelected} onChange={() => toggleQuote(q.id)} />
                            <span className="crm-quote-name">{q.productName}</span>
                          </label>
                          <span className="crm-quote-price">${q.priceUsd.toFixed(2)}</span>
                          {isSelected && (
                            <div className="crm-quote-qty">
                              <button
                                type="button"
                                onClick={() => changeQuantity(q.id, -1)}
                                aria-label={`Restar una unidad de ${q.productName}`}
                              >
                                <Minus size={12} />
                              </button>
                              <span className="lm-num">{quantities[q.id]}</span>
                              <button
                                type="button"
                                onClick={() => changeQuantity(q.id, 1)}
                                aria-label={`Agregar una unidad de ${q.productName}`}
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div className="crm-quote-total">
                      <span>Total</span>
                      <span className="lm-num">${totalUsd.toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>

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
                    className="w-20 rounded-field border border-border bg-field px-2 text-sm text-field-foreground"
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
                  className="w-full rounded-field border border-border bg-field px-3 py-2 text-sm text-field-foreground"
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
                        <p className="text-xs text-muted">Fotos que envió el cliente por el chat:</p>
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
              <Button variant="primary" onPress={handleSubmit} isDisabled={isSaving || selectedItems.length === 0}>
                {isSaving ? "Guardando..." : "Guardar y cerrar venta"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
