import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "@/lib/ai/fake-redis";

// ---------------------------------------------------------------------------
// T3a, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026). Se usa el `FakeRedis` de la cola (fake-redis.ts)
// para el ida y vuelta, y se le suman DOS espías —la clave y los argumentos
// de cada `set`— porque un fake que no distingue el TTL o la clave real no
// prueba nada (CLAUDE.md, trampa de "El resguardo antes del push",
// 20/9/2026).
// ---------------------------------------------------------------------------

class RedisEspia extends FakeRedis {
  setCalls: { key: string; value: string; args: unknown[] }[] = [];
  getCalls: string[] = [];
  /** Cuando no es null, get()/set() lanzan esto (simula un corte de Redis). */
  fallaCon: Error | null = null;

  override async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    this.setCalls.push({ key, value, args });
    if (this.fallaCon) throw this.fallaCon;
    return super.set(key, value, ...args);
  }

  override async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    if (this.fallaCon) throw this.fallaCon;
    return super.get(key);
  }
}

const estado = vi.hoisted(() => ({ redis: null as unknown, sinRedis: false }));
vi.mock("@/lib/redis", () => ({
  getRedis: () => {
    if (estado.sinRedis) throw new Error("Falta REDIS_URL: la cola de turnos del agente no puede funcionar sin Redis.");
    return estado.redis;
  },
}));

import { CATALOGO_PEDIDO_TTL_SECONDS, guardarPedido, leerPedido, type PedidoCatalogo } from "@/lib/ai/catalog-memory";
import { log } from "@/lib/log";

let redis: RedisEspia;

beforeEach(() => {
  redis = new RedisEspia();
  estado.redis = redis;
  estado.sinRedis = false;
  vi.restoreAllMocks();
});

const pedido: PedidoCatalogo = {
  ultimoQuery: "asiento",
  moto: [["sbr"]],
  cilindrada: [["200"]],
  preguntaHechaPara: "asiento",
};

describe("guardarPedido / leerPedido", () => {
  it("escribe la clave 'catalogo:pedido:<id>' con el JSON del pedido y TTL de 6 horas exactas", async () => {
    await guardarPedido("conv-1", pedido);

    expect(redis.setCalls).toHaveLength(1);
    const llamada = redis.setCalls[0];
    expect(llamada.key).toBe("catalogo:pedido:conv-1");
    expect(JSON.parse(llamada.value)).toEqual(pedido);
    // Seis horas, literal: si alguien cambia el número, este test lo delata.
    expect(CATALOGO_PEDIDO_TTL_SECONDS).toBe(21600);
    expect(llamada.args).toEqual(["EX", 21600]);
  });

  it("lo que se guarda se lee igual", async () => {
    await guardarPedido("conv-1", pedido);
    expect(await leerPedido("conv-1")).toEqual(pedido);
  });

  it("cada conversación tiene su propia clave", async () => {
    await guardarPedido("conv-1", pedido);
    expect(await leerPedido("conv-2")).toBeNull();
  });

  it("sin nada guardado, lee null", async () => {
    expect(await leerPedido("conv-1")).toBeNull();
  });

  it("un JSON corrupto o con otra forma se lee como null, sin lanzar", async () => {
    await redis.set("catalogo:pedido:conv-1", "{no es json");
    expect(await leerPedido("conv-1")).toBeNull();

    await redis.set("catalogo:pedido:conv-1", JSON.stringify({ ultimoQuery: 5 }));
    expect(await leerPedido("conv-1")).toBeNull();
  });
});

describe("Redis caído o sin REDIS_URL: nunca lanza, avisa con log.warn", () => {
  it("leerPedido con Redis caído da null y deja log.warn con el detalle", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    redis.fallaCon = new Error("ECONNREFUSED");

    await expect(leerPedido("conv-1")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "catalogo_pedido_no_legible",
      expect.objectContaining({ conversationId: "conv-1", detail: expect.stringContaining("ECONNREFUSED") })
    );
  });

  it("guardarPedido con Redis caído no lanza y deja log.warn", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    redis.fallaCon = new Error("ECONNREFUSED");

    await expect(guardarPedido("conv-1", pedido)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "catalogo_pedido_no_escrito",
      expect.objectContaining({ conversationId: "conv-1" })
    );
  });

  it("sin REDIS_URL (getRedis lanza) las dos son no-op", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    estado.sinRedis = true;

    await expect(guardarPedido("conv-1", pedido)).resolves.toBeUndefined();
    await expect(leerPedido("conv-1")).resolves.toBeNull();
  });
});
