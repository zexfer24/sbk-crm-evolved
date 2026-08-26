import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONVERSATIONS_PAGE_SIZE, fetchBoardConversations, fetchConversations } from "@/lib/data";

// ---------------------------------------------------------------------------
// Fake de SupabaseClient para la cadena de fetchConversations
// (`.from().select().order().range()`), que devuelve rebanadas reales del
// arreglo según el rango pedido. Reproduce el tope de filas de PostgREST:
// sin `.range()`, una respuesta se corta en silencio y las conversaciones
// más viejas desaparecen de la bandeja sin ningún error.
// ---------------------------------------------------------------------------

interface RangeCall {
  from: number;
  to: number;
}

function makeRow(index: number) {
  return {
    id: `conv-${index}`,
    status: "open" as const,
    assigned_agent_id: null as string | null,
    // Columna generada: la calcula Postgres a partir de los dos timestamps.
    awaiting_reply: false,
    unread_count: 0,
    ai_enabled: true,
    deal_status: null,
    deal_closed_at: null,
    deal_payment_proof_url: null,
    order: null,
    deal_verified: false,
    deal_verified_at: null,
    deal_verified_by: null,
    deal_payment_method: null,
    deal_closed_by: null,
    last_customer_message_at: null,
    last_message_at: new Date(2024, 0, 1, 0, 0, index).toISOString(),
    last_message_preview: `preview ${index}`,
    last_message_direction: null,
    last_message_status: null,
    created_at: new Date(2024, 0, 1, 0, 0, index).toISOString(),
    journey_stage: null,
    intent: null,
    active_tool: null,
    welcome_sent_at: null,
    contact: {
      id: `contact-${index}`,
      phone_number: `5840000${index}`,
      display_name: `Cliente ${index}`,
      profile_name: null,
      avatar_url: null,
      cedula_type: null,
      cedula_number: null,
      state: null,
      city: null,
      address: null,
      contact_tags: [],
    },
    channel: {
      id: "canal-1",
      label: "Principal",
      phone_number: "584120000000",
      phone_number_id: "pnid",
      status: "connected" as const,
    },
    assigned_agent: null,
  };
}

function createFakeSupabase(rows: ReturnType<typeof makeRow>[]) {
  const calls: RangeCall[] = [];
  const filters: { op: string; column: string; value: unknown }[] = [];

  // Builder encadenable como el de PostgREST: los filtros se anotan y el
  // range final resuelve sobre las filas que quedaron.
  function builder(current: ReturnType<typeof makeRow>[]) {
    return {
      neq(column: string, value: unknown) {
        filters.push({ op: "neq", column, value });
        return builder(current.filter((row) => (row as Record<string, unknown>)[column] !== value));
      },
      eq(column: string, value: unknown) {
        filters.push({ op: "eq", column, value });
        return builder(current.filter((row) => (row as Record<string, unknown>)[column] === value));
      },
      is(column: string, value: unknown) {
        filters.push({ op: "is", column, value });
        return builder(
          current.filter((row) => ((row as Record<string, unknown>)[column] ?? null) === value)
        );
      },
      in(column: string, values: unknown[]) {
        filters.push({ op: "in", column, value: values });
        return builder(
          current.filter((row) => values.includes((row as Record<string, unknown>)[column]))
        );
      },
      range(from: number, to: number) {
        calls.push({ from, to });
        return Promise.resolve({ data: current.slice(from, to + 1), error: null });
      },
    };
  }

  const selects: string[] = [];

  const client = {
    from() {
      return {
        select(query: string) {
          selects.push(query);
          return {
            order() {
              return builder(rows);
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls, filters, selects };
}

describe("fetchConversations", () => {
  /**
   * Este es el fallo que no avisa: PostgREST corta la respuesta en su tope de
   * filas y devuelve `error: null`. La bandeja se ve normal, solo que sin las
   * conversaciones más viejas. `fetchMessages` ya se defendía de esto; la
   * lista de conversaciones no.
   */
  it("pagina hasta traerlas todas cuando hay más filas que el tope de una página", async () => {
    const total = CONVERSATIONS_PAGE_SIZE + 250;
    const { client, calls } = createFakeSupabase(
      Array.from({ length: total }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client);

    expect(result).toHaveLength(total);
    expect(calls.length).toBeGreaterThan(1);
  });

  /**
   * La bandeja no necesita el histórico completo para pintar la lista: pide
   * las más recientes y con eso arma la pantalla. Traer de más cuesta una
   * consulta con siete joins por fila y un payload que viaja entero al
   * navegador en cada carga.
   */
  it("respeta el tope pedido y resuelve con una sola consulta", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 5000 }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client, { limit: 200 });

    expect(result).toHaveLength(200);
    expect(calls).toEqual([{ from: 0, to: 199 }]);
  });

  /** Un tope mayor que lo que existe no debe inventar páginas vacías de más. */
  it("se detiene cuando la página vuelve incompleta", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 10 }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client);

    expect(result).toHaveLength(10);
    expect(calls).toHaveLength(1);
  });

  /**
   * Bajar por la bandeja tiene que costar una página.
   *
   * Sin `offset`, «traer 30 más» se pedía como `limit` creciente desde la
   * fila 0: la sexta bajada volvía a bajar 180 filas —135 KB, 1,2 s medidos
   * en producción— para mostrar 30 nuevas.
   */
  it("con offset pide solo la página siguiente", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 200 }, (_, i) => makeRow(i))
    );

    const result = await fetchConversations(client, { offset: 30, limit: 30 });

    expect(calls).toEqual([{ from: 30, to: 59 }]);
    expect(result).toHaveLength(30);
    expect(result[0].id).toBe("conv-30");
  });

  /**
   * El tablero y el roster piden solo el trabajo vivo: su costo depende de la
   * carga del día, no de cuántos meses de histórico acumule el CRM.
   */
  it("con activeOnly deja lo cerrado en la base, no lo filtra el navegador", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i));
    rows[3] = { ...rows[3], status: "closed" as never };
    const { client, filters } = createFakeSupabase(rows);

    const result = await fetchConversations(client, { activeOnly: true });

    expect(filters).toContainEqual({ op: "neq", column: "status", value: "closed" });
    expect(result).toHaveLength(9);
  });

  /**
   * El tablero y Control de IA piden TODO el trabajo abierto de una vez para
   * contar por etapa y por asesor: cientos de filas, y cada campo se paga en
   * cada una. Medido: 320,9 KB por petición. Lo que no cuentan ni pintan no
   * puede viajar — sobre todo `contact_tags(tag:tags(...))`, que PostgREST
   * resuelve con un lateral por fila.
   */
  it("la fila del tablero no arrastra ni la vista previa ni las etiquetas", async () => {
    const { client, selects } = createFakeSupabase([makeRow(0)]);

    await fetchBoardConversations(client, { activeOnly: true });

    const select = selects[0];
    expect(select).not.toContain("contact_tags");
    expect(select).not.toContain("last_message_preview");
    expect(select).not.toContain("last_message_status");
    expect(select).not.toContain("avatar_url");
    // Pero sí lo que el recorrido necesita para ubicar la conversación.
    expect(select).toContain("journey_stage");
    expect(select).toContain("assigned_agent");
  });

  it("la fila de la bandeja sí las lleva: pinta una línea de chat", async () => {
    const { client, selects } = createFakeSupabase([makeRow(0)]);

    await fetchConversations(client, { limit: 30 });

    expect(selects[0]).toContain("contact_tags");
    expect(selects[0]).toContain("last_message_preview");
  });

  /**
   * El filtro "Sin contestar" no puede resolverse sobre la ventana cargada: el
   * chat libre que nadie contestó hace tres semanas está cientos de filas más
   * abajo, y filtrar 30 filas en el navegador lo escondería justo a él. Los
   * tres cortes viajan a la base, que los resuelve con un índice parcial.
   */
  it("con los cortes de 'sin contestar' pregunta por los tres a la base", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => makeRow(i));
    rows[0] = { ...rows[0], awaiting_reply: true };
    rows[1] = { ...rows[1], awaiting_reply: true, assigned_agent_id: "ana" };
    rows[2] = { ...rows[2], awaiting_reply: true, status: "closed" as never };
    const { client, filters } = createFakeSupabase(rows);

    const result = await fetchConversations(client, {
      activeOnly: true,
      unassignedOnly: true,
      awaitingReplyOnly: true,
    });

    expect(filters).toContainEqual({ op: "eq", column: "awaiting_reply", value: true });
    expect(filters).toContainEqual({ op: "is", column: "assigned_agent_id", value: null });
    expect(filters).toContainEqual({ op: "neq", column: "status", value: "closed" });
    expect(result.map((c) => c.id)).toEqual(["conv-0"]);
  });

  /**
   * `.in()` con lista vacía no es una consulta válida en PostgREST, y acá
   * además significa «nada que buscar»: se resuelve sin ir a la red.
   */
  it("con una lista vacía de ids o contactos responde vacío sin consultar", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 10 }, (_, i) => makeRow(i))
    );

    expect(await fetchConversations(client, { contactIds: [] })).toEqual([]);
    expect(await fetchConversations(client, { ids: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
