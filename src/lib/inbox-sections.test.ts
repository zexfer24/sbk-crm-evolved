import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "@/lib/types";
import { buildInboxSections, PENDING_STALE_LIMIT } from "@/lib/inbox-sections";

/** Conversación mínima: solo los campos que miran las secciones. */
function conversation(over: {
  id: string;
  lastCustomerMessageAt?: string | null;
  unreadCount?: number;
  manuallyUnread?: boolean;
}): ConversationSummary {
  return {
    id: over.id,
    lastCustomerMessageAt:
      "lastCustomerMessageAt" in over ? (over.lastCustomerMessageAt ?? null) : null,
    unreadCount: over.unreadCount ?? 0,
    manuallyUnread: over.manuallyUnread ?? false,
    contact: {
      id: `c-${over.id}`,
      phoneNumber: "+58000",
      displayName: over.id,
      profileName: null,
      avatarUrl: null,
      tags: [],
    },
  } as unknown as ConversationSummary;
}

const NOW = new Date("2026-08-28T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

/** El instante exacto en el que un mensaje del cliente cumple 24 h. */
const CUTOFF_MS = NOW_MS - DAY_MS;

describe("buildInboxSections — pending", () => {
  it("arma dos secciones: Nuevos y Esperando", () => {
    const nuevo = conversation({ id: "nuevo", lastCustomerMessageAt: new Date(NOW_MS - 60_000).toISOString() });
    const viejo = conversation({ id: "viejo", lastCustomerMessageAt: new Date(NOW_MS - 2 * DAY_MS).toISOString() });

    const sections = buildInboxSections("pending", [nuevo, viejo], NOW);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ label: "Nuevos · últimas 24 h", conversations: [nuevo] });
    expect(sections[1]).toMatchObject({ label: "Esperando +24 h", conversations: [viejo] });
  });

  it("un segundo antes de cumplir 24 h va a Nuevos", () => {
    // Mensaje que todavía no llegó a las 24 h: elapsed = 24h - 1s.
    const c = conversation({ id: "c", lastCustomerMessageAt: new Date(CUTOFF_MS + 1000).toISOString() });

    const sections = buildInboxSections("pending", [c], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Nuevos · últimas 24 h");
    expect(sections[0].conversations).toEqual([c]);
  });

  it("un segundo después de cumplir 24 h va a Esperando", () => {
    // Mensaje que ya pasó las 24 h: elapsed = 24h + 1s.
    const c = conversation({ id: "c", lastCustomerMessageAt: new Date(CUTOFF_MS - 1000).toISOString() });

    const sections = buildInboxSections("pending", [c], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Esperando +24 h");
    expect(sections[0].conversations).toEqual([c]);
  });

  it("exactamente a las 24 h (borde inclusive) va a Esperando", () => {
    // withinFreeformWindow usa comparación estricta (>), así que el instante
    // exacto del corte ya cuenta como fuera de la ventana.
    const c = conversation({ id: "c", lastCustomerMessageAt: new Date(CUTOFF_MS).toISOString() });

    const sections = buildInboxSections("pending", [c], NOW);

    expect(sections[0].label).toBe("Esperando +24 h");
  });

  it("lastCustomerMessageAt null va a Esperando: sin fecha del cliente no hay ventana abierta", () => {
    const c = conversation({ id: "sin-fecha", lastCustomerMessageAt: null });

    const sections = buildInboxSections("pending", [c], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Esperando +24 h");
    expect(sections[0].conversations).toEqual([c]);
  });

  it("una sección vacía no produce entrada en el resultado", () => {
    const nuevo = conversation({ id: "nuevo", lastCustomerMessageAt: new Date(NOW_MS - 60_000).toISOString() });

    const sections = buildInboxSections("pending", [nuevo], NOW);

    expect(sections).toHaveLength(1);
    expect(sections.map((s) => s.label)).toEqual(["Nuevos · últimas 24 h"]);
  });

  it("ningún elemento de Esperando queda por encima de uno de Nuevos en el array resultante", () => {
    // Entrada mezclada a propósito: viejo, nuevo, viejo, nuevo.
    const viejo1 = conversation({ id: "viejo1", lastCustomerMessageAt: new Date(NOW_MS - 3 * DAY_MS).toISOString() });
    const nuevo1 = conversation({ id: "nuevo1", lastCustomerMessageAt: new Date(NOW_MS - 60_000).toISOString() });
    const viejo2 = conversation({ id: "viejo2", lastCustomerMessageAt: new Date(NOW_MS - 2 * DAY_MS).toISOString() });
    const nuevo2 = conversation({ id: "nuevo2", lastCustomerMessageAt: new Date(NOW_MS - 120_000).toISOString() });

    const sections = buildInboxSections("pending", [viejo1, nuevo1, viejo2, nuevo2], NOW);
    const flat = sections.flatMap((s) => s.conversations);
    const flatIds = flat.map((c) => c.id);

    const lastNuevoIndex = Math.max(flatIds.indexOf("nuevo1"), flatIds.indexOf("nuevo2"));
    const firstViejoIndex = Math.min(flatIds.indexOf("viejo1"), flatIds.indexOf("viejo2"));

    expect(lastNuevoIndex).toBeLessThan(firstViejoIndex);
  });

  it("preserva el orden de entrada dentro de cada sección", () => {
    const a = conversation({ id: "a", lastCustomerMessageAt: new Date(NOW_MS - 10_000).toISOString() });
    const b = conversation({ id: "b", lastCustomerMessageAt: new Date(NOW_MS - 20_000).toISOString() });
    const c = conversation({ id: "c", lastCustomerMessageAt: new Date(NOW_MS - 30_000).toISOString() });

    const sections = buildInboxSections("pending", [a, b, c], NOW);

    expect(sections[0].conversations.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("preserva el orden de entrada aunque vengan los viejos primero", () => {
    const viejo1 = conversation({ id: "viejo1", lastCustomerMessageAt: new Date(NOW_MS - 3 * DAY_MS).toISOString() });
    const viejo2 = conversation({ id: "viejo2", lastCustomerMessageAt: new Date(NOW_MS - 2 * DAY_MS).toISOString() });
    const viejo3 = conversation({ id: "viejo3", lastCustomerMessageAt: new Date(NOW_MS - 4 * DAY_MS).toISOString() });

    // Entrada ya ordenada "viejos primero" (orden ascendente): el módulo NO
    // debe reordenar, solo respetar lo que llegó.
    const sections = buildInboxSections("pending", [viejo1, viejo2, viejo3], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].conversations.map((x) => x.id)).toEqual(["viejo1", "viejo2", "viejo3"]);
  });
});

describe("buildInboxSections — mine", () => {
  it("arma dos secciones: No leídos y Leídos", () => {
    const noLeido = conversation({ id: "no-leido", unreadCount: 2 });
    const leido = conversation({ id: "leido", unreadCount: 0 });

    const sections = buildInboxSections("mine", [noLeido, leido], NOW);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ label: "No leídos", conversations: [noLeido] });
    expect(sections[1]).toMatchObject({ label: "Leídos", conversations: [leido] });
  });

  it("manuallyUnread cuenta como no leído aunque unreadCount sea 0", () => {
    const apartada = conversation({ id: "apartada", unreadCount: 0, manuallyUnread: true });
    const leida = conversation({ id: "leida", unreadCount: 0, manuallyUnread: false });

    const sections = buildInboxSections("mine", [apartada, leida], NOW);

    expect(sections[0]).toMatchObject({ label: "No leídos", conversations: [apartada] });
    expect(sections[1]).toMatchObject({ label: "Leídos", conversations: [leida] });
  });

  it("una sección vacía no produce entrada", () => {
    const leida = conversation({ id: "leida", unreadCount: 0 });

    const sections = buildInboxSections("mine", [leida], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Leídos");
  });

  it("preserva el orden de entrada dentro de cada sección", () => {
    const a = conversation({ id: "a", unreadCount: 1 });
    const b = conversation({ id: "b", unreadCount: 2 });
    const c = conversation({ id: "c", unreadCount: 3 });

    const sections = buildInboxSections("mine", [a, b, c], NOW);

    expect(sections[0].conversations.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("buildInboxSections — all", () => {
  it("arma una sola sección sin etiqueta", () => {
    const uno = conversation({ id: "uno" });
    const dos = conversation({ id: "dos" });

    const sections = buildInboxSections("all", [uno, dos], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBeNull();
    expect(sections[0].conversations).toEqual([uno, dos]);
  });

  it("preserva el orden de entrada", () => {
    const dos = conversation({ id: "dos" });
    const uno = conversation({ id: "uno" });

    const sections = buildInboxSections("all", [dos, uno], NOW);

    expect(sections[0].conversations.map((x) => x.id)).toEqual(["dos", "uno"]);
  });
});

describe("PENDING_STALE_LIMIT", () => {
  it("es un tope declarado, no aplicado por este módulo", () => {
    expect(PENDING_STALE_LIMIT).toBe(100);

    // El módulo no recorta nada: pasar más de PENDING_STALE_LIMIT filas
    // "Esperando" no descarta ninguna. El límite es de la consulta que
    // alimenta a la bandeja, no de esta función pura.
    const viejos = Array.from({ length: PENDING_STALE_LIMIT + 5 }, (_, i) =>
      conversation({ id: `viejo-${i}`, lastCustomerMessageAt: new Date(NOW_MS - 2 * DAY_MS).toISOString() })
    );

    const sections = buildInboxSections("pending", viejos, NOW);

    expect(sections[0].conversations).toHaveLength(PENDING_STALE_LIMIT + 5);
  });
});
