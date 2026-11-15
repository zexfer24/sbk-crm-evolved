"use client";

import type { BusinessHours } from "@/lib/business-hours";
import { estaAbierto, horasDeAtencion } from "./datos";
import { formatoEntero } from "./formato";

/**
 * «Cuándo escriben» (plan "Paneles", C5, 13/11/2026): mensajes del cliente por
 * día de la semana y hora de Caracas, en las horas de atención del negocio.
 *
 * Es una tabla de verdad (`th scope`), no una rejilla de divs: un lector de
 * pantalla la recorre fila por fila y cada celda dice su día, su hora y su
 * cantidad en `title`. La intensidad sale de una variable CSS (`--i`, 0 a 1)
 * mezclada con el fondo, así sigue al tema claro y al oscuro. Una celda de un
 * día u hora cerrada se dibuja hueca: si ahí llegaron mensajes igual, se ven
 * (el número no se esconde), pero el hueco avisa que nadie atendía.
 *
 * No hay mapa de ventas: la RPC solo trae mensajes del cliente (el calor del
 * chat), y las ventas por hora no existen como matriz.
 */

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
/** De lunes a domingo: la semana se lee desde el lunes aunque la matriz empiece en domingo. */
const ORDEN = [1, 2, 3, 4, 5, 6, 0];

export function MapaDeCalor({ valores, horario }: { valores: number[][]; horario: BusinessHours }) {
  const { desde, hasta } = horasDeAtencion(horario);
  const horas = Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);

  let maximo = 0;
  let total = 0;
  let fuera = 0;
  let pico: { dia: number; hora: number; n: number } | null = null;
  for (let dia = 0; dia < valores.length; dia++) {
    for (let hora = 0; hora < valores[dia].length; hora++) {
      const n = valores[dia][hora];
      total += n;
      if (hora < desde || hora > hasta) {
        fuera += n;
        continue;
      }
      maximo = Math.max(maximo, n);
      if (pico === null || n > pico.n) pico = { dia, hora, n };
    }
  }

  if (!(total > 0)) {
    return <p className="pn-vacio">Sin mensajes de clientes en este período.</p>;
  }

  const mensajes = (n: number) => `${formatoEntero(n)} ${n === 1 ? "mensaje" : "mensajes"}`;

  return (
    <>
      {pico !== null && pico.n > 0 && (
        <p className="pn-subtitulo" style={{ marginBottom: 12 }}>
          Hora pico: {DIAS[pico.dia].toLowerCase()} a las {pico.hora}:00 ({mensajes(pico.n)}).
        </p>
      )}
      <div className="an-calor-wrap">
        <table className="an-calor" aria-label="Cuándo escriben: mensajes de clientes por día y hora">
          <thead>
            <tr>
              <th scope="col">
                <span className="pn-sr">Día</span>
              </th>
              {horas.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ORDEN.map((dia) => (
              <tr key={dia}>
                <th scope="row">{DIAS[dia]}</th>
                {horas.map((hora) => {
                  const n = valores[dia]?.[hora] ?? 0;
                  const intensidad = maximo > 0 ? n / maximo : 0;
                  const cerrado = !estaAbierto(horario, dia, hora);
                  return (
                    <td
                      key={hora}
                      title={`${DIAS[dia]}, ${hora}:00 a ${hora}:59: ${mensajes(n)}${cerrado ? " (fuera de horario)" : ""}`}
                      data-cerrado={cerrado && n === 0 ? "true" : undefined}
                      data-fuerte={intensidad > 0.55 ? "true" : undefined}
                      data-cero={n === 0 ? "true" : undefined}
                      style={{ ["--i" as string]: intensidad.toFixed(2) }}
                    >
                      {n}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="an-calor-escala">
        <span>Menos</span>
        <i aria-hidden="true" />
        <span>Más (hasta {mensajes(maximo)} por hora)</span>
      </div>
      {fuera > 0 && (
        <p className="pn-subtitulo" style={{ marginTop: 8 }}>
          {mensajes(fuera)} llegaron fuera de las horas que se muestran.
        </p>
      )}
    </>
  );
}
