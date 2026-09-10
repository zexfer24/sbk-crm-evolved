import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dayRangeFrom,
  fetchAgentDaySummary,
  fetchAiAssignmentsToday,
} from "@/lib/agent-day-data";

// ---------------------------------------------------------------------------
// T3, "Los números del día" (10/9/2026). Dos fakes chicos, uno por forma de
// llamada: `fetchAgentDaySummary` pasa por `supabase.rpc(...)` (como
// `fetchAgentMetrics` en data.ts); `fetchAiAssignmentsToday` pasa por
// `.from().select().eq()...` (mismo patrón de cadena que
// `data-inbox-counts.test.ts`, pero sin `.or()`).
// ---------------------------------------------------------------------------

function createFakeRpc(response: { data: unknown; error: unknown }) {
  const llamadas: { nombre: string; params: unknown }[] = [];
  const client = {
    rpc(nombre: string, params: unknown) {
      llamadas.push({ nombre, params });
      return Promise.resolve(response);
    },
  };
  return { client: client as unknown as SupabaseClient, llamadas };
}

describe("fetchAgentDaySummary", () => {
  it("llama al RPC agent_day_summary con p_from/p_to exactos y convierte numeric/bigint de texto a número", async () => {
    const { client, llamadas } = createFakeRpc({
      data: [{ asignadas: "7", respondidas: "5", ventas: "2", monto: "412.50" }],
      error: null,
    });

    const result = await fetchAgentDaySummary(client, {
      from: "2026-09-10T04:00:00.000Z",
      to: "2026-09-11T04:00:00.000Z",
    });

    expect(llamadas).toEqual([
      {
        nombre: "agent_day_summary",
        params: { p_from: "2026-09-10T04:00:00.000Z", p_to: "2026-09-11T04:00:00.000Z" },
      },
    ]);
    expect(result).toEqual({ asignadas: 7, respondidas: 5, ventas: 2, montoUsd: 412.5 });
  });

  it("sin fila devuelve ceros, no null", async () => {
    const { client } = createFakeRpc({ data: [], error: null });

    const result = await fetchAgentDaySummary(client, {
      from: "2026-09-10T04:00:00.000Z",
      to: "2026-09-11T04:00:00.000Z",
    });

    expect(result).toEqual({ asignadas: 0, respondidas: 0, ventas: 0, montoUsd: 0 });
  });

  it("con error de Postgres, lanza en vez de devolver un resumen a medias", async () => {
    const { client } = createFakeRpc({
      data: null,
      error: { message: "no autorizado", code: "42501" },
    });

    await expect(
      fetchAgentDaySummary(client, {
        from: "2026-09-10T04:00:00.000Z",
        to: "2026-09-11T04:00:00.000Z",
      })
    ).rejects.toEqual({ message: "no autorizado", code: "42501" });
  });
});

interface Filtro {
  op: string;
  column: string;
  value: unknown;
}

interface RawRow {
  id: string;
  conversation_id: string;
  created_at: string;
  to_kind: string;
  to_id: string;
  reason: string;
  conversation: {
    contact: { display_name: string | null; profile_name: string | null; phone_number: string } | null;
  } | null;
}

function createFakeHandoffs(rows: RawRow[]) {
  const filtros: Filtro[] = [];
  let ordenCol: string | undefined;
  let ordenOpts: unknown;
  let limiteN: number | undefined;

  function builder(current: RawRow[]) {
    const api = {
      eq(column: string, value: unknown) {
        filtros.push({ op: "eq", column, value });
        return builder(
          current.filter((row) => (row as unknown as Record<string, unknown>)[column] === value)
        );
      },
      gte(column: string, value: unknown) {
        filtros.push({ op: "gte", column, value });
        return builder(
          current.filter(
            (row) => ((row as unknown as Record<string, unknown>)[column] as string) >= (value as string)
          )
        );
      },
      order(column: string, opts: { ascending?: boolean }) {
        ordenCol = column;
        ordenOpts = opts;
        const ascending = opts?.ascending ?? true;
        const sorted = [...current].sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[column] as string;
          const bv = (b as unknown as Record<string, unknown>)[column] as string;
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return ascending ? cmp : -cmp;
        });
        return builder(sorted);
      },
      limit(n: number) {
        limiteN = n;
        return builder(current.slice(0, n));
      },
      then(resolve: (value: { data: RawRow[]; error: null }) => unknown) {
        return resolve({ data: current, error: null });
      },
    };
    return api;
  }

  const client = {
    from() {
      return {
        select() {
          return builder(rows);
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    filtros: () => filtros,
    orden: () => ({ column: ordenCol, opts: ordenOpts }),
    limite: () => limiteN,
  };
}

function fila(over: Partial<RawRow> = {}): RawRow {
  return {
    id: "handoff-1",
    conversation_id: "conv-1",
    created_at: "2026-09-10T12:00:00.000Z",
    to_kind: "human",
    to_id: "agent-1",
    reason: "escalada",
    conversation: {
      contact: { display_name: "Pedro", profile_name: "Pedrito", phone_number: "584121234567" },
    },
    ...over,
  };
}

describe("fetchAiAssignmentsToday", () => {
  it("arma la consulta con to_kind=human, to_id, reason=escalada, gte since, orden descendente y el límite", async () => {
    const { client, filtros, orden, limite } = createFakeHandoffs([fila()]);

    await fetchAiAssignmentsToday(client, "agent-1", "2026-09-10T04:00:00.000Z", 5);

    expect(filtros()).toEqual([
      { op: "eq", column: "to_kind", value: "human" },
      { op: "eq", column: "to_id", value: "agent-1" },
      { op: "eq", column: "reason", value: "escalada" },
      { op: "gte", column: "created_at", value: "2026-09-10T04:00:00.000Z" },
    ]);
    expect(orden()).toEqual({ column: "created_at", opts: { ascending: false } });
    expect(limite()).toBe(5);
  });

  it("mapea el nombre del contacto con el orden display_name -> profile_name -> phone_number", async () => {
    const rows = [
      fila({
        id: "h-1",
        conversation: { contact: { display_name: "Pedro", profile_name: null, phone_number: "584121111111" } },
      }),
      fila({
        id: "h-2",
        conversation: { contact: { display_name: null, profile_name: "Perfil WA", phone_number: "584122222222" } },
      }),
      fila({
        id: "h-3",
        conversation: { contact: { display_name: null, profile_name: null, phone_number: "584123333333" } },
      }),
    ];
    const { client } = createFakeHandoffs(rows);

    const result = await fetchAiAssignmentsToday(client, "agent-1", "2026-09-10T04:00:00.000Z");

    expect(result.map((r) => r.contactName)).toEqual(["Pedro", "Perfil WA", "584123333333"]);
    expect(result[0]).toEqual({
      handoffId: "h-1",
      conversationId: "conv-1",
      contactName: "Pedro",
      createdAt: "2026-09-10T12:00:00.000Z",
    });
  });

  it("con límite por defecto pide 5", async () => {
    const { client, limite } = createFakeHandoffs([fila()]);

    await fetchAiAssignmentsToday(client, "agent-1", "2026-09-10T04:00:00.000Z");

    expect(limite()).toBe(5);
  });
});

describe("dayRangeFrom", () => {
  it("suma exactamente 24 h a `from` para armar `to`, y deja `from` intacto", () => {
    const result = dayRangeFrom("2026-09-10T04:00:00.000Z");

    expect(result.from).toBe("2026-09-10T04:00:00.000Z");
    expect(result.to).toBe("2026-09-11T04:00:00.000Z");
    expect(Date.parse(result.to) - Date.parse(result.from)).toBe(24 * 60 * 60 * 1000);
  });
});
