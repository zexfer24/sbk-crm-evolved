import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchConversationQuotes } from "@/lib/data";

interface RawQuoteRow {
  id: string;
  product_id: string | null;
  product_name: string;
  price_usd: number;
  price_bs: number;
  bcv_rate: number;
  quoted_at: string;
}

function createFakeSupabase(rows: RawQuoteRow[]) {
  const calls: { eqColumn: string; eqValue: string; orderColumn: string; ascending: boolean | undefined }[] = [];

  const client = {
    from() {
      return {
        select() {
          return {
            eq(eqColumn: string, eqValue: string) {
              return {
                order(orderColumn: string, opts?: { ascending?: boolean }) {
                  calls.push({ eqColumn, eqValue, orderColumn, ascending: opts?.ascending });
                  return {
                    limit: async () => ({ data: rows, error: null }),
                  };
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

describe("fetchConversationQuotes", () => {
  it("devuelve las cotizaciones de la conversación mapeadas a camelCase, más recientes primero", async () => {
    const { client, calls } = createFakeSupabase([
      {
        id: "q-1",
        product_id: "prod-1",
        product_name: "Carburador PZ27",
        price_usd: 18,
        price_bs: 720,
        bcv_rate: 40,
        quoted_at: "2026-08-21T12:00:00.000Z",
      },
    ]);

    const result = await fetchConversationQuotes(client, "conv-1");

    expect(result).toEqual([
      {
        id: "q-1",
        productId: "prod-1",
        productName: "Carburador PZ27",
        priceUsd: 18,
        priceBs: 720,
        bcvRate: 40,
        quotedAt: "2026-08-21T12:00:00.000Z",
      },
    ]);
    expect(calls[0]).toMatchObject({ eqColumn: "conversation_id", eqValue: "conv-1", orderColumn: "quoted_at", ascending: false });
  });
});
