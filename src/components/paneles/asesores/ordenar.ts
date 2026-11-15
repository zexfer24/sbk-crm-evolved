import type { PanelConversaciones, PersonaAsesores } from "@/lib/paneles/parse";

/**
 * Orden de la tabla por persona de Asesores (plan "Paneles", 13/11/2026).
 * Puro: sin React, para probar el orden sin montar la pantalla.
 */

export type ColumnaId =
  | "nombre"
  | "conversaciones"
  | "mensajes"
  | "contactos"
  | "primera"
  | "en5"
  | "envios"
  | "monto"
  | "conversion"
  | "reasignadas"
  | "ultimo";

export type Direccion = "asc" | "desc";

/** Una persona de `panel_asesores` con su conversión cruzada de `panel_conversaciones`. */
export interface FilaPersona {
  persona: PersonaAsesores;
  atendidas: number | null;
  compraron: number | null;
  /** compraron / atendidas (0–1); `null` si no hay dato o no atendió ninguna. */
  conversion: number | null;
}

/**
 * Cruza por `agent_id`. `conversion` en `null` (bloque de conversaciones caído)
 * deja todas las conversiones en «—» en vez de tumbar la tabla entera.
 */
export function cruzarConversion(
  personas: PersonaAsesores[],
  conversion: PanelConversaciones["conversion"]["personas"] | null
): FilaPersona[] {
  const porId = new Map<string, { atendidas: number; compraron: number }>();
  for (const c of conversion ?? []) {
    if (c.agent_id !== null) porId.set(c.agent_id, { atendidas: c.atendidas, compraron: c.compraron });
  }
  return personas.map((persona) => {
    const c = porId.get(persona.agent_id);
    return {
      persona,
      atendidas: c?.atendidas ?? null,
      compraron: c?.compraron ?? null,
      conversion: c && c.atendidas > 0 ? c.compraron / c.atendidas : null,
    };
  });
}

/** Nombre y primera respuesta empiezan ascendentes (menos es mejor); el resto, de mayor a menor. */
export function direccionInicial(columna: ColumnaId): Direccion {
  return columna === "nombre" || columna === "primera" ? "asc" : "desc";
}

const sinAcentos = (texto: string) =>
  texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function valorDe(fila: FilaPersona, columna: ColumnaId): number | string | null {
  const p = fila.persona;
  switch (columna) {
    case "nombre":
      return sinAcentos(p.nombre);
    case "conversaciones":
      return p.conversaciones;
    case "mensajes":
      return p.mensajes;
    case "contactos":
      return p.contactos;
    case "primera":
      return p.primera_resp_mediana_min;
    case "en5":
      return p.en_5min;
    case "envios":
      return p.envios;
    case "monto":
      return p.monto;
    case "conversion":
      return fila.conversion;
    case "reasignadas":
      return p.reasignadas_desde;
    case "ultimo": {
      if (!p.ultimo_mensaje) return null;
      const t = Date.parse(p.ultimo_mensaje);
      return Number.isNaN(t) ? null : t;
    }
  }
}

/**
 * Copia ordenada. Los vacíos (`null`) van SIEMPRE al final, suba o baje el
 * orden: ordenar por "primera respuesta" de menor a mayor no puede poner de
 * primero a quien no respondió nada. El empate se resuelve por nombre.
 */
export function ordenarFilas(filas: FilaPersona[], columna: ColumnaId, direccion: Direccion): FilaPersona[] {
  const signo = direccion === "asc" ? 1 : -1;
  return [...filas].sort((a, b) => {
    const va = valorDe(a, columna);
    const vb = valorDe(b, columna);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) {
      if (typeof va === "string" && typeof vb === "string") return (va < vb ? -1 : 1) * signo;
      return ((va as number) - (vb as number)) * signo;
    }
    const na = sinAcentos(a.persona.nombre);
    const nb = sinAcentos(b.persona.nombre);
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}
