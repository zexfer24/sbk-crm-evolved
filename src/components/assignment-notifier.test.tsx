/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { AssignmentNotifier } from "@/components/assignment-notifier";
import { resetAssignmentNoticeDedupe } from "@/lib/assignment-notice";

type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";
type ChannelHandler = (payload: { eventType: RealtimeEvent; new: Record<string, unknown> }) => void;

interface Subscription {
  table: string;
  event: RealtimeEvent | "*";
  handler: ChannelHandler;
}

type ChannelState = "closed" | "joining" | "joined" | "leaving";

interface FakeChannel {
  topic: string;
  state: ChannelState;
  subscriptions: Subscription[];
  on(
    type: string,
    config: { event: RealtimeEvent | "*"; table: string },
    handler: ChannelHandler
  ): FakeChannel;
  subscribe(callback?: (status: string) => void): FakeChannel;
}

/**
 * Fake del cliente realtime de Supabase, copiado de `crm-shell.test.tsx`
 * (`createFakeSupabase`) y extendido con lo que `AssignmentNotifier` necesita
 * además del canal: `auth.getSession()` para resolver quién soy
 * (`fetchCurrentAgent`, `src/lib/data.ts`) y `from("conversations")` para el
 * nombre del contacto.
 *
 * 29/10/2026 (hotfix "/inventario se cae al guardar un presupuesto"): el canal
 * del fake era UN solo objeto para todo `channel(...)`, con un `on()` que nunca
 * lanzaba, y por eso no podía atrapar el fallo real. Ahora imita los tres
 * comportamientos de realtime-js 2.112.3 que lo causan: (1) `channel(topic)`
 * devuelve el canal que ya existe con ese topic; (2) `on("postgres_changes")`
 * lanza si el canal ya está `joining`/`joined`; (3) `removeChannel` es
 * asíncrono — deja el canal en `leaving` y solo sale del registro cuando el
 * servidor confirma (`confirmarSalidas()` en el fake). Y el INSERT se despacha
 * a TODOS los canales `joined` del registro, como haría el servidor.
 */
function createFakeSupabase() {
  const channels = new Map<string, FakeChannel>();

  const session: { user: { id: string } } | null = { user: { id: "agente-1" } };
  // Rol del usuario que mira la pantalla (T10b-5): el aviso de demora solo es
  // para supervisor/admin. Antes de esta tarea el fake ni lo modelaba
  // ("agente" no es un rol válido), y el aviso de asignación no lo mira.
  let role = "agent";
  let contactImpl: () => Promise<{ data: unknown; error: unknown }> = async () => ({
    data: { contact: { display_name: "María Pérez", profile_name: null, phone_number: null } },
    error: null,
  });

  return {
    supabase: {
      channel(nombre: string) {
        const topic = `realtime:${nombre}`;
        const existente = channels.get(topic);
        if (existente) return existente;
        const canal: FakeChannel = {
          topic,
          state: "closed",
          subscriptions: [],
          on(_type, config, handler) {
            if (canal.state === "joining" || canal.state === "joined") {
              throw new Error(
                `cannot add \`postgres_changes\` callbacks for ${canal.topic} after \`subscribe()\`.`
              );
            }
            canal.subscriptions.push({ table: config.table, event: config.event, handler });
            return canal;
          },
          subscribe() {
            if (canal.state === "closed") canal.state = "joined";
            return canal;
          },
        };
        channels.set(topic, canal);
        return canal;
      },
      removeChannel(canal: FakeChannel) {
        // Como realtime-js: pasa a "leaving" y sigue en la lista hasta que el
        // servidor confirma la salida.
        canal.state = "leaving";
      },
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
                        role,
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
      // El servidor entrega el INSERT a todos los canales unidos.
      for (const canal of [...channels.values()]) {
        if (canal.state !== "joined") continue;
        for (const sub of canal.subscriptions) {
          if (sub.table !== table) continue;
          if (sub.event === "*" || sub.event === eventType) sub.handler({ eventType, new: row });
        }
      }
    },
    /** El servidor confirma las salidas: los canales en "leaving" salen del registro. */
    confirmarSalidas() {
      for (const [topic, canal] of channels) {
        if (canal.state === "leaving") {
          canal.state = "closed";
          channels.delete(topic);
        }
      }
    },
    setRole(next: string) {
      role = next;
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

/** Fila `demora_sin_asesor`: el cron de demora ya no tiene a quién rotar (dueño sin cambiar). */
function demoraSinAsesorHandoff(overrides: Record<string, unknown> = {}) {
  return {
    id: "handoff-demora-1",
    conversation_id: "conv-9",
    to_kind: "human",
    to_id: "agente-2",
    reason: "demora_sin_asesor",
    ...overrides,
  };
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

  it("dos instancias vivas a la vez no lanzan, avisan una sola vez y, al irse una, la otra sigue recibiendo (canal único por suscripción)", async () => {
    // Sin nombre único por suscripción, la segunda instancia recibe el canal
    // ya unido y `on()` lanza "cannot add `postgres_changes` callbacks … after
    // `subscribe()`" desde un useEffect (hotfix 29/10/2026).
    const primera = render(<AssignmentNotifier />);
    const segunda = render(<AssignmentNotifier />);
    await flush();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
    });
    await flush();
    expect(toastMock).toHaveBeenCalledTimes(1);

    primera.unmount();
    fake.confirmarSalidas();

    act(() => {
      fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff({ id: "handoff-2" }));
    });
    await flush();
    expect(toastMock).toHaveBeenCalledTimes(2);

    segunda.unmount();
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

  describe("aviso a supervisores y admins por demora_sin_asesor (T10b-5, 29/9/2026)", () => {
    it("un supervisor ve el toast con el nombre del contacto y el botón Abrir", async () => {
      fake.setRole("supervisor");
      render(<AssignmentNotifier />);
      await flush();

      act(() => {
        fake.trigger("conversation_handoffs", "INSERT", demoraSinAsesorHandoff());
      });
      await flush();

      expect(toastMock).toHaveBeenCalledTimes(1);
      expect(toastMock).toHaveBeenCalledWith(
        "Nadie atendió una conversación",
        expect.objectContaining({
          description: expect.stringContaining("María Pérez"),
          timeout: 10000,
        })
      );
      const options = toastMock.mock.calls[0][1] as { actionProps: { children: string; onPress: () => void } };
      expect(options.actionProps.children).toBe("Abrir");
      options.actionProps.onPress();
      expect(pushMock).toHaveBeenCalledWith("/inbox?conversation=conv-9");
    });

    it("un admin también lo ve, aunque el traspaso quede sin dueño (to_kind unassigned)", async () => {
      fake.setRole("admin");
      render(<AssignmentNotifier />);
      await flush();

      act(() => {
        fake.trigger(
          "conversation_handoffs",
          "INSERT",
          demoraSinAsesorHandoff({ to_kind: "unassigned", to_id: null })
        );
      });
      await flush();

      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    it("un asesor común NO lo ve, ni siquiera cuando el caso quedó a su nombre", async () => {
      fake.setRole("agent");
      render(<AssignmentNotifier />);
      await flush();

      act(() => {
        fake.trigger("conversation_handoffs", "INSERT", demoraSinAsesorHandoff({ to_id: "agente-1" }));
      });
      await flush();

      expect(toastMock).not.toHaveBeenCalled();
    });

    it("dos instancias montadas a la vez (cruce de section-skeleton) avisan una sola vez", async () => {
      fake.setRole("supervisor");
      render(
        <>
          <AssignmentNotifier />
          <AssignmentNotifier />
        </>
      );
      await flush();

      act(() => {
        fake.trigger("conversation_handoffs", "INSERT", demoraSinAsesorHandoff());
      });
      await flush();

      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    it("si la consulta del nombre falla, igual avisa con el texto neutro", async () => {
      fake.setRole("supervisor");
      fake.setContactFails();
      render(<AssignmentNotifier />);
      await flush();

      act(() => {
        fake.trigger("conversation_handoffs", "INSERT", demoraSinAsesorHandoff());
      });
      await flush();

      expect(toastMock).toHaveBeenCalledTimes(1);
      expect(toastMock).toHaveBeenCalledWith(
        "Nadie atendió una conversación",
        expect.objectContaining({ description: expect.not.stringContaining("María") })
      );
    });

    it("una escalada normal para un supervisor sigue siendo el aviso de asignación de siempre, no este", async () => {
      fake.setRole("supervisor");
      render(<AssignmentNotifier />);
      await flush();

      act(() => {
        fake.trigger("conversation_handoffs", "INSERT", escaladaHandoff());
      });
      await flush();

      expect(toastMock).toHaveBeenCalledTimes(1);
      expect(toastMock.mock.calls[0][0]).toBe("Te asignaron una conversación");
    });

    it("un traspaso demora_sin_asesor cuyo dueño soy yo NO dispara además el aviso de asignación", async () => {
      fake.setRole("supervisor");
      render(<AssignmentNotifier />);
      await flush();

      act(() => {
        fake.trigger("conversation_handoffs", "INSERT", demoraSinAsesorHandoff({ to_id: "agente-1" }));
      });
      await flush();

      expect(toastMock).toHaveBeenCalledTimes(1);
      expect(toastMock.mock.calls[0][0]).toBe("Nadie atendió una conversación");
    });
  });
});
