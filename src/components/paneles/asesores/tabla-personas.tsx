"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { PanelHoja } from "@/components/paneles/panel-hoja";
import { tiendaVisible } from "@/lib/paneles/canal";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { HojaPersona } from "./hoja-persona";
import { formatoFechaHora, formatoMinutos, formatoPorcentaje, iniciales } from "./formato";
import { direccionInicial, ordenarFilas, type ColumnaId, type Direccion, type FilaPersona } from "./ordenar";
import { avatarDe, etiquetaRol } from "./persona";

/**
 * Tabla por persona de Asesores (plan "Paneles", 13/11/2026, C6): una fila por
 * persona de `panel_asesores`, con la conversión cruzada de
 * `panel_conversaciones` por `agent_id`.
 *
 * - Encabezados ordenables: son `<button>` dentro del `<th>`, y el `<th>` lleva
 *   `aria-sort` solo cuando es la columna activa. Los vacíos van siempre al
 *   final (`ordenarFilas`).
 * - En móvil la tabla pasa a tarjetas (CSS, con `data-label` en cada celda) y
 *   los encabezados desaparecen, así que el orden se elige con un `<select>`
 *   (solo visible en ese ancho).
 * - Pulsar una persona abre su hoja (`PanelHoja`) con su actividad por hora.
 * - Un `null` pinta «—», nunca 0. La conversión de quien no atendió chats
 *   (cajas) es «—» porque la caja no registra a quien no compra.
 */
const COLUMNAS: { id: ColumnaId; etiqueta: string; numerica: boolean }[] = [
  { id: "nombre", etiqueta: "Persona", numerica: false },
  { id: "conversaciones", etiqueta: "Conversaciones", numerica: true },
  { id: "mensajes", etiqueta: "Mensajes", numerica: true },
  { id: "contactos", etiqueta: "Contactos", numerica: true },
  { id: "primera", etiqueta: "1ª respuesta", numerica: true },
  { id: "en5", etiqueta: "≤ 5 min", numerica: true },
  { id: "envios", etiqueta: "Envíos", numerica: true },
  { id: "monto", etiqueta: "Monto", numerica: true },
  { id: "conversion", etiqueta: "Conversión", numerica: true },
  { id: "reasignadas", etiqueta: "Reasignadas", numerica: true },
  { id: "ultimo", etiqueta: "Último mensaje", numerica: true },
];

const entero = (n: number) => n.toLocaleString("es-VE");

function celdas(fila: FilaPersona, abrir: () => void): Record<ColumnaId, ReactNode> {
  const p = fila.persona;
  return {
    nombre: (
      <div className="as-ag">
        <span className={`pn-avatar pn-avatar--${avatarDe(p.rol)}`} aria-hidden="true">
          {iniciales(p.nombre)}
        </span>
        <div>
          <button type="button" className="as-nombre" onClick={abrir}>
            {p.nombre}
          </button>
          <small>
            {etiquetaRol(p.rol)}
            {p.en_reparto && <span className="pn-chip pn-chip--bien as-reparto">En reparto</span>}
          </small>
        </div>
      </div>
    ),
    conversaciones: <span className="as-v">{entero(p.conversaciones)}</span>,
    mensajes: <span className="as-v">{entero(p.mensajes)}</span>,
    contactos: <span className="as-v">{entero(p.contactos)}</span>,
    primera: (
      <>
        <span className="as-v">{formatoMinutos(p.primera_resp_mediana_min)}</span>
        {p.primera_resp_p90_min !== null && <small>p90 {formatoMinutos(p.primera_resp_p90_min)}</small>}
      </>
    ),
    en5: <span className="as-v">{formatoPorcentaje(p.en_5min)}</span>,
    envios: (
      <>
        <span className="as-v">{entero(p.envios)}</span>
        {tiendaVisible() && (
          <small>
            {p.envios_online} online · {p.envios_tienda} tienda
          </small>
        )}
      </>
    ),
    monto: <span className="as-v">{formatoUsd(p.monto)}</span>,
    conversion: (
      <>
        <span className="as-conv">
          <span className="as-conv__pista" aria-hidden="true">
            <span className="as-conv__fill" style={{ transform: `scaleX(${Math.min(1, Math.max(0, fila.conversion ?? 0))})` }} />
          </span>
          <span className="as-v">{formatoPorcentaje(fila.conversion)}</span>
        </span>
        {fila.atendidas !== null && fila.compraron !== null && (
          <small>
            {fila.compraron} de {fila.atendidas}
          </small>
        )}
      </>
    ),
    reasignadas: <span className="as-v">{entero(p.reasignadas_desde)}</span>,
    ultimo: <span className="as-v as-v--fecha">{formatoFechaHora(p.ultimo_mensaje)}</span>,
  };
}

export function TablaPersonas({
  filas,
  etiquetaRango,
  recortado,
  conversionDisponible,
}: {
  filas: FilaPersona[];
  etiquetaRango: string;
  /** El rango pasó el tope de 92 días de las lecturas de mensajes. */
  recortado: boolean;
  /** `false` si la lectura de conversaciones cayó: la columna Conversión queda en «—». */
  conversionDisponible: boolean;
}) {
  const [columna, setColumna] = useState<ColumnaId>("mensajes");
  const [direccion, setDireccion] = useState<Direccion>("desc");
  const [abierta, setAbierta] = useState<string | null>(null);

  const ordenadas = useMemo(() => ordenarFilas(filas, columna, direccion), [filas, columna, direccion]);
  const filaAbierta = abierta ? (filas.find((f) => f.persona.agent_id === abierta) ?? null) : null;

  function ordenarPor(id: ColumnaId) {
    if (id === columna) {
      setDireccion((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setColumna(id);
      setDireccion(direccionInicial(id));
    }
  }

  return (
    <section className="pn-card pn-card--panel as-tabla-card" aria-labelledby="as-tabla-tit">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Equipo · {etiquetaRango}</p>
          <h2 className="pn-card__titulo" id="as-tabla-tit">
            Rendimiento por persona
          </h2>
          {recortado && <p className="pn-subtitulo">Mostrando los últimos 92 días: es el máximo que se puede medir de una vez.</p>}
          {!conversionDisponible && <p className="pn-subtitulo">La conversión no está disponible ahora.</p>}
        </div>
        <label className="as-orden-movil">
          <span className="pn-sr">Ordenar por</span>
          <select
            aria-label="Ordenar por"
            value={columna}
            onChange={(e) => {
              const id = e.target.value as ColumnaId;
              setColumna(id);
              setDireccion(direccionInicial(id));
            }}
          >
            {COLUMNAS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.etiqueta}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filas.length === 0 ? (
        <p className="pn-vacio">Sin actividad en este período.</p>
      ) : (
        <div className="pn-tabla-wrap">
          <table className="as-tabla" aria-label="Rendimiento por persona">
            <thead>
              <tr>
                {COLUMNAS.map((c) => (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={c.id === columna ? (direccion === "asc" ? "ascending" : "descending") : undefined}
                  >
                    <button type="button" className="as-th" onClick={() => ordenarPor(c.id)}>
                      {c.etiqueta}
                      <ArrowDown size={12} aria-hidden="true" data-flecha="" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordenadas.map((fila) => {
                const contenido = celdas(fila, () => setAbierta(fila.persona.agent_id));
                return (
                  <tr key={fila.persona.agent_id} onClick={() => setAbierta(fila.persona.agent_id)}>
                    {COLUMNAS.map((c) => (
                      <td key={c.id} data-label={c.etiqueta}>
                        {contenido[c.id]}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PanelHoja abierta={filaAbierta !== null} titulo={filaAbierta?.persona.nombre ?? "Persona"} onCerrar={() => setAbierta(null)}>
        {filaAbierta && <HojaPersona fila={filaAbierta} etiquetaRango={etiquetaRango} />}
      </PanelHoja>
    </section>
  );
}
