"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutGrid, List } from "lucide-react";
import { INVENTORY_VIEW_COOKIE, type InventoryView } from "@/lib/inventory";

/** Un año: la vista que eligió el asesor se recuerda hasta que la cambie. */
const UN_ANIO_EN_SEGUNDOS = 31_536_000;

const OPCIONES: { vista: InventoryView; texto: string; icono: typeof List }[] = [
  { vista: "lista", texto: "Lista", icono: List },
  { vista: "cuadricula", texto: "Cuadrícula", icono: LayoutGrid },
];

/**
 * Escribe la cookie de la vista y dice si pudo. Vive FUERA del componente a propósito:
 * la regla `react-hooks/immutability` prohíbe asignar `document.cookie` dentro de un
 * componente o de un manejador definido en él, y esta es justo la escritura de un
 * efecto de borde (no estado de React) que el servidor leerá en la próxima petición.
 * `path=/inventario` (no viaja con ninguna otra petición del CRM), un año de vida y
 * `SameSite=Lax`. Un navegador con cookies bloqueadas puede lanzar al escribir: no es
 * un error del asesor, simplemente no se recordará la elección.
 */
function guardarVista(vista: InventoryView): boolean {
  try {
    document.cookie = `${INVENTORY_VIEW_COOKIE}=${vista}; path=/inventario; max-age=${UN_ANIO_EN_SEGUNDOS}; samesite=lax`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Interruptor Lista / Cuadrícula de /inventario (30/10/2026, plan «Cada
 * repuesto con su foto», T5a, D4).
 *
 * Recuerda la última vista de cada asesor en una COOKIE y no en `localStorage`:
 * `page.tsx` la lee en el servidor y pinta la vista correcta en el primer
 * render, sin el parpadeo de "lista y, un instante después, cuadrícula" que
 * dejaría un valor que solo el navegador conoce. Por eso, después de escribirla,
 * pide `router.refresh()`: el servidor vuelve a renderizar con la cookie nueva.
 *
 * La cookie va con `path=/inventario` (no viaja con ninguna otra petición del
 * CRM), un año de vida y `SameSite=Lax`. Escribirla va dentro de `try/catch`: un
 * navegador con cookies bloqueadas no debe romper la pantalla — simplemente no
 * recordará la elección.
 *
 * Mientras el servidor contesta, el botón elegido ya se ve marcado (`pendiente`);
 * en cuanto llega la vista nueva por props, manda ella. Si la cookie no se pudo
 * escribir NO se marca nada: el servidor no va a cambiar de vista y el botón
 * mentiría.
 */
export function VistaToggle({ vista }: { vista: InventoryView }) {
  const router = useRouter();
  const [pendiente, setPendiente] = useState<InventoryView | null>(null);

  // "Ajustar el estado cuando cambia un prop": al llegar la vista del servidor se
  // suelta la elección optimista (regla `react-hooks/set-state-in-effect`).
  const [vistaPrevia, setVistaPrevia] = useState(vista);
  if (vista !== vistaPrevia) {
    setVistaPrevia(vista);
    setPendiente(null);
  }

  const activa = pendiente ?? vista;

  function elegir(nueva: InventoryView) {
    if (nueva === activa) return;

    // Si las cookies están bloqueadas se refresca igual (no cuesta nada) pero la vista no va a cambiar.
    if (guardarVista(nueva)) setPendiente(nueva);
    router.refresh();
  }

  return (
    <div className="inv-vista" role="group" aria-label="Vista del inventario">
      {OPCIONES.map(({ vista: opcion, texto, icono: Icono }) => (
        <button key={opcion} type="button" aria-pressed={activa === opcion} onClick={() => elegir(opcion)}>
          <Icono size={14} aria-hidden="true" />
          {texto}
        </button>
      ))}
    </div>
  );
}
