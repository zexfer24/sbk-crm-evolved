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
  tabla: string;
  filtros: Filtro[];
  orden: { columna: string; opciones: unknown } | null;
  opciones: unknown;
}

/**
 * `humanos` son los ids que en `messages` tienen un mensaje de asesor: los
 * chats que una persona ya está atendiendo y que el atraso tiene que dejar
 * fuera. Ver src/lib/ai/human-handled.ts.
 */
function createFakeSupabase(count = 0, humanos: string[] = []) {
  const consultas: Consulta[] = [];
  const filas = Array.from({ length: count }, (_, i) => ({ id: `conv-${i}` }));

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
      in: (columna: string, valor: unknown) => {
        consulta.filtros.push({ op: "in", columna, valor });
        return api;
      },
      order: (columna: string, opciones: unknown) => {
        consulta.orden = { columna, opciones };
        return api;
      },
      // Se resuelve como promesa cuando la consulta se espera sin .order().
      then: (resolve: (value: { data: unknown[]; error: null; count: number }) => unknown) =>
        resolve(
          consulta.tabla === "messages"
            ? { data: humanos.map((id) => ({ conversation_id: id })), error: null, count: humanos.length }
            : { data: filas, error: null, count }
        ),
    };
    return api;
  }

  const client = {
    from(tabla: string) {
      return {
        select: (_columns: string, opciones?: unknown) => {
          const consulta: Consulta = { tabla, filtros: [], orden: null, opciones };
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

  /**
   * Las tres condiciones del WHERE no distinguen un chat sin atender de uno
   * que una persona está atendiendo: los asesores contestan sin asignarse la
   * conversación, y `awaiting_reply` describe igual de bien a alguien que
   * respondió "Ok" a su asesor.
   */
  it("deja fuera los chats donde ya escribió un asesor", async () => {
    const { client } = createFakeSupabase(5, ["conv-1", "conv-3"]);

    expect(await fetchBacklogConversationIds(client, AHORA)).toEqual(["conv-0", "conv-2", "conv-4"]);
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

  /**
   * Lo de fuera de la ventana sigue siendo un count(*): no se le descuenta
   * nada porque no se le escribe a nadie de ahí.
   */
  it("lo de fuera de la ventana se cuenta sin traer filas", async () => {
    const { client, consultas } = createFakeSupabase();

    await fetchBacklogCounts(client, AHORA);

    expect(consultas[1].opciones).toEqual({ count: "exact", head: true });
  });

  it("devuelve los dos números por separado", async () => {
    const { client } = createFakeSupabase(7);

    expect(await fetchBacklogCounts(client, AHORA)).toEqual({ inWindow: 7, outOfWindow: 7 });
  });

  /**
   * El número que engañó al dueño el 26 de agosto de 2026.
   *
   * El diálogo dijo 139 y 22 de esas conversaciones las estaba atendiendo un
   * asesor. El número que se muestra antes de pulsar tiene que ser el de los
   * clientes a los que de verdad se les va a escribir, o el consentimiento
   * que da el dueño es sobre otra cosa.
   */
  it("no cuenta los chats que ya está atendiendo un asesor", async () => {
    const { client } = createFakeSupabase(7, ["conv-0", "conv-1", "conv-2"]);

    expect(await fetchBacklogCounts(client, AHORA)).toEqual({ inWindow: 4, outOfWindow: 7 });
  });

  /** El corte sale de una sola constante: la ventana de Meta no se copia a mano en dos sitios. */
  it("usa la ventana declarada en dashboard.ts", () => {
    expect(FREEFORM_WINDOW_HOURS).toBe(24);
    expect(Date.parse(HACE_24H)).toBe(AHORA - FREEFORM_WINDOW_HOURS * 60 * 60 * 1000);
  });
});
