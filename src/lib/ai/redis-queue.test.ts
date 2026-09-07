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
//   docker run -d --name sbk_redis -p 6379:6379 redis:7-alpine \
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

    expect((await cola.claimDue())?.conversationId).toBe("conv-1");
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

    expect(reclamos.filter((r) => r?.conversationId === "conv-1")).toHaveLength(1);
    expect(reclamos.filter((r) => r === null)).toHaveLength(7);
  });

  it("entrega primero la conversación que lleva más tiempo esperando", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("vieja", -10);
    await cola.enqueue("nueva", 0);

    expect((await cola.claimDue())?.conversationId).toBe("vieja");
  });
});

// ---------------------------------------------------------------------------
// El vencimiento que viaja con el reclamo.
//
// 7/9/2026 ("La respuesta llega en siete segundos", T0): sin esto, un turno
// reintentado por la cola (ritmo al tope, sin cupo, lock, error transitorio)
// perdía su vencimiento ORIGINAL en cada vuelta — el próximo reclamo veía
// solo el score del último reintento, y `colaMs` (agent.ts) medía de menos
// justo el número que el criterio de cierre de la rampa exige mirar.
// ---------------------------------------------------------------------------
describe("el vencimiento que trae el reclamo", () => {
  it("el reclamo devuelve la conversación y su vencimiento", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);
    const antes = Date.now();

    await cola.enqueue("conv-1", 0);
    const reclamo = await cola.claimDue();

    expect(reclamo?.conversationId).toBe("conv-1");
    expect(reclamo?.vencioEn).toBeGreaterThanOrEqual(antes - 250);
    expect(reclamo?.vencioEn).toBeLessThanOrEqual(Date.now() + 250);
  });

  /**
   * No se puede esperar 20 s reales en una prueba: se difiere una vez con un
   * plazo corto y una segunda vez con un score ya vencido, para forzar el
   * reclamo sin dormir. Lo que importa es que el vencimiento que vuelve sea
   * el de la PRIMERA vez que se encoló, no el de ningún diferido intermedio.
   */
  it("un turno diferido conserva el vencimiento original", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);
    const original = Date.now();

    await cola.enqueue("conv-1", 0);
    await cola.defer("conv-1", 20);
    await cola.defer("conv-1", -30); // Vuelve a diferir, pero ya vencido.

    const reclamo = await cola.claimDue();
    expect(reclamo?.vencioEn).toBeGreaterThanOrEqual(original - 250);
    expect(reclamo?.vencioEn).toBeLessThanOrEqual(original + 250);
  });

  it("diferir varias veces conserva el PRIMER vencimiento", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);
    const original = Date.now();

    await cola.enqueue("conv-1", 0);
    await cola.defer("conv-1", 30);
    await cola.defer("conv-1", 20);
    await cola.defer("conv-1", -10);

    const reclamo = await cola.claimDue();
    expect(reclamo?.vencioEn).toBeGreaterThanOrEqual(original - 250);
    expect(reclamo?.vencioEn).toBeLessThanOrEqual(original + 250);
  });

  /**
   * Contraste con los dos de arriba: un mensaje nuevo del cliente SÍ es una
   * ventana nueva, y `enqueue` borra el vencimiento que hubiera quedado de un
   * diferido anterior — a propósito, es la mitad de la distinción con `defer`.
   */
  it("un mensaje nuevo reinicia el vencimiento", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("conv-1", 0);
    await cola.defer("conv-1", 30);
    const antesDelNuevo = Date.now();
    await cola.enqueue("conv-1", 0); // El cliente escribió de nuevo: ventana nueva, ya vencida al reclamar.

    const reclamo = await cola.claimDue();
    expect(reclamo?.vencioEn).toBeGreaterThanOrEqual(antesDelNuevo - 250);
    expect(reclamo?.vencioEn).toBeLessThanOrEqual(antesDelNuevo + 250);
  });

  /**
   * El camino REAL de producción: `queue.ts` no difiere una conversación que
   * nunca se reclamó — difiere una que YA reclamó y no pudo correr (ritmo al
   * tope, sin cupo, lock, error transitorio). En ese momento el `ZREM` de
   * `claimDue` ya sacó la conversación del ZSET, así que el `ZSCORE` de
   * `defer` no encuentra nada que preservar: quien sostiene el vencimiento
   * original a través de este reintento es el PRIMER `claimDue`, que lo
   * siembra en `liminal:agent:vencimiento:{id}` antes de que nada se difiera.
   */
  it("el reintento tras un reclamo conserva el vencimiento del primer reclamo", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("conv-1", 0);
    const primero = await cola.claimDue();
    await cola.defer("conv-1", -1); // Ya vencido, sin esperar.
    const segundo = await cola.claimDue();

    expect(segundo?.vencioEn).toBe(primero?.vencioEn);
  });

  /**
   * Un turno que SÍ corre (no vuelve a diferirse) no puede dejar la clave de
   * vencimiento puesta para siempre: el segundo reclamo, al encontrarla, la
   * BORRA (no la vuelve a sembrar) — así un tercer reclamo de esta misma
   * conversación, si algún día lo hubiera, no hereda un vencimiento de dos
   * vueltas atrás. Si esa conversación necesitara encolarse de nuevo, entra
   * por `enqueue` (mensaje nuevo del cliente) o por otro `defer`, y los dos
   * caminos parten de cero: `enqueue` la borra explícitamente, y `defer` solo
   * la siembra cuando encuentra algo en el ZSET (no la hay, recién se limpió).
   */
  it("tras el segundo reclamo la clave de vencimiento queda limpia", async () => {
    if (!disponible) return;
    const cola = createAgentQueue(redis);

    await cola.enqueue("conv-1", 0);
    await cola.claimDue();
    await cola.defer("conv-1", -1);
    await cola.claimDue();

    expect(await redis.get("liminal:agent:vencimiento:conv-1")).toBeNull();
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
