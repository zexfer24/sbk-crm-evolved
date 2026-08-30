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
  unread_count: number;
  manually_unread: boolean;
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
      // Fake mínimo: entiende las cláusulas que emite fetchInboxCounts para
      // `pendingStale` (`columna.lte.valor` y `columna.is.null`) y para
      // `unread` (`columna.gt.valor` y `columna.is.true`).
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
              if (op === "is") {
                if (value === "null") return cell == null;
                if (value === "true") return cell === true;
                return cell === value;
              }
              if (op === "lte") return cell != null && (cell as string) <= value;
              if (op === "gt") return cell != null && (cell as number) > Number(value);
              throw new Error(`operador "${op}" no soportado por el fake de .or()`);
            })
          )
        );
      },
      // La consulta de "Sin dueño" (`fetchUnassignedConversationIds`) no es un
      // conteo: pide filas con la bitácora embebida y ordena/limita esa
      // relación. Acá esos tres solo tienen que no romper la cadena — lo que
      // el corte decide se prueba en `data-unassigned-conversations.test.ts`,
      // contra un doble que sí modela la bitácora.
      order() {
        return builder(consulta, current);
      },
      range(desde: number, hasta: number) {
        return builder(consulta, current.slice(desde, hasta + 1));
      },
      limit() {
        return builder(consulta, current);
      },
      in(column: string, values: unknown[]) {
        consulta.filtros.push({ op: "in", column, value: values });
        return builder(
          consulta,
          current.filter((row) =>
            values.includes((row as unknown as Record<string, unknown>)[column])
          )
        );
      },
      // Se resuelve como promesa. Para los cuatro conteos, `count: "exact",
      // head: true` no trae filas; para la consulta de "Sin dueño" se
      // devuelven las filas con la bitácora vacía, que es lo que hace que
      // ninguna califique y el contador dé 0 en este archivo.
      then(
        resolve: (value: {
          count: number;
          data: Record<string, unknown>[];
          error: null;
        }) => unknown
      ) {
        return resolve({
          count: current.length,
          data: current.map((row) => ({ ...row, conversation_handoffs: [] })),
          error: null,
        });
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
      unread_count: 0,
      manually_unread: false,
    },
    // Pendiente, fuera de la ventana, CON asesor — cuenta igual: "Pendientes"
    // no exige "sin asesor" (migración 20260828020000).
    {
      id: "conv-1",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: "ana",
      last_customer_message_at: ANTES_DEL_CORTE,
      unread_count: 0,
      manually_unread: false,
    },
    // awaiting_reply, pero cerrada: no es "Pendientes". Sí trae mensajes sin
    // leer: cuenta para "unread" (decisión de diseño — ver el test de abajo).
    {
      id: "conv-2",
      awaiting_reply: true,
      status: "closed",
      assigned_agent_id: null,
      last_customer_message_at: ANTES_DEL_CORTE,
      unread_count: 4,
      manually_unread: false,
    },
    // No está esperando respuesta, pero es del viewer: cuenta para "mine".
    {
      id: "conv-3",
      awaiting_reply: false,
      status: "open",
      assigned_agent_id: "viewer-1",
      last_customer_message_at: null,
      unread_count: 0,
      manually_unread: false,
    },
    // Pendiente, del viewer, sin fecha de cliente: cae en "stale" (falla
    // cerrado) y también en "mine". Apartada a mano: cuenta también para
    // "unread", aunque el contador esté en cero.
    {
      id: "conv-4",
      awaiting_reply: true,
      status: "open",
      assigned_agent_id: "viewer-1",
      last_customer_message_at: null,
      unread_count: 0,
      manually_unread: true,
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

  /**
   * `unread` va cerca del final del `Promise.all` para no correr los índices
   * que los tres tests de arriba ya afirman por posición (`consultas[0..2]`).
   * Sin condición de estado, a propósito: una conversación CERRADA con
   * mensajes sin leer (conv-2) sigue contando — es la misma decisión que
   * `unreadOnly` de `fetchConversations` (ver data-conversations.test.ts).
   *
   * Son CINCO consultas desde el 30/8/2026, no cuatro: la quinta es la de
   * "Sin dueño", y va última porque no es un conteo —pide filas con la
   * bitácora embebida— y porque es la única que toca otra tabla.
   */
  it('"unread" pregunta por el OR de unread_count/manually_unread, sin condición de estado', async () => {
    const { client, consultas } = createFakeSupabase(filas());

    await fetchInboxCounts(client, "viewer-1", AHORA);

    expect(consultas).toHaveLength(5);
    expect(consultas[3].filtros).toEqual([
      {
        op: "or",
        column: "",
        value: "unread_count.gt.0,manually_unread.is.true",
      },
    ]);
    expect(consultas[3].opciones).toEqual({ count: "exact", head: true });
  });

  it("devuelve los cinco números, cada uno contra su propio subconjunto", async () => {
    const { client } = createFakeSupabase(filas());

    const result = await fetchInboxCounts(client, "viewer-1", AHORA);

    // pending: conv-0, conv-1, conv-4 (awaiting_reply y no cerrada).
    // pendingStale: de esos, conv-1 (fuera de ventana) y conv-4 (sin fecha).
    // mine: conv-3 y conv-4 (assigned_agent_id === "viewer-1").
    // unread: conv-2 (cerrada, pero con unread_count > 0 — a propósito, no
    // exige status abierto) y conv-4 (manually_unread).
    expect(result).toEqual({ pending: 3, pendingStale: 2, mine: 2, unread: 2, unassigned: 0 });
  });
});
