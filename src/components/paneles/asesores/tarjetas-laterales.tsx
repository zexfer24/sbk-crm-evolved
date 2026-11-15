"use client";

import { Store } from "lucide-react";
import type { Bloque } from "@/lib/paneles-data";
import type { PanelAsesores, PanelVentas } from "@/lib/paneles/parse";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { Cifra, entero } from "./cifra";
import { formatoFechaHora, iniciales } from "./formato";
import { avatarDe, etiquetaRol } from "./persona";

/**
 * Las dos tarjetas de la columna lateral de Asesores (plan "Paneles",
 * 13/11/2026, C6): Seba y el mostrador.
 */

/**
 * Seba: solo muestra cifras si tuvo actividad en el período. Sin mensajes, la
 * tarjeta dice "IA apagada" con el último mensaje que se le conoce: un panel
 * que pinta "0 mensajes" no distingue una IA callada por apagada de una IA que
 * no tuvo a quién contestar, y la primera es lo que el supervisor necesita ver.
 */
export function TarjetaSeba({ seba }: { seba: PanelAsesores["seba"] }) {
  const activa = seba.mensajes > 0;
  return (
    <section className="pn-card as-lado-card" aria-label="Seba">
      <div className="as-lado-card__cab">
        <span className="pn-avatar pn-avatar--ia" aria-hidden="true">
          {iniciales("Seba")}
        </span>
        <div>
          <b>Seba</b>
          <small>Agente de IA vendedor</small>
        </div>
        <span className="pn-chip pn-chip--ia as-lado-card__chip">IA</span>
      </div>

      {activa ? (
        <>
          <p className="pn-kpi__cifra">
            <Cifra valor={seba.mensajes} formato={entero} />
          </p>
          <p className="pn-kpi__sub">mensajes enviados</p>
          <p className="pn-kpi__pie">
            {seba.conversaciones.toLocaleString("es-VE")} conversaciones · último mensaje {formatoFechaHora(seba.ultimo)}
          </p>
        </>
      ) : (
        <p className="as-apagada">
          {seba.ultimo
            ? `IA apagada · último mensaje el ${formatoFechaHora(seba.ultimo)}`
            : "IA apagada · sin mensajes registrados"}
        </p>
      )}
    </section>
  );
}

/**
 * Mostrador: quién envió ventas de tienda a SAINT en el período. Los envíos
 * salen de `panel_asesores` (`envios_tienda`) y el monto de tienda, de
 * `panel_ventas.personas` en el canal tienda: `panel_asesores.monto` mezcla los
 * dos canales y no sirve para esto. Si la lectura de ventas cayó, el monto es
 * «—» (los envíos siguen siendo ciertos).
 */
export function TarjetaMostrador({ personas, ventas }: { personas: PanelAsesores["personas"]; ventas: Bloque<PanelVentas> }) {
  const montos = new Map<string, number | null>();
  if (ventas.ok) {
    for (const v of ventas.dato.personas) if (v.canal === "tienda") montos.set(v.agent_id, v.ingresos);
  }
  const filas = personas.filter((p) => p.envios_tienda > 0).sort((a, b) => b.envios_tienda - a.envios_tienda);

  return (
    <section className="pn-card as-lado-card" aria-label="Mostrador">
      <div className="as-lado-card__cab">
        <span className="pn-kpi__ico" aria-hidden="true">
          <Store size={16} />
        </span>
        <div>
          <b>Mostrador</b>
          <small>Envíos de tienda a SAINT</small>
        </div>
      </div>

      {filas.length === 0 ? (
        <p className="pn-vacio">Nadie envió ventas de tienda en este período.</p>
      ) : (
        <ul className="pn-lista">
          {filas.map((p) => (
            <li key={p.agent_id} className="pn-lista__fila">
              <span className={`pn-avatar pn-avatar--${avatarDe(p.rol)}`} aria-hidden="true">
                {iniciales(p.nombre)}
              </span>
              <span className="pn-lista__txt">
                <b>{p.nombre}</b>
                <small>
                  {p.envios_tienda === 1 ? "1 envío" : `${p.envios_tienda} envíos`} · {etiquetaRol(p.rol)}
                </small>
              </span>
              <span className="as-monto">{formatoUsd(ventas.ok ? (montos.get(p.agent_id) ?? null) : null)}</span>
            </li>
          ))}
        </ul>
      )}
      {!ventas.ok && filas.length > 0 && <p className="pn-kpi__pie">Los montos no están disponibles ahora.</p>}
    </section>
  );
}
