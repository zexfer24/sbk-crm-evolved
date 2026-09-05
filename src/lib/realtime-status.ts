/**
 * Qué hacer cuando cambia el estado de un canal realtime (F9, 4/9/2026).
 *
 * `channel.subscribe((status, err) => …)` de `@supabase/realtime-js` avisa
 * cuatro estados: `SUBSCRIBED`, `TIMED_OUT`, `CLOSED`, `CHANNEL_ERROR`. Hasta
 * ahora ningún canal del CRM miraba ese callback: si el WebSocket se caía
 * (wifi del local, reinicio del proxy, el propio Supabase reiniciando
 * Realtime) la pestaña se quedaba mostrando lo último que alcanzó a bajar,
 * sin aviso y sin ponerse al día sola al reconectar — el asesor solo lo
 * notaba si recargaba a mano.
 *
 * Esta función es la decisión pura, sin efectos: dado el último estado
 * conocido y el que acaba de llegar, dice qué corresponde hacer. El hook que
 * la llama es quien guarda el estado anterior y quien ejecuta el log o el
 * refresco.
 */

/** Los cuatro estados que reporta `channel.subscribe`. */
export type RealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export type RealtimeAction = "none" | "log_down" | "resync";

const DOWN_STATUSES: ReadonlySet<RealtimeStatus> = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);

/**
 * `previous` es `null` antes de la primera notificación de este canal en
 * esta sesión (recién montado): un `SUBSCRIBED` ahí es la conexión inicial,
 * no una reconexión, así que no dispara resync.
 *
 * - Se cae por primera vez (antes no estaba caído) → `log_down`. Si ya
 *   estaba caído y llega OTRO estado caído (p. ej. `TIMED_OUT` después de
 *   `CHANNEL_ERROR`, reintentando solo), no se repite el log: sería ruido
 *   por cada intento fallido del propio cliente de Supabase.
 * - Vuelve `SUBSCRIBED` justo después de haber estado caído → `resync`: lo
 *   que se aplicó en memoria mientras el canal no escuchaba pudo quedarse
 *   corto, así que hace falta una puesta al día.
 * - `SUBSCRIBED` sin caída previa (la conexión inicial, o un doble aviso) no
 *   hace nada: ya está al día.
 */
export function nextRealtimeAction(
  previous: RealtimeStatus | null,
  status: RealtimeStatus
): RealtimeAction {
  const wasDown = previous !== null && DOWN_STATUSES.has(previous);

  if (DOWN_STATUSES.has(status)) {
    return wasDown ? "none" : "log_down";
  }

  if (status === "SUBSCRIBED") {
    return wasDown ? "resync" : "none";
  }

  return "none";
}
