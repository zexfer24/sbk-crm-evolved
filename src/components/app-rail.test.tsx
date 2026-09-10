/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppRail, AppTopNav } from "@/components/app-rail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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

const SECCIONES = [
  ["Recorrido", "/"],
  ["Bandeja", "/inbox"],
  ["Clientes", "/clientes"],
  ["Ventas", "/ventas"],
  ["Inventario", "/inventario"],
  ["Control de IA", "/agent-control"],
] as const;

describe("AppRail", () => {
  // El rail estaba copiado en cuatro pantallas; el punto de extraerlo es que
  // agregar una sección no dependa de acordarse de editar las cuatro.
  it("ofrece las seis secciones con su destino", () => {
    render(<AppRail active="clientes" />);

    for (const [label, href] of SECCIONES) {
      expect(screen.getByLabelText(label).getAttribute("href")).toBe(href);
    }
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
});
