/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => fake.supabase,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
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
 * (session → fila de `agents`/`conversations` → `setState`) dentro de `act`,
 * sin depender de temporizadores: `vi.useFakeTimers()` (el test de los 6 s)
 * no toca la cola de microtareas, así que esto funciona igual con o sin
 * temporizadores falsos.
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
  resetAssignmentNoticeDedupe();
});

describe("AssignmentNotifier", () => {
  it("un traspaso 'escalada' para mí muestra el aviso con el nombre del contacto", async () => {
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
    });
    await flush();

    expect(screen.getByText("Te asignaron una conversación")).toBeTruthy();
    expect(screen.getByText("La IA te la pasó: María Pérez")).toBeTruthy();
  });

  it("a los 6.000 ms el aviso desaparece", async () => {
    vi.useFakeTimers();
    try {
      render(<AssignmentNotifier />);
      await flush();

      act(() => {
        fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
      });
      await flush();

      expect(screen.getByText("Te asignaron una conversación")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(screen.queryByText("Te asignaron una conversación")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("el clic navega directo a la conversación asignada", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff({ conversation_id: "conv-42" }));
    });
    await flush();

    await user.click(screen.getByRole("button"));

    expect(pushMock).toHaveBeenCalledWith("/inbox?conversation=conv-42");
  });

  it("un traspaso 'escalada' para otro asesor no muestra nada", async () => {
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff({ to_id: "agente-2" }));
    });
    await flush();

    expect(screen.queryByText("Te asignaron una conversación")).toBeNull();
  });

  it("dos instancias montadas a la vez (el cruce de section-skeleton) muestran un solo aviso", async () => {
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

    expect(screen.getAllByText("Te asignaron una conversación")).toHaveLength(1);
  });

  it("si la consulta del nombre del contacto falla, el aviso igual aparece con el texto neutro", async () => {
    fake.setContactFails();
    render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
    });
    await flush();

    expect(screen.getByText("Te asignaron una conversación")).toBeTruthy();
    expect(screen.getByText("La IA te la pasó.")).toBeTruthy();
  });
});
