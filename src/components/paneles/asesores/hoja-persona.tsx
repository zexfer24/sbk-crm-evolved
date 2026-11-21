"use client";

import { BarrasVerticales, type SerieGrafico } from "@/components/paneles/panel-graficos";
import { tiendaVisible } from "@/lib/paneles/canal";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { avatarDe, etiquetaRol } from "./persona";
import { formatoFechaHora, formatoMinutos, formatoPorcentaje, iniciales } from "./formato";
import type { FilaPersona } from "./ordenar";

/**
 * Contenido de la hoja de una persona (plan "Paneles", 13/11/2026, C6): sus
 * números del período y la actividad por hora — cuántos mensajes mandó en cada
 * hora del día (hora de Caracas), para ver cuándo trabaja de verdad.
 */
const SERIE: SerieGrafico[] = [{ id: "mensajes", nombre: "Mensajes", color: "var(--pn-online)" }];

function resumenDeActividad(horas: number[]): string {
  let mejor = 0;
  for (let h = 1; h < horas.length; h++) if (horas[h] > horas[mejor]) mejor = h;
  const pico = horas[mejor] ?? 0;
  if (pico <= 0) return "Sin mensajes enviados en el período.";
  const total = horas.reduce((s, n) => s + n, 0);
  return `Mensajes enviados por hora, en hora de Caracas. Pico: ${mejor} h con ${pico} mensajes; ${total} en total.`;
}

function Dato({ etiqueta, valor, nota }: { etiqueta: string; valor: string; nota?: string }) {
  return (
    <div className="hj-dato">
      <span>{etiqueta}</span>
      <b>{valor}</b>
      {nota && <small>{nota}</small>}
    </div>
  );
}

export function HojaPersona({ fila, etiquetaRango }: { fila: FilaPersona; etiquetaRango: string }) {
  const p = fila.persona;
  const categorias = p.actividad_hora.map((n, h) => ({ etiqueta: `${h} h`, valores: [n] }));

  return (
    <div className="hj">
      <div className="hj-cab">
        <span className={`pn-avatar pn-avatar--${avatarDe(p.rol)}`} aria-hidden="true">
          {iniciales(p.nombre)}
        </span>
        <div>
          <b>{etiquetaRol(p.rol)}</b>
          <small>
            {p.en_reparto ? "En el reparto" : "Fuera del reparto"} · {etiquetaRango}
          </small>
        </div>
      </div>

      <div className="hj-resumen">
        <Dato etiqueta="Conversaciones" valor={p.conversaciones.toLocaleString("es-VE")} />
        <Dato etiqueta="Mensajes" valor={p.mensajes.toLocaleString("es-VE")} />
        <Dato etiqueta="Contactos" valor={p.contactos.toLocaleString("es-VE")} />
        <Dato etiqueta="Consultas atendidas" valor={p.episodios.toLocaleString("es-VE")} />
        <Dato
          etiqueta="Primera respuesta"
          valor={formatoMinutos(p.primera_resp_mediana_min)}
          nota={p.primera_resp_p90_min !== null ? `p90 ${formatoMinutos(p.primera_resp_p90_min)}` : undefined}
        />
        <Dato etiqueta="Respondidas en ≤ 5 min" valor={formatoPorcentaje(p.en_5min)} />
        <Dato etiqueta="Envíos a SAINT" valor={p.envios.toLocaleString("es-VE")} nota={tiendaVisible() ? `${p.envios_online} online · ${p.envios_tienda} tienda` : undefined} />
        <Dato etiqueta="Monto enviado" valor={formatoUsd(p.monto)} nota={`${p.unidades.toLocaleString("es-VE")} unidades`} />
        <Dato
          etiqueta="Conversión"
          valor={formatoPorcentaje(fila.conversion)}
          nota={fila.atendidas !== null && fila.compraron !== null ? `${fila.compraron} de ${fila.atendidas} atendidas` : undefined}
        />
        <Dato etiqueta="Reasignadas por demora" valor={p.reasignadas_desde.toLocaleString("es-VE")} />
        <Dato etiqueta="Último mensaje" valor={formatoFechaHora(p.ultimo_mensaje)} />
      </div>

      <h3 className="hj-tit">Actividad por hora</h3>
      <BarrasVerticales categorias={categorias} series={SERIE} ariaLabel={resumenDeActividad(p.actividad_hora)} alto={170} />
    </div>
  );
}
