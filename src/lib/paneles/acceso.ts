/**
 * Quién ve los paneles (Dashboard de ventas, Analíticas, Asesores; plan
 * "Paneles", 13/11/2026): solo supervisor y admin. La regla de verdad vive en
 * las RPC (`is_supervisor_or_admin()` con 42501) y en el `layout.tsx` de
 * `/panel`; esto es solo para decidir si el rail muestra el botón, así que un
 * rol desconocido o ausente NO lo ve (fallar cerrado).
 *
 * Vive aparte de `app-rail.tsx` (un componente de cliente) para que un server
 * component, como el layout, pueda llamarlo sin cruzar la frontera.
 */
export function puedeVerPaneles(role: string | null | undefined): boolean {
  return role === "supervisor" || role === "admin";
}
