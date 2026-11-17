// ---------------------------------------------------------------------------
// Sombra y copiloto de Seba v2 (entrega 3 del rework de Seba, 17/11/2026).
// Módulo PURO: sin React ni Supabase. Aquí viven los tipos de lo que guardan
// `agent_shadow_drafts` y `shadow_reviews` (migración 20261117010000), los
// mappers tolerantes a jsonb raro, las reglas de la sugerencia de copiloto
// (cuándo se muestra, cuándo vence, qué se envía), los filtros del panel
// «Sombra» y sus números de cabecera. Las lecturas están en `shadow-data.ts` y
// las escrituras en `mutations.ts`.
//
// `database.types.ts` NO se usa acá a propósito: un jsonb llega como `Json`, y
// el panel tiene que sobrevivir a una fila rara (un `mensajes` que no es un
// arreglo) sin tumbar la lista entera.
// ---------------------------------------------------------------------------

import { isArea, type Area } from "@/lib/seba-v2-config";

/** Cuántos minutos vive una sugerencia de copiloto sin que nadie la use. */
export const SUGGESTION_TTL_MINUTES = 10;

// ------------------------------- Tipos -------------------------------------

export type ShadowMode = "sombra" | "copiloto";
export type SuggestionState = "pendiente" | "enviada" | "editada" | "descartada" | "vencida";
export type ShadowVerdict = "igual" | "cambio_menor" | "no";
export type ShadowMessageOrigin = "modelo" | "fijo" | "herramienta";

export interface ShadowMessage {
  orden: number;
  tipo: "texto" | "imagen";
  /** El texto del mensaje; en una imagen, su pie (o `null` si no lo trae). */
  texto: string | null;
  origen: ShadowMessageOrigin;
  mediaUrl: string | null;
}

export interface ShadowGuard {
  guarda: string;
  fragmento: string;
}

export interface ShadowDraft {
  id: string;
  conversationId: string;
  modo: ShadowMode;
  triggerMessageId: string | null;
  /** Los textos del cliente que el borrador respondía. */
  rafaga: string[];
  mensajes: ShadowMessage[];
  herramientas: string[];
  productos: string[];
  escalaria: boolean;
  motivo: string | null;
  area: Area | null;
  nota: string | null;
  guardas: ShadowGuard[];
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Cuántas llamadas al proveedor hizo el turno (`llamadas` es un arreglo en la base). */
  llamadas: number;
  durationMs: number | null;
  /** `null` en sombra (solo el copiloto tiene sugerencia). */
  sugerenciaEstado: SuggestionState | null;
  sugerenciaResueltaPor: string | null;
  sugerenciaResueltaAt: string | null;
  createdAt: string;
}

export interface ShadowReview {
  draftId: string;
  veredicto: ShadowVerdict;
  errorTipo: string | null;
  correccion: string | null;
  destino: string | null;
  reviewedBy: string;
  reviewedAt: string;
}

// ----------------------- Listas del formulario ------------------------------

export const VERDICTS: { value: ShadowVerdict; label: string }[] = [
  { value: "igual", label: "Igual" },
  { value: "cambio_menor", label: "Cambio menor" },
  { value: "no", label: "No" },
];

/**
 * Espejo EXACTO del CHECK `shadow_reviews_error_tipo_check` de la migración
 * 20261117010000. Un valor que la base no conoce rechaza el guardado con un
 * error de constraint que no le dice nada al supervisor.
 */
export const ERROR_TIPOS: { value: string; label: string }[] = [
  { value: "producto_equivocado", label: "Producto equivocado" },
  { value: "precio", label: "Precio" },
  { value: "tono", label: "Tono" },
  { value: "debio_pasar", label: "Debió pasar a un asesor" },
  { value: "no_debio_pasar", label: "No debió pasar a un asesor" },
  { value: "dato_inventado", label: "Dato inventado" },
  { value: "forma_de_pago", label: "Forma de pago" },
  { value: "otro", label: "Otro" },
];

/** Espejo EXACTO del CHECK `shadow_reviews_destino_check`. */
export const DESTINOS: { value: string; label: string }[] = [
  { value: "leccion", label: "Una lección de Seba" },
  { value: "caso_de_arnes", label: "Un caso del arnés" },
  { value: "prompt", label: "El prompt" },
  { value: "ninguno", label: "Ninguno" },
];

/** Tope de `shadow_reviews.correccion` (CHECK `shadow_reviews_correccion_length`). */
export const CORRECCION_MAX = 2000;

// ------------------------------ Mappers ------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const ORIGINS: readonly ShadowMessageOrigin[] = ["modelo", "fijo", "herramienta"];
const SUGGESTION_STATES: readonly SuggestionState[] = ["pendiente", "enviada", "editada", "descartada", "vencida"];

function mapMessages(value: unknown): ShadowMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ShadowMessage[] = [];
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    if (raw.tipo !== "texto" && raw.tipo !== "imagen") return;
    const origen = ORIGINS.find((o) => o === raw.origen) ?? "modelo";
    out.push({
      orden: asNumber(raw.orden) ?? index + 1,
      tipo: raw.tipo,
      texto: asString(raw.texto),
      origen,
      mediaUrl: asString(raw.mediaUrl),
    });
  });
  return out;
}

/** La herramienta puede llegar como texto o como un objeto con su nombre. */
function mapTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
    else if (isRecord(item)) {
      const name = asString(item.nombre) ?? asString(item.name) ?? asString(item.herramienta);
      if (name) out.push(name);
    }
  }
  return out;
}

function mapGuards(value: unknown): ShadowGuard[] {
  if (!Array.isArray(value)) return [];
  const out: ShadowGuard[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.guarda !== "string") continue;
    out.push({ guarda: item.guarda, fragmento: asString(item.fragmento) ?? "" });
  }
  return out;
}

/** Una fila cruda de `agent_shadow_drafts` (o el `new` de un evento Realtime). */
export function shadowDraftFromRow(row: Record<string, unknown>): ShadowDraft {
  const estado = SUGGESTION_STATES.find((s) => s === row.sugerencia_estado) ?? null;
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    modo: row.modo === "copiloto" ? "copiloto" : "sombra",
    triggerMessageId: asString(row.trigger_message_id),
    rafaga: asStringList(row.rafaga),
    mensajes: mapMessages(row.mensajes),
    herramientas: mapTools(row.herramientas),
    productos: asStringList(row.productos),
    escalaria: row.escalaria === true,
    motivo: asString(row.motivo),
    area: isArea(row.area) ? row.area : null,
    nota: asString(row.nota),
    guardas: mapGuards(row.guardas),
    model: asString(row.model),
    inputTokens: asNumber(row.input_tokens) ?? 0,
    outputTokens: asNumber(row.output_tokens) ?? 0,
    llamadas: Array.isArray(row.llamadas) ? row.llamadas.length : 0,
    durationMs: asNumber(row.duration_ms),
    sugerenciaEstado: estado,
    sugerenciaResueltaPor: asString(row.sugerencia_resuelta_por),
    sugerenciaResueltaAt: asString(row.sugerencia_resuelta_at),
    createdAt: String(row.created_at ?? ""),
  };
}

export function shadowReviewFromRow(row: Record<string, unknown>): ShadowReview {
  return {
    draftId: String(row.draft_id),
    veredicto: row.veredicto === "igual" || row.veredicto === "cambio_menor" ? row.veredicto : "no",
    errorTipo: asString(row.error_tipo),
    correccion: asString(row.correccion),
    destino: asString(row.destino),
    reviewedBy: String(row.reviewed_by ?? ""),
    reviewedAt: String(row.reviewed_at ?? ""),
  };
}

// ----------------------- Sugerencia de copiloto ----------------------------

interface SuggestionClock {
  now: Date;
  /** Fecha del último mensaje REAL de un asesor en la conversación, si hay. */
  lastAgentMessageAt: string | null;
}

function ageMinutes(draft: ShadowDraft, now: Date): number {
  return (now.getTime() - new Date(draft.createdAt).getTime()) / 60_000;
}

/** Algún asesor escribió DESPUÉS del borrador: la sugerencia ya no tiene a quién ayudar. */
function advisorWroteAfter(draft: ShadowDraft, lastAgentMessageAt: string | null): boolean {
  if (!lastAgentMessageAt) return false;
  return new Date(lastAgentMessageAt).getTime() > new Date(draft.createdAt).getTime();
}

/**
 * Se muestra sobre el composer solo si es de copiloto, sigue pendiente, tiene
 * menos de `SUGGESTION_TTL_MINUTES` y ningún asesor escribió después de ella.
 */
export function suggestionVisible(draft: ShadowDraft, clock: SuggestionClock): boolean {
  return (
    draft.modo === "copiloto" &&
    draft.sugerenciaEstado === "pendiente" &&
    ageMinutes(draft, clock.now) < SUGGESTION_TTL_MINUTES &&
    !advisorWroteAfter(draft, clock.lastAgentMessageAt)
  );
}

/** Pendiente que ya no se debe mostrar: cumplió el plazo o quedó detrás de un mensaje del asesor. */
export function suggestionExpired(draft: ShadowDraft, clock: SuggestionClock): boolean {
  if (draft.sugerenciaEstado !== "pendiente") return false;
  return ageMinutes(draft, clock.now) >= SUGGESTION_TTL_MINUTES || advisorWroteAfter(draft, clock.lastAgentMessageAt);
}

/**
 * Los textos que «Enviar» manda, en orden. Una imagen aporta su pie si lo trae;
 * sin pie se omite: en esta versión la foto no se reenvía (el borrador guarda
 * una URL, no el archivo del bucket que Meta pueda descargar).
 */
export function suggestionTexts(draft: ShadowDraft): string[] {
  return [...draft.mensajes]
    .sort((a, b) => a.orden - b.orden)
    .map((m) => (m.texto ?? "").trim())
    .filter((texto) => texto.length > 0);
}

/** Un pase a un asesor no se «envía», y sin ningún texto tampoco hay qué enviar. */
export function suggestionSendable(draft: ShadowDraft): boolean {
  return !draft.escalaria && suggestionTexts(draft).length > 0;
}

// ------------------------------ Filtros ------------------------------------

export interface ShadowFilters {
  /** ISO inclusive; `null` = sin cota. */
  desde: string | null;
  /** ISO exclusivo; `null` = sin cota. */
  hasta: string | null;
  veredicto: "todos" | ShadowVerdict | "sin_revisar";
  escalaria: "todos" | "si" | "no";
  area: Area | "todas";
  guarda: string | "todas";
}

export const EMPTY_SHADOW_FILTERS: ShadowFilters = {
  desde: null,
  hasta: null,
  veredicto: "todos",
  escalaria: "todos",
  area: "todas",
  guarda: "todas",
};

export function matchesShadowFilters(draft: ShadowDraft, review: ShadowReview | null, filters: ShadowFilters): boolean {
  const created = new Date(draft.createdAt).getTime();
  if (filters.desde && created < new Date(filters.desde).getTime()) return false;
  if (filters.hasta && created >= new Date(filters.hasta).getTime()) return false;

  if (filters.veredicto === "sin_revisar") {
    if (review) return false;
  } else if (filters.veredicto !== "todos") {
    if (review?.veredicto !== filters.veredicto) return false;
  }

  if (filters.escalaria === "si" && !draft.escalaria) return false;
  if (filters.escalaria === "no" && draft.escalaria) return false;

  if (filters.area !== "todas" && draft.area !== filters.area) return false;

  if (filters.guarda !== "todas" && !draft.guardas.some((g) => g.guarda === filters.guarda)) return false;

  return true;
}

export function hasActiveShadowFilters(filters: ShadowFilters): boolean {
  return (
    filters.veredicto !== "todos" ||
    filters.escalaria !== "todos" ||
    filters.area !== "todas" ||
    filters.guarda !== "todas"
  );
}

/** Los nombres distintos de guardas que dispararon en estos borradores, para el selector. */
export function guardNames(drafts: readonly ShadowDraft[]): string[] {
  const names = new Set<string>();
  for (const draft of drafts) for (const g of draft.guardas) names.add(g.guarda);
  return [...names].sort((a, b) => a.localeCompare(b, "es"));
}

// ------------------------------ Números ------------------------------------

export interface ShadowStats {
  borradores: number;
  revisados: number;
  /** % de revisados «igual» o «cambio menor». `null` sin revisados: se pinta «—», nunca 0. */
  aprobacionPct: number | null;
  /** Mediana de `duration_ms`. `null` sin datos. */
  medianaMs: number | null;
}

export function shadowStats(drafts: readonly ShadowDraft[], reviews: readonly ShadowReview[]): ShadowStats {
  const ids = new Set(drafts.map((d) => d.id));
  const revisadas = reviews.filter((r) => ids.has(r.draftId));
  const buenas = revisadas.filter((r) => r.veredicto === "igual" || r.veredicto === "cambio_menor").length;

  const duraciones = drafts
    .map((d) => d.durationMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  let medianaMs: number | null = null;
  if (duraciones.length > 0) {
    const mitad = Math.floor(duraciones.length / 2);
    medianaMs = duraciones.length % 2 === 1 ? duraciones[mitad] : (duraciones[mitad - 1] + duraciones[mitad]) / 2;
  }

  return {
    borradores: drafts.length,
    revisados: revisadas.length,
    aprobacionPct: revisadas.length > 0 ? (buenas / revisadas.length) * 100 : null,
    medianaMs,
  };
}

// ---------------------- Formulario de revisión -----------------------------

export interface ShadowReviewInput {
  veredicto: ShadowVerdict | null;
  errorTipo: string;
  correccion: string;
  destino: string;
}

export interface ShadowReviewErrors {
  veredicto?: string;
  errorTipo?: string;
  correccion?: string;
}

/**
 * `{}` = válido. «Igual» no exige nada más; «cambio menor» y «no» piden el tipo
 * de error y la corrección (sin ellas la revisión no le sirve a nadie para
 * mejorar a Seba). La corrección tiene el tope de la base. La corre el panel
 * antes de guardar y `saveShadowReview` otra vez como segunda barrera.
 */
export function validateShadowReview(input: ShadowReviewInput): ShadowReviewErrors {
  const errors: ShadowReviewErrors = {};
  if (!input.veredicto) {
    errors.veredicto = "Elige un veredicto.";
    return errors;
  }
  const correccion = input.correccion.trim();
  if (input.veredicto !== "igual") {
    if (!input.errorTipo) errors.errorTipo = "Elige qué tipo de error fue.";
    if (!correccion) errors.correccion = "Escribe cómo debió responder Seba.";
  }
  if (correccion.length > CORRECCION_MAX) {
    errors.correccion = `La corrección no puede pasar de ${CORRECCION_MAX} caracteres.`;
  }
  return errors;
}
