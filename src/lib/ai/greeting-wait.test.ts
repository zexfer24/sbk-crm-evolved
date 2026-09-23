import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// T6, plan "Seba no habla de más mientras el cliente espera al asesor"
// (22-23/9/2026). Fake de Redis PROPIO con espía de clave/valor/argumentos —
// mismo criterio que `turn-seen.test.ts`/`turn-cession.test.ts` (CLAUDE.md,
// trampa de "El resguardo antes del push": un fake que no distingue el
// operador o el argumento real de una llamada no prueba nada). Acá lo que
// hay que distinguir de verdad es `NX`: sin él, dos llamadas seguidas a
// `set` "ganarían" las dos, y `claimGreetingWait` no podría distinguir el
// primer intento del segundo.
// ---------------------------------------------------------------------------

interface SetCall {
  key: string;
  value: string;
  args: unknown[];
}

class FakeRedisSpy {
  store = new Map<string, string>();
  setCalls: SetCall[] = [];
  delCalls: string[] = [];
  /** Cuando no es null, la próxima llamada lanza esto (simula un corte de Redis). */
  fallaCon: Error | null = null;

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    this.setCalls.push({ key, value, args });
    if (this.fallaCon) throw this.fallaCon;
    const nx = args.some((arg) => typeof arg === "string" && arg.toUpperCase() === "NX");
    if (nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.delCalls.push(key);
    if (this.fallaCon) throw this.fallaCon;
    const existed = this.store.delete(key);
    return existed ? 1 : 0;
  }
}

const redis = new FakeRedisSpy();
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

import {
  claimGreetingWait,
  clearGreetingWait,
  GREETING_WAIT_SECONDS,
  GreetingAwaitsQuestionError,
  isGreetingAwaitsQuestion,
} from "@/lib/ai/greeting-wait";
import { log } from "@/lib/log";

beforeEach(() => {
  redis.store.clear();
  redis.setCalls.length = 0;
  redis.delCalls.length = 0;
  redis.fallaCon = null;
});

describe("claimGreetingWait", () => {
  it("la primera llamada escribe la clave 'turno:saludo_suelto:<id>' con NX y devuelve 'primer_intento'", async () => {
    const resultado = await claimGreetingWait("conv-1");

    expect(resultado).toBe("primer_intento");
    expect(redis.setCalls).toHaveLength(1);
    const llamada = redis.setCalls[0];
    expect(llamada.key).toBe("turno:saludo_suelto:conv-1");
    // NX está entre los argumentos que le llegan a Redis -- sin esto, la
    // segunda llamada "ganaría" el SET igual que la primera.
    expect(llamada.args.map((a) => String(a).toUpperCase())).toContain("NX");
    // Con TTL: `GREETING_WAIT_SECONDS` más el margen documentado en el
    // módulo, no un número cualquiera ni el símbolo importado a secas
    // (CLAUDE.md, "un tope numérico se fija en el test con su literal").
    expect(llamada.args).toContain("EX");
    expect(llamada.args[llamada.args.indexOf("EX") + 1]).toBe(38);
  });

  it("la segunda llamada, con la clave ya puesta, devuelve 'segundo_intento' sin pisar el valor", async () => {
    await claimGreetingWait("conv-1");
    const resultado = await claimGreetingWait("conv-1");

    expect(resultado).toBe("segundo_intento");
    expect(redis.setCalls).toHaveLength(2);
  });

  it("dos conversaciones distintas no se pisan: cada una tiene su propio primer intento", async () => {
    expect(await claimGreetingWait("conv-1")).toBe("primer_intento");
    expect(await claimGreetingWait("conv-2")).toBe("primer_intento");
  });

  it("con Redis caído, devuelve 'sin_redis' sin lanzar y deja el aviso en el log", async () => {
    redis.fallaCon = new Error("ECONNREFUSED");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    const resultado = await claimGreetingWait("conv-1");

    expect(resultado).toBe("sin_redis");
    expect(warn).toHaveBeenCalledWith(
      "turno_saludo_suelto_redis_no_disponible",
      expect.objectContaining({ conversationId: "conv-1", detail: "ECONNREFUSED" })
    );
    warn.mockRestore();
  });
});

describe("clearGreetingWait", () => {
  it("borra la clave de esta conversación", async () => {
    await claimGreetingWait("conv-1");
    expect(redis.store.has("turno:saludo_suelto:conv-1")).toBe(true);

    await clearGreetingWait("conv-1");

    expect(redis.store.has("turno:saludo_suelto:conv-1")).toBe(false);
    expect(redis.delCalls).toEqual(["turno:saludo_suelto:conv-1"]);
  });

  it("borrar una clave que no existe no lanza", async () => {
    await expect(clearGreetingWait("conv-sin-rastro")).resolves.toBeUndefined();
  });

  it("con Redis caído, no lanza y deja el aviso en el log", async () => {
    redis.fallaCon = new Error("ECONNREFUSED");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    await expect(clearGreetingWait("conv-1")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "turno_saludo_suelto_rastro_no_borrado",
      expect.objectContaining({ conversationId: "conv-1", detail: "ECONNREFUSED" })
    );
    warn.mockRestore();
  });
});

describe("GREETING_WAIT_SECONDS", () => {
  it("es 8 -- decisión literal del operador (23/9/2026), no un número cualquiera", () => {
    expect(GREETING_WAIT_SECONDS).toBe(8);
  });
});

describe("GreetingAwaitsQuestionError / isGreetingAwaitsQuestion", () => {
  it("isGreetingAwaitsQuestion reconoce solo esta clase de error", () => {
    expect(isGreetingAwaitsQuestion(new GreetingAwaitsQuestionError("conv-1"))).toBe(true);
    expect(isGreetingAwaitsQuestion(new Error("otro error"))).toBe(false);
    expect(isGreetingAwaitsQuestion(null)).toBe(false);
  });

  it("guarda el conversationId y menciona los 8 s de espera en el mensaje", () => {
    const err = new GreetingAwaitsQuestionError("conv-42");
    expect(err.conversationId).toBe("conv-42");
    // Literal, no el símbolo bajo prueba (CLAUDE.md, "El resguardo antes del
    // push"): si alguien cambia `GREETING_WAIT_SECONDS` sin querer, este
    // test tiene que notarlo.
    expect(err.message).toContain("8 s");
  });
});
