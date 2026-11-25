"use client";

import Link from "next/link";
import { Check, Flame, Target, Trophy, X } from "lucide-react";
import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { MetaVenta, PanelVentas } from "@/lib/paneles/parse";
import { etiquetaDiaMes } from "@/lib/paneles/periodos";
import { porcentaje } from "@/lib/paneles/rendimiento";
import { todayKey } from "@/lib/sales-day";
import { PanelBloque } from "@/components/paneles/panel-marco";
import {
  diasDeRendimiento,
  esDiaEvaluado,
  etiquetaDeDia,
  resumenDeRendimiento,
  type DiaDeRendimiento,
  type DiaEvaluado,
} from "./datos";
import { formatoEntero, formatoUsd, usdGrafico } from "./formato";

/**
 * «Cumplimiento de la meta diaria» (plan "Paneles", C5, 13/11/2026): los
 * últimos 30 días hábiles de la vista, cada uno cumplido o no contra la meta
 * que regía ese día (`metaDelDia`), con la racha, el mejor día y cuántos se
 * cumplieron. Hoy aparece «en curso»: no cuenta como cumplido ni como fallado.
 * La meta se edita en el Dashboard (tarjeta Rendimiento), no acá.
 */

const DIAS_A_MOSTRAR = 30;

function Dia({ d, piso }: { d: DiaDeRendimiento; piso: Date | null }) {
  const corto = etiquetaDeDia(d.dia).split(" ").slice(0, 2).join(" ");
  if (!esDiaEvaluado(d)) {
    // Un día anterior al piso: sin meta, sin monto y sin ícono de cumplido ni de fallado.
    const sinDatos = `${etiquetaDeDia(d.dia)}: sin datos${piso ? ` (los paneles cuentan desde el ${etiquetaDiaMes(piso)})` : ""}`;
    return (
      <li className="an-dia an-dia--sin-datos" aria-label={sinDatos} title={sinDatos}>
        <span>{corto}</span>
        <small>sin datos</small>
      </li>
    );
  }
  const estado = d.enCurso ? "Día en curso" : d.cumplida ? "Meta cumplida" : "No se cumplió la meta";
  const pct = porcentaje(d.logrado, d.meta);
  const detalle = `${etiquetaDeDia(d.dia)}: ${formatoUsd(d.logrado)} de ${formatoUsd(d.meta)}${pct === null ? "" : ` (${Math.round(pct)} %)`}. ${estado}`;
  return (
    <li
      className={`an-dia ${d.enCurso ? "an-dia--curso" : d.cumplida ? "an-dia--si" : "an-dia--no"}`}
      aria-label={detalle}
      title={detalle}
    >
      <span>{corto}</span>
      {d.enCurso ? <small>en curso</small> : d.cumplida ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
      <b>{usdGrafico(Math.round(d.logrado))}</b>
    </li>
  );
}

function Contenido({
  serie,
  metas,
  vista,
  horario,
  ahora,
  piso,
}: {
  serie: PanelVentas["serie"];
  metas: MetaVenta[];
  vista: Vista;
  horario: BusinessHours;
  ahora: Date;
  piso: Date | null;
}) {
  const dias = diasDeRendimiento({ serie, metas, vista, horario, hoy: todayKey(ahora), max: DIAS_A_MOSTRAR, piso });

  if (dias.length === 0) {
    return (
      <div className="pn-vacio">
        <Target size={20} aria-hidden="true" />
        <p style={{ margin: 0 }}>
          Todavía no hay una meta diaria para esta vista, o ninguno de estos días fue hábil con meta vigente.
        </p>
        <Link className="pn-enlace" href="/panel">
          Definir la meta en el Dashboard
        </Link>
      </div>
    );
  }

  const resumen = resumenDeRendimiento(dias);
  // La meta vigente es la del último día evaluado: un día sin datos no tiene meta.
  const ultima: DiaEvaluado | undefined = dias.filter(esDiaEvaluado).at(-1);
  const hayDiasSinDatos = dias.some((d) => !esDiaEvaluado(d));

  return (
    <div className="an-rend">
      <div>
        <ol className="an-cal" aria-label={`Cumplimiento de la meta, últimos ${dias.length} días hábiles`}>
          {dias.map((d) => (
            <Dia key={d.dia} d={d} piso={piso} />
          ))}
        </ol>
        <div className="an-leyenda">
          <span>
            <Check size={14} aria-hidden="true" />
            Meta cumplida
          </span>
          <span>
            <X size={14} aria-hidden="true" />
            No se cumplió
          </span>
          {hayDiasSinDatos && (
            <span>
              <i className="an-leyenda__sin-datos" aria-hidden="true" />
              Sin datos
            </span>
          )}
        </div>
      </div>
      <div className="an-lado">
        <div className="an-stat" role="group" aria-label="Meta diaria">
          <span>
            <Target size={14} aria-hidden="true" />
            Meta diaria
          </span>
          <b>{ultima ? formatoUsd(ultima.meta) : "—"}</b>
          <small>{ultima ? `vigente el ${etiquetaDeDia(ultima.dia)}` : "Sin días evaluados todavía"}</small>
        </div>
        <div className="an-stat" role="group" aria-label="Racha">
          <span>
            <Flame size={14} aria-hidden="true" />
            Racha
          </span>
          <b>{formatoEntero(resumen.racha)}</b>
          <small>{resumen.racha === 1 ? "día seguido" : "días seguidos"} sin contar hoy</small>
        </div>
        <div className="an-stat" role="group" aria-label="Mejor día">
          <span>
            <Trophy size={14} aria-hidden="true" />
            Mejor día
          </span>
          <b>{resumen.mejor ? formatoUsd(resumen.mejor.logrado) : "—"}</b>
          <small>{resumen.mejor ? etiquetaDeDia(resumen.mejor.dia) : "Sin ventas en estos días"}</small>
        </div>
        <div className="an-stat" role="group" aria-label="Cumplidas">
          <span>
            <Check size={14} aria-hidden="true" />
            Cumplidas
          </span>
          <b>
            {formatoEntero(resumen.cumplidas)} de {formatoEntero(resumen.evaluadas)}
          </b>
          <small>días terminados con meta</small>
        </div>
      </div>
    </div>
  );
}

export function RendimientoDeMetas({
  ventasUltimos40,
  metas,
  vista,
  horario,
  ahora,
  piso = null,
}: {
  ventasUltimos40: Bloque<PanelVentas>;
  metas: Bloque<MetaVenta[]>;
  vista: Vista;
  horario: BusinessHours;
  ahora: Date;
  /** El piso de datos de los paneles (`rangos.piso`): los días anteriores salen «sin datos». */
  piso?: Date | null;
}) {
  return (
    <div className="pn-c12">
      <PanelBloque bloque={metas} nombre="Metas de venta">
        {(listaDeMetas) => (
          <PanelBloque bloque={ventasUltimos40} nombre="Ventas de los últimos 40 días">
            {(dato) => (
              <section className="pn-card pn-card--panel" aria-labelledby="an-rend-titulo">
                <div className="pn-card__cab">
                  <div>
                    <p className="pn-eyebrow">Últimos 30 días hábiles</p>
                    <h2 className="pn-card__titulo" id="an-rend-titulo">
                      Cumplimiento de la meta diaria
                    </h2>
                  </div>
                </div>
                <Contenido serie={dato.serie} metas={listaDeMetas} vista={vista} horario={horario} ahora={ahora} piso={piso} />
              </section>
            )}
          </PanelBloque>
        )}
      </PanelBloque>
    </div>
  );
}
