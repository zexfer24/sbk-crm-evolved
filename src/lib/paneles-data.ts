import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseMetasVenta,
  parsePanelAsesores,
  parsePanelCola,
  parsePanelConversaciones,
  parsePanelVentas,
  parsePanelVentasActivas,
  type MetaVenta,
  type PanelAsesores,
  type PanelCola,
  type PanelConversaciones,
  type PanelVentas,
  type PanelVentasActivas,
} from "@/lib/paneles/parse";
import { TEXTO_INICIO_PANELES, topeMensajes } from "@/lib/paneles/periodos";

/**
 * Lecturas de los paneles (Dashboard, Analíticas, Asesores; plan "Paneles",
 * 13/11/2026). Cada una llama a UNA RPC (`docs/paneles-contrato.md`) con el
 * cliente Supabase que le pasen (el de sesión: la RPC verifica
 * `is_supervisor_or_admin()` ella misma) y devuelve un `Bloque`.
 *
 * Por qué un `Bloque` en vez de lanzar: una página junta 6 a 9 lecturas en un
 * `Promise.all`, y una sola que falle (migración sin aplicar, timeout, jsonb
 * con otra forma) no puede dejar sin pantalla a las otras ocho. El panel pinta
 * "No disponible: <motivo>" SOLO en ese bloque y sigue con el resto — mismo
 * criterio que `readListIfTableExists` de Control IA, pero por bloque y sin
 * relanzar nada que no sea un bug.
 *
 * Qué SÍ se relanza: el `42501` (no autorizado). El layout de `/panel` ya
 * filtra por rol, así que si una RPC lo devuelve es un bug o una sesión que
 * cambió de rol a mitad de la carga, y esconderlo detrás de un bloque vacío lo
 * dejaría invisible; lo atrapa `error.tsx`.
 *
 * Sin `lib/log.ts` (es `server-only` y estas funciones se pueden importar desde
 * una vista): los avisos van por `console.error`, y el `detalle` que ve la
 * pantalla es un texto corto en español, nunca el mensaje crudo de Postgres.
 */

export type Bloque<T> =
  | { ok: true; dato: T }
  | { ok: false; motivo: "no_disponible" | "error"; detalle: string };

/** Los bloques que leen `messages` avisan si el rango se recortó al tope de 92 días. */
export type BloqueConTope<T> = Bloque<T> & { recortado: boolean };

/**
 * Bloque para un rango que entero cae antes de `INICIO_PANELES`: no se llama a
 * la RPC (no hay nada que leer ahí) y la pantalla ve un `no_disponible` con el
 * texto del piso. Plan "Los paneles cuentan desde el lunes 16/11/2026",
 * 21/11/2026.
 */
export function bloqueAntesDelInicio<T>(): Bloque<T> {
  return { ok: false, motivo: "no_disponible", detalle: TEXTO_INICIO_PANELES };
}

/** Variante de `bloqueAntesDelInicio` para las lecturas con tope de 92 días. */
export function bloqueConTopeAntesDelInicio<T>(): BloqueConTope<T> {
  return { ...bloqueAntesDelInicio<T>(), recortado: false };
}

/** Función de la RPC inexistente: la migración M4 no está aplicada en esa base. */
const FUNCION_INEXISTENTE = new Set(["PGRST202", "42883"]);
/** Tabla inexistente (o fuera del caché de esquema de PostgREST). */
const TABLA_INEXISTENTE = new Set(["42P01", "PGRST205"]);

function codigoDe(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

/** Un `Error` de verdad (con pila) que conserva el `code` del `PostgrestError` original. */
function errorNoAutorizado(origen: unknown): Error & { code: string } {
  const mensaje = (origen as { message?: unknown } | null)?.message;
  return Object.assign(new Error(typeof mensaje === "string" ? mensaje : "No autorizado"), { code: "42501" });
}

/**
 * Convierte la respuesta cruda de la base en un `Bloque`. `inexistentes` dice
 * qué códigos significan "esto todavía no existe en esta base" para esa lectura
 * (una función, o una tabla).
 */
function aBloque<T>(
  etiqueta: string,
  inexistentes: Set<string>,
  leer: () => Promise<{ data: unknown; error: unknown }>,
  parsear: (json: unknown) => T
): Promise<Bloque<T>> {
  return (async (): Promise<Bloque<T>> => {
    let respuesta: { data: unknown; error: unknown };
    try {
      respuesta = await leer();
    } catch (error) {
      // Un corte de red antes de que supabase-js arme su `PostgrestError`.
      console.error(`No se pudo leer ${etiqueta} (la consulta falló antes de responder):`, error);
      return { ok: false, motivo: "error", detalle: `No se pudo leer ${etiqueta}. Reintenta en unos segundos.` };
    }

    if (respuesta.error) {
      const code = codigoDe(respuesta.error);
      if (code === "42501") throw errorNoAutorizado(respuesta.error);
      if (code !== null && inexistentes.has(code)) {
        console.error(`No se pudo leer ${etiqueta} (la migración de los paneles no está aplicada):`, respuesta.error);
        return {
          ok: false,
          motivo: "no_disponible",
          detalle: `Falta aplicar la migración de los paneles en esta base (${etiqueta}).`,
        };
      }
      console.error(`No se pudo leer ${etiqueta}:`, respuesta.error);
      return { ok: false, motivo: "error", detalle: `No se pudo leer ${etiqueta}. Reintenta en unos segundos.` };
    }

    try {
      return { ok: true, dato: parsear(respuesta.data) };
    } catch (error) {
      console.error(`${etiqueta} llegó con un formato inesperado:`, error);
      return { ok: false, motivo: "error", detalle: `${etiqueta} llegó con un formato inesperado.` };
    }
  })();
}

function rpcConRango<T>(
  sb: SupabaseClient,
  funcion: string,
  etiqueta: string,
  desde: Date,
  hasta: Date,
  parsear: (json: unknown) => T
): Promise<Bloque<T>> {
  return aBloque(
    etiqueta,
    FUNCION_INEXISTENTE,
    async () => sb.rpc(funcion, { p_desde: desde.toISOString(), p_hasta: hasta.toISOString() }),
    parsear
  );
}

/** Ventas del rango `[desde, hasta)`: totales por canal, serie, personas, repuestos, estado. */
export function fetchPanelVentas(sb: SupabaseClient, desde: Date, hasta: Date): Promise<Bloque<PanelVentas>> {
  return rpcConRango(sb, "panel_ventas", "las ventas", desde, hasta, parsePanelVentas);
}

/**
 * Conversaciones del rango (embudo, resultados, conversión por persona, calor).
 * Lee `messages`: la RPC rechaza más de 92 días con `22023`, así que se recorta
 * ANTES con `topeMensajes` y el bloque dice si lo hizo (`recortado`).
 */
export async function fetchPanelConversaciones(
  sb: SupabaseClient,
  desde: Date,
  hasta: Date
): Promise<BloqueConTope<PanelConversaciones>> {
  const rango = topeMensajes({ desde, hasta });
  const bloque = await rpcConRango(sb, "panel_conversaciones", "las conversaciones", rango.desde, rango.hasta, parsePanelConversaciones);
  return { ...bloque, recortado: rango.recortado };
}

/** Actividad y rendimiento por persona del rango. Mismo tope de 92 días. */
export async function fetchPanelAsesores(
  sb: SupabaseClient,
  desde: Date,
  hasta: Date
): Promise<BloqueConTope<PanelAsesores>> {
  const rango = topeMensajes({ desde, hasta });
  const bloque = await rpcConRango(sb, "panel_asesores", "la actividad de los asesores", rango.desde, rango.hasta, parsePanelAsesores);
  return { ...bloque, recortado: rango.recortado };
}

/** La cola de conversaciones esperando respuesta (foto de AHORA, sin rango). */
export function fetchPanelCola(sb: SupabaseClient): Promise<Bloque<PanelCola>> {
  return aBloque("la cola de pendientes", FUNCION_INEXISTENTE, async () => sb.rpc("panel_cola"), parsePanelCola);
}

/** Presupuestos y carritos todavía sin enviar a SAINT, valuados al precio de hoy. */
export function fetchPanelVentasActivas(sb: SupabaseClient): Promise<Bloque<PanelVentasActivas>> {
  return aBloque(
    "las ventas en curso",
    FUNCION_INEXISTENTE,
    async () => sb.rpc("panel_ventas_activas"),
    parsePanelVentasActivas
  );
}

/** Las metas diarias por canal (RLS de supervisor/admin), de la más vieja a la más nueva. */
export function fetchMetasVenta(sb: SupabaseClient): Promise<Bloque<MetaVenta[]>> {
  return aBloque(
    "las metas de venta",
    TABLA_INEXISTENTE,
    async () => sb.from("metas_venta").select("canal, vigente_desde, monto_usd").order("vigente_desde", { ascending: true }),
    parseMetasVenta
  );
}
