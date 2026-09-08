"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button, Input, Label, Modal, toast } from "@heroui/react";
import type { Agent } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createContactConversation } from "@/lib/mutations";
import { normalizePhoneInput } from "@/lib/whatsapp/phone";

interface NewContactModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  currentAgent: Agent;
  /**
   * Se llama tras crear (o reutilizar) la conversación, ya con el modal
   * cerrado. `existed` deja que quien la reciba decida si le importa —hoy
   * `inbox-sidebar.tsx` no distingue, siempre abre el chat—, pero la señal
   * viaja completa por si algún consumidor futuro sí necesita saberlo.
   */
  onCreated: (conversationId: string, existed: boolean) => void;
}

/**
 * "Agregar contacto" (T6, 8/9/2026): hasta hoy un contacto solo nacía cuando
 * escribía primero por WhatsApp. El operador quería adelantarse -- cargar
 * nombre + teléfono y abrir la conversación antes del primer mensaje.
 *
 * Sin mensaje del cliente el compositor sigue las reglas normales de la
 * ventana de 24h (cerrada) y ofrece plantillas -- eso NO se toca acá, es el
 * comportamiento correcto de WhatsApp para un contacto que todavía no
 * escribió.
 */
export function NewContactModal({ isOpen, onOpenChange, currentAgent, onCreated }: NewContactModalProps) {
  const [displayName, setDisplayName] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  function reset() {
    setDisplayName("");
    setPhoneInput("");
    setPhoneError(null);
  }

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  async function handleSave() {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      toast.danger("Ponle un nombre al contacto.");
      return;
    }
    const phoneNumber = normalizePhoneInput(phoneInput);
    if (!phoneNumber) {
      setPhoneError("Ese teléfono no se puede entregar. Escribe +58 o 04xx…");
      return;
    }
    setPhoneError(null);
    setIsSaving(true);
    try {
      const supabase = createClient();
      const { conversationId, existed } = await createContactConversation(supabase, {
        displayName: trimmedName,
        phoneNumber,
        agent: currentAgent,
      });
      if (existed) {
        toast.info("Ese número ya tiene conversación: te la abrimos.");
      }
      reset();
      onOpenChange(false);
      onCreated(conversationId, existed);
    } catch {
      // No se cierra: el asesor no perdió lo que escribió y puede reintentar.
      toast.danger("No se pudo agregar el contacto. Intenta de nuevo.");
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
                <UserPlus size={18} />
              </Modal.Icon>
              <Modal.Heading>Agregar contacto</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="new-contact-name">Nombre</Label>
                <Input
                  id="new-contact-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  fullWidth
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="new-contact-phone">Teléfono</Label>
                <Input
                  id="new-contact-phone"
                  value={phoneInput}
                  onChange={(e) => {
                    setPhoneInput(e.target.value);
                    if (phoneError) setPhoneError(null);
                  }}
                  placeholder="+58 o 04xx…"
                  fullWidth
                />
                {phoneError && <p className="text-xs text-danger">{phoneError}</p>}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => handleOpenChange(false)}>
                Cancelar
              </Button>
              <Button variant="primary" onPress={handleSave} isDisabled={isSaving}>
                Agregar
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
