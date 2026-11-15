"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Banknote, Clock, Package, ShoppingCart, Users } from "lucide-react";
import { formatBs } from "@/lib/cashea";
import type { Vista } from "@/lib/paneles/canal";
import type { PanelConversaciones, PanelVentas, PanelVentasActivas } from "@/lib/paneles/parse";
import { Anillo, Sparkline } from "@/components/paneles/panel-graficos";
import { formatoUsd } from "@/components/paneles/panel-marco";
import {
  canalDeVista,
  cantidadItemsViejos,
  desgloseActivas,
  serieDeVista,
  variacion,
} from "@/components/paneles/dashboard/calculos";
import {
  ChipVariacion,
  Cifra,
  formatoEntero,
  formatoPorcentaje,
  plural,
} from "@/components/paneles/dashboard/cifra";

/**
 * Las cuatro tarjetas pequeñas de la primera fila del Dashboard (plan
 * "Paneles", C4, 13/11/2026): ventas activas, enviado a SAINT, unidades y
 * conversión. Cada una es un `<section>` con nombre; el botón del encabezado
 * es el camino por teclado a su hoja de detalle, y un clic en cualquier parte
 * de la tarjeta la abre también (comodidad del ratón, no el único camino).
 */

function TarjetaKpi({
  nombre,
  eyebrow,
  icono,
  onAbrir,
  children,
}: {
  nombre: string;
  eyebrow: string;
  icono: ReactNode;
  /** Sin él la tarjeta no abre nada (la conversión de "En tienda" no tiene detalle). */
  onAbrir?: () => void;
  children: ReactNode;
}) {
  return (
    // El clic de la tarjeta es solo comodidad del ratón: el teclado entra por el botón del encabezado.
    <section
      aria-label={nombre}
      className={onAbrir ? "pn-card pn-card--click pd-kpi" : "pn-card pd-kpi"}
      onClick={onAbrir}
    >
      <header className="pn-kpi__cab">
        {onAbrir ? (
          <button type="button" className="pd-abrir" aria-label={`${nombre}: abrir detalle`}>
            <span className="pn-eyebrow pd-eyebrow">{eyebrow}</span>
          </button>
        ) : (
          <span className="pn-eyebrow pd-eyebrow">{eyebrow}</span>
        )}
        <span className="pn-kpi__ico" aria-hidden="true">
          {icono}
        </span>
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ventas activas
// ---------------------------------------------------------------------------

export function KpiVentasActivas({
  datos,
  vista,
  ahora,
  onAbrir,
}: {
  datos: PanelVentasActivas;
  vista: Vista;
  ahora: Date;
  onAbrir: () => void;
}) {
  const d = desgloseActivas(datos, vista);
  const viejos = cantidadItemsViejos(datos, vista, ahora);

  // La barra reparte por monto; si algún monto no se puede calcular, por cantidad.
  const porMonto = d.presupuestos.monto !== null && d.carritos.monto !== null && d.presupuestos.monto + d.carritos.monto > 0;
  const pesoPresupuestos = porMonto ? (d.presupuestos.monto ?? 0) : d.presupuestos.cantidad;
  const pesoCarritos = porMonto ? (d.carritos.monto ?? 0) : d.carritos.cantidad;
  const totalPeso = pesoPresupuestos + pesoCarritos;

  return (
    <TarjetaKpi nombre="Ventas activas" eyebrow="Ventas activas" icono={<ShoppingCart size={16} />} onAbrir={onAbrir}>
      <Cifra valor={d.monto} formato={formatoUsd} className="pn-kpi__cifra" />
      <p className="pn-kpi__sub">
        {d.cantidad} {plural(d.cantidad, "presupuesto o carrito sin enviar", "presupuestos y carritos sin enviar")}
      </p>
      <div className="pn-kpi__viz">
        <div
          className="pd-apilada"
          role="img"
          aria-label={`Reparto entre presupuestos (${d.presupuestos.cantidad}) y carritos (${d.carritos.cantidad})`}
        >
          {totalPeso > 0 && (
            <>
              <i className="pd-apilada__a" style={{ width: `${(pesoPresupuestos * 100) / totalPeso}%` }} />
              <i className="pd-apilada__b" style={{ width: `${(pesoCarritos * 100) / totalPeso}%` }} />
            </>
          )}
        </div>
        <ul className="pn-leyenda pd-leyenda">
          <li className="pn-leyenda__item">
            <span className="pn-leyenda__sw pd-sw-presupuesto" aria-hidden="true" />
            <span>Presupuestos</span>
            <b className="lm-num">{d.presupuestos.cantidad}</b>
          </li>
          <li className="pn-leyenda__item">
            <span className="pn-leyenda__sw pd-sw-carrito" aria-hidden="true" />
            <span>Carritos</span>
            <b className="lm-num">{d.carritos.cantidad}</b>
          </li>
        </ul>
      </div>
      {viejos > 0 && (
        <div>
          <span className="pn-chip pn-chip--alerta">
            <Clock size={13} aria-hidden="true" />
            Hay {viejos} de más de 7 días
          </span>
        </div>
      )}
      <p className="pn-kpi__pie">Ahora mismo · no depende del período</p>
    </TarjetaKpi>
  );
}

// ---------------------------------------------------------------------------
// Enviado a SAINT
// ---------------------------------------------------------------------------

export function KpiEnviado({
  ventas,
  previo,
  etiquetaPrevio,
  vista,
  tasaBcv,
  avisarInicioDeEnvios,
  onAbrir,
}: {
  ventas: PanelVentas;
  /** `null` si el período previo no se pudo leer: la tarjeta sigue sin chip de variación. */
  previo: PanelVentas | null;
  etiquetaPrevio: string;
  vista: Vista;
  tasaBcv: number;
  avisarInicioDeEnvios: boolean;
  onAbrir: () => void;
}) {
  const canal = canalDeVista(ventas, vista);
  const delta = previo ? variacion(canal.ingresos, canalDeVista(previo, vista).ingresos) : null;
  const bs = canal.ingresos !== null && tasaBcv > 0 ? Math.round(canal.ingresos * tasaBcv * 100) / 100 : null;
  const { transito, error } = ventas.estado;
  const sobreTodos = vista === "resumen" ? "" : " · todos los canales";
  const serie = serieDeVista(ventas, vista, "ingresos");

  return (
    <TarjetaKpi nombre="Enviado a SAINT" eyebrow="Enviado a SAINT" icono={<Banknote size={16} />} onAbrir={onAbrir}>
      <Cifra valor={canal.ingresos} formato={formatoUsd} className="pn-kpi__cifra" />
      <p className="pn-kpi__sub">en espera de facturar</p>
      <p className="pd-bs lm-num">{bs === null ? "Bs. —" : formatBs(bs)}</p>
      <div className="pd-chips">
        {previo && <ChipVariacion variacion={delta} contra={etiquetaPrevio} />}
        {canal.estimados > 0 && (
          <>
            <span className="pn-chip pn-chip--alerta" title={TEXTO_ESTIMADO} aria-describedby="pd-estimado">
              Estimado
            </span>
            <span id="pd-estimado" className="pn-sr">
              {TEXTO_ESTIMADO}
            </span>
          </>
        )}
      </div>
      <div className="pn-kpi__viz">
        <Sparkline
          valores={serie}
          color="var(--pn-online)"
          ariaLabel={`Enviado a SAINT por tramo del período: ${serie.length} puntos, de ${formatoUsd(Math.min(...serie, 0))} a ${formatoUsd(Math.max(...serie, 0))}`}
        />
      </div>
      <p className="pd-transito">
        {transito.envios === 0 ? (
          <>Sin envíos en tránsito{sobreTodos}</>
        ) : (
          <>
            En tránsito: <b className="lm-num">{formatoUsd(transito.monto)}</b> ({transito.envios}){sobreTodos}
          </>
        )}
      </p>
      {error.envios > 0 && (
        <div>
          <span className="pn-chip pn-chip--critico">
            <AlertTriangle size={13} aria-hidden="true" />
            {error.envios} con error{sobreTodos}
          </span>
        </div>
      )}
      {avisarInicioDeEnvios && (
        <p className="pn-kpi__pie">Los envíos a SAINT se registran desde el 26 de octubre de 2026.</p>
      )}
    </TarjetaKpi>
  );
}

const TEXTO_ESTIMADO =
  "Hay ventas de este período cuyo monto es una estimación: la foto del envío no pudo calcularse con exactitud, así que la cifra puede variar un poco.";

// ---------------------------------------------------------------------------
// Unidades vendidas
// ---------------------------------------------------------------------------

export function KpiUnidades({
  ventas,
  previo,
  etiquetaPrevio,
  vista,
  onAbrir,
}: {
  ventas: PanelVentas;
  previo: PanelVentas | null;
  etiquetaPrevio: string;
  vista: Vista;
  onAbrir: () => void;
}) {
  const canal = canalDeVista(ventas, vista);
  const delta = previo ? variacion(canal.unidades, canalDeVista(previo, vista).unidades) : null;
  const envios = serieDeVista(ventas, vista, "envios");
  const maximo = Math.max(...envios, 1);

  const masVendido = ventas.top_repuestos
    .map((r) => ({
      nombre: r.nombre,
      unidades: vista === "resumen" ? r.unidades : vista === "online" ? r.unidades_online : r.unidades_tienda,
    }))
    .filter((r) => r.unidades > 0)
    .sort((a, b) => b.unidades - a.unidades)[0];

  return (
    <TarjetaKpi nombre="Unidades vendidas" eyebrow="Unidades vendidas" icono={<Package size={16} />} onAbrir={onAbrir}>
      <Cifra valor={canal.unidades} formato={formatoEntero} className="pn-kpi__cifra" />
      <div className="pd-chips">{previo && <ChipVariacion variacion={delta} contra={etiquetaPrevio} />}</div>
      <div className="pn-kpi__viz">
        {/* El contrato no trae unidades por tramo: las barras son los ENVÍOS de cada tramo. */}
        <div
          className="pd-minibarras"
          role="img"
          aria-label={`Envíos por tramo del período: ${envios.length} tramos, ${envios.reduce((s, n) => s + n, 0)} envíos en total`}
        >
          {envios.map((n, i) => (
            <i key={i} className="pd-minibarras__b" style={{ height: `${Math.max((n / maximo) * 100, n > 0 ? 6 : 2)}%` }} />
          ))}
        </div>
      </div>
      <p className="pn-kpi__sub">
        {masVendido ? (
          <>
            Más vendido: <b>{masVendido.nombre}</b> ({masVendido.unidades})
          </>
        ) : (
          "Sin ventas en el período"
        )}
      </p>
    </TarjetaKpi>
  );
}

// ---------------------------------------------------------------------------
// Tasa de conversión
// ---------------------------------------------------------------------------

export function KpiConversion({
  conversaciones,
  recortado,
  enTienda,
  onAbrir,
}: {
  /** `null` en "En tienda": la caja no registra a quien no compra. */
  conversaciones: PanelConversaciones | null;
  recortado: boolean;
  enTienda: boolean;
  /** Sin detalle en "En tienda": ahí no hay conversión que abrir. */
  onAbrir?: () => void;
}) {
  if (enTienda || conversaciones === null) {
    return (
      <TarjetaKpi nombre="Tasa de conversión" eyebrow="Tasa de conversión" icono={<Users size={16} />}>
        <span className="pn-kpi__cifra">—</span>
        <p className="pn-kpi__sub">
          La caja no registra a quien no compra, así que la conversión solo se mide en el chat. Mira «Envíos por
          persona» para ver qué hizo cada quien en la tienda.
        </p>
      </TarjetaKpi>
    );
  }

  const { atendidas, compraron } = conversaciones.conversion.equipo;
  const tasa = atendidas > 0 ? Math.round((compraron / atendidas) * 1000) / 10 : null;

  return (
    <TarjetaKpi nombre="Tasa de conversión" eyebrow="Tasa de conversión" icono={<Users size={16} />} onAbrir={onAbrir}>
      <div className="pd-conv">
        <div className="pd-conv__txt">
          <Cifra valor={tasa} formato={formatoPorcentaje} className="pn-kpi__cifra" />
          <p className="pn-kpi__sub">
            {atendidas > 0 ? `${compraron} de ${atendidas} conversaciones compraron` : "Sin conversaciones atendidas"}
          </p>
        </div>
        <Anillo
          porcentaje={tasa}
          color="var(--pn-online)"
          tam={84}
          ariaLabel={tasa === null ? "Conversión no disponible" : `Conversión del equipo: ${formatoPorcentaje(tasa)}`}
        />
      </div>
      <p className="pn-kpi__pie">
        Mide solo el chat: de las conversaciones que recibieron respuesta, cuántas compraron
        {recortado ? " (últimos 92 días)" : ""}.
      </p>
    </TarjetaKpi>
  );
}
