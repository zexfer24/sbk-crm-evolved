"use client";

import { FileText, ShoppingCart } from "lucide-react";
import { tiendaVisible, type Vista } from "@/lib/paneles/canal";
import type { PanelVentasActivas } from "@/lib/paneles/parse";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { antiguedadTexto, desgloseActivas, itemsDeVista } from "@/components/paneles/dashboard/calculos";

/**
 * «Lo más viejo sin procesar» (plan "Paneles", C4, 13/11/2026): los 5
 * presupuestos o carritos que más llevan sin enviarse a SAINT, según la vista.
 * «Ver todas» abre la hoja de ventas activas con la lista completa.
 */

const CUANTOS = 5;

export function LoMasViejo({
  datos,
  vista,
  ahora,
  onVerTodas,
}: {
  datos: PanelVentasActivas;
  vista: Vista;
  ahora: Date;
  onVerTodas: () => void;
}) {
  const items = itemsDeVista(datos, vista);
  const total = desgloseActivas(datos, vista).cantidad;
  // D1 (21/11/2026): sin el canal «tienda» el chip de canal por ítem no distingue nada.
  const conCanal = tiendaVisible();

  return (
    <section aria-label="Lo más viejo sin procesar" className="pn-card pn-card--panel pd-viejo">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Sin procesar</p>
          <h2 className="pn-card__titulo">Lo más viejo</h2>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="pn-vacio">Nada sin procesar: todo lo armado ya se envió a SAINT.</p>
      ) : (
        <ul className="pn-lista">
          {items.slice(0, CUANTOS).map((item) => (
            <li key={item.id} className="pn-lista__fila">
              <span className="pn-kpi__ico" aria-hidden="true">
                {item.tipo === "carrito" ? <ShoppingCart size={15} /> : <FileText size={15} />}
              </span>
              <div className="pn-lista__txt">
                <b>{item.cliente ?? "Sin cliente"}</b>
                <small>
                  <span>{item.tipo === "carrito" ? "Carrito" : "Presupuesto"}</span>
                  {conCanal && (
                    <span className={item.canal === "online" ? "pn-chip pn-chip--online" : "pn-chip pn-chip--tienda"}>
                      {item.canal === "online" ? "Online" : "En tienda"}
                    </span>
                  )}
                  <span>{item.responsable ?? "Sin responsable"}</span>
                </small>
              </div>
              <div className="pd-viejo__der">
                <b className="lm-num">{formatoUsd(item.monto)}</b>
                <small>{antiguedadTexto(item.desde, ahora)}</small>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="pd-viejo__pie">
        <p className="pn-kpi__pie">
          {items.length > 0 ? `Mostrando ${Math.min(CUANTOS, items.length)} de ${total}.` : ""}
        </p>
        {items.length > 0 && (
          <button type="button" className="pn-boton" onClick={onVerTodas}>
            Ver todas
          </button>
        )}
      </div>
    </section>
  );
}
