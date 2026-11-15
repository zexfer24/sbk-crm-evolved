"use client";

import { CheckCircle2, Clock } from "lucide-react";
import type { BusinessHours } from "@/lib/business-hours";
import type { PanelCola } from "@/lib/paneles/parse";
import { esperaDe, tonoEspera } from "./espera";
import { formatoReloj, iniciales } from "./formato";

/**
 * Aviso del mensaje más viejo sin responder (plan "Paneles", 13/11/2026, C6).
 * Es lo primero que ve el supervisor: cuánto lleva esperando el cliente que más
 * lleva, en vivo (segundos) y en minutos de horario de atención, quién es y
 * quién lo tiene. Sin pendientes, un estado vacío POSITIVO: el panel dice que
 * todo está al día en vez de dejar un hueco.
 *
 * Las conversaciones de más de `corte_dias` no entran aquí (la RPC las separa
 * como abandonadas): una nota discreta lo recuerda, porque si no un mensaje de
 * hace 3 semanas parecería "no existir" cuando en realidad quedó fuera del corte.
 */
export function AvisoMasViejo({ dato, ahoraVivo, horario }: { dato: PanelCola; ahoraVivo: Date; horario: BusinessHours }) {
  const nota =
    dato.abandonadas > 0 ? (
      <p className="as-nota">
        {dato.abandonadas === 1
          ? `1 conversación de más de ${dato.corte_dias} días se considera abandonada.`
          : `${dato.abandonadas} conversaciones de más de ${dato.corte_dias} días se consideran abandonadas.`}
      </p>
    ) : null;

  const viejo = dato.mas_viejo;
  if (!viejo) {
    return (
      <section className="pn-card as-aviso as-aviso--vacio" aria-label="Mensaje más viejo sin responder">
        <div className="as-aviso__vacio">
          <span className="as-aviso__ico as-aviso__ico--bien" aria-hidden="true">
            <CheckCircle2 size={22} />
          </span>
          <div>
            <h2 className="as-aviso__tit">No hay mensajes sin responder</h2>
            <p className="pn-subtitulo">Todo el equipo está al día con sus conversaciones.</p>
          </div>
        </div>
        {nota}
      </section>
    );
  }

  const espera = esperaDe(viejo.desde, ahoraVivo, horario);
  const tono = tonoEspera(espera.laborales);
  const contacto = viejo.contacto?.trim() || "Contacto sin nombre";

  return (
    <section className={`pn-card as-aviso as-aviso--${tono}`} aria-label="Mensaje más viejo sin responder">
      <div className="as-aviso__cuerpo">
        <p className="pn-eyebrow">Lo más viejo sin responder</p>
        <h2 className="as-aviso__tit">
          El mensaje más viejo sin responder lleva{" "}
          <span className="as-reloj" role="timer">
            {formatoReloj(espera.ms)}
          </span>
        </h2>
        <p className="as-aviso__lab">
          <Clock size={14} aria-hidden="true" />
          {espera.laborales.toLocaleString("es-VE")} min en horario de atención
        </p>
        <div className="as-aviso__quien">
          <span className="pn-avatar" aria-hidden="true">
            {iniciales(contacto)}
          </span>
          <b>{contacto}</b>
          {viejo.asesor ? <span className="pn-chip pn-chip--neutro">{viejo.asesor}</span> : <span className="pn-chip pn-chip--alerta">Sin dueño</span>}
        </div>
      </div>
      <a className="pn-enlace as-aviso__enlace" href="#pendientes">
        Ver pendientes
      </a>
      {nota}
    </section>
  );
}
