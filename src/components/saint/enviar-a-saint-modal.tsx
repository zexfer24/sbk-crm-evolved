"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Button, Input, Label, Modal, toast } from "@heroui/react";
import type { CedulaType } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { configErrorMessage } from "@/lib/config-write";
import { enviarBorradorSaint } from "@/lib/saint-borradores-data";
import {
  mensajeErrorEnvio,
  validarClienteSaint,
  type CampoClienteSaint,
  type DatosClienteSaint,
  type OrigenSaint,
} from "@/lib/saint-borradores";

/**
 * El modal de «Facturar en SAINT» (25/10/2026, plan "Enviar a SAINT", T3;
 * renombrado el 28/10/2026): pide los datos del cliente que SAINT necesita
 * —cédula V/E, nombre y apellido obligatorios; teléfono OPCIONAL desde el
 * 28/10, hay clientes de mostrador que no lo dan y la base ya acepta vacío— y
 * llama a la RPC que deja el borrador `pendiente`. Solo viajan
 * esos datos y los artículos; el precio lo pone SAINT.
 *
 * Las reglas (qué se exige, qué texto sale) son de `saint-borradores.ts`; aquí
 * no se repiten. Si el envío falla, el motivo sale en un toast y el modal
 * QUEDA ABIERTO para no perder lo escrito. Corre en el navegador: errores a
 * `toast` y `console.error`, nunca a `lib/log.ts`.
 */

interface EnviarASaintModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  origen: OrigenSaint;
  origenId: string;
  /** Lo que aparece al abrir. */
  inicial: DatosClienteSaint;
  onEnviado: () => void;
  /**
   * Corre antes del envío, con los datos ya validados; devuelve el id del origen
   * que se envía (el carrito del Inventario se guarda como presupuesto aquí).
   * Si lanza, no se envía nada.
   */
  prepararOrigen?: (datos: DatosClienteSaint) => Promise<string>;
}

export function EnviarASaintModal({
  isOpen,
  onOpenChange,
  origen,
  origenId,
  inicial,
  onEnviado,
  prepararOrigen,
}: EnviarASaintModalProps) {
  const [datos, setDatos] = useState<DatosClienteSaint>(inicial);
  const [errores, setErrores] = useState<Partial<Record<CampoClienteSaint, string>>>({});
  const [enviando, setEnviando] = useState(false);

  // El modal no se desmonta al cerrarse: lo escrito la vez anterior seguiría
  // ahí. Se reinicia con `inicial` cada vez que ABRE, con el patrón "Adjusting
  // state when a prop changes" (durante el render) y no con un `setState`
  // dentro de un `useEffect` (`react-hooks/set-state-in-effect`).
  const [estabaAbierto, setEstabaAbierto] = useState(isOpen);
  if (isOpen !== estabaAbierto) {
    setEstabaAbierto(isOpen);
    if (isOpen) {
      setDatos(inicial);
      setErrores({});
      setEnviando(false);
    }
  }

  function editar(cambio: Partial<DatosClienteSaint>, campo: CampoClienteSaint) {
    setDatos((prev) => ({ ...prev, ...cambio }));
    // Se borra SOLO el error del campo que cambió: no se revalida el resto.
    setErrores((prev) => {
      if (!prev[campo]) return prev;
      const siguiente = { ...prev };
      delete siguiente[campo];
      return siguiente;
    });
  }

  async function enviar() {
    if (enviando) return;
    const encontrados = validarClienteSaint(datos);
    setErrores(encontrados);
    if (Object.keys(encontrados).length > 0) return;

    setEnviando(true);

    // 28/10/2026 (plan "El carrito de cotización se ordena", T2): el carrito del
    // Inventario no existe en la base; `prepararOrigen` lo guarda como
    // presupuesto y devuelve su id. Si falla NO se envía nada y el modal queda
    // abierto con lo escrito.
    let id = origenId;
    if (prepararOrigen) {
      try {
        id = await prepararOrigen(datos);
      } catch (error) {
        console.error("saint_preparar_fallido", error);
        toast.danger(configErrorMessage(error, "No se pudo guardar el presupuesto antes de enviarlo."));
        setEnviando(false);
        return;
      }
    }

    try {
      await enviarBorradorSaint(createClient(), { origen, origenId: id, datos });
      toast.success("Enviado a SAINT para facturar. Te avisamos aquí cuando quede creado.");
      onOpenChange(false);
      onEnviado();
    } catch (error) {
      console.error("saint_envio_fallido", error);
      toast.danger(mensajeErrorEnvio(error));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(abierto) => {
        // Mientras envía no se cierra con Escape ni con un clic afuera.
        if (!abierto && enviando) return;
        onOpenChange(abierto);
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <Send size={18} />
              </Modal.Icon>
              <Modal.Heading>Facturar en SAINT</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <p className="text-sm">
                Se crea un documento en espera en SAINT con los artículos de la lista; el precio lo pone SAINT. El
                nombre y la cédula quedan guardados en el cliente.
              </p>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="saint-cedula-numero" className="lm-required">
                  Cédula
                </Label>
                <div className="flex gap-2">
                  <select
                    id="saint-cedula-tipo"
                    aria-label="Tipo de cédula"
                    value={datos.cedulaTipo}
                    onChange={(e) => editar({ cedulaTipo: e.target.value as CedulaType | "" }, "cedula")}
                    className="w-20 lm-select"
                  >
                    {datos.cedulaTipo === "" && <option value="">—</option>}
                    <option value="V">V</option>
                    <option value="E">E</option>
                  </select>
                  <Input
                    id="saint-cedula-numero"
                    value={datos.cedulaNumero}
                    onChange={(e) => editar({ cedulaNumero: e.target.value }, "cedula")}
                    placeholder="12345678"
                    fullWidth
                  />
                </div>
                {errores.cedula && (
                  <p role="alert" className="lm-field-error">
                    {errores.cedula}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="saint-nombre" className="lm-required">
                  Nombre
                </Label>
                <Input
                  id="saint-nombre"
                  value={datos.nombre}
                  onChange={(e) => editar({ nombre: e.target.value }, "nombre")}
                  fullWidth
                />
                {errores.nombre && (
                  <p role="alert" className="lm-field-error">
                    {errores.nombre}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="saint-apellido" className="lm-required">
                  Apellido
                </Label>
                <Input
                  id="saint-apellido"
                  value={datos.apellido}
                  onChange={(e) => editar({ apellido: e.target.value }, "apellido")}
                  fullWidth
                />
                {errores.apellido && (
                  <p role="alert" className="lm-field-error">
                    {errores.apellido}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="saint-telefono">Teléfono (opcional)</Label>
                <Input
                  id="saint-telefono"
                  type="tel"
                  value={datos.telefono}
                  onChange={(e) => editar({ telefono: e.target.value }, "telefono")}
                  placeholder="04141234567"
                  fullWidth
                />
                {errores.telefono && (
                  <p role="alert" className="lm-field-error">
                    {errores.telefono}
                  </p>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" onPress={() => onOpenChange(false)} isDisabled={enviando}>
                Cancelar
              </Button>
              <Button variant="primary" onPress={() => void enviar()} isDisabled={enviando}>
                {enviando ? "Enviando…" : "Facturar en SAINT"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
