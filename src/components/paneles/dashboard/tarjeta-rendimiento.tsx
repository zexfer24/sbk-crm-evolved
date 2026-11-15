"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@heroui/react";
import { Check, Flame, Pencil, X } from "lucide-react";
import { configErrorMessage } from "@/lib/config-write";
import { guardarMetaVenta } from "@/lib/mutations";
import { createClient } from "@/lib/supabase/client";
import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque } from "@/lib/paneles-data";
import { VISTAS, type Vista } from "@/lib/paneles/canal";
import type { CanalId, MetaVenta, PanelVentas } from "@/lib/paneles/parse";
import { curvaHoraria, faltante, metaDelDia, porcentaje, proyeccion, racha } from "@/lib/paneles/rendimiento";
import { crmDayKey } from "@/lib/sales-day";
import { crmMinuteOfDay } from "@/lib/time-zone";
import { Anillo } from "@/components/paneles/panel-graficos";
import { formatoUsd } from "@/components/paneles/panel-marco";
import {
  HORARIO_SIEMPRE_ABIERTO,
  acumuladoPorHora,
  canalDeVista,
  horaEnteraDeCaracas,
  metaAcumuladaPorHora,
  serieDeVista,
  ventanaDeHoy,
} from "@/components/paneles/dashboard/calculos";
import { Cifra, plural } from "@/components/paneles/dashboard/cifra";
import { GraficoRitmo } from "@/components/paneles/dashboard/grafico-ritmo";

/**
 * La tarjeta héroe oscura del Dashboard (plan "Paneles", C4, 13/11/2026):
 * rendimiento del día contra su meta. Es la ÚNICA tarjeta oscura de la página.
 *
 * Decisiones:
 * - "Logrado" es lo ENVIADO a SAINT hoy (lo mismo que la tarjeta de ingresos).
 * - La meta de un día se lee con `metaDelDia` (cierra los días sin atención).
 *   Editarla escribe una fila `vigente_desde = hoy` (`guardarMetaVenta`): rige
 *   desde hoy y hasta que alguien la cambie, no solo hoy.
 * - En el Resumen la meta es la SUMA de las dos y no se puede escribir una
 *   suma: el lápiz abre dos campos (online y tienda) y solo guarda el que
 *   cambió.
 * - Con la tienda cerrada hoy no se edita (la meta de hoy no existe): se
 *   edita el próximo día hábil.
 */

const DIA_FALLO = "La meta tiene que ser un monto en dólares mayor que cero.";

function porHoraDe(dia: { online: number[]; tienda: number[] }, vista: Vista): number[] {
  if (vista === "online") return dia.online;
  if (vista === "tienda") return dia.tienda;
  return dia.online.map((v, h) => v + dia.tienda[h]);
}

function montoDelCampo(texto: string): number {
  return Number(texto.trim().replace(",", "."));
}

export function TarjetaRendimiento({
  hoy,
  historia,
  metas,
  horario,
  vista,
  ahora,
  hoyClave,
}: {
  hoy: PanelVentas;
  historia: Bloque<PanelVentas>;
  metas: Bloque<MetaVenta[]>;
  horario: BusinessHours;
  vista: Vista;
  ahora: Date;
  hoyClave: string;
}) {
  const router = useRouter();
  const idCampo = useId();
  const [editando, setEditando] = useState(false);
  const [campos, setCampos] = useState<Record<CanalId, string>>({ online: "", tienda: "" });
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const ventana = ventanaDeHoy(horario, ahora);
  const abre = ventana !== null;
  const lista = metas.ok ? metas.dato : null;
  const logrado = canalDeVista(hoy, vista).ingresos;
  const meta = lista ? metaDelDia(lista, vista, hoyClave, horario) : null;
  const pct = porcentaje(logrado, meta);
  const falta = faltante(logrado, meta);
  const cumplida = meta !== null && logrado !== null && logrado >= meta;

  const horaActual = crmMinuteOfDay(ahora) / 60;
  const curva = historia.ok
    ? curvaHoraria(historia.dato.perfil_horario.map((d) => ({ dia: d.dia, porHora: porHoraDe(d, vista) })))
    : null;
  const proyectado = logrado !== null ? proyeccion(logrado, horaActual, curva) : null;

  // Cada día de la historia con lo logrado y su meta (null si ese día no tenía).
  const diasHistoria =
    historia.ok && lista
      ? (() => {
          const logrados = serieDeVista(historia.dato, vista, "ingresos");
          return historia.dato.serie.map((p, i) => {
            const dia = crmDayKey(p.t);
            return { dia, logrado: logrados[i], meta: metaDelDia(lista, vista, dia, horario) };
          });
        })()
      : null;
  const seguidos = diasHistoria ? racha(diasHistoria) : null;
  // Los últimos 7 días con meta, del más viejo al más reciente: ● cumplido, ○ no.
  const ultimosDias = (diasHistoria ?? [])
    .filter((d) => d.meta !== null)
    .sort((x, y) => x.dia.localeCompare(y.dia))
    .slice(-7);

  const etiquetaVista = VISTAS.find((v) => v.id === vista)?.etiqueta ?? "";
  const canalesEditables: CanalId[] = vista === "resumen" ? ["online", "tienda"] : [vista];

  function metaActual(canal: CanalId): number | null {
    return lista ? metaDelDia(lista, canal, hoyClave, HORARIO_SIEMPRE_ABIERTO) : null;
  }

  function abrirEdicion() {
    setCampos({
      online: metaActual("online")?.toString() ?? "",
      tienda: metaActual("tienda")?.toString() ?? "",
    });
    setError(null);
    setEditando(true);
  }

  async function guardar(evento: FormEvent) {
    evento.preventDefault();
    const unSoloCanal = canalesEditables.length === 1;

    // Qué canales se escriben: el único de la vista siempre; en el resumen, solo los que cambiaron.
    const porGuardar: { canal: CanalId; monto: number }[] = [];
    for (const canal of canalesEditables) {
      const texto = campos[canal];
      const actual = metaActual(canal);
      if (!unSoloCanal && texto.trim() === "" && actual === null) continue;
      const monto = montoDelCampo(texto);
      if (!Number.isFinite(monto) || monto <= 0) {
        setError(DIA_FALLO);
        return;
      }
      if (!unSoloCanal && actual !== null && Math.round(monto * 100) === Math.round(actual * 100)) continue;
      porGuardar.push({ canal, monto });
    }
    setError(null);

    if (porGuardar.length === 0) {
      setEditando(false);
      return;
    }

    setGuardando(true);
    try {
      const supabase = createClient();
      for (const { canal, monto } of porGuardar) {
        await guardarMetaVenta(supabase, canal, monto, hoyClave);
      }
      toast.success("Meta guardada.");
      setEditando(false);
      router.refresh();
    } catch (fallo) {
      toast.danger(configErrorMessage(fallo, "No se pudo guardar la meta. Vuelve a intentarlo."));
    } finally {
      setGuardando(false);
    }
  }

  // El eje del ritmo: del inicio de la atención al cierre (incluye una hora de gracia si se vende después).
  const desdeHora = ventana ? Math.floor(ventana.desde) : 0;
  const hastaHora = ventana ? Math.min(23, Math.ceil(ventana.hasta)) : 23;
  const horaEntera = horaEnteraDeCaracas(ahora);
  const real = acumuladoPorHora(hoy, vista, horaEntera);
  const metaPorHora = meta !== null ? metaAcumuladaPorHora(meta, curva, ventana) : null;

  return (
    <section aria-label="Rendimiento de ventas" className="pn-card pn-card--panel pn-card--hero pd-hero">
      <div className="pn-card__cab">
        <div>
          <p className="pn-eyebrow">Hoy</p>
          <h2 className="pn-card__titulo">Rendimiento de ventas</h2>
        </div>
        <span className="pn-chip">{etiquetaVista}</span>
      </div>

      {!abre ? (
        <div className="pd-cerrado">
          <p className="pd-cerrado__txt">Hoy la tienda no abre</p>
          {logrado !== null && logrado > 0 && (
            <p className="pn-subtitulo">Aun así se enviaron {formatoUsd(logrado)} a SAINT.</p>
          )}
        </div>
      ) : (
        <>
          <div className="pd-hero__top">
            <Anillo
              porcentaje={pct}
              color="var(--pn-hero-bien)"
              tam={132}
              ariaLabel={pct === null ? "Avance de la meta: sin meta definida" : `Avance de la meta: ${Math.round(pct)} %`}
            />
            <div className="pd-hero__datos">
              <div>
                <Cifra valor={logrado} formato={formatoUsd} className="pd-logrado" />
                <p className="pd-etq">logrado hoy</p>
              </div>

              {editando ? (
                <form className="pd-meta-form" onSubmit={guardar} noValidate>
                  {canalesEditables.map((canal) => {
                    const etiqueta =
                      canalesEditables.length === 1
                        ? "Meta del día (USD)"
                        : canal === "online"
                          ? "Meta online (USD)"
                          : "Meta en tienda (USD)";
                    return (
                      <label key={canal} className="pd-meta-form__campo" htmlFor={`${idCampo}-${canal}`}>
                        <span>{etiqueta}</span>
                        <input
                          id={`${idCampo}-${canal}`}
                          className="pd-meta-form__input"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={campos[canal]}
                          onChange={(e) => setCampos((previos) => ({ ...previos, [canal]: e.target.value }))}
                          disabled={guardando}
                        />
                      </label>
                    );
                  })}
                  {error && (
                    <p className="pd-meta-form__error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="pd-meta-form__acciones">
                    <button type="submit" className="pn-boton pd-boton-hero" disabled={guardando}>
                      <Check size={14} aria-hidden="true" />
                      Guardar meta
                    </button>
                    <button type="button" className="pn-boton pd-boton-hero" onClick={() => setEditando(false)} disabled={guardando}>
                      <X size={14} aria-hidden="true" />
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : (
                <div className="pd-meta">
                  <span>Meta diaria</span>
                  <Cifra valor={meta} formato={formatoUsd} className="pd-meta__valor lm-num" />
                  {lista && (
                    <button type="button" className="pd-lapiz" aria-label="Editar la meta diaria" onClick={abrirEdicion}>
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}

              {!metas.ok && <p className="pn-subtitulo">Las metas no están disponibles ahora.</p>}
              <div>
                {meta === null ? (
                  metas.ok && <span className="pn-chip">Sin meta definida</span>
                ) : cumplida ? (
                  <span className="pn-chip pn-chip--bien">
                    <Check size={13} aria-hidden="true" />
                    Meta cumplida
                  </span>
                ) : (
                  <span className="pn-chip pn-chip--alerta">Faltan {formatoUsd(falta)}</span>
                )}
              </div>
            </div>
          </div>

          <p className="pd-proyeccion">
            {!historia.ok ? (
              "La proyección no está disponible ahora."
            ) : curva === null ? (
              "La proyección aparece con 10 días hábiles de historia."
            ) : proyectado === null ? (
              "Todavía es temprano para proyectar el cierre del día."
            ) : (
              <>
                A este ritmo cerrarías el día en <b className="lm-num">{formatoUsd(proyectado)}</b>
                {meta !== null && pct !== null && proyectado >= meta ? " y llegarías a la meta." : "."}
              </>
            )}
          </p>

          {metaPorHora && (
            <div className="pd-ritmo-bloque">
              <div className="pd-ritmo-bloque__tit">
                <span className="pn-eyebrow">Ritmo por hora</span>
                <span className="pd-leyenda-ritmo">
                  <span className="pd-leyenda-ritmo__real">Acumulado real</span>
                  <span className="pd-leyenda-ritmo__meta">Meta</span>
                </span>
              </div>
              <GraficoRitmo
                real={real}
                meta={metaPorHora}
                desdeHora={desdeHora}
                hastaHora={hastaHora}
                horaActual={horaEntera}
                ariaLabel={`Ritmo de ventas por hora: llevas ${formatoUsd(real[real.length - 1] ?? 0)} de una meta de ${formatoUsd(meta)}${
                  metaPorHora[Math.min(horaEntera, 23)] !== undefined ? `; a esta hora la meta acumulada es ${formatoUsd(metaPorHora[Math.min(horaEntera, 23)])}` : ""
                }`}
              />
            </div>
          )}

          {seguidos !== null && (
            <div className="pd-racha">
              <span className="pd-racha__txt">
                <Flame size={16} aria-hidden="true" />
                {seguidos === 0 ? (
                  "Sin racha todavía"
                ) : (
                  <>
                    Racha: {seguidos} {plural(seguidos, "día", "días")}
                  </>
                )}
              </span>
              {ultimosDias.length > 0 && (
                <span className="pd-puntos" aria-hidden="true">
                  {ultimosDias.map((d) => (
                    <i key={d.dia} className={d.logrado >= (d.meta ?? Infinity) ? "pd-punto pd-punto--si" : "pd-punto"} />
                  ))}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
