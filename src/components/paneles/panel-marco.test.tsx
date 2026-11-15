/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BUSINESS_NAME } from "@/lib/brand";
import { ControlPeriodo, ControlVista, PanelBloque, PanelMarco } from "@/components/paneles/panel-marco";

/**
 * Plan "Paneles" (13/11/2026), C3: el marco común de los tres paneles.
 * Lo que importa de verdad (y jsdom no puede medir como layout, pero sí como
 * árbol): el grid `.dash-frame` tiene DOS columnas, así que `AppRail` + `main`
 * son sus ÚNICOS hijos directos (trampa del FRAGMENTO, CLAUDE.md 9/9/2026).
 */

const replace = vi.fn();
const refresh = vi.fn();
let parametros = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  usePathname: () => "/panel",
  useSearchParams: () => parametros,
}));

// El rail real monta un canal de realtime y consulta al agente; acá basta un
// único nodo que diga si recibió `verPaneles` y cuál sección está activa.
vi.mock("@/components/app-rail", () => ({
  AppRail: ({ active, verPaneles }: { active: string; verPaneles?: boolean }) => (
    <nav data-testid="rail" data-active={active} data-ver-paneles={String(Boolean(verPaneles))} />
  ),
  AppTopNav: ({ active, verPaneles }: { active: string; verPaneles?: boolean }) => (
    <nav data-testid="topnav" data-active={active} data-ver-paneles={String(Boolean(verPaneles))} />
  ),
}));

const AHORA = new Date("2026-11-13T18:30:00-04:00");

beforeEach(() => {
  replace.mockClear();
  refresh.mockClear();
  parametros = new URLSearchParams();
});

describe("PanelMarco", () => {
  it("entrega AppRail y main como únicos hijos directos de .dash-frame", () => {
    const { container } = render(
      <PanelMarco panel="dashboard" titulo="Dashboard de ventas" ahora={AHORA} periodo="hoy">
        <p>contenido</p>
      </PanelMarco>
    );
    const frame = container.querySelector(".dash > .dash-frame");
    expect(frame).not.toBeNull();
    expect(frame!.childElementCount).toBe(2);
    expect(frame!.children[0]).toBe(screen.getByTestId("rail"));
    expect(frame!.children[1].tagName).toBe("MAIN");
    expect(screen.getByTestId("rail")).toHaveAttribute("data-active", "dashboard");
    expect(screen.getByTestId("rail")).toHaveAttribute("data-ver-paneles", "true");
  });

  // 15/11/2026 (code-review): en el teléfono `.dash-rail` es `display: none`, así
  // que sin la barra superior un supervisor no podía salir de /panel. Va DENTRO
  // del `main`: si fuera hijo directo de `.dash-frame` rompería el grid.
  it("monta la navegación superior con su panel activo dentro del main, no en el grid", () => {
    const { container } = render(
      <PanelMarco panel="dashboard" titulo="Dashboard de ventas" ahora={AHORA} periodo="hoy">
        <p>contenido</p>
      </PanelMarco>
    );
    const barra = container.querySelector("header.dash-topbar");
    expect(barra).not.toBeNull();
    expect(container.querySelector(".dash-frame > .dash-topbar")).toBeNull();
    expect(container.querySelector("main")!.contains(barra)).toBe(true);
    const nav = screen.getByTestId("topnav");
    expect(barra!.contains(nav)).toBe(true);
    expect(nav).toHaveAttribute("data-active", "dashboard");
    expect(nav).toHaveAttribute("data-ver-paneles", "true");
    expect(barra).toHaveTextContent(BUSINESS_NAME);
    expect(container.querySelector(".dash-frame")!.childElementCount).toBe(2);
  });

  // 15/11/2026: la entrada única «Paneles» se partió en tres; cada pantalla marca
  // SU entrada en el rail y en la barra superior, no una genérica.
  it.each([
    ["dashboard", "Dashboard de ventas"],
    ["analiticas", "Analíticas"],
    ["asesores", "Asesores"],
  ] as const)("el panel «%s» marca su propia entrada en el rail y en la barra superior", (panel, titulo) => {
    render(
      <PanelMarco panel={panel} titulo={titulo} ahora={AHORA} periodo="hoy">
        <p>contenido</p>
      </PanelMarco>
    );
    expect(screen.getByTestId("rail")).toHaveAttribute("data-active", panel);
    expect(screen.getByTestId("topnav")).toHaveAttribute("data-active", panel);
  });

  it("pone la fecha de hoy en Caracas como eyebrow y el título como h1", () => {
    render(
      <PanelMarco panel="dashboard" titulo="Dashboard de ventas" ahora={AHORA} periodo="hoy">
        <p>contenido</p>
      </PanelMarco>
    );
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard de ventas" })).toBeInTheDocument();
    expect(screen.getByText(/viernes.*13.*noviembre/i)).toBeInTheDocument();
  });

  it("la fecha usa la zona de Caracas aunque el instante ya sea otro día en UTC", () => {
    // 23:30 en Caracas del 13/11 = 03:30 UTC del 14/11.
    render(
      <PanelMarco panel="asesores" titulo="Asesores" ahora={new Date("2026-11-14T03:30:00Z")} periodo="hoy">
        <p>contenido</p>
      </PanelMarco>
    );
    expect(screen.getByText(/viernes.*13.*noviembre/i)).toBeInTheDocument();
  });

  it("las pestañas son enlaces a los tres paneles y solo la actual lleva aria-current", () => {
    render(
      <PanelMarco panel="analiticas" titulo="Analíticas" ahora={AHORA} periodo="hoy">
        <p>contenido</p>
      </PanelMarco>
    );
    const nav = screen.getByRole("navigation", { name: "Paneles" });
    const enlaces = within(nav).getAllByRole("link");
    expect(enlaces.map((a) => a.textContent)).toEqual(["Dashboard", "Analíticas", "Asesores"]);
    expect(enlaces.map((a) => a.getAttribute("href"))).toEqual([
      "/panel?periodo=hoy",
      "/panel/analiticas?periodo=hoy",
      "/panel/asesores?periodo=hoy",
    ]);
    expect(enlaces.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it("las pestañas arrastran el periodo elegido y la vista, si la hay", () => {
    render(
      <PanelMarco panel="dashboard" titulo="Dashboard de ventas" ahora={AHORA} periodo="7d" vista="online">
        <p>contenido</p>
      </PanelMarco>
    );
    const nav = screen.getByRole("navigation", { name: "Paneles" });
    expect(within(nav).getByRole("link", { name: "Asesores" })).toHaveAttribute("href", "/panel/asesores?periodo=7d");
    expect(within(nav).getByRole("link", { name: "Analíticas" })).toHaveAttribute(
      "href",
      "/panel/analiticas?periodo=7d&vista=online"
    );
  });

  it("pinta el slot de controles y el contenido", () => {
    render(
      <PanelMarco panel="dashboard" titulo="T" ahora={AHORA} periodo="hoy" controles={<button type="button">Un control</button>}>
        <p>contenido propio</p>
      </PanelMarco>
    );
    expect(screen.getByRole("button", { name: "Un control" })).toBeInTheDocument();
    expect(screen.getByText("contenido propio")).toBeInTheDocument();
  });
});

describe("ControlPeriodo y ControlVista", () => {
  it("cambiar el periodo reemplaza la URL conservando el resto y sin saltar al inicio", async () => {
    parametros = new URLSearchParams("vista=online");
    render(<ControlPeriodo periodo="hoy" />);
    await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: "7 días" }));
    expect(replace).toHaveBeenCalledTimes(1);
    const [url, opciones] = replace.mock.calls[0];
    expect(String(url)).toMatch(/^\/panel\?/);
    const buscado = new URLSearchParams(String(url).split("?")[1]);
    expect(buscado.get("periodo")).toBe("7d");
    expect(buscado.get("vista")).toBe("online");
    expect(opciones).toEqual({ scroll: false });
  });

  it("cambiar la vista reemplaza la URL conservando el periodo", async () => {
    parametros = new URLSearchParams("periodo=30d");
    render(<ControlVista vista="resumen" />);
    await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: "En tienda" }));
    const [url, opciones] = replace.mock.calls[0];
    const buscado = new URLSearchParams(String(url).split("?")[1]);
    expect(buscado.get("vista")).toBe("tienda");
    expect(buscado.get("periodo")).toBe("30d");
    expect(opciones).toEqual({ scroll: false });
  });
});

describe("PanelBloque", () => {
  it("con datos pinta el contenido", () => {
    render(
      <PanelBloque bloque={{ ok: true, dato: { n: 3 } }} nombre="Ventas">
        {(dato) => <p>Van {dato.n}</p>}
      </PanelBloque>
    );
    expect(screen.getByText("Van 3")).toBeInTheDocument();
  });

  it("degradado: dice 'No disponible', el motivo, y Reintentar vuelve a pedir al servidor", async () => {
    render(
      <PanelBloque bloque={{ ok: false, motivo: "error", detalle: "No se pudo leer las ventas." }} nombre="Ventas">
        {() => <p>no debería verse</p>}
      </PanelBloque>
    );
    expect(screen.queryByText("no debería verse")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/No disponible/);
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo leer las ventas.");
    await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: "Reintentar" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("un bloque con motivo no_disponible lo nombra distinto de un error", () => {
    render(
      <PanelBloque bloque={{ ok: false, motivo: "no_disponible", detalle: "Falta la migración." }} nombre="Ventas">
        {() => null}
      </PanelBloque>
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Falta la migración.");
  });
});
