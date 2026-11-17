/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SebaSuggestion } from "@/components/chat/seba-suggestion";
import type { Agent } from "@/lib/types";
import type { ShadowDraft } from "@/lib/shadow";

/**
 * La tarjeta de la sugerencia de copiloto (entrega 3 de Seba v2, 17/11/2026).
 * Lo central: «Enviar» resuelve la sugerencia PRIMERO y solo manda los textos si
 * ganó la carrera contra otro asesor.
 */

const calls: string[] = [];
const resolveSuggestionMock = vi.fn();
vi.mock("@/lib/mutations", () => ({
  resolveSuggestion: (...args: unknown[]) => {
    calls.push(`resolve:${String(args[3])}`);
    return resolveSuggestionMock(...args);
  },
}));

const FAKE_CLIENT = { fakeClient: true };
vi.mock("@/lib/supabase/client", () => ({ createClient: () => FAKE_CLIENT }));

const warningToast = vi.fn();
const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: { warning: (...a: unknown[]) => warningToast(...a), danger: (...a: unknown[]) => dangerToast(...a) },
  };
});

const AGENTE: Agent = {
  id: "ase-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function draft(overrides: Partial<ShadowDraft> = {}): ShadowDraft {
  return {
    id: "d1",
    conversationId: "c1",
    modo: "copiloto",
    triggerMessageId: null,
    rafaga: ["hola"],
    mensajes: [
      { orden: 2, tipo: "texto", texto: "¿Para qué moto es?", origen: "modelo", mediaUrl: null },
      { orden: 1, tipo: "texto", texto: "Claro, tenemos *pastillas*.", origen: "modelo", mediaUrl: null },
    ],
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
    createdAt: "2026-11-17T15:00:00.000Z",
    ...overrides,
  };
}

const onSend = vi.fn((texts: string[]) => {
  void texts;
  calls.push("send");
});
const onEdit = vi.fn();
const onResolved = vi.fn();

function montar(props: { draft?: ShadowDraft; editing?: boolean } = {}) {
  render(
    <SebaSuggestion
      draft={props.draft ?? draft()}
      agent={AGENTE}
      editing={props.editing ?? false}
      onSend={onSend}
      onEdit={onEdit}
      onResolved={onResolved}
    />
  );
}

beforeEach(() => {
  calls.length = 0;
  resolveSuggestionMock.mockReset().mockResolvedValue(true);
  onSend.mockClear();
  onEdit.mockClear();
  onResolved.mockClear();
  warningToast.mockClear();
  dangerToast.mockClear();
});

describe("SebaSuggestion — lo que se ve", () => {
  it("es una región con nombre, con los mensajes en orden y con formato de WhatsApp", () => {
    montar();

    const region = screen.getByRole("region", { name: "Sugerencia de Seba" });
    expect(region).toBeInTheDocument();
    const burbujas = region.querySelectorAll(".sbk-sug-bubble");
    expect(burbujas).toHaveLength(2);
    expect(burbujas[0]).toHaveTextContent("Claro, tenemos pastillas.");
    expect(burbujas[0].querySelector("strong")).toHaveTextContent("pastillas");
    expect(burbujas[1]).toHaveTextContent("¿Para qué moto es?");
  });

  it("ofrece Enviar, Editar y Descartar", () => {
    montar();

    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Editar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeEnabled();
  });
});

describe("SebaSuggestion — Enviar", () => {
  it("resuelve «enviada» PRIMERO y solo después manda los textos, en orden", async () => {
    montar();

    await userEvent.setup().click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(resolveSuggestionMock).toHaveBeenCalledWith(FAKE_CLIENT, AGENTE, "d1", "enviada");
    expect(onSend).toHaveBeenCalledWith(["Claro, tenemos *pastillas*.", "¿Para qué moto es?"]);
    expect(calls).toEqual(["resolve:enviada", "send"]);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("si otro asesor ya la usó (resolveSuggestion da false) NO envía nada, avisa y la tarjeta se va", async () => {
    resolveSuggestionMock.mockResolvedValue(false);
    montar();

    await userEvent.setup().click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(warningToast).toHaveBeenCalledWith("Otro asesor ya usó esta sugerencia"));
    expect(onSend).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("si la base falla NO envía, avisa y la tarjeta se queda para reintentar", async () => {
    resolveSuggestionMock.mockRejectedValue(new Error("red"));
    montar();

    await userEvent.setup().click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled();
  });

  it("un doble clic no resuelve dos veces", async () => {
    let release: (value: boolean) => void = () => {};
    resolveSuggestionMock.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    montar();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    release(true);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(resolveSuggestionMock).toHaveBeenCalledTimes(1);
  });
});

describe("SebaSuggestion — Editar y Descartar", () => {
  it("Editar carga los textos unidos con una línea en blanco y NO resuelve nada todavía", async () => {
    montar();

    await userEvent.setup().click(screen.getByRole("button", { name: "Editar" }));

    expect(onEdit).toHaveBeenCalledWith("Claro, tenemos *pastillas*.\n\n¿Para qué moto es?");
    expect(resolveSuggestionMock).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("en estado editando no ofrece Enviar ni Editar: dice dónde está el texto y deja Descartar", () => {
    montar({ editing: true });

    expect(screen.queryByRole("button", { name: "Enviar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(screen.getByText(/Editando en el cuadro de mensaje/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeInTheDocument();
  });

  it("Descartar resuelve «descartada» y quita la tarjeta", async () => {
    montar();

    await userEvent.setup().click(screen.getByRole("button", { name: "Descartar" }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(resolveSuggestionMock).toHaveBeenCalledWith(FAKE_CLIENT, AGENTE, "d1", "descartada");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("si Descartar falla avisa y la tarjeta se queda", async () => {
    resolveSuggestionMock.mockRejectedValue(new Error("red"));
    montar();

    await userEvent.setup().click(screen.getByRole("button", { name: "Descartar" }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalled());
    expect(onResolved).not.toHaveBeenCalled();
  });
});

describe("SebaSuggestion — un pase a un asesor", () => {
  const pase = () =>
    draft({
      escalaria: true,
      area: "pagos",
      nota: "El cliente mandó el comprobante",
      mensajes: [{ orden: 1, tipo: "texto", texto: "Un asesor te confirma el pago", origen: "fijo", mediaUrl: null }],
    });

  it("no tiene botón Enviar (ni Editar) y dice a dónde pasaría el caso", () => {
    montar({ draft: pase() });

    expect(screen.queryByRole("button", { name: "Enviar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(screen.getByText("Seba pasaría este caso a Pagos: El cliente mandó el comprobante")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeInTheDocument();
  });

  it("sin nota ni área, igual lo dice", () => {
    montar({ draft: { ...pase(), area: null, nota: null } });

    expect(screen.getByText("Seba pasaría este caso a un asesor.")).toBeInTheDocument();
  });
});

describe("SebaSuggestion — sin nada que enviar", () => {
  it("una sugerencia sin textos (solo fotos sin pie) no ofrece Enviar y lo explica", () => {
    montar({
      draft: draft({ mensajes: [{ orden: 1, tipo: "imagen", texto: null, origen: "herramienta", mediaUrl: "u" }] }),
    });

    expect(screen.queryByRole("button", { name: "Enviar" })).not.toBeInTheDocument();
    expect(screen.getByText(/no trae texto para enviar/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeInTheDocument();
  });
});
