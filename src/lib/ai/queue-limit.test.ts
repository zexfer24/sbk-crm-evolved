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

// El segundo argumento (`{ vencioEn }`, T0 "La respuesta llega en siete
// segundos", 7/9/2026) se captura para el describe de más abajo; el resto de
// este archivo lo ignora, igual que antes.
const runAgentTurnMock = vi.fn(async (id: string, opts?: { vencioEn?: number }) => {
  void id;
  void opts;
});
vi.mock("@/lib/ai/agent", () => ({
  runAgentTurn: (id: string, opts?: { vencioEn?: number }) => runAgentTurnMock(id, opts),
}));

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
  delete process.env.AGENT_QUEUE_MAX_PER_RUN;
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

  /** Sin límite explícito, la pasada del cron drena hasta su tope por pasada. */
  it("el cron sigue drenando hasta su tope por pasada", async () => {
    process.env.AGENT_QUEUE_MAX_PER_RUN = "10";
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    await enqueueAgentTurns(ids, { debounceSeconds: 0 });

    await processQueuedTurns();

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

describe("tope por pasada sale del entorno", () => {
  /**
   * 7/9/2026: MAX_PER_RUN era una constante fija en diez. Con la cola
   * destopada (ver queue.ts) el tope por pasada tiene que poder subirse en la
   * rampa sin recompilar, igual que maxTurnsPerMinute.
   */
  it("respeta AGENT_QUEUE_MAX_PER_RUN sin límite explícito", async () => {
    process.env.AGENT_QUEUE_MAX_PER_RUN = "3";
    const ids = Array.from({ length: 5 }, (_, i) => `c${i}`);
    await enqueueAgentTurns(ids, { debounceSeconds: 0 });

    await processQueuedTurns();

    expect(runAgentTurnMock).toHaveBeenCalledTimes(3);
    expect(await pendingAgentTurns()).toBe(2);
  });

  /** Basura en la variable no puede tirar la cola con un NaN: cae al default. */
  it("con basura en la variable cae al default de treinta", async () => {
    process.env.AGENT_QUEUE_MAX_PER_RUN = "muchos";
    const ids = Array.from({ length: 32 }, (_, i) => `c${i}`);
    await enqueueAgentTurns(ids, { debounceSeconds: 0 });

    await processQueuedTurns();

    expect(runAgentTurnMock).toHaveBeenCalledTimes(30);
    expect(await pendingAgentTurns()).toBe(2);
  });

  /** Cero tampoco es un tope válido: mismo camino que la basura, al default. */
  it("con cero en la variable cae al default de treinta", async () => {
    process.env.AGENT_QUEUE_MAX_PER_RUN = "0";
    const ids = Array.from({ length: 32 }, (_, i) => `c${i}`);
    await enqueueAgentTurns(ids, { debounceSeconds: 0 });

    await processQueuedTurns();

    expect(runAgentTurnMock).toHaveBeenCalledTimes(30);
    expect(await pendingAgentTurns()).toBe(2);
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

  /**
   * 7/9/2026: con el default viejo de cuatro por minuto, una pasada normal
   * devolvía turnos a la cola (`deferred`) apenas pasaba de cuatro
   * conversaciones — el síntoma (`cola_ritmo_al_tope`) detrás de la espera de
   * hasta hora y media medida en producción. Con el ritmo destopado (default
   * treinta, y acá directamente sin variable) una tanda chica no debería
   * tocar ese camino.
   */
  it("con ritmo destopado una pasada no deja deferred", async () => {
    delete process.env.AGENT_MAX_TURNS_PER_MINUTE;

    const ids = Array.from({ length: 8 }, (_, i) => `c${i}`);
    await enqueueAgentTurns(ids, { debounceSeconds: 0 });

    const resultado = await processQueuedTurns();

    expect(resultado.deferred).toBe(0);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(8);
    expect(await pendingAgentTurns()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// El vencimiento que viaja del reclamo al turno.
//
// 7/9/2026 ("La respuesta llega en siete segundos", T0): sin esto, un turno
// que la cola tuvo que reintentar (acá, por el tope de ritmo) le llegaba a
// `runAgentTurn` con el vencimiento del ÚLTIMO reintento, no el del primer
// reclamo — y `colaMs` (agent.ts) hubiera medido de menos justo lo que el
// criterio de cierre de la rampa exige medir bien.
// ---------------------------------------------------------------------------
describe("vencimiento que llega al turno", () => {
  it("el turno recibe el vencimiento con que se reclamó", async () => {
    const antes = Date.now();

    await enqueueAgentTurns(["c1"], { debounceSeconds: 0 });
    await processQueuedTurns(1);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    const [, opts] = runAgentTurnMock.mock.calls[0];
    expect(opts?.vencioEn).toBeGreaterThanOrEqual(antes - 300);
    expect(opts?.vencioEn).toBeLessThanOrEqual(Date.now() + 300);
  });

  it("un turno diferido por ritmo conserva su vencimiento original", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "1";
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      // No importa cuál de las dos se lleve el único cupo del minuto y cuál
      // se difiera: lo que importa es que, cuando le toque su turno, cada
      // una llegue con SU PROPIO vencimiento original, no con el del
      // reintento.
      const enqueuedAt: Record<string, number> = { c1: Date.now() };
      await enqueueAgentTurns(["c1"], { debounceSeconds: 0 });
      enqueuedAt.c2 = Date.now();
      await enqueueAgentTurns(["c2"], { debounceSeconds: 0 });

      // Una se lleva el único cupo de ritmo del minuto; la otra se difiere.
      await processQueuedTurns(2);
      expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
      expect(await pendingAgentTurns()).toBe(1);
      const yaCorrida = runAgentTurnMock.mock.calls[0][0];
      const diferida = yaCorrida === "c1" ? "c2" : "c1";

      // Se adelanta el reloj más allá del reintento (RETRY_WHEN_PACED_SECONDS
      // = 20s) y se destopa el ritmo, para que el segundo reclamo no vuelva
      // a diferirse por el mismo motivo.
      vi.setSystemTime(t0 + 25_000);
      delete process.env.AGENT_MAX_TURNS_PER_MINUTE;

      await processQueuedTurns(2);

      expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
      const llamadaDiferida = runAgentTurnMock.mock.calls.find(([id]) => id === diferida);
      const original = enqueuedAt[diferida];
      expect(llamadaDiferida?.[1]?.vencioEn).toBeGreaterThanOrEqual(original - 300);
      expect(llamadaDiferida?.[1]?.vencioEn).toBeLessThanOrEqual(original + 300);
    } finally {
      vi.useRealTimers();
      process.env.AGENT_MAX_TURNS_PER_MINUTE = "1000";
    }
  });
});
