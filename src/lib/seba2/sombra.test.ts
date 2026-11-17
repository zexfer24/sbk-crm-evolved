import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import { turnCallsSnapshot } from "@/lib/ai/turn-telemetry";

const logInfo = vi.fn();
const logWarn = vi.fn();
const crearEffectsMock = vi.fn();
const leerVistoMock = vi.fn();

vi.mock("@/lib/log", () => ({
  log: { info: (...a: unknown[]) => logInfo(...a), warn: (...a: unknown[]) => logWarn(...a), error: vi.fn() },
  errorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("./effects-sombra", () => ({
  crearEffectsDeSombra: (...a: unknown[]) => crearEffectsMock(...a),
  leerVistoDeSombra: (...a: unknown[]) => leerVistoMock(...a),
}));
// `getRedis` lanza sin REDIS_URL; cada test decide si hay Redis por `deps.redis`,
// y este mock es el que responde cuando NO se inyecta nada (el camino real).
const getRedisMock = vi.fn();
vi.mock("@/lib/redis", () => ({ getRedis: () => getRedisMock() }));

import { SOMBRA_ESPERA_MAX_MS, SOMBRA_LOCK_SEGUNDOS, correrSombra, type EntradaDeSombra } from "./sombra";
import type { ResumenDeTurno } from "./tipos";

const supabase = {} as SupabaseClient<Database>;
const AHORA = new Date("2026-11-17T15:00:00.000Z");
const EFECTOS = { modo: "sombra" } as const;
const VISTO = { hasta: "2026-11-17T14:59:00.000Z", ids: ["m-1"] };

const RESUMEN = { accion: "answered" } as unknown as ResumenDeTurno;

function entrada(extra: Partial<EntradaDeSombra> = {}): EntradaDeSombra {
  return {
    supabase,
    conversationId: "conv-1",
    modo: "sombra",
    iaGlobal: false,
    asesorAsignado: false,
    businessHours: DEFAULT_BUSINESS_HOURS,
    lessons: { global: [], chat: [] } as unknown as EntradaDeSombra["lessons"],
    cargarHistorial: vi.fn(),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  crearEffectsMock.mockReturnValue(EFECTOS);
  leerVistoMock.mockResolvedValue(VISTO);
  getRedisMock.mockImplementation(() => {
    throw new Error("Falta REDIS_URL");
  });
});

describe("correrSombra — el candado anti-duplicado", () => {
  it("toma sombra:<id> con SET NX EX 90 y corre el turno", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno, redis: () => ({ set }), ahora: () => AHORA } }));

    expect(SOMBRA_LOCK_SEGUNDOS).toBe(90);
    expect(set).toHaveBeenCalledWith("sombra:conv-1", "1", "EX", 90, "NX");
    expect(correrTurno).toHaveBeenCalledTimes(1);
  });

  it("con el candado tomado no corre y lo deja dicho", async () => {
    const set = vi.fn().mockResolvedValue(null);
    const correrTurno = vi.fn();

    await correrSombra(entrada({ deps: { correrTurno, redis: () => ({ set }) } }));

    expect(correrTurno).not.toHaveBeenCalled();
    expect(leerVistoMock).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith("sombra_ya_en_curso", expect.objectContaining({ conversationId: "conv-1" }));
  });

  it("sin Redis (getRedis lanza) corre igual, sin candado, y avisa", async () => {
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno } }));

    expect(correrTurno).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("sombra_sin_candado", expect.objectContaining({ conversationId: "conv-1" }));
  });

  it("si Redis responde con error al tomar el candado, corre igual y avisa", async () => {
    const set = vi.fn().mockRejectedValue(new Error("redis caído"));
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno, redis: () => ({ set }) } }));

    expect(correrTurno).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("sombra_sin_candado", expect.objectContaining({ detail: "redis caído" }));
  });

  it("usa getRedis cuando no se inyecta Redis", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    getRedisMock.mockReturnValue({ set });
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno } }));

    expect(set).toHaveBeenCalledWith("sombra:conv-1", "1", "EX", 90, "NX");
  });
});

describe("correrSombra — el turno", () => {
  it("corre con persistencia sombra, el visto de leerVistoDeSombra y lo precargado", async () => {
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);
    const e = entrada({ modo: "copiloto", asesorAsignado: true, iaGlobal: true, deps: { correrTurno, ahora: () => AHORA } });

    await correrSombra(e);

    expect(leerVistoMock).toHaveBeenCalledWith(supabase, "conv-1", "copiloto");
    expect(crearEffectsMock).toHaveBeenCalledTimes(1);
    const deps = crearEffectsMock.mock.calls[0][0];
    expect(deps).toMatchObject({
      supabase,
      conversationId: "conv-1",
      modo: "copiloto",
      businessHours: e.businessHours,
      asesorAsignado: true,
    });
    expect(deps.ahora()).toEqual(AHORA);

    const [entradaDeTurno, efectos] = correrTurno.mock.calls[0];
    expect(efectos).toBe(EFECTOS);
    expect(entradaDeTurno).toMatchObject({
      supabase,
      conversationId: "conv-1",
      ahora: AHORA,
      iaGlobal: true,
      visto: VISTO,
      persistencia: "sombra",
      cargarHistorial: e.cargarHistorial,
      precargado: { lessons: e.lessons, businessHours: e.businessHours },
    });
  });

  it("corre dentro de su PROPIO registro de telemetría, no del turno de v1", async () => {
    const { conTelemetriaDeTurno } = await import("@/lib/ai/turn-telemetry");
    let dentro: unknown[] | null = null;
    const correrTurno = vi.fn(async () => {
      dentro = turnCallsSnapshot();
      return RESUMEN;
    });

    let fuera: unknown[] = [];
    await conTelemetriaDeTurno(async () => {
      fuera = turnCallsSnapshot();
      await correrSombra(entrada({ deps: { correrTurno } }));
    });

    expect(dentro).not.toBeNull();
    expect(dentro).not.toBe(fuera);
  });

  it("deja sombra_turno con la acción y la duración al terminar", async () => {
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno } }));

    expect(logInfo).toHaveBeenCalledWith(
      "sombra_turno",
      expect.objectContaining({ conversationId: "conv-1", modo: "sombra", accion: "answered", duracionMs: expect.any(Number) })
    );
  });

  it("un turno que lanza NO rechaza: queda en sombra_fallo", async () => {
    const correrTurno = vi.fn().mockRejectedValue(new Error("el modelo se cayó"));

    await expect(correrSombra(entrada({ deps: { correrTurno } }))).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledWith(
      "sombra_fallo",
      expect.objectContaining({ conversationId: "conv-1", detail: "el modelo se cayó" })
    );
  });

  it("si lo que lanza es leerVistoDeSombra, tampoco rechaza", async () => {
    leerVistoMock.mockRejectedValue(new Error("base caída"));
    const correrTurno = vi.fn();

    await expect(correrSombra(entrada({ deps: { correrTurno } }))).resolves.toBeUndefined();

    expect(correrTurno).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("sombra_fallo", expect.objectContaining({ detail: "base caída" }));
  });

  it("el tope de espera de la costura es de un minuto", () => {
    expect(SOMBRA_ESPERA_MAX_MS).toBe(60_000);
  });
});
