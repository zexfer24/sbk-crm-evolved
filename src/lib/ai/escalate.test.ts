import { describe, expect, it, vi } from "vitest";

const claimNextAvailableAgentMock = vi.fn();
vi.mock("@/lib/ai/claim-agent", () => ({
  claimNextAvailableAgent: () => claimNextAvailableAgentMock(),
}));

import { escalateConversation } from "@/lib/ai/escalate";

interface Estado {
  conversationUpdates: Record<string, unknown>[];
  notas: string[];
}

function createFakeSupabase(): { client: unknown; estado: Estado } {
  const estado: Estado = { conversationUpdates: [], notas: [] };

  const client = {
    from(table: string) {
      if (table === "conversations") {
        return {
          update(values: Record<string, unknown>) {
            estado.conversationUpdates.push(values);
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }
      if (table === "messages") {
        return {
          insert(row: { content?: string }) {
            estado.notas.push(row.content ?? "");
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "tags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
      }
      if (table === "contact_tags") {
        return { upsert: async () => ({ data: null, error: null }) };
      }
      throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
    },
  };

  return { client, estado };
}

const PARAMS = {
  conversationId: "conv-1",
  contactId: "contact-1",
  motivo: "queja" as const,
  resumen: "El cliente reclama por un envío que no llegó.",
};

describe("escalateConversation", () => {
  it("asigna al asesor disponible y pausa la IA", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
    const { client, estado } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo suficiente para este test
    const result = await escalateConversation(client, PARAMS);

    expect(result.escalated).toBe(true);
    expect(result.assignedAgentName).toBe("María");
    expect(estado.conversationUpdates[0]).toMatchObject({
      ai_enabled: false,
      assigned_agent_id: "agent-1",
      journey_stage: "assigned",
    });
  });

  /**
   * El caso que se comía los tokens: sin asesores la conversación quedaba con
   * la IA encendida, así que cada mensaje del cliente disparaba otro turno
   * completo que volvía a intentar escalar y volvía a fallar. El cliente
   * insistía, el gasto subía y nadie lo atendía.
   */
  describe("cuando no hay ningún asesor disponible", () => {
    it("pausa la IA igual, en vez de dejarla reintentando en cada mensaje", async () => {
      claimNextAvailableAgentMock.mockResolvedValue(null);
      const { client, estado } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      await escalateConversation(client, PARAMS);

      expect(estado.conversationUpdates[0]).toMatchObject({
        ai_enabled: false,
        assigned_agent_id: null,
        journey_stage: "assigned",
      });
    });

    it("informa que quedó sin asignar, para que quien responda lo diga distinto", async () => {
      claimNextAvailableAgentMock.mockResolvedValue(null);
      const { client } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      const result = await escalateConversation(client, PARAMS);

      // Escalado sí: el caso salió de manos de la IA. Asignado no.
      expect(result.escalated).toBe(true);
      expect(result.assignedAgentName).toBeNull();
      expect(result.unassigned).toBe(true);
    });

    it("deja la nota interna diciendo que no había nadie, no un asesor inventado", async () => {
      claimNextAvailableAgentMock.mockResolvedValue(null);
      const { client, estado } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      await escalateConversation(client, PARAMS);

      expect(estado.notas[0]).toContain("sin asesores disponibles");
      expect(estado.notas[0]).toContain(PARAMS.resumen);
    });

    it("sigue etiquetando el reclamo aunque no haya a quién asignárselo", async () => {
      claimNextAvailableAgentMock.mockResolvedValue(null);
      const { client } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      const result = await escalateConversation(client, PARAMS);

      expect(result.escalated).toBe(true);
    });
  });
});
