"use client";

import { useState } from "react";
import { HelpCircle, Info, TrendingDown } from "lucide-react";
import type { BusinessHours } from "@/lib/business-hours";
import type { BloqueConTope } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { PanelConversaciones } from "@/lib/paneles/parse";
import { PanelBloque } from "@/components/paneles/panel-marco";
import { PanelHoja } from "@/components/paneles/panel-hoja";
import { BarraApilada100 } from "@/components/paneles/panel-graficos";
import { etapasDelEmbudo, fraseDelEmbudo } from "./datos";
import { formatoEntero } from "./formato";
import { MapaDeCalor } from "./calor";

/**
 * Embudo conversacional (plan "Paneles", C5, 13/11/2026): solo el chat. Las
 * cuatro etapas con la caída entre pasos, cómo terminaron todos los que
 * escribieron (cinco resultados excluyentes que suman el total), la frase que
 * lo resume y el mapa de calor «Cuándo escriben». En «En tienda» no hay nada
 * que medir —la caja no registra a quien no compra— y lo dice.
 */

/**
 * El orden de la barra NO sigue el de la base: verde y rojo no van juntos
 * (con deuteranopía se confunden, ΔE 5,7 según `validate_palette`); el rojo
 * del reclamo queda al final, separado del verde por tres segmentos.
 */
const RESULTADOS = [
  { id: "compraron", etiqueta: "Compraron", color: "var(--pn-bien)" },
  { id: "carrito_sin_compra", etiqueta: "Carrito sin compra", color: "var(--pn-alerta)" },
  { id: "solo_preguntaron", etiqueta: "Solo preguntaron", color: "var(--pn-online)" },
  { id: "sin_respuesta", etiqueta: "Sin respuesta", color: "var(--an-neutro)" },
  { id: "reclamo", etiqueta: "Reclamo", color: "var(--pn-critico)" },
] as const;

function pluralConversaciones(n: number): string {
  return `${formatoEntero(n)} ${n === 1 ? "conversación" : "conversaciones"}`;
}

export function EmbudoConversacional({
  conversaciones,
  vista,
  horario,
}: {
  conversaciones: BloqueConTope<PanelConversaciones>;
  vista: Vista;
  horario: BusinessHours;
}) {
  const [hojaAbierta, setHojaAbierta] = useState(false);

  if (vista === "tienda") {
    return (
      <div className="pn-c12">
        <section className="pn-card pn-card--panel" aria-label="Embudo conversacional">
          <p className="an-nota">
            <Info size={16} aria-hidden="true" />
            <span>
              <b>El embudo mide el chat.</b> Las ventas en tienda no pasan por una conversación de WhatsApp, así que
              no hay quién escribió, respondió ni compró que contar. Cambia a Resumen u Online para verlo.
            </span>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="pn-c12">
      <PanelBloque bloque={conversaciones} nombre="Embudo conversacional">
        {(dato) => {
          const etapas = etapasDelEmbudo(dato.embudo);
          const frase = fraseDelEmbudo(dato.embudo, dato.resultados);
          const segmentos = RESULTADOS.map((r) => ({
            id: r.id,
            etiqueta: r.etiqueta,
            valor: dato.resultados[r.id],
            color: r.color,
          }));
          const resumenResultados = `De ${pluralConversaciones(dato.embudo.escribieron)}: ${segmentos
            .map((s) => `${s.valor} ${s.etiqueta.toLowerCase()}`)
            .join(", ")}.`;

          return (
            <div className="pn-bento">
              <p className="pn-c12 an-frase" aria-live="polite">
                {frase ?? "Nadie escribió en este período."}
              </p>

              <section className="pn-card pn-card--panel pn-c7" aria-labelledby="an-embudo-titulo">
                <div className="pn-card__cab">
                  <div>
                    <p className="pn-eyebrow">Embudo conversacional</p>
                    <h2 className="pn-card__titulo" id="an-embudo-titulo">
                      Por dónde se van
                    </h2>
                  </div>
                  {conversaciones.recortado && <span className="pn-chip pn-chip--neutro">Últimos 92 días</span>}
                </div>
                <ol className="an-etapas">
                  {etapas.map((etapa) => (
                    <li key={etapa.id} className="an-etapa">
                      <div className="an-etapa__cab">
                        <b>{etapa.etiqueta}</b>
                        <span className="an-etapa__cifra">{formatoEntero(etapa.valor)}</span>
                      </div>
                      <div className="an-barra" aria-hidden="true">
                        <i style={{ width: `${Math.min(100, etapa.pctDelInicio)}%` }} />
                      </div>
                      <small>
                        {etapa.pctDelInicio} % de los que escribieron
                        {etapa.caida && etapa.caida.n > 0 && (
                          <>
                            {" · "}
                            <span className="an-etapa__caida" title="Se perdieron entre la etapa anterior y esta">
                              <TrendingDown size={12} aria-hidden="true" />
                              −{etapa.caida.n} · {etapa.caida.pct} %
                            </span>
                          </>
                        )}
                      </small>
                    </li>
                  ))}
                </ol>
              </section>

              <section className="pn-card pn-card--panel pn-c5" aria-labelledby="an-terminaron-titulo">
                <div className="pn-card__cab">
                  <div>
                    <p className="pn-eyebrow">Todos los que escribieron</p>
                    <h2 className="pn-card__titulo" id="an-terminaron-titulo">
                      En qué terminaron
                    </h2>
                  </div>
                  <span className="pn-chip pn-chip--neutro">{pluralConversaciones(dato.embudo.escribieron)}</span>
                </div>
                <BarraApilada100 segmentos={segmentos} ariaLabel={resumenResultados} />
                <div className="an-pie">
                  <span>Cada conversación cuenta en un solo resultado.</span>
                  <button type="button" className="pn-boton" onClick={() => setHojaAbierta(true)}>
                    <HelpCircle size={13} aria-hidden="true" />
                    Cómo se mide
                  </button>
                </div>
              </section>

              <section className="pn-card pn-card--panel pn-c12" aria-labelledby="an-calor-titulo">
                <div className="pn-card__cab">
                  <div>
                    <p className="pn-eyebrow">Mensajes de los clientes · hora de Caracas</p>
                    <h2 className="pn-card__titulo" id="an-calor-titulo">
                      Cuándo escriben
                    </h2>
                  </div>
                </div>
                <MapaDeCalor valores={dato.calor.valores} horario={horario} />
              </section>

              <PanelHoja abierta={hojaAbierta} titulo="Cómo se mide cada resultado" onCerrar={() => setHojaAbierta(false)}>
                <div className="an-definiciones">
                  <h3>Las cuatro etapas</h3>
                  <dl className="an-definiciones">
                    <div>
                      <dt>Escribieron</dt>
                      <dd>Conversaciones con al menos un mensaje del cliente dentro del período.</dd>
                    </div>
                    <div>
                      <dt>Respondidas</dt>
                      <dd>
                        Un asesor o Seba le respondió al cliente (una nota interna no cuenta) después de su primer
                        mensaje del período.
                      </dd>
                    </div>
                    <div>
                      <dt>Con carrito</dt>
                      <dd>Se creó o cambió algún renglón del carrito de esa conversación dentro del período.</dd>
                    </div>
                    <div>
                      <dt>Compraron</dt>
                      <dd>Hay un envío a SAINT de esa conversación dentro del período.</dd>
                    </div>
                  </dl>
                  <h3>En qué terminaron (en este orden de prioridad)</h3>
                  <dl className="an-definiciones">
                    <div>
                      <dt>Compraron</dt>
                      <dd>Tienen un envío a SAINT en el período.</dd>
                    </div>
                    <div>
                      <dt>Reclamo</dt>
                      <dd>El contacto tiene una etiqueta que empieza por «reclamo» y no compró.</dd>
                    </div>
                    <div>
                      <dt>Carrito sin compra</dt>
                      <dd>Armaron un carrito pero no hay envío.</dd>
                    </div>
                    <div>
                      <dt>Solo preguntaron</dt>
                      <dd>Les respondieron, no armaron carrito y no compraron.</dd>
                    </div>
                    <div>
                      <dt>Sin respuesta</dt>
                      <dd>Nadie les respondió dentro del período.</dd>
                    </div>
                  </dl>
                </div>
              </PanelHoja>
            </div>
          );
        }}
      </PanelBloque>
    </div>
  );
}
