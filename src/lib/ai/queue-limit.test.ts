import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "@/lib/ai/fake-redis";

// ---------------------------------------------------------------------------
// El reparto del presupuesto de una pasada, que es JavaScript puro.
//
// Los otros archivos de la cola corren contra un Redis de verdad y se saltan
// enteros donde no lo hay. Eso dejó pasar la carrera del `limit`: los
// trabajadores decidían si quedaba sitio mirando los contadores de `result`,
// que sólo suben DESPUÉS del turno, así que con limit=1 los tres veían
// "0 < 1", los tres reclamaban y los tres arrancaban. El techo real era
// maxConcurrentTurns, no limit.
//
// Importa porque de ese límite depende que un mensaje entrante de WhatsApp no
// drene el atraso de otros. Ver processAfterDebounce.
//
// Acá el Redis es un doble en memoria (ver fake-redis.ts): alcanza para lo que
// se prueba, que es cómo se reparten los trabajadores, y hace que esto corra
// en cualquier máquina en vez de saltarse en silencio.
// ---------------------------------------------------------------------------

const redis = new FakeRedis();
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

const runAgentTurnMock = vi.fn(async (id: string) => {
  void id;
});
vi.mock("@/lib/ai/agent", () => ({ runAgentTurn: (id: string) => runAgentTurnMock(id) }));

import { enqueueAgentTurns, pendingAgentTurns, processQueuedTurns } from "@/lib/ai/queue";

beforeEach(async () => {
  await redis.del("liminal:agent:turns");
  await redis.del("liminal:agent:slots");
  await redis.del("liminal:agent:ritmo");
  runAgentTurnMock.mockReset();
  runAgentTurnMock.mockImplementation(async () => {});
  // Tres trabajadores contra un presupuesto de uno: es la forma que tenía la
  // carrera. Y el ritmo alto para no confundir un freno con el otro.
  process.env.AGENT_MAX_CONCURRENT_TURNS = "3";
  process.env.AGENT_MAX_TURNS_PER_MINUTE = "1000";
});

afterEach(() => {
  delete process.env.AGENT_MAX_CONCURRENT_TURNS;
  delete process.env.AGENT_MAX_TURNS_PER_MINUTE;
});

describe("presupuesto de una pasada", () => {
  /**
   * El caso exacto que falló: limit=1 con tres trabajadores y turnos que
   * tardan. Antes entraban los tres antes de que ninguno terminara.
   */
  it("con límite de uno, corre uno solo aunque haya tres trabajadores", async () => {
    let simultaneos = 0;
    let pico = 0;
    runAgentTurnMock.mockImplementation(async () => {
      simultaneos++;
      pico = Math.max(pico, simultaneos);
      await new Promise((r) => setTimeout(r, 25));
      simultaneos--;
    });

    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5"], { debounceSeconds: 0 });

    const resultado = await processQueuedTurns(1);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(pico).toBe(1);
    expect(resultado.processed).toBe(1);
    // Los otros cuatro siguen en la cola: ni se reclamaron ni se tiraron.
    expect(await pendingAgentTurns()).toBe(4);
  });

  it("respeta un límite intermedio", async () => {
    runAgentTurnMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

    await processQueuedTurns(2);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(await pendingAgentTurns()).toBe(4);
  });

  /**
   * El webhook le pasa el tamaño de SU lote. Un mensaje entrante puede
   * provocar un turno, no diez: es la mitad del arreglo de la causa 2 del
   * incidente del 26 de agosto de 2026 —la otra mitad es que `limit` se
   * respete de verdad, que es lo que prueban los dos casos de arriba.
   */
  it("un mensaje entrante no arrastra el atraso de los demás", async () => {
    // El atraso: nueve conversaciones esperando.
    await enqueueAgentTurns(["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"], { debounceSeconds: 0 });

    // Entra UN mensaje de un cliente. El webhook drena su propio lote.
    await processQueuedTurns(1);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(await pendingAgentTurns()).toBe(8);
  });

  /** Sin límite, la pasada del cron sí drena su tanda entera. */
  it("el cron sigue drenando hasta su tope por pasada", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    await enqueueAgentTurns(ids, { debounceSeconds: 0 });

    await processQueuedTurns();

    // MAX_PER_RUN es diez.
    expect(runAgentTurnMock).toHaveBeenCalledTimes(10);
    expect(await pendingAgentTurns()).toBe(2);
  });

  /** La cola vacía no consume presupuesto ni deja trabajadores colgados. */
  it("no rompe con la cola vacía", async () => {
    const resultado = await processQueuedTurns(5);

    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(resultado).toEqual({ processed: 0, failed: 0, deferred: 0 });
  });
});

describe("tope de turnos por minuto", () => {
  /**
   * El otro freno, y hay que comprobar que no comparte la carrera del `limit`.
   *
   * No la comparte, y por un motivo estructural: el presupuesto del minuto se
   * decide DENTRO de Redis, en un script que limpia, cuenta y añade de una
   * sola pieza. No hay un contador de JavaScript que dos trabajadores puedan
   * leer antes de que ninguno escriba.
   */
  it("no deja salir más turnos por minuto que el tope", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "2";

    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

    await processQueuedTurns();

    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
  });

  /** Y es de todo el sistema, no de cada pasada. */
  it("el tope es compartido entre pasadas simultáneas", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "2";

    await enqueueAgentTurns(["c1", "c2", "c3", "c4", "c5", "c6"], { debounceSeconds: 0 });

    await Promise.all([processQueuedTurns(), processQueuedTurns(), processQueuedTurns()]);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
  });
});
