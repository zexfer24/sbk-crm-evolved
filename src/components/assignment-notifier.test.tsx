/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { AssignmentNotifier } from "@/components/assignment-notifier";
import { resetAssignmentNoticeDedupe } from "@/lib/assignment-notice";

type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";
type ChannelHandler = (payload: { eventType: RealtimeEvent; new: Record<string, unknown> }) => void;

interface Subscription {
  event: RealtimeEvent | "*";
  handler: ChannelHandler;
}

/**
 * Fake mínimo del cliente realtime de Supabase, copiado de
 * `crm-shell.test.tsx` (`createFakeSupabase`, líneas 25-60) — respeta el
 * tipo de evento, igual que el original — y extendido con lo que
 * `AssignmentNotifier` necesita además del canal: `auth.getSession()` para
 * resolver quién soy (`fetchCurrentAgent`, `src/lib/data.ts`) y
 * `from("conversations")` para el nombre del contacto.
 */
function createFakeSupabase() {
  const subscriptionsByTable = new Map<string, Subscription[]>();

  const session: { user: { id: string } } | null = { user: { id: "agente-1" } };
  let contactImpl: () => Promise<{ data: unknown; error: unknown }> = async () => ({
    data: { contact: { display_name: "María Pérez", profile_name: null, phone_number: null } },
    error: null,
  });

  const channel = {
    on(
      _type: string,
      config: { event: RealtimeEvent | "*"; table: string },
      handler: ChannelHandler
    ) {
      const list = subscriptionsByTable.get(config.table) ?? [];
      list.push({ event: config.event, handler });
      subscriptionsByTable.set(config.table, list);
      return channel;
    },
    subscribe() {
      return channel;
    },
  };

  return {
    supabase: {
      channel: () => channel,
      removeChannel: () => {},
      auth: {
        getSession: async () => ({ data: { session } }),
      },
      from(table: string) {
        if (table === "agents") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: session
                    ? {
                        id: session.user.id,
                        display_name: "Agente Uno",
                        full_name: null,
                        avatar_url: null,
                        role: "agente",
                        is_active: true,
                      }
                    : null,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => contactImpl(),
              }),
            }),
          };
        }
        throw new Error(`tabla no mockeada en el fake: ${table}`);
      },
    },
    trigger(
      table: string,
      eventType: RealtimeEvent = "INSERT",
      row: Record<string, unknown> = {}
    ) {
      for (const { event, handler } of subscriptionsByTable.get(table) ?? []) {
        if (event === "*" || event === eventType) handler({ eventType, new: row });
      }
    },
    /** Solo para el test de "la consulta del nombre falla". */
    setContactFails() {
      contactImpl = () => Promise.reject(new Error("no se pudo leer el contacto"));
    },
  };
}

let fake: ReturnType<typeof createFakeSupabase>;
let pushMock: ReturnType<typeof vi.fn>;
let toastMock: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => fake.supabase,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// Mismo patrón que `producto-fila.test.tsx`/`business-hours-panel.test.tsx`:
// mockear solo la función que este componente usa (`toast` como callable),
// nada del resto del módulo — acá no hace falta `.success`/`.danger`/etc
// porque `assignment-notifier.tsx` es el único código de este árbol de
// render que toca `@heroui/react`.
vi.mock("@heroui/react", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

/** Fila de traspaso `escalada` para "agente-1", como la escribe `escalateConversation`. */
function escaladaHandoff(overrides: Record<string, unknown> = {}) {
  return {
    id: "handoff-1",
    conversation_id: "conv-1",
    to_kind: "human",
    to_id: "agente-1",
    reason: "escalada",
    ...overrides,
  };
}

/**
 * Deja correr la cadena de promesas de `fetchCurrentAgent`/`fetchContactName`
 * (session → fila de `agents`/`conversations` → `toast()`) dentro de `act`,
 * sin depender de temporizadores.
 */
async function flush(ticks = 8) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  fake = createFakeSupabase();
  pushMock = vi.fn();
  toastMock = vi.fn();
  resetAssignmentNoticeDedupe();
});

describe("AssignmentNotifier", () => {
  it("un traspaso 'escalada' para mí llama a toast() con el nombre del contacto", async () => {
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
    });
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      "Te asignaron una conversación",
      expect.objectContaining({
        description: "La IA te pasó a María Pérez",
        timeout: 10000,
      })
    );
  });

  it("si la consulta del nombre del contacto falla, igual llama a toast() con la descripción neutra", async () => {
    fake.setContactFails();
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
    });
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(
      "Te asignaron una conversación",
      expect.objectContaining({ description: "La IA te pasó una conversación" })
    );
  });

  it("un traspaso 'asignada' (mismo dueño de siempre) no llama a toast()", async () => {
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff({ reason: "asignada" }));
    });
    await flush();

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("un traspaso 'escalada' para OTRO asesor no llama a toast()", async () => {
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff({ to_id: "agente-2" }));
    });
    await flush();

    expect(toastMock).not.toHaveBeenCalled();
  });

  it("dos instancias montadas a la vez (el cruce de section-skeleton) llaman a toast() una sola vez", async () => {
    render(
      <>
        <AssignmentNotifier />
        <AssignmentNotifier />
      </>
    );
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
    });
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("el 'Abrir' del toast navega a la conversación asignada", async () => {
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff({ conversation_id: "conv-42" }));
    });
    await flush();

    expect(toastMock).toHaveBeenCalledTimes(1);
    const options = toastMock.mock.calls[0][1] as { actionProps: { children: string; onPress: () => void } };
    expect(options.actionProps.children).toBe("Abrir");

    options.actionProps.onPress();
    expect(pushMock).toHaveBeenCalledWith("/inbox?conversation=conv-42");
  });

  it("no deja ningún nodo propio en el DOM: el Toast.Provider de HeroUI (layout.tsx) es quien pinta", async () => {
    const { container } = render(<AssignmentNotifier />);
    await flush();

    expect(container.childElementCount).toBe(0);
  });
});
