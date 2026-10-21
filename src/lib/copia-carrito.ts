/**
 * Qué incluir al copiar un carrito o un presupuesto (21/10/2026, plan
 * "Presupuestos y mensajes rápidos", T3). El cliente pidió dos cosas: que el
 * texto que se le manda NO diga «incluye envío» y poder apagar partes del
 * resumen (el código, el subtotal, el total en bolívares…) según lo que cada
 * cliente quiera ver.
 *
 * Las casillas son las MISMAS para el carrito de /inventario y el del chat, y
 * se recuerdan POR ASESOR en `localStorage` (un asesor que nunca manda el
 * código no lo desmarca en cada copia). Es una preferencia de visor: nunca
 * viaja a la base ni a otro navegador.
 *
 * Este módulo corre en el navegador: nada de `lib/log.ts`, y todo acceso a
 * `localStorage` va en try/catch (modo privado, almacenamiento bloqueado o
 * lleno) y deja la copia funcionando con las casillas iniciales.
 */

export interface OpcionesCopia {
  codigo: boolean;
  cantidad: boolean;
  precioUnitario: boolean;
  subtotal: boolean;
  totalUsd: boolean;
  totalBs: boolean;
  /** Solo existe en el carrito de /inventario (el chat no calcula Cashea). */
  planCashea: boolean;
}

export const OPCIONES_COPIA_INICIALES: Readonly<OpcionesCopia> = Object.freeze({
  codigo: true,
  cantidad: true,
  precioUnitario: true,
  subtotal: true,
  totalUsd: true,
  totalBs: true,
  planCashea: true,
});

/** Orden y etiquetas de las casillas. El nombre del producto no está: siempre va. */
export const CAMPOS_COPIA: ReadonlyArray<{ clave: keyof OpcionesCopia; etiqueta: string; soloInventario?: true }> = [
  { clave: "codigo", etiqueta: "Código" },
  { clave: "cantidad", etiqueta: "Cantidad" },
  { clave: "precioUnitario", etiqueta: "Precio unitario" },
  { clave: "subtotal", etiqueta: "Subtotal" },
  { clave: "totalUsd", etiqueta: "Total $" },
  { clave: "totalBs", etiqueta: "Total Bs" },
  { clave: "planCashea", etiqueta: "Plan Cashea", soloInventario: true },
];

export const COPIA_STORAGE_PREFIX = "sbk:copia-carrito:v1:";

function claveDe(agentId: string | null): string {
  return `${COPIA_STORAGE_PREFIX}${agentId ?? "anon"}`;
}

/**
 * Lo guardado para este asesor, sin fiarse de nada: el valor lo pudo escribir
 * una versión vieja o el propio navegador. Completa con las iniciales lo que
 * falte e ignora claves desconocidas o valores que no sean booleanos. Nunca
 * lanza.
 */
export function leerOpcionesCopia(agentId: string | null): OpcionesCopia {
  const opciones: OpcionesCopia = { ...OPCIONES_COPIA_INICIALES };
  try {
    const raw = window.localStorage.getItem(claveDe(agentId));
    if (raw === null) return opciones;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return opciones;
    const guardado = parsed as Record<string, unknown>;
    for (const { clave } of CAMPOS_COPIA) {
      const valor = guardado[clave];
      if (typeof valor === "boolean") opciones[clave] = valor;
    }
  } catch {
    // JSON roto o localStorage inaccesible: las casillas iniciales.
  }
  return opciones;
}

/** Recuerda las casillas de este asesor. Si el almacenamiento falla, la copia sigue funcionando sin recordarlas. */
export function guardarOpcionesCopia(agentId: string | null, opciones: OpcionesCopia): void {
  try {
    window.localStorage.setItem(claveDe(agentId), JSON.stringify(opciones));
  } catch {
    // Sin almacenamiento no se recuerda la preferencia; no es un error del asesor.
  }
}
