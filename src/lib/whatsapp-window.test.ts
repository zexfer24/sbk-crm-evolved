import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/types";
import {
  hoursUntilWindowCloses,
  isComposerWindowOpen,
  isWithin24hWindow,
  windowClosedByMeta,
} from "@/lib/whatsapp-window";

// ---------------------------------------------------------------------------
// Espejo en TypeScript del test SQL de T1 (misma corrida "La ventana de 24h
// dice la verdad", 7/9/2026): T1 cierra el candado en la base
// (`last_customer_message_at` deja de moverse con `unsupported`, y un
// saliente `failed` con 131047 la cierra a `created_at - 24h`); T2 es la red
// de seguridad del lado del cliente para el hueco entre ese rechazo y el
// próximo refresh por realtime, así que los nombres de los casos calcan los
// del test SQL a propósito -- el caso 6 (marcado ahí) es solo SQL y no tiene
// espejo acá.
//
// Caso real que motivó las dos corridas: la conversación `aa75ef33-…`
// (+593987317372) tenía la caja de texto habilitada y "quedan 11 h" mientras
// Meta rechazaba todo con 131047, porque un `unsupported` guardado como
// `inbound` movía `last_customer_message_at` sin que Meta lo contara para su
// propia ventana.
// ---------------------------------------------------------------------------

const HORA = 60 * 60 * 1000;
const AHORA = new Date("2026-09-07T12:00:00.000Z");
const AHORA_MS = AHORA.getTime();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function mensaje(over: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "text",
    content: "hola",
    templateName: null,
    mediaUrl: null,
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
    createdAt: iso(AHORA_MS - HORA),
    ...over,
  };
}

/** Un saliente rechazado por Meta con 131047 ("ventana de 24h cerrada"). */
function falloVentanaCerrada(over: Partial<Message> = {}): Message {
  return mensaje({
    direction: "outbound",
    senderType: "agent",
    messageType: "text",
    content: "texto libre",
    whatsappStatus: "failed",
    whatsappError: "Han pasado más de 24 horas desde el último mensaje del cliente.",
    whatsappErrorCode: 131047,
    ...over,
  });
}

describe("inbound text abre la ventana", () => {
  it("un mensaje de texto reciente del cliente deja la ventana abierta", () => {
    const mensajes = [mensaje({ direction: "inbound", messageType: "text", createdAt: iso(AHORA_MS - HORA) })];
    expect(windowClosedByMeta(mensajes)).toBe(false);
    expect(isComposerWindowOpen(iso(AHORA_MS - HORA), mensajes, AHORA)).toBe(true);
  });
});

describe("inbound unsupported no mueve la ventana", () => {
  it("un unsupported posterior a un fallo 131047 no reabre la ventana", () => {
    const fallo = falloVentanaCerrada({ createdAt: iso(AHORA_MS - 2 * HORA) });
    const unsupportedPosterior = mensaje({
      direction: "inbound",
      messageType: "unsupported",
      content: null,
      createdAt: iso(AHORA_MS - HORA),
    });
    const mensajes = [fallo, unsupportedPosterior];

    expect(windowClosedByMeta(mensajes)).toBe(true);
    expect(isComposerWindowOpen(iso(AHORA_MS - HORA), mensajes, AHORA)).toBe(false);
  });
});

describe("fallo saliente 131047 cierra la ventana a created_at menos 24h", () => {
  it("un failed 131047 sin inbound real posterior cierra la ventana aunque lcma sea reciente", () => {
    const fallo = falloVentanaCerrada({ createdAt: iso(AHORA_MS - HORA) });
    const mensajes = [mensaje({ direction: "inbound", messageType: "text", createdAt: iso(AHORA_MS - 3 * HORA) }), fallo];

    expect(windowClosedByMeta(mensajes)).toBe(true);
    // lcma reciente (lo que quedaría tras el `unsupported` del caso real) no
    // rescata la ventana: Meta ya la cerró.
    expect(isComposerWindowOpen(iso(AHORA_MS - HORA), mensajes, AHORA)).toBe(false);
  });
});

describe("fallo con otro código no toca la ventana", () => {
  it("131026 (número inválido, por ejemplo) deja la ventana abierta", () => {
    const falloOtroCodigo = falloVentanaCerrada({ whatsappErrorCode: 131026, createdAt: iso(AHORA_MS - HORA) });
    const mensajes = [falloOtroCodigo];

    expect(windowClosedByMeta(mensajes)).toBe(false);
    expect(isComposerWindowOpen(iso(AHORA_MS - HORA), mensajes, AHORA)).toBe(true);
  });
});

describe("tras el cierre por 131047 un inbound text la reabre", () => {
  it("un mensaje de texto real del cliente después del fallo reabre la ventana", () => {
    const fallo = falloVentanaCerrada({ createdAt: iso(AHORA_MS - 3 * HORA) });
    const textoPosterior = mensaje({ direction: "inbound", messageType: "text", createdAt: iso(AHORA_MS - HORA) });
    const mensajes = [fallo, textoPosterior];

    expect(windowClosedByMeta(mensajes)).toBe(false);
    expect(isComposerWindowOpen(iso(AHORA_MS - HORA), mensajes, AHORA)).toBe(true);
  });
});

describe("fallo 131047 insertado ya fallido cierra la ventana", () => {
  it("un mensaje con status failed desde el inicio (sin transición) cierra igual la ventana", () => {
    const fallo = falloVentanaCerrada({ createdAt: iso(AHORA_MS - HORA) });
    const mensajes = [fallo];

    expect(windowClosedByMeta(mensajes)).toBe(true);
    expect(isComposerWindowOpen(iso(AHORA_MS - HORA), mensajes, AHORA)).toBe(false);
  });
});

describe("fallo 131047 sin mensaje del cliente deja la ventana en null", () => {
  it("lastCustomerMessageAt null cierra la ventana sin necesidad de mirar los mensajes", () => {
    const fallo = falloVentanaCerrada({ createdAt: iso(AHORA_MS - HORA) });
    const mensajes = [fallo];

    expect(isComposerWindowOpen(null, mensajes, AHORA)).toBe(false);
  });
});

describe("fallo 131047 anterior al último mensaje del cliente no toca la ventana", () => {
  it("un inbound real posterior al fallo dentro de un hilo más largo deja la ventana abierta", () => {
    const falloViejo = falloVentanaCerrada({ createdAt: iso(AHORA_MS - 5 * HORA) });
    const textoReciente = mensaje({ direction: "inbound", messageType: "text", createdAt: iso(AHORA_MS - HORA) });
    const mensajes = [falloViejo, textoReciente];

    expect(windowClosedByMeta(mensajes)).toBe(false);
    expect(isComposerWindowOpen(iso(AHORA_MS - HORA), mensajes, AHORA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cobertura mínima de las dos funciones que ya existían y no cambiaron
// (`isWithin24hWindow`/`hoursUntilWindowCloses`), sin test propio hasta ahora.
// ---------------------------------------------------------------------------

describe("isWithin24hWindow / hoursUntilWindowCloses (sin cambios)", () => {
  it("sin lastCustomerMessageAt, la ventana está cerrada", () => {
    expect(isWithin24hWindow(null, AHORA)).toBe(false);
    expect(hoursUntilWindowCloses(null, AHORA)).toBe(0);
  });

  it("dentro de las 24h, abierta, con horas restantes positivas", () => {
    expect(isWithin24hWindow(iso(AHORA_MS - HORA), AHORA)).toBe(true);
    expect(hoursUntilWindowCloses(iso(AHORA_MS - HORA), AHORA)).toBeCloseTo(23, 5);
  });

  it("pasadas 24h, cerrada, con horas restantes en cero", () => {
    expect(isWithin24hWindow(iso(AHORA_MS - 25 * HORA), AHORA)).toBe(false);
    expect(hoursUntilWindowCloses(iso(AHORA_MS - 25 * HORA), AHORA)).toBe(0);
  });
});
