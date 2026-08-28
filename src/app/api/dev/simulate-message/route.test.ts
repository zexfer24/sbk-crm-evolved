import { describe, expect, it, vi, afterEach } from "vitest";
import { runAgentTurn } from "@/lib/ai/agent";
import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "@/app/api/dev/simulate-message/route";

// Mocks mínimos: el route importa estas cuatro dependencias de forma
// estática, y las pruebas de esta suite solo necesitan verificar que la
// guarda de producción corta ANTES de tocarlas.
vi.mock("@/lib/ai/agent", () => ({ runAgentTurn: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/data", () => ({ fetchCurrentAgent: vi.fn() }));

describe("POST /api/dev/simulate-message en producción", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("responde 404 sin tocar ninguna dependencia cuando NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Sin vi.resetModules(): el route lee process.env.NODE_ENV dentro del
    // handler POST (no a nivel de módulo), así que no hace falta recargarlo.

    const response = await POST(new Request("http://localhost/api/dev/simulate-message", { method: "POST" }));

    expect(response.status).toBe(404);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
