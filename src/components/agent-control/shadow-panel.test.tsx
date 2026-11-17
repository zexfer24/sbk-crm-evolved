/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShadowPanel } from "@/components/agent-control/shadow-panel";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import type { Agent } from "@/lib/types";
import { sombraResumenFromRow, type EjeDePreparacion, type ShadowDraft, type ShadowReview, type SombraResumen } from "@/lib/shadow";

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
const fetchSombraResumenMock = vi.fn();
vi.mock("@/lib/shadow-data", () => ({
  fetchShadowDrafts: (...args: unknown[]) => fetchShadowDraftsMock(...args),
  fetchShadowReviews: (...args: unknown[]) => fetchShadowReviewsMock(...args),
  fetchAdvisorFollowups: (...args: unknown[]) => fetchAdvisorFollowupsMock(...args),
  fetchShadowSpendToday: (...args: unknown[]) => fetchShadowSpendTodayMock(...args),
  fetchSombraResumen: (...args: unknown[]) => fetchSombraResumenMock(...args),
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

/** El resumen de la RPC `sombra_resumen`, ya mapeado, con los tres ejes a medida. */
function resumen(
  ejes: Partial<Record<EjeDePreparacion, [number, number, number, number]>> = {},
  consumo: Record<string, unknown> = {}
): SombraResumen {
  const eje = (nombre: EjeDePreparacion) => {
    const [poblacion, revisados, reprobados, cambiosMenores] = ejes[nombre] ?? [0, 0, 0, 0];
    return { eje: nombre, poblacion, revisados, reprobados, cambios_menores: cambiosMenores };
  };
  const out = sombraResumenFromRow({
    consumo: {
      dias: [
        { dia: "2026-11-17", borradores: 12, input_tokens: 1_200_000, output_tokens: 300_000, cached_input_tokens: 0, costo_usd: 3.5 },
        { dia: "2026-11-16", borradores: 8, input_tokens: 800_000, output_tokens: 200_000, cached_input_tokens: 0, costo_usd: null },
      ],
      total: { borradores: 20, input_tokens: 2_000_000, output_tokens: 500_000, cached_input_tokens: 0, costo_usd: 3.5, sin_tarifa: 0 },
      hoy_usd: 3.5,
      tope_usd: 5,
      muestreo_pct: 100,
      ...consumo,
    },
    preparacion: {
      ejes: [eje("busqueda"), eje("conversacion"), eje("pago")],
      senales: { total: 20, con_guardas: 2, pasarian_a_asesor: 3, sin_mensajes: 1 },
    },
  });
  if (!out) throw new Error("el resumen de prueba debía mapear");
  return out;
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
  fetchSombraResumenMock.mockReset().mockResolvedValue(resumen());
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

// ----------------- Preparación para desplegar y consumo (P1, 17/11/2026) -----------------

describe("ShadowPanel — preparación para desplegar", () => {
  it("pinta los tres ejes con su porcentaje, sus revisados y el número general (el menor)", async () => {
    fetchSombraResumenMock.mockResolvedValue(
      resumen({ busqueda: [40, 35, 3, 2], conversacion: [100, 50, 5, 1], pago: [12, 10, 1, 0] })
    );
    await montar();

    const bloque = await screen.findByRole("region", { name: "Preparación para desplegar" });
    // (35-3)/35 = 91; (50-5)/50 = 90; (10-1)/10 = 90.
    expect(within(bloque).getByTestId("prep-eje-busqueda")).toHaveTextContent("Búsqueda de repuestos");
    expect(within(bloque).getByTestId("prep-eje-busqueda")).toHaveTextContent("91 %");
    expect(within(bloque).getByTestId("prep-eje-busqueda")).toHaveTextContent("35 revisados de 40");
    expect(within(bloque).getByTestId("prep-eje-conversacion")).toHaveTextContent("Conversación");
    expect(within(bloque).getByTestId("prep-eje-conversacion")).toHaveTextContent("90 %");
    expect(within(bloque).getByTestId("prep-eje-conversacion")).toHaveTextContent("50 revisados de 100");
    expect(within(bloque).getByTestId("prep-eje-pago")).toHaveTextContent("Montos y pago");
    expect(within(bloque).getByTestId("prep-eje-pago")).toHaveTextContent("90 %");

    expect(within(bloque).getByTestId("prep-general")).toHaveTextContent("90 %");
    expect(within(bloque).getByTestId("prep-motivo")).toHaveTextContent(
      "Los tres ejes llegan al 90 %: lista para el siguiente escalón"
    );
  });

  it("cada barra es un medidor accesible con el porcentaje en su nombre y la marca del 90 %", async () => {
    fetchSombraResumenMock.mockResolvedValue(
      resumen({ busqueda: [40, 35, 3, 2], conversacion: [100, 50, 5, 1], pago: [12, 10, 1, 0] })
    );
    await montar();

    const medidor = await screen.findByRole("meter", { name: "Búsqueda de repuestos: 91 %" });
    expect(medidor).toHaveAttribute("aria-valuenow", "91");
    expect(medidor).toHaveAttribute("aria-valuemin", "0");
    expect(medidor).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getAllByRole("meter")).toHaveLength(3);
    expect(within(medidor).getByTestId("prep-marca-90")).toBeInTheDocument();
  });

  it("con revisiones que faltan: «—» en el general, el motivo con lo que falta y los ejes con su «faltan K»", async () => {
    fetchSombraResumenMock.mockResolvedValue(
      resumen({ busqueda: [40, 12, 0, 0], conversacion: [100, 30, 1, 0], pago: [8, 3, 0, 0] })
    );
    await montar();

    expect(await screen.findByTestId("prep-general")).toHaveTextContent("—");
    expect(screen.getByTestId("prep-general")).not.toHaveTextContent("%");
    expect(screen.getByTestId("prep-motivo")).toHaveTextContent("Faltan revisiones: búsqueda 12 de 30, pago 3 de 10");

    expect(screen.getByTestId("prep-eje-busqueda")).toHaveTextContent("faltan 18 revisiones");
    expect(screen.getByTestId("prep-eje-pago")).toHaveTextContent("faltan 7 revisiones");
    expect(screen.getByTestId("prep-eje-conversacion")).not.toHaveTextContent("faltan");
    // Un eje con su mínimo pinta su porcentaje aunque el general no exista.
    expect(screen.getByTestId("prep-eje-conversacion")).toHaveTextContent("97 %");
    // Uno sin el mínimo no inventa porcentaje (el 100 % de 12 casos sería mentira).
    expect(screen.getByTestId("prep-eje-busqueda")).toHaveTextContent("—");
    expect(screen.getByTestId("prep-eje-busqueda")).not.toHaveTextContent("100 %");
  });

  it("sin ninguna revisión no hay 0 % ni 100 %: «—» en todo y la línea fija de que la sombra no aprende sola", async () => {
    await montar();

    const bloque = await screen.findByRole("region", { name: "Preparación para desplegar" });
    expect(within(bloque).getByTestId("prep-general")).toHaveTextContent("—");
    expect(within(bloque).queryByText(/\b0 %/)).not.toBeInTheDocument();
    expect(within(bloque).getByTestId("prep-eje-pago")).toHaveTextContent("todavía no hubo ningún borrador con pago");
    expect(bloque).toHaveTextContent(
      "Este número sale de las revisiones de los supervisores. La sombra no aprende sola: mejora cuando una corrección se convierte en lección o en un ajuste del guion."
    );
  });

  it("las señales automáticas, sin revisión", async () => {
    await montar();

    const senales = await screen.findByTestId("prep-senales");
    expect(senales).toHaveTextContent("2 con guardas");
    expect(senales).toHaveTextContent("3 pasarían a un asesor");
    expect(senales).toHaveTextContent("1 sin mensajes");
  });

  it("un general por debajo del umbral nombra el eje más flojo", async () => {
    fetchSombraResumenMock.mockResolvedValue(
      resumen({ busqueda: [40, 30, 0, 0], conversacion: [100, 30, 0, 0], pago: [12, 10, 2, 0] })
    );
    await montar();

    expect(await screen.findByTestId("prep-general")).toHaveTextContent("80 %");
    expect(screen.getByTestId("prep-motivo")).toHaveTextContent(
      "El eje más flojo es Montos y pago (80 %): todavía no llega al 90 %"
    );
  });
});

describe("ShadowPanel — consumo", () => {
  it("pinta hoy contra el tope, el total del período, el costo por borrador y el promedio diario", async () => {
    await montar();

    const bloque = await screen.findByRole("region", { name: "Consumo" });
    expect(within(bloque).getByTestId("stat-gasto")).toHaveTextContent("$0,42 de $2,00");
    expect(within(bloque).getByTestId("consumo-borradores")).toHaveTextContent("20");
    expect(within(bloque).getByTestId("consumo-costo")).toHaveTextContent("$3,50");
    expect(within(bloque).getByTestId("consumo-tokens")).toHaveTextContent("2.000.000");
    expect(within(bloque).getByTestId("consumo-tokens")).toHaveTextContent("500.000");
    expect(within(bloque).getByTestId("consumo-por-borrador")).toHaveTextContent("$0,175");
    // 3,50 USD repartidos en 2 días con borradores.
    expect(within(bloque).getByTestId("consumo-promedio")).toHaveTextContent("$1,75");
  });

  it("la tabla por día: del más reciente al más viejo, con tokens con separador de miles y «—» en un día sin tarifa", async () => {
    await montar();

    const tabla = await screen.findByRole("table", { name: "Consumo por día" });
    const filas = within(tabla).getAllByRole("row");
    // Encabezado + 2 días.
    expect(filas).toHaveLength(3);
    expect(filas[1]).toHaveTextContent("17 nov");
    expect(filas[1]).toHaveTextContent("12");
    expect(filas[1]).toHaveTextContent("1.200.000");
    expect(filas[1]).toHaveTextContent("300.000");
    expect(filas[1]).toHaveTextContent("$3,50");
    expect(filas[2]).toHaveTextContent("16 nov");
    expect(filas[2]).toHaveTextContent("—");
    expect(filas[2]).not.toHaveTextContent("$0,00");
  });

  it("la tabla va en un contenedor con su propio scroll horizontal, enfocable con teclado", async () => {
    await montar();

    const tabla = await screen.findByRole("table", { name: "Consumo por día" });
    const contenedor = tabla.closest(".ac-sh-table-scroll") as HTMLElement;
    expect(contenedor).not.toBeNull();
    expect(contenedor).toHaveAttribute("tabindex", "0");
  });

  it("avisa de los borradores sin tarifa: no suman costo y el tope no los frena", async () => {
    fetchSombraResumenMock.mockResolvedValue(
      resumen({}, { total: { borradores: 20, input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, costo_usd: 3.5, sin_tarifa: 3 } })
    );
    await montar();

    expect(await screen.findByTestId("consumo-aviso-sin-tarifa")).toHaveTextContent(
      "3 borradores sin tarifa: el modelo no tiene fila en model_pricing, su costo no se cuenta y el tope no los frena"
    );
  });

  it("con un solo borrador sin tarifa, el aviso va en singular; sin ninguno, no hay aviso", async () => {
    fetchSombraResumenMock.mockResolvedValue(
      resumen({}, { total: { borradores: 20, input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, costo_usd: 3.5, sin_tarifa: 1 } })
    );
    await montar();
    expect(await screen.findByTestId("consumo-aviso-sin-tarifa")).toHaveTextContent("1 borrador sin tarifa:");
  });

  it("sin borradores sin tarifa no hay aviso", async () => {
    await montar();
    await screen.findByRole("region", { name: "Consumo" });
    expect(screen.queryByTestId("consumo-aviso-sin-tarifa")).not.toBeInTheDocument();
  });

  it("la proyección al 100 % de muestreo aparece solo si el muestreo es menor que 100", async () => {
    fetchSombraResumenMock.mockResolvedValue(resumen({}, { muestreo_pct: 20 }));
    await montar();

    // 1,75 por día con el 20 % de las conversaciones: al 100 % serían 8,75.
    expect(await screen.findByTestId("consumo-proyeccion")).toHaveTextContent(
      "Al 100 % de muestreo serían ≈ $8,75 por día"
    );
  });

  it("con el muestreo al 100 % no hay proyección que mostrar", async () => {
    await montar();
    await screen.findByRole("region", { name: "Consumo" });
    expect(screen.queryByTestId("consumo-proyeccion")).not.toBeInTheDocument();
  });

  it("con muestreo 0 tampoco hay proyección (no se puede dividir)", async () => {
    fetchSombraResumenMock.mockResolvedValue(resumen({}, { muestreo_pct: 0 }));
    await montar();
    await screen.findByRole("region", { name: "Consumo" });
    expect(screen.queryByTestId("consumo-proyeccion")).not.toBeInTheDocument();
  });

  it("sin borradores en el período lo dice y no pinta una tabla vacía", async () => {
    fetchSombraResumenMock.mockResolvedValue(
      resumen(
        {},
        { dias: [], total: { borradores: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, costo_usd: 0, sin_tarifa: 0 } }
      )
    );
    await montar();

    expect(await screen.findByText("Sin borradores en este período.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Consumo por día" })).not.toBeInTheDocument();
    expect(screen.getByTestId("consumo-por-borrador")).toHaveTextContent("—");
  });
});

describe("ShadowPanel — el resumen no se pudo leer", () => {
  it("resumen null (falta la migración): «No disponible» con el nombre de la migración, en los dos bloques", async () => {
    fetchSombraResumenMock.mockResolvedValue(null);
    await montar();

    const avisos = await screen.findAllByText("No disponible: falta aplicar la migración 20261117020000");
    expect(avisos).toHaveLength(2);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    // Lo que no depende del resumen sigue: los borradores y el gasto de hoy.
    expect(screen.getByTestId("stat-gasto")).toHaveTextContent("$0,42 de $2,00");
  });

  it("un error de lectura se avisa y se puede reintentar", async () => {
    fetchSombraResumenMock.mockRejectedValueOnce({ code: "57014" });
    await montar();

    const bloque = await screen.findByRole("region", { name: "Preparación para desplegar" });
    expect(await within(bloque).findByRole("alert")).toHaveTextContent(/No se pudo cargar la preparación y el consumo/);
    await userEvent.setup().click(within(bloque).getByRole("button", { name: "Reintentar" }));
    expect(await screen.findAllByRole("meter")).toHaveLength(3);
  });

  it("cambiar el período vuelve a pedir el resumen, con el rango nuevo", async () => {
    await montar();
    await waitFor(() => expect(fetchSombraResumenMock).toHaveBeenCalled());
    const antes = fetchSombraResumenMock.mock.calls.length;
    const primero = fetchSombraResumenMock.mock.calls[0];
    expect(primero[0]).toBe(FAKE_CLIENT);
    expect(primero[1]).toEqual({ desde: expect.any(String), hasta: expect.any(String) });
    expect(new Date(primero[1].hasta).getTime()).toBeGreaterThan(new Date(primero[1].desde).getTime());

    await userEvent.setup().click(screen.getByRole("button", { name: "30 días" }));
    await waitFor(() => expect(fetchSombraResumenMock.mock.calls.length).toBeGreaterThan(antes));
    const ultimo = fetchSombraResumenMock.mock.calls.at(-1);
    // 30 días hacia atrás empieza antes que el «hoy» del primer pedido.
    expect(new Date(ultimo?.[1].desde).getTime()).toBeLessThan(new Date(primero[1].desde).getTime());
  });
});
