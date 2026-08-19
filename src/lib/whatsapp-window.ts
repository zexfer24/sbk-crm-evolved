const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta exige que el texto libre solo se envíe dentro de las 24h posteriores
 * al último mensaje del cliente. Pasado ese punto solo se pueden enviar
 * plantillas preaprobadas para "reabrir" la conversación.
 */
export function isWithin24hWindow(lastCustomerMessageAt: string | null, now: Date = new Date()): boolean {
  if (!lastCustomerMessageAt) return false;
  const last = new Date(lastCustomerMessageAt).getTime();
  return now.getTime() - last < WINDOW_MS;
}

export function hoursUntilWindowCloses(lastCustomerMessageAt: string | null, now: Date = new Date()): number {
  if (!lastCustomerMessageAt) return 0;
  const last = new Date(lastCustomerMessageAt).getTime();
  const remainingMs = WINDOW_MS - (now.getTime() - last);
  return Math.max(0, remainingMs / (60 * 60 * 1000));
}
