/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppRail, AppTopNav } from "@/components/app-rail";

// Con `verPaneles` el rail lee la URL (`usePathname`/`useSearchParams`) para que
// las tres entradas de los paneles arrastren el período y el canal elegidos
// (15/11/2026). Cada test fija la ruta con `ubicacion`.
const ubicacion = vi.hoisted(() => ({ ruta: "/ventas", consulta: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => ubicacion.ruta,
  useSearchParams: () => new URLSearchParams(ubicacion.consulta),
}));

// AppRail monta AssignmentNotifier (T6), que abre su propio canal de
// realtime y resuelve el agente actual con `auth.getSession()` — sin estas
// dos piezas el montaje revienta antes de llegar a las aserciones de estas
// pruebas, que no miran el aviso en sí (eso lo cubre
// assignment-notifier.test.tsx).
function fakeChannel() {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return channel;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn(), getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    channel: () => fakeChannel(),
    removeChannel: vi.fn(),
  }),
}));

// `AssignmentNotifier` (T6, 10/9/2026) llama a `toast()` de HeroUI cuando le
// llega un aviso de asignación por el canal de arriba; estas pruebas no
// disparan ningún INSERT, así que nunca se invoca, pero el import real de
// `@heroui/react` no hace falta acá — mismo patrón que
// `assignment-notifier.test.tsx`.
vi.mock("@heroui/react", () => ({ toast: vi.fn() }));

// El rol `caja` (13/10/2026) no debe montar el aviso de asignación: no lee
// conversaciones, y su canal y su consulta del agente actual solo fallarían.
// Se reemplaza por un espía que cuenta los renders y, como el real, devuelve
// `null` (no suma ningún hijo al DOM: ver el test del fragmento).
const notifierRenderizado = vi.hoisted(() => vi.fn());
vi.mock("@/components/assignment-notifier", () => ({
  AssignmentNotifier: () => {
    notifierRenderizado();
    return null;
  },
}));

// Orden del menú desde el 15/11/2026 (plan "Paneles"): el Recorrido se mudó a
// `/recorrido` y quedó AL FINAL; para un asesor (sin `verPaneles`) este es el
// menú completo.
const SECCIONES = [
  ["Bandeja", "/inbox"],
  ["Clientes", "/clientes"],
  // «Casos» (T7, plan "La ronda del cliente", 30/9/2026): el tablero Kanban
  // por etiqueta, entre Clientes y Ventas.
  ["Casos", "/casos"],
  ["Ventas", "/ventas"],
  ["Inventario", "/inventario"],
  ["Control de IA", "/agent-control"],
  ["Recorrido", "/recorrido"],
] as const;

// Las tres entradas de los paneles, que reemplazan a la «Paneles» única: van al
// PRINCIPIO y solo las ve un supervisor/admin (`verPaneles`).
const PANELES = [
  ["Dashboard", "/panel"],
  ["Analíticas", "/panel/analiticas"],
  ["Asesores", "/panel/asesores"],
] as const;
const MENU_SUPERVISOR = [...PANELES, ...SECCIONES] as const;

beforeEach(() => {
  ubicacion.ruta = "/ventas";
  ubicacion.consulta = "";
});

describe("AppRail", () => {
  // El rail estaba copiado en cuatro pantallas; el punto de extraerlo es que
  // agregar una sección no dependa de acordarse de editar las cuatro.
  it("ofrece las siete secciones con su destino, en orden, con el Recorrido al final", () => {
    render(<AppRail active="clientes" />);

    for (const [label, href] of SECCIONES) {
      expect(screen.getByLabelText(label).getAttribute("href")).toBe(href);
    }
    const orden = Array.from(document.querySelectorAll(".dash-rail-btn[href]")).map((a) => a.getAttribute("aria-label"));
    expect(orden).toEqual(SECCIONES.map(([label]) => label));
  });

  it("marca solo la sección activa", () => {
    render(<AppRail active="inventario" />);

    expect(screen.getByLabelText("Inventario").getAttribute("data-active")).toBe("true");
    expect(screen.getByLabelText("Inventario").getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("Clientes").getAttribute("data-active")).toBeNull();
  });

  it("siempre deja a mano el cierre de sesión", () => {
    render(<AppRail active="bandeja" />);
    expect(screen.getByLabelText("Cerrar sesión")).toBeTruthy();
  });

  // La bandeja a pantalla completa y las pantallas enmarcadas siguen usando
  // dos familias de clases distintas en el CSS.
  it("respeta el prefijo de clase de cada familia de pantallas", () => {
    const { container, unmount } = render(<AppRail active="bandeja" variant="crm" />);
    expect(container.querySelector(".crm-rail")).toBeTruthy();
    unmount();

    const { container: dash } = render(<AppRail active="ventas" variant="dash" />);
    expect(dash.querySelector(".dash-rail")).toBeTruthy();
  });

  /**
   * Resguardo de layout, no de comportamiento (10/9/2026, reemplaza al test
   * "la hoja de estilos del aviso" de `assignment-notifier.test.tsx`).
   *
   * `AppRail` devuelve un fragmento con el `<nav>` del rail MÁS
   * `<AssignmentNotifier />`; un fragmento no crea nodo DOM, así que
   * CUALQUIER hijo que `AssignmentNotifier` deje montado sube como hijo
   * DIRECTO del contenedor de la pantalla. `.crm` (crm.css) y `.dash-frame`
   * (dashboard.css) son grids de DOS columnas (`72px minmax(0, 1fr)`): un
   * segundo hijo ahí le roba la columna del contenido y desarma el CRM
   * entero — pasó en producción el 9/9/2026 con `.an-live`, en las seis
   * secciones a la vez. Ahora que `AssignmentNotifier` devuelve `null` (usa
   * el `Toast.Provider` global de HeroUI en vez de montar contenedor
   * propio) el resguardo es más simple: verificar que `AppRail` nunca
   * entregue más de un hijo directo, sin importar qué monte por dentro.
   */
  it("entrega un solo hijo directo (el <nav>): un hijo de más desarma el grid de dos columnas de .crm/.dash-frame", () => {
    const { container } = render(<AppRail active="bandeja" />);
    expect(container.childElementCount).toBe(1);
    expect(container.firstElementChild?.tagName).toBe("NAV");
  });
});

describe("AppRail con soloInventario (rol caja)", () => {
  beforeEach(() => notifierRenderizado.mockClear());

  it("muestra solo Inventario, el tema y Cerrar sesión", () => {
    const { container } = render(<AppRail active="inventario" soloInventario />);

    const links = Array.from(container.querySelectorAll(".dash-rail-btn[href]")).map((a) => a.getAttribute("aria-label"));
    expect(links).toEqual(["Inventario"]);
    expect(screen.getByLabelText("Inventario").getAttribute("href")).toBe("/inventario");
    expect(screen.getByLabelText("Inventario").getAttribute("data-active")).toBe("true");
    expect(screen.getByLabelText("Cerrar sesión")).toBeTruthy();
    expect(screen.getByLabelText(/Cambiar a modo/)).toBeTruthy();
    for (const [label] of SECCIONES) {
      if (label !== "Inventario") expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it("no monta el AssignmentNotifier", () => {
    render(<AppRail active="inventario" soloInventario />);
    expect(notifierRenderizado).not.toHaveBeenCalled();
  });

  it("sin la prop monta el notifier y las siete secciones, como siempre", () => {
    const { container } = render(<AppRail active="inventario" />);
    expect(notifierRenderizado).toHaveBeenCalled();
    expect(container.querySelectorAll(".dash-rail-btn[href]").length).toBe(SECCIONES.length);
  });

  it("sigue entregando un solo hijo directo (el <nav>)", () => {
    const { container } = render(<AppRail active="inventario" soloInventario />);
    expect(container.childElementCount).toBe(1);
    expect(container.firstElementChild?.tagName).toBe("NAV");
  });

  it("soloInventario={false} es igual que no pasarla", () => {
    const { container } = render(<AppRail active="inventario" soloInventario={false} />);
    expect(container.querySelectorAll(".dash-rail-btn[href]").length).toBe(SECCIONES.length);
  });
});

// Plan "Paneles" (13/11/2026): los tres paneles de ventas/analíticas/asesores
// viven bajo /panel y solo los ven supervisor y admin. La pantalla los muestra
// con la prop `verPaneles` (la calcula cada vista desde el rol que ya cargó);
// el candado de verdad es el layout de /panel y las RPC.
describe("AppRail con verPaneles", () => {
  const etiquetas = (c: HTMLElement) =>
    Array.from(c.querySelectorAll(".dash-rail-btn[href]")).map((a) => a.getAttribute("aria-label"));

  it("sin la prop no aparece ninguna de las tres entradas de paneles ni la vieja «Paneles»", () => {
    const { container } = render(<AppRail active="ventas" />);
    for (const [label] of PANELES) expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.queryByLabelText("Paneles")).toBeNull();
    expect(etiquetas(container)).toEqual(SECCIONES.map(([label]) => label));
  });

  it("verPaneles={false} es igual que no pasarla", () => {
    const { container } = render(<AppRail active="ventas" verPaneles={false} />);
    expect(etiquetas(container)).toEqual(SECCIONES.map(([label]) => label));
  });

  it("para un supervisor/admin el orden exacto es Dashboard, Analíticas, Asesores, … y el Recorrido al final", () => {
    const { container } = render(<AppRail active="ventas" verPaneles />);

    expect(etiquetas(container)).toEqual([
      "Dashboard",
      "Analíticas",
      "Asesores",
      "Bandeja",
      "Clientes",
      "Casos",
      "Ventas",
      "Inventario",
      "Control de IA",
      "Recorrido",
    ]);
    for (const [label, href] of MENU_SUPERVISOR) {
      expect(screen.getByLabelText(label).getAttribute("href")).toBe(href);
    }
    // La entrada única «Paneles» desapareció: la reemplazan las tres.
    expect(screen.queryByLabelText("Paneles")).toBeNull();
  });

  it.each([
    ["dashboard", "Dashboard"],
    ["analiticas", "Analíticas"],
    ["asesores", "Asesores"],
    ["recorrido", "Recorrido"],
  ] as const)("marca solo «%s» cuando es la sección activa", (id, label) => {
    const { container } = render(<AppRail active={id} verPaneles />);

    expect(screen.getByLabelText(label).getAttribute("data-active")).toBe("true");
    expect(screen.getByLabelText(label).getAttribute("aria-current")).toBe("page");
    expect(container.querySelectorAll("[data-active]").length).toBe(1);
  });

  it("la caja nunca las ve, aunque se le pase verPaneles", () => {
    const { container } = render(<AppRail active="inventario" soloInventario verPaneles />);

    for (const [label] of PANELES) expect(screen.queryByLabelText(label)).toBeNull();
    expect(etiquetas(container)).toEqual(["Inventario"]);
  });

  it("sigue entregando un solo hijo directo (el <nav>)", () => {
    const { container } = render(<AppRail active="dashboard" verPaneles />);
    expect(container.childElementCount).toBe(1);
    expect(container.firstElementChild?.tagName).toBe("NAV");
  });
});

// 15/11/2026: la cápsula del rail (rediseño pedido por el operador). El nav lleva
// la marca FUERA y UNA cápsula con, en orden: los tres paneles, un separador,
// las secciones, un separador y el grupo de abajo (tema y cerrar sesión). Ya no
// hay un spacer que empuje ese grupo al fondo.
describe("AppRail: la cápsula y sus separadores", () => {
  const hijos = (nav: Element) =>
    Array.from(nav.children).map((el) =>
      el.matches('[aria-hidden="true"].dash-rail-sep')
        ? "|"
        : (el.getAttribute("aria-label") ?? el.className)
    );

  it("la marca queda fuera de la cápsula y la cápsula es lo único más que lleva el nav", () => {
    const { container } = render(<AppRail active="ventas" verPaneles />);
    const nav = container.querySelector("nav.dash-rail")!;

    expect(nav.children.length).toBe(2);
    expect(nav.children[0]).toHaveClass("dash-rail-brand");
    expect(nav.children[1]).toHaveClass("dash-rail-capsule");
    expect(nav.querySelector(".dash-rail-capsule .dash-rail-brand")).toBeNull();
    expect(nav.querySelector(".dash-rail-spacer")).toBeNull();
  });

  it("con verPaneles: paneles, separador, secciones, separador, tema y salir", () => {
    const { container } = render(<AppRail active="ventas" verPaneles />);
    const capsula = container.querySelector(".dash-rail-capsule")!;

    expect(hijos(capsula)).toEqual([
      "Dashboard",
      "Analíticas",
      "Asesores",
      "|",
      "Bandeja",
      "Clientes",
      "Casos",
      "Ventas",
      "Inventario",
      "Control de IA",
      "Recorrido",
      "|",
      expect.stringMatching(/Cambiar a modo/),
      "Cerrar sesión",
    ]);
  });

  it("sin verPaneles no hay separador entre secciones, solo el de antes del grupo de abajo", () => {
    const { container } = render(<AppRail active="ventas" />);
    const capsula = container.querySelector(".dash-rail-capsule")!;

    const orden = hijos(capsula);
    expect(orden.filter((h) => h === "|").length).toBe(1);
    expect(orden[0]).toBe("Bandeja");
    expect(orden.slice(-3)).toEqual(["|", expect.stringMatching(/Cambiar a modo/), "Cerrar sesión"]);
  });

  it("los separadores son aria-hidden y el primero va justo después de Asesores", () => {
    const { container } = render(<AppRail active="ventas" verPaneles />);
    const seps = container.querySelectorAll(".dash-rail-sep");

    expect(seps.length).toBe(2);
    seps.forEach((sep) => expect(sep.getAttribute("aria-hidden")).toBe("true"));
    expect(screen.getByLabelText("Asesores").nextElementSibling).toBe(seps[0]);
    expect(seps[0].nextElementSibling).toBe(screen.getByLabelText("Bandeja"));
  });

  it("la caja (soloInventario) no ve el separador de los paneles: Inventario, separador, tema y salir", () => {
    const { container } = render(<AppRail active="inventario" soloInventario verPaneles />);
    const capsula = container.querySelector(".dash-rail-capsule")!;

    expect(hijos(capsula)).toEqual(["Inventario", "|", expect.stringMatching(/Cambiar a modo/), "Cerrar sesión"]);
  });

  it("la variante crm usa sus propias clases (crm-rail-capsule, crm-rail-sep)", () => {
    const { container } = render(<AppRail active="bandeja" variant="crm" verPaneles />);

    expect(container.querySelector("nav.crm-rail > .crm-rail-capsule")).not.toBeNull();
    expect(container.querySelectorAll(".crm-rail-capsule > .crm-rail-sep").length).toBe(2);
    expect(container.querySelector(".dash-rail-sep")).toBeNull();
  });

  it("AppTopNav NO lleva separador", () => {
    const { container } = render(<AppTopNav active="ventas" verPaneles />);
    expect(container.querySelector('[class*="rail-sep"]')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

// 15/11/2026: se quitaron las pestañas internas de los paneles y su trabajo
// (no perder el período ni el canal al cambiar de panel) pasó a estas tres
// entradas, SOLO estando ya en un panel.
describe("las entradas de los paneles arrastran período y canal", () => {
  const hrefs = () => ({
    dashboard: screen.getByLabelText("Dashboard").getAttribute("href"),
    analiticas: screen.getByLabelText("Analíticas").getAttribute("href"),
    asesores: screen.getByLabelText("Asesores").getAttribute("href"),
  });

  it("fuera de los paneles los href quedan limpios, aunque la URL traiga ?periodo", () => {
    ubicacion.ruta = "/ventas";
    ubicacion.consulta = "periodo=7d&vista=online";
    render(<AppRail active="ventas" verPaneles />);

    expect(hrefs()).toEqual({ dashboard: "/panel", analiticas: "/panel/analiticas", asesores: "/panel/asesores" });
  });

  it("dentro de un panel llevan el período y, a Dashboard y Analíticas, la vista", () => {
    ubicacion.ruta = "/panel";
    ubicacion.consulta = "periodo=7d&vista=online";
    render(<AppRail active="dashboard" verPaneles />);

    expect(hrefs()).toEqual({
      dashboard: "/panel?periodo=7d&vista=online",
      analiticas: "/panel/analiticas?periodo=7d&vista=online",
      asesores: "/panel/asesores?periodo=7d",
    });
  });

  it("la barra superior hace lo mismo que el rail", () => {
    ubicacion.ruta = "/panel/analiticas";
    ubicacion.consulta = "periodo=30d&vista=tienda";
    render(<AppTopNav active="analiticas" verPaneles />);

    expect(screen.getByText("Asesores").getAttribute("href")).toBe("/panel/asesores?periodo=30d");
    expect(screen.getByText("Dashboard").getAttribute("href")).toBe("/panel?periodo=30d&vista=tienda");
  });

  it("sin verPaneles no lee la URL (un asesor no paga los hooks)", () => {
    ubicacion.ruta = "/panel";
    ubicacion.consulta = "periodo=7d";
    render(<AppRail active="ventas" />);

    expect(screen.queryByLabelText("Dashboard")).toBeNull();
  });
});

describe("AppTopNav", () => {
  it("lleva las mismas secciones que el rail", () => {
    render(<AppTopNav active="ventas" />);

    for (const [label, href] of SECCIONES) {
      expect(screen.getByText(label).getAttribute("href")).toBe(href);
    }
  });

  it("marca la sección activa para lectores de pantalla", () => {
    render(<AppTopNav active="ventas" />);
    expect(screen.getByText("Ventas").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Clientes").getAttribute("aria-current")).toBeNull();
  });

  it("las tres entradas de paneles aparecen solo con verPaneles, antes que todo, y nunca para la caja", () => {
    const etiquetasNav = (c: HTMLElement) => Array.from(c.querySelectorAll("a")).map((a) => a.textContent);

    const { container, unmount } = render(<AppTopNav active="ventas" />);
    for (const [label] of PANELES) expect(screen.queryByText(label)).toBeNull();
    expect(screen.queryByText("Paneles")).toBeNull();
    expect(etiquetasNav(container)).toEqual(SECCIONES.map(([label]) => label));
    unmount();

    const { container: conPaneles, unmount: desmontar } = render(<AppTopNav active="ventas" verPaneles />);
    expect(etiquetasNav(conPaneles)).toEqual(MENU_SUPERVISOR.map(([label]) => label));
    for (const [label, href] of PANELES) {
      expect(screen.getByText(label).getAttribute("href")).toBe(href);
    }
    desmontar();

    render(<AppTopNav active="inventario" soloInventario verPaneles />);
    for (const [label] of PANELES) expect(screen.queryByText(label)).toBeNull();
  });

  it("marca la entrada activa de un panel por su id", () => {
    render(<AppTopNav active="analiticas" verPaneles />);
    expect(screen.getByText("Analíticas").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Dashboard").getAttribute("aria-current")).toBeNull();
  });

  // El Recorrido pinta aquí sus anclas (Actividad, Reclamos) a continuación de su
  // propia entrada, que ahora es la última.
  it("`extra` va dentro del <nav>, después de las secciones", () => {
    const { container } = render(
      <AppTopNav active="recorrido" extra={<a href="#actividad">Actividad</a>} />
    );
    const enlaces = Array.from(container.querySelectorAll("nav.dash-nav > a")).map((a) => a.textContent);
    expect(enlaces).toEqual([...SECCIONES.map(([label]) => label), "Actividad"]);
  });

  // 15/11/2026: con el menú nuevo la barra no cabe a 1024 px y el enlace activo
  // (p. ej. «Recorrido», el último) quedaba fuera, a la derecha. jsdom no calcula
  // layout: se simulan los rectángulos y se espía `scrollIntoView`.
  describe("lleva el enlace activo a la vista", () => {
    const original = Element.prototype.scrollIntoView;
    const rectOriginal = Element.prototype.getBoundingClientRect;
    const scrollIntoView = vi.fn();

    function rect(left: number, right: number): DOMRect {
      return { left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) };
    }

    /** La barra ocupa 0–800 px; el enlace activo se coloca donde diga cada caso. */
    function simularLayout(izquierdaDelActivo: number, derechaDelActivo: number) {
      Element.prototype.getBoundingClientRect = function (this: Element) {
        if (this.matches("nav.dash-nav")) return rect(0, 800);
        if (this.matches('[aria-current="page"]')) return rect(izquierdaDelActivo, derechaDelActivo);
        return rect(0, 0);
      };
    }

    beforeEach(() => {
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = original;
      Element.prototype.getBoundingClientRect = rectOriginal;
    });

    it("si el enlace activo queda fuera, a la derecha, lo trae con scrollIntoView sin tocar el scroll vertical", () => {
      simularLayout(900, 1000);
      render(<AppTopNav active="recorrido" />);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByText("Recorrido"));
    });

    it("si queda cortado a la izquierda también lo trae", () => {
      simularLayout(-120, -20);
      render(<AppTopNav active="dashboard" verPaneles />);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it("si ya está dentro del área visible de la barra no mueve nada", () => {
      simularLayout(100, 200);
      render(<AppTopNav active="ventas" />);

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("sin `scrollIntoView` (jsdom, navegadores viejos) no lanza", () => {
      simularLayout(900, 1000);
      // @ts-expect-error simula un entorno sin la API
      Element.prototype.scrollIntoView = undefined;
      expect(() => render(<AppTopNav active="recorrido" />)).not.toThrow();
    });
  });

  it("con soloInventario lleva solo el enlace a Inventario", () => {
    const { container } = render(<AppTopNav active="inventario" soloInventario />);

    const links = Array.from(container.querySelectorAll("a")).map((a) => a.textContent);
    expect(links).toEqual(["Inventario"]);
    expect(screen.getByText("Inventario").getAttribute("href")).toBe("/inventario");
  });
});
