/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { BoardConversation } from "@/lib/types";
import { buildJourney, isStalled } from "@/lib/dashboard";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import { JourneyBoard } from "@/components/dashboard/journey-board";

/**
 * jsdom no trae `ResizeObserver` (tampoco `getBoundingClientRect` mide nada
 * real); `JourneyBoard` lo usa para recalcular los hilos del recorrido, algo
 * que a estas pruebas no les interesa. Mismo sustituto no-op que usa
 * `sliding-pills.test.tsx` para el mismo problema.
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Frente A, "El reloj dice la verdad" (5/9/2026): el tablero deja de
 * inventar su propio reloj (`minutesInStage`) y usa el único que hay
 * (`waitingMinutes`/`isStalled`, `src/lib/dashboard.ts`). Estas pruebas
 * cubren la tarjeta (A4), no la fórmula en sí — esa la prueba
 * `dashboard.test.ts`.
 *
 * `conversacion` es el mismo fixture mínimo que usa `dashboard.test.ts`
 * (misma forma de `BoardConversation`), para no tener dos formas de armar
 * el mismo objeto en el repo.
 */
function conversacion(over: Partial<BoardConversation> = {}): BoardConversation {
  return {
    id: "conv-1",
    contact: { id: "contact-1", phoneNumber: "+580000000011", displayName: "Cliente", profileName: null },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: null,
    lastMessageAt: null,
    lastReplyAt: null,
    lastReplySender: null,
    hasReply: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...over,
  };
}

/** Color de fondo del punto de la tarjeta, leído del atributo `style` crudo
 *  (no de `.style.background`) para no depender de cómo jsdom serialice un
 *  `var(...)` en la propiedad shorthand. */
function tickStyle(container: HTMLElement): string {
  return container.querySelector(".dash-card-tick")?.getAttribute("style") ?? "";
}

describe("JourneyBoard — la tarjeta dice cuánto lleva esperando el cliente y por qué está en rojo (A4)", () => {
  it("(a) 23 minutos de espera real pintan 'espera 23 min'", () => {
    const now = Date.parse("2026-09-04T12:23:00.000Z");
    const conversation = conversacion({
      id: "conv-a",
      lastCustomerMessageAt: new Date(now - 23 * 60_000).toISOString(),
    });

    const stages = buildJourney([conversation], now, DEFAULT_BUSINESS_HOURS);
    render(<JourneyBoard stages={stages} now={now} hours={DEFAULT_BUSINESS_HOURS} />);

    expect(screen.getByText("espera 23 min")).toBeInTheDocument();
  });

  it("(b) la IA ya respondió y el cliente calla: 'sin respuesta del cliente' en gris, sin punto rojo", () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const DIA = 24 * 60 * 60_000;
    const conversation = conversacion({
      id: "conv-b",
      // El cliente escribió hace 5 días; la IA respondió al día siguiente
      // (hace 4 días) — awaitingReply() ya da false, no hay nada que esperar.
      lastCustomerMessageAt: new Date(now - 5 * DIA).toISOString(),
      lastReplyAt: new Date(now - 4 * DIA).toISOString(),
      lastReplySender: "ai",
    });

    const stages = buildJourney([conversation], now, DEFAULT_BUSINESS_HOURS);
    const { container } = render(
      <JourneyBoard stages={stages} now={now} hours={DEFAULT_BUSINESS_HOURS} />
    );

    expect(screen.getByText("sin respuesta del cliente")).toBeInTheDocument();
    expect(tickStyle(container)).toContain("--lm-good");
    expect(tickStyle(container)).not.toContain("--lm-hot");
  });

  it("(c) 'Con asesor': 13 h de pared no atascan si el horario laboral no llega a 60 min, pero 61 min laborales sí", () => {
    // Viernes 4/9/2026 17:30 (America/Caracas, sin horario de verano):
    // faltan 30 min laborales para el cierre de las 18:00.
    const from = "2026-09-04T17:30:00-04:00";
    const agent = { id: "ag-1", displayName: "Pedro" };

    // Sábado 5/9 06:30: 13 h de reloj de pared, pero el fin de semana está
    // cerrado — solo cuentan los 30 min de viernes. 30 < 60: no atascado.
    const notStalledNow = Date.parse("2026-09-05T06:30:00-04:00");
    const conversationLow = conversacion({
      id: "conv-c-low",
      assignedAgent: agent,
      lastCustomerMessageAt: from,
    });

    const stagesLow = buildJourney([conversationLow], notStalledNow, DEFAULT_BUSINESS_HOURS);
    const low = render(
      <JourneyBoard stages={stagesLow} now={notStalledNow} hours={DEFAULT_BUSINESS_HOURS} />
    );
    expect(tickStyle(low.container)).toContain("--lm-good");
    low.unmount();

    // Lunes 7/9 08:31: se suman los 30 min de viernes más 31 min del lunes
    // (08:00 a 08:31) = 61 min laborales. 61 >= 60: atascado.
    const stalledNow = Date.parse("2026-09-07T08:31:00-04:00");
    const conversationHigh = conversacion({
      id: "conv-c-high",
      assignedAgent: agent,
      lastCustomerMessageAt: from,
    });

    const stagesHigh = buildJourney([conversationHigh], stalledNow, DEFAULT_BUSINESS_HOURS);
    const high = render(
      <JourneyBoard stages={stagesHigh} now={stalledNow} hours={DEFAULT_BUSINESS_HOURS} />
    );
    expect(tickStyle(high.container)).toContain("--lm-hot");

    const tick = high.container.querySelector(".dash-card-tick");
    expect(tick?.getAttribute("title")).toBe("60 min en horario de atención");
  });

  it("(d) el conteo de atascados de la columna coincide con isStalled", () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const conversations = [
      // Consulta (sin asesor, sin journey_stage): umbral 15 min de pared.
      conversacion({
        id: "conv-d1",
        lastCustomerMessageAt: new Date(now - 200 * 60_000).toISOString(), // atascada
      }),
      conversacion({
        id: "conv-d2",
        lastCustomerMessageAt: new Date(now - 5 * 60_000).toISOString(), // reciente
      }),
      conversacion({
        id: "conv-d3",
        lastCustomerMessageAt: new Date(now - 150 * 60_000).toISOString(), // atascada
      }),
    ];

    const stages = buildJourney(conversations, now, DEFAULT_BUSINESS_HOURS);
    const inquiryStage = stages.find((s) => s.id === "inquiry")!;
    const expectedStalled = inquiryStage.conversations.filter((c) =>
      isStalled(c, now, DEFAULT_BUSINESS_HOURS)
    ).length;
    expect(expectedStalled).toBe(2);

    const { container } = render(
      <JourneyBoard stages={stages} now={now} hours={DEFAULT_BUSINESS_HOURS} />
    );

    // Las otras cuatro columnas están vacías: el único ".dash-stage-alert"
    // del documento es el de "Consulta".
    const badge = container.querySelector(".dash-stage-alert .dash-num");
    expect(badge?.textContent).toBe(String(expectedStalled));
  });

  it("(e) una conversación creada hoy con asesor asignado sale en 'Primer contacto' Y en 'Con asesor' a la vez", () => {
    // Corrida "El Recorrido cuenta los números nuevos del día" (10/9/2026):
    // "Primer contacto" pasó de peldaño exclusivo a columna de cohorte, así
    // que una tarjeta de hoy con asesor asignado tiene que verse en las DOS
    // columnas al mismo tiempo — la misma conversación, dos apariciones.
    const dayStart = "2026-09-04T04:00:00.000Z"; // medianoche de Caracas del 4/9/2026
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const conversation = conversacion({
      id: "conv-e",
      assignedAgent: { id: "ag-1", displayName: "Pedro" },
      lastCustomerMessageAt: new Date(now - 5 * 60_000).toISOString(),
      createdAt: new Date(now - 5 * 60_000).toISOString(),
    });

    const stages = buildJourney([conversation], now, DEFAULT_BUSINESS_HOURS, dayStart);
    const { container } = render(
      <JourneyBoard stages={stages} now={now} hours={DEFAULT_BUSINESS_HOURS} />
    );

    const sections = Array.from(container.querySelectorAll<HTMLElement>(".dash-stage"));
    const primerContacto = sections.find(
      (el) => el.querySelector(".dash-stage-label")?.textContent === "Primer contacto"
    )!;
    const conAsesor = sections.find(
      (el) => el.querySelector(".dash-stage-label")?.textContent === "Con asesor"
    )!;

    expect(within(primerContacto).getByText("Cliente")).toBeInTheDocument();
    expect(within(conAsesor).getByText("Cliente")).toBeInTheDocument();
  });
});
