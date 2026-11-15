"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { SlidingPills } from "@/components/sliding-pills";
import type { BusinessHours } from "@/lib/business-hours";
import type { PanelCola } from "@/lib/paneles/parse";
import { esperaDe, tonoEspera } from "./espera";
import { formatoReloj, iniciales } from "./formato";

/**
 * Cola de pendientes (plan "Paneles", 13/11/2026, C6): las 20 conversaciones
 * más viejas que esperan respuesta, con su espera en vivo (el reloj único de la
 * página, no uno por fila), contacto y asesor, un filtro Todas / Sin dueño /
 * Con dueño y la distribución por antigüedad.
 *
 * Los conteos de las píldoras son los de la cola ENTERA (`pendientes`,
 * `sin_dueno`, `con_dueno`), no los de la lista de 20: si no, "Sin dueño 7"
 * mentiría cuando hay 40 sin dueño. Cuando la lista es más corta que el total
 * lo dice ("Mostrando las 20 más viejas de 85").
 *
 * `id="pendientes"` es el ancla a la que apuntan el aviso y la tarjeta de
 * pendientes de arriba. Sin "Abrir chat" ni "Reasignar": no hay una fuente
 * confiable de esas acciones desde un panel de solo lectura.
 */
type Filtro = "todas" | "sin_dueno" | "con_dueno";

const TRAMOS: { clave: keyof PanelCola["por_antiguedad"]; etiqueta: string }[] = [
  { clave: "menos_1h", etiqueta: "Menos de 1 h" },
  { clave: "de_1_a_4h", etiqueta: "1 a 4 h" },
  { clave: "de_4_a_24h", etiqueta: "4 a 24 h" },
  { clave: "de_1_a_7d", etiqueta: "1 a 7 días" },
];

export function ColaPendientes({ dato, ahoraVivo, horario }: { dato: PanelCola; ahoraVivo: Date; horario: BusinessHours }) {
  const [filtro, setFiltro] = useState<Filtro>("todas");

  const visibles = dato.lista.filter((f) => (filtro === "todas" ? true : filtro === "sin_dueno" ? f.asesor_id === null : f.asesor_id !== null));
  const maximo = Math.max(1, ...TRAMOS.map((t) => dato.por_antiguedad[t.clave]));

  return (
    <section className="pn-card pn-card--panel as-cola" id="pendientes" tabIndex={-1} aria-labelledby="as-cola-tit">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Cola · ahora</p>
          <h2 className="pn-card__titulo" id="as-cola-tit">
            Esperando respuesta
          </h2>
        </div>
        <div className="pn-scroll">
          <SlidingPills<Filtro>
            ariaLabel="Filtrar pendientes"
            tone="segmented"
            value={filtro}
            onChange={setFiltro}
            items={[
              { value: "todas", label: "Todas", count: dato.pendientes },
              { value: "sin_dueno", label: "Sin dueño", count: dato.sin_dueno },
              { value: "con_dueno", label: "Con dueño", count: dato.con_dueno },
            ]}
          />
        </div>
      </div>

      {dato.pendientes === 0 ? (
        <p className="pn-vacio as-cola__bien">
          <CheckCircle2 size={22} aria-hidden="true" />
          No hay conversaciones esperando respuesta.
        </p>
      ) : (
        <div className="as-cola__cuerpo">
          <div>
            {visibles.length === 0 ? (
              <p className="pn-vacio">No hay conversaciones en este filtro entre las más viejas.</p>
            ) : (
              <ul className="pn-lista">
                {visibles.map((f) => {
                  const espera = esperaDe(f.desde, ahoraVivo, horario);
                  const contacto = f.contacto?.trim() || "Contacto sin nombre";
                  return (
                    <li key={f.conversation_id} className="pn-lista__fila as-cola__fila">
                      <span className="pn-avatar" aria-hidden="true">
                        {iniciales(contacto)}
                      </span>
                      <span className="pn-lista__txt">
                        <b>{contacto}</b>
                        <small>
                          {f.asesor ? <span className="pn-chip pn-chip--neutro">{f.asesor}</span> : <span className="pn-chip pn-chip--alerta">Sin dueño</span>}
                        </small>
                      </span>
                      <span className={`pn-chip pn-chip--${tonoEspera(espera.laborales)} as-espera`}>{formatoReloj(espera.ms)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {dato.pendientes > dato.lista.length && (
              <p className="pn-kpi__pie as-cola__pie">
                Mostrando las {dato.lista.length} más viejas de {dato.pendientes}.
              </p>
            )}
          </div>

          <div className="as-antig" role="group" aria-label="Pendientes por antigüedad">
            <p className="pn-eyebrow">Por antigüedad</p>
            <ul className="as-antig__lista">
              {TRAMOS.map((t) => {
                const n = dato.por_antiguedad[t.clave];
                return (
                  <li key={t.clave} className="as-antig__fila">
                    <span>{t.etiqueta}</span>
                    <b>{n}</b>
                    <span className="as-antig__pista" aria-hidden="true">
                      <i style={{ width: `${(n / maximo) * 100}%` }} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
