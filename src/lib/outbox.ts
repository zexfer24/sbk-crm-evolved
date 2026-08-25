/**
 * Cola de envío de mensajes de texto.
 *
 * Antes, enviar era un `await` dentro del cuadro de texto: si el asesor
 * cambiaba de chat con el envío en vuelo, el mensaje quedaba atado a un
 * componente que ya no existía, y un fallo devolvía el texto al cuadro — de
 * un chat que quizás ya no era el abierto. Con la cola, el mensaje sale del
 * cuadro y pasa a ser responsabilidad de la bandeja: se entrega aunque el
 * asesor se mueva a otro chat, y si falla queda a la vista con su aviso y su
 * botón de reintentar, en el chat al que pertenece.
 *
 * Este módulo es solo la lógica (pura, sin red): quién sigue, qué pasa al
 * fallar, cuándo se limpia. El envío real lo dispara el shell del CRM.
 */

export type OutboxStatus = "queued" | "sending" | "failed" | "sent";

export interface OutboxItem {
  /** Id local, solo para seguirle la pista en la cola. No es el id del mensaje. */
  localId: string;
  conversationId: string;
  content: string;
  replyToMessageId: string | null;
  status: OutboxStatus;
  /** Qué dijo el servidor al fallar, para mostrarlo junto al aviso. */
  error: string | null;
  /** Cuándo se pulsó enviar: es la hora que ve el asesor en la burbuja. */
  createdAt: string;
  /** Id del mensaje real una vez que el servidor lo aceptó. */
  sentMessageId: string | null;
}

export function enqueueText(
  queue: OutboxItem[],
  conversationId: string,
  content: string,
  replyToMessageId: string | null
): OutboxItem[] {
  return [
    ...queue,
    {
      localId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      conversationId,
      content,
      replyToMessageId,
      status: "queued",
      error: null,
      createdAt: new Date().toISOString(),
      sentMessageId: null,
    },
  ];
}

/**
 * El próximo mensaje que puede salir.
 *
 * Dentro de una conversación el orden es sagrado: el cliente tiene que leer
 * los mensajes en el orden en que el asesor los escribió. Por eso uno en
 * vuelo ("sending") o caído ("failed") frena a los que vienen detrás en esa
 * misma conversación — un fallo no puede hacer que el segundo mensaje llegue
 * antes que el primero. Entre conversaciones distintas no hay orden que
 * cuidar, así que no se frenan entre sí.
 */
export function nextSendable(queue: OutboxItem[]): OutboxItem | null {
  return sendableHeads(queue)[0] ?? null;
}

/**
 * Todas las cabezas listas para salir: por cada conversación, su mensaje más
 * viejo sin entregar, solo si está "queued". El motor las dispara todas en un
 * mismo repaso — las conversaciones no se hacen cola entre sí.
 */
export function sendableHeads(queue: OutboxItem[]): OutboxItem[] {
  const conConversacionTomada = new Set<string>();
  const heads: OutboxItem[] = [];
  for (const item of queue) {
    if (item.status === "sent") continue;
    if (conConversacionTomada.has(item.conversationId)) continue;
    conConversacionTomada.add(item.conversationId);
    if (item.status === "queued") heads.push(item);
  }
  return heads;
}

export function markSending(queue: OutboxItem[], localId: string): OutboxItem[] {
  return queue.map((item) => (item.localId === localId ? { ...item, status: "sending" as const } : item));
}

export function markFailed(queue: OutboxItem[], localId: string, error: string | null): OutboxItem[] {
  return queue.map((item) => (item.localId === localId ? { ...item, status: "failed" as const, error } : item));
}

export function markSent(queue: OutboxItem[], localId: string, sentMessageId: string | null): OutboxItem[] {
  return queue.map((item) =>
    item.localId === localId ? { ...item, status: "sent" as const, error: null, sentMessageId } : item
  );
}

/** Vuelve a poner en cola un mensaje caído, en el lugar que ya ocupaba. */
export function retryItem(queue: OutboxItem[], localId: string): OutboxItem[] {
  return queue.map((item) =>
    item.localId === localId && item.status === "failed"
      ? { ...item, status: "queued" as const, error: null }
      : item
  );
}

export function discardItem(queue: OutboxItem[], localId: string): OutboxItem[] {
  return queue.filter((item) => item.localId !== localId);
}

/**
 * Saca de la cola los enviados cuyo mensaje real ya está en el hilo.
 *
 * Devuelve la misma referencia cuando no hay nada que limpiar: esto corre en
 * un efecto que depende del hilo cargado, y devolver siempre un array nuevo
 * armaría un bucle de renders sin cambios.
 */
export function pruneDelivered(queue: OutboxItem[], presentMessageIds: ReadonlySet<string>): OutboxItem[] {
  const kept = queue.filter(
    (item) => !(item.status === "sent" && item.sentMessageId && presentMessageIds.has(item.sentMessageId))
  );
  return kept.length === queue.length ? queue : kept;
}
