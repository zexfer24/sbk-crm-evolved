import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { TurnTarget } from "@/lib/ai/turn-target";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";

const crearEffectsMock = vi.fn();
const readSeenMock = vi.fn();
const getRedisMock = vi.fn();

vi.mock("./effects-real", () => ({ crearEffectsReales: (...a: unknown[]) => crearEffectsMock(...a) }));
vi.mock("@/lib/ai/turn-seen", () => ({ readSeen: (...a: unknown[]) => readSeenMock(...a) }));
vi.mock("@/lib/redis", () => ({ getRedis: () => getRedisMock() }));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errorText: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { correrSeba2EnVivo, type EntradaDeVivo } from "./vivo";
import type { ResumenDeTurno } from "./tipos";

const supabase = {} as SupabaseClient<Database>;
const AHORA = new Date("2026-11-17T15:00:00.000Z");
const EFECTOS = { modo: "real" } as const;
const VISTO = { hasta: "2026-11-17T14:59:00.000Z", ids: ["m-1"] };
const RESUMEN = { accion: "answered" } as unknown as ResumenDeTurno;
const TARGET = { conversationId: "conv-1" } as unknown as TurnTarget;

function entrada(extra: Partial<EntradaDeVivo> = {}): EntradaDeVivo {
  return {
    supabase,
    conversationId: "conv-1",
    contactId: "contact-1",
    target: TARGET,
    assignedAgentId: null,
    businessHours: DEFAULT_BUSINESS_HOURS,
    lessons: { global: [], chat: [] } as unknown as EntradaDeVivo["lessons"],
    cargarHistorial: vi.fn(),
    entregar: vi.fn(),
    alFallarEnvio: vi.fn(),
    escribiendo: vi.fn(),
    registrarTurno: vi.fn(),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  crearEffectsMock.mockReturnValue(EFECTOS);
  readSeenMock.mockResolvedValue(VISTO);
  getRedisMock.mockReturnValue({});
});

describe("correrSeba2EnVivo", () => {
  it("arma los efectos reales con TODAS las deps que recibe", async () => {
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);
    const e = entrada({ assignedAgentId: "agente-7", deps: { correrTurno, ahora: () => AHORA } });

    await correrSeba2EnVivo(e);

    expect(crearEffectsMock).toHaveBeenCalledTimes(1);
    const deps = crearEffectsMock.mock.calls[0][0];
    expect(deps).toMatchObject({
      supabase,
      conversationId: "conv-1",
      contactId: "contact-1",
      target: TARGET,
      businessHours: DEFAULT_BUSINESS_HOURS,
      assignedAgentId: "agente-7",
      entregar: e.entregar,
      alFallarEnvio: e.alFallarEnvio,
      escribiendo: e.escribiendo,
      registrarTurno: e.registrarTurno,
      redisDisponible: true,
    });
    // R1/C1 (17/11/2026): los efectos reales ya no reciben la marca del turno anterior (el turno le pasa a
    // `hayMensajeNuevoDelCliente` la de su ráfaga); la marca sigue viajando al TURNO como `entrada.visto`.
    expect(deps).not.toHaveProperty("visto");
    expect(deps.ahora()).toEqual(AHORA);
  });

  it("corre el turno con persistencia normal, IA global y lo precargado, y devuelve su resumen", async () => {
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);
    const e = entrada({ deps: { correrTurno, ahora: () => AHORA } });

    await expect(correrSeba2EnVivo(e)).resolves.toBe(RESUMEN);

    const [entradaDeTurno, efectos] = correrTurno.mock.calls[0];
    expect(efectos).toBe(EFECTOS);
    expect(entradaDeTurno).toMatchObject({
      supabase,
      conversationId: "conv-1",
      ahora: AHORA,
      iaGlobal: true,
      visto: VISTO,
      persistencia: "normal",
      cargarHistorial: e.cargarHistorial,
      precargado: { lessons: e.lessons, businessHours: e.businessHours },
    });
    expect(readSeenMock).toHaveBeenCalledWith("conv-1");
  });

  it("sin Redis: visto null, redisDisponible false y no consulta la marca", async () => {
    getRedisMock.mockImplementation(() => {
      throw new Error("Falta REDIS_URL");
    });
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSeba2EnVivo(entrada({ deps: { correrTurno } }));

    expect(readSeenMock).not.toHaveBeenCalled();
    expect(crearEffectsMock.mock.calls[0][0]).toMatchObject({ redisDisponible: false });
    expect(correrTurno.mock.calls[0][0]).toMatchObject({ visto: null });
  });

  it("acepta las inyecciones de test (leerVisto y redisDisponible)", async () => {
    const leerVisto = vi.fn().mockResolvedValue(VISTO);
    const correrTurno = vi.fn().mockResolvedValue(RESUMEN);

    await correrSeba2EnVivo(entrada({ deps: { correrTurno, leerVisto, redisDisponible: true } }));

    expect(leerVisto).toHaveBeenCalledWith("conv-1");
    expect(readSeenMock).not.toHaveBeenCalled();
    expect(getRedisMock).not.toHaveBeenCalled();
  });

  it("lo que lanza el turno sale tal cual: quien llama decide el reintento", async () => {
    const error = new Error("el modelo se cayó");
    const correrTurno = vi.fn().mockRejectedValue(error);

    await expect(correrSeba2EnVivo(entrada({ deps: { correrTurno } }))).rejects.toBe(error);
  });
});
