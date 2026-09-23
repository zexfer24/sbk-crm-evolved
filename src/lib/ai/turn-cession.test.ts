import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// T2, plan "Seba no habla de más mientras el cliente espera al asesor"
// (22-23/9/2026). Fake de Redis PROPIO, con espía de clave/valor/TTL —
// mismo criterio que `turn-seen.test.ts` (CLAUDE.md, trampa de "El
// resguardo antes del push": un fake que no distingue el operador o el
// argumento real de una llamada no prueba nada).
// ---------------------------------------------------------------------------

interface ExpireCall {
  key: string;
  seconds: number;
}

class FakeRedisSpy {
  store = new Map<string, number>();
  incrCalls: string[] = [];
  expireCalls: ExpireCall[] = [];
  delCalls: string[] = [];
  /** Cuando no es null, la próxima llamada lanza esto (simula un corte de Redis). */
  fallaCon: Error | null = null;

  async incr(key: string): Promise<number> {
    this.incrCalls.push(key);
    if (this.fallaCon) throw this.fallaCon;
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expireCalls.push({ key, seconds });
    if (this.fallaCon) throw this.fallaCon;
    return 1;
  }

  async del(key: string): Promise<number> {
    this.delCalls.push(key);
    if (this.fallaCon) throw this.fallaCon;
    this.store.delete(key);
    return 1;
  }
}

const redis = new FakeRedisSpy();
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

import { clearCessionCounter, decideCession, shouldCedeDraft } from "@/lib/ai/turn-cession";
import { log } from "@/lib/log";

beforeEach(() => {
  redis.store.clear();
  redis.incrCalls.length = 0;
  redis.expireCalls.length = 0;
  redis.delCalls.length = 0;
  redis.fallaCon = null;
});

describe("decideCession — la parte pura", () => {
  it("un mensaje más nuevo que lo cargado cede", () => {
    expect(
      decideCession({
        lastCustomerMessageAtAhora: "2026-09-22T15:25:00.000Z",
        hastaCargado: "2026-09-22T15:24:44.000Z",
        yaEscalo: false,
      })
    ).toEqual({ cede: true, motivo: "mas_nuevo" });
  });

  it("la misma fecha (empate) no cede: no es nada nuevo, es lo mismo que ya se cargó", () => {
    expect(
      decideCession({
        lastCustomerMessageAtAhora: "2026-09-22T15:24:44.000Z",
        hastaCargado: "2026-09-22T15:24:44.000Z",
        yaEscalo: false,
      })
    ).toEqual({ cede: false, motivo: "sin_novedad" });
  });

  it("una fecha más VIEJA no cede", () => {
    expect(
      decideCession({
        lastCustomerMessageAtAhora: "2026-09-22T15:20:00.000Z",
        hastaCargado: "2026-09-22T15:24:44.000Z",
        yaEscalo: false,
      })
    ).toEqual({ cede: false, motivo: "sin_novedad" });
  });

  it("si el turno ya escaló, no cede aunque haya un mensaje más nuevo — la despedida tiene que salir", () => {
    expect(
      decideCession({
        lastCustomerMessageAtAhora: "2026-09-22T15:30:00.000Z",
        hastaCargado: "2026-09-22T15:24:44.000Z",
        yaEscalo: true,
      })
    ).toEqual({ cede: false, motivo: "ya_escalo" });
  });

  it("sin hastaCargado (el historial cargado no traía ninguna línea de cliente con fecha) no cede", () => {
    expect(
      decideCession({
        lastCustomerMessageAtAhora: "2026-09-22T15:30:00.000Z",
        hastaCargado: null,
        yaEscalo: false,
      })
    ).toEqual({ cede: false, motivo: "sin_novedad" });
  });

  it("sin lastCustomerMessageAtAhora (lectura rara, dato ausente) no cede", () => {
    expect(
      decideCession({
        lastCustomerMessageAtAhora: null,
        hastaCargado: "2026-09-22T15:24:44.000Z",
        yaEscalo: false,
      })
    ).toEqual({ cede: false, motivo: "sin_novedad" });
  });
});

function fakeSupabase(lastCustomerMessageAt: string | null, error: { message: string } | null = null) {
  return {
    from: (table: string) => {
      if (table !== "conversations") throw new Error(`tabla no esperada: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: error ? null : { last_customer_message_at: lastCustomerMessageAt },
              error,
            }),
          }),
        }),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("shouldCedeDraft — el contador y el tope", () => {
  it("escribe INCR en la clave 'turno:cedido:<id>' y EXPIRE de 120 s exactos (literal, no CESSION_TTL_SECONDS)", async () => {
    const supabase = fakeSupabase("2026-09-22T15:30:00.000Z");

    const decision = await shouldCedeDraft({
      supabase,
      conversationId: "conv-1",
      hastaCargado: "2026-09-22T15:24:44.000Z",
      yaEscalo: false,
    });

    expect(decision).toEqual({ cede: true, motivo: "mas_nuevo" });
    expect(redis.incrCalls).toEqual(["turno:cedido:conv-1"]);
    // Literal, no el símbolo del propio módulo (CLAUDE.md, "El resguardo
    // antes del push": "un tope numérico se fija en el test con su
    // literal, nunca con el símbolo que ya está probando").
    expect(redis.expireCalls).toEqual([{ key: "turno:cedido:conv-1", seconds: 120 }]);
  });

  it("tope: al tercer intento (valor > 2) ya no cede, aunque siga llegando más — se manda", async () => {
    const supabase = fakeSupabase("2026-09-22T15:30:00.000Z");
    const params = {
      supabase,
      conversationId: "conv-1",
      hastaCargado: "2026-09-22T15:24:44.000Z",
      yaEscalo: false,
    };

    // Literal 2, no CESSION_CAP: las primeras DOS ceden.
    expect((await shouldCedeDraft(params)).cede).toBe(true);
    expect((await shouldCedeDraft(params)).cede).toBe(true);
    // La tercera (INCR da 3, > 2) ya no.
    const tercera = await shouldCedeDraft(params);
    expect(tercera).toEqual({ cede: false, motivo: "tope" });
  });

  it("si el turno ya escaló, ni siquiera lee la base ni toca Redis", async () => {
    const supabase = fakeSupabase("2026-09-22T15:30:00.000Z");
    const selectSpy = vi.spyOn(supabase, "from");

    const decision = await shouldCedeDraft({
      supabase,
      conversationId: "conv-1",
      hastaCargado: "2026-09-22T15:24:44.000Z",
      yaEscalo: true,
    });

    expect(decision).toEqual({ cede: false, motivo: "ya_escalo" });
    expect(selectSpy).not.toHaveBeenCalled();
    expect(redis.incrCalls).toEqual([]);
  });

  it("un error leyendo conversations no lanza: no cede", async () => {
    const supabase = fakeSupabase(null, { message: "corte de red" });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const decision = await shouldCedeDraft({
      supabase,
      conversationId: "conv-1",
      hastaCargado: "2026-09-22T15:24:44.000Z",
      yaEscalo: false,
    });

    expect(decision).toEqual({ cede: false, motivo: "lectura_fallida" });
    expect(warnSpy).toHaveBeenCalledWith(
      "turno_cesion_no_consultable",
      expect.objectContaining({ conversationId: "conv-1" })
    );
    warnSpy.mockRestore();
  });

  it("Redis caído en el momento del tope: no cede (Redis caído == no ceder)", async () => {
    const supabase = fakeSupabase("2026-09-22T15:30:00.000Z");
    redis.fallaCon = new Error("ECONNREFUSED");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const decision = await shouldCedeDraft({
      supabase,
      conversationId: "conv-1",
      hastaCargado: "2026-09-22T15:24:44.000Z",
      yaEscalo: false,
    });

    expect(decision).toEqual({ cede: false, motivo: "redis_no_disponible" });
    expect(warnSpy).toHaveBeenCalledWith(
      "turno_cesion_redis_no_disponible",
      expect.objectContaining({ conversationId: "conv-1" })
    );
    warnSpy.mockRestore();
  });

  it("sin novedad (no hay mensaje más nuevo): no toca Redis en absoluto", async () => {
    const supabase = fakeSupabase("2026-09-22T15:24:44.000Z");

    const decision = await shouldCedeDraft({
      supabase,
      conversationId: "conv-1",
      hastaCargado: "2026-09-22T15:24:44.000Z",
      yaEscalo: false,
    });

    expect(decision).toEqual({ cede: false, motivo: "sin_novedad" });
    expect(redis.incrCalls).toEqual([]);
  });
});

describe("clearCessionCounter", () => {
  it("borra la clave 'turno:cedido:<id>' con DEL", async () => {
    await clearCessionCounter("conv-1");
    expect(redis.delCalls).toEqual(["turno:cedido:conv-1"]);
  });

  it("nunca lanza si Redis falla: deja log.warn y sigue", async () => {
    redis.fallaCon = new Error("ECONNRESET");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(clearCessionCounter("conv-1")).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "turno_cesion_contador_no_borrado",
      expect.objectContaining({ conversationId: "conv-1" })
    );
    warnSpy.mockRestore();
  });
});
