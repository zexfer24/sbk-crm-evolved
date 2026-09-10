import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import {
  awaitingReply,
  buildJourney,
  isStalled,
  stageDetail,
  stageOf,
  waitingMinutes,
} from "@/lib/dashboard";
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

// ===========================================================================
// stageOf / waitingMinutes / isStalled / buildJourney — el recorrido que
// describe el operador y el reloj único del atasco (Frente A, "El reloj
// dice la verdad", 5/9/2026, anexo A1).
//
// `NOW` cae un viernes a las 3 pm hora de Caracas (dentro del horario
// laboral por defecto, lunes a viernes 8 am a 6 pm) para que los casos que
// no tocan horario laboral no tengan que pensar en él.
// ===========================================================================

const NOW = Date.parse("2026-09-04T19:00:00.000Z"); // viernes 3:00 pm America/Caracas
const HORA = 60 * MIN;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

describe("stageOf — la escalera nueva, un peldaño a la vez", () => {
  it("1. hay asesor asignado → assigned, sin importar el resto", () => {
    const conversation = conversacion({
      assignedAgent: { id: "agente-1", displayName: "Pedro" },
      journeyStage: "classifying",
      activeTool: "buscar_producto",
      lastCustomerMessageAt: isoAt(NOW - 5 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(conversation)).toBe("assigned");
  });

  it("2. espera respuesta y hay herramienta corriendo (activeTool) → tool_running", () => {
    const conversation = conversacion({
      assignedAgent: null,
      activeTool: "buscar_producto",
      lastCustomerMessageAt: isoAt(NOW - 1 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(conversation)).toBe("tool_running");
  });

  it("2b. espera respuesta y journey_stage = tool_running (sin activeTool en vivo) → tool_running", () => {
    const conversation = conversacion({
      assignedAgent: null,
      activeTool: null,
      journeyStage: "tool_running",
      lastCustomerMessageAt: isoAt(NOW - 1 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(conversation)).toBe("tool_running");
  });

  it("3. espera respuesta, journey_stage = classifying y la IA sigue activa → classifying", () => {
    const conversation = conversacion({
      assignedAgent: null,
      activeTool: null,
      journeyStage: "classifying",
      aiEnabled: true,
      lastCustomerMessageAt: isoAt(NOW - 1 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(conversation)).toBe("classifying");
  });

  it("3b. classifying SIN awaitingReply es un resto congelado: cae a inquiry", () => {
    // Punto 4 del diagnóstico: `rejectedByMeta` en agent.ts podía devolver
    // antes de resetear `journey_stage`, dejando "Clasificando" congelado
    // sobre un chat que ya recibió respuesta real. A3 corrige el origen;
    // acá se prueba que `stageOf` no lo honra de todos modos.
    const conversation = conversacion({
      assignedAgent: null,
      journeyStage: "classifying",
      aiEnabled: true,
      lastCustomerMessageAt: isoAt(NOW - 20 * MIN),
      lastReplyAt: isoAt(NOW - 10 * MIN), // respuesta real, posterior al cliente
      lastReplySender: "ai",
    });

    expect(stageOf(conversation)).toBe("inquiry");
  });

  it("4. (regla cambiada el 10/9/2026, 'Los números del día') recibió la bienvenida y no ha vuelto a escribir → first_contact, YA NO exige !awaitingReply", () => {
    // Hasta el 9/9/2026 este peldaño exigía `!awaitingReply` (alguien ya
    // había respondido de verdad y el cliente calló). El operador lo cambió:
    // ahora "Primer contacto" describe al lead nuevo ANTES de esa respuesta,
    // así que el peldaño tiene que calzar con o sin ella.
    const conRespuesta = conversacion({
      assignedAgent: null,
      welcomeSentAt: isoAt(NOW - 5 * MIN),
      lastCustomerMessageAt: isoAt(NOW - 10 * MIN), // anterior a la bienvenida
      lastReplyAt: isoAt(NOW - 5 * MIN),
      lastReplySender: "ai",
    });
    expect(awaitingReply(conRespuesta)).toBe(false);
    expect(stageOf(conRespuesta)).toBe("first_contact");

    const sinRespuesta = conversacion({
      assignedAgent: null,
      welcomeSentAt: isoAt(NOW - 5 * MIN),
      lastCustomerMessageAt: isoAt(NOW - 10 * MIN),
      lastReplyAt: null,
    });
    expect(awaitingReply(sinRespuesta)).toBe(true);
    expect(stageOf(sinRespuesta)).toBe("first_contact");
  });

  it("5. todo lo demás → inquiry (el cliente pregunta y espera)", () => {
    const conversation = conversacion({
      assignedAgent: null,
      welcomeSentAt: null,
      lastCustomerMessageAt: isoAt(NOW - 20 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(conversation)).toBe("inquiry");
  });

  it("5b. todo lo demás → inquiry también cuando el cliente calló tras la respuesta de la IA", () => {
    const conversation = conversacion({
      assignedAgent: null,
      welcomeSentAt: null, // sin bienvenida: el peldaño 4 no aplica
      lastCustomerMessageAt: isoAt(NOW - 16 * HORA),
      lastReplyAt: isoAt(NOW - 15 * HORA),
      lastReplySender: "ai",
    });

    expect(awaitingReply(conversation)).toBe(false);
    expect(stageOf(conversation)).toBe("inquiry");
  });

  it("first_contact YA NO es 'nunca se atasca' (regla cambiada el 10/9/2026, stallMinutes pasó de null a 15): con respuesta real ya enviada la pelota volvió al cliente y sigue sin atascarse, pero sin respuesta sí se atasca pasados 15 min", () => {
    const conRespuesta = conversacion({
      assignedAgent: null,
      welcomeSentAt: isoAt(NOW - 48 * HORA),
      lastCustomerMessageAt: isoAt(NOW - 49 * HORA),
      lastReplyAt: isoAt(NOW - 48 * HORA),
      lastReplySender: "ai",
    });

    expect(stageOf(conRespuesta)).toBe("first_contact");
    // No es el `stallMinutes: null` de antes lo que la salva: es que
    // `awaitingReply` es false (ya hubo respuesta real) y `waitingMinutes`
    // devuelve null para cualquier etapa en ese caso.
    expect(waitingMinutes(conRespuesta, NOW)).toBeNull();
    expect(isStalled(conRespuesta, NOW)).toBe(false);

    const sinRespuesta = conversacion({
      assignedAgent: null,
      welcomeSentAt: isoAt(NOW - 20 * MIN),
      lastCustomerMessageAt: isoAt(NOW - 20 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(sinRespuesta)).toBe("first_contact");
    expect(waitingMinutes(sinRespuesta, NOW)).toBeCloseTo(20, 5);
    expect(isStalled(sinRespuesta, NOW)).toBe(true);
  });

  it("un lastReplyAt posterior al del cliente apaga la espera: waitingMinutes null", () => {
    const conversation = conversacion({
      lastCustomerMessageAt: isoAt(NOW - 30 * MIN),
      lastReplyAt: isoAt(NOW - 20 * MIN),
      lastReplySender: "agent",
    });

    expect(awaitingReply(conversation)).toBe(false);
    expect(waitingMinutes(conversation, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tabla de casos del artefacto "El reloj dice la verdad" (sección 8):
// Diana, Carlos, Laura, Ana (x2), "Cliente de prueba", Roberto.
// ---------------------------------------------------------------------------

describe("waitingMinutes / isStalled — tabla de casos del artefacto", () => {
  it("Diana: espera 20 min sin bienvenida → inquiry atascada (umbral 15)", () => {
    const diana = conversacion({
      id: "diana",
      assignedAgent: null,
      welcomeSentAt: null,
      lastCustomerMessageAt: isoAt(NOW - 20 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(diana)).toBe("inquiry");
    expect(waitingMinutes(diana, NOW)).toBeCloseTo(20, 5);
    expect(isStalled(diana, NOW)).toBe(true);
  });

  it("Carlos: la IA respondió y el cliente calló 16 h → inquiry NO atascada, waitingMinutes null", () => {
    const carlos = conversacion({
      id: "carlos",
      assignedAgent: null,
      welcomeSentAt: null,
      lastCustomerMessageAt: isoAt(NOW - 16 * HORA),
      lastReplyAt: isoAt(NOW - 15 * HORA),
      lastReplySender: "ai",
      lastMessageAt: isoAt(NOW - 15 * HORA),
    });

    expect(stageOf(carlos)).toBe("inquiry");
    expect(waitingMinutes(carlos, NOW)).toBeNull();
    expect(isStalled(carlos, NOW)).toBe(false);
  });

  it("Laura: una nota interna reciente NO reinicia el reloj — sigue contando desde el mensaje del cliente", () => {
    const laura = conversacion({
      id: "laura",
      assignedAgent: null,
      welcomeSentAt: null,
      lastCustomerMessageAt: isoAt(NOW - 30 * MIN),
      // La nota es visible (avanza lastMessageAt en la base) pero no es una
      // respuesta real: lastReplyAt se queda en null.
      lastMessageAt: isoAt(NOW - 1 * MIN),
      lastReplyAt: null,
    });

    expect(awaitingReply(laura)).toBe(true);
    expect(waitingMinutes(laura, NOW)).toBeCloseTo(30, 5);
    expect(isStalled(laura, NOW)).toBe(true);
  });

  it('Ana: con asesor, dentro de las 59 primeras horas laborales tras el cierre del jueves → NO atascada', () => {
    // El cliente escribió el jueves 10:30 pm hora de Caracas (fuera de
    // horario). "Ahora" es el viernes 8:59 am: solo 59 minutos de horario
    // laboral corrieron desde que abrió la tienda a las 8:00 am.
    const clienteEscribio = Date.parse("2026-09-04T02:30:00.000Z"); // jue 10:30 pm Caracas
    const ahoraNoAtascada = Date.parse("2026-09-04T12:59:00.000Z"); // vie 8:59 am Caracas

    const ana = conversacion({
      id: "ana",
      assignedAgent: { id: "agente-1", displayName: "Pedro" },
      lastCustomerMessageAt: isoAt(clienteEscribio),
      lastReplyAt: null,
    });

    expect(stageOf(ana)).toBe("assigned");
    expect(waitingMinutes(ana, ahoraNoAtascada, DEFAULT_BUSINESS_HOURS)).toBe(59);
    expect(isStalled(ana, ahoraNoAtascada, DEFAULT_BUSINESS_HOURS)).toBe(false);
  });

  it("Ana: dos minutos más tarde (61 min laborales) → SÍ atascada, aunque el reloj de pared diga lo mismo de siempre", () => {
    const clienteEscribio = Date.parse("2026-09-04T02:30:00.000Z"); // jue 10:30 pm Caracas
    const ahoraAtascada = Date.parse("2026-09-04T13:01:00.000Z"); // vie 9:01 am Caracas

    const ana = conversacion({
      id: "ana",
      assignedAgent: { id: "agente-1", displayName: "Pedro" },
      lastCustomerMessageAt: isoAt(clienteEscribio),
      lastReplyAt: null,
    });

    expect(waitingMinutes(ana, ahoraAtascada, DEFAULT_BUSINESS_HOURS)).toBe(61);
    expect(isStalled(ana, ahoraAtascada, DEFAULT_BUSINESS_HOURS)).toBe(true);
  });

  it('"Cliente de prueba": journey_stage = assigned SIN asesor, espera 20 min → inquiry atascada, no "Con asesor"', () => {
    const clienteDePrueba = conversacion({
      id: "cliente-de-prueba",
      assignedAgent: null,
      journeyStage: "assigned",
      lastCustomerMessageAt: isoAt(NOW - 20 * MIN),
      lastReplyAt: null,
    });

    expect(stageOf(clienteDePrueba)).toBe("inquiry");
    expect(waitingMinutes(clienteDePrueba, NOW)).toBeCloseTo(20, 5);
    expect(isStalled(clienteDePrueba, NOW)).toBe(true);
  });

  it("Roberto: conversación cerrada → waitingMinutes null, nunca atascada", () => {
    const roberto = conversacion({
      id: "roberto",
      status: "closed",
      assignedAgent: null,
      lastCustomerMessageAt: isoAt(NOW - 100 * HORA),
      lastReplyAt: null,
    });

    expect(waitingMinutes(roberto, NOW)).toBeNull();
    expect(isStalled(roberto, NOW)).toBe(false);
  });
});

describe("buildJourney — la base del artefacto: un solo atascado (Diana)", () => {
  it("cuenta 1 atascado en total, con Diana en Consulta y Carlos en Consulta sin atasco", () => {
    const diana = conversacion({
      id: "diana",
      lastCustomerMessageAt: isoAt(NOW - 20 * MIN),
      lastReplyAt: null,
    });
    const carlos = conversacion({
      id: "carlos",
      lastCustomerMessageAt: isoAt(NOW - 16 * HORA),
      lastReplyAt: isoAt(NOW - 15 * HORA),
      lastReplySender: "ai",
      lastMessageAt: isoAt(NOW - 15 * HORA),
    });
    const clienteDePrueba = conversacion({
      id: "cliente-de-prueba",
      journeyStage: "assigned",
      lastCustomerMessageAt: isoAt(NOW - 10 * MIN), // bajo el umbral de 15
      lastReplyAt: null,
    });
    const roberto = conversacion({
      id: "roberto",
      status: "closed",
      lastCustomerMessageAt: isoAt(NOW - 100 * HORA),
      lastReplyAt: null,
    });

    const stages = buildJourney([diana, carlos, clienteDePrueba, roberto], NOW);
    const inquiry = stages.find((s) => s.id === "inquiry")!;

    const totalStalled = stages.reduce((sum, s) => sum + s.stalled, 0);
    expect(totalStalled).toBe(1);

    // Roberto está cerrado: `buildJourney` filtra por `isActive`, no aparece
    // en ninguna columna.
    const idsEnTablero = stages.flatMap((s) => s.conversations.map((c) => c.id));
    expect(idsEnTablero).not.toContain("roberto");

    // Orden cambiado el 10/9/2026 ("Los números del día"): ya NO es "mayor
    // espera arriba" (eso habría puesto a Diana primero); ahora es "más
    // nuevo arriba" por `lastCustomerMessageAt` — "Cliente de prueba"
    // escribió hace 10 min (más reciente que los 20 min de Diana), así que
    // va primero aunque Diana sea la única atascada de las tres.
    expect(inquiry.conversations.map((c) => c.id)).toEqual(["cliente-de-prueba", "diana", "carlos"]);
  });
});

describe("stageDetail — las frases nuevas de Primer contacto y Consulta en silencio", () => {
  // 10/9/2026 ("Los números del día"): `first_contact` deja de tener un
  // único texto fijo, igual que `stageOf` dejó de exigir `!awaitingReply`
  // para esta etapa — ahora puede estar esperando la primera respuesta
  // (muestra el `intent`, como "Consulta") o ya haber recibido la
  // bienvenida sin volver a escribir (el texto de siempre).
  it('first_contact esperando respuesta muestra el intent, como inquiry', () => {
    const conversation = conversacion({ welcomeSentAt: isoAt(NOW), lastReplyAt: null, intent: "compra" });
    expect(awaitingReply(conversation)).toBe(true);
    expect(stageDetail(conversation, "first_contact")).toBe("compra");
  });

  it('first_contact sin esperar respuesta dice "esperando su siguiente mensaje"', () => {
    const conversation = conversacion({
      welcomeSentAt: isoAt(NOW),
      lastCustomerMessageAt: isoAt(NOW - 10 * MIN),
      lastReplyAt: isoAt(NOW),
      lastReplySender: "ai",
    });
    expect(awaitingReply(conversation)).toBe(false);
    expect(stageDetail(conversation, "first_contact")).toBe("esperando su siguiente mensaje");
  });

  it('inquiry sin awaitingReply dice "sin respuesta del cliente"', () => {
    const conversation = conversacion({
      lastCustomerMessageAt: isoAt(NOW - 16 * HORA),
      lastReplyAt: isoAt(NOW - 15 * HORA),
      lastReplySender: "ai",
      intent: "compra",
    });

    expect(stageDetail(conversation, "inquiry")).toBe("sin respuesta del cliente");
  });

  it("inquiry esperando respuesta sigue mostrando el intent, como antes", () => {
    const conversation = conversacion({
      lastCustomerMessageAt: isoAt(NOW - 5 * MIN),
      lastReplyAt: null,
      intent: "compra",
    });

    expect(stageDetail(conversation, "inquiry")).toBe("compra");
  });
});

// ===========================================================================
// buildJourney con dayStart — el tablero del día (T1, corrida "Los números
// del día", 10/9/2026). `DAY_START` es la medianoche de Caracas del 10/9
// (mismo formato que produce `useInboxDay`); `HOY` cae a las 3 pm del mismo
// día, igual patrón que `NOW` más arriba en este archivo. Ojo con los
// fixtures: `conversacion()` por defecto pone `lastMessageAt`/`createdAt`
// en el 4/9 (T0) — cada caso de acá abajo que deba PASAR el corte del día
// tiene que pisar `lastMessageAt` explícito, porque `matchesDay` (la gemela
// de `inbox-filters.ts`) mira `lastMessageAt ?? createdAt`, nunca
// `lastCustomerMessageAt`.
// ===========================================================================

describe("buildJourney con dayStart — el tablero del día", () => {
  const DAY_START = "2026-09-10T04:00:00.000Z"; // medianoche de Caracas, 10/9/2026
  const HOY = Date.parse("2026-09-10T19:00:00.000Z"); // 10/9, 3 pm Caracas

  it("(a) el último mensaje fue ayer: no entra a ninguna etapa", () => {
    const ayer = conversacion({
      id: "ayer",
      createdAt: "2026-09-09T15:00:00.000Z",
      lastMessageAt: "2026-09-09T20:00:00.000Z",
      lastCustomerMessageAt: "2026-09-09T20:00:00.000Z",
      lastReplyAt: null,
    });

    const stages = buildJourney([ayer], HOY, DEFAULT_BUSINESS_HOURS, DAY_START);
    const idsEnTablero = stages.flatMap((s) => s.conversations.map((c) => c.id));
    expect(idsEnTablero).not.toContain("ayer");
  });

  it("(b) creada hoy, un solo mensaje, con bienvenida y SIN respuesta → first_contact; se atasca a los 15 min, no a los 14", () => {
    const creadaHoy = "2026-09-10T18:44:00.000Z"; // 10/9, 2:44 pm Caracas
    const primerMensaje = conversacion({
      id: "primer-mensaje",
      createdAt: creadaHoy,
      welcomeSentAt: creadaHoy,
      lastCustomerMessageAt: creadaHoy,
      lastMessageAt: creadaHoy,
      lastReplyAt: null,
    });

    expect(stageOf(primerMensaje, DAY_START)).toBe("first_contact");

    const a14min = Date.parse(creadaHoy) + 14 * MIN;
    const a15min = Date.parse(creadaHoy) + 15 * MIN;
    expect(isStalled(primerMensaje, a14min, DEFAULT_BUSINESS_HOURS, DAY_START)).toBe(false);
    expect(isStalled(primerMensaje, a15min, DEFAULT_BUSINESS_HOURS, DAY_START)).toBe(true);
  });

  it("(c) creada ayer que hoy escribió su segundo mensaje → inquiry, no first_contact", () => {
    const segundoMensaje = conversacion({
      id: "segundo-mensaje",
      createdAt: "2026-09-09T15:00:00.000Z", // ayer, primer mensaje
      welcomeSentAt: "2026-09-09T15:05:00.000Z", // ayer, tras el primer mensaje
      lastCustomerMessageAt: "2026-09-10T12:00:00.000Z", // hoy, segundo mensaje
      lastMessageAt: "2026-09-10T12:00:00.000Z",
      lastReplyAt: null,
    });

    // El último mensaje es posterior a la bienvenida (segundo mensaje real):
    // el peldaño 4 también fallaría por esto solo, pero lo que este caso
    // prueba es el pie extra del 10/9/2026 (creada ayer, no hoy).
    expect(stageOf(segundoMensaje, DAY_START)).toBe("inquiry");
  });

  it("(d) dentro de una etapa el orden es el más nuevo arriba", () => {
    const masVieja = conversacion({
      id: "mas-vieja",
      lastMessageAt: "2026-09-10T10:00:00.000Z",
      lastCustomerMessageAt: "2026-09-10T10:00:00.000Z",
      lastReplyAt: null,
    });
    const media = conversacion({
      id: "media",
      lastMessageAt: "2026-09-10T14:00:00.000Z",
      lastCustomerMessageAt: "2026-09-10T14:00:00.000Z",
      lastReplyAt: null,
    });
    const masNueva = conversacion({
      id: "mas-nueva",
      lastMessageAt: "2026-09-10T18:00:00.000Z",
      lastCustomerMessageAt: "2026-09-10T18:00:00.000Z",
      lastReplyAt: null,
    });

    // Orden deliberadamente distinto al de inserción, para que un `sort`
    // que no hiciera nada (o que ordenara al revés) se note.
    const stages = buildJourney([media, masVieja, masNueva], HOY, DEFAULT_BUSINESS_HOURS, DAY_START);
    const inquiry = stages.find((s) => s.id === "inquiry")!;

    expect(inquiry.conversations.map((c) => c.id)).toEqual(["mas-nueva", "media", "mas-vieja"]);
  });

  it("(e) sin dayStart (llamada vieja), nada se filtra por fecha", () => {
    const ayer = conversacion({
      id: "ayer-sin-daystart",
      createdAt: "2026-09-09T15:00:00.000Z",
      lastMessageAt: "2026-09-09T20:00:00.000Z",
      lastCustomerMessageAt: "2026-09-09T20:00:00.000Z",
      lastReplyAt: null,
    });

    const stages = buildJourney([ayer], HOY);
    const idsEnTablero = stages.flatMap((s) => s.conversations.map((c) => c.id));
    expect(idsEnTablero).toContain("ayer-sin-daystart");
  });
});
