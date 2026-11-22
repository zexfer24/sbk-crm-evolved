"use client";

import { useState, type ReactNode } from "react";
import { mostrarEquipoTienda, tiendaVisible, type Vista } from "@/lib/paneles/canal";
import {
  VENTANAS_ACTIVA,
  type EquipoActiva,
  type MontoCantidad,
  type OrigenActiva,
  type PanelConversaciones,
  type PanelVentas,
  type PanelVentasActivas,
  type VentanaActiva,
} from "@/lib/paneles/parse";
import { PanelHoja } from "@/components/paneles/panel-hoja";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { SlidingPills } from "@/components/sliding-pills";
import {
  antiguedadTexto,
  canalDeVista,
  desgloseActivas,
  enviosPorPersona,
  ETIQUETA_ORIGEN,
  ETIQUETA_VENTANA,
  itemsDeVista,
  origenesConFila,
  type DesgloseActivas,
} from "@/components/paneles/dashboard/calculos";
import { formatoEntero, formatoPorcentaje } from "@/components/paneles/dashboard/cifra";
import {
  ETIQUETA_EQUIPO_ITEM,
  textoCelda,
  textoEquipoItem,
  VentanaDeItem,
} from "@/components/paneles/dashboard/ventas-activas-comun";

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

const FILAS_INICIALES = 8;
/** Lo que trae `panel_ventas_activas()` como máximo (los más viejos primero). */
const TOPE_DE_ITEMS = 300;

type FiltroVentana = "todas" | "abierta" | "por_cerrar" | "cerrada";
const FILTROS_DE_VENTANA: { value: FiltroVentana; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "abierta", label: "Abierta" },
  { value: "por_cerrar", label: "Por cerrar" },
  { value: "cerrada", label: "Cerrada" },
];

/** De dónde sale cada venta y quién la armó: una fila por origen, una columna por equipo y el total. */
function MatrizOrigenEquipo({
  d,
  porOrigenEquipo,
  vista,
}: {
  d: DesgloseActivas;
  porOrigenEquipo: Record<OrigenActiva, Record<EquipoActiva, MontoCantidad>>;
  vista: Vista;
}) {
  const porOrigen = d.porOrigen;
  const porEquipo = d.porEquipo;
  if (!porOrigen || !porEquipo) return null;
  const equipos: EquipoActiva[] = [
    "online",
    ...(mostrarEquipoTienda(porEquipo.tienda.cantidad) ? (["tienda"] as const) : []),
    ...(porEquipo.sin_dato.cantidad > 0 ? (["sin_dato"] as const) : []),
  ];
  return (
    <Tabla titulo="De dónde y quién lo armó">
      <thead>
        <tr>
          <th scope="col">Origen</th>
          {equipos.map((e) => (
            <th key={e} scope="col" className="pn-der">
              {ETIQUETA_EQUIPO_ITEM[e]}
            </th>
          ))}
          <th scope="col" className="pn-der">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {origenesConFila(d, vista).map((o) => (
          <tr key={o}>
            <th scope="row">{ETIQUETA_ORIGEN[o]}</th>
            {equipos.map((e) => (
              <td key={e} className="pn-der lm-num pd-matriz__celda">
                {textoCelda(porOrigenEquipo[o][e])}
              </td>
            ))}
            <td className="pn-der lm-num pd-matriz__celda">{textoCelda(porOrigen[o])}</td>
          </tr>
        ))}
      </tbody>
    </Tabla>
  );
}

/** Cuántas ventas todavía se le pueden escribir al cliente sin plantilla (la ventana de 24 h de WhatsApp). */
function TablaVentanas({ porVentana }: { porVentana: Record<VentanaActiva, MontoCantidad> }) {
  const estados = VENTANAS_ACTIVA.filter((v) => v !== "no_aplica" || porVentana.no_aplica.cantidad > 0);
  return (
    <Tabla titulo="Ventana de WhatsApp">
      <thead>
        <tr>
          <th scope="col">Estado</th>
          <th scope="col" className="pn-der">
            Cantidad
          </th>
          <th scope="col" className="pn-der">
            Monto
          </th>
        </tr>
      </thead>
      <tbody>
        {estados.map((v) => (
          <tr key={v}>
            <th scope="row">{ETIQUETA_VENTANA[v]}</th>
            <td className="pn-der lm-num">{porVentana[v].cantidad}</td>
            <td className="pn-der lm-num">{formatoUsd(porVentana[v].monto)}</td>
          </tr>
        ))}
      </tbody>
    </Tabla>
  );
}

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
  const [ventana, setVentana] = useState<FiltroVentana>("todas");
  const [verTodas, setVerTodas] = useState(false);
  const d = desgloseActivas(datos, vista);
  const items = itemsDeVista(datos, vista);
  const desglose = datos.desglose;
  const conDesglose = desglose !== null && d.porVentana !== null;
  // D1 (21/11/2026): sin el canal «tienda» la columna «Canal» no distingue nada.
  const conCanal = tiendaVisible();

  const filas = conDesglose && ventana !== "todas" ? items.filter((i) => i.ventana === ventana) : items;
  const visibles = verTodas ? filas : filas.slice(0, FILAS_INICIALES);

  return (
    <PanelHoja abierta={abierta} titulo="Ventas activas" onCerrar={onCerrar}>
      <p className="pn-subtitulo">
        Presupuestos y carritos que todavía no se enviaron a SAINT, movidos en las últimas 48 h, valuados al precio de
        hoy. Lo de más de 48 h sigue en el chat y en Inventario, pero no cuenta acá.
      </p>

      {desglose && d.porVentana && (
        <>
          <h3 className="pd-hoja-sub">De dónde y quién lo armó</h3>
          <MatrizOrigenEquipo d={d} porOrigenEquipo={desglose.por_origen_equipo} vista={vista} />
          <h3 className="pd-hoja-sub">Ventana de WhatsApp</h3>
          <TablaVentanas porVentana={d.porVentana} />
          <h3 className="pd-hoja-sub">Una por una</h3>
        </>
      )}

      {conDesglose && (
        <div className="pn-scroll pd-hoja-filtro">
          <SlidingPills
            ariaLabel="Ventana de WhatsApp de la venta activa"
            tone="segmented"
            value={ventana}
            onChange={setVentana}
            items={FILTROS_DE_VENTANA}
          />
        </div>
      )}

      {filas.length === 0 ? (
        <p className="pn-vacio">{items.length === 0 ? "No hay nada sin enviar." : "No hay ventas activas con esa ventana."}</p>
      ) : (
        <Tabla titulo="Presupuestos y carritos sin enviar">
          <thead>
            <tr>
              <th scope="col">Tipo</th>
              {conCanal && <th scope="col">Canal</th>}
              <th scope="col">Responsable</th>
              {conDesglose && <th scope="col">Equipo</th>}
              <th scope="col">Cliente</th>
              <th scope="col" className="pn-der">
                Monto
              </th>
              <th scope="col" className="pn-der">
                Antigüedad
              </th>
              {conDesglose && <th scope="col">Ventana</th>}
            </tr>
          </thead>
          <tbody>
            {visibles.map((i) => (
              <tr key={i.id}>
                <td>{i.tipo === "carrito" ? "Carrito" : "Presupuesto"}</td>
                {conCanal && <td>{ETIQUETA_CANAL[i.canal]}</td>}
                <td className="pn-corto">{i.responsable ?? "—"}</td>
                {conDesglose && <td>{textoEquipoItem(i)}</td>}
                <td className="pn-corto">{i.cliente ?? "—"}</td>
                <td className="pn-der lm-num">{formatoUsd(i.monto)}</td>
                <td className="pn-der lm-num">{antiguedadTexto(i.desde, ahora)}</td>
                {conDesglose && (
                  <td>
                    <VentanaDeItem item={i} ahora={ahora} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Tabla>
      )}

      {filas.length > FILAS_INICIALES && (
        <button type="button" className="pn-boton" onClick={() => setVerTodas((v) => !v)} aria-expanded={verTodas}>
          {verTodas ? "Ver menos" : `Ver todas (${formatoEntero(filas.length)})`}
        </button>
      )}
      {datos.items.length >= TOPE_DE_ITEMS && <p className="pn-kpi__pie">Se muestran los {TOPE_DE_ITEMS} más viejos.</p>}
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
  // D1 (21/11/2026): sin el canal «tienda» el desglose online/tienda desaparece: una sola columna.
  const desglosar = tiendaVisible();

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
              {desglosar && (
                <>
                  <th scope="col" className="pn-der">
                    Online
                  </th>
                  <th scope="col" className="pn-der">
                    En tienda
                  </th>
                </>
              )}
              <th scope="col" className="pn-der">
                {desglosar ? "Total" : "Unidades"}
              </th>
            </tr>
          </thead>
          <tbody>
            {repuestos.map((r) => (
              <tr key={r.codprod}>
                <td>{r.nombre}</td>
                {desglosar && (
                  <>
                    <td className="pn-der lm-num">{r.unidades_online}</td>
                    <td className="pn-der lm-num">{r.unidades_tienda}</td>
                  </>
                )}
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
