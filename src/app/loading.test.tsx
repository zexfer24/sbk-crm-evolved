/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import InboxLoading from "@/app/inbox/loading";
import ClientesLoading from "@/app/clientes/loading";
import VentasLoading from "@/app/ventas/loading";
import InventarioLoading from "@/app/inventario/loading";
import ControlLoading from "@/app/agent-control/loading";
import RecorridoLoading from "@/app/loading";

// El rail cierra sesión con el router, que fuera de Next no existe.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

// AppRail monta AssignmentNotifier (T6): abre su propio canal de realtime y
// resuelve el agente actual con `auth.getSession()`. Sin esas dos piezas acá
// el mock se queda corto para lo que el rail necesita ahora y el montaje de
// cada esqueleto revienta con "supabase.channel is not a function" antes de
// llegar a las aserciones de este archivo, que no miran el aviso en sí (eso
// lo cubre assignment-notifier.test.tsx).
function fakeChannel() {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return channel;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn().mockResolvedValue({}), getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    channel: () => fakeChannel(),
    removeChannel: vi.fn(),
  }),
}));

/**
 * Sin `loading.tsx`, Next no prefetchea una ruta dinámica y deja la pantalla
 * congelada en la página anterior hasta que el servidor responde. Como todas
 * las rutas del CRM son dinámicas, que estos archivos existan y rendericen no
 * es cosmética: es lo que hace que un clic se sienta atendido.
 */
const PANTALLAS = [
  ["bandeja", InboxLoading],
  ["clientes", ClientesLoading],
  ["ventas", VentasLoading],
  ["inventario", InventarioLoading],
  ["control de IA", ControlLoading],
  ["recorrido", RecorridoLoading],
] as const;

describe("esqueletos de carga", () => {
  it.each(PANTALLAS)("%s avisa que está cargando en vez de quedarse en blanco", (_nombre, Loading) => {
    render(<Loading />);

    const aviso = screen.getByRole("status");
    expect(aviso).toHaveAttribute("aria-busy", "true");
    expect(aviso).toHaveAccessibleName(/cargando/i);
  });

  it.each(PANTALLAS)("%s deja la navegación usable mientras carga", (_nombre, Loading) => {
    render(<Loading />);

    // El rail no espera a los datos: se puede saltar a otra sección sin que
    // la anterior haya terminado de llegar.
    expect(screen.getAllByRole("link", { name: /bandeja/i }).length).toBeGreaterThan(0);
  });
});
