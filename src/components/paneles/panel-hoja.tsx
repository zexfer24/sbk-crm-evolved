"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Hoja de detalle de los paneles (plan "Paneles", 13/11/2026): un `<dialog>`
 * pegado a la derecha que se abre al pulsar una tarjeta, y una hoja inferior
 * en ≤ 560 px (el CSS lo decide con el ancho: `.pn-hoja` en `paneles.css`).
 * Equivale a `ui.hoja` de `mockups/paneles-analitica/shared/kit.js`.
 *
 * Es CONTROLADA: la abre quien tiene `abierta` y la cierra `onCerrar`. Por qué
 * `<dialog>` y no un div con `position: fixed`: `showModal()` deja inerte el
 * resto de la página, atrapa el tabulador adentro y pinta el fondo sin que
 * haya que reinventar nada de eso.
 *
 * Cierre: botón Cerrar, Esc, o un clic fuera del panel (el `<dialog>` ocupa
 * todo el borde y el panel interior lo llena, así que un clic cuyo destino es
 * el propio `<dialog>` cayó en el fondo). El navegador dispara `cancel` con Esc
 * y cierra el dialog por su cuenta; se frena y se cierra por la prop, para que
 * `abierta` y el dialog nunca discrepen. El Esc por teclado se atiende también
 * (y detiene `cancel`) porque jsdom no dispara `cancel`: así lo cubre un test.
 *
 * Foco: al abrir va al botón Cerrar; al cerrar vuelve a quien lo tenía antes
 * (el navegador lo hace solo con `showModal`, pero el respaldo explícito
 * cubre también el camino sin `showModal` y es lo que verifica el test).
 *
 * El contenido solo existe mientras está abierta: una hoja cerrada no debe
 * pagar el render de su detalle ni dejar filas fantasma para lectores de
 * pantalla.
 */
export function PanelHoja({
  abierta,
  titulo,
  onCerrar,
  children,
}: {
  abierta: boolean;
  titulo: string;
  onCerrar: () => void;
  children?: ReactNode;
}) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const botonCerrar = useRef<HTMLButtonElement>(null);
  const previo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dlg = dialogo.current;
    if (!dlg) return;

    if (abierta) {
      if (!dlg.open) {
        previo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.setAttribute("open", "");
      }
      botonCerrar.current?.focus();
    } else if (dlg.open) {
      if (typeof dlg.close === "function") dlg.close();
      else dlg.removeAttribute("open");
      previo.current?.focus();
      previo.current = null;
    }
  }, [abierta]);

  function alTeclear(evento: KeyboardEvent<HTMLDialogElement>) {
    if (evento.key !== "Escape") return;
    evento.preventDefault();
    onCerrar();
  }

  return (
    <dialog
      ref={dialogo}
      className="pn-hoja"
      aria-label={titulo}
      onKeyDown={alTeclear}
      onCancel={(evento) => {
        evento.preventDefault();
        onCerrar();
      }}
      // Cerrado por otra vía que no pasa por `abierta` (un `method="dialog"`):
      // se avisa para que el padre no quede creyendo que sigue abierta.
      onClose={() => {
        if (abierta) onCerrar();
      }}
      onClick={(evento) => {
        if (evento.target === evento.currentTarget) onCerrar();
      }}
    >
      <div className="pn-hoja__panel">
        <header className="pn-hoja__cab">
          <h2 className="pn-hoja__tit">{titulo}</h2>
          <button ref={botonCerrar} type="button" className="pn-hoja__x" aria-label="Cerrar" onClick={onCerrar}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="pn-hoja__cuerpo">{abierta ? children : null}</div>
      </div>
    </dialog>
  );
}
