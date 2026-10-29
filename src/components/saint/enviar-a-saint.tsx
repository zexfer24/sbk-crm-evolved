"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@heroui/react";
import {
  decidirEnvio,
  etiquetaEstado,
  renglonesBloqueados,
  textoBloqueo,
  textoConfirmacionReenvio,
  type BorradorSaint,
  type DatosClienteSaint,
  type OrigenSaint,
} from "@/lib/saint-borradores";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EnviarASaintModal } from "@/components/saint/enviar-a-saint-modal";
import "./saint.css";

/**
 * «Facturar en SAINT» con su línea de estado (25/10/2026, plan "Enviar a
 * SAINT", T3; renombrado el 28/10/2026 por el plan "Facturar en SAINT sale del
 * fondo del panel": el operador quiso que el botón diga lo que hace, y el
 * nombre es el mismo en los tres sitios). Un mismo componente para los tres sitios donde se manda algo a SAINT:
 * el carrito del chat, los presupuestos del cliente en el panel del chat y los
 * presupuestos de /inventario.
 *
 * No sabe de Supabase ni de Realtime: recibe el ÚLTIMO envío de ese origen
 * (`ultimo`, que mantiene `useBorradoresSaint`) y el reloj (`ahora`). Las
 * reglas —qué botón se bloquea, qué se confirma, qué texto sale— son de
 * `saint-borradores.ts`; aquí solo se pintan.
 *
 * Devuelve UN solo elemento raíz a propósito: los padres (la columna del chat,
 * las tarjetas de /inventario) reparten sus hijos en flex/grid y un fragmento
 * les sumaría hijos directos (trampa del 9/9/2026, CLAUDE.md).
 */

interface EnviarASaintProps {
  origen: OrigenSaint;
  origenId: string;
  /** Los artículos que viajan, con lo que decide si SAINT puede recibirlos. */
  productos: { name: string; saintCode: string | null; isActive: boolean }[];
  /** Lo que aparece en el modal. La cédula y el teléfono vacíos se completan con los del último envío. */
  inicial: DatosClienteSaint;
  ultimo: BorradorSaint | null;
  ahora: Date;
  /** Se llama tras un envío aceptado: el padre relee el estado. */
  onEnviado: () => void;
  /**
   * Solo la línea de estado, sin botón ni modal: el carrito del chat vacío que
   * todavía tiene un envío anterior (pendiente, creado o con error) sigue
   * mostrando qué pasó con él, pero no hay nada que enviar.
   */
  soloEstado?: boolean;
  /**
   * Cómo se pinta el botón (28/10/2026, plan "Facturar en SAINT sale del fondo
   * del panel"). `secondary` por defecto, como en las tarjetas de presupuestos;
   * el carrito del chat lo sube a `primary` porque es la acción principal de su
   * bloque.
   */
  variante?: "primary" | "secondary";
}

export function EnviarASaint({
  origen,
  origenId,
  productos,
  inicial,
  ultimo,
  ahora,
  onEnviado,
  soloEstado = false,
  variante = "secondary",
}: EnviarASaintProps) {
  const [confirmando, setConfirmando] = useState(false);
  const [modalAbierto, setModalAbierto] = useState(false);

  const decision = decidirEnvio(ultimo);
  const bloqueo = textoBloqueo(renglonesBloqueados(productos));
  const estado = ultimo ? etiquetaEstado(ultimo, ahora) : null;

  // Por qué está deshabilitado, en el orden en que importa: lo que ya viaja,
  // luego lo que no hay, luego lo que SAINT no puede recibir.
  let motivo: string | undefined;
  if (decision.tipo === "en_curso") motivo = "Ya hay un envío en curso.";
  else if (productos.length === 0) motivo = "No hay artículos para enviar.";
  else if (bloqueo) motivo = bloqueo;

  // Un presupuesto de /inventario no tiene contacto: la cédula y el teléfono
  // de un envío anterior ahorran volver a escribirlos. Nombre y apellido de
  // `inicial` mandan si no están vacíos.
  const inicialDelModal: DatosClienteSaint = ultimo
    ? {
        cedulaTipo: inicial.cedulaNumero.trim() === "" ? ultimo.cedulaTipo : inicial.cedulaTipo,
        cedulaNumero: inicial.cedulaNumero.trim() === "" ? ultimo.cedulaNumero : inicial.cedulaNumero,
        nombre: inicial.nombre.trim() === "" ? ultimo.nombre : inicial.nombre,
        apellido: inicial.apellido.trim() === "" ? ultimo.apellido : inicial.apellido,
        telefono: inicial.telefono.trim() === "" ? ultimo.telefono : inicial.telefono,
      }
    : inicial;

  function alPulsar() {
    if (decision.tipo === "confirmar") setConfirmando(true);
    else if (decision.tipo === "libre") setModalAbierto(true);
  }

  return (
    <div className="saint-envio">
      {estado && (
        <div className="saint-estado" data-tono={estado.tono} role="status" aria-live="polite">
          {estado.tono === "progreso" && <span className="saint-spinner" aria-hidden="true" />}
          <span className="saint-estado-texto">
            <span>{estado.texto}</span>
            {estado.detalle && <span className="saint-estado-detalle">{estado.detalle}</span>}
          </span>
        </div>
      )}

      {!soloEstado && (
        <>
          {/* El `title` va en el envoltorio: el Button de HeroUI no lo pasa al DOM,
              y un botón deshabilitado tampoco recibe el hover. */}
          <span className="saint-envio-btn" title={motivo}>
            <Button size="sm" variant={variante} fullWidth isDisabled={motivo !== undefined} onPress={alPulsar}>
              <Send size={13} />
              Facturar en SAINT
            </Button>
          </span>

          {bloqueo && <p className="saint-hint">{bloqueo}</p>}

          {decision.tipo === "confirmar" && (
            <ConfirmDialog
              isOpen={confirmando}
              onOpenChange={setConfirmando}
              titulo="¿Facturar de nuevo en SAINT?"
              descripcion={textoConfirmacionReenvio(origen, decision.numeroSaint, decision.createdAt)}
              confirmarEtiqueta="Sí, facturar de nuevo"
              onConfirmar={() => setModalAbierto(true)}
            />
          )}

          <EnviarASaintModal
            isOpen={modalAbierto}
            onOpenChange={setModalAbierto}
            origen={origen}
            origenId={origenId}
            inicial={inicialDelModal}
            onEnviado={onEnviado}
          />
        </>
      )}
    </div>
  );
}
