import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ConversationBusyError,
  TURN_LOCK_LEASE_SECONDS,
  TURN_LOCK_RENEW_SECONDS,
  isConversationBusy,
  withConversationTurnLock,
} from "@/lib/ai/conversation-lock";

/**
 * Fake que simula la MISMA semántica que los tres RPC de la migración
 * 20260829020000 (`ai_turn_lock_acquire/renew/release`, fenceados por
 * token, `now()` para el vencimiento): un `Map<conversationId, {token,
 * until}>` con el chequeo-y-set síncrono antes de cualquier `await`, igual
 * que lo garantiza el UPDATE atómico de Postgres.
 */
function createFakeSupabase() {
  const locks = new Map<string, { token: string; until: number }>();

  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      const conversationId = String(args.p_conversation_id);

      if (fn === "ai_turn_lock_acquire") {
        const token = String(args.p_token);
        const leaseSeconds = Number(args.p_lease_seconds);
        const actual = locks.get(conversationId);
        const libre = !actual || actual.until <= Date.now();
        if (!libre) return Promise.resolve({ data: false, error: null });
        locks.set(conversationId, { token, until: Date.now() + leaseSeconds * 1000 });
        return Promise.resolve({ data: true, error: null });
      }

      if (fn === "ai_turn_lock_renew") {
        const token = String(args.p_token);
        const leaseSeconds = Number(args.p_lease_seconds);
        const actual = locks.get(conversationId);
        if (!actual || actual.token !== token) return Promise.resolve({ data: false, error: null });
        locks.set(conversationId, { token, until: Date.now() + leaseSeconds * 1000 });
        return Promise.resolve({ data: true, error: null });
      }

      if (fn === "ai_turn_lock_release") {
        const token = String(args.p_token);
        const actual = locks.get(conversationId);
        if (!actual || actual.token !== token) return Promise.resolve({ data: false, error: null });
        locks.delete(conversationId);
        return Promise.resolve({ data: true, error: null });
      }

      return Promise.reject(new Error(`rpc no soportada: ${fn}`));
    },
  };

  return { client: client as unknown as SupabaseClient, locks };
}

/** Deja un lock puesto sin pasar por withConversationTurnLock, como si un turno hubiera muerto sin soltarlo. */
function simularLockVigente(locks: Map<string, { token: string; until: number }>, conversationId: string) {
  locks.set(conversationId, { token: "token-del-turno-caído", until: Date.now() + TURN_LOCK_LEASE_SECONDS * 1000 });
}

/**
 * Vacía la cola de microtareas sin depender de temporizadores: `await`
 * sobre una promesa ya resuelta agenda su continuación como microtarea, y
 * con los timers fingidos (`vi.useFakeTimers`) un `setTimeout` no avanza
 * solo. Varias vueltas alcanzan para dejar correr `withConversationTurnLock`
 * hasta que `fn` arranca y queda pendiente.
 */
async function flushMicrotasks(vueltas = 6) {
  for (let i = 0; i < vueltas; i++) await Promise.resolve();
}

describe("withConversationTurnLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ejecuta fn y suelta el lock al terminar", async () => {
    const { client, locks } = createFakeSupabase();
    const fn = vi.fn().mockResolvedValue(undefined);

    await withConversationTurnLock(client, "conv-1", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(locks.has("conv-1")).toBe(false);
  });

  it("libera el lock aunque fn lance", async () => {
    const { client, locks } = createFakeSupabase();
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(withConversationTurnLock(client, "conv-1", fn)).rejects.toThrow("boom");
    expect(locks.has("conv-1")).toBe(false);
  });

  it("dos invocaciones simultáneas para la misma conversación: solo una ejecuta fn", async () => {
    const { client } = createFakeSupabase();
    let concurrentRuns = 0;
    let maxConcurrentRuns = 0;
    const fn = vi.fn().mockImplementation(async () => {
      concurrentRuns++;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
      concurrentRuns--;
    });

    const resultados = await Promise.allSettled([
      withConversationTurnLock(client, "conv-1", fn),
      withConversationTurnLock(client, "conv-1", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(maxConcurrentRuns).toBe(1);

    const rechazado = resultados.find((r) => r.status === "rejected");
    expect(rechazado).toBeDefined();
    if (rechazado?.status === "rejected") {
      expect(isConversationBusy(rechazado.reason)).toBe(true);
    }
  });

  it("conversaciones distintas no se bloquean entre sí", async () => {
    const { client } = createFakeSupabase();
    const fn = vi.fn().mockResolvedValue(undefined);

    await Promise.all([
      withConversationTurnLock(client, "conv-1", fn),
      withConversationTurnLock(client, "conv-2", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("un lock vencido se puede volver a tomar", async () => {
    const { client, locks } = createFakeSupabase();
    simularLockVigente(locks, "conv-1");

    // El proceso que lo tomó murió sin soltarlo: el lease vence solo.
    vi.setSystemTime(new Date(Date.now() + (TURN_LOCK_LEASE_SECONDS + 1) * 1000));

    const fn = vi.fn().mockResolvedValue(undefined);
    await withConversationTurnLock(client, "conv-1", fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("un lock vigente no se puede tomar", async () => {
    const { client, locks } = createFakeSupabase();
    simularLockVigente(locks, "conv-1");

    vi.setSystemTime(new Date(Date.now() + 60_000));

    const fn = vi.fn().mockResolvedValue(undefined);
    await expect(withConversationTurnLock(client, "conv-1", fn)).rejects.toThrow(ConversationBusyError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("el turno posterior a un crash no se pierde en silencio", async () => {
    const { client, locks } = createFakeSupabase();
    simularLockVigente(locks, "conv-1");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const fn = vi.fn().mockResolvedValue(undefined);
    await expect(withConversationTurnLock(client, "conv-1", fn)).rejects.toBeInstanceOf(ConversationBusyError);
    expect(fn).not.toHaveBeenCalled();

    // log.warn sale por console.error (lib/log.ts: warn y error comparten stderr).
    const eventos = consoleError.mock.calls.map(([linea]) => JSON.parse(String(linea)).event);
    expect(eventos).toContain("turno_lock_ocupado");

    consoleError.mockRestore();
  });

  it("el latido mantiene el lease mientras el turno vive", async () => {
    const { client, locks } = createFakeSupabase();
    let liberarFn: () => void = () => {};
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          liberarFn = resolve;
        })
    );

    const promesa = withConversationTurnLock(client, "conv-1", fn);
    await flushMicrotasks();

    const untilInicial = locks.get("conv-1")!.until;

    await vi.advanceTimersByTimeAsync(TURN_LOCK_RENEW_SECONDS * 1000);

    expect(locks.get("conv-1")!.until).toBeGreaterThan(untilInicial);

    liberarFn();
    await promesa;
  });

  it("si otro se llevó el lock, confirmar() dice que no", async () => {
    const { client, locks } = createFakeSupabase();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let lease: { confirmar(): Promise<boolean> } | undefined;
    let liberarFn: () => void = () => {};

    const fn = vi.fn().mockImplementation(
      (l: { confirmar(): Promise<boolean> }) =>
        new Promise<void>((resolve) => {
          lease = l;
          liberarFn = resolve;
        })
    );

    const promesa = withConversationTurnLock(client, "conv-1", fn);
    await flushMicrotasks();
    expect(lease).toBeDefined();

    // Otro proceso se lleva el lock por debajo (el lease venció y alguien
    // más lo tomó primero).
    locks.set("conv-1", { token: "otro-turno", until: Date.now() + TURN_LOCK_LEASE_SECONDS * 1000 });

    await expect(lease!.confirmar()).resolves.toBe(false);

    const eventos = consoleError.mock.calls.map(([linea]) => JSON.parse(String(linea)).event);
    expect(eventos).toContain("turno_lock_perdido");

    consoleError.mockRestore();
    liberarFn();
    await promesa;
  });

  it("el release está fenceado: un zombi no libera el lock del nuevo dueño", async () => {
    const { client, locks } = createFakeSupabase();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let liberarFn: () => void = () => {};

    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          liberarFn = resolve;
        })
    );

    const promesa = withConversationTurnLock(client, "conv-1", fn);
    await flushMicrotasks();

    // Mientras el turno "zombi" sigue corriendo (fn no resolvió todavía),
    // otro dueño se queda con el lock por debajo.
    locks.set("conv-1", { token: "token-nuevo-dueño", until: Date.now() + TURN_LOCK_LEASE_SECONDS * 1000 });

    liberarFn();
    await promesa;

    // El release del zombi (con su token viejo) no debe haber tocado el
    // lock del nuevo dueño.
    expect(locks.get("conv-1")?.token).toBe("token-nuevo-dueño");

    const eventos = consoleError.mock.calls.map(([linea]) => JSON.parse(String(linea)).event);
    expect(eventos).toContain("turno_lock_ya_no_era_nuestro");

    consoleError.mockRestore();
  });
});
