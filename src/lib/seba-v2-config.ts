// ---------------------------------------------------------------------------
// Configuración de Seba v2 que edita el supervisor (Entrega 2 de Seba v2, "Los
// datos del negocio", 16/11/2026). Módulo PURO: sin React ni Supabase. Aquí
// viven los tipos, las listas cerradas y las validaciones de lo que guardan
// `agent_settings` (modo, límites de la sombra, bienvenida, datos de Cashea) y
// `agents.areas`; las lecturas están en `data.ts` y las escrituras en
// `mutations.ts`.
//
// Las reglas espejan los CHECK de las migraciones 20261116020000 y
// 20261116030000: la base es la última barrera, pero un error de constraint en
// un toast no le dice nada al supervisor, así que se valida ANTES de escribir y
// con mensaje propio. Una excepción a propósito: el tope de 160 caracteres POR
// FRASE de la bienvenida lo valida solo la app (la base solo limita el total a
// 1280 = 8 x 160).
//
// Las longitudes se miden con `.length` de JS: un emoji cuenta 2 (par
// sustituto). La base mide en caracteres, o sea menos o igual, nunca más — así
// que lo que esta validación deja pasar la base lo acepta siempre.
// ---------------------------------------------------------------------------

// ------------------------------- Áreas -------------------------------------

export const AREAS = ["pagos", "ventas", "envios", "reclamos"] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABELS: Record<Area, string> = {
  pagos: "Pagos",
  ventas: "Ventas",
  envios: "Envíos",
  reclamos: "Reclamos",
};

export function isArea(value: unknown): value is Area {
  return typeof value === "string" && (AREAS as readonly string[]).includes(value);
}

/**
 * Lo que no sea un arreglo da `[]`. Descarta desconocidos y repetidos y
 * devuelve siempre en el orden de `AREAS`, para que dos lecturas de la misma
 * fila den el mismo resultado y la interfaz no baile.
 */
export function parseAreas(value: unknown): Area[] {
  if (!Array.isArray(value)) return [];
  const presentes = new Set<unknown>(value);
  return AREAS.filter((area) => presentes.has(area));
}

/** Enciende o apaga un área; siempre devuelve en el orden de `AREAS`, sin repetidos. */
export function toggleArea(areas: readonly Area[], area: Area, on: boolean): Area[] {
  const resultado = new Set<Area>(areas);
  if (on) resultado.add(area);
  else resultado.delete(area);
  return AREAS.filter((a) => resultado.has(a));
}

// ------------------------------- Modo --------------------------------------

export const SEBA_V2_MODES = ["apagado", "sombra", "copiloto", "fuera_de_horario", "siempre"] as const;
export type SebaV2Mode = (typeof SEBA_V2_MODES)[number];

/** Un valor desconocido cae a "apagado": nunca se inventa un modo que responda solo. */
export function parseSebaV2Mode(value: unknown): SebaV2Mode {
  return typeof value === "string" && (SEBA_V2_MODES as readonly string[]).includes(value)
    ? (value as SebaV2Mode)
    : "apagado";
}

export const SEBA_V2_MODE_LABELS: Record<SebaV2Mode, string> = {
  apagado: "Apagado",
  sombra: "Sombra",
  copiloto: "Copiloto",
  fuera_de_horario: "Fuera de horario",
  siempre: "Siempre",
};

export const SEBA_V2_MODE_DESCRIPTIONS: Record<SebaV2Mode, string> = {
  apagado: "Seba v2 no corre. Es el estado de fábrica.",
  sombra: "Redacta cada respuesta en silencio y la guarda para revisión. Al cliente no le llega nada.",
  copiloto: "Le propone la respuesta al asesor, que decide si la envía, la edita o la descarta.",
  fuera_de_horario: "Responde sola a los clientes cuando la tienda está cerrada.",
  siempre: "Responde sola a los clientes a toda hora.",
};

/**
 * true solo para "fuera_de_horario" y "siempre": los dos modos en que Seba le
 * escribe al cliente sin un asesor en medio. El panel pide confirmación antes
 * de pasar a uno de ellos.
 */
export function modeNeedsConfirmation(mode: SebaV2Mode): boolean {
  return mode === "fuera_de_horario" || mode === "siempre";
}

// ------------------------------- Lectura -----------------------------------

export interface SebaV2Config {
  modo: SebaV2Mode;
  shadowDailyCapUsd: number;
  shadowSamplePct: number;
  welcomeText: string;
  welcomeFollowups: string[];
  casheaDatosText: string;
  casheaMinimoUsd: number;
  casheaSeisCuotasDesdeUsd: number;
}

// ------------------------------- Límites -----------------------------------

export const WELCOME_TEXT_MAX = 1000;
export const FOLLOWUP_MAX_CHARS = 160;
export const FOLLOWUPS_MIN = 2;
export const FOLLOWUPS_MAX = 8;
export const CASHEA_TEXT_MAX = 1000;
/** `numeric(8,2)` en la base. */
export const USD_AMOUNT_MAX = 999999.99;

// ------------------------------- Bienvenida --------------------------------

export interface WelcomeDraft {
  welcomeText: string;
  followups: string[];
}

export interface WelcomeErrors {
  welcomeText?: string;
  followups?: string;
  /** Error por posición de la frase (índice en el arreglo normalizado). */
  followupItems?: Record<number, string>;
}

/** Quita espacios al principio y al final del texto y de cada frase. NO toca saltos de línea internos. */
export function normalizeWelcomeDraft(draft: WelcomeDraft): WelcomeDraft {
  return {
    welcomeText: draft.welcomeText.trim(),
    followups: draft.followups.map((frase) => frase.trim()),
  };
}

/** `{}` = válido. Valida sobre el borrador YA normalizado. */
export function validateWelcomeDraft(draft: WelcomeDraft): WelcomeErrors {
  const { welcomeText, followups } = normalizeWelcomeDraft(draft);
  const errors: WelcomeErrors = {};

  if (!welcomeText) errors.welcomeText = "Escribe el mensaje de bienvenida.";
  else if (welcomeText.length > WELCOME_TEXT_MAX) errors.welcomeText = "El mensaje no puede pasar de 1000 caracteres.";

  if (followups.length < FOLLOWUPS_MIN) {
    errors.followups = "Hacen falta al menos 2 frases: Seba no repite la misma dos veces seguidas.";
  } else if (followups.length > FOLLOWUPS_MAX) {
    errors.followups = "Máximo 8 frases.";
  }

  const porFrase: Record<number, string> = {};
  followups.forEach((frase, i) => {
    if (!frase) porFrase[i] = "Escribe la frase o quítala.";
    else if (frase.length > FOLLOWUP_MAX_CHARS) porFrase[i] = "La frase no puede pasar de 160 caracteres.";
  });
  if (Object.keys(porFrase).length > 0) errors.followupItems = porFrase;

  return errors;
}

export function hasWelcomeErrors(errors: WelcomeErrors): boolean {
  return (
    Boolean(errors.welcomeText) ||
    Boolean(errors.followups) ||
    Object.keys(errors.followupItems ?? {}).length > 0
  );
}

// ------------------------------- Montos ------------------------------------

type UsdParse = { ok: true; value: number } | { ok: false; error: string };

/**
 * Monto en dólares como lo escribe el supervisor: coma o punto decimal, hasta
 * dos decimales, entre 0 y `USD_AMOUNT_MAX`. No acepta separador de miles
 * ("1.000,50" no es un monto): mejor pedir que lo reescriba que adivinar si el
 * punto es de miles o decimal.
 */
function parseUsdAmount(text: string): UsdParse {
  const limpio = text.trim();
  const m = /^(-?)(\d*)(?:[.,](\d*))?$/.exec(limpio);
  if (!m || (m[2] === "" && !m[3])) return { ok: false, error: "Escribe un monto en dólares." };

  const [, signo, enteros, decimales = ""] = m;
  const value = Number(`${enteros || "0"}.${decimales || "0"}`);
  if (signo === "-" && value > 0) return { ok: false, error: "El monto no puede ser negativo." };
  if (decimales.length > 2) return { ok: false, error: "Usa como mucho dos decimales." };
  if (value > USD_AMOUNT_MAX) return { ok: false, error: "El monto es demasiado grande." };
  return { ok: true, value };
}

// ------------------------------- Sombra ------------------------------------

export type ShadowLimitsResult =
  | { ok: true; capUsd: number; samplePct: number }
  | { ok: false; errors: { capUsd?: string; samplePct?: string } };

export function parseShadowLimits(input: { capUsd: string; samplePct: string }): ShadowLimitsResult {
  const errors: { capUsd?: string; samplePct?: string } = {};

  const cap = parseUsdAmount(input.capUsd);
  if (!cap.ok) errors.capUsd = cap.error;

  const pctText = input.samplePct.trim();
  const pct = /^\d{1,3}$/.test(pctText) ? Number(pctText) : NaN;
  if (!(pct >= 0 && pct <= 100)) errors.samplePct = "Escribe un porcentaje entero entre 0 y 100.";

  if (!cap.ok || errors.samplePct) return { ok: false, errors };
  return { ok: true, capUsd: cap.value, samplePct: pct };
}

// ------------------------------- Cashea ------------------------------------

export type CasheaSettingsResult =
  | { ok: true; datosText: string; minimoUsd: number; seisCuotasDesdeUsd: number }
  | { ok: false; errors: { datosText?: string; minimoUsd?: string; seisCuotasDesdeUsd?: string } };

export function parseCasheaSettings(input: {
  datosText: string;
  minimoUsd: string;
  seisCuotasDesdeUsd: string;
}): CasheaSettingsResult {
  const errors: { datosText?: string; minimoUsd?: string; seisCuotasDesdeUsd?: string } = {};

  const datosText = input.datosText.trim();
  if (!datosText) errors.datosText = "Escribe el texto que pide los datos.";
  else if (datosText.length > CASHEA_TEXT_MAX) errors.datosText = "El texto no puede pasar de 1000 caracteres.";

  const minimo = parseUsdAmount(input.minimoUsd);
  if (!minimo.ok) errors.minimoUsd = minimo.error;

  const seis = parseUsdAmount(input.seisCuotasDesdeUsd);
  if (!seis.ok) errors.seisCuotasDesdeUsd = seis.error;

  if (!minimo.ok || !seis.ok || errors.datosText) return { ok: false, errors };
  return { ok: true, datosText, minimoUsd: minimo.value, seisCuotasDesdeUsd: seis.value };
}
