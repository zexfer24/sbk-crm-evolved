"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { AppRail } from "@/components/app-rail";
import { SlidingPills } from "@/components/sliding-pills";
import { PERIODOS, type PeriodoId } from "@/lib/paneles/periodos";
import { VISTAS, type Vista } from "@/lib/paneles/canal";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import type { Bloque } from "@/lib/paneles-data";
// `.dash`, `.dash-frame`, `.dash-main`, `.dash-content`, `.dash-title`: el marco
// de siempre del CRM. `paneles.css` pone encima lo propio de los paneles.
import "@/components/dashboard/dashboard.css";
import "@/components/paneles/paneles.css";

/**
 * Marco común de los tres paneles (plan "Paneles", 13/11/2026):
 * `.dash > .dash-frame > AppRail + main`. El grid de `.dash-frame` tiene DOS
 * columnas, así que el rail y el `main` son sus ÚNICOS hijos directos (trampa
 * del FRAGMENTO de CLAUDE.md, 9/9/2026: un tercer hijo le roba la columna al
 * contenido y desarma la pantalla; jsdom no lo ve, por eso `panel-marco.test`
 * cuenta los hijos).
 *
 * Los controles de período y de vista NO guardan estado propio: cambian los
 * `searchParams` con `router.replace(..., { scroll: false })` y el servidor
 * vuelve a leer — la URL es la fuente de verdad y se puede compartir.
 */

export type PanelId = "dashboard" | "analiticas" | "asesores";

/** Dólares con separador de miles; `null` es "no se puede calcular" y se pinta «—», nunca $0. */
export function formatoUsd(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) return "—";
  return `$${valor.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PESTANAS: { id: PanelId; etiqueta: string; ruta: string; conVista: boolean }[] = [
  { id: "dashboard", etiqueta: "Dashboard", ruta: "/panel", conVista: true },
  { id: "analiticas", etiqueta: "Analíticas", ruta: "/panel/analiticas", conVista: true },
  // Asesores es por persona, no por canal: no arrastra la vista.
  { id: "asesores", etiqueta: "Asesores", ruta: "/panel/asesores", conVista: false },
];

/** «viernes, 13 de noviembre»: hoy en hora de Caracas, sea cual sea la zona del navegador. */
export function fechaLargaDeHoy(ahora: Date): string {
  return new Intl.DateTimeFormat("es-VE", {
    timeZone: CRM_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(ahora);
}

export function PanelMarco({
  panel,
  titulo,
  ahora,
  periodo,
  vista,
  controles,
  children,
}: {
  panel: PanelId;
  titulo: string;
  /** El instante de la lectura (lo fija el servidor: cliente y servidor pintan la misma fecha). */
  ahora: Date;
  /** Las pestañas lo arrastran para que cambiar de panel no pierda el período elegido. */
  periodo: PeriodoId;
  vista?: Vista;
  /** Slot de controles (período, vista…) a la derecha de la cabecera. */
  controles?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="paneles" verPaneles />

        <main className="dash-main">
          <div className="dash-content pn-contenido">
            <header className="pn-cab">
              <div className="pn-cab__titulos">
                <p className="pn-eyebrow">{fechaLargaDeHoy(ahora)}</p>
                <h1 className="dash-title dash-display">{titulo}</h1>
              </div>
              {controles && <div className="pn-cab__controles">{controles}</div>}
            </header>

            <nav className="pn-pestanas" aria-label="Paneles">
              {PESTANAS.map((p) => {
                const consulta = new URLSearchParams({ periodo });
                if (p.conVista && vista) consulta.set("vista", vista);
                return (
                  <Link
                    key={p.id}
                    className="pn-pestana"
                    href={`${p.ruta}?${consulta.toString()}`}
                    {...(p.id === panel ? { "aria-current": "page" as const } : {})}
                  >
                    {p.etiqueta}
                  </Link>
                );
              })}
            </nav>

            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controles que cambian la URL
// ---------------------------------------------------------------------------

function useCambiarParametro() {
  const router = useRouter();
  const pathname = usePathname();
  const actuales = useSearchParams();
  return (clave: string, valor: string) => {
    const params = new URLSearchParams(actuales?.toString() ?? "");
    params.set(clave, valor);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
}

export function ControlPeriodo({ periodo }: { periodo: PeriodoId }) {
  const cambiar = useCambiarParametro();
  return (
    <div className="pn-scroll">
      <SlidingPills
        ariaLabel="Período"
        tone="segmented"
        value={periodo}
        onChange={(v) => cambiar("periodo", v)}
        items={PERIODOS.map((p) => ({ value: p.id, label: p.etiqueta }))}
      />
    </div>
  );
}

export function ControlVista({ vista }: { vista: Vista }) {
  const cambiar = useCambiarParametro();
  return (
    <div className="pn-scroll">
      <SlidingPills
        ariaLabel="Canal"
        tone="segmented"
        value={vista}
        onChange={(v) => cambiar("vista", v)}
        items={VISTAS.map((v) => ({ value: v.id, label: v.etiqueta }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloque con degradación
// ---------------------------------------------------------------------------

/**
 * Pinta el dato de un `Bloque`, o "No disponible: <motivo>" con Reintentar si la
 * lectura falló (`paneles-data.ts`). Un bloque caído no tumba a los demás.
 * Reintentar hace `router.refresh()`: el servidor vuelve a leer TODA la página.
 */
export function PanelBloque<T>({
  bloque,
  nombre,
  children,
}: {
  bloque: Bloque<T>;
  /** Qué es el bloque, para el lector de pantalla («Ventas»). */
  nombre: string;
  children: (dato: T) => ReactNode;
}) {
  const router = useRouter();
  if (bloque.ok) return <>{children(bloque.dato)}</>;
  return (
    <div className="pn-degradado" role="alert" aria-label={nombre}>
      <AlertTriangle size={18} aria-hidden="true" />
      <p className="pn-degradado__txt">
        <b>No disponible:</b> {bloque.detalle}
      </p>
      <button type="button" className="pn-boton" onClick={() => router.refresh()}>
        <RefreshCw size={13} aria-hidden="true" />
        Reintentar
      </button>
    </div>
  );
}
