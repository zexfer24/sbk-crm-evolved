import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchUnassignedConversations } from "@/lib/data";

// ---------------------------------------------------------------------------
// T1.6 del plan "Ningún lead invisible": la píldora "Sin dueño".
// `fetchUnassignedConversations` hace DOS consultas contra "conversations" —
// candidatos (con `conversation_handoffs` embebido y acotado a la fila más
// reciente por `embedLatestHandoff`, ver data.ts) y filas completas
// (`fetchConversations(..., { ids })`). El fake distingue una de otra por el
// `select` pedido: solo la de candidatos pide `conversation_handoffs(...)`.
//
// No reimplementa el LATERAL de PostgREST: los fixtures de candidatos ya
// traen la bitácora reducida a UN elemento (a lo sumo), como la entregaría
// la base real con `embedLatestHandoff` — lo que este archivo prueba es que
// `fetchUnassignedConversations` filtra bien sobre eso (vía
// `isUnassignedLead`, probada aparte en inbox-filters.test.ts con traspasos
// fabricados a mano) y que hidrata solo las filas que corresponden.
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  last_message_at: string | null;
  awaiting_reply: boolean;
  conversation_handoffs: { to_kind: string; created_at: string }[];
}

function candidate(
  id: string,
  awaitingReply: boolean,
  handoffs: { to_kind: string; created_at: string }[]
): CandidateRow {
  return {
    id,
    last_message_at: "2026-08-30T10:00:00Z",
    awaiting_reply: awaitingReply,
    conversation_handoffs: handoffs,
  };
}

function summaryRow(id: string) {
  return {
    id,
    status: "open" as const,
    unread_count: 0,
    manually_unread: false,
    ai_enabled: true,
    deal_status: "none" as const,
    deal_verified: false,
    last_customer_message_at: "2026-08-30T09:00:00Z",
    last_message_at: "2026-08-30T10:00:00Z",
    has_reply: false,
    created_at: "2026-08-29T10:00:00Z",
    journey_stage: null,
    intent: null,
    active_tool: null,
    welcome_sent_at: null,
    last_message_preview: `preview ${id}`,
    last_message_direction: null,
    last_message_status: null,
    contact: {
      id: `contact-${id}`,
      phone_number: "584100000",
      display_name: `Cliente ${id}`,
      profile_name: null,
      avatar_url: null,
      contact_tags: [],
    },
    assigned_agent: null,
  };
}

type SummaryRow = ReturnType<typeof summaryRow>;

function createFakeSupabase(candidates: CandidateRow[], summaries: Map<string, SummaryRow>) {
  function builder(isCandidateQuery: boolean, idFilter: string[] | null) {
    const api = {
      // `.order()`/`.limit()` (con o sin `{foreignTable}`) no hacen falta acá:
      // los fixtures de candidatos ya vienen con la bitácora reducida a la
      // más reciente, como la entregaría la base real.
      order() {
        return api;
      },
      limit() {
        return api;
      },
      // Solo la usa la consulta de candidatos (`awaiting_reply`); no filtra
      // acá a propósito — lo que este archivo prueba es que
      // `fetchUnassignedConversations` filtra bien EN MEMORIA sobre lo que
      // la base le entrega, no que la base sepa filtrar `.eq()`.
      eq() {
        return api;
      },
      in(column: string, values: string[]) {
        if (column !== "id") throw new Error(`columna inesperada en .in(): ${column}`);
        return builder(isCandidateQuery, values);
      },
      range(from: number, to: number) {
        if (isCandidateQuery) {
          return Promise.resolve({ data: candidates.slice(from, to + 1), error: null });
        }
        const ids = idFilter ?? [];
        const rows = ids
          .map((id) => summaries.get(id))
          .filter((row): row is SummaryRow => Boolean(row));
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
    };
    return api;
  }

  const client = {
    from() {
      return {
        select(query: string) {
          const isCandidateQuery = query.includes("conversation_handoffs(");
          return builder(isCandidateQuery, null);
        },
      };
    },
  };

  return client as unknown as SupabaseClient;
}

describe("fetchUnassignedConversations", () => {
  it("incluye la que sigue esperando y cuyo último traspaso fue a unassigned", async () => {
    const candidates = [candidate("conv-a", true, [{ to_kind: "unassigned", created_at: "2026-08-30T10:00:00Z" }])];
    const summaries = new Map([["conv-a", summaryRow("conv-a")]]);

    const result = await fetchUnassignedConversations(createFakeSupabase(candidates, summaries));

    expect(result.map((c) => c.id)).toEqual(["conv-a"]);
  });

  it("no incluye la que ya tiene un traspaso posterior (a ai o a human)", async () => {
    // Simula lo que entregaría la base tras el `.limit(1, {foreignTable})`:
    // el traspaso embebido es el ÚLTIMO, y ya no es `unassigned`.
    const candidates = [
      candidate("conv-ai", true, [{ to_kind: "ai", created_at: "2026-08-30T11:00:00Z" }]),
      candidate("conv-human", true, [{ to_kind: "human", created_at: "2026-08-30T11:00:00Z" }]),
    ];
    const summaries = new Map([
      ["conv-ai", summaryRow("conv-ai")],
      ["conv-human", summaryRow("conv-human")],
    ]);

    const result = await fetchUnassignedConversations(createFakeSupabase(candidates, summaries));

    expect(result).toEqual([]);
  });

  it("no incluye la que no está esperando respuesta, aunque el traspaso diga unassigned", async () => {
    const candidates = [
      candidate("conv-contestada", false, [{ to_kind: "unassigned", created_at: "2026-08-30T10:00:00Z" }]),
    ];
    const summaries = new Map([["conv-contestada", summaryRow("conv-contestada")]]);

    const result = await fetchUnassignedConversations(createFakeSupabase(candidates, summaries));

    expect(result).toEqual([]);
  });

  it("no incluye la que todavía no tiene ningún traspaso en la bitácora", async () => {
    const candidates = [candidate("conv-sin-bitacora", true, [])];
    const summaries = new Map([["conv-sin-bitacora", summaryRow("conv-sin-bitacora")]]);

    const result = await fetchUnassignedConversations(createFakeSupabase(candidates, summaries));

    expect(result).toEqual([]);
  });

  it("hidrata solo las que califican, no todos los candidatos consultados", async () => {
    const candidates = [
      candidate("conv-a", true, [{ to_kind: "unassigned", created_at: "2026-08-30T10:00:00Z" }]),
      candidate("conv-b", true, [{ to_kind: "human", created_at: "2026-08-30T10:00:00Z" }]),
      candidate("conv-c", true, [{ to_kind: "unassigned", created_at: "2026-08-30T09:00:00Z" }]),
    ];
    const summaries = new Map([
      ["conv-a", summaryRow("conv-a")],
      ["conv-b", summaryRow("conv-b")],
      ["conv-c", summaryRow("conv-c")],
    ]);

    const result = await fetchUnassignedConversations(createFakeSupabase(candidates, summaries));

    expect(result.map((c) => c.id).sort()).toEqual(["conv-a", "conv-c"]);
  });
});
