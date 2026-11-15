"use client";

import { useState } from "react";
import type { Bloque } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { RangosDeAnaliticas } from "@/lib/paneles/rangos";
import type { PanelVentas } from "@/lib/paneles/parse";
import { PanelBloque } from "@/components/paneles/panel-marco";
import { LineaArea } from "@/components/paneles/panel-graficos";
import { SlidingPills } from "@/components/sliding-pills";
import { canalesDeVista, etiquetaDeTramo, serieDeMedida, valoresPrevios, type Medida } from "./datos";
import { formatoEntero, formatoUsd, usdGrafico } from "./formato";
import { ChipVariacion } from "./piezas";

/**
 * «Ingresos en el tiempo» (plan "Paneles", C5, 13/11/2026): la línea del
 * período con la serie previa punteada al comparar, la medida (Ingresos o
 * Envíos), el total y el promedio por tramo, y el estado de los envíos que no
 * entran en el total.
 *
 * La medida «Unidades» del plan no está: `panel_ventas.serie` no trae unidades
 * por tramo (solo montos y envíos), y dibujar otra cosa con ese nombre sería
 * mentir. Las unidades del período están en el KPI de Envíos y en el top de
 * repuestos.
 */

const MEDIDAS: { value: Medida; label: string }[] = [
  { value: "ingresos", label: "Ingresos" },
  { value: "envios", label: "Envíos" },
];

const POR_TRAMO: Record<PanelVentas["granularidad"], { promedio: string; tramo: string }> = {
  hora: { promedio: "Promedio por hora", tramo: "hora" },
  dia: { promedio: "Promedio diario", tramo: "día" },
  mes: { promedio: "Promedio mensual", tramo: "mes" },
};

export function IngresosEnElTiempo({
  ventas,
  previo,
  vista,
  comparar,
  rangos,
}: {
  ventas: Bloque<PanelVentas>;
  previo: Bloque<PanelVentas>;
  vista: Vista;
  comparar: boolean;
  rangos: RangosDeAnaliticas;
}) {
  const [medida, setMedida] = useState<Medida>("ingresos");

  return (
    <div className="pn-c12">
      <PanelBloque bloque={ventas} nombre="Ingresos en el tiempo">
        {(dato) => {
          const conPrevio = comparar && previo.ok ? previo.dato : null;
          const { series, valores } = serieDeMedida(dato, vista, medida, conPrevio !== null && vista === "resumen");
          const puntos = dato.serie.map((fila, i) => ({
            etiqueta: etiquetaDeTramo(fila.t, dato.granularidad),
            valores: valores[i],
          }));
          const previa = conPrevio
            ? {
                nombre: rangos.previo.etiqueta,
                // Alineada por posición; si el período previo tiene menos tramos, la línea previa es más corta.
                valores: valoresPrevios(conPrevio, vista, medida).slice(0, puntos.length),
              }
            : undefined;

          const canal = canalesDeVista(dato, vista);
          const total = medida === "ingresos" ? canal.ingresos : canal.envios;
          const totalPrevio =
            conPrevio === null
              ? null
              : medida === "ingresos"
                ? canalesDeVista(conPrevio, vista).ingresos
                : canalesDeVista(conPrevio, vista).envios;
          const promedio = total === null || puntos.length === 0 ? null : total / puntos.length;
          const formatoTotal = medida === "ingresos" ? formatoUsd : formatoEntero;
          const formatoGrafico = medida === "ingresos" ? usdGrafico : (n: number) => formatoEntero(n);

          const todos = valoresPrevios(dato, vista, medida);
          const pico = todos.length ? Math.max(...todos) : 0;
          const tramoPico = todos.indexOf(pico);
          const resumen =
            puntos.length === 0 || !(pico > 0)
              ? `${medida === "ingresos" ? "Ingresos" : "Envíos"} por ${POR_TRAMO[dato.granularidad].tramo}: sin movimiento en el período.`
              : `${medida === "ingresos" ? "Ingresos" : "Envíos"} por ${POR_TRAMO[dato.granularidad].tramo}, ${rangos.periodo.etiqueta}: total ${formatoTotal(total)}, máximo ${formatoGrafico(pico)} en ${puntos[tramoPico].etiqueta}.`;

          return (
            <section className="pn-card pn-card--panel" aria-labelledby="an-ingresos-titulo">
              <div className="pn-card__cab">
                <div>
                  <p className="pn-eyebrow">Enviado a SAINT · en espera de facturar</p>
                  <h2 className="pn-card__titulo" id="an-ingresos-titulo">
                    {medida === "ingresos" ? "Ingresos en el tiempo" : "Envíos en el tiempo"}
                  </h2>
                  <div className="an-tot">
                    <div>
                      <small>Total</small>
                      <b>{formatoTotal(total)}</b>
                    </div>
                    <div>
                      <small>{POR_TRAMO[dato.granularidad].promedio}</small>
                      <b>{promedio === null ? "—" : medida === "ingresos" ? formatoUsd(promedio) : promedio.toLocaleString("es-VE", { maximumFractionDigits: 1 })}</b>
                    </div>
                    {conPrevio && (
                      <div>
                        <small>Variación</small>
                        <span style={{ marginTop: 4 }}>
                          <ChipVariacion actual={total} previo={totalPrevio} />
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="pn-scroll">
                  <SlidingPills ariaLabel="Medida del gráfico" tone="segmented" value={medida} onChange={setMedida} items={MEDIDAS} />
                </div>
              </div>

              <LineaArea
                puntos={puntos}
                series={series}
                previa={previa}
                formato={formatoGrafico}
                ariaLabel={resumen}
                alto={240}
              />

              <ul className="an-leyenda" aria-label="Leyenda del gráfico">
                {series.map((s) => (
                  <li key={s.id}>
                    <span className="an-leyenda__sw" style={{ background: s.color }} aria-hidden="true" />
                    {s.nombre}
                  </li>
                ))}
                {previa && (
                  <li>
                    <span className="an-leyenda__sw an-leyenda__sw--previa" aria-hidden="true" />
                    {previa.nombre}
                  </li>
                )}
              </ul>
              {comparar && vista === "resumen" && (
                <p className="pn-subtitulo" style={{ marginTop: 6 }}>
                  Al comparar, el resumen suma online y tienda en una sola línea.
                </p>
              )}

              <div className="an-estado-bloque">
              <p className="an-estado__titulo">Qué no entra en el total</p>
              <ul className="an-estado" aria-label="Estado de los envíos">
                <li title="Enviados a SAINT que todavía no se confirman como creados.">
                  <b>
                    {formatoEntero(dato.estado.transito.envios)} · {formatoUsd(dato.estado.transito.monto)}
                  </b>
                  En tránsito
                </li>
                <li data-nivel={dato.estado.error.envios > 0 ? "critico" : undefined} title="Envíos que SAINT no pudo crear: no cuentan como ventas.">
                  <b>{formatoEntero(dato.estado.error.envios)}</b>
                  Con error
                </li>
                <li title="Un mismo envío repetido en menos de 24 horas se cuenta una sola vez.">
                  <b>{formatoEntero(dato.estado.duplicados)}</b>
                  Posibles duplicados excluidos
                </li>
                <li data-nivel={dato.estado.sin_foto > 0 ? "alerta" : undefined} title="Envíos cuya foto no pudo calcularse: no tienen monto en este panel.">
                  <b>{formatoEntero(dato.estado.sin_foto)}</b>
                  Sin foto del envío
                </li>
                <li data-nivel={canal.estimados > 0 ? "alerta" : undefined} title="Ventas reconstruidas después de enviarse; su monto es aproximado.">
                  <b>{formatoEntero(canal.estimados)}</b>
                  Estimados
                </li>
              </ul>
              </div>
            </section>
          );
        }}
      </PanelBloque>
    </div>
  );
}
