import { CRM_TIME_ZONE } from "@/lib/time-zone";

// ---------------------------------------------------------------------------
// "La tasa del BCV lleva demasiado sin actualizarse" — la regla, aparte de
// cualquier servidor para que la UI la importe sin arrastrar `server-only`.
//
// Historia: desde el 19/11/2026 cada lectura de bcv.org.ve falló (certificado
// nuevo del BCV) y nadie se enteró en dos días: el único aviso era un
// `console.error` por minuto. Y como se cargó la tasa a mano en
// `exchange_rates`, ni siquiera `isStale` se marcó. Por eso la alerta mira
// `bcv_fetch_status.last_success_at` (solo lo mueve una lectura REAL de la
// página) y no `exchange_rates`: una fila cargada a mano no cuenta como éxito.
// ---------------------------------------------------------------------------

/**
 * Horas sin una lectura buena a partir de las cuales hay alerta. El cron lee
 * a las 00/06/12/18 VE: más de 8 h sin éxito significa que ya se perdió al
 * menos un horario completo y van dos horas del siguiente sin poder leer
 * (6 h entre horarios + margen para reintentos).
 */
export const BCV_ALERTA_HORAS = 8;

/** Fila única de `bcv_fetch_status`, ya en camelCase. */
export interface BcvEstadoLectura {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface BcvAlerta {
  /** ISO del último éxito, o null si nunca hubo uno registrado. */
  desde: string | null;
  ultimoError: string | null;
}

/**
 * Alerta si el último éxito tiene MÁS de 8 h (estricto), o si no hay éxito
 * registrado y hay fallos. Sin estado (`null`: tabla inexistente, falla de
 * lectura) devuelve null — la app se comporta exactamente como antes.
 */
export function alertaDeTasa(estado: BcvEstadoLectura | null, ahora: Date = new Date()): BcvAlerta | null {
  if (!estado) return null;

  if (estado.lastSuccessAt) {
    const edadMs = ahora.getTime() - new Date(estado.lastSuccessAt).getTime();
    if (edadMs > BCV_ALERTA_HORAS * 3_600_000) {
      return { desde: estado.lastSuccessAt, ultimoError: estado.lastError };
    }
    return null;
  }

  // Sin ningún éxito registrado: solo es alerta si ya hubo fallos (si nada ha
  // corrido todavía, no hay nada de lo que avisar).
  if (estado.consecutiveFailures > 0) {
    return { desde: null, ultimoError: estado.lastError };
  }
  return null;
}

const FORMATO_DESDE = new Intl.DateTimeFormat("es-VE", {
  timeZone: CRM_TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * "18 nov., 6:00 p. m." en hora de Caracas. Según el ICU, Intl separa la hora
 * del "p. m." con un espacio fino sin salto (U+202F); se normaliza a un
 * espacio común para que el texto sea el mismo en toda máquina.
 */
export function formatearDesde(iso: string): string {
  return FORMATO_DESDE.format(new Date(iso)).replace(/[\u00a0\u202f]/g, " ");
}
