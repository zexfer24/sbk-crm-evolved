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
  // Alto por defecto para que el tope por minuto no interfiera con las
  // pruebas que miden otra cosa; el suyo lo baja a mano.
  process.env.AGENT_MAX_TURNS_PER_MINUTE = "100";
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

describe("tope de turnos por minuto", () => {
  /**
   * El freno que faltaba el 26 de agosto de 2026.
   *
   * Ese día salieron ocho mensajes en el minuto de las 16:35 con
   * AGENT_MAX_CONCURRENT_TURNS en 3, y ningún tope se pasó: los cupos limitan
   * turnos SIMULTÁNEOS, y con turnos de siete segundos caben veinticinco en
   * un minuto. Contar mensajes por minuto es lo único que acota cuánto sale
   * mientras alguien se da cuenta y apaga el interruptor.
   */
  it("no deja salir más turnos por minuto que el tope, y devuelve el resto a la cola", async () => {
    if (!disponible) return;
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "3";
    try {
      await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

      const resultado = await processQueuedTurns();

      expect(runAgentTurnMock).toHaveBeenCalledTimes(3);
      expect(resultado.processed).toBe(3);
      // Lo que no salió no se pierde: vuelve a la cola para el minuto próximo.
      expect(resultado.deferred).toBeGreaterThan(0);
      expect(await pendingAgentTurns()).toBeGreaterThan(0);
    } finally {
      process.env.AGENT_MAX_TURNS_PER_MINUTE = "100";
    }
  });

  /**
   * El tope es de TODO el sistema, no de cada pasada: si fuera por pasada,
   * cada webhook entrante traería su propio presupuesto y no frenaría nada,
   * que es justo lo que pasó con el drenado.
   */
  it("el tope es compartido entre pasadas simultáneas", async () => {
    if (!disponible) return;
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "2";
    try {
      await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

      await Promise.all([processQueuedTurns(), processQueuedTurns(), processQueuedTurns()]);

      expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
    } finally {
      process.env.AGENT_MAX_TURNS_PER_MINUTE = "100";
    }
  });
});

describe("processAfterDebounce", () => {
  /**
   * La causa 2 del incidente: esto corría con el MAX_PER_RUN de diez sobre la
   * cola COMPARTIDA, así que cada mensaje entrante de WhatsApp drenaba hasta
   * diez turnos del atraso. En cuatro minutos entraron veintisiete mensajes y
   * salieron veinticuatro respuestas: el ritmo lo puso el tráfico entrante, no
   * el cron que el comentario del barrido decía que lo ponía.
   */
  it("drena como mucho el límite que le pasa el webhook", async () => {
    if (!disponible) return;
    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5"], { debounceSeconds: 0 });

    // El webhook le pasa el tamaño de SU lote: un mensaje entrante, un turno.
    const resultado = await processQueuedTurns(1);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(resultado.processed).toBe(1);
    expect(await pendingAgentTurns()).toBe(4);
  });

  /**
   * `limit` era una sugerencia con una carrera dentro.
   *
   * Los trabajadores decidían si quedaba sitio mirando los contadores de
   * `result`, que sólo suben DESPUÉS del turno. Con limit=1 los tres veían
   * "0 < 1", los tres reclamaban y los tres arrancaban: el techo real era
   * maxConcurrentTurns, no limit. Y de ese límite depende que un mensaje
   * entrante no drene el atraso de otros.
   *
   * Con turnos lentos la ventana de la carrera se abre del todo: sin la
   * reserva previa, los tres entran antes de que ninguno termine.
   */
  it("respeta el límite aunque los turnos tarden y los trabajadores se solapen", async () => {
    if (!disponible) return;

    let simultaneos = 0;
    let pico = 0;
    runAgentTurnMock.mockImplementation(async () => {
      simultaneos++;
      pico = Math.max(pico, simultaneos);
      await new Promise((r) => setTimeout(r, 40));
      simultaneos--;
    });

    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

    const resultado = await processQueuedTurns(1);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(pico).toBe(1);
    expect(resultado.processed).toBe(1);
    // Los otros cinco siguen esperando: no se reclamaron y se tiraron.
    expect(await pendingAgentTurns()).toBe(5);
  });

  /** Un límite de dos con tres trabajadores: dos, ni uno más. */
  it("no se pasa del límite con más trabajadores que presupuesto", async () => {
    if (!disponible) return;
    runAgentTurnMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

    await processQueuedTurns(2);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(await pendingAgentTurns()).toBe(4);
  });
});
