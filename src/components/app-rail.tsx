"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Inbox, LogOut, Package, Receipt, Route, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { SbkMark } from "@/components/sbk-logo";
import { ThemeToggle } from "@/components/theme-toggle";

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

export type RailSection = "recorrido" | "bandeja" | "clientes" | "ventas" | "inventario" | "control";

const SECTIONS: { id: RailSection; href: string; label: string; Icon: typeof Route }[] = [
  { id: "recorrido", href: "/", label: "Recorrido", Icon: Route },
  { id: "bandeja", href: "/inbox", label: "Bandeja", Icon: Inbox },
  { id: "clientes", href: "/clientes", label: "Clientes", Icon: Users },
  { id: "ventas", href: "/ventas", label: "Ventas", Icon: Receipt },
  { id: "inventario", href: "/inventario", label: "Inventario", Icon: Package },
  { id: "control", href: "/agent-control", label: "Control de IA", Icon: Bot },
];

interface AppRailProps {
  active: RailSection;
  /** `crm` en la bandeja a pantalla completa; `dash` en las pantallas enmarcadas. */
  variant?: "crm" | "dash";
}

export function AppRail({ active, variant = "dash" }: AppRailProps) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <nav className={`${variant}-rail`} aria-label="Secciones">
      {/* La marca ancla la columna, pero no navega: "Recorrido" ya es el
          primer botón y un segundo camino a la misma ruta solo confunde. */}
      <span className={`${variant}-rail-brand`}>
        <SbkMark size={32} />
      </span>

      {SECTIONS.map(({ id, href, label, Icon }) => (
        <Link
          key={id}
          className={`${variant}-rail-btn`}
          href={href}
          aria-label={label}
          title={label}
          {...(active === id ? { "data-active": "true", "aria-current": "page" as const } : {})}
        >
          <Icon size={17} />
        </Link>
      ))}

      <span className={`${variant}-rail-spacer`} />

      <ThemeToggle variant={variant} />

      <button className={`${variant}-rail-btn`} type="button" onClick={signOut} aria-label="Cerrar sesión">
        <LogOut size={17} />
      </button>
    </nav>
  );
}

/** Los mismos destinos, para la barra de navegación superior de las pantallas enmarcadas. */
export function AppTopNav({ active }: { active: RailSection }) {
  return (
    <nav className="dash-nav" aria-label="Navegación principal">
      {SECTIONS.map(({ id, href, label }) => (
        <Link key={id} className="dash-nav-link" href={href} {...(active === id ? { "aria-current": "page" as const } : {})}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
