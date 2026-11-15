"use client";

import { Info } from "lucide-react";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { PanelConversaciones, PanelVentas } from "@/lib/paneles/parse";
import { PanelBloque } from "@/components/paneles/panel-marco";
import { tasaDeConversion, tasaDeRegreso } from "./datos";
import { formatoEntero, formatoFraccion, formatoUsd, iniciales } from "./formato";

/**
 * «Conversión» (plan "Paneles", C5, 13/11/2026): quién convierte más en el
 * chat, cruzado con lo que cada persona envió a SAINT, y los clientes que
 * regresan. En «En tienda» no hay conversión (la caja no registra a quien no
 * compra): la tarjeta lo dice y en su lugar van los envíos por persona.
 */

function Avatar({ nombre, rol }: { nombre: string; rol: string }) {
  const clase = rol === "ia" ? "pn-avatar--ia" : rol === "caja" ? "pn-avatar--caja" : "pn-avatar--asesor";
  return (
    <span className={`pn-avatar ${clase}`} aria-hidden="true">
      {rol === "ia" ? "IA" : iniciales(nombre)}
    </span>
  );
}

function Persona({ nombre, rol }: { nombre: string; rol: string }) {
  return (
    <div className="an-quien">
      <Avatar nombre={nombre} rol={rol} />
      <b>{nombre}</b>
      {rol === "ia" && <span className="pn-chip pn-chip--ia">IA</span>}
    </div>
  );
}

function TablaConversion({ dato, ventas }: { dato: PanelConversaciones; ventas: Bloque<PanelVentas> }) {
  const equipo = tasaDeConversion(dato.conversion.equipo);
  // Lo que cada persona envió a SAINT desde el chat, cruzado por agent_id.
  const enviosOnline = new Map(
    ventas.ok ? ventas.dato.personas.filter((p) => p.canal === "online").map((p) => [p.agent_id, p]) : []
  );

  return (
    <section className="pn-card pn-card--panel" aria-labelledby="an-conv-titulo">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Conversión por persona · chat</p>
          <h2 className="pn-card__titulo" id="an-conv-titulo">
            Quién convierte más
          </h2>
        </div>
        <span className="pn-chip pn-chip--neutro">
          Equipo: {formatoFraccion(equipo.fraccion)} ({formatoEntero(equipo.compraron)} de {formatoEntero(equipo.atendidas)})
        </span>
      </div>
      {dato.conversion.personas.length === 0 ? (
        <p className="pn-vacio">Nadie atendió conversaciones en este período.</p>
      ) : (
        <div className="pn-tabla-wrap">
          <table className="pn-tabla an-tabla">
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col" className="pn-der an-oculta-m">
                  Atendidas
                </th>
                <th scope="col" className="pn-der">
                  Compraron
                </th>
                <th scope="col">Conversión</th>
                <th scope="col" className="pn-der an-oculta-m">
                  Envíos
                </th>
                <th scope="col" className="pn-der an-oculta-m">
                  Enviado
                </th>
              </tr>
            </thead>
            <tbody>
              {dato.conversion.personas.map((p) => {
                const fraccion = p.atendidas > 0 ? p.compraron / p.atendidas : null;
                const envio = p.agent_id === null ? undefined : enviosOnline.get(p.agent_id);
                return (
                  <tr key={p.agent_id ?? `rol-${p.rol}`}>
                    <td>
                      <Persona nombre={p.nombre} rol={p.rol} />
                    </td>
                    <td className="pn-der an-oculta-m">{formatoEntero(p.atendidas)}</td>
                    <td className="pn-der">{formatoEntero(p.compraron)}</td>
                    <td>
                      <div className="an-pct">
                        <div className="an-barra" aria-hidden="true">
                          <i style={{ width: `${Math.min(100, (fraccion ?? 0) * 100)}%` }} />
                        </div>
                        <b>{formatoFraccion(fraccion)}</b>
                      </div>
                    </td>
                    <td className="pn-der an-oculta-m">{envio ? formatoEntero(envio.envios) : "—"}</td>
                    <td className="pn-der an-oculta-m">{envio ? formatoUsd(envio.ingresos) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="pn-subtitulo" style={{ marginTop: 12 }}>
        Una venta cuenta para cada persona que respondió en esa conversación, por eso las filas pueden sumar más que el
        equipo. Se mira hasta 7 días después de su primera respuesta.
      </p>
    </section>
  );
}

function EnviosPorPersonaTienda({ dato }: { dato: PanelVentas }) {
  const filas = dato.personas.filter((p) => p.canal === "tienda");
  return (
    <section className="pn-card pn-card--panel" aria-labelledby="an-conv-titulo">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Mostrador</p>
          <h2 className="pn-card__titulo" id="an-conv-titulo">
            Envíos por persona
          </h2>
        </div>
      </div>
      <p className="an-nota" style={{ marginBottom: 14 }}>
        <Info size={16} aria-hidden="true" />
        <span>
          La caja no registra a quien no compra, así que en tienda no hay tasa de conversión: se muestran los envíos a
          SAINT de cada persona.
        </span>
      </p>
      {filas.length === 0 ? (
        <p className="pn-vacio">Sin envíos de tienda en este período.</p>
      ) : (
        <div className="pn-tabla-wrap">
          <table className="pn-tabla an-tabla">
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col" className="pn-der">
                  Envíos
                </th>
                <th scope="col" className="pn-der an-oculta-m">
                  Unidades
                </th>
                <th scope="col" className="pn-der">
                  Enviado
                </th>
              </tr>
            </thead>
            <tbody>
              {filas.map((p) => (
                <tr key={p.agent_id}>
                  <td>
                    <Persona nombre={p.nombre} rol={p.rol} />
                  </td>
                  <td className="pn-der">{formatoEntero(p.envios)}</td>
                  <td className="pn-der an-oculta-m">{formatoEntero(p.unidades)}</td>
                  <td className="pn-der">{formatoUsd(p.ingresos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ClientesQueRegresan({ dato, vista }: { dato: PanelVentas; vista: Vista }) {
  const regreso = tasaDeRegreso(dato.recurrentes, vista);
  const nuevos = regreso.compradores - regreso.regresan;
  const total = regreso.compradores;
  return (
    <section className="pn-card pn-card--panel" aria-labelledby="an-regresan-titulo">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Compradores</p>
          <h2 className="pn-card__titulo" id="an-regresan-titulo">
            Nuevos y que regresan
          </h2>
        </div>
      </div>
      {total === 0 ? (
        <p className="pn-vacio">Sin compradores en este período.</p>
      ) : (
        <div className="an-regresan">
          <div
            className="pn-apilada"
            role="img"
            aria-label={`${regreso.regresan} de ${total} compradores ya eran clientes y ${nuevos} son nuevos.`}
          >
            <span className="pn-apilada__seg" style={{ width: `${(nuevos * 100) / total}%`, background: "var(--an-nuevos)" }} />
            <span className="pn-apilada__seg" style={{ width: `${(regreso.regresan * 100) / total}%`, background: "var(--pn-seba)" }} />
          </div>
          <div className="an-regresan__datos">
            <div>
              <span>Nuevos</span>
              <b>{formatoEntero(nuevos)}</b>
              <span>{formatoFraccion(nuevos / total)}</span>
            </div>
            <div>
              <span>Regresan</span>
              <b>{formatoEntero(regreso.regresan)}</b>
              <span>{formatoFraccion(regreso.fraccion)}</span>
            </div>
          </div>
          <p className="pn-subtitulo">
            «Regresa» quien ya había comprado antes del período o ya existía en SAINT.
            {dato.recurrentes.genericos_excluidos > 0 &&
              ` No se cuentan ${formatoEntero(dato.recurrentes.genericos_excluidos)} clientes genéricos del mostrador.`}
            {vista === "resumen" && " En el resumen, quien compró en los dos canales cuenta en cada uno."}
          </p>
        </div>
      )}
    </section>
  );
}

export function ConversionYClientes({
  conversaciones,
  ventas,
  vista,
}: {
  conversaciones: BloqueConTope<PanelConversaciones>;
  ventas: Bloque<PanelVentas>;
  vista: Vista;
}) {
  return (
    <div className="pn-c12">
      <div className="pn-bento">
        {vista === "tienda" ? (
          <div className="pn-c8">
            <PanelBloque bloque={ventas} nombre="Envíos por persona">
              {(dato) => <EnviosPorPersonaTienda dato={dato} />}
            </PanelBloque>
          </div>
        ) : (
          <div className="pn-c8">
            <PanelBloque bloque={conversaciones} nombre="Conversión por persona">
              {(dato) => <TablaConversion dato={dato} ventas={ventas} />}
            </PanelBloque>
          </div>
        )}
        <div className="pn-c4">
          <PanelBloque bloque={ventas} nombre="Clientes que regresan">
            {(dato) => <ClientesQueRegresan dato={dato} vista={vista} />}
          </PanelBloque>
        </div>
      </div>
    </div>
  );
}
