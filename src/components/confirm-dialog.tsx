"use client";

import { useState, type ReactNode } from "react";
import { Button, Modal } from "@heroui/react";

/**
 * Confirmación compartida (21/10/2026, plan "Presupuestos y mensajes rápidos",
 * T3): borrar un presupuesto, borrar todos los propios y reemplazar el carrito
 * al reabrir uno. Antes cada pantalla armaba su propia confirmación en línea.
 *
 * `onConfirmar` puede ser asíncrono. Mientras corre, los dos botones quedan
 * deshabilitados (un segundo clic no repite el borrado) y el diálogo no se
 * puede cerrar. Si se resuelve, se cierra; si falla, QUEDA ABIERTO: quien
 * llama es quien muestra el toast con el motivo (aquí no se sabe si fue la
 * RLS, la red o un constraint). El foco inicial va a Cancelar: con Enter
 * apretado de más, lo que se pierde es el gesto, no el dato.
 */

interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  titulo: string;
  descripcion: ReactNode;
  confirmarEtiqueta: string;
  cancelarEtiqueta?: string;
  /** Acción destructiva: el botón de confirmar va en rojo. */
  peligro?: boolean;
  onConfirmar: () => void | Promise<void>;
}

export function ConfirmDialog({
  isOpen,
  onOpenChange,
  titulo,
  descripcion,
  confirmarEtiqueta,
  cancelarEtiqueta = "Cancelar",
  peligro = false,
  onConfirmar,
}: ConfirmDialogProps) {
  const [ocupado, setOcupado] = useState(false);

  async function confirmar() {
    if (ocupado) return;
    setOcupado(true);
    try {
      await onConfirmar();
      onOpenChange(false);
    } catch {
      // Queda abierto a propósito; el llamador ya avisó con su toast.
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(abierto) => {
        // Mientras guarda no se cierra con Escape ni con un clic afuera.
        if (!abierto && ocupado) return;
        onOpenChange(abierto);
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{titulo}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="text-sm">{descripcion}</Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" autoFocus onPress={() => onOpenChange(false)} isDisabled={ocupado}>
                {cancelarEtiqueta}
              </Button>
              <Button variant={peligro ? "danger" : "primary"} onPress={confirmar} isDisabled={ocupado}>
                {ocupado ? `${confirmarEtiqueta}…` : confirmarEtiqueta}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
