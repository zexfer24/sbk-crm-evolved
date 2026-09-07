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

/**
 * Único traductor de errores a texto de log.
 *
 * `err instanceof Error ? err.message : String(err)` aplastaba a
 * `"[object Object]"` los `PostgrestError` de supabase-js: en algunas
 * versiones no extienden `Error`, y aunque lo hagan, con dos copias del
 * paquete en el árbol (una del cliente admin, otra de una dependencia)
 * `instanceof` falla igual porque compara contra el `Error` de OTRA copia.
 * Medido en producción el 7/9/2026: `turno_lock_no_liberado`
 * (`conversation-lock.ts`) y `webhook_error_actualizar_estado`
 * (`api/webhooks/whatsapp/route.ts`) salían con `detail: "[object Object]"`
 * pese a llamar a `errorText` — el defecto estaba acá, no en los llamadores.
 * Por eso la regla no depende de `instanceof`: cualquier objeto con
 * `message` de tipo string (cubre `PostgrestError`, `AuthError`,
 * `StorageError` y cualquier `{ message }` suelto) se trata igual, tenga o
 * no el prototipo correcto.
 */
export function errorText(err: unknown): string {
  // El chequeo de `code` va ANTES que el de `instanceof Error` a propósito:
  // `PostgrestError` SÍ extiende `Error` en la copia de supabase-js que hoy
  // vive en node_modules, así que si el `instanceof` ganara primero el
  // código (`42501`, `PGRST301`...) se perdería igual que con el defecto
  // viejo. El resto de errores comunes de Node/JS no traen `code`, así que
  // no cambia nada para ellos.
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string") {
      const code = (err as { code?: unknown }).code;
      if ((typeof code === "string" || typeof code === "number") && String(code) !== "") {
        return `${code}: ${message}`;
      }
      if (message) return message;
    }
  }

  if (err instanceof Error) return err.message || err.name;

  if (typeof err === "string") return err;
  if (err === undefined) return "undefined";
  if (err === null) return "null";

  try {
    const json = JSON.stringify(err);
    if (json.length > 300) return `${json.slice(0, 300)}…`;
    return json;
  } catch {
    return String(err);
  }
}
