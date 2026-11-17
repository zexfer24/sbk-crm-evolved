"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "@heroui/react";
import type { Agent } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  fetchAdvisorFollowups,
  fetchShadowDrafts,
  fetchShadowReviews,
  fetchShadowSpendToday,
  fetchSombraResumen,
  type AdvisorFollowups,
} from "@/lib/shadow-data";
import { saveShadowReview } from "@/lib/mutations";
import { configErrorMessage } from "@/lib/config-write";
import { periodStart, type SearchPeriod } from "@/lib/catalog-searches";
import { AREAS, AREA_LABELS } from "@/lib/seba-v2-config";
import {
  CORRECCION_MAX,
  DESTINOS,
  EJE_LABELS,
  EJE_SIN_POBLACION,
  EMPTY_SHADOW_FILTERS,
  ERROR_TIPOS,
  UMBRAL_DE_PREPARACION,
  VERDICTS,
  guardNames,
  hasActiveShadowFilters,
  matchesShadowFilters,
  medirPreparacion,
  proyectarConsumo,
  shadowStats,
  validateShadowReview,
  type EjeMedido,
  type PreparacionDeSombra,
  type ProyeccionDeConsumo,
  type ShadowDraft,
  type ShadowFilters,
  type ShadowReview,
  type ShadowReviewErrors,
  type ShadowVerdict,
  type SombraResumen,
} from "@/lib/shadow";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import "@/components/agent-control/shadow.css";

// ---------------------------------------------------------------------------
// Pestaña «Sombra» de Control IA (entrega 3 de Seba v2, 17/11/2026). Solo
// supervisor y admin: la RLS de `agent_shadow_drafts` y `shadow_reviews` ya lo
// exige, y la vista ni siquiera monta la pestaña para un asesor.
//
// Qué resuelve: Seba v2 puede redactar un turno completo SIN enviarlo (modo
// sombra) o proponérselo al asesor (copiloto). Para saber si está lista hay
// que ponerle al lado lo que de verdad contestó una persona, y dejar escrito
// qué estuvo mal. La lista abre cada borrador en tres columnas —el cliente, lo
// que habría enviado Seba, lo que contestó el asesor— y debajo un formulario de
// revisión (veredicto, tipo de error, corrección, destino). Convertir una
// corrección en lección es a mano por ahora: ese paso queda fuera.
//
// Los datos los pide este propio componente al montarse (carga perezosa: la
// vista solo lo monta cuando se abre la pestaña). Un número que no se pudo
// leer se pinta «—», nunca un cero que parezca medido. Un único contenedor raíz
// (`.ac-sh`): ver la trampa del fragmento de `AppRail` (CLAUDE.md, 9/9/2026).
// ---------------------------------------------------------------------------

const DASH = "—";

const PERIODS: { value: SearchPeriod; label: string }[] = [
  { value: "hoy", label: "Hoy" },
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
];

const VERDICT_LABEL: Record<ShadowVerdict, string> = {
  igual: "Igual",
  cambio_menor: "Cambio menor",
  no: "No",
};

const VERDICT_TONE: Record<ShadowVerdict, string> = {
  igual: "good",
  cambio_menor: "wait",
  no: "hot",
};

function dateTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString("es-VE", {
    timeZone: CRM_TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Con coma decimal y sin depender de la ICU de quien corre esto. */
function decimal(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",");
}

function seconds(ms: number | null): string {
  return ms === null ? DASH : `${decimal(ms / 1000, 1)} s`;
}

function usd(value: number, digits = 2): string {
  return `$${decimal(value, digits)}`;
}

/** Separador de miles con punto, sin depender de la ICU de quien corre esto. */
function miles(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** `2026-11-17` → «17 nov». El día ya viene cortado en hora de Caracas por la base. */
function diaCorto(dia: string): string {
  const [, mes, numero] = dia.split("-").map(Number);
  if (!mes || !numero || mes < 1 || mes > 12) return dia;
  return `${numero} ${MESES_CORTOS[mes - 1]}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Stat({ testId, value, label, sub }: { testId: string; value: string; label: string; sub?: string }) {
  return (
    <div className="ac-sh-stat" data-testid={testId}>
      <span className="ac-sh-stat-n">{value}</span>
      <span className="ac-sh-stat-label">{label}</span>
      {sub && <span className="ac-sh-stat-sub">{sub}</span>}
    </div>
  );
}

// ------------------------------ Detalle ------------------------------------

function DraftColumns({ draft }: { draft: ShadowDraft }) {
  const [followups, setFollowups] = useState<AdvisorFollowups | null | undefined>(undefined);

  // Lo que contestó el asesor se pide al abrir el borrador. Efecto inline con
  // `.then()` y bandera `cancelado` (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelado = false;
    fetchAdvisorFollowups(createClient(), draft.conversationId, draft.createdAt)
      .then((next) => {
        if (!cancelado) setFollowups(next);
      })
      .catch((error: unknown) => {
        console.error("No se pudo leer lo que contestó el asesor:", error);
        if (!cancelado) setFollowups(null);
      });
    return () => {
      cancelado = true;
    };
  }, [draft.conversationId, draft.createdAt]);

  const mensajes = [...draft.mensajes].sort((a, b) => a.orden - b.orden);
  const meta = [
    draft.model,
    plural(draft.llamadas, "llamada", "llamadas"),
    seconds(draft.durationMs),
    `${(draft.inputTokens + draft.outputTokens).toLocaleString("es-VE")} tokens`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="ac-sh-cols">
      <section className="ac-sh-col" aria-label="Lo que escribió el cliente">
        <h4 className="ac-sh-col-title">Lo que escribió el cliente</h4>
        {draft.rafaga.length === 0 ? (
          <p className="ac-sh-muted">Sin texto del cliente.</p>
        ) : (
          draft.rafaga.map((texto, index) => (
            <p className="ac-sh-bubble" data-from="cliente" key={index}>
              {texto}
            </p>
          ))
        )}
      </section>

      <section className="ac-sh-col" aria-label="Lo que habría enviado Seba">
        <h4 className="ac-sh-col-title">Lo que habría enviado Seba</h4>
        {mensajes.length === 0 ? (
          <p className="ac-sh-muted">Seba no habría enviado ningún mensaje.</p>
        ) : (
          mensajes.map((m) => (
            <div className="ac-sh-msg" key={m.orden}>
              <p className="ac-sh-bubble" data-from="seba">
                {m.tipo === "imagen" && <span className="ac-sh-photo">Foto</span>}
                {m.texto}
              </p>
              <span className="ac-sh-origin">{m.origen}</span>
            </div>
          ))
        )}

        {draft.herramientas.length > 0 && (
          <div className="ac-sh-chips" aria-label="Herramientas que usó">
            {draft.herramientas.map((tool, index) => (
              <span className="ac-sh-chip" key={`${tool}-${index}`}>
                {tool}
              </span>
            ))}
          </div>
        )}

        {draft.escalaria && (
          <p className="ac-sh-pase">
            <strong>Pasaría el caso a {draft.area ? AREA_LABELS[draft.area] : "un asesor"}.</strong>
            {draft.motivo && <span> Motivo: {draft.motivo}.</span>}
            {draft.nota && <span> Nota: {draft.nota}</span>}
          </p>
        )}

        {draft.guardas.length > 0 && (
          <ul className="ac-sh-guards" aria-label="Guardas que dispararon">
            {draft.guardas.map((g, index) => (
              <li key={`${g.guarda}-${index}`}>
                <strong>{g.guarda}</strong>
                {g.fragmento && <span> — «{g.fragmento}»</span>}
              </li>
            ))}
          </ul>
        )}

        <p className="ac-sh-meta">{meta}</p>
      </section>

      <section className="ac-sh-col" aria-label="Lo que contestó el asesor">
        <h4 className="ac-sh-col-title">Lo que contestó el asesor</h4>
        {followups === undefined ? (
          <p className="ac-sh-muted">Cargando…</p>
        ) : followups === null ? (
          <p className="ac-sh-muted">No se pudo cargar lo que contestó el asesor.</p>
        ) : followups.messages.length === 0 ? (
          <p className="ac-sh-muted">El asesor todavía no contestó</p>
        ) : (
          <>
            {followups.messages.map((m) => (
              <p className="ac-sh-bubble" data-from="asesor" key={m.id}>
                {m.content ?? `[${m.messageType}]`}
              </p>
            ))}
            {followups.minutesToFirst !== null && (
              <p className="ac-sh-meta">Tardó {decimal(followups.minutesToFirst, 1)} min en contestar.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ReviewForm({
  draft,
  review,
  agent,
  onSaved,
}: {
  draft: ShadowDraft;
  review: ShadowReview | null;
  agent: Agent;
  onSaved: (review: ShadowReview) => void;
}) {
  const [veredicto, setVeredicto] = useState<ShadowVerdict | null>(review?.veredicto ?? null);
  const [errorTipo, setErrorTipo] = useState(review?.errorTipo ?? "");
  const [correccion, setCorreccion] = useState(review?.correccion ?? "");
  const [destino, setDestino] = useState(review?.destino ?? "");
  const [errors, setErrors] = useState<ShadowReviewErrors>({});
  const [saving, setSaving] = useState(false);

  function clearError(field: keyof ShadowReviewErrors) {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSave() {
    const found = validateShadowReview({ veredicto, errorTipo, correccion, destino });
    if (Object.keys(found).length > 0 || !veredicto) {
      setErrors(found);
      return;
    }
    setErrors({});
    setSaving(true);
    const payload = {
      veredicto,
      errorTipo: errorTipo || null,
      correccion: correccion.trim() || null,
      destino: destino || null,
    };
    try {
      await saveShadowReview(createClient(), agent, draft.id, payload);
      toast.success("Revisión guardada.");
      onSaved({
        draftId: draft.id,
        ...payload,
        reviewedBy: agent.id,
        reviewedAt: new Date().toISOString(),
      });
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudo guardar la revisión."));
    } finally {
      setSaving(false);
    }
  }

  const needsDetail = veredicto !== null && veredicto !== "igual";
  const over = correccion.length > CORRECCION_MAX;
  const id = (name: string) => `sh-${draft.id}-${name}`;

  return (
    <div className="ac-sh-form">
      <h4 className="ac-sh-col-title">Revisión</h4>

      <fieldset className="ac-sh-verdicts">
        <legend className="ac-sh-label">Veredicto</legend>
        {VERDICTS.map((v) => (
          <label className="ac-sh-verdict" data-selected={veredicto === v.value} key={v.value}>
            <input
              type="radio"
              name={id("veredicto")}
              value={v.value}
              checked={veredicto === v.value}
              onChange={() => {
                setVeredicto(v.value);
                clearError("veredicto");
              }}
            />
            <span>{v.label}</span>
          </label>
        ))}
      </fieldset>
      {errors.veredicto && (
        <p className="lm-field-error" role="alert">
          {errors.veredicto}
        </p>
      )}

      <div className="ac-sh-form-row">
        <div className="ac-sh-field">
          <label className="ac-sh-label" htmlFor={id("error")}>
            Tipo de error
          </label>
          <select
            id={id("error")}
            className="lm-select"
            value={errorTipo}
            onChange={(e) => {
              setErrorTipo(e.target.value);
              clearError("errorTipo");
            }}
          >
            <option value="">{needsDetail ? "Elige uno" : "Sin error"}</option>
            {ERROR_TIPOS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
          {errors.errorTipo && (
            <p className="lm-field-error" role="alert">
              {errors.errorTipo}
            </p>
          )}
        </div>

        <div className="ac-sh-field">
          <label className="ac-sh-label" htmlFor={id("destino")}>
            Destino de la corrección
          </label>
          <select id={id("destino")} className="lm-select" value={destino} onChange={(e) => setDestino(e.target.value)}>
            <option value="">Sin destino</option>
            {DESTINOS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="ac-sh-field">
        <label className="ac-sh-label" htmlFor={id("correccion")}>
          Corrección
        </label>
        <textarea
          id={id("correccion")}
          className="ac-sh-textarea"
          rows={3}
          value={correccion}
          aria-describedby={id("contador")}
          placeholder={needsDetail ? "Cómo debió responder Seba" : "Opcional cuando quedó igual"}
          onChange={(e) => {
            setCorreccion(e.target.value);
            clearError("correccion");
          }}
        />
        <span id={id("contador")} className="ac-sh-count" data-testid="contador-correccion" data-over={over}>
          {correccion.length} / {CORRECCION_MAX}
        </span>
        {errors.correccion && (
          <p className="lm-field-error" role="alert">
            {errors.correccion}
          </p>
        )}
      </div>

      <div className="ac-sh-actions">
        <button type="button" className="crm-pill" data-variant="solid" onClick={handleSave} disabled={saving}>
          {saving ? "Guardando…" : "Guardar revisión"}
        </button>
        {review && (
          <span className="ac-sh-muted">
            Revisado el {dateTimeLabel(review.reviewedAt)}
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------- Fila --------------------------------------

function DraftRow({
  draft,
  review,
  open,
  agent,
  onToggle,
  onReviewed,
}: {
  draft: ShadowDraft;
  review: ShadowReview | null;
  open: boolean;
  agent: Agent;
  onToggle: () => void;
  onReviewed: (review: ShadowReview) => void;
}) {
  const first = draft.rafaga[0]?.trim() || DASH;

  return (
    <li className="ac-sh-row" data-open={open}>
      <button type="button" className="ac-sh-row-head" aria-expanded={open} onClick={onToggle}>
        <span className="ac-sh-row-main">
          <span className="ac-sh-row-msg">{first}</span>
          <span className="ac-sh-row-time">{dateTimeLabel(draft.createdAt)}</span>
        </span>
        <span className="ac-sh-row-tags">
          <span className="ac-badge" data-tone={draft.modo === "copiloto" ? "plum" : "muted"}>
            {draft.modo === "copiloto" ? "Copiloto" : "Sombra"}
          </span>
          {draft.escalaria && (
            <span className="ac-badge" data-tone="wait">
              Pasaría a {draft.area ? AREA_LABELS[draft.area] : "un asesor"}
            </span>
          )}
          {draft.guardas.map((g, index) => (
            <span className="ac-badge" data-tone="hot" key={`${g.guarda}-${index}`}>
              {g.guarda}
            </span>
          ))}
          {review && (
            <span className="ac-badge" data-tone={VERDICT_TONE[review.veredicto]}>
              {VERDICT_LABEL[review.veredicto]}
            </span>
          )}
        </span>
        <ChevronDown size={16} className="ac-sh-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="ac-sh-detail">
          <DraftColumns draft={draft} />
          <ReviewForm draft={draft} review={review} agent={agent} onSaved={onReviewed} />
        </div>
      )}
    </li>
  );
}

// ------------------- Preparación para desplegar y consumo -------------------
//
// P1, 17/11/2026 (pedido del operador). Dos bloques que siguen el selector de
// período y se alimentan de UNA sola lectura (`sombra_resumen`): cuánto cuesta
// la sombra y qué tan lista está Seba v2 en tres ejes. El porcentaje sale de
// las revisiones de los supervisores —la sombra no aprende sola—, así que sin
// revisiones suficientes se pinta «—» con lo que falta, nunca un 0 % ni un
// 100 % que parezca medido.

/** `undefined` = cargando; `null` = la RPC no existe todavía (falta la migración). */
type ResumenState = SombraResumen | null | undefined;

const MIGRACION_RESUMEN = "20261117020000";

function nivelDeEje(pct: number | null): "listo" | "cerca" | "lejos" | "sin_dato" {
  if (pct === null) return "sin_dato";
  if (pct >= UMBRAL_DE_PREPARACION) return "listo";
  return pct >= UMBRAL_DE_PREPARACION - 10 ? "cerca" : "lejos";
}

function EjeFila({ eje }: { eje: EjeMedido }) {
  const label = EJE_LABELS[eje.eje];
  // Un eje por debajo de su mínimo de revisiones no enseña porcentaje: con 12
  // casos un solo error mueve el número ocho puntos y parecería medido.
  const pct = eje.suficiente ? eje.pct : null;
  const nivel = nivelDeEje(pct);
  const faltantes = `faltan ${eje.faltan} ${eje.faltan === 1 ? "revisión" : "revisiones"}`;

  return (
    <li className="ac-sh-eje" data-testid={`prep-eje-${eje.eje}`}>
      <div className="ac-sh-eje-head">
        <span className="ac-sh-eje-name">{label}</span>
        <span className="ac-sh-eje-pct" data-nivel={nivel}>
          {pct === null ? DASH : `${pct} %`}
        </span>
      </div>

      <div
        className="ac-sh-meter"
        role="meter"
        aria-label={pct === null ? `${label}: sin porcentaje todavía` : `${label}: ${pct} %`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        aria-valuetext={pct === null ? `Sin porcentaje todavía: ${faltantes}` : `${pct} %`}
      >
        <span className="ac-sh-meter-fill" data-nivel={nivel} style={{ width: `${pct ?? 0}%` }} />
        <span
          className="ac-sh-meter-marca"
          data-testid="prep-marca-90"
          style={{ left: `${UMBRAL_DE_PREPARACION}%` }}
          aria-hidden="true"
        />
      </div>

      <p className="ac-sh-eje-meta">
        {eje.poblacion === 0 ? (
          <span>Sin datos: {EJE_SIN_POBLACION[eje.eje]}.</span>
        ) : (
          <>
            <span>
              {eje.revisados} {eje.revisados === 1 ? "revisado" : "revisados"} de {eje.poblacion}{" "}
              {eje.poblacion === 1 ? "borrador" : "borradores"}
            </span>
            {!eje.suficiente && <strong className="ac-sh-eje-faltan">{faltantes}</strong>}
            {eje.revisados > 0 && (
              <span className="ac-sh-eje-detalle">
                {eje.reprobados} {eje.reprobados === 1 ? "reprobado" : "reprobados"}, {eje.cambiosMenores} con cambio
                menor
              </span>
            )}
          </>
        )}
      </p>
    </li>
  );
}

function PreparacionBlock({
  resumen,
  preparacion,
  error,
  onRetry,
}: {
  resumen: ResumenState;
  preparacion: PreparacionDeSombra | null;
  error: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="dash-panel" aria-label="Preparación para desplegar">
      <div className="ac-sh-head">
        <h2 className="dash-panel-title">Preparación para desplegar</h2>
      </div>
      <div className="ac-sh-body">
        {error ? (
          <div className="ac-sh-error" role="alert">
            <span>No se pudo cargar la preparación y el consumo. Reintenta en un momento.</span>
            <button type="button" className="crm-pill" onClick={onRetry}>
              Reintentar
            </button>
          </div>
        ) : resumen === undefined ? (
          <p className="ac-sh-muted">Cargando…</p>
        ) : resumen === null || preparacion === null ? (
          <p className="ac-sh-muted">No disponible: falta aplicar la migración {MIGRACION_RESUMEN}</p>
        ) : (
          <>
            <div className="ac-sh-prep">
              <div className="ac-sh-general" data-nivel={nivelDeEje(preparacion.general)}>
                <span className="ac-sh-general-n" data-testid="prep-general">
                  {preparacion.general === null ? DASH : `${preparacion.general} %`}
                </span>
                <span className="ac-sh-general-label">Preparación general</span>
                <p className="ac-sh-motivo" data-testid="prep-motivo">
                  {preparacion.motivo}
                </p>
              </div>

              <div className="ac-sh-ejes-col">
                <ul className="ac-sh-ejes">
                  {preparacion.ejes.map((eje) => (
                    <EjeFila key={eje.eje} eje={eje} />
                  ))}
                </ul>
                <p className="ac-sh-leyenda">
                  La marca vertical es el {UMBRAL_DE_PREPARACION} %. El número general es el del eje más flojo: un
                  vendedor está tan listo como su punto más débil.
                </p>
              </div>
            </div>

            <p className="ac-sh-senales" data-testid="prep-senales">
              <span className="ac-sh-senales-titulo">
                Señales sin revisión, de {miles(resumen.preparacion.senales.total)} borradores:
              </span>
              <span>{miles(resumen.preparacion.senales.conGuardas)} con guardas</span>
              <span>{miles(resumen.preparacion.senales.pasarianAAsesor)} pasarían a un asesor</span>
              <span>{miles(resumen.preparacion.senales.sinMensajes)} sin mensajes</span>
            </p>

            <p className="ac-sh-nota-fija">
              Este número sale de las revisiones de los supervisores. La sombra no aprende sola: mejora cuando una
              corrección se convierte en lección o en un ajuste del guion.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function ConsumoBlock({
  resumen,
  proyeccion,
  error,
  spendText,
}: {
  resumen: ResumenState;
  proyeccion: ProyeccionDeConsumo | null;
  error: boolean;
  spendText: string;
}) {
  return (
    <section className="dash-panel" aria-label="Consumo">
      <div className="ac-sh-head">
        <h2 className="dash-panel-title">Consumo</h2>
      </div>
      <div className="ac-sh-body ac-sh-consumo">
        {/* Hoy contra el tope no depende del período ni del resumen: sigue visible aunque la RPC falte. */}
        <div className="ac-sh-stats">
          <Stat testId="stat-gasto" value={spendText} label="Gasto de la sombra hoy" sub="contra el tope diario" />
          {resumen && proyeccion && (
            <>
              <Stat
                testId="consumo-borradores"
                value={miles(resumen.consumo.total.borradores)}
                label="Borradores del período"
              />
              <Stat
                testId="consumo-costo"
                value={resumen.consumo.total.costoUsd === null ? DASH : usd(resumen.consumo.total.costoUsd)}
                label="Costo del período"
                sub={resumen.consumo.total.sinTarifa > 0 ? "sin contar los de modelos sin tarifa" : undefined}
              />
              <Stat
                testId="consumo-tokens"
                value={miles(resumen.consumo.total.inputTokens)}
                label="Tokens de entrada"
                sub={`${miles(resumen.consumo.total.outputTokens)} de salida`}
              />
              <Stat
                testId="consumo-por-borrador"
                value={proyeccion.costoPorBorradorUsd === null ? DASH : usd(proyeccion.costoPorBorradorUsd, 3)}
                label="Costo por borrador"
              />
              <Stat
                testId="consumo-promedio"
                value={proyeccion.promedioDiarioUsd === null ? DASH : usd(proyeccion.promedioDiarioUsd)}
                label="Promedio por día"
                sub={`sobre ${plural(proyeccion.diasEnElPeriodo, "día con borradores", "días con borradores")}`}
              />
            </>
          )}
        </div>

        {error ? (
          <p className="ac-sh-muted">No se pudo cargar el consumo del período.</p>
        ) : resumen === undefined ? (
          <p className="ac-sh-muted">Cargando…</p>
        ) : resumen === null || proyeccion === null ? (
          <p className="ac-sh-muted">No disponible: falta aplicar la migración {MIGRACION_RESUMEN}</p>
        ) : (
          <>
            {proyeccion.alCienPorCientoUsd !== null &&
              resumen.consumo.muestreoPct !== null &&
              resumen.consumo.muestreoPct < 100 && (
                <p className="ac-sh-proyeccion" data-testid="consumo-proyeccion">
                  Al 100 % de muestreo serían ≈ {usd(proyeccion.alCienPorCientoUsd)} por día (hoy se muestrea el{" "}
                  {resumen.consumo.muestreoPct} % de los turnos).
                </p>
              )}

            {resumen.consumo.total.sinTarifa > 0 && (
              <p className="ac-sh-aviso" role="status" data-testid="consumo-aviso-sin-tarifa">
                {plural(resumen.consumo.total.sinTarifa, "borrador sin tarifa", "borradores sin tarifa")}: el modelo no
                tiene fila en model_pricing, su costo no se cuenta y el tope no los frena.
              </p>
            )}

            {resumen.consumo.dias.length === 0 ? (
              <p className="ac-sh-muted">Sin borradores en este período.</p>
            ) : (
              <div className="ac-sh-table-scroll" role="group" aria-label="Tabla de consumo por día, desplazable" tabIndex={0}>
                <table className="ac-sh-table" aria-label="Consumo por día">
                  <thead>
                    <tr>
                      <th scope="col">Día</th>
                      <th scope="col">Borradores</th>
                      <th scope="col">Tokens de entrada</th>
                      <th scope="col">Tokens de salida</th>
                      <th scope="col">Costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resumen.consumo.dias.map((dia) => (
                      <tr key={dia.dia}>
                        <th scope="row">{diaCorto(dia.dia)}</th>
                        <td>{miles(dia.borradores)}</td>
                        <td>{miles(dia.inputTokens)}</td>
                        <td>{miles(dia.outputTokens)}</td>
                        <td>
                          {dia.costoUsd === null ? (
                            <span title="Ningún borrador de este día tiene tarifa de modelo">{DASH}</span>
                          ) : (
                            usd(dia.costoUsd)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ------------------------------- Panel -------------------------------------

interface ShadowPanelProps {
  currentAgent: Agent;
  /** `agent_settings.shadow_daily_cap_usd`; `null` = no se pudo leer la configuración. */
  dailyCapUsd: number | null;
}

interface Loaded {
  drafts: ShadowDraft[];
  reviews: ShadowReview[];
}

export function ShadowPanel({ currentAgent, dailyCapUsd }: ShadowPanelProps) {
  const [period, setPeriod] = useState<SearchPeriod>("hoy");
  const [retry, setRetry] = useState(0);
  // `undefined` = cargando.
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [spend, setSpend] = useState<number | null | undefined>(undefined);
  // El resumen (consumo y preparación) tiene su propia lectura y su propio
  // Reintentar: que falle o falte la migración no debe tumbar la lista de borradores.
  const [resumen, setResumen] = useState<ResumenState>(undefined);
  const [resumenError, setResumenError] = useState(false);
  const [retryResumen, setRetryResumen] = useState(0);
  const [filters, setFilters] = useState<ShadowFilters>(EMPTY_SHADOW_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);

  // Borradores y revisiones del período. Inline, con `.then()` y bandera
  // `cancelado` (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelado = false;
    const supabase = createClient();
    fetchShadowDrafts(supabase, { desde: periodStart(period) })
      .then(async (drafts) => {
        const reviews = await fetchShadowReviews(
          supabase,
          drafts.map((d) => d.id)
        );
        if (cancelado) return;
        setLoaded({ drafts, reviews });
        setLoadError(false);
      })
      .catch((error: unknown) => {
        console.error("No se pudieron cargar los borradores de la sombra:", error);
        if (!cancelado) setLoadError(true);
      });
    return () => {
      cancelado = true;
    };
  }, [period, retry]);

  // Consumo y preparación del período (P1, 17/11/2026): una sola RPC. Inline,
  // con `.then()` y bandera `cancelado` (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelado = false;
    fetchSombraResumen(createClient(), { desde: periodStart(period), hasta: new Date().toISOString() })
      .then((next) => {
        if (cancelado) return;
        setResumen(next);
        setResumenError(false);
      })
      .catch((error: unknown) => {
        console.error("No se pudo cargar el consumo y la preparación de la sombra:", error);
        if (!cancelado) setResumenError(true);
      });
    return () => {
      cancelado = true;
    };
  }, [period, retryResumen]);

  // El gasto de hoy no depende del período.
  useEffect(() => {
    let cancelado = false;
    fetchShadowSpendToday(createClient())
      .then((value) => {
        if (!cancelado) setSpend(value);
      })
      .catch(() => {
        if (!cancelado) setSpend(null);
      });
    return () => {
      cancelado = true;
    };
  }, []);

  const reviewByDraft = useMemo(
    () => new Map((loaded?.reviews ?? []).map((r) => [r.draftId, r])),
    [loaded?.reviews]
  );
  const stats = useMemo(() => shadowStats(loaded?.drafts ?? [], loaded?.reviews ?? []), [loaded]);
  const guards = useMemo(() => guardNames(loaded?.drafts ?? []), [loaded?.drafts]);
  const visible = useMemo(
    () => (loaded ? loaded.drafts.filter((d) => matchesShadowFilters(d, reviewByDraft.get(d.id) ?? null, filters)) : []),
    [loaded, reviewByDraft, filters]
  );

  const preparacion = useMemo(() => (resumen ? medirPreparacion(resumen) : null), [resumen]);
  const proyeccion = useMemo(() => (resumen ? proyectarConsumo(resumen) : null), [resumen]);

  function changePeriod(next: SearchPeriod) {
    if (next === period) return;
    setPeriod(next);
    setLoaded(undefined);
    setLoadError(false);
    setResumen(undefined);
    setResumenError(false);
    setOpenId(null);
  }

  function retryLoadResumen() {
    setResumen(undefined);
    setResumenError(false);
    setRetryResumen((n) => n + 1);
  }

  function setFilter<K extends keyof ShadowFilters>(key: K, value: ShadowFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function handleReviewed(review: ShadowReview) {
    setLoaded((current) =>
      current
        ? { ...current, reviews: [...current.reviews.filter((r) => r.draftId !== review.draftId), review] }
        : current
    );
  }

  const spendText =
    spend === undefined
      ? "…"
      : spend === null
        ? DASH
        : dailyCapUsd === null
          ? usd(spend)
          : `${usd(spend)} de ${usd(dailyCapUsd)}`;

  return (
    <div className="ac-sh">
      <section className="dash-panel" aria-label="Resumen del período">
        <div className="ac-sh-head">
          <h2 className="dash-panel-title">Sombra de Seba v2</h2>
          <span className="dash-panel-spacer" />
          <div className="ac-sh-periods" role="group" aria-label="Período">
            {PERIODS.map((item) => (
              <button
                key={item.value}
                type="button"
                className="crm-pill"
                data-variant={period === item.value ? "solid" : undefined}
                aria-pressed={period === item.value}
                onClick={() => changePeriod(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="ac-sh-body">
          <div className="ac-sh-stats">
            <Stat testId="stat-borradores" value={loaded ? String(stats.borradores) : DASH} label="Borradores" />
            <Stat testId="stat-revisados" value={loaded ? String(stats.revisados) : DASH} label="Revisados" />
            <Stat
              testId="stat-aprobacion"
              value={stats.aprobacionPct === null ? DASH : `${Math.round(stats.aprobacionPct)} %`}
              label="Igual o cambio menor"
              sub="sobre los revisados"
            />
            <Stat testId="stat-mediana" value={loaded ? seconds(stats.medianaMs) : DASH} label="Duración mediana" />
          </div>
        </div>
      </section>

      <PreparacionBlock resumen={resumen} preparacion={preparacion} error={resumenError} onRetry={retryLoadResumen} />

      <ConsumoBlock resumen={resumen} proyeccion={proyeccion} error={resumenError} spendText={spendText} />

      <section className="dash-panel" aria-label="Borradores">
        <div className="ac-sh-head">
          <h2 className="dash-panel-title">Borradores</h2>
          <span className="dash-panel-spacer" />
          {loaded && (
            <span className="dash-panel-note">
              {visible.length === loaded.drafts.length
                ? plural(loaded.drafts.length, "borrador", "borradores")
                : `${visible.length} de ${loaded.drafts.length} borradores`}
            </span>
          )}
        </div>

        <div className="ac-sh-filters">
          <select
            className="lm-select"
            aria-label="Filtrar por veredicto"
            value={filters.veredicto}
            onChange={(e) => setFilter("veredicto", e.target.value as ShadowFilters["veredicto"])}
          >
            <option value="todos">Todos los veredictos</option>
            {VERDICTS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
            <option value="sin_revisar">Sin revisar</option>
          </select>
          <select
            className="lm-select"
            aria-label="Filtrar por pase a un asesor"
            value={filters.escalaria}
            onChange={(e) => setFilter("escalaria", e.target.value as ShadowFilters["escalaria"])}
          >
            <option value="todos">Pasen o no a un asesor</option>
            <option value="si">Pasaría a un asesor</option>
            <option value="no">No pasaría</option>
          </select>
          <select
            className="lm-select"
            aria-label="Filtrar por área"
            value={filters.area}
            onChange={(e) => setFilter("area", e.target.value as ShadowFilters["area"])}
          >
            <option value="todas">Todas las áreas</option>
            {AREAS.map((area) => (
              <option key={area} value={area}>
                {AREA_LABELS[area]}
              </option>
            ))}
          </select>
          <select
            className="lm-select"
            aria-label="Filtrar por guarda"
            value={filters.guarda}
            onChange={(e) => setFilter("guarda", e.target.value)}
          >
            <option value="todas">Todas las guardas</option>
            {guards.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {hasActiveShadowFilters(filters) && (
            <button type="button" className="crm-pill" onClick={() => setFilters(EMPTY_SHADOW_FILTERS)}>
              Limpiar filtros
            </button>
          )}
        </div>

        {loadError ? (
          <div className="ac-sh-body">
            <div className="ac-sh-error" role="alert">
              <span>No se pudieron cargar los borradores. Reintenta en un momento.</span>
              <button type="button" className="crm-pill" onClick={() => setRetry((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          </div>
        ) : loaded === undefined ? (
          <div className="ac-sh-body">
            <p className="ac-sh-muted">Cargando…</p>
          </div>
        ) : loaded.drafts.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">
              Todavía no hay borradores. Seba v2 los guarda cuando el modo es Sombra o Copiloto.
            </p>
            <p className="dash-empty-hint">Cambia el modo en la pestaña «Seba v2».</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">Ningún borrador pasa esos filtros</p>
            <p className="dash-empty-hint">Quita algún filtro para volver a ver la lista.</p>
          </div>
        ) : (
          <ul className="ac-sh-list">
            {visible.map((draft) => (
              <DraftRow
                key={draft.id}
                draft={draft}
                review={reviewByDraft.get(draft.id) ?? null}
                open={openId === draft.id}
                agent={currentAgent}
                onToggle={() => setOpenId((current) => (current === draft.id ? null : draft.id))}
                onReviewed={handleReviewed}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
