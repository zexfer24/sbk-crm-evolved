import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONVERSATIONS_PAGE_SIZE, fetchConversations } from "@/lib/data";

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

  const client = {
    from() {
      return {
        select() {
          return {
            order() {
              return {
                range(from: number, to: number) {
                  calls.push({ from, to });
                  return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
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
});
