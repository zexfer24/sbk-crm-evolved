import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `createAdminClient` pasa `global.fetch` envuelto con `fetchConReintentos`
 * (T1, plan "Nada se pierde en un corte ni en un deploy", 21-22/9/2026):
 * cubre PostgREST, las RPC y Storage (storage-js usa el mismo `fetch`) sin
 * que ningún llamador existente tenga que cambiar. Acá solo se prueba el
 * cableado — que `createClient` recibe un `fetch` DISTINTO del global y que
 * ese `fetch` es el que arma `fetchConReintentos` — no la lógica de
 * reintento, ya cubierta en `fetch-reintentos.test.ts`.
 */

const createClientCalls: Array<{ url: string; key: string; options: unknown }> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, options: unknown) => {
    createClientCalls.push({ url, key, options });
    return { __fake: "cliente-admin" };
  },
}));

const fetchConReintentosCalls: Array<typeof fetch> = [];
const FETCH_ENVUELTO = (async () => new Response("ok")) as unknown as typeof fetch;

vi.mock("@/lib/supabase/fetch-reintentos", () => ({
  fetchConReintentos: (fetchBase: typeof fetch) => {
    fetchConReintentosCalls.push(fetchBase);
    return FETCH_ENVUELTO;
  },
}));

import { createAdminClient } from "./admin";

beforeEach(() => {
  createClientCalls.length = 0;
  fetchConReintentosCalls.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ejemplo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "clave-de-servicio";
});

describe("createAdminClient", () => {
  it("envuelve el fetch global con fetchConReintentos y se lo pasa a createClient en global.fetch", () => {
    createAdminClient();

    expect(createClientCalls).toHaveLength(1);
    expect(fetchConReintentosCalls).toHaveLength(1);

    const { options } = createClientCalls[0];
    expect((options as { global?: { fetch?: unknown } }).global?.fetch).toBe(FETCH_ENVUELTO);
  });

  it("conserva auth.persistSession=false y autoRefreshToken=false (sin sesión, service_role)", () => {
    createAdminClient();

    const { options } = createClientCalls[0];
    expect((options as { auth?: unknown }).auth).toEqual({
      persistSession: false,
      autoRefreshToken: false,
    });
  });
});
