/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShadowPanel } from "@/components/agent-control/shadow-panel";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import type { Agent } from "@/lib/types";
import type { ShadowDraft, ShadowReview } from "@/lib/shadow";

/**
 * Pestaña «Sombra» de Control IA (entrega 3 de Seba v2, 17/11/2026). Las
 * lecturas y la mutación se mockean con sus firmas reales; lo que se prueba es
 * la pantalla: cabecera con números, filtros, la fila que abre las tres
 * columnas y el formulario de revisión.
 */

const fetchShadowDraftsMock = vi.fn();
const fetchShadowReviewsMock = vi.fn();
const fetchAdvisorFollowupsMock = vi.fn();
const fetchShadowSpendTodayMock = vi.fn();
vi.mock("@/lib/shadow-data", () => ({
  fetchShadowDrafts: (...args: unknown[]) => fetchShadowDraftsMock(...args),
  fetchShadowReviews: (...args: unknown[]) => fetchShadowReviewsMock(...args),
  fetchAdvisorFollowups: (...args: unknown[]) => fetchAdvisorFollowupsMock(...args),
  fetchShadowSpendToday: (...args: unknown[]) => fetchShadowSpendTodayMock(...args),
}));

const saveShadowReviewMock = vi.fn();
vi.mock("@/lib/mutations", () => ({
  saveShadowReview: (...args: unknown[]) => saveShadowReviewMock(...args),
}));

const FAKE_CLIENT = { fakeClient: true };
vi.mock("@/lib/supabase/client", () => ({ createClient: () => FAKE_CLIENT }));

const successToast = vi.fn();
const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: { success: (...a: unknown[]) => successToast(...a), danger: (...a: unknown[]) => dangerToast(...a) },
  };
});

const SUPERVISOR: Agent = {
  id: "sup-1",
  displayName: "Rosa",
  fullName: "Rosa Pérez",
  avatarUrl: null,
  role: "supervisor",
  isActive: true,
};

function draft(id: string, overrides: Partial<ShadowDraft> = {}): ShadowDraft {
  return {
    id,
    conversationId: `conv-${id}`,
    modo: "sombra",
    triggerMessageId: null,
    rafaga: [`Mensaje del cliente ${id}`],
    mensajes: [{ orden: 1, tipo: "texto", texto: `Respuesta de Seba ${id}`, origen: "modelo", mediaUrl: null }],
    herramientas: [],
    productos: [],
    escalaria: false,
    motivo: null,
    area: null,
    nota: null,
    guardas: [],
    model: "gpt-x",
    inputTokens: 100,
    outputTokens: 20,
    llamadas: 2,
    durationMs: 3000,
    sugerenciaEstado: null,
    sugerenciaResueltaPor: null,
    sugerenciaResueltaAt: null,
    createdAt: "2026-11-17T15:00:00.000Z",
    ...overrides,
  };
}

function review(draftId: string, veredicto: ShadowReview["veredicto"]): ShadowReview {
  return { draftId, veredicto, errorTipo: null, correccion: null, destino: null, reviewedBy: "sup-1", reviewedAt: "2026-11-17T16:00:00.000Z" };
}

const DRAFTS = [
  draft("d1", { durationMs: 2000 }),
  draft("d2", {
    modo: "copiloto",
    sugerenciaEstado: "pendiente",
    escalaria: true,
    area: "pagos",
    motivo: "comprobante",
    nota: "Mandó el pago móvil",
    durationMs: 4000,
    guardas: [{ guarda: "identidad", fragmento: "soy un asistente" }],
  }),
  draft("d3", { durationMs: 6000 }),
];

beforeEach(() => {
  fetchShadowDraftsMock.mockReset().mockResolvedValue(DRAFTS);
  fetchShadowReviewsMock.mockReset().mockResolvedValue([review("d1", "igual"), review("d3", "no")]);
  fetchAdvisorFollowupsMock.mockReset().mockResolvedValue({ messages: [], minutesToFirst: null });
  fetchShadowSpendTodayMock.mockReset().mockResolvedValue(0.42);
  saveShadowReviewMock.mockReset().mockResolvedValue(undefined);
  successToast.mockReset();
  dangerToast.mockReset();
});

async function montar(props: Partial<React.ComponentProps<typeof ShadowPanel>> = {}) {
  render(<ShadowPanel currentAgent={SUPERVISOR} dailyCapUsd={2} {...props} />);
  await screen.findByText("Mensaje del cliente d1");
}

describe("ShadowPanel — cabecera y lista", () => {
  it("pinta los números del período: borradores, revisados, aprobación, mediana y gasto contra el tope", async () => {
    await montar();

    expect(screen.getByTestId("stat-borradores")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-revisados")).toHaveTextContent("2");
    // Un «igual» y un «no»: la mitad.
    expect(screen.getByTestId("stat-aprobacion")).toHaveTextContent("50 %");
    expect(screen.getByTestId("stat-mediana")).toHaveTextContent("4,0 s");
    expect(screen.getByTestId("stat-gasto")).toHaveTextContent("$0,42 de $2,00");
  });

  it("lo que no se pudo leer se pinta «—», nunca un cero", async () => {
    fetchShadowReviewsMock.mockResolvedValue([]);
    fetchShadowSpendTodayMock.mockResolvedValue(null);
    await montar({ dailyCapUsd: null });

    expect(screen.getByTestId("stat-aprobacion")).toHaveTextContent("—");
    expect(screen.getByTestId("stat-gasto")).toHaveTextContent("—");
  });

  it("pide los borradores del período elegido y las revisiones de esos ids", async () => {
    await montar();

    expect(fetchShadowDraftsMock).toHaveBeenCalledWith(FAKE_CLIENT, expect.objectContaining({ desde: expect.any(String) }));
    expect(fetchShadowReviewsMock).toHaveBeenCalledWith(FAKE_CLIENT, ["d1", "d2", "d3"]);

    const antes = fetchShadowDraftsMock.mock.calls.length;
    await userEvent.setup().click(screen.getByRole("button", { name: "30 días" }));
    await waitFor(() => expect(fetchShadowDraftsMock.mock.calls.length).toBeGreaterThan(antes));
  });

  it("cada fila trae la primera línea de la ráfaga y sus etiquetas", async () => {
    await montar();

    const fila = screen.getByText("Mensaje del cliente d2").closest("li") as HTMLElement;
    expect(within(fila).getByText("Copiloto")).toBeInTheDocument();
    expect(within(fila).getByText("Pasaría a Pagos")).toBeInTheDocument();
    expect(within(fila).getByText("identidad")).toBeInTheDocument();

    const revisada = screen.getAllByText("Mensaje del cliente d1")[0].closest("li") as HTMLElement;
    expect(within(revisada).getByText("Igual")).toBeInTheDocument();
    expect(within(revisada).getByText("Sombra")).toBeInTheDocument();
  });

  it("sin borradores, el estado vacío dice qué hacer", async () => {
    fetchShadowDraftsMock.mockResolvedValue([]);
    render(<ShadowPanel currentAgent={SUPERVISOR} dailyCapUsd={2} />);

    expect(
      await screen.findByText("Todavía no hay borradores. Seba v2 los guarda cuando el modo es Sombra o Copiloto.")
    ).toBeInTheDocument();
  });

  it("si la lectura falla, avisa y ofrece reintentar", async () => {
    fetchShadowDraftsMock.mockRejectedValueOnce({ code: "PGRST205" });
    render(<ShadowPanel currentAgent={SUPERVISOR} dailyCapUsd={2} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudieron cargar los borradores/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Mensaje del cliente d1")).toBeInTheDocument();
  });
});

describe("ShadowPanel — filtros", () => {
  it("veredicto «Sin revisar» deja solo el borrador sin revisión", async () => {
    await montar();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Filtrar por veredicto"), "sin_revisar");

    expect(screen.getByText("Mensaje del cliente d2")).toBeInTheDocument();
    expect(screen.queryByText("Mensaje del cliente d1")).not.toBeInTheDocument();
    expect(screen.queryByText("Mensaje del cliente d3")).not.toBeInTheDocument();
  });

  it("veredicto «No» deja solo el revisado con «no»", async () => {
    await montar();
    await userEvent.setup().selectOptions(screen.getByLabelText("Filtrar por veredicto"), "no");

    expect(screen.getByText("Mensaje del cliente d3")).toBeInTheDocument();
    expect(screen.queryByText("Mensaje del cliente d1")).not.toBeInTheDocument();
  });

  it("«Pasaría a un asesor»: sí / no", async () => {
    await montar();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Filtrar por pase a un asesor"), "si");
    expect(screen.getByText("Mensaje del cliente d2")).toBeInTheDocument();
    expect(screen.queryByText("Mensaje del cliente d1")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filtrar por pase a un asesor"), "no");
    expect(screen.queryByText("Mensaje del cliente d2")).not.toBeInTheDocument();
    expect(screen.getByText("Mensaje del cliente d1")).toBeInTheDocument();
  });

  it("área y guarda", async () => {
    await montar();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Filtrar por área"), "pagos");
    expect(screen.getAllByRole("listitem").filter((li) => li.classList.contains("ac-sh-row"))).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText("Filtrar por área"), "todas");
    await user.selectOptions(screen.getByLabelText("Filtrar por guarda"), "identidad");
    expect(screen.getByText("Mensaje del cliente d2")).toBeInTheDocument();
    expect(screen.queryByText("Mensaje del cliente d1")).not.toBeInTheDocument();
  });

  it("un filtro que no deja nada lo dice y «Limpiar filtros» devuelve la lista", async () => {
    await montar();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Filtrar por área"), "envios");
    expect(screen.getByText("Ningún borrador pasa esos filtros")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    expect(screen.getByText("Mensaje del cliente d1")).toBeInTheDocument();
  });
});

describe("ShadowPanel — un borrador abierto", () => {
  async function abrir(id: string) {
    const user = userEvent.setup();
    await user.click(screen.getByText(`Mensaje del cliente ${id}`).closest("button") as HTMLElement);
    return user;
  }

  it("muestra las tres columnas: lo que escribió el cliente, lo que habría enviado Seba y lo que contestó el asesor", async () => {
    fetchAdvisorFollowupsMock.mockResolvedValue({
      messages: [
        { id: "m1", content: "Hola, claro que sí", messageType: "text", createdAt: "2026-11-17T15:04:30.000Z" },
        { id: "m2", content: "¿Para qué moto?", messageType: "text", createdAt: "2026-11-17T15:05:00.000Z" },
      ],
      minutesToFirst: 4.5,
    });
    fetchShadowDraftsMock.mockResolvedValue([
      draft("d2", {
        modo: "copiloto",
        rafaga: ["Hola", "¿Tienen pastillas?"],
        mensajes: [
          { orden: 1, tipo: "texto", texto: "Claro, ¿para qué moto?", origen: "modelo", mediaUrl: null },
          { orden: 2, tipo: "texto", texto: "Los precios los confirma un asesor.", origen: "fijo", mediaUrl: null },
        ],
        herramientas: ["buscarRepuesto"],
        escalaria: true,
        area: "pagos",
        motivo: "comprobante",
        nota: "Mandó el pago móvil",
      }),
    ]);
    fetchShadowReviewsMock.mockResolvedValue([]);
    render(<ShadowPanel currentAgent={SUPERVISOR} dailyCapUsd={2} />);
    await screen.findByText("Hola");
    await userEvent.setup().click(screen.getByText("Hola").closest("button") as HTMLElement);

    const cliente = await screen.findByRole("region", { name: "Lo que escribió el cliente" });
    expect(within(cliente).getByText("Hola")).toBeInTheDocument();
    expect(within(cliente).getByText("¿Tienen pastillas?")).toBeInTheDocument();

    const seba = screen.getByRole("region", { name: "Lo que habría enviado Seba" });
    expect(within(seba).getByText("Claro, ¿para qué moto?")).toBeInTheDocument();
    expect(within(seba).getByText("Los precios los confirma un asesor.")).toBeInTheDocument();
    expect(within(seba).getByText("modelo")).toBeInTheDocument();
    expect(within(seba).getByText("fijo")).toBeInTheDocument();
    expect(within(seba).getByText("buscarRepuesto")).toBeInTheDocument();
    expect(within(seba).getByText(/Pasaría el caso a Pagos/)).toBeInTheDocument();
    expect(within(seba).getByText(/comprobante/)).toBeInTheDocument();
    expect(within(seba).getByText(/Mandó el pago móvil/)).toBeInTheDocument();

    const asesor = await screen.findByRole("region", { name: "Lo que contestó el asesor" });
    expect(await within(asesor).findByText("Hola, claro que sí")).toBeInTheDocument();
    expect(within(asesor).getByText("¿Para qué moto?")).toBeInTheDocument();
    expect(within(asesor).getByText(/4,5 min/)).toBeInTheDocument();
    expect(fetchAdvisorFollowupsMock).toHaveBeenCalledWith(FAKE_CLIENT, "conv-d2", "2026-11-17T15:00:00.000Z");
  });

  it("si el asesor todavía no contestó, lo dice", async () => {
    await montar();
    await abrir("d1");

    const asesor = await screen.findByRole("region", { name: "Lo que contestó el asesor" });
    expect(await within(asesor).findByText("El asesor todavía no contestó")).toBeInTheDocument();
  });

  it("una imagen del borrador se pinta como foto con su pie, y la guarda disparada con su fragmento", async () => {
    fetchShadowDraftsMock.mockResolvedValue([
      draft("d9", {
        mensajes: [{ orden: 1, tipo: "imagen", texto: "Así se ve", origen: "herramienta", mediaUrl: "https://x/y.jpg" }],
        guardas: [{ guarda: "identidad", fragmento: "soy un asistente" }],
      }),
    ]);
    fetchShadowReviewsMock.mockResolvedValue([]);
    render(<ShadowPanel currentAgent={SUPERVISOR} dailyCapUsd={2} />);
    await userEvent.setup().click((await screen.findByText("Mensaje del cliente d9")).closest("button") as HTMLElement);

    const seba = await screen.findByRole("region", { name: "Lo que habría enviado Seba" });
    expect(within(seba).getByText("Foto")).toBeInTheDocument();
    expect(within(seba).getByText("Así se ve")).toBeInTheDocument();
    expect(within(seba).getByText(/soy un asistente/)).toBeInTheDocument();
  });
});

describe("ShadowPanel — formulario de revisión", () => {
  async function abrirSinRevisar() {
    fetchShadowReviewsMock.mockResolvedValue([]);
    await montar();
    const user = userEvent.setup();
    await user.click(screen.getByText("Mensaje del cliente d1").closest("button") as HTMLElement);
    return user;
  }

  it("«No» sin tipo de error ni corrección no guarda y marca los dos campos", async () => {
    const user = await abrirSinRevisar();

    await user.click(screen.getByRole("radio", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Guardar revisión" }));

    expect(saveShadowReviewMock).not.toHaveBeenCalled();
    expect(screen.getByText("Elige qué tipo de error fue.")).toBeInTheDocument();
    expect(screen.getByText("Escribe cómo debió responder Seba.")).toBeInTheDocument();
  });

  it("sin veredicto tampoco guarda", async () => {
    const user = await abrirSinRevisar();

    await user.click(screen.getByRole("button", { name: "Guardar revisión" }));

    expect(saveShadowReviewMock).not.toHaveBeenCalled();
    expect(screen.getByText("Elige un veredicto.")).toBeInTheDocument();
  });

  it("guardar llama a saveShadowReview con el payload correcto, avisa y deja la fila marcada", async () => {
    const user = await abrirSinRevisar();

    await user.click(screen.getByRole("radio", { name: "No" }));
    await user.selectOptions(screen.getByLabelText("Tipo de error"), "precio");
    await user.type(screen.getByLabelText("Corrección"), "El precio era $12");
    await user.selectOptions(screen.getByLabelText("Destino de la corrección"), "leccion");
    await user.click(screen.getByRole("button", { name: "Guardar revisión" }));

    await waitFor(() =>
      expect(saveShadowReviewMock).toHaveBeenCalledWith(FAKE_CLIENT, SUPERVISOR, "d1", {
        veredicto: "no",
        errorTipo: "precio",
        correccion: "El precio era $12",
        destino: "leccion",
      })
    );
    expect(successToast).toHaveBeenCalledWith("Revisión guardada.");

    const fila = screen.getAllByText("Mensaje del cliente d1")[0].closest("li") as HTMLElement;
    // La etiqueta de la fila dice «No» (el radio del formulario también, por eso se mira dentro de la cabecera).
    expect(within(fila.querySelector(".ac-sh-row-head") as HTMLElement).getByText("No")).toBeInTheDocument();
  });

  it("«Igual» guarda sin pedir nada más", async () => {
    const user = await abrirSinRevisar();

    await user.click(screen.getByRole("radio", { name: "Igual" }));
    await user.click(screen.getByRole("button", { name: "Guardar revisión" }));

    await waitFor(() =>
      expect(saveShadowReviewMock).toHaveBeenCalledWith(FAKE_CLIENT, SUPERVISOR, "d1", {
        veredicto: "igual",
        errorTipo: null,
        correccion: null,
        destino: null,
      })
    );
  });

  it("la corrección lleva contador y se pasa en rojo de 2000", async () => {
    const user = await abrirSinRevisar();
    await user.click(screen.getByRole("radio", { name: "Cambio menor" }));

    expect(screen.getByTestId("contador-correccion")).toHaveTextContent("0 / 2000");
    const campo = screen.getByLabelText("Corrección");
    await user.click(campo);
    await user.paste("x".repeat(2001));
    expect(screen.getByTestId("contador-correccion")).toHaveTextContent("2001 / 2000");
    expect(screen.getByTestId("contador-correccion")).toHaveAttribute("data-over", "true");

    await user.selectOptions(screen.getByLabelText("Tipo de error"), "tono");
    await user.click(screen.getByRole("button", { name: "Guardar revisión" }));
    expect(saveShadowReviewMock).not.toHaveBeenCalled();
    expect(screen.getByText(/no puede pasar de 2000 caracteres/)).toBeInTheDocument();
  });

  it("un error de permiso muestra el mensaje de la RLS en un toast y no marca la fila", async () => {
    saveShadowReviewMock.mockRejectedValue(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    const user = await abrirSinRevisar();

    await user.click(screen.getByRole("radio", { name: "Igual" }));
    await user.click(screen.getByRole("button", { name: "Guardar revisión" }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto."));
    expect(successToast).not.toHaveBeenCalled();
    const fila = screen.getAllByText("Mensaje del cliente d1")[0].closest("li") as HTMLElement;
    expect(within(fila.querySelector(".ac-sh-row-head") as HTMLElement).queryByText("Igual")).not.toBeInTheDocument();
  });

  it("un borrador ya revisado abre el formulario con lo guardado", async () => {
    fetchShadowReviewsMock.mockResolvedValue([
      { ...review("d1", "cambio_menor"), errorTipo: "tono", correccion: "Más cálido", destino: "prompt" },
    ]);
    await montar();
    await userEvent.setup().click(screen.getByText("Mensaje del cliente d1").closest("button") as HTMLElement);

    expect(screen.getByRole("radio", { name: "Cambio menor" })).toBeChecked();
    expect(screen.getByLabelText("Tipo de error")).toHaveValue("tono");
    expect(screen.getByLabelText("Corrección")).toHaveValue("Más cálido");
    expect(screen.getByLabelText("Destino de la corrección")).toHaveValue("prompt");
  });
});
