import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { createAgentQueue, createTurnSlots } from "@/lib/ai/redis-queue";

// ---------------------------------------------------------------------------
// Pruebas contra un Redis de verdad.
//
// La cola se apoya en la atomicidad de Redis para que dos procesos no
// atiendan la misma conversación. Un doble falso en memoria no prueba eso:
// probaría el doble. Sin REDIS_URL en el entorno, se saltan.
//
//   docker run -d --name liminal_redis -p 6379:6379 redis:7-alpine \
//     redis-server --appendonly yes
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const REDIS_DB = 1;

let redis: Redis;
let disponible = false;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, db: REDIS_DB });
  try {
    await redis.connect();
    await redis.ping();
    disponible = true;
  } catch {
    disponible = false;
  }
});

afterEach(async () => {
  if (disponible) await redis.flushdb();
});

afterAll(async () => {
  if (redis) await redis.quit();
});

describe("cola de turnos en Redis", () => {
  it("no entrega un turno antes de que venza su ventana de silencio", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("conv-1", 30);

    expect(await cola.claimDue()).toBeNull();
    expect(await cola.pending()).toBe(1);
  });

  it("entrega el turno una vez vencida la ventana", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("conv-1", 0);

    expect(await cola.claimDue()).toBe("conv-1");
  });

  /**
   * Es la razón de ser del debounce: mientras el cliente sigue escribiendo,
   * el turno no debe dispararse. Cada mensaje nuevo corre la ventana.
   */
  it("un mensaje nuevo corre la ventana hacia adelante", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("conv-1", 0);
    await cola.enqueue("conv-1", 30);

    expect(await cola.claimDue()).toBeNull();
    expect(await cola.pending()).toBe(1);
  });

  it("encolar la misma conversación dos veces deja un solo turno pendiente", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("conv-1", 0);
    await cola.enqueue("conv-1", 0);

    expect(await cola.pending()).toBe(1);
  });

  /**
   * El punto crítico: si dos instancias del contenedor reclaman a la vez,
   * una sola puede quedarse con la conversación. Lo contrario son dos
   * respuestas al mismo cliente.
   */
  it("solo un reclamo se lleva la conversación aunque compitan varios", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);
    await cola.enqueue("conv-1", 0);

    const reclamos = await Promise.all(
      Array.from({ length: 8 }, () => cola.claimDue())
    );

    expect(reclamos.filter((r) => r === "conv-1")).toHaveLength(1);
    expect(reclamos.filter((r) => r === null)).toHaveLength(7);
  });

  it("entrega primero la conversación que lleva más tiempo esperando", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("vieja", -10);
    await cola.enqueue("nueva", 0);

    expect(await cola.claimDue()).toBe("vieja");
  });
});

describe("cupos de turnos simultáneos", () => {
  it("no entrega más cupos que el máximo configurado", async () => {
    if (!disponible) return;
    const cupos = createTurnSlots(redis, { max: 3 });

    const otorgados = await Promise.all(
      Array.from({ length: 6 }, () => cupos.acquire())
    );

    expect(otorgados.filter((c) => c !== null)).toHaveLength(3);
    expect(otorgados.filter((c) => c === null)).toHaveLength(3);
  });

  it("devuelve el cupo al liberarlo", async () => {
    if (!disponible) return;
    const cupos = createTurnSlots(redis, { max: 1 });

    const primero = await cupos.acquire();
    expect(primero).not.toBeNull();
    expect(await cupos.acquire()).toBeNull();

    await cupos.release(primero!);

    expect(await cupos.acquire()).not.toBeNull();
  });

  /**
   * Si un contenedor muere a mitad de un turno, su cupo no puede quedar
   * tomado para siempre: sin esto, un par de reinicios desafortunados dejan
   * al agente sin poder atender a nadie.
   */
  it("recupera los cupos de un proceso que murió sin liberarlos", async () => {
    if (!disponible) return;
    const cupos = createTurnSlots(redis, { max: 1, leaseSeconds: -1 });

    await cupos.acquire();

    // El cupo anterior ya venció, así que el siguiente debe poder tomarlo.
    expect(await cupos.acquire()).not.toBeNull();
  });
});

describe("reintentos de un turno que falla", () => {
  /**
   * Un turno que falla se reintenta, pero no para siempre: una conversación
   * que rompe en cada intento se quedaría reclamando cupos eternamente y
   * empujando a las demás hacia atrás.
   */
  it("cuenta los intentos fallidos de cada conversación", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    expect(await cola.recordFailure("conv-1")).toBe(1);
    expect(await cola.recordFailure("conv-1")).toBe(2);
    expect(await cola.recordFailure("conv-2")).toBe(1);
  });

  it("olvida los intentos cuando la conversación se atiende bien", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.recordFailure("conv-1");
    await cola.clearFailures("conv-1");

    expect(await cola.recordFailure("conv-1")).toBe(1);
  });
});
