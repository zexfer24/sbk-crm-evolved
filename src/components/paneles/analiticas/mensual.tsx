"use client";

import type { Bloque } from "@/lib/paneles-data";
import { tiendaVisible, type Vista } from "@/lib/paneles/canal";
import type { PanelVentas } from "@/lib/paneles/parse";
import { todayKey } from "@/lib/sales-day";
import { PanelBloque } from "@/components/paneles/panel-marco";
import { BarrasVerticales, type SerieGrafico } from "@/components/paneles/panel-graficos";
import { esMesRecortadoPorElPiso, mesesDelTablero, rotuloDelMes } from "@/lib/paneles/meses";
import { TEXTO_INICIO_PANELES } from "@/lib/paneles/periodos";
import { MESES_LARGOS, mesesDelAnio, variacionPct, type MesDelAnio } from "./datos";
import { formatoEntero, formatoUsd, textoVariacion, usdGrafico } from "./formato";

/**
 * «Ingresos mes a mes» (plan "Paneles", C5, 13/11/2026): el año en curso por
 * mes, apilado online/tienda en el resumen, con el mes en curso marcado y una
 * tabla que dice lo mismo con todas las etiquetas (el gráfico, con 11 o 12
 * barras, rotula una de cada dos).
 *
 * No hay «2026 contra 2025»: la foto de los envíos a SAINT empezó a guardarse a
 * finales de octubre de 2026, así que no hay con qué comparar un año anterior.
 *
 * Desde el 15/11/2026 la tabla y el gráfico arrancan en el primer mes con algún
 * envío: enero a septiembre no tienen registro y pintarlos en $0,00 con «—»
 * parecía «no tuvimos ventas en marzo». Se cortó también el gráfico (no solo la
 * tabla) para que los dos cuenten lo mismo. Sin ningún envío en el año, un aviso
 * en vez de doce meses en cero.
 *
 * Desde el 21/11/2026 el corte es el piso de los paneles (`mesesDelTablero`):
 * arranca en el mes del piso, que lleva el rótulo «Nov (desde el 16)», y la
 * variación del mes SIGUIENTE es «—» porque su mes previo viene recortado.
 */

const SERIE_ONLINE: SerieGrafico = { id: "online", nombre: "Online", color: "var(--pn-online)" };
const SERIE_TIENDA: SerieGrafico = { id: "tienda", nombre: "En tienda", color: "var(--pn-tienda)" };
// D1 (21/11/2026): con la tienda oculta el resumen es UNA serie, el total de los dos canales, en el color online.
const SERIE_TOTAL: SerieGrafico = { id: "total", nombre: "Total", color: "var(--pn-online)" };

function totalDe(mes: MesDelAnio, vista: Vista): number {
  return vista === "resumen" ? mes.online + mes.tienda : mes[vista];
}

export function IngresosMensuales({
  ventasAnio,
  vista,
  ahora,
  piso = null,
}: {
  ventasAnio: Bloque<PanelVentas>;
  vista: Vista;
  ahora: Date;
  /** El piso de datos de los paneles (`rangos.piso`); `null` conserva el corte por primer envío. */
  piso?: Date | null;
}) {
  return (
    <div className="pn-c12">
      <PanelBloque bloque={ventasAnio} nombre="Ingresos mes a mes">
        {(dato) => {
          const delAnio = mesesDelAnio(dato.serie, ahora);
          const anio = Number(todayKey(ahora).slice(0, 4));
          const meses = mesesDelTablero(delAnio, anio, piso);
          // «Nov» → «Nov (desde el 16)» solo en el mes del piso (`mes` de la tabla es 0 = enero).
          const rotulo = (m: MesDelAnio, etiqueta: string) => rotuloDelMes(etiqueta, anio, m.mes + 1, piso);
          const mesesOmitidos = delAnio.length - meses.length;
          const primerMes = meses.length > 0 ? MESES_LARGOS[meses[0].mes] : null;
          const desglosar = tiendaVisible();
          const series =
            vista === "resumen"
              ? desglosar
                ? [SERIE_ONLINE, SERIE_TIENDA]
                : [SERIE_TOTAL]
              : [vista === "online" ? SERIE_ONLINE : SERIE_TIENDA];
          const totalAnio = meses.reduce((suma, m) => suma + totalDe(m, vista), 0);
          const resumen = `Ingresos por mes de ${anio}: ${meses
            .map((m) => `${MESES_LARGOS[m.mes].toLowerCase()} ${usdGrafico(Math.round(totalDe(m, vista)))}`)
            .join(", ")}.`;

          return (
            <section className="pn-card pn-card--panel" aria-labelledby="an-mensual-titulo">
              <div className="pn-card__cab">
                <div>
                  <p className="pn-eyebrow">Enviado a SAINT · en espera de facturar</p>
                  <h2 className="pn-card__titulo" id="an-mensual-titulo">
                    Ingresos mes a mes
                  </h2>
                  <p className="pn-subtitulo" style={{ marginTop: 4 }}>
                    Total del año hasta hoy: <b className="lm-num">{formatoUsd(totalAnio)}</b>
                  </p>
                </div>
              </div>

              {meses.length === 0 ? (
                <p className="pn-vacio">Todavía no hay envíos a SAINT este año.</p>
              ) : (
                <>
                  <BarrasVerticales
                    categorias={meses.map((m) => ({
                      etiqueta: rotulo(m, m.etiqueta),
                      valores: vista === "resumen" ? (desglosar ? [m.online, m.tienda] : [totalDe(m, vista)]) : [m[vista]],
                    }))}
                    series={series}
                    apiladas
                    formato={usdGrafico}
                    ariaLabel={resumen}
                    alto={220}
                  />
                  <ul className="an-leyenda" aria-label="Leyenda del gráfico">
                    {series.map((s) => (
                      <li key={s.id}>
                        <span className="an-leyenda__sw" style={{ background: s.color }} aria-hidden="true" />
                        {s.nombre}
                      </li>
                    ))}
                  </ul>

                  <div className="pn-tabla-wrap" style={{ marginTop: 16 }}>
                    <table className="pn-tabla an-tabla">
                      <thead>
                        <tr>
                          <th scope="col">Mes</th>
                          {vista === "resumen" && desglosar && (
                            <>
                              <th scope="col" className="pn-der an-oculta-m">
                                Online
                              </th>
                              <th scope="col" className="pn-der an-oculta-m">
                                En tienda
                              </th>
                        </>
                      )}
                      <th scope="col" className="pn-der">
                        Total
                      </th>
                      <th scope="col" className="pn-der an-oculta-m">
                        Envíos
                      </th>
                      <th scope="col" className="pn-der">
                        Contra el mes anterior
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {meses.map((m, i) => {
                      const total = totalDe(m, vista);
                      // El mes previo del que sigue al del piso viene recortado: compararlo sería «mes entero contra medio mes».
                      const previoRecortado = i > 0 && esMesRecortadoPorElPiso(anio, meses[i - 1].mes + 1, piso);
                      const previo = i > 0 && !previoRecortado ? totalDe(meses[i - 1], vista) : null;
                      const variacion = variacionPct(total, previo);
                      return (
                        <tr key={m.clave}>
                          <th scope="row">
                            {rotulo(m, MESES_LARGOS[m.mes])}
                            {m.enCurso && (
                              <>
                                {" "}
                                <span className="pn-chip pn-chip--neutro">En curso</span>
                              </>
                            )}
                          </th>
                          {vista === "resumen" && desglosar && (
                            <>
                              <td className="pn-der an-oculta-m">{formatoUsd(m.online)}</td>
                              <td className="pn-der an-oculta-m">{formatoUsd(m.tienda)}</td>
                            </>
                          )}
                          <td className="pn-der">{formatoUsd(total)}</td>
                          <td className="pn-der an-oculta-m">{formatoEntero(m.envios)}</td>
                          <td className="pn-der">{variacion === null ? "—" : `${textoVariacion(variacion)}${m.enCurso ? " (parcial)" : ""}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
                </>
              )}
              {piso !== null && mesesOmitidos > 0 && primerMes && (
                <p className="pn-subtitulo" style={{ marginTop: 12 }}>
                  {TEXTO_INICIO_PANELES} y por eso la tabla empieza en {primerMes.toLowerCase()}.
                </p>
              )}
            </section>
          );
        }}
      </PanelBloque>
    </div>
  );
}
