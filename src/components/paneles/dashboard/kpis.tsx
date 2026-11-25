"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Banknote, Clock, Minus, Package, ShoppingCart, Users } from "lucide-react";
import { formatBs } from "@/lib/cashea";
import {
  enviosDeTiendaOcultos,
  mostrarEquipoTienda,
  textoEquipoTiendaOculto,
  textoTiendaOculta,
  tiendaVisible,
  type Vista,
} from "@/lib/paneles/canal";
import { TEXTO_INICIO_PANELES, TEXTO_SIN_PREVIO } from "@/lib/paneles/periodos";
import type {
  EquipoActiva,
  MontoCantidad,
  OrigenActiva,
  PanelConversaciones,
  PanelVentas,
  PanelVentasActivas,
  VentanaActiva,
} from "@/lib/paneles/parse";
import { Anillo, Sparkline } from "@/components/paneles/panel-graficos";
import { formatoUsd } from "@/components/paneles/panel-marco";
import {
  canalDeVista,
  cantidadPorVencer,
  desgloseActivas,
  ETIQUETA_EQUIPO,
  ETIQUETA_ORIGEN,
  ETIQUETA_VENTANA,
  origenesConFila,
  origenesDeVista,
  serieDeVista,
  variacion,
  ventanaEscribible,
  type DesgloseActivas,
} from "@/components/paneles/dashboard/calculos";
import {
  ChipVariacion,
  Cifra,
  formatoEntero,
  formatoPorcentaje,
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

const TEXTO_POR_VENCER = "Llevan más de 24 h sin moverse: a las 48 h salen del conteo (no se borran).";

/** La clase de cada origen en la barra apilada y en su muestra de color. */
const CLASES_ORIGEN: Record<OrigenActiva, { barra: string; muestra: string }> = {
  presupuesto_inventario: { barra: "pd-apilada__a", muestra: "pd-sw-presupuesto" },
  carrito_chat: { barra: "pd-apilada__b", muestra: "pd-sw-carrito" },
  presupuesto_chat: { barra: "pd-apilada__c", muestra: "pd-sw-presupuesto-chat" },
};

/** Una fila de los bloques del desglose: etiqueta, cantidad y monto («—» si no se pudo calcular). */
function FilaDesglose({ etiqueta, celda, muestra }: { etiqueta: string; celda: MontoCantidad; muestra?: string }) {
  return (
    <li className="pd-desglose__fila">
      <span className="pd-desglose__etiqueta">
        {muestra && <i className={`pn-leyenda__sw ${muestra}`} aria-hidden="true" />}
        {etiqueta}
      </span>
      <b className="lm-num">{celda.cantidad}</b>
      <span className="lm-num pd-desglose__monto">{formatoUsd(celda.monto)}</span>
    </li>
  );
}

/**
 * Cuánto pesa cada origen en la barra: por monto si todos los que tienen algo
 * traen monto (y suman más que cero), si no por cantidad, como antes. Solo los
 * orígenes con peso > 0 pintan un tramo.
 */
function pesosDeOrigenes(porOrigen: Record<OrigenActiva, MontoCantidad>, orden: readonly OrigenActiva[]) {
  const conAlgo = orden.filter((o) => porOrigen[o].cantidad > 0);
  const montos = conAlgo.map((o) => porOrigen[o].monto);
  const porMonto = montos.every((m) => m !== null) && montos.reduce<number>((t, m) => t + (m ?? 0), 0) > 0;
  return orden
    .map((o) => ({ origen: o, cantidad: porOrigen[o].cantidad, peso: porMonto ? (porOrigen[o].monto ?? 0) : porOrigen[o].cantidad }))
    .filter((p) => p.peso > 0);
}

/** Las tres preguntas de la tarjeta con el desglose de la base: de dónde sale, quién lo armó y si se le puede escribir. */
function DesgloseDeActivas({
  d,
  porOrigen,
  porEquipo,
  porVentana,
  vista,
}: {
  d: DesgloseActivas;
  porOrigen: Record<OrigenActiva, MontoCantidad>;
  porEquipo: Record<EquipoActiva, MontoCantidad>;
  porVentana: Record<VentanaActiva, MontoCantidad>;
  vista: Vista;
}) {
  const tramos = pesosDeOrigenes(porOrigen, origenesDeVista(vista));
  const totalPeso = tramos.reduce((t, p) => t + p.peso, 0);
  const filas = origenesConFila(d, vista);
  const { tienda, sin_dato: sinDato } = porEquipo;
  const escribible = ventanaEscribible(porVentana);
  const porCerrar = porVentana.por_cerrar.cantidad;
  // D1: con la tienda oculta una caja que armó presupuestos no desaparece del desglose; un chip recuerda por qué.
  const cajaConTiendaOculta = !tiendaVisible() && tienda.cantidad > 0;

  return (
    <>
      <div
        className="pd-apilada"
        role="img"
        aria-label={`Reparto por origen: ${tramos.map((t) => `${ETIQUETA_ORIGEN[t.origen]} (${t.cantidad})`).join(", ")}`}
      >
        {tramos.map((t) => (
          <i key={t.origen} className={CLASES_ORIGEN[t.origen].barra} style={{ width: `${(t.peso * 100) / totalPeso}%` }} />
        ))}
      </div>

      <h3 className="pd-bloque__titulo">De dónde</h3>
      <ul className="pd-desglose">
        {filas.map((o) => (
          <FilaDesglose key={o} etiqueta={ETIQUETA_ORIGEN[o]} celda={porOrigen[o]} muestra={CLASES_ORIGEN[o].muestra} />
        ))}
      </ul>

      <h3 className="pd-bloque__titulo">Quién lo armó</h3>
      <ul className="pd-desglose">
        <FilaDesglose etiqueta={ETIQUETA_EQUIPO.online} celda={porEquipo.online} />
        {mostrarEquipoTienda(tienda.cantidad) && <FilaDesglose etiqueta={ETIQUETA_EQUIPO.tienda} celda={tienda} />}
        {sinDato.cantidad > 0 && <FilaDesglose etiqueta={ETIQUETA_EQUIPO.sin_dato} celda={sinDato} />}
      </ul>
      {cajaConTiendaOculta && (
        <div>
          <span className="pn-chip pn-chip--alerta">{textoEquipoTiendaOculto(tienda.cantidad)}</span>
        </div>
      )}

      <h3 className="pd-bloque__titulo">Se puede escribir</h3>
      <ul className="pd-desglose">
        <FilaDesglose etiqueta="Ventana abierta" celda={escribible} />
        <FilaDesglose etiqueta="Ventana cerrada (solo plantilla)" celda={porVentana.cerrada} />
        {porVentana.no_aplica.cantidad > 0 && <FilaDesglose etiqueta={ETIQUETA_VENTANA.no_aplica} celda={porVentana.no_aplica} />}
      </ul>
      {porCerrar > 0 && (
        <div>
          <span className="pn-chip pn-chip--alerta">
            {porCerrar === 1 ? "1 cierra en menos de 4 h" : `${porCerrar} cierran en menos de 4 h`}
          </span>
        </div>
      )}
    </>
  );
}

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
  const porVencer = cantidadPorVencer(datos, vista, ahora);

  // Sin desglose (base vieja) la barra reparte presupuestos contra carritos, por monto o, si no se puede, por cantidad.
  const porMonto = d.presupuestos.monto !== null && d.carritos.monto !== null && d.presupuestos.monto + d.carritos.monto > 0;
  const pesoPresupuestos = porMonto ? (d.presupuestos.monto ?? 0) : d.presupuestos.cantidad;
  const pesoCarritos = porMonto ? (d.carritos.monto ?? 0) : d.carritos.cantidad;
  const totalPeso = pesoPresupuestos + pesoCarritos;

  return (
    <TarjetaKpi nombre="Ventas activas" eyebrow="Ventas activas" icono={<ShoppingCart size={16} />} onAbrir={onAbrir}>
      <Cifra valor={d.monto} formato={formatoUsd} className="pn-kpi__cifra" />
      <p className="pn-kpi__sub">{d.cantidad} sin enviar</p>
      <div className="pn-kpi__viz">
        {d.porOrigen && d.porEquipo && d.porVentana ? (
          <DesgloseDeActivas d={d} porOrigen={d.porOrigen} porEquipo={d.porEquipo} porVentana={d.porVentana} vista={vista} />
        ) : (
          <>
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
          </>
        )}
      </div>
      {porVencer > 0 && (
        <div>
          <span className="pn-chip pn-chip--alerta" title={TEXTO_POR_VENCER} aria-describedby="pd-por-vencer">
            <Clock size={13} aria-hidden="true" />
            {porVencer} por vencer
          </span>
          <span id="pd-por-vencer" className="pn-sr">
            {TEXTO_POR_VENCER}
          </span>
        </div>
      )}
      <p className="pn-kpi__pie">
        {d.fuera === null
          ? "Ahora mismo · no depende del período"
          : `Ahora mismo · movidos en las últimas 48 h${
              d.fuera > 0
                ? ` · ${d.fuera} ${d.fuera === 1 ? "más viejo" : "más viejos"} fuera del conteo (no se borraron)`
                : ""
            }`}
      </p>
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
  avisarInicioDePaneles,
  sinPrevio = false,
  onAbrir,
}: {
  ventas: PanelVentas;
  /** `null` si el período previo no se pudo leer: la tarjeta sigue sin chip de variación. */
  previo: PanelVentas | null;
  etiquetaPrevio: string;
  vista: Vista;
  tasaBcv: number;
  /** El piso de datos recortó el período (`rangos.periodoRecortado`): la tarjeta lo avisa. */
  avisarInicioDePaneles: boolean;
  /** No existe un período anterior comparable (arrancaría antes del piso): chip neutro en vez de variación. */
  sinPrevio?: boolean;
  onAbrir: () => void;
}) {
  const canal = canalDeVista(ventas, vista);
  const delta = previo ? variacion(canal.ingresos, canalDeVista(previo, vista).ingresos) : null;
  const bs = canal.ingresos !== null && tasaBcv > 0 ? Math.round(canal.ingresos * tasaBcv * 100) / 100 : null;
  const { transito, error } = ventas.estado;
  const sobreTodos = vista === "resumen" ? "" : " · todos los canales";
  const serie = serieDeVista(ventas, vista, "ingresos");
  // D1 (21/11/2026): con la tienda oculta, el total del resumen ya suma sus envíos; se avisa cuántos son.
  const enviosTienda = vista === "resumen" ? enviosDeTiendaOcultos(ventas.canales.tienda.envios) : 0;

  return (
    <TarjetaKpi nombre="Enviado a SAINT" eyebrow="Enviado a SAINT" icono={<Banknote size={16} />} onAbrir={onAbrir}>
      <Cifra valor={canal.ingresos} formato={formatoUsd} className="pn-kpi__cifra" />
      <p className="pn-kpi__sub">en espera de facturar</p>
      <p className="pd-bs lm-num">{bs === null ? "Bs. —" : formatBs(bs)}</p>
      <div className="pd-chips">
        {sinPrevio ? <ChipSinPrevio /> : previo && <ChipVariacion variacion={delta} contra={etiquetaPrevio} />}
        {enviosTienda > 0 && <span className="pn-chip pn-chip--alerta">{textoTiendaOculta(enviosTienda)}</span>}
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
      {avisarInicioDePaneles && <p className="pn-kpi__pie">{TEXTO_INICIO_PANELES}.</p>}
    </TarjetaKpi>
  );
}

/** El chip neutro que ocupa el lugar de la variación cuando no hay período anterior comparable. */
function ChipSinPrevio() {
  return (
    <span className="pn-chip pn-chip--neutro">
      <Minus size={13} aria-hidden="true" />
      {TEXTO_SIN_PREVIO}
    </span>
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
  sinPrevio = false,
  onAbrir,
}: {
  ventas: PanelVentas;
  previo: PanelVentas | null;
  etiquetaPrevio: string;
  vista: Vista;
  /** No existe un período anterior comparable (arrancaría antes del piso): chip neutro en vez de variación. */
  sinPrevio?: boolean;
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
      <div className="pd-chips">
        {sinPrevio ? <ChipSinPrevio /> : previo && <ChipVariacion variacion={delta} contra={etiquetaPrevio} />}
      </div>
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
