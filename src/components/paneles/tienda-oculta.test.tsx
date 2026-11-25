/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import { VISTAS, vistaDesdeParam } from "@/lib/paneles/canal";
import { rangosDeAnaliticas } from "@/lib/paneles/rangos";
import { metaDelDia } from "@/lib/paneles/rendimiento";
import type { PanelAsesores, PanelCola, PanelVentas, PersonaAsesores } from "@/lib/paneles/parse";
import { AnaliticasView, type AnaliticasViewProps } from "@/components/paneles/analiticas-view";
import { AsesoresView, type AsesoresViewProps } from "@/components/paneles/asesores-view";
import { DashboardView } from "@/components/paneles/dashboard-view";
import { ControlVista } from "@/components/paneles/panel-marco";
import {
  AHORA,
  AHORA_ACTIVAS,
  METAS,
  activas,
  activasComoHoy,
  activasConDesglose,
  canal,
  conversaciones,
  ok,
  propsBase,
  ventas,
} from "@/components/paneles/dashboard/dashboard-fixtures";

/**
 * D1 (21/11/2026, plan "Los paneles cuentan desde el lunes 16/11/2026 y se
 * refrescan solos", T3): con `CANAL_TIENDA_VISIBLE = false` —el valor real, SIN
 * `vi.mock` de `canal-config`— ningún panel pinta el canal «tienda», y el
 * «Resumen» sigue siendo el total de los dos canales (nada se pierde). Los
 * fixtures TRAEN tienda a propósito: lo que se prueba es que no se pinte.
 * jsdom no calcula layout: la revisión visual va aparte.
 */

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  usePathname: () => "/panel",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/app-rail", () => ({
  AppRail: () => <nav data-testid="rail" />,
  AppTopNav: () => <nav data-testid="topnav" />,
}));

const clienteFalso = { __cliente: true };
vi.mock("@/lib/supabase/client", () => ({ createClient: () => clienteFalso }));

const guardarMetaVenta = vi.fn();
vi.mock("@/lib/mutations", () => ({
  guardarMetaVenta: (...args: unknown[]) => guardarMetaVenta(...args),
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn() } };
});

beforeEach(() => {
  replace.mockClear();
  refresh.mockClear();
  guardarMetaVenta.mockReset();
  guardarMetaVenta.mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
});

const seccion = (nombre: string) => screen.getByRole("region", { name: nombre });

/** Lo que de ninguna manera puede quedar en pantalla con la tienda oculta. */
const TEXTOS_DE_TIENDA = [/En tienda/, /Mostrador/, /Meta en tienda/, /tienda juntos/, /Online \/ tienda/, /\d+ tienda\b/];
const CLASES_DE_TIENDA = [".pn-chip--tienda", ".pd-sw-tienda", ".pd-mes__seg--tienda", ".pd-pista__relleno--tienda"];

function sinRastroDeTienda(contenedor: HTMLElement) {
  const texto = contenedor.textContent ?? "";
  for (const patron of TEXTOS_DE_TIENDA) expect(texto, String(patron)).not.toMatch(patron);
  for (const clase of CLASES_DE_TIENDA) expect(contenedor.querySelector(clase), clase).toBeNull();
}

/** Un PanelVentas con `n` envíos de tienda en el período (y su monto dentro del total). */
const conEnviosDeTienda = (n: number): PanelVentas =>
  ventas({
    canales: {
      online: canal({ ingresos: 800, envios: 8, unidades: 20, ticket: 100 }),
      tienda: canal({ ingresos: n > 0 ? 434.5 : 0, envios: n, unidades: n > 0 ? 9 : 0, ticket: n > 0 ? 86.9 : null }),
    },
  });

// ---------------------------------------------------------------------------
// Las vistas y las metas
// ---------------------------------------------------------------------------

describe("canal «tienda» oculto: vistas y metas", () => {
  it("el control de vista ofrece solo Resumen y Online", () => {
    render(<ControlVista vista="resumen" />);
    const grupo = screen.getByRole("group", { name: "Canal" });
    expect(within(grupo).getAllByRole("button").map((b) => b.textContent)).toEqual(["Resumen", "Online"]);
    expect(VISTAS.map((v) => v.id)).toEqual(["resumen", "online"]);
  });

  it("?vista=tienda cae en el resumen", () => {
    expect(vistaDesdeParam("tienda")).toBe("resumen");
    expect(vistaDesdeParam("online")).toBe("online");
  });

  it("la meta del resumen es la online sola, aunque haya una de tienda; sin meta online es null", () => {
    expect(metaDelDia(METAS, "resumen", "2026-11-13", DEFAULT_BUSINESS_HOURS)).toBe(2000);
    expect(
      metaDelDia([{ canal: "tienda", vigente_desde: "2026-10-01", monto_usd: 1000 }], "resumen", "2026-11-13", DEFAULT_BUSINESS_HOURS)
    ).toBeNull();
  });

  it("el lápiz del resumen ofrece un solo campo, «Meta del día (USD)», y guarda online", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase()} />);
    const hero = seccion("Rendimiento de ventas");

    await user.click(within(hero).getByRole("button", { name: "Editar la meta diaria" }));
    expect(within(hero).queryByLabelText("Meta online (USD)")).toBeNull();
    expect(within(hero).queryByLabelText("Meta en tienda (USD)")).toBeNull();
    const campo = within(hero).getByLabelText("Meta del día (USD)");
    expect(campo).toHaveValue(2000);

    await user.clear(campo);
    await user.type(campo, "2500");
    await user.click(within(hero).getByRole("button", { name: "Guardar meta" }));

    await waitFor(() => expect(guardarMetaVenta).toHaveBeenCalledTimes(1));
    expect(guardarMetaVenta).toHaveBeenCalledWith(clienteFalso, "online", 2500, "2026-11-13");
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe("canal «tienda» oculto: Dashboard", () => {
  it("el resumen no pinta nada de tienda, ni en las tarjetas ni en las hojas", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { container } = render(<DashboardView {...propsBase()} />);
    sinRastroDeTienda(container);

    // Las hojas solo pintan su contenido abiertas: se abren las que tenían columnas de canal.
    await user.click(screen.getByRole("button", { name: "Unidades vendidas: abrir detalle" }));
    const hojaUnidades = screen.getByRole("dialog");
    expect(within(hojaUnidades).getByRole("columnheader", { name: "Unidades" })).toBeInTheDocument();
    expect(within(hojaUnidades).queryByRole("columnheader", { name: "Online" })).toBeNull();
    sinRastroDeTienda(hojaUnidades);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Ventas activas: abrir detalle" }));
    const hojaActivas = screen.getByRole("dialog");
    expect(within(hojaActivas).getByRole("columnheader", { name: "Monto" })).toBeInTheDocument();
    expect(within(hojaActivas).queryByRole("columnheader", { name: "Canal" })).toBeNull();
    sinRastroDeTienda(hojaActivas);
  });

  it("ventas activas como están hoy (0 de la caja): ni la tarjeta ni la hoja traen «Tienda (caja)» ni rastro de tienda", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { container } = render(
      <DashboardView {...propsBase({ ahora: AHORA_ACTIVAS, ventasActivas: ok(activasComoHoy()) })} />
    );
    const tarjeta = seccion("Ventas activas");
    expect(within(tarjeta).getByText("Asesores online")).toBeInTheDocument();
    expect(tarjeta.textContent).not.toMatch(/Tienda \(caja\)/);
    expect(tarjeta.textContent).not.toMatch(/la tienda está oculta/);
    sinRastroDeTienda(container);

    await user.click(within(tarjeta).getByRole("button", { name: /abrir detalle/i }));
    const hoja = await screen.findByRole("dialog", { name: "Ventas activas" });
    expect(hoja.textContent).not.toMatch(/Tienda \(caja\)/);
    expect(within(hoja).queryByRole("columnheader", { name: "Canal" })).toBeNull();
    expect(within(hoja).getByRole("columnheader", { name: "Equipo" })).toBeInTheDocument();
    sinRastroDeTienda(hoja);
  });

  it("si una caja armó un presupuesto, aparece «Tienda (caja)» y un chip avisa que la tienda está oculta", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase({ ahora: AHORA_ACTIVAS, ventasActivas: ok(activasConDesglose()) })} />);
    const tarjeta = seccion("Ventas activas");
    const filaCaja = within(tarjeta).getByText("Tienda (caja)").closest("li")!;
    expect(within(filaCaja).getByText("$150,00")).toBeInTheDocument();
    expect(within(tarjeta).getByText("1 armado por la caja (la tienda está oculta)")).toBeInTheDocument();

    await user.click(within(tarjeta).getByRole("button", { name: /abrir detalle/i }));
    const hoja = await screen.findByRole("dialog", { name: "Ventas activas" });
    const matriz = within(hoja).getByRole("table", { name: "De dónde y quién lo armó" });
    expect(within(matriz).getByRole("columnheader", { name: "Tienda (caja)" })).toBeInTheDocument();
  });

  it("con varias armadas por la caja el chip va en plural", () => {
    const base = activasConDesglose();
    const dg = base.desglose!;
    render(
      <DashboardView
        {...propsBase({
          ahora: AHORA_ACTIVAS,
          ventasActivas: ok({ ...base, desglose: { ...dg, por_equipo: { ...dg.por_equipo, tienda: { monto: 300, cantidad: 3 } } } }),
        })}
      />
    );
    expect(within(seccion("Ventas activas")).getByText("3 armados por la caja (la tienda está oculta)")).toBeInTheDocument();
  });

  it("el tablero mensual del resumen es una sola serie «Total», sin segmento de tienda", () => {
    render(<DashboardView {...propsBase()} />);
    const tablero = seccion("Ingresos por mes");
    expect(tablero.querySelector(".pn-leyenda")).toHaveTextContent("Total");
    expect(tablero.querySelector(".pn-leyenda")).not.toHaveTextContent("Online");
    expect(tablero.querySelector(".pd-mes__seg--online")).not.toBeNull();
    expect(tablero.querySelector(".pd-mes__seg--tienda")).toBeNull();
    // El mes en curso (nov) trae online 800 + tienda 434,5: el total no pierde la tienda.
    expect(tablero).toHaveTextContent("Nov: $1.234,50");
  });

  it("«Enviado a SAINT» del resumen suma los dos canales y avisa cuántos envíos de tienda incluye", () => {
    render(<DashboardView {...propsBase({ ventas: ok(conEnviosDeTienda(2)) })} />);
    const enviado = seccion("Enviado a SAINT");
    expect(within(enviado).getByText("$1.234,50")).toBeInTheDocument();
    expect(within(enviado).getByText("2 envíos de tienda incluidos en el total (el canal está oculto)")).toBeInTheDocument();
  });

  it("con un envío de tienda el aviso va en singular", () => {
    render(<DashboardView {...propsBase({ ventas: ok(conEnviosDeTienda(1)) })} />);
    expect(
      within(seccion("Enviado a SAINT")).getByText("1 envío de tienda incluido en el total (el canal está oculto)")
    ).toBeInTheDocument();
  });

  it("sin envíos de tienda no aparece ningún aviso", () => {
    render(<DashboardView {...propsBase({ ventas: ok(conEnviosDeTienda(0)) })} />);
    expect(seccion("Enviado a SAINT").textContent).not.toMatch(/canal está oculto/);
  });

  it("en «Online» no se avisa: ese total ya no incluye la tienda", () => {
    render(<DashboardView {...propsBase({ vista: "online", ventas: ok(conEnviosDeTienda(2)) })} />);
    const enviado = seccion("Enviado a SAINT");
    expect(within(enviado).getByText("$800,00")).toBeInTheDocument();
    expect(enviado.textContent).not.toMatch(/canal está oculto/);
  });
});

// ---------------------------------------------------------------------------
// Analíticas
// ---------------------------------------------------------------------------

function propsAnaliticas(parcial: Partial<AnaliticasViewProps> = {}): AnaliticasViewProps {
  const AHORA_AN = new Date("2026-11-15T12:00:00-04:00");
  return {
    periodo: "30d",
    vista: "resumen",
    ahora: AHORA_AN,
    rangos: rangosDeAnaliticas("30d", AHORA_AN, null),
    ventas: ok(ventas()),
    ventasPrevio: ok(ventas()),
    conversaciones: conversaciones(),
    conversacionesPrevio: conversaciones(),
    ventasAnio: ok(ventas()),
    ventasUltimos40: ok(ventas()),
    ventasActivas: ok(activas()),
    metas: ok(METAS),
    horario: DEFAULT_BUSINESS_HOURS,
    tasaBcv: 40,
    ...parcial,
  };
}

describe("canal «tienda» oculto: Analíticas", () => {
  it("el contexto del resumen dice que el mostrador no pasa por el CRM", () => {
    render(<AnaliticasView {...propsAnaliticas()} />);
    expect(screen.getByText("Ventas armadas desde el chat (el mostrador no pasa por el CRM)")).toBeInTheDocument();
  });

  it("el resumen no pinta nada de tienda en ninguna de sus secciones, y el total sigue sumando los dos canales", () => {
    const { container } = render(<AnaliticasView {...propsAnaliticas()} />);
    sinRastroDeTienda(container);
    expect(within(seccion("Enviado a SAINT")).getByText("$1.234,50")).toBeInTheDocument();
    // La tipo de precio del resumen es una sola barra con los dos canales sumados.
    expect(screen.getByRole("img", { name: "Total: 3 unidades con precio de promoción y 10 con precio estándar." })).toBeInTheDocument();
  });

  it("ventas activas con el desglose: el filtro Equipo no ofrece «Tienda (caja)» si no hay nada de la caja, y sin rastro de tienda", () => {
    const { container } = render(<AnaliticasView {...propsAnaliticas({ ahora: AHORA_ACTIVAS, ventasActivas: ok(activasComoHoy()) })} />);
    const seccion = document.getElementById("ventas-activas")!;
    const equipo = within(seccion).getByRole("group", { name: "Equipo de la venta activa" });
    expect(within(equipo).getAllByRole("button").map((b) => b.textContent)).toEqual(["Todos", "Online"]);
    expect(seccion.textContent).not.toMatch(/Tienda \(caja\)/);
    sinRastroDeTienda(container);
  });

  it("si hay algo armado por la caja, el filtro Equipo sí ofrece «Tienda (caja)»", () => {
    render(<AnaliticasView {...propsAnaliticas({ ahora: AHORA_ACTIVAS, ventasActivas: ok(activasConDesglose()) })} />);
    const equipo = within(document.getElementById("ventas-activas")!).getByRole("group", { name: "Equipo de la venta activa" });
    expect(within(equipo).getAllByRole("button").map((b) => b.textContent)).toEqual(["Todos", "Online", "Tienda (caja)"]);
  });

  it("el resumen con «Comparar» no explica una suma de canales que ya no existe", () => {
    render(<AnaliticasView {...propsAnaliticas()} />);
    expect(document.body.textContent).not.toMatch(/suma online y tienda/);
  });

  it("avisa los envíos de tienda incluidos en el total solo en el resumen y solo si los hay", () => {
    const { rerender } = render(<AnaliticasView {...propsAnaliticas({ ventas: ok(conEnviosDeTienda(2)) })} />);
    expect(screen.getByText("2 envíos de tienda incluidos en el total (el canal está oculto)")).toBeInTheDocument();

    rerender(<AnaliticasView {...propsAnaliticas({ ventas: ok(conEnviosDeTienda(1)) })} />);
    expect(screen.getByText("1 envío de tienda incluido en el total (el canal está oculto)")).toBeInTheDocument();

    rerender(<AnaliticasView {...propsAnaliticas({ ventas: ok(conEnviosDeTienda(0)) })} />);
    expect(document.body.textContent).not.toMatch(/canal está oculto/);

    rerender(<AnaliticasView {...propsAnaliticas({ vista: "online", ventas: ok(conEnviosDeTienda(2)) })} />);
    expect(document.body.textContent).not.toMatch(/canal está oculto/);
  });
});

// ---------------------------------------------------------------------------
// Asesores
// ---------------------------------------------------------------------------

function persona(extra: Partial<PersonaAsesores> & Pick<PersonaAsesores, "agent_id" | "nombre">): PersonaAsesores {
  return {
    rol: "agent",
    en_reparto: true,
    conversaciones: 0,
    mensajes: 0,
    contactos: 0,
    episodios: 0,
    primera_resp_mediana_min: null,
    primera_resp_p90_min: null,
    en_5min: null,
    envios: 0,
    monto: null,
    unidades: 0,
    envios_online: 0,
    envios_tienda: 0,
    reasignadas_desde: 0,
    ultimo_mensaje: null,
    actividad_hora: Array.from({ length: 24 }, () => 0),
    ...extra,
  };
}

function propsAsesores(ventasDato: PanelVentas): AsesoresViewProps {
  const asesores: PanelAsesores = {
    personas: [
      persona({ agent_id: "a1", nombre: "Ana Gómez", envios: 5, envios_online: 5, monto: 500, mensajes: 300 }),
      persona({ agent_id: "c1", nombre: "Carla Caja", rol: "caja", en_reparto: false, envios: 4, envios_tienda: 4, monto: 120 }),
    ],
    seba: { mensajes: 120, conversaciones: 45, ultimo: "2026-11-13T14:50:00-04:00" },
    equipo: { episodios: 42, primera_resp_mediana_min: 3.2, en_5min: 0.72 },
  };
  const cola: PanelCola = {
    corte_dias: 7,
    pendientes: 0,
    sin_dueno: 0,
    con_dueno: 0,
    abandonadas: 0,
    por_antiguedad: { menos_1h: 0, de_1_a_4h: 0, de_4_a_24h: 0, de_1_a_7d: 0 },
    mas_viejo: null,
    lista: [],
  };
  return {
    periodo: "hoy",
    ahora: AHORA,
    rango: { desde: new Date("2026-11-13T04:00:00Z"), hasta: AHORA, etiqueta: "Hoy" },
    asesores: { ok: true, dato: asesores, recortado: false },
    conversaciones: { ...conversaciones(), recortado: false },
    ventas: ok(ventasDato),
    cola: ok(cola),
    horario: DEFAULT_BUSINESS_HOURS,
  };
}

/** La tarjeta «Enviado a SAINT» del resumen del equipo (no es una región con nombre propio). */
function enviadoDelEquipo(): HTMLElement {
  const tarjeta = within(seccion("Resumen del equipo")).getByText("Enviado a SAINT").closest("section");
  if (!tarjeta) throw new Error("No se encontró la tarjeta «Enviado a SAINT».");
  return tarjeta;
}

describe("canal «tienda» oculto: Asesores", () => {
  it("no monta la tarjeta del mostrador ni la nota «N online · M tienda»", () => {
    const { container } = render(<AsesoresView {...propsAsesores(conEnviosDeTienda(4))} />);
    expect(screen.queryByRole("region", { name: "Mostrador" })).toBeNull();
    expect(screen.getByRole("region", { name: "Seba" })).toBeInTheDocument();
    sinRastroDeTienda(container);
    expect(container.textContent).not.toMatch(/\d+ online · \d+ tienda/);
  });

  it("«Enviado a SAINT» del equipo suma los dos canales y avisa los envíos de tienda incluidos", () => {
    render(<AsesoresView {...propsAsesores(conEnviosDeTienda(2))} />);
    const enviado = enviadoDelEquipo();
    expect(within(enviado).getByText("$1.234,50")).toBeInTheDocument();
    expect(within(enviado).getByText("2 envíos de tienda incluidos en el total (el canal está oculto)")).toBeInTheDocument();
  });

  it("sin envíos de tienda no aparece ningún aviso", () => {
    render(<AsesoresView {...propsAsesores(conEnviosDeTienda(0))} />);
    expect(enviadoDelEquipo().textContent).not.toMatch(/canal está oculto/);
  });
});
