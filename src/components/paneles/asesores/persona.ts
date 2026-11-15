/**
 * Rótulos de rol de Asesores (plan "Paneles", 13/11/2026). `rol` llega tal cual
 * de `agents.role` (`agent`, `supervisor`, `admin`, `caja`) o `ia` (Seba).
 */
export function etiquetaRol(rol: string): string {
  switch (rol) {
    case "agent":
      return "Asesor";
    case "supervisor":
      return "Supervisor";
    case "admin":
      return "Administrador";
    case "caja":
      return "Caja";
    case "ia":
      return "IA";
    default:
      return rol;
  }
}

/** Variante de color del avatar: la caja lleva el color de la tienda, la IA el de Seba. */
export function avatarDe(rol: string): "asesor" | "caja" | "ia" {
  if (rol === "caja") return "caja";
  if (rol === "ia") return "ia";
  return "asesor";
}
