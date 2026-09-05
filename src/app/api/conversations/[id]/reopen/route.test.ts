import { describe, expect, it, vi, beforeEach } from "vitest";

/** Gemelo de close/route.test.ts: mismo patrón de dos clientes (ver su cabecera). */

interface FakeAgent {
  id: string;
  displayName: string;
  fullName: string;
  avatarUrl: string | null;
  role: string;
  isActive: boolean;
}

let currentAgent: FakeAgent | null;

vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: vi.fn(async () => currentAgent),
}));

const conversationUpdates: { id: string; patch: Record<string, unknown> }[] = [];
const insertedEvents: Record<string, unknown>[] = [];

function createFakeSessionClient() {
  return {
    from(table: string) {
      if (table === "conversations") {
        return {
          update(patch: Record<string, unknown>) {
            return {
              eq: async (_col: string, id: string) => {
                conversationUpdates.push({ id, patch });
                return { error: null };
              },
            };
          },
        };
      }
      if (table === "messages") {
        return {
          insert(row: Record<string, unknown>) {
            insertedEvents.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Tabla inesperada en el test: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => createFakeSessionClient()),
}));

const handoffCalls: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, params?: Record<string, unknown>) => {
      if (fn === "record_handoff") {
        handoffCalls.push(params ?? {});
        return { data: "handoff-1", error: null };
      }
      throw new Error(`RPC inesperada en el test: ${fn}`);
    },
  }),
}));

import { POST } from "./route";

function fakeRequest(): Request {
  return new Request("http://crm.example/api/conversations/conv-1/reopen", { method: "POST" });
}

function ctx(id = "conv-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  currentAgent = {
    id: "agent-1",
    displayName: "María",
    fullName: "María Pérez",
    avatarUrl: null,
    role: "agent",
    isActive: true,
  };
  conversationUpdates.length = 0;
  insertedEvents.length = 0;
  handoffCalls.length = 0;
});

describe("POST /api/conversations/[id]/reopen", () => {
  it("sin sesión responde 401 y no toca nada", async () => {
    currentAgent = null;

    const res = await POST(fakeRequest(), ctx());

    expect(res.status).toBe(401);
    expect(conversationUpdates).toHaveLength(0);
    expect(insertedEvents).toHaveLength(0);
    expect(handoffCalls).toHaveLength(0);
  });

  it("reabre la conversación, deja el evento de sistema y el traspaso a quien reabrió", async () => {
    const res = await POST(fakeRequest(), ctx("conv-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });

    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: { status: "open" } });

    expect(insertedEvents[0]).toMatchObject({
      conversation_id: "conv-1",
      sender_type: "system",
      message_type: "system_event",
      content: "María reabrió la conversación",
    });

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_to_id: "agent-1",
      p_reason: "reabierta_por_asesor",
      p_created_by: "user",
    });
  });
});
