"use client";

import { useState } from "react";
import { Handshake } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { Agent, CedulaType, Contact } from "@/lib/types";
import { VENEZUELA_STATES } from "@/lib/venezuela";
import { createClient } from "@/lib/supabase/client";
import { closeSaleWithContactInfo } from "@/lib/mutations";

interface CloseSaleModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contact: Contact;
  agent: Agent;
}

export function CloseSaleModal({ isOpen, onOpenChange, conversationId, contact, agent }: CloseSaleModalProps) {
  const [displayName, setDisplayName] = useState(contact.displayName ?? contact.profileName ?? "");
  const [cedulaType, setCedulaType] = useState<CedulaType | "">(contact.cedulaType ?? "V");
  const [cedulaNumber, setCedulaNumber] = useState(contact.cedulaNumber ?? "");
  const [state, setState] = useState(contact.state ?? "");
  const [city, setCity] = useState(contact.city ?? "");
  const [address, setAddress] = useState(contact.address ?? "");
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit() {
    if (!displayName.trim()) {
      toast.danger("El nombre del cliente es obligatorio.");
      return;
    }
    setIsSaving(true);
    try {
      const supabase = createClient();
      await closeSaleWithContactInfo(supabase, conversationId, contact.id, agent, {
        displayName: displayName.trim(),
        cedulaType: cedulaType || null,
        cedulaNumber: cedulaNumber.trim() || null,
        state: state || null,
        city: city.trim() || null,
        address: address.trim() || null,
      });
      toast.success("¡Venta cerrada!");
      onOpenChange(false);
    } catch {
      toast.danger("No se pudo cerrar la venta. Intenta de nuevo.");
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
