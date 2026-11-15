"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useRef, type ReactNode } from "react";
import {
  Bot,
  ChartColumn,
  Headset,
  Inbox,
  LayoutDashboard,
  LogOut,
  Package,
  Receipt,
  Route,
  SquareKanban,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { HREFS_PANELES_LIMPIOS, hrefsDePaneles, type HrefsPaneles } from "@/lib/paneles/hrefs";
import { SbkMark } from "@/components/sbk-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { AssignmentNotifier } from "@/components/assignment-notifier";

/**
 * La barra lateral de secciones.
 *
 * Estaba copiada en crm-shell, dashboard-view y sales-view, cada una con su
 * propio `signOut` y su propio prefijo de clase. Con seis secciones esa
 * duplicación ya no se sostiene: agregar una obligaba a editar tres
 * archivos y olvidarse de uno pasaba desapercibido.
 *
 * El prefijo se mantiene como prop porque las dos familias de estilos
 * (`crm-*` para la bandeja a pantalla completa, `dash-*` para las pantallas
 * enmarcadas) siguen siendo distintas en el CSS.
 */

export type RailSection =
  // Los tres paneles de ventas, analíticas y asesores (plan "Paneles",
  // 13/11/2026). Solo supervisor/admin: ver `verPaneles` más abajo. Desde el
  // 15/11/2026 son tres entradas del menú, una por pantalla, que reemplazan a
  // la «Paneles» única: cada pantalla marca la SUYA.
  | "dashboard"
  | "analiticas"
  | "asesores"
  | "bandeja"
  | "clientes"
  | "casos"
  | "ventas"
  | "inventario"
  | "control"
  // El Recorrido va AL FINAL del menú desde el 15/11/2026 (pedido del
  // operador) y vive en `/recorrido`; la raíz `/` solo redirige por rol.
  | "recorrido";

/** Los tres ids de los paneles: se filtran juntos cuando no hay `verPaneles`. */
const IDS_PANELES: readonly RailSection[] = ["dashboard", "analiticas", "asesores"];

const SECTIONS: { id: RailSection; href: string; label: string; Icon: typeof Route }[] = [
  // Los `href` de los tres paneles son los LIMPIOS; estando en un panel se
  // reemplazan por los que arrastran período y canal (`HrefsPaneles`, abajo).
  { id: "dashboard", href: "/panel", label: "Dashboard", Icon: LayoutDashboard },
  { id: "analiticas", href: "/panel/analiticas", label: "Analíticas", Icon: ChartColumn },
  { id: "asesores", href: "/panel/asesores", label: "Asesores", Icon: Headset },
  { id: "bandeja", href: "/inbox", label: "Bandeja", Icon: Inbox },
  { id: "clientes", href: "/clientes", label: "Clientes", Icon: Users },
  // El tablero de chats abiertos por etiqueta (T7, "La ronda del cliente", 30/9/2026).
  { id: "casos", href: "/casos", label: "Casos", Icon: SquareKanban },
  { id: "ventas", href: "/ventas", label: "Ventas", Icon: Receipt },
  { id: "inventario", href: "/inventario", label: "Inventario", Icon: Package },
  { id: "control", href: "/agent-control", label: "Control de IA", Icon: Bot },
  { id: "recorrido", href: "/recorrido", label: "Recorrido", Icon: Route },
];

/**
 * El rol `caja` (13/10/2026) solo ve el Inventario: se le deja esa única
 * sección y se le oculta el resto. Es de pantalla; el candado de verdad es la
 * RLS y el middleware (`rutaPermitidaParaCaja`).
 */
function seccionesVisibles(soloInventario: boolean, verPaneles: boolean) {
  if (soloInventario) return SECTIONS.filter((s) => s.id === "inventario");
  // Los paneles (13/11/2026) solo para supervisor/admin: sin la prop se ocultan
  // las tres entradas, así una pantalla que olvide pasarla falla cerrada. Es de
  // pantalla; el candado de verdad es el layout de /panel y las RPC
  // (`is_supervisor_or_admin`).
  return verPaneles ? SECTIONS : SECTIONS.filter((s) => !IDS_PANELES.includes(s.id));
}

/**
 * Resuelve a dónde lleva cada entrada del menú. Las tres de los paneles
 * arrastran el período (y el canal) elegidos SOLO cuando la página actual ya es
 * un panel (`hrefsDePaneles`): heredan el trabajo de las pestañas internas que
 * se quitaron el 15/11/2026. Fuera de los paneles —y sin `verPaneles`— los `href`
 * quedan limpios y ni se leen los hooks de la URL.
 *
 * `useSearchParams` queda aislado en `ConUrl` y dentro de un `Suspense` con los
 * enlaces limpios de respaldo: el rail se monta en toda la app y en los
 * esqueletos de carga, y una página prerenderizada sin esa frontera rompería el
 * build ("Missing Suspense boundary with useSearchParams"). Todas las rutas son
 * dinámicas hoy (leen la cookie de sesión), pero la frontera no cuesta nada.
 */
function ConUrl({ children }: { children: (hrefs: HrefsPaneles) => ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return <>{children(hrefsDePaneles(pathname, searchParams))}</>;
}

function HrefsDePaneles({
  activo,
  children,
}: {
  /** `false`: sin entradas de paneles que enriquecer, así que no se lee la URL. */
  activo: boolean;
  children: (hrefs: HrefsPaneles) => ReactNode;
}) {
  if (!activo) return <>{children(HREFS_PANELES_LIMPIOS)}</>;
  return (
    <Suspense fallback={children(HREFS_PANELES_LIMPIOS)}>
      <ConUrl>{children}</ConUrl>
    </Suspense>
  );
}

function hrefDe(id: RailSection, href: string, hrefs: HrefsPaneles): string {
  return id === "dashboard" || id === "analiticas" || id === "asesores" ? hrefs[id] : href;
}

interface AppRailProps {
  active: RailSection;
  /**
   * `true` para una cuenta de caja: solo la sección Inventario (más tema y
   * cierre de sesión) y SIN `AssignmentNotifier`, que abre un canal de
   * `conversation_handoffs` que esa cuenta no puede leer. Sin la prop, el
   * rail es el de siempre.
   */
  soloInventario?: boolean;
  /**
   * `true` para supervisor/admin: suma las tres entradas de los paneles
   * (Dashboard, Analíticas, Asesores, al principio del menú). Falsa
   * por defecto, y la caja (`soloInventario`) nunca la ve aunque se pase. Cada
   * vista la calcula con `puedeVerPaneles(currentAgent.role)` desde el agente
   * que YA cargó, sin una lectura nueva.
   */
  verPaneles?: boolean;
  /** `crm` en la bandeja a pantalla completa; `dash` en las pantallas enmarcadas. */
  variant?: "crm" | "dash";
}

export function AppRail({ active, variant = "dash", soloInventario = false, verPaneles = false }: AppRailProps) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const secciones = seccionesVisibles(soloInventario, verPaneles);
  const conPaneles = secciones.some((x) => x.id === "asesores");

  return (
    <>
      <nav className={`${variant}-rail`} aria-label="Secciones">
        {/* La marca ancla la columna, pero no navega: el menú ya trae su
            entrada de cada pantalla y un segundo camino solo confunde. Queda
            FUERA de la cápsula, arriba, como siempre. */}
        <span className={`${variant}-rail-brand`}>
          <SbkMark size={32} />
        </span>

        {/* La cápsula (15/11/2026, rediseño del rail): paneles, separador,
            secciones, separador y el grupo de abajo (tema y salir). Ya no hay
            un spacer que empuje ese grupo al fondo: la cápsula abraza su
            contenido. Los separadores son `aria-hidden`; el `<nav>` sigue
            entregando un solo hijo directo al grid, la cápsula va adentro. */}
        <div className={`${variant}-rail-capsule`}>
          <HrefsDePaneles activo={conPaneles}>
            {(hrefs) =>
              secciones.map(({ id, href, label, Icon }) => (
                <Fragment key={id}>
                  <Link
                    className={`${variant}-rail-btn`}
                    href={hrefDe(id, href, hrefs)}
                    aria-label={label}
                    title={label}
                    {...(active === id ? { "data-active": "true", "aria-current": "page" as const } : {})}
                  >
                    <Icon size={17} />
                  </Link>
                  {id === "asesores" && <span className={`${variant}-rail-sep`} aria-hidden="true" />}
                </Fragment>
              ))
            }
          </HrefsDePaneles>

          <span className={`${variant}-rail-sep`} aria-hidden="true" />

          <ThemeToggle variant={variant} />

          <button className={`${variant}-rail-btn`} type="button" onClick={signOut} aria-label="Cerrar sesión">
            <LogOut size={17} />
          </button>
        </div>
      </nav>

      {/* Global, no un botón más del rail: se monta una vez por cada AppRail
          vivo (incluida la instancia que `section-skeleton.tsx` deja unos
          milisegundos durante una navegación), y el dedupe de
          `assignment-notice.ts` —un `Set` de MÓDULO— es lo que garantiza un
          solo aviso aunque haya dos instancias a la vez. */}
      {!soloInventario && <AssignmentNotifier />}
    </>
  );
}

/** Los mismos destinos, para la barra de navegación superior de las pantallas enmarcadas. */
export function AppTopNav({
  active,
  soloInventario = false,
  verPaneles = false,
  extra,
}: {
  active: RailSection;
  soloInventario?: boolean;
  verPaneles?: boolean;
  /**
   * Enlaces propios de la pantalla, después de las secciones: el Recorrido pone
   * aquí sus anclas (Actividad, Reclamos) a continuación de su propia entrada.
   */
  extra?: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);

  // 15/11/2026: con el menú nuevo la barra puede no caber (1024 px) y el enlace
  // activo —sobre todo «Recorrido», el último— quedaba fuera de la vista al
  // cargar. Solo si está fuera del área visible de la barra, se lo trae con
  // `nearest` en ambos ejes (no mueve nada si ya se ve ni centra a la fuerza).
  // `scrollIntoView` no existe en jsdom: la guarda evita que lance.
  useEffect(() => {
    const nav = navRef.current;
    const activo = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !activo || typeof activo.scrollIntoView !== "function") return;
    const barra = nav.getBoundingClientRect();
    const enlace = activo.getBoundingClientRect();
    if (enlace.left < barra.left || enlace.right > barra.right) {
      activo.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  return (
    <nav ref={navRef} className="dash-nav" aria-label="Navegación principal">
      <HrefsDePaneles activo={verPaneles && !soloInventario}>
        {(hrefs) =>
          seccionesVisibles(soloInventario, verPaneles).map(({ id, href, label }) => (
            <Link
              key={id}
              className="dash-nav-link"
              href={hrefDe(id, href, hrefs)}
              {...(active === id ? { "aria-current": "page" as const } : {})}
            >
              {label}
            </Link>
          ))
        }
      </HrefsDePaneles>
      {extra}
    </nav>
  );
}
