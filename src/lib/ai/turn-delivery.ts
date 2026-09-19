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

// ---------------------------------------------------------------------------
// T12, plan "Seba sale sin pisar a nadie" (19/9/2026, cierra la decisión
// abierta #1): la ÚNICA excepción a la regla de arriba — es seguro reintentar
// un turno que ya "intentó entregar algo" cuando lo único que salió fue la
// presentación de Seba (`seba.ts`).
//
// Por qué es distinto de cualquier otro envío: `claimPresentation` (agent.ts)
// sella `welcome_sent_at` ANTES de mandarla, así que el reintento no puede
// volver a presentarse — y `runTurnPhases` reconoce, al arrancar, que la
// última línea del historial ya es esa presentación (`isSebaGreeting`,
// seba.ts) y la recorta antes de calcular nada más: el reintento ve
// exactamente lo que vio el primer intento, sin el saludo, y contesta lo que
// faltó. Ningún `deliver()` vive fuera de agent.ts —las herramientas del tool
// loop no le mandan nada al cliente por su cuenta—, así que si el turno cae
// DESPUÉS de la presentación (clasificando, o dentro del tool loop) no hay
// ningún otro mensaje que un reintento pudiera duplicar.
//
// La cola (queue.ts) NO se toca: ya sabe reintentar un error común
// (`recordFailure` → `RETRY_AFTER_ERROR_SECONDS`, hasta `MAX_ATTEMPTS`), y
// esta clase deliberadamente NO es `NonRetryableTurnError` para que la cola
// la trate así — `isNonRetryable` no la reconoce, y `queue.ts` la reencola
// como cualquier fallo transitorio.
// ---------------------------------------------------------------------------

/**
 * El turno falló DESPUÉS de que Seba ya se presentó, y es seguro reintentar:
 * `agent.ts` la lanza desde las dos salidas que hoy pueden caer justo
 * después del saludo (clasificar la intención, o el tool loop) cuando
 * `introducedThisTurn` es `true`.
 */
export class ProviderFailedAfterGreetingError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderFailedAfterGreetingError";
    this.conversationId = conversationId;
  }
}

export function isProviderFailedAfterGreeting(err: unknown): err is ProviderFailedAfterGreetingError {
  return err instanceof ProviderFailedAfterGreetingError;
}
