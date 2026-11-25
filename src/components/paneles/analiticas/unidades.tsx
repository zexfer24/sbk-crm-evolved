"use client";

import type { Bloque } from "@/lib/paneles-data";
import { tiendaVisible, type Vista } from "@/lib/paneles/canal";
import type { CanalId, PanelVentas } from "@/lib/paneles/parse";
import { PanelBloque } from "@/components/paneles/panel-marco";
import { BarraApilada100 } from "@/components/paneles/panel-graficos";
import { canalesDeVista, nombreDeCanal } from "./datos";
import { formatoEntero, formatoUsd } from "./formato";

/**
 * «Unidades» (plan "Paneles", C5, 13/11/2026): el tipo de precio con que se
 * vendió (promoción o estándar, por canal) y el top de repuestos de la vista.
 * Reemplaza al «Cómo se paga» del mockup, que no tiene fuente: el CRM no
 * guarda forma de pago, sí el tipo de precio de cada renglón.
 *
 * `tipo_precio` cuenta UNIDADES, no envíos ni renglones (contrato de la RPC).
 */

const COLOR_PROMOCION = "var(--an-promo)";
const COLOR_ESTANDAR = "var(--an-estandar)";
const MAX_REPUESTOS = 10;

function TipoDePrecio({ dato, vista }: { dato: PanelVentas; vista: Vista }) {
  // D1 (21/11/2026): con la tienda oculta el resumen es UNA sola barra con los dos canales sumados, sin chip de canal.
  const sumados = vista === "resumen" && !tiendaVisible();
  const canales: CanalId[] = vista === "resumen" ? ["online", "tienda"] : [vista];
  const barras = sumados
    ? [
        {
          id: "total",
          nombre: "Total",
          promocion: dato.tipo_precio.online.promocion + dato.tipo_precio.tienda.promocion,
          estandar: dato.tipo_precio.online.estandar + dato.tipo_precio.tienda.estandar,
          canal: null as CanalId | null,
        },
      ]
    : canales.map((c) => ({ id: c, nombre: nombreDeCanal(c), ...dato.tipo_precio[c], canal: c as CanalId | null }));
  return (
    <section className="pn-card pn-card--panel pn-c5" aria-labelledby="an-precio-titulo">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Tipo de precio</p>
          <h2 className="pn-card__titulo" id="an-precio-titulo">
            Promoción o estándar
          </h2>
          <p className="pn-subtitulo" style={{ marginTop: 4 }}>
            Unidades vendidas según el precio con que salieron.
          </p>
        </div>
      </div>
      <div style={{ display: "grid", gap: 20 }}>
        {barras.map(({ id, nombre, promocion, estandar, canal }) => {
          return (
            <div key={id}>
              {barras.length > 1 && canal !== null && (
                <p style={{ margin: "0 0 8px" }}>
                  <span className={`pn-chip pn-chip--${canal}`}>{nombre}</span>
                </p>
              )}
              <BarraApilada100
                segmentos={[
                  { id: "promocion", etiqueta: "Promoción", valor: promocion, color: COLOR_PROMOCION },
                  { id: "estandar", etiqueta: "Estándar", valor: estandar, color: COLOR_ESTANDAR },
                ]}
                ariaLabel={`${nombre}: ${promocion} unidades con precio de promoción y ${estandar} con precio estándar.`}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TopRepuestos({ dato, vista }: { dato: PanelVentas; vista: Vista }) {
  const unidadesDe = (r: PanelVentas["top_repuestos"][number]) =>
    vista === "resumen" ? r.unidades : vista === "online" ? r.unidades_online : r.unidades_tienda;
  const filas = dato.top_repuestos
    .filter((r) => unidadesDe(r) > 0)
    .sort((a, b) => unidadesDe(b) - unidadesDe(a))
    .slice(0, MAX_REPUESTOS);
  const total = canalesDeVista(dato, vista).unidades;
  // `ingresos` del repuesto es del total de los dos canales: por canal no existe.
  const conIngresos = vista === "resumen";

  return (
    <section className="pn-card pn-card--panel pn-c7" aria-labelledby="an-top-titulo">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Unidades vendidas</p>
          <h2 className="pn-card__titulo" id="an-top-titulo">
            Repuestos más vendidos
          </h2>
        </div>
        <span className="pn-chip pn-chip--neutro">{formatoEntero(total)} unidades en total</span>
      </div>
      {filas.length === 0 ? (
        <p className="pn-vacio">Sin repuestos vendidos en este período.</p>
      ) : (
        <div className="pn-tabla-wrap">
          <table className="pn-tabla an-tabla">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Repuesto</th>
                <th scope="col" className="pn-der">
                  Unidades
                </th>
                {conIngresos && (
                  <th scope="col" className="pn-der">
                    Ingresos
                  </th>
                )}
                {conIngresos && tiendaVisible() && (
                  <th scope="col" className="an-oculta-m">
                    Online / tienda
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {filas.map((r, i) => (
                <tr key={r.codprod}>
                  <td>{i + 1}</td>
                  <td>
                    <span className="an-repuesto">
                      <b>{r.nombre}</b>
                      <small>{r.codprod}</small>
                    </span>
                  </td>
                  <td className="pn-der">{unidadesDe(r)}</td>
                  {conIngresos && <td className="pn-der">{formatoUsd(r.ingresos)}</td>}
                  {conIngresos && tiendaVisible() && (
                    <td className="an-oculta-m">
                      {r.unidades_online} / {r.unidades_tienda}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function UnidadesYPrecio({ ventas, vista }: { ventas: Bloque<PanelVentas>; vista: Vista }) {
  return (
    <div className="pn-c12">
      <PanelBloque bloque={ventas} nombre="Unidades y tipo de precio">
        {(dato) => (
          <div className="pn-bento">
            <TopRepuestos dato={dato} vista={vista} />
            <TipoDePrecio dato={dato} vista={vista} />
          </div>
        )}
      </PanelBloque>
    </div>
  );
}
