import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchInboxCounts } from "@/lib/data";
import { freeformWindowCutoff } from "@/lib/dashboard";

// ---------------------------------------------------------------------------
// Los tres conteos de la reforma de píldoras del 28/8/2026: "Pendientes" (con
// o sin asesor — a propósito, ver la migración 20260828020000), su
// subconjunto fuera de la ventana de 24 h ("Esperando +24 h"), y "Lo mío".
// El fake reproduce `.from("conversations").select("id", {count, head})`
// encadenado con `.eq()/.neq()/.is()/.or()`, resolviendo como PostgREST
// resolvería un `count: "exact", head: true`: sin filas, solo el número.
// ---------------------------------------------------------------------------

interface Filtro {
  op: string;
  column: string;
  value: unknown;
}

interface Consulta {
  filtros: Filtro[];
  opciones: unknown;
}

interface FilaConteo {
  id: string;
  awaiting_reply: boolean;
  status: string;
  assigned_agent_id: string | null;
  last_customer_message_at: string | null;
}

function createFakeSupabase(rows: FilaConteo[]) {
  const consultas: Consulta[] = [];

  function builder(consulta: Consulta, current: FilaConteo[]) {
    const api = {
      eq(column: string, value: unknown) {
        consulta.filtros.push({ op: "eq", column, value });
        return builder(
          consulta,
          current.filter((row) => (row as unknown as Record<string, unknown>)[column] === value)
        );
      },
      neq(column: string, value: unknown) {
        consulta.filtros.push({ op: "neq", column, value });
        return builder(
          consulta,
          current.filter((row) => (row as unknown as Record<string, unknown>)[column] !== value)
        );
      },
      is(column: string, value: unknown) {
        consulta.filtros.push({ op: "is", column, value });
        return builder(
          consulta,
          current.filter(
            (row) => ((row as unknown as Record<string, unknown>)[column] ?? null) === value
          )
        );
      },
      // Fake mínimo: solo entiende las cláusulas que emite fetchInboxCounts
      // para `pendingStale` (`columna.lte.valor` y `columna.is.null`).
      or(clause: string) {
        consulta.filtros.push({ op: "or", column: "", value: clause });
        const conditions = clause.split(",").map((raw) => {
          const [column, op, ...rest] = raw.split(".");
          return { column, op, value: rest.join(".") };
        });
        return builder(
          consulta,
          current.filter((row) =>
            conditions.some(({ column, op, value }) => {
              const cell = (row as unknown as Record<string, unknown>)[column];
              if (op === "is") return value === "null" ? cell == null : cell === value;
              if (op === "lte") return cell != null && (cell as string) <= value;
              throw new Error(`operador "${op}" no soportado por el fake de .or()`);
            })
          )
        );
      },
      // Se resuelve como promesa: `count: "exact", head: true` no trae filas.
      then(resolve: (value: { count: number; error: null }) => unknown) {
        return resolve({ count: current.length, error: null });
      },
    };
    return api;
  }

  const client = {
    from() {
      return {
        select(_columns: string, opciones?: unknown) {
          const consulta: Consulta = { filtros: [], opciones };
          consultas.push(consulta);
          return builder(consulta, rows);
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, consultas };
}

const AHORA = Date.parse("2026-08-28T12:00:00.000Z");
const CUTOFF = freeformWindowCutoff(AHORA);
const DESPUES_DEL_CORTE = new Date(Date.parse(CUTOFF) + 1000).toISOString();
const ANTES_DEL_CORTE = new Date(Date.parse(CUTOFF) - 1000).toISOString();

function filas(): FilaConteo[] {
  return [
    // Pendiente, dentro de la ventana, sin asesor.
    {
      id: "conv-0",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: null,
      last_customer_message_at: DESPUES_DEL_CORTE,
    },
    // Pendiente, fuera de la ventana, CON asesor — cuenta igual: "Pendientes"
    // no exige "sin asesor" (migración 20260828020000).
    {
      id: "conv-1",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: "ana",
      last_customer_message_at: ANTES_DEL_CORTE,
    },
    // awaiting_reply, pero cerrada: no es "Pendientes".
    {
      id: "conv-2",
      awaiting_reply: true,
      status: "closed",
      assigned_agent_id: null,
      last_customer_message_at: ANTES_DEL_CORTE,
    },
    // No está esperando respuesta, pero es del viewer: cuenta para "mine".
    {
      id: "conv-3",
      awaiting_reply: false,
      status: "open",
      assigned_agent_id: "viewer-1",
      last_customer_message_at: null,
    },
    // Pendiente, del viewer, sin fecha de cliente: cae en "stale" (falla
    // cerrado) y también en "mine".
    {
      id: "conv-4",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: "viewer-1",
      last_customer_message_at: null,
    },
  ];
}

describe("fetchInboxCounts", () => {
  it('"pending" pregunta por awaiting_reply y status <> closed, sin condición de asesor', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[0].filtros).toEqual([
      { op: "eq", column: "awaiting_reply", value: true },
      { op: "neq", column: "status", value: "closed" },
    ]);
    expect(consultas[0].opciones).toEqual({ count: "exact", head: true });
  });

  it('"pendingStale" repite el predicado de "pending" y le agrega el corte de ventana invertido con .or(), incluido lo sin fecha', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[1].filtros).toEqual([
      { op: "eq", column: "awaiting_reply", value: true },
      { op: "neq", column: "status", value: "closed" },
      {
        op: "or",
        column: "",
        value: `last_customer_message_at.lte.${CUTOFF},last_customer_message_at.is.null`,
      },
    ]);
    expect(consultas[1].opciones).toEqual({ count: "exact", head: true });
  });

  it('"mine" pregunta por assigned_agent_id igual al viewer, igual que antes de la reforma', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas[2].filtros).toEqual([
      { op: "eq", column: "assigned_agent_id", value: "viewer-1" },
    ]);
    expect(consultas[2].opciones).toEqual({ count: "exact", head: true });
  });

  it("devuelve los tres números, cada uno contra su propio subconjunto", async () => {
    const { client } = createFakeSupabase(filas());

    const result = await fetchInboxCounts(client, "viewer-1", AHORA);

    // pending: conv-0, conv-1, conv-4 (awaiting_reply y no cerrada).
    // pendingStale: de esos, conv-1 (fuera de ventana) y conv-4 (sin fecha).
    // mine: conv-3 y conv-4 (assigned_agent_id === "viewer-1").
    expect(result).toEqual({ pending: 3, pendingStale: 2, mine: 2 });
  });
});
