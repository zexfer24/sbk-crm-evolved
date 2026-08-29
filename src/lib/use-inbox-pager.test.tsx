/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInboxPager } from "@/lib/use-inbox-pager";
import { cursorAfterPage } from "@/lib/inbox-paging";
import type { ConversationSummary } from "@/lib/types";

/**
 * `useInboxPager` es la máquina de paginación por cursor compartida por las
 * tres píldoras de la bandeja (ver el comentario grande del propio hook).
 * Estos tests clavan las carreras que la motivaron: H1 (doble disparo del
 * mismo frame), H2 (respuesta vieja pisando una sesión nueva) y H3 (dos
 * eventos de scroll seguidos con el mismo cursor). No se mockea Supabase:
 * `fetchPage`/`onPage` son `vi.fn()` con promesas diferidas que este archivo
 * controla a mano.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function row(id: string, lastMessageAt = "2026-08-29T12:00:00.000Z"): ConversationSummary {
  return {
    id,
    contact: {
      id: `contact-${id}`,
      phoneNumber: "+58123456789",
      displayName: "Cliente de Prueba",
      profileName: "Cliente",
      avatarUrl: null,
      tags: [],
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: false,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: lastMessageAt,
    hasReply: false,
    lastMessageAt,
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
    createdAt: lastMessageAt,
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
  };
}

/** `pageSize` de los tests es 2: dos filas es página llena, menos es la última. */
function rows(n: number, prefix = "c"): ConversationSummary[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}-${i}`));
}

describe("useInboxPager", () => {
  it("loadMore() dos veces antes del repintado dispara UNA sola llamada (H3)", async () => {
    const first = deferred<ConversationSummary[]>();
    const second = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(first.promise);
    fetchPage.mockReturnValueOnce(second.promise);
    const onPage = vi.fn();

    const { result } = renderHook(() =>
      useInboxPager({ sessionKey: "s1", fetchPage, onPage, pageSize: 2 })
    );

    await act(async () => {
      first.resolve(rows(2));
      await first.promise;
    });
    expect(result.current.hasMore).toBe(true);

    // Ráfaga de scroll: dos disparos antes de que React repinte nada.
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });

    expect(fetchPage).toHaveBeenCalledTimes(2); // 1 primera página + 1 sola "cargar más"
  });

  it("con la primera página en vuelo, loadMore() no pide (H1); resuelta, sí pide la segunda", async () => {
    const first = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(first.promise);
    const onPage = vi.fn();

    const { result } = renderHook(() =>
      useInboxPager({ sessionKey: "s1", fetchPage, onPage, pageSize: 2 })
    );

    expect(result.current.status).toBe("loading");

    act(() => {
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(1); // sigue siendo solo la primera página en vuelo

    const second = deferred<ConversationSummary[]>();
    fetchPage.mockReturnValueOnce(second.promise);

    await act(async () => {
      first.resolve(rows(2));
      await first.promise;
    });
    expect(result.current.status).toBe("ready");

    act(() => {
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("el cursor se lee al llamar: la página 3 usa el cursor de la 2, no uno viejo", async () => {
    const page1 = rows(2, "p1");
    const page2 = rows(2, "p2");
    const first = deferred<ConversationSummary[]>();
    const second = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(first.promise);
    fetchPage.mockReturnValueOnce(second.promise);
    fetchPage.mockReturnValueOnce(Promise.resolve([]));
    const onPage = vi.fn();

    const { result } = renderHook(() =>
      useInboxPager({ sessionKey: "s1", fetchPage, onPage, pageSize: 2 })
    );

    await act(async () => {
      first.resolve(page1);
      await first.promise;
    });

    act(() => {
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);

    // Se resuelve la página 2 FUERA de act, sin dejar que React repinte.
    second.resolve(page2);
    await Promise.resolve();
    await Promise.resolve();

    // `loadMore` tiene identidad estable: se puede llamar directo sobre el
    // último `result.current` aunque no haya habido un render de por medio.
    result.current.loadMore();

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2][0]).toEqual(cursorAfterPage(page2));
    expect(fetchPage.mock.calls[2][0]).not.toEqual(cursorAfterPage(page1));
  });

  it("cambiar sessionKey con página en vuelo: la respuesta vieja no toca onPage ni el estado (H2)", async () => {
    const s1First = deferred<ConversationSummary[]>();
    const s2First = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(s1First.promise);
    fetchPage.mockReturnValueOnce(s2First.promise);
    const onPage = vi.fn();

    const { result, rerender } = renderHook(
      ({ sessionKey }: { sessionKey: string }) =>
        useInboxPager({ sessionKey, fetchPage, onPage, pageSize: 2 }),
      { initialProps: { sessionKey: "s1" } }
    );

    act(() => {
      rerender({ sessionKey: "s2" });
    });

    // La respuesta de la sesión abandonada ("s1") llega tarde.
    await act(async () => {
      s1First.resolve(rows(2, "s1"));
      await s1First.promise;
    });

    expect(onPage).not.toHaveBeenCalled();
    expect(result.current.status).toBe("loading"); // "s2" sigue esperando SU primera página

    await act(async () => {
      s2First.resolve(rows(1, "s2"));
      await s2First.promise;
    });

    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "s2-0" })]),
      "first"
    );
  });

  it("página llena mantiene hasMore; una corta lo cierra y loadMore() deja de pedir", async () => {
    const first = deferred<ConversationSummary[]>();
    const second = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(first.promise);
    fetchPage.mockReturnValueOnce(second.promise);
    const onPage = vi.fn();

    const { result } = renderHook(() =>
      useInboxPager({ sessionKey: "s1", fetchPage, onPage, pageSize: 2 })
    );

    await act(async () => {
      first.resolve(rows(2));
      await first.promise;
    });
    expect(result.current.hasMore).toBe(true);

    act(() => {
      result.current.loadMore();
    });

    await act(async () => {
      second.resolve(rows(1)); // corta: es la última
      await second.promise;
    });

    expect(result.current.hasMore).toBe(false);

    act(() => {
      result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2); // no un tercer pedido
  });

  it("primera página que falla: status error, hasMore false; retry() recarga sin cursor", async () => {
    const failing = deferred<ConversationSummary[]>();
    const retrying = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(failing.promise);
    fetchPage.mockReturnValueOnce(retrying.promise);
    const onPage = vi.fn();

    const { result } = renderHook(() =>
      useInboxPager({ sessionKey: "s1", fetchPage, onPage, pageSize: 2 })
    );

    await act(async () => {
      failing.reject(new Error("caída de red"));
      try {
        await failing.promise;
      } catch {
        // se afirma sobre el estado del hook, no sobre esta promesa
      }
    });

    expect(result.current.status).toBe("error");
    expect(result.current.hasMore).toBe(false);
    expect(onPage).not.toHaveBeenCalled(); // las filas previas/sembradas no se tocan

    act(() => {
      result.current.retry();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1][0]).toBe(null); // nunca hubo página: sin cursor que reusar

    await act(async () => {
      retrying.resolve(rows(2)); // página llena
      await retrying.promise;
    });

    // Si el error hubiera encendido `reachedEnd`, una página llena entregada
    // por `retry()` no alcanzaría a reabrir `hasMore` sin pasar por acá.
    expect(result.current.status).toBe("ready");
    expect(result.current.hasMore).toBe(true);
  });

  it("página siguiente que falla: lastPageFailed true, cursor quieto; el siguiente loadMore() repite la MISMA página", async () => {
    const first = deferred<ConversationSummary[]>();
    const failingSecond = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(first.promise);
    fetchPage.mockReturnValueOnce(failingSecond.promise);
    fetchPage.mockReturnValueOnce(Promise.resolve(rows(1, "retry")));
    const onPage = vi.fn();

    const { result } = renderHook(() =>
      useInboxPager({ sessionKey: "s1", fetchPage, onPage, pageSize: 2 })
    );

    const page1 = rows(2, "p1");
    await act(async () => {
      first.resolve(page1);
      await first.promise;
    });

    act(() => {
      result.current.loadMore();
    });

    await act(async () => {
      failingSecond.reject(new Error("caída de red"));
      try {
        await failingSecond.promise;
      } catch {
        // idem: se afirma sobre el hook
      }
    });

    expect(result.current.lastPageFailed).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.status).toBe("ready"); // el fallo de "cargar más" no toca `status`

    act(() => {
      result.current.loadMore(); // reintento: misma guarda que un "cargar más" cualquiera
    });

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2][0]).toEqual(cursorAfterPage(page1)); // el cursor no avanzó
  });

  it("con seed no pide nada al montar y hasMore sale del seed", () => {
    const fetchPage = vi.fn();
    const onPage = vi.fn();
    const seedRows = rows(2, "seed");

    const { result } = renderHook(() =>
      useInboxPager({
        sessionKey: "seeded",
        fetchPage,
        onPage,
        pageSize: 2,
        seed: { cursor: cursorAfterPage(seedRows), reachedEnd: false },
      })
    );

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    expect(result.current.hasMore).toBe(true);
  });

  it("enabled:false no pide nada; al pasar a true abre sesión y pide la primera página", async () => {
    const firstEnabled = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(firstEnabled.promise);
    const onPage = vi.fn();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useInboxPager({ sessionKey: "s1", enabled, fetchPage, onPage, pageSize: 2 }),
      { initialProps: { enabled: false } }
    );

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    expect(result.current.hasMore).toBe(false);

    act(() => {
      rerender({ enabled: true });
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(null);

    await act(async () => {
      firstEnabled.resolve(rows(2));
      await firstEnabled.promise;
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.hasMore).toBe(true);
  });

  it("página siguiente vacía no llama a onPage", async () => {
    const first = deferred<ConversationSummary[]>();
    const emptySecond = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(first.promise);
    fetchPage.mockReturnValueOnce(emptySecond.promise);
    const onPage = vi.fn();

    const { result } = renderHook(() =>
      useInboxPager({ sessionKey: "s1", fetchPage, onPage, pageSize: 2 })
    );

    await act(async () => {
      first.resolve(rows(2));
      await first.promise;
    });
    expect(onPage).toHaveBeenCalledTimes(1); // la primera SÍ se entrega, aunque sea corta

    act(() => {
      result.current.loadMore();
    });

    await act(async () => {
      emptySecond.resolve([]);
      await emptySecond.promise;
    });

    expect(onPage).toHaveBeenCalledTimes(1); // sigue en 1: la vacía no genera render de balde
    expect(result.current.hasMore).toBe(false);
  });

  it("la respuesta de una sesión abandonada no libera el candado de la sesión vigente", async () => {
    const s1First = deferred<ConversationSummary[]>();
    const s1Second = deferred<ConversationSummary[]>(); // "cargar más" de la sesión vieja: resuelve tarde
    const s2First = deferred<ConversationSummary[]>();
    const s2Second = deferred<ConversationSummary[]>();
    const fetchPage = vi.fn();
    fetchPage.mockReturnValueOnce(s1First.promise);
    fetchPage.mockReturnValueOnce(s1Second.promise);
    fetchPage.mockReturnValueOnce(s2First.promise);
    fetchPage.mockReturnValueOnce(s2Second.promise);
    const onPage = vi.fn();

    const { result, rerender } = renderHook(
      ({ sessionKey }: { sessionKey: string }) =>
        useInboxPager({ sessionKey, fetchPage, onPage, pageSize: 2 }),
      { initialProps: { sessionKey: "s1" } }
    );

    await act(async () => {
      s1First.resolve(rows(2, "s1"));
      await s1First.promise;
    });

    act(() => {
      result.current.loadMore(); // sesión 1: queda en vuelo, `s1Second` no resuelve todavía
    });
    expect(result.current.loadingMore).toBe(true);

    // Se abandona la sesión 1 con esa página siguiente aún viajando.
    act(() => {
      rerender({ sessionKey: "s2" });
    });

    await act(async () => {
      s2First.resolve(rows(2, "s2"));
      await s2First.promise;
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.loadingMore).toBe(false);

    act(() => {
      result.current.loadMore(); // sesión 2 pagina por su cuenta
    });
    expect(result.current.loadingMore).toBe(true);

    // La respuesta vieja de la sesión 1 llega tarde: no debe abrir el
    // candado que la sesión 2 acaba de cerrar.
    await act(async () => {
      s1Second.resolve(rows(2, "s1-tarde"));
      await s1Second.promise;
    });

    expect(result.current.loadingMore).toBe(true); // sigue cerrado por la sesión 2
    expect(onPage).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "s1-tarde-0" })]),
      "next"
    );

    // La sesión 2 sigue paginando con normalidad tras el ruido de la vieja.
    await act(async () => {
      s2Second.resolve(rows(1, "s2-2")); // corta: cierra
      await s2Second.promise;
    });

    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(false);
  });
});
