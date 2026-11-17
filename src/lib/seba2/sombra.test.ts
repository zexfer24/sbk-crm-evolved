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

/**
 * Un Redis de mentira con la semántica que importa del candado: `SET … NX` solo pone si no hay valor, y `get`/`del`
 * leen y borran. Sin vencimiento (los tests no esperan 90 s): lo que vence solo se prueba con `SOMBRA_LOCK_SEGUNDOS`.
 */
function redisFalso() {
  const guardado = new Map<string, string>();
  const set = vi.fn(async (...args: [key: string, value: string, ex: "EX", segundos: number, nx: "NX"]) => {
    const [key, value] = args;
    if (guardado.has(key)) return null;
    guardado.set(key, value);
    return "OK";
  });
  const get = vi.fn(async (key: string) => guardado.get(key) ?? null);
  const del = vi.fn(async (key: string) => (guardado.delete(key) ? 1 : 0));
  return { set, get, del, guardado };
}

/** Una promesa que se resuelve a mano: sirve para dejar un turno «en curso» mientras otro intenta entrar. */
function diferida<T>() {
  let resolver!: (valor: T) => void;
  let rechazar!: (error: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

describe("correrSombra — el candado anti-duplicado", () => {
  it("toma sombra:<id> con un valor propio, SET NX EX 90, y corre el turno", async () => {
    const redis = redisFalso();
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno, redis: () => redis, ahora: () => AHORA } }));

    expect(SOMBRA_LOCK_SEGUNDOS).toBe(90);
    expect(redis.set).toHaveBeenCalledWith("sombra:conv-1", expect.any(String), "EX", 90, "NX");
    // El valor es aleatorio por disparo (no un «1» compartido): solo así se puede reconocer el candado propio.
    expect(redis.set.mock.calls[0][1]).not.toBe("1");
    expect(correrTurno).toHaveBeenCalledTimes(1);
  });

  it("con el candado tomado no corre y lo deja dicho", async () => {
    const redis = redisFalso();
    redis.guardado.set("sombra:conv-1", "de-otro-disparo");
    const correrTurno = vi.fn();

    await correrSombra(entrada({ deps: { correrTurno, redis: () => redis } }));

    expect(correrTurno).not.toHaveBeenCalled();
    expect(leerVistoMock).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith("sombra_ya_en_curso", expect.objectContaining({ conversationId: "conv-1" }));
    // El candado ajeno no se toca: ni se pisa ni se borra.
    expect(redis.guardado.get("sombra:conv-1")).toBe("de-otro-disparo");
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("sin Redis (getRedis lanza) corre igual, sin candado, y avisa", async () => {
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno } }));

    expect(correrTurno).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("sombra_sin_candado", expect.objectContaining({ conversationId: "conv-1" }));
  });

  it("si Redis responde con error al tomar el candado, corre igual y avisa", async () => {
    const redis = { ...redisFalso(), set: vi.fn().mockRejectedValue(new Error("redis caído")) };
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno, redis: () => redis } }));

    expect(correrTurno).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("sombra_sin_candado", expect.objectContaining({ detail: "redis caído" }));
    // Sin candado tomado no hay nada que liberar.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("usa getRedis cuando no se inyecta Redis", async () => {
    const redis = redisFalso();
    getRedisMock.mockReturnValue(redis);
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSombra(entrada({ deps: { correrTurno } }));

    expect(redis.set).toHaveBeenCalledWith("sombra:conv-1", expect.any(String), "EX", 90, "NX");
  });

  // 17/11/2026 (R1/C2): el candado vivía 90 s aunque el turno ya hubiera terminado. Un cliente que escribía «hola» y
  // 30 s después su pregunta real veía el segundo turno salir por `sombra_ya_en_curso`: esa pregunta no dejaba borrador.
  it("al terminar el turno libera el candado, y una segunda corrida inmediata SÍ corre", async () => {
    const redis = redisFalso();
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);
    const deps = { correrTurno, redis: () => redis };

    await correrSombra(entrada({ deps }));
    expect(redis.guardado.has("sombra:conv-1")).toBe(false);

    await correrSombra(entrada({ deps }));

    expect(correrTurno).toHaveBeenCalledTimes(2);
    expect(logInfo).not.toHaveBeenCalledWith("sombra_ya_en_curso", expect.anything());
  });

  it("mientras la primera corrida sigue en curso, la segunda NO corre (dos disparos simultáneos: uno solo)", async () => {
    const redis = redisFalso();
    const enCurso = diferida<ResumenDeTurno>();
    const correrTurno = vi.fn().mockReturnValueOnce(enCurso.promesa).mockResolvedValue(RESUMEN);
    const deps = { correrTurno, redis: () => redis };

    const primera = correrSombra(entrada({ deps }));
    await vi.waitFor(() => expect(correrTurno).toHaveBeenCalledTimes(1));

    await correrSombra(entrada({ deps }));
    expect(correrTurno).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith("sombra_ya_en_curso", expect.objectContaining({ conversationId: "conv-1" }));

    enCurso.resolver(RESUMEN);
    await primera;
    expect(redis.guardado.has("sombra:conv-1")).toBe(false);
  });

  it("si el turno lanza, el candado se libera igual", async () => {
    const redis = redisFalso();
    const correrTurno = vi.fn().mockRejectedValue(new Error("el modelo se cayó"));

    await expect(correrSombra(entrada({ deps: { correrTurno, redis: () => redis } }))).resolves.toBeUndefined();

    expect(redis.guardado.has("sombra:conv-1")).toBe(false);
    expect(logWarn).toHaveBeenCalledWith("sombra_fallo", expect.objectContaining({ detail: "el modelo se cayó" }));
  });

  it("si lo que lanza es leerVistoDeSombra, el candado también se libera", async () => {
    const redis = redisFalso();
    leerVistoMock.mockRejectedValue(new Error("base caída"));

    await correrSombra(entrada({ deps: { correrTurno: vi.fn(), redis: () => redis } }));

    expect(redis.guardado.has("sombra:conv-1")).toBe(false);
  });

  it("no borra un candado ajeno: si el valor ya no es el propio (venció y otro disparo lo tomó), lo deja", async () => {
    const redis = redisFalso();
    const correrTurno = vi.fn(async () => {
      // El candado propio venció a los 90 s y otro disparo tomó el suyo mientras este turno seguía corriendo.
      redis.guardado.set("sombra:conv-1", "valor-de-otro-disparo");
      return RESUMEN;
    });

    await correrSombra(entrada({ deps: { correrTurno, redis: () => redis } }));

    expect(redis.guardado.get("sombra:conv-1")).toBe("valor-de-otro-disparo");
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("un fallo al liberar (del) no rechaza: queda en sombra_candado_no_liberado", async () => {
    const redis = redisFalso();
    redis.del.mockRejectedValue(new Error("redis caído"));
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await expect(correrSombra(entrada({ deps: { correrTurno, redis: () => redis } }))).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledWith(
      "sombra_candado_no_liberado",
      expect.objectContaining({ conversationId: "conv-1", detail: "redis caído" })
    );
  });

  it("un fallo al leer el candado para liberarlo (get) tampoco rechaza", async () => {
    const redis = redisFalso();
    redis.get.mockRejectedValue(new Error("redis caído"));
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await expect(correrSombra(entrada({ deps: { correrTurno, redis: () => redis } }))).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledWith("sombra_candado_no_liberado", expect.objectContaining({ conversationId: "conv-1" }));
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
