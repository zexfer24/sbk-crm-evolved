// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, fromMock, createAdminClientMock } = vi.hoisted(() => {
  const rpcMock = vi.fn();
  const fromMock = vi.fn();
  return {
    rpcMock,
    fromMock,
    createAdminClientMock: vi.fn(() => ({ rpc: rpcMock, from: fromMock })),
  };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: createAdminClientMock }));

import { log } from "@/lib/log";
import { leerEstadoBcv, registrarIntentoBcv, resetBcvStatusForTests } from "@/lib/ai/bcv-status";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registrarIntentoBcv", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    resetBcvStatusForTests();
    vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  it("llama a la RPC con p_ok y p_error y mapea los tres campos", async () => {
    rpcMock.mockResolvedValue({
      data: [{ consecutive_failures: 3, previous_failures: 2, previous_error: "boom" }],
      error: null,
    });

    const resultado = await registrarIntentoBcv(false, "cert vencido");

    expect(rpcMock).toHaveBeenCalledWith("bcv_registrar_intento", { p_ok: false, p_error: "cert vencido" });
    expect(resultado).toEqual({ fallosSeguidos: 3, fallosPrevios: 2, errorPrevio: "boom" });
  });

  it("acepta que la RPC devuelva un objeto suelto en vez de un arreglo", async () => {
    rpcMock.mockResolvedValue({
      data: { consecutive_failures: 0, previous_failures: 5, previous_error: null },
      error: null,
    });

    expect(await registrarIntentoBcv(true, null)).toEqual({
      fallosSeguidos: 0,
      fallosPrevios: 5,
      errorPrevio: null,
    });
  });

  it("con error de la RPC (tabla o función inexistente) devuelve null y avisa UNA sola vez por proceso", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "no existe la función" } });

    expect(await registrarIntentoBcv(false, "x")).toBeNull();
    expect(await registrarIntentoBcv(false, "x")).toBeNull();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "bcv_estado_no_disponible",
      expect.objectContaining({ detail: expect.stringContaining("no existe la función") })
    );
  });

  it("si la RPC lanza (red caída) tampoco lanza: null", async () => {
    rpcMock.mockRejectedValue(new Error("fetch failed"));
    await expect(registrarIntentoBcv(true, null)).resolves.toBeNull();
  });

  it("si ni siquiera se puede crear el cliente admin devuelve null", async () => {
    createAdminClientMock.mockImplementationOnce(() => {
      throw new Error("falta SUPABASE_SERVICE_ROLE_KEY");
    });
    await expect(registrarIntentoBcv(true, null)).resolves.toBeNull();
  });
});

describe("leerEstadoBcv", () => {
  beforeEach(() => {
    fromMock.mockReset();
    resetBcvStatusForTests();
    vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  function clienteConFila(resultado: { data: unknown; error: unknown }) {
    const maybeSingle = vi.fn(async () => resultado);
    const select = vi.fn(() => ({ maybeSingle }));
    const from = vi.fn(() => ({ select }));
    return { client: { from }, from, select };
  }

  it("mapea snake_case a camelCase", async () => {
    const { client, from } = clienteConFila({
      data: {
        last_attempt_at: "2026-11-21T10:00:00Z",
        last_success_at: "2026-11-18T22:00:00Z",
        last_failure_at: "2026-11-21T10:00:00Z",
        last_error: "boom",
        consecutive_failures: 7,
      },
      error: null,
    });

    // @ts-expect-error -- fake mínimo del cliente de supabase
    const estado = await leerEstadoBcv(client);

    expect(from).toHaveBeenCalledWith("bcv_fetch_status");
    expect(estado).toEqual({
      lastAttemptAt: "2026-11-21T10:00:00Z",
      lastSuccessAt: "2026-11-18T22:00:00Z",
      lastFailureAt: "2026-11-21T10:00:00Z",
      lastError: "boom",
      consecutiveFailures: 7,
    });
  });

  it("sin fila devuelve null", async () => {
    const { client } = clienteConFila({ data: null, error: null });
    // @ts-expect-error -- fake mínimo
    expect(await leerEstadoBcv(client)).toBeNull();
  });

  it("con error devuelve null y avisa a lo sumo una vez por proceso", async () => {
    const { client } = clienteConFila({ data: null, error: { code: "42P01", message: "no existe la tabla" } });

    // @ts-expect-error -- fake mínimo
    expect(await leerEstadoBcv(client)).toBeNull();
    // @ts-expect-error -- fake mínimo
    expect(await leerEstadoBcv(client)).toBeNull();

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("si la consulta lanza, devuelve null", async () => {
    const client = {
      from: () => {
        throw new Error("boom");
      },
    };
    // @ts-expect-error -- fake mínimo
    await expect(leerEstadoBcv(client)).resolves.toBeNull();
  });
});
