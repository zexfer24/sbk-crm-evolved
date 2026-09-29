import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAgentSettings } from "@/lib/data";

// T10b-5 (29/9/2026): `fetchAgentSettings` lee también el interruptor de la
// demora del asesor. Un `select` sin esas dos columnas dejaría el panel
// siempre "apagado" aunque la base diga otra cosa.

function fakeSupabase(row: Record<string, unknown>) {
  const selects: string[] = [];
  const client = {
    from(table: string) {
      if (table !== "agent_settings") throw new Error(`tabla inesperada: ${table}`);
      return {
        select(columns: string) {
          selects.push(columns);
          return { eq: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
      };
    },
    rpc: async () => ({ data: 1.5, error: null }),
  } as unknown as SupabaseClient;
  return { client, selects };
}

const BASE = { ai_globally_enabled: true, daily_spend_cap_usd: null, business_hours: null };

describe("fetchAgentSettings — la demora del asesor", () => {
  it("pide las dos columnas y las mapea", async () => {
    const { client, selects } = fakeSupabase({
      ...BASE,
      demora_activa: true,
      demora_activa_desde: "2026-09-29T15:30:00+00:00",
    });

    const settings = await fetchAgentSettings(client);

    expect(selects[0]).toContain("demora_activa");
    expect(selects[0]).toContain("demora_activa_desde");
    expect(settings.demoraActiva).toBe(true);
    expect(settings.demoraActivaDesde).toBe("2026-09-29T15:30:00+00:00");
  });

  it("apagada y sin fecha: false y null (nunca undefined)", async () => {
    const { client } = fakeSupabase({ ...BASE, demora_activa: false, demora_activa_desde: null });

    const settings = await fetchAgentSettings(client);

    expect(settings.demoraActiva).toBe(false);
    expect(settings.demoraActivaDesde).toBeNull();
  });
});
