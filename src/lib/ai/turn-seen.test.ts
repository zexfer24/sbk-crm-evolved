import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// T1, plan "Seba no habla de más mientras el cliente espera al asesor"
// (22-23/9/2026). Fake de Redis PROPIO (no el `FakeRedis` de fake-redis.ts,
// que es de la cola y otra tarea en paralelo lo toca): acá interesa poder
// espiar la clave, el valor y el TTL EXACTOS de cada llamada, no solo que la
// lectura/escritura "funcione" — CLAUDE.md, trampa de "El resguardo antes
// del push" (20/9/2026): un fake que no distingue el operador o el argumento
// real de una llamada no prueba nada.
// ---------------------------------------------------------------------------

interface SetCall {
  key: string;
  value: string;
  args: unknown[];
}

class FakeRedisSpy {
  store = new Map<string, string>();
  setCalls: SetCall[] = [];
  getCalls: string[] = [];
  /** Cuando no es null, la próxima llamada a get()/set() lanza esto (simula un corte de Redis). */
  fallaCon: Error | null = null;

  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    if (this.fallaCon) throw this.fallaCon;
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK"> {
    this.setCalls.push({ key, value, args });
    if (this.fallaCon) throw this.fallaCon;
    this.store.set(key, value);
    return "OK";
  }
}

const redis = new FakeRedisSpy();
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

import { readSeen, writeSeen } from "@/lib/ai/turn-seen";
import { log } from "@/lib/log";

beforeEach(() => {
  redis.store.clear();
  redis.setCalls.length = 0;
  redis.getCalls.length = 0;
  redis.fallaCon = null;
});

describe("writeSeen", () => {
  it("escribe la clave 'turno:visto:<id>' con el JSON de la marca y TTL de 6 horas exactas", async () => {
    await writeSeen("conv-1", { hasta: "2026-09-22T15:24:44.000Z", ids: ["m1", "m2"] });

    expect(redis.setCalls).toHaveLength(1);
    const llamada = redis.setCalls[0];
    expect(llamada.key).toBe("turno:visto:conv-1");
    expect(JSON.parse(llamada.value)).toEqual({ hasta: "2026-09-22T15:24:44.000Z", ids: ["m1", "m2"] });
    // Literal, no el símbolo TTL_SECONDS del propio módulo (CLAUDE.md, "un
    // tope numérico se fija con su literal, nunca con el símbolo que ya está
    // probando"): 6 horas = 21600 segundos.
    expect(llamada.args).toEqual(["EX", 21600]);
  });

  it("nunca lanza si Redis falla: deja log.warn y sigue", async () => {
    redis.fallaCon = new Error("ECONNREFUSED");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(writeSeen("conv-1", { hasta: "2026-09-22T15:24:44.000Z", ids: [] })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "turno_visto_no_escrito",
      expect.objectContaining({ conversationId: "conv-1" })
    );
    warnSpy.mockRestore();
  });
});

describe("readSeen", () => {
  it("devuelve null si nunca se escribió nada para esa conversación", async () => {
    expect(await readSeen("conv-nunca-vista")).toBeNull();
    expect(redis.getCalls).toEqual(["turno:visto:conv-nunca-vista"]);
  });

  it("lee de vuelta exactamente lo que escribió writeSeen", async () => {
    await writeSeen("conv-1", { hasta: "2026-09-22T15:24:44.000Z", ids: ["m1"] });
    expect(await readSeen("conv-1")).toEqual({ hasta: "2026-09-22T15:24:44.000Z", ids: ["m1"] });
  });

  it("nunca lanza si Redis falla: deja log.warn y devuelve null", async () => {
    redis.fallaCon = new Error("ECONNRESET");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(readSeen("conv-1")).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      "turno_visto_no_legible",
      expect.objectContaining({ conversationId: "conv-1" })
    );
    warnSpy.mockRestore();
  });

  it("un JSON corrupto en la clave da null en vez de lanzar", async () => {
    redis.store.set("turno:visto:conv-1", "{esto no es JSON");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(await readSeen("conv-1")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("turno_visto_no_legible", expect.anything());
    warnSpy.mockRestore();
  });

  it("un valor con forma distinta a SeenMarker (sin 'ids', por ejemplo) da null", async () => {
    redis.store.set("turno:visto:conv-1", JSON.stringify({ hasta: "2026-09-22T15:24:44.000Z" }));
    expect(await readSeen("conv-1")).toBeNull();
  });
});
