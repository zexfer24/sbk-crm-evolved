import { describe, expect, it, vi } from "vitest";

const claimNextAvailableAgentMock = vi.fn();
vi.mock("@/lib/ai/claim-agent", () => ({
  claimNextAvailableAgent: () => claimNextAvailableAgentMock(),
}));

import { escalateConversation } from "@/lib/ai/escalate";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";

/**
 * Caracas es UTC-4 todo el año (sin horario de verano), así que un instante
 * en UTC con 4 horas sumadas siempre cae en la misma hora local. Mismo
 * helper que `business-hours.test.ts`, para no depender de la `TZ` del
 * proceso que corre la suite.
 */
function enCaracas(fechaLocalIso: string): Date {
  const [fecha, hora] = fechaLocalIso.split("T");
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const [h, m] = hora.split(":").map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia, h + 4, m, 0));
}

interface Estado {
  conversationUpdates: Record<string, unknown>[];
  notas: string[];
  /** Cada llamada a la RPC `record_handoff` (ver handoffs.ts), con sus parámetros. */
  handoffs: Record<string, unknown>[];
  /**
   * Orden real en que ocurrieron los tres pasos: update → nota → traspaso.
   * T0.3 le agregó el traspaso a `escalateConversation`, y el requisito no es
   * solo que ocurra, sino que quede DETRÁS de un estado ya consistente (la
   * conversación actualizada y la nota ya escrita), no a mitad de escribirlo.
   */
  pasos: string[];
}

function createFakeSupabase(): { client: unknown; estado: Estado } {
  const estado: Estado = { conversationUpdates: [], notas: [], handoffs: [], pasos: [] };

  const client = {
    from(table: string) {
      if (table === "conversations") {
        return {
          update(values: Record<string, unknown>) {
            estado.conversationUpdates.push(values);
            estado.pasos.push("update");
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }
      if (table === "messages") {
        return {
          insert(row: { content?: string }) {
            estado.notas.push(row.content ?? "");
            estado.pasos.push("nota");
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
    rpc(fn: string, params?: Record<string, unknown>) {
      if (fn !== "record_handoff") throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
      estado.handoffs.push(params ?? {});
      estado.pasos.push("traspaso");
      return Promise.resolve({ data: "handoff-1", error: null });
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
   * T0.3: el escalamiento es una salida silenciosa más de la IA —la
   * conversación deja de correr por el turno— y hasta ahora no dejaba fila
   * en `conversation_handoffs`. Con candidato, el traspaso va a la persona
   * exacta que se lo llevó (`toId`), no solo a "human" en general.
   */
  it("con un asesor disponible, registra el traspaso a 'human' con su toId y razón 'escalada'", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
    const { client, estado } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, PARAMS);

    expect(estado.handoffs).toHaveLength(1);
    expect(estado.handoffs[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_to_id: "agent-1",
      p_reason: "escalada",
    });
  });

  /**
   * El orden importa: la bitácora tiene que quedar DETRÁS de un estado ya
   * consistente (conversación actualizada, nota ya escrita), no a mitad de
   * escribirlo — igual que ya exigía el orden etiquetar→escalar en agent.ts.
   */
  it("escribe en el orden update → nota → traspaso", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
    const { client, estado } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, PARAMS);

    expect(estado.pasos).toEqual(["update", "nota", "traspaso"]);
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

    /**
     * Sin candidato el traspaso es a "unassigned", no a "human": nadie quedó
     * a cargo de verdad, y es justo lo que hace que esta conversación
     * aparezca en la píldora "Sin dueño" del panel de inicio.
     */
    it("registra el traspaso a 'unassigned' con razón 'escalada_sin_asesor'", async () => {
      claimNextAvailableAgentMock.mockResolvedValue(null);
      const { client, estado } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      await escalateConversation(client, PARAMS);

      expect(estado.handoffs).toHaveLength(1);
      expect(estado.handoffs[0]).toMatchObject({
        p_conversation_id: "conv-1",
        p_to_kind: "unassigned",
        p_reason: "escalada_sin_asesor",
      });
      expect(estado.handoffs[0].p_to_id).toBeUndefined();
    });

    it("sin asesor también respeta el orden update → nota → traspaso", async () => {
      claimNextAvailableAgentMock.mockResolvedValue(null);
      const { client, estado } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      await escalateConversation(client, PARAMS);

      expect(estado.pasos).toEqual(["update", "nota", "traspaso"]);
    });
  });
});

/**
 * Frente B4 ("El reloj dice la verdad", 5/9/2026): sin asesores, el evento de
 * sistema y el resultado que le llega a `buildEscalateTool` (`tools.ts`)
 * tienen que saber si la tienda está abierta — antes de esto la despedida no
 * podía decir cuándo iban a atender al cliente sin arriesgarse a prometer
 * algo falso.
 */
describe("escalateConversation — horario de la tienda al escalar sin asesores", () => {
  it("agrega '(fuera de horario)' a la nota cuando la tienda está cerrada", async () => {
    claimNextAvailableAgentMock.mockResolvedValue(null);
    const { client, estado } = createFakeSupabase();

    // 2026-09-06 es domingo (mismo ancla que business-hours.test.ts: el
    // 2026-08-30 es domingo). Sin franja los domingos, cerrada a cualquier hora.
    const domingo = enCaracas("2026-09-06T10:00");

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, { ...PARAMS, now: domingo, businessHours: DEFAULT_BUSINESS_HOURS });

    expect(estado.notas[0]).toContain("(fuera de horario)");
  });

  it("agrega '(en horario)' a la nota cuando la tienda está abierta", async () => {
    claimNextAvailableAgentMock.mockResolvedValue(null);
    const { client, estado } = createFakeSupabase();

    // 2026-09-07 es lunes, 10 am: dentro del horario por defecto (8am-6pm).
    const lunes = enCaracas("2026-09-07T10:00");

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, { ...PARAMS, now: lunes, businessHours: DEFAULT_BUSINESS_HOURS });

    expect(estado.notas[0]).toContain("(en horario)");
  });

  it("con un asesor asignado, la nota no lleva sufijo de horario", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
    const { client, estado } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, PARAMS);

    expect(estado.notas[0]).not.toMatch(/\(en horario\)|\(fuera de horario\)/);
  });

  it("con la tienda cerrada un domingo, el resultado dice cuándo abre: el lunes", async () => {
    claimNextAvailableAgentMock.mockResolvedValue(null);
    const { client } = createFakeSupabase();

    const domingo = enCaracas("2026-09-06T10:00");

    // @ts-expect-error -- fake mínimo
    const result = await escalateConversation(client, {
      ...PARAMS,
      now: domingo,
      businessHours: DEFAULT_BUSINESS_HOURS,
    });

    expect(result.businessStatus?.open).toBe(false);
    expect(result.businessStatus?.nextOpening).toEqual({ dayLabel: "el lunes", time: "8:00 am" });
  });

  it("con un asesor asignado, el resultado no lleva businessStatus (no hace falta para esa despedida)", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
    const { client } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    const result = await escalateConversation(client, PARAMS);

    expect(result.businessStatus).toBeUndefined();
  });

  it("sin now ni businessHours, usa el reloj real y el horario por defecto sin reventar", async () => {
    claimNextAvailableAgentMock.mockResolvedValue(null);
    const { client, estado } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    const result = await escalateConversation(client, PARAMS);

    expect(estado.notas[0]).toMatch(/\(en horario\)|\(fuera de horario\)/);
    expect(result.businessStatus).toBeDefined();
  });
});
