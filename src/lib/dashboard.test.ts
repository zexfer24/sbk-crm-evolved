import { describe, expect, it } from "vitest";
import { awaitingReply } from "@/lib/dashboard";
import type { BoardConversation } from "@/lib/types";

// ===========================================================================
// awaitingReply() distingue una respuesta real de una nota, un evento o una
// bienvenida (T0.2, plan "La bandeja que no pierde", 5/9/2026)
//
// Gemelo en SQL: `supabase/tests/awaiting_reply.sql` (mismo canal/conversación,
// nueve pasos cronológicos). Este archivo cubre los cuatro pasos de aquel que
// tocan justo la comparación que hace `awaitingReply()` en memoria —los otros
// (1, 3, 7, 8, 9) son mensaje entrante, evento de sistema, o tocan la base
// directamente (el CHECK de `conversation_handoffs.reason`) y no tienen nada
// nuevo que este lado deba probar—:
//
//   (2) nota interna de asesor        → sigue esperando
//   (4) bienvenida automática         → sigue esperando (aunque avance el
//                                        "último mensaje visible")
//   (5) salida de la IA rechazada     → sigue esperando
//       por Meta (whatsapp_status='failed')
//   (6) salida de la IA aceptada      → deja de esperar
//
// La base expresa "nota/evento/bienvenida/rechazo no cuentan" con un trigger
// que simplemente NO mueve `last_reply_at`. Acá se induce lo mismo dejando
// `lastReplyAt` en null (el trigger nunca lo tocó) salvo en (6), donde SÍ
// avanzó. `lastMessageAt` viaja también en los fixtures de (4)/(5) —avanza
// con cualquier mensaje visible, tal como hace la base— precisamente para
// dejar constancia de que `awaitingReply()` ya NO lo mira: si alguien
// reintrodujera esa comparación, (4) y (5) seguirían pasando por accidente
// salvo que la fecha de `lastMessageAt` se ponga MÁS VIEJA que el mensaje del
// cliente, que es justo lo que hacen estos dos casos.
// ===========================================================================

const T0 = Date.parse("2026-09-04T10:00:00.000Z"); // el cliente escribe
const MIN = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function conversacion(over: Partial<BoardConversation> = {}): BoardConversation {
  return {
    id: "conv-1",
    contact: { id: "contact-1", phoneNumber: "+580000000011", displayName: null, profileName: null },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: iso(T0),
    lastMessageAt: iso(T0),
    lastReplyAt: null,
    lastReplySender: null,
    hasReply: false,
    createdAt: iso(T0),
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...over,
  };
}

describe("awaitingReply — los cuatro casos espejo de awaiting_reply.sql", () => {
  it("paso 2 · nota interna de asesor: sigue esperando (la nota no mueve last_reply_at)", () => {
    // La nota es interna: ni siquiera es "visible" (no mueve last_message_at
    // en la base), así que acá el fixture ni la simula — solo importa que
    // lastReplyAt siga en null.
    const conversation = conversacion({
      lastCustomerMessageAt: iso(T0),
      lastMessageAt: iso(T0), // la nota no es visible: no avanza en la base tampoco
      lastReplyAt: null,
      lastReplySender: null,
    });

    expect(awaitingReply(conversation)).toBe(true);
  });

  it("paso 4 · bienvenida automática: sigue esperando aunque last_message_at haya avanzado", () => {
    const conversation = conversacion({
      lastCustomerMessageAt: iso(T0),
      // Sí es visible: el cliente la recibe, así que en la base avanza.
      lastMessageAt: iso(T0 + 15 * MIN),
      // Pero es `is_auto_reply`: el trigger nunca mueve last_reply_at con ella.
      lastReplyAt: null,
      lastReplySender: null,
    });

    expect(awaitingReply(conversation)).toBe(true);
  });

  it("paso 5 · salida de la IA rechazada por Meta (failed): sigue esperando", () => {
    const conversation = conversacion({
      lastCustomerMessageAt: iso(T0),
      // También visible (whatsapp_status='failed' no la esconde de la lista).
      lastMessageAt: iso(T0 + 20 * MIN),
      // El trigger exige whatsapp_status IS DISTINCT FROM 'failed' para mover
      // last_reply_at: un envío rechazado no cuenta como respuesta real.
      lastReplyAt: null,
      lastReplySender: null,
    });

    expect(awaitingReply(conversation)).toBe(true);
  });

  it("paso 6 · salida de la IA aceptada (sent): deja de esperar", () => {
    const conversation = conversacion({
      lastCustomerMessageAt: iso(T0),
      lastMessageAt: iso(T0 + 25 * MIN),
      lastReplyAt: iso(T0 + 25 * MIN),
      lastReplySender: "ai",
    });

    expect(awaitingReply(conversation)).toBe(false);
  });
});

describe("awaitingReply — bordes ya cubiertos indirectamente por el contrato de arriba", () => {
  it("sin lastCustomerMessageAt, false: falla cerrado sin importar lastReplyAt", () => {
    expect(conversacionSinCliente()).toBe(false);
  });

  function conversacionSinCliente() {
    return awaitingReply(conversacion({ lastCustomerMessageAt: null, lastReplyAt: null }));
  }

  it("lastReplyAt null con cliente esperando: true (nadie respondió todavía)", () => {
    expect(awaitingReply(conversacion({ lastCustomerMessageAt: iso(T0), lastReplyAt: null }))).toBe(true);
  });

  it("lastReplyAt EXACTO al lastCustomerMessageAt todavía cuenta como esperando (`<=`, mismo operador que la columna generada)", () => {
    // Mismo criterio que la columna generada de la base: `last_reply_at <=
    // last_customer_message_at` (con `<=`, no `<`) es "esperando". Solo una
    // respuesta ESTRICTAMENTE posterior al mensaje del cliente apaga
    // awaiting_reply.
    expect(
      awaitingReply(
        conversacion({
          lastCustomerMessageAt: iso(T0),
          lastReplyAt: iso(T0),
          lastReplySender: "agent",
        })
      )
    ).toBe(true);
  });
});
