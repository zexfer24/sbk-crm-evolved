import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "@/lib/ai/fake-redis";

// ---------------------------------------------------------------------------
// T3 ("La respuesta llega en siete segundos", 7/9/2026): que un turno frenado
// no dependa del cron.
//
// Hasta acá, cuando una pasada diferia un turno (ritmo al tope, sin cupo,
// lock tomado), el worker se retiraba y nadie lo despertaba: el turno volvía
// a la cola y solo lo reclamaban el próximo webhook (que drena como mucho lo
// que él mismo encoló, a propósito, desde el 26/8/2026) o el cron —cada 5
// min con tope 10 hasta el 7/9/2026, o sea hasta 5 min de espera para un
// turno frenado 20 s por ritmo. Esta suite prueba la continuación que
// `queue.ts` programa sola en ese caso.
//
// Redis es el doble en memoria (fake-redis.ts): esto no depende de que haya
// un Redis real levantado, a diferencia de queue.test.ts. El reloj es falso
// (`vi.useFakeTimers()`) porque la continuación se prueba haciendo avanzar el
// tiempo sin esperar de verdad los 3-30 s reales que tardaría.
// ---------------------------------------------------------------------------

const redis = new FakeRedis();
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

/**
 * Deja avanzar el microtask queue sin tocar el reloj falso.
 *
 * `claimDue → tryConsume → acquire → runAgentTurn → clearFailures →
 * release` son varios `await` encadenados (cada uno, aunque no haga I/O de
 * verdad, es una función `async` y por lo tanto una vuelta más del
 * microtask queue). Un par de `await Promise.resolve()` sueltos alcanzaban a
 * veces y otras no —dependía de cuántos pasos quedaban por delante en la
 * cadena real—, así que esto sencillamente da bastantes vueltas de sobra:
 * de más no rompe nada, de menos deja una prueba en una carrera contra su
 * propia async.
 */
async function flushMicrotasks(vueltas = 30): Promise<void> {
  for (let i = 0; i < vueltas; i++) {
    await Promise.resolve();
  }
}

const runAgentTurnMock = vi.fn(async (id: string, opts?: { vencioEn?: number }) => {
  void id;
  void opts;
});
vi.mock("@/lib/ai/agent", () => ({
  runAgentTurn: (id: string, opts?: { vencioEn?: number }) => runAgentTurnMock(id, opts),
}));

// Mismo motivo que queue.test.ts: sustituye el módulo entero (sin
// `importOriginal`) porque el real arrastra `@/lib/supabase/admin`, que sin
// las variables de Supabase en el entorno construye un cliente que lanza. El
// camino de error de esta suite no llega a MAX_ATTEMPTS, pero se deja el
// mock en espejo por si algún caso lo empuja hasta ahí sin querer.
const recordHandoffAdminMock = vi.fn(async (input: unknown) => {
  void input;
  return true;
});
vi.mock("@/lib/ai/handoffs", () => ({
  recordHandoffAdmin: (input: unknown) => recordHandoffAdminMock(input),
}));

import {
  enqueueAgentTurns,
  pendingAgentTurns,
  processQueuedTurns,
  resetContinuacionParaPruebas,
  stopAgentQueue,
} from "@/lib/ai/queue";
import { log } from "@/lib/log";

beforeEach(async () => {
  await redis.del("liminal:agent:turns");
  await redis.del("liminal:agent:slots");
  await redis.del("liminal:agent:ritmo");
  runAgentTurnMock.mockReset();
  runAgentTurnMock.mockImplementation(async () => {});
  recordHandoffAdminMock.mockClear();
  // Generosos por defecto: cada prueba topa a mano el freno que le interesa
  // medir, para no confundir uno con el otro.
  process.env.AGENT_MAX_CONCURRENT_TURNS = "8";
  process.env.AGENT_MAX_TURNS_PER_MINUTE = "1000";
  delete process.env.AGENT_QUEUE_MAX_PER_RUN;
  // `shouldAdvanceTime: false`: el reloj SOLO avanza cuando la prueba lo pide
  // con `advanceTimersByTimeAsync`, nunca solo. Necesario para poder afirmar
  // "vi.getTimerCount() === 1" sin que un tick de fondo lo haya disparado ya.
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(async () => {
  // Antes de volver a timers reales: si quedó una continuación programada
  // (o "corriendo"), se cancela. Sin esto, un timer de una prueba que falló
  // a mitad de camino podría disparar en la prueba siguiente, ya con
  // timers reales y mocks reseteados.
  resetContinuacionParaPruebas();
  vi.useRealTimers();
  delete process.env.AGENT_MAX_CONCURRENT_TURNS;
  delete process.env.AGENT_MAX_TURNS_PER_MINUTE;
  delete process.env.AGENT_QUEUE_MAX_PER_RUN;
});

describe("continuación de la cola: programa exactamente una", () => {
  it("una pasada con diferidos programa exactamente una continuación", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "1";

    await enqueueAgentTurns(["c1", "c2", "c3"], { debounceSeconds: 0 });
    const resultado = await processQueuedTurns();

    // Uno se lleva el único cupo de ritmo del minuto; los otros dos se
    // difieren por RETRY_WHEN_PACED_SECONDS (20s).
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(resultado.deferred).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("sin diferidos no programa ninguna", async () => {
    // Ritmo y cupos generosos (los del beforeEach): las tres entran sin
    // toparse con ningún freno.
    await enqueueAgentTurns(["c1", "c2", "c3"], { debounceSeconds: 0 });
    const resultado = await processQueuedTurns();

    expect(resultado.deferred).toBe(0);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dos pasadas con diferidos comparten una sola continuación", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "1";

    await enqueueAgentTurns(["c1", "c2"], { debounceSeconds: 0 });
    await processQueuedTurns(); // deja uno diferido, programa la continuación.

    await enqueueAgentTurns(["c3", "c4"], { debounceSeconds: 0 });
    await processQueuedTurns(); // el ritmo del minuto sigue gastado: vuelve a diferir.

    // Sigue habiendo UN solo timer, no dos: la segunda pasada encontró la
    // continuación ya "programada" y se quedó callada.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stopAgentQueue cancela la continuación pendiente", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "1";

    await enqueueAgentTurns(["c1", "c2"], { debounceSeconds: 0 });
    await processQueuedTurns();
    expect(vi.getTimerCount()).toBe(1);

    await stopAgentQueue();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("un turno con error no programa continuación", async () => {
    runAgentTurnMock.mockImplementation(async () => {
      throw new Error("el modelo no respondió");
    });

    await enqueueAgentTurns(["c1"], { debounceSeconds: 0 });
    const resultado = await processQueuedTurns();

    // Se reintenta (RETRY_AFTER_ERROR_SECONDS), pero ese plazo no cuenta para
    // la continuación: reintentar un error en caliente tiende a pegarle al
    // mismo muro, y ya lo cubre el cron a los 60 s.
    expect(resultado.failed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("elige el menor plazo", async () => {
    // Un solo cupo global (maxConcurrentTurns alimenta tanto el número de
    // trabajadores por pasada como el tope de cupos, ver queue.ts): dos
    // pasadas SEPARADAS compitiendo por ese único cupo es lo que reproduce
    // "sin cupo", igual que "no arranca más turnos simultáneos que el tope"
    // en queue.test.ts. Con una sola pasada y un solo trabajador esto no se
    // puede provocar: no hay nadie más pidiendo cupo al mismo tiempo.
    process.env.AGENT_MAX_CONCURRENT_TURNS = "1";
    const infoSpy = vi.spyOn(log, "info");
    infoSpy.mockClear();

    // c1 se lleva el único cupo y se queda colgado con él. Envuelto en un
    // objeto (no un `let` suelto): TypeScript, al analizar el flujo de
    // control de una variable capturada y reasignada solo DENTRO del
    // ejecutor de la promesa, la termina angostando a `never` en la lectura
    // de más abajo -un objeto evita esa angostura porque la propiedad no
    // participa del análisis de flujo de la variable en sí.
    const liberar: { fn: (() => void) | null } = { fn: null };
    runAgentTurnMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          liberar.fn = resolve;
        })
    );

    await enqueueAgentTurns(["c1"], { debounceSeconds: 0 });
    const pasada1 = processQueuedTurns();
    // Deja que pasada1 reclame c1, pida su cupo y quede colgada de
    // `runAgentTurn`, antes de que exista una segunda pasada.
    await flushMicrotasks();

    await enqueueAgentTurns(["c2"], { debounceSeconds: 0 });
    const resultado2 = await processQueuedTurns();

    // c2 se difirió por falta de CUPO (RETRY_WHEN_BUSY_SECONDS = 3s) — el
    // ritmo (RETRY_WHEN_PACED_SECONDS = 20s) es generoso en esta prueba y no
    // participa: el menor plazo tiene que ganar, y acá el único plazo en
    // juego para c2 es el de cupo.
    expect(resultado2.deferred).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith("cola_continuacion_programada", {
      enSegundos: 3,
      diferidos: 1,
    });

    liberar.fn?.();
    await pasada1;
  });

  it("tras avanzar lo suficiente, la continuación atiende el turno diferido", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "1";

    await enqueueAgentTurns(["c1", "c2"], { debounceSeconds: 0 });
    await processQueuedTurns();
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(await pendingAgentTurns()).toBe(1);

    // El ritmo de FakeRedis mide con Date.now(), que sí avanza con
    // vi.advanceTimersByTimeAsync: la ventana de un minuto libera sola. Se
    // avanza bastante más de 60s para darle margen a la cadena de
    // continuaciones que se van reprogramando cada ~20s mientras el minuto
    // no cierra.
    await vi.advanceTimersByTimeAsync(65_000);

    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(await pendingAgentTurns()).toBe(0);
  });
});

describe("continuación de la cola: no se solapa", () => {
  it("la continuación no se solapa con otra en curso", async () => {
    process.env.AGENT_MAX_CONCURRENT_TURNS = "1";
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "1";

    // c1 se lleva el único cupo Y el único turno del minuto (se resuelve de
    // inmediato con el mock por defecto); c2 se difiere por ritmo y programa
    // la continuación.
    await enqueueAgentTurns(["c1", "c2"], { debounceSeconds: 0 });
    await processQueuedTurns();
    expect(vi.getTimerCount()).toBe(1);

    // A partir de acá runAgentTurn se cuelga: es lo que va a encontrar la
    // continuación al reclamar c2. Ritmo generoso para que la única traba
    // que quede sea el cupo (así el "otra pasada" de abajo se difiere por
    // CUPO, no por ritmo, mientras la continuación lo tiene tomado).
    delete process.env.AGENT_MAX_TURNS_PER_MINUTE;
    // Objeto, no `let` suelto: mismo motivo que en "elige el menor plazo"
    // (TypeScript angosta la variable a `never` en la lectura si es un `let`
    // reasignado solo dentro del ejecutor de la promesa).
    const liberarContinuacion: { fn: (() => void) | null } = { fn: null };
    runAgentTurnMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          liberarContinuacion.fn = resolve;
        })
    );

    // Dispara el timer: la continuación arranca, reclama c2 y toma el único
    // cupo. `flushMicrotasks` para que llegue de verdad hasta quedar colgada
    // de runAgentTurn (claim → ritmo → cupo → turno son varios `await`
    // encadenados, cada uno su propia vuelta del microtask queue).
    await vi.advanceTimersByTimeAsync(20_500);
    expect(vi.getTimerCount()).toBe(0); // el timer que disparó ya no existe.
    await flushMicrotasks();

    // Mientras tanto, "otra pasada" (un webhook nuevo): con el único cupo
    // tomado por la continuación, no consigue ninguno y se difiere por CUPO.
    await enqueueAgentTurns(["c3"], { debounceSeconds: 0 });
    const resultadoAjeno = await processQueuedTurns();
    expect(resultadoAjeno.deferred).toBe(1);

    // Ningún timer nuevo: la continuación sigue "corriendo" y esta pasada
    // ajena se quedó callada, tal como describe registrarDiferidos.
    expect(vi.getTimerCount()).toBe(0);

    // Se libera el turno colgado y se deja terminar a la continuación: el
    // resto de su cadena (clearFailures, release del cupo, un claimDue más
    // que no encuentra nada vencido, el registrarDiferidos final) son varios
    // `await` más -de ahí `flushMicrotasks` en vez de un par sueltos-.
    liberarContinuacion.fn?.();
    await flushMicrotasks();

    // c3 recién se difirió: la continuación, al terminar, no encuentra nada
    // más vencido de inmediato y vuelve a "inactiva" — no se espera que la
    // reclame ella misma en este instante. Lo que sí hace falta demostrar es
    // que el estado quedó libre: una pasada FRESCA con diferidos (un mensaje
    // nuevo del cliente) puede programar de cero, no se quedó pegada en
    // "corriendo" para siempre.
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "1"; // aprieta el ritmo otra vez.
    await enqueueAgentTurns(["c4"], { debounceSeconds: 0 });
    await processQueuedTurns();

    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("continuación de la cola: drenado sin cron", () => {
  /**
   * El reporte de T3 pide un número: cuánto avanza sola —sin cron, sin un
   * webhook nuevo insistiendo— la cola con un atraso de 100 conversaciones,
   * apoyada solo en la continuación de este archivo, con
   * AGENT_MAX_TURNS_PER_MINUTE=30 y AGENT_MAX_CONCURRENT_TURNS=8 (la rampa
   * completa). El resultado real —medido acá, no el supuesto del plan
   * ("≈3 min 20 s: 30+30+30+10")— es que la continuación NUNCA LLEGA A
   * PROGRAMARSE: la pasada inicial (`processQueuedTurns()`, límite por
   * defecto `maxPerRun()` = 30, igual que la llamaría el cron o cualquier
   * disparador sin límite propio) procesa exactamente 30 con éxito y
   * termina limpia, sin diferir ni un solo turno — quedan 70 esperando, sin
   * ningún timer que las vaya a tocar.
   *
   * La causa: `AGENT_QUEUE_MAX_PER_RUN` y `AGENT_MAX_TURNS_PER_MINUTE`
   * valen los dos 30 por diseño (T1, misma rampa). Cuando el `limit` de una
   * pasada coincide con (o queda por debajo de) lo que el ritmo permite en
   * ese instante, cada trabajador de `atender()` deja de reclamar por
   * `if (tomados >= limit) return` ANTES de que el ritmo llegue a rechazar
   * nada — no hay ningún turno "frenado" que registrar en
   * `plazosDiferidos`, así que `registrarDiferidos` no tiene nada que
   * programar. La continuación de T3 solo se dispara cuando ALGO se
   * refirió de verdad (ritmo, cupo o lock) DENTRO del `limit` de la pasada
   * — el caso que sí cubre el resto de este archivo: un turno puntual que
   * se topa con el freno a mitad de una tanda más chica (el tamaño real de
   * un lote de webhook), no un backlog frío más grande que un `maxPerRun()`
   * entero procesado de un tirón.
   *
   * Esto es un límite real de lo que T3 alcanza a cubrir —el plan pide
   * explícitamente que la continuación use `maxPerRun()` y no toca esa
   * interacción con el tope por pasada—, no una regresión de esta corrida:
   * el cron (cada 60 s desde S1) sigue siendo quien complete lo que una
   * pasada que "cierra limpia" deja sin tocar. Ver el punto 5 del reporte.
   */
  it("100 conversaciones: la pasada inicial agota su límite sin diferir nada, y nadie más la sigue", async () => {
    process.env.AGENT_MAX_TURNS_PER_MINUTE = "30";
    process.env.AGENT_MAX_CONCURRENT_TURNS = "8";

    const ids = Array.from({ length: 100 }, (_, i) => `sim-${i}`);
    await enqueueAgentTurns(ids, { debounceSeconds: 0 });

    // La pasada inicial, con el límite POR DEFECTO —el mismo que usaría el
    // cron, o cualquier disparador que no traiga su propio tamaño de lote—.
    const resultadoInicial = await processQueuedTurns();

    expect(resultadoInicial.processed).toBe(30);
    expect(resultadoInicial.deferred).toBe(0);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(30);

    // Ninguna continuación programada: no hubo nada que registrar.
    expect(vi.getTimerCount()).toBe(0);
    // Las 70 restantes siguen ahí, sin ningún timer que las vaya a reclamar.
    expect(await pendingAgentTurns()).toBe(70);

    // Avanzar el reloj no cambia nada: no hay timer que dispare nada.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await pendingAgentTurns()).toBe(70);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(30);
  });
});
