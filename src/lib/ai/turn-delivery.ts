import "server-only";

// ---------------------------------------------------------------------------
// La barrera que impide que un cliente reciba el mismo mensaje dos veces.
//
// El turno hace varias cosas después de enviar: actualiza la conversación,
// escala, etiqueta, escribe la bitácora. Cualquiera de esas puede fallar —un
// corte con Supabase alcanza—, y hasta ahora esa excepción subía a la cola,
// que contaba un intento fallido y RE-ENCOLABA la conversación. El reintento
// corría el turno desde cero: clasificaba otra vez y enviaba otra vez. El
// cliente recibía el mensaje dos veces (hasta tres, con MAX_ATTEMPTS) por un
// fallo que no tenía nada que ver con el mensaje.
//
// La regla es la del negocio, no la del código: preferimos un turno marcado
// como fallido a un cliente leyendo lo mismo dos veces. Un turno fallido lo
// ve un humano en la bitácora; un duplicado lo ve el cliente.
//
// Sin clave de idempotencia en el envío no hay forma de reintentar sin
// arriesgar el duplicado, así que en cuanto el turno INTENTA entregar algo,
// deja de ser reintentable. Se marca antes de enviar y no después a propósito:
// si el envío falla a mitad no sabemos si el mensaje salió, y ante la duda se
// da por salido.
// ---------------------------------------------------------------------------

/** Registro de si este turno ya intentó ponerle algo delante al cliente. */
export interface TurnDelivery {
  intentado: boolean;
}

export function newTurnDelivery(): TurnDelivery {
  return { intentado: false };
}

/**
 * El turno falló, pero volver a correrlo haría más daño que dejarlo fallido.
 *
 * La cola la registra y la abandona en vez de re-encolarla (ver queue.ts).
 */
export class NonRetryableTurnError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableTurnError";
    this.conversationId = conversationId;
  }
}

export function isNonRetryable(err: unknown): err is NonRetryableTurnError {
  return err instanceof NonRetryableTurnError;
}
