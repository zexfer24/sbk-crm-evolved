import { describe, expect, it } from "vitest";
import type { Agent, ConversationSummary } from "@/lib/types";
import { buildInboxSections } from "@/lib/inbox-sections";

const ANA: Agent = { id: "ana", displayName: "Ana", fullName: null, avatarUrl: null, role: "agent", isActive: true };

/** Conversación mínima: solo los campos que miran las secciones. */
function conversation(over: {
  id: string;
  unreadCount?: number;
  manuallyUnread?: boolean;
  /** T1.5 (5/9/2026): lo que parte "escalated" en Sin asesor/Con asesor. */
  assignedAgent?: Agent | null;
}): ConversationSummary {
  return {
    id: over.id,
    unreadCount: over.unreadCount ?? 0,
    manuallyUnread: over.manuallyUnread ?? false,
    assignedAgent: over.assignedAgent ?? null,
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

describe("buildInboxSections — pending", () => {
  it("arma dos secciones: Sin abrir y Leídas sin responder", () => {
    const sinAbrir = conversation({ id: "sin-abrir", unreadCount: 2 });
    const leidaSinResponder = conversation({ id: "leida-sin-responder", unreadCount: 0 });

    const sections = buildInboxSections("pending", [sinAbrir, leidaSinResponder], NOW);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ id: "sin-abrir", label: "Sin abrir", conversations: [sinAbrir] });
    expect(sections[1]).toMatchObject({
      id: "leidas-sin-responder",
      label: "Leídas sin responder",
      conversations: [leidaSinResponder],
    });
  });

  it("manuallyUnread cuenta como sin abrir aunque unreadCount sea 0", () => {
    const apartada = conversation({ id: "apartada", unreadCount: 0, manuallyUnread: true });
    const leida = conversation({ id: "leida", unreadCount: 0, manuallyUnread: false });

    const sections = buildInboxSections("pending", [apartada, leida], NOW);

    expect(sections[0]).toMatchObject({ label: "Sin abrir", conversations: [apartada] });
    expect(sections[1]).toMatchObject({ label: "Leídas sin responder", conversations: [leida] });
  });

  it("una sección vacía no produce entrada", () => {
    const leida = conversation({ id: "leida", unreadCount: 0 });

    const sections = buildInboxSections("pending", [leida], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Leídas sin responder");
  });

  it("la otra sección vacía tampoco produce entrada", () => {
    const sinAbrir = conversation({ id: "sin-abrir", unreadCount: 1 });

    const sections = buildInboxSections("pending", [sinAbrir], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Sin abrir");
  });

  it("preserva el orden de entrada dentro de cada sección", () => {
    const a = conversation({ id: "a", unreadCount: 1 });
    const b = conversation({ id: "b", unreadCount: 2 });
    const c = conversation({ id: "c", unreadCount: 3 });

    const sections = buildInboxSections("pending", [a, b, c], NOW);

    expect(sections[0].conversations.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("buildInboxSections — unread", () => {
  it("arma una sola sección sin etiqueta", () => {
    const sinLeer1 = conversation({ id: "sin-leer-1", unreadCount: 2 });
    const sinLeer2 = conversation({ id: "sin-leer-2", unreadCount: 1 });

    const sections = buildInboxSections("unread", [sinLeer1, sinLeer2], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBeNull();
    expect(sections[0].conversations).toEqual([sinLeer1, sinLeer2]);
  });

  it("preserva el orden de entrada", () => {
    const b = conversation({ id: "b", unreadCount: 1 });
    const a = conversation({ id: "a", unreadCount: 1 });

    const sections = buildInboxSections("unread", [b, a], NOW);

    expect(sections[0].conversations.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

/**
 * T1.5 del plan "La bandeja que no pierde" (5/9/2026): distinto criterio de
 * partición que "pending"/"mine" (que parten por LECTURA) — acá importa si
 * YA hay un asesor a cargo, no si abrió el chat.
 */
describe("buildInboxSections — escalated", () => {
  it("arma dos secciones: Sin asesor y Con asesor", () => {
    const sinAsesor = conversation({ id: "sin-asesor" });
    const conAsesor = conversation({ id: "con-asesor", assignedAgent: ANA });

    const sections = buildInboxSections("escalated", [sinAsesor, conAsesor], NOW);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      id: "escalada-sin-asesor",
      label: "Sin asesor",
      conversations: [sinAsesor],
    });
    expect(sections[1]).toMatchObject({
      id: "escalada-con-asesor",
      label: "Con asesor",
      conversations: [conAsesor],
    });
  });

  it("una sección vacía no produce entrada", () => {
    const conAsesor = conversation({ id: "con-asesor", assignedAgent: ANA });

    const sections = buildInboxSections("escalated", [conAsesor], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Con asesor");
  });

  it("la otra sección vacía tampoco produce entrada", () => {
    const sinAsesor = conversation({ id: "sin-asesor" });

    const sections = buildInboxSections("escalated", [sinAsesor], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Sin asesor");
  });

  it("preserva el orden de entrada dentro de cada sección", () => {
    const a = conversation({ id: "a", assignedAgent: ANA });
    const b = conversation({ id: "b", assignedAgent: ANA });
    const c = conversation({ id: "c", assignedAgent: ANA });

    const sections = buildInboxSections("escalated", [a, b, c], NOW);

    expect(sections[0].conversations.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("buildInboxSections — mine", () => {
  it("arma dos secciones: Sin leer y Leídas", () => {
    const noLeido = conversation({ id: "no-leido", unreadCount: 2 });
    const leido = conversation({ id: "leido", unreadCount: 0 });

    const sections = buildInboxSections("mine", [noLeido, leido], NOW);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ label: "Sin leer", conversations: [noLeido] });
    expect(sections[1]).toMatchObject({ label: "Leídas", conversations: [leido] });
  });

  it("manuallyUnread cuenta como no leído aunque unreadCount sea 0", () => {
    const apartada = conversation({ id: "apartada", unreadCount: 0, manuallyUnread: true });
    const leida = conversation({ id: "leida", unreadCount: 0, manuallyUnread: false });

    const sections = buildInboxSections("mine", [apartada, leida], NOW);

    expect(sections[0]).toMatchObject({ label: "Sin leer", conversations: [apartada] });
    expect(sections[1]).toMatchObject({ label: "Leídas", conversations: [leida] });
  });

  it("una sección vacía no produce entrada", () => {
    const leida = conversation({ id: "leida", unreadCount: 0 });

    const sections = buildInboxSections("mine", [leida], NOW);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Leídas");
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
