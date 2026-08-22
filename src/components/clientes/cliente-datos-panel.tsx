"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, UserPen } from "lucide-react";
import { Button, Input, Label, Modal, toast } from "@heroui/react";
import type { CedulaType, Contact } from "@/lib/types";
import { VENEZUELA_STATES } from "@/lib/venezuela";
import { createClient } from "@/lib/supabase/client";
import { updateContactProfile } from "@/lib/mutations";

/**
 * Corregir los datos de una persona sin tener que cerrar una venta de nuevo.
 *
 * Escribe las mismas columnas que el cierre de venta, menos el comprobante:
 * ese pertenece a la venta, no al perfil. Al guardar se pide un refresco del
 * componente de servidor en vez de mantener una copia en memoria.
 */
export function ClienteDatosPanel({ contact }: { contact: Contact }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [displayName, setDisplayName] = useState(contact.displayName ?? contact.profileName ?? "");
  const [cedulaType, setCedulaType] = useState<CedulaType>(contact.cedulaType ?? "V");
  const [cedulaNumber, setCedulaNumber] = useState(contact.cedulaNumber ?? "");
  const [state, setState] = useState(contact.state ?? "");
  const [city, setCity] = useState(contact.city ?? "");
  const [address, setAddress] = useState(contact.address ?? "");

  function open() {
    // Reabrir tras cancelar no debe conservar lo tecleado a medias.
    setDisplayName(contact.displayName ?? contact.profileName ?? "");
    setCedulaType(contact.cedulaType ?? "V");
    setCedulaNumber(contact.cedulaNumber ?? "");
    setState(contact.state ?? "");
    setCity(contact.city ?? "");
    setAddress(contact.address ?? "");
    setIsOpen(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    try {
      await updateContactProfile(createClient(), contact.id, {
        displayName,
        // Sin número, el tipo de cédula no significa nada: se guardan los dos
        // en null para no dejar una "V-" suelta en la ficha.
        cedulaType: cedulaNumber.trim() ? cedulaType : null,
        cedulaNumber,
        state,
        city,
        address,
      });
      toast.success("Datos actualizados.");
      setIsOpen(false);
      router.refresh();
    } catch {
      toast.danger("No se pudieron guardar los datos.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <button type="button" className="crm-pill" onClick={open}>
        <Pencil size={13} />
        Editar
      </button>

      <Modal isOpen={isOpen} onOpenChange={setIsOpen}>
        <Modal.Backdrop>
          <Modal.Container size="md" placement="center">
            <Modal.Dialog>
              <form onSubmit={handleSubmit}>
                <Modal.Header>
                  <Modal.Icon>
                    <UserPen size={18} />
                  </Modal.Icon>
                  <Modal.Heading>Editar datos del cliente</Modal.Heading>
                  <Modal.CloseTrigger />
                </Modal.Header>

                <Modal.Body className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cli-name">Nombre</Label>
                    <Input
                      id="cli-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      fullWidth
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cli-phone">Número de WhatsApp</Label>
                    <Input id="cli-phone" value={contact.phoneNumber} disabled fullWidth />
                    <p className="lm-hint">El número identifica al contacto: no se edita desde acá.</p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cli-cedula-number">Cédula</Label>
                    <div className="flex gap-2">
                      <select
                        id="cli-cedula-type"
                        value={cedulaType}
                        onChange={(e) => setCedulaType(e.target.value as CedulaType)}
                        className="w-20 lm-select"
                        aria-label="Tipo de cédula"
                      >
                        <option value="V">V</option>
                        <option value="E">E</option>
                      </select>
                      <Input
                        id="cli-cedula-number"
                        value={cedulaNumber}
                        onChange={(e) => setCedulaNumber(e.target.value)}
                        inputMode="numeric"
                        fullWidth
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cli-state">Estado</Label>
                    <select
                      id="cli-state"
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                      className="lm-select"
                    >
                      <option value="">Sin especificar</option>
                      {VENEZUELA_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cli-city">Ciudad</Label>
                    <Input id="cli-city" value={city} onChange={(e) => setCity(e.target.value)} fullWidth />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cli-address">Dirección</Label>
                    <Input id="cli-address" value={address} onChange={(e) => setAddress(e.target.value)} fullWidth />
                  </div>
                </Modal.Body>

                <Modal.Footer>
                  <Button variant="secondary" type="button" onPress={() => setIsOpen(false)} isDisabled={isSaving}>
                    Cancelar
                  </Button>
                  <Button variant="primary" type="submit" isDisabled={isSaving}>
                    {isSaving ? "Guardando…" : "Guardar"}
                  </Button>
                </Modal.Footer>
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
