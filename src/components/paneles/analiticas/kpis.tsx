"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { PanelConversaciones, PanelVentas } from "@/lib/paneles/parse";
import { PanelBloque } from "@/components/paneles/panel-marco";
import { Sparkline } from "@/components/paneles/panel-graficos";
import { canalesDeVista, tasaDeConversion, tasaDeRegreso, valoresPrevios } from "./datos";
import { formatoBs, formatoEntero, formatoUsd } from "./formato";
import { ChipPuntos, ChipVariacion, Cifra } from "./piezas";

/**
 * Los cinco KPI de Analíticas (plan "Paneles", C5, 13/11/2026): Enviado a
 * SAINT, Envíos, Ticket promedio, Tasa de conversión (solo chat) y Clientes
 * que regresan. Cada uno es una región con nombre; las variaciones solo
 * aparecen al comparar con el período anterior.
 */

function Kpi({
  nombre,
  cifra,
  sub,
  chips,
  viz,
  indice,
}: {
  nombre: string;
  cifra: ReactNode;
  sub?: ReactNode;
  chips?: ReactNode;
  viz?: ReactNode;
  indice: number;
}) {
  return (
    <section
      className="pn-card pn-kpi an-kpi an-sube"
      aria-label={nombre}
      style={{ ["--i" as string]: indice }}
    >
      <div className="pn-kpi__cab">
        <p className="pn-eyebrow" style={{ margin: 0 }}>
          {nombre}
        </p>
      </div>
      <p className="pn-kpi__cifra">{cifra}</p>
      {sub && <p className="pn-kpi__sub">{sub}</p>}
      {chips && <div className="an-kpi__chips">{chips}</div>}
      {viz && <div className="pn-kpi__viz">{viz}</div>}
    </section>
  );
}

const EXPLICACION_ESTIMADOS =
  "Estas ventas se reconstruyeron después de enviarse (antes del 13/11/2026 el CRM no guardaba la foto del envío): su canal y su monto salen del precio y la tasa del día, no de los del momento exacto del envío.";

export function KpisDeAnaliticas({
  ventas,
  previo,
  conversaciones,
  conversacionesPrevio,
  vista,
  comparar,
  tasaBcv,
}: {
  ventas: Bloque<PanelVentas>;
  previo: Bloque<PanelVentas>;
  conversaciones: BloqueConTope<PanelConversaciones>;
  conversacionesPrevio: BloqueConTope<PanelConversaciones>;
  vista: Vista;
  comparar: boolean;
  tasaBcv: number;
}) {
  const conversion = (
    <KpiConversion conversaciones={conversaciones} previo={conversacionesPrevio} vista={vista} comparar={comparar} />
  );
  // Sin ventas caen cuatro de los cinco: un solo aviso (no cuatro) y la conversión, que viene de otra lectura, sigue.
  if (!ventas.ok) {
    return (
      <>
        <PanelBloque bloque={ventas} nombre="Ventas del período">
          {() => null}
        </PanelBloque>
        {conversion}
      </>
    );
  }
  return (
    <PanelBloque bloque={ventas} nombre="Ventas del período">
      {(dato) => {
        const canal = canalesDeVista(dato, vista);
        const anterior = comparar && previo.ok ? canalesDeVista(previo.dato, vista) : null;
        const hayPrevio = comparar && previo.ok;
        const regreso = tasaDeRegreso(dato.recurrentes, vista);
        const regresoPrevio = hayPrevio ? tasaDeRegreso(previo.dato.recurrentes, vista).fraccion : null;
        const bs = formatoBs(canal.ingresos, tasaBcv);

        return (
          <>
            <Kpi
              indice={0}
              nombre="Enviado a SAINT"
              cifra={<Cifra valor={canal.ingresos} formato={formatoUsd} />}
              sub={
                <>
                  en espera de facturar{canal.ingresos !== null && bs !== "—" ? ` · ${bs}` : ""}
                </>
              }
              chips={
                <>
                  {canal.estimados > 0 && (
                    <span
                      className="pn-chip pn-chip--alerta"
                      title={`${canal.estimados} ${canal.estimados === 1 ? "envío está estimado" : "envíos están estimados"}: ${EXPLICACION_ESTIMADOS}`}
                    >
                      <Info size={13} aria-hidden="true" />
                      Estimado
                    </span>
                  )}
                  {hayPrevio && <ChipVariacion actual={canal.ingresos} previo={anterior?.ingresos ?? null} />}
                </>
              }
              viz={<Sparkline valores={valoresPrevios(dato, vista, "ingresos")} ariaLabel="Ingresos del período, por tramo" />}
            />
            <Kpi
              indice={1}
              nombre="Envíos"
              cifra={<Cifra valor={canal.envios} formato={formatoEntero} />}
              sub={`${formatoEntero(canal.unidades)} unidades`}
              chips={hayPrevio && <ChipVariacion actual={canal.envios} previo={anterior?.envios ?? null} />}
              viz={<Sparkline valores={valoresPrevios(dato, vista, "envios")} ariaLabel="Envíos del período, por tramo" />}
            />
            <Kpi
              indice={2}
              nombre="Ticket promedio"
              cifra={<Cifra valor={canal.ticket} formato={formatoUsd} />}
              sub="por envío con monto"
              chips={hayPrevio && <ChipVariacion actual={canal.ticket} previo={anterior?.ticket ?? null} />}
            />
            {conversion}
            <Kpi
              indice={4}
              nombre="Clientes que regresan"
              cifra={<Cifra valor={regreso.fraccion === null ? null : regreso.fraccion * 100} formato={(n) => `${Math.round(n)} %`} />}
              sub={
                regreso.compradores > 0
                  ? `${formatoEntero(regreso.regresan)} de ${formatoEntero(regreso.compradores)} ya eran clientes`
                  : "Sin compradores en el período"
              }
              chips={hayPrevio && <ChipPuntos actual={regreso.fraccion} previo={regresoPrevio} />}
            />
          </>
        );
      }}
    </PanelBloque>
  );
}

function KpiConversion({
  conversaciones,
  previo,
  vista,
  comparar,
}: {
  conversaciones: BloqueConTope<PanelConversaciones>;
  previo: BloqueConTope<PanelConversaciones>;
  vista: Vista;
  comparar: boolean;
}) {
  // La caja no registra a quien no compra: en tienda no hay conversión que calcular.
  if (vista === "tienda") {
    return (
      <Kpi indice={3} nombre="Tasa de conversión" cifra="—" sub="Solo se mide en el chat" />
    );
  }
  return (
    <PanelBloque bloque={conversaciones} nombre="Conversaciones">
      {(dato) => {
        const tasa = tasaDeConversion(dato.conversion.equipo);
        const anterior = comparar && previo.ok ? tasaDeConversion(previo.dato.conversion.equipo).fraccion : null;
        return (
          <Kpi
            indice={3}
            nombre="Tasa de conversión"
            cifra={<Cifra valor={tasa.fraccion === null ? null : tasa.fraccion * 100} formato={(n) => `${Math.round(n)} %`} />}
            sub={
              tasa.atendidas > 0
                ? `${formatoEntero(tasa.compraron)} de ${formatoEntero(tasa.atendidas)} conversaciones compraron`
                : "Sin conversaciones atendidas"
            }
            chips={
              <>
                {conversaciones.recortado && <span className="pn-chip pn-chip--neutro">Últimos 92 días</span>}
                {comparar && previo.ok && <ChipPuntos actual={tasa.fraccion} previo={anterior} />}
              </>
            }
          />
        );
      }}
    </PanelBloque>
  );
}
