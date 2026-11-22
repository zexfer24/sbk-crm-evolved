/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardView } from "@/components/paneles/dashboard-view";
import { rangosDelDashboard } from "@/lib/paneles/rangos";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import {
  AHORA,
  AHORA_ACTIVAS,
  AHORA_DOMINGO,
  activas,
  activasComoHoy,
  activasConDesglose,
  caido,
  canal,
  conversaciones,
  historia,
  ok,
  propsBase,
  ventas,
  ventasHoy,
} from "@/components/paneles/dashboard/dashboard-fixtures";

// Estos tests describen el canal «tienda» visible (D1, 21/11/2026: hoy está oculto); `tienda-oculta.test.tsx` cubre el caso oculto.
vi.mock("@/lib/paneles/canal-config", () => ({ CANAL_TIENDA_VISIBLE: true }));

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
    expect(within(activasSec).getByText("5 sin enviar")).toBeInTheDocument();

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

  it("ya no habla del 26/10: el aviso de inicio es el del piso, y sin piso no hay ninguno", () => {
    const { rerender } = render(<DashboardView {...propsBase()} />);
    expect(within(seccion("Enviado a SAINT")).queryByText(/26 de octubre|Los paneles cuentan/)).toBeNull();

    rerender(<DashboardView {...propsBase({ periodo: "30d", rangos: rangosDelDashboard("30d", AHORA, null) })} />);
    expect(within(seccion("Enviado a SAINT")).queryByText(/26 de octubre|Los paneles cuentan/)).toBeNull();
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
    expect(within(sec).getByText("2 sin enviar")).toBeInTheDocument();
  });

  it("marca con un chip lo que está por vencer (más de 24 h sin moverse)", () => {
    render(<DashboardView {...propsBase()} />);
    const sec = seccion("Ventas activas");
    // Sin desglose se cuentan los ítems de la vista con más de 24 h: p-viejo, c-medio y p-medio.
    expect(within(sec).getByText("3 por vencer")).toBeInTheDocument();
    expect(sec.textContent).toMatch(/a las 48 h salen del conteo \(no se borran\)/);
    expect(sec.textContent).not.toMatch(/de más de 7 días/);
  });

  it("sin desglose (base vieja) la tarjeta conserva el reparto presupuestos/carritos y no inventa bloques", () => {
    render(<DashboardView {...propsBase()} />);
    const sec = seccion("Ventas activas");
    expect(within(sec).getByRole("img", { name: "Reparto entre presupuestos (3) y carritos (2)" })).toBeInTheDocument();
    expect(within(sec).queryByText("De dónde")).toBeNull();
    expect(within(sec).queryByText("Quién lo armó")).toBeNull();
    expect(within(sec).queryByText("Se puede escribir")).toBeNull();
    expect(within(sec).getByText("Ahora mismo · no depende del período")).toBeInTheDocument();
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
    expect(within(hero).getByText("La proyección aparece con 10 días con ventas (van 5)")).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("cerrarías");
  });

  it("un día cerrado dice que la tienda no abre y sí deja editar la meta", () => {
    // 15/11/2026: la fila nueva rige desde hoy, así que en un día cerrado fija la meta del próximo día hábil.
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO, null);
    render(<DashboardView {...propsBase({ ahora: AHORA_DOMINGO, rangos })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("Hoy la tienda no abre")).toBeInTheDocument();
    expect(within(hero).getByRole("button", { name: "Editar la meta diaria" })).toBeInTheDocument();
  });

  it("en un día cerrado, editar la meta de un canal llama a guardarMetaVenta con el día de hoy y refresca", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO, null);
    expect(rangos.hoyClave).toBe("2026-11-15");
    render(<DashboardView {...propsBase({ ahora: AHORA_DOMINGO, rangos, vista: "online" })} />);
    const hero = seccion("Rendimiento de ventas");

    await user.click(within(hero).getByRole("button", { name: "Editar la meta diaria" }));
    const campo = within(hero).getByLabelText("Meta del día (USD)");
    await user.clear(campo);
    await user.type(campo, "2500");
    await user.click(within(hero).getByRole("button", { name: "Guardar meta" }));

    await waitFor(() => expect(guardarMetaVenta).toHaveBeenCalledTimes(1));
    expect(guardarMetaVenta).toHaveBeenCalledWith(clienteFalso, "online", 2500, "2026-11-15");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("en un día cerrado, el lápiz del resumen abre los dos campos (online y tienda)", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO, null);
    render(<DashboardView {...propsBase({ ahora: AHORA_DOMINGO, rangos })} />);
    const hero = seccion("Rendimiento de ventas");

    await user.click(within(hero).getByRole("button", { name: "Editar la meta diaria" }));
    expect(within(hero).getByLabelText("Meta online (USD)")).toHaveValue(2000);
    expect(within(hero).getByLabelText("Meta en tienda (USD)")).toHaveValue(1000);
    expect(within(hero).getByRole("button", { name: "Cancelar" })).toBeInTheDocument();

    const tienda = within(hero).getByLabelText("Meta en tienda (USD)");
    await user.clear(tienda);
    await user.type(tienda, "1200");
    await user.click(within(hero).getByRole("button", { name: "Guardar meta" }));
    await waitFor(() => expect(guardarMetaVenta).toHaveBeenCalledTimes(1));
    expect(guardarMetaVenta).toHaveBeenCalledWith(clienteFalso, "tienda", 1200, "2026-11-15");
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
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO, null);
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
    expect(within(hero).getByRole("button", { name: "Editar la meta diaria" })).toBeInTheDocument();
  });

  it("en un día cerrado, lo que no se puede calcular es «—»: sin metas leídas no hay meta del lunes", () => {
    const rangos = rangosDelDashboard("hoy", AHORA_DOMINGO, null);
    render(<DashboardView {...propsBase({ ahora: AHORA_DOMINGO, rangos, metas: caido("No se pudo leer las metas.") })} />);
    const hero = seccion("Rendimiento de ventas");
    expect(within(hero).getByText("el lunes a las 8:00 am")).toBeInTheDocument();
    expect(within(hero).getByText("Meta de ese día").parentElement).toHaveTextContent("—");
    expect(hero).not.toHaveTextContent("Racha");
    // Sin metas leídas tampoco hay lápiz: igual que en un día abierto, solo con la lista.
    expect(within(hero).queryByRole("button", { name: /Editar la meta/ })).toBeNull();
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

  it("agrupa por mes y marca el mes en curso", () => {
    render(<DashboardView {...propsBase({ ventasAnio: anioDesdeOctubre() })} />);
    const tablero = seccion("Ingresos por mes");
    expect(within(tablero).getByText(/mes en curso/i)).toBeInTheDocument();
    // Sin piso no hay nota de inicio, y la del 26/10 ya no existe.
    expect(within(tablero).queryByText(/26 de octubre|Los paneles cuentan/)).toBeNull();
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
    expect(within(tablero).queryByText(/26 de octubre/)).toBeNull();
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

// ---------------------------------------------------------------------------
// Ventas activas con el desglose de la base (22/11/2026)
// ---------------------------------------------------------------------------

/** La fila (<li>) de un bloque de la tarjeta, buscada por su etiqueta. */
const fila = (contenedor: HTMLElement, etiqueta: string) => {
  const li = within(contenedor).getByText(etiqueta).closest("li");
  if (!li) throw new Error(`No hay una fila «${etiqueta}».`);
  return li as HTMLElement;
};

const propsConDesglose = (extra: Parameters<typeof propsBase>[0] = {}) =>
  propsBase({ ahora: AHORA_ACTIVAS, ventasActivas: ok(activasConDesglose()), ...extra });

const abrirHojaDeActivas = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(seccion("Ventas activas")).getByRole("button", { name: /abrir detalle/i }));
  return screen.findByRole("dialog", { name: "Ventas activas" });
};

describe("DashboardView: ventas activas con desglose", () => {
  it("«De dónde» da la cantidad y el monto de cada origen, y la barra los reparte", () => {
    render(<DashboardView {...propsConDesglose()} />);
    const sec = seccion("Ventas activas");
    expect(within(sec).getByText("$700,00")).toBeInTheDocument();
    expect(within(sec).getByText("7 sin enviar")).toBeInTheDocument();

    expect(within(fila(sec, "Carritos del chat")).getByText("4")).toBeInTheDocument();
    expect(within(fila(sec, "Carritos del chat")).getByText("$260,00")).toBeInTheDocument();
    expect(within(fila(sec, "Presupuestos del chat")).getByText("$200,00")).toBeInTheDocument();
    expect(within(fila(sec, "Presupuestos de Inventario")).getByText("2")).toBeInTheDocument();
    expect(within(fila(sec, "Presupuestos de Inventario")).getByText("$240,00")).toBeInTheDocument();

    expect(
      within(sec).getByRole("img", {
        name: "Reparto por origen: Carritos del chat (4), Presupuestos del chat (1), Presupuestos de Inventario (2)",
      })
    ).toBeInTheDocument();
  });

  it("«Quién lo armó» separa por el rol de quien armó la venta, no por el canal", () => {
    render(<DashboardView {...propsConDesglose()} />);
    const sec = seccion("Ventas activas");
    expect(within(fila(sec, "Asesores online")).getByText("5")).toBeInTheDocument();
    expect(within(fila(sec, "Asesores online")).getByText("$490,00")).toBeInTheDocument();
    expect(within(fila(sec, "Tienda (caja)")).getByText("$150,00")).toBeInTheDocument();
    expect(within(fila(sec, "Sin dato")).getByText("$60,00")).toBeInTheDocument();
  });

  it("«Se puede escribir» suma abierta y por cerrar, avisa lo que cierra pronto y cuenta aparte lo cerrado y lo sin chat", () => {
    render(<DashboardView {...propsConDesglose()} />);
    const sec = seccion("Ventas activas");
    const abierta = fila(sec, "Ventana abierta");
    expect(within(abierta).getByText("4")).toBeInTheDocument();
    expect(within(abierta).getByText("$400,00")).toBeInTheDocument();
    expect(within(sec).getByText("1 cierra en menos de 4 h")).toBeInTheDocument();
    expect(within(fila(sec, "Ventana cerrada (solo plantilla)")).getByText("$60,00")).toBeInTheDocument();
    expect(within(fila(sec, "Sin chat")).getByText("$240,00")).toBeInTheDocument();
  });

  it("en plural el aviso dice «N cierran en menos de 4 h»", () => {
    const base = activasConDesglose();
    const dg = base.desglose!;
    render(
      <DashboardView
        {...propsConDesglose({
          ventasActivas: ok({
            ...base,
            desglose: { ...dg, por_ventana: { ...dg.por_ventana, por_cerrar: { monto: 160, cantidad: 2 } } },
          }),
        })}
      />
    );
    expect(within(seccion("Ventas activas")).getByText("2 cierran en menos de 4 h")).toBeInTheDocument();
  });

  it("el pie dice que cuenta lo movido en 48 h y cuántos más viejos quedaron fuera (sin borrarlos)", () => {
    render(<DashboardView {...propsConDesglose()} />);
    expect(seccion("Ventas activas").textContent).toMatch(
      /Ahora mismo · movidos en las últimas 48 h · 6 más viejos fuera del conteo \(no se borraron\)/
    );
  });

  it("sin nada fuera del conteo el pie no menciona más viejos", () => {
    const base = activasConDesglose();
    const dg = base.desglose!;
    const sinFuera = { carritos: 0, presupuestos: 0, por_origen: { carrito_chat: 0, presupuesto_chat: 0, presupuesto_inventario: 0 } };
    render(<DashboardView {...propsConDesglose({ ventasActivas: ok({ ...base, desglose: { ...dg, fuera_de_ventana: sinFuera } }) })} />);
    const texto = seccion("Ventas activas").textContent ?? "";
    expect(texto).toMatch(/Ahora mismo · movidos en las últimas 48 h/);
    expect(texto).not.toMatch(/fuera del conteo/);
  });

  it("«por vencer» sale del tramo de 48 h de la base", () => {
    render(<DashboardView {...propsConDesglose()} />);
    expect(within(seccion("Ventas activas")).getByText("2 por vencer")).toBeInTheDocument();
  });

  it("en la vista Online no aparece el presupuesto de Inventario y «Quién lo armó» solo cuenta orígenes online", () => {
    render(<DashboardView {...propsConDesglose({ vista: "online" })} />);
    const sec = seccion("Ventas activas");
    expect(within(sec).queryByText("Presupuestos de Inventario")).toBeNull();
    expect(within(sec).getByText("5 sin enviar")).toBeInTheDocument();
    // El presupuesto de Inventario armado por un asesor NO suma al equipo online de esta vista (4, no 5).
    expect(within(fila(sec, "Asesores online")).getByText("4")).toBeInTheDocument();
    expect(within(fila(sec, "Asesores online")).getByText("$400,00")).toBeInTheDocument();
    expect(within(sec).getByRole("img", { name: "Reparto por origen: Carritos del chat (4), Presupuestos del chat (1)" })).toBeInTheDocument();
  });

  it("como está hoy en producción: todo son carritos del chat, sin fila de presupuestos del chat ni de sin dato", () => {
    render(<DashboardView {...propsBase({ ahora: AHORA_ACTIVAS, ventasActivas: ok(activasComoHoy()) })} />);
    const sec = seccion("Ventas activas");
    expect(within(sec).getByText("4 sin enviar")).toBeInTheDocument();
    expect(within(fila(sec, "Carritos del chat")).getByText("$260,00")).toBeInTheDocument();
    expect(within(sec).queryByText("Presupuestos del chat")).toBeNull();
    expect(within(sec).queryByText("Sin dato")).toBeNull();
    // Inventario sí es origen del Resumen, aunque esté en 0.
    expect(within(fila(sec, "Presupuestos de Inventario")).getByText("0")).toBeInTheDocument();
    expect(within(sec).getByText("1 cierra en menos de 4 h")).toBeInTheDocument();
  });

  it("la hoja explica el conteo de 48 h", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsConDesglose()} />);
    const hoja = await abrirHojaDeActivas(user);
    expect(hoja.textContent).toMatch(/movidos en las últimas 48 h/);
    expect(hoja.textContent).toMatch(/sigue en el chat y en Inventario, pero no cuenta acá/);
  });

  it("la hoja trae la matriz «De dónde y quién lo armó» con celdas «N · $X»", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsConDesglose()} />);
    const hoja = await abrirHojaDeActivas(user);

    const matriz = within(hoja).getByRole("table", { name: "De dónde y quién lo armó" });
    expect(within(matriz).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([
      "Origen",
      "Online",
      "Tienda (caja)",
      "Sin dato",
      "Total",
    ]);
    const carritos = within(matriz).getByText("Carritos del chat").closest("tr")!;
    expect(within(carritos).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "3 · $200,00",
      "0",
      "1 · $60,00",
      "4 · $260,00",
    ]);
    const inventario = within(matriz).getByText("Presupuestos de Inventario").closest("tr")!;
    expect(within(inventario).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "1 · $90,00",
      "1 · $150,00",
      "0",
      "2 · $240,00",
    ]);
  });

  it("la hoja trae la tabla «Ventana de WhatsApp» con cada estado", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsConDesglose()} />);
    const hoja = await abrirHojaDeActivas(user);

    const tabla = within(hoja).getByRole("table", { name: "Ventana de WhatsApp" });
    const celdas = (nombre: string) =>
      within(within(tabla).getByRole("rowheader", { name: nombre }).closest("tr")!)
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(celdas("Abierta")).toEqual(["3", "$320,00"]);
    expect(celdas("Por cerrar")).toEqual(["1", "$80,00"]);
    expect(celdas("Cerrada")).toEqual(["1", "$60,00"]);
    expect(celdas("Sin chat")).toEqual(["2", "$240,00"]);
  });

  it("la lista suma Equipo y Ventana («quedan N h») y «Abrir chat» solo en abierta y por cerrar", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsConDesglose()} />);
    const hoja = await abrirHojaDeActivas(user);

    const lista = within(hoja).getByRole("table", { name: "Presupuestos y carritos sin enviar" });
    expect(within(lista).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([
      "Tipo",
      "Canal",
      "Responsable",
      "Equipo",
      "Cliente",
      "Monto",
      "Antigüedad",
      "Ventana",
    ]);

    const filaDe = (cliente: string) => within(lista).getByText(cliente).closest("tr")!;
    // Abierta: dice cuánto le queda y enlaza al chat.
    const abierta = filaDe("Marta Silva");
    expect(abierta).toHaveTextContent("quedan 10 h");
    expect(within(abierta).getByRole("link", { name: "Abrir chat" })).toHaveAttribute("href", "/inbox?conversation=conv-p-chat");
    // Por cerrar: chip de alerta y enlace.
    const porCerrar = filaDe("Ana Gómez");
    expect(within(porCerrar).getByText("quedan 2 h").className).toMatch(/pn-chip--alerta/);
    expect(within(porCerrar).getByRole("link", { name: "Abrir chat" })).toHaveAttribute(
      "href",
      "/inbox?conversation=conv-c-por-cerrar"
    );
    // Cerrada: se dice, pero ya no se le puede escribir: sin enlace.
    const cerrada = filaDe("Rosa Díaz");
    expect(cerrada).toHaveTextContent("Cerrada");
    expect(within(cerrada).queryByRole("link", { name: "Abrir chat" })).toBeNull();
    // Sin chat (presupuesto de Inventario): sin enlace y con su texto.
    const sinChat = filaDe("Luis Rojas");
    expect(sinChat).toHaveTextContent("Sin chat");
    expect(within(sinChat).queryByRole("link", { name: "Abrir chat" })).toBeNull();
    // El equipo se dice con palabras de negocio.
    expect(filaDe("Pedro Pérez")).toHaveTextContent("Tienda (caja)");
    expect(abierta).toHaveTextContent("Online");
    expect(cerrada).toHaveTextContent("Sin dato");
  });

  it("el filtro de ventana de la hoja deja solo el estado elegido", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsConDesglose()} />);
    const hoja = await abrirHojaDeActivas(user);
    const lista = () => within(hoja).getByRole("table", { name: "Presupuestos y carritos sin enviar" });

    expect(within(lista()).getAllByRole("row")).toHaveLength(1 + 7);
    await user.click(within(hoja).getByRole("button", { name: "Por cerrar" }));
    expect(within(lista()).getAllByRole("row")).toHaveLength(1 + 1);
    expect(within(lista()).getByText("Ana Gómez")).toBeInTheDocument();
    await user.click(within(hoja).getByRole("button", { name: "Abierta" }));
    expect(within(lista()).getAllByRole("row")).toHaveLength(1 + 3);
    await user.click(within(hoja).getByRole("button", { name: "Cerrada" }));
    expect(within(lista()).getByText("Rosa Díaz")).toBeInTheDocument();
    expect(within(lista()).getAllByRole("row")).toHaveLength(1 + 1);
  });

  it("la hoja muestra 8 filas y «Ver todas (N)» abre el resto; con 300 avisa que son los más viejos", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const base = activasConDesglose();
    const muchos = Array.from({ length: 300 }, (_, i) => ({ ...base.items[5], id: `extra-${i}`, cliente: `Cliente ${i}` }));
    render(<DashboardView {...propsConDesglose({ ventasActivas: ok({ ...base, items: muchos }) })} />);
    const hoja = await abrirHojaDeActivas(user);
    const lista = () => within(hoja).getByRole("table", { name: "Presupuestos y carritos sin enviar" });

    expect(within(lista()).getAllByRole("row")).toHaveLength(1 + 8);
    expect(hoja.textContent).toMatch(/Se muestran los 300 más viejos\./);
    await user.click(within(hoja).getByRole("button", { name: "Ver todas (300)" }));
    expect(within(lista()).getAllByRole("row")).toHaveLength(1 + 300);
    await user.click(within(hoja).getByRole("button", { name: "Ver menos" }));
    expect(within(lista()).getAllByRole("row")).toHaveLength(1 + 8);
  });

  it("la hoja de una base vieja no pinta matriz, ni columnas de equipo y ventana, ni filtro", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<DashboardView {...propsBase()} />);
    const hoja = await abrirHojaDeActivas(user);
    expect(within(hoja).queryByRole("table", { name: "De dónde y quién lo armó" })).toBeNull();
    expect(within(hoja).queryByRole("table", { name: "Ventana de WhatsApp" })).toBeNull();
    expect(within(hoja).queryByRole("columnheader", { name: "Equipo" })).toBeNull();
    expect(within(hoja).queryByRole("columnheader", { name: "Ventana" })).toBeNull();
    expect(within(hoja).queryByRole("button", { name: "Por cerrar" })).toBeNull();
  });
});

describe("DashboardView: «Tienda (caja)» con el canal visible", () => {
  it("la fila aparece aunque la caja no haya armado nada: un 0 es información", () => {
    render(<DashboardView {...propsBase({ ahora: AHORA_ACTIVAS, ventasActivas: ok(activasComoHoy()) })} />);
    const sec = seccion("Ventas activas");
    const filaCaja = within(sec).getByText("Tienda (caja)").closest("li")!;
    expect(within(filaCaja).getByText("0")).toBeInTheDocument();
    // Con la tienda visible no hace falta ningún aviso de «tienda oculta».
    expect(sec.textContent).not.toMatch(/la tienda está oculta/);
  });
});
