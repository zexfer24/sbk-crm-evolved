"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import type { Bloque } from "@/lib/paneles-data";
import { tiendaVisible, type Vista } from "@/lib/paneles/canal";
import type { PanelVentasActivas } from "@/lib/paneles/parse";
import { PanelBloque } from "@/components/paneles/panel-marco";
import { SlidingPills } from "@/components/sliding-pills";
import { filtrarActivas, formatoEdad, horasDesde, nombreDeCanal, type FiltroActivas } from "./datos";
import { formatoEntero, formatoUsd } from "./formato";

/**
 * «Ventas activas» (plan "Paneles", C5, 13/11/2026): lo que todavía no se envió
 * a SAINT —presupuestos y carritos del chat— valuado al precio de hoy. Es una
 * foto de AHORA: no depende del período. La tabla trae los 30 más viejos (el
 * límite es de la RPC) y se filtra en el cliente por tipo, canal y antigüedad.
 *
 * El canal arranca en el de la vista y, si cambia la vista, el filtro vuelve a
 * seguirla (el componente se remonta con `key={vista}`).
 *
 * `antiguedad` de la RPC (tramos 24 h / 3 d / 7 d / 30 d) NO se pinta: el
 * contrato no dice si el tramo es acumulado o excluyente, y mostrar un número
 * dudoso en la pantalla que decide qué cobrar es peor que no mostrarlo. La
 * antigüedad se filtra con la fecha de cada ítem.
 */

const FILAS_INICIALES = 8;

const TIPOS: { value: FiltroActivas["tipo"]; label: string }[] = [
  { value: "todos", label: "Todas" },
  { value: "presupuesto", label: "Presupuestos" },
  { value: "carrito", label: "Carritos" },
];
const TODOS_LOS_CANALES: { value: Vista; label: string }[] = [
  { value: "resumen", label: "Todos" },
  { value: "online", label: "Online" },
  { value: "tienda", label: "En tienda" },
];
const ANTIGUEDADES: { value: FiltroActivas["antiguedad"]; label: string }[] = [
  { value: "todas", label: "Cualquiera" },
  { value: "24h", label: "+24 h" },
  { value: "3d", label: "+3 d" },
  { value: "7d", label: "+7 d" },
];

function Tabla({ dato, vistaInicial, ahora }: { dato: PanelVentasActivas; vistaInicial: Vista; ahora: Date }) {
  const [tipo, setTipo] = useState<FiltroActivas["tipo"]>("todos");
  const [canal, setCanal] = useState<Vista>(vistaInicial);
  const [antiguedad, setAntiguedad] = useState<FiltroActivas["antiguedad"]>("todas");
  const [verTodas, setVerTodas] = useState(false);
  // D1 (21/11/2026): sin el canal «tienda» no hay pastilla «En tienda», ni columna ni chip de canal por ítem.
  const conTienda = tiendaVisible();
  const CANALES = conTienda ? TODOS_LOS_CANALES : TODOS_LOS_CANALES.filter((c) => c.value !== "tienda");

  const filas = filtrarActivas(dato.items, { tipo, canal, antiguedad }, ahora);
  const visibles = verTodas ? filas : filas.slice(0, FILAS_INICIALES);

  const enCanal = canal === "resumen" ? dato.total : dato.por_canal[canal].monto;
  const cantidadCanal =
    canal === "resumen" ? dato.por_canal.online.cantidad + dato.por_canal.tienda.cantidad : dato.por_canal[canal].cantidad;
  const hayRecorte = cantidadCanal > dato.items.filter((i) => canal === "resumen" || i.canal === canal).length;

  return (
    <section className="pn-card pn-card--panel" aria-labelledby="an-activas-titulo">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Ahora mismo · no depende del período</p>
          <h2 className="pn-card__titulo" id="an-activas-titulo">
            Ventas activas
          </h2>
          <p className="pn-subtitulo" style={{ marginTop: 4 }}>
            {formatoUsd(enCanal)} en {formatoEntero(cantidadCanal)} presupuestos y carritos sin enviar, al precio de hoy.
          </p>
        </div>
      </div>

      <div className="an-filtros">
        <div className="pn-scroll">
          <SlidingPills ariaLabel="Tipo de venta activa" tone="segmented" value={tipo} onChange={setTipo} items={TIPOS} />
        </div>
        <div className="pn-scroll">
          <SlidingPills ariaLabel="Canal de la venta activa" tone="segmented" value={canal} onChange={setCanal} items={CANALES} />
        </div>
        <div className="pn-scroll">
          <SlidingPills
            ariaLabel="Antigüedad de la venta activa"
            tone="segmented"
            value={antiguedad}
            onChange={setAntiguedad}
            items={ANTIGUEDADES}
          />
        </div>
      </div>

      {filas.length === 0 ? (
        <p className="pn-vacio">No hay ventas activas con esos filtros.</p>
      ) : (
        <div className="pn-tabla-wrap">
          <table className="pn-tabla an-tabla">
            <thead>
              <tr>
                <th scope="col">Cliente</th>
                <th scope="col" className="an-oculta-m">
                  Tipo
                </th>
                {conTienda && (
                  <th scope="col" className="an-oculta-m">
                    Canal
                  </th>
                )}
                <th scope="col" className="an-oculta-m">
                  Quién
                </th>
                <th scope="col">Antigüedad</th>
                <th scope="col" className="pn-der">
                  Monto
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((item) => {
                const horas = horasDesde(item.desde, ahora);
                const nivel = horas > 168 ? "critico" : horas > 24 ? "alerta" : "neutro";
                return (
                  <tr key={`${item.tipo}-${item.id}`}>
                    <td className="pn-corto">{item.cliente ?? "—"}</td>
                    <td className="an-oculta-m">{item.tipo === "presupuesto" ? "Presupuesto" : "Carrito"}</td>
                    {conTienda && (
                      <td className="an-oculta-m">
                        <span className={`pn-chip pn-chip--${item.canal}`}>{nombreDeCanal(item.canal)}</span>
                      </td>
                    )}
                    <td className="pn-corto an-oculta-m">{item.responsable ?? "—"}</td>
                    <td>
                      <span className={`pn-chip pn-chip--${nivel} an-edad`}>
                        <Clock size={12} aria-hidden="true" />
                        {formatoEdad(horas)}
                      </span>
                    </td>
                    <td className="pn-der">{formatoUsd(item.monto)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="an-pie">
        <span>
          {hayRecorte
            ? `Se muestran las ${formatoEntero(dato.items.length)} más viejas de ${formatoEntero(cantidadCanal)}.`
            : `${formatoEntero(filas.length)} ${filas.length === 1 ? "venta activa" : "ventas activas"} con estos filtros.`}
        </span>
        {filas.length > FILAS_INICIALES && (
          <button type="button" className="pn-boton" onClick={() => setVerTodas((v) => !v)} aria-expanded={verTodas}>
            {verTodas ? "Ver menos" : `Ver todas (${formatoEntero(filas.length)})`}
          </button>
        )}
      </div>
    </section>
  );
}

export function VentasActivasAnaliticas({
  ventasActivas,
  vista,
  ahora,
}: {
  ventasActivas: Bloque<PanelVentasActivas>;
  vista: Vista;
  ahora: Date;
}) {
  return (
    <div className="pn-c12">
      <PanelBloque bloque={ventasActivas} nombre="Ventas activas">
        {(dato) => <Tabla key={vista} dato={dato} vistaInicial={vista} ahora={ahora} />}
      </PanelBloque>
    </div>
  );
}
