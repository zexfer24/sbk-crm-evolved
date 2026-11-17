/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSebaSuggestion } from "@/components/chat/use-seba-suggestion";
import type { Agent } from "@/lib/types";
import type { ShadowDraft } from "@/lib/shadow";

/**
 * Hook de la sugerencia de copiloto (entrega 3 de Seba v2, 17/11/2026). El
 * reloj va falseado (solo `Date` y los intervalos, no las promesas) porque lo
 * que se prueba es el paso de los 10 minutos y el temporizador de 30 s. Con
 * timers falsos NO se usa `waitFor` (CLAUDE.md, 27/9/2026): se cede la cola de
 * microtareas a mano con `flush`.
 */

const fetchSebaV2ConfigMock = vi.fn();
vi.mock("@/lib/data", () => ({ fetchSebaV2Config: (...a: unknown[]) => fetchSebaV2ConfigMock(...a) }));

const fetchPendingSuggestionMock = vi.fn();
vi.mock("@/lib/shadow-data", () => ({ fetchPendingSuggestion: (...a: unknown[]) => fetchPendingSuggestionMock(...a) }));

const resolveSuggestionMock = vi.fn();
vi.mock("@/lib/mutations", () => ({ resolveSuggestion: (...a: unknown[]) => resolveSuggestionMock(...a) }));

interface FakeChannel {
  name: string;
  filter: Record<string, unknown> | null;
  onChange: ((payload: { new: unknown }) => void) | null;
  onStatus: ((status: string) => void) | null;
}
const channels: FakeChannel[] = [];
const removeChannelMock = vi.fn();
const FAKE_CLIENT = {
  channel: (name: string) => {
    const channel: FakeChannel = { name, filter: null, onChange: null, onStatus: null };
    channels.push(channel);
    const api = {
      on: (_type: string, filter: Record<string, unknown>, cb: (payload: { new: unknown }) => void) => {
        channel.filter = filter;
        channel.onChange = cb;
        return api;
      },
      subscribe: (cb?: (status: string) => void) => {
        channel.onStatus = cb ?? null;
        return api;
      },
    };
    return Object.assign(api, { __channel: channel });
  },
  removeChannel: (ch: unknown) => removeChannelMock(ch),
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => FAKE_CLIENT }));

const AGENTE: Agent = {
  id: "ase-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

const T0 = new Date("2026-11-17T15:00:00.000Z");
const MIN = 60_000;

function draft(overrides: Partial<ShadowDraft> = {}): ShadowDraft {
  return {
    id: "d1",
    conversationId: "c1",
    modo: "copiloto",
    triggerMessageId: null,
    rafaga: ["hola"],
    mensajes: [{ orden: 1, tipo: "texto", texto: "Claro", origen: "modelo", mediaUrl: null }],
    herramientas: [],
    productos: [],
    escalaria: false,
    motivo: null,
    area: null,
    nota: null,
    guardas: [],
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    llamadas: 0,
    durationMs: null,
    sugerenciaEstado: "pendiente",
    sugerenciaResueltaPor: null,
    sugerenciaResueltaAt: null,
    createdAt: T0.toISOString(),
    ...overrides,
  };
}

/** La fila cruda, como la manda Realtime. */
function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "d2",
    conversation_id: "c1",
    modo: "copiloto",
    rafaga: ["otra"],
    mensajes: [{ orden: 1, tipo: "texto", texto: "Nueva", origen: "modelo" }],
    sugerencia_estado: "pendiente",
    created_at: new Date(T0.getTime() + 2 * MIN).toISOString(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

async function avanzar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function montar(props: { conversationId?: string; lastAgentMessageAt?: string | null } = {}) {
  return renderHook(
    (p: { conversationId: string; lastAgentMessageAt: string | null }) =>
      useSebaSuggestion({ conversationId: p.conversationId, agent: AGENTE, lastAgentMessageAt: p.lastAgentMessageAt }),
    { initialProps: { conversationId: props.conversationId ?? "c1", lastAgentMessageAt: props.lastAgentMessageAt ?? null } }
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(T0.getTime() + MIN));
  channels.length = 0;
  removeChannelMock.mockReset();
  fetchSebaV2ConfigMock.mockReset().mockResolvedValue({ modo: "copiloto" });
  fetchPendingSuggestionMock.mockReset().mockResolvedValue(draft());
  resolveSuggestionMock.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSebaSuggestion — solo en modo copiloto", () => {
  it.each(["apagado", "sombra", "fuera_de_horario", "siempre"])(
    "con el modo %s no consulta borradores ni se suscribe",
    async (modo) => {
      fetchSebaV2ConfigMock.mockResolvedValue({ modo });
      const { result } = montar();
      await flush();

      expect(result.current.draft).toBeNull();
      expect(fetchPendingSuggestionMock).not.toHaveBeenCalled();
      expect(channels).toHaveLength(0);
    }
  );

  it("si la configuración no se puede leer (null), tampoco", async () => {
    fetchSebaV2ConfigMock.mockResolvedValue(null);
    const { result } = montar();
    await flush();

    expect(result.current.draft).toBeNull();
    expect(fetchPendingSuggestionMock).not.toHaveBeenCalled();
  });

  it("si la lectura de la configuración falla, falla cerrado (sin sugerencia) y lo anota", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSebaV2ConfigMock.mockRejectedValue(new Error("red"));
    const { result } = montar();
    await flush();

    expect(result.current.draft).toBeNull();
    expect(fetchPendingSuggestionMock).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("lee el modo UNA sola vez aunque cambie de conversación", async () => {
    const { rerender } = montar();
    await flush();
    rerender({ conversationId: "c2", lastAgentMessageAt: null });
    await flush();

    expect(fetchSebaV2ConfigMock).toHaveBeenCalledTimes(1);
    expect(fetchPendingSuggestionMock).toHaveBeenCalledWith(FAKE_CLIENT, "c1");
    expect(fetchPendingSuggestionMock).toHaveBeenCalledWith(FAKE_CLIENT, "c2");
  });
});

describe("useSebaSuggestion — carga y Realtime", () => {
  it("devuelve la sugerencia pendiente y reciente", async () => {
    const { result } = montar();
    await flush();

    expect(result.current.draft?.id).toBe("d1");
    expect(result.current.editing).toBe(false);
  });

  it("una sugerencia ya resuelta no se muestra", async () => {
    fetchPendingSuggestionMock.mockResolvedValue(draft({ sugerenciaEstado: "enviada" }));
    const { result } = montar();
    await flush();

    expect(result.current.draft).toBeNull();
  });

  it("se suscribe con un nombre único y filtra por conversation_id; al desmontar quita el canal", async () => {
    const { unmount } = montar();
    await flush();

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toMatch(/^seba-suggestion-c1:\d+$/);
    expect(channels[0].filter).toMatchObject({ schema: "public", table: "agent_shadow_drafts", filter: "conversation_id=eq.c1" });

    unmount();
    expect(removeChannelMock).toHaveBeenCalledTimes(1);
  });

  it("dos montajes de la misma conversación no comparten el nombre del canal", async () => {
    montar();
    montar();
    await flush();

    expect(channels).toHaveLength(2);
    expect(channels[0].name).not.toBe(channels[1].name);
  });

  it("un borrador nuevo por Realtime reemplaza al anterior", async () => {
    const { result } = montar();
    await flush();

    act(() => channels[0].onChange?.({ new: rawRow() }));

    expect(result.current.draft?.id).toBe("d2");
  });

  it("un UPDATE a «enviada» (otro asesor la usó) la oculta", async () => {
    const { result } = montar();
    await flush();

    act(() =>
      channels[0].onChange?.({
        new: rawRow({ id: "d1", created_at: T0.toISOString(), sugerencia_estado: "enviada" }),
      })
    );

    expect(result.current.draft).toBeNull();
  });

  it("un evento de un borrador de sombra, o uno viejo, no pisa al actual", async () => {
    const { result } = montar();
    await flush();

    act(() => channels[0].onChange?.({ new: rawRow({ id: "s1", modo: "sombra" }) }));
    expect(result.current.draft?.id).toBe("d1");

    act(() => channels[0].onChange?.({ new: rawRow({ id: "viejo", created_at: new Date(T0.getTime() - 5 * MIN).toISOString() }) }));
    expect(result.current.draft?.id).toBe("d1");
  });

  it("al reconectar el canal vuelve a leer el último borrador", async () => {
    montar();
    await flush();
    expect(fetchPendingSuggestionMock).toHaveBeenCalledTimes(1);

    act(() => channels[0].onStatus?.("CLOSED"));
    act(() => channels[0].onStatus?.("SUBSCRIBED"));
    await flush();

    expect(fetchPendingSuggestionMock).toHaveBeenCalledTimes(2);
  });

  it("al cambiar de conversación no se ve la sugerencia de la anterior", async () => {
    fetchPendingSuggestionMock.mockImplementation(async (_c: unknown, id: string) =>
      id === "c1" ? draft() : null
    );
    const { result, rerender } = montar();
    await flush();
    expect(result.current.draft?.id).toBe("d1");

    rerender({ conversationId: "c2", lastAgentMessageAt: null });
    expect(result.current.draft).toBeNull();
    await flush();
    expect(result.current.draft).toBeNull();
  });
});

describe("useSebaSuggestion — vencimiento", () => {
  it("a los 10 minutos deja de verse y se marca «vencida» UNA sola vez", async () => {
    const { result } = montar();
    await flush();
    expect(result.current.draft?.id).toBe("d1");

    // Pasó 1 min desde T0; faltan 9 para el plazo. El temporizador corre cada 30 s.
    await avanzar(8 * MIN + 30_000);
    expect(result.current.draft?.id).toBe("d1");
    expect(resolveSuggestionMock).not.toHaveBeenCalled();

    await avanzar(60_000);
    expect(result.current.draft).toBeNull();
    expect(resolveSuggestionMock).toHaveBeenCalledTimes(1);
    expect(resolveSuggestionMock).toHaveBeenCalledWith(FAKE_CLIENT, AGENTE, "d1", "vencida");

    await avanzar(5 * MIN);
    expect(resolveSuggestionMock).toHaveBeenCalledTimes(1);
  });

  it("si un asesor escribió después del borrador, se marca «vencida» sin esperar los 10 minutos", async () => {
    const { result, rerender } = montar();
    await flush();
    expect(result.current.draft?.id).toBe("d1");

    rerender({ conversationId: "c1", lastAgentMessageAt: new Date(T0.getTime() + 30_000).toISOString() });
    await flush();

    expect(result.current.draft).toBeNull();
    expect(resolveSuggestionMock).toHaveBeenCalledWith(FAKE_CLIENT, AGENTE, "d1", "vencida");
  });

  it("si marcarla «vencida» falla, lo anota y no tumba nada", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveSuggestionMock.mockRejectedValue(new Error("red"));
    const { result } = montar();
    await flush();

    await avanzar(10 * MIN);

    expect(result.current.draft).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("useSebaSuggestion — resolverla", () => {
  it("hide() la oculta y después NO se marca «vencida»", async () => {
    const { result } = montar();
    await flush();

    act(() => result.current.hide());
    expect(result.current.draft).toBeNull();

    await avanzar(11 * MIN);
    expect(resolveSuggestionMock).not.toHaveBeenCalled();
  });

  it("«Editar» deja la tarjeta en estado editando, y al enviar el asesor se marca «editada»", async () => {
    const { result } = montar();
    await flush();

    act(() => result.current.beginEdit());
    expect(result.current.editing).toBe(true);
    expect(result.current.draft?.id).toBe("d1");

    act(() => result.current.notifyAdvisorSent());
    await flush();

    expect(resolveSuggestionMock).toHaveBeenCalledWith(FAKE_CLIENT, AGENTE, "d1", "editada");
    expect(result.current.draft).toBeNull();
    expect(result.current.editing).toBe(false);

    // El mensaje del asesor llega después por Realtime: ya no debe pasar a «vencida».
    await avanzar(11 * MIN);
    expect(resolveSuggestionMock).toHaveBeenCalledTimes(1);
  });

  it("si el asesor envía sin haber pulsado «Editar», notifyAdvisorSent no resuelve nada", async () => {
    const { result } = montar();
    await flush();

    act(() => result.current.notifyAdvisorSent());
    await flush();

    expect(resolveSuggestionMock).not.toHaveBeenCalled();
    expect(result.current.draft?.id).toBe("d1");
  });

  it("descartar mientras edita sale del estado editando", async () => {
    const { result } = montar();
    await flush();
    act(() => result.current.beginEdit());

    act(() => result.current.hide());

    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBeNull();
  });
});
