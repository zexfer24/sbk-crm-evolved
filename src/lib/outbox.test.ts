import { describe, expect, it } from "vitest";
import {
  discardItem,
  enqueueText,
  markFailed,
  markSending,
  markSent,
  nextSendable,
  pruneDelivered,
  retryItem,
  type OutboxItem,
} from "@/lib/outbox";

function cola(...pasos: Array<[conversationId: string, content: string]>): OutboxItem[] {
  return pasos.reduce<OutboxItem[]>((q, [conv, texto]) => enqueueText(q, conv, texto, null), []);
}

describe("outbox — el orden dentro de una conversación es sagrado", () => {
  it("ofrece primero el mensaje más viejo de la cola", () => {
    const q = cola(["a", "primero"], ["a", "segundo"]);
    expect(nextSendable(q)?.content).toBe("primero");
  });

  it("uno en vuelo frena a los que vienen detrás en su conversación", () => {
    let q = cola(["a", "primero"], ["a", "segundo"]);
    q = markSending(q, q[0].localId);
    expect(nextSendable(q)).toBeNull();
  });

  it("uno caído también frena a los suyos: un fallo no puede reordenar el hilo", () => {
    let q = cola(["a", "primero"], ["a", "segundo"]);
    q = markSending(q, q[0].localId);
    q = markFailed(q, q[0].localId, "sin red");
    expect(nextSendable(q)).toBeNull();
  });

  it("pero un fallo en un chat no frena los envíos de otro chat", () => {
    let q = cola(["a", "cae"], ["b", "sale igual"]);
    q = markFailed(q, q[0].localId, "sin red");
    expect(nextSendable(q)?.content).toBe("sale igual");
  });

  it("al completarse el primero, sigue el segundo de la misma conversación", () => {
    let q = cola(["a", "primero"], ["a", "segundo"]);
    q = markSent(q, q[0].localId, "msg-real-1");
    expect(nextSendable(q)?.content).toBe("segundo");
  });
});

describe("outbox — reintentar y descartar un mensaje caído", () => {
  it("reintentar lo devuelve a la cola en el lugar que ocupaba, sin el error viejo", () => {
    let q = cola(["a", "primero"], ["a", "segundo"]);
    q = markFailed(q, q[0].localId, "sin red");
    q = retryItem(q, q[0].localId);

    expect(nextSendable(q)?.content).toBe("primero");
    expect(q[0].error).toBeNull();
  });

  it("reintentar no toca mensajes que no estaban caídos", () => {
    let q = cola(["a", "en vuelo"]);
    q = markSending(q, q[0].localId);
    q = retryItem(q, q[0].localId);
    expect(q[0].status).toBe("sending");
  });

  it("descartar el caído desbloquea a los que esperaban detrás", () => {
    let q = cola(["a", "cae"], ["a", "esperando"]);
    q = markFailed(q, q[0].localId, "sin red");
    q = discardItem(q, q[0].localId);
    expect(nextSendable(q)?.content).toBe("esperando");
  });
});

describe("outbox — limpieza cuando el mensaje real ya está en el hilo", () => {
  it("saca de la cola los enviados que ya aparecen en la conversación", () => {
    let q = cola(["a", "hola"]);
    q = markSent(q, q[0].localId, "msg-real-1");
    const limpia = pruneDelivered(q, new Set(["msg-real-1"]));
    expect(limpia).toHaveLength(0);
  });

  it("no toca los enviados cuyo mensaje real todavía no llegó", () => {
    let q = cola(["a", "hola"]);
    q = markSent(q, q[0].localId, "msg-real-1");
    expect(pruneDelivered(q, new Set(["otro"]))).toHaveLength(1);
  });

  it("devuelve la misma referencia cuando no hay nada que limpiar, para no armar bucles de render", () => {
    let q = cola(["a", "hola"]);
    q = markSent(q, q[0].localId, "msg-real-1");
    expect(pruneDelivered(q, new Set(["otro"]))).toBe(q);
  });

  it("nunca limpia un mensaje caído: ese espera al asesor", () => {
    let q = cola(["a", "cae"]);
    q = markFailed(q, q[0].localId, "sin red");
    expect(pruneDelivered(q, new Set())).toBe(q);
  });
});
