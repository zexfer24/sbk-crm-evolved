import "server-only";

// ---------------------------------------------------------------------------
// Registro estructurado.
//
// `console.error("algo pasó:", err)` se lee bien en una terminal y es inútil
// en producción: no se puede filtrar por conversación, ni contar errores por
// tipo, ni alertar sobre uno en particular. Emitir una línea JSON por evento
// deja que Loki, Datadog, CloudWatch o el que sea lo indexe sin parsear texto.
//
// Sin dependencias: es stdout. El recolector es cosa del servidor.
// ---------------------------------------------------------------------------

type Level = "info" | "warn" | "error";

/**
 * Datos que acompañan al evento. Nunca metas acá el contenido de un mensaje
 * de cliente ni PII: estos registros salen del sistema y suelen guardarse más
 * tiempo que los datos que describen. Ids sí, contenido no.
 */
export type LogContext = Record<string, string | number | boolean | null | undefined>;

const REDACTED = "[oculto]";

/**
 * Claves cuyo valor no se imprime nunca, aunque alguien las pase por
 * descuido. La comprobación es por substring: cubre `apiKey`,
 * `WHATSAPP_ACCESS_TOKEN` y cualquier variante de mayúsculas.
 */
const SENSITIVE = ["token", "secret", "password", "apikey", "authorization", "cedula", "phone"];

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE.some((needle) => lower.includes(needle));
}

function sanitize(context: LogContext): LogContext {
  const clean: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    clean[key] = isSensitive(key) ? REDACTED : value;
  }
  return clean;
}

function emit(level: Level, event: string, context: LogContext = {}) {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...sanitize(context),
  });

  // stderr para warn y error: así el recolector los separa sin mirar el nivel.
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event: string, context?: LogContext) => emit("info", event, context),
  warn: (event: string, context?: LogContext) => emit("warn", event, context),
  error: (event: string, context?: LogContext) => emit("error", event, context),
};

/** Mensaje de un error desconocido, sin arrastrar el stack a los registros. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
