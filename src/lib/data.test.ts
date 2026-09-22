import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchAgentTurns,
  fetchDefaultChannel,
  fetchMessages,
  fetchTokenUsageSummary,
  fetchTurnCallsByPhase,
  searchConversationSummaries,
} from "@/lib/data";

// ---------------------------------------------------------------------------
// Fake SupabaseClient: simula el query builder encadenable que usa
// fetchMessages (`.from().select().eq().order().range()`), devolviendo
// páginas reales de datos según el rango pedido. No es un mock genérico:
// reproduce el comportamiento de paginación de PostgREST para poder
// verificar que fetchMessages pagina correctamente.
// ---------------------------------------------------------------------------

interface RawMessageRow {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender_type: "customer" | "agent" | "ai" | "system";
  message_type: "text";
  content: string | null;
  template_name: string | null;
  media_url: string | null;
  is_internal_note: boolean;
  whatsapp_status: null;
  reply_to_message_id: string | null;
  created_at: string;
  sender_agent: null;
}

interface RangeCall {
  table: string;
  eqColumn: string;
  eqValue: string;
  orderColumn: string;
  orderAscending: boolean | undefined;
  from: number;
  to: number;
}

function makeRow(index: number, conversationId: string): RawMessageRow {
  // created_at estrictamente creciente para respetar el orden ascendente.
  const createdAt = new Date(2024, 0, 1, 0, 0, index).toISOString();
  return {
    id: `msg-${index}`,
    conversation_id: conversationId,
    direction: "inbound",
    sender_type: "customer",
    message_type: "text",
    content: `mensaje ${index}`,
    template_name: null,
    media_url: null,
    is_internal_note: false,
    whatsapp_status: null,
    reply_to_message_id: null,
    created_at: createdAt,
    sender_agent: null,
  };
}

/**
 * Crea un fake de SupabaseClient cuyo `.range(from, to)` devuelve un
 * "slice" real del arreglo `rows` (simulando paginación de PostgREST).
 * Si `errorOnCallNumber` coincide con el número de llamada a `.range`
 * (1-indexed), esa página devuelve `{ data: null, error }` en su lugar.
 */
function createFakeSupabase(
  rows: RawMessageRow[],
  options?: { errorOnCallNumber?: number }
) {
  const calls: RangeCall[] = [];
  let rangeCallCount = 0;

  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq(eqColumn: string, eqValue: string) {
              return {
                order(orderColumn: string, orderOpts?: { ascending?: boolean }) {
                  return {
                    range(from: number, to: number) {
                      rangeCallCount += 1;
                      calls.push({
                        table,
                        eqColumn,
                        eqValue,
                        orderColumn,
                        orderAscending: orderOpts?.ascending,
                        from,
                        to,
                      });

                      if (options?.errorOnCallNumber === rangeCallCount) {
                        return Promise.resolve({
                          data: null,
                          error: { message: "boom: fallo simulado de PostgREST" },
                        });
                      }

                      const page = rows.slice(from, to + 1);
                      return Promise.resolve({ data: page, error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    getCalls: () => calls,
  };
}

describe("fetchMessages", () => {
  it("devuelve exactamente los mensajes de una conversación con menos de 1000 (sin paginar de más)", async () => {
    const conversationId = "conv-short";
    const rows = [
      makeRow(0, conversationId),
      makeRow(1, conversationId),
      makeRow(2, conversationId),
    ];
    const { client, getCalls } = createFakeSupabase(rows);

    const result = await fetchMessages(client, conversationId);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2"]);

    // Como la primera página (de tamaño PAGE_SIZE) devolvió menos filas que
    // el tamaño de página, no debe haber pedido una segunda página.
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0].from).toBe(0);
    expect(getCalls()[0].to).toBe(999);
  });

  it("devuelve los 2500 mensajes completos de una conversación con más de 1000 (paginando en 3 páginas)", async () => {
    const conversationId = "conv-long";
    const totalMessages = 2500;
    const rows = Array.from({ length: totalMessages }, (_, i) => makeRow(i, conversationId));
    const { client, getCalls } = createFakeSupabase(rows);

    const result = await fetchMessages(client, conversationId);

    expect(result).toHaveLength(totalMessages);
    expect(result[0].id).toBe("msg-0");
    expect(result[totalMessages - 1].id).toBe(`msg-${totalMessages - 1}`);
    // Verifica que no hay huecos ni duplicados en la secuencia completa.
    expect(result.map((m) => m.id)).toEqual(rows.map((r) => r.id));

    const calls = getCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ from: 0, to: 999 });
    expect(calls[1]).toMatchObject({ from: 1000, to: 1999 });
    expect(calls[2]).toMatchObject({ from: 2000, to: 2999 });

    // Cada página debe mantener el mismo filtro y el mismo orden estable.
    for (const call of calls) {
      expect(call.table).toBe("messages");
      expect(call.eqColumn).toBe("conversation_id");
      expect(call.eqValue).toBe(conversationId);
      expect(call.orderColumn).toBe("created_at");
      expect(call.orderAscending).toBe(true);
    }
  });

  it("propaga el error si una página intermedia falla, en vez de devolver datos parciales en silencio", async () => {
    const conversationId = "conv-error";
    const totalMessages = 2500;
    const rows = Array.from({ length: totalMessages }, (_, i) => makeRow(i, conversationId));
    // La primera página (llamada 1) tiene éxito; la segunda (llamada 2) falla.
    const { client, getCalls } = createFakeSupabase(rows, { errorOnCallNumber: 2 });

    await expect(fetchMessages(client, conversationId)).rejects.toMatchObject({
      message: "boom: fallo simulado de PostgREST",
    });

    // No debe haber intentado pedir una tercera página tras el error.
    expect(getCalls()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// searchConversationSummaries — F13: el buscador de la bandeja deja de
// depender de que el contacto esté cargado en pantalla para encontrarlo sin
// acentos. Antes filtraba `display_name`/`profile_name`/`phone_number` con un
// `ilike` directo contra lo que la persona escribió: "jose" no encontraba a
// "José" salvo que ya estuviera en memoria, donde el filtro sí normalizaba.
// Ahora filtra `search_text.ilike.%<normalizado>%` (la columna generada de
// 20260905020000_contacts_search_unaccent.sql) con el término pasado por
// `normalizeForSearch` — el mismo criterio que usa `immutable_unaccent` en la
// base para no acentos/mayúsculas.
//
// El fake solo implementa la mesa `contacts`: con `contactIds: []` (porque la
// consulta a contacts no matcheó nada) y `messageHitIds: []`, las dos
// llamadas internas a `fetchConversations` cortan por el `.in()` vacío antes
// de tocar `conversations` (ver el comentario "`.in()` con lista vacía..." en
// `fetchConversationRows`), así que no hace falta simular esa mesa acá.
// ---------------------------------------------------------------------------

describe("searchConversationSummaries", () => {
  function fakeContactsSearch() {
    let capturedFilter: string | undefined;
    let capturedLimit: number | undefined;

    const builder = {
      select: () => builder,
      or: (filter: string) => {
        capturedFilter = filter;
        return builder;
      },
      limit: (n: number) => {
        capturedLimit = n;
        return Promise.resolve({ data: [], error: null });
      },
    };

    const client = {
      from: (table: string) => {
        if (table !== "contacts") {
          throw new Error(`el fake de este test solo conoce la mesa "contacts", pidieron "${table}"`);
        }
        return builder;
      },
    };

    return {
      client: client as unknown as SupabaseClient,
      getFilter: () => capturedFilter,
      getLimit: () => capturedLimit,
    };
  }

  it("normaliza acentos y mayúsculas antes de armar el filtro contra search_text", async () => {
    const { client, getFilter } = fakeContactsSearch();

    await searchConversationSummaries(client, "José", []);

    expect(getFilter()).toBe('search_text.ilike."%jose%"');
  });

  it("aplana también la ñ, igual que el diccionario unaccent de Postgres", async () => {
    const { client, getFilter } = fakeContactsSearch();

    await searchConversationSummaries(client, "Muñeca", []);

    expect(getFilter()).toBe('search_text.ilike."%muneca%"');
  });

  it("un término que ya venía en minúsculas y sin acentos no cambia", async () => {
    const { client, getFilter } = fakeContactsSearch();

    await searchConversationSummaries(client, "bujia", []);

    expect(getFilter()).toBe('search_text.ilike."%bujia%"');
  });

  it("pide como mucho CONTACT_SEARCH_LIMIT contactos", async () => {
    const { client, getLimit } = fakeContactsSearch();

    await searchConversationSummaries(client, "jose", []);

    expect(getLimit()).toBe(40);
  });

  it("sin coincidencias de contacto ni de mensaje, devuelve la lista vacía sin tocar conversations", async () => {
    const { client } = fakeContactsSearch();

    const result = await searchConversationSummaries(client, "nadie", []);

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchDefaultChannel — T6 (8/9/2026): "Agregar contacto" desde la bandeja
// necesita un canal para crear la conversación aunque el cliente no haya
// escrito nunca. Mismo criterio "connected primero, si no el primero que
// exista" que `fetchWhatsappChannelHealth` ya usa para la salud del número;
// el fake reproduce las dos consultas encadenadas (`.eq("status",
// "connected")` primero, sin ese filtro después) sin duplicar PostgREST.
// ---------------------------------------------------------------------------

interface RawChannelRow {
  id: string;
  label: string;
  phone_number: string;
  phone_number_id: string | null;
  status: "connected" | "disconnected" | "pending";
}

function fakeChannelsTable(rows: { connected?: RawChannelRow[]; all?: RawChannelRow[] }) {
  const client = {
    from: (table: string) => {
      if (table !== "whatsapp_channels") {
        throw new Error(`el fake de este test solo conoce "whatsapp_channels", pidieron "${table}"`);
      }
      let filtroConnected = false;
      const builder = {
        select: () => builder,
        eq: () => {
          filtroConnected = true;
          return builder;
        },
        order: () => builder,
        limit: () =>
          Promise.resolve({ data: (filtroConnected ? rows.connected : rows.all) ?? [], error: null }),
      };
      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient };
}

const CANAL_CONECTADO: RawChannelRow = {
  id: "chan-connected",
  label: "Principal",
  phone_number: "+584000000000",
  phone_number_id: "phone-id-1",
  status: "connected",
};

const CANAL_PENDIENTE: RawChannelRow = {
  id: "chan-pending",
  label: "Demo",
  phone_number: "+584000000001",
  phone_number_id: null,
  status: "pending",
};

describe("fetchDefaultChannel", () => {
  it("prefiere el canal connected sobre cualquier otro", async () => {
    const { client } = fakeChannelsTable({
      connected: [CANAL_CONECTADO],
      all: [CANAL_PENDIENTE, CANAL_CONECTADO],
    });

    const result = await fetchDefaultChannel(client);

    expect(result?.id).toBe("chan-connected");
  });

  it("sin ningún canal connected, cae al primero que exista (demo)", async () => {
    const { client } = fakeChannelsTable({ connected: [], all: [CANAL_PENDIENTE] });

    const result = await fetchDefaultChannel(client);

    expect(result?.id).toBe("chan-pending");
  });

  it("sin ningún canal creado, devuelve null en vez de inventar uno", async () => {
    const { client } = fakeChannelsTable({ connected: [], all: [] });

    const result = await fetchDefaultChannel(client);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): tres
// lecturas nuevas/ampliadas de la telemetría por turno. Fakes mínimos, uno
// por función -- estas tres nunca comparten forma de query con las de arriba.
// ---------------------------------------------------------------------------

describe("fetchAgentTurns", () => {
  /**
   * `cached_input_tokens`/`steps`/`tools_used` se agregaron al SELECT en esta
   * tarea -- sin este test, un `revert` accidental de esas tres columnas del
   * string no lo detectaría ningún otro test de este archivo.
   */
  it("pide cached_input_tokens, steps y tools_used en el SELECT", async () => {
    let columnasPedidas = "";
    const client = {
      from: (table: string) => {
        if (table !== "agent_turns") throw new Error(`fake solo conoce "agent_turns", pidieron "${table}"`);
        return {
          select: (columns: string) => {
            columnasPedidas = columns;
            return {
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            };
          },
        };
      },
    };

    await fetchAgentTurns(client as unknown as SupabaseClient);

    expect(columnasPedidas).toContain("cached_input_tokens");
    expect(columnasPedidas).toContain("steps");
    expect(columnasPedidas).toContain("tools_used");
  });

  it("mapea cached_input_tokens/steps/tools_used a camelCase, null incluido (turnos de antes de la migración)", async () => {
    const client = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: async () => ({
              data: [
                {
                  id: "turn-1",
                  conversation_id: "conv-1",
                  intent: "otro",
                  action: "answered",
                  summary: "ok",
                  model: "openai/gpt-5.6-luna",
                  input_tokens: 100,
                  output_tokens: 20,
                  total_tokens: 120,
                  reasoning_tokens: 5,
                  cached_input_tokens: 40,
                  steps: 2,
                  tools_used: "buscarRepuesto,escalarAAsesor",
                  playbook_id: null,
                  customer_message: "hola",
                  created_at: "2026-09-22T10:00:00Z",
                  conversation: null,
                },
                {
                  id: "turn-2",
                  conversation_id: "conv-2",
                  intent: null,
                  action: "answered",
                  summary: null,
                  model: null,
                  input_tokens: null,
                  output_tokens: null,
                  total_tokens: null,
                  reasoning_tokens: 0,
                  cached_input_tokens: null,
                  steps: null,
                  tools_used: null,
                  playbook_id: null,
                  customer_message: null,
                  created_at: "2026-09-01T00:00:00Z",
                  conversation: null,
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };

    const result = await fetchAgentTurns(client as unknown as SupabaseClient);

    expect(result[0]).toMatchObject({ cachedInputTokens: 40, steps: 2, toolsUsed: "buscarRepuesto,escalarAAsesor" });
    expect(result[1]).toMatchObject({ cachedInputTokens: null, steps: null, toolsUsed: null });
  });
});

interface RawTokenUsageFixtureRow {
  day: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
}

function fakeTokenUsageClient(rows: RawTokenUsageFixtureRow[]) {
  const rpcCalls: { fn: string; params: unknown }[] = [];
  const client = {
    rpc: (fn: string, params?: unknown) => {
      rpcCalls.push({ fn, params });
      if (fn !== "agent_token_usage") throw new Error(`fake solo conoce "agent_token_usage", pidieron "${fn}"`);
      return Promise.resolve({ data: rows, error: null });
    },
    from: (table: string) => {
      if (table !== "model_pricing") throw new Error(`fake solo conoce "model_pricing", pidieron "${table}"`);
      return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
    },
  };
  return { client: client as unknown as SupabaseClient, rpcCalls };
}

describe("fetchTokenUsageSummary", () => {
  /**
   * `agent_token_usage` se recreó (migración 20260921040000) con
   * `cached_input_tokens`/`reasoning_tokens` — sin este test, sumarlos mal
   * (o dejar de sumarlos) no lo detecta ningún otro test de este archivo.
   * Modelo pricing vacío a propósito: no es lo que se prueba acá.
   */
  it("suma cached_input_tokens y reasoning_tokens de TODAS las filas, día×modelo incluido", async () => {
    const { client } = fakeTokenUsageClient([
      {
        day: "2026-09-20",
        model: "openai/gpt-5.6-luna",
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 1200,
        cached_input_tokens: 300,
        reasoning_tokens: 50,
      },
      {
        day: "2026-09-21",
        model: "openai/gpt-5.6-luna",
        input_tokens: 500,
        output_tokens: 100,
        total_tokens: 600,
        cached_input_tokens: 0,
        reasoning_tokens: 20,
      },
      {
        day: "2026-09-21",
        model: "google/gemini-3.1-flash-lite",
        input_tokens: 400,
        output_tokens: 80,
        total_tokens: 480,
        cached_input_tokens: 120,
        reasoning_tokens: 0,
      },
    ]);

    const result = await fetchTokenUsageSummary(client, 30);

    expect(result.totalCachedInputTokens).toBe(420); // 300 + 0 + 120
    expect(result.totalReasoningTokens).toBe(70); // 50 + 20 + 0
  });

  it("pide los días pedidos a la RPC, sin fijarlos a 30", async () => {
    const { client, rpcCalls } = fakeTokenUsageClient([]);

    await fetchTokenUsageSummary(client, 7);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({ fn: "agent_token_usage", params: { days: 7 } });
  });

  it("con cero filas, los dos totales nuevos son 0 (no undefined ni NaN)", async () => {
    const { client } = fakeTokenUsageClient([]);

    const result = await fetchTokenUsageSummary(client);

    expect(result.totalCachedInputTokens).toBe(0);
    expect(result.totalReasoningTokens).toBe(0);
  });
});

describe("fetchTurnCallsByPhase", () => {
  it("llama a la RPC agent_turn_calls_by_phase con los días pedidos y mapea las columnas a camelCase", async () => {
    const rpcCalls: { fn: string; params: unknown }[] = [];
    const client = {
      rpc: (fn: string, params?: unknown) => {
        rpcCalls.push({ fn, params });
        return Promise.resolve({
          data: [
            {
              phase: "redactar",
              calls: 40,
              input_tokens: 12000,
              output_tokens: 3000,
              cached_input_tokens: 5000,
              reasoning_tokens: 900,
              max_output_tokens_max: 1500,
              tool_choice_none_calls: 6,
            },
          ],
          error: null,
        });
      },
    };

    const result = await fetchTurnCallsByPhase(client as unknown as SupabaseClient, 14);

    expect(rpcCalls).toEqual([{ fn: "agent_turn_calls_by_phase", params: { days: 14 } }]);
    expect(result).toEqual([
      {
        phase: "redactar",
        calls: 40,
        inputTokens: 12000,
        outputTokens: 3000,
        cachedInputTokens: 5000,
        reasoningTokens: 900,
        maxOutputTokensMax: 1500,
        toolChoiceNoneCalls: 6,
      },
    ]);
  });

  it("relanza el error de la RPC (p. ej. PGRST202, función sin migrar) — lo maneja el llamador con readListIfTableExists", async () => {
    const error = { code: "PGRST202", message: "función no encontrada" };
    const client = {
      rpc: () => Promise.resolve({ data: null, error }),
    };

    await expect(fetchTurnCallsByPhase(client as unknown as SupabaseClient)).rejects.toBe(error);
  });
});
