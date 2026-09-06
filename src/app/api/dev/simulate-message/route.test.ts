import { describe, expect, it, vi, afterEach } from "vitest";
import { runAgentTurn } from "@/lib/ai/agent";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { POST } from "@/app/api/dev/simulate-message/route";

// Mocks mínimos: el route importa estas cuatro dependencias de forma
// estática, y las pruebas de esta suite solo necesitan verificar que la
// guarda de producción corta ANTES de tocarlas. `@/lib/ai/agent` va sin
// importOriginal() a propósito (CLAUDE.md): cargarlo de verdad arrastra los
// SDK de IA, Redis y turn-target.ts enteros, que este archivo no necesita —
// y ese módulo lo edita en paralelo otro subagente (Frente B).
vi.mock("@/lib/ai/agent", () => ({ runAgentTurn: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/data", () => ({ fetchCurrentAgent: vi.fn() }));

describe("POST /api/dev/simulate-message en producción", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("responde 404 sin tocar ninguna dependencia cuando NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Sin vi.resetModules(): el route lee process.env.NODE_ENV dentro del
    // handler POST (no a nivel de módulo), así que no hace falta recargarlo.

    const response = await POST(new Request("http://localhost/api/dev/simulate-message", { method: "POST" }));

    expect(response.status).toBe(404);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

// C3 (5/9/2026): antes de este arreglo, el contacto fijo del simulador traía
// `phone_number: "+00 000 0000001"` (con espacios) — `buildTurnTarget`
// (turn-target.ts, cargado de verdad dentro del `runAgentTurn` real) lo
// rechazaba con `TurnIdentityError` SIEMPRE, así que ningún turno sin
// `conversationId` llegaba jamás a completarse. Acá `runAgentTurn` va
// mockeado (no se ejercita turn-target.ts), así que lo que esta prueba
// verifica es la mitad que sí es responsabilidad del route: que arma/reusa
// la conversación de prueba y LLEGA a invocar el turno, en vez de fallar
// antes por la fila que crea con `upsert`.
function createFakeAdminClient() {
  const insertedMessages: Record<string, unknown>[] = [];
  const conversationInserts: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table === "whatsapp_channels") {
        return { upsert: async () => ({ data: null, error: null }) };
      }
      if (table === "contacts") {
        return { upsert: async () => ({ data: null, error: null }) };
      }
      if (table === "conversations") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    // Sin conversación previa: fuerza el camino de `insert`.
                    return { maybeSingle: async () => ({ data: null, error: null }) };
                  },
                };
              },
            };
          },
          insert(payload: Record<string, unknown>) {
            conversationInserts.push(payload);
            return {
              select() {
                return { single: async () => ({ data: { id: "conv-simulado" }, error: null }) };
              },
            };
          },
        };
      }
      if (table === "messages") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            insertedMessages.push(payload);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`Tabla no mockeada en este test: ${table}`);
    },
  };

  return { client, insertedMessages, conversationInserts };
}

describe("POST /api/dev/simulate-message sin conversationId", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("arma la conversación de prueba y llega a runAgentTurn en vez de fallar", async () => {
    const { client, insertedMessages, conversationInserts } = createFakeAdminClient();
    vi.mocked(createClient).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof createClient>>
    );
    vi.mocked(fetchCurrentAgent).mockResolvedValue(
      { id: "agente-1" } as unknown as Awaited<ReturnType<typeof fetchCurrentAgent>>
    );
    vi.mocked(createAdminClient).mockReturnValue(
      client as unknown as ReturnType<typeof createAdminClient>
    );
    vi.mocked(runAgentTurn).mockResolvedValue(undefined);

    const response = await POST(
      new Request("http://localhost/api/dev/simulate-message", {
        method: "POST",
        body: JSON.stringify({ text: "Hola, quiero cotizar una moto" }),
      })
    );
    const json = (await response.json()) as { conversationId?: string; ok?: boolean; error?: string };

    expect(json.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(json).toEqual({ conversationId: "conv-simulado", ok: true });
    // La conversación de prueba se crea contra el contacto/canal fijos.
    expect(conversationInserts).toEqual([
      {
        contact_id: "99999999-0000-0000-0000-000000000002",
        whatsapp_channel_id: "99999999-0000-0000-0000-000000000001",
      },
    ]);
    expect(insertedMessages).toEqual([
      expect.objectContaining({
        conversation_id: "conv-simulado",
        direction: "inbound",
        sender_type: "customer",
        content: "Hola, quiero cotizar una moto",
      }),
    ]);
    // El punto central de C3: el turno SÍ se invoca, no falla antes por la
    // identidad del contacto de prueba.
    expect(runAgentTurn).toHaveBeenCalledWith("conv-simulado");
  });
});
