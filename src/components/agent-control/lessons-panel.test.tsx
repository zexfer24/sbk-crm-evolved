/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LessonsPanel } from "@/components/agent-control/lessons-panel";
import type { Agent, AiLesson } from "@/lib/types";

/**
 * T6, plan "Seba atiende el mostrador" (18/9/2026, requisito 7 del
 * cliente): la lista de "Lecciones de Seba" en Control IA. El backend (T5,
 * ya commiteado) se mockea tal cual sus firmas reales —
 * `setLessonActive(supabase, id, isActive)` y `deleteLesson(supabase, id)`.
 */

const setLessonActiveMock = vi.fn();
const deleteLessonMock = vi.fn();
vi.mock("@/lib/mutations", () => ({
  setLessonActive: (...args: unknown[]) => setLessonActiveMock(...args),
  deleteLesson: (...args: unknown[]) => deleteLessonMock(...args),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ fakeClient: true }) }));

const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { danger: (...a: unknown[]) => dangerToast(...a), success: vi.fn() } };
});

const AGENTE: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

const SUPERVISORA: Agent = {
  id: "agent-2",
  displayName: "Marta",
  fullName: "Marta Supervisora",
  avatarUrl: null,
  role: "supervisor",
  isActive: true,
};

function lesson(overrides: Partial<AiLesson> = {}): AiLesson {
  return {
    id: "lesson-1",
    scope: "global",
    kind: "nota",
    content: 'La Bera SBR también se llama "Sport" entre los clientes.',
    synonymFrom: null,
    synonymTo: null,
    messageId: "msg-1",
    messageExcerpt: "¿tienen para la sport?",
    conversationId: null,
    contactId: "contact-1",
    isActive: true,
    createdBy: "agent-1",
    authorName: "Ana",
    createdAt: "2026-09-18T11:00:00.000Z",
    updatedAt: "2026-09-18T11:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  setLessonActiveMock.mockReset();
  deleteLessonMock.mockReset();
  dangerToast.mockReset();
});

describe("LessonsPanel — lista vacía", () => {
  it("sin lecciones, dice que todavía no hay ninguna", () => {
    render(<LessonsPanel currentAgent={AGENTE} lessons={[]} />);
    expect(screen.getByText("Todavía no hay lecciones")).toBeInTheDocument();
  });
});

describe("LessonsPanel — una nota", () => {
  it("muestra el alcance, el autor, la fecha y el extracto", () => {
    render(<LessonsPanel currentAgent={AGENTE} lessons={[lesson()]} />);

    expect(screen.getByText(/Todos los chats/)).toBeInTheDocument();
    expect(screen.getByText(/Ana/)).toBeInTheDocument();
    expect(screen.getByText('La Bera SBR también se llama "Sport" entre los clientes.')).toBeInTheDocument();
    expect(screen.getByText(/¿tienen para la sport\?/)).toBeInTheDocument();
  });

  it("una lección apagada dice que Seba no la ve", () => {
    render(<LessonsPanel currentAgent={AGENTE} lessons={[lesson({ isActive: false })]} />);
    expect(screen.getByText("Seba no la ve")).toBeInTheDocument();
  });
});

describe("LessonsPanel — un sinónimo", () => {
  it("muestra el par jerga → catálogo en vez del content crudo", () => {
    render(
      <LessonsPanel
        currentAgent={AGENTE}
        lessons={[
          lesson({
            kind: "sinonimo",
            content: "pastilla → pastillas de freno",
            synonymFrom: "pastilla",
            synonymTo: "pastillas de freno",
          }),
        ]}
      />
    );

    expect(screen.getByText("«pastilla» → «pastillas de freno»")).toBeInTheDocument();
  });
});

describe("LessonsPanel — activar/desactivar", () => {
  it("el autor puede apagar su propia lección", async () => {
    render(<LessonsPanel currentAgent={AGENTE} lessons={[lesson({ createdBy: AGENTE.id, isActive: true })]} />);

    fireEvent.click(screen.getByRole("button", { name: /apagar la lección de ana/i }));

    await waitFor(() =>
      expect(setLessonActiveMock).toHaveBeenCalledWith(expect.objectContaining({ fakeClient: true }), "lesson-1", false)
    );
  });

  it("un agente que no es el autor no puede tocar el interruptor", () => {
    render(<LessonsPanel currentAgent={AGENTE} lessons={[lesson({ createdBy: "otro-agente" })]} />);

    expect(screen.getByRole("button", { name: /apagar la lección de ana/i })).toBeDisabled();
  });

  it("un supervisor puede tocar el interruptor aunque no sea el autor", async () => {
    render(<LessonsPanel currentAgent={SUPERVISORA} lessons={[lesson({ createdBy: "otro-agente" })]} />);

    const boton = screen.getByRole("button", { name: /apagar la lección de ana/i });
    expect(boton).not.toBeDisabled();

    fireEvent.click(boton);
    await waitFor(() => expect(setLessonActiveMock).toHaveBeenCalled());
  });
});

describe("LessonsPanel — borrar", () => {
  it("un agente que no es el autor ni supervisor no ve el botón de borrar", () => {
    render(<LessonsPanel currentAgent={AGENTE} lessons={[lesson({ createdBy: "otro-agente" })]} />);
    expect(screen.queryByRole("button", { name: /borrar/i })).not.toBeInTheDocument();
  });

  it("el autor ve el botón y el primer clic pide confirmar antes de borrar de verdad", async () => {
    render(<LessonsPanel currentAgent={AGENTE} lessons={[lesson({ createdBy: AGENTE.id })]} />);

    fireEvent.click(screen.getByRole("button", { name: /^borrar$/i }));
    expect(deleteLessonMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /confirmar/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirmar/i }));
    await waitFor(() =>
      expect(deleteLessonMock).toHaveBeenCalledWith(expect.objectContaining({ fakeClient: true }), "lesson-1")
    );
  });
});

describe("LessonsPanel — onChanged (19/9/2026, T2)", () => {
  /*
   * El panel dependía solo del canal Realtime de `ai_lessons` para verse al
   * día — que se pospone con la pestaña oculta y que calla para siempre si el
   * canal está caído — y el 19/9/2026 eso dejó la base en `is_active = false`
   * con la pantalla diciendo "Activa". `onChanged` es la vía directa: se
   * llama tras una mutación que salió bien, nunca si falló (ese camino ya
   * tiene su propio toast).
   */
  it("tras apagar con éxito, llama a onChanged", async () => {
    setLessonActiveMock.mockResolvedValueOnce(undefined);
    const onChanged = vi.fn();
    render(
      <LessonsPanel
        currentAgent={AGENTE}
        lessons={[lesson({ createdBy: AGENTE.id, isActive: true })]}
        onChanged={onChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /apagar la lección de ana/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(dangerToast).not.toHaveBeenCalled();
  });

  it("si la mutación de apagar falla, NO llama a onChanged y sale el toast de error", async () => {
    setLessonActiveMock.mockRejectedValueOnce(new Error("boom"));
    const onChanged = vi.fn();
    render(
      <LessonsPanel
        currentAgent={AGENTE}
        lessons={[lesson({ createdBy: AGENTE.id, isActive: true })]}
        onChanged={onChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /apagar la lección de ana/i }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("No se pudo cambiar el estado de la lección."));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("tras borrar con éxito, llama a onChanged", async () => {
    deleteLessonMock.mockResolvedValueOnce(undefined);
    const onChanged = vi.fn();
    render(
      <LessonsPanel currentAgent={AGENTE} lessons={[lesson({ createdBy: AGENTE.id })]} onChanged={onChanged} />
    );

    fireEvent.click(screen.getByRole("button", { name: /^borrar$/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(dangerToast).not.toHaveBeenCalled();
  });

  it("si la mutación de borrar falla, NO llama a onChanged y sale el toast de error", async () => {
    deleteLessonMock.mockRejectedValueOnce(new Error("boom"));
    const onChanged = vi.fn();
    render(
      <LessonsPanel currentAgent={AGENTE} lessons={[lesson({ createdBy: AGENTE.id })]} onChanged={onChanged} />
    );

    fireEvent.click(screen.getByRole("button", { name: /^borrar$/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar/i }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("No se pudo borrar la lección."));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
