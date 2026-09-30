"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, GraduationCap, MessageSquare, ShieldCheck } from "lucide-react";
import { Input, toast } from "@heroui/react";
import type {
  Agent,
  AiLesson,
  CatalogSearchNotice,
  CatalogSearchQuery,
  CatalogSearchResult,
  CatalogSearchTurn,
  CatalogNoticeType,
  SearchSummary,
  SearchTerms,
} from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchCatalogSearches, fetchSearchSummary, fetchSearchTerms } from "@/lib/data";
import { protectWordFromCorrection } from "@/lib/mutations";
import { configErrorMessage } from "@/lib/config-write";
import {
  EMPTY_SEARCH_FILTERS,
  NOTICE_LABEL,
  NOTICE_ORDER,
  RESULT_LABEL,
  RESULT_ORDER,
  RESULT_TONE,
  filterSearchTurns,
  hasActiveSearchFilters,
  periodStart,
  synonymSeed,
  type SearchFilters,
  type SearchPeriod,
} from "@/lib/catalog-searches";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import { TeachSebaModal } from "@/components/chat/teach-seba-modal";
import "@/components/agent-control/catalog-searches.css";

// ---------------------------------------------------------------------------
// Pestaña «Búsquedas» de Control IA (T9, plan "Seba no cotiza lo que no es",
// 30/9/2026): todo lo que hace la búsqueda del catálogo, sin abrir la base ni
// los logs. Cuatro bloques:
//
//   A · Resumen del período (hoy / 7 / 30 días), de la RPC `resumen_busquedas`.
//   B · Los últimos turnos que tocaron el catálogo, con filtros y una fila
//       expandible por turno (`fetchCatalogSearches`, filtrado EN MEMORIA).
//   C · Lo que Seba no encuentra: los términos obligatorios sin resultados o
//       relajados, 30 días, de la RPC `terminos_de_busquedas`.
//   D · Las correcciones del corrector de tipeos y en qué terminó cada una, con
//       «No corregir esta palabra» (D5).
//
// LEE DOS VERSIONES A LA VEZ de `agent_turns.catalog_queries`: las filas v1
// (28/9, sin `v`) y las v2 (A2). Lo que una fila v1 no registró llega como
// `null` y se pinta «—»; «ninguno»/«nada» se reserva para «se registró y no
// hubo». Confundirlos pintaría un cero que parezca un dato medido.
//
// Los datos los pide este propio componente (como `LessonsPanel` con sus
// mutaciones) y se refrescan cuando `refreshToken` cambia: la vista lo sube en
// cada refresco por `postgres_changes` sobre `agent_turns`. Los paneles de un
// mismo bloque comparten un contenedor único (`.ac-bq`), no un fragmento: ver
// la trampa del fragmento de `AppRail` (CLAUDE.md, 9/9/2026).
// ---------------------------------------------------------------------------

/** Cuántos turnos trae la lista (B). Los conteos de A, C y D no salen de esta lista sino de SQL. */
const TURNS_LIMIT = 200;

const PERIODS: { value: SearchPeriod; label: string }[] = [
  { value: "hoy", label: "Hoy" },
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
];

/** Marca de «no se registró» (fila v1). */
const DASH = "—";

interface CatalogSearchesPanelProps {
  currentAgent: Agent;
  /** Las lecciones de Seba: de ahí salen las palabras que ya tienen «No corregir». */
  lessons: AiLesson[];
  /** Sube en cada refresco de la vista; al cambiar, todo se vuelve a pedir. */
  refreshToken: number;
  /** Se llama tras crear una lección `no_corregir` que salió bien, para que la pestaña «Lecciones» la vea. */
  onLessonsChanged?: () => void | Promise<void>;
}

/** Un `PGRST202`/`42883` es «la función no existe todavía»: falta aplicar la migración, no un fallo pasajero. */
function isMissingFunction(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "PGRST202" || code === "42883";
}

function loadErrorMessage(error: unknown, what: string): string {
  if (isMissingFunction(error)) {
    return `No se pudo cargar ${what}: falta aplicar la migración 20260930060000 en la base.`;
  }
  return `No se pudo cargar ${what}. Reintenta en un momento.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function dateTimeLabel(iso: string | null): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleString("es-VE", {
    timeZone: CRM_TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateLabel(iso: string | null): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString("es-VE", { timeZone: CRM_TIME_ZONE, day: "numeric", month: "short" });
}

function noticeText(notice: CatalogSearchNotice): string {
  const label = NOTICE_LABEL[notice.tipo];
  return notice.detalle ? `${label}: ${notice.detalle}` : label;
}

/** Un campo de la fila expandida: `null` (v1) es «—»; una lista vacía es `emptyText` («ninguno»). */
function Field({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </>
  );
}

function Dash() {
  return <span className="ac-bq-dash">{DASH}</span>;
}

function Chips({ items }: { items: readonly string[] }) {
  return (
    <span className="ac-bq-chips">
      {items.map((item) => (
        <span className="ac-bq-chip" key={item}>
          {item}
        </span>
      ))}
    </span>
  );
}

function Stat({ testId, value, label, sub }: { testId: string; value: number; label: string; sub?: string }) {
  return (
    <div className="ac-bq-stat" data-testid={testId}>
      <span className="ac-bq-stat-n">{value}</span>
      <span className="ac-bq-stat-label">{label}</span>
      {sub && <span className="ac-bq-stat-sub">{sub}</span>}
    </div>
  );
}

function QueryDetail({
  turn,
  query,
  onTeach,
}: {
  turn: CatalogSearchTurn;
  query: CatalogSearchQuery;
  onTeach: (query: CatalogSearchQuery) => void;
}) {
  const isV1 = query.version === 1;

  return (
    <section className="ac-bq-query" aria-label="Detalle de la búsqueda">
      {isV1 && (
        <p className="ac-bq-query-title">Fila anterior a A2: no registra avisos, relajos, decisión ni cotizados.</p>
      )}
      <dl className="ac-bq-fields">
        <Field label="Se buscó" testId="campo-busqueda">
          {query.query || <Dash />}
          {query.productos && query.productos.length > 1 && (
            <>
              {" "}
              <span className="ac-bq-dash">(lista: {query.productos.join(", ")})</span>
            </>
          )}
        </Field>

        <Field label="Resultado" testId="campo-resultado">
          {query.resultado ? (
            <span className="ac-badge" data-tone={RESULT_TONE[query.resultado]}>
              {RESULT_LABEL[query.resultado]}
            </span>
          ) : (
            <Dash />
          )}
        </Field>

        <Field label="Términos obligatorios" testId="campo-terminos">
          {query.terminos.length > 0 ? <Chips items={query.terminos} /> : <Dash />}
          {query.moto.length > 0 && (
            <>
              {" "}
              <span className="ac-bq-dash">moto:</span> <Chips items={query.moto} />
            </>
          )}
          {query.variantes && query.variantes.length > 0 && (
            <>
              {" "}
              <span className="ac-bq-dash">variantes:</span> <Chips items={query.variantes} />
            </>
          )}
        </Field>

        <Field label="Corrector" testId="campo-corrector">
          {query.corregido.length > 0 ? (
            <ul>
              {query.corregido.map((c) => (
                <li key={`${c.original}->${c.corregido}`}>
                  {c.original} → {c.corregido}
                </li>
              ))}
            </ul>
          ) : (
            "Sin corrección"
          )}
        </Field>

        <Field label="Corrección descartada" testId="campo-descartada">
          {query.correccionDescartada === null ? (
            <Dash />
          ) : query.correccionDescartada.length > 0 ? (
            <ul>
              {query.correccionDescartada.map((c) => (
                <li key={`${c.original}->${c.corregido}`}>
                  {c.original} → {c.corregido} (descartada por la guarda de producto)
                </li>
              ))}
            </ul>
          ) : (
            "Ninguna"
          )}
        </Field>

        <Field label="Relajo" testId="campo-relajo">
          {query.relajados === null ? (
            <Dash />
          ) : query.relajados.length > 0 ? (
            <Chips items={query.relajados} />
          ) : (
            "Nada se relajó"
          )}
        </Field>

        <Field label="Decisión" testId="campo-decision">
          {query.decision ? query.decision : <Dash />}
        </Field>

        <Field label="Conteos" testId="campo-conteos">
          {query.conteos ? (
            <span>
              calzan {query.conteos.calzan} · con existencia {query.conteos.conStock} · nombran moto{" "}
              {query.conteos.nombranMoto} · universales {query.conteos.universales}
            </span>
          ) : (
            <Dash />
          )}
        </Field>

        <Field label="Cotizado" testId="campo-cotizado">
          {query.cotizados === null ? (
            <Dash />
          ) : query.cotizados.length > 0 ? (
            <ul>
              {query.cotizados.map((p) => (
                <li key={p.productId}>
                  {p.nombre} · {p.stock === 0 ? "agotado" : plural(p.stock, "disponible", "disponibles")} · $
                  {p.precioUsd.toFixed(2)}
                </li>
              ))}
            </ul>
          ) : (
            "Nada cotizado"
          )}
        </Field>

        <Field label="Avisos" testId="campo-avisos">
          {query.avisos === null ? (
            <Dash />
          ) : query.avisos.length > 0 ? (
            <span className="ac-bq-chips">
              {query.avisos.map((notice, index) => (
                <span className="ac-badge" data-tone="wait" key={`${notice.tipo}-${index}`}>
                  {noticeText(notice)}
                </span>
              ))}
            </span>
          ) : (
            "Ninguno"
          )}
        </Field>

        <Field label="Escalada" testId="campo-escalada">
          {turn.escalationReason ?? "No escaló"}
        </Field>
      </dl>

      <div className="ac-bq-actions">
        <Link className="crm-pill" href={`/inbox?conversation=${turn.conversationId}`}>
          <MessageSquare size={13} />
          Abrir chat
        </Link>
        <button className="crm-pill" type="button" onClick={() => onTeach(query)}>
          <GraduationCap size={13} />
          Enseñar sinónimo
        </button>
      </div>
    </section>
  );
}

function TurnRow({ turn, onTeach }: { turn: CatalogSearchTurn; onTeach: (turn: CatalogSearchTurn, query: CatalogSearchQuery) => void }) {
  const [open, setOpen] = useState(false);

  const results = [...new Set(turn.consultas.map((q) => q.resultado).filter((r): r is CatalogSearchResult => r !== null))];
  const hasCorrection = turn.consultas.some((q) => q.corregido.length > 0);
  const hasRelax = turn.consultas.some((q) => (q.relajados ?? []).length > 0);
  const isList = turn.consultas.some((q) => q.productos !== null);
  const notices = new Set<CatalogNoticeType>();
  for (const q of turn.consultas) for (const n of q.avisos ?? []) notices.add(n.tipo);

  return (
    <li className="ac-bq-turn" data-open={open}>
      <button type="button" className="ac-bq-turn-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ac-bq-turn-main">
          <span className="ac-bq-turn-msg">{turn.customerMessage ?? DASH}</span>
          <span className="ac-bq-turn-meta">
            <span>{turn.contactName ?? "Sin contacto"}</span>
            <span>{dateTimeLabel(turn.createdAt)}</span>
            {turn.consultas.length > 1 && <span>{turn.consultas.length} búsquedas</span>}
          </span>
        </span>
        <span className="ac-bq-turn-tags">
          {results.map((result) => (
            <span className="ac-badge" data-tone={RESULT_TONE[result]} key={result}>
              {RESULT_LABEL[result]}
            </span>
          ))}
          {notices.size > 0 && (
            <span className="ac-badge" data-tone="wait">
              {plural(notices.size, "aviso", "avisos")}
            </span>
          )}
          {hasCorrection && (
            <span className="ac-badge" data-tone="plum">
              Corregida
            </span>
          )}
          {hasRelax && (
            <span className="ac-badge" data-tone="wait">
              Relajada
            </span>
          )}
          {isList && (
            <span className="ac-badge" data-tone="link">
              Lista
            </span>
          )}
          {turn.action === "escalated" && (
            <span className="ac-badge" data-tone="hot">
              Escaló
            </span>
          )}
        </span>
        <ChevronDown size={16} className="ac-bq-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="ac-bq-detail">
          {turn.consultas.map((query, index) => (
            <QueryDetail key={index} turn={turn} query={query} onTeach={(q) => onTeach(turn, q)} />
          ))}
        </div>
      )}
    </li>
  );
}

interface TeachTarget {
  key: string;
  conversationId: string | null;
  contextText: string;
  seed: string;
}

export function CatalogSearchesPanel({ currentAgent, lessons, refreshToken, onLessonsChanged }: CatalogSearchesPanelProps) {
  const [period, setPeriod] = useState<SearchPeriod>("hoy");
  const [retry, setRetry] = useState(0);

  // `undefined` = cargando; `null` (resumen/términos) = la RPC respondió null (no es agente).
  const [summary, setSummary] = useState<SearchSummary | null | undefined>(undefined);
  const [summaryError, setSummaryError] = useState<unknown>(null);
  const [turns, setTurns] = useState<CatalogSearchTurn[] | undefined>(undefined);
  const [turnsError, setTurnsError] = useState<unknown>(null);
  const [terms, setTerms] = useState<SearchTerms | null | undefined>(undefined);
  const [termsError, setTermsError] = useState<unknown>(null);

  const [filters, setFilters] = useState<SearchFilters>(EMPTY_SEARCH_FILTERS);
  const [teach, setTeach] = useState<TeachTarget | null>(null);
  // Cada apertura del modal es un montaje nuevo (`key`): los valores iniciales
  // solo cuentan al montar. Un contador y no `Date.now()`: es impuro.
  const teachSeq = useRef(0);
  const [protecting, setProtecting] = useState<string | null>(null);
  const [protectedNow, setProtectedNow] = useState<ReadonlySet<string>>(new Set());

  // Resumen (A) y lista (B): siguen el período elegido.
  useEffect(() => {
    let cancelado = false;
    const supabase = createClient();
    const desde = periodStart(period);

    fetchSearchSummary(supabase, desde)
      .then((next) => {
        if (cancelado) return;
        setSummary(next);
        setSummaryError(null);
      })
      .catch((error: unknown) => {
        if (!cancelado) setSummaryError(error);
      });

    fetchCatalogSearches(supabase, { desde, limit: TURNS_LIMIT })
      .then((next) => {
        if (cancelado) return;
        setTurns(next);
        setTurnsError(null);
      })
      .catch((error: unknown) => {
        if (!cancelado) setTurnsError(error);
      });

    return () => {
      cancelado = true;
    };
  }, [period, refreshToken, retry]);

  // Términos (C) y correcciones (D): siempre 30 días, no dependen del período.
  useEffect(() => {
    let cancelado = false;
    fetchSearchTerms(createClient(), periodStart("30"))
      .then((next) => {
        if (cancelado) return;
        setTerms(next);
        setTermsError(null);
      })
      .catch((error: unknown) => {
        if (!cancelado) setTermsError(error);
      });
    return () => {
      cancelado = true;
    };
  }, [refreshToken, retry]);

  const visibleTurns = useMemo(() => (turns ? filterSearchTurns(turns, filters) : []), [turns, filters]);

  const protectedWords = useMemo(() => {
    const words = new Set<string>(protectedNow);
    for (const lesson of lessons) {
      if (lesson.kind === "no_corregir" && lesson.isActive && lesson.synonymFrom) {
        words.add(lesson.synonymFrom.toLowerCase());
      }
    }
    return words;
  }, [lessons, protectedNow]);

  function changePeriod(next: SearchPeriod) {
    if (next === period) return;
    setPeriod(next);
    setSummary(undefined);
    setTurns(undefined);
  }

  function setFilter<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function teachFromQuery(turn: CatalogSearchTurn, query: CatalogSearchQuery) {
    setTeach({
      key: `${turn.id}-${(teachSeq.current += 1)}`,
      conversationId: turn.conversationId,
      contextText: turn.customerMessage?.trim() || query.query,
      seed: synonymSeed(query),
    });
  }

  function teachFromTerm(term: string, detail: string) {
    setTeach({
      key: `termino-${term}-${(teachSeq.current += 1)}`,
      conversationId: null,
      contextText: detail,
      seed: term,
    });
  }

  async function handleProtect(original: string) {
    setProtecting(original);
    try {
      await protectWordFromCorrection(createClient(), currentAgent, original);
      setProtectedNow((current) => new Set(current).add(original.toLowerCase()));
      toast.success(`Seba dejará de corregir «${original}».`);
      await onLessonsChanged?.();
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudo guardar. Intenta de nuevo."));
    } finally {
      setProtecting(null);
    }
  }

  const retryButton = (
    <button type="button" className="crm-pill" onClick={() => setRetry((n) => n + 1)}>
      Reintentar
    </button>
  );

  return (
    <div className="ac-bq">
      {/* ---------------------------------------------------------------- A */}
      <section className="dash-panel" aria-label="Resumen del período">
        <div className="ac-bq-head">
          <h2 className="dash-panel-title">Búsquedas del catálogo</h2>
          <span className="dash-panel-spacer" />
          <div className="ac-bq-periods" role="group" aria-label="Período">
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

        <div className="ac-bq-body">
          {summaryError ? (
            <div className="ac-bq-error" role="alert">
              <span>{loadErrorMessage(summaryError, "el resumen")}</span>
              {retryButton}
            </div>
          ) : summary === undefined ? (
            <p className="ac-bq-loading">Cargando…</p>
          ) : summary === null ? (
            <div className="ac-bq-error" role="alert">
              <span>No se pudo cargar el resumen: la base no reconoce tu sesión como asesor.</span>
            </div>
          ) : (
            <>
              <div className="ac-bq-stats">
                <Stat
                  testId="stat-busquedas"
                  value={summary.busquedas}
                  label="Búsquedas"
                  sub={`en ${plural(summary.turnos, "turno", "turnos")}`}
                />
                {RESULT_ORDER.filter(
                  (result) => summary.resultados[result] > 0 || (result !== "sin_terminos" && result !== "error")
                ).map((result) => (
                  <Stat key={result} testId={`stat-${result}`} value={summary.resultados[result]} label={RESULT_LABEL[result]} />
                ))}
              </div>

              <p className="ac-bq-subtitle">Avisos que se le dijeron al cliente</p>
              <div className="ac-bq-chips">
                {NOTICE_ORDER.map((tipo) => (
                  <span
                    className="ac-badge"
                    data-tone={summary.avisos[tipo] > 0 ? "wait" : "muted"}
                    data-testid={`stat-aviso-${tipo}`}
                    key={tipo}
                  >
                    {NOTICE_LABEL[tipo]} {summary.avisos[tipo]}
                  </span>
                ))}
              </div>

              <div className="ac-bq-stats" style={{ marginTop: 14 }}>
                <Stat testId="stat-correcciones" value={summary.correcciones} label="Correcciones" />
                <Stat testId="stat-descartadas" value={summary.descartadas} label="Descartadas por la guarda de producto" />
                <Stat
                  testId="stat-relajos"
                  value={summary.relajos}
                  label="Relajos"
                  sub={`${summary.relajosCotizaron} terminaron con existencia`}
                />
                <Stat testId="stat-cotizaciones" value={summary.cotizaciones} label="Cotizaciones" />
                <Stat testId="stat-productos" value={summary.productosDistintos} label="Productos distintos" />
              </div>

              {summary.v1 > 0 && (
                <p className="ac-bq-note">
                  {summary.v1} {summary.v1 === 1 ? "búsqueda del período es anterior" : "búsquedas del período son anteriores"} a
                  A2: no registran avisos, relajos ni cotizados, así que esos conteos no las incluyen.
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- B */}
      <section className="dash-panel" aria-label="Turnos del período">
        <div className="ac-bq-head">
          <h2 className="dash-panel-title">Turnos con búsqueda</h2>
          <span className="dash-panel-spacer" />
          {turns !== undefined && (
            <span className="dash-panel-note">
              {visibleTurns.length === turns.length
                ? plural(turns.length, "turno", "turnos")
                : `${visibleTurns.length} de ${turns.length} turnos`}
              {turns.length >= TURNS_LIMIT && ` · solo los últimos ${TURNS_LIMIT}`}
            </span>
          )}
        </div>

        <div className="ac-bq-filters">
          <select
            className="lm-select"
            aria-label="Filtrar por resultado"
            value={filters.resultado}
            onChange={(e) => setFilter("resultado", e.target.value as SearchFilters["resultado"])}
          >
            <option value="todos">Todos los resultados</option>
            {RESULT_ORDER.map((result) => (
              <option key={result} value={result}>
                {RESULT_LABEL[result]}
              </option>
            ))}
          </select>
          <select
            className="lm-select"
            aria-label="Filtrar por aviso"
            value={filters.aviso}
            onChange={(e) => setFilter("aviso", e.target.value as SearchFilters["aviso"])}
          >
            <option value="todos">Todos los avisos</option>
            {NOTICE_ORDER.map((tipo) => (
              <option key={tipo} value={tipo}>
                {NOTICE_LABEL[tipo]}
              </option>
            ))}
          </select>
          {(
            [
              ["conCorreccion", "Con corrección"],
              ["relajadas", "Relajadas"],
              ["listas", "Listas"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="crm-pill"
              data-variant={filters[key] ? "solid" : undefined}
              aria-pressed={filters[key]}
              onClick={() => setFilter(key, !filters[key])}
            >
              {label}
            </button>
          ))}
          <div className="ac-bq-search">
            <Input
              aria-label="Buscar en las búsquedas"
              placeholder="Buscar por cliente, pedido o producto"
              value={filters.texto}
              onChange={(e) => setFilter("texto", e.target.value)}
              fullWidth
            />
          </div>
          {hasActiveSearchFilters(filters) && (
            <button type="button" className="crm-pill" onClick={() => setFilters(EMPTY_SEARCH_FILTERS)}>
              Limpiar filtros
            </button>
          )}
        </div>

        {turnsError ? (
          <div className="ac-bq-body">
            <div className="ac-bq-error" role="alert">
              <span>{loadErrorMessage(turnsError, "los turnos")}</span>
              {retryButton}
            </div>
          </div>
        ) : turns === undefined ? (
          <div className="ac-bq-body">
            <p className="ac-bq-loading">Cargando…</p>
          </div>
        ) : turns.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">No hay búsquedas en este período</p>
            <p className="dash-empty-hint">Cuando Seba consulte el catálogo, cada turno aparece acá.</p>
          </div>
        ) : visibleTurns.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">Ningún turno pasa esos filtros</p>
            <p className="dash-empty-hint">Quita algún filtro para volver a ver la lista.</p>
          </div>
        ) : (
          <ul className="ac-bq-list">
            {visibleTurns.map((turn) => (
              <TurnRow key={turn.id} turn={turn} onTeach={teachFromQuery} />
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- C */}
      <section className="dash-panel" aria-label="Lo que Seba no encuentra">
        <div className="ac-bq-head">
          <h2 className="dash-panel-title">Lo que Seba no encuentra</h2>
          <span className="dash-panel-spacer" />
          <span className="dash-panel-note">Últimos 30 días</span>
        </div>
        <div className="ac-bq-body">
          <p className="ac-bq-note">
            Los términos obligatorios de las búsquedas que no dieron nada, y los que Seba tuvo que soltar para encontrar algo. Si el
            cliente los usa como jerga de un producto, enséñale el sinónimo.
          </p>
          {termsError ? (
            <div className="ac-bq-error" role="alert">
              <span>{loadErrorMessage(termsError, "los términos")}</span>
              {retryButton}
            </div>
          ) : terms === undefined ? (
            <p className="ac-bq-loading">Cargando…</p>
          ) : terms === null ? (
            <p className="ac-bq-loading">{DASH}</p>
          ) : terms.sinCalce.length === 0 ? (
            <p className="ac-bq-loading">Nada por ahora: ninguna búsqueda se quedó sin resultados en 30 días.</p>
          ) : (
            <ul className="ac-bq-rows">
              {terms.sinCalce.map((row) => {
                const meta = [
                  row.sinResultados > 0 ? plural(row.sinResultados, "sin resultado", "sin resultados") : null,
                  row.relajado > 0 ? plural(row.relajado, "relajado", "relajados") : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li className="ac-bq-row" key={row.termino}>
                    <div className="ac-bq-row-main">
                      <span className="ac-bq-row-term">{row.termino}</span>
                      <span className="ac-bq-row-meta">{meta}</span>
                      <span className="ac-bq-row-meta">última vez {dateLabel(row.ultima)}</span>
                    </div>
                    <button
                      type="button"
                      className="crm-pill"
                      aria-label={`Enseñar sinónimo de ${row.termino}`}
                      onClick={() => teachFromTerm(row.termino, `Se buscó «${row.termino}» y no calzó (${meta}).`)}
                    >
                      <GraduationCap size={13} />
                      Enseñar sinónimo
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- D */}
      <section className="dash-panel" aria-label="Correcciones">
        <div className="ac-bq-head">
          <h2 className="dash-panel-title">Correcciones del corrector</h2>
          <span className="dash-panel-spacer" />
          <span className="dash-panel-note">Últimos 30 días</span>
        </div>
        <div className="ac-bq-body">
          <p className="ac-bq-note">
            Palabras que Seba cambió por otra antes de buscar. Si una es legítima (no es un tipeo), «No corregir esta palabra» la protege
            para siempre; se puede apagar desde «Lecciones».
          </p>
          {termsError ? (
            <div className="ac-bq-error" role="alert">
              <span>{loadErrorMessage(termsError, "las correcciones")}</span>
            </div>
          ) : terms === undefined ? (
            <p className="ac-bq-loading">Cargando…</p>
          ) : terms === null ? (
            <p className="ac-bq-loading">{DASH}</p>
          ) : terms.correcciones.length === 0 ? (
            <p className="ac-bq-loading">Nada por ahora: el corrector no cambió ninguna palabra en 30 días.</p>
          ) : (
            <ul className="ac-bq-rows">
              {terms.correcciones.map((row) => {
                const ended = [
                  row.conExistencia > 0 ? `${row.conExistencia} con existencia` : null,
                  row.agotados > 0 ? plural(row.agotados, "agotado", "agotados") : null,
                  row.sinResultados > 0 ? plural(row.sinResultados, "sin resultado", "sin resultados") : null,
                  row.otros > 0 ? plural(row.otros, "otro", "otros") : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                const isProtected = protectedWords.has(row.original.toLowerCase());
                return (
                  <li className="ac-bq-row" key={`${row.original}->${row.corregido}`}>
                    <div className="ac-bq-row-main">
                      <span className="ac-bq-row-term">
                        {row.original} → {row.corregido}
                      </span>
                      <span className="ac-bq-row-meta">{plural(row.veces, "vez", "veces")}</span>
                      <span className="ac-bq-row-meta">Terminaron: {ended || DASH}</span>
                      <span className="ac-bq-row-meta">última vez {dateLabel(row.ultima)}</span>
                    </div>
                    {isProtected ? (
                      <span className="ac-badge" data-tone="good">
                        <ShieldCheck size={11} style={{ marginRight: 4 }} />
                        Protegida
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="crm-pill"
                        disabled={protecting === row.original}
                        onClick={() => handleProtect(row.original)}
                      >
                        No corregir esta palabra
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {teach && (
        <TeachSebaModal
          key={teach.key}
          isOpen
          agent={currentAgent}
          conversationId={teach.conversationId}
          contactId={null}
          contextText={teach.contextText}
          initialKind="sinonimo"
          initialSynonymFrom={teach.seed}
          onOpenChange={(open) => {
            if (!open) setTeach(null);
          }}
        />
      )}
    </div>
  );
}
