import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { lecturaDeMediaActiva } from "@/lib/ai/media-reading-switch";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// El turno espera, un rato acotado, a que el webhook termine de leer los
// adjuntos recién llegados (plan "Seba lee fotos y audios", M6, 16/11/2026).
//
// El webhook escribe la fila de `message_readings` 1-4 s después de recibir
// una foto o una nota de voz, y la cola espera 2-6 s de silencio antes de
// atender: casi siempre la lectura ya está cuando el turno arranca. Pero "casi
// siempre" no alcanza — un turno que carga el historial MIENTRAS la lectura
// sigue en vuelo ve el marcador viejo ("no puedes verla") y le pide al cliente
// que escriba lo que acaba de decir. Esperar acá, antes de `loadHistory`,
// cierra esa carrera sin tocar la cola.
//
// Tres topes, todos medidos contra lo que el webhook de verdad tarda:
//   - `maxMs` (8 s): lo que se espera EN TOTAL. Pasado eso, el turno sigue con
//     el marcador viejo —peor que esperar poco no hay, un cliente sin
//     respuesta—; la lectura que llegue después la verá el turno siguiente.
//   - una fila `pendiente` de más de 120 s: quedó huérfana (el proceso que la
//     escribió murió en un deploy) y nunca va a resolverse; esperarla es
//     gastar los 8 s por nada, turno tras turno.
//   - un adjunto SIN fila de más de 20 s: el webhook no la escribió (lectura
//     apagada cuando llegó, descarga que falló antes de crearla); menos de 20 s
//     todavía puede estar bajando.
//
// NUNCA lanza: esto es una espera de cortesía, no una condición del turno.
// ---------------------------------------------------------------------------

const MAX_MS_DEFAULT = 8000;
const PASO_MS_DEFAULT = 400;
/** Una lectura `pendiente` más vieja que esto quedó huérfana de un deploy. */
const PENDIENTE_HUERFANA_MS = 120_000;
/** Un adjunto sin fila de lectura más viejo que esto ya no la va a tener. */
const SIN_FILA_MAX_MS = 20_000;
/** Ventana de mensajes recientes que se miran: lo anterior ya se resolvió o se perdió. */
const VENTANA_MS = 10 * 60 * 1000;
/** Cuántos adjuntos recientes se miran: una ráfaga de más de diez fotos no cambia la decisión. */
const MAX_ADJUNTOS = 10;

export interface EsperaDeLecturas {
  /** Cuánto se esperó en total, en ms. */
  esperadoMs: number;
  /** Cuántos adjuntos seguían sin lectura cuando se dejó de esperar. */
  pendientes: number;
}

interface OpcionesEspera {
  maxMs?: number;
  pasoMs?: number;
  /** Inyectables en tests: el reloj y la pausa. */
  ahora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

/** El embed de una relación uno a uno llega como objeto o `null`; por si un cliente lo trajera como arreglo, se toma el primero. */
function estadoDeLectura(embed: unknown): string | null {
  const lectura = Array.isArray(embed) ? embed[0] : embed;
  if (typeof lectura !== "object" || lectura === null) return null;
  const { status } = lectura as { status?: unknown };
  return typeof status === "string" ? status : null;
}

/** Cuántos adjuntos recientes del cliente siguen sin lectura Y todavía pueden recibirla. */
async function contarPendientes(
  admin: SupabaseClient<Database>,
  conversationId: string,
  ahora: () => number
): Promise<number> {
  const ahoraMs = ahora();
  const { data, error } = await admin
    .from("messages")
    .select("id, created_at, message_type, message_readings(status)")
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .in("message_type", ["audio", "image"])
    .gte("created_at", new Date(ahoraMs - VENTANA_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(MAX_ADJUNTOS);

  if (error) throw error;

  let pendientes = 0;
  for (const fila of data ?? []) {
    const antiguedadMs = ahoraMs - Date.parse(fila.created_at);
    const estado = estadoDeLectura(fila.message_readings);
    if (estado === "pendiente") {
      if (antiguedadMs < PENDIENTE_HUERFANA_MS) pendientes++;
    } else if (estado === null) {
      if (antiguedadMs < SIN_FILA_MAX_MS) pendientes++;
    }
  }
  return pendientes;
}

export async function esperarLecturas(
  admin: SupabaseClient<Database>,
  conversationId: string,
  opciones: OpcionesEspera = {}
): Promise<EsperaDeLecturas> {
  // Con la lectura apagada nunca hay filas: sin este corte, cada turno con un
  // adjunto esperaría los 8 s completos por una lectura que no va a llegar.
  if (!lecturaDeMediaActiva()) return { esperadoMs: 0, pendientes: 0 };

  const maxMs = opciones.maxMs ?? MAX_MS_DEFAULT;
  const pasoMs = opciones.pasoMs ?? PASO_MS_DEFAULT;
  const ahora = opciones.ahora ?? Date.now;
  const dormir = opciones.dormir ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Se cuenta por pasos y no con el reloj: lo que se devuelve (y se loguea) es
  // lo que el turno de verdad durmió, y un `dormir` que no avanza el reloj no
  // puede dejar el bucle sin salida.
  let esperadoMs = 0;
  let pendientes = 0;
  try {
    for (;;) {
      pendientes = await contarPendientes(admin, conversationId, ahora);
      if (pendientes === 0 || esperadoMs + pasoMs > maxMs) break;
      await dormir(pasoMs);
      esperadoMs += pasoMs;
    }
  } catch (err) {
    log.warn("espera_lecturas_fallo", { conversationId, detail: errorText(err) });
    return { esperadoMs, pendientes: 0 };
  }

  if (esperadoMs > 0) log.info("turno_espero_lecturas", { conversationId, esperadoMs, pendientes });
  return { esperadoMs, pendientes };
}
