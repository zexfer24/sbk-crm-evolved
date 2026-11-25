/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AnaliticasView, type AnaliticasViewProps } from "@/components/paneles/analiticas-view";
import { DashboardView } from "@/components/paneles/dashboard-view";
import {
  activas,
  canal,
  conversaciones,
  METAS,
  ok,
  propsBase,
  ventas,
  ventasHoy,
} from "@/components/paneles/dashboard/dashboard-fixtures";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import { TEXTO_INICIO_PANELES, TEXTO_SIN_PREVIO } from "@/lib/paneles/periodos";
import { rangosDeAnaliticas, rangosDelDashboard } from "@/lib/paneles/rangos";
import type { PanelVentas } from "@/lib/paneles/parse";

/**
 * Plan «Los paneles cuentan desde el lunes 16/11/2026 y se refrescan solos»
 * (21/11/2026), T4: la pantalla dice la verdad sobre el piso. Estos tests
 * ejercitan las vistas con el piso POR DEFECTO (`INICIO_PANELES`) y relojes de
 * después del 16/11; los demás tests de paneles fijan el reloj el 13/11 y pasan
 * `piso: null` para seguir probando el comportamiento de antes.
 */

// El canal «tienda» visible (D1, 21/11/2026: hoy está oculto); `tienda-oculta.test.tsx` cubre el caso oculto.
vi.mock("@/lib/paneles/canal-config", () => ({ CANAL_TIENDA_VISIBLE: true }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/panel",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/app-rail", () => ({
  AppRail: () => <nav data-testid="rail" />,
  AppTopNav: () => <nav data-testid="topnav" />,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/mutations", () => ({ guardarMetaVenta: vi.fn() }));
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn() } };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  document.body.innerHTML = "";
});

// Sábado 21/11/2026, 9:20 am en Caracas: la tienda no abre.
const SABADO_21 = new Date("2026-11-21T09:20:00-04:00");
// Viernes 27/11/2026, 11:00 am: la tienda abre y ya hay 10 días con ventas posibles desde el 16/11.
const VIERNES_27 = new Date("2026-11-27T11:00:00-04:00");
// Lunes 30/11/2026: «7 días» ya cabe entero desde el piso, así que su previo existe.
const LUNES_30 = new Date("2026-11-30T11:00:00-04:00");

const seccion = (nombre: string) => screen.getByRole("region", { name: nombre });
const textoDeLaPagina = () => document.body.textContent ?? "";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe("Dashboard sin período anterior comparable (reloj del 21/11)", () => {
  it("«Hoy»: las tarjetas dicen que no hay período anterior y no pintan ningún porcentaje", () => {
    const rangos = rangosDelDashboard("hoy", SABADO_21);
    expect(rangos.previo).toBeNull();
    render(<DashboardView {...propsBase({ ahora: SABADO_21, rangos, ventasPrevio: null })} />);

    for (const nombre of ["Enviado a SAINT", "Unidades vendidas"]) {
      const tarjeta = seccion(nombre);
      expect(within(tarjeta).getByText(TEXTO_SIN_PREVIO)).toBeInTheDocument();
      expect(within(tarjeta).queryByText(/vs\./)).toBeNull();
    }
    expect(textoDeLaPagina()).not.toMatch(/−100|∞|Sin referencia previa/);
  });

  it("el chip sin período anterior es neutro y ocupa el lugar de la variación", () => {
    const rangos = rangosDelDashboard("hoy", SABADO_21);
    render(<DashboardView {...propsBase({ ahora: SABADO_21, rangos, ventasPrevio: null })} />);
    const chip = within(seccion("Enviado a SAINT")).getByText(TEXTO_SIN_PREVIO);
    expect(chip.closest(".pn-chip")).toHaveClass("pn-chip--neutro");
  });

  it("«7 días»: avisa que los paneles cuentan desde el lunes 16/11/2026", () => {
    const rangos = rangosDelDashboard("7d", SABADO_21);
    expect(rangos.periodoRecortado).toBe(true);
    render(<DashboardView {...propsBase({ ahora: SABADO_21, rangos, periodo: "7d", ventasPrevio: null })} />);
    expect(within(seccion("Enviado a SAINT")).getByText(new RegExp(TEXTO_INICIO_PANELES))).toBeInTheDocument();
  });

  it("«Hoy» no está recortado: no repite el aviso", () => {
    const rangos = rangosDelDashboard("hoy", SABADO_21);
    render(<DashboardView {...propsBase({ ahora: SABADO_21, rangos, ventasPrevio: null })} />);
    expect(within(seccion("Enviado a SAINT")).queryByText(new RegExp(TEXTO_INICIO_PANELES))).toBeNull();
  });

  it("con el reloj del 30/11 y «7 días» el previo existe y vuelve el chip de variación", () => {
    const rangos = rangosDelDashboard("7d", LUNES_30);
    expect(rangos.previo).not.toBeNull();
    render(<DashboardView {...propsBase({ ahora: LUNES_30, rangos, periodo: "7d" })} />);
    const enviado = seccion("Enviado a SAINT");
    expect(within(enviado).getByText(/\+12,2 %/)).toBeInTheDocument();
    expect(within(enviado).queryByText(TEXTO_SIN_PREVIO)).toBeNull();
    expect(within(enviado).queryByText(new RegExp(TEXTO_INICIO_PANELES))).toBeNull();
  });
});

describe("Dashboard: la proyección espera 10 días con ventas desde el piso (D2, A2)", () => {
  /** Un día con ventas a las 10 y a las 15. */
  const perfil = (dia: string) => {
    const online = Array<number>(24).fill(0);
    online[10] = 100;
    online[15] = 100;
    return { dia, online, tienda: Array<number>(24).fill(0) };
  };
  const sinVentas = (dia: string) => ({ dia, online: Array<number>(24).fill(0), tienda: Array<number>(24).fill(0) });
  const historiaDe = (perfiles: ReturnType<typeof perfil>[], serie: PanelVentas["serie"] = []) => ventas({ serie, perfil_horario: perfiles });
  const dias = (desde: number, hasta: number) =>
    Array.from({ length: hasta - desde + 1 }, (_, i) => `2026-11-${String(desde + i).padStart(2, "0")}`);

  function dibujar(historia: PanelVentas) {
    const rangos = rangosDelDashboard("hoy", VIERNES_27);
    render(
      <DashboardView
        {...propsBase({
          ahora: VIERNES_27,
          rangos,
          ventasPrevio: null,
          ventasHoy: ok(ventasHoy()),
          ventasHistoria: ok(historia),
        })}
      />
    );
    return seccion("Rendimiento de ventas");
  }

  it("con 9 días con ventas desde el piso dice «van 9» y no proyecta", () => {
    const hero = dibujar(historiaDe(dias(16, 24).map(perfil)));
    expect(within(hero).getByText("La proyección aparece con 10 días con ventas desde el 16/11 (van 9)")).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("cerrarías el día en");
  });

  it("con 10 días con ventas desde el piso aparece la proyección", () => {
    const hero = dibujar(historiaDe(dias(16, 25).map(perfil)));
    expect(within(hero).getByText(/cerrarías el día en/)).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("La proyección aparece con");
  });

  it("los días sin ventas no cuentan: 12 días con 3 en cero son 9 con ventas", () => {
    const perfiles = [...dias(16, 24).map(perfil), ...dias(25, 27).map(sinVentas)];
    const hero = dibujar(historiaDe(perfiles));
    expect(within(hero).getByText(/\(van 9\)/)).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("cerrarías");
  });

  it("los días anteriores al piso no cuentan: 9 desde el piso y 5 de antes dicen «van 9»", () => {
    const perfiles = [...dias(11, 15).map(perfil), ...dias(16, 24).map(perfil)];
    const hero = dibujar(historiaDe(perfiles));
    expect(within(hero).getByText(/\(van 9\)/)).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("cerrarías");
  });

  it("mientras no hay curva no se pinta ningún monto proyectado", () => {
    const hero = dibujar(historiaDe(dias(16, 18).map(perfil)));
    expect(within(hero).getByText(/\(van 3\)/)).toBeInTheDocument();
    expect(hero.textContent).not.toMatch(/cerrarías|llegarías a la meta/);
  });

  it("la racha no suma ni corta con un día anterior al piso que llegue en la historia", () => {
    // Meta del resumen: 3.000. Los dos días del 12 y el 13/11 (anteriores al piso) la cumplen: sin el filtro la racha sería 11.
    const fila = (dia: string, online: number, tienda: number) => ({
      t: `${dia}T00:00:00-04:00`,
      online,
      tienda,
      envios_online: 1,
      envios_tienda: 1,
    });
    const desdeElPiso = ["16", "17", "18", "19", "20", "23", "24", "25", "26"].map((d) => fila(`2026-11-${d}`, 2000, 1000));
    const anteriores = ["12", "13"].map((d) => fila(`2026-11-${d}`, 2000, 1000));
    const hero = dibujar(historiaDe(dias(16, 25).map(perfil), [...anteriores, ...desdeElPiso]));
    expect(within(hero).getByText(/Racha: 9 días/)).toBeInTheDocument();
  });
});

describe("Dashboard: el tablero mensual arranca en el mes del piso", () => {
  const anio = ok(
    ventas({
      granularidad: "dia",
      serie: [
        { t: "2026-10-28T00:00:00-04:00", online: 2000, tienda: 800, envios_online: 20, envios_tienda: 8 },
        { t: "2026-11-17T00:00:00-04:00", online: 800, tienda: 434.5, envios_online: 8, envios_tienda: 5 },
      ],
    })
  );

  it("empieza en noviembre «desde el 16», conserva diciembre y explica por qué", () => {
    const rangos = rangosDelDashboard("hoy", SABADO_21);
    render(<DashboardView {...propsBase({ ahora: SABADO_21, rangos, ventasPrevio: null, ventasAnio: anio })} />);
    const tablero = seccion("Ingresos por mes");

    expect(within(tablero).getAllByRole("rowheader").map((c) => c.textContent)).toEqual([
      "noviembre (desde el 16)",
      "diciembre",
    ]);
    expect(within(tablero).getByText("Nov (desde el 16)")).toBeInTheDocument();
    expect(within(tablero).queryByText("Oct")).toBeNull();
    expect(
      within(tablero).getByText(`${TEXTO_INICIO_PANELES}: por eso el tablero empieza en noviembre.`)
    ).toBeInTheDocument();
  });

  it("sin piso arranca en el primer mes con envíos, como antes", () => {
    const rangos = rangosDelDashboard("hoy", SABADO_21, null);
    render(<DashboardView {...propsBase({ ahora: SABADO_21, rangos, ventasPrevio: null, ventasAnio: anio })} />);
    const tablero = seccion("Ingresos por mes");
    expect(within(tablero).getAllByRole("rowheader")[0].textContent).toBe("octubre");
    expect(within(tablero).queryByText(/desde el 16/)).toBeNull();
    expect(within(tablero).queryByText(new RegExp(TEXTO_INICIO_PANELES))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Analíticas
// ---------------------------------------------------------------------------

function propsAnaliticas(extra: Partial<AnaliticasViewProps> = {}): AnaliticasViewProps {
  return {
    periodo: "7d",
    vista: "resumen",
    ahora: SABADO_21,
    rangos: rangosDeAnaliticas("7d", SABADO_21),
    ventas: ok(ventas()),
    ventasPrevio: null,
    conversaciones: conversaciones(),
    conversacionesPrevio: null,
    ventasAnio: ok(ventas()),
    ventasUltimos40: ok(ventas({ serie: [] })),
    ventasActivas: ok(activas()),
    metas: ok(METAS),
    horario: DEFAULT_BUSINESS_HOURS,
    tasaBcv: 40,
    ...extra,
  };
}

const kpi = (nombre: string) => screen.getByRole("region", { name: nombre });
const botonComparar = () => screen.getByRole("button", { name: /Comparar con el período anterior/ });

describe("Analíticas sin período anterior comparable (reloj del 21/11)", () => {
  it("el chip de contexto lo dice con el texto largo y no hay «Contra: …»", () => {
    render(<AnaliticasView {...propsAnaliticas()} />);
    expect(document.querySelector(".an-contexto")).toHaveTextContent(TEXTO_SIN_PREVIO);
    expect(screen.queryByText(/^Contra:/)).toBeNull();
  });

  it("el botón «Comparar» queda deshabilitado, apagado y con el porqué en el title", () => {
    render(<AnaliticasView {...propsAnaliticas()} />);
    const boton = botonComparar();
    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute("aria-pressed", "false");
    expect(boton).toHaveAttribute("title", TEXTO_SIN_PREVIO);
  });

  it("los cinco KPI muestran «Sin período anterior comparable» y ningún porcentaje", () => {
    render(<AnaliticasView {...propsAnaliticas()} />);
    for (const nombre of ["Enviado a SAINT", "Envíos", "Ticket promedio", "Tasa de conversión", "Clientes que regresan"]) {
      expect(within(kpi(nombre)).getByText("Sin período anterior comparable")).toBeInTheDocument();
    }
    expect(textoDeLaPagina()).not.toMatch(/−100|∞|vs\./);
    expect(document.querySelector(".pn-linea--previa")).toBeNull();
  });

  it("«Ingresos en el tiempo» pinta el texto en su bloque «Variación» y no dibuja la línea previa", () => {
    render(<AnaliticasView {...propsAnaliticas()} />);
    const ingresos = document.getElementById("ingresos")!;
    const variacion = within(ingresos).getByText("Variación").parentElement!;
    expect(variacion).toHaveTextContent(TEXTO_SIN_PREVIO);
    expect(ingresos.querySelector(".pn-linea--previa")).toBeNull();
  });

  it("«7 días» avisa que los paneles cuentan desde el lunes 16/11/2026 y «Hoy» no", () => {
    const { unmount } = render(<AnaliticasView {...propsAnaliticas()} />);
    expect(document.querySelector(".an-contexto")).toHaveTextContent(TEXTO_INICIO_PANELES);
    unmount();

    render(<AnaliticasView {...propsAnaliticas({ periodo: "hoy", rangos: rangosDeAnaliticas("hoy", SABADO_21) })} />);
    expect(document.querySelector(".an-contexto")).not.toHaveTextContent(TEXTO_INICIO_PANELES);
  });

  it("con el reloj del 30/11 y «7 días» el previo existe: el botón se habilita y vuelven las variaciones", () => {
    const ahora = LUNES_30;
    render(
      <AnaliticasView
        {...propsAnaliticas({
          ahora,
          rangos: rangosDeAnaliticas("7d", ahora),
          ventasPrevio: ok(
            ventas({
              canales: {
                online: canal({ ingresos: 400, envios: 4, unidades: 8, ticket: 100 }),
                tienda: canal({ ingresos: 200, envios: 4, unidades: 6, ticket: 50 }),
              },
            })
          ),
          conversacionesPrevio: conversaciones(),
        })}
      />
    );
    expect(botonComparar()).toBeEnabled();
    expect(botonComparar()).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(TEXTO_SIN_PREVIO)).toBeNull();
    expect(screen.queryByText("Sin período anterior comparable")).toBeNull();
    expect(document.querySelector(".an-contexto")).toHaveTextContent("Contra:");
    expect(within(kpi("Enviado a SAINT")).getByText(/%/)).toBeInTheDocument();
  });
});

describe("Analíticas: el calendario de rendimiento y el piso", () => {
  const fila = (dia: string, online: number, tienda: number) => ({
    t: `${dia}T00:00:00-04:00`,
    online,
    tienda,
    envios_online: 1,
    envios_tienda: 1,
  });
  // La serie ya viene recortada al piso: 16/11 a 20/11 (lunes a viernes). Meta del resumen: 3.000.
  const serie = [
    fila("2026-11-16", 2000, 1000),
    fila("2026-11-17", 2000, 1000),
    fila("2026-11-18", 2000, 1000),
    fila("2026-11-19", 100, 0),
    fila("2026-11-20", 100, 0),
  ];

  function dibujar() {
    render(<AnaliticasView {...propsAnaliticas({ ventasUltimos40: ok(ventas({ serie })) })} />);
    return document.getElementById("rendimiento")!;
  }

  it("los días hábiles del 10/11 al 13/11 salen «sin datos», sin ícono ni monto", () => {
    const seccionRend = dibujar();
    const sinDatos = within(seccionRend).getAllByLabelText(/sin datos \(los paneles cuentan desde el 16\/11\)/);
    const dia = (n: number) => sinDatos.find((li) => li.getAttribute("aria-label")!.includes(` ${n} `) || li.getAttribute("aria-label")!.includes(`${n} nov`));
    for (const n of [10, 11, 12, 13]) expect(dia(n)).toBeDefined();
    for (const li of sinDatos) {
      expect(li).toHaveClass("an-dia--sin-datos");
      expect(li.querySelector("svg")).toBeNull();
      expect(li.querySelector("b")).toBeNull();
    }
  });

  it("no cuentan en «Cumplidas», «Racha» ni «Mejor día»; los del 16/11 en adelante se evalúan como siempre", () => {
    const seccionRend = dibujar();
    expect(within(within(seccionRend).getByLabelText("Cumplidas")).getByText("3 de 5")).toBeInTheDocument();
    expect(within(seccionRend).getAllByLabelText(/Meta cumplida/)).toHaveLength(3);
    expect(within(seccionRend).getAllByLabelText(/No se cumplió/)).toHaveLength(2);
    // Los dos últimos días fallaron: sin racha.
    expect(within(within(seccionRend).getByLabelText("Racha")).getByText("0")).toBeInTheDocument();
    expect(within(within(seccionRend).getByLabelText("Mejor día")).getByText("$3.000,00")).toBeInTheDocument();
  });

  it("la leyenda agrega «Sin datos» solo cuando hay días en ese estado", () => {
    const seccionRend = dibujar();
    expect(within(seccionRend).getByText("Sin datos")).toBeInTheDocument();
  });

  it("sin días hábiles pero con un calendario sin datos, no cae en el mensaje de «todavía no hay una meta»", () => {
    render(<AnaliticasView {...propsAnaliticas({ ventasUltimos40: ok(ventas({ serie: [] })) })} />);
    const seccionRend = document.getElementById("rendimiento")!;
    expect(within(seccionRend).queryByText(/Todavía no hay una meta diaria/)).toBeNull();
    expect(within(seccionRend).getAllByLabelText(/sin datos/).length).toBeGreaterThan(0);
  });

  it("sin metas y sin piso conserva el mensaje de vacío de siempre", () => {
    render(
      <AnaliticasView
        {...propsAnaliticas({
          metas: ok([]),
          rangos: rangosDeAnaliticas("7d", SABADO_21, null),
          ventasUltimos40: ok(ventas({ serie })),
        })}
      />
    );
    expect(within(document.getElementById("rendimiento")!).getByText(/Todavía no hay una meta diaria/)).toBeInTheDocument();
  });
});

describe("Analíticas: «Mes a mes» desde el mes del piso", () => {
  const filaMes = (dia: string, online: number, tienda: number) => ({
    t: `${dia}T00:00:00-04:00`,
    online,
    tienda,
    envios_online: 2,
    envios_tienda: 1,
  });
  const anio = (...filas: ReturnType<typeof filaMes>[]) => ok(ventas({ serie: filas }));

  it("arranca en noviembre «desde el 16» y la nota dice por qué la tabla empieza ahí", () => {
    const anioDeDatos = anio(filaMes("2026-10-28", 500, 100), filaMes("2026-11-17", 800, 434.5));
    render(<AnaliticasView {...propsAnaliticas({ ventasAnio: anioDeDatos })} />);
    const mensual = document.getElementById("mensual")!;
    const filas = within(within(mensual).getByRole("table")).getAllByRole("row").slice(1);
    expect(filas.map((f) => within(f).getAllByRole("rowheader")[0].textContent)).toEqual(["Noviembre (desde el 16) En curso"]);
    expect(within(mensual).getByText(`${TEXTO_INICIO_PANELES} y por eso la tabla empieza en noviembre.`)).toBeInTheDocument();
  });

  it("en diciembre, diciembre no se compara con un noviembre recortado: su variación es «—»", () => {
    const ahora = new Date("2026-12-15T12:00:00-04:00");
    const anioDeDatos = anio(filaMes("2026-11-17", 800, 400), filaMes("2026-12-02", 1500, 500));
    render(
      <AnaliticasView
        {...propsAnaliticas({
          ahora,
          periodo: "mes",
          rangos: rangosDeAnaliticas("mes", ahora),
          ventasAnio: anioDeDatos,
        })}
      />
    );
    const mensual = document.getElementById("mensual")!;
    const filas = within(within(mensual).getByRole("table")).getAllByRole("row").slice(1);
    expect(filas).toHaveLength(2);
    const diciembre = filas[1];
    expect(within(diciembre).getByRole("rowheader")).toHaveTextContent("Diciembre");
    const celdas = within(diciembre).getAllByRole("cell");
    expect(celdas[celdas.length - 1]).toHaveTextContent("—");
  });

  it("sin piso el corte sigue siendo el primer mes con envíos y no hay nota", () => {
    const anioDeDatos = anio(filaMes("2026-10-28", 500, 100), filaMes("2026-11-17", 800, 434.5));
    render(<AnaliticasView {...propsAnaliticas({ ventasAnio: anioDeDatos, rangos: rangosDeAnaliticas("7d", SABADO_21, null) })} />);
    const mensual = document.getElementById("mensual")!;
    const filas = within(within(mensual).getByRole("table")).getAllByRole("row").slice(1);
    expect(filas.map((f) => within(f).getAllByRole("rowheader")[0].textContent)).toEqual(["Octubre", "Noviembre En curso"]);
    expect(within(mensual).queryByText(/la tabla empieza en/)).toBeNull();
  });
});

describe("los textos y constantes del 26/10/2026 ya no existen en pantalla", () => {
  it("ni el Dashboard ni Analíticas los pintan", () => {
    render(<DashboardView {...propsBase({ ahora: SABADO_21, rangos: rangosDelDashboard("30d", SABADO_21), ventasPrevio: null })} />);
    expect(textoDeLaPagina()).not.toMatch(/26\/10|26 de octubre/);
  });
});
