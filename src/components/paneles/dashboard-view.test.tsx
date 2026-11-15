/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardView } from "@/components/paneles/dashboard-view";
import { rangosDelDashboard } from "@/lib/paneles/rangos";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import {
  AHORA,
  AHORA_DOMINGO,
  activas,
  caido,
  canal,
  conversaciones,
  historia,
  ok,
  propsBase,
  ventas,
  ventasHoy,
} from "@/components/paneles/dashboard/dashboard-fixtures";

/**
 * Plan "Paneles" (13/11/2026), C4: el Dashboard de ventas (`/panel`). Los datos
 * respetan `docs/paneles-contrato.md`. jsdom no calcula layout: la revisión
 * visual (1440, 1024 y 390 px, tema claro y oscuro) se hace en el navegador.
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
});

const seccion = (nombre: string) => screen.getByRole("region", { name: nombre });

describe("DashboardView: las cifras principales", () => {
  it("pinta cada tarjeta con sus cifras formateadas", () => {
    render(<DashboardView {...propsBase()} />);

    const activasSec = seccion("Ventas activas");
    expect(within(activasSec).getByText("$600,00")).toBeInTheDocument();
    expect(within(activasSec).getByText("5 presupuestos y carritos sin enviar")).toBeInTheDocument();

    const enviado = seccion("Enviado a SAINT");
    expect(within(enviado).getByText("$1.234,50")).toBeInTheDocument();
    expect(within(enviado).getByText("en espera de facturar")).toBeInTheDocument();
    expect(within(enviado).getByText("Bs. 49.380,00")).toBeInTheDocument();
    expect(within(enviado).getByText(/\+12,2 %/)).toBeInTheDocument();

    const unidades = seccion("Unidades vendidas");
    expect(within(unidades).getByText("29")).toBeInTheDocument();

    const conversion = seccion("Tasa de conversión");
    expect(within(conversion).getAllByText("20 %").length).toBeGreaterThan(0);
    expect(within(conversion).getByText("8 de 40 conversaciones compraron")).toBeInTheDocument();
  });

  it("sin tasa BCV los bolívares son «—», no cero", () => {
    render(<DashboardView {...propsBase({ tasaBcv: 0 })} />);
    expect(within(seccion("Enviado a SAINT")).getByText("Bs. —")).toBeInTheDocument();
  });

  it("un monto null se pinta «—», nunca $0,00", () => {
    const sinMonto = ventas({
      canales: {
        online: canal({ ingresos: null, envios: 2, sin_monto: 2 }),
        tienda: canal({ ingresos: null, envios: 1, sin_monto: 1 }),
      },
    });
    render(<DashboardView {...propsBase({ ventas: ok(sinMonto) })} />);
    const enviado = seccion("Enviado a SAINT");
    expect(within(enviado).getByText("—", { selector: ".pn-kpi__cifra" })).toBeInTheDocument();
    expect(enviado).not.toHaveTextContent("$0,00");
  });

  it("marca «Estimado» solo cuando hay ventas estimadas", () => {
    const { rerender } = render(<DashboardView {...propsBase()} />);
    expect(within(seccion("Enviado a SAINT")).queryByText("Estimado")).toBeNull();

    const estimadas = ventas({ canales: { online: canal({ ingresos: 100, envios: 1, estimados: 1 }), tienda: canal() } });
    rerender(<DashboardView {...propsBase({ ventas: ok(estimadas) })} />);
    expect(within(seccion("Enviado a SAINT")).getByText("Estimado")).toBeInTheDocument();
  });

  it("dice lo que está en tránsito y los envíos con error", () => {
    const conEstado = ventas({
      estado: { transito: { envios: 2, monto: 332.5 }, error: { envios: 1 }, sin_foto: 0, duplicados: 0 },
    });
    render(<DashboardView {...propsBase({ ventas: ok(conEstado) })} />);
    const enviado = seccion("Enviado a SAINT");
    expect(within(enviado).getByText(/En tránsito:/)).toHaveTextContent("En tránsito: $332,50 (2)");
    expect(within(enviado).getByText(/1 con error/)).toBeInTheDocument();
  });

  it("avisa que los envíos a SAINT existen desde el 26/10 en los períodos que lo cruzan", () => {
    const { rerender } = render(<DashboardView {...propsBase()} />);
    expect(within(seccion("Enviado a SAINT")).queryByText(/se registran desde el 26 de octubre/)).toBeNull();

    rerender(<DashboardView {...propsBase({ periodo: "30d", rangos: rangosDelDashboard("30d", AHORA) })} />);
    expect(within(seccion("Enviado a SAINT")).getByText(/se registran desde el 26 de octubre/)).toBeInTheDocument();
  });
});

describe("DashboardView: bloques caídos", () => {
  it("un bloque caído pinta el degradado y el resto sigue", () => {
    render(<DashboardView {...propsBase({ ventas: caido("No se pudo leer las ventas.") })} />);

    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No disponible/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Reintentar/ }).length).toBeGreaterThan(0);
    // Ventas activas no depende de `ventas`: sigue en pie.
    expect(within(seccion("Ventas activas")).getByText("$600,00")).toBeInTheDocument();
    expect(seccion("Rendimiento de ventas")).toBeInTheDocument();
  });

  it("sin conversaciones, la conversión degrada sin tumbar los ingresos", () => {
    render(<DashboardView {...propsBase({ conversaciones: { ...caido("Las conversaciones fallaron."), recortado: false } })} />);
    expect(within(seccion("Enviado a SAINT")).getByText("$1.234,50")).toBeInTheDocument();
    expect(screen.getAllByText(/Las conversaciones fallaron/).length).toBeGreaterThan(0);
  });
});

describe("DashboardView: En tienda", () => {
  it("no muestra tasa de conversión y explica por qué; en su lugar, envíos por persona", () => {
    render(<DashboardView {...propsBase({ vista: "tienda" })} />);

    const conversion = seccion("Tasa de conversión");
    expect(within(conversion).getByText("—", { selector: ".pn-kpi__cifra" })).toBeInTheDocument();
    expect(within(conversion).getByText(/La caja no registra a quien no compra/)).toBeInTheDocument();
    expect(conversion).not.toHaveTextContent("%");

    const personas = seccion("Envíos por persona");
    expect(within(personas).getByText("Caja 1")).toBeInTheDocument();
    expect(within(personas).getByText("5 envíos")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Conversión por persona" })).toBeNull();
  });

  it("en el resumen la conversión por persona sale con el promedio del equipo y Seba", () => {
    render(<DashboardView {...propsBase()} />);
    const personas = seccion("Conversión por persona");
    expect(within(personas).getByText("Asesor 1")).toBeInTheDocument();
    expect(within(personas).getByText("30 %")).toBeInTheDocument();
    expect(within(personas).getByText("Seba")).toBeInTheDocument();
    expect(within(personas).getByText(/Promedio del equipo/)).toHaveTextContent("20 %");
  });

  it("si Seba no tuvo actividad dice «IA apagada»", () => {
    const sinSeba = conversaciones();
    if (sinSeba.ok) sinSeba.dato.conversion.personas = sinSeba.dato.conversion.personas.filter((p) => p.rol !== "ia");
    render(<DashboardView {...propsBase({ conversaciones: sinSeba })} />);
    expect(within(seccion("Conversión por persona")).getByText(/IA apagada/)).toBeInTheDocument();
  });
});

describe("DashboardView: ventas activas", () => {
  it("sigue la vista: en tienda solo cuenta lo de tienda", () => {
    render(<DashboardView {...propsBase({ vista: "tienda" })} />);
    const sec = seccion("Ventas activas");
    expect(within(sec).getByText("$250,00")).toBeInTheDocument();
    expect(within(sec).getByText("2 presupuestos y carritos sin enviar")).toBeInTheDocument();
  });

  it("marca con un chip lo que lleva más de 7 días", () => {
    render(<DashboardView {...propsBase()} />);
    expect(within(seccion("Ventas activas")).getByText(/Hay 1 de más de 7 días/)).toBeInTheDocument();
  });

  it("la hoja lista los ítems del más viejo al más nuevo", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase({ ventasActivas: ok(activas({ items: activas().items.slice().reverse() })) })} />);

    await user.click(within(seccion("Ventas activas")).getByRole("button", { name: /abrir detalle/i }));

    const dialogo = await screen.findByRole("dialog", { name: "Ventas activas" });
    const filas = within(dialogo).getAllByRole("row").slice(1);
    expect(filas[0]).toHaveTextContent("Pedro Pérez");
    expect(filas[filas.length - 1]).toHaveTextContent("Marta Silva");
    // Un monto sin precio se dice «—», no $0.
    expect(filas[filas.length - 1]).toHaveTextContent("—");
  });

  it("«Lo más viejo» muestra los 5 más viejos y «Ver todas» abre la hoja de ventas activas", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase()} />);

    const viejo = seccion("Lo más viejo sin procesar");
    const nombres = within(viejo).getAllByRole("listitem");
    expect(nombres).toHaveLength(5);
    expect(nombres[0]).toHaveTextContent("Pedro Pérez");

    await user.click(within(viejo).getByRole("button", { name: "Ver todas" }));
    expect(await screen.findByRole("dialog", { name: "Ventas activas" })).toBeInTheDocument();
  });

  it("sin nada pendiente, «Lo más viejo» lo dice", () => {
    render(<DashboardView {...propsBase({ ventasActivas: ok(activas({ items: [], total: 0 })) })} />);
    expect(within(seccion("Lo más viejo sin procesar")).getByText(/Nada sin procesar/)).toBeInTheDocument();
  });
});

describe("DashboardView: rendimiento de ventas", () => {
  it("muestra meta, logrado, porcentaje y faltante", () => {
    render(<DashboardView {...propsBase()} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("$3.000,00")).toBeInTheDocument();
    expect(within(hero).getByText("$600,00", { selector: ".pd-logrado" })).toBeInTheDocument();
    expect(within(hero).getByText("Faltan $2.400,00")).toBeInTheDocument();
    expect(within(hero).getAllByText("20 %").length).toBeGreaterThan(0);
  });

  it("dice «Meta cumplida» cuando lo logrado alcanza la meta", () => {
    const cumplida = ventasHoy({
      canales: { online: canal({ ingresos: 2500, envios: 3 }), tienda: canal({ ingresos: 600, envios: 2 }) },
    });
    render(<DashboardView {...propsBase({ ventasHoy: ok(cumplida) })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("Meta cumplida")).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("Faltan");
  });

  it("con 10 días de historia proyecta el cierre del día", () => {
    render(<DashboardView {...propsBase()} />);
    expect(within(seccion("Rendimiento de ventas")).getByText(/cerrarías el día en/)).toBeInTheDocument();
  });

  it("oculta la proyección sin curva y explica cuándo aparece", () => {
    render(<DashboardView {...propsBase({ ventasHistoria: ok(historia(5)) })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("La proyección aparece con 10 días hábiles de historia.")).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("cerrarías");
  });

  it("un día cerrado dice que la tienda no abre y no deja editar la meta", () => {
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO);
    render(<DashboardView {...propsBase({ ahora: AHORA_DOMINGO, rangos })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("Hoy la tienda no abre")).toBeInTheDocument();
    expect(within(hero).queryByRole("button", { name: /Editar la meta/ })).toBeNull();
  });

  it("en un día cerrado la tarjeta sigue siendo útil: próxima apertura, la meta que regirá y la racha", () => {
    // Domingo 15/11/2026: tres días hábiles seguidos (mié a vie) por encima de la meta de 3.000 → racha de 3.
    const dia = (n: number) => ({
      t: `2026-11-${n}T00:00:00-04:00`,
      online: 2000,
      tienda: 1000,
      envios_online: 4,
      envios_tienda: 2,
    });
    const conRacha = { ...historia(12), serie: [dia(11), dia(12), dia(13)] };
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO);
    render(<DashboardView {...propsBase({ ahora: AHORA_DOMINGO, rangos, ventasHistoria: ok(conRacha) })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("Hoy la tienda no abre")).toBeInTheDocument();
    expect(within(hero).getByText("Próxima apertura")).toBeInTheDocument();
    expect(within(hero).getByText("el lunes a las 8:00 am")).toBeInTheDocument();
    // La meta del lunes 16/11 (resumen: 2.000 + 1.000), no la de hoy.
    expect(within(hero).getByText("Meta de ese día")).toBeInTheDocument();
    expect(within(hero).getByText("$3.000,00")).toBeInTheDocument();
    expect(within(hero).getByText(/Racha: 3 días/)).toBeInTheDocument();
    // Lo del día abierto no se pinta: ni anillo, ni «logrado hoy», ni ritmo.
    expect(hero).not.toHaveTextContent("logrado hoy");
    expect(within(hero).queryByRole("button", { name: /Editar la meta/ })).toBeNull();
  });

  it("en un día cerrado, lo que no se puede calcular es «—»: sin metas leídas no hay meta del lunes", () => {
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO);
    render(<DashboardView {...propsBase({ ahora: AHORA_DOMINGO, rangos, metas: caido("No se pudo leer las metas.") })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("el lunes a las 8:00 am")).toBeInTheDocument();
    expect(within(hero).getByText("Meta de ese día").parentElement).toHaveTextContent("—");
    expect(hero).not.toHaveTextContent("Racha");
  });

  it("en un día abierto no aparece nada de la próxima apertura", () => {
    render(<DashboardView {...propsBase()} />);
    const hero = seccion("Rendimiento de ventas");
    expect(hero).not.toHaveTextContent("Próxima apertura");
    expect(hero).not.toHaveTextContent("Meta de ese día");
  });

  it("sin meta definida el porcentaje es «—», no 0 %", () => {
    render(<DashboardView {...propsBase({ metas: ok([]) })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("Sin meta definida")).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("0 %");
  });

  it("editar la meta de un canal llama a guardarMetaVenta con canal, monto y el día de hoy", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase({ vista: "online" })} />);
    const hero = seccion("Rendimiento de ventas");

    await user.click(within(hero).getByRole("button", { name: "Editar la meta diaria" }));
    const campo = within(hero).getByLabelText("Meta del día (USD)");
    await user.clear(campo);
    await user.type(campo, "2500");
    await user.click(within(hero).getByRole("button", { name: "Guardar meta" }));

    await waitFor(() => expect(guardarMetaVenta).toHaveBeenCalledTimes(1));
    expect(guardarMetaVenta).toHaveBeenCalledWith(clienteFalso, "online", 2500, "2026-11-13");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const { toast } = await import("@heroui/react");
    expect(toast.success).toHaveBeenCalled();
  });

  it("en el resumen se editan las dos metas y solo se guarda la que cambió", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase()} />);
    const hero = seccion("Rendimiento de ventas");

    await user.click(within(hero).getByRole("button", { name: "Editar la meta diaria" }));
    const tienda = within(hero).getByLabelText("Meta en tienda (USD)");
    await user.clear(tienda);
    await user.type(tienda, "1200");
    await user.click(within(hero).getByRole("button", { name: "Guardar meta" }));

    await waitFor(() => expect(guardarMetaVenta).toHaveBeenCalledTimes(1));
    expect(guardarMetaVenta).toHaveBeenCalledWith(clienteFalso, "tienda", 1200, "2026-11-13");
  });

  it("si no se puede guardar, avisa con el motivo y no refresca", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    guardarMetaVenta.mockRejectedValue(new ConfigWriteDeniedError());
    render(<DashboardView {...propsBase({ vista: "tienda" })} />);
    const hero = seccion("Rendimiento de ventas");

    await user.click(within(hero).getByRole("button", { name: "Editar la meta diaria" }));
    await user.click(within(hero).getByRole("button", { name: "Guardar meta" }));

    const { toast } = await import("@heroui/react");
    await waitFor(() => expect(toast.danger).toHaveBeenCalled());
    expect(guardarMetaVenta).toHaveBeenCalledWith(clienteFalso, "tienda", 1000, "2026-11-13");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rechaza una meta que no es un monto positivo antes de llamar a la base", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase({ vista: "online" })} />);
    const hero = seccion("Rendimiento de ventas");

    await user.click(within(hero).getByRole("button", { name: "Editar la meta diaria" }));
    const campo = within(hero).getByLabelText("Meta del día (USD)");
    await user.clear(campo);
    await user.type(campo, "0");
    await user.click(within(hero).getByRole("button", { name: "Guardar meta" }));

    expect(guardarMetaVenta).not.toHaveBeenCalled();
    expect(within(hero).getByRole("alert")).toHaveTextContent(/mayor que cero/);
  });

  it("cuenta la racha de días con la meta cumplida", () => {
    // Historia de 2 días (11 y 12/11, jueves y miércoles... con meta online 2000) cumplidos.
    const hist = historia(12);
    hist.serie = [
      { t: "2026-11-11T00:00:00-04:00", online: 2500, tienda: 0, envios_online: 3, envios_tienda: 0 },
      { t: "2026-11-12T00:00:00-04:00", online: 2200, tienda: 0, envios_online: 3, envios_tienda: 0 },
    ];
    render(<DashboardView {...propsBase({ vista: "online", ventasHistoria: ok(hist) })} />);
    expect(within(seccion("Rendimiento de ventas")).getByText(/Racha: 2 días/)).toBeInTheDocument();
  });
});

describe("DashboardView: tablero mensual", () => {
  const anioDesdeOctubre = () =>
    ok(
      ventas({
        granularidad: "dia",
        serie: [
          { t: "2026-10-28T00:00:00-04:00", online: 2000, tienda: 800, envios_online: 20, envios_tienda: 8 },
          { t: "2026-11-12T00:00:00-04:00", online: 800, tienda: 434.5, envios_online: 8, envios_tienda: 5 },
        ],
      })
    );
  const mesesDeLaTabla = (tablero: HTMLElement) =>
    within(tablero)
      .getAllByRole("rowheader")
      .map((c) => c.textContent);

  it("agrupa por mes, marca el mes en curso y aclara desde cuándo hay envíos", () => {
    render(<DashboardView {...propsBase({ ventasAnio: anioDesdeOctubre() })} />);
    const tablero = seccion("Ingresos por mes");
    expect(within(tablero).getByText(/mes en curso/i)).toBeInTheDocument();
    expect(within(tablero).getByText(/se registran desde el 26 de octubre/)).toBeInTheDocument();
  });

  it("parte del primer mes con envíos: de enero a septiembre no hay columnas ni filas (15/11/2026)", () => {
    render(<DashboardView {...propsBase({ ventasAnio: anioDesdeOctubre() })} />);
    const tablero = seccion("Ingresos por mes");
    // Octubre, noviembre (en curso) y diciembre (futuro): ningún mes sin registro.
    expect(mesesDeLaTabla(tablero)).toEqual(["octubre", "noviembre", "diciembre"]);
    for (const etiqueta of ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep"]) {
      expect(within(tablero).queryByText(etiqueta)).not.toBeInTheDocument();
    }
    expect(within(tablero).getByText("Oct")).toBeInTheDocument();
    expect(within(tablero).getByText("Nov")).toBeInTheDocument();
  });

  it("el primer mes sale de todos los canales, no del que filtra la vista", () => {
    // Septiembre solo tiene tienda; la vista online debe seguir arrancando en septiembre.
    const anio = ok(
      ventas({
        granularidad: "dia",
        serie: [
          { t: "2026-09-15T00:00:00-04:00", online: 0, tienda: 300, envios_online: 0, envios_tienda: 3 },
          { t: "2026-11-12T00:00:00-04:00", online: 800, tienda: 0, envios_online: 8, envios_tienda: 0 },
        ],
      })
    );
    render(<DashboardView {...propsBase({ vista: "online", ventasAnio: anio })} />);
    expect(mesesDeLaTabla(seccion("Ingresos por mes"))[0]).toBe("septiembre");
  });

  it("sin envíos en el año muestra un estado vacío honesto, sin columnas ni tabla", () => {
    render(<DashboardView {...propsBase({ ventasAnio: ok(ventas({ granularidad: "dia", serie: [] })) })} />);
    const tablero = seccion("Ingresos por mes");
    expect(within(tablero).getByText(/todavía no hay envíos a SAINT este año/i)).toBeInTheDocument();
    expect(within(tablero).queryByRole("table")).not.toBeInTheDocument();
    expect(within(tablero).queryByText("Ene")).not.toBeInTheDocument();
    expect(within(tablero).getByText(/se registran desde el 26 de octubre/)).toBeInTheDocument();
  });
});

describe("DashboardView: la hoja de Enviado a SAINT", () => {
  it("lista los repuestos y las personas con lo que enviaron", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase()} />);

    await user.click(within(seccion("Enviado a SAINT")).getByRole("button", { name: /abrir detalle/i }));
    const dialogo = await screen.findByRole("dialog", { name: "Enviado a SAINT" });
    expect(within(dialogo).getByText("Pastillas de freno SBR")).toBeInTheDocument();
    expect(within(dialogo).getByText("Asesor 1")).toBeInTheDocument();
    expect(within(dialogo).getByText("Caja 1")).toBeInTheDocument();
  });
});
