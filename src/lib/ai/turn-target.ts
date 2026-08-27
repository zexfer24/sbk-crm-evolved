import "server-only";
import { isDeliverablePhoneNumber } from "@/lib/whatsapp/phone";

// ---------------------------------------------------------------------------
// Identidad del turno: a qué chat y a qué cliente le estamos hablando.
//
// El riesgo que este archivo existe para cerrar es el peor de todos: mandarle
// a un cliente la respuesta que era de otro. No pasa hoy —la cola atiende una
// conversación por turno y el id viaja como argumento—, pero "no pasa hoy" es
// una propiedad del código actual, no una garantía. Acá se convierte en una:
//
//   - El envío NO acepta una conversación cualquiera. Acepta un TurnTarget,
//     que solo se construye pasando por la comprobación de abajo.
//   - El TurnTarget se arma UNA vez, al principio del turno, desde la fila que
//     se leyó por ese conversationId, y es el mismo objeto que llega al envío.
//     No hay índice, ni orden, ni variable de módulo en el medio.
//   - Está congelado: nada puede reapuntarlo a otro chat a mitad de turno.
//
// Si la identidad no cuadra, el turno aborta y queda registrado. No se envía.
// ---------------------------------------------------------------------------

/** La fila de `conversations` que el turno necesita, tal como llega de PostgREST. */
export interface AgentConversation {
  id: string;
  contact_id: string;
  ai_enabled: boolean;
  assigned_agent_id: string | null;
  /** null cuando nunca salió la plantilla de bienvenida: es lo que decide si el agente saluda. */
  welcome_sent_at: string | null;
  /** Decide si Meta todavía acepta texto libre en este chat. Ver withinFreeformWindow. */
  last_customer_message_at: string | null;
  contact: { phone_number: string };
  channel: { phone_number_id: string | null; status: string };
}

/**
 * Destinatario verificado del turno. Lo único que el envío acepta.
 *
 * Lleva junto todo lo que hace falta para entregar el mensaje —chat, cliente,
 * número, canal—, así que no hay forma de armar un envío tomando el texto de
 * un turno y el número de otro: o viene todo del mismo objeto, o no viene.
 */
export interface TurnTarget {
  readonly conversationId: string;
  readonly contactId: string;
  readonly phoneNumber: string;
  readonly phoneNumberId: string | null;
  readonly channelStatus: string;
}

/** La identidad del turno no se pudo verificar. El turno no envía nada. */
export class TurnIdentityError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, motivo: string) {
    super(`Identidad no verificable en la conversación ${conversationId}: ${motivo}`);
    this.name = "TurnIdentityError";
    this.conversationId = conversationId;
  }
}

/**
 * Construye el destinatario del turno, o lanza.
 *
 * `expectedConversationId` es el id que pidió la cola; `convo` es la fila que
 * volvió de la base. Que coincidan es la comprobación central: si alguna vez
 * se cuela una fila de otro chat —una consulta mal filtrada, un caché, un
 * cambio de firma— esto lo corta antes de que el mensaje salga, en vez de
 * después.
 */
export function buildTurnTarget(expectedConversationId: string, convo: AgentConversation): TurnTarget {
  if (!convo.id) {
    throw new TurnIdentityError(expectedConversationId, "la conversación volvió sin id");
  }
  if (convo.id !== expectedConversationId) {
    throw new TurnIdentityError(
      expectedConversationId,
      `la fila leída es del chat ${convo.id}, no del que pidió la cola`
    );
  }
  if (!convo.contact_id) {
    throw new TurnIdentityError(expectedConversationId, "la conversación no tiene contacto asociado");
  }
  // El embed `contact:contacts(phone_number)` puede volver vacío si el
  // contacto se borró entre la consulta y la respuesta. Sin número no hay a
  // quién escribirle, y un `undefined` acá termina en una llamada a Meta con
  // destinatario vacío.
  const phoneNumber = convo.contact?.phone_number;
  if (!phoneNumber) {
    throw new TurnIdentityError(expectedConversationId, "el contacto no trae número de teléfono");
  }
  // Tener algo guardado no es tener un teléfono. Un contacto con '+undefined'
  // pasaba esta comprobación y el turno corría entero —clasificar,
  // herramientas, redactar— para producir una llamada a Meta con destinatario
  // vacío. La identidad rota no se arregla sola, así que el turno no se
  // reintenta: sale como NonRetryableTurnError y deja de gastar cupos.
  if (!isDeliverablePhoneNumber(phoneNumber)) {
    throw new TurnIdentityError(
      expectedConversationId,
      `el contacto tiene "${phoneNumber}" donde debería ir un teléfono de WhatsApp`
    );
  }

  return Object.freeze({
    conversationId: convo.id,
    contactId: convo.contact_id,
    phoneNumber,
    phoneNumberId: convo.channel?.phone_number_id ?? null,
    channelStatus: convo.channel?.status ?? "disconnected",
  });
}
