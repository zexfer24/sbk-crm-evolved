import type { Message } from "@/lib/types";

// Exportada para que otros módulos (claimWelcome en el webhook, que reclama
// el envío de la bienvenida contra este mismo corte de 24h) no dupliquen el
// número.
export const WINDOW_MS = 24 * 60 * 60 * 1000;

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

/** Lo mínimo que necesita `windowClosedByMeta`/`isComposerWindowOpen` de un mensaje. */
type WindowMessage = Pick<Message, "direction" | "messageType" | "whatsappStatus" | "whatsappErrorCode" | "createdAt">;

/**
 * Espejo en TypeScript del candado que T1 puso en la base (corrida "La
 * ventana de 24h dice la verdad", 7/9/2026): cuando Meta rechaza un saliente
 * con el código 131047 ("re-engagement message" — la ventana de 24h ya
 * cerró del lado de Meta) es Meta la que manda la última palabra, así que el
 * CRM le cree aunque `last_customer_message_at` diga que todavía queda
 * tiempo.
 *
 * Caso real que motivó esto (6/9/2026): la conversación `aa75ef33-…`
 * (+593987317372) mostraba la caja de texto habilitada y "quedan 11 h"
 * mientras Meta rechazaba todo con 131047. La causa: un mensaje
 * `unsupported` de Meta se guardaba como `inbound` y movía
 * `last_customer_message_at` -- pero Meta nunca contó ese aviso para su
 * propia ventana de 24h, así que el reloj del CRM y el de Meta discrepaban.
 *
 * Esta función es la red de seguridad del lado del cliente para el hueco
 * entre ese rechazo y el próximo refresh por realtime (o una desconexión del
 * canal): sin ella el composer sigue creyendo que la ventana está abierta
 * hasta que algo la refresque.
 *
 * Regla, espejo de la de la base: el saliente MÁS RECIENTE con
 * `whatsappStatus === 'failed' && whatsappErrorCode === 131047` cierra la
 * ventana, salvo que exista un entrante POSTERIOR a ese fallo que no sea
 * `unsupported` -- un `unsupported` no reabre, es justo lo que causó el bug
 * de arriba. El array no viene garantizado en orden: se ordena por
 * `createdAt` antes de mirar nada.
 */
export function windowClosedByMeta(messages: WindowMessage[]): boolean {
  const ordenados = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  let ultimoFallo131047: WindowMessage | null = null;
  for (const mensaje of ordenados) {
    if (mensaje.direction === "outbound" && mensaje.whatsappStatus === "failed" && mensaje.whatsappErrorCode === 131047) {
      ultimoFallo131047 = mensaje;
    }
  }
  if (!ultimoFallo131047) return false;

  const falloEnMs = new Date(ultimoFallo131047.createdAt).getTime();
  const reabreDespues = ordenados.some(
    (mensaje) =>
      mensaje.direction === "inbound" &&
      mensaje.messageType !== "unsupported" &&
      new Date(mensaje.createdAt).getTime() > falloEnMs
  );
  return !reabreDespues;
}

/**
 * Lo que de verdad decide si el composer deja escribir texto libre: la
 * ventana calculada en memoria (`isWithin24hWindow`) Y que Meta no haya
 * avisado ya que la cerró (`windowClosedByMeta`). La primera pata sola no
 * alcanza -- es la que se equivocaba en el caso real del 6/9/2026 de arriba,
 * confiando en `last_customer_message_at` aunque Meta ya hubiera rechazado
 * el envío con 131047.
 */
export function isComposerWindowOpen(
  lastCustomerMessageAt: string | null,
  messages: WindowMessage[],
  now: Date = new Date()
): boolean {
  return isWithin24hWindow(lastCustomerMessageAt, now) && !windowClosedByMeta(messages);
}
