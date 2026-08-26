import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchBacklogConversationIds, fetchBacklogCounts } from "@/lib/data";
import { FREEFORM_WINDOW_HOURS } from "@/lib/dashboard";

// ---------------------------------------------------------------------------
// El filtro del atraso, que es donde está el riesgo real: si el corte de la
// ventana de 24 h se cae de la consulta, la IA le escribe a gente a la que
// Meta no deja escribirle. Y si el número que se le muestra al dueño antes de
// disparar no sale del MISMO filtro que dispara, el diálogo miente.
// ---------------------------------------------------------------------------

interface Filtro {
  op: string;
  columna: string;
  valor: unknown;
}

interface Consulta {
  filtros: Filtro[];
  orden: { columna: string; opciones: unknown } | null;
  opciones: unknown;
}

function createFakeSupabase(count = 0) {
  const consultas: Consulta[] = [];

  function builder(consulta: Consulta) {
    const api = {
      eq: (columna: string, valor: unknown) => {
        consulta.filtros.push({ op: "eq", columna, valor });
        return api;
      },
      neq: (columna: string, valor: unknown) => {
        consulta.filtros.push({ op: "neq", columna, valor });
        return api;
      },
      is: (columna: string, valor: unknown) => {
        consulta.filtros.push({ op: "is", columna, valor });
        return api;
      },
      gt: (columna: string, valor: unknown) => {
        consulta.filtros.push({ op: "gt", columna, valor });
        return api;
      },
      lte: (columna: string, valor: unknown) => {
        consulta.filtros.push({ op: "lte", columna, valor });
        return api;
      },
      order: (columna: string, opciones: unknown) => {
        consulta.orden = { columna, opciones };
        return api;
      },
      // Se resuelve como promesa cuando la consulta se espera sin .order().
      then: (resolve: (value: { data: unknown[]; error: null; count: number }) => unknown) =>
        resolve({ data: [], error: null, count }),
    };
    return api;
  }

  const client = {
    from() {
      return {
        select: (_columns: string, opciones?: unknown) => {
          const consulta: Consulta = { filtros: [], orden: null, opciones };
          consultas.push(consulta);
          return builder(consulta);
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, consultas };
}

const AHORA = Date.parse("2026-08-26T15:00:00.000Z");
const HACE_24H = "2026-08-25T15:00:00.000Z";

describe("fetchBacklogConversationIds", () => {
  it("exige las cuatro condiciones y el corte de la ventana, todas en el WHERE", async () => {
    const { client, consultas } = createFakeSupabase();

    await fetchBacklogConversationIds(client, AHORA);

    expect(consultas).toHaveLength(1);
    expect(consultas[0].filtros).toEqual([
      { op: "eq", columna: "awaiting_reply", valor: true },
      { op: "is", columna: "assigned_agent_id", valor: null },
      { op: "neq", columna: "status", valor: "closed" },
      { op: "eq", columna: "ai_enabled", valor: true },
      { op: "gt", columna: "last_customer_message_at", valor: HACE_24H },
    ]);
  });

  /**
   * Las tres primeras condiciones son el predicado del índice parcial
   * `conversations_free_unanswered_idx`, y el orden es el mismo con el que se
   * creó. Cambiar cualquiera de las dos cosas deja la consulta sin índice.
   */
  it("ordena como el índice parcial, del más reciente al más viejo", async () => {
    const { client, consultas } = createFakeSupabase();

    await fetchBacklogConversationIds(client, AHORA);

    expect(consultas[0].orden).toEqual({
      columna: "last_message_at",
      opciones: { ascending: false, nullsFirst: false },
    });
  });
});

describe("fetchBacklogCounts", () => {
  /**
   * La condición que hace que el diálogo de encendido sea honesto: el número
   * que se le muestra al dueño se cuenta con el mismo filtro con el que se
   * dispara. Si los dos se separan, el diálogo dice un número y salen otros
   * mensajes.
   */
  it("cuenta lo de dentro de la ventana con exactamente el mismo filtro que dispara", async () => {
    const disparo = createFakeSupabase();
    await fetchBacklogConversationIds(disparo.client, AHORA);

    const cuenta = createFakeSupabase();
    await fetchBacklogCounts(cuenta.client, AHORA);

    expect(cuenta.consultas[0].filtros).toEqual(disparo.consultas[0].filtros);
  });

  it("cuenta aparte lo de fuera de la ventana, con el mismo corte invertido", async () => {
    const { client, consultas } = createFakeSupabase();

    await fetchBacklogCounts(client, AHORA);

    expect(consultas[1].filtros.at(-1)).toEqual({
      op: "lte",
      columna: "last_customer_message_at",
      valor: HACE_24H,
    });
  });

  it("pide solo la cuenta, sin traerse las filas", async () => {
    const { client, consultas } = createFakeSupabase();

    await fetchBacklogCounts(client, AHORA);

    expect(consultas[0].opciones).toEqual({ count: "exact", head: true });
    expect(consultas[1].opciones).toEqual({ count: "exact", head: true });
  });

  it("devuelve los dos números por separado", async () => {
    const { client } = createFakeSupabase(7);

    expect(await fetchBacklogCounts(client, AHORA)).toEqual({ inWindow: 7, outOfWindow: 7 });
  });

  /** El corte sale de una sola constante: la ventana de Meta no se copia a mano en dos sitios. */
  it("usa la ventana declarada en dashboard.ts", () => {
    expect(FREEFORM_WINDOW_HOURS).toBe(24);
    expect(Date.parse(HACE_24H)).toBe(AHORA - FREEFORM_WINDOW_HOURS * 60 * 60 * 1000);
  });
});
