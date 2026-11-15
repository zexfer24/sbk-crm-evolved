"use client";

import { Gauge, Inbox, Send, Timer, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { Bloque } from "@/lib/paneles-data";
import { sumaCanales, type PanelAsesores, type PanelCola, type PanelVentas } from "@/lib/paneles/parse";
import { PanelBloque, formatoUsd } from "@/components/paneles/panel-marco";
import { Cifra, entero } from "./cifra";
import { formatoMinutos, formatoPorcentaje } from "./formato";

/**
 * Resumen del equipo (plan "Paneles", 13/11/2026, C6): cinco cifras.
 *
 * Qué pasa cuando una lectura cae: las que dependen de `asesores` y de `cola`
 * pintan «—» sin alerta propia, porque el aviso de arriba (cola) y la tabla
 * (asesores) ya muestran su "No disponible" con Reintentar; repetirlo en cada
 * tarjeta apilaría cinco alertas iguales. La de lo enviado a SAINT sí lleva la
 * suya (`PanelBloque`): ningún otro bloque de la página la cubre.
 *
 * El monto se rotula "Enviado a SAINT · en espera de facturar": la venta es una
 * factura en espera, no un cobro. Si hay envíos con monto estimado, el chip
 * "Estimado" lo avisa.
 */
function Tarjeta({
  icono,
  etiqueta,
  cifra,
  sub,
  pie,
  enlace,
}: {
  icono: ReactNode;
  etiqueta: string;
  cifra: ReactNode;
  sub?: ReactNode;
  pie?: ReactNode;
  enlace?: string;
}) {
  const cuerpo = (
    <>
      <div className="pn-kpi__cab">
        <p className="pn-eyebrow">{etiqueta}</p>
        <span className="pn-kpi__ico" aria-hidden="true">
          {icono}
        </span>
      </div>
      <p className="pn-kpi__cifra">{cifra}</p>
      {sub && <p className="pn-kpi__sub">{sub}</p>}
      {pie}
    </>
  );
  if (enlace) {
    return (
      <a className="pn-card pn-kpi pn-card--click as-kpi" href={enlace}>
        {cuerpo}
      </a>
    );
  }
  return <section className="pn-card pn-kpi as-kpi">{cuerpo}</section>;
}

export function KpisEquipo({
  asesores,
  cola,
  ventas,
}: {
  asesores: Bloque<PanelAsesores>;
  cola: Bloque<PanelCola>;
  ventas: Bloque<PanelVentas>;
}) {
  const a = asesores.ok ? asesores.dato : null;
  const c = cola.ok ? cola.dato : null;
  const enReparto = a ? a.personas.filter((p) => p.en_reparto).length : null;

  return (
    <section className="as-kpis" aria-label="Resumen del equipo">
      <div className="as-kpis__grupo">
        <Tarjeta
          icono={<Users size={16} />}
          etiqueta="Personas activas"
          cifra={<Cifra valor={a ? a.personas.length : null} formato={entero} />}
          sub={enReparto === null ? "Sin datos" : `${enReparto} en el reparto`}
        />
        <Tarjeta
          icono={<Timer size={16} />}
          etiqueta="Primera respuesta"
          cifra={<Cifra valor={a?.equipo.primera_resp_mediana_min} formato={formatoMinutos} />}
          sub={a ? `Mediana · ${a.equipo.episodios.toLocaleString("es-VE")} consultas` : "Sin datos"}
        />
        <Tarjeta
          icono={<Gauge size={16} />}
          etiqueta="Respondidas en ≤ 5 min"
          cifra={<Cifra valor={a?.equipo.en_5min} formato={formatoPorcentaje} />}
          sub={a ? "De las consultas del período" : "Sin datos"}
        />
      </div>

      <Tarjeta
        icono={<Inbox size={16} />}
        etiqueta="Pendientes ahora"
        enlace="#pendientes"
        cifra={<Cifra valor={c?.pendientes} formato={entero} />}
        sub={c ? `${c.sin_dueno} sin dueño · ${c.con_dueno} con dueño` : "Sin datos"}
      />

      <PanelBloque bloque={ventas} nombre="Envíos a SAINT del equipo">
        {(dato) => {
          const total = sumaCanales(dato);
          return (
            <Tarjeta
              icono={<Send size={16} />}
              etiqueta="Enviado a SAINT"
              cifra={formatoUsd(total.ingresos)}
              sub={`${total.envios.toLocaleString("es-VE")} envíos · en espera de facturar`}
              pie={
                total.estimados > 0 ? (
                  <span
                    className="pn-chip pn-chip--alerta"
                    title="Incluye envíos cuyo monto es una estimación: la foto de la venta no pudo calcularse con el precio exacto."
                  >
                    Estimado
                  </span>
                ) : undefined
              }
            />
          );
        }}
      </PanelBloque>
    </section>
  );
}
