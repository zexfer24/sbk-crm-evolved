"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Button, Input, Label, Modal, TextArea } from "@heroui/react";
import { validarDatosPresupuesto } from "@/lib/presupuestos";

/**
 * El modal que pide nombre, apellido y nota antes de guardar un carrito como
 * presupuesto (21/10/2026, plan "Presupuestos y mensajes rápidos", T3). Lo
 * comparten el carrito de /inventario y el panel del chat.
 *
 * No sabe de Supabase: `onGuardar` hace el trabajo y este modal solo muestra
 * qué pasó. Si falla, el motivo aparece DENTRO del modal (`role="alert"`) y no
 * se cierra, para que el asesor no pierda lo que escribió. Con
 * `puedeGuardarCambios` (reabrió uno suyo, o es supervisor) hay dos caminos:
 * «Guardar cambios» reemplaza ese presupuesto y «Guardar como nuevo» deja el
 * original intacto; sin él, solo «Guardar», que siempre crea uno nuevo.
 */

export interface DatosPresupuestoForm {
  nombre: string;
  apellido: string;
  nota: string;
}

interface GuardarPresupuestoModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lo que aparece al abrir: el contacto del chat, o el presupuesto reabierto. */
  inicial: DatosPresupuestoForm;
  puedeGuardarCambios: boolean;
  onGuardar: (datos: DatosPresupuestoForm, modo: "cambios" | "nuevo") => Promise<void>;
}

type CampoForm = keyof DatosPresupuestoForm;

export function GuardarPresupuestoModal({
  isOpen,
  onOpenChange,
  inicial,
  puedeGuardarCambios,
  onGuardar,
}: GuardarPresupuestoModalProps) {
  const [datos, setDatos] = useState<DatosPresupuestoForm>(inicial);
  const [errores, setErrores] = useState<Partial<Record<CampoForm, string>>>({});
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // El modal no se desmonta al cerrarse (sigue vivo con `isOpen=false`), así
  // que lo escrito la vez anterior seguiría ahí. Se reinicia con `inicial`
  // cada vez que ABRE, con el patrón "Adjusting state when a prop changes" de
  // React (durante el render, antes de pintar) y no con un `setState` dentro
  // de un `useEffect`, que dispara `react-hooks/set-state-in-effect`.
  const [estabaAbierto, setEstabaAbierto] = useState(isOpen);
  if (isOpen !== estabaAbierto) {
    setEstabaAbierto(isOpen);
    if (isOpen) {
      setDatos(inicial);
      setErrores({});
      setErrorGeneral(null);
      setGuardando(false);
    }
  }

  function editar(campo: CampoForm, valor: string) {
    setDatos((prev) => ({ ...prev, [campo]: valor }));
    // Se borra SOLO el error del campo que cambió: no se revalida el resto.
    setErrores((prev) => {
      if (!prev[campo]) return prev;
      const siguiente = { ...prev };
      delete siguiente[campo];
      return siguiente;
    });
  }

  async function guardar(modo: "cambios" | "nuevo") {
    if (guardando) return;
    const recortados: DatosPresupuestoForm = {
      nombre: datos.nombre.trim(),
      apellido: datos.apellido.trim(),
      nota: datos.nota.trim(),
    };
    const encontrados = validarDatosPresupuesto(recortados);
    setErrores(encontrados);
    setErrorGeneral(null);
    if (Object.keys(encontrados).length > 0) return;

    setGuardando(true);
    try {
      await onGuardar(recortados, modo);
      onOpenChange(false);
    } catch (error) {
      setErrorGeneral(
        error instanceof Error && error.message ? error.message : "No se pudo guardar el presupuesto. Intenta de nuevo."
      );
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(abierto) => {
        // Mientras guarda no se cierra con Escape ni con un clic afuera.
        if (!abierto && guardando) return;
        onOpenChange(abierto);
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <Save size={18} />
              </Modal.Icon>
              <Modal.Heading>Guardar presupuesto</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="presupuesto-nombre" className="lm-required">
                  Nombre
                </Label>
                <Input
                  id="presupuesto-nombre"
                  value={datos.nombre}
                  onChange={(e) => editar("nombre", e.target.value)}
                  fullWidth
                />
                {errores.nombre && (
                  <p role="alert" className="lm-field-error">
                    {errores.nombre}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="presupuesto-apellido" className="lm-required">
                  Apellido
                </Label>
                <Input
                  id="presupuesto-apellido"
                  value={datos.apellido}
                  onChange={(e) => editar("apellido", e.target.value)}
                  fullWidth
                />
                {errores.apellido && (
                  <p role="alert" className="lm-field-error">
                    {errores.apellido}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="presupuesto-nota">Nota (opcional)</Label>
                <TextArea
                  id="presupuesto-nota"
                  value={datos.nota}
                  onChange={(e) => editar("nota", e.target.value)}
                  rows={3}
                  fullWidth
                />
                {errores.nota && (
                  <p role="alert" className="lm-field-error">
                    {errores.nota}
                  </p>
                )}
              </div>

              {errorGeneral && (
                <p role="alert" className="lm-field-error">
                  {errorGeneral}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              {puedeGuardarCambios ? (
                <>
                  <Button variant="secondary" onPress={() => guardar("nuevo")} isDisabled={guardando}>
                    Guardar como nuevo
                  </Button>
                  <Button variant="primary" onPress={() => guardar("cambios")} isDisabled={guardando}>
                    Guardar cambios
                  </Button>
                </>
              ) : (
                <Button variant="primary" onPress={() => guardar("nuevo")} isDisabled={guardando}>
                  Guardar
                </Button>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
