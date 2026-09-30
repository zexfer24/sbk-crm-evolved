import { searchTerms, normalizeForSearch } from "@/lib/message-search";
import { CRM_TIME_ZONE, currentDayRange } from "@/lib/time-zone";
import type {
  CatalogNoticeType,
  CatalogSearchQuery,
  CatalogSearchResult,
  CatalogSearchTurn,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Pestaña «Búsquedas» de Control IA (T9, plan "Seba no cotiza lo que no es",
// 30/9/2026): las reglas puras de la pantalla, separadas de React para
// probarlas sin levantar nada (mismo criterio que `inbox-filters.ts`).
//
// Una fila v1 (sin `v`, anterior a A2) trae `null` en todo lo que A2 sumó
// (avisos, relajos, cotizados…). Ninguna regla de acá trata ese `null` como
// «lista vacía que no calza»: para los filtros una fila v1 simplemente no
// tiene avisos ni relajos, pero la pantalla sigue distinguiendo «—» (no se
// registró) de «ninguno» (se registró y no hubo).
// ---------------------------------------------------------------------------

export const RESULT_LABEL: Record<CatalogSearchResult, string> = {
  con_existencia: "Con existencia",
  agotados: "Agotados",
  generico: "Pregunta de filtro",
  sin_resultados: "Sin resultados",
  sin_terminos: "Sin términos",
  error: "Error",
};

/** El tono del `.ac-badge` de cada resultado. */
export const RESULT_TONE: Record<CatalogSearchResult, "good" | "wait" | "link" | "hot" | "muted"> = {
  con_existencia: "good",
  agotados: "wait",
  generico: "link",
  sin_resultados: "hot",
  sin_terminos: "muted",
  error: "hot",
};

export const NOTICE_LABEL: Record<CatalogNoticeType, string> = {
  universales: "Universales",
  moto_sin_calce: "Moto sin calce",
  relajado: "Relajado",
  relajado_agotado: "Relajado agotado",
  variante_agotada: "Variante agotada",
  varias_opciones: "Varias opciones",
};

export const RESULT_ORDER: readonly CatalogSearchResult[] = [
  "con_existencia",
  "agotados",
  "generico",
  "sin_resultados",
  "sin_terminos",
  "error",
];

export const NOTICE_ORDER: readonly CatalogNoticeType[] = [
  "universales",
  "moto_sin_calce",
  "relajado",
  "relajado_agotado",
  "variante_agotada",
  "varias_opciones",
];

export type SearchPeriod = "hoy" | "7" | "30";

/**
 * Desde cuándo cuenta un período. «Hoy» es la medianoche de Caracas
 * (`currentDayRange`, el mismo corte del resto del CRM), NO la del navegador
 * ni la UTC: un asesor con el reloj en otra zona vería cambiar el día en otro
 * momento. 7 y 30 días son días corridos hacia atrás desde ahora.
 */
export function periodStart(period: SearchPeriod, now: Date = new Date()): string {
  if (period === "hoy") return currentDayRange(CRM_TIME_ZONE, now).from.toISOString();
  const days = period === "7" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export interface SearchFilters {
  resultado: CatalogSearchResult | "todos";
  aviso: CatalogNoticeType | "todos";
  conCorreccion: boolean;
  relajadas: boolean;
  listas: boolean;
  texto: string;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  resultado: "todos",
  aviso: "todos",
  conCorreccion: false,
  relajadas: false,
  listas: false,
  texto: "",
};

/** ¿Hay algún filtro activo? Para mostrar «Limpiar filtros». */
export function hasActiveSearchFilters(filters: SearchFilters): boolean {
  return (
    filters.resultado !== "todos" ||
    filters.aviso !== "todos" ||
    filters.conCorreccion ||
    filters.relajadas ||
    filters.listas ||
    filters.texto.trim() !== ""
  );
}

function haystackOf(turn: CatalogSearchTurn, query: CatalogSearchQuery): string {
  return normalizeForSearch(
    [
      turn.customerMessage ?? "",
      turn.contactName ?? "",
      query.query,
      ...(query.productos ?? []),
      ...(query.cotizados ?? []).map((product) => product.nombre),
    ].join(" ")
  );
}

/** ¿Esta búsqueda cumple TODOS los filtros? (Los filtros se combinan sobre la misma búsqueda.) */
function queryMatches(turn: CatalogSearchTurn, query: CatalogSearchQuery, filters: SearchFilters, words: string[]): boolean {
  if (filters.resultado !== "todos" && query.resultado !== filters.resultado) return false;
  if (filters.aviso !== "todos" && !(query.avisos ?? []).some((notice) => notice.tipo === filters.aviso)) return false;
  if (filters.conCorreccion && query.corregido.length === 0) return false;
  if (filters.relajadas && (query.relajados ?? []).length === 0) return false;
  if (filters.listas && query.productos === null) return false;
  if (words.length > 0) {
    const haystack = haystackOf(turn, query);
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

/** Pasa el turno si ALGUNA de sus búsquedas cumple todos los filtros. */
export function turnMatchesFilters(turn: CatalogSearchTurn, filters: SearchFilters): boolean {
  const words = searchTerms(filters.texto);
  return turn.consultas.some((query) => queryMatches(turn, query, filters, words));
}

export function filterSearchTurns(turns: readonly CatalogSearchTurn[], filters: SearchFilters): CatalogSearchTurn[] {
  return turns.filter((turn) => turnMatchesFilters(turn, filters));
}

/**
 * La palabra con la que se abre «Enseñar sinónimo» desde una búsqueda: el
 * primer término que D3 relajó (no estaba en el nombre de ningún producto) o,
 * si la búsqueda no encontró nada, el primer obligatorio. Si la búsqueda sí
 * encontró algo y nada se relajó no hay palabra que ofrecer: campo vacío, el
 * asesor la escribe. Una fila v1 no trae `relajados` (`null`): cae directo en
 * la segunda regla.
 */
export function synonymSeed(query: CatalogSearchQuery): string {
  const relajado = (query.relajados ?? [])[0];
  if (relajado) return relajado;
  if (query.resultado === "sin_resultados") return query.terminos[0] ?? "";
  return "";
}
