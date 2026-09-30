/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogSearchesPanel } from "@/components/agent-control/catalog-searches-panel";
import type {
  Agent,
  AiLesson,
  CatalogSearchQuery,
  CatalogSearchTurn,
  SearchSummary,
  SearchTerms,
} from "@/lib/types";

/**
 * Pestaña «Búsquedas» de Control IA (T9, plan "Seba no cotiza lo que no es",
 * 30/9/2026). Los tres fetchers y la mutación se mockean con sus firmas
 * reales; lo que se prueba es la pantalla: el resumen, los filtros, la fila
 * expandible (v2 completa y v1 con «—»), «Abrir chat», «Enseñar sinónimo»
 * con el término precargado y «No corregir esta palabra».
 */

const fetchCatalogSearchesMock = vi.fn();
const fetchSearchSummaryMock = vi.fn();
const fetchSearchTermsMock = vi.fn();
vi.mock("@/lib/data", () => ({
  fetchCatalogSearches: (...args: unknown[]) => fetchCatalogSearchesMock(...args),
  fetchSearchSummary: (...args: unknown[]) => fetchSearchSummaryMock(...args),
  fetchSearchTerms: (...args: unknown[]) => fetchSearchTermsMock(...args),
}));

const protectWordMock = vi.fn();
const createLessonMock = vi.fn();
vi.mock("@/lib/mutations", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mutations")>();
  return {
    ...real,
    protectWordFromCorrection: (...args: unknown[]) => protectWordMock(...args),
    createLesson: (...args: unknown[]) => createLessonMock(...args),
  };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ fakeClient: true }) }));

const successToast = vi.fn();
const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: { success: (...a: unknown[]) => successToast(...a), danger: (...a: unknown[]) => dangerToast(...a) },
  };
});

const AGENTE: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function consulta(overrides: Partial<CatalogSearchQuery> = {}): CatalogSearchQuery {
  return {
    version: 2,
    query: "visera casco",
    productos: null,
    terminos: ["visera", "casco"],
    moto: [],
    variantes: [],
    relajados: [],
    avisos: [],
    corregido: [],
    correccionDescartada: [],
    decision: "moto SBR calza: cotizó 1 de 5",
    cotizados: [{ productId: "p1", nombre: "VISERA LS2 FUMÉ", stock: 3, precioUsd: 8 }],
    conteos: { calzan: 5, conStock: 2, nombranMoto: 1, universales: 0 },
    motoIgnorada: false,
    calzaEntero: true,
    resultado: "con_existencia",
    ...overrides,
  };
}

/** Una fila v1 (28/9, sin `v`): todo lo de A2 en null. */
function consultaV1(overrides: Partial<CatalogSearchQuery> = {}): CatalogSearchQuery {
  return consulta({
    version: 1,
    query: "pastilla freno",
    terminos: ["pastilla", "freno"],
    variantes: null,
    relajados: null,
    avisos: null,
    correccionDescartada: null,
    decision: null,
    cotizados: null,
    conteos: null,
    motoIgnorada: null,
    calzaEntero: null,
    resultado: "sin_resultados",
    ...overrides,
  });
}

function turno(id: string, consultas: CatalogSearchQuery[], overrides: Partial<CatalogSearchTurn> = {}): CatalogSearchTurn {
  return {
    id,
    conversationId: `conv-${id}`,
    contactName: "Ana Pérez",
    createdAt: "2026-09-30T15:00:00.000Z",
    customerMessage: "necesito una visera",
    action: "answered",
    escalationReason: null,
    consultas,
    ...overrides,
  };
}

const RESUMEN: SearchSummary = {
  turnos: 5,
  busquedas: 6,
  v1: 2,
  resultados: { con_existencia: 2, agotados: 1, generico: 1, sin_resultados: 2, sin_terminos: 0, error: 0 },
  avisos: {
    universales: 1,
    moto_sin_calce: 0,
    relajado: 1,
    relajado_agotado: 0,
    variante_agotada: 1,
    varias_opciones: 1,
  },
  correcciones: 2,
  descartadas: 1,
  relajos: 1,
  relajosCotizaron: 1,
  cotizaciones: 3,
  productosDistintos: 2,
};

const TERMINOS: SearchTerms = {
  sinCalce: [{ termino: "freno", sinResultados: 4, relajado: 1, ultima: "2026-09-30T10:00:00+00:00" }],
  correcciones: [
    {
      original: "iphone",
      corregido: "ipone",
      veces: 3,
      conExistencia: 2,
      agotados: 1,
      sinResultados: 0,
      otros: 0,
      ultima: "2026-09-30T11:00:00+00:00",
    },
  ],
};

function lesson(overrides: Partial<AiLesson> = {}): AiLesson {
  return {
    id: "l1",
    scope: "global",
    kind: "no_corregir",
    content: "No corregir «iphone»",
    synonymFrom: "iphone",
    synonymTo: null,
    messageId: null,
    messageExcerpt: null,
    conversationId: null,
    contactId: null,
    isActive: true,
    createdBy: "agent-1",
    authorName: "Ana",
    createdAt: "2026-09-30T09:00:00.000Z",
    updatedAt: "2026-09-30T09:00:00.000Z",
    ...overrides,
  };
}

function usuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function renderPanel(props: Partial<Parameters<typeof CatalogSearchesPanel>[0]> = {}) {
  return render(<CatalogSearchesPanel currentAgent={AGENTE} lessons={[]} refreshToken={0} {...props} />);
}

/** Los tres turnos del caso: una v2 con relajo y aviso, una v1 y una lista con corrección. */
function turnosDeEjemplo(): CatalogSearchTurn[] {
  return [
    turno(
      "t2",
      [
        consulta({
          resultado: "con_existencia",
          relajados: ["semi"],
          avisos: [
            { tipo: "relajado", productoPedido: null, detalle: "semi" },
            { tipo: "universales", productoPedido: null, detalle: "bera" },
          ],
          correccionDescartada: [{ original: "vicera", corregido: "visera" }],
        }),
      ],
      { customerMessage: "necesito una visera semi", contactName: "Luis Gómez", action: "escalated", escalationReason: "confirmar_inventario" }
    ),
    turno("t1", [consultaV1()], { customerMessage: "tienen pastillas de freno", contactName: "Marta Ruiz" }),
    turno(
      "t3",
      [
        consulta({
          query: "aceite iphone",
          productos: ["aceite iphone", "guantes"],
          terminos: ["aceite", "ipone"],
          corregido: [{ original: "iphone", corregido: "ipone" }],
          resultado: "agotados",
          cotizados: [],
        }),
      ],
      { customerMessage: "aceite iphone y guantes", contactName: "Pedro" }
    ),
  ];
}

beforeEach(() => {
  fetchCatalogSearchesMock.mockReset().mockResolvedValue(turnosDeEjemplo());
  fetchSearchSummaryMock.mockReset().mockResolvedValue(RESUMEN);
  fetchSearchTermsMock.mockReset().mockResolvedValue(TERMINOS);
  protectWordMock.mockReset().mockResolvedValue(undefined);
  createLessonMock.mockReset().mockResolvedValue(undefined);
  successToast.mockReset();
  dangerToast.mockReset();
});

describe("CatalogSearchesPanel — bloque A, el resumen", () => {
  it("pinta los conteos de la RPC y avisa cuántas búsquedas del período son anteriores a A2", async () => {
    renderPanel();

    const resumen = await screen.findByRole("region", { name: "Resumen del período" });
    expect(within(resumen).getByText("Búsquedas")).toBeInTheDocument();
    expect(within(resumen).getByTestId("stat-busquedas")).toHaveTextContent("6");
    expect(within(resumen).getByTestId("stat-con_existencia")).toHaveTextContent("2");
    expect(within(resumen).getByTestId("stat-sin_resultados")).toHaveTextContent("2");
    expect(within(resumen).getByTestId("stat-aviso-universales")).toHaveTextContent("1");
    expect(within(resumen).getByTestId("stat-correcciones")).toHaveTextContent("2");
    expect(within(resumen).getByTestId("stat-descartadas")).toHaveTextContent("1");
    expect(within(resumen).getByTestId("stat-relajos")).toHaveTextContent("1");
    expect(within(resumen).getByTestId("stat-cotizaciones")).toHaveTextContent("3");
    expect(within(resumen).getByTestId("stat-productos")).toHaveTextContent("2");
    expect(screen.getByText(/2 búsquedas del período son anteriores a A2/)).toBeInTheDocument();
  });

  it("arranca en «Hoy» y al cambiar de período vuelve a pedir el resumen con otro `desde`", async () => {
    const user = usuario();
    renderPanel();
    await screen.findByRole("region", { name: "Resumen del período" });

    expect(screen.getByRole("button", { name: "Hoy" })).toHaveAttribute("aria-pressed", "true");
    const primero = fetchSearchSummaryMock.mock.calls[0][1] as string;

    await user.click(screen.getByRole("button", { name: "7 días" }));

    await waitFor(() => expect(fetchSearchSummaryMock).toHaveBeenCalledTimes(2));
    const segundo = fetchSearchSummaryMock.mock.calls[1][1] as string;
    expect(new Date(segundo).getTime()).toBeLessThan(new Date(primero).getTime());
    expect(screen.getByRole("button", { name: "7 días" })).toHaveAttribute("aria-pressed", "true");
    // La lista sigue el mismo período.
    expect(fetchCatalogSearchesMock.mock.calls[1][1]).toMatchObject({ desde: segundo });
  });

  it("si la RPC responde null (no es agente) o falla, no pinta ceros: dice que no se pudo cargar", async () => {
    fetchSearchSummaryMock.mockRejectedValue({ code: "57014", message: "statement timeout" });
    renderPanel();

    expect(await screen.findByText(/No se pudo cargar el resumen/)).toBeInTheDocument();
    expect(screen.queryByTestId("stat-busquedas")).not.toBeInTheDocument();
  });

  it("si la función todavía no está en la base (PGRST202), lo dice con el nombre de la migración", async () => {
    fetchSearchSummaryMock.mockRejectedValue({ code: "PGRST202", message: "no encontrada" });
    renderPanel();

    expect(await screen.findByText(/20260930060000/)).toBeInTheDocument();
  });
});

describe("CatalogSearchesPanel — bloque B, la lista", () => {
  it("lista los turnos con lo que pidió el cliente, el resultado y las marcas de cada búsqueda", async () => {
    renderPanel();

    expect(await screen.findByText("necesito una visera semi")).toBeInTheDocument();
    expect(screen.getByText("tienen pastillas de freno")).toBeInTheDocument();
    expect(screen.getByText("aceite iphone y guantes")).toBeInTheDocument();
    expect(screen.getByText("Luis Gómez")).toBeInTheDocument();
  });

  it("al expandir una fila v2 muestra el corrector, el relajo, la decisión con sus conteos, lo cotizado, los avisos y el motivo de la escalada", async () => {
    const user = usuario();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /necesito una visera semi/ }));

    const detalle = screen.getByRole("region", { name: "Detalle de la búsqueda" });
    expect(within(detalle).getByText("visera casco")).toBeInTheDocument();
    expect(within(detalle).getByText("moto SBR calza: cotizó 1 de 5")).toBeInTheDocument();
    expect(within(detalle).getByText(/calzan 5/)).toBeInTheDocument();
    expect(within(detalle).getByText(/VISERA LS2 FUMÉ/)).toBeInTheDocument();
    expect(within(detalle).getByText(/vicera → visera/)).toBeInTheDocument(); // corrección descartada
    expect(within(detalle).getByText("semi")).toBeInTheDocument(); // relajado
    expect(within(detalle).getByText("Universales: bera")).toBeInTheDocument(); // aviso con su detalle
    expect(within(detalle).getByText("confirmar_inventario")).toBeInTheDocument();
  });

  it("una fila v1 se lee igual: lo que no registra se pinta «—» y no aparece como «ninguno»", async () => {
    const user = usuario();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /tienen pastillas de freno/ }));

    const detalle = screen.getByRole("region", { name: "Detalle de la búsqueda" });
    expect(within(detalle).getByText("pastilla freno")).toBeInTheDocument();
    expect(within(detalle).getByTestId("campo-decision")).toHaveTextContent("—");
    expect(within(detalle).getByTestId("campo-avisos")).toHaveTextContent("—");
    expect(within(detalle).getByTestId("campo-relajo")).toHaveTextContent("—");
    expect(within(detalle).getByTestId("campo-cotizado")).toHaveTextContent("—");
    expect(within(detalle).getByTestId("campo-conteos")).toHaveTextContent("—");
    expect(within(detalle).getByTestId("campo-descartada")).toHaveTextContent("—");
    expect(within(detalle).getByText(/anterior a A2/)).toBeInTheDocument();
    expect(within(detalle).getByTestId("campo-avisos")).not.toHaveTextContent(/ninguno/i);
  });

  it("una fila v2 SIN avisos dice «ninguno» (se registró y no hubo), no «—»", async () => {
    const user = usuario();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /aceite iphone y guantes/ }));

    const detalle = screen.getByRole("region", { name: "Detalle de la búsqueda" });
    expect(within(detalle).getByTestId("campo-avisos")).toHaveTextContent(/ninguno/i);
    expect(within(detalle).getByTestId("campo-cotizado")).toHaveTextContent(/nada/i);
  });

  it("filtra por resultado y por «Con corrección»", async () => {
    const user = usuario();
    renderPanel();
    await screen.findByText("necesito una visera semi");

    await user.selectOptions(screen.getByLabelText("Filtrar por resultado"), "agotados");
    expect(screen.queryByText("necesito una visera semi")).not.toBeInTheDocument();
    expect(screen.getByText("aceite iphone y guantes")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filtrar por resultado"), "todos");
    await user.click(screen.getByRole("button", { name: "Con corrección" }));
    expect(screen.getByText("aceite iphone y guantes")).toBeInTheDocument();
    expect(screen.queryByText("tienen pastillas de freno")).not.toBeInTheDocument();
  });

  it("filtra por aviso, por «Relajadas», por «Listas» y por texto libre; «Limpiar filtros» los quita", async () => {
    const user = usuario();
    renderPanel();
    await screen.findByText("necesito una visera semi");

    await user.selectOptions(screen.getByLabelText("Filtrar por aviso"), "universales");
    expect(screen.getByText("necesito una visera semi")).toBeInTheDocument();
    expect(screen.queryByText("tienen pastillas de freno")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filtrar por aviso"), "todos");

    await user.click(screen.getByRole("button", { name: "Relajadas" }));
    expect(screen.getByText("necesito una visera semi")).toBeInTheDocument();
    expect(screen.queryByText("aceite iphone y guantes")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Relajadas" }));

    await user.click(screen.getByRole("button", { name: "Listas" }));
    expect(screen.getByText("aceite iphone y guantes")).toBeInTheDocument();
    expect(screen.queryByText("necesito una visera semi")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Listas" }));

    await user.type(screen.getByLabelText("Buscar en las búsquedas"), "MARTA");
    expect(screen.getByText("tienen pastillas de freno")).toBeInTheDocument();
    expect(screen.queryByText("necesito una visera semi")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    expect(screen.getByText("necesito una visera semi")).toBeInTheDocument();
  });

  it("si ningún turno pasa los filtros lo dice, sin confundirlo con «no hay búsquedas»", async () => {
    const user = usuario();
    renderPanel();
    await screen.findByText("necesito una visera semi");

    await user.type(screen.getByLabelText("Buscar en las búsquedas"), "zzzz");

    expect(screen.getByText("Ningún turno pasa esos filtros")).toBeInTheDocument();
  });

  it("sin turnos en el período, lo dice", async () => {
    fetchCatalogSearchesMock.mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText("No hay búsquedas en este período")).toBeInTheDocument();
  });

  it("«Abrir chat» lleva a la conversación del turno", async () => {
    const user = usuario();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /necesito una visera semi/ }));

    expect(screen.getByRole("link", { name: "Abrir chat" })).toHaveAttribute("href", "/inbox?conversation=conv-t2");
  });

  it("«Enseñar sinónimo» abre el modal con el primer término que no calzó y alcance global", async () => {
    const user = usuario();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /necesito una visera semi/ }));
    await user.click(screen.getByRole("button", { name: "Enseñar sinónimo" }));

    // El término relajado («semi») ya viene escrito; el tipo es sinónimo y el alcance, todos los chats.
    expect(await screen.findByLabelText("Cómo lo dice el cliente")).toHaveValue("semi");
    expect(screen.getByRole("button", { name: "Sinónimo de búsqueda" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Todos los chats" })).toHaveAttribute("aria-pressed", "true");

    await user.type(screen.getByLabelText("Cómo se llama en el catálogo"), "sintetico");
    await user.click(screen.getByRole("button", { name: /guardar/i }));

    await waitFor(() => expect(createLessonMock).toHaveBeenCalled());
    expect(createLessonMock.mock.calls[0][2]).toMatchObject({
      scope: "global",
      kind: "sinonimo",
      synonymFrom: "semi",
      synonymTo: "sintetico",
      messageId: null,
    });
  });
});

describe("CatalogSearchesPanel — bloque C, lo que Seba no encuentra", () => {
  it("lista los términos con cuántas veces no calzaron y ofrece «Enseñar sinónimo» con el término precargado", async () => {
    const user = usuario();
    renderPanel();

    const bloque = await screen.findByRole("region", { name: "Lo que Seba no encuentra" });
    expect(within(bloque).getByText("freno")).toBeInTheDocument();
    expect(within(bloque).getByText(/4 sin resultados/)).toBeInTheDocument();
    expect(within(bloque).getByText(/1 relajado/)).toBeInTheDocument();

    await user.click(within(bloque).getByRole("button", { name: "Enseñar sinónimo de freno" }));

    expect(await screen.findByLabelText("Cómo lo dice el cliente")).toHaveValue("freno");
    // Sin chat de origen: no hay «Solo este chat» que ofrecer.
    expect(screen.queryByRole("button", { name: "Solo este chat" })).not.toBeInTheDocument();
  });

  it("sin términos, lo dice", async () => {
    fetchSearchTermsMock.mockResolvedValue({ sinCalce: [], correcciones: [] });
    renderPanel();

    const bloque = await screen.findByRole("region", { name: "Lo que Seba no encuentra" });
    expect(within(bloque).getByText(/Nada por ahora/)).toBeInTheDocument();
  });
});

describe("CatalogSearchesPanel — bloque D, las correcciones", () => {
  it("lista original → corregido con las veces y en qué terminó cada una", async () => {
    renderPanel();

    const bloque = await screen.findByRole("region", { name: "Correcciones" });
    expect(within(bloque).getByText("iphone → ipone")).toBeInTheDocument();
    expect(within(bloque).getByText(/3 veces/)).toBeInTheDocument();
    expect(within(bloque).getByText(/2 con existencia/)).toBeInTheDocument();
    expect(within(bloque).getByText(/1 agotado/)).toBeInTheDocument();
  });

  it("«No corregir esta palabra» protege el original, avisa y refresca las lecciones", async () => {
    const user = usuario();
    const onLessonsChanged = vi.fn();
    renderPanel({ onLessonsChanged });

    const bloque = await screen.findByRole("region", { name: "Correcciones" });
    await user.click(within(bloque).getByRole("button", { name: "No corregir esta palabra" }));

    await waitFor(() => expect(protectWordMock).toHaveBeenCalledWith(expect.objectContaining({ fakeClient: true }), AGENTE, "iphone"));
    expect(successToast).toHaveBeenCalled();
    expect(onLessonsChanged).toHaveBeenCalled();
  });

  it("si la base rechaza el guardado, avisa con un toast de error y no refresca", async () => {
    protectWordMock.mockRejectedValueOnce(new Error("sin conexión"));
    const user = usuario();
    const onLessonsChanged = vi.fn();
    renderPanel({ onLessonsChanged });

    const bloque = await screen.findByRole("region", { name: "Correcciones" });
    await user.click(within(bloque).getByRole("button", { name: "No corregir esta palabra" }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalled());
    expect(onLessonsChanged).not.toHaveBeenCalled();
  });

  it("una palabra ya protegida (lección no_corregir activa) muestra «Protegida» y no ofrece el botón", async () => {
    renderPanel({ lessons: [lesson()] });

    const bloque = await screen.findByRole("region", { name: "Correcciones" });
    expect(within(bloque).getByText("Protegida")).toBeInTheDocument();
    expect(within(bloque).queryByRole("button", { name: "No corregir esta palabra" })).not.toBeInTheDocument();
  });

  it("una lección no_corregir APAGADA no cuenta como protección: el botón sigue ahí", async () => {
    renderPanel({ lessons: [lesson({ isActive: false })] });

    const bloque = await screen.findByRole("region", { name: "Correcciones" });
    expect(within(bloque).getByRole("button", { name: "No corregir esta palabra" })).toBeInTheDocument();
  });
});

describe("CatalogSearchesPanel — refresco", () => {
  it("cuando cambia refreshToken vuelve a pedir el resumen, la lista y los términos", async () => {
    const { rerender } = renderPanel({ refreshToken: 0 });
    await screen.findByRole("region", { name: "Resumen del período" });
    expect(fetchSearchSummaryMock).toHaveBeenCalledTimes(1);
    expect(fetchSearchTermsMock).toHaveBeenCalledTimes(1);

    rerender(<CatalogSearchesPanel currentAgent={AGENTE} lessons={[]} refreshToken={1} />);

    await waitFor(() => expect(fetchSearchSummaryMock).toHaveBeenCalledTimes(2));
    expect(fetchCatalogSearchesMock).toHaveBeenCalledTimes(2);
    expect(fetchSearchTermsMock).toHaveBeenCalledTimes(2);
  });
});
