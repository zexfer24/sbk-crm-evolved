import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "@/lib/ai/classify";
import type { TurnTarget } from "@/lib/ai/turn-target";

// ---------------------------------------------------------------------------
// La pregunta que estas pruebas contestan es la que da más miedo del sistema:
// con un lote donde algunas conversaciones fallan, ¿puede la respuesta de un
// cliente terminar en el chat de otro?
//
// El lote es lo que hace el escenario: varios turnos corriendo a la vez, unos
// fallando y otros no. Es exactamente lo que produce un rate limit del
// proveedor —unos turnos reciben 429 y otros pasan dentro del mismo minuto—,
// que es como este archivo nació.
//
// Cada conversación tiene su propio cliente, su propio número y su propio
// mensaje, y el modelo responde con un texto que lleva la marca de quién
// preguntó. Así, un cruce no se manifiesta como "falló algo": se ve como el
// texto de A saliendo por el número de B.
// ---------------------------------------------------------------------------

interface ConversacionFalsa {
  id: string;
  contactId: string;
  phoneNumber: string;
  /** Lo que escribió el cliente. Es lo que hace identificable a cada turno. */
  mensaje: string;
}

const CONVERSACIONES: ConversacionFalsa[] = [
  { id: "conv-ana", contactId: "contacto-ana", phoneNumber: "+584120000001", mensaje: "soy ana, busco cauchos" },
  { id: "conv-beto", contactId: "contacto-beto", phoneNumber: "+584120000002", mensaje: "soy beto, busco frenos" },
  { id: "conv-cami", contactId: "contacto-cami", phoneNumber: "+584120000003", mensaje: "soy cami, busco aceite" },
  { id: "conv-dani", contactId: "contacto-dani", phoneNumber: "+584120000004", mensaje: "soy dani, busco cadena" },
];

function porId(id: string): ConversacionFalsa {
  const encontrada = CONVERSACIONES.find((c) => c.id === id);
  if (!encontrada) throw new Error(`conversación desconocida en la prueba: ${id}`);
  return encontrada;
}

/** Ids cuya fase de clasificación revienta con un 429, como en el incidente. */
let clasificacionFallaEn = new Set<string>();
/** Ids donde algo posterior al envío revienta (un corte con la base, típico). */
let fallaDespuesDelEnvioEn = new Set<string>();
/**
 * Chats cuya consulta devuelve la fila de OTRO chat.
 *
 * Es el cruce en su forma más pura: una consulta mal filtrada, un caché
 * envenenado, un embed que trae de más. No hace falta que sea probable —
 * hace falta que si pasa, el mensaje no salga.
 */
let filaCruzada = new Map<string, string>();

// ---------------------------------------------------------------------------
// Supabase falso, con VARIAS conversaciones. El de agent.test.ts sirve una
// sola, y una sola conversación no puede revelar un cruce.
// ---------------------------------------------------------------------------

const turnosRegistrados: { conversationId: string; action: string; summary: string }[] = [];

function createFakeSupabase() {
  return {
    rpc(fn: string) {
      if (fn === "agent_can_run") return Promise.resolve({ data: true, error: null });
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    },
    from(table: string) {
      if (table === "conversations") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => {
                const convo = porId(filaCruzada.get(id) ?? id);
                return {
                  data: {
                    id: convo.id,
                    contact_id: convo.contactId,
                    ai_enabled: true,
                    assigned_agent_id: null,
                    welcome_sent_at: "2026-08-22T10:00:00Z",
                    last_customer_message_at: new Date().toISOString(),
                    contact: { phone_number: convo.phoneNumber },
                    channel: { phone_number_id: "pnid-1", status: "connected" },
                  },
                };
              },
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              // Adquisición del lock: encadena un segundo .eq() y un .select().
              if (values.ai_turn_running === true) {
                return { eq: () => ({ select: async () => ({ data: [{ id }] }) }) };
              }
              // El corte simulado pega acá: es una escritura que el turno hace
              // DESPUÉS de responderle al cliente (limpiar journey_stage).
              if (values.journey_stage === null && fallaDespuesDelEnvioEn.has(id)) {
                return Promise.reject(new Error("se cayó la conexión con la base"));
              }
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }

      if (table === "messages") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              order: () => ({
                limit: async () => ({
                  data: [{ sender_type: "customer", content: porId(id).mensaje, is_internal_note: false }],
                }),
              }),
              // Ningún asesor escribió en estos chats: son conversaciones que
              // la IA sí tiene permitido atender. Lo contrario se prueba en
              // human-handled.test.ts.
              eq: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
          }),
        };
      }

      if (table === "agent_tools") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }

      if (table === "agent_turns") {
        return {
          insert: (row: Record<string, unknown>) => {
            turnosRegistrados.push({
              conversationId: String(row.conversation_id),
              action: String(row.action),
              summary: String(row.summary),
            });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createFakeSupabase() }));

vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: async () => ({
    playbook: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }),
  fetchActivePlaybooks: async () => [],
}));

/** Lo que de verdad se le mandó a cada cliente: texto y destinatario, juntos. */
const enviados: { target: TurnTarget; text: string }[] = [];
vi.mock("@/lib/ai/send", () => ({
  sendAgentText: async (_supabase: unknown, target: TurnTarget, text: string) => {
    enviados.push({ target, text });
  },
  sendPlaybookReply: async () => undefined,
}));

/**
 * La clasificación falla con el error real del incidente para los ids
 * marcados. Distingue por el contenido del mensaje porque es lo único que
 * recibe: si el turno le pasara el historial de otra conversación, este mock
 * fallaría al cliente equivocado y la prueba lo vería.
 */
vi.mock("@/lib/ai/classify", () => ({
  classifyIntent: async (history: { content: string }[]) => {
    const mensaje = history[history.length - 1]?.content ?? "";
    const convo = CONVERSACIONES.find((c) => c.mensaje === mensaje);
    if (!convo) throw new Error(`el turno clasificó un historial que no es de nadie: ${mensaje}`);

    if (clasificacionFallaEn.has(convo.id)) {
      throw new Error(
        "Failed after 3 attempts. Last error: AI_APICallError: Rate limit exceeded: " +
          "new-account-rpm/openai/gpt-5.6-luna-20260709."
      );
    }

    return {
      intent: "consulta_disponibilidad" as Intent,
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    };
  },
}));

vi.mock("@/lib/ai/escalate", () => ({
  escalateConversation: async () => ({ escalated: true, assignedAgentName: "María" }),
  RECLAMO_CATEGORIES: ["Envío", "Pago", "Producto", "Atención", "Garantía"],
}));

/**
 * El modelo responde citando el mensaje que recibió. Es lo que convierte un
 * cruce en algo visible: si la respuesta de Ana sale por el número de Beto,
 * el texto lo dice.
 */
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: class {
    generate = async ({ messages }: { messages: { content: string }[] }) => ({
      text: `respuesta para "${messages[messages.length - 1]?.content}"`,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    });
  },
}));

vi.mock("@/lib/ai/model", () => ({
  getAgentModel: () => ({ model: "modelo-falso" }),
  getClassifierModel: () => ({ model: "modelo-falso" }),
  currentAgentModelLabel: () => "fake/modelo",
}));

vi.mock("@/lib/ai/tools", () => ({
  buildCatalogTool: () => ({}),
  buildEscalateTool: () => ({}),
  buildOrderHistoryTool: () => ({}),
}));

vi.mock("@/lib/ai/knowledge", () => ({ buildKnowledgeTool: () => ({}) }));

import { runAgentTurn } from "@/lib/ai/agent";
import { NonRetryableTurnError } from "@/lib/ai/turn-delivery";
import { buildTurnTarget, TurnIdentityError, type AgentConversation } from "@/lib/ai/turn-target";

beforeEach(() => {
  clasificacionFallaEn = new Set();
  fallaDespuesDelEnvioEn = new Set();
  filaCruzada = new Map();
  enviados.length = 0;
  turnosRegistrados.length = 0;
});

/** Corre el lote entero a la vez, que es como lo corre la cola. */
async function correrLote(ids: string[]) {
  return Promise.allSettled(ids.map((id) => runAgentTurn(id)));
}

describe("lote con fallos parciales", () => {
  /**
   * El escenario del incidente: cuatro turnos en el mismo minuto, dos se
   * comen el 429 al clasificar y dos pasan.
   *
   * Lo que se comprueba no es que "funcione": es que el texto que se le
   * mandó a cada cliente sea el suyo. Con dos turnos caídos, una lista de
   * resultados emparejada por posición correría dos lugares y le mandaría a
   * Cami la respuesta de Dani.
   */
  it("le manda a cada cliente su propia respuesta aunque la mitad del lote falle", async () => {
    clasificacionFallaEn = new Set(["conv-beto", "conv-dani"]);

    await correrLote(CONVERSACIONES.map((c) => c.id));

    expect(enviados).toHaveLength(2);

    for (const { target, text } of enviados) {
      const dueño = CONVERSACIONES.find((c) => c.phoneNumber === target.phoneNumber);
      expect(dueño, `se envió a un número que no es de nadie: ${target.phoneNumber}`).toBeDefined();

      // Las tres identidades tienen que apuntar al mismo cliente: el número
      // por el que salió, el chat donde se guardó y el contacto asociado.
      expect(target.conversationId).toBe(dueño!.id);
      expect(target.contactId).toBe(dueño!.contactId);
      // Y el texto tiene que ser respuesta a lo que ESE cliente escribió.
      expect(text).toContain(dueño!.mensaje);
    }

    const atendidos = enviados.map((e) => e.target.conversationId).sort();
    expect(atendidos).toEqual(["conv-ana", "conv-cami"]);
  });

  /**
   * Caerse a una intención por defecto y contestar igual sería lo peor de
   * los dos mundos: el cliente recibe algo que no responde a lo que
   * preguntó, y en la bitácora parece un turno atendido.
   */
  it("no le manda nada al cliente cuya clasificación falló", async () => {
    clasificacionFallaEn = new Set(["conv-beto", "conv-dani"]);

    await correrLote(CONVERSACIONES.map((c) => c.id));

    const numerosEscritos = enviados.map((e) => e.target.phoneNumber);
    expect(numerosEscritos).not.toContain(porId("conv-beto").phoneNumber);
    expect(numerosEscritos).not.toContain(porId("conv-dani").phoneNumber);
  });

  /** Un turno que no respondió tiene que quedar visible como error, no como atendido. */
  it("deja el fallo en la bitácora del chat que falló, y de ninguno más", async () => {
    clasificacionFallaEn = new Set(["conv-beto"]);

    await correrLote(CONVERSACIONES.map((c) => c.id));

    const errores = turnosRegistrados.filter((t) => t.action === "error");
    expect(errores).toHaveLength(1);
    expect(errores[0].conversationId).toBe("conv-beto");
    expect(errores[0].summary).toContain("Fallo al clasificar intención");
  });

  /**
   * El lote corre en paralelo de verdad, no uno detrás de otro. Si algo
   * guardara la "conversación actual" en una variable de módulo o en un
   * cliente compartido, se pisaría acá y no en la ejecución secuencial.
   */
  it("mantiene separados los turnos aunque corran entrelazados", async () => {
    clasificacionFallaEn = new Set(["conv-cami"]);

    // Dos vueltas del lote a la vez: el doble de entrelazado.
    const ids = CONVERSACIONES.map((c) => c.id);
    await Promise.all([correrLote(ids), correrLote(ids)]);

    for (const { target, text } of enviados) {
      const dueño = CONVERSACIONES.find((c) => c.phoneNumber === target.phoneNumber)!;
      expect(text).toContain(dueño.mensaje);
      expect(target.conversationId).toBe(dueño.id);
    }
  });
});

describe("fallo posterior al envío", () => {
  /**
   * El caso que le mandaba el mismo mensaje dos veces al cliente: el envío
   * salió bien y lo que reventó fue un paso posterior. Antes eso subía como
   * un error cualquiera, la cola lo re-encolaba y el turno volvía a correr
   * entero — clasificando y enviando otra vez.
   */
  it("sale como no reintentable para que la cola no lo reenvíe", async () => {
    fallaDespuesDelEnvioEn = new Set(["conv-ana"]);

    await expect(runAgentTurn("conv-ana")).rejects.toBeInstanceOf(NonRetryableTurnError);

    // El mensaje salió una sola vez: es lo que no se puede deshacer.
    expect(enviados).toHaveLength(1);
    expect(enviados[0].target.phoneNumber).toBe(porId("conv-ana").phoneNumber);
  });

  /** Un fallo ANTES de responder sí se reintenta: no hay nada que duplicar. */
  it("un fallo sin envío de por medio sigue siendo reintentable", async () => {
    // La clasificación falla, pero eso el turno lo captura y lo registra sin
    // lanzar: no hay envío ni excepción hacia la cola.
    clasificacionFallaEn = new Set(["conv-ana"]);

    await expect(runAgentTurn("conv-ana")).resolves.toBeUndefined();
    expect(enviados).toHaveLength(0);
  });
});

describe("verificación de identidad", () => {
  /**
   * El cruce recorriendo el turno completo, no solo la función que verifica.
   *
   * La cola pide el turno de Ana y la base devuelve la fila de Beto. Sin la
   * comprobación, el turno seguiría contento: leería el historial de Ana,
   * redactaría para Ana y lo enviaría al número de Beto. Con ella, el turno
   * aborta antes de tocar el modelo y no sale nada.
   */
  it("aborta el turno sin enviar nada si la base devuelve la fila de otro chat", async () => {
    filaCruzada = new Map([["conv-ana", "conv-beto"]]);

    await expect(runAgentTurn("conv-ana")).rejects.toBeInstanceOf(NonRetryableTurnError);

    expect(enviados).toHaveLength(0);
  });

  /**
   * Y los demás del lote no se ven afectados: un chat con la identidad rota
   * no puede arrastrar al resto.
   */
  it("no arrastra al resto del lote", async () => {
    filaCruzada = new Map([["conv-ana", "conv-beto"]]);

    await correrLote(CONVERSACIONES.map((c) => c.id));

    const atendidos = enviados.map((e) => e.target.conversationId).sort();
    expect(atendidos).toEqual(["conv-beto", "conv-cami", "conv-dani"]);
    for (const { target, text } of enviados) {
      const dueño = CONVERSACIONES.find((c) => c.phoneNumber === target.phoneNumber)!;
      expect(text).toContain(dueño.mensaje);
    }
  });


  function fila(overrides: Partial<AgentConversation> = {}): AgentConversation {
    return {
      id: "conv-ana",
      contact_id: "contacto-ana",
      ai_enabled: true,
      assigned_agent_id: null,
      welcome_sent_at: null,
      last_customer_message_at: new Date().toISOString(),
      contact: { phone_number: "+584120000001" },
      channel: { phone_number_id: "pnid-1", status: "connected" },
      ...overrides,
    };
  }

  /**
   * La comprobación central: la fila que volvió de la base tiene que ser del
   * chat que pidió la cola. Es la que corta un cruce antes del envío en vez
   * de después.
   */
  it("rechaza una fila que es de otro chat", () => {
    expect(() => buildTurnTarget("conv-ana", fila({ id: "conv-beto" }))).toThrow(TurnIdentityError);
  });

  it("rechaza un contacto sin número: no hay a quién escribirle", () => {
    expect(() =>
      buildTurnTarget("conv-ana", fila({ contact: undefined as unknown as { phone_number: string } }))
    ).toThrow(TurnIdentityError);
  });

  it("rechaza una conversación sin contacto asociado", () => {
    expect(() => buildTurnTarget("conv-ana", fila({ contact_id: "" }))).toThrow(TurnIdentityError);
  });

  /**
   * Tener algo guardado no es tener un teléfono. Un contacto con '+undefined'
   * pasaba esta comprobación —la cadena no está vacía— y el turno corría
   * entero para producir una llamada a Meta con destinatario vacío: `toWaId`
   * le quita todo lo que no es dígito y no queda nada.
   */
  it.each([["+undefined"], ["undefined"], ["584120000001"], ["+CO.1550555583222997"], ["+"]])(
    "rechaza un contacto cuyo número no es un teléfono: %s",
    (phone_number) => {
      expect(() => buildTurnTarget("conv-ana", fila({ contact: { phone_number } }))).toThrow(
        TurnIdentityError
      );
    }
  );

  /** Congelado: nada puede reapuntarlo a otro chat a mitad de turno. */
  it("entrega un destinatario que no se puede modificar", () => {
    const target = buildTurnTarget("conv-ana", fila());

    expect(() => {
      (target as { phoneNumber: string }).phoneNumber = "+584129999999";
    }).toThrow();
    expect(target.phoneNumber).toBe("+584120000001");
  });
});
