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
  /**
   * T4, "Seba atiende el mostrador" (18/9/2026): lo que trae el `select`
   * previo al reclamo — `null`/sin `assigned_agent_id` de fábrica, el caso
   * "todavía nadie lo tiene" que ejercitan casi todos los tests viejos de
   * este archivo. Un test que quiera la rama "ya asignado" lo sobrescribe.
   */
  currentConversation: {
    assigned_agent_id: string | null;
    ai_enabled: boolean;
    assigned_agent: { id: string; display_name: string } | null;
  };
  /** Si viene con mensaje, el `select` previo al reclamo falla — no debe tumbar la función (falla abierto hacia "no estaba asignada"). */
  currentConversationError: { message: string } | null;
}

function createFakeSupabase(): { client: unknown; estado: Estado } {
  const estado: Estado = {
    conversationUpdates: [],
    notas: [],
    handoffs: [],
    pasos: [],
    currentConversation: { assigned_agent_id: null, ai_enabled: true, assigned_agent: null },
    currentConversationError: null,
  };

  const client = {
    from(table: string) {
      if (table === "conversations") {
        return {
          // El `select` previo al reclamo (hallazgo 3 del plan): una sola
          // consulta, `.eq("id", ...).maybeSingle()`.
          select() {
            return {
              eq: () => ({
                maybeSingle: async () => ({
                  data: estado.currentConversationError ? null : estado.currentConversation,
                  error: estado.currentConversationError,
                }),
              }),
            };
          },
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
  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, D2, requisito 6 del
   * cliente): hasta esta corrida el título decía "asigna al asesor
   * disponible y pausa la IA" — ya no la pausa. Escalar asigna, pero Seba
   * sigue contestando hasta que el asesor escriba de verdad (el trigger de
   * la migración 20260917010000 es quien apaga `ai_enabled`, no esta
   * función).
   */
  it("asigna al asesor disponible sin apagar la IA", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
    const { client, estado } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo suficiente para este test
    const result = await escalateConversation(client, PARAMS);

    expect(result.escalated).toBe(true);
    expect(result.assignedAgentName).toBe("María");
    expect(estado.conversationUpdates[0]).toMatchObject({
      assigned_agent_id: "agent-1",
      journey_stage: "assigned",
    });
    // El punto central de D2: el UPDATE de la escalada NUNCA toca ai_enabled.
    expect(estado.conversationUpdates[0]).not.toHaveProperty("ai_enabled");
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
    /**
     * T4 (18/9/2026, D2/P1): el comentario y el título viejos decían "pausa
     * la IA igual, en vez de dejarla reintentando en cada mensaje" — eso era
     * cierto hasta esta corrida (dejarla encendida sin asesor reintentaba
     * escalar en cada mensaje, puro gasto). Con P1 el operador decidió lo
     * contrario a propósito: de noche o un domingo sin nadie conectado, Seba
     * SIGUE vendiendo — el freno contra el bucle ya no es apagar la IA acá,
     * es el predicado nuevo del reconciliador (`reconciler.ts`, hallazgo 2
     * del plan) y la rama "ya asignado" de más abajo en este mismo archivo.
     */
    it("asigna 'assigned' sin candidato y sin apagar la IA", async () => {
      claimNextAvailableAgentMock.mockResolvedValue(null);
      const { client, estado } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      await escalateConversation(client, PARAMS);

      expect(estado.conversationUpdates[0]).toMatchObject({
        assigned_agent_id: null,
        journey_stage: "assigned",
      });
      expect(estado.conversationUpdates[0]).not.toHaveProperty("ai_enabled");
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
 * T4, "Seba atiende el mostrador" (18/9/2026, D2/D3, hallazgo 3 del plan):
 * con la IA encendida tras escalar, el modelo puede volver a llamar a
 * `escalarAAsesor` en cada consulta de inventario del mismo chat (las reglas
 * 3/4 del prompt escalan con o sin existencia). Reclamar de nuevo reasignaría
 * por round-robin a OTRO asesor, quitándoselo al que ya lo tenía — esta rama
 * lo evita.
 */
describe("escalateConversation — el chat ya tenía asesor asignado", () => {
  it("no reclama a nadie nuevo: claimNextAvailableAgent ni se llama", async () => {
    // Este archivo no tiene `beforeEach`: se limpia a mano el conteo de
    // llamadas que dejaron los tests anteriores, no el comportamiento del
    // mock (`escalateConversation` nunca debería necesitarlo en esta rama).
    claimNextAvailableAgentMock.mockClear();
    const { client, estado } = createFakeSupabase();
    estado.currentConversation = {
      assigned_agent_id: "agent-9",
      ai_enabled: true,
      assigned_agent: { id: "agent-9", display_name: "Pedro" },
    };

    const result = await escalateConversation(
      // @ts-expect-error -- fake mínimo
      client,
      { ...PARAMS, motivo: "seguimiento" as const }
    );

    expect(claimNextAvailableAgentMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ escalated: true, assignedAgentName: "Pedro", alreadyAssigned: true });
  });

  it("no deja ningún traspaso nuevo: el aviso de asignación solo dispara con 'escalada'", async () => {
    const { client, estado } = createFakeSupabase();
    estado.currentConversation = {
      assigned_agent_id: "agent-9",
      ai_enabled: true,
      assigned_agent: { id: "agent-9", display_name: "Pedro" },
    };

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, { ...PARAMS, motivo: "seguimiento" as const });

    expect(estado.handoffs).toHaveLength(0);
  });

  it("deja la nota de sistema con 'reiteró' y el nombre del asesor que ya lo tenía", async () => {
    const { client, estado } = createFakeSupabase();
    estado.currentConversation = {
      assigned_agent_id: "agent-9",
      ai_enabled: true,
      assigned_agent: { id: "agent-9", display_name: "Pedro" },
    };

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, { ...PARAMS, motivo: "seguimiento" as const });

    expect(estado.notas).toHaveLength(1);
    expect(estado.notas[0]).toContain("IA reiteró la escalada a Pedro");
    expect(estado.notas[0]).toContain(PARAMS.resumen);
  });

  it("motivo intencion_compra: SÍ actualiza deal_status, sin tocar assigned_agent_id ni ai_enabled", async () => {
    const { client, estado } = createFakeSupabase();
    estado.currentConversation = {
      assigned_agent_id: "agent-9",
      ai_enabled: true,
      assigned_agent: { id: "agent-9", display_name: "Pedro" },
    };

    await escalateConversation(
      // @ts-expect-error -- fake mínimo
      client,
      { ...PARAMS, motivo: "intencion_compra" as const }
    );

    expect(estado.conversationUpdates).toHaveLength(1);
    expect(estado.conversationUpdates[0]).toEqual({ deal_status: "in_progress" });
  });

  it("motivo distinto de intencion_compra: no hace ningún UPDATE a conversations", async () => {
    const { client, estado } = createFakeSupabase();
    estado.currentConversation = {
      assigned_agent_id: "agent-9",
      ai_enabled: true,
      assigned_agent: { id: "agent-9", display_name: "Pedro" },
    };

    // @ts-expect-error -- fake mínimo
    await escalateConversation(client, { ...PARAMS, motivo: "seguimiento" as const });

    expect(estado.conversationUpdates).toHaveLength(0);
  });

  it("sin nombre en el embed (fila rota), usa 'un asesor' en vez de reventar", async () => {
    const { client, estado } = createFakeSupabase();
    estado.currentConversation = { assigned_agent_id: "agent-9", ai_enabled: true, assigned_agent: null };

    const result = await escalateConversation(
      // @ts-expect-error -- fake mínimo
      client,
      { ...PARAMS, motivo: "seguimiento" as const }
    );

    expect(result.assignedAgentName).toBe("un asesor");
    expect(estado.notas[0]).toContain("IA reiteró la escalada a un asesor");
  });

  /**
   * Falla abierto: si el `select` previo revienta, se trata como "no estaba
   * asignado" y sigue el camino de siempre (reclama a alguien) en vez de
   * tumbar la herramienta que el modelo está esperando.
   */
  it("si el select previo falla, sigue el camino de siempre: reclama a un asesor", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
    const { client, estado } = createFakeSupabase();
    estado.currentConversationError = { message: "conexión perdida" };

    const result = await escalateConversation(
      // @ts-expect-error -- fake mínimo
      client,
      PARAMS
    );

    expect(result).toMatchObject({ escalated: true, assignedAgentName: "María" });
    expect(result.alreadyAssigned).toBeUndefined();
  });
});

/**
 * T3, "Seba atiende el mostrador" (18/9/2026, requisitos 2/3/4 del cliente):
 * `EscalationMotivo` suma `confirmar_inventario`, `sin_stock` y
 * `no_identificado` — los motivos con los que `buildCatalogTool` (tools.ts)
 * le pide al modelo que escale tras cotizar. `motivo` no tiene CHECK en la
 * base (hallazgo 7 del plan): viaja tal cual en el texto del `system_event`,
 * así que no hay una etiqueta legible que traducir — este test solo fija que
 * `escalateConversation` los acepta y los deja igual de crudos en la nota,
 * el mismo comportamiento que ya tenían `devolucion`/`queja`/`seguimiento`.
 */
describe("escalateConversation — acepta los tres motivos nuevos del catálogo", () => {
  it.each(["confirmar_inventario", "sin_stock", "no_identificado"] as const)(
    "motivo '%s': asigna, y la nota interna lo nombra tal cual",
    async (motivo) => {
      claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
      const { client, estado } = createFakeSupabase();

      // @ts-expect-error -- fake mínimo
      const result = await escalateConversation(client, { ...PARAMS, motivo });

      expect(result.escalated).toBe(true);
      expect(estado.notas[0]).toContain(`Motivo: ${motivo}.`);
    }
  );
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

  /**
   * Tarea 5 ("La voz cercana y la espera visible", 14/9/2026): businessStatus
   * pasa a viajar SIEMPRE, con asesor o sin él — antes de esta tarea solo
   * viajaba sin asesor, y `escalationInstruction`/`despedidaConAsesor`
   * (`tools.ts`/`agent.ts`) lo necesitan también con asesor, para poder
   * avisar "la tienda está cerrada" cuando corresponda. Ya se calculaba
   * siempre por dentro; lo único que cambió es que ahora también se expone.
   */
  it("con un asesor asignado y la tienda cerrada, el resultado igual trae businessStatus con la próxima apertura", async () => {
    claimNextAvailableAgentMock.mockResolvedValue({ id: "agent-1", displayName: "María" });
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

  it("sin now ni businessHours, usa el reloj real y el horario por defecto sin reventar", async () => {
    claimNextAvailableAgentMock.mockResolvedValue(null);
    const { client, estado } = createFakeSupabase();

    // @ts-expect-error -- fake mínimo
    const result = await escalateConversation(client, PARAMS);

    expect(estado.notas[0]).toMatch(/\(en horario\)|\(fuera de horario\)/);
    expect(result.businessStatus).toBeDefined();
  });
});
