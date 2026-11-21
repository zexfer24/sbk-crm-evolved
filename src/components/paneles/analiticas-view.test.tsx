/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import { rangosDeAnaliticas } from "@/lib/paneles/rangos";
import type {
  CanalVentas,
  MetaVenta,
  PanelConversaciones,
  PanelVentas,
  PanelVentasActivas,
} from "@/lib/paneles/parse";
import { AnaliticasView, type AnaliticasViewProps } from "@/components/paneles/analiticas-view";

/**
 * Plan "Paneles" (13/11/2026), C5: la pantalla de Analíticas completa con un
 * fixture que respeta `docs/paneles-contrato.md`. jsdom no calcula layout: lo
 * visual (rejilla, sticky, responsive) lo revisa el orquestador en el navegador.
 */

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  usePathname: () => "/panel/analiticas",
  useSearchParams: () => new URLSearchParams("periodo=30d"),
}));
vi.mock("@/components/app-rail", () => ({
  AppRail: () => <nav data-testid="rail" />,
  AppTopNav: () => <nav data-testid="topnav" />,
}));

const AHORA = new Date("2026-11-15T12:00:00-04:00");
const scrollIntoView = vi.fn();

beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
beforeEach(() => {
  scrollIntoView.mockClear();
  replace.mockClear();
  refresh.mockClear();
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function canal(parcial: Partial<CanalVentas>): CanalVentas {
  return { ingresos: 0, envios: 0, unidades: 0, ticket: null, estimados: 0, sin_monto: 0, ...parcial };
}

function ventas(parcial: Partial<PanelVentas> = {}): PanelVentas {
  const serie = [
    { t: "2026-10-17T00:00:00-04:00", online: 100, tienda: 40, envios_online: 2, envios_tienda: 1 },
    { t: "2026-10-18T00:00:00-04:00", online: 300, tienda: 90, envios_online: 3, envios_tienda: 2 },
    { t: "2026-10-19T00:00:00-04:00", online: 400, tienda: 304.5, envios_online: 3, envios_tienda: 2 },
  ];
  return {
    granularidad: "dia",
    canales: {
      online: canal({ ingresos: 800, envios: 8, unidades: 20, ticket: 100 }),
      tienda: canal({ ingresos: 434.5, envios: 5, unidades: 10, ticket: 86.9 }),
    },
    serie,
    perfil_horario: [],
    personas: [
      { agent_id: "a1", nombre: "Ana Pérez", rol: "agent", canal: "online", ingresos: 500, envios: 5, unidades: 12 },
      { agent_id: "c1", nombre: "Caja Uno", rol: "caja", canal: "tienda", ingresos: 434.5, envios: 5, unidades: 10 },
    ],
    top_repuestos: [
      { codprod: "LF09", nombre: "FILTRO DE ACEITE", unidades: 14, ingresos: 280, unidades_online: 9, unidades_tienda: 5 },
      { codprod: "BJ02", nombre: "BUJIA NGK", unidades: 9, ingresos: 90, unidades_online: 2, unidades_tienda: 7 },
    ],
    tipo_precio: { online: { promocion: 6, estandar: 2 }, tienda: { promocion: 1, estandar: 4 } },
    estado: { transito: { envios: 2, monto: 150 }, error: { envios: 1 }, sin_foto: 3, duplicados: 4 },
    recurrentes: {
      online: { compradores: 10, regresan: 4 },
      tienda: { compradores: 30, regresan: 8 },
      genericos_excluidos: 1,
    },
    ...parcial,
  };
}

function conversaciones(parcial: Partial<PanelConversaciones> = {}): BloqueConTope<PanelConversaciones> {
  const calor = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  calor[1][9] = 12; // lunes 9 h
  return {
    ok: true,
    recortado: false,
    dato: {
      embudo: { escribieron: 200, respondidas: 150, con_carrito: 60, compraron: 30 },
      resultados: { compraron: 30, reclamo: 2, carrito_sin_compra: 28, solo_preguntaron: 90, sin_respuesta: 50 },
      conversion: {
        equipo: { atendidas: 40, compraron: 10 },
        personas: [
          { agent_id: "a1", nombre: "Ana Pérez", rol: "agent", atendidas: 30, compraron: 8 },
          { agent_id: null, nombre: "Seba", rol: "ia", atendidas: 10, compraron: 2 },
        ],
      },
      calor: { valores: calor },
      ...parcial,
    },
  };
}

const ACTIVAS: PanelVentasActivas = {
  total: 500,
  presupuestos: { monto: 300, cantidad: 1, sin_precio: 0 },
  carritos: { monto: 200, cantidad: 2, sin_precio: 0 },
  por_canal: { online: { monto: 200, cantidad: 2 }, tienda: { monto: 300, cantidad: 1 } },
  antiguedad: [
    { tramo: "24h", monto: 100, cantidad: 1 },
    { tramo: "3d", monto: 0, cantidad: 0 },
    { tramo: "7d", monto: 200, cantidad: 1 },
    { tramo: "30d", monto: 200, cantidad: 1 },
  ],
  items: [
    { tipo: "presupuesto", id: "p1", canal: "tienda", responsable: "Caja Uno", cliente: "Pedro Gómez", monto: 300, unidades: 3, desde: "2026-10-30T10:00:00-04:00" },
    { tipo: "carrito", id: "c1", canal: "online", responsable: "Ana Pérez", cliente: "Lucía Rojas", monto: 150, unidades: 2, desde: "2026-11-10T10:00:00-04:00" },
    { tipo: "carrito", id: "c2", canal: "online", responsable: "Ana Pérez", cliente: "Mario Díaz", monto: 50, unidades: 1, desde: "2026-11-15T09:00:00-04:00" },
  ],
};

const METAS: MetaVenta[] = [
  { canal: "online", vigente_desde: "2026-10-01", monto_usd: 250 },
  { canal: "tienda", vigente_desde: "2026-10-01", monto_usd: 100 },
];

function ok<T>(dato: T): Bloque<T> {
  return { ok: true, dato };
}

function props(parcial: Partial<AnaliticasViewProps> = {}): AnaliticasViewProps {
  return {
    periodo: "30d",
    vista: "resumen",
    ahora: AHORA,
    rangos: rangosDeAnaliticas("30d", AHORA, null),
    ventas: ok(ventas()),
    ventasPrevio: ok(
      ventas({
        canales: {
          online: canal({ ingresos: 400, envios: 4, unidades: 8, ticket: 100 }),
          tienda: canal({ ingresos: 200, envios: 4, unidades: 6, ticket: 50 }),
        },
        serie: [
          { t: "2026-09-17T00:00:00-04:00", online: 50, tienda: 20, envios_online: 1, envios_tienda: 1 },
          { t: "2026-09-18T00:00:00-04:00", online: 150, tienda: 80, envios_online: 1, envios_tienda: 1 },
          { t: "2026-09-19T00:00:00-04:00", online: 200, tienda: 100, envios_online: 2, envios_tienda: 2 },
        ],
      })
    ),
    conversaciones: conversaciones(),
    conversacionesPrevio: conversaciones(),
    ventasAnio: ok(ventas()),
    ventasUltimos40: ok(
      ventas({
        serie: [
          { t: "2026-11-09T00:00:00-04:00", online: 300, tienda: 100, envios_online: 3, envios_tienda: 1 },
          { t: "2026-11-10T00:00:00-04:00", online: 100, tienda: 20, envios_online: 1, envios_tienda: 1 },
          { t: "2026-11-11T00:00:00-04:00", online: 260, tienda: 120, envios_online: 3, envios_tienda: 2 },
          { t: "2026-11-12T00:00:00-04:00", online: 280, tienda: 90, envios_online: 3, envios_tienda: 1 },
          { t: "2026-11-13T00:00:00-04:00", online: 100, tienda: 30, envios_online: 1, envios_tienda: 1 },
        ],
      })
    ),
    ventasActivas: ok(ACTIVAS),
    metas: ok(METAS),
    horario: DEFAULT_BUSINESS_HOURS,
    tasaBcv: 40,
    ...parcial,
  };
}

function kpi(nombre: string) {
  return screen.getByRole("region", { name: nombre });
}

describe("AnaliticasView · KPI", () => {
  it("pinta Enviado a SAINT, Envíos, Ticket, Conversión y Clientes que regresan con sus cifras", () => {
    render(<AnaliticasView {...props()} />);

    expect(within(kpi("Enviado a SAINT")).getByText("$1.234,50")).toBeInTheDocument();
    expect(within(kpi("Enviado a SAINT")).getByText(/en espera de facturar/i)).toBeInTheDocument();
    expect(within(kpi("Envíos")).getByText("13")).toBeInTheDocument();
    // 1234,50 entre 13 envíos con monto.
    expect(within(kpi("Ticket promedio")).getByText("$94,96")).toBeInTheDocument();
    expect(within(kpi("Tasa de conversión")).getByText("25 %")).toBeInTheDocument();
    expect(within(kpi("Tasa de conversión")).getByText(/10 de 40 conversaciones compraron/)).toBeInTheDocument();
    expect(within(kpi("Clientes que regresan")).getByText("30 %")).toBeInTheDocument();
    expect(within(kpi("Clientes que regresan")).getByText(/12 de 40 ya eran clientes/)).toBeInTheDocument();
  });

  it("un null pinta «—», nunca $0,00", () => {
    const sinMonto = ventas({
      canales: {
        online: canal({ ingresos: null, envios: 2, sin_monto: 2 }),
        tienda: canal({ ingresos: null, envios: 1, sin_monto: 1 }),
      },
    });
    render(<AnaliticasView {...props({ ventas: ok(sinMonto) })} />);
    expect(within(kpi("Enviado a SAINT")).getByText("—")).toBeInTheDocument();
    expect(within(kpi("Ticket promedio")).getByText("—")).toBeInTheDocument();
    expect(within(kpi("Enviado a SAINT")).queryByText("$0,00")).not.toBeInTheDocument();
  });

  it("avisa con un chip «Estimado» y su explicación cuando hay ventas estimadas", () => {
    const conEstimados = ventas();
    conEstimados.canales.online.estimados = 3;
    render(<AnaliticasView {...props({ ventas: ok(conEstimados) })} />);
    const chip = within(kpi("Enviado a SAINT")).getByText("Estimado");
    expect(chip.closest("[title]")).toHaveAttribute("title", expect.stringMatching(/3 .*reconstruyeron/i));
  });

  it("al comparar muestra la variación contra el período anterior", () => {
    render(<AnaliticasView {...props()} />);
    // 1234,50 contra 600 = +105,8 %.
    expect(within(kpi("Enviado a SAINT")).getByText(/\+106 %/)).toBeInTheDocument();
  });
});

describe("AnaliticasView · degradación por bloque", () => {
  it("una lectura caída pinta su degradado y el resto de la pantalla sigue", () => {
    const caido: BloqueConTope<PanelConversaciones> = {
      ok: false,
      motivo: "error",
      detalle: "No se pudo leer las conversaciones.",
      recortado: false,
    };
    render(<AnaliticasView {...props({ conversaciones: caido })} />);

    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No se pudo leer las conversaciones/).length).toBeGreaterThan(0);
    expect(within(kpi("Enviado a SAINT")).getByText("$1.234,50")).toBeInTheDocument();
    expect(document.getElementById("ingresos")).not.toBeNull();
  });
});

describe("AnaliticasView · vista En tienda", () => {
  it("no hay tasa de conversión: «—», su explicación y los envíos por persona", () => {
    render(<AnaliticasView {...props({ vista: "tienda" })} />);

    const conversion = kpi("Tasa de conversión");
    expect(within(conversion).getByText("—")).toBeInTheDocument();
    expect(within(conversion).queryByText(/\d\s?%/)).not.toBeInTheDocument();

    const seccion = document.getElementById("conversion")!;
    expect(within(seccion).getByText(/La caja no registra a quien no compra/)).toBeInTheDocument();
    expect(within(seccion).getByText("Envíos por persona")).toBeInTheDocument();
    expect(within(seccion).getByText("Caja Uno")).toBeInTheDocument();
    expect(within(seccion).queryByText("Atendidas")).not.toBeInTheDocument();

    expect(within(document.getElementById("embudo")!).getByText(/El embudo mide el chat/)).toBeInTheDocument();
  });
});

describe("AnaliticasView · navegación por secciones", () => {
  it("tiene las siete secciones con sus ids", () => {
    render(<AnaliticasView {...props()} />);
    for (const id of ["ingresos", "embudo", "ventas-activas", "unidades", "conversion", "rendimiento", "mensual"]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it("al cargar con #id baja a esa sección y la resalta", () => {
    window.history.replaceState(null, "", "/panel/analiticas#embudo");
    render(<AnaliticasView {...props()} />);
    const seccion = document.getElementById("embudo")!;
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(seccion);
    expect(seccion).toHaveClass("an-flash");
  });

  it("un #id desconocido no rompe nada", () => {
    window.history.replaceState(null, "", "/panel/analiticas#no-existe");
    render(<AnaliticasView {...props()} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("pulsar una sección del menú baja a ella y la deja en la URL", async () => {
    const usuario = userEvent.setup({ delay: null });
    render(<AnaliticasView {...props()} />);
    const menu = screen.getByRole("group", { name: "Ir a una sección" });
    await usuario.click(within(menu).getByRole("button", { name: "Rendimiento" }));
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(document.getElementById("rendimiento"));
    expect(window.location.hash).toBe("#rendimiento");
  });
});

describe("AnaliticasView · comparar con el período anterior", () => {
  it("muestra la serie previa punteada y la oculta al apagar el interruptor", async () => {
    const usuario = userEvent.setup({ delay: null });
    const { container } = render(<AnaliticasView {...props()} />);
    const interruptor = screen.getByRole("button", { name: /Comparar con el período anterior/ });

    expect(interruptor).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".pn-linea--previa")).not.toBeNull();

    await usuario.click(interruptor);
    expect(interruptor).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".pn-linea--previa")).toBeNull();
  });

  it("sin el período anterior no inventa la serie previa", () => {
    const caido: Bloque<PanelVentas> = { ok: false, motivo: "error", detalle: "No se pudo leer las ventas." };
    const { container } = render(<AnaliticasView {...props({ ventasPrevio: caido })} />);
    expect(container.querySelector(".pn-linea--previa")).toBeNull();
  });
});

describe("AnaliticasView · embudo", () => {
  it("los resultados suman el total de los que escribieron", () => {
    render(<AnaliticasView {...props()} />);
    const seccion = document.getElementById("embudo")!;
    const termino = within(seccion).getByRole("region", { name: "En qué terminaron" });
    const suma = within(termino)
      .getAllByRole("listitem")
      .reduce((total, li) => total + Number(li.querySelector("b")!.textContent!.replace(/\D/g, "")), 0);
    expect(suma).toBe(200);
    expect(within(seccion).getByText(/200 conversaciones/)).toBeInTheDocument();
  });

  it("calcula la frase y las caídas entre pasos", () => {
    render(<AnaliticasView {...props()} />);
    const seccion = document.getElementById("embudo")!;
    expect(within(seccion).getByText("De cada 100 que escribieron, 45 solo preguntaron y 15 compraron.")).toBeInTheDocument();
    expect(within(seccion).getByText(/−50 · 25 %/)).toBeInTheDocument();
  });
});

describe("AnaliticasView · ventas activas", () => {
  it("filtra por tipo", async () => {
    const usuario = userEvent.setup({ delay: null });
    render(<AnaliticasView {...props()} />);
    const seccion = document.getElementById("ventas-activas")!;
    expect(within(seccion).getByText("Pedro Gómez")).toBeInTheDocument();
    expect(within(seccion).getByText("Lucía Rojas")).toBeInTheDocument();

    await usuario.click(within(seccion).getByRole("button", { name: "Carritos" }));
    expect(within(seccion).queryByText("Pedro Gómez")).not.toBeInTheDocument();
    expect(within(seccion).getByText("Lucía Rojas")).toBeInTheDocument();
  });
});

describe("AnaliticasView · rendimiento", () => {
  it("marca cada día cumplida o no con la meta vigente y calcula la racha", () => {
    render(<AnaliticasView {...props()} />);
    const seccion = document.getElementById("rendimiento")!;
    // Meta del resumen: 350. Lun 400 ✓, mar 120 ✗, mié 380 ✓, jue 370 ✓, vie (hoy es sáb 14 → pasó) 130 ✗.
    const dias = within(seccion).getAllByRole("listitem");
    expect(dias.length).toBe(5);
    expect(within(seccion).getAllByLabelText(/Meta cumplida/).length).toBe(3);
    expect(within(seccion).getAllByLabelText(/No se cumplió/).length).toBe(2);
    expect(within(within(seccion).getByLabelText("Racha")).getByText("0")).toBeInTheDocument();
  });

  it("sin metas explica cómo definirla en vez de pintar un calendario vacío", () => {
    render(<AnaliticasView {...props({ metas: ok([]) })} />);
    expect(within(document.getElementById("rendimiento")!).getByText(/Todavía no hay una meta diaria/)).toBeInTheDocument();
  });
});

describe("AnaliticasView · tipo de precio, repuestos y mes a mes", () => {
  it("muestra promoción contra estándar por canal y el top de repuestos de la vista", () => {
    render(<AnaliticasView {...props({ vista: "online" })} />);
    const seccion = document.getElementById("unidades")!;
    expect(within(seccion).getByText("Tipo de precio")).toBeInTheDocument();
    expect(within(seccion).getByText("FILTRO DE ACEITE")).toBeInTheDocument();
    // En Online cuentan solo las unidades online.
    expect(within(within(seccion).getByRole("table")).getByText("9")).toBeInTheDocument();
  });

  it("el año se agrupa por mes y ya no habla del 26/10/2026", () => {
    render(<AnaliticasView {...props()} />);
    const seccion = document.getElementById("mensual")!;
    expect(within(seccion).getByText("En curso")).toBeInTheDocument();
    expect(within(seccion).queryByText(/26\/10\/2026/)).toBeNull();
  });

  it("la tabla arranca en el primer mes con envíos: de enero a septiembre no hay filas en $0,00", () => {
    // 15/11/2026: los envíos del fixture empiezan en octubre. Enero a septiembre no tienen registro, no son «cero ventas».
    render(<AnaliticasView {...props()} />);
    const seccion = document.getElementById("mensual")!;
    const filas = within(within(seccion).getByRole("table")).getAllByRole("row").slice(1);
    expect(filas.map((f) => within(f).getAllByRole("rowheader")[0].textContent)).toEqual(["Octubre", "Noviembre En curso"]);
    for (const mes of ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre"]) {
      expect(within(seccion).queryByRole("rowheader", { name: new RegExp(mes) })).toBeNull();
    }
    // Sin piso no hay nota de inicio (la explica el piso, ver piso-en-pantalla.test.tsx).
    expect(within(seccion).queryByText(/la tabla empieza en/i)).toBeNull();
  });

  it("sin ningún envío en el año, dice que todavía no hay envíos en vez de pintar doce meses en cero", () => {
    render(<AnaliticasView {...props({ ventasAnio: ok(ventas({ serie: [] })) })} />);
    const seccion = document.getElementById("mensual")!;
    expect(within(seccion).getByText(/Todavía no hay envíos a SAINT este año/)).toBeInTheDocument();
    expect(within(seccion).queryByRole("table")).toBeNull();
    expect(within(seccion).queryByText(/26\/10\/2026/)).toBeNull();
  });
});

describe("AnaliticasView · mapa de calor", () => {
  it("muestra las horas de atención con los mensajes del cliente por día y hora", () => {
    render(<AnaliticasView {...props()} />);
    const mapa = within(document.getElementById("embudo")!).getByRole("table", { name: /Cuándo escriben/ });
    // 08:00–17:00 son 10 columnas de horas.
    expect(within(mapa).getAllByRole("columnheader").length).toBe(1 + 10);
    expect(within(mapa).getByTitle(/Lunes.*9:00.*12 mensajes/)).toBeInTheDocument();
  });
});
