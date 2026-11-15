"use client";

import type { Vista } from "@/lib/paneles/canal";
import type { PanelConversaciones, PanelVentas } from "@/lib/paneles/parse";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { enviosPorPersona, iniciales } from "@/components/paneles/dashboard/calculos";
import { formatoPorcentaje, plural } from "@/components/paneles/dashboard/cifra";

/**
 * Las dos versiones de la tarjeta "por persona" (plan "Paneles", C4,
 * 13/11/2026). En Resumen y Online: conversión por persona que respondió, con
 * el promedio del equipo marcado en cada barra. En "En tienda" no hay
 * conversión (la caja no registra a quien no compra): se muestran los envíos
 * por persona.
 */

function Avatar({ nombre, rol }: { nombre: string; rol: string }) {
  const clase = rol === "ia" ? "pn-avatar pn-avatar--ia" : rol === "caja" ? "pn-avatar pn-avatar--caja" : "pn-avatar pn-avatar--asesor";
  return (
    <span className={clase} aria-hidden="true">
      {iniciales(nombre)}
    </span>
  );
}

export function ConversionPorPersona({
  conversaciones,
  vista,
  recortado,
}: {
  conversaciones: PanelConversaciones;
  vista: Vista;
  recortado: boolean;
}) {
  const { equipo, personas } = conversaciones.conversion;
  const tasaEquipo = equipo.atendidas > 0 ? (equipo.compraron / equipo.atendidas) * 100 : null;

  // Seba solo aparece si tuvo actividad: una fila con 0 atendidas no es una persona del reparto.
  const filas = personas
    .filter((p) => p.atendidas > 0)
    .map((p) => ({ ...p, tasa: (p.compraron / p.atendidas) * 100 }))
    .sort((a, b) => b.tasa - a.tasa || b.atendidas - a.atendidas);
  const sebaActiva = filas.some((f) => f.rol === "ia");

  const escala = Math.max(...filas.map((f) => f.tasa), tasaEquipo ?? 0, 1) * 1.1;

  return (
    <section aria-label="Conversión por persona" className="pn-card pn-card--panel pd-persona">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">{vista === "online" ? "Online · solo chat" : "Solo chat"}</p>
          <h2 className="pn-card__titulo">Conversión por persona</h2>
        </div>
        {tasaEquipo !== null && (
          <span className="pd-prom-tag">
            Promedio del equipo · <b className="lm-num">{formatoPorcentaje(Math.round(tasaEquipo * 10) / 10)}</b>
          </span>
        )}
      </div>

      {filas.length === 0 ? (
        <p className="pn-vacio">Nadie recibió respuesta en este período.</p>
      ) : (
        <ul className="pd-personas">
          {filas.map((f) => (
            <li key={f.agent_id ?? `rol-${f.rol}`} className="pd-persona-fila">
              <Avatar nombre={f.nombre} rol={f.rol} />
              <div className="pd-persona-fila__centro">
                <div className="pd-persona-fila__linea">
                  <b>{f.nombre}</b>
                  <small>
                    {f.compraron} de {f.atendidas}
                  </small>
                </div>
                <div className="pd-pista" aria-hidden="true">
                  <i
                    className={f.rol === "ia" ? "pd-pista__relleno pd-pista__relleno--ia" : "pd-pista__relleno"}
                    style={{ width: `${(f.tasa / escala) * 100}%` }}
                  />
                  {tasaEquipo !== null && <i className="pd-pista__prom" style={{ left: `${(tasaEquipo / escala) * 100}%` }} />}
                </div>
              </div>
              <span className="pd-persona-fila__pct lm-num">{formatoPorcentaje(Math.round(f.tasa * 10) / 10)}</span>
            </li>
          ))}
          {!sebaActiva && (
            <li className="pd-persona-fila pd-persona-fila--vacia">
              <Avatar nombre="Seba" rol="ia" />
              <div className="pd-persona-fila__centro">
                <div className="pd-persona-fila__linea">
                  <b>Seba (IA)</b>
                  <small>IA apagada en este período</small>
                </div>
              </div>
            </li>
          )}
        </ul>
      )}

      <p className="pn-kpi__pie">
        Una venta cuenta para cada persona que respondió en esa conversación, por eso las barras no suman el total
        {recortado ? " · Últimos 92 días" : ""}.
      </p>
    </section>
  );
}

export function EnviosPorPersona({ ventas }: { ventas: PanelVentas }) {
  const filas = enviosPorPersona(ventas, "tienda");
  const maximo = Math.max(...filas.map((f) => f.envios), 1);

  return (
    <section aria-label="Envíos por persona" className="pn-card pn-card--panel pd-persona">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">En tienda</p>
          <h2 className="pn-card__titulo">Envíos por persona</h2>
        </div>
      </div>

      {filas.length === 0 ? (
        <p className="pn-vacio">Nadie envió nada a SAINT en este período.</p>
      ) : (
        <ul className="pd-personas">
          {filas.map((f) => (
            <li key={f.agent_id} className="pd-persona-fila">
              <Avatar nombre={f.nombre} rol={f.rol} />
              <div className="pd-persona-fila__centro">
                <div className="pd-persona-fila__linea">
                  <b>{f.nombre}</b>
                  <small className="lm-num">{formatoUsd(f.ingresos)}</small>
                </div>
                <div className="pd-pista" aria-hidden="true">
                  <i className="pd-pista__relleno pd-pista__relleno--tienda" style={{ width: `${(f.envios / maximo) * 100}%` }} />
                </div>
              </div>
              <span className="pd-persona-fila__pct lm-num">
                {f.envios} {plural(f.envios, "envío", "envíos")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="pn-kpi__pie">En tienda no hay tasa de conversión: la caja no registra a quien no compra.</p>
    </section>
  );
}
