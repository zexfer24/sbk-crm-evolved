"use client";

import type { ReactNode } from "react";
import type { Vista } from "@/lib/paneles/canal";
import type { PanelConversaciones, PanelVentas, PanelVentasActivas } from "@/lib/paneles/parse";
import { PanelHoja } from "@/components/paneles/panel-hoja";
import { formatoUsd } from "@/components/paneles/panel-marco";
import {
  antiguedadTexto,
  canalDeVista,
  enviosPorPersona,
  itemsDeVista,
} from "@/components/paneles/dashboard/calculos";
import { formatoEntero, formatoPorcentaje } from "@/components/paneles/dashboard/cifra";

/**
 * Las hojas de detalle del Dashboard (plan "Paneles", C4, 13/11/2026): una por
 * tarjeta pequeña. `PanelHoja` solo pinta su contenido mientras está abierta.
 */

function Tabla({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="pn-tabla-wrap">
      <table className="pn-tabla">
        <caption className="pn-sr">{titulo}</caption>
        {children}
      </table>
    </div>
  );
}

const ETIQUETA_CANAL = { online: "Online", tienda: "En tienda" } as const;

export function HojaVentasActivas({
  abierta,
  onCerrar,
  datos,
  vista,
  ahora,
}: {
  abierta: boolean;
  onCerrar: () => void;
  datos: PanelVentasActivas;
  vista: Vista;
  ahora: Date;
}) {
  const items = itemsDeVista(datos, vista);
  return (
    <PanelHoja abierta={abierta} titulo="Ventas activas" onCerrar={onCerrar}>
      <p className="pn-subtitulo">
        Presupuestos y carritos que todavía no se enviaron a SAINT, valuados al precio de hoy. Los más viejos
        primero.
      </p>
      {items.length === 0 ? (
        <p className="pn-vacio">No hay nada sin enviar.</p>
      ) : (
        <Tabla titulo="Presupuestos y carritos sin enviar">
          <thead>
            <tr>
              <th scope="col">Tipo</th>
              <th scope="col">Canal</th>
              <th scope="col">Responsable</th>
              <th scope="col">Cliente</th>
              <th scope="col" className="pn-der">
                Monto
              </th>
              <th scope="col" className="pn-der">
                Antigüedad
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.tipo === "carrito" ? "Carrito" : "Presupuesto"}</td>
                <td>{ETIQUETA_CANAL[i.canal]}</td>
                <td className="pn-corto">{i.responsable ?? "—"}</td>
                <td className="pn-corto">{i.cliente ?? "—"}</td>
                <td className="pn-der lm-num">{formatoUsd(i.monto)}</td>
                <td className="pn-der lm-num">{antiguedadTexto(i.desde, ahora)}</td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      )}
      {datos.items.length >= 30 && <p className="pn-kpi__pie">Se muestran los 30 más viejos.</p>}
    </PanelHoja>
  );
}

function unidadesDe(r: PanelVentas["top_repuestos"][number], vista: Vista): number {
  return vista === "resumen" ? r.unidades : vista === "online" ? r.unidades_online : r.unidades_tienda;
}

export function HojaEnviado({
  abierta,
  onCerrar,
  ventas,
  vista,
}: {
  abierta: boolean;
  onCerrar: () => void;
  ventas: PanelVentas;
  vista: Vista;
}) {
  const repuestos = ventas.top_repuestos.filter((r) => unidadesDe(r, vista) > 0).slice(0, 8);
  const personas = enviosPorPersona(ventas, vista);
  const { duplicados, sin_foto: sinFoto } = ventas.estado;

  return (
    <PanelHoja abierta={abierta} titulo="Enviado a SAINT" onCerrar={onCerrar}>
      <p className="pn-subtitulo">
        Lo enviado a SAINT en el período: facturas en espera, todavía no cobradas.
      </p>

      <h3 className="pd-hoja-sub">Repuestos que más ingresos dejaron</h3>
      {repuestos.length === 0 ? (
        <p className="pn-vacio">Sin ventas en el período.</p>
      ) : (
        <Tabla titulo="Repuestos del período">
          <thead>
            <tr>
              <th scope="col">Repuesto</th>
              <th scope="col" className="pn-der">
                Unidades
              </th>
              {vista === "resumen" && (
                <th scope="col" className="pn-der">
                  Ingresos
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {repuestos.map((r) => (
              <tr key={r.codprod}>
                <td>{r.nombre}</td>
                <td className="pn-der lm-num">{formatoEntero(unidadesDe(r, vista))}</td>
                {vista === "resumen" && <td className="pn-der lm-num">{formatoUsd(r.ingresos)}</td>}
              </tr>
            ))}
          </tbody>
        </Tabla>
      )}

      <h3 className="pd-hoja-sub">Personas</h3>
      {personas.length === 0 ? (
        <p className="pn-vacio">Nadie envió nada en el período.</p>
      ) : (
        <Tabla titulo="Envíos por persona">
          <thead>
            <tr>
              <th scope="col">Persona</th>
              <th scope="col" className="pn-der">
                Envíos
              </th>
              <th scope="col" className="pn-der">
                Monto
              </th>
            </tr>
          </thead>
          <tbody>
            {personas.map((p) => (
              <tr key={p.agent_id}>
                <td>{p.nombre}</td>
                <td className="pn-der lm-num">{p.envios}</td>
                <td className="pn-der lm-num">{formatoUsd(p.ingresos)}</td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      )}

      {(duplicados > 0 || sinFoto > 0) && (
        <p className="pn-kpi__pie">
          {duplicados > 0 && `${duplicados} posibles duplicados no se cuentan. `}
          {sinFoto > 0 && `${sinFoto} envíos no tienen foto de monto y quedan fuera de las cifras.`}
        </p>
      )}
    </PanelHoja>
  );
}

export function HojaUnidades({
  abierta,
  onCerrar,
  ventas,
  vista,
}: {
  abierta: boolean;
  onCerrar: () => void;
  ventas: PanelVentas;
  vista: Vista;
}) {
  const total = canalDeVista(ventas, vista).unidades;
  const repuestos = ventas.top_repuestos
    .map((r) => ({ ...r, cuantas: unidadesDe(r, vista) }))
    .filter((r) => r.cuantas > 0)
    .sort((a, b) => b.cuantas - a.cuantas);

  return (
    <PanelHoja abierta={abierta} titulo="Unidades vendidas" onCerrar={onCerrar}>
      <p className="pn-subtitulo">{formatoEntero(total)} unidades en el período, por repuesto (los 15 con más ingresos).</p>
      {repuestos.length === 0 ? (
        <p className="pn-vacio">Sin ventas en el período.</p>
      ) : (
        <Tabla titulo="Unidades por repuesto">
          <thead>
            <tr>
              <th scope="col">Repuesto</th>
              <th scope="col" className="pn-der">
                Online
              </th>
              <th scope="col" className="pn-der">
                En tienda
              </th>
              <th scope="col" className="pn-der">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {repuestos.map((r) => (
              <tr key={r.codprod}>
                <td>{r.nombre}</td>
                <td className="pn-der lm-num">{r.unidades_online}</td>
                <td className="pn-der lm-num">{r.unidades_tienda}</td>
                <td className="pn-der lm-num">{r.cuantas}</td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      )}
    </PanelHoja>
  );
}

export function HojaConversion({
  abierta,
  onCerrar,
  conversaciones,
}: {
  abierta: boolean;
  onCerrar: () => void;
  conversaciones: PanelConversaciones;
}) {
  const { embudo, conversion } = conversaciones;
  return (
    <PanelHoja abierta={abierta} titulo="Tasa de conversión" onCerrar={onCerrar}>
      <p className="pn-subtitulo">
        Solo el chat. Una conversación «compró» si tiene una venta en los 7 días siguientes a la primera respuesta.
      </p>
      <h3 className="pd-hoja-sub">Del primer mensaje a la compra</h3>
      <Tabla titulo="Embudo del chat">
        <tbody>
          <tr>
            <th scope="row">Escribieron</th>
            <td className="pn-der lm-num">{embudo.escribieron}</td>
          </tr>
          <tr>
            <th scope="row">Recibieron respuesta</th>
            <td className="pn-der lm-num">{embudo.respondidas}</td>
          </tr>
          <tr>
            <th scope="row">Armaron un carrito</th>
            <td className="pn-der lm-num">{embudo.con_carrito}</td>
          </tr>
          <tr>
            <th scope="row">Compraron</th>
            <td className="pn-der lm-num">{embudo.compraron}</td>
          </tr>
        </tbody>
      </Tabla>

      <h3 className="pd-hoja-sub">Por persona que respondió</h3>
      {conversion.personas.length === 0 ? (
        <p className="pn-vacio">Nadie respondió en el período.</p>
      ) : (
        <Tabla titulo="Conversión por persona">
          <thead>
            <tr>
              <th scope="col">Persona</th>
              <th scope="col" className="pn-der">
                Atendidas
              </th>
              <th scope="col" className="pn-der">
                Compraron
              </th>
              <th scope="col" className="pn-der">
                Tasa
              </th>
            </tr>
          </thead>
          <tbody>
            {conversion.personas.map((p) => (
              <tr key={p.agent_id ?? `rol-${p.rol}`}>
                <td>{p.nombre}</td>
                <td className="pn-der lm-num">{p.atendidas}</td>
                <td className="pn-der lm-num">{p.compraron}</td>
                <td className="pn-der lm-num">
                  {p.atendidas > 0 ? formatoPorcentaje(Math.round((p.compraron / p.atendidas) * 1000) / 10) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </Tabla>
      )}
    </PanelHoja>
  );
}
