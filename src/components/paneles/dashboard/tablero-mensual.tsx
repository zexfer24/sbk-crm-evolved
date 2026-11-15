"use client";

import { useState, type CSSProperties } from "react";
import type { Vista } from "@/lib/paneles/canal";
import type { PanelVentas } from "@/lib/paneles/parse";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { ingresosPorMes } from "@/components/paneles/dashboard/calculos";
import { mesesDesdeElPrimerEnvio } from "@/lib/paneles/meses";
import { crmDayKey } from "@/lib/sales-day";

/**
 * Tablero de ingresos por mes del año en curso (plan "Paneles", C4,
 * 13/11/2026). Barras de HTML/CSS (no SVG) porque el mes en curso va marcado y
 * las barras CRECEN con una transición de altura al cambiar la vista.
 *
 * Accesibilidad: el dibujo es un `role="img"` con el resumen en texto, y los
 * meses con sus cifras exactas viven en una tabla solo para lectores de
 * pantalla (`th scope`) al lado: los hijos de un `role="img"` no se leen, y
 * una barra que se pueda enfocar adentro de una imagen no es accesible. La
 * lectura exacta con ratón sale arriba del dibujo.
 *
 * Desde el 15/11/2026 arranca en el primer mes con algún envío, igual que el
 * «Mes a mes» de Analíticas (`mesesDesdeElPrimerEnvio`, regla compartida): los
 * envíos a SAINT se registran desde el 26/10/2026 y enero a septiembre en
 * blanco se leían como «no vendimos». El primer mes se decide con los dos
 * canales juntos, no con el que filtra la vista, para que cambiar de vista no
 * mueva el eje. Los meses que faltan del año (el mes en curso y los futuros)
 * siguen, atenuados. Sin envíos en el año, estado vacío.
 */

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MESES_LARGOS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

export function TableroMensual({
  ventas,
  vista,
  anio,
  mesActual,
}: {
  ventas: PanelVentas;
  vista: Vista;
  anio: number;
  /** 1–12: el mes en curso, que se marca. */
  mesActual: number;
}) {
  const [leido, setLeido] = useState<number | null>(null);

  // Los envíos por mes salen de la serie (la regla del primer mes los cuenta
  // además de los importes); el recorte se hace con los dos canales juntos.
  const enviosPorMes = new Array<number>(12).fill(0);
  for (const p of ventas.serie) {
    const [a, m] = crmDayKey(p.t).split("-").map(Number);
    if (a === anio) enviosPorMes[m - 1] += p.envios_online + p.envios_tienda;
  }
  const delAnio = ingresosPorMes(ventas, anio).map((m) => ({ ...m, envios: enviosPorMes[m.mes - 1] }));
  const meses = mesesDesdeElPrimerEnvio(delAnio).map((m) => ({
    ...m,
    // Lo que cuenta la vista: un canal, o los dos apilados en el resumen.
    online: vista === "tienda" ? 0 : m.online,
    tienda: vista === "online" ? 0 : m.tienda,
  }));

  const totales = meses.map((m) => m.online + m.tienda);
  const maximo = Math.max(...totales, 1);
  const totalAnio = totales.reduce((s, n) => s + n, 0);
  const mejor = totales.reduce((mejorMes, total, i) => (total > totales[mejorMes.i] ? { i } : mejorMes), { i: 0 });

  const posActual = meses.findIndex((m) => m.mes === mesActual);
  const mostrado = leido ?? (posActual >= 0 ? posActual : 0);
  const m = meses[mostrado];
  const nombreMostrado = m ? MESES[m.mes - 1] : "";
  const lectura = !m
    ? ""
    : vista === "resumen"
      ? `${nombreMostrado}: online ${formatoUsd(m.online)} · en tienda ${formatoUsd(m.tienda)} · total ${formatoUsd(totales[mostrado])}`
      : `${nombreMostrado}: ${formatoUsd(totales[mostrado])}`;

  const resumen = `Ingresos enviados a SAINT por mes de ${anio}: total ${formatoUsd(totalAnio)}${
    totalAnio > 0 ? `; el mejor mes es ${MESES_LARGOS[meses[mejor.i].mes - 1]} con ${formatoUsd(totales[mejor.i])}` : ""
  }.`;

  return (
    <section aria-label="Ingresos por mes" className="pn-card pn-card--panel pd-tablero">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Ingresos mes a mes · {anio}</p>
          <h2 className="pn-card__titulo">Tablero de ingresos</h2>
          <p className="pn-subtitulo lm-num">Total del año: {formatoUsd(totalAnio)}</p>
        </div>
      </div>

      {meses.length === 0 ? (
        <p className="pn-vacio">Todavía no hay envíos a SAINT este año.</p>
      ) : (
        <>
          <p className="pd-tablero__lectura lm-num">{lectura}</p>

          <div
            className="pd-meses"
            style={{ "--pd-n-meses": meses.length } as CSSProperties}
            role="img"
            aria-label={resumen}
            onPointerLeave={() => setLeido(null)}
          >
            {meses.map((mes, i) => {
              const futuro = mes.mes > mesActual;
              return (
                <div
                  key={mes.mes}
                  className={[
                    "pd-mes",
                    mes.mes === mesActual ? "pd-mes--actual" : "",
                    futuro ? "pd-mes--futuro" : "",
                    mostrado === i ? "pd-mes--leido" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onPointerEnter={() => setLeido(i)}
                >
                  <div className="pd-mes__columna">
                    <div className="pd-mes__barra" style={{ height: `${(totales[i] / maximo) * 100}%` }}>
                      {mes.tienda > 0 && <i className="pd-mes__seg pd-mes__seg--tienda" style={{ flexGrow: mes.tienda }} />}
                      {mes.online > 0 && <i className="pd-mes__seg pd-mes__seg--online" style={{ flexGrow: mes.online }} />}
                    </div>
                  </div>
                  <span className="pd-mes__etq">{MESES[mes.mes - 1]}</span>
                </div>
              );
            })}
          </div>

          <ul className="pn-leyenda pd-leyenda">
            {vista !== "tienda" && (
              <li className="pn-leyenda__item">
                <span className="pn-leyenda__sw pd-sw-online" aria-hidden="true" />
                <span>Online</span>
              </li>
            )}
            {vista !== "online" && (
              <li className="pn-leyenda__item">
                <span className="pn-leyenda__sw pd-sw-tienda" aria-hidden="true" />
                <span>En tienda</span>
              </li>
            )}
            <li className="pn-leyenda__item">
              <span className="pd-marca-actual" aria-hidden="true" />
              <span>Mes en curso (parcial)</span>
            </li>
          </ul>
        </>
      )}

      <p className="pn-kpi__pie">
        Los envíos a SAINT se registran desde el 26 de octubre de 2026: por eso el tablero empieza en el primer mes con envíos y los meses anteriores no
        tienen datos.
      </p>

      {meses.length > 0 && (
        <table className="pn-sr">
          <caption>Ingresos enviados a SAINT por mes de {anio}</caption>
          <thead>
            <tr>
              <th scope="col">Mes</th>
              <th scope="col">Online</th>
              <th scope="col">En tienda</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {meses.map((mes, i) => (
              <tr key={mes.mes}>
                <th scope="row">{MESES_LARGOS[mes.mes - 1]}</th>
                <td>{formatoUsd(mes.online)}</td>
                <td>{formatoUsd(mes.tienda)}</td>
                <td>{formatoUsd(totales[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
