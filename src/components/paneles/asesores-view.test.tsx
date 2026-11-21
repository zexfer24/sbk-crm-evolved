/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AsesoresView, type AsesoresViewProps } from "@/components/paneles/asesores-view";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import type { PanelAsesores, PanelCola, PanelConversaciones, PanelVentas, PersonaAsesores } from "@/lib/paneles/parse";

// Estos tests describen el canal «tienda» visible (D1, 21/11/2026: hoy está oculto); `tienda-oculta.test.tsx` cubre el caso oculto.
vi.mock("@/lib/paneles/canal-config", () => ({ CANAL_TIENDA_VISIBLE: true }));

/**
 * Plan "Paneles" (13/11/2026), C6: la pantalla de Asesores con un fixture que
 * respeta `docs/paneles-contrato.md`. jsdom no calcula layout: la revisión
 * visual la hace el orquestador en el navegador; acá se verifica contenido,
 * orden, filtros, degradación por bloque y que todos los relojes cuelguen de UN
 * solo `setInterval`.
 */

const replace = vi.fn();
const refresh = vi.fn();
let parametros = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  usePathname: () => "/panel/asesores",
  useSearchParams: () => parametros,
}));
vi.mock("@/components/app-rail", () => ({
  AppRail: () => <nav data-testid="rail" />,
  AppTopNav: () => <nav data-testid="topnav" />,
}));

// Viernes 13/11/2026, 3:00 p. m. en Caracas (L–V 08:00–18:00).
const AHORA = new Date("2026-11-13T15:00:00-04:00");
const DESDE_MAS_VIEJO = "2026-11-13T13:00:00-04:00"; // 2 h de reloj = 120 min laborales

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

const horas = (picos: Record<number, number>) => Array.from({ length: 24 }, (_, h) => picos[h] ?? 0);

const ANA = persona({
  agent_id: "a1",
  nombre: "Ana Gómez",
  conversaciones: 40,
  mensajes: 300,
  contactos: 35,
  episodios: 30,
  primera_resp_mediana_min: 2.4,
  primera_resp_p90_min: 9,
  en_5min: 0.8,
  envios: 5,
  envios_online: 5,
  envios_tienda: 0,
  monto: 500,
  reasignadas_desde: 1,
  ultimo_mensaje: "2026-11-13T14:20:00-04:00",
  actividad_hora: horas({ 9: 12, 14: 40 }),
});
const BETO = persona({
  agent_id: "b1",
  nombre: "Beto Díaz",
  rol: "supervisor",
  en_reparto: false,
  conversaciones: 20,
  mensajes: 500,
  contactos: 18,
  episodios: 12,
  primera_resp_mediana_min: 6,
  primera_resp_p90_min: 20,
  en_5min: null,
  envios: 2,
  envios_tienda: 2,
  monto: 90,
  ultimo_mensaje: "2026-11-12T10:00:00-04:00",
});
const CARLA = persona({
  agent_id: "c1",
  nombre: "Carla Caja",
  rol: "caja",
  en_reparto: false,
  envios: 4,
  envios_tienda: 4,
  monto: 120,
});

function asesoresDato(extra: Partial<PanelAsesores> = {}): PanelAsesores {
  return {
    personas: [ANA, BETO, CARLA],
    seba: { mensajes: 120, conversaciones: 45, ultimo: "2026-11-13T14:50:00-04:00" },
    equipo: { episodios: 42, primera_resp_mediana_min: 3.2, en_5min: 0.72 },
    ...extra,
  };
}

function conversacionesDato(): PanelConversaciones {
  return {
    embudo: { escribieron: 100, respondidas: 90, con_carrito: 30, compraron: 12 },
    resultados: { compraron: 12, reclamo: 1, carrito_sin_compra: 18, solo_preguntaron: 59, sin_respuesta: 10 },
    conversion: {
      equipo: { atendidas: 90, compraron: 12 },
      personas: [
        { agent_id: "a1", nombre: "Ana Gómez", rol: "agent", atendidas: 40, compraron: 10 },
        { agent_id: "b1", nombre: "Beto Díaz", rol: "supervisor", atendidas: 20, compraron: 2 },
        { agent_id: null, nombre: "Seba", rol: "ia", atendidas: 45, compraron: 3 },
      ],
    },
    calor: { valores: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)) },
  };
}

function canal(extra: Partial<PanelVentas["canales"]["online"]> = {}) {
  return { ingresos: 0, envios: 0, unidades: 0, ticket: null, estimados: 0, sin_monto: 0, ...extra };
}

function ventasDato(estimados = 0): PanelVentas {
  return {
    granularidad: "dia",
    canales: {
      online: canal({ ingresos: 500, envios: 5, unidades: 9, ticket: 100, estimados }),
      tienda: canal({ ingresos: 210, envios: 6, unidades: 11, ticket: 35 }),
    },
    serie: [],
    perfil_horario: [],
    personas: [
      { agent_id: "a1", nombre: "Ana Gómez", rol: "agent", canal: "online", ingresos: 500, envios: 5, unidades: 9 },
      { agent_id: "c1", nombre: "Carla Caja", rol: "caja", canal: "tienda", ingresos: 120, envios: 4, unidades: 6 },
      { agent_id: "b1", nombre: "Beto Díaz", rol: "supervisor", canal: "tienda", ingresos: 90, envios: 2, unidades: 5 },
    ],
    top_repuestos: [],
    tipo_precio: { online: { promocion: 0, estandar: 0 }, tienda: { promocion: 0, estandar: 0 } },
    estado: { transito: { envios: 0, monto: null }, error: { envios: 0 }, sin_foto: 0, duplicados: 0 },
    recurrentes: {
      online: { compradores: 0, regresan: 0 },
      tienda: { compradores: 0, regresan: 0 },
      genericos_excluidos: 0,
    },
  } as PanelVentas;
}

function colaDato(extra: Partial<PanelCola> = {}): PanelCola {
  return {
    corte_dias: 7,
    pendientes: 25,
    sin_dueno: 10,
    con_dueno: 15,
    abandonadas: 3,
    por_antiguedad: { menos_1h: 5, de_1_a_4h: 10, de_4_a_24h: 7, de_1_a_7d: 3 },
    mas_viejo: { conversation_id: "k1", desde: DESDE_MAS_VIEJO, contacto: "Pedro Pérez", asesor: null },
    lista: [
      { conversation_id: "k1", desde: DESDE_MAS_VIEJO, contacto: "Pedro Pérez", asesor_id: null, asesor: null },
      { conversation_id: "k2", desde: "2026-11-13T14:00:00-04:00", contacto: "María Ruiz", asesor_id: "a1", asesor: "Ana Gómez" },
      { conversation_id: "k3", desde: "2026-11-13T14:30:00-04:00", contacto: "Luis Soto", asesor_id: null, asesor: null },
    ],
    ...extra,
  };
}

const FALLO = { ok: false as const, motivo: "error" as const, detalle: "La lectura falló." };

function props(extra: Partial<AsesoresViewProps> = {}): AsesoresViewProps {
  return {
    periodo: "hoy",
    ahora: AHORA,
    rango: { desde: new Date("2026-11-13T04:00:00Z"), hasta: AHORA, etiqueta: "Hoy" },
    asesores: { ok: true, dato: asesoresDato(), recortado: false },
    conversaciones: { ok: true, dato: conversacionesDato(), recortado: false },
    ventas: { ok: true, dato: ventasDato() },
    cola: { ok: true, dato: colaDato() },
    horario: DEFAULT_BUSINESS_HOURS,
    ...extra,
  };
}

function filasDeTabla(): string[] {
  const tabla = screen.getByRole("table", { name: /rendimiento por persona/i });
  return within(tabla)
    .getAllByRole("row")
    .slice(1)
    .map((fila) => within(within(fila).getAllByRole("cell")[0]).getByRole("button").textContent ?? "");
}

beforeEach(() => {
  replace.mockClear();
  refresh.mockClear();
  parametros = new URLSearchParams();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AsesoresView · control de período", () => {
  it("ofrece solo Hoy, 7 días y 30 días, y ningún selector de vista", () => {
    render(<AsesoresView {...props()} />);
    const grupo = screen.getByRole("group", { name: "Período" });
    const nombres = within(grupo)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(nombres).toEqual(["Hoy", "7 días", "30 días"]);
    expect(screen.queryByRole("group", { name: "Canal" })).toBeNull();
  });

  it("la lista de períodos es siempre la misma: no pinta ninguna opción extra", () => {
    // 15/11/2026: la página ya no deja pasar mes/anio, así que el control no
    // tiene rama para "un período fuera de la lista".
    render(<AsesoresView {...props({ periodo: "30d" })} />);
    const grupo = screen.getByRole("group", { name: "Período" });
    expect(within(grupo).getAllByRole("button").map((b) => b.textContent)).toEqual(["Hoy", "7 días", "30 días"]);
  });

  it("cambiar de período reemplaza la URL sin recargar", async () => {
    render(<AsesoresView {...props()} />);
    await userEvent.click(within(screen.getByRole("group", { name: "Período" })).getByRole("button", { name: "30 días" }));
    expect(replace).toHaveBeenCalledWith("/panel/asesores?periodo=30d", { scroll: false });
  });
});

describe("AsesoresView · aviso del mensaje más viejo", () => {
  it("dice cuánto lleva, con reloj, minutos laborales, contacto y 'Sin dueño'", () => {
    render(<AsesoresView {...props()} />);
    const aviso = screen.getByRole("region", { name: /mensaje más viejo/i });
    expect(within(aviso).getByText(/El mensaje más viejo sin responder lleva/)).toBeInTheDocument();
    expect(within(aviso).getByRole("timer")).toHaveTextContent("2:00:00");
    expect(within(aviso).getByText(/120 min en horario de atención/)).toBeInTheDocument();
    expect(within(aviso).getByText("Pedro Pérez")).toBeInTheDocument();
    expect(within(aviso).getByText("Sin dueño")).toBeInTheDocument();
    expect(within(aviso).getByText(/3 conversaciones de más de 7 días se consideran abandonadas/)).toBeInTheDocument();
  });

  it("nombra al asesor cuando el mensaje tiene dueño", () => {
    const dato = colaDato({ mas_viejo: { conversation_id: "k2", desde: DESDE_MAS_VIEJO, contacto: "María Ruiz", asesor: "Ana Gómez" } });
    render(<AsesoresView {...props({ cola: { ok: true, dato } })} />);
    const aviso = screen.getByRole("region", { name: /mensaje más viejo/i });
    expect(within(aviso).getByText("Ana Gómez")).toBeInTheDocument();
    expect(within(aviso).queryByText("Sin dueño")).toBeNull();
  });

  it("sin pendientes pinta un estado vacío positivo", () => {
    const dato = colaDato({ pendientes: 0, sin_dueno: 0, con_dueno: 0, mas_viejo: null, lista: [], abandonadas: 0 });
    render(<AsesoresView {...props({ cola: { ok: true, dato } })} />);
    const aviso = screen.getByRole("region", { name: /mensaje más viejo/i });
    expect(within(aviso).getByText(/No hay mensajes sin responder/)).toBeInTheDocument();
    expect(within(aviso).queryByRole("timer")).toBeNull();
  });

  it("el reloj avanza segundo a segundo con un solo intervalo", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(AHORA);
    render(<AsesoresView {...props()} />);
    expect(screen.getByRole("region", { name: /mensaje más viejo/i })).toHaveTextContent("2:00:00");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole("region", { name: /mensaje más viejo/i })).toHaveTextContent("2:00:05");
  });
});

describe("AsesoresView · un único reloj", () => {
  it("todos los relojes cuelgan de UN setInterval de 1 s", () => {
    const espia = vi.spyOn(globalThis, "setInterval");
    render(<AsesoresView {...props()} />);
    const deUnSegundo = espia.mock.calls.filter(([, ms]) => ms === 1000);
    expect(deUnSegundo).toHaveLength(1);
  });
});

describe("AsesoresView · equipo", () => {
  it("muestra personas activas, pendientes, mediana, ≤ 5 min y lo enviado a SAINT", () => {
    render(<AsesoresView {...props()} />);
    const equipo = screen.getByRole("region", { name: /resumen del equipo/i });
    expect(within(equipo).getByText("Personas activas")).toBeInTheDocument();
    expect(within(equipo).getByText("3")).toBeInTheDocument();
    expect(within(equipo).getByText("25")).toBeInTheDocument();
    expect(within(equipo).getByText(/10 sin dueño · 15 con dueño/)).toBeInTheDocument();
    expect(within(equipo).getByText("3,2 min")).toBeInTheDocument();
    expect(within(equipo).getByText("72 %")).toBeInTheDocument();
    expect(within(equipo).getByText("Enviado a SAINT")).toBeInTheDocument();
    expect(within(equipo).getByText("$710,00")).toBeInTheDocument();
    expect(within(equipo).getByText(/11 envíos · en espera de facturar/)).toBeInTheDocument();
  });

  it("un null del equipo pinta «—», nunca 0", () => {
    const dato = asesoresDato({ equipo: { episodios: 0, primera_resp_mediana_min: null, en_5min: null } });
    render(<AsesoresView {...props({ asesores: { ok: true, dato, recortado: false } })} />);
    const equipo = screen.getByRole("region", { name: /resumen del equipo/i });
    expect(within(equipo).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(within(equipo).queryByText("0 %")).toBeNull();
  });

  it("marca como Estimado cuando hay envíos con monto estimado", () => {
    render(<AsesoresView {...props({ ventas: { ok: true, dato: ventasDato(2) } })} />);
    expect(screen.getByText("Estimado")).toBeInTheDocument();
  });
});

describe("AsesoresView · tabla por persona", () => {
  it("pinta las cifras formateadas y cruza la conversión por agent_id", () => {
    render(<AsesoresView {...props()} />);
    const tabla = screen.getByRole("table", { name: /rendimiento por persona/i });
    const ana = within(tabla).getByRole("row", { name: /Ana Gómez/ });
    expect(within(ana).getByText("300")).toBeInTheDocument();
    expect(within(ana).getByText("2,4 min")).toBeInTheDocument();
    expect(within(ana).getByText(/p90 9 min/)).toBeInTheDocument();
    expect(within(ana).getByText("80 %")).toBeInTheDocument();
    expect(within(ana).getByText("$500,00")).toBeInTheDocument();
    expect(within(ana).getByText("25 %")).toBeInTheDocument(); // 10 de 40
    const beto = within(tabla).getByRole("row", { name: /Beto Díaz/ });
    expect(within(beto).getByText("10 %")).toBeInTheDocument(); // 2 de 20
  });

  it("un null pinta «—» (≤ 5 min de Beto) y quien no tiene conversión también", () => {
    render(<AsesoresView {...props()} />);
    const tabla = screen.getByRole("table", { name: /rendimiento por persona/i });
    const beto = within(tabla).getByRole("row", { name: /Beto Díaz/ });
    expect(within(beto).getAllByText("—").length).toBeGreaterThanOrEqual(1);
    const carla = within(tabla).getByRole("row", { name: /Carla Caja/ });
    expect(within(carla).getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("el chip «En reparto» sale solo para quien está en el reparto", () => {
    render(<AsesoresView {...props()} />);
    const tabla = screen.getByRole("table", { name: /rendimiento por persona/i });
    expect(within(within(tabla).getByRole("row", { name: /Ana Gómez/ })).getByText("En reparto")).toBeInTheDocument();
    expect(within(within(tabla).getByRole("row", { name: /Beto Díaz/ })).queryByText("En reparto")).toBeNull();
  });

  it("ordenar por una columna cambia el orden y marca aria-sort", async () => {
    render(<AsesoresView {...props()} />);
    const tabla = screen.getByRole("table", { name: /rendimiento por persona/i });
    // Por defecto: más mensajes primero (Beto 500, Ana 300, Carla 0).
    expect(filasDeTabla()).toEqual(["Beto Díaz", "Ana Gómez", "Carla Caja"]);
    expect(within(tabla).getByRole("columnheader", { name: /Mensajes/ })).toHaveAttribute("aria-sort", "descending");

    await userEvent.click(within(tabla).getByRole("button", { name: /Reasignadas/ }));
    expect(filasDeTabla()[0]).toMatch(/^Ana/);
    expect(within(tabla).getByRole("columnheader", { name: /Reasignadas/ })).toHaveAttribute("aria-sort", "descending");
    expect(within(tabla).getByRole("columnheader", { name: /Mensajes/ })).not.toHaveAttribute("aria-sort", "descending");

    // Segundo clic sobre la misma columna: invierte.
    await userEvent.click(within(tabla).getByRole("button", { name: /Reasignadas/ }));
    expect(within(tabla).getByRole("columnheader", { name: /Reasignadas/ })).toHaveAttribute("aria-sort", "ascending");
    expect(filasDeTabla()[0]).not.toMatch(/^Ana/);
  });

  it("los vacíos quedan siempre al final, también ordenando de menor a mayor", async () => {
    render(<AsesoresView {...props()} />);
    const tabla = screen.getByRole("table", { name: /rendimiento por persona/i });
    await userEvent.click(within(tabla).getByRole("button", { name: /^1ª respuesta/ }));
    // Ascendente por mediana: Ana 2,4 y Beto 6; Carla (null) al final.
    expect(filasDeTabla()).toEqual(["Ana Gómez", "Beto Díaz", "Carla Caja"]);
  });

  it("el selector de orden de móvil ordena igual", async () => {
    render(<AsesoresView {...props()} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /ordenar por/i }), "envios");
    expect(filasDeTabla()[0]).toMatch(/^Ana/); // 5 envíos
  });

  it("al pulsar una persona abre su hoja con la actividad por hora", async () => {
    render(<AsesoresView {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: "Ana Gómez" }));
    const hoja = screen.getByRole("dialog", { name: "Ana Gómez" });
    expect(within(hoja).getByText("Actividad por hora")).toBeInTheDocument();
    expect(within(hoja).getByRole("img", { name: /pico.*14.*40/i })).toBeInTheDocument();
  });
});

describe("AsesoresView · Seba", () => {
  it("con actividad muestra su tarjeta", () => {
    render(<AsesoresView {...props()} />);
    const seba = screen.getByRole("region", { name: "Seba" });
    expect(within(seba).getByText("120")).toBeInTheDocument();
    expect(within(seba).getByText(/45 conversaciones/)).toBeInTheDocument();
    expect(within(seba).queryByText(/IA apagada/)).toBeNull();
  });

  it("sin mensajes dice «IA apagada» con el último mensaje", () => {
    const dato = asesoresDato({ seba: { mensajes: 0, conversaciones: 0, ultimo: "2026-11-10T09:30:00-04:00" } });
    render(<AsesoresView {...props({ asesores: { ok: true, dato, recortado: false } })} />);
    const seba = screen.getByRole("region", { name: "Seba" });
    expect(within(seba).getByText(/IA apagada · último mensaje el/)).toBeInTheDocument();
  });
});

describe("AsesoresView · mostrador", () => {
  it("lista solo a quien tiene envíos de tienda, con envíos y monto de tienda", () => {
    render(<AsesoresView {...props()} />);
    const mostrador = screen.getByRole("region", { name: "Mostrador" });
    expect(within(mostrador).getByText("Carla Caja")).toBeInTheDocument();
    expect(within(mostrador).getByText("Beto Díaz")).toBeInTheDocument();
    expect(within(mostrador).queryByText("Ana Gómez")).toBeNull();
    expect(within(mostrador).getByText("$120,00")).toBeInTheDocument();
    expect(within(mostrador).getByText(/4 envíos/)).toBeInTheDocument();
  });
});

describe("AsesoresView · cola de pendientes", () => {
  it("lista las conversaciones con espera en vivo y su distribución por antigüedad", () => {
    render(<AsesoresView {...props()} />);
    const cola = document.getElementById("pendientes") as HTMLElement;
    expect(cola).not.toBeNull();
    expect(within(cola).getByText("Pedro Pérez")).toBeInTheDocument();
    expect(within(cola).getByText("María Ruiz")).toBeInTheDocument();
    expect(within(cola).getByText(/Menos de 1 h/)).toBeInTheDocument();
    expect(within(cola).getByText(/Mostrando las 3 más viejas de 25/)).toBeInTheDocument();
  });

  it("el filtro «Sin dueño» deja solo las conversaciones sin asesor", async () => {
    render(<AsesoresView {...props()} />);
    const cola = document.getElementById("pendientes") as HTMLElement;
    await userEvent.click(within(cola).getByRole("button", { name: /Sin dueño/ }));
    expect(within(cola).getByText("Pedro Pérez")).toBeInTheDocument();
    expect(within(cola).getByText("Luis Soto")).toBeInTheDocument();
    expect(within(cola).queryByText("María Ruiz")).toBeNull();
    await userEvent.click(within(cola).getByRole("button", { name: /Con dueño/ }));
    expect(within(cola).getByText("María Ruiz")).toBeInTheDocument();
    expect(within(cola).queryByText("Pedro Pérez")).toBeNull();
  });
});

describe("AsesoresView · degradación por bloque", () => {
  it("si falla asesores, la cola y el aviso siguen", () => {
    render(<AsesoresView {...props({ asesores: { ...FALLO, recortado: false } })} />);
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/No disponible/).length).toBeGreaterThanOrEqual(1);
    expect(within(screen.getByRole("region", { name: /mensaje más viejo/i })).getByText("Pedro Pérez")).toBeInTheDocument();
    expect((document.getElementById("pendientes") as HTMLElement)).toBeInTheDocument();
  });

  it("si falla la cola, la tabla de personas sigue", () => {
    render(<AsesoresView {...props({ cola: FALLO })} />);
    expect(screen.getAllByText(/No disponible/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("table", { name: /rendimiento por persona/i })).toBeInTheDocument();
  });

  it("si fallan las conversaciones, la tabla sigue y la conversión queda en «—»", () => {
    render(<AsesoresView {...props({ conversaciones: { ...FALLO, recortado: false } })} />);
    const ana = within(screen.getByRole("table", { name: /rendimiento por persona/i })).getByRole("row", { name: /Ana Gómez/ });
    expect(within(ana).queryByText("25 %")).toBeNull();
  });

  it("si el rango pasó el tope de 92 días lo avisa", () => {
    render(<AsesoresView {...props({ asesores: { ok: true, dato: asesoresDato(), recortado: true } })} />);
    expect(screen.getByText(/últimos 92 días/)).toBeInTheDocument();
  });

  it("Reintentar de un bloque caído refresca la página", async () => {
    render(<AsesoresView {...props({ cola: FALLO })} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Reintentar/ })[0]);
    expect(refresh).toHaveBeenCalled();
  });
});
