import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// La cola corre contra un Redis real; lo único que se sustituye es el turno
// del agente (que llamaría al modelo) y el cliente de la base.
// ---------------------------------------------------------------------------

// Base propia: los archivos de prueba corren en paralelo y cada uno hace
// flushdb, así que compartir base los hace pisarse entre sí.
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const REDIS_DB = 2;

let redis: Redis;
let disponible = false;

const runAgentTurnMock = vi.fn(async (id: string) => {
  void id;
});
vi.mock("@/lib/ai/agent", () => ({ runAgentTurn: (id: string) => runAgentTurnMock(id) }));
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

import {
  DEBOUNCE_SECONDS,
  enqueueAgentTurns,
  pendingAgentTurns,
  processQueuedTurns,
} from "@/lib/ai/queue";

beforeAll(async () => {
  // Tope bajo a propósito: hace visible el límite sin alargar la prueba.
  process.env.AGENT_MAX_CONCURRENT_TURNS = "2";
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
  runAgentTurnMock.mockReset();
  runAgentTurnMock.mockImplementation(async () => {});
  if (disponible) await redis.flushdb();
});

afterAll(async () => {
  if (redis) await redis.quit();
});

describe("enqueueAgentTurns", () => {
  it("deja un solo turno por conversación aunque el lote traiga varios mensajes", async () => {
    if (!disponible) return;

    await enqueueAgentTurns(["conv-1", "conv-1", "conv-2", "conv-1"]);

    expect(await pendingAgentTurns()).toBe(2);
  });

  /**
   * Sin ventana, un cliente que escribe en ráfaga recibe una respuesta por
   * frase, cada una sin el contexto de las siguientes.
   */
  it("no entrega el turno antes de que venza la ventana de silencio", async () => {
    if (!disponible) return;

    await enqueueAgentTurns(["conv-1"]);
    const resultado = await processQueuedTurns();

    expect(DEBOUNCE_SECONDS).toBeGreaterThan(0);
    expect(resultado.processed).toBe(0);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });
});

describe("processQueuedTurns", () => {
  it("atiende los turnos cuya ventana ya venció", async () => {
    if (!disponible) return;
    await enqueueAgentTurns(["conv-1", "conv-2"], { debounceSeconds: 0 });

    const resultado = await processQueuedTurns();

    expect(resultado.processed).toBe(2);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
  });

  /**
   * El tope de turnos simultáneos es lo que evita que un pico de mensajes
   * dispare decenas de llamadas al modelo a la vez: el proveedor responde
   * con rate limit y los turnos empiezan a fallar en cadena.
   *
   * Lo que no entra ahora no se pierde: vuelve a la cola para el próximo
   * intento.
   */
  it("no arranca más turnos simultáneos que el tope, y devuelve el resto a la cola", async () => {
    if (!disponible) return;

    let simultaneos = 0;
    let pico = 0;
    runAgentTurnMock.mockImplementation(async () => {
      simultaneos++;
      pico = Math.max(pico, simultaneos);
      await new Promise((r) => setTimeout(r, 30));
      simultaneos--;
    });

    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

    // Varias pasadas a la vez, como cuando llegan varios webhooks seguidos.
    const pasadas = await Promise.all([
      processQueuedTurns(),
      processQueuedTurns(),
      processQueuedTurns(),
    ]);

    expect(pico).toBeLessThanOrEqual(2);
    const atendidos = pasadas.reduce((total, p) => total + p.processed, 0);
    const devueltos = pasadas.reduce((total, p) => total + p.deferred, 0);
    expect(atendidos + devueltos).toBeGreaterThanOrEqual(6);
  });

  /** Un turno que falla vuelve a la cola en vez de perderse. */
  it("devuelve a la cola el turno que falló", async () => {
    if (!disponible) return;
    runAgentTurnMock.mockImplementation(async () => {
      throw new Error("el modelo no respondió");
    });

    await enqueueAgentTurns(["conv-1"], { debounceSeconds: 0 });
    const resultado = await processQueuedTurns();

    expect(resultado.failed).toBe(1);
    expect(await pendingAgentTurns()).toBe(1);
  });

  /**
   * Pero no para siempre: una conversación que rompe en cada intento se
   * quedaría reclamando cupos y empujando al resto hacia atrás.
   */
  it("abandona la conversación que falla una y otra vez", async () => {
    if (!disponible) return;
    runAgentTurnMock.mockImplementation(async () => {
      throw new Error("el modelo no respondió");
    });

    for (let intento = 0; intento < 5; intento++) {
      await enqueueAgentTurns(["conv-1"], { debounceSeconds: 0 });
      await processQueuedTurns();
    }

    expect(await pendingAgentTurns()).toBe(0);
  });

  it("no deja cupos tomados después de un turno que falló", async () => {
    if (!disponible) return;
    runAgentTurnMock.mockImplementationOnce(async () => {
      throw new Error("el modelo no respondió");
    });

    await enqueueAgentTurns(["conv-1"], { debounceSeconds: 0 });
    await processQueuedTurns();

    await enqueueAgentTurns(["conv-2"], { debounceSeconds: 0 });
    const segunda = await processQueuedTurns();

    expect(segunda.processed).toBe(1);
  });
});
